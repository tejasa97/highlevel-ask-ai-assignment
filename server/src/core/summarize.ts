import type { Registry } from "../registry/registry.js";
import type { CompiledPlan, CStep } from "./compile.js";
import type { RunResult, StepResult } from "./execute.js";
import { parseRef } from "./refs.js";

// The reply the user reads. Written by code from the run result, not by the model:
// no second LLM call, and nothing in it can be a hallucinated success.
// Reads that feed a later step stay quiet; a read nothing else uses is the answer, so its result is shown.

const NAMES_MAX = 5;
const FIELDS_MAX = 6;
/** Fields that say little to a reader; ids are kept out too. */
const QUIET = new Set(["firstName", "lastName", "createdAt", "updatedAt"]);
/** Record ids look like `ct_31`; they mean nothing to the person asking. */
const ID = /^[a-z]{2,4}_\d+$/;

export function summarize(plan: CompiledPlan, run: RunResult, registry: Registry): string {
  const byId = new Map(plan.steps.map((s) => [s.id, s]));
  const lines: string[] = [];
  const used = new Set(plan.steps.flatMap((s) => [...s.deps, ...("in" in s ? [rootOf(s.in)] : []), ...(s.kind === "exclude" ? [rootOf(s.set)] : [])]));

  for (const r of run.steps) {
    const step = byId.get(r.id)!;
    const line = describe(step, r, registry) ?? (used.has(r.id) || r.status !== "done" ? null : found(step, r.output, nounOf(step, byId, registry)));
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
    const name = titleOf(r.output);
    const caveat = r.output === undefined ? undefined : a.caveat?.(r.output);
    return `Done: ${a.name}${name ? ` (${name})` : ""}${r.items?.[0]?.replayed ? ", already done earlier" : ""}${caveat ? `, but ${caveat}` : ""}.`;
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

/** What a read returned, for a step nothing else consumed. */
function found(step: CStep, output: unknown, noun: string): string | null {
  if (step.kind === "forEach" || step.kind === "resolve") return null;
  const items = Array.isArray(output) ? output : isList(output) ? output.items : null;
  if (items) {
    const total = isList(output) ? output.total : items.length;
    if (total === 0) return `No ${plural(noun, 0)} found${criteria(step)}.`;
    if (items.length === 1 && total === 1) return `Found 1 ${noun}: ${record(items[0])}.`;
    const names = items.map((x) => brief(x));
    // Two records with the same name read as one; tell them apart by their first plain detail.
    const twice = new Set(names.filter((n, i) => names.indexOf(n) !== i));
    names.forEach((n, i) => {
      const d = detail(items[i]);
      if (twice.has(n) && d) names[i] = n.replace(/( \(|$)/, (m) => `, ${d}${m}`);
    });
    return `Found ${total} ${plural(noun, total)}${criteria(step)}: ${list(names, total)}.`;
  }
  if (output && typeof output === "object") return `${record(output, noun)}.`;
  return output === undefined ? null : `${cap(noun)}: ${String(output)}.`;
}

/** One record in full: its name, then its plain fields. */
function record(x: unknown, noun?: string): string {
  if (!x || typeof x !== "object") return String(x);
  const o = x as Record<string, unknown>;
  const fields = Object.entries(o)
    .filter(([k, v]) => k !== titleKey(o) && k !== "id" && !k.endsWith("Id") && !QUIET.has(k) && shown(v) && !(typeof v === "string" && ID.test(v)))
    .slice(0, FIELDS_MAX)
    .map(([k, v]) => `${words(k)} ${Array.isArray(v) ? v.join(", ") : String(v)}`);
  const title = titleOf(o);
  const head = title ? `${title}${noun ? ` (${noun})` : ""}` : noun ? cap(noun) : "";
  return [head, fields.join(", ")].filter(Boolean).join(fields.length && head ? ": " : "");
}

/** One record in a list: its name, with its status when it has one. */
function brief(x: unknown): string {
  if (!x || typeof x !== "object") return String(x);
  const o = x as Record<string, unknown>;
  const name = titleOf(o) ?? String(o.id ?? "?");
  return typeof o.status === "string" ? `${name} (${o.status})` : name;
}

/** The literal filters a search ran with, e.g. ` matching status new, source facebook_ads`. */
function criteria(step: CStep): string {
  const args = step.kind === "action" ? step.call.args : step.kind === "filter" ? step.where : {};
  const parts = Object.entries(args)
    .filter(([k, v]) => k !== "limit" && shown(v) && !(typeof v === "string" && parseRef(v)))
    .map(([k, v]) => `${words(k)} ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  return parts.length ? ` matching ${parts.join(", ")}` : "";
}

/** The record type a step returns: the action's own, or for filter/exclude, the type of what it read from. */
function nounOf(step: CStep, byId: Map<string, CStep>, registry: Registry): string {
  if (step.kind === "action") {
    // Few actions declare what they return; the rest return their module's record type.
    const id = step.call.action.id;
    const mod = id.slice(0, 3);
    return registry.get(id)?.entities?.produces ?? registry.list().find((a) => a.id.startsWith(mod) && a.entities?.produces)?.entities?.produces ?? "result";
  }
  if (step.kind === "filter" || step.kind === "exclude") {
    const src = byId.get(rootOf(step.in));
    return src && src !== step ? nounOf(src, byId, registry) : "result";
  }
  return "result";
}

/** The field a record is called by: `name`, `title`, else a `…Name` field such as a conversation's `personName`. */
const titleKey = (x: unknown): string | undefined => {
  const o = x && typeof x === "object" ? (x as Record<string, unknown>) : {};
  const named = (k: string) => typeof o[k] === "string" && o[k] !== "";
  if (named("name")) return "name";
  if (named("title")) return "title";
  return Object.keys(o).find((k) => k.endsWith("Name") && !QUIET.has(k) && named(k));
};
const titleOf = (x: unknown): string | undefined => {
  const k = titleKey(x);
  return k ? ((x as Record<string, string>)[k]) : undefined;
};
const detail = (x: unknown): string => {
  const o = x && typeof x === "object" ? (x as Record<string, unknown>) : {};
  return String(o.email ?? o.phone ?? o.company ?? o.id ?? "");
};
const isList = (x: unknown): x is { items: unknown[]; total: number } =>
  !!x && typeof x === "object" && Array.isArray((x as { items?: unknown }).items) && typeof (x as { total?: unknown }).total === "number";
const shown = (v: unknown) =>
  v !== null && v !== undefined && v !== "" && (typeof v !== "object" || (Array.isArray(v) && v.length > 0 && v.every((e) => typeof e !== "object")));
const rootOf = (ref: string) => parseRef(ref)?.root ?? ref.replace(/^\$/, "").split(/[.[]/)[0]!;
const plural = (noun: string, n: number) => (n === 1 ? noun : noun.endsWith("s") ? noun : noun.endsWith("y") ? `${noun.slice(0, -1)}ies` : `${noun}s`);
const words = (k: string) => k.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

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
  const shown = names.slice(0, NAMES_MAX);
  return total > shown.length ? `${shown.join(", ")} and ${total - shown.length} more` : shown.join(", ");
}
