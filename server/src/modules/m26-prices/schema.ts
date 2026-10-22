import { z } from "zod";

export const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD"] as const;
export const BILLING_INTERVALS = ["one_time", "day", "week", "month", "year"] as const;

export const Price = z.object({
  id: z.string(),
  productId: z.string(),
  label: z.string(),
  amount: z.number().min(0),
  currency: z.enum(CURRENCIES),
  interval: z.enum(BILLING_INTERVALS),
  /** Every N intervals (2 + month = every two months); 1 for one_time. */
  intervalCount: z.number().int().min(1),
  trialDays: z.number().int().min(0),
  /** Exactly one active price per product is the default (also `products.defaultPriceId`). */
  isDefault: z.boolean(),
  status: z.enum(["active", "archived"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Price = z.infer<typeof Price>;

// Quotes, orders, invoices and payments are USD only: adding a non-USD price to one is CONFLICT.
