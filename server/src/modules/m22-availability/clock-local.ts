import { WEEKDAYS } from "./schema.js";

// Wall-clock conversion for an arbitrary IANA zone. `atLocal` in the store only
// knows America/New_York, and the availability index is not allowed to construct dates.

const SUN_FIRST = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

function parts(ms: number, timeZone: string): { date: string; time: string } {
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

/** ISO instant for HH:MM on a calendar date in `timeZone`. Two passes so a DST boundary settles. */
export function zonedInstant(date: string, hhmm: string, timeZone: string): string {
  const hm = hhmm.length === 5 ? `${hhmm}:00` : hhmm;
  const wall = Date.parse(`${date}T${hm}Z`);
  const offset = (ms: number) => {
    const p = parts(ms, timeZone);
    return Date.parse(`${p.date}T${p.time}Z`) - ms;
  };
  const guess = wall - offset(wall);
  return new Date(wall - offset(guess)).toISOString();
}

function instantMs(instant: Date | string | number): number {
  if (typeof instant === "number") return instant;
  if (typeof instant === "string") return Date.parse(instant);
  return instant.getTime();
}

/** YYYY-MM-DD of an instant in `timeZone`. */
export function zonedDate(instant: Date | string | number, timeZone: string): string {
  return parts(instantMs(instant), timeZone).date;
}

/** HH:MM of an instant in `timeZone`. */
export function zonedTime(instant: Date | string | number, timeZone: string): string {
  return parts(instantMs(instant), timeZone).time.slice(0, 5);
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
