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
  const used = new Set(plan.steps.flatMap((s) => [...s.deps, ...("in" in s ? rootsOf(s.in) : []), ...(s.kind === "exclude" ? [rootOf(s.set)] : [])]));

  for (const r of run.steps) {
    const step = byId.get(r.id)!;
    const line = describe(step, r, registry, used) ?? (used.has(r.id) || r.status !== "done" ? null : found(step, r.output, nounOf(step, byId, registry)));
    if (line) lines.push(line);
  }

  if (run.pending) {
    const p = run.pending;
    const names = [...new Set(p.preview.map((x) => x.label).filter(Boolean))] as string[];
    const actions = [...new Set(p.preview.map((x) => x.name))].join(" + ");
    if (p.blockedCount) {
      lines.push(`Cannot proceed for ${p.blockedCount}: ${p.blocked!.map((b) => `${b.label} (${b.error.message})`).join("; ")}${p.blockedCount > p.blocked!.length ? "; …" : ""}.`);
      lines.push(`Can proceed for ${p.count}: ${actions}${names.length ? ` (${list(names, p.count)})` : ""}. Proceed with only these?`);
    }
    lines.push(
      `${p.changed ? "The records changed since you looked. " : ""}Waiting for your OK: ${actions}, ${p.reason}` +
        (names.length ? ` (${list(names, p.count)})` : "") +
        ".",
    );
  }
  if (run.clarification) {
    const c = run.clarification;
    lines.push(`More than one ${c.entity} matches "${c.name}": ${c.candidates.map((x) => (x.detail ? `${x.name} (${x.detail})` : x.name)).join(", ")}. ${whichOne(plan, c.stepId)}`);
  }
  return lines.join("\n");
}

/** "Which one is the contact that stays?" when the name fills an argument named for its role (a merge's keepId). */
function whichOne(plan: CompiledPlan, stepId: string): string {
  for (const s of plan.steps) {
    for (const call of s.kind === "action" ? [s.call] : s.kind === "forEach" ? s.calls : []) {
      const key = Object.keys(call.args).find((k) => call.args[k] === `$${stepId}.id` && call.action.idTypes?.[k]);
      const role = key && ((call.action.inputSchema.properties ?? {}) as Record<string, { description?: string }>)[key]?.description;
      if (role) return `Which one is ${role}?`;
    }
  }
  return "Which one?";
}

/** Records the reply talks about, sent with it so the client can show them as cards rather than a sentence. */
export type Shown = {
  noun: string;
  /** What the cards are, e.g. "Found 12 leads matching status new". */
  heading: string;
  total: number;
  items: Record<string, unknown>[];
  /** The reply line these cards say again in full; the client shows the cards in its place. */
  replaces?: string;
};
const SHOWN_MAX = 25;

/** The records behind the reply's text: what each answering read returned, and the record each write produced. */
export function shownRecords(plan: CompiledPlan, run: RunResult, registry: Registry): Shown[] {
  const byId = new Map(plan.steps.map((s) => [s.id, s]));
  const used = new Set(plan.steps.flatMap((s) => [...s.deps, ...("in" in s ? (Array.isArray(s.in) ? s.in : [s.in]).map(rootOf) : []), ...(s.kind === "exclude" ? [rootOf(s.set)] : [])]));
  const out: Shown[] = [];
  const add = (noun: string, heading: string, total: number, items: unknown[], replaces?: string | null) => {
    const rows = items.filter(isRecord).slice(0, SHOWN_MAX);
    if (rows.length) out.push({ noun, heading, total, items: rows, ...(replaces ? { replaces } : {}) });
  };
  for (const r of run.steps) {
    const step = byId.get(r.id)!;
    if (r.status !== "done") continue;
    if (step.kind === "action" && step.call.action.risk !== "read") {
      const noun = actionNoun(step.call.action.id, registry);
      if (isRecord(r.output)) add(noun, cap(noun), 1, [r.output]);
      continue;
    }
    if (used.has(r.id) || step.kind === "resolve") continue;
    if (step.kind === "forEach") {
      const read = step.calls.find((c) => c.action.risk === "read");
      if (!r.items || step.calls.some((c) => c.action.risk !== "read") || !read) continue;
      const noun = actionNoun(read.action.id, registry);
      for (const i of r.items) {
        const who = i.label ?? (ID.test(i.key) ? null : i.key);
        if (i.results?.length) add(noun, who ?? `${i.results.length} ${plural(noun, i.results.length)}`, i.results.length, i.results, itemLine(i));
      }
      continue;
    }
    const noun = nounOf(step, byId, registry);
    const items = Array.isArray(r.output) ? r.output : isList(r.output) ? r.output.items : null;
    const line = found(step, r.output, noun);
    if (items) {
      const total = isList(r.output) ? r.output.total : items.length;
      add(noun, `Found ${total} ${plural(noun, total)}${criteria(step)}`, total, items, line);
    } else if (isRecord(r.output)) add(noun, cap(noun), 1, [r.output], line);
  }
  return out;
}

