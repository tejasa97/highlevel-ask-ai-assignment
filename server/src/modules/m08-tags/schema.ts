import { z } from "zod";

/** Record types that carry tags, and their tables. Records store tag names, so a rename updates them. */
export const TAGGED_TABLES = { contact: "contacts", lead: "leads" } as const;
export const TAGGED_TYPES = ["contact", "lead"] as const;
export const TAG_COLORS = ["gray", "red", "orange", "yellow", "green", "blue", "purple", "pink"] as const;

export const Tag = z.object({
  id: z.string(),
  name: z.string(),
  color: z.enum(TAG_COLORS),
  description: z.string().nullable(),
  createdAt: z.string(),
});
export type Tag = z.infer<typeof Tag>;
