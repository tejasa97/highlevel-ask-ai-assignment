import { z } from "zod";

export const REQUEST_STATUSES = [
  "draft",
  "sent",
  "failed",
  "cancelled",
  "fulfilled",
] as const;
export const ReviewRequest = z.object({
  id: z.string(),
  contactId: z.string(),
  status: z.enum(REQUEST_STATUSES),
  subject: z.string(),
  body: z.string(),
  emailId: z.string().nullable(),
  /** Why the email bounced, while the request is `failed`. */
  failureReason: z.string().nullable().optional(),
  createdAt: z.string(),
  sentAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  fulfilledAt: z.string().nullable(),
  reviewId: z.string().nullable(),
});
export type ReviewRequest = z.infer<typeof ReviewRequest>;
export const Review = z.object({
  id: z.string(),
  contactId: z.string(),
  requestId: z.string().nullable(),
  rating: z.number().int().min(1).max(5),
  body: z.string(),
  responseDraft: z.string().nullable(),
  publishedResponse: z.string().nullable(),
  publishedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type Review = z.infer<typeof Review>;
