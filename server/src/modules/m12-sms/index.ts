import { z } from "zod";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import { contains, inDateRange, Limit, listOf, page, person, PersonArgs, personName, personRef, requirePermission, requireState } from "../../registry/helpers.js";
import type { ModuleExports } from "../../registry/registry.js";
import type { Store } from "../../store/db.js";
import { deliverSms, optOut, OUR_PHONE, personOf, recordOptOut, requireReachable, sender, touch } from "../m11-conversations/messaging.js";
import { OptOut } from "../m11-conversations/schema.js";
import { Sms, SMS_STATUSES } from "./schema.js";

export { Sms } from "./schema.js";

// Text messages to and from contacts and leads. Sending is simulated (see m11-conversations/messaging.ts):
// nothing leaves the building, but consent rules, segment counts and delivery failures behave like the real thing.

const SmsId = z.string().describe("SMS id (sm_…)");

const GSM = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXT = "^{}\\[~]|€";

/** How a body is billed: GSM-7 fits 160 characters in one part (153 per part when split); anything else is UCS-2, 70 (67). */
export function segmentation(body: string) {
  const chars = [...body];
  const nonGsm = [...new Set(chars.filter((c) => !GSM.includes(c) && !GSM_EXT.includes(c)))];
  const encoding = nonGsm.length ? ("UCS-2" as const) : ("GSM-7" as const);
  const units = encoding === "GSM-7" ? chars.reduce((n, c) => n + (GSM_EXT.includes(c) ? 2 : 1), 0) : body.length;
  const [single, multi] = encoding === "GSM-7" ? [160, 153] : [70, 67];
  const segments = units === 0 ? 0 : units <= single ? 1 : Math.ceil(units / multi);
  return { characters: chars.length, units, encoding, segments, perSegment: segments > 1 ? multi : single, nonGsmCharacters: nonGsm };
}

function newSms(store: Store, a: { contactId?: string; leadId?: string; body: string }, actorId: string | undefined, now: string, status: "draft" | "scheduled", scheduledAt: string | null): Sms {
  const p = person(store, a, "be texted");
  if (!p.phone) throw new ActionError("CONFLICT", `${p.name} has no phone number`);
  const { encoding, segments } = segmentation(a.body);
  return store.insert("sms", "sm", {
    conversationId: null,
    ...personRef(p),
    to: p.phone,
    from: OUR_PHONE,
    body: a.body,
    campaignId: null,
    direction: "outbound" as const,
    status,
    segments,
    encoding,
    scheduledAt,
    sentAt: null,
    deliveredAt: null,
    failureReason: null,
    createdBy: actorId ?? "us_1",
    createdAt: now,
  });
}

/** For send and schedule: a stored draft by id, or a new message from person + body. */
const SendArgs = {
  smsId: SmsId.optional().describe("a draft to send; or give contactId/leadId and body"),
  ...PersonArgs,
  body: z.string().min(1).max(1600).optional(),
};

function outgoing(store: Store, a: { smsId?: string; contactId?: string; leadId?: string; body?: string }, actorId: string | undefined, now: string): Sms {
  if (a.smsId) {
    if (a.contactId || a.leadId || a.body) throw new ActionError("INVALID", "Give smsId alone, or contactId/leadId with body, not both");
    const s = mustGet<Sms>(store, "sms", a.smsId, "SMS");
    requireState("The SMS", s.status, ["draft", "scheduled"], "send it");
    return s;
  }
  if (!a.body) throw new ActionError("INVALID", "Give smsId, or contactId/leadId with body");
  return newSms(store, { ...a, body: a.body }, actorId, now, "draft", null);
}

const draftSms = defineAction({
  id: "M12.A01",
  description: "Write a text message to a contact or lead and save it as a draft, without sending. Send it later with M12.A03.",
  risk: "write",
  input: z.strictObject({ ...PersonArgs, body: z.string().min(1).max(1600) }),
  output: Sms,
  siblings: ["M13.A01"],
  entities: { produces: "sms", consumes: ["contact", "lead"] },
  example: (f) => ({ contactId: f.contact({ phone: "+15550123456" }).id, body: "Hi! Just checking you got our proposal." }),
  handler: (a, { store, clock, actorId }) => newSms(store, a, actorId, clock.now().toISOString(), "draft", null),
});

