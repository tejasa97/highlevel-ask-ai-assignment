import { z } from "zod";

/** Record types a smart list can filter, and the table each lives in. */
export const SMART_LIST_TABLES = { contact: "contacts", lead: "leads", opportunity: "opportunities", company: "companies" } as const;
export const SMART_LIST_TARGETS = ["contact", "lead", "opportunity", "company"] as const;

export const FILTER_OPS = ["eq", "neq", "contains", "gt", "lt", "in", "is_empty", "is_not_empty"] as const;

export const FilterRule = z.object({
  /** A top-level field of the record, or `tags` (matches any element), or `cf.<fieldKey>` for a custom field (M10). */
  field: z.string(),
  op: z.enum(FILTER_OPS),
  value: z.unknown().optional(),
});
export type FilterRule = z.infer<typeof FilterRule>;

export const SmartList = z.object({
  id: z.string(),
  name: z.string(),
  target: z.enum(SMART_LIST_TARGETS),
  /** Every rule must match (AND). */
  rules: z.array(FilterRule),
  createdBy: z.string(),
  status: z.enum(["active", "deleted"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SmartList = z.infer<typeof SmartList>;