function describe(step: CStep, r: StepResult, registry: Registry, used: Set<string>): string | null {
  if (r.status === "awaiting_confirmation" || r.status === "needs_clarification") return null;
  if (r.status === "skipped") return `Skipped ${what(step, registry)}: ${r.error?.code === "NOT_RUN" ? r.error.message : "an earlier step didn't complete"}.`;
  if (r.status === "failed" && !r.items) return `Couldn't ${what(step, registry)}: ${r.error!.message}.`;

  if (step.kind === "action") {
    const a = step.call.action;
    if (a.risk === "read") return null; // reads only matter through what they feed
    const name = titleOf(r.output);
    if (r.existing) return `Used the existing ${name ? `"${name}"` : "record"} (${(r.output as { id?: string }).id}) rather than ${a.name.toLowerCase()} again: ${r.existing.message}.`;
    const caveat = r.output === undefined ? undefined : a.caveat?.(r.output);
    return `Done: ${a.name}${name ? ` (${name})` : ""}${r.items?.[0]?.replayed ? ", already done earlier" : ""}${caveat ? `, but ${caveat}` : ""}.`;
  }
  if (step.kind === "forEach" && r.items) {
    const writes = step.calls.filter((c) => c.action.risk !== "read");
    if (writes.length === 0) return used.has(r.id) ? null : eachRead(r.items);
    const actions = writes.map((c) => c.action.name).join(" + ");
    const ok = r.items.filter((i) => i.status === "done");
    const bad = r.items.filter((i) => i.status === "failed");
    const names = (xs: typeof ok) => xs.map((i) => i.label ?? i.key);
    const out: string[] = [];
    if (r.items.length === 0) return `${actions}: nothing matched, so nothing was changed.`;
    if (ok.length) out.push(`${actions} for ${ok.length} of ${r.items.length}: ${list(names(ok), ok.length)}.`);
    // A write that recorded its outcome as a failure (a bounced email, a failed sync) is not a plain success.
    const caveats = ok.flatMap((i) => step.calls.flatMap((c, n) => (c.action.risk !== "read" && c.action.caveat?.(i.results?.[n]) ? [`${i.label ?? i.key} (${c.action.caveat(i.results?.[n])})`] : [])));
    if (caveats.length) out.push(`But ${caveats.length} of those did not go through: ${caveats.slice(0, NAMES_MAX).join("; ")}${caveats.length > NAMES_MAX ? "; …" : ""}.`);
    if (bad.length) out.push(`Failed for ${bad.length}: ${bad.slice(0, NAMES_MAX).map((i) => `${i.label ?? i.key} (${i.error!.message})`).join("; ")}${bad.length > NAMES_MAX ? "; …" : ""}.`);
    return out.join(" ");
  }
  return null;
}

/** A loop of reads nothing else consumed: what each item looked up is the answer. */
function eachRead(items: NonNullable<StepResult["items"]>): string {
  if (items.length === 0) return "Nothing matched, so there was nothing to look up.";
  const lines = items.slice(0, NAMES_MAX).map(itemLine);
  if (items.length > NAMES_MAX) lines.push(`…and ${items.length - NAMES_MAX} more.`);
  return lines.join("\n");
}

/** One looked-up item's line in a loop of reads. */
function itemLine(i: NonNullable<StepResult["items"]>[number]): string {
  const who = i.label ?? (ID.test(i.key) ? null : i.key);
  const prefix = who ? `${who}: ` : "";
  if (i.status === "failed") return `${prefix}couldn't look up (${i.error!.message}).`;
  return `${prefix}${(i.results ?? []).map((x) => record(x)).filter(Boolean).join("; ") || "nothing found"}.`;
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
    .filter(([k, v]) => k !== titleKey(o) && k !== "id" && !/Ids?$/.test(k) && !QUIET.has(k) && (shown(v) || named(v)) && !(typeof v === "string" && ID.test(v)) && !(Array.isArray(v) && v.some((x) => typeof x === "string" && ID.test(x))))
    .slice(0, FIELDS_MAX)
    .map(([k, v]) => `${words(k)} ${named(v) ? nested(v) : Array.isArray(v) ? v.join(", ") : String(v)}`);
  const title = titleOf(o);
  const head = title ? `${title}${noun ? ` (${noun})` : ""}` : noun ? cap(noun) : "";
  return [head, fields.join(", ")].filter(Boolean).join(fields.length && head ? ": " : "");
}

