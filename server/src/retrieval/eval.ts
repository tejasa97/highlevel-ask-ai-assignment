import { readFileSync } from "node:fs";
import type { Retriever } from "./retrieve.js";

// Scoring for the retrieval eval (eval/retrieval/queries.jsonl). Shared by the eval script and the
// regression test, so both measure the same thing.

export interface Query {
  id: string;
  group: string;
  q: string;
  /** Every entry must be retrieved; an entry that is a list is satisfied by any one of its ids. */
  need: (string | string[])[];
  context?: { prev?: string[]; entities?: string[] };
  split: "dev" | "test";
}

/** About 40% of questions are held out for reporting; tuning only looks at "dev". Stable per id. */
export function splitOf(id: string): "dev" | "test" {
  let h = 2166136261;
  for (const ch of id) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h % 5 < 2 ? "test" : "dev";
}

export function loadQueries(path: string): Query[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      const q = JSON.parse(l) as Omit<Query, "split">;
      return { ...q, split: splitOf(q.id) };
    });
}

export interface Scored {
  q: Query;
  /** k → share of needed entries present in the picks. */
  recall: Record<number, number>;
  /** Mean over needed entries of 1 / best rank in the merged ranking (0 if not ranked). */
  rr: number;
  picks: number;
  misses: { need: string[]; rank?: number }[];
  rejected: boolean;
  top: string[];
  ms: number;
}

export function score(q: Query, retriever: Retriever, ks: number[], resolvable: string[]): Scored {
  const groups = q.need.map((n) => (Array.isArray(n) ? n : [n]));
  const recall: Record<number, number> = {};
  let atDefault = retriever.retrieve({ message: q.q, context: q.context, resolvable }, { k: 15 });
  for (const k of ks) {
    const r = k === 15 ? atDefault : retriever.retrieve({ message: q.q, context: q.context, resolvable }, { k });
    const got = new Set(r.picks.map((p) => p.id));
    recall[k] = groups.length ? groups.filter((g) => g.some((id) => got.has(id))).length / groups.length : 1;
  }
  const rankOf = (g: string[]) => {
    const ranks = g.map((id) => atDefault.ranking.find((r) => r.id === id)?.rank).filter((r): r is number => r !== undefined);
    return ranks.length ? Math.min(...ranks) : undefined;
  };
  const got = new Set(atDefault.picks.map((p) => p.id));
  const misses = groups.filter((g) => !g.some((id) => got.has(id))).map((g) => ({ need: g, rank: rankOf(g) }));
  const rr = groups.length ? groups.reduce((s, g) => s + 1 / (rankOf(g) ?? Infinity), 0) / groups.length : 0;
  return {
    q,
    recall,
    rr,
    picks: atDefault.picks.length,
    misses,
    rejected: atDefault.noMatch,
    top: atDefault.ranking.slice(0, 3).map((r) => r.id),
    ms: atDefault.ms,
  };
}

export interface GroupReport {
  n: number;
  recall: Record<number, number>;
  /** Share of questions with every needed entry retrieved. */
  all: Record<number, number>;
  mrr: number;
  picks: number;
}

export function summarize(scored: Scored[], ks: number[]) {
  const inScope = scored.filter((s) => s.q.group !== "outside");
  const outside = scored.filter((s) => s.q.group === "outside");
  const agg = (xs: Scored[]): GroupReport => ({
    n: xs.length,
    recall: Object.fromEntries(ks.map((k) => [k, mean(xs.map((s) => s.recall[k]!))])),
    all: Object.fromEntries(ks.map((k) => [k, mean(xs.map((s) => (s.recall[k] === 1 ? 1 : 0)))])),
    mrr: mean(xs.map((s) => s.rr)),
    picks: mean(xs.map((s) => s.picks)),
  });
  const groups: Record<string, GroupReport> = {};
  for (const g of [...new Set(scored.map((s) => s.q.group))]) groups[g] = agg(scored.filter((s) => s.q.group === g));
  return {
    groups,
    total: agg(inScope),
    outside: { n: outside.length, rejected: outside.filter((s) => s.rejected).length },
    falseRejects: inScope.filter((s) => s.rejected).length,
    msPerQuery: mean(scored.map((s) => s.ms)),
  };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
