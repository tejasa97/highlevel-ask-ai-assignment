import { z } from "zod";
import { ActionError, defineAction, mustGet, type ActionContext } from "../../registry/define.js";
import {
  activeUser,
  candidates,
  inDateRange,
  Limit,
  listOf,
  norm,
  page,
  permissionsOf,
  person,
  personName,
  requirePermission,
  requireState,
} from "../../registry/helpers.js";
import type { ModuleExports } from "../../registry/registry.js";
import type { Store } from "../../store/db.js";
import { ownedEmailRecipient, sendOwnedEmail } from "../m13-email/owned.js";
import {
  dueAt,
  PRIORITIES,
  SLA_HOURS,
  Ticket,
  TICKET_STATUSES,
} from "./schema.js";

const Text = z.string().trim().min(1);
const TicketId = Text.describe("support ticket id (tic_…)");
const get = (store: Store, id: string) =>
  mustGet<Ticket>(store, "tickets", id, "support ticket");
const mutable = (t: Ticket) =>
  requireState(
    `Ticket ${t.title}`,
    t.status,
    ["open", "in_progress"],
    "change or receive a reply; reopen it first",
  );
function owner(store: Store, id: string) {
  const u = activeUser(store, id, "own support tickets");
  if (!u.available || !permissionsOf(u).includes("tickets.manage"))
    throw new ActionError(
      "CONFLICT",
      `${u.name} must be available and have tickets.manage to own support tickets`,
    );
  return u;
}
const detail = (s: Store, t: Ticket) => ({
  ...t,
  personName: personName(s, { contactId: t.contactId, leadId: null }),
});
/** What a search words match against: the ticket's own text plus who asked, so "Dorian Vale receipt" finds it. */
const text = (s: Store, t: Ticket) =>
  norm([t.title, t.body, personName(s, { contactId: t.contactId, leadId: null }), t.requesterEmail].filter(Boolean).join(" "));
