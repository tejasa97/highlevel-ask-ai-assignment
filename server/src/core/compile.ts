import { createHash } from "node:crypto";
import type { z } from "zod";
import type { SubmitPlan } from "../planner/submit-plan.js";
import { CATALOG_ACTIONS } from "../registry/catalog.js";
import type { JsonSchema, RegisteredAction, Registry } from "../registry/registry.js";
import { ANY, arrayOf, collectRefs, fieldsOf, isLoopEntry, kindOf, literalList, looksLikeBrokenRef, parseRef, pathOf, RESERVED_ROOTS, type Ref, templateSlips, typeAt, unwrap } from "./refs.js";
import { normalizeDateTimes } from "./datetimes.js";
import { lowerLookups, OTHER_THAN } from "./lookups.js";
import { argumentEntities } from "../registry/arguments.js";

// Stage 1 of validation: everything that can be checked before anything runs.
// - structure: unique step ids, known actions that were offered to the planner this turn, JSON in argsJson/whereJson
// - references: backward-only (so the graph is acyclic), every path exists in the producer's output schema,
//   $item/$rr only inside forEach, and the referenced value's shape fits where it is used
// - literal args: checked against the action's input schema (ref-valued args wait for stage 2)
// Errors are written for the planner, so one repair call can fix them.

export interface Call {
  action: RegisteredAction;
  args: Record<string, unknown>;
  /** Arg paths filled from a list ("$s2.items[*].id") that must hold exactly one value when the step runs. */
  one?: (string | number)[][];
}

export type CStep = { id: string; deps: string[]; type: JsonSchema } & (
  | { kind: "action"; call: Call }
  | { kind: "resolve"; entity: string; name: string; where?: Record<string, string>; /** Bound from the NER index: used as is, no store lookup. */ pinned?: { id: string; name: string } }
  | { kind: "filter"; in: string; where: Record<string, unknown> }
  | { kind: "exclude"; in: string; by: string; set: string }
  | { kind: "forEach"; in: string | string[]; roundRobin: string | string[] | null; calls: Call[] }
);

export interface CompiledPlan {
  steps: CStep[];
  /** Hash of the plan as compiled; a confirmation is bound to it. */
  hash: string;
}

export type CompileResult = { ok: true; plan: CompiledPlan } | { ok: false; errors: string[] };

export const WHERE_OPS = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "nin", "contains", "exists", "orNull"] as const;
const RESOLVED: JsonSchema = {
  type: "object",
  properties: { id: { type: "string" }, name: { type: "string" } },
  required: ["id", "name"],
};

/**
 * `offered`: the action ids the planner was shown this turn. A plan may only use those, so a model that
 * remembers an id from an earlier turn (or makes one up) can't reach an action retrieval didn't pick.
 */
