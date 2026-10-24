import type { CompiledPlan } from "../core/compile.js";
import { parseRef, valueAt } from "../core/refs.js";
import type { Candidate, RegisteredAction, Registry } from "../registry/registry.js";
import type { Store } from "../store/db.js";
import type { SubmitPlan } from "./submit-plan.js";

export type Outcome = NonNullable<SubmitPlan["outcome"]>;

/** Checks declared task coverage, not the truth of the model's interpretation of the request. */
export function outcomeErrors(plan: CompiledPlan, outcome?: Outcome, request?: { message: string; offered: RegisteredAction[] }): string[] {
  if (!outcome) return []; // historical saved replies predate the contract
  const calls = plan.steps.flatMap((s) => s.kind === "action" ? [s.call.action] : s.kind === "forEach" ? s.calls.map((c) => c.action) : []);
  const ids = new Set(calls.map((a) => a.id));
  const errors = outcome.actions.filter((id) => !ids.has(id)).map((id) => `requested operation ${id} is missing; prerequisite reads do not complete it`);
  if (outcome.effect === "change" && !calls.some((a) => a.risk !== "read")) errors.push("the requested outcome changes records, but this plan only reads; use look for prerequisites, then plan the final change");
  if (outcome.effect === "change" && !outcome.actions.length) errors.push("identify the final requested action(s), using search_tools if needed, before returning a plan");
  if (outcome.effect === "read" && calls.some((a) => a.risk !== "read" && !a.query)) errors.push("the requested outcome is read-only; do not introduce a change");
  if (outcome.destination) for (const a of calls) {
    if (a.destination && a.destination.id !== outcome.destination) errors.push(`${a.id} delivers to ${a.destination.label}, not the requested destination ${outcome.destination}`);
  }
  if (request && (outcome.destination || (SEND.test(request.message) && !HOLD.test(request.message))) && !calls.some((a) => a.destination)) {
    // "Send a review request" planned as only creating one: the record exists, but nothing went out.
    for (const a of calls) {
      const made = a.risk === "read" ? undefined : a.entities?.produces;
      const sender = made && request.offered.find((o) => o.destination && !ids.has(o.id) && o.entities?.consumes?.includes(made));
      // Calls in one forEach "do" can't see each other's output, so the send must loop over the create step's results.
      if (sender) errors.push(`${a.id} only creates the ${made.replace(/_/g, " ")}; the request asks to send it, which is ${sender.id} (${sender.name}). `
        + `Send what was created: after a forEach that creates them (say s3), add a forEach over "$s3" calling ${sender.id} with the new ID "$item.results[0].id"; for a single create, use "$s3.id"`);
    }
  }
  return [...new Set(errors)];
}

const SEND = /\bsend\b/i;
const HOLD = /\b(don'?t|do not|not|without|never|before|later|until)\b.{0,20}\bsend/i;

/**
 * A change that loops over a list the look round already found empty would end "done" with nothing changed.
 * Only direct references to a looked step count: a filter between them may make the list longer or shorter.
 */
export function emptyTargets(plan: CompiledPlan, looked: { id: string; output?: unknown; error?: string }[]): { step: string; list: string }[] {
  const byId = new Map(looked.filter((l) => !l.error && l.output !== undefined).map((l) => [l.id, l.output]));
  const out: { step: string; list: string }[] = [];
  for (const step of plan.steps) {
    if (step.kind !== "forEach" || step.calls.every((c) => c.action.risk === "read")) continue;
    const ref = parseRef(step.in);
    if (!ref || !byId.has(ref.root)) continue;
    try {
      const list = valueAt(byId.get(ref.root), ref.path, ref.root);
      if (Array.isArray(list) && list.length === 0) out.push({ step: step.id, list: step.in });
    } catch { /* A path the look result doesn't have is the compiler's and executor's to report. */ }
  }
  return out;
}

/** Bounded, read-only identity check. Qualifiers are validated, never silently dropped. */
export function checkIdentity(lookup: NonNullable<SubmitPlan["lookup"]>, registry: Registry, store: Store): { count: number; digest: string; options?: string[]; match?: Candidate } {
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
    match: candidates.length === 1 ? candidates[0] : undefined,
    digest: JSON.stringify({ entity: lookup.entity, name: lookup.name, where, count: candidates.length, candidates: candidates.slice(0, 8), truncated: candidates.length > 8 }),
    options: candidates.length <= 8 ? labels.map((label, n) => labels.filter((l) => l === label).length > 1 ? `${label} (${candidates[n]!.id})` : label) : undefined,
  };
}
