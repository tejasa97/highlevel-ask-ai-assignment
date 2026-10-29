// NER as non-blocking hints. The sidecar's links never stop a turn on their own: the planner picks the action and its
// typed arguments, and only an argument that needs an existing record (a $lookup, lowered to a resolve step) is bound
// against what NER found for that name. Ambiguity or a one-edit typo becomes a question about that argument; a name
// used as a filter value, in a new record or inside a message body never asks anything.
import type { CompiledPlan, CStep } from "../core/compile.js";
import type { Registry } from "../registry/registry.js";
import type { Mention } from "../retrieval/mentions.js";

export type Bound =
  | { kind: "plan"; plan: CompiledPlan; notice?: string }
  | { kind: "clarify"; text: string; options: string[] };

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();
const label = (entity: string) => entity.replaceAll("_", " ");
const option = (c: { name: string; detail?: string }) => (c.detail ? `${c.name} (${c.detail})` : c.name);

/** NER-sourced mentions only: Title-Case Store mentions carry no method. */
export const fromNer = (m: Mention) => m.method !== undefined;

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
  opts: { holds?: (id: string) => boolean; duplicates?: "warn" | "off" } = {},
): Bound {
  const ner = named.filter(fromNer);
  if (!ner.length) return { kind: "plan", plan };
  const steps: CStep[] = [];
  for (const s of plan.steps) {
    if (s.kind !== "resolve" || (s.where && Object.keys(s.where).length)) { steps.push(s); continue; }
    const key = norm(s.name);
    const m = ner.find((x) => norm(x.name) === key && (x.entity === s.entity || x.candidates?.some((c) => c.entity === s.entity)));
    if (!m) { steps.push(s); continue; }
    const cands = (m.candidates ?? []).filter((c) => !c.entity || c.entity === s.entity);
    const role = roleOf(plan, s.id, registry);
    const forRole = role ? ` for ${role}` : "";
    if (m.suggestion && cands.length) {
      const text = cands.length === 1 ? `Did you mean ${cands[0]!.name}${forRole}?` : `I couldn't find a ${label(s.entity)} named ${s.name}${forRole}. Did you mean one of these?`;
      return { kind: "clarify", text, options: cands.map(option) };
    }
    if (m.ambiguous) {
      const exact = cands.filter((c) => norm(c.name) === key);
      if (exact.length > 1) return { kind: "clarify", text: `I found ${exact.length} ${label(s.entity)} records named ${s.name}. Which one should I use${forRole}?`, options: exact.map(option) };
      if (exact.length === 1 && (!opts.holds || opts.holds(exact[0]!.id))) { steps.push({ ...s, pinned: { id: exact[0]!.id, name: exact[0]!.name } }); continue; }
      steps.push(s);
      continue;
    }
    // A unique exact link is the answer: the executor uses it without a store lookup.
    if (m.linkedId && m.entity === s.entity && (!opts.holds || opts.holds(m.linkedId))) { steps.push({ ...s, pinned: { id: m.linkedId, name: s.name } }); continue; }
    steps.push(s);
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
  return { kind: "plan", plan: { ...plan, steps }, ...(notice ? { notice } : {}) };
}
