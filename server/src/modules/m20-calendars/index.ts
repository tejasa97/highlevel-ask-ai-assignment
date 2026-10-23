import { z } from "zod";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import { activeUser, atLeastOne, contains, Limit, listOf, page, requireState } from "../../registry/helpers.js";
import type { ModuleExports } from "../../registry/registry.js";
import type { Store } from "../../store/db.js";
import type { Appointment } from "../m21-appointments/schema.js";
import type { BookingPage } from "../m23-booking-pages/schema.js";
import { Calendar } from "./schema.js";
import "./fixtures.js";

// Calendars appointments can be booked on. Archiving is refused while a booked appointment is still upcoming.

const CalendarId = z.string().describe("calendar id (cal_…)");

function requireZone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new ActionError("INVALID", `${timezone} isn't an IANA timezone`);
  }
}

function live(store: Store, id: string, doing: string): Calendar {
  const cal = mustGet<Calendar>(store, "calendars", id, "calendar");
  requireState(`Calendar "${cal.name}"`, cal.status, ["active"], doing);
  return cal;
}

// A published booking page is live to visitors, so its calendar must stay public and active.
function requireNoPublishedPage(store: Store, cal: Calendar, doing: string): void {
  const pages = store.find<BookingPage>("booking_pages", (p) => p.calendarId === cal.id && p.status === "published");
  if (pages.length) throw new ActionError("CONFLICT", `Calendar "${cal.name}" is on published booking page ${pages[0]!.id}; unpublish it (M23.A10) before ${doing}`);
}

function hosts(store: Store, ids: string[]): string[] {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new ActionError("INVALID", `hostIds lists ${id} twice`);
    seen.add(id);
    activeUser(store, id, "be a calendar host");
  }
  return ids;
}

const createCalendar = defineAction({
  id: "M20.A01",
  description:
    "Create a calendar: its timezone, hosts, appointment length, the gap kept free after each booking, and whether a booking page may use it. M21.A01 books one meeting; M22.A09 only lists open times on a calendar that already exists.",
  risk: "write",
  input: z.strictObject({
    name: z.string().min(1),
    description: z.string().nullable().optional(),
    timezone: z.string().min(1).optional().describe("IANA zone, default America/New_York"),
    hostIds: z.array(z.string()).optional().describe("user ids (us_…) who can be booked"),
    durationMinutes: z.number().int().min(5).optional(),
    bufferMinutes: z.number().int().min(0).optional(),
    visibility: z.enum(["public", "private"]).optional(),
  }),
  output: Calendar,
  siblings: ["M21.A01", "M22.A09"],
  entities: { produces: "calendar" },
  example: () => ({ name: "Intro calls", timezone: "America/Chicago", visibility: "public" }),
  handler: (a, { store, clock }) => {
    const timezone = a.timezone ?? "America/New_York";
    requireZone(timezone);
    const now = clock.now().toISOString();
    return store.insert("calendars", "cal", {
      name: a.name,
      description: a.description ?? null,
      timezone,
      hostIds: hosts(store, a.hostIds ?? []),
      durationMinutes: a.durationMinutes ?? 30,
      bufferMinutes: a.bufferMinutes ?? 0,
      visibility: a.visibility ?? "private",
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    });
  },
});

const getCalendar = defineAction({
  id: "M20.A02",
  description: "Get one calendar's timezone, hosts, appointment length, buffer, visibility and status. To browse several, use M20.A03 List calendars.",
  risk: "read",
  input: z.strictObject({ calendarId: CalendarId }),
  output: Calendar,
  entities: { consumes: ["calendar"] },
  example: (f) => ({ calendarId: f.calendar().id }),
  handler: ({ calendarId }, { store }) => mustGet<Calendar>(store, "calendars", calendarId, "calendar"),
});

