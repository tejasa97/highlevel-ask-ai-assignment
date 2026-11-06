import type { ActionContext } from "../registry/define.js";
import { invoke } from "../registry/invoke.js";
import type { Registry } from "../registry/registry.js";
import type { SubmitPlan } from "../planner/submit-plan.js";
import { compile, type CompiledPlan } from "./compile.js";
import { fieldOf, type RunResult } from "./execute.js";

// A follow-up that narrows or amends what the last turn made ("only the Facebook ones, and make those tasks due
// tomorrow") is planned as the whole request again, with its new terms. The planner never writes the difference:
// running that plan, each create the last turn already did for the same record (a task for the same lead) edits that
// record instead of making another, the creates it didn't do run as usual, and the records it made that the new plan
// no longer makes are undone afterwards, behind the usual approval.

/** A record a turn made with a create that declares `revise`, as the create returned it. */
export interface Made { entity: string; id: string; action: string; record: Record<string, unknown> }

/** The records this run made with revisable creates: what a follow-up may narrow. */
export function madeBy(plan: CompiledPlan, result: RunResult, registry: Registry): Made[] {
  const made: Made[] = [];
  const add = (id: string, value: unknown) => {
    const a = registry.get(id);
    const entity = a?.entities?.produces;
    if (!a?.revise || !entity || !value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.id === "string" && !made.some((m) => m.id === record.id)) made.push({ entity, id: record.id, action: a.id, record });
  };
  for (const step of result.steps) {
    const s = plan.steps.find((x) => x.id === step.id);
    if (s?.kind === "action" && step.status === "done") add(s.call.action.id, step.output);
    if (s?.kind === "forEach" && Array.isArray(step.output)) {
      for (const item of step.output as { results?: unknown[] }[]) s.calls.forEach((c, i) => add(c.action.id, item.results?.[i]));
    }
  }
  return made;
}

/** Plans that make what the last turn made: a revision when every create of those records can be revised. */
export function revisable(plan: CompiledPlan, made: Made[]): boolean {
  const creates = plan.steps.flatMap((s) => (s.kind === "action" ? [s.call.action] : s.kind === "forEach" ? s.calls.map((c) => c.action) : []))
    .filter((a) => a.risk !== "read" && made.some((m) => m.entity === a.entities?.produces && !(a.entities?.consumes ?? []).includes(m.entity)));
  return creates.length > 0 && creates.every((a) => !!a.revise);
}

/**
 * The executor's hook for creates: one the last turn already did for the same record (same `revise.key`) edits that
 * record, field by field through `revise.edits`, and returns it; any other runs as written. Each made record is
 * claimed once, so two new creates for one lead don't both land on the same task.
 */
export function reviser(made: Made[], registry: Registry): NonNullable<ActionContext["revise"]> {
  const claimed = new Set<string>();
  return (actionId, args, ctx) => {
    // The planner's own undo of a record the last turn made is left to the reconcile after the run.
    const target = made.find((x) => registry.get(x.action)!.revise!.undo === actionId && args[`${x.entity}Id`] === x.id);
    if (target) return { value: target.record };
    const spec = registry.get(actionId)?.revise;
    if (!spec) return undefined;
    const key = fieldOf(args, spec.key);
    const m = key === undefined || key === null ? undefined : made.find((x) => x.action === actionId && !claimed.has(x.id) && fieldOf(x.record, spec.key) === key);
    if (!m) return undefined;
    claimed.add(m.id);
    const byAction = new Map<string, Record<string, unknown>>();
    for (const [field, edit] of Object.entries(spec.edits)) {
      if (args[field] === undefined || JSON.stringify(args[field]) === JSON.stringify(m.record[field])) continue;
      byAction.set(edit, { ...byAction.get(edit), [field]: args[field] });
    }
    let record: unknown = m.record;
    for (const [edit, fields] of byAction) record = invoke(registry.get(edit)!, { [`${m.entity}Id`]: m.id, ...fields }, ctx);
    return { value: record };
  };
}

/** The made records this run's revision didn't keep: every one no create returned. */
export function leftOut(made: Made[], plan: CompiledPlan, result: RunResult, registry: Registry): Made[] {
  const kept = new Set(madeBy(plan, result, registry).map((m) => m.id));
  return made.filter((m) => !kept.has(m.id));
}

/** One loop per kind of record, undoing those left out (a cancel pauses for approval like any other). */
export function undoPlan(left: Made[], registry: Registry): CompiledPlan | undefined {
  if (!left.length) return undefined;
  const steps: NonNullable<SubmitPlan["steps"]> = [];
  for (const action of [...new Set(left.map((m) => m.action))]) {
    const undo = registry.get(registry.get(action)!.revise!.undo)!;
    const mine = left.filter((m) => m.action === action);
    const shape = (undo.input as { shape?: Record<string, unknown> }).shape ?? {};
    const args = { [`${mine[0]!.entity}Id`]: "$item", ...("reason" in shape ? { reason: "No longer part of the request" } : {}) };
    steps.push({ id: `undo${steps.length + 1}`, kind: "op", op: "forEach", in: mine.map((m) => m.id), whereJson: null, by: null, set: null, roundRobin: null, do: [{ action: undo.id, argsJson: JSON.stringify(args) }] } as NonNullable<SubmitPlan["steps"]>[number]);
  }
  const compiled = compile({ type: "plan", steps, question: null, options: null, reason: null, alternatives: null, query: null, text: null }, registry);
  if (!compiled.ok) throw new Error(`undo plan did not compile: ${compiled.errors.join("; ")}`);
  return compiled.plan;
}
