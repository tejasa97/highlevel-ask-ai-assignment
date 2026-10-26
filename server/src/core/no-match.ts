import type { CompiledPlan } from "./compile.js";
import type { RunResult } from "./execute.js";
import { parseRef, substitute, valueAt } from "./refs.js";

/** Only a genuine lookup miss, before any attempted write, can safely get a fresh plan. Empty successful
 * reads remain valid answers. A failed reference must identify the empty list, not merely share a plan
 * with an empty search. Confirmation resumes never use this recovery path. */
export function runtimeNoMatch(plan: CompiledPlan, run: RunResult): string | undefined {
  return noMatch(plan, run)?.text;
}

/** The search that found nothing, as {action, args}, so a retry that runs it again unchanged can be refused. */
export function emptyRead(plan: CompiledPlan, run: RunResult): { action: string; args: unknown } | undefined {
  return noMatch(plan, run)?.read;
}

function noMatch(plan: CompiledPlan, run: RunResult): { text: string; read?: { action: string; args: unknown } } | undefined {
  if (run.writesAttempted !== false) return;
  const outputs = new Map(run.steps.map((s) => [s.id, s.output]));
  if (run.status === "done") return emptyLoop(plan, run, outputs);
  if (run.status !== "failed" && run.status !== "partial") return;
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
    if (source.kind === "resolve") return { text: `Step ${source.id} (resolve ${source.entity}) looked for ${JSON.stringify(source.name)} and found nothing.${found(plan, run, source.name)} No write ran. Revise the plan using this fact.` };
    if (source.kind !== "action" || source.call.action.risk !== "read") continue;
    try {
      const args = substitute(source.call.args, (ref) => valueAt(outputs.get(ref.root), ref.path, `$${ref.root}`));
      return {
        text: `Step ${source.id} (${source.call.action.id}) searched/looked up ${JSON.stringify(args)} and found nothing (0 items).${found(plan, run)} No write ran. Revise the plan using this fact.`,
        read: { action: source.call.action.id, args },
      };
    } catch { /* Can't prove what was searched; do not replan. */ }
  }
}

/** What the run's other reads did find, so the next plan builds on them rather than concluding nothing
 * exists: "Archive every contact at Wayne" finds no company record named Wayne, but its contact search
 * matched five contacts whose company field says Wayne. */
function found(plan: CompiledPlan, run: RunResult, name?: string): string {
  const facts: string[] = [];
  for (const step of run.steps) {
    const source = plan.steps.find((s) => s.id === step.id);
    if (step.status !== "done" || source?.kind !== "action" || source.call.action.risk !== "read") continue;
    const out = step.output as { items?: unknown } | unknown[] | undefined;
    const items = Array.isArray(out) ? out : Array.isArray(out?.items) ? out.items : undefined;
    if (!items?.length) continue;
    const fields = name ? [...new Set(items.flatMap((item) => Object.entries(item as Record<string, unknown>)
      .filter(([k, v]) => k !== "id" && typeof v === "string" && v.toLowerCase().includes(name.toLowerCase())).map(([k]) => k)))] : [];
    facts.push(` Step ${source.id} (${source.call.action.id}) did find ${items.length} item${items.length === 1 ? "" : "s"}` +
      (fields.length ? ` whose ${fields.join("/")} contains ${JSON.stringify(name)}.` : "."));
  }
  return facts.join("");
}

/** A write loop that ran over nothing because a search it builds on found nothing: "Archive every contact at Wayne"
 * searched companies for Wayne, found none, and archived nobody, though five contacts' company field says Wayne. A
 * filter that leaves nothing of what a search did find is a real "nothing matched" and isn't reported here. */
function emptyLoop(plan: CompiledPlan, run: RunResult, outputs: Map<string, unknown>): { text: string; read: { action: string; args: unknown } } | undefined {
  const byId = new Map(plan.steps.map((s) => [s.id, s]));
  for (const loop of plan.steps) {
    if (loop.kind !== "forEach" || loop.calls.every((c) => c.action.risk === "read")) continue;
    if (run.steps.find((s) => s.id === loop.id)?.items?.length !== 0) continue;
    const seen = new Set<string>();
    const queue = [...loop.deps];
    for (let id = queue.shift(); id; id = queue.shift()) {
      const source = byId.get(id);
      if (!source || seen.has(id)) continue;
      seen.add(id);
      queue.push(...source.deps);
      if (source.kind !== "action" || source.call.action.risk !== "read") continue;
      const out = outputs.get(id) as { items?: unknown } | undefined;
      if (!Array.isArray(out?.items) || out.items.length) continue;
      try {
        const args = substitute(source.call.args, (ref) => valueAt(outputs.get(ref.root), ref.path, `$${ref.root}`));
        return {
          text: `Step ${source.id} (${source.call.action.id}) searched ${JSON.stringify(args)} and found nothing (0 items), so step ${loop.id} (${loop.calls.map((c) => c.action.id).join(", ")}) ran over nothing.${found(plan, run)} No write ran. Revise the plan using this fact, or reply with type answer if nothing should match.`,
          read: { action: source.call.action.id, args },
        };
      } catch { /* Can't prove what was searched; do not replan. */ }
    }
  }
}
