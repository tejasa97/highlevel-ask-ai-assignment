import { z } from "zod";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import { activeUser, atLeastOne, candidates, contains, Limit, listOf, Name, page, requirePermission, requireState } from "../../registry/helpers.js";
import type { ModuleExports } from "../../registry/registry.js";
import type { Store } from "../../store/db.js";
import type { Contact } from "../m01-contacts/schema.js";
import type { Lead } from "../m03-leads/schema.js";
import { blocked, deliverEmail, deliverSms, OUR_EMAIL, OUR_PHONE } from "../m11-conversations/messaging.js";
import type { Email } from "../m13-email/schema.js";
import type { Sms } from "../m12-sms/schema.js";
import { segmentation } from "../m12-sms/index.js";
import { Campaign, CAMPAIGN_STATUSES } from "./schema.js";

export { Campaign } from "./schema.js";

// Marketing campaigns: an audience (a tag and/or hand-picked contacts) and a sequence of email or SMS steps.
// Launching sends the day-0 steps right away (simulated, with the usual consent rules); later steps are
// shown in the plan but not run by this demo. Leads a campaign brought in point at it via lead.campaignId.

const CampaignId = z.string().describe("campaign id (cp_…)");

function audience(store: Store, c: Campaign): Contact[] {
  const ids = new Set(c.audience.contactIds);
  return store.find<Contact>("contacts", (x) => x.status === "active" && (ids.has(x.id) || (!!c.audience.tag && x.tags.some((t) => t.toLowerCase() === c.audience.tag!.toLowerCase()))));
}

function editable(store: Store, id: string): Campaign {
  const c = mustGet<Campaign>(store, "campaigns", id, "campaign");
  requireState(`Campaign "${c.name}"`, c.status, ["draft", "scheduled"], "be edited (only drafts and scheduled campaigns can change)");
  return c;
}

const asPerson = (c: Contact) => ({ type: "contact" as const, id: c.id, name: c.name, email: c.email, phone: c.phone });

const createCampaign = defineAction({
  id: "M15.A01",
  description: "Create a draft marketing campaign with a name and main channel (email or SMS). Add an audience (M15.A04) and steps (M15.A05) before launching.",
  risk: "write",
  input: z.strictObject({ name: Name, channel: z.enum(["email", "sms"]), ownerId: z.string().optional() }),
  output: Campaign,
  entities: { produces: "campaign", consumes: ["user"] },
  example: () => ({ name: "Winter Check-in", channel: "email" }),
  handler: (a, { store, clock, actorId }) => {
    if (store.find<Campaign>("campaigns", (c) => c.name.toLowerCase() === a.name.trim().toLowerCase()).length)
      throw new ActionError("DUPLICATE", `A campaign named "${a.name}" already exists`);
    const ownerId = a.ownerId ? activeUser(store, a.ownerId, "own campaigns").id : (actorId ?? null);
    return store.insert("campaigns", "cp", {
      name: a.name.trim(),
      channel: a.channel,
      status: "draft" as Campaign["status"],
      audience: { tag: null as string | null, contactIds: [] as string[] },
      steps: [] as Campaign["steps"],
      startAt: null as string | null,
      launchedAt: null as string | null,
      pausedAt: null as string | null,
      ownerId,
      createdAt: clock.now().toISOString(),
    });
  },
});

const getCampaign = defineAction({
  id: "M15.A02",
  description: "Get one campaign: status, audience and its size, steps, schedule, and how many leads it brought in.",
  risk: "read",
  input: z.strictObject({ campaignId: CampaignId }),
  output: Campaign.extend({ audienceSize: z.number(), leadsAttributed: z.number() }),
  entities: { consumes: ["campaign"] },
  example: () => ({ campaignId: "cp_1" }),
  handler: ({ campaignId }, { store }) => {
    const c = mustGet<Campaign>(store, "campaigns", campaignId, "campaign");
    return { ...c, audienceSize: audience(store, c).length, leadsAttributed: store.find<Lead>("leads", (l) => l.campaignId === c.id).length };
  },
});

const listCampaigns = defineAction({
  id: "M15.A03",
  description: "List campaigns, optionally by status, channel or name.",
  risk: "read",
  input: z.strictObject({ status: z.enum(CAMPAIGN_STATUSES).optional(), channel: z.enum(["email", "sms"]).optional(), query: z.string().optional(), limit: Limit }),
  output: listOf(Campaign),
  entities: { produces: "campaign" },
  example: () => ({ status: "active" }),
  handler: (a, { store }) => {
    const items = store.find<Campaign>("campaigns", (c) => (!a.status || c.status === a.status) && (!a.channel || c.channel === a.channel) && (!a.query || contains(c.name, a.query)));
    items.sort((x, y) => y.createdAt.localeCompare(x.createdAt));
    return page(items, a.limit);
  },
});

