import type { Registry } from "../registry/registry.js";
import type { Store } from "../store/db.js";
import { ENTITIES } from "../store/entities.js";
import { tableOf } from "../core/identity.js";

// Entity linking: which records the names in a message belong to. "What is Sarah Johnson's status?" never says
// "contact", so BM25 can't find the contact actions, and the planner can't tell Hiro Reyes the lead from a contact.
// Capitalized runs of words are looked up with the registry's resolvers; a name counts only when every one of
// its words is a whole word of the record's name (resolvers also match prefixes, which is too loose here).

export interface Mention {
  name: string;
  entity: string;
  count: number;
  /** The contact, named in the same message, whose record this is: "Starter" for Yusuf Silva is his subscription. */
  of?: string;
  /** Store id when NER (or another linker) uniquely linked this span. Never set for ambiguous. */
  linkedId?: string;
  /** True when NER found multiple candidates; count mirrors candidate size. */
  ambiguous?: boolean;
  /** Ambiguous NER candidates (id/name/detail); never auto-picked for writes. */
  candidates?: { id: string; name: string; detail?: string; entity?: string }[];
  /** Linking method when known (exact|embed|edit|rule). */
  method?: string;
  /** Best link score; informational only. */
  score?: number;
  /** NER found no exact name, only near misses (a typo, a partial): its candidates are "did you mean" suggestions. */
  suggestion?: boolean;
  /** Records that carry this name as text in a field named after a record type: Stark is the company of 5 contacts. */
  inField?: { table: string; field: string; count: number }[];
}

/** Record types whose names are titles, not names of people or teams: too noisy to link. */
const SKIP = new Set(["task"]);

export function mentions(message: string, registry: Registry, store: Store): Mention[] {
  const out: Mention[] = [];
  const link = (name: string) => {
    const words = norm(name).split(" ");
    let found = false;
    for (const entity of registry.resolverEntities()) {
      if (SKIP.has(entity)) continue;
      const resolver = registry.resolver(entity)!;
      if (resolver.parentQualifiers?.length) continue; // A child label alone cannot identify its parent.
      const hits = resolver(store, name).filter((c) => {
        if (c.inactive) return false;
        if (resolver.exactMention) return norm(c.name) === norm(name);
        const have = norm(c.name).split(" ");
        return words.every((w) => have.includes(w));
      });
      if (!hits.length) continue;
      found = true;
      if (!out.some((m) => m.name === name && m.entity === entity)) out.push({ name, entity, count: hits.length });
    }
    return found;
  };
  // A run that opens a sentence may start with an ordinary word: "Call Ana Ruiz" → try "Ana Ruiz" if nothing matched.
  // Only there: mid-sentence, "Jo Park" is one name, and an unknown Jo Park mustn't link to some user Park.
  const runs = nameRuns(message);
  for (const { name, opens } of runs) if (!link(name) && opens && name.includes(" ")) link(name.slice(name.indexOf(" ") + 1));
  // "Text sjohnson@gmail.example": an exact email names its record as surely as a full name does.
  for (const email of message.match(/[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+\.[a-z]{2,}/gi) ?? []) {
    const key = email.toLowerCase();
    for (const entity of registry.resolverEntities()) {
      const table = tableOf(entity);
      const resolver = registry.resolver(entity)!;
      if (!table || resolver.parentQualifiers?.length) continue;
      const hits = store.all<Record<string, unknown>>(table)
        .filter((r) => typeof r.email === "string" && r.email.toLowerCase() === key && typeof r.name === "string")
        .filter((r) => resolver(store, r.name as string).some((c) => c.id === r.id && !c.inactive));
      if (hits.length) out.push({ name: email, entity, count: hits.length, ...(hits.length === 1 ? { linkedId: hits[0]!.id as string } : {}) });
    }
  }
  // Records with no name of their own (a subscription, a quote) are named by their owner and what they hold.
  // "Move Yusuf Silva from Starter to Pro": Starter alone is a product, but Yusuf's Starter is his subscription.
  for (const owner of out.filter((m) => m.entity === "contact" && m.count === 1).map((m) => m.name)) {
    for (const { name } of runs) {
      if (name === owner || owner.includes(name)) continue;
      const words = norm(name).split(" ");
      for (const entity of registry.resolverEntities()) {
        const resolver = registry.resolver(entity)!;
        if (!resolver.qualifiers?.includes("contact")) continue;
        const hits = resolver(store, name, { contact: owner }).filter((c) => !c.inactive && words.every((w) => norm(c.name).split(" ").includes(w)));
        if (hits.length && !out.some((m) => m.name === name && m.entity === entity)) out.push({ name, entity, count: hits.length, of: owner });
      }
    }
  }
  return out;
}

/** "What is Sarah Johnson's status?" → "What" (opens a sentence), "Sarah Johnson". */
export function nameRuns(message: string): { name: string; opens: boolean }[] {
  return [...message.matchAll(/(?<![\p{L}\p{N}])\p{Lu}[\p{L}'’-]*(?:\s+\p{Lu}[\p{L}'’-]*)*/gu)].map((m) => ({
    name: m[0].replace(/['’]s\b/g, "").replace(/['’]$/, ""),
    opens: /(^|[.!?:;\n]\s*)$/.test(message.slice(0, m.index)),
  }));
}

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();

/**
 * "How many contacts work at Stark?" when a company is only a contact's text field, not a company record: the mention
 * says which records carry the name there, so the planner searches them by it instead of resolving a record.
 */
export function withTextFields(named: Mention[], registry: Registry, store: Store): Mention[] {
  const fields = registry.resolverEntities();
  const found = new Map<string, Mention["inField"]>();
  const of = (name: string) => {
    const key = norm(name);
    if (!found.has(key)) {
      const hits: NonNullable<Mention["inField"]> = [];
      for (const table of Object.keys(ENTITIES)) {
        const records = store.all<Record<string, unknown>>(table);
        for (const field of fields) {
          const count = records.filter((r) => typeof r[field] === "string" && norm(r[field] as string) === key).length;
          if (count) hits.push({ table, field, count });
        }
      }
      found.set(key, hits);
    }
    return found.get(key)!;
  };
  return named.map((m) => (m.of || m.linkedId ? m : of(m.name)!.length ? { ...m, inField: of(m.name) } : m));
}
