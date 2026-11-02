import { argumentAt, argumentEntities, scopedWhere } from "../registry/arguments.js";
import type { Registry } from "../registry/registry.js";
import type { Store } from "../store/db.js";
import { checkIdentity } from "./contracts.js";
import type { SubmitPlan } from "./submit-plan.js";
import { TIMEZONE } from "../store/clock.js";
import { isDeepStrictEqual } from "node:util";

type Lookup = NonNullable<SubmitPlan["lookup"]>;
type Check = ReturnType<typeof checkIdentity>;
export type ClarificationCheck =
  | { kind: "question" }
  | { kind: "identity"; lookup: Lookup; check: Check }
  | { kind: "facts"; digest: string; ambiguous: boolean; /** Set when the only names found match no record. */ none?: { entity: string; name: string } };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
// A null stands for "not given" ("email": null beside a question about the email), the same as a missing key.
const present = (v: unknown) => v !== undefined && v !== null && v !== "";

function selector(value: unknown): Lookup | undefined {
  if (!object(value) || !Object.hasOwn(value, "$lookup")) return;
  const v = value.$lookup;
  if (Object.keys(value).length !== 1 || !object(v) || Object.keys(v).some((k) => !["entity", "name", "where"].includes(k)) || typeof v.entity !== "string" || typeof v.name !== "string") throw new Error("Invalid named argument selector");
  return { entity: v.entity, name: v.name, whereJson: v.where === undefined ? null : JSON.stringify(v.where) };
}

/**
 * The message names this input as something it brings along, without (necessarily) giving it: "with this email
 * address", "using the email I'm pasting", "with her phone number". A verb ("Email Sarah", "and email her") or a
 * passing mention ("send her an email") does not.
 */
export function namesField(message: string, path: string): boolean {
  const leaf = path.split(/[.[\]]/).filter(Boolean).pop() ?? "";
  const words = leaf.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  if (!words || /^\d+$/.test(words)) return false;
  const brought = `\\b(with|using|including|plus|via)\\s+((the following|the|this|that|these|those|her|his|their|its|my|our)\\s+)?${words}\\b`;
  const pointed = `\\b(this|that|these|those|the following)\\s+${words}\\b`;
  return new RegExp(`${brought}|${pointed}`, "i").test(message);
}

/** "at 9am", "3:30 pm", "14:00", "noon": the message says what time of day it means. */
export const TIME_OF_DAY = /\b\d{1,2}(:\d{2})?\s*([ap]\.?m\.?)(?![a-z])|\b\d{1,2}:\d{2}\b|\b(noon|midday|midnight)\b/i;
/** A time of day, or words that settle one without an hour: "now", "tonight", "tomorrow morning", "in 2 hours". */
export const SAYS_WHEN = new RegExp(`${TIME_OF_DAY.source}|\\b(now|immediately|right away|asap|tonight|morning|afternoon|evening|noon|midnight|end of (the )?day|eod)\\b|\\bin \\d+ (minutes?|mins?|hours?|hrs?)\\b`, "i");
const isDateTime = (schema: { format?: unknown; anyOf?: unknown }): boolean =>
  schema.format === "date-time" || (Array.isArray(schema.anyOf) && schema.anyOf.some((s) => isDateTime(s as { format?: unknown })));

class ParentChoice extends Error {
  constructor(readonly lookup: Lookup, readonly check: Check) { super("Parent must be resolved first"); }
}

