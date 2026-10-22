import { z } from "zod";

export const BookingPage = z.object({
  id: z.string(),
  title: z.string(),
  /** URL path segment, unique across booking pages. */
  slug: z.string(),
  description: z.string().nullable(),
  /** The calendar (M20) it books on; a page can only be published with one linked, and the calendar must be public. */
  calendarId: z.string().nullable(),
  /** Questions asked before booking; name and email are always collected. */
  intakeFields: z.array(z.object({ label: z.string(), type: z.enum(["text", "textarea", "dropdown", "phone"]), required: z.boolean(), options: z.array(z.string()) })),
  confirmationMessage: z.string().nullable(),
  redirectUrl: z.string().nullable(),
  status: z.enum(["draft", "published"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  publishedAt: z.string().nullable(),
});
export type BookingPage = z.infer<typeof BookingPage>;
