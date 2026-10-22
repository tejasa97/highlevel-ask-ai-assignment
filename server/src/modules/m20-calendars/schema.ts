import { z } from "zod";

export const Calendar = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  /** IANA zone, e.g. America/Chicago. Working hours (M22) are read in this zone. */
  timezone: z.string(),
  /** Users (M48) who can be booked on this calendar. */
  hostIds: z.array(z.string()),
  durationMinutes: z.number().int().min(5),
  /** Gap kept free after each appointment. */
  bufferMinutes: z.number().int().min(0),
  /** public calendars can be put on a booking page (M23); private ones only take internal bookings. */
  visibility: z.enum(["public", "private"]),
  status: z.enum(["active", "archived"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Calendar = z.infer<typeof Calendar>;

// Appointments booked on a calendar carry `calendarId` (M21). Archiving a calendar is refused while it has upcoming ones.