export function compile(plan: SubmitPlan, registry: Registry, offered?: ReadonlySet<string>): CompileResult {
  const errors: string[] = [];
  if (plan.type !== "plan") return { ok: false, errors: [`expected type "plan", got "${plan.type}"`] };
  const lowered = lowerLookups(plan.steps ?? [], registry);
  errors.push(...lowered.errors);
  const raw = tidy(lowered.steps);
  if (raw.length === 0) return { ok: false, errors: ["plan has no steps"] };
  const ids = new Set(raw.map((s) => s.id));

  const types = new Map<string, JsonSchema>(); // step id → output type, filled in order
  const kinds = new Map<string, string>(); // step id → kind/op, for errors that list the legal steps
  const ents = new Map<string, string>(); // step id → the record type it returns or lists, when known
  const steps: CStep[] = [];

  for (const s of raw) {
    const at = `step ${s.id}`;
    if (types.has(s.id) || steps.some((x) => x.id === s.id)) {
      errors.push(`${at}: duplicate step id`);
      continue;
    }
    if (RESERVED_ROOTS.has(s.id)) {
      errors.push(`${at}: "${s.id}" is reserved; use ids like s1, s2`);
      continue;
    }
    const deps = new Set<string>();
    const scope: Scope = { types, kinds, deps, at, self: s.id, all: ids, item: null, rr: null, prev: null, offered, registry, ents, itemEnt: null, rrEnt: null };
    const err = (m: string) => errors.push(`${at}: ${m}`);

    // A step with errors still gets its output type, so later steps are checked against it
    // instead of all reporting "not an earlier step".
    try {
      if (s.kind === "action") {
        // The action variant has no id enum, so a planner sometimes names "resolve" there and puts the entity
        // and name in argsJson. That is a resolve step written the other way round: take it as one.
        if (s.action.trim().toLowerCase() === "resolve") {
          const args = parseObject(s.argsJson, "argsJson", err);
          if (!args) continue;
          const [entity, name] = [args.entity, args.name];
          if (typeof entity !== "string" || typeof name !== "string" || !entity || !name) {
            err(`"resolve" needs "entity" and "name" in argsJson, e.g. {"entity": "contact", "name": "Zoe Costa"}; or write kind "resolve" with entity and name`);
            continue;
          }
          if (!registry.resolver(entity)) {
            err(`can't resolve entity "${entity}"; resolvable: ${registry.resolverEntities().join(", ")}`);
            continue;
          }
          steps.push({ id: s.id, kind: "resolve", entity, name, deps: [], type: RESOLVED });
          types.set(s.id, RESOLVED);
          ents.set(s.id, entity);
          continue;
        }
        const call = compileCall(s.action, s.argsJson, registry, scope, err);
        if (!call) continue;
        steps.push({ id: s.id, kind: "action", call, deps: [...deps], type: call.action.outputSchema });
        types.set(s.id, call.action.outputSchema);
        if (call.action.entities?.produces) ents.set(s.id, call.action.entities.produces);
      } else if (s.kind === "resolve") {
        if (!registry.resolver(s.entity)) {
          err(`can't resolve entity "${s.entity}"; resolvable: ${registry.resolverEntities().join(", ")}`);
          continue;
        }
        const where = s.whereJson == null ? {} : parseObject(s.whereJson, "whereJson", err);
        if (!s.name.trim()) err("resolve requires a non-empty name");
        if (!where) continue;
        // {"courseId": {"$lookup": {"entity": "course", "name": "Sales 101"}}}: qualifiers that name a parent take its name.
        for (const [key, value] of Object.entries(where)) {
          const name = (value as { $lookup?: { name?: unknown } } | null)?.$lookup?.name;
          if (typeof name === "string" && name.trim()) where[key] = name.trim();
        }
        const allowed = registry.resolver(s.entity)!.qualifiers ?? [];
        const parents = registry.resolver(s.entity)!.parentQualifiers;
        if (parents?.length && !parents.some((key) => where[key])) err(`child lookup ${s.entity} requires a parent qualifier: ${parents.join(" or ")}`);
        for (const [key, value] of Object.entries(where)) {
          if (!allowed.includes(key) && key !== OTHER_THAN) err(`unknown ${s.entity} qualifier ${key}; allowed: ${allowed.join(", ") || "none"}`);
          if (typeof value !== "string" || !value.trim()) err(`qualifier ${key} must be a non-empty string`);
        }
        for (const ref of collectRefs(where)) {
          const type = refType(ref.ref, scope, err);
          if (type && unwrap(type).type !== "string") err(`lookup qualifiers require a single string`);
        }
        steps.push({ id: s.id, kind: "resolve", entity: s.entity, name: s.name, ...(Object.keys(where).length ? { where: where as Record<string, string> } : {}), deps: [...deps], type: RESOLVED });
        types.set(s.id, RESOLVED);
        ents.set(s.id, s.entity);
      } else {
        if (s.op !== "forEach" && Array.isArray(s.in)) {
          err(`"in" on ${s.op} must be a $ref to a list; a literal array is only for forEach`);
          continue;
        }
        const literal = s.op === "forEach" ? literalList(oneRecord(s.in, kinds), err) : undefined;
        if (literal === null) continue;
        const inType = literal ? writtenList(literal, scope, `"in"`, err) : listRef(s.in as string, scope, `"in"`, err);
        if (!inType) continue;
        const item = (unwrap(inType).items ?? ANY) as JsonSchema;
        const itemEnt = literal ? writtenEnt(literal, scope) : listEnt(s.in as string, scope);
        // A filter or exclude keeps the records it was given, so its result lists the same type.
        if (s.op !== "forEach" && itemEnt && !itemEnt.ids) ents.set(s.id, itemEnt.entity);

        if (s.op === "filter") {
          // A filter that keeps everything only names its list; the steps that read it can point at that list.
          if (!s.whereJson?.trim()) {
            err(`a filter needs whereJson, the condition the items it keeps meet. Without one it keeps all of ${JSON.stringify(s.in)}: where a step reads $${s.id}, write that list instead`);
            continue;
          }
          const where = parseObject(s.whereJson, "whereJson", err);
          if (!where) continue;
          checkWhere(where, item, scope, err);
          steps.push({ id: s.id, kind: "filter", in: s.in as string, where, deps: [...deps], type: inType });
          types.set(s.id, inType);
        } else if (s.op === "exclude") {
          if (!s.by || !s.set) {
            err(`exclude needs "by" (a field of each item) and "set" (a $ref to a list)`);
            continue;
          }
          checkField(item, s.by, `"by"`, err);
          const setType = listRef(s.set, scope, `"set"`, err);
          if (setType && kindOf((unwrap(setType).items ?? ANY) as JsonSchema) === "object") {
            err(`"set" ${s.set} is a list of objects; point at the field, e.g. ${s.set}[*].id`);
          }
          steps.push({ id: s.id, kind: "exclude", in: s.in as string, by: s.by, set: s.set, deps: [...deps], type: inType });
          types.set(s.id, inType);
        } else {
          if (!s.do?.length) {
            err(`forEach needs at least one call in "do"; it runs actions, it does not construct a list. Put action/argsJson calls in "do".`);
            continue;
          }
          let rr: JsonSchema | null = null;
          let rrEnt: Ent | null = null;
          // Like "in", the people to rotate through may be written out: ["us_2","us_4"].
          const rrLiteral = s.roundRobin ? literalList(oneRecord(s.roundRobin, kinds), err, "roundRobin") : undefined;
          if (rrLiteral === null) continue;
          if (s.roundRobin) {
            const t = rrLiteral ? writtenList(rrLiteral, scope, `"roundRobin"`, err) : listRef(s.roundRobin, scope, `"roundRobin"`, err);
            if (!t) continue;
            rr = (unwrap(t).items ?? ANY) as JsonSchema;
            rrEnt = rrLiteral ? writtenEnt(rrLiteral, scope) : listEnt(s.roundRobin, scope);
          }
          const inner: Scope = { ...scope, item, rr, itemEnt, rrEnt };
          const own = {
            item: kindOf(item) === "scalar" ? ownNames(literal ?? s.in, itemEnt) : [],
            rr: rr && kindOf(rr) === "scalar" ? ownNames(rrLiteral ?? s.roundRobin!, rrEnt) : [],
          };
          const actions = s.do.map((c) => c.action);
          // $prev in a call is what the call before it in "do" returned for the same item.
          const calls: (Call | null)[] = [];
          s.do.forEach((c, i) => {
            const prev = i > 0 ? (calls[i - 1]?.action.outputSchema ?? ANY) : null;
            calls.push(
              compileCall(c.action, ownField(c.argsJson, own), registry, { ...inner, prev, at: `${at} do[${i}]`, inDo: { step: s.id, actions, index: i } }, (m) =>
                errors.push(`${at} do[${i}]: ${m}`),
              ),
            );
          });
          if (calls.some((c) => !c)) continue;
          // results[k] is what do[k] returned for the item.
          const results = { ...arrayOf(ANY), prefixItems: (calls as Call[]).map((c) => c.action.outputSchema ?? ANY) };
          const out = arrayOf({ type: "object", properties: { item, results } });
          steps.push({ id: s.id, kind: "forEach", in: literal ?? (s.in as string), roundRobin: rrLiteral ?? s.roundRobin, calls: calls as Call[], deps: [...deps], type: out });
          types.set(s.id, out);
        }
      }
    } finally {
      if (!types.has(s.id)) types.set(s.id, (s.kind === "action" && registry.get(s.action)?.outputSchema) || ANY);
      if (!kinds.has(s.id)) kinds.set(s.id, s.kind === "op" ? s.op : s.kind);
    }
  }

  if (errors.length) return { ok: false, errors };
  const hash = createHash("sha256").update(JSON.stringify(raw)).digest("hex").slice(0, 16);
  return { ok: true, plan: { steps, hash } };
}

