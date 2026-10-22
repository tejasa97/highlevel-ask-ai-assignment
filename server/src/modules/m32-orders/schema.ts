import { z } from "zod";

export const ORDER_STATUSES = ["draft", "submitted", "fulfilled", "cancelled"] as const;

export const OrderLine = z.object({
  id: z.string(),
  productId: z.string(),
  variantId: z.string().nullable(),
  priceId: z.string(),
  description: z.string(),
  quantity: z.number().int().min(1),
  unitPrice: z.number().min(0).describe("USD"),
  amount: z.number().describe("quantity × unitPrice"),
});
export type OrderLine = z.infer<typeof OrderLine>;

export const Address = z.object({ line1: z.string(), city: z.string(), region: z.string(), postalCode: z.string(), country: z.string() });
export type Address = z.infer<typeof Address>;

export const Order = z.object({
  id: z.string(),
  number: z.string().describe("e.g. ORD-1001"),
  contactId: z.string(),
  /** draft → submitted → fulfilled; a draft or submitted order can be cancelled. Lines, coupon and address change only in draft. */
  status: z.enum(ORDER_STATUSES),
  lines: z.array(OrderLine),
  shippingAddress: Address.nullable(),
  couponId: z.string().nullable(),
  subtotal: z.number(),
  discountTotal: z.number(),
  taxTotal: z.number().describe("from tax rules (M34) at submit time"),
  total: z.number(),
  currency: z.literal("USD"),
  /** Submitting creates an open invoice (M28); cancelling voids it. */
  invoiceId: z.string().nullable(),
  submittedAt: z.string().nullable(),
  fulfilledAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Order = z.infer<typeof Order>;
