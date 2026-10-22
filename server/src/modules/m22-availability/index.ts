import { z } from "zod";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import { Limit, listOf, page, requireState } from "../../registry/helpers.js";
import type { ModuleExports } from "../../registry/registry.js";
import { addDays } from "../../store/clock.js";
import type { Store } from "../../store/db.js";
import type { Appointment } from "../m21-appointments/schema.js";
import type { Calendar } from "../m20-calendars/schema.js";
import { addMinutes, fromMinutes, minutes, weekday, zonedDate, zonedInstant, zonedTime } from "./clock-local.js";
import { Availability, WEEKDAYS, type TimeRange } from "./schema.js";
import "./fixtures.js";

// One availability row per calendar, created by the first hours, block, notice or horizon write.
// Slots are working hours minus date blocks minus booked time, in the calendar's timezone.

const CalendarId = z.string().describe("calendar id (cal_…)");
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM");
const Range = z.strictObject({ start: HHMM, end: HHMM });
const DEFAULT_NOTICE = 0;
const DEFAULT_HORIZON = 60;

const Slot = z.object({
  start: z.string(),
  end: z.string(),
  hostId: z.string().nullable(),
});

const HORIZON = "past the booking horizon";
const NOTICE = "before the minimum booking notice";
const OUTSIDE = "outside working hours";
const BLOCKED = "overlaps a blocked time";
const HOST_BOOKED = "the host is booked";
const ALL_BOOKED = "every host is booked";
const CALENDAR_BOOKED = "the calendar is booked";
const NOT_A_HOST = "that user is not a host on this calendar";

type Weekday = (typeof WEEKDAYS)[number];

function liveCalendar(store: Store, id: string, doing: string): Calendar {
  const cal = mustGet<Calendar>(store, "calendars", id, "calendar");
  requireState(`Calendar "${cal.name}"`, cal.status, ["active"], doing);
  return cal;
}

function findAvailability(store: Store, calendarId: string): Availability | undefined {
  return store.find<Availability>("availability", (a) => a.calendarId === calendarId)[0];
}

function requireAvailability(store: Store, calendarId: string): Availability {
  const row = findAvailability(store, calendarId);
  if (!row) throw new ActionError("NOT_FOUND", `No availability for calendar ${calendarId}; set hours, notice, or a block first`);
  return row;
}

function blankWeek(): Availability["weekly"] {
  const weekly = {} as Availability["weekly"];
  for (const day of WEEKDAYS) weekly[day] = [];
  return weekly;
}

function checkRanges(ranges: TimeRange[]): void {
  const sorted = [...ranges].sort((a, b) => a.start.localeCompare(b.start));
  let prevEnd = "";
  for (const r of sorted) {
    if (r.end <= r.start) throw new ActionError("INVALID", `${r.start}–${r.end} ends before it starts`);
    if (prevEnd && r.start < prevEnd) throw new ActionError("INVALID", `${r.start} starts before the previous range ends at ${prevEnd}`);
    prevEnd = r.end;
  }
}

function normalizeWeek(weekly: Partial<Record<Weekday, TimeRange[]>>): Availability["weekly"] {
  const out = blankWeek();
  for (const day of WEEKDAYS) {
    const ranges = weekly[day];
    if (!ranges?.length) continue;
    out[day] = [...ranges]
      .map((r) => ({ start: r.start, end: r.end }))
      .sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  }
  return out;
}

function weeklyFromHours(hours: { weekday: Weekday; ranges: TimeRange[] }[]): Availability["weekly"] {
  const weekly = blankWeek();
  const seen = new Set<string>();
  for (const row of hours) {
    if (seen.has(row.weekday)) throw new ActionError("INVALID", `${row.weekday} is listed twice`);
    seen.add(row.weekday);
    checkRanges(row.ranges);
    if (row.ranges.length) weekly[row.weekday] = row.ranges.map((r) => ({ start: r.start, end: r.end }));
  }
  return normalizeWeek(weekly);
}

function sameWeek(a: Availability["weekly"], b: Availability["weekly"]): boolean {
  return JSON.stringify(normalizeWeek(a)) === JSON.stringify(normalizeWeek(b));
}

function emptyRow(calendarId: string, now: string, patch: Partial<Omit<Availability, "id" | "calendarId">>): Omit<Availability, "id"> {
  return {
    calendarId,
    weekly: blankWeek(),
    dateOverrides: [],
    blocks: [],
    minNoticeMinutes: DEFAULT_NOTICE,
    maxHorizonDays: DEFAULT_HORIZON,
    updatedAt: now,
    ...patch,
  };
}

