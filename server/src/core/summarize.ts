import type { Registry } from "../registry/registry.js";
import type { CompiledPlan, CStep } from "./compile.js";
import type { RunResult, StepResult } from "./execute.js";

// The reply the user reads. Written by code from the run result, not by the model:
// no second LLM call, and nothing in it can be a hallucinated success.

const NAMES_MAX = 5;

export function summarize(plan: CompiledPlan, run: RunResult, registry: Registry): string {
  const byId = new Map(plan.steps.map((s) => [s.id, s]));
  const lines: string[] = [];

  for (const r of run.steps) {
    const step = byId.get(r.id)!;
    const line = describe(step, r, registry);
    if (line) lines.push(line);
  }

  if (run.pending) {
    const p = run.pending;
    const names = [...new Set(p.preview.map((x) => x.label).filter(Boolean))] as string[];
    const actions = [...new Set(p.preview.map((x) => x.name))].join(" + ");
    lines.push(
      `${p.changed ? "The records changed since you looked. " : ""}Waiting for your OK: ${actions}, ${p.reason}` +
        (names.length ? ` (${list(names, p.count)})` : "") +
        ".",
    );
  }
  if (run.clarification) {
    const c = run.clarification;
    lines.push(`More than one ${c.entity} matches "${c.name}": ${c.candidates.map((x) => (x.detail ? `${x.name} (${x.detail})` : x.name)).join(", ")}. Which one?`);
  }
  return lines.join("\n");
}

function describe(step: CStep, r: StepResult, registry: Registry): string | null {
  if (r.status === "awaiting_confirmation" || r.status === "needs_clarification") return null;
  if (r.status === "skipped") return `Skipped ${what(step, registry)}: an earlier step didn't complete.`;
  if (r.status === "failed" && !r.items) return `Couldn't ${what(step, registry)}: ${r.error!.message}.`;

  if (step.kind === "action") {
    const a = step.call.action;
    if (a.risk === "read") return null; // reads only matter through what they feed
    return `Done: ${a.name}${r.items?.[0]?.replayed ? " (already done earlier)" : ""}.`;
  }
  if (step.kind === "forEach" && r.items) {
    const writes = step.calls.filter((c) => c.action.risk !== "read");
    if (writes.length === 0) return null;
    const actions = writes.map((c) => c.action.name).join(" + ");
    const ok = r.items.filter((i) => i.status === "done");
    const bad = r.items.filter((i) => i.status === "failed");
    const names = (xs: typeof ok) => xs.map((i) => i.label ?? i.key);
    const out: string[] = [];
    if (r.items.length === 0) return `${actions}: nothing matched, so nothing was changed.`;
    if (ok.length) out.push(`${actions} for ${ok.length} of ${r.items.length}: ${list(names(ok), ok.length)}.`);
    if (bad.length) out.push(`Failed for ${bad.length}: ${bad.slice(0, NAMES_MAX).map((i) => `${i.label ?? i.key} (${i.error!.message})`).join("; ")}${bad.length > NAMES_MAX ? "; …" : ""}.`);
    return out.join(" ");
  }
  return null;
}

function what(step: CStep, registry: Registry): string {
  switch (step.kind) {
    case "action":
      return step.call.action.name.toLowerCase();
    case "resolve":
      return `find ${step.entity} "${step.name}"`;
    case "forEach":
      return step.calls.map((c) => registry.get(c.action.id)!.name.toLowerCase()).join(" + ");
    default:
      return `${step.kind} ${step.in}`;
  }
}

function list(names: string[], total: number): string {
  const shown = names.slice(0, NAMES_MAX).join(", ");
  return total > NAMES_MAX ? `${shown} and ${total - NAMES_MAX} more` : shown;
}