const setAudience = defineAction({
  id: "M15.A04",
  description: "Choose who a draft or scheduled campaign goes to: everyone with a tag, specific contacts, or both.",
  risk: "write",
  input: z.strictObject({ campaignId: CampaignId, tag: z.string().nullable().optional(), contactIds: z.array(z.string()).optional() }),
  output: Campaign,
  siblings: ["M08.A06"],
  entities: { consumes: ["campaign", "tag", "contact"] },
  example: (f) => ({ campaignId: f.campaign().id, tag: "newsletter" }),
  handler: ({ campaignId, ...a }, { store }) => {
    atLeastOne(a, ["tag", "contactIds"]);
    const c = editable(store, campaignId);
    for (const id of a.contactIds ?? []) mustGet<Contact>(store, "contacts", id, "contact");
    return store.update<Campaign>("campaigns", c.id, {
      audience: { tag: a.tag !== undefined ? a.tag : c.audience.tag, contactIds: a.contactIds ?? c.audience.contactIds },
    });
  },
});

const addStep = defineAction({
  id: "M15.A05",
  description: "Add a message step to a draft or scheduled campaign: channel, subject (email), body, and how many days after launch it goes out.",
  risk: "write",
  input: z.strictObject({
    campaignId: CampaignId,
    channel: z.enum(["email", "sms"]).optional().describe("default: the campaign's channel"),
    subject: z.string().optional(),
    body: z.string().min(1),
    delayDays: z.number().int().min(0).optional().describe("default 0"),
  }),
  output: Campaign,
  entities: { consumes: ["campaign"] },
  example: (f) => ({ campaignId: f.campaign().id, subject: "You're invited", body: "Join our live session next week.", delayDays: 0 }),
  handler: ({ campaignId, ...a }, { store }) => {
    const c = editable(store, campaignId);
    const channel = a.channel ?? c.channel;
    if (channel === "email" && !a.subject) throw new ActionError("INVALID", "Email steps need a subject");
    if (channel === "sms" && a.subject) throw new ActionError("INVALID", "SMS steps don't have a subject");
    return store.update<Campaign>("campaigns", c.id, {
      steps: [...c.steps, { order: c.steps.length + 1, channel, subject: a.subject ?? null, body: a.body, delayDays: a.delayDays ?? 0 }],
    });
  },
});

const setSchedule = defineAction({
  id: "M15.A06",
  description: "Set when a draft campaign should start (status becomes scheduled), or clear it (back to draft).",
  risk: "write",
  input: z.strictObject({ campaignId: CampaignId, startAt: z.iso.datetime({ offset: true }).nullable() }),
  output: Campaign,
  siblings: ["M13.A04"],
  entities: { consumes: ["campaign"] },
  example: (f) => ({ campaignId: f.campaign().id, startAt: f.at(7, 14) }),
  handler: ({ campaignId, startAt }, { store, clock }) => {
    const c = editable(store, campaignId);
    if (startAt && new Date(startAt) <= clock.now()) throw new ActionError("INVALID", `startAt ${startAt} isn't in the future`);
    return store.update<Campaign>("campaigns", c.id, { startAt: startAt ? new Date(startAt).toISOString() : null, status: startAt ? "scheduled" : "draft" });
  },
});

const launch = defineAction({
  id: "M15.A07",
  description:
    "Launch a draft or scheduled campaign now: it becomes active and its day-0 steps go out to every reachable contact in the audience. People who opted out or are on do-not-disturb are skipped and counted.",
  risk: "external",
  input: z.strictObject({ campaignId: CampaignId }),
  output: z.object({ campaign: Campaign, sent: z.number(), skipped: z.array(z.object({ contactId: z.string(), reason: z.string() })) }),
  entities: { consumes: ["campaign"] },
  example: (f) => {
    const c = f.contact({ tags: ["launch-test"] });
    return { campaignId: f.campaign({ audience: { tag: "launch-test", contactIds: [c.id] }, steps: [{ order: 1, channel: "email", subject: "Hello", body: "Welcome!", delayDays: 0 }] }).id };
  },
  handler: ({ campaignId }, { store, clock, actorId }) => {
    requirePermission(store, actorId, "messaging.send");
    const c = editable(store, campaignId);
    if (!c.steps.length) throw new ActionError("CONFLICT", `Campaign "${c.name}" has no steps; add one first (M15.A05)`);
    const people = audience(store, c);
    if (!people.length) throw new ActionError("CONFLICT", `Campaign "${c.name}" has nobody in its audience; set one first (M15.A04)`);
    const at = clock.now().toISOString();
    const skipped: { contactId: string; reason: string }[] = [];
    let sent = 0;
    for (const step of c.steps.filter((s) => s.delayDays === 0)) {
      for (const p of people) {
        const why = blocked(store, asPerson(p), step.channel);
        if (why) {
          skipped.push({ contactId: p.id, reason: why });
          continue;
        }
        const base = { conversationId: null, contactId: p.id, leadId: null, direction: "outbound" as const, scheduledAt: null, sentAt: null, deliveredAt: null, failureReason: null, createdBy: actorId ?? "us_1", createdAt: at };
        if (step.channel === "email") {
          const e = store.insert("emails", "em", { ...base, to: p.email!, from: OUR_EMAIL, subject: step.subject ?? c.name, body: step.body, kind: "campaign" as const, invoiceId: null, campaignId: c.id, status: "draft" as Email["status"] });
          deliverEmail(store, e, at);
        } else {
          const { encoding, segments } = segmentation(step.body);
          const s = store.insert("sms", "sm", { ...base, to: p.phone!, from: OUR_PHONE, body: step.body, campaignId: c.id, status: "draft" as Sms["status"], segments, encoding });
          deliverSms(store, s, at);
        }
        sent++;
      }
    }
    const campaign = store.update<Campaign>("campaigns", c.id, { status: "active", launchedAt: at, pausedAt: null });
    return { campaign, sent, skipped };
  },
});

