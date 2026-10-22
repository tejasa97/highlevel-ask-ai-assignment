import { z } from "zod";

export const DAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;
const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const Interval = z
  .strictObject({ open: Time, close: Time })
  .refine(
    (x) => x.open < x.close,
    "opening must precede closing; overnight hours are not supported",
  );
export const Hours = z.strictObject({
  monday: Interval.nullable(),
  tuesday: Interval.nullable(),
  wednesday: Interval.nullable(),
  thursday: Interval.nullable(),
  friday: Interval.nullable(),
  saturday: Interval.nullable(),
  sunday: Interval.nullable(),
});
export const Listing = z.object({
  id: z.string(),
  name: z.string(),
  directory: z.string(),
  address: z.string(),
  phone: z.string(),
  categories: z.array(z.string()),
  hours: Hours,
  timezone: z.literal("America/New_York"),
  version: z.number().int(),
  publishedVersion: z.number().int().nullable(),
  publishedAt: z.string().nullable(),
  lastSyncAt: z.string().nullable(),
  failureReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Listing = z.infer<typeof Listing>;
export const defaultHours = () => ({
  monday: null,
  tuesday: null,
  wednesday: null,
  thursday: null,
  friday: null,
  saturday: null,
  sunday: null,
});
