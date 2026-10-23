import { z } from "zod";

export const FORM_FIELD_TYPES = ["text", "email", "phone", "number", "textarea", "dropdown", "checkbox"] as const;

export const FormField = z.object({
  id: z.string(),
  label: z.string(),
  type: z.enum(FORM_FIELD_TYPES),
  required: z.boolean(),
  options: z.array(z.string()),
  validation: z.object({ minLength: z.number().int().nullable(), maxLength: z.number().int().nullable(), pattern: z.string().nullable() }),
  /** Contact field a submission fills when it creates or updates a contact (email, phone, firstName, ...). */
  mapsTo: z.string().nullable(),
});
export type FormField = z.infer<typeof FormField>;

export const Form = z.object({
  id: z.string(),
  name: z.string(),
  fields: z.array(FormField),
  status: z.enum(["draft", "published", "archived"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  publishedAt: z.string().nullable(),
});
export type Form = z.infer<typeof Form>;

export const FormSubmission = z.object({
  id: z.string(),
  formId: z.string(),
  /** field id → answer */
  values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  /** The contact the submission created or matched (by email), if any. */
  contactId: z.string().nullable(),
  submittedAt: z.string(),
});
export type FormSubmission = z.infer<typeof FormSubmission>;
