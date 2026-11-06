import { createHash } from "node:crypto";
import { norm as plain } from "../registry/helpers.js";
import type { Candidate, LookupWhere, Registry } from "../registry/registry.js";
import type { Doc, Store } from "../store/db.js";
import { ENTITIES } from "../store/entities.js";
import { OTHER_THAN } from "./lookups.js";

// The identity resolver: the one place that decides which existing record a name means. NER links, embedding matches
// and edit-distance near misses are candidate sources only; they rank, they never bind. See
// docs/adr/0001-ner-suggests-resolver-decides.md.
//
// Policy, by what the record is for:
// - read: the unique match is used (a wrong read is visible and harmless); several ask, as a single-record read must
//   still pick one, and only near misses are offered back ("did you mean"). A name the planner used as a filter value
//   never reaches here at all.
// - create: never binds or asks; a same-named record is a duplicate warning for the reply.
// - write (any change or send aimed at one record): binds only on a strong key unique in scope (its id, its email,
//   or its exact normalized name). Several exact matches are "ambiguous"; only near misses are "suggest".

export type ActionRisk = "read" | "create" | "write";

/** Why a candidate is on the list. Only id, email and exact-name are strong enough to bind a write. */
export type MatchReason = "id" | "email" | "exact-name" | "alias" | "name" | "edit" | "ner" | "embed";
export const STRONG: ReadonlySet<MatchReason> = new Set(["id", "email", "exact-name"]);

/** How a binding was made: a unique strong key, the store lookup (reads, or narrowed by the user's words), or the user's pick. */
export type Provenance = "exact-unique" | "lookup" | "user-selected";

export interface RankedCandidate {
  id: string;
  /** The record's own name, never the user's text. */
  name: string;
  detail?: string;
  matchReason: MatchReason;
  score: number;
  /** Set when the record can't be used (its status): such a record is never bound. */
  inactive?: string;
}

/** A record bound to a name, as carried from resolution to execution. */
export interface IdentityBinding {
  entity: string;
  id: string;
  /** The record's own name, which is what the preview and the step's output show. */
  name: string;
  /** What the user typed. */
  text: string;
  provenance: Provenance;
  matchReason: MatchReason;
  /** The record's updatedAt when it was resolved, if it has one: for the trace. */
  updatedAt?: string;
  /** Hash of what identifies the record (name, detail, status): execution refuses the binding if it changed. */
  fingerprint: string;
  /** The scope it was resolved in, so revalidation looks in the same place. */
  where?: LookupWhere;
}

interface Base {
  entity: string;
  text: string;
  actionRisk: ActionRisk;
  /** Ranked best first, at most config.suggestMax for asks. */
  candidates: RankedCandidate[];
  /** One line for the trace: what was decided and why. */
  decision: string;
}

/** The resolver's answer. B's clarification state machine builds on this. */
export type IdentityResolution =
  | (Base & { kind: "bound"; binding: IdentityBinding })
  | (Base & { kind: "ambiguous" })
  | (Base & { kind: "suggest"; /** The qualifier matched none of them: picking one drops it. */ dropsWhere?: true })
  | (Base & { kind: "not_found"; /** Records that match but can't be used (deactivated, merged): to say why. */ unusable: RankedCandidate[] });

/** Candidate links from NER or another linker, by name. Never trusted: every id is checked against the store and scope. */
export interface Hint {
  id: string;
  name?: string;
  score?: number;
  /** exact | embed | edit | rule, as the linker reports it. */
  method?: string;
}

export interface IdentityQuery {
  entity: string;
  /** The name as the user (or planner) wrote it. */
  text: string;
  /** Scope: the parent and exact qualifiers the resolver understands. May hold OTHER_THAN. */
  where?: LookupWhere;
  /** The user's words: a detail in them ("Sarah Johnson at Brightside") can narrow exact matches to one. */
  qualifiers?: string;
  actionRisk: ActionRisk;
  hints?: Hint[];
}

