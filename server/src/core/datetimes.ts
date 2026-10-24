import type { JsonSchema } from "../registry/registry.js";
import { TIMEZONE, zonedInstant } from "../store/clock.js";
import { unwrap } from "./refs.js";

const WALL = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/i;

/**
 * Date-time args as UTC ISO instants: "2026-10-28T09:00:00" is 9am in the app's timezone, and an offset
 * ("09:00-04:00") becomes the same instant in Z. Anything else is left for validation to report.
 */
export function normalizeDateTimes(value: unknown, schema: JsonSchema): unknown {
  const s = unwrap(schema);
  if (typeof value === "string") {
    if (s.format !== "date-time") return value;
    const m = WALL.exec(value.trim());
    if (!m || (m[3]?.toUpperCase() === "Z" && m[2]!.length === 8)) return value;
    const ms = m[3] ? Date.parse(`${m[1]}T${m[2]!.length === 5 ? `${m[2]}:00` : m[2]}${m[3].toUpperCase()}`) : Date.parse(zonedInstant(m[1]!, m[2]!, TIMEZONE));
    return Number.isNaN(ms) ? value : new Date(ms).toISOString();
  }
  if (Array.isArray(value)) return s.items ? value.map((x) => normalizeDateTimes(x, s.items as JsonSchema)) : value;
  if (value && typeof value === "object" && s.properties) {
    const props = s.properties as Record<string, JsonSchema>;
    return Object.fromEntries(Object.entries(value).map(([k, x]) => [k, props[k] ? normalizeDateTimes(x, props[k]) : x]));
  }
  return value;
}