function rangesFor(av: Availability, date: string): TimeRange[] {
  const override = av.dateOverrides.find((o) => o.date === date);
  if (override) return override.ranges;
  return av.weekly[weekday(date)] ?? [];
}

interface Span {
  start: number;
  end: number;
  hostId: string;
  calendarId: string | null;
}

function spans(store: Store, calendar: Calendar): Span[] {
  const buffer = calendar.bufferMinutes * 60_000;
  return store
    .find<Appointment>(
      "appointments",
      (a) => a.status === "booked" && (calendar.hostIds.includes(a.hostId) || a.calendarId === calendar.id),
    )
    .map((a) => ({ start: Date.parse(a.startAt), end: Date.parse(a.endAt) + buffer, hostId: a.hostId, calendarId: a.calendarId }));
}

function overlaps(a0: number, a1: number, b0: number, b1: number): boolean {
  return a0 < b1 && a1 > b0;
}

function hostFree(rows: Span[], calendar: Calendar, hostId: string, start: number, end: number): boolean {
  return !rows.some(
    (s) => overlaps(start, end, s.start, s.end) && (s.hostId === hostId || (s.calendarId === calendar.id && !calendar.hostIds.includes(s.hostId))),
  );
}

function calendarFree(rows: Span[], start: number, end: number): boolean {
  return !rows.some((s) => overlaps(start, end, s.start, s.end));
}

function blockHit(av: Availability, date: string, startMin: number, endMin: number): boolean {
  return av.blocks.some((b) => b.date === date && startMin < minutes(b.end) && endMin > minutes(b.start));
}

