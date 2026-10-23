import type { CompiledPlan } from "../core/compile.js";
import type { RunResult } from "../core/execute.js";

export interface WorkingRecord { entity: string; id: string; name: string }
export const MAX_RECORDS = 12;

/** Remember identities actually observed by the executor, never planned IDs or raw result records. */
export function rememberRecords(previous: WorkingRecord[], plan: CompiledPlan, result: RunResult): WorkingRecord[] {
  const records = [...previous];
  const add = (entity: string, value: unknown) => {
    if (!value || typeof value !== "object") return;
    const row = value as Record<string, unknown>;
    const name = row.name ?? row.title ?? row.label ?? row.code;
    if (typeof row.id !== "string" || typeof name !== "string") return;
    const old = records.findIndex((r) => r.entity === entity && r.id === row.id);
    if (old >= 0) records.splice(old, 1);
    records.push({ entity, id: row.id, name: name.slice(0, 240) });
  };
  for (const step of result.steps) {
    if (step.status !== "done") continue;
    const compiled = plan.steps.find((s) => s.id === step.id);
    if (compiled?.kind === "resolve") add(compiled.entity, step.output);
    if (compiled?.kind !== "action" || !compiled.call.action.entities?.produces) continue;
    const entity = compiled.call.action.entities.produces;
    const out = step.output as { items?: unknown[] } | undefined;
    if (Array.isArray(out?.items)) for (const item of out.items.slice(0, MAX_RECORDS)) add(entity, item);
    else add(entity, step.output);
  }
  return records.slice(-MAX_RECORDS);
}
