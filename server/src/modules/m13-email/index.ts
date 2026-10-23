import { z } from "zod";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import { contains, inDateRange, Limit, listOf, page, person, PersonArgs, personName, personRef, requirePermission, requireState } from "../../registry/helpers.js";
import type { ModuleExports } from "../../registry/registry.js";
import { localDate } from "../../store/clock.js";
import type { Store } from "../../store/db.js";
import { blocked, deliverEmail, OUR_EMAIL, personOf, recordOptOut, sender, touch } from "../m11-conversations/messaging.js";
import { OptOut } from "../m11-conversations/schema.js";
import { daysOverdue, reminderBlocker } from "../m28-invoices/billing.js";
import type { Invoice } from "../m28-invoices/schema.js";
import { Email, EMAIL_KINDS, EMAIL_STATUSES } from "./schema.js";
import { ownedEmailBlocker } from "./owned.js";

export { Email } from "./schema.js";

// Email to and from contacts and leads, simulated like SMS (see m11-conversations/messaging.ts).
// Invoice reminders are emails of kind invoice_reminder; sending one is logged on the invoice.

const EmailId = z.string().describe("email id (em_…)");
const TRANSACTIONAL = new Set<string>(["invoice", "invoice_reminder", "ticket_reply"]);

/** Why this stored email can't be sent now (consent, state, reminder spacing), or an empty list. */
function blockers(store: Store, e: Email, now: Date): string[] {
  const out: string[] = [];
  const route = ownedEmailBlocker(e.kind);
  if (route) out.push(route);
  if (e.status !== "draft" && e.status !== "scheduled") out.push(`The email is ${e.status}`);
  const why = e.contactId || e.leadId ? blocked(store, personOf(store, e, "be emailed"), "email", TRANSACTIONAL.has(e.kind)) : (!e.to || !z.email().safeParse(e.to).success ? "No valid requester email address" : null);
  if (why) out.push(why);
  if (e.kind === "invoice_reminder" && e.invoiceId) {
    const inv = store.get<Invoice>("invoices", e.invoiceId);
    const r = inv ? reminderBlocker(inv, now) : `Invoice ${e.invoiceId} no longer exists`;
    if (r) out.push(r);
  }
  return out;
}

function requireSendable(store: Store, e: Email, now: Date): void {
  const b = blockers(store, e, now);
  if (b.length) throw new ActionError("CONFLICT", b.join("; "), { blockers: b });
}

function requireGenericRoute(store: Store, emailId?: string): void {
  if (!emailId) return;
  const e = mustGet<Email>(store, "emails", emailId, "email");
  const route = ownedEmailBlocker(e.kind);
  if (route) throw new ActionError("CONFLICT", route);
}

type NewEmail = { contactId?: string; leadId?: string; subject?: string; body?: string; invoiceId?: string };

function newEmail(store: Store, a: NewEmail, actorId: string | undefined, now: Date): Email {
  let inv: Invoice | undefined;
  if (a.invoiceId) {
    inv = mustGet<Invoice>(store, "invoices", a.invoiceId, "invoice");
    if (a.leadId) throw new ActionError("INVALID", "Invoice reminders go to the invoice's contact, not a lead");
    if (a.contactId && a.contactId !== inv.contactId) throw new ActionError("INVALID", `Invoice ${inv.number} belongs to contact ${inv.contactId}, not ${a.contactId}`);
    requireState(`Invoice ${inv.number}`, inv.status, ["open"], "get a reminder");
  }
  const p = person(store, inv ? { contactId: inv.contactId } : a, "be emailed");
  if (!p.email) throw new ActionError("CONFLICT", `${p.name} has no email address`);
  const late = inv ? daysOverdue(inv, localDate(now)) : 0;
  const subject = a.subject ?? (inv ? `Reminder: invoice ${inv.number} ${late ? `is ${late} days overdue` : `is due ${inv.dueDate}`}` : undefined);
  const body =
    a.body ??
    (inv ? `Hi ${p.name.split(" ")[0]},\n\nA friendly reminder that invoice ${inv.number} for $${inv.amountDue.toFixed(2)} was due on ${inv.dueDate}. You can pay it any time from the link in the original invoice email.\n\nThanks!` : undefined);
  if (!subject || !body) throw new ActionError("INVALID", "Give subject and body (they're only filled in for you on invoice reminders)");
  return store.insert("emails", "em", {
    conversationId: null,
    ...personRef(p),
    to: p.email,
    from: OUR_EMAIL,
    subject,
    body,
    kind: inv ? ("invoice_reminder" as const) : ("general" as const),
    invoiceId: inv?.id ?? null,
    campaignId: null,
    direction: "outbound" as const,
    status: "draft" as Email["status"],
    scheduledAt: null,
    sentAt: null,
    deliveredAt: null,
    failureReason: null,
    createdBy: actorId ?? "us_1",
    createdAt: now.toISOString(),
  });
}