interface Scope {
  types: Map<string, JsonSchema>;
  kinds: Map<string, string>;
  deps: Set<string>;
  at: string;
  item: JsonSchema | null;
  rr: JsonSchema | null;
  prev: JsonSchema | null;
  offered?: ReadonlySet<string>;
  registry: Registry;
  ents: Map<string, string>;
  itemEnt: Ent | null;
  rrEnt: Ent | null;
  /** The id of the step being compiled: a ref to it is the usual off-by-one, so the error can name the right id. */
  self: string;
  /** Every step id in the submitted plan, so a ref to a later step can say it comes later. */
  all: ReadonlySet<string>;
  /** Inside a forEach: the step, its "do" actions, and which one this call is. */
  inDo?: { step: string; actions: string[]; index: number };
}

// ---------- record types of ids ----------
// An id arg says which record it takes ("review request id (rrq_…)"); a step's records come from the action's
// entities.produces or the resolve's entity. A ref that hands one record type's id to an arg that wants another
// (an appointment's id as requestId) fails at run time with NOT_FOUND, so compile says so first. Only ids whose
// type is known on both sides are checked.

/** What a ref or list holds: records of `entity`, or (ids) their ids. */
type Ent = { entity: string; ids: boolean };

const words = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\s-]+/g, " ").trim().toLowerCase();

/** The known entity a phrase names: itself, or its last words ("support ticket" → ticket). */
function entityNamed(phrase: string, registry: Registry): string | null {
  const p = words(phrase);
  let best: string | null = null;
  for (const e of knownEntities(registry)) {
    const w = words(e);
    if ((p === w || p.endsWith(` ${w}`)) && (!best || w.length > words(best).length)) best = e;
  }
  return best;
}

const KNOWN = new WeakMap<Registry, string[]>();
function knownEntities(registry: Registry): string[] {
  let k = KNOWN.get(registry);
  if (!k) {
    const s = new Set(registry.resolverEntities());
    for (const a of registry.list()) {
      if (a.entities?.produces) s.add(a.entities.produces);
      for (const c of a.entities?.consumes ?? []) s.add(c);
    }
    KNOWN.set(registry, (k = [...s]));
  }
  return k;
}

