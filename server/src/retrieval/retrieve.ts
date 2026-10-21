import MiniSearch, { type SearchResult } from "minisearch";
import { clauses, terms } from "./text.js";
import type { SearchCard } from "./cards.js";

// Tool retrieval: narrows the 500 catalog actions to a short list for the planner. No LLM involved.
//   1. BM25 (MiniSearch) over each card's name, synonyms, module and description, on the whole message
//      and on each clause of a multi-part message; with an embedding model loaded (embed.ts), its
//      meaning-based ranking of the same texts too. Each clause's top few BM25 hits go first, taking turns;
//      the rest follow in reciprocal-rank-fusion order.
//   2. Walk the merged ranking with a per-module cap until k cards are picked.
//   3. Add what the planner will need next to them: look-alike siblings, a producer for any record type
//      a picked card needs but nothing picked returns, and the previous turn's actions.

export interface RetrieveOptions {
  k: number;

  /** Most cards one module may take from the ranked slots. */
  moduleCap: number;
  /** Per-field BM25 weights. */
  boost: Record<Field, number>;
  /** Edit distance for typos, by term length: [min length for 1 edit, min length for 2 edits]. */
  fuzzy: [number, number] | false;
  /** Retrieve per clause as well as on the whole message. */
  splitClauses: boolean;
  /** Each clause's best this-many go first, taking turns, so one part of a request can't crowd out another. */
  perClause: number;
  /** Add look-alike siblings for the best this-many ranked picks (0 = off). */
  siblings: number;
  producers: boolean;
  /** Cards scoring under this share of the top score are dropped from the ranked slots. */
  floor: number;
  /** A top BM25 score under this means nothing in the catalog matched. Deliberately low: words like "book" or
   *  "order" match real actions, so telling off-topic requests apart is the planner's job, not retrieval's. */
  noMatchScore: number;
  /** How much of each meaning-based ranking joins the fusion, and its weight against one BM25 list. */
  denseTop: number;
  denseWeight: number;
  /** Cards in the top this-many of a meaning ranking skip the score floor: they share no words with the
   *  question, so their BM25 score says nothing about them. */
  denseFloorExempt: number;
}

export type Field = "name" | "synonyms" | "module" | "description";

export const DEFAULTS: RetrieveOptions = {
  k: 15,
  moduleCap: 6,
  boost: { name: 3, synonyms: 2, module: 1.5, description: 1 },
  fuzzy: [5, 9],
  splitClauses: true,
  perClause: 2,
  siblings: 3,
  producers: true,
  floor: 0.1,
  noMatchScore: 2,
  denseTop: 20,
  denseWeight: 1,
  denseFloorExempt: 10,
};

export interface RetrieveInput {
  message: string;
  /** Short follow-ups lean on the previous turn: its actions are carried over, its record types join the query. */
  context?: { prev?: string[]; entities?: string[] };
  /** Ids already offered (a search_tools round asks for something new). */
  exclude?: string[];
  /** Record types the planner can resolve by name, so they never need a producer card. */
  resolvable?: string[];
  /** Names in the message that matched records (see mentions.ts): their record type's get and search join. */
  mentions?: { entity: string }[];
  /** Meaning-based rankings of the cards for the query and then each clause, in that order (see prepare). */
  dense?: { id: string }[][];
}

/** Ranks every card by meaning for each text (embed.ts). */
export interface Dense {
  rank(texts: string[]): Promise<{ id: string; score: number }[][]>;
}

/** "bm25" and "dense" are the ranked slots: "dense" when only the embedding ranking found the card. */
export type Why = "bm25" | "dense" | "sibling" | "producer" | "carried" | "mention";

export interface Pick {
  id: string;
  why: Why;
  /** Position in the merged ranking (1-based), when it was ranked at all. */
  rank?: number;
  score?: number;
  /** Query terms that matched this card, by field. */
  matched?: Record<string, string[]>;
  /** For siblings and producers: the pick that pulled it in. */
  via?: string;
}

export interface Retrieval {
  query: string;
  clauses: string[];
  terms: string[];
  picks: Pick[];
  /** The merged ranking before caps and additions, for evals and the debug view. */
  ranking: { id: string; score: number; rank: number }[];
  topScore: number;
  noMatch: boolean;
  ms: number;
}

export class Retriever {
  private readonly search: MiniSearch<SearchCard>;
  private readonly byId: Map<string, SearchCard>;
  private readonly opts: RetrieveOptions;

