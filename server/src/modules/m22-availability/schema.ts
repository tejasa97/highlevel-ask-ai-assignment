import { z } from "zod";

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

/** Times are "HH:MM" in the calendar's timezone; dates are "YYYY-MM-DD". */
export const TimeRange = z.object({ start: z.string(), end: z.string() });
export type TimeRange = z.infer<typeof TimeRange>;

/** One document per calendar: when its hosts can be booked. Created with the calendar's first availability write. */
export const Availability = z.object({
  id: z.string(),
  calendarId: z.string(),
  /** Regular weekly hours; a weekday with no ranges is a day off. */
  weekly: z.record(z.enum(WEEKDAYS), z.array(TimeRange)),
  /** Replaces the weekly hours for one date (an extra Saturday, a half day). An empty `ranges` makes it a day off. */
  dateOverrides: z.array(z.object({ date: z.string(), ranges: z.array(TimeRange) })),
  /** Time that is unavailable regardless of the hours above. */
  blocks: z.array(z.object({ id: z.string(), date: z.string(), start: z.string(), end: z.string(), reason: z.string().nullable() })),
  minNoticeMinutes: z.number().int().min(0),
  maxHorizonDays: z.number().int().min(1),
  updatedAt: z.string(),
});
export type Availability = z.infer<typeof Availability>;

// Finding slots (A09) and checking conflicts (A10) read `appointments` for the calendar's hosts (`calendarId`, `hostId`, `status`).