/** A question must name an offered action and a real missing argument, regardless of its prose category. */
export function assessClarification(d: SubmitPlan, registry: Registry, offered: ReadonlySet<string>, message: string, store?: Store): ClarificationCheck {
  if (!d.missing) throw new Error("clarify requires missing {action, argument, argsJson}; bind the question to a required input, or plan/search instead");
  const { action: id, argument: path, argsJson } = d.missing;
  // <now> settles the zone and the year, so a question about either is never needed, unless the zone is the input itself.
  if (/time\s?zone|\b(which|what) year\b/i.test(d.question ?? "") && !/zone|year/i.test(path)) throw new Error(`<now> gives today's date and the workspace time zone, ${TIMEZONE}: a date without a year is its next one from today, and a time is in that zone. Don't ask either; plan with the date and time the user gave`);
  const action = registry.get(id);
  if (!action || !offered.has(id)) throw new Error(`Clarification action ${id} must be in <actions>`);
  const args: unknown = JSON.parse(argsJson);
  if (!object(args)) throw new Error("missing.argsJson must be an object of known arguments");
  const properties = (action.inputSchema.properties ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(args)) if (!Object.hasOwn(properties, key)) throw new Error(`Unknown known argument ${key}`);
  const field = argumentAt(action, args, path);
  const inline = selector(field.value);
  if (inline && d.lookup && (inline.entity !== d.lookup.entity || inline.name !== d.lookup.name || !isDeepStrictEqual(JSON.parse(inline.whereJson ?? "{}"), JSON.parse(d.lookup.whereJson ?? "{}")))) throw new Error("Conflicting argument and clarification lookup selectors");
  let lookup = inline ?? d.lookup ?? undefined;
  // "2026-11-02" in a date-time input is the day without the time the question asks for, so it isn't supplied yet.
  const dayOnly = isDateTime(field.schema) && typeof field.value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(field.value.trim());
  if (present(field.value) && !inline && !dayOnly) throw new Error(`${path} is already supplied; use plan/look to validate or inspect it, not clarify`);
  const time = isDateTime(field.schema) && message.match(TIME_OF_DAY)?.[0];
  if (time) throw new Error(`The message gives the time (${time}); set ${path} to it in the workspace time zone, ${TIMEZONE}, written as the input's ISO date-time, rather than asking`);
  const entities = argumentEntities(action, path, args).filter((e) => registry.resolver(e));
  // A question about a plain value ("what time?") can't select a record, so a lookup sent with it is noise; the record it
  // names stays in argsJson.
  if (lookup && !inline && !entities.length) lookup = undefined;
  if (lookup && (!entities.includes(lookup.entity) || field.schema.type !== "string")) throw new Error(`Lookup entity does not match argument ${path}; expected ${entities.join(" or ") || "a non-identity input"}`);
  const alternatives = action.inputAlternatives ?? [];
  const has = (key: string) => present(args[key]);
  if (alternatives.some((group) => !group.some((key) => path === key || path.startsWith(`${key}.`) || path.startsWith(`${key}[`)) && group.every(has))) throw new Error("A complete input alternative is already supplied; do not ask for another route's inputs");
  const required = field.required || alternatives.some((group) => group.includes(path));
  if (!required && !lookup && !namesField(message, path)) throw new Error(`${path} is optional; do not ask for an unspecified optional input`);
  const binding = action.argumentLookups?.[path.replace(/\[\d+\]/g, "[]")];
  const parent = (parentPath: string): string => {
    const value = argumentAt(action, args, parentPath).value;
    const named = selector(value);
    if (named) {
      if (!store) throw new Error("Parent identity checking needs an account store");
      if (!argumentEntities(action, parentPath, args).includes(named.entity)) throw new Error(`Invalid parent lookup entity for ${parentPath}`);
      const checked = checkIdentity(named, registry, store);
      if (checked.count !== 1) throw new ParentChoice(named, checked);
      return checked.match!.id;
    }
    if (typeof value !== "string" || !value.trim() || value.startsWith("$") || value.includes("{{$")) throw new Error(`Parent ${parentPath} needs a known ID or named lookup before clarifying ${path}`);
    return value;
  };
  try {
    if (lookup) {
      if (!store) throw new Error("Identity clarification requires an account store; use plan/look instead");
      const raw = lookup.whereJson === null ? {} : JSON.parse(lookup.whereJson) as unknown;
      if (!object(raw) || Object.values(raw).some((v) => typeof v !== "string" || !v.trim())) throw new Error("Lookup qualifiers must be nonempty strings");
      lookup = { ...lookup, whereJson: JSON.stringify(scopedWhere(binding, raw as Record<string, string>, parent)) };
      return { kind: "identity", lookup, check: checkIdentity(lookup, registry, store) };
    }
    // An ID question without a selector still checks named references in the user's message. It
    // cannot evade grounding merely by being labelled "choice" instead of "identity".
    if (store && entities.length && field.schema.type === "string") {
      const where = scopedWhere(binding, {}, parent);
      // A name the question repeats from the message ("What should Dana Whitfield be assigned to?") that no record has
      // is a fact too: the planner learns nothing matches, rather than asking the user who it is.
      const facts = namedFacts(message, entities, where, registry, store);
      if (!facts.length) for (const name of sharedNames(message, d.question ?? "")) facts.push({ entity: entities[0]!, name, count: 0, candidates: [], truncated: false });
      // The fullest name the message gives ("zoe costa", not "zoe") matching more than one record is real ambiguity.
      const ambiguous = facts.some((f) => f.count > 1 && !facts.some((g) => g !== f && g.name.includes(f.name)));
      const none = facts.length && facts.every((f) => !f.count) ? { entity: facts[0]!.entity, name: facts[0]!.name } : undefined;
      if (facts.length) return { kind: "facts", ambiguous, ...(none ? { none } : {}), digest: JSON.stringify({ action: id, argument: path, matches: facts, instruction: "These are account facts, not permission to choose a target. Preserve the user's full request and plan or clarify actual ambiguity." }) };
    }
  } catch (err) {
    if (err instanceof ParentChoice) return { kind: "identity", lookup: err.lookup, check: err.check };
    throw err;
  }
  return { kind: "question" };
}