  constructor(
    readonly cards: SearchCard[],
    opts: Partial<RetrieveOptions> = {},
    private readonly dense?: Dense,
  ) {
    this.opts = { ...DEFAULTS, ...opts, boost: { ...DEFAULTS.boost, ...opts.boost } };
    this.byId = new Map(cards.map((c) => [c.id, c]));
    this.search = new MiniSearch<SearchCard>({
      fields: ["name", "synonyms", "module", "description"],
      storeFields: [],
      extractField: (doc, field) => {
        if (field === "synonyms") return doc.synonyms.join(" ; ");
        if (field === "module") return `${doc.module} ${doc.moduleDescription}`;
        return (doc as unknown as Record<string, string>)[field] ?? "";
      },
      tokenize: (text) => terms(text),
      processTerm: (t) => t,
    });
    this.search.addAll(cards);
  }

  card(id: string): SearchCard | undefined {
    return this.byId.get(id);
  }

  /** Whether an embedding model is loaded. */
  get hybrid(): boolean {
    return !!this.dense;
  }

  /** Adds the meaning-based rankings to an input; unchanged without a model. Separate from retrieve because
   *  the model is async and retrieve is not. */
  async prepare(input: RetrieveInput): Promise<RetrieveInput> {
    if (!this.dense || input.dense) return input;
    const { query, parts } = this.texts(input, this.opts);
    try {
      return { ...input, dense: await this.dense.rank(parts.length > 1 ? [query, ...parts] : [query]) };
    } catch (e) {
      // A failed inference costs this turn its embedding half, not the turn itself.
      console.error(`embedding failed, this turn uses BM25 only: ${(e as Error).message}`);
      return input;
    }
  }

  retrieve(input: RetrieveInput, override: Partial<RetrieveOptions> = {}): Retrieval {
    const started = performance.now();
    const o = { ...this.opts, ...override, boost: { ...this.opts.boost, ...override.boost } };
    const exclude = new Set(input.exclude ?? []);
    const { query, parts } = this.texts(input, o);
    const lists = [this.run(query, o), ...(parts.length > 1 ? parts.map((p) => this.run(p, o)) : [])];
    const dense = (input.dense ?? []).map((d) => d.filter((x) => this.byId.has(x.id)).slice(0, o.denseTop));
    const floorExempt = new Set(dense.flatMap((d) => d.slice(0, o.denseFloorExempt).map((x) => x.id)));

    // Reciprocal rank fusion: ranks only, so the whole message, short clauses and the two kinds of ranking
    // weigh in alike. `best` is the card's best BM25 hit; cards only the embedding ranking found have none.
    const fused = new Map<string, { score: number; best?: SearchResult }>();
    const fuse = (ids: { id: string; hit?: SearchResult }[], weight: number) =>
      ids.forEach(({ id, hit }, i) => {
        const f = fused.get(id) ?? fused.set(id, { score: 0 }).get(id)!;
        f.score += weight / (60 + i + 1);
        if (hit && hit.score > (f.best?.score ?? -1)) f.best = hit;
      });
    for (const list of lists) fuse(list.map((hit) => ({ id: hit.id as string, hit })), 1);
    for (const list of dense) fuse(list, o.denseWeight);
    // RRF alone lets a card that is middling in several lists beat the clear winner of one clause
    // ("find leads from facebook" → Search leads ranked 20th behind team and task actions).
    const first: string[] = [];
    for (let r = 0; r < o.perClause; r++) {
      for (const list of lists.slice(1)) {
        const id = list[r]?.id as string | undefined;
        if (id && !first.includes(id)) first.push(id);
      }
    }
    const order = (id: string) => (first.includes(id) ? first.indexOf(id) : Infinity);
    const merged = [...fused.entries()]
      .filter(([id]) => !exclude.has(id))
      .sort((a, b) => order(a[0]) - order(b[0]) || b[1].score - a[1].score || bm25(b[1]) - bm25(a[1]));
    const ranking = merged.map(([id, f], i) => ({ id, score: round(bm25(f)), rank: i + 1 }));
    const topScore = lists[0]![0]?.score ?? 0;
    // A message that names a known record is about the CRM even with no catalog words ("tell me about Victor Larsen").
    const noMatch = topScore < o.noMatchScore && !input.mentions?.length;

    // Ranked slots: module cap and score floor.
    const picks: Pick[] = [];
    const taken = new Set<string>();
    const perModule = new Map<string, number>();
    const floor = o.floor * Math.max(...merged.map(([, f]) => bm25(f)), 0);
    const capped: typeof merged = [];
    const take = ([id, f]: (typeof merged)[number]) => {
      const rank = ranking.find((r) => r.id === id)!.rank;
      picks.push(f.best ? { id, why: "bm25", rank, score: round(f.best.score), matched: byField(f.best) } : { id, why: "dense", rank });
      taken.add(id);
    };
    for (const entry of merged) {
      if (picks.length >= o.k) break;
      const [id, f] = entry;
      if (bm25(f) < floor && !floorExempt.has(id)) continue;
      const mod = id.slice(0, 3);
      if ((perModule.get(mod) ?? 0) >= o.moduleCap) {
        capped.push(entry);
        continue;
      }
      perModule.set(mod, (perModule.get(mod) ?? 0) + 1);
      take(entry);
    }
    // The cap makes room for other modules. When nothing else clears the floor, that room would sit empty:
    // give it back to the capped cards ("answer the 2-star review" is all about reviews).
    for (const entry of capped) if (picks.length < o.k) take(entry);
    if (noMatch) picks.length = 0;

    const add = (id: string, why: Why, via?: string) => {
      if (taken.has(id) || exclude.has(id) || !this.byId.has(id)) return;
      taken.add(id);
      const r = ranking.find((x) => x.id === id);
      picks.push({ id, why, ...(via ? { via } : {}), ...(r ? { rank: r.rank, score: r.score } : {}) });
    };

    for (const id of input.context?.prev ?? []) add(id, "carried");

    // "What is Sarah Johnson's status?" names a contact without saying so: offer the contact lookups.
    for (const entity of new Set((input.mentions ?? []).map((m) => m.entity))) {
      for (const id of this.lookupsFor(entity)) add(id, "mention", entity);
    }

    // Siblings only for the strongest picks: for weak ones they mostly add noise to the prompt.
    for (const p of picks.filter((x) => x.why === "bm25" || x.why === "dense").slice(0, o.siblings)) {
      for (const s of this.byId.get(p.id)!.siblings) add(s, "sibling", p.id);
    }

    if (o.producers) {
      // A picked card needs an id of some record type that no picked card returns and that can't be
      // resolved by name: add the best-ranked card that produces it (a search or list action, usually).
      const resolvable = new Set(input.resolvable ?? []);
      for (const p of [...picks]) {
        for (const need of this.byId.get(p.id)!.consumes) {
          if (resolvable.has(need) || picks.some((q) => this.byId.get(q.id)!.produces === need)) continue;
          const producer = this.producerFor(need, ranking);
          if (producer) add(producer, "producer", p.id);
        }
      }
    }

    return { query, clauses: parts, terms: terms(query), picks, ranking: ranking.slice(0, 50), topScore: round(topScore), noMatch, ms: round(performance.now() - started) };
  }