/** The type a ref (or a list ref) holds. "$s1.items" → records; "$s1.items[*].id", "$item.contactId" → ids. */
function listEnt(raw: string, scope: Scope): Ent | null {
  const ref = parseRef(raw.trim());
  if (!ref) return null;
  const root = ref.root === "item" ? scope.itemEnt : ref.root === "rr" ? scope.rrEnt : scope.ents.has(ref.root) ? { entity: scope.ents.get(ref.root)!, ids: false } : null;
  let path = ref.path;
  if (root && !root.ids) {
    if (path[0] && "field" in path[0] && path[0].field === "items") path = path.slice(1);
    if (path[0] && !("field" in path[0])) path = path.slice(1);
  }
  if (!path.length) return root;
  const last = path.at(-1)!;
  if (!("field" in last)) return null;
  if (last.field === "id") return path.length === 1 && root && !root.ids ? { entity: root.entity, ids: true } : null;
  const named = /^(.+)Id$/.exec(last.field);
  const entity = named ? entityNamed(named[1]!, scope.registry) : null;
  return entity ? { entity, ids: true } : null;
}

function writtenEnt(list: string[], scope: Scope): Ent | null {
  const all = list.map((x) => (parseRef(x) ? listEnt(x, scope) : null));
  const first = all[0];
  return first && all.every((e) => e && e.entity === first.entity && e.ids === first.ids) ? first : null;
}

/** The record type an id arg takes: from its record-type sibling when it has one, else its description: "contact id (ct_…)", "user ids". */
function argEntity(action: RegisteredAction, at: (string | number)[], args: Record<string, unknown>, registry: Registry): string | null {
  const path = at.map((s, i) => (typeof s === "number" ? `[${s}]` : i ? `.${s}` : s)).join("");
  if (action.typedIds?.[path.replace(/\[\d+\]/g, "[]")]) {
    const [type] = argumentEntities(action, path, args);
    return type && !parseRef(type) ? entityNamed(type, registry) : null;
  }
  const desc = (s: JsonSchema | null) => (s ? ((s.description ?? unwrap(s).description) as string | undefined) : undefined);
  const d = desc(schemaAt(action.inputSchema, at)) ?? (typeof at.at(-1) === "number" ? desc(schemaAt(action.inputSchema, at.slice(0, -1))) : undefined);
  const m = d && /^(?:the |a |an )?([A-Za-z][A-Za-z ]*?) ids?\b/.exec(d.trim());
  // "contact or lead id" names no single type.
  return m && !/\bor\b/.test(m[1]!) ? entityNamed(m[1]!, registry) : null;
}

/** The path to an action result's own id ("id", "request.id"), or null. */
function idPath(schema: JsonSchema): string | null {
  if (fieldsOf(schema).includes("id")) return "id";
  const props = (unwrap(schema).properties ?? {}) as Record<string, JsonSchema>;
  const f = Object.keys(props).find((k) => fieldsOf(props[k]!).includes("id"));
  return f ? `${f}.id` : null;
}

function idTypeError(id: string, at: (string | number)[], raw: string, have: string, want: string, scope: Scope): string {
  const article = (e: string) => (/^[aeio]/i.test(words(e)) ? "an" : "a");
  let msg = `${id} arg ${at.join(".")} takes ${article(want)} ${words(want)} id, but ${raw} is ${article(have)} ${words(have)} id.`;
  const d = scope.inDo;
  const k = d ? d.actions.findIndex((a, i) => i !== d.index && scope.registry.get(a)?.entities?.produces === want) : -1;
  if (d && k >= 0) {
    const path = idPath(scope.registry.get(d.actions[k]!)!.outputSchema);
    msg += ` Calls in one "do" can't use each other's results: move ${id} into its own forEach step after ${d.step}, with "in": "$${d.step}[*].results[${k}]${path ? `.${path}` : ""}" (the ${words(want)} ids ${d.actions[k]} returned) and the arg set to "$item".`;
  } else {
    msg += ` Use the id of ${article(want)} ${words(want)} record, from a step that finds or creates one.`;
  }
  return msg;
}

