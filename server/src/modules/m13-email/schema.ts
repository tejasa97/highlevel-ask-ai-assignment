import { z } from "zod";

export const EMAIL_STATUSES = ["draft", "scheduled", "sent", "delivered", "bounced", "cancelled", "received"] as const;
/** invoice and invoice_reminder are transactional: they go out even to people who unsubscribed from marketing. */
export const EMAIL_KINDS = ["general", "invoice", "invoice_reminder", "campaign"] as const;

export const Email = z.object({
  id: z.string(),
  conversationId: z.string().nullable(),
  contactId: z.string().nullable(),
  leadId: z.string().nullable(),
  to: z.string(),
  from: z.string(),
  subject: z.string(),
  body: z.string(),
  kind: z.enum(EMAIL_KINDS),
  invoiceId: z.string().nullable(),
  campaignId: z.string().nullable(),
  direction: z.enum(["outbound", "inbound"]),
  status: z.enum(EMAIL_STATUSES),
  scheduledAt: z.string().nullable(),
  sentAt: z.string().nullable(),
  deliveredAt: z.string().nullable(),
  failureReason: z.string().nullable(),
  createdBy: z.string().nullable().describe("user id; null for inbound"),
  createdAt: z.string(),
});
export type Email = z.infer<typeof Email>;