const norm = (s: string) => s.normalize("NFKD").toLowerCase().replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim();
const STOP = new Set("a an the it me my we our i you your who which what to for of in on and or is are please".split(" "));

/**
 * Runs of two or more capitalized words (a person's or company's name) the message and the question both say, as the
 * message writes them, longest first. "the welcome email" is shared too, but it is not a name nobody has.
 */
function sharedNames(message: string, question: string): string[] {
  const tokens = message.split(/[^\p{L}\p{M}\p{N}'’-]+/u).filter(Boolean).slice(0, 64);
  const asked = ` ${norm(question)} `;
  const out: string[] = [];
  for (let size = Math.min(4, tokens.length); size > 1; size--) for (let n = 0; n <= tokens.length - size; n++) {
    const span = tokens.slice(n, n + size);
    const name = span.join(" ");
    if (span.some((w) => STOP.has(norm(w)) || !/^\p{Lu}/u.test(w)) || !asked.includes(` ${norm(name)} `) || out.some((o) => norm(o).includes(norm(name)))) continue;
    out.push(name);
  }
  return out;
}

/** Bounded mention scan for the argument's entity only. Never resolves a write target automatically. */
function namedFacts(message: string, entities: string[], where: Record<string, string>, registry: Registry, store: Store): { entity: string; name: string; count: number; candidates: unknown[]; truncated: boolean }[] {
  const words = norm(message).split(" ").slice(0, 64);
  const facts: ReturnType<typeof namedFacts> = [], seen = new Set<string>();
  for (let size = Math.min(6, words.length); size > 0; size--) for (let n = 0; n <= words.length - size; n++) {
    const span = words.slice(n, n + size);
    if (span.some((w) => STOP.has(w))) continue;
    const name = span.join(" ");
    for (const entity of entities) {
      const hits = registry.resolver(entity)!(store, name, where).filter((c) => span.every((w) => norm(c.name).split(" ").includes(w)));
      if (!hits.length) continue;
      const key = `${entity}:${hits.map((c) => c.id).sort().join(",")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      facts.push({ entity, name, count: hits.length, candidates: hits.slice(0, 8), truncated: hits.length > 8 });
      if (facts.length === 8) return facts;
    }
  }
  return facts;
}
