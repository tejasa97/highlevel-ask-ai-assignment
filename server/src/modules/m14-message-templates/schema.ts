import { z } from "zod";

export const TEMPLATE_CHANNELS = ["email", "sms"] as const;

export const TemplateVariable = z.object({
  /** Used in the body as {{name}}. Dotted names reach into a record: contact.firstName. */
  name: z.string(),
  required: z.boolean(),
  sample: z.string().nullable(),
});
export type TemplateVariable = z.infer<typeof TemplateVariable>;

export const TemplateVersion = z.object({ version: z.number().int(), subject: z.string().nullable(), body: z.string(), at: z.string(), by: z.string() });

export const MessageTemplate = z.object({
  id: z.string(),
  name: z.string(),
  channel: z.enum(TEMPLATE_CHANNELS),
  /** Email only. */
  subject: z.string().nullable(),
  body: z.string(),
  variables: z.array(TemplateVariable),
  /** Current version number; `versions` holds the earlier ones, oldest first. */
  version: z.number().int(),
  versions: z.array(TemplateVersion),
  status: z.enum(["active", "archived"]),
  createdBy: z.string(),
  /** Who last changed the content, variables or status. */
  updatedBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MessageTemplate = z.infer<typeof MessageTemplate>;
