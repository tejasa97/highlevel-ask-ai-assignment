// NER as non-blocking hints. The sidecar's links never stop a turn on their own and never bind a record: the planner
// picks the action and its typed arguments, and only an argument that needs an existing record (a $lookup, lowered to a
// resolve step) is checked, by the identity resolver (core/identity.ts), with what NER found as extra candidates. NER
// suggests, the resolver decides, the user settles doubt: several exact matches or only near misses (a one-edit typo,
// an embedding lookalike) become a question about that argument; a name used as a filter value, in a new record or
// inside a message body never asks anything. See docs/adr/0001-ner-suggests-resolver-decides.md.
import { argumentRole, type CompiledPlan, type CStep } from "../core/compile.js";
import { identityRisk } from "../core/execute.js";
import { type Hint, type IdentityBinding, type IdentityResolution, legacyResolution, narrowByRequest, optionLabel, resolveIdentity, resolverOff } from "../core/identity.js";
import { OTHER_THAN } from "../core/lookups.js";
import type { Registry } from "../registry/registry.js";
import type { Mention } from "../retrieval/mentions.js";
import type { Store } from "../store/db.js";

export type Bound =
  | { kind: "plan"; plan: CompiledPlan; notice?: string; decisions: IdentityDecision[] }
  | {
      kind: "clarify"; text: string; options: string[]; resolution?: IdentityResolution; stepId?: string; decisions: IdentityDecision[];
      /** The plan as far as binding got: the steps before the one asked about keep their bindings for the resume. */
      plan: CompiledPlan;
    };

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

/** NER-sourced mentions only: Title-Case Store mentions carry no method. */
export const fromNer = (m: Mention) => m.method !== undefined;

/** A mention's links as resolver hints: candidates to check, never answers. */
function hintsOf(m: Mention, entity: string): Hint[] {
  const out: Hint[] = (m.candidates ?? []).filter((c) => !c.entity || c.entity === entity).map((c) => ({ id: c.id, name: c.name, ...(m.score !== undefined ? { score: m.score } : {}), ...(m.method ? { method: m.method } : {}) }));
  if (m.linkedId && m.entity === entity && !out.some((h) => h.id === m.linkedId)) out.push({ id: m.linkedId, ...(m.score !== undefined ? { score: m.score } : {}), ...(m.method ? { method: m.method } : {}) });
  return out;
}

/** The argument a resolve step feeds, for the question: "the recipient (contactId)". */
function roleOf(plan: CompiledPlan, stepId: string): string | undefined {
  // Only worth saying when the plan looks up more than one record; the schema's notes ("ct_…; give this or leadId")
  // are for the planner, not the user.
  if (plan.steps.filter((s) => s.kind === "resolve").length < 2) return undefined;
  const role = argumentRole(plan, stepId);
  const said = role?.description?.split(";")[0]!.replace(/\s*\([^)]*\)/g, "").trim();
  return role && (said ? `${said} (${role.arg})` : role.arg);
}

/**
 * The user's picks for names in this message, from a question a look asked: each lookup of that record type and name
 * is bound to the pick, so planning the message again doesn't ask the same question. Execution revalidates them.
 */
function bindPicks(plan: CompiledPlan, picks: IdentityBinding[] = []): CompiledPlan {
  if (!picks.length) return plan;
  // A lookup told to skip the picked record (the other Sarah of a merge) is not that pick.
  const pickFor = (s: CStep) => s.kind === "resolve" && !s.bound && !(s.where && JSON.stringify(s.where).includes("$"))
    ? picks.find((p) => p.entity === s.entity && norm(p.text) === norm(s.name) && p.id !== s.where?.[OTHER_THAN]) : undefined;
  return { ...plan, steps: plan.steps.map((s) => { const p = pickFor(s); return p ? { ...s, bound: p } : s; }) };
}