const previewSegments = defineAction({
  id: "M12.A02",
  description: "Check how a text would be split and billed: characters, encoding (GSM-7 or UCS-2 for emoji and some accents) and number of segments. Sends nothing.",
  risk: "read",
  input: z.strictObject({ body: z.string().min(1).max(1600) }),
  output: z.object({ characters: z.number(), units: z.number(), encoding: z.enum(["GSM-7", "UCS-2"]), segments: z.number(), perSegment: z.number(), nonGsmCharacters: z.array(z.string()) }),
  example: () => ({ body: "Your appointment is confirmed for Friday at 3pm 🎉" }),
  handler: ({ body }) => segmentation(body),
});

const sendSms = defineAction({
  id: "M12.A03",
  destination: { id: "sms", label: "SMS" },
  description:
    "Send a text message now: a saved draft (smsId) or a new message to a contact or lead. Refused if they opted out, are on do-not-disturb, turned off SMS, or have no valid mobile number.",
  risk: "external",
  input: z.strictObject(SendArgs),
  output: Sms,
  siblings: ["M13.A03"],
  entities: { produces: "sms", consumes: ["contact", "lead", "sms"] },
  example: (f) => ({ contactId: f.contact({ phone: "+15550123456" }).id, body: "Thanks for your time today!" }),
  handler: (a, { store, clock, actorId }) => {
    requirePermission(store, actorId, "messaging.send");
    const now = clock.now().toISOString();
    const s = outgoing(store, a, actorId, now);
    requireReachable(store, { ...personOf(store, s, "be texted"), phone: s.to }, "sms");
    return deliverSms(store, s, now);
  },
});

const scheduleSms = defineAction({
  id: "M12.A04",
  destination: { id: "sms", label: "SMS" },
  description: "Schedule a text message to go out later: a saved draft (smsId) or a new message to a contact or lead. The same consent rules as sending apply.",
  risk: "external",
  input: z.strictObject({ ...SendArgs, sendAt: z.iso.datetime({ offset: true }).describe("when to send, ISO date-time") }),
  output: Sms,
  siblings: ["M13.A04"],
  entities: { produces: "sms", consumes: ["contact", "lead", "sms"] },
  example: (f) => ({ contactId: f.contact({ phone: "+15550123456" }).id, body: "Reminder: your demo is tomorrow at 10am.", sendAt: f.at(1, 15) }),
  handler: ({ sendAt, ...a }, { store, clock, actorId }) => {
    requirePermission(store, actorId, "messaging.send");
    if (new Date(sendAt) <= clock.now()) throw new ActionError("INVALID", `sendAt ${sendAt} isn't in the future (now is ${clock.now().toISOString()})`);
    const s = outgoing(store, a, actorId, clock.now().toISOString());
    requireReachable(store, { ...personOf(store, s, "be texted"), phone: s.to }, "sms");
    return store.update<Sms>("sms", s.id, { status: "scheduled", scheduledAt: new Date(sendAt).toISOString() });
  },
});

const cancelScheduled = defineAction({
  id: "M12.A05",
  description: "Cancel a scheduled text message before it goes out.",
  risk: "write",
  input: z.strictObject({ smsId: SmsId }),
  output: Sms,
  entities: { consumes: ["sms"] },
  example: (f) => ({ smsId: f.sms({ status: "scheduled", scheduledAt: f.at(1) }).id }),
  handler: ({ smsId }, { store }) => {
    const s = mustGet<Sms>(store, "sms", smsId, "SMS");
    requireState("The SMS", s.status, ["scheduled"], "cancel it");
    return store.update<Sms>("sms", s.id, { status: "cancelled" });
  },
});

const Detail = Sms.extend({ personName: z.string().nullable() });

const getSms = defineAction({
  id: "M12.A06",
  description: "Get one text message: who it's to or from, the text, its status and timestamps.",
  risk: "read",
  input: z.strictObject({ smsId: SmsId }),
  output: Detail,
  entities: { consumes: ["sms"] },
  example: (f) => ({ smsId: f.sms().id }),
  handler: ({ smsId }, { store }) => {
    const s = mustGet<Sms>(store, "sms", smsId, "SMS");
    return { ...s, personName: personName(store, s) };
  },
});

