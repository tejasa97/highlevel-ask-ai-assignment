import type { CompiledPlan } from "../core/compile.js";
import { fieldOf, matches } from "../core/execute.js";
import { parseRef, type Ref, substitute, valueAt } from "../core/refs.js";
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
  // A destination says where a record would go, not that it goes now: "draft reminders" for email stays a draft.
  const sendAsked = !!request && SEND.test(request.message) && !HOLD.test(request.message);
  const deliver = !!request && (sendAsked || (!!outcome.destination && !DRAFT.test(request.message)));
  if (request && !deliver) for (const a of calls) {
    if (a.destination && !outcome.actions.includes(a.id)) errors.push(`${a.id} sends to ${a.destination.label}, but the request doesn't ask to send anything; leave out ${a.id} and keep what was made unsent`);
  }
  if (request && deliver && !calls.some((a) => a.destination)) {
    // "Send a review request" planned as only creating one: the record exists, but nothing went out.
    for (const a of calls) {
      const made = a.risk === "read" ? undefined : a.entities?.produces;
      const sender = made && request.offered.find((o) => o.destination && !ids.has(o.id) && o.entities?.consumes?.includes(made));
      if (sender) errors.push(`${a.id} only creates the ${made.replace(/_/g, " ")}; the request asks to send it, which is ${sender.id} (${sender.name}). `
        + `Send what was created: in the same forEach "do", call ${sender.id} after ${a.id} with the new ID "$prev.id"; for a single create step s3, use "$s3.id"`);
    }
  }
  return [...new Set(errors)];
}

const SEND = /\bsend\b/i;
const DRAFT = /\b(draft|drafts|drafting|prepare|write up)\b/i;
const HOLD = /\b(don'?t|do not|not|without|never|before|later|until)\b.{0,20}\bsend/i;

/**
 * A change that loops over a list the look round already found empty would end "done" with nothing changed.
 * Only direct references to a looked step count: a filter between them may make the list longer or shorter.
 */
export function emptyTargets(plan: CompiledPlan, looked: { id: string; output?: unknown; error?: string }[]): { step: string; list: string }[] {
  const byId = new Map(looked.filter((l) => !l.error && l.output !== undefined).map((l) => [l.id, l.output]));
  const out: { step: string; list: string }[] = [];
  for (const step of plan.steps) {
    if (step.kind !== "forEach" || typeof step.in !== "string" || step.calls.every((c) => c.action.risk === "read")) continue;
    const ref = parseRef(step.in);
    if (!ref || !byId.has(ref.root)) continue;
    try {
      const list = valueAt(byId.get(ref.root), ref.path, ref.root);
      if (Array.isArray(list) && list.length === 0) out.push({ step: step.id, list: step.in });
    } catch { /* A path the look result doesn't have is the compiler's and executor's to report. */ }
  }
  return out;
}

/**
 * Weaker models pick the records a change runs on the wrong way round (exclude last week's leads where the request
 * keeps only those) or write out ids they picked by hand from <looked>. Before the change runs, the filter and exclude
 * steps that choose its records are said back in plain words, with what each keeps of the records already looked at,
 * so the planner can check them against the request once.
 */
export function selectionReadback(plan: CompiledPlan, looked: { id: string; output?: unknown; error?: string }[], message: string): string[] {
  const byId = new Map(plan.steps.map((s) => [s.id, s]));
  const values = new Map<string, unknown>(looked.filter((l) => !l.error && l.output !== undefined).map((l) => [l.id, l.output]));
  const chain = new Set<string>();
  const loops = plan.steps.flatMap((s) => (s.kind === "forEach" && typeof s.in === "string" && s.calls.some((c) => c.action.risk !== "read") ? [{ ...s, in: s.in }] : []));
  for (const loop of loops) {
    for (let at = parseRef(loop.in)?.root; at && !chain.has(at); ) {
      const s = byId.get(at);
      if (!s || (s.kind !== "filter" && s.kind !== "exclude")) break;
      chain.add(at);
      at = parseRef(s.in)?.root;
    }
  }
  if (!chain.size) return [];
  const read = (r: Ref) => {
    if (!values.has(r.root)) throw new Error("not looked");
    return valueAt(values.get(r.root), r.path, r.root);
  };
  const source = (ref: string) => {
    const s = byId.get(parseRef(ref)?.root ?? "");
    return s?.kind === "action" ? ` (what ${s.id}, ${s.call.action.id} ${s.call.action.name} ${JSON.stringify(s.call.args)}, found)` : "";
  };
  const label = (x: unknown) => {
    const o = (x ?? {}) as Record<string, unknown>;
    return String(o.name ?? o.title ?? o.personName ?? o.contactName ?? o.id ?? JSON.stringify(x));
  };
  const lines: string[] = [];
  const handPicked: string[] = [];
  let counted = false;
  for (const s of plan.steps) {
    if (!chain.has(s.id) || (s.kind !== "filter" && s.kind !== "exclude")) continue;
    let rule: string;
    if (s.kind === "exclude") rule = `whose ${s.by} is NOT among ${s.set}${source(s.set)}`;
    else {
      rule = `where ${Object.entries(s.where).map(([field, cond]) => {
        const conds = cond && typeof cond === "object" && !Array.isArray(cond) ? Object.entries(cond) : [["eq", cond] as const];
        return conds.map(([op, v]) => {
          if ((op === "in" || op === "nin") && Array.isArray(v) && v.length > 1 && v.every((x) => typeof x === "string" && /^[a-z]{2,4}_\w+$/.test(x) && !message.includes(x))) handPicked.push(`${s.id} (${JSON.stringify(v)})`);
          const what = typeof v === "string" && parseRef(v) ? `${v}${source(v)}` : JSON.stringify(v);
          return op === "in" ? `${field} is among ${what}` : op === "nin" ? `${field} is NOT among ${what}` : `${field} ${op} ${what}`;
        }).join(" and ");
      }).join(" and ")}`;
    }
    let count = "";
    try {
      const list = read(parseRef(s.in)!);
      if (Array.isArray(list)) {
        const kept = s.kind === "filter"
          ? list.filter((x) => matches(x, substitute(s.where, read) as Record<string, unknown>))
          : (() => {
              const set = new Set((read(parseRef(s.set)!) as unknown[]).map(String));
              return list.filter((x) => !set.has(String(fieldOf(x, s.by))));
            })();
        values.set(s.id, kept);
        counted = true;
        count = ` ${kept.length} of the ${list.length}${kept.length ? ` (${kept.slice(0, 8).map(label).join(", ")}${kept.length > 8 ? ", …" : ""})` : ""}`;
      }
    } catch { /* Not all of it was looked at: say the rule without counts. */ }
    lines.push(`${s.id} keeps${count} items of ${s.in} ${rule}`);
  }
  if (!counted && !handPicked.length) return [];
  const runs = loops.filter((l) => chain.has(parseRef(l.in)?.root ?? "")).map((l) => `${l.id} runs ${l.calls.map((c) => c.action.id).join(" and ")} on each`);
  return [
    `check which records this changes before it runs: ${lines.join("; ")}; ${runs.join("; ")}. ` +
      `If those are exactly the records the request means, plan the same again. If a step keeps what the request leaves out or drops what it keeps, turn it round: exclude drops the items whose field is among the set, and filter {"<field>":{"in":"$sN.items[*].<field>"}} keeps only those` +
      (handPicked.length ? `. ${handPicked.join(", ")} writes out ids picked by hand; the request's own condition decides which records those are, so read what decides it (an appointment booked, a reply) and filter or exclude by a $ref to that list instead` : ""),
  ];
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
