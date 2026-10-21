import { z } from "zod";

export const CHANNELS = ["sms", "email"] as const;
export type Channel = (typeof CHANNELS)[number];

/** One thread per contact or lead, across SMS and email. Messages live in sms / emails and point back here. */
export const Conversation = z.object({
  id: z.string(),
  contactId: z.string().nullable(),
  leadId: z.string().nullable(),
  channels: z.array(z.enum(CHANNELS)),
  status: z.enum(["open", "closed"]),
  ownerId: z.string().nullable(),
  unread: z.boolean().describe("an inbound message nobody has read yet"),
  lastMessageAt: z.string().nullable(),
  lastDirection: z.enum(["inbound", "outbound"]).nullable().describe("inbound = they wrote last, outbound = we wrote last"),
  lastMessagePreview: z.string().nullable(),
  lastInboundAt: z.string().nullable(),
  lastOutboundAt: z.string().nullable(),
  /** Internal notes between staff; never sent to the customer. */
  comments: z.array(z.object({ body: z.string(), authorId: z.string(), at: z.string() })),
  createdAt: z.string(),
  closedAt: z.string().nullable(),
});
export type Conversation = z.infer<typeof Conversation>;

/** An SMS or email unsubscribe, by address, so it holds whichever record the address is on. */
export const OptOut = z.object({
  id: z.string(),
  channel: z.enum(CHANNELS),
  address: z.string().describe("phone number or email address"),
  contactId: z.string().nullable(),
  leadId: z.string().nullable(),
  source: z.enum(["reply_stop", "unsubscribe_link", "manual"]),
  at: z.string(),
});
export type OptOut = z.infer<typeof OptOut>;