const searchSms = defineAction({
  id: "M12.A07",
  description: "Find text messages by contact or lead, direction, status, date sent or received, or text. Newest first. Dates are inclusive.",
  risk: "read",
  input: z.strictObject({
    ...PersonArgs,
    direction: z.enum(["outbound", "inbound"]).optional(),
    status: z.enum(SMS_STATUSES).optional(),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    query: z.string().optional().describe("words in the message"),
    limit: Limit,
  }),
  output: listOf(Detail),
  siblings: ["M13.A07"],
  entities: { produces: "sms" },
  example: () => ({ direction: "inbound" }),
  handler: (a, { store }) => {
    const items = store
      .find<Sms>(
        "sms",
        (s) =>
          (!a.contactId || s.contactId === a.contactId) &&
          (!a.leadId || s.leadId === a.leadId) &&
          (!a.direction || s.direction === a.direction) &&
          (!a.status || s.status === a.status) &&
          inDateRange(s.sentAt ?? s.createdAt, a.from, a.to) &&
          (!a.query || contains(s.body, a.query)),
      )
      .map((s) => ({ ...s, personName: personName(store, s) }));
    items.sort((x, y) => (y.sentAt ?? y.createdAt).localeCompare(x.sentAt ?? x.createdAt));
    return page(items, a.limit);
  },
});

const deliveryStatus = defineAction({
  id: "M12.A08",
  description: "Check whether a text message was delivered, and why it failed if it did.",
  risk: "read",
  input: z.strictObject({ smsId: SmsId }),
  output: z.object({ smsId: z.string(), to: z.string(), status: z.enum(SMS_STATUSES), sentAt: z.string().nullable(), deliveredAt: z.string().nullable(), failureReason: z.string().nullable(), segments: z.number() }),
  siblings: ["M13.A08"],
  entities: { consumes: ["sms"] },
  example: (f) => ({ smsId: f.sms().id }),
  handler: ({ smsId }, { store }) => {
    const s = mustGet<Sms>(store, "sms", smsId, "SMS");
    return { smsId: s.id, to: s.to, status: s.status, sentAt: s.sentAt, deliveredAt: s.deliveredAt, failureReason: s.failureReason, segments: s.segments };
  },
});

const STOP_WORDS = ["stop", "stopall", "unsubscribe", "cancel", "end", "quit"];

const receiveSms = defineAction({
  id: "M12.A09",
  description:
    "Simulate a text arriving from a phone number, as if the person replied. It lands in their conversation as unread. A reply of STOP (or UNSUBSCRIBE, QUIT…) also opts them out of SMS.",
  risk: "write",
  input: z.strictObject({ from: z.string().describe("the sender's phone number, +1555…"), body: z.string().min(1) }),
  output: Sms.extend({ optedOut: z.boolean() }),
  siblings: ["M13.A09"],
  entities: { produces: "sms" },
  example: (f) => ({ from: f.contact({ phone: "+15550123456" }).phone!, body: "Yes, Friday works for me" }),
  handler: ({ from, body }, { store, clock }) => {
    const ref = sender(store, "sms", from);
    if (!ref) throw new ActionError("NOT_FOUND", `No contact or lead has the phone number ${from}`);
    const now = clock.now().toISOString();
    const conv = touch(store, ref, "sms", "inbound", body, now);
    const { encoding, segments } = segmentation(body);
    const s = store.insert("sms", "sm", {
      conversationId: conv.id,
      ...ref,
      to: OUR_PHONE,
      from,
      body,
      campaignId: null,
      direction: "inbound" as const,
      status: "received" as const,
      segments,
      encoding,
      scheduledAt: null,
      sentAt: now,
      deliveredAt: now,
      failureReason: null,
      createdBy: null,
      createdAt: now,
    });
    const stop = STOP_WORDS.includes(body.trim().toLowerCase());
    // Someone already opted out can text STOP again; the reply is still recorded.
    if (stop && !optOut(store, "sms", from)) recordOptOut(store, "sms", from, ref, "reply_stop", now);
    return { ...s, optedOut: stop };
  },
});

const recordSmsOptOut = defineAction({
  id: "M12.A10",
  description: "Record that a contact or lead doesn't want text messages any more. Future sends to their number are refused. For email, use M13.A10 Record unsubscribe.",
  risk: "write",
  input: z.strictObject({ ...PersonArgs }),
  output: OptOut,
  siblings: ["M13.A10", "M01.A08"],
  entities: { consumes: ["contact", "lead"] },
  example: (f) => ({ contactId: f.contact({ phone: "+15550123456" }).id }),
  handler: (a, { store, clock }) => {
    const p = person(store, a, "opt out");
    if (!p.phone) throw new ActionError("CONFLICT", `${p.name} has no phone number to opt out`);
    return recordOptOut(store, "sms", p.phone, personRef(p), "manual", clock.now().toISOString());
  },
});

export default {
  actions: [draftSms, previewSegments, sendSms, scheduleSms, cancelScheduled, getSms, searchSms, deliveryStatus, receiveSms, recordSmsOptOut],
} satisfies ModuleExports;
