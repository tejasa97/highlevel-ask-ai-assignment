import { ActionError } from "../../registry/define.js";
import { type Person, person } from "../../registry/helpers.js";
import type { Store } from "../../store/db.js";
import type { Contact } from "../m01-contacts/schema.js";
import type { Lead } from "../m03-leads/schema.js";
import type { Email } from "../m13-email/schema.js";
import type { Sms } from "../m12-sms/schema.js";
import type { Channel, Conversation, OptOut } from "./schema.js";

// The plumbing SMS, email, campaigns and invoices share: consent checks, simulated delivery, and keeping
// each person's conversation up to date. Nothing leaves the building; delivery is decided by simple rules
// so tests and scenarios can count on it:
// - an SMS to a number ending in 0000 fails (a landline);
// - an email to a domain containing "bounce" bounces.

export const OUR_PHONE = "+15550009999";
export const OUR_EMAIL = "hello@ourco.example";
const PHONE = /^\+\d{10,15}$/;

export type Ref = { contactId: string | null; leadId: string | null };

const lower = (s: string) => s.trim().toLowerCase();

/** The contact or lead a stored record belongs to, checked the same way as when it was created. */
export function personOf(store: Store, ref: Ref, doing: string): Person {
  return person(store, { contactId: ref.contactId ?? undefined, leadId: ref.leadId ?? undefined }, doing);
}

export function conversationOf(store: Store, ref: Ref): Conversation | undefined {
  if (!ref.contactId && !ref.leadId) return undefined;
  return store.find<Conversation>("conversations", (c) => (ref.contactId ? c.contactId === ref.contactId : c.leadId === ref.leadId))[0];
}

/** Finds or opens the person's conversation and records a message in it. */
export function touch(store: Store, ref: Ref, channel: Channel, direction: "inbound" | "outbound", preview: string, at: string): Conversation {
  const cur =
    conversationOf(store, ref) ??
    store.insert("conversations", "cv", {
      // Callers may pass an entire email/SMS (structural typing). Never spread its id or payload
      // into a conversation: doing so overwrites the generated cv_ id and copies private message fields.
      contactId: ref.contactId,
      leadId: ref.leadId,
      channels: [] as Channel[],
      status: "open" as const,
      ownerId: ownerOf(store, ref),
      unread: false,
      lastMessageAt: null as string | null,
      lastDirection: null as "inbound" | "outbound" | null,
      lastMessagePreview: null as string | null,
      lastInboundAt: null as string | null,
      lastOutboundAt: null as string | null,
      comments: [],
      createdAt: at,
      closedAt: null as string | null,
    });
  const latest = !cur.lastMessageAt || at >= cur.lastMessageAt;
  return store.update<Conversation>("conversations", cur.id, {
    channels: cur.channels.includes(channel) ? cur.channels : [...cur.channels, channel],
    ...(latest ? { lastMessageAt: at, lastDirection: direction, lastMessagePreview: preview.slice(0, 80) } : {}),
    ...(direction === "inbound" ? { unread: true, status: "open", closedAt: null, lastInboundAt: max(cur.lastInboundAt, at) } : { lastOutboundAt: max(cur.lastOutboundAt, at) }),
  });
}

const max = (a: string | null, b: string) => (a && a > b ? a : b);

function ownerOf(store: Store, ref: Ref): string | null {
  const doc = ref.contactId ? store.get<Contact>("contacts", ref.contactId) : ref.leadId ? store.get<Lead>("leads", ref.leadId) : undefined;
  return doc?.ownerId ?? null;
}

export function optOut(store: Store, channel: Channel, address: string): OptOut | undefined {
  return store.find<OptOut>("opt_outs", (o) => o.channel === channel && lower(o.address) === lower(address))[0];
}

/**
 * Why we may not message this person on this channel, or null if we may. Transactional email (invoices)
 * ignores marketing preferences and unsubscribes; do-not-disturb and opt-outs block everything else.
 */
