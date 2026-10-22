import { z } from "zod";

export const SUBSCRIPTION_STATUSES = ["trialing", "active", "paused", "canceled"] as const;

export const Subscription = z.object({
  id: z.string(),
  contactId: z.string(),
  /** A recurring price (M26): interval is not one_time. The product comes from the price. */
  priceId: z.string(),
  productId: z.string(),
  quantity: z.number().int().min(1),
  status: z.enum(SUBSCRIPTION_STATUSES),
  trialEnd: z.string().nullable(),
  currentPeriodStart: z.string(),
  currentPeriodEnd: z.string(),
  pausedAt: z.string().nullable(),
  canceledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Subscription = z.infer<typeof Subscription>;