  /** The whole-message query and the clauses, shared by BM25 and the embedding model. */
  private texts(input: RetrieveInput, o: RetrieveOptions): { query: string; parts: string[] } {
    // Record types from the previous turn join the query, so "make those high priority" knows it means tasks.
    const query = [input.message, ...(input.context?.entities ?? []).map((e) => e.replace(/_/g, " "))].join(" ");
    return { query, parts: o.splitClauses ? clauses(input.message) : [] };
  }

  private run(text: string, o: RetrieveOptions): SearchResult[] {
    const [one, two] = o.fuzzy || [Infinity, Infinity];
    return this.search.search(text, {
      boost: o.boost,
      combineWith: "OR",
      fuzzy: (term) => (term.length >= two ? 2 : term.length >= one ? 1 : false) as number,
      weights: { fuzzy: 0.45, prefix: 0.375 },
    });
  }

  /** The get and search actions for a record type. */
  private lookupsFor(type: string): string[] {
    const producers = this.cards.filter((c) => c.produces === type && c.available);
    return ["get", "search"].flatMap((verb) => producers.find((c) => new RegExp(`^${verb}\\b`, "i").test(c.name))?.id ?? []);
  }

  /** Prefer a producer the query already ranked; otherwise the module's search/list action for that type. */
  private producerFor(type: string, ranking: { id: string }[]): string | undefined {
    const producers = this.cards.filter((c) => c.produces === type);
    if (!producers.length) return undefined;
    const ranked = ranking.find((r) => producers.some((p) => p.id === r.id));
    if (ranked) return ranked.id;
    return (producers.find((p) => /^(search|list)\b/i.test(p.name)) ?? producers[0])!.id;
  }
}

function byField(r: SearchResult): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [term, fields] of Object.entries(r.match)) for (const f of fields) (out[f] ??= []).push(term);
  return out;
}

const bm25 = (f: { best?: SearchResult }) => f.best?.score ?? 0;
const round = (n: number) => Math.round(n * 100) / 100;
