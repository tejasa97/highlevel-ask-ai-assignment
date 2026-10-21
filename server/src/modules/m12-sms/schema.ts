import { z } from "zod";

export const SMS_STATUSES = ["draft", "scheduled", "sent", "delivered", "failed", "cancelled", "received"] as const;

export const Sms = z.object({
  id: z.string(),
  /** Set once the message is sent or received; drafts aren't in a conversation yet. */
  conversationId: z.string().nullable(),
  contactId: z.string().nullable(),
  leadId: z.string().nullable(),
  to: z.string(),
  from: z.string(),
  body: z.string(),
  campaignId: z.string().nullable().describe("the campaign that sent it"),
  direction: z.enum(["outbound", "inbound"]),
  status: z.enum(SMS_STATUSES),
  segments: z.number().int().describe("billed message parts"),
  encoding: z.enum(["GSM-7", "UCS-2"]),
  scheduledAt: z.string().nullable(),
  sentAt: z.string().nullable(),
  deliveredAt: z.string().nullable(),
  failureReason: z.string().nullable(),
  createdBy: z.string().nullable().describe("user id; null for inbound"),
  createdAt: z.string(),
});
export type Sms = z.infer<typeof Sms>;
