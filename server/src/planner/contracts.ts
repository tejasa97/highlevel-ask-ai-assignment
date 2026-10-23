import type { CompiledPlan } from "../core/compile.js";
import type { Registry } from "../registry/registry.js";
import type { Store } from "../store/db.js";
import type { SubmitPlan } from "./submit-plan.js";

export type Outcome = NonNullable<SubmitPlan["outcome"]>;

/** Checks declared task coverage, not the truth of the model's interpretation of the request. */
export function outcomeErrors(plan: CompiledPlan, outcome?: Outcome): string[] {
  if (!outcome) return []; // historical saved replies predate the contract
  const calls = plan.steps.flatMap((s) => s.kind === "action" ? [s.call.action] : s.kind === "forEach" ? s.calls.map((c) => c.action) : []);
  const ids = new Set(calls.map((a) => a.id));
  const errors = outcome.actions.filter((id) => !ids.has(id)).map((id) => `requested operation ${id} is missing; prerequisite reads do not complete it`);
  if (outcome.effect === "change" && !calls.some((a) => a.risk !== "read")) errors.push("the requested outcome changes records, but this plan only reads; use look for prerequisites, then plan the final change");
  if (outcome.effect === "change" && !outcome.actions.length) errors.push("identify the final requested action(s), using search_tools if needed, before returning a plan");
  if (outcome.effect === "read" && calls.some((a) => a.risk !== "read")) errors.push("the requested outcome is read-only; do not introduce a change");
  if (outcome.destination) for (const a of calls) {
    if (a.destination && a.destination.id !== outcome.destination) errors.push(`${a.id} delivers to ${a.destination.label}, not the requested destination ${outcome.destination}`);
  }
  return errors;
}

/** Bounded, read-only identity check. Qualifiers are validated, never silently dropped. */
export function checkIdentity(lookup: NonNullable<SubmitPlan["lookup"]>, registry: Registry, store: Store): { count: number; digest: string; options?: string[] } {
  if (!lookup.name.trim()) throw new Error("Give a nonempty name for identity lookup");
  const resolver = registry.resolver(lookup.entity);
  if (!resolver) throw new Error(`No resolver for ${lookup.entity}; use read-only discovery instead`);
  const where = lookup.whereJson ? JSON.parse(lookup.whereJson) as unknown : {};
  if (!where || typeof where !== "object" || Array.isArray(where) || Object.values(where).some((v) => typeof v !== "string" || !v.trim())) throw new Error("lookup whereJson must be an object of nonempty string qualifiers");
  for (const key of Object.keys(where)) if (!resolver.qualifiers?.includes(key)) throw new Error(`Unknown ${lookup.entity} qualifier: ${key}`);
  const candidates = resolver(store, lookup.name, where as Record<string, string>);
  const labels = candidates.map((c) => `${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  return {
    count: candidates.length,
    digest: JSON.stringify({ entity: lookup.entity, name: lookup.name, where, count: candidates.length, candidates: candidates.slice(0, 8), truncated: candidates.length > 8 }),
    options: candidates.length <= 8 ? labels.map((label, n) => labels.filter((l) => l === label).length > 1 ? `${label} (${candidates[n]!.id})` : label) : undefined,
  };
}
