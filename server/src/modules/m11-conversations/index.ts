import { z } from "zod";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import { activeUser, contains, inDateRange, Limit, listOf, page, PersonArgs, personName, requireState } from "../../registry/helpers.js";
import type { ModuleExports } from "../../registry/registry.js";
import type { Store } from "../../store/db.js";
import type { Email } from "../m13-email/schema.js";
import type { Sms } from "../m12-sms/schema.js";
import { CHANNELS, Conversation } from "./schema.js";

export { Conversation } from "./schema.js";

// One thread per contact or lead, holding their SMS and email both ways. Sending happens in M12 SMS and
// M13 Email; this module is the inbox: who's waiting on whom, ownership, read state and internal comments.

const ConversationId = z.string().describe("conversation id (cv_…)");

const Message = z.object({
  id: z.string(),
  channel: z.enum(CHANNELS),
  direction: z.enum(["inbound", "outbound"]),
  status: z.string(),
  at: z.string(),
  subject: z.string().nullable(),
  body: z.string(),
});
type Message = z.infer<typeof Message>;

/** Sent and received messages in a conversation, oldest first. Drafts, scheduled and cancelled ones aren't in it yet. */
function messages(store: Store, c: Conversation): Message[] {
  const live = (s: string) => !["draft", "scheduled", "cancelled"].includes(s);
  const sms = store.find<Sms>("sms", (m) => m.conversationId === c.id && live(m.status));
  const emails = store.find<Email>("emails", (m) => m.conversationId === c.id && live(m.status));
  return [
    ...sms.map((m) => ({ id: m.id, channel: "sms" as const, direction: m.direction, status: m.status, at: m.sentAt ?? m.createdAt, subject: null, body: m.body })),
    ...emails.map((m) => ({ id: m.id, channel: "email" as const, direction: m.direction, status: m.status, at: m.sentAt ?? m.createdAt, subject: m.subject, body: m.body })),
  ].sort((x, y) => x.at.localeCompare(y.at));
}

const Row = Conversation.extend({ personName: z.string().nullable() });
const row = (store: Store, c: Conversation) => ({ ...c, personName: personName(store, c) });

const getConversation = defineAction({
  id: "M11.A01",
  description: "Open a conversation: who it's with, its status and owner, and every SMS and email sent and received, oldest first.",
  risk: "read",
  input: z.strictObject({ conversationId: ConversationId }),
  output: Row.extend({ messages: z.array(Message) }),
  entities: { consumes: ["conversation"] },
  example: () => ({ conversationId: "cv_1" }),
  handler: ({ conversationId }, { store }) => {
    const c = mustGet<Conversation>(store, "conversations", conversationId, "conversation");
    return { ...row(store, c), messages: messages(store, c) };
  },
});

const searchConversations = defineAction({
  id: "M11.A02",
  description:
    "Find conversations by contact or lead, owner, open/closed, unread, channel, or when the last message was. Newest activity first. To find who's waiting for a reply, use M11.A10 List unanswered.",
  risk: "read",
  input: z.strictObject({
    ...PersonArgs,
    ownerId: z.string().optional(),
    status: z.enum(["open", "closed"]).optional(),
    unread: z.boolean().optional(),
    channel: z.enum(CHANNELS).optional(),
    lastMessageFrom: z.iso.date().optional(),
    lastMessageTo: z.iso.date().optional(),
    query: z.string().optional().describe("part of the person's name or the last message"),
    limit: Limit,
  }),
  output: listOf(Row),
  siblings: ["M11.A10"],
  entities: { produces: "conversation" },
  example: () => ({ unread: true }),
  handler: (a, { store }) => {
    const items = store
      .all<Conversation>("conversations")
      .map((c) => row(store, c))
      .filter(
        (c) =>
          (!a.contactId || c.contactId === a.contactId) &&
          (!a.leadId || c.leadId === a.leadId) &&
          (!a.ownerId || c.ownerId === a.ownerId) &&
          (!a.status || c.status === a.status) &&
          (a.unread === undefined || c.unread === a.unread) &&
          (!a.channel || c.channels.includes(a.channel)) &&
          ((!a.lastMessageFrom && !a.lastMessageTo) || (!!c.lastMessageAt && inDateRange(c.lastMessageAt, a.lastMessageFrom, a.lastMessageTo))) &&
          (!a.query || contains(c.personName, a.query) || contains(c.lastMessagePreview, a.query)),
      );
    items.sort((x, y) => (y.lastMessageAt ?? "").localeCompare(x.lastMessageAt ?? ""));
    return page(items, a.limit);
  },
});