export interface IdentityConfig {
  /** Max Levenshtein distance for the near-miss generator (whole normalized name). */
  editMaxDistance: number;
  /** Most candidates offered in a question. */
  suggestMax: number;
  /** Hints below this score are dropped. */
  hintMin: number;
  /** "strong" (default): a write binds only on a unique strong key. "unique": a unique partial-name match binds too. */
  writeBind: "strong" | "unique";
}

const envNum = (v: string | undefined, d: number) => (v !== undefined && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
export function identityConfig(env: NodeJS.ProcessEnv = process.env): IdentityConfig {
  return {
    editMaxDistance: envNum(env.RESOLVER_EDIT_MAX_DISTANCE, 1),
    suggestMax: envNum(env.RESOLVER_SUGGEST_MAX, 5),
    hintMin: envNum(env.RESOLVER_HINT_MIN_SCORE, 0),
    writeBind: env.RESOLVER_WRITE_BIND === "unique" ? "unique" : "strong",
  };
}

const SCORE: Record<MatchReason, number> = { id: 1, email: 1, "exact-name": 1, alias: 0.95, name: 0.7, edit: 0.6, ner: 0.5, embed: 0.5 };
const RANK: MatchReason[] = ["id", "email", "exact-name", "alias", "name", "edit", "embed", "ner"];
// Accents are dropped, not split on: "Muñoz" is "munoz", not "mun oz".
const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/['’]s\b/gu, "").replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim();
const ID = /^[a-z]{1,6}_\d+(_\d+)*$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** How a candidate is offered in a question: "Sarah Johnson (sjohnson@gmail.example)". */
/**
 * RESOLVER=off restores the binding path from before this resolver (NER links pinned, the store's lookup as it was),
 * for evals that compare the two. Read on every call, so a test or eval can switch it without reloading.
 */
export const resolverOff = () => process.env.RESOLVER === "off";

/** A pre-resolver answer as a resolution, so the stored question and its resume work the same in both modes. */
export function legacyResolution(entity: string, text: string, actionRisk: ActionRisk, cs: { id: string; name: string; detail?: string }[], matchReason: MatchReason): IdentityResolution {
  return { kind: "ambiguous", entity, text, actionRisk, candidates: cs.map((c) => ({ id: c.id, name: c.name, ...(c.detail ? { detail: c.detail } : {}), matchReason, score: 1 })), decision: "resolver off: several matches" };
}

export const optionLabel = (c: { name: string; detail?: string }) => (c.detail ? `${c.name} (${c.detail})` : c.name);

/** The store table an id lives in, from its prefix. */
export function tableOfId(id: string): string | undefined {
  const prefix = id.split("_")[0];
  return Object.entries(ENTITIES).find(([, e]) => e.prefix === prefix)?.[0];
}

/** The store table for an entity name ("contact" → "contacts", "opportunity" → "opportunities"). */
export function tableOf(entity: string): string | undefined {
  const tables = Object.keys(ENTITIES);
  return [`${entity}s`, `${entity.replace(/y$/, "ies")}`, `${entity}es`, entity].find((t) => tables.includes(t));
}

export function fingerprint(c: Pick<Candidate, "name" | "detail" | "inactive">): string {
  return createHash("sha256").update(JSON.stringify([c.name, c.detail ?? "", c.inactive ?? ""])).digest("hex").slice(0, 16);
}

function levenshtein(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]!);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * Resolves a name to a record of one entity type within one scope. Every candidate, whatever produced it, is one the
 * entity's own resolver returns for that scope: a hint for a record of another type, or outside the parent, is dropped.
 */
/** Every word said is a whole word of the record's: "tom" in "Tom Becker", not "to" or "becke". */
// "2 Ceramic Mugs" says the product Ceramic Mug: a word said in the plural holds its singular.
const wholeWords = (said: string[], name: string) => {
  const words = new Set(norm(name).split(" "));
  return said.every((w) => words.has(w) || (w.endsWith("s") && words.has(w.slice(0, -1))) || (w.endsWith("es") && words.has(w.slice(0, -2))));
};

export function resolveIdentity(q: IdentityQuery, deps: { registry: Registry; store: Store; config?: IdentityConfig }): IdentityResolution {
  const config = deps.config ?? identityConfig();
  const resolver = deps.registry.resolver(q.entity);
  if (!resolver) throw new Error(`can't resolve entity "${q.entity}"`);
  const { [OTHER_THAN]: other, ...where } = q.where ?? {};
  const text = q.text.trim();
  const key = norm(text);
  // One store lookup per name, however many keys point at it.
  const looked = new Map<string, Candidate[]>();
  const lookup = (name: string) => {
    if (!looked.has(name)) looked.set(name, resolver(deps.store, name, where).filter((c) => c.id !== other));
    return looked.get(name)!;
  };
  const found = new Map<string, RankedCandidate>();
  const add = (c: Candidate, matchReason: MatchReason, score = SCORE[matchReason]) => {
    const was = found.get(c.id);
    if (was && RANK.indexOf(was.matchReason) <= RANK.indexOf(matchReason)) return;
    found.set(c.id, { id: c.id, name: c.name, ...(c.detail ? { detail: c.detail } : {}), matchReason, score, ...(c.inactive ? { inactive: c.inactive } : {}) });
  };
  /** The record as the resolver sees it in this scope, or nothing when it isn't there. */
  const inScope = (id: string, name: string) => lookup(name).find((c) => c.id === id);

  // 1. Exact id.
  if (ID.test(text)) {
    const c = inScope(text, text);
    if (c) add(c, "id");
  }
  // 2. Name: the store resolver's own match, split into exact normalized names and the looser tiers (word, prefix).
  for (const c of lookup(text)) add(c, norm(c.name) === key ? "exact-name" : "name");
  // 3. Exact email, aliases, and one-edit near misses, in one pass over the table. Near misses count only when
  //    nothing else matched at all.
  const table = tableOf(q.entity);
  const byEmail = EMAIL.test(text) ? text.toLowerCase() : undefined;
  const edits = !!table && config.editMaxDistance > 0 && key.length > 3;
  const near: Doc[] = [];
  if (table) {
    for (const row of deps.store.all<Doc>(table)) {
      if (typeof row.name !== "string") continue;
      const id = row.id as string;
      if (byEmail && typeof row.email === "string" && row.email.toLowerCase() === byEmail) {
        const c = inScope(id, row.name);
        if (c) add(c, "email");
      }
      if (Array.isArray(row.aliases) && row.aliases.some((a) => typeof a === "string" && norm(a) === key)) {
        const c = inScope(id, row.name);
        if (c) add(c, "alias");
      }
      if (edits && levenshtein(norm(row.name), key, config.editMaxDistance) <= config.editMaxDistance) near.push(row);
    }
  }
  if (!found.size) {
    for (const row of near) {
      const c = inScope(row.id as string, row.name as string);
      if (c) add(c, "edit");
    }
  }
  // 6. Hints (NER links, embedding matches): candidates only, checked against the store and scope like any other.
  for (const h of q.hints ?? []) {
    if ((h.score ?? 1) < config.hintMin) continue;
    const t = tableOfId(h.id);
    const row = t && t === table ? deps.store.get<Doc>(t, h.id) : undefined;
    const name = row && typeof row.name === "string" ? row.name : h.name;
    const c = name ? inScope(h.id, name) : undefined;
    if (!c) continue;
    const reason: MatchReason = h.method === "embed" ? "embed" : h.method === "edit" ? "edit" : "ner";
    // A hint never scores like a strong key, however sure the linker was.
    add(c, reason, Math.min(h.score ?? SCORE[reason], 0.9));
  }

  const all = [...found.values()].sort((a, b) => RANK.indexOf(a.matchReason) - RANK.indexOf(b.matchReason) || b.score - a.score || a.name.localeCompare(b.name));
  const usable = all.filter((c) => !c.inactive);
  const base = { entity: q.entity, text, actionRisk: q.actionRisk };
  const top = (cs: RankedCandidate[]) => cs.slice(0, config.suggestMax);
  const bind = (c: RankedCandidate, provenance: Provenance, decision: string, scope = q.where): IdentityResolution => ({
    ...base, kind: "bound", candidates: [c], decision,
    binding: bindingOf(q.entity, text, c, provenance, deps.store, Object.keys(scope ?? {}).length ? scope : undefined),
  });
  if (!usable.length && Object.keys(where).length && q.actionRisk !== "create" && !Object.keys(where).some((k) => resolver.parentQualifiers?.includes(k))) {
    // "Call Zoe Costa at Acme" when no Zoe Costa is at Acme but two are elsewhere: the qualifier may be the slip, so
    // offer the records the name alone matches rather than a dead end. Never across a parent: Yusuf's subscription is
    // never someone else's.
    const held = other === undefined ? undefined : { [OTHER_THAN]: other } as LookupWhere;
    const loose = resolveIdentity({ ...q, where: held, qualifiers: undefined }, deps);
    const cs = loose.candidates.filter((c) => !c.inactive);
    // where {email: "gmail.com"} for the Sarah Johnson at sjohnson@gmail.example: the qualifier's words still pick one.
    const picked = cs.length > 1 ? narrowByRequest(cs, `${Object.values(where).join(" ")} ${q.qualifiers ?? ""}`) : [];
    if (picked.length === 1 && q.actionRisk !== "read") return bind(picked[0]!, "lookup", `no exact match where ${JSON.stringify(where)}; its words pick one`, held ?? {});
    if (cs.length) return { ...base, kind: "suggest", candidates: top(cs), dropsWhere: true, decision: `no match where ${JSON.stringify(where)}; the name alone matches, asking` };
  }
  if (!usable.length) return { ...base, kind: "not_found", candidates: [], unusable: all, decision: all.length ? "only unusable records match" : "no candidate" };

  if (q.actionRisk === "create") {
    const same = usable.filter((c) => c.matchReason === "exact-name");
    return same.length ? { ...base, kind: "suggest", candidates: top(same), decision: "create: duplicate warning only" } : { ...base, kind: "not_found", candidates: [], unusable: [], decision: "create: no duplicate" };
  }

  // Store matches decide; hint-only and near-miss candidates can at most be offered back.
  const matched = usable.filter((c) => c.matchReason !== "edit" && c.matchReason !== "embed" && c.matchReason !== "ner");
  const narrow = (cs: RankedCandidate[]) => (cs.length > 1 && q.qualifiers ? narrowByRequest(cs, q.qualifiers) : cs);
  if (q.actionRisk === "read") {
    const cs = narrow(matched);
    if (cs.length === 1) return bind(cs[0]!, STRONG.has(cs[0]!.matchReason) && matched.length === 1 ? "exact-unique" : "lookup", "read: unique match");
    if (cs.length > 1) return { ...base, kind: "ambiguous", candidates: top(cs), decision: "read: several matches" };
    // "What's Omar Lassen's email?" with an Omar Larsen on file: a dead end helps nobody, so offer the near miss.
    return { ...base, kind: "suggest", candidates: top(usable), decision: "read: only near misses, asking" };
  }

  const strong = usable.filter((c) => STRONG.has(c.matchReason));
  if (strong.length === 1) return bind(strong[0]!, "exact-unique", `write: unique ${strong[0]!.matchReason}`);
  if (strong.length > 1) {
    const cs = narrow(strong);
    if (cs.length === 1) return bind(cs[0]!, "lookup", "write: exact matches narrowed to one by the request");
    return { ...base, kind: "ambiguous", candidates: top(strong), decision: `write: ${strong.length} strong matches` };
  }
  if (config.writeBind === "unique" && matched.length === 1) return bind(matched[0]!, "lookup", "write: unique partial match (RESOLVER_WRITE_BIND=unique)");
  // A record people describe rather than name ("Elena Costa's quote", "the Workspace login ticket", "Tom" for Tom
  // Becker) binds when it is the only one whose name and detail hold every word said, the entity's own noun aside.
  // People are strict: "Sarah" is never the one Sarah on file.
  if (!resolver.strictNames) {
    const noun = new Set(q.entity.split("_"));
    const said = key.split(" ").filter((w) => w && !noun.has(w));
    const holds = said.length ? usable.filter((c) => wholeWords(said, `${c.name} ${c.detail ?? ""}`)) : [];
    if (holds.length === 1) return bind(holds[0]!, "lookup", "write: the one record holding every word said");
  }
  return { ...base, kind: "suggest", candidates: top(usable), decision: "write: no strong key, asking" };
}

function bindingOf(entity: string, text: string, c: RankedCandidate, provenance: Provenance, store: Store, where?: LookupWhere): IdentityBinding {
  const t = tableOfId(c.id);
  const row = t ? store.get<Doc>(t, c.id) : undefined;
  return {
    entity, id: c.id, name: c.name, text, provenance, matchReason: c.matchReason,
    ...(typeof row?.updatedAt === "string" ? { updatedAt: row.updatedAt } : {}),
    fingerprint: fingerprint(c),
    ...(where ? { where } : {}),
  };
}

/** The scope a pick from this question still holds: all of it, or only the exclusions when its qualifier matched none. */
export function heldWhere(r: Pick<IdentityResolution, "kind"> & { dropsWhere?: true }, where?: LookupWhere): LookupWhere | undefined {
  if (!r.dropsWhere || !where) return where;
  return OTHER_THAN in where ? { [OTHER_THAN]: where[OTHER_THAN] } as LookupWhere : undefined;
}

/** A binding the user made by picking a candidate from a question. */
export function userSelected(entity: string, text: string, c: RankedCandidate, store: Store, where?: LookupWhere): IdentityBinding {
  return bindingOf(entity, text, c, "user-selected", store, where);
}

/** Why a binding made earlier can no longer be used, or nothing when it still holds. */
export function revalidate(b: IdentityBinding, deps: { registry: Registry; store: Store }): { code: "GONE" | "INACTIVE" | "CHANGED"; message: string } | undefined {
  const t = tableOfId(b.id);
  const row = t ? deps.store.get<Doc>(t, b.id) : undefined;
  if (t && !row) return { code: "GONE", message: `${b.name} (${b.id}) no longer exists` };
  if (!t && !deps.store.holds(b.id)) return { code: "GONE", message: `${b.name} (${b.id}) no longer exists` };
  if (row && typeof row.mergedInto === "string" && row.mergedInto) return { code: "INACTIVE", message: `${b.name} (${b.id}) was merged into ${row.mergedInto}` };
  const { [OTHER_THAN]: _skip, ...where } = b.where ?? {};
  const label = row && typeof row.name === "string" ? row.name : b.name;
  const now = deps.registry.resolver(b.entity)?.(deps.store, label, where).find((c) => c.id === b.id);
  if (!now) return { code: "CHANGED", message: `${b.name} (${b.id}) is no longer a ${b.entity} matching "${label}" here` };
  if (now.inactive) return { code: "INACTIVE", message: `${now.name} is ${now.inactive}` };
  if (fingerprint(now) !== b.fingerprint) return { code: "CHANGED", message: `${b.name} (${b.id}) changed since it was chosen (now ${now.detail ? `${now.name}, ${now.detail}` : now.name})` };
  return undefined;
}

/** A detail of exactly one candidate in the user's words ("Sarah Johnson at Brightside") picks it. */
export function narrowByRequest<T extends { detail?: string; name?: string }>(found: T[], request: string): T[] {
  // An email's words count too ("the gmail one" is sjohnson@gmail.example), except the words of the names themselves:
  // "Sarah" in sarah.johnson@ is no detail when the request is about Sarah Johnson.
  const words = (s: string) => plain(s.replace(/[@._+-]/g, " ")).split(" ");
  const said = ` ${plain(request.replace(/\s+/g, " "))} ${words(request).join(" ")} `;
  const names = new Set(found.flatMap((c) => words(c.name ?? "")));
  const partsOf = (c: T) => {
    const parts = (c.detail ?? "").split(",");
    return [...parts.map((p) => plain(p)), ...parts.filter((p) => p.includes("@")).flatMap(words).filter((w) => w.length > 2 && !names.has(w))].filter((p) => p.length > 1);
  };
  const shared = (p: string) => found.every((c) => partsOf(c).includes(p));
  const hit = found.filter((c) => partsOf(c).some((p) => !shared(p) && said.includes(` ${p} `)));
  return hit.length === 1 ? hit : found;
}
