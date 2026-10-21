// Retrieval-only eval: runs every question in eval/retrieval/queries.jsonl through the retriever (no LLM)
// and reports recall@k, all-needed@k, MRR and out-of-scope rejection, per group and per split.
//   npm run eval:retrieval                       held-out split, default settings
//   npm run eval:retrieval -- --split dev        tuning split (or "all")
//   npm run eval:retrieval -- --misses           list every miss with where the action ranked
//   npm run eval:retrieval -- --set k=20 moduleCap=3 boost.synonyms=3 fuzzy=off splitClauses=false
//   npm run eval:retrieval -- --no-mentions      ablation: names in questions aren't linked to records
//   npm run eval:retrieval -- --names-only       ablation: cards without synonyms or descriptions
//   npm run eval:retrieval -- --label baseline   also saves eval/results/retrieval-<label>.json
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadRegistry } from "../registry/registry.js";
import { buildCards } from "../retrieval/cards.js";
import { loadQueries, score, summarize, type Scored } from "../retrieval/eval.js";
import { mentions } from "../retrieval/mentions.js";
import { DEFAULTS, type RetrieveOptions, Retriever } from "../retrieval/retrieve.js";
import { world } from "../store/world.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const value = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const opts: Partial<RetrieveOptions> = {};
const setAt = argv.indexOf("--set");
if (setAt >= 0) {
  for (const kv of argv.slice(setAt + 1)) {
    if (kv.startsWith("--")) break;
    const [key, raw] = kv.split("=") as [string, string];
    const v: unknown = raw === "off" || raw === "false" ? false : raw === "true" ? true : raw.includes(",") ? raw.split(",").map(Number) : Number(raw);
    if (key.startsWith("boost.")) opts.boost = { ...DEFAULTS.boost, ...opts.boost, [key.slice(6)]: v };
    else (opts as Record<string, unknown>)[key] = v;
  }
}

const registry = await loadRegistry();
let cards = buildCards(registry);
if (flag("names-only")) cards = cards.map((c) => ({ ...c, synonyms: [], description: "" }));
const missingMeta = cards.filter((c) => !c.synonyms.length).length;
if (missingMeta && !flag("names-only")) console.log(`note: ${missingMeta} cards have no synonyms yet (npm run cards)\n`);

const retriever = new Retriever(cards, opts);
const split = value("split") ?? "test";
const queries = loadQueries(`${ROOT}eval/retrieval/queries.jsonl`).filter((q) => split === "all" || q.split === split);
const resolvable = registry.resolverEntities();
const KS = [5, 10, 15, 20, 25];

// Names are linked against the seed data, as the dev server links them against its database.
const { store } = world();
const linked = flag("no-mentions") ? undefined : (m: string) => mentions(m, registry, store);
const scored: Scored[] = queries.map((q) => score(q, retriever, KS, resolvable, linked));
const report = summarize(scored, KS);

const pct = (n: number) => `${(n * 100).toFixed(1)}%`.padStart(6);
console.log(`retrieval eval · split=${split} · ${queries.length} questions · ${cards.length} cards · settings ${JSON.stringify({ ...opts })}`);
console.log(`\n${"group".padEnd(11)} ${"n".padStart(3)}  ${KS.map((k) => `R@${k}`.padStart(6)).join(" ")}  ${"all@15".padStart(6)}  ${"MRR".padStart(5)}  ${"picks".padStart(5)}`);
for (const [group, g] of Object.entries(report.groups)) {
  if (group === "outside") continue;
  console.log(`${group.padEnd(11)} ${String(g.n).padStart(3)}  ${KS.map((k) => pct(g.recall[k]!)).join(" ")}  ${pct(g.all[15]!)}  ${g.mrr.toFixed(2).padStart(5)}  ${g.picks.toFixed(1).padStart(5)}`);
}
const t = report.total;
console.log(`${"ALL".padEnd(11)} ${String(t.n).padStart(3)}  ${KS.map((k) => pct(t.recall[k]!)).join(" ")}  ${pct(t.all[15]!)}  ${t.mrr.toFixed(2).padStart(5)}  ${t.picks.toFixed(1).padStart(5)}`);
console.log(`\nout of scope: ${report.outside.rejected}/${report.outside.n} rejected · in scope wrongly rejected: ${report.falseRejects}/${t.n} · ${report.msPerQuery.toFixed(2)} ms/question`);

if (flag("misses")) {
  console.log("\nmisses at k=15:");
  for (const s of scored) {
    for (const m of s.misses) console.log(`  ${s.q.id.padEnd(4)} ${m.need.join("|").padEnd(18)} best rank ${m.rank ?? "–"}  “${s.q.q}”`);
    if (s.q.group === "outside" && !s.rejected) console.log(`  ${s.q.id.padEnd(4)} not rejected (top ${s.top.join(", ")})  “${s.q.q}”`);
  }
}

const label = value("label");
if (label) {
  mkdirSync(`${ROOT}eval/results`, { recursive: true });
  const file = `${ROOT}eval/results/retrieval-${label}.json`;
  writeFileSync(file, JSON.stringify({ label, split, opts, at: new Date().toISOString(), report, questions: scored.map((s) => ({ id: s.q.id, misses: s.misses, rejected: s.rejected })) }, null, 1));
  console.log(`\nsaved ${file}`);
}