const SendArgs = {
  emailId: EmailId.optional().describe("a draft to send; or give contactId/leadId, subject and body"),
  ...PersonArgs,
  subject: z.string().min(1).optional(),
  body: z.string().min(1).optional(),
};

function outgoing(store: Store, a: { emailId?: string } & NewEmail, actorId: string | undefined, now: Date): Email {
  if (a.emailId) {
    if (a.contactId || a.leadId || a.subject || a.body) throw new ActionError("INVALID", "Give emailId alone, or contactId/leadId with subject and body, not both");
    return mustGet<Email>(store, "emails", a.emailId, "email");
  }
  if (!a.subject || !a.body) throw new ActionError("INVALID", "Give emailId, or contactId/leadId with subject and body");
  return newEmail(store, a, actorId, now);
}

const draftEmail = defineAction({
  id: "M13.A01",
  description:
    "Write an email to a contact or lead and save it as a draft, without sending. With invoiceId it drafts a payment reminder for that open invoice to its contact (subject and body filled in unless given). Send it with M13.A03.",
  risk: "write",
  input: z.strictObject({ ...PersonArgs, subject: z.string().min(1).optional(), body: z.string().min(1).optional(), invoiceId: z.string().optional().describe("draft a reminder for this invoice (inv_…)") }),
  output: Email,
  siblings: ["M12.A01", "M28.A08"],
  entities: { produces: "email", consumes: ["contact", "lead", "invoice"] },
  example: () => ({ contactId: "ct_31", subject: "Your proposal", body: "Hi Sarah, attached is the proposal we discussed." }),
  handler: (a, { store, clock, actorId }) => newEmail(store, a, actorId, clock.now()),
});

const previewEmail = defineAction({
  id: "M13.A02",
  description: "Preview a draft email as it would go out, and list anything that would stop it sending (unsubscribed, do-not-disturb, no address, a reminder sent in the last 24 hours).",
  risk: "read",
  input: z.strictObject({ emailId: EmailId }),
  output: z.object({ emailId: z.string(), to: z.string(), personName: z.string().nullable(), subject: z.string(), body: z.string(), kind: z.enum(EMAIL_KINDS), canSend: z.boolean(), blockers: z.array(z.string()) }),
  entities: { consumes: ["email"] },
  example: (f) => ({ emailId: f.email().id }),
  handler: ({ emailId }, { store, clock }) => {
    const e = mustGet<Email>(store, "emails", emailId, "email");
    const b = blockers(store, e, clock.now());
    return { emailId: e.id, to: e.to, personName: personName(store, e), subject: e.subject, body: e.body, kind: e.kind, canSend: b.length === 0, blockers: b };
  },
});

