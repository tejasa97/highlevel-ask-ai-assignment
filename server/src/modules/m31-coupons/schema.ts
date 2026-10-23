import { z } from "zod";

/** Shared by coupons (M31), quotes (M27) and orders (M32). */
export const Discount = z.object({
  type: z.enum(["percent", "amount"]),
  /** percent: 0–100; amount: USD off. */
  value: z.number().positive(),
});
export type Discount = z.infer<typeof Discount>;

export const Coupon = z.object({
  id: z.string(),
  /** Upper-case, unique. Redeemed by typing it in. */
  code: z.string(),
  description: z.string().nullable(),
  discount: Discount,
  validFrom: z.string().nullable(),
  validUntil: z.string().nullable(),
  /** null = unlimited. `redemptions` counts submitted orders that used it. */
  maxRedemptions: z.number().int().min(1).nullable(),
  redemptions: z.number().int().min(0),
  /** Empty = applies to every product; otherwise only to lines for these products. */
  productIds: z.array(z.string()),
  status: z.enum(["active", "inactive"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Coupon = z.infer<typeof Coupon>;