function datesThrough(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

interface Opening {
  start: string;
  end: string;
  hostId: string | null;
}

function openings(store: Store, calendar: Calendar, av: Availability, from: string | undefined, to: string | undefined, now: Date): Opening[] {
  if (calendar.durationMinutes < 1) return [];
  const today = zonedDate(now, calendar.timezone);
  const horizon = addDays(today, av.maxHorizonDays);
  const startDate = from ?? today;
  const endDate = to === undefined || to > horizon ? horizon : to;
  if (startDate > endDate) return [];
  const booked = spans(store, calendar);
  const earliest = now.getTime() + av.minNoticeMinutes * 60_000;
  const hosts = [...new Set(calendar.hostIds)].sort((a, b) => a.localeCompare(b, "en"));
  const seen = new Set<string>();
  const items: Opening[] = [];
  for (const date of datesThrough(startDate, endDate)) {
    for (const range of rangesFor(av, date)) {
      const open = minutes(range.start);
      const close = minutes(range.end);
      if (!(close > open)) continue;
      for (let t = open; t + calendar.durationMinutes <= close; t += calendar.durationMinutes) {
        const startHH = fromMinutes(t);
        const endHH = fromMinutes(t + calendar.durationMinutes);
        const start = zonedInstant(date, startHH, calendar.timezone);
        const end = zonedInstant(date, endHH, calendar.timezone);
        if (!(Date.parse(end) > Date.parse(start))) continue;
        if (Date.parse(start) < earliest) continue;
        if (blockHit(av, date, t, t + calendar.durationMinutes)) continue;
        const startMs = Date.parse(start);
        const endMs = Date.parse(end);
        if (hosts.length === 0) {
          if (!calendarFree(booked, startMs, endMs)) continue;
          const key = `${start}|`;
          if (seen.has(key)) continue;
          seen.add(key);
          items.push({ start, end, hostId: null });
          continue;
        }
        for (const hostId of hosts) {
          if (!hostFree(booked, calendar, hostId, startMs, endMs)) continue;
          const key = `${start}|${hostId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          items.push({ start, end, hostId });
        }
      }
    }
  }
  items.sort((a, b) => a.start.localeCompare(b.start) || (a.hostId ?? "\uffff").localeCompare(b.hostId ?? "\uffff", "en"));
  return items;
}

function insideHours(av: Availability, day: string, startMin: number, endMin: number, sameDay: boolean): boolean {
  if (!sameDay || !(endMin > startMin)) return false;
  return rangesFor(av, day).some((r) => startMin >= minutes(r.start) && endMin <= minutes(r.end));
}

const setWeekly = defineAction({
  id: "M22.A01",
  description:
    "Replace a calendar's weekly working hours. A weekday you leave out is off. Date-specific hours (M22.A03) and time blocks (M22.A05) are kept. The first call creates the calendar's availability.",
  risk: "write",
  input: z.strictObject({
    calendarId: CalendarId,
    hours: z.array(z.strictObject({ weekday: z.enum(WEEKDAYS), ranges: z.array(Range) })),
  }),
  output: Availability,
  entities: { produces: "calendar" },
  example: (f) => ({ calendarId: f.calendar().id, hours: [{ weekday: "wed", ranges: [{ start: "09:00", end: "12:00" }] }] }),
  handler: ({ calendarId, hours }, { store, clock }) => {
    liveCalendar(store, calendarId, "change working hours");
    const weekly = weeklyFromHours(hours);
    const now = clock.now().toISOString();
    const existing = findAvailability(store, calendarId);
    if (existing && sameWeek(existing.weekly, weekly)) throw new ActionError("CONFLICT", "The calendar already has those working hours");
    if (!existing) return store.insert("availability", "avl", emptyRow(calendarId, now, { weekly }));
    return store.update<Availability>("availability", existing.id, { weekly, updatedAt: now });
  },
});

const getWeekly = defineAction({
  id: "M22.A02",
  description:
    "Get the weekly hours, date overrides, blocks, notice and horizon for a calendar. Refused with not found until the first availability write. Open times are M22.A09, not this.",
  risk: "read",
  input: z.strictObject({ calendarId: CalendarId }),
  output: Availability,
  entities: { consumes: ["calendar"] },
  example: (f) => ({ calendarId: f.availability().calendarId }),
  handler: ({ calendarId }, { store }) => {
    mustGet<Calendar>(store, "calendars", calendarId, "calendar");
    return requireAvailability(store, calendarId);
  },
});

const addDate = defineAction({
  id: "M22.A03",
  description:
    "Set hours for one date, replacing that weekday's usual hours. An empty range list makes the date a day off. A date that already has specific hours is a duplicate; remove them with M22.A04 first.",
  risk: "write",
  input: z.strictObject({
    calendarId: CalendarId,
    date: z.iso.date(),
    ranges: z.array(Range),
  }),
  output: Availability,
  entities: { produces: "calendar" },
  example: (f) => ({ calendarId: f.calendar().id, date: "2026-10-24", ranges: [{ start: "10:00", end: "14:00" }] }),
  handler: ({ calendarId, date, ranges }, { store, clock }) => {
    liveCalendar(store, calendarId, "add date-specific hours");
    checkRanges(ranges);
    const now = clock.now().toISOString();
    const existing = findAvailability(store, calendarId);
    const next = ranges.map((r) => ({ start: r.start, end: r.end }));
    if (!existing) {
      return store.insert("availability", "avl", emptyRow(calendarId, now, { dateOverrides: [{ date, ranges: next }] }));
    }
    if (existing.dateOverrides.some((o) => o.date === date)) throw new ActionError("DUPLICATE", `Specific hours for ${date} already exist; remove them first`);
    const dateOverrides = [...existing.dateOverrides, { date, ranges: next }].sort((a, b) => a.date.localeCompare(b.date));
    return store.update<Availability>("availability", existing.id, { dateOverrides, updatedAt: now });
  },
});

const removeDate = defineAction({
  id: "M22.A04",
  description:
    "Remove one date's specific hours so that weekday's weekly hours apply again. This does not delete a time block (M22.A06) or change the weekly schedule (M22.A01).",
  risk: "destructive",
  input: z.strictObject({ calendarId: CalendarId, date: z.iso.date() }),
  output: Availability,
  entities: { consumes: ["calendar"] },
  example: (f) => {
    const row = f.availability({ dateOverrides: [{ date: "2026-10-24", ranges: [{ start: "10:00", end: "12:00" }] }] });
    return { calendarId: row.calendarId, date: "2026-10-24" };
  },
  handler: ({ calendarId, date }, { store, clock }) => {
    liveCalendar(store, calendarId, "remove date-specific hours");
    const row = requireAvailability(store, calendarId);
    if (!row.dateOverrides.some((o) => o.date === date)) throw new ActionError("CONFLICT", `No specific hours on ${date}; the weekly hours apply`);
    return store.update<Availability>("availability", row.id, {
      dateOverrides: row.dateOverrides.filter((o) => o.date !== date),
      updatedAt: clock.now().toISOString(),
    });
  },
});

const blockTime = defineAction({
  id: "M22.A05",
  description:
    "Mark a same-day HH:MM range unavailable on one date, on top of the working hours. Weekly hours and date overrides stay as they are. Remove it later with M22.A06.",
  risk: "write",
  input: z.strictObject({
    calendarId: CalendarId,
    date: z.iso.date(),
    start: HHMM,
    end: HHMM,
    reason: z.string().nullable().optional(),
  }),
  output: Availability,
  entities: { produces: "calendar" },
  example: (f) => ({ calendarId: f.calendar().id, date: "2026-10-21", start: "12:00", end: "13:00", reason: "Lunch" }),
  handler: (a, { store, clock }) => {
    liveCalendar(store, a.calendarId, "block time");
    if (a.end <= a.start) throw new ActionError("INVALID", `${a.start}–${a.end} ends before it starts`);
    const now = clock.now().toISOString();
    const block = { id: store.nextId("_nested", "tb"), date: a.date, start: a.start, end: a.end, reason: a.reason ?? null };
    const existing = findAvailability(store, a.calendarId);
    if (!existing) return store.insert("availability", "avl", emptyRow(a.calendarId, now, { blocks: [block] }));
    return store.update<Availability>("availability", existing.id, { blocks: [...existing.blocks, block], updatedAt: now });
  },
});

const removeBlock = defineAction({
  id: "M22.A06",
  description:
    "Remove one blocked range by its id. The weekly hours and any date-specific hours stay. To drop a date override instead, use M22.A04.",
  risk: "destructive",
  input: z.strictObject({
    calendarId: CalendarId,
    blockId: z.string().describe("time block id (tb_…)"),
  }),
  output: Availability,
  entities: { consumes: ["calendar"] },
  example: (f) => {
    const row = f.availability({ blocks: [{ id: "tb_9001", date: "2026-10-21", start: "12:00", end: "13:00", reason: null }] });
    return { calendarId: row.calendarId, blockId: "tb_9001" };
  },
  handler: ({ calendarId, blockId }, { store, clock }) => {
    liveCalendar(store, calendarId, "remove a time block");
    const row = requireAvailability(store, calendarId);
    if (!row.blocks.some((b) => b.id === blockId)) throw new ActionError("NOT_FOUND", `No time block with id ${blockId}`);
    return store.update<Availability>("availability", row.id, {
      blocks: row.blocks.filter((b) => b.id !== blockId),
      updatedAt: clock.now().toISOString(),
    });
  },
});

const setNotice = defineAction({
  id: "M22.A07",
  description:
    "Set how many minutes ahead of now a slot must start. The furthest day someone can book is M22.A08. The first call creates the calendar's availability, with empty hours until you set them.",
  risk: "write",
  input: z.strictObject({ calendarId: CalendarId, minNoticeMinutes: z.number().int().min(0) }),
  output: Availability,
  entities: { produces: "calendar" },
  example: (f) => ({ calendarId: f.calendar().id, minNoticeMinutes: 60 }),
  handler: ({ calendarId, minNoticeMinutes }, { store, clock }) => {
    liveCalendar(store, calendarId, "change the booking notice");
    const now = clock.now().toISOString();
    const existing = findAvailability(store, calendarId);
    if (existing && existing.minNoticeMinutes === minNoticeMinutes) throw new ActionError("CONFLICT", "The calendar already has that minimum notice");
    if (!existing) return store.insert("availability", "avl", emptyRow(calendarId, now, { minNoticeMinutes }));
    return store.update<Availability>("availability", existing.id, { minNoticeMinutes, updatedAt: now });
  },
});

const setHorizon = defineAction({
  id: "M22.A08",
  description:
    "Set how many days past today slots are offered, in the calendar's timezone. The minimum notice is M22.A07. The first call creates the calendar's availability.",
  risk: "write",
  input: z.strictObject({ calendarId: CalendarId, maxHorizonDays: z.number().int().min(1) }),
  output: Availability,
  entities: { produces: "calendar" },
  example: (f) => ({ calendarId: f.calendar().id, maxHorizonDays: 14 }),
  handler: ({ calendarId, maxHorizonDays }, { store, clock }) => {
    liveCalendar(store, calendarId, "change the booking horizon");
    const now = clock.now().toISOString();
    const existing = findAvailability(store, calendarId);
    if (existing && existing.maxHorizonDays === maxHorizonDays) throw new ActionError("CONFLICT", "The calendar already has that booking horizon");
    if (!existing) return store.insert("availability", "avl", emptyRow(calendarId, now, { maxHorizonDays }));
    return store.update<Availability>("availability", existing.id, { maxHorizonDays, updatedAt: now });
  },
});

const findSlots = defineAction({
  id: "M22.A09",
  description:
    "List open slots from weekly hours or that date's override, stepping by the appointment length, through the sooner of `to` and today plus the horizon. Drops slots inside the notice window, blocked ranges, and booked time expanded by the buffer. A time is returned when at least one host is free (one row per free host); with no hosts, the calendar itself must be free. Sorted by start, then host id. M21.A01 books a meeting and M20.A01 creates the calendar; this only reads. M22.A10 checks one proposed start instead of listing the grid.",
  risk: "read",
  input: z.strictObject({
    calendarId: CalendarId,
    from: z.iso.date().optional().describe("YYYY-MM-DD in the calendar timezone; default today"),
    to: z.iso.date().optional().describe("YYYY-MM-DD inclusive, capped at today plus the horizon"),
    limit: Limit,
  }),
  output: listOf(Slot),
  siblings: ["M21.A01", "M20.A01"],
  entities: { produces: "slot", consumes: ["calendar", "appointment"] },
  example: (f) => ({ calendarId: f.availability().calendarId, from: "2026-10-21", to: "2026-10-21" }),
  handler: (a, { store, clock }) => {
    const cal = mustGet<Calendar>(store, "calendars", a.calendarId, "calendar");
    const av = requireAvailability(store, cal.id);
    return page(openings(store, cal, av, a.from, a.to, clock.now()), a.limit);
  },
});

const checkConflicts = defineAction({
  id: "M22.A10",
  description:
    "Check one proposed start, lasting the calendar's appointment length, against the same rules as finding slots: horizon, notice, working hours, blocks and booked hosts. The start does not have to sit on the slot grid. Returns whether it is free and why. Unlike M22.A09, this does not list the day's openings.",
  risk: "read",
  input: z.strictObject({
    calendarId: CalendarId,
    startAt: z.iso.datetime({ offset: true }).describe("ISO start; the end is one appointment duration later"),
    hostId: z.string().optional().describe("user id (us_…); omit to accept any free host"),
  }),
  output: z.object({
    free: z.boolean(),
    hostId: z.string().nullable(),
    start: z.string(),
    end: z.string(),
    reasons: z.array(z.string()),
  }),
  entities: { consumes: ["calendar", "appointment"] },
  example: (f) => ({ calendarId: f.availability().calendarId, startAt: "2026-10-21T15:00:00.000Z" }),
  handler: (a, { store, clock }) => {
    const cal = mustGet<Calendar>(store, "calendars", a.calendarId, "calendar");
    const av = requireAvailability(store, cal.id);
    if (a.hostId) mustGet(store, "users", a.hostId, "user");
    const start = a.startAt;
    const end = addMinutes(start, cal.durationMinutes);
    const day = zonedDate(start, cal.timezone);
    const endDay = zonedDate(end, cal.timezone);
    const startMin = minutes(zonedTime(start, cal.timezone));
    const endMin = minutes(zonedTime(end, cal.timezone));
    const today = zonedDate(clock.now(), cal.timezone);
    const horizon = addDays(today, av.maxHorizonDays);
    const reasons: string[] = [];
    if (day < today || day > horizon) reasons.push(HORIZON);
    if (Date.parse(start) < clock.now().getTime() + av.minNoticeMinutes * 60_000) reasons.push(NOTICE);
    const fits = insideHours(av, day, startMin, endMin, endDay === day);
    if (!fits) reasons.push(OUTSIDE);
    else if (blockHit(av, day, startMin, endMin)) reasons.push(BLOCKED);
    let hostId: string | null = null;
    if (!reasons.length) {
      const booked = spans(store, cal);
      const startMs = Date.parse(start);
      const endMs = Date.parse(end);
      if (a.hostId && !cal.hostIds.includes(a.hostId)) reasons.push(NOT_A_HOST);
      else if (cal.hostIds.length === 0) {
        if (!calendarFree(booked, startMs, endMs)) reasons.push(CALENDAR_BOOKED);
      } else {
        const candidates = a.hostId ? [a.hostId] : [...new Set(cal.hostIds)].sort((x, y) => x.localeCompare(y, "en"));
        const free = candidates.filter((id) => hostFree(booked, cal, id, startMs, endMs));
        const picked = free[0];
        if (picked) hostId = picked;
        else reasons.push(a.hostId ? HOST_BOOKED : ALL_BOOKED);
      }
    }
    return { free: reasons.length === 0, hostId: reasons.length === 0 ? hostId : null, start, end, reasons };
  },
});

export default {
  actions: [setWeekly, getWeekly, addDate, removeDate, blockTime, removeBlock, setNotice, setHorizon, findSlots, checkConflicts],
} satisfies ModuleExports;