const sendEmail = defineAction({
  id: "M13.A03",
  description:
    "Send an email now: a saved draft (emailId) or a new email to a contact or lead. Refused if they unsubscribed, are on do-not-disturb or turned off email (invoice emails are exempt from marketing preferences).",
  risk: "external",
  input: z.strictObject(SendArgs),
  output: Email,
  siblings: ["M12.A03", "M28.A08"],
  entities: { produces: "email", consumes: ["contact", "lead", "email"] },
  example: () => ({ contactId: "ct_31", subject: "Great talking today", body: "Thanks for your time, Sarah. Next steps below." }),
  handler: (a, { store, clock, actorId }) => {
    requireGenericRoute(store, a.emailId);
    requirePermission(store, actorId, "messaging.send");
    const e = outgoing(store, a, actorId, clock.now());
    requireSendable(store, e, clock.now());
    return deliverEmail(store, e, clock.now().toISOString());
  },
});

const scheduleEmail = defineAction({
  id: "M13.A04",
  description: "Schedule an email to go out later: a saved draft (emailId) or a new email to a contact or lead. The same consent rules as sending apply.",
  risk: "external",
  input: z.strictObject({ ...SendArgs, sendAt: z.iso.datetime({ offset: true }).describe("when to send, ISO date-time") }),
  output: Email,
  siblings: ["M12.A04", "M15.A06"],
  entities: { produces: "email", consumes: ["contact", "lead", "email"] },
  example: (f) => ({ contactId: "ct_31", subject: "Checking in", body: "Hi Sarah, any questions on the proposal?", sendAt: f.at(2, 14) }),
  handler: ({ sendAt, ...a }, { store, clock, actorId }) => {
    requireGenericRoute(store, a.emailId);
    requirePermission(store, actorId, "messaging.send");
    if (new Date(sendAt) <= clock.now()) throw new ActionError("INVALID", `sendAt ${sendAt} isn't in the future (now is ${clock.now().toISOString()})`);
    const e = outgoing(store, a, actorId, clock.now());
    requireSendable(store, e, clock.now());
    return store.update<Email>("emails", e.id, { status: "scheduled", scheduledAt: new Date(sendAt).toISOString() });
  },
});

const cancelScheduled = defineAction({
  id: "M13.A05",
  description: "Cancel a scheduled email before it goes out.",
  risk: "write",
  input: z.strictObject({ emailId: EmailId }),
  output: Email,
  entities: { consumes: ["email"] },
  example: (f) => ({ emailId: f.email({ status: "scheduled", scheduledAt: f.at(1) }).id }),
  handler: ({ emailId }, { store }) => {
    const e = mustGet<Email>(store, "emails", emailId, "email");
    requireState("The email", e.status, ["scheduled"], "cancel it");
    return store.update<Email>("emails", e.id, { status: "cancelled" });
  },
});

const Detail = Email.extend({ personName: z.string().nullable() });

const getEmail = defineAction({
  id: "M13.A06",
  description: "Get one email: who it's to or from, subject, body, kind (general, invoice, invoice_reminder, campaign), status and timestamps.",
  risk: "read",
  input: z.strictObject({ emailId: EmailId }),
  output: Detail,
  entities: { consumes: ["email"] },
  example: (f) => ({ emailId: f.email().id }),
  handler: ({ emailId }, { store }) => {
    const e = mustGet<Email>(store, "emails", emailId, "email");
    return { ...e, personName: personName(store, e) };
  },
});

const searchEmails = defineAction({
  id: "M13.A07",
  description:
    "Find emails by contact or lead, invoice, campaign, kind (e.g. invoice_reminder), direction, status, date or text. Newest first. Dates are inclusive and use when it was sent (or written, for drafts).",
  risk: "read",
  input: z.strictObject({
    ...PersonArgs,
    invoiceId: z.string().optional(),
    campaignId: z.string().optional(),
    kind: z.enum(EMAIL_KINDS).optional(),
    direction: z.enum(["outbound", "inbound"]).optional(),
    status: z.enum(EMAIL_STATUSES).optional(),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    query: z.string().optional().describe("words in the subject or body"),
    limit: Limit,
  }),
  output: listOf(Detail),
  siblings: ["M12.A07"],
  entities: { produces: "email" },
  example: () => ({ kind: "invoice_reminder" }),
  handler: (a, { store }) => {
    const items = store
      .find<Email>(
        "emails",
        (e) =>
          (!a.contactId || e.contactId === a.contactId) &&
          (!a.leadId || e.leadId === a.leadId) &&
          (!a.invoiceId || e.invoiceId === a.invoiceId) &&
          (!a.campaignId || e.campaignId === a.campaignId) &&
          (!a.kind || e.kind === a.kind) &&
          (!a.direction || e.direction === a.direction) &&
          (!a.status || e.status === a.status) &&
          inDateRange(e.sentAt ?? e.createdAt, a.from, a.to) &&
          (!a.query || contains(e.subject, a.query) || contains(e.body, a.query)),
      )
      .map((e) => ({ ...e, personName: personName(store, e) }));
    items.sort((x, y) => (y.sentAt ?? y.createdAt).localeCompare(x.sentAt ?? x.createdAt));
    return page(items, a.limit);
  },
});

