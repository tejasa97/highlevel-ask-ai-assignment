import { z } from "zod";
import { ActionError, type ActionContext } from "../../registry/define.js";
import { person } from "../../registry/helpers.js";
import {
  deliverEmail,
  OUR_EMAIL,
  requireReachable,
} from "../m11-conversations/messaging.js";
import type { Email } from "./schema.js";

/** These emails may only be sent by their owning action, which also updates its domain records. */
export function ownedEmailBlocker(kind: string): string | undefined {
  return kind === "review_request"
    ? "Use Send review request (M45.A02) to send this email"
    : kind === "ticket_reply"
      ? "Use Reply to ticket requester (M47.A08) to send this email"
      : undefined;
}

/** Called inside the owning action's transaction. A failed delivery rolls back its domain changes too. */
export function sendOwnedEmail(
  ctx: ActionContext,
  a: {
    kind: "review_request" | "ticket_reply";
    contactId: string | null;
    to?: string | null;
    subject: string;
    body: string;
  },
): Email {
  let to = a.to;
  if (a.contactId) {
    const p = person(
      ctx.store,
      { contactId: a.contactId },
      "receive this email",
    );
    if (to && p.email && to.toLowerCase() !== p.email.toLowerCase())
      throw new ActionError(
        "INVALID",
        "The requester email does not match the linked contact",
      );
    to = to ?? p.email;
    requireReachable(
      ctx.store,
      { ...p, email: to ?? null },
      "email",
      a.kind === "ticket_reply",
    );
  }
  if (!to || !z.email().safeParse(to).success)
    throw new ActionError(
      "CONFLICT",
      "The requester has no valid email address",
    );
  const at = ctx.clock.now().toISOString();
  const e = ctx.store.insert("emails", "em", {
    contactId: a.contactId,
    leadId: null,
    conversationId: null,
    to,
    from: OUR_EMAIL,
    subject: a.subject,
    body: a.body,
    kind: a.kind,
    invoiceId: null,
    campaignId: null,
    direction: "outbound",
    status: "draft",
    scheduledAt: null,
    sentAt: null,
    deliveredAt: null,
    failureReason: null,
    createdBy: ctx.actorId ?? "us_1",
    createdAt: at,
  }) as Email;
  const out = deliverEmail(ctx.store, e, at);
  if (out.status !== "delivered")
    throw new ActionError(
      "UNAVAILABLE",
      out.failureReason ?? "The email was not delivered",
    );
  return out;
}
