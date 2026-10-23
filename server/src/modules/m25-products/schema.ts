import { z } from "zod";

export const ProductVariant = z.object({
  id: z.string(),
  name: z.string(),
  sku: z.string().nullable(),
  /** Units on hand; null = not tracked (always available). */
  inventory: z.number().int().min(0).nullable(),
});
export type ProductVariant = z.infer<typeof ProductVariant>;

export const Product = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  /** Unique across products and variants. */
  sku: z.string().nullable(),
  /** Units on hand when the product has no variants; null = not tracked. With variants, availability is the sum of theirs. */
  inventory: z.number().int().min(0).nullable(),
  variants: z.array(ProductVariant),
  /** Matches a tax rule's productCategory (M34). */
  taxCategory: z.string().nullable(),
  /** The price (M26) used when a quote or order doesn't name one. */
  defaultPriceId: z.string().nullable(),
  status: z.enum(["active", "archived"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Product = z.infer<typeof Product>;