const pause = defineAction({
  id: "M15.A08",
  description: "Pause an active campaign so no further steps go out.",
  risk: "write",
  input: z.strictObject({ campaignId: CampaignId }),
  output: Campaign,
  siblings: ["M15.A09"],
  entities: { consumes: ["campaign"] },
  example: (f) => ({ campaignId: f.campaign({ status: "active", launchedAt: f.at(-3) }).id }),
  handler: ({ campaignId }, { store, clock }) => {
    const c = mustGet<Campaign>(store, "campaigns", campaignId, "campaign");
    requireState(`Campaign "${c.name}"`, c.status, ["active"], "be paused");
    return store.update<Campaign>("campaigns", c.id, { status: "paused", pausedAt: clock.now().toISOString() });
  },
});

const resume = defineAction({
  id: "M15.A09",
  description: "Resume a paused campaign.",
  risk: "write",
  input: z.strictObject({ campaignId: CampaignId }),
  output: Campaign,
  siblings: ["M15.A08"],
  entities: { consumes: ["campaign"] },
  example: (f) => ({ campaignId: f.campaign({ status: "paused", launchedAt: f.at(-3), pausedAt: f.at(-1) }).id }),
  handler: ({ campaignId }, { store }) => {
    const c = mustGet<Campaign>(store, "campaigns", campaignId, "campaign");
    requireState(`Campaign "${c.name}"`, c.status, ["paused"], "be resumed");
    return store.update<Campaign>("campaigns", c.id, { status: "active", pausedAt: null });
  },
});

const performance = defineAction({
  id: "M15.A10",
  description: "How a campaign is doing: messages sent, delivered, bounced or failed, replies, and leads it brought in.",
  risk: "read",
  input: z.strictObject({ campaignId: CampaignId }),
  output: z.object({
    campaignId: z.string(),
    name: z.string(),
    status: z.enum(CAMPAIGN_STATUSES),
    sent: z.number(),
    delivered: z.number(),
    failed: z.number(),
    deliveryRate: z.number().nullable(),
    replies: z.number(),
    leadsAttributed: z.number(),
  }),
  entities: { consumes: ["campaign"] },
  example: () => ({ campaignId: "cp_1" }),
  handler: ({ campaignId }, { store }) => {
    const c = mustGet<Campaign>(store, "campaigns", campaignId, "campaign");
    const launched = c.launchedAt ?? "9999";
    const emails = store.find<Email>("emails", (e) => e.campaignId === c.id && !!e.sentAt);
    const texts = store.find<Sms>("sms", (s) => s.campaignId === c.id && !!s.sentAt);
    const sent = [...emails, ...texts];
    const delivered = sent.filter((m) => m.status === "delivered").length;
    const who = new Set(sent.map((m) => m.contactId));
    const replies = new Set([
      ...store.find<Email>("emails", (e) => e.direction === "inbound" && who.has(e.contactId) && e.createdAt > launched).map((e) => e.contactId),
      ...store.find<Sms>("sms", (s) => s.direction === "inbound" && who.has(s.contactId) && s.createdAt > launched).map((s) => s.contactId),
    ]).size;
    return {
      campaignId: c.id,
      name: c.name,
      status: c.status,
      sent: sent.length,
      delivered,
      failed: sent.length - delivered,
      deliveryRate: sent.length ? Math.round((delivered / sent.length) * 100) / 100 : null,
      replies,
      leadsAttributed: store.find<Lead>("leads", (l) => l.campaignId === c.id).length,
    };
  },
});

export default {
  actions: [createCampaign, getCampaign, listCampaigns, setAudience, addStep, setSchedule, launch, pause, resume, performance],
  resolvers: {
    campaign: (store, name) => candidates(store.all<Campaign>("campaigns"), name, (c) => c.name, (c) => `${c.status} ${c.channel} campaign`),
  },
} satisfies ModuleExports;