const listCalendars = defineAction({
  id: "M20.A03",
  description:
    "List calendars, sorted by name then id. Filter by status, visibility, or a word in the name or description. Unlike M20.A02, this returns a page of matches rather than one calendar's settings.",
  risk: "read",
  input: z.strictObject({
    status: z.enum(["active", "archived"]).optional(),
    visibility: z.enum(["public", "private"]).optional(),
    query: z.string().optional(),
    limit: Limit,
  }),
  output: listOf(Calendar),
  entities: { produces: "calendar" },
  example: () => ({}),
  handler: (a, { store }) => {
    const items = store.find<Calendar>(
      "calendars",
      (c) =>
        (!a.status || c.status === a.status) &&
        (!a.visibility || c.visibility === a.visibility) &&
        (!a.query || contains(c.name, a.query) || contains(c.description, a.query)),
    );
    items.sort((x, y) => x.name.localeCompare(y.name, "en") || x.id.localeCompare(y.id, "en"));
    return page(items, a.limit);
  },
});

const updateCalendar = defineAction({
  id: "M20.A04",
  description:
    "Change a calendar's name or description. Timezone, hosts, duration, buffer and visibility each have their own action; archiving is M20.A10.",
  risk: "write",
  input: z.strictObject({
    calendarId: CalendarId,
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
  }),
  output: Calendar,
  entities: { consumes: ["calendar"] },
  example: (f) => ({ calendarId: f.calendar({ name: "Intro" }).id, name: "Intro calls" }),
  handler: (a, { store, clock }) => {
    const cal = live(store, a.calendarId, "be renamed");
    atLeastOne(a, ["name", "description"]);
    const patch: Partial<Calendar> = {};
    if (a.name !== undefined && a.name !== cal.name) patch.name = a.name;
    if (a.description !== undefined && a.description !== cal.description) patch.description = a.description;
    if (!Object.keys(patch).length) throw new ActionError("CONFLICT", "The calendar already has that value");
    return store.update<Calendar>("calendars", cal.id, { ...patch, updatedAt: clock.now().toISOString() });
  },
});

const setTimezone = defineAction({
  id: "M20.A05",
  description:
    "Set the IANA timezone working hours are read in. This does not rename the calendar (M20.A04) or change how long an appointment lasts (M20.A07).",
  risk: "write",
  input: z.strictObject({ calendarId: CalendarId, timezone: z.string().min(1) }),
  output: Calendar,
  entities: { consumes: ["calendar"] },
  example: (f) => ({ calendarId: f.calendar().id, timezone: "America/Chicago" }),
  handler: ({ calendarId, timezone }, { store, clock }) => {
    const cal = live(store, calendarId, "change timezone");
    requireZone(timezone);
    if (cal.timezone === timezone) throw new ActionError("CONFLICT", "The calendar already has that timezone");
    return store.update<Calendar>("calendars", cal.id, { timezone, updatedAt: clock.now().toISOString() });
  },
});

const assignHost = defineAction({
  id: "M20.A06",
  description:
    "Add an active user as a host who can be booked on this calendar. Create calendar can set the initial hosts; this adds one more. It does not remove anyone.",
  risk: "write",
  input: z.strictObject({ calendarId: CalendarId, userId: z.string().describe("user id (us_…)") }),
  output: Calendar,
  entities: { consumes: ["calendar"] },
  example: (f) => ({ calendarId: f.calendar().id, userId: "us_1" }),
  handler: ({ calendarId, userId }, { store, clock }) => {
    const cal = live(store, calendarId, "take another host");
    const user = activeUser(store, userId, "be a calendar host");
    if (cal.hostIds.includes(user.id)) throw new ActionError("CONFLICT", `The calendar already has ${user.name} as a host`);
    return store.update<Calendar>("calendars", cal.id, { hostIds: [...cal.hostIds, user.id], updatedAt: clock.now().toISOString() });
  },
});