const Detail = Ticket.extend({ personName: z.string().nullable() });
const create = defineAction({
  id: "M47.A01",
  description:
    "Open a support ticket with title and body. Give contactId or requesterEmail; an optional owner must be an available support/manager/admin user. Defaults: normal priority, open status.",
  risk: "write",
  input: z.strictObject({
    title: Text,
    body: Text,
    contactId: Text.optional(),
    requesterEmail: z.email().optional(),
    ownerId: Text.optional(),
    priority: z.enum(PRIORITIES).optional(),
  }),
  output: Ticket,
  entities: { produces: "ticket", consumes: ["contact", "user"] },
  example: (f) => ({
    title: "Portal problem",
    body: "Export fails",
    contactId: f.contact().id,
  }),
  handler: (a, { store, clock }) => {
    const p = a.contactId
      ? person(store, { contactId: a.contactId }, "open a ticket")
      : undefined;
    if (!p && !a.requesterEmail)
      throw new ActionError("INVALID", "Give contactId or requesterEmail");
    if (
      p?.email &&
      a.requesterEmail &&
      p.email.toLowerCase() !== a.requesterEmail.toLowerCase()
    )
      throw new ActionError(
        "INVALID",
        "The requester email does not match the contact",
      );
    if (a.ownerId) owner(store, a.ownerId);
    const at = clock.now().toISOString();
    return store.insert("tickets", "tic", {
      title: a.title,
      body: a.body,
      contactId: a.contactId ?? null,
      requesterEmail: a.requesterEmail ?? p?.email ?? null,
      ownerId: a.ownerId ?? null,
      priority: a.priority ?? "normal",
      status: "open" as const,
      notes: [],
      replies: [],
      createdAt: at,
      updatedAt: at,
      resolvedAt: null,
      closedAt: null,
      firstResponseAt: null,
      firstResponseDueAt: null,
      history: [],
    });
  },
});
const details = defineAction({
  id: "M47.A02",
  description:
    "Get a support ticket with requester, description, owner, status, priority, internal notes and reply history.",
  risk: "read",
  input: z.strictObject({ ticketId: TicketId }),
  output: Detail,
  entities: { consumes: ["ticket"] },
  example: (f) => ({ ticketId: f.ticket().id }),
  handler: ({ ticketId }, { store }) => detail(store, get(store, ticketId)),
});
const search = defineAction({
  id: "M47.A03",
  description:
    "Search support tickets by text (matched against title, body, requester name and email: every word must appear somewhere), contact, owner, priority or status; newest first. With no status filter includes resolved and closed tickets.",
  risk: "read",
  input: z.strictObject({
    query: Text.optional(),
    contactId: Text.optional(),
    ownerId: Text.optional(),
    priority: z.enum(PRIORITIES).optional(),
    status: z.enum(TICKET_STATUSES).optional(),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    limit: Limit,
  }),
  output: listOf(Detail),
  entities: { produces: "ticket" },
  example: () => ({ status: "open" }),
  handler: (a, { store }) => {
    const words = a.query ? norm(a.query).split(" ").filter(Boolean) : null;
    return page(
      store
        .find<Ticket>(
          "tickets",
          (t) =>
            (!words ||
              words.every((w) => text(store, t).includes(w))) &&
            (!a.contactId || t.contactId === a.contactId) &&
            (!a.ownerId || t.ownerId === a.ownerId) &&
            (!a.priority || t.priority === a.priority) &&
            (!a.status || t.status === a.status) &&
            inDateRange(t.createdAt, a.from, a.to),
        )
        .sort(
          (x, y) =>
            y.createdAt.localeCompare(x.createdAt) || x.id.localeCompare(y.id),
        )
        .map((t) => detail(store, t)),
      a.limit,
    );
  },
});
const assign = defineAction({
  id: "M47.A04",
  description:
    "Assign a support ticket to an available user with tickets.manage (support/manager/admin). This assigns a ticket, not a task or contact. Reopen resolved/closed tickets first.",
  risk: "write",
  input: z.strictObject({ ticketId: TicketId, ownerId: Text }),
  output: Ticket,
  entities: { consumes: ["ticket", "user"] },
  example: (f) => ({ ticketId: f.ticket().id, ownerId: "us_2" }),
  handler: ({ ticketId, ownerId }, { store, clock }) => {
    const t = get(store, ticketId);
    mutable(t);
    owner(store, ownerId);
    if (t.ownerId === ownerId)
      throw new ActionError("CONFLICT", "The ticket already has this owner");
    return store.update<Ticket>("tickets", t.id, {
      ownerId,
      updatedAt: clock.now().toISOString(),
    });
  },
});
const priority = defineAction({
  id: "M47.A05",
  description:
    "Set an open/in-progress support ticket's low/normal/high/urgent priority. Before first response, its elapsed-time SLA deadline is recalculated from creation.",
  risk: "write",
  input: z.strictObject({ ticketId: TicketId, priority: z.enum(PRIORITIES) }),
  output: Ticket,
  entities: { consumes: ["ticket"] },
  example: (f) => ({ ticketId: f.ticket().id, priority: "urgent" }),
  handler: ({ ticketId, priority }, { store, clock }) => {
    const t = get(store, ticketId);
    mutable(t);
    if (t.priority === priority)
      throw new ActionError("CONFLICT", "The priority is unchanged");
    return store.update<Ticket>("tickets", t.id, {
      priority,
      updatedAt: clock.now().toISOString(),
    });
  },
});
const transitions: Record<Ticket["status"], Ticket["status"][]> = {
  open: ["in_progress", "resolved", "closed"],
  in_progress: ["open", "resolved", "closed"],
  resolved: ["open", "closed"],
  closed: ["open"],
};
const status = defineAction({
  id: "M47.A06",
  description:
    "Change support ticket status. open → in_progress/resolved/closed; in_progress → open/resolved/closed; resolved → open/closed; closed → open (reopen). Reopening preserves the original first-response SLA.",
  risk: "write",
  input: z.strictObject({
    ticketId: TicketId,
    status: z.enum(TICKET_STATUSES),
  }),
  output: Ticket,
  entities: { consumes: ["ticket"] },
  example: (f) => ({ ticketId: f.ticket().id, status: "resolved" }),
  handler: ({ ticketId, status }, { store, clock, actorId }) => {
    const t = get(store, ticketId);
    if (!transitions[t.status].includes(status))
      throw new ActionError(
        "CONFLICT",
        `Cannot change ${t.status} to ${status}; allowed: ${transitions[t.status].join(", ")}`,
      );
    const at = clock.now().toISOString();
    return store.update<Ticket>("tickets", t.id, {
      status,
      updatedAt: at,
      resolvedAt:
        status === "open" ? null : status === "resolved" ? at : t.resolvedAt,
      closedAt:
        status === "open" ? null : status === "closed" ? at : t.closedAt,
      history: [
        ...t.history,
        { from: t.status, to: status, at, by: actorId ?? "us_1" },
      ],
    });
  },
});
const note = defineAction({
  id: "M47.A07",
  description:
    "Append an internal private note to a support ticket, including closed tickets. Does not message the requester, add a contact note, reopen the ticket or count as an SLA response.",
  risk: "write",
  input: z.strictObject({ ticketId: TicketId, body: Text }),
  output: Ticket,
  entities: { produces: "ticket", consumes: ["ticket"] },
  example: (f) => ({ ticketId: f.ticket().id, body: "Investigating" }),
  handler: ({ ticketId, body }, { store, clock, actorId }) => {
    const t = get(store, ticketId),
      at = clock.now().toISOString();
    return store.update<Ticket>("tickets", t.id, {
      notes: [...t.notes, { body, by: actorId ?? "us_1", at }],
      updatedAt: at,
    });
  },
});
function replyTarget(ticketId: string, ctx: ActionContext) {
  requirePermission(ctx.store, ctx.actorId, "tickets.manage");
  requirePermission(ctx.store, ctx.actorId, "messaging.send");
  const t = get(ctx.store, ticketId);
  mutable(t);
  const to = ownedEmailRecipient(ctx, { kind: "ticket_reply", contactId: t.contactId, to: t.requesterEmail });
  return { ticket: t, to };
}
const reply = defineAction({
  id: "M47.A08",
  destination: { id: "email", label: "Email" },
  description:
    "Reply by email to a support ticket's requester with body. Only this action updates ticket replies and first-response SLA; do not use generic email/SMS/conversation send. Resolved/closed tickets must be reopened; success moves open to in_progress. Transactional: marketing opt-outs do not block, but an email address is required.",
  risk: "external",
  input: z.strictObject({ ticketId: TicketId, body: Text }),
  output: Ticket,
  entities: { produces: "ticket", consumes: ["ticket"] },
  example: (f) => ({ ticketId: f.ticket().id, body: "We are investigating" }),
  preflight: ({ ticketId }, ctx) => {
    const { ticket, to } = replyTarget(ticketId, ctx);
    return { ticketId, contactId: ticket.contactId, to };
  },
  handler: ({ ticketId, body }, ctx) => {
    const { ticket: t } = replyTarget(ticketId, ctx);
    const e = sendOwnedEmail(ctx, {
        kind: "ticket_reply",
        contactId: t.contactId,
        to: t.requesterEmail,
        subject: `Re: ${t.title}`,
        body,
      }),
      at = ctx.clock.now().toISOString();
    return ctx.store.update<Ticket>("tickets", t.id, {
      status: "in_progress",
      updatedAt: at,
      firstResponseAt: t.firstResponseAt ?? at,
      firstResponseDueAt: t.firstResponseDueAt ?? dueAt(t),
      replies: [...t.replies, { body, emailId: e.id, at }],
      history:
        t.status === "open"
          ? [
              ...t.history,
              {
                from: "open",
                to: "in_progress",
                at,
                by: ctx.actorId ?? "us_1",
              },
            ]
          : t.history,
    });
  },
});
const link = defineAction({
  id: "M47.A09",
  description:
    "Link an open/in-progress support ticket to a contact and use that contact's current email as requester address. Reopen resolved/closed tickets first.",
  risk: "write",
  input: z.strictObject({ ticketId: TicketId, contactId: Text }),
  output: Ticket,
  entities: { consumes: ["ticket", "contact"] },
  example: (f) => ({ ticketId: f.ticket().id, contactId: f.contact().id }),
  handler: ({ ticketId, contactId }, { store, clock }) => {
    const t = get(store, ticketId);
    mutable(t);
    const p = person(store, { contactId }, "be linked to a ticket");
    if (t.contactId === contactId)
      throw new ActionError(
        "CONFLICT",
        "The ticket is already linked to this contact",
      );
    return store.update<Ticket>("tickets", t.id, {
      contactId,
      requesterEmail: p.email ?? t.requesterEmail,
      updatedAt: clock.now().toISOString(),
    });
  },
});
const sla = defineAction({
  id: "M47.A10",
  description:
    "Get support ticket FIRST-RESPONSE SLA status (not resolution SLA). Elapsed hours since creation: urgent 1, high 4, normal 24, low 72. Internal notes do not count; reopening does not reset it.",
  risk: "read",
  input: z.strictObject({ ticketId: TicketId }),
  output: z.object({
    ticketId: z.string(),
    title: z.string(),
    status: z.enum(["pending", "met", "breached"]),
    policy: z.literal("first_response"),
    timeBasis: z.literal("elapsed"),
    priority: z.enum(PRIORITIES),
    targetHours: z.number(),
    createdAt: z.string(),
    dueAt: z.string(),
    firstResponseAt: z.string().nullable(),
    evaluatedAt: z.string(),
  }),
  entities: { consumes: ["ticket"] },
  example: (f) => ({ ticketId: f.ticket().id }),
  handler: ({ ticketId }, { store, clock }) => {
    const t = get(store, ticketId),
      due = dueAt(t),
      at = clock.now().toISOString();
    return {
      ticketId: t.id,
      title: t.title,
      policy: "first_response" as const,
      timeBasis: "elapsed" as const,
      priority: t.priority,
      targetHours: (Date.parse(due) - Date.parse(t.createdAt)) / 3_600_000,
      createdAt: t.createdAt,
      dueAt: due,
      firstResponseAt: t.firstResponseAt,
      evaluatedAt: at,
      status: t.firstResponseAt
        ? t.firstResponseAt <= due
          ? ("met" as const)
          : ("breached" as const)
        : at > due
          ? ("breached" as const)
          : ("pending" as const),
    };
  },
});
export default {
  actions: [
    create,
    details,
    search,
    assign,
    priority,
    status,
    note,
    reply,
    link,
    sla,
  ],
  resolvers: {
    ticket: (store, name) =>
      candidates(
        store.all<Ticket>("tickets").filter((t) =>
          norm(name)
            .split(" ")
            .some((w) => norm(t.title).split(" ").includes(w)),
        ),
        name,
        (t) =>
          `${t.title} ${personName(store, { contactId: t.contactId, leadId: null }) ?? ""}`,
        (t) => `${t.status}, ${t.id}`,
      ),
  },
} satisfies ModuleExports;
