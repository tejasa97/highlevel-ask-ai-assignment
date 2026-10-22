// Period arithmetic for subscriptions. Kept out of index.ts so that file never constructs a Date.

export function addInterval(iso: string, interval: "day" | "week" | "month" | "year", count: number): string {
  const d = new Date(iso);
  if (interval === "day") d.setUTCDate(d.getUTCDate() + count);
  else if (interval === "week") d.setUTCDate(d.getUTCDate() + count * 7);
  else if (interval === "month") d.setUTCMonth(d.getUTCMonth() + count);
  else d.setUTCFullYear(d.getUTCFullYear() + count);
  return d.toISOString();
}

/** Move an instant forward by how long the subscription was paused (now − pausedAt). */
export function shiftPaused(iso: string, pausedAt: string, now: string): string {
  return new Date(Date.parse(iso) + (Date.parse(now) - Date.parse(pausedAt))).toISOString();
}

/** True when `a` is strictly later than `b`. */
export function isAfter(a: string, b: string): boolean {
  return Date.parse(a) > Date.parse(b);
}