/** Static type of a ref, or null after reporting why it's wrong. */
function refType(raw: string, scope: Scope, err: (m: string) => void): JsonSchema | null {
  const ref = parseRef(raw);
  if (!ref) {
    err(`"${raw}" is not a valid $ref (forms: $s1.items, $s1.items[*].id, $item.id, $rr.userId, $prev.id)`);
    return null;
  }
  const root = rootType(ref, scope, err);
  if (!root) return null;
  const t = typeAt(root, ref.path, `$${ref.root}`);
  if ("error" in t) {
    const kind = scope.kinds.get(ref.root);
    // "[*].results" is the forEach shape; reaching for it on a filter or an action is the same mistake as
    // "does this step give me a list", so say which step kind the ref actually names.
    const star = ref.path[0] !== undefined && "all" in ref.path[0];
    const hint = kind === "resolve"
      ? ` Resolve returns one {id, name}, not a list or a full record; use $${ref.root}.id for its id. Read other record fields with a listed action: plan that read as its own step, then take a field of every item from "$sN.items[*].id"; if no listed action reads it, reply search_tools.`
      : star && kind !== "forEach"
        ? ` "[*]" walks a list, and only a forEach step has "results": $${ref.root} is ${kind ? `${/^[aeiou]/.test(kind) ? "an" : "a"} ${kind} step` : "not a forEach step"}, so a field of each of its items is "$${ref.root}[*].<field>".`
        : (ref.root === "item" || ref.root === "rr") && kindOf(root) === "scalar"
          ? ` $${ref.root} is the scalar element of its input list; use $${ref.root} directly, without a field.`
          : "";
    err(t.error + hint);
    return null;
  }
  return t.type;
}

function rootType(ref: Ref, scope: Scope, err: (m: string) => void): JsonSchema | null {
  if (ref.root === "item" || ref.root === "rr") {
    const t = ref.root === "item" ? scope.item : scope.rr;
    if (!t) {
      // Name a step the plan already has: the old example ("$s2[*].userId") was the step being written,
      // which is the one ref the compiler refuses.
      const people = [...scope.ents].filter(([id, e]) => e === "user" && scope.types.get(id)).at(-1)?.[0];
      err(
        ref.root === "item"
          ? `$item only works inside forEach "do"; the action that runs once per item belongs in that "do", and a step after the loop reads what it made with "$sN[*].results[0].<field>"`
          : `$rr needs "roundRobin" on the forEach: set it to the list to rotate through${people ? `, like "$${people}.items[*].id" (the people $${people} returned)` : `, a $ref like "$s1.items[*].id"`}, or write the ids out as a JSON array`,
      );
    }
    return t;
  }
  if (ref.root === "prev") {
    if (!scope.prev) err(`$prev is the previous call's output; it only works in the second or later call of a forEach "do"`);
    return scope.prev;
  }
  if (ref.root === "ctx") {
    err(`$ctx is not available yet`);
    return null;
  }
  const t = scope.types.get(ref.root);
  if (!t) {
    const steps = [...scope.kinds].map(([id, kind]) => `${id} (${kind})`);
    const context = new Set(["looked", "mentions", "context", "actions", "now", "recent_records"]);
    const prev = [...scope.kinds.keys()].at(-1);
    // Counting from 0, or naming the step being written, is what this error usually is: name the id to use instead.
    const off = ref.root === "s0"
      ? " Step ids count from s1, so the first step is s1."
      : ref.root === scope.self
        ? ` $${ref.root} is the step you are writing; a step can only use earlier ids${prev ? `, and the step just before it is $${prev}` : ""}.${scope.inDo ? ` Inside "do", the current item is $item.` : ""}`
        : scope.all.has(ref.root)
          ? ` $${ref.root} comes later in your plan; list it before this step, or use the step that already has the value.`
          : "";
    err(
      `$${ref.root} is not an earlier step; ${steps.length ? `your steps are ${steps.join(", ")}` : "there are no earlier steps yet"}. Refs can only point back to a step id.` +
        off +
        (context.has(ref.root) ? ` <${ref.root}> is a prompt block, not a step: copy the value you need into args as plain text${ref.root === "recent_records" ? ` (a loop over some of them is "in": ["tsk_1", "tsk_2"], their ids written out)` : ""}.` : ""),
    );
    return null;
  }
  scope.deps.add(ref.root);
  return t;
}

function listRef(raw: string, scope: Scope, what: string, err: (m: string) => void): JsonSchema | null {
  const t = refType(raw, scope, err);
  if (!t) return null;
  const k = kindOf(t);
  if (k === "any") return arrayOf(ANY);
  if (k !== "array") {
    const fields = fieldsOf(t).filter((f) => kindOf(((unwrap(t).properties ?? {}) as Record<string, JsonSchema>)[f]!) === "array");
    const resolve = scope.kinds.get(parseRef(raw.trim())?.root ?? "") === "resolve";
    err(
      `${what} ${raw} is not a list${fields.length ? `; did you mean ${fields.map((f) => `${raw}.${f}`).join(" or ")}?` : ""}` +
        (resolve ? ` A resolve names one record already: use "${raw}.id" where you need it, and filter only a list a read action returned.` : ""),
    );
    return null;
  }
  return t;
}

type RawStep = NonNullable<SubmitPlan["steps"]>[number];

/**
 * Slips with only one reading, rewritten rather than sent back, so a repair round goes on what is really wrong:
 * - an exclude whose "set" is written out (["ld_1"]) is a filter on "by" not in those values;
 * - a filter with no condition that no step reads does nothing, so it goes;
 * - a step that reads a step listed after it runs after it: the plan is a graph, so the order it was written in is not
 *   the order it must run in. A cycle is left for compile to report.
 */