export function blocked(store: Store, p: Person, channel: Channel, transactional = false): string | null {
  const address = channel === "sms" ? p.phone : p.email;
  if (!address) return `${p.name} has no ${channel === "sms" ? "phone number" : "email address"}`;
  if (channel === "sms" && !PHONE.test(address)) return `${p.name}'s phone number ${address} isn't a valid mobile number (+ and 10–15 digits)`;
  if (transactional) return null;
  const o = optOut(store, channel, address);
  if (o) return `${p.name} ${channel === "sms" ? "opted out of SMS" : "unsubscribed from email"} on ${o.at.slice(0, 10)}`;
  if (p.type === "contact") {
    const c = store.get<Contact>("contacts", p.id)!;
    if (c.preferences.dnd) return `${p.name} is on do-not-disturb`;
    if (!c.preferences[channel]) return `${p.name} doesn't accept ${channel === "sms" ? "text messages" : "email"}`;
  }
  return null;
}

export function requireReachable(store: Store, p: Person, channel: Channel, transactional = false): void {
  const why = blocked(store, p, channel, transactional);
  if (why) throw new ActionError("CONFLICT", why, { channel });
}

/** Sends an SMS that's already stored (draft or scheduled) and records it in the conversation. */
export function deliverSms(store: Store, s: Sms, at: string): Sms {
  const failed = s.to.endsWith("0000");
  const conv = touch(store, s, "sms", "outbound", s.body, at);
  return store.update<Sms>("sms", s.id, {
    conversationId: conv.id,
    status: failed ? "failed" : "delivered",
    sentAt: at,
    deliveredAt: failed ? null : at,
    failureReason: failed ? "Carrier rejected: the number is a landline and can't receive texts" : null,
  });
}

/** Sends an email that's already stored, records it in the conversation, and logs invoice reminders on the invoice. */
export function deliverEmail(store: Store, e: Email, at: string): Email {
  const bounced = e.to.toLowerCase().split("@")[1]?.includes("bounce") ?? false;
  // An unlinked ticket may have only an explicit requester address. Do not attach it to an unrelated contact.
  const conv = e.contactId || e.leadId ? touch(store, e, "email", "outbound", e.subject, at) : undefined;
  const out = store.update<Email>("emails", e.id, {
    conversationId: conv?.id ?? null,
    status: bounced ? "bounced" : "delivered",
    sentAt: at,
    deliveredAt: bounced ? null : at,
    failureReason: bounced ? "Mailbox doesn't exist (hard bounce)" : null,
  });
  if (e.kind === "invoice_reminder" && e.invoiceId) {
    const inv = store.get<{ id: string; reminders: { at: string; emailId: string }[] }>("invoices", e.invoiceId);
    if (inv) store.update("invoices", inv.id, { reminders: [...inv.reminders, { at, emailId: e.id }], lastReminderAt: at });
  }
  return out;
}

/** The contact (preferred) or lead with this phone number or email address. */
export function sender(store: Store, channel: Channel, address: string): Ref | undefined {
  const match = (d: { phone: string | null; email: string | null }) => (channel === "sms" ? d.phone === address : !!d.email && lower(d.email) === lower(address));
  const c = store.find<Contact>("contacts", (c) => c.status === "active" && match(c))[0];
  if (c) return { contactId: c.id, leadId: null };
  const l = store.find<Lead>("leads", (l) => l.status !== "converted" && match(l))[0];
  return l ? { contactId: null, leadId: l.id } : undefined;
}

/** Records an opt-out by address; on a contact it also turns off that channel in their preferences. */
export function recordOptOut(store: Store, channel: Channel, address: string, ref: Ref, source: OptOut["source"], at: string): OptOut {
  if (optOut(store, channel, address)) throw new ActionError("CONFLICT", `${address} has already opted out of ${channel}`);
  if (ref.contactId) {
    const c = store.get<Contact>("contacts", ref.contactId)!;
    store.update("contacts", c.id, { preferences: { ...c.preferences, [channel]: false }, updatedAt: at });
  }
  return store.insert("opt_outs", "oo", { channel, address, ...ref, source, at });
}
