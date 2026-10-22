import { wallParts } from "../../store/clock.js";
import { WEEKDAYS } from "./schema.js";

// Wall-clock helpers for an arbitrary IANA zone. The instant conversion itself (`zonedInstant`) lives in
// the store, next to `atLocal`, so both settle daylight-saving changes the same way.
export { zonedInstant } from "../../store/clock.js";

const SUN_FIRST = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

function instantMs(instant: Date | string | number): number {
  if (typeof instant === "number") return instant;
  if (typeof instant === "string") return Date.parse(instant);
  return instant.getTime();
}

/** YYYY-MM-DD of an instant in `timeZone`. */
export function zonedDate(instant: Date | string | number, timeZone: string): string {
  return wallParts(instantMs(instant), timeZone).date;
}

/** HH:MM of an instant in `timeZone`. */
export function zonedTime(instant: Date | string | number, timeZone: string): string {
  return wallParts(instantMs(instant), timeZone).time.slice(0, 5);
}

/** Weekday of a YYYY-MM-DD civil date. The date itself has no zone. */
export function weekday(date: string): (typeof WEEKDAYS)[number] {
  const name = SUN_FIRST[new Date(Date.parse(`${date}T12:00:00Z`)).getUTCDay()];
  if (!name) throw new Error(`bad weekday for ${date}`);
  return name;
}

/** Move an ISO instant by real minutes (appointment buffers, not wall-clock slots). */
export function addMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

/** Minutes since midnight for a zero-padded HH:MM. */
export function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

/** Zero-padded HH:MM from minutes since midnight. */
export function fromMinutes(n: number): string {
  const h = Math.floor(n / 60);
  const m = n % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