export function bindNerLookups(
  raw: CompiledPlan,
  named: Mention[],
  registry: Registry,
  opts: { store?: Store; request?: string; duplicates?: "warn" | "off"; picks?: IdentityBinding[]; answering?: boolean } = {},
): Bound {
  const plan = bindPicks(raw, opts.picks);
  const ner = named.filter(fromNer);
  const decisions: IdentityDecision[] = [];
  if (!ner.length) return { kind: "plan", plan, decisions };
  if (resolverOff()) return pinNerLinks(plan, ner, registry, opts);
  // An answer to a question already asked plans with that question in view: it settles the type, never asks it again.
  const doubt = opts.store && !opts.answering ? typeDoubt(plan, ner, registry, opts.store, opts.request ?? "") : undefined;
  if (doubt) return { ...doubt, decisions };
  const typo = opts.store && !opts.answering ? searchedTypo(plan, ner, registry, opts.store) : undefined;
  if (typo) return { ...typo, decisions };
  const steps: CStep[] = [];
  for (const [i, planned] of plan.steps.entries()) {
    // A lookup scoped by an earlier step's result can't be checked before that step runs; execution resolves it.
    if (planned.kind !== "resolve" || planned.bound || (planned.where && JSON.stringify(planned.where).includes("$"))) { steps.push(planned); continue; }
    // A name the user never wrote that is NER's did-you-mean for one they did ("Rosa Ito" for "Rosalind Ito") is the
    // planner taking the suggestion: the user's own name is looked up instead, so the suggestion is asked, not used.
    const suggested = opts.request && !norm(opts.request).includes(norm(planned.name))
      ? ner.find((x) => x.suggestion && x.candidates?.some((c) => (!c.entity || c.entity === planned.entity) && norm(c.name) === norm(planned.name)))
      : undefined;
    const s = suggested ? { ...planned, name: suggested.name } : planned;
    const key = norm(s.name);
    const m = ner.find((x) => norm(x.name) === key && (x.entity === s.entity || x.candidates?.some((c) => c.entity === s.entity)));
    // Reads never ask or bind here: the name only filters, and execution looks it up.
    if (!m || identityRisk(plan, s.id) === "read") { steps.push(planned); continue; }
    const role = roleOf(plan, s.id);
    const forRole = role ? ` for ${role}` : "";
    const ask = (r: Pick<IdentityResolution, "kind" | "candidates">, resolution?: IdentityResolution): Bound => {
      const exact = r.kind === "ambiguous";
      const text = exact
        ? `I found ${r.candidates.length} ${label(s.entity)} records named ${s.name}. Which one should I use${forRole}?`
        : r.candidates.length === 1 ? `Did you mean ${r.candidates[0]!.name}${forRole}?` : `I couldn't find a ${label(s.entity)} named ${s.name}${forRole}. Did you mean one of these?`;
      const sofar = { ...plan, steps: [...steps, ...plan.steps.slice(i)] };
      return { kind: "clarify", text, options: r.candidates.map(optionLabel), stepId: s.id, decisions, plan: sofar, ...(resolution ? { resolution } : {}) };
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
  return withNotice(plan, steps, ner, decisions, opts.duplicates);
}

/**
 * A read that searches by a name no record has, when NER only found near misses for it ("Omar Lassen's email"): the
 * search can only come back empty, so the user is asked the did-you-mean a lookup of that name would have asked.
 */
function searchedTypo(plan: CompiledPlan, ner: Mention[], registry: Registry, store: Store): Omit<Extract<Bound, { kind: "clarify" }>, "decisions"> | undefined {
  for (const s of plan.steps) {
    if (s.kind !== "action" || s.call.action.risk !== "read") continue;
    const query = (s.call.args as { query?: unknown }).query;
    const entity = s.call.action.entities?.produces;
    const resolver = entity ? registry.resolver(entity) : undefined;
    if (typeof query !== "string" || !entity || !resolver) continue;
    const m = ner.find((x) => x.suggestion && norm(x.name) === norm(query));
    if (!m || resolver(store, query)?.some((c) => norm(c.name) === norm(query))) continue;
    const cands = (m.candidates ?? []).filter((c) => !c.entity || c.entity === entity).flatMap((c) => resolver(store, c.name)?.filter((r) => r.id === c.id && !r.inactive) ?? []);
    if (!cands.length) continue;
    const text = cands.length === 1 ? `I couldn't find a ${label(entity)} named ${query}. Did you mean ${cands[0]!.name}?` : `I couldn't find a ${label(entity)} named ${query}. Did you mean one of these?`;
    return { kind: "clarify", text, options: cands.map(optionLabel), plan };
  }
  return undefined;
}

/**
 * A write naming someone who is exactly a record of more than one type ("Femi Silva" is a contact and a lead) when the
 * request doesn't say which type: a planner that has to pick one guesses, and one that hedges writes both. The user is
 * asked before anything runs; the answer plans the message again with the question in view.
 */
function typeDoubt(plan: CompiledPlan, ner: Mention[], registry: Registry, store: Store, request: string): Omit<Extract<Bound, { kind: "clarify" }>, "decisions"> | undefined {
  const asked = new Set<string>();
  for (const s of plan.steps) {
    if (s.kind !== "resolve" || (s.bound && s.bound.provenance === "user-selected") || identityRisk(plan, s.id) === "read") continue;
    const key = norm(s.name);
    if (asked.has(key)) continue;
    asked.add(key);
    const doubt = typeDoubtOf(s.name, s.entity, ner, registry, store, request);
    if (doubt) return { kind: "clarify", ...doubt, plan };
  }
  return undefined;
}

/** The question for one name that is exactly a record of more than one type, when the request doesn't say which. */
export function typeDoubtOf(name: string, entity: string, ner: Mention[], registry: Registry, store: Store, request: string): { text: string; options: string[] } | undefined {
  const said = ` ${norm(request)} `;
  const named = (e: string) => [label(e), `${label(e)}s`].some((w) => said.includes(` ${w} `));
  const key = norm(name);
  const m = ner.find((x) => norm(x.name) === key);
  if (!m) return undefined;
  const types = [...new Set([entity, m.entity, ...(m.candidates ?? []).map((c) => c.entity)].filter((e): e is string => !!e && !!registry.resolver(e)))];
  const found = types.flatMap((e) => (registry.resolver(e)!(store, name) ?? []).filter((c) => !c.inactive && norm(c.name) === key).map((c) => ({ ...c, entity: e })));
  const kinds = [...new Set(found.map((c) => c.entity))];
  if (kinds.length < 2 || kinds.some(named) || narrowByRequest(found, request).length === 1) return undefined;
  const what = kinds.map((k) => `a ${label(k)}`).join(" and ");
  return { text: `${name} is ${kinds.length === 2 ? "both " : ""}${what}. Which one did you mean?`, options: found.map((c) => `The ${label(c.entity)} ${optionLabel(c)}`) };
}

/**
 * RESOLVER=off: the binding path from before the resolver, for evals that compare the two. NER's own doubt (a
 * suggestion, several exact links) asks, read or write; a unique link the store holds is pinned and used as is.
 */
function pinNerLinks(plan: CompiledPlan, ner: Mention[], registry: Registry, opts: { store?: Store; duplicates?: "warn" | "off" }): Bound {
  const holds = (id: string) => !opts.store || opts.store.holds(id);
  const steps: CStep[] = [];
  for (const [i, s] of plan.steps.entries()) {
    if (s.kind !== "resolve" || s.bound || (s.where && Object.keys(s.where).length)) { steps.push(s); continue; }
    const key = norm(s.name);
    const m = ner.find((x) => norm(x.name) === key && (x.entity === s.entity || x.candidates?.some((c) => c.entity === s.entity)));
    if (!m) { steps.push(s); continue; }
    // The store's own rows for NER's ids where it has them, so a pick binds (and revalidates) the record as it is.
    const stored = new Map(opts.store ? (registry.resolver(s.entity)?.(opts.store, s.name) ?? []).map((c) => [c.id, c]) : []);
    const cands = (m.candidates ?? []).filter((c) => !c.entity || c.entity === s.entity).map((c) => stored.get(c.id) ?? c);
    const role = roleOf(plan, s.id);
    const forRole = role ? ` for ${role}` : "";
    const ask = (text: string, cs: typeof cands, reason: "ner" | "exact-name"): Bound => ({
      kind: "clarify", text, options: cs.map(optionLabel), stepId: s.id, decisions: [], plan: { ...plan, steps: [...steps, ...plan.steps.slice(i)] },
      resolution: { ...legacyResolution(s.entity, s.name, identityRisk(plan, s.id), cs, reason), ...(reason === "ner" ? { kind: "suggest" as const } : {}) },
    });
    if (m.suggestion && cands.length) return ask(cands.length === 1 ? `Did you mean ${cands[0]!.name}${forRole}?` : `I couldn't find a ${label(s.entity)} named ${s.name}${forRole}. Did you mean one of these?`, cands, "ner");
    if (m.ambiguous) {
      const exact = cands.filter((c) => norm(c.name) === key);
      if (exact.length > 1) return ask(`I found ${exact.length} ${label(s.entity)} records named ${s.name}. Which one should I use${forRole}?`, exact, "exact-name");
      steps.push(exact.length === 1 && holds(exact[0]!.id) ? { ...s, pinned: { id: exact[0]!.id, name: exact[0]!.name } } : s);
      continue;
    }
    // A unique exact link is the answer: the executor uses it without a store lookup.
    steps.push(m.linkedId && m.entity === s.entity && holds(m.linkedId) ? { ...s, pinned: { id: m.linkedId, name: s.name } } : s);
  }
  return withNotice(plan, steps, ner, [], opts.duplicates);
}

/** Duplicate-check policy for creates: a warning on the reply, never a "which one" picker. */
function withNotice(plan: CompiledPlan, steps: CStep[], ner: Mention[], decisions: IdentityDecision[], duplicates: "warn" | "off" = "warn"): Bound {
  let notice: string | undefined;
  if (duplicates === "warn") {
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
