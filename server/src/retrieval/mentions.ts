import type { Registry } from "../registry/registry.js";
import type { Store } from "../store/db.js";

// Entity linking: which records the names in a message belong to. "What is Sarah Johnson's status?" never says
// "contact", so BM25 can't find the contact actions, and the planner can't tell Hiro Reyes the lead from a contact.
// Capitalized runs of words are looked up with the registry's resolvers; a name counts only when every one of
// its words is a whole word of the record's name (resolvers also match prefixes, which is too loose here).

export interface Mention {
  name: string;
  entity: string;
  count: number;
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
  for (const { name, opens } of nameRuns(message)) if (!link(name) && opens && name.includes(" ")) link(name.slice(name.indexOf(" ") + 1));
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
