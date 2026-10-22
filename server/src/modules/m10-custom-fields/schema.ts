import { z } from "zod";

/** Record types a custom field can extend, and the table each lives in. */
export const CUSTOM_FIELD_TABLES = { contact: "contacts", lead: "leads", opportunity: "opportunities", company: "companies" } as const;
export const CUSTOM_FIELD_MODULES = ["contact", "lead", "opportunity", "company"] as const;

export const FIELD_TYPES = ["text", "number", "date", "checkbox", "dropdown"] as const;

export const CustomField = z.object({
  id: z.string(),
  /** Stable machine name, unique per module (lead_budget). Smart-list filters address it as `cf.<key>`. */
  key: z.string(),
  label: z.string(),
  helpText: z.string().nullable(),
  module: z.enum(CUSTOM_FIELD_MODULES),
  type: z.enum(FIELD_TYPES),
  /** Dropdown choices. A retired option stays on records that already use it but can't be chosen again. */
  options: z.array(z.object({ value: z.string(), label: z.string(), retired: z.boolean() })),
  validation: z.object({ required: z.boolean(), min: z.number().nullable(), max: z.number().nullable(), pattern: z.string().nullable() }),
  status: z.enum(["active", "archived"]),
  createdAt: z.string(),
});
export type CustomField = z.infer<typeof CustomField>;

/** One value of one field on one record. Kept out of the records themselves so no other module's schema changes. */
export const CustomFieldValue = z.object({
  id: z.string(),
  fieldId: z.string(),
  recordType: z.enum(CUSTOM_FIELD_MODULES),
  recordId: z.string(),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  updatedAt: z.string(),
});
export type CustomFieldValue = z.infer<typeof CustomFieldValue>;
