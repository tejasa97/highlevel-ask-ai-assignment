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

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
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
    `Date ranges are inclusive.</now>`,
  ].join(" ");
}
