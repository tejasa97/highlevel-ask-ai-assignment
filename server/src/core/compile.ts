import { createHash } from "node:crypto";
import type { z } from "zod";
import type { SubmitPlan } from "../planner/submit-plan.js";
import { CATALOG_ACTIONS } from "../registry/catalog.js";
import type { JsonSchema, RegisteredAction, Registry } from "../registry/registry.js";
import { ANY, arrayOf, collectRefs, fieldsOf, kindOf, parseRef, RESERVED_ROOTS, type Ref, typeAt, unwrap } from "./refs.js";
import { lowerLookups } from "./lookups.js";

// Stage 1 of validation: everything that can be checked before anything runs.
// - structure: unique step ids, known actions that were offered to the planner this turn, JSON in argsJson/whereJson
// - references: backward-only (so the graph is acyclic), every path exists in the producer's output schema,
//   $item/$rr only inside forEach, and the referenced value's shape fits where it is used
// - literal args: checked against the action's input schema (ref-valued args wait for stage 2)
// Errors are written for the planner, so one repair call can fix them.

export interface Call {
  action: RegisteredAction;
  args: Record<string, unknown>;
}

export type CStep = { id: string; deps: string[]; type: JsonSchema } & (
  | { kind: "action"; call: Call }
  | { kind: "resolve"; entity: string; name: string; where?: Record<string, string> }
  | { kind: "filter"; in: string; where: Record<string, unknown> }
  | { kind: "exclude"; in: string; by: string; set: string }
  | { kind: "forEach"; in: string; roundRobin: string | null; calls: Call[] }
);

export interface CompiledPlan {
  steps: CStep[];
  /** Hash of the plan as compiled; a confirmation is bound to it. */
  hash: string;
}

export type CompileResult = { ok: true; plan: CompiledPlan } | { ok: false; errors: string[] };

export const WHERE_OPS = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "nin", "contains", "exists"] as const;
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
  const raw = lowered.steps;
  if (raw.length === 0) return { ok: false, errors: ["plan has no steps"] };

  const types = new Map<string, JsonSchema>(); // step id → output type, filled in order
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
    const scope: Scope = { types, deps, at, item: null, rr: null, offered };
    const err = (m: string) => errors.push(`${at}: ${m}`);

    // A step with errors still gets its output type, so later steps are checked against it
    // instead of all reporting "not an earlier step".
    try {
      if (s.kind === "action") {
        const call = compileCall(s.action, s.argsJson, registry, scope, err);
        if (!call) continue;
        steps.push({ id: s.id, kind: "action", call, deps: [...deps], type: call.action.outputSchema });
        types.set(s.id, call.action.outputSchema);
      } else if (s.kind === "resolve") {
        if (!registry.resolver(s.entity)) {
          err(`can't resolve entity "${s.entity}"; resolvable: ${registry.resolverEntities().join(", ")}`);
          continue;
        }
        const where = s.whereJson == null ? {} : parseObject(s.whereJson, "whereJson", err);
        if (!s.name.trim()) err("resolve requires a non-empty name");
        if (!where) continue;
        const allowed = registry.resolver(s.entity)!.qualifiers ?? [];
        for (const [key, value] of Object.entries(where)) {
          if (!allowed.includes(key)) err(`unknown ${s.entity} qualifier ${key}; allowed: ${allowed.join(", ") || "none"}`);
          if (typeof value !== "string" || !value.trim()) err(`qualifier ${key} must be a non-empty string`);
        }
        for (const ref of collectRefs(where)) {
          const type = refType(ref.ref, scope, err);
          if (type && unwrap(type).type !== "string") err(`lookup qualifiers require a single string`);
        }
        steps.push({ id: s.id, kind: "resolve", entity: s.entity, name: s.name, ...(Object.keys(where).length ? { where: where as Record<string, string> } : {}), deps: [...deps], type: RESOLVED });
        types.set(s.id, RESOLVED);
      } else {
        const inType = listRef(s.in, scope, `"in"`, err);
        if (!inType) continue;
        const item = (unwrap(inType).items ?? ANY) as JsonSchema;

        if (s.op === "filter") {
          const where = parseObject(s.whereJson, "whereJson", err);
          if (!where) continue;
          checkWhere(where, item, scope, err);
          steps.push({ id: s.id, kind: "filter", in: s.in, where, deps: [...deps], type: inType });
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
          steps.push({ id: s.id, kind: "exclude", in: s.in, by: s.by, set: s.set, deps: [...deps], type: inType });
          types.set(s.id, inType);
        } else {
          if (!s.do?.length) {
            err(`forEach needs at least one call in "do"`);
            continue;
          }
          let rr: JsonSchema | null = null;
          if (s.roundRobin) {
            const t = listRef(s.roundRobin, scope, `"roundRobin"`, err);
            if (!t) continue;
            rr = (unwrap(t).items ?? ANY) as JsonSchema;
          }
          const inner: Scope = { ...scope, item, rr };
          const calls = s.do.map((c, i) =>
            compileCall(c.action, c.argsJson, registry, { ...inner, at: `${at} do[${i}]` }, (m) => errors.push(`${at} do[${i}]: ${m}`)),
          );
          if (calls.some((c) => !c)) continue;
          const out = arrayOf({ type: "object", properties: { item, results: arrayOf(ANY) } });
          steps.push({ id: s.id, kind: "forEach", in: s.in, roundRobin: s.roundRobin, calls: calls as Call[], deps: [...deps], type: out });
          types.set(s.id, out);
        }
      }
    } finally {
      if (!types.has(s.id)) types.set(s.id, (s.kind === "action" && registry.get(s.action)?.outputSchema) || ANY);
    }
  }

  if (errors.length) return { ok: false, errors };
  const hash = createHash("sha256").update(JSON.stringify(raw)).digest("hex").slice(0, 16);
  return { ok: true, plan: { steps, hash } };
}

