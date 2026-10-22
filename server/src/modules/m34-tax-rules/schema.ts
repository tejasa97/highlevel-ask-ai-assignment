import { z } from "zod";

export const TaxRule = z.object({
  id: z.string(),
  name: z.string(),
  /** Percent, 0–100. */
  rate: z.number().min(0).max(100),
  /** Country ("US") or country-region ("US-CA"); a more specific region wins over a broader one. */
  region: z.string(),
  /** null = applies to every product category; otherwise only products with this `taxCategory` (M25). */
  productCategory: z.string().nullable(),
  /** Prices already include this tax; the tax is carved out of the total instead of added on top. */
  inclusive: z.boolean(),
  status: z.enum(["active", "inactive"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TaxRule = z.infer<typeof TaxRule>;

export const TaxExemption = z.object({
  id: z.string(),
  contactId: z.string(),
  certificateNumber: z.string(),
  reason: z.string().nullable(),
  /** Empty = exempt everywhere. */
  regions: z.array(z.string()),
  expiresAt: z.string().nullable(),
  recordedBy: z.string(),
  createdAt: z.string(),
});
export type TaxExemption = z.infer<typeof TaxExemption>;
