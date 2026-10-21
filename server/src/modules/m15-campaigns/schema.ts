import { z } from "zod";

export const CAMPAIGN_STATUSES = ["draft", "scheduled", "active", "paused", "completed"] as const;

export const Step = z.object({
  order: z.number().int(),
  channel: z.enum(["email", "sms"]),
  subject: z.string().nullable().describe("email steps only"),
  body: z.string(),
  delayDays: z.number().int().min(0).describe("days after launch"),
});
export type Step = z.infer<typeof Step>;

/** A marketing campaign: a sequence of messages sent to an audience of contacts. */
export const Campaign = z.object({
  id: z.string(),
  name: z.string(),
  channel: z.enum(["email", "sms"]).describe("the main channel"),
  status: z.enum(CAMPAIGN_STATUSES),
  /** Contacts with this tag, plus these contacts. */
  audience: z.object({ tag: z.string().nullable(), contactIds: z.array(z.string()) }),
  steps: z.array(Step),
  startAt: z.string().nullable(),
  launchedAt: z.string().nullable(),
  pausedAt: z.string().nullable(),
  ownerId: z.string().nullable(),
  createdAt: z.string(),
});
export type Campaign = z.infer<typeof Campaign>;
