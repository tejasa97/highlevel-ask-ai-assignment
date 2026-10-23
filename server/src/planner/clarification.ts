import { argumentAt, argumentEntities, scopedWhere } from "../registry/arguments.js";
import type { Registry } from "../registry/registry.js";
import type { Store } from "../store/db.js";
import { checkIdentity } from "./contracts.js";
import type { SubmitPlan } from "./submit-plan.js";
import { isDeepStrictEqual } from "node:util";

type Lookup = NonNullable<SubmitPlan["lookup"]>;
type Check = ReturnType<typeof checkIdentity>;
export type ClarificationCheck =
  | { kind: "question" }
  | { kind: "identity"; lookup: Lookup; check: Check }
  | { kind: "facts"; digest: string };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const present = (v: unknown) => v !== undefined && v !== "";

function selector(value: unknown): Lookup | undefined {
  if (!object(value) || !Object.hasOwn(value, "$lookup")) return;
  const v = value.$lookup;
  if (Object.keys(value).length !== 1 || !object(v) || Object.keys(v).some((k) => !["entity", "name", "where"].includes(k)) || typeof v.entity !== "string" || typeof v.name !== "string") throw new Error("Invalid named argument selector");
  return { entity: v.entity, name: v.name, whereJson: v.where === undefined ? null : JSON.stringify(v.where) };
}

class ParentChoice extends Error {
  constructor(readonly lookup: Lookup, readonly check: Check) { super("Parent must be resolved first"); }
}

/** A question must name an offered action and a real missing argument, regardless of its prose category. */
export function assessClarification(d: SubmitPlan, registry: Registry, offered: ReadonlySet<string>, message: string, store?: Store): ClarificationCheck {
  if (!d.missing) throw new Error("clarify requires missing {action, argument, argsJson}; bind the question to a required input, or plan/search instead");
  const { action: id, argument: path, argsJson } = d.missing;
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
  if (present(field.value) && !inline) throw new Error(`${path} is already supplied; use plan/look to validate or inspect it, not clarify`);
  const entities = argumentEntities(action, path).filter((e) => registry.resolver(e));
  if (lookup && (!entities.includes(lookup.entity) || field.schema.type !== "string")) throw new Error(`Lookup entity does not match argument ${path}; expected ${entities.join(" or ") || "a non-identity input"}`);
  const alternatives = action.inputAlternatives ?? [];
  const has = (key: string) => present(args[key]);
  if (alternatives.some((group) => !group.some((key) => path === key || path.startsWith(`${key}.`) || path.startsWith(`${key}[`)) && group.every(has))) throw new Error("A complete input alternative is already supplied; do not ask for another route's inputs");
  const required = field.required || alternatives.some((group) => group.includes(path));
  if (!required && !lookup) throw new Error(`${path} is optional; do not ask for an unspecified optional input`);
  const binding = action.argumentLookups?.[path.replace(/\[\d+\]/g, "[]")];
  const parent = (parentPath: string): string => {
    const value = argumentAt(action, args, parentPath).value;
    const named = selector(value);
    if (named) {
      if (!store) throw new Error("Parent identity checking needs an account store");
      if (!argumentEntities(action, parentPath).includes(named.entity)) throw new Error(`Invalid parent lookup entity for ${parentPath}`);
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
      const facts = namedFacts(message, entities, where, registry, store);
      if (facts.length) return { kind: "facts", digest: JSON.stringify({ action: id, argument: path, matches: facts, instruction: "These are account facts, not permission to choose a target. Preserve the user's full request and plan or clarify actual ambiguity." }) };
    }
  } catch (err) {
    if (err instanceof ParentChoice) return { kind: "identity", lookup: err.lookup, check: err.check };
    throw err;
  }
  return { kind: "question" };
}

const norm = (s: string) => s.normalize("NFKD").toLowerCase().replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim();
const STOP = new Set("a an the it me my we our i you your who which what to for of in on and or is are please".split(" "));

/** Bounded mention scan for the argument's entity only. Never resolves a write target automatically. */
function namedFacts(message: string, entities: string[], where: Record<string, string>, registry: Registry, store: Store): unknown[] {
  const words = norm(message).split(" ").slice(0, 64);
  const facts: unknown[] = [], seen = new Set<string>();
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