export function tidy(steps: RawStep[]): RawStep[] {
  const out = steps.map((s) => {
    if (s.kind === "op" && s.op === "exclude" && s.by && s.set) {
      const written = literalList(s.set, () => {}, "set");
      if (written) return { ...s, op: "filter" as const, whereJson: JSON.stringify({ [s.by]: { nin: written } }), by: null, set: null };
    }
    return s;
  });
  const empty = (s: RawStep) => s.kind === "op" && s.op === "filter" && !s.whereJson?.trim();
  const reads = (s: RawStep) => out.some((x) => x !== s && [...JSON.stringify(x).matchAll(/\$([A-Za-z_]\w*)/g)].some((m) => m[1] === s.id));
  const kept = out.filter((s) => !empty(s) || reads(s));
  if (kept.length && kept.length < out.length) return tidy(kept);
  const ids = new Set(out.map((s) => s.id));
  const needs = new Map(out.map((s) => [s.id, new Set([...JSON.stringify(s).matchAll(/\$([A-Za-z_]\w*)/g)].map((m) => m[1]!).filter((r) => r !== s.id && ids.has(r)))]));
  const order: RawStep[] = [];
  const placed = new Set<string>();
  while (order.length < out.length) {
    const next = out.find((s) => !placed.has(s.id) && [...needs.get(s.id)!].every((r) => placed.has(r)));
    if (!next) return out;
    order.push(next);
    placed.add(next.id);
  }
  return order;
}

/**
 * A resolve finds one record, but models loop over it as if it found a list: "in": "$s1", "$s1.items",
 * "$s1.items[*].id". That is a list of the one record (or of its field), written out as ["$s1"] / ["$s1.id"].
 */
function oneRecord(raw: string | string[], kinds: Map<string, string>): string | string[] {
  if (typeof raw !== "string") return raw;
  const ref = parseRef(raw.trim());
  if (!ref || kinds.get(ref.root) !== "resolve") return raw;
  let path = ref.path;
  if (path[0] && "field" in path[0] && path[0].field === "items") path = path.slice(1);
  if (path[0] && ("all" in path[0] || ("index" in path[0] && path[0].index === 0))) path = path.slice(1);
  if (path.length > 1 || (path[0] && !("field" in path[0]))) return raw;
  return [path[0] ? `$${ref.root}.${path[0].field}` : `$${ref.root}`];
}

/** The field a list of values was taken from: "userId" for "$s1.items[*].userId" or ["$u1.userId"], else null. */
function elementField(raw: string | string[]): string | null {
  const fields = (typeof raw === "string" ? [raw] : raw).map((x) => {
    const last = parseRef(x)?.path.at(-1);
    return last && "field" in last ? last.field : null;
  });
  return fields.length && fields.every((f) => f && f === fields[0]) ? fields[0]! : null;
}

/**
 * The fields that name a scalar element itself: the field it was projected from ("userId" for
 * "$s1.items[*].userId"), ".id" on a list of ids, and ".<type>Id" on ids of a known type ("$rr.userId" over user ids).
 */
function ownNames(raw: string | string[], ent: Ent | null): string[] {
  const f = elementField(raw);
  const names = new Set<string>();
  if (f) names.add(f);
  if (f && /id$/i.test(f)) names.add("id");
  if (ent?.ids) {
    const camel = words(ent.entity).replace(/ (\w)/g, (_, c: string) => c.toUpperCase());
    names.add("id").add(`${camel}Id`);
  }
  return [...names];
}

/**
 * Over a list of values projected from records ("$s1.items[*].userId"), "$rr.userId" names the value it already is;
 * so do the other ownNames. All are written as the bare "$rr" / "$item". Any other field stays an error.
 */
function ownField(argsJson: string, own: { item: string[]; rr: string[] }): string {
  let out = argsJson;
  for (const root of ["item", "rr"] as const) {
    const names = own[root];
    if (!names.length) continue;
    out = out.replace(new RegExp(`\\$${root}\\.(?:${names.join("|")})(?![\\w.\\[])`, "g"), () => `$${root}`);
  }
  return out;
}

/** The type of a written-out list: strings, single-value $refs, or $refs to records of one shape. */
function writtenList(list: string[], scope: Scope, what: string, err: (m: string) => void): JsonSchema | null {
  let item: JsonSchema | null = null;
  for (const x of list) {
    const t = parseRef(x) ? refType(x, scope, err) : looksLikeBrokenRef(x) ? (err(`${what} element "${x}" is not a valid $ref`), null) : { type: "string" };
    if (!t) return null;
    if (kindOf(t) === "array") {
      err(`${what} element "${x}" is a list; give ${what} that $ref itself instead of a JSON array around it`);
      return null;
    }
    if (item && kindOf(item) !== kindOf(t) && kindOf(t) !== "any" && kindOf(item) !== "any") {
      err(`${what} mixes records and plain values; list only ids ("$s1.id", "us_2") or only records`);
      return null;
    }
    item ??= t;
  }
  return arrayOf(item ?? { type: "string" });
}

