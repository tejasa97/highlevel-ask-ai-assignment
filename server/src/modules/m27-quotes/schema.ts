import { z } from "zod";
import { Discount } from "../m31-coupons/schema.js";

export const QUOTE_STATUSES = ["draft", "sent", "accepted", "declined", "expired", "converted"] as const;

export const QuoteLine = z.object({
  id: z.string(),
  description: z.string(),
  productId: z.string().nullable(),
  priceId: z.string().nullable(),
  quantity: z.number().positive(),
  unitPrice: z.number().min(0).describe("USD"),
  amount: z.number().describe("quantity × unitPrice"),
});
export type QuoteLine = z.infer<typeof QuoteLine>;

export const Quote = z.object({
  id: z.string(),
  number: z.string().describe("e.g. QT-1001"),
  contactId: z.string(),
  opportunityId: z.string().nullable(),
  /** draft → sent → accepted → converted; a sent quote can also be declined or expire. Lines are editable only in draft. */
  status: z.enum(QUOTE_STATUSES),
  lines: z.array(QuoteLine),
  discount: Discount.nullable(),
  subtotal: z.number(),
  total: z.number(),
  currency: z.literal("USD"),
  expiresAt: z.string().nullable(),
  sentAt: z.string().nullable(),
  decidedAt: z.string().nullable(),
  /** Set when converted (M27.A10 creates the invoice in M28). */
  invoiceId: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Quote = z.infer<typeof Quote>;
