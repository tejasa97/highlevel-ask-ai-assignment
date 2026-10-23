// A clock the handlers and the planner prompt share. Evals pin it, so "last week" means the same days every run.

export interface Clock {
  now(): Date;
}

export const DEFAULT_NOW = "2026-10-21T14:00:00.000Z"; // Wed 10:00 in America/New_York
export const TIMEZONE = "America/New_York";

export function frozenClock(iso = DEFAULT_NOW): Clock {
  const t = new Date(iso);
  return { now: () => new Date(t) };
}

export const systemClock: Clock = { now: () => new Date() };

/** YYYY-MM-DD of a date in the app's timezone. */
export function localDate(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: TIMEZONE });
}

/** HH:MM:SS of a date's wall-clock time in the app's timezone. */
export function localTime(d: Date): string {
  return d.toLocaleTimeString("en-GB", { timeZone: TIMEZONE, hour12: false });
}

/** The wall-clock date (YYYY-MM-DD) and time (HH:MM:SS) an instant has in `timeZone`. */
export function wallParts(ms: number, timeZone: string): { date: string; time: string } {
  const d = new Date(ms);
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
  const bits = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  let hour = bits.hour ?? "00";
  if (hour === "24") hour = "00";
  return { date: date.replaceAll("/", "-"), time: `${hour}:${bits.minute ?? "00"}:${bits.second ?? "00"}` };
}

const DAY_MS = 86_400_000;

/**
 * ISO instant for a wall-clock time (HH:MM or HH:MM:SS) on a calendar date in `timeZone`.
 * A wall time that happens twice (clocks going back) is its first occurrence; one that never happens
 * (clocks going forward) lands the same distance after the gap, as if the old offset still applied.
 */
export function zonedInstant(date: string, time: string, timeZone: string): string {
  const hms = time.length === 5 ? `${time}:00` : time;
  const wall = Date.parse(`${date}T${hms}Z`);
  const offset = (ms: number) => {
    const p = wallParts(ms, timeZone);
    return Date.parse(`${p.date}T${p.time}Z`) - ms;
  };
  // The offsets in force a day before and a day after bracket any single transition.
  const before = offset(wall - DAY_MS);
  const after = offset(wall + DAY_MS);
  const candidates = [wall - before, wall - after].filter((ms) => offset(ms) === wall - ms);
  return new Date(candidates.length ? Math.min(...candidates) : wall - before).toISOString();
}

/** The instant a wall-clock time on a date has in the app's timezone, across daylight-saving changes. */
export function atLocal(date: string, time: string): Date {
  return new Date(zonedInstant(date, time, TIMEZONE));
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Bare weekdays mean the next occurrence including today; "next Friday" is strictly future. */
export function weekdayDates(clock: Clock): Record<string, { upcoming: string; next: string }> {
  const today = localDate(clock.now());
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
  return Object.fromEntries(["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((day, n) => {
    const delta = (n - dow + 7) % 7;
    return [day, { upcoming: addDays(today, delta), next: addDays(today, delta || 7) }];
  }));
}

/** The <now> block: precomputed ranges so the model never does calendar math. */
export function nowBlock(clock: Clock): string {
  const today = localDate(clock.now());
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  const monday = addDays(today, -((dow + 6) % 7));
  const weekday = new Date(`${today}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  return [
    `<now>${today} (${weekday}), ${TIMEZONE}.`,
    `today = ${today}. tomorrow = ${addDays(today, 1)}. yesterday = ${addDays(today, -1)}.`,
    `this_week = ${monday}..${addDays(monday, 6)}. last_week = ${addDays(monday, -7)}..${addDays(monday, -1)}.`,
    `last_7_days = ${addDays(today, -6)}..${today}. last_30_days = ${addDays(today, -29)}..${today}.`,
    `weekdays = ${JSON.stringify(weekdayDates(clock))}. Bare weekday uses upcoming (including today); "next weekday" uses next (strictly future).`,
    `Date ranges are inclusive.</now>`,
  ].join(" ");
}