/** A field of each item, or a dotted path into one ("relatedTo.id" on a task, "results[0].total" on a loop's). */
function checkField(item: JsonSchema, field: string, what: string, err: (m: string) => void): void {
  let cur = item;
  const parts = pathOf(field);
  for (const [i, part] of parts.entries()) {
    if (/^\d+$/.test(part)) {
      if (kindOf(cur) !== "array") return err(`${what}: "${field}" takes a position in ${parts.slice(0, i).join(".") || "the item"}, which is not a list`);
      cur = (unwrap(cur).items ?? ANY) as JsonSchema;
      continue;
    }
    if (kindOf(cur) !== "object") return;
    const fields = fieldsOf(cur);
    if (!fields.length) return;
    const at = parts.slice(0, i).join(".");
    // A loop entry's field it doesn't have is what its one "do" call returned: "total" is "results.0.total".
    const calls = isLoopEntry(cur) && !fields.includes(part) ? ((unwrap(((unwrap(cur).properties ?? {}) as Record<string, JsonSchema>).results!).prefixItems ?? []) as JsonSchema[]) : [];
    if (calls.length === 1 && fieldsOf(calls[0]!).includes(part)) {
      cur = ((unwrap(calls[0]!).properties ?? {}) as Record<string, JsonSchema>)[part]!;
      continue;
    }
    if (!fields.includes(part)) return err(`${what}: items have no field "${field}"; fields${at ? ` of ${at}` : ""}: ${fields.join(", ")}`);
    cur = ((unwrap(cur).properties ?? {}) as Record<string, JsonSchema>)[part]!;
  }
}

function checkWhere(where: Record<string, unknown>, item: JsonSchema, scope: Scope, err: (m: string) => void): void {
  for (const [field, cond] of Object.entries(where)) {
    checkField(item, field, "whereJson", err);
    const conds = cond && typeof cond === "object" && !Array.isArray(cond) ? Object.entries(cond) : [["eq", cond] as const];
    for (const [op, val] of conds) {
      if (!(WHERE_OPS as readonly string[]).includes(op)) {
        err(`whereJson.${field}: unknown operator "${op}"; use ${WHERE_OPS.join(", ")}`);
        continue;
      }
      if (op === "orNull" && typeof val !== "boolean") {
        err(`whereJson.${field}.orNull must be a boolean`);
        continue;
      }
      if (typeof val === "string" && val.startsWith("$")) {
        const t = refType(val, scope, err);
        if (t && (op === "in" || op === "nin") && kindOf(t) !== "array" && kindOf(t) !== "any") err(`whereJson.${field}.${op} needs a list, ${val} is not one`);
      } else if ((op === "in" || op === "nin") && !Array.isArray(val)) {
        err(`whereJson.${field}.${op} needs a list or a $ref to one`);
      }
    }
  }
}

