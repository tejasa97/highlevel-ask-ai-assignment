import { z } from "zod";

export const APPOINTMENT_STATUSES = ["booked", "completed", "cancelled", "no_show"] as const;

export const Attendee = z.object({
  kind: z.enum(["contact", "lead", "user"]),
  id: z.string(),
  name: z.string(),
  noShow: z.boolean(),
});
export type Attendee = z.infer<typeof Attendee>;

/** A meeting with a contact or lead, hosted by one of our users. */
export const Appointment = z.object({
  id: z.string(),
  title: z.string(),
  contactId: z.string().nullable(),
  leadId: z.string().nullable(),
  hostId: z.string(),
  /** The calendar (M20) it was booked on, if any. Slot finding (M22) checks a calendar's hosts against these. */
  calendarId: z.string().nullable(),
  /** Everyone invited, the primary contact or lead first. */
  attendees: z.array(Attendee),
  startAt: z.string(),
  endAt: z.string(),
  location: z.string().nullable(),
  status: z.enum(APPOINTMENT_STATUSES),
  cancelReason: z.string().nullable(),
  outcome: z.string().nullable(),
  createdAt: z.string(),
});
export type Appointment = z.infer<typeof Appointment>;
