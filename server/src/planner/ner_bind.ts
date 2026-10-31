// NER as non-blocking hints. The sidecar's links never stop a turn on their own and never bind a record: the planner
// picks the action and its typed arguments, and only an argument that needs an existing record (a $lookup, lowered to a
// resolve step) is checked, by the identity resolver (core/identity.ts), with what NER found as extra candidates. NER
// suggests, the resolver decides, the user settles doubt: several exact matches or only near misses (a one-edit typo,
// an embedding lookalike) become a question about that argument; a name used as a filter value, in a new record or
// inside a message body never asks anything. See docs/adr/0001-ner-suggests-resolver-decides.md.
import type { CompiledPlan, CStep } from "../core/compile.js";
import { identityRisk } from "../core/execute.js";
import { type Hint, type IdentityResolution, resolveIdentity } from "../core/identity.js";
import type { Registry } from "../registry/registry.js";
import type { Mention } from "../retrieval/mentions.js";
import type { Store } from "../store/db.js";

export type Bound =
  | { kind: "plan"; plan: CompiledPlan; notice?: string; decisions: IdentityDecision[] }
  | { kind: "clarify"; text: string; options: string[]; resolution?: IdentityResolution; stepId?: string; decisions: IdentityDecision[] };

/** One resolver decision made while binding, for the turn's trace. */
export interface IdentityDecision {
  stepId: string;
  kind: IdentityResolution["kind"];
  entity: string;
  text: string;
  decision: string;
  candidates: IdentityResolution["candidates"];
  binding?: Extract<IdentityResolution, { kind: "bound" }>["binding"];
}

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();
const label = (entity: string) => entity.replaceAll("_", " ");
const option = (c: { name: string; detail?: string }) => (c.detail ? `${c.name} (${c.detail})` : c.name);

/** NER-sourced mentions only: Title-Case Store mentions carry no method. */
export const fromNer = (m: Mention) => m.method !== undefined;

/** A mention's links as resolver hints: candidates to check, never answers. */
function hintsOf(m: Mention, entity: string): Hint[] {
  const out: Hint[] = (m.candidates ?? []).filter((c) => !c.entity || c.entity === entity).map((c) => ({ id: c.id, name: c.name, ...(m.score !== undefined ? { score: m.score } : {}), ...(m.method ? { method: m.method } : {}) }));
  if (m.linkedId && m.entity === entity && !out.some((h) => h.id === m.linkedId)) out.push({ id: m.linkedId, ...(m.score !== undefined ? { score: m.score } : {}), ...(m.method ? { method: m.method } : {}) });
  return out;
}

/** The argument a resolve step feeds, for the question: "the recipient (contactId)". */
function roleOf(plan: CompiledPlan, stepId: string, registry: Registry): string | undefined {
  const ref = `$${stepId}.id`;
  for (const s of plan.steps) {
    const calls = s.kind === "action" ? [s.call] : s.kind === "forEach" ? s.calls : [];
    for (const c of calls) {
      for (const [arg, v] of Object.entries(c.args as Record<string, unknown>)) {
        if (!JSON.stringify(v).includes(ref)) continue;
        const desc = ((registry.get(c.action.id)?.inputSchema.properties ?? {}) as Record<string, { description?: string }>)[arg]?.description;
        return desc ? `${desc} (${arg})` : arg;
      }
    }
  }
  return undefined;
}

export function bindNerLookups(
  plan: CompiledPlan,
  named: Mention[],
  registry: Registry,
  opts: { store?: Store; request?: string; duplicates?: "warn" | "off" } = {},
): Bound {
  const ner = named.filter(fromNer);
  const decisions: IdentityDecision[] = [];
  if (!ner.length) return { kind: "plan", plan, decisions };
  const steps: CStep[] = [];
  for (const s of plan.steps) {
    // A lookup scoped by an earlier step's result can't be checked before that step runs; execution resolves it.
    if (s.kind !== "resolve" || (s.where && JSON.stringify(s.where).includes("$"))) { steps.push(s); continue; }
    const key = norm(s.name);
    const m = ner.find((x) => norm(x.name) === key && (x.entity === s.entity || x.candidates?.some((c) => c.entity === s.entity)));
    // Reads never ask or bind here: the name only filters, and execution looks it up.
    if (!m || identityRisk(plan, s.id) === "read") { steps.push(s); continue; }
    const role = roleOf(plan, s.id, registry);
    const forRole = role ? ` for ${role}` : "";
    const ask = (r: Pick<IdentityResolution, "kind" | "candidates">, resolution?: IdentityResolution): Bound => {
      const exact = r.kind === "ambiguous";
      const text = exact
        ? `I found ${r.candidates.length} ${label(s.entity)} records named ${s.name}. Which one should I use${forRole}?`
        : r.candidates.length === 1 ? `Did you mean ${r.candidates[0]!.name}${forRole}?` : `I couldn't find a ${label(s.entity)} named ${s.name}${forRole}. Did you mean one of these?`;
      return { kind: "clarify", text, options: r.candidates.map(option), stepId: s.id, decisions, ...(resolution ? { resolution } : {}) };
    };
    if (!opts.store) {
      // Nothing to check NER's links against: never bind, but its doubt is still worth a question.
      const cands = (m.candidates ?? []).filter((c) => !c.entity || c.entity === s.entity).map((c) => ({ ...c, matchReason: "ner" as const, score: m.score ?? 0 }));
      const exact = cands.filter((c) => norm(c.name) === key);
      if (m.suggestion && cands.length) return ask({ kind: "suggest", candidates: cands });
      if (m.ambiguous && exact.length > 1) return ask({ kind: "ambiguous", candidates: exact });
      steps.push(s);
      continue;
    }
    const r = resolveIdentity({ entity: s.entity, text: s.name, ...(s.where ? { where: s.where } : {}), actionRisk: "write", hints: hintsOf(m, s.entity), ...(opts.request ? { qualifiers: opts.request } : {}) }, { registry, store: opts.store });
    decisions.push({ stepId: s.id, kind: r.kind, entity: s.entity, text: s.name, decision: r.decision, candidates: r.candidates, ...(r.kind === "bound" ? { binding: r.binding } : {}) });
    if (r.kind === "ambiguous" || r.kind === "suggest") return ask(r, r);
    // A unique strong key binds, with the record's own name and how it was bound; execution checks it still holds.
    steps.push(r.kind === "bound" ? { ...s, bound: r.binding } : s);
  }
  // Duplicate-check policy for creates: a warning on the reply, never a "which one" picker.
  let notice: string | undefined;
  if ((opts.duplicates ?? "warn") === "warn") {
    for (const s of steps) {
      if (s.kind !== "action") continue;
      const made = s.call.action.entities?.produces;
      const a = s.call.args as Record<string, unknown>;
      const name = typeof a.name === "string" ? a.name : [a.firstName, a.lastName].filter((v) => typeof v === "string").join(" ");
      if (!made || !name || s.call.action.risk === "read") continue;
      const same = ner.find((x) => norm(x.name) === norm(name) && (x.entity === made || x.candidates?.some((c) => c.entity === made && norm(c.name) === norm(name))));
      if (same) notice = `Note: a ${label(made)} named ${name} already exists; this creates another one.`;
    }
  }
  return { kind: "plan", plan: { ...plan, steps }, decisions, ...(notice ? { notice } : {}) };
}
