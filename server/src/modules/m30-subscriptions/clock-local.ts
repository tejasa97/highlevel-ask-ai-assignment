// Period arithmetic for subscriptions. Kept out of index.ts so that file never constructs a Date.

export function addInterval(iso: string, interval: "day" | "week" | "month" | "year", count: number): string {
  const d = new Date(iso);
  if (interval === "day") d.setUTCDate(d.getUTCDate() + count);
  else if (interval === "week") d.setUTCDate(d.getUTCDate() + count * 7);
  else clampedMonths(d, interval === "month" ? count : count * 12);
  return d.toISOString();
}

/** Adds whole months, stopping at the target month's last day instead of spilling into the next month (31 Jan + 1 month is 28 Feb). */
function clampedMonths(d: Date, months: number): void {
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  d.setUTCDate(Math.min(day, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()));
}

/** Move an instant forward by how long the subscription was paused (now − pausedAt). */
export function shiftPaused(iso: string, pausedAt: string, now: string): string {
  return new Date(Date.parse(iso) + (Date.parse(now) - Date.parse(pausedAt))).toISOString();
}

/** True when `a` is strictly later than `b`. */
export function isAfter(a: string, b: string): boolean {
  return Date.parse(a) > Date.parse(b);
}