const assignOwner = defineAction({
  id: "M11.A03",
  description: "Make a user responsible for answering a conversation. To change who owns the contact or lead itself, use M01.A07 or M03.A05.",
  risk: "write",
  input: z.strictObject({ conversationId: ConversationId, ownerId: z.string().describe("user id") }),
  output: Conversation,
  siblings: ["M01.A07", "M03.A05"],
  entities: { consumes: ["conversation", "user"] },
  example: () => ({ conversationId: "cv_1", ownerId: "us_5" }),
  handler: ({ conversationId, ownerId }, { store }) => {
    const c = mustGet<Conversation>(store, "conversations", conversationId, "conversation");
    const u = activeUser(store, ownerId, "own conversations");
    if (c.ownerId === u.id) throw new ActionError("CONFLICT", `${u.name} already owns this conversation`);
    return store.update<Conversation>("conversations", c.id, { ownerId: u.id });
  },
});

const readState = (id: string, unread: boolean, description: string) =>
  defineAction({
    id,
    description,
    risk: "write",
    input: z.strictObject({ conversationId: ConversationId }),
    output: Conversation,
    entities: { consumes: ["conversation"] },
    example: (f) => ({ conversationId: f.conversation({ unread: !unread }).id }),
    handler: ({ conversationId }, { store }) => {
      const c = mustGet<Conversation>(store, "conversations", conversationId, "conversation");
      if (c.unread === unread) throw new ActionError("CONFLICT", `The conversation is already ${unread ? "unread" : "read"}`);
      return store.update<Conversation>("conversations", c.id, { unread });
    },
  });

const markRead = readState("M11.A04", false, "Mark a conversation as read.");
const markUnread = readState("M11.A05", true, "Mark a conversation as unread, so it shows up again as needing attention.");

const closeConversation = defineAction({
  id: "M11.A06",
  description: "Close a conversation that needs nothing more. A new message from the person reopens it.",
  risk: "write",
  input: z.strictObject({ conversationId: ConversationId }),
  output: Conversation,
  entities: { consumes: ["conversation"] },
  example: (f) => ({ conversationId: f.conversation().id }),
  handler: ({ conversationId }, { store, clock }) => {
    const c = mustGet<Conversation>(store, "conversations", conversationId, "conversation");
    requireState("The conversation", c.status, ["open"], "close it");
    return store.update<Conversation>("conversations", c.id, { status: "closed", closedAt: clock.now().toISOString() });
  },
});

const reopenConversation = defineAction({
  id: "M11.A07",
  description: "Reopen a closed conversation.",
  risk: "write",
  input: z.strictObject({ conversationId: ConversationId }),
  output: Conversation,
  entities: { consumes: ["conversation"] },
  example: (f) => ({ conversationId: f.conversation({ status: "closed", closedAt: f.at(-1) }).id }),
  handler: ({ conversationId }, { store }) => {
    const c = mustGet<Conversation>(store, "conversations", conversationId, "conversation");
    requireState("The conversation", c.status, ["closed"], "reopen it");
    return store.update<Conversation>("conversations", c.id, { status: "open", closedAt: null });
  },
});

const addComment = defineAction({
  id: "M11.A08",
  description: "Leave an internal comment on a conversation for teammates. The customer never sees it. To message the customer, use M12.A03 Send SMS or M13.A03 Send email.",
  risk: "write",
  input: z.strictObject({ conversationId: ConversationId, body: z.string().min(1) }),
  output: Conversation,
  siblings: ["M07.A01"],
  entities: { consumes: ["conversation"] },
  example: () => ({ conversationId: "cv_1", body: "Raj, can you take this one? They asked about Agency pricing." }),
  handler: ({ conversationId, body }, { store, clock, actorId }) => {
    const c = mustGet<Conversation>(store, "conversations", conversationId, "conversation");
    return store.update<Conversation>("conversations", c.id, { comments: [...c.comments, { body, authorId: actorId ?? "us_1", at: clock.now().toISOString() }] });
  },
});

const hoursSince = (iso: string, now: Date) => Math.floor((now.getTime() - new Date(iso).getTime()) / 3_600_000);

