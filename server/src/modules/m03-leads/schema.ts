import { z } from "zod";

export const LEAD_SOURCES = ["facebook_ads", "google_ads", "website", "referral", "event", "manual"] as const;
export const LEAD_STATUSES = ["new", "contacted", "qualified", "disqualified", "converted"] as const;
export const DISQUALIFY_REASONS = ["no_budget", "no_need", "bad_timing", "unreachable", "competitor", "spam", "other"] as const;

export const Qualification = z.object({
  budget: z.string().nullable().describe("what they can spend"),
  authority: z.string().nullable().describe("who decides"),
  need: z.string().nullable().describe("the problem they want solved"),
  timeline: z.string().nullable().describe("when they want to buy"),
});
export type Qualification = z.infer<typeof Qualification>;

export const Lead = z.object({
  id: z.string(),
  firstName: z.string(),
  lastName: z.string().nullable(),
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  company: z.string().nullable(),
  source: z.enum(LEAD_SOURCES),
  /** The campaign that brought the lead in, if any. */
  campaignId: z.string().nullable(),
  status: z.enum(LEAD_STATUSES),
  score: z.number().int().min(0).max(100),
  ownerId: z.string().nullable(),
  qualification: Qualification,
  disqualifyReason: z.enum(DISQUALIFY_REASONS).nullable(),
  disqualifyNote: z.string().nullable(),
  /** Set by Convert lead to opportunity. */
  convertedTo: z.object({ contactId: z.string(), opportunityId: z.string() }).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Lead = z.infer<typeof Lead>;
