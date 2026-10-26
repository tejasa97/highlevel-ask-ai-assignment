import type { CompiledPlan } from "../core/compile.js";
import type { RunResult } from "../core/execute.js";
import type { RegisteredAction } from "../registry/registry.js";

/** `for` is the record this one belongs to (a task's lead, an invoice's contact), so a follow-up can tell them apart. */
export interface WorkingRecord { entity: string; id: string; name: string; for?: string }
export const MAX_RECORDS = 12;

/** Remember identities actually observed by the executor, never planned IDs or raw result records. */
export function rememberRecords(previous: WorkingRecord[], plan: CompiledPlan, result: RunResult): WorkingRecord[] {
  const records = [...previous];
  const add = (entity: string, value: unknown) => {
    if (!value || typeof value !== "object") return;
    const row = value as Record<string, unknown>;
    // Quotes, orders and invoices go by their number, messages by their subject; a subscription or enrollment by what it is.
    const name = row.name ?? row.title ?? row.label ?? row.code ?? row.number ?? row.subject ?? (typeof row.contactId === "string" ? entity : undefined);
    if (typeof row.id !== "string" || typeof name !== "string") return;
    const old = records.findIndex((r) => r.entity === entity && r.id === row.id);
    if (old >= 0) records.splice(old, 1);
    const related = row.relatedTo as { id?: unknown } | undefined;
    const owner = [related?.id, row.leadId, row.contactId].find((v): v is string => typeof v === "string");
    records.push({ entity, id: row.id, name: name.slice(0, 240), ...(owner ? { for: owner } : {}) });
  };
  for (const step of result.steps) {
    const compiled = plan.steps.find((s) => s.id === step.id);
    // A loop's writes are the records a follow-up most often amends ("make those tasks due tomorrow"); its reads aren't
    // kept, so a long loop doesn't crowd them out. A loop where some items failed still made the others.
    if (compiled?.kind === "forEach" && (step.status === "done" || step.status === "partial") && Array.isArray(step.output)) {
      for (const each of step.output as { results?: unknown[] }[]) {
        compiled.calls.forEach((c, i) => {
          const entity = c.action.risk === "read" ? undefined : produced(c.action);
          if (entity) add(entity, each.results?.[i]);
        });
      }
      continue;
    }
    if (step.status !== "done") continue;
    if (compiled?.kind === "resolve") add(compiled.entity, step.output);
    if (compiled?.kind !== "action") continue;
    const entity = produced(compiled.call.action);
    if (!entity) continue;
    const out = step.output as { items?: unknown[] } | undefined;
    if (Array.isArray(out?.items)) for (const item of out.items.slice(0, MAX_RECORDS)) add(entity, item);
    else add(entity, step.output);
  }
  return records.slice(-MAX_RECORDS);
}

/** What an action's output is a record of: what it declares, or for a "Get …" read of one record type, that type. */
function produced(action: RegisteredAction): string | undefined {
  const { produces, consumes = [] } = action.entities ?? {};
  if (produces) return produces;
  return action.risk === "read" && /^Get\b/.test(action.name) && consumes.length === 1 ? consumes[0] : undefined;
}