interface Scope {
  types: Map<string, JsonSchema>;
  deps: Set<string>;
  at: string;
  item: JsonSchema | null;
  rr: JsonSchema | null;
  offered?: ReadonlySet<string>;
}

/** Static type of a ref, or null after reporting why it's wrong. */
function refType(raw: string, scope: Scope, err: (m: string) => void): JsonSchema | null {
  const ref = parseRef(raw);
  if (!ref) {
    err(`"${raw}" is not a valid $ref (forms: $s1.items, $s1.items[*].id, $item.id, $rr.userId)`);
    return null;
  }
  const root = rootType(ref, scope, err);
  if (!root) return null;
  const t = typeAt(root, ref.path, `$${ref.root}`);
  if ("error" in t) {
    err(t.error);
    return null;
  }
  return t.type;
}

function rootType(ref: Ref, scope: Scope, err: (m: string) => void): JsonSchema | null {
  if (ref.root === "item" || ref.root === "rr") {
    const t = ref.root === "item" ? scope.item : scope.rr;
    if (!t) err(ref.root === "item" ? `$item only works inside forEach "do"` : `$rr needs "roundRobin" on the forEach`);
    return t;
  }
  if (ref.root === "ctx") {
    err(`$ctx is not available yet`);
    return null;
  }
  const t = scope.types.get(ref.root);
  if (!t) {
    err(`$${ref.root} is not an earlier step (refs can only point back)`);
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
    err(`${what} ${raw} is not a list${fields.length ? `; did you mean ${fields.map((f) => `${raw}.${f}`).join(" or ")}?` : ""}`);
    return null;
  }
  return t;
}

function checkField(item: JsonSchema, field: string, what: string, err: (m: string) => void): void {
  if (kindOf(item) !== "object") return;
  const fields = fieldsOf(item);
  if (fields.length && !fields.includes(field)) err(`${what}: items have no field "${field}"; fields: ${fields.join(", ")}`);
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
  try {
    const v = JSON.parse(s);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // fall through
  }
  err(`${what} must be a JSON object string, got ${JSON.stringify(s).slice(0, 80)}`);
  return null;
}

function compileCall(id: string, argsJson: string, registry: Registry, scope: Scope, err: (m: string) => void): Call | null {
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
  const args = parseObject(argsJson, "argsJson", err);
  if (!args) return null;

  // Refs: each must type-check, and its shape must fit the arg it fills.
  const refs = collectRefs(args);
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
    if (have !== "any" && need !== "any" && have !== need) {
      err(
        `${id} arg ${r.at.join(".")} needs a ${need === "scalar" ? "single value" : need}, but ${r.ref} is ${have === "scalar" ? "a single value" : `a ${have}`}`,
      );
      ok = false;
    }
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
      err(`${id} arg ${p || "(args)"}: ${issue.message}`);
      ok = false;
    }
  }
  return ok ? { action, args } : null;
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
