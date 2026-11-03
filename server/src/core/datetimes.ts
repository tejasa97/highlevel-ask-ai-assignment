import type { JsonSchema } from "../registry/registry.js";
import { TIMEZONE, zonedInstant } from "../store/clock.js";
import { unwrap } from "./refs.js";

/** The offsets, in minutes, the app timezone has in January and July of `year`. */
function zoneOffsets(year: string): Set<number> {
  const at = (date: string) => (Date.parse(`${date}T12:00:00Z`) - Date.parse(zonedInstant(date, "12:00", TIMEZONE))) / 60_000;
  return new Set([at(`${year}-01-15`), at(`${year}-07-15`)]);
}
const offsetMinutes = (o: string): number => {
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(o)!;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
};

const WALL = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/i;

/**
 * Date-time args as UTC ISO instants: "2026-10-28T09:00:00" is 9am in the app's timezone, and an offset
 * ("09:00-04:00") becomes the same instant in Z. An offset that is one of the app timezone's own (summer or winter)
 * is the model's guess at the local offset, often the wrong season's, so it reads the wall time as local instead:
 * "2026-11-02T10:00:00-04:00" after the clocks went back is 10am local. Anything else is left for validation to report.
 */
export function normalizeDateTimes(value: unknown, schema: JsonSchema): unknown {
  const s = unwrap(schema);
  if (typeof value === "string") {
    if (s.format !== "date-time") return value;
    const m = WALL.exec(value.trim());
    if (!m || (m[3]?.toUpperCase() === "Z" && m[2]!.length === 8)) return value;
    const local = !m[3] || (m[3].toUpperCase() !== "Z" && zoneOffsets(m[1]!.slice(0, 4)).has(offsetMinutes(m[3])));
    const ms = !local ? Date.parse(`${m[1]}T${m[2]!.length === 5 ? `${m[2]}:00` : m[2]}${m[3]!.toUpperCase()}`) : Date.parse(zonedInstant(m[1]!, m[2]!, TIMEZONE));
    return Number.isNaN(ms) ? value : new Date(ms).toISOString();
  }
  if (Array.isArray(value)) return s.items ? value.map((x) => normalizeDateTimes(x, s.items as JsonSchema)) : value;
  if (value && typeof value === "object" && s.properties) {
    const props = s.properties as Record<string, JsonSchema>;
    return Object.fromEntries(Object.entries(value).map(([k, x]) => [k, props[k] ? normalizeDateTimes(x, props[k]) : x]));
  }
  return value;
}
