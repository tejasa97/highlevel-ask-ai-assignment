import { Fixtures, type Input } from "../../store/fixtures.js";
import { Calendar } from "../m20-calendars/schema.js";
import { Availability, WEEKDAYS, type TimeRange } from "./schema.js";

type AvailabilityInput = Omit<Input<Availability>, "weekly"> & { weekly?: Partial<Availability["weekly"]> };

declare module "../../store/fixtures.js" {
  interface Fixtures {
    availability(o?: AvailabilityInput): Availability;
  }
}

type Week = Availability["weekly"];

const BUSINESS: Week = {
  mon: [{ start: "09:00", end: "17:00" }],
  tue: [{ start: "09:00", end: "17:00" }],
  wed: [{ start: "09:00", end: "17:00" }],
  thu: [{ start: "09:00", end: "17:00" }],
  fri: [{ start: "09:00", end: "17:00" }],
  sat: [],
  sun: [],
};

/** Zod's weekday record requires every day. A missing day is off. */
function fillWeek(partial?: Partial<Record<(typeof WEEKDAYS)[number], TimeRange[]>>): Week {
  const out = {} as Week;
  for (const day of WEEKDAYS) out[day] = partial?.[day] ?? [];
  return out;
}

Fixtures.prototype.availability = function (this: Fixtures, o: AvailabilityInput = {}): Availability {
  const calendarId =
    o.calendarId ??
    this.make("calendars", "cal", Calendar, {
      name: `Calendar ${this.seq()}`,
      description: null,
      timezone: "America/New_York",
      hostIds: [],
      durationMinutes: 30,
      bufferMinutes: 0,
      visibility: "private",
      status: "active",
      createdAt: this.now(),
      updatedAt: this.now(),
    }).id;
  return this.make("availability", "avl", Availability, {
    calendarId,
    weekly: o.weekly ? fillWeek(o.weekly) : BUSINESS,
    dateOverrides: o.dateOverrides ?? [],
    blocks: o.blocks ?? [],
    minNoticeMinutes: o.minNoticeMinutes ?? 0,
    maxHorizonDays: o.maxHorizonDays ?? 60,
    updatedAt: o.updatedAt ?? this.now(),
  });
};