function parseObject(s: string | null, what: string, err: (m: string) => void): Record<string, unknown> | null {
  if (s === null) {
    err(`${what} is required here`);
    return null;
  }
  let why = "";
  try {
    const v = JSON.parse(s);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch (e) {
    // The parser's message names the position, which a stray brace past the 80-character excerpt needs.
    why = ` (not valid JSON: ${(e as Error).message})`;
  }
  const quoted = JSON.stringify(s);
  err(`${what} must be a JSON object string${why}, got ${quoted.slice(0, 80)}${quoted.length > 80 ? `…${JSON.stringify(s.slice(-20))}` : ""}`);
  return null;
}

function compileCall(id: string, argsJson: string, registry: Registry, scope: Scope, err: (m: string) => void): Call | null {
  // Small models copy the listing line, "M21.A03 Search appointments": the id followed by exactly its own name is the id.
  const [head, ...rest] = id.trim().split(/\s+/);
  const named = rest.length && registry.get(head!);
  if (!registry.get(id) && named && rest.join(" ").toLowerCase() === named.name.toLowerCase()) id = head!;
  const action = registry.get(id);
  const known = CATALOG_ACTIONS.get(id);
  if (!action) {
    err(known ? `${id} (${known.name}) is not available in this version; reply unsupported if the request needs it` : `unknown action ${id}`);
    return null;
  }
  if (scope.offered && !scope.offered.has(id)) {
    err(`${id} was not in <actions>; use a listed action, or reply search_tools with a query for what's missing`);
    return null;
  }
  const parsedArgs = parseObject(argsJson, "argsJson", err);
  if (!parsedArgs) return null;
  const args = normalizeDateTimes(parsedArgs, action.inputSchema) as Record<string, unknown>;

  // Refs: each must type-check, and its shape must fit the arg it fills.
  const refs = collectRefs(args);
  const one: (string | number)[][] = [];
  let ok = true;
  for (const r of refs) {
    if (r.template) {
      if (!refType(r.ref, scope, (m) => (err(m), (ok = false)))) ok = false;
      continue;
    }
    const t = refType(r.ref, scope, (m) => (err(m), (ok = false)));
    if (!t) {
      ok = false;
      continue;
    }
    const want = schemaAt(action.inputSchema, r.at);
    const [have, need] = [kindOf(t), want ? kindOf(want) : "any"];
    if (have === "array" && need === "scalar" && oneOf(r.ref, t, scope)) {
      // "the overdue invoice" planned as a search: the step runs only if the search found exactly one.
      one.push(r.at);
      continue;
    }
    if (have !== "any" && need !== "any" && have !== need) {
      err(
        `${id} arg ${r.at.join(".")} needs a ${need === "scalar" ? "single value" : need}, but ${r.ref} is ${have === "scalar" ? "a single value" : `a ${have}`}`,
      );
      ok = false;
      continue;
    }
    const held = listEnt(r.ref, scope);
    const wanted = held?.ids ? argEntity(action, r.at, args, registry) : null;
    if (held?.ids && wanted && held.entity !== wanted) {
      err(idTypeError(id, r.at, r.ref, held.entity, wanted, scope));
      ok = false;
    }
  }

  for (const slip of templateSlips(args)) {
    err(
      `${id} arg ${slip.at.join(".")}: ${slip.text.slice(0, 80)} is not a ref; a {{template}} holds one $ref (e.g. {{$item.name}}) and nothing in it is computed. To act on some records each with its own id, loop over those records and use $item.id`,
    );
    ok = false;
  }

  // Literal args: validate with ref-valued leaves removed; their issues are deferred to stage 2.
  const refPaths = refs.filter((r) => !r.template).map((r) => r.at.join("."));
  const stripped = stripAt(
    args,
    refs.filter((r) => !r.template).map((r) => r.at),
  );
  const parsed = (action.input as z.ZodType).safeParse(stripped);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const p = issue.path.join(".");
      if (refPaths.some((rp) => p === rp || p.startsWith(`${rp}.`))) continue;
      err(`${id} arg ${p || "(args)"}: ${issue.message}${hint(issue, p, action.inputSchema)}`);
      ok = false;
    }
  }
  // "requires one input group": a call naming none of them would only fail when it runs.
  const groups = action.inputAlternatives ?? [];
  if (groups.length && !groups.some((g) => g.every((k) => args[k] !== undefined && args[k] !== null))) {
    err(`${id} needs one of these input groups: ${groups.map((g) => g.join(" + ")).join(" or ")}`);
    ok = false;
  }
  return ok ? { action, args, ...(one.length ? { one } : {}) } : null;
}

/** A top-level step's ref that picks one field from each item of an earlier step's list. */
function oneOf(raw: string, t: JsonSchema, scope: Scope): boolean {
  const ref = parseRef(raw);
  if (!ref || RESERVED_ROOTS.has(ref.root) || scope.item || ref.path.filter((p) => "all" in p).length !== 1) return false;
  const items = unwrap(t).items as JsonSchema | undefined;
  return !!items && kindOf(items) === "scalar";
}

/** For an unknown argument name: the action's real argument names, and the closest one. */
function hint(issue: z.core.$ZodIssue, at: string, schema: JsonSchema): string {
  if (issue.code !== "unrecognized_keys") return "";
  const parent = at ? schemaAt(schema, at.split(".").map((k) => (/^\d+$/.test(k) ? Number(k) : k))) : schema;
  const names = parent ? fieldsOf(parent) : [];
  if (!names.length) return "";
  const close = issue.keys.map((k) => names.find((n) => n.toLowerCase() === k.toLowerCase() || n.toLowerCase().startsWith(k.toLowerCase()) || k.toLowerCase().startsWith(n.toLowerCase()))).filter((n): n is string => !!n);
  return `; arguments: ${names.join(", ")}${close.length ? `; did you mean ${[...new Set(close)].join(" or ")}?` : ""}`;
}

function schemaAt(s: JsonSchema, at: (string | number)[]): JsonSchema | null {
  let cur: JsonSchema | undefined = s;
  for (const k of at) {
    if (!cur) return null;
    const u = unwrap(cur);
    cur = typeof k === "number" ? (u.items as JsonSchema | undefined) : ((u.properties ?? {}) as Record<string, JsonSchema>)[k];
  }
  return cur ?? null;
}

function stripAt(v: unknown, paths: (string | number)[][]): unknown {
  const copy = structuredClone(v) as Record<string, unknown>;
  for (const p of paths) {
    let cur: unknown = copy;
    for (const k of p.slice(0, -1)) cur = (cur as Record<string | number, unknown>)[k];
    delete (cur as Record<string | number, unknown>)[p.at(-1)!];
  }
  return copy;
}