/** A record's own list of named parts, such as a pipeline's stages: "New (probability 10); Negotiation (probability 75)". */
function nested(v: Record<string, unknown>[]): string {
  const parts = v.slice(0, NAMES_MAX).map((o) => {
    const plain = Object.entries(o).filter(([k, x]) => k !== titleKey(o) && k !== "id" && !k.endsWith("Id") && (typeof x === "string" || typeof x === "number") && !(typeof x === "string" && ID.test(x)));
    return plain.length ? `${titleOf(o)} (${plain.slice(0, 2).map(([k, x]) => `${words(k)} ${x}`).join(", ")})` : titleOf(o)!;
  });
  return v.length > parts.length ? `${parts.join("; ")}; and ${v.length - parts.length} more` : parts.join("; ");
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
    // A record id names nothing a user knows, whether passed by $ref or written out ("contact id ct_35").
    .filter(([k, v]) => k !== "limit" && !/Ids?$/.test(k) && shown(v) && !(typeof v === "string" && parseRef(v)))
    .map(([k, v]) => `${words(k)} ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  return parts.length ? ` matching ${parts.join(", ")}` : "";
}

/** The record type a step returns: the action's own, or for filter/exclude, the type of what it read from. */
function nounOf(step: CStep, byId: Map<string, CStep>, registry: Registry): string {
  if (step.kind === "action") return actionNoun(step.call.action.id, registry);
  if (step.kind === "filter" || step.kind === "exclude") {
    const src = byId.get(rootOf(step.in));
    return src && src !== step ? nounOf(src, byId, registry) : "result";
  }
  return "result";
}

/** Few actions declare what they return; the rest return their module's record type. */
function actionNoun(id: string, registry: Registry): string {
  const mod = id.slice(0, 3);
  return registry.get(id)?.entities?.produces ?? registry.list().find((a) => a.id.startsWith(mod) && a.entities?.produces)?.entities?.produces ?? "result";
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
const isRecord = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x) && !isList(x);
const isList = (x: unknown): x is { items: unknown[]; total: number } =>
  !!x && typeof x === "object" && Array.isArray((x as { items?: unknown }).items) && typeof (x as { total?: unknown }).total === "number";
const shown = (v: unknown) =>
  v !== null && v !== undefined && v !== "" && (typeof v !== "object" || (Array.isArray(v) && v.length > 0 && v.every((e) => typeof e !== "object")));
/** A list of records that each have a name, e.g. a pipeline's stages. */
const named = (v: unknown): v is Record<string, unknown>[] =>
  Array.isArray(v) && v.length > 0 && v.every((e) => !!e && typeof e === "object" && !Array.isArray(e) && !!titleOf(e as Record<string, unknown>));
const rootOf = (ref: string) => parseRef(ref)?.root ?? ref.replace(/^\$/, "").split(/[.[]/)[0]!;
const rootsOf = (v: string | string[]) => (Array.isArray(v) ? [] : [rootOf(v)]);
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

const RECORDS_MAX = 8;

/**
 * The records a run created, changed or found, with their ids, for the next turn's <context>: the reply the user
 * reads leaves ids out, but "give it to Aisha" needs the id of the task just made. Undefined when there are none.
 */
export function touchedRecords(plan: CompiledPlan, run: RunResult): string | undefined {
  const byId = new Map(plan.steps.map((s) => [s.id, s]));
  const out = new Map<string, string>();
  const add = (x: unknown, noun: string) => {
    const o = x && typeof x === "object" ? (x as Record<string, unknown>) : undefined;
    if (!o || typeof o.id !== "string" || out.has(o.id)) return;
    const title = titleOf(o);
    out.set(o.id, `${noun} ${o.id}${title ? ` ${JSON.stringify(title)}` : ""}${typeof o.status === "string" ? ` (${o.status})` : ""}`);
  };
  const addAll = (v: unknown, noun: string) => {
    const items = v && typeof v === "object" && Array.isArray((v as { items?: unknown }).items) ? (v as { items: unknown[] }).items : [v];
    items.forEach((x) => add(x, noun));
  };
  for (const r of run.steps) {
    const step = byId.get(r.id);
    if (!step || r.output === undefined) continue;
    if (step.kind === "resolve") add(r.output, step.entity);
    else if (step.kind === "action") addAll(r.output, step.call.action.entities?.produces ?? "record");
    else if (step.kind === "forEach")
      for (const each of r.output as { results?: unknown[] }[]) (each.results ?? []).forEach((x, i) => addAll(x, step.calls[i]?.action.entities?.produces ?? "record"));
  }
  const all = [...out.values()];
  return all.length ? `${all.slice(0, RECORDS_MAX).join("; ")}${all.length > RECORDS_MAX ? `; and ${all.length - RECORDS_MAX} more` : ""}` : undefined;
}
