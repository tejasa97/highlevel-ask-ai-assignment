import type { CompiledPlan } from "./compile.js";
import type { RunResult } from "./execute.js";
import { parseRef, substitute, valueAt } from "./refs.js";

/** Only a genuine lookup miss, before any attempted write, can safely get a fresh plan. Empty successful
 * reads remain valid answers. A failed reference must identify the empty list, not merely share a plan
 * with an empty search. Confirmation resumes never use this recovery path. */
export function runtimeNoMatch(plan: CompiledPlan, run: RunResult): string | undefined {
  if (run.writesAttempted !== false || !["failed", "partial"].includes(run.status)) return;
  const outputs = new Map(run.steps.map((s) => [s.id, s.output]));
  for (const failed of run.steps.filter((s) => s.status === "failed")) {
    let source = plan.steps.find((s) => s.id === failed.id);
    if (failed.error?.code !== "NOT_FOUND") {
      if (failed.error?.code !== "INVALID") continue;
      const empty = /(\$[A-Za-z_]\w*(?:\.[A-Za-z_]\w*|\[\*\]|\[\d+\])*) has 0 items/.exec(failed.error.message);
      if (!empty) continue;
      const ref = parseRef(empty[1]!);
      if (!ref) continue;
      source = plan.steps.find((s) => s.id === ref.root);
      try {
        const value = valueAt(outputs.get(ref.root), ref.path, `$${ref.root}`);
        if (!Array.isArray(value) || value.length) continue;
      } catch { continue; }
    }
    if (!source) continue;
    if (source.kind === "resolve") return `Step ${source.id} (resolve ${source.entity}) looked for ${JSON.stringify(source.name)} and found nothing. No write ran. Revise the plan using this fact.`;
    if (source.kind !== "action" || source.call.action.risk !== "read") continue;
    try {
      const args = substitute(source.call.args, (ref) => valueAt(outputs.get(ref.root), ref.path, `$${ref.root}`));
      return `Step ${source.id} (${source.call.action.id}) searched/looked up ${JSON.stringify(args)} and found nothing (0 items). No write ran. Revise the plan using this fact.`;
    } catch { /* Can't prove what was searched; do not replan. */ }
  }
}