const deliveryStatus = defineAction({
  id: "M13.A08",
  description: "Check whether an email was delivered or bounced, and why.",
  risk: "read",
  input: z.strictObject({ emailId: EmailId }),
  output: z.object({ emailId: z.string(), to: z.string(), status: z.enum(EMAIL_STATUSES), sentAt: z.string().nullable(), deliveredAt: z.string().nullable(), failureReason: z.string().nullable() }),
  siblings: ["M12.A08"],
  entities: { consumes: ["email"] },
  example: (f) => ({ emailId: f.email().id }),
  handler: ({ emailId }, { store }) => {
    const e = mustGet<Email>(store, "emails", emailId, "email");
    return { emailId: e.id, to: e.to, status: e.status, sentAt: e.sentAt, deliveredAt: e.deliveredAt, failureReason: e.failureReason };
  },
});

const receiveEmail = defineAction({
  id: "M13.A09",
  description: "Simulate an email arriving from an address, as if the person replied. It lands in their conversation as unread.",
  risk: "write",
  input: z.strictObject({ from: z.string().describe("the sender's email address"), subject: z.string().min(1), body: z.string().min(1) }),
  output: Email,
  siblings: ["M12.A09"],
  entities: { produces: "email" },
  example: (f) => ({ from: f.contact().email!, subject: "Re: Your proposal", body: "Looks good, let's talk Thursday." }),
  handler: ({ from, subject, body }, { store, clock }) => {
    const ref = sender(store, "email", from);
    if (!ref) throw new ActionError("NOT_FOUND", `No contact or lead has the email address ${from}`);
    const now = clock.now().toISOString();
    const conv = touch(store, ref, "email", "inbound", subject, now);
    return store.insert("emails", "em", {
      conversationId: conv.id,
      ...ref,
      to: OUR_EMAIL,
      from,
      subject,
      body,
      kind: "general" as const,
      invoiceId: null,
      campaignId: null,
      direction: "inbound" as const,
      status: "received" as const,
      scheduledAt: null,
      sentAt: now,
      deliveredAt: now,
      failureReason: null,
      createdBy: null,
      createdAt: now,
    });
  },
});

const unsubscribe = defineAction({
  id: "M13.A10",
  description: "Record that a contact or lead unsubscribed from email. Marketing and follow-up email to them is refused from now on; invoices still go out. For texts, use M12.A10.",
  risk: "write",
  input: z.strictObject({ ...PersonArgs }),
  output: OptOut,
  siblings: ["M12.A10", "M01.A08"],
  entities: { consumes: ["contact", "lead"] },
  example: (f) => ({ contactId: f.contact().id }),
  handler: (a, { store, clock }) => {
    const p = person(store, a, "unsubscribe");
    if (!p.email) throw new ActionError("CONFLICT", `${p.name} has no email address to unsubscribe`);
    return recordOptOut(store, "email", p.email, personRef(p), "manual", clock.now().toISOString());
  },
});

export default {
  actions: [draftEmail, previewEmail, sendEmail, scheduleEmail, cancelScheduled, getEmail, searchEmails, deliveryStatus, receiveEmail, unsubscribe],
} satisfies ModuleExports;
