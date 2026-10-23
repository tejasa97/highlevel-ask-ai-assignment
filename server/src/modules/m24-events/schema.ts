import { z } from "zod";

export const Event = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  startsAt: z.string(),
  endsAt: z.string(),
  location: z.string().nullable(),
  /** Seats; registered (not waitlisted or cancelled) attendees count against it. */
  capacity: z.number().int().min(1),
  status: z.enum(["scheduled", "cancelled", "completed"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Event = z.infer<typeof Event>;

export const REGISTRATION_STATUSES = ["registered", "waitlisted", "cancelled", "checked_in"] as const;

export const EventRegistration = z.object({
  id: z.string(),
  eventId: z.string(),
  contactId: z.string(),
  status: z.enum(REGISTRATION_STATUSES),
  /** Order on the waitlist (1 = next), set while waitlisted. A cancelled registration frees its seat; promotion is explicit (A09). */
  waitlistPosition: z.number().int().nullable(),
  registeredAt: z.string(),
  checkedInAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
});
export type EventRegistration = z.infer<typeof EventRegistration>;