const summarize = defineAction({
  id: "M11.A09",
  description: "Sum up a conversation: how many messages each way and on which channel, when it started, the last message each way, and who is waiting on whom.",
  risk: "read",
  input: z.strictObject({ conversationId: ConversationId }),
  output: z.object({
    conversationId: z.string(),
    personName: z.string().nullable(),
    inbound: z.object({ sms: z.number(), email: z.number() }),
    outbound: z.object({ sms: z.number(), email: z.number() }),
    firstMessageAt: z.string().nullable(),
    lastInboundAt: z.string().nullable(),
    lastOutboundAt: z.string().nullable(),
    waitingOn: z.enum(["contact", "team", "nobody"]).describe("contact = we wrote last; team = they wrote last; nobody = closed or empty"),
    hoursWaiting: z.number().nullable(),
    recent: z.array(Message).describe("the last 3 messages"),
  }),
  entities: { consumes: ["conversation"] },
  example: () => ({ conversationId: "cv_1" }),
  handler: ({ conversationId }, { store, clock }) => {
    const c = mustGet<Conversation>(store, "conversations", conversationId, "conversation");
    const ms = messages(store, c);
    const count = (dir: string, ch: string) => ms.filter((m) => m.direction === dir && m.channel === ch).length;
    const waitingOn: "contact" | "team" | "nobody" = c.status === "closed" || !c.lastDirection ? "nobody" : c.lastDirection === "outbound" ? "contact" : "team";
    return {
      conversationId: c.id,
      personName: personName(store, c),
      inbound: { sms: count("inbound", "sms"), email: count("inbound", "email") },
      outbound: { sms: count("outbound", "sms"), email: count("outbound", "email") },
      firstMessageAt: ms[0]?.at ?? null,
      lastInboundAt: c.lastInboundAt,
      lastOutboundAt: c.lastOutboundAt,
      waitingOn,
      hoursWaiting: waitingOn === "nobody" || !c.lastMessageAt ? null : hoursSince(c.lastMessageAt, clock.now()),
      recent: ms.slice(-3),
    };
  },
});

const unanswered = defineAction({
  id: "M11.A10",
  description:
    'List open conversations waiting for a reply, longest wait first. waitingOn "team" = the customer wrote last and we haven\'t answered. waitingOn "contact" = we wrote last and they haven\'t replied (e.g. leads who never answered our follow-up). People we never messaged have no conversation, so they don\'t appear.',
  risk: "read",
  input: z.strictObject({
    waitingOn: z.enum(["team", "contact"]).describe('"team": they wrote last; "contact": we wrote last, no reply yet'),
    personType: z.enum(["contact", "lead"]).optional(),
    ownerId: z.string().optional(),
    minHours: z.number().min(0).optional().describe("only those waiting at least this long"),
    limit: Limit,
  }),
  output: listOf(
    z.object({
      conversationId: z.string(),
      contactId: z.string().nullable(),
      leadId: z.string().nullable(),
      personName: z.string().nullable(),
      ownerId: z.string().nullable(),
      waitingSince: z.string(),
      hoursWaiting: z.number(),
      lastMessagePreview: z.string().nullable(),
    }),
  ),
  siblings: ["M11.A02"],
  entities: { produces: "conversation" },
  example: () => ({ waitingOn: "contact", personType: "lead" }),
  handler: (a, { store, clock }) => {
    const now = clock.now();
    const dir = a.waitingOn === "team" ? "inbound" : "outbound";
    const items = store
      .find<Conversation>(
        "conversations",
        (c) =>
          c.status === "open" &&
          c.lastDirection === dir &&
          !!c.lastMessageAt &&
          (!a.personType || (a.personType === "contact" ? !!c.contactId : !!c.leadId)) &&
          (!a.ownerId || c.ownerId === a.ownerId),
      )
      .map((c) => ({
        conversationId: c.id,
        contactId: c.contactId,
        leadId: c.leadId,
        personName: personName(store, c),
        ownerId: c.ownerId,
        waitingSince: c.lastMessageAt!,
        hoursWaiting: hoursSince(c.lastMessageAt!, now),
        lastMessagePreview: c.lastMessagePreview,
      }))
      .filter((c) => a.minHours === undefined || c.hoursWaiting >= a.minHours);
    items.sort((x, y) => x.waitingSince.localeCompare(y.waitingSince));
    return page(items, a.limit);
  },
});

export default {
  actions: [getConversation, searchConversations, assignOwner, markRead, markUnread, closeConversation, reopenConversation, addComment, summarize, unanswered],
} satisfies ModuleExports;