const setDuration = defineAction({
  id: "M20.A07",
  description:
    "Set how many minutes each appointment on this calendar lasts (at least 5). The buffer after it is M20.A08; this does not change the calendar's name.",
  risk: "write",
  input: z.strictObject({ calendarId: CalendarId, durationMinutes: z.number().int().min(5) }),
  output: Calendar,
  entities: { consumes: ["calendar"] },
  example: (f) => ({ calendarId: f.calendar().id, durationMinutes: 45 }),
  handler: ({ calendarId, durationMinutes }, { store, clock }) => {
    const cal = live(store, calendarId, "change appointment length");
    if (cal.durationMinutes === durationMinutes) throw new ActionError("CONFLICT", "The calendar already has that duration");
    return store.update<Calendar>("calendars", cal.id, { durationMinutes, updatedAt: clock.now().toISOString() });
  },
});

const setBuffer = defineAction({
  id: "M20.A08",
  description:
    "Set the minutes kept free after each appointment on this calendar. Appointment length is M20.A07; a buffer of 0 means the next slot can start when the appointment ends.",
  risk: "write",
  input: z.strictObject({ calendarId: CalendarId, bufferMinutes: z.number().int().min(0) }),
  output: Calendar,
  entities: { consumes: ["calendar"] },
  example: (f) => ({ calendarId: f.calendar().id, bufferMinutes: 15 }),
  handler: ({ calendarId, bufferMinutes }, { store, clock }) => {
    const cal = live(store, calendarId, "change the booking buffer");
    if (cal.bufferMinutes === bufferMinutes) throw new ActionError("CONFLICT", "The calendar already has that buffer");
    return store.update<Calendar>("calendars", cal.id, { bufferMinutes, updatedAt: clock.now().toISOString() });
  },
});

const setVisibility = defineAction({
  id: "M20.A09",
  description:
    "Set a calendar to public or private. A public active calendar can be published on a booking page (M23.A09); a private one only takes internal bookings. This does not publish the page.",
  risk: "write",
  input: z.strictObject({ calendarId: CalendarId, visibility: z.enum(["public", "private"]) }),
  output: Calendar,
  siblings: ["M23.A09"],
  entities: { consumes: ["calendar"] },
  example: (f) => ({ calendarId: f.calendar().id, visibility: "public" }),
  handler: ({ calendarId, visibility }, { store, clock }) => {
    const cal = live(store, calendarId, "change visibility");
    if (cal.visibility === visibility) throw new ActionError("CONFLICT", "The calendar already has that visibility");
    if (visibility === "private") requireNoPublishedPage(store, cal, "making it private");
    return store.update<Calendar>("calendars", cal.id, { visibility, updatedAt: clock.now().toISOString() });
  },
});

const archiveCalendar = defineAction({
  id: "M20.A10",
  description:
    "Archive a calendar so it can no longer be edited or published on a booking page. Refused while booked appointments on it are still upcoming; cancel those or wait until they end. Get and list still return it.",
  risk: "destructive",
  input: z.strictObject({ calendarId: CalendarId }),
  output: Calendar,
  entities: { consumes: ["calendar"] },
  example: (f) => ({ calendarId: f.calendar().id }),
  handler: ({ calendarId }, { store, clock }) => {
    const cal = mustGet<Calendar>(store, "calendars", calendarId, "calendar");
    requireState(`Calendar "${cal.name}"`, cal.status, ["active"], "be archived");
    requireNoPublishedPage(store, cal, "archiving it");
    const now = clock.now().getTime();
    const upcoming = store.find<Appointment>(
      "appointments",
      (a) => a.calendarId === cal.id && a.status === "booked" && Date.parse(a.endAt) > now,
    );
    if (upcoming.length) throw new ActionError("CONFLICT", `Cancel or wait out ${upcoming.length} upcoming appointments first`);
    return store.update<Calendar>("calendars", cal.id, { status: "archived", updatedAt: clock.now().toISOString() });
  },
});

export default {
  actions: [createCalendar, getCalendar, listCalendars, updateCalendar, setTimezone, assignHost, setDuration, setBuffer, setVisibility, archiveCalendar],
} satisfies ModuleExports;
