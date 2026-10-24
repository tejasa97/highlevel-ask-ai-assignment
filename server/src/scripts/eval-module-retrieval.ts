// Development-only retrieval ablation. Never reads reporting scenarios. This measures tool availability,
// not planner correctness: for follow-ups it unions independently retrieved turns without guessed state.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { selectScenarios } from "../eval/selection.js";
import { fingerprint, gitState } from "../eval/history.js";
import { loadRegistry } from "../registry/registry.js";
import { card } from "../registry/card.js";
import { buildCards } from "../retrieval/cards.js";
import { Embedder } from "../retrieval/embed.js";
import { mentions } from "../retrieval/mentions.js";
import { Retriever } from "../retrieval/retrieve.js";
import { world } from "../store/world.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const regression = process.argv.includes("--regression");
const selection = selectScenarios(root, regression ? "eval/scenarios" : "eval/module-scenarios/m45-m47/development");
const registry = await loadRegistry();
const cards = buildCards(registry);
const dense = await Embedder.load(cards); // Fail, rather than silently calling a BM25 run hybrid.
const { store } = world();
const pairs = [
  ["M47.A08", "M13.A03"],
  ["M47.A08", "M12.A03"],
  ["M47.A07", "M07.A01"],
  ["M47.A04", "M06.A05"],
  ["M47.A04", "M01.A07"],
  ["M45.A09", "M46.A09"],
];
for (const pair of pairs)
  for (const id of pair) assert.ok(registry.get(id), id);
const variants: {name:string; pairs:string[][]; forward?:string[][]}[] = [
  { name: "existing-links", pairs: [] as string[][] },
  ...pairs.map((pair) => ({ name: pair.join("<->"), pairs: [pair] })),
  { name: "all-candidates", pairs },
  { name: "team-strategy->workload", pairs: [], forward: [["M49.A08", "M49.A09"]] },
];
// Inference is independent of sibling links. Compute once and reuse byte-identical rankings.
const original = new Retriever(cards, {}, dense);
const inputs = await Promise.all(
  selection.scenarios.map(async (s) => ({
    scenario: s,
    turns: await Promise.all(
      s.turns.map((t) =>
        original.prepare({
          message: t.user,
          resolvable: registry.resolverEntities(),
          mentions: mentions(t.user, registry, store),
        }),
      ),
    ),
  })),
);
const results = variants.map((v) => {
  const modified = cards.map((c) => ({
    ...c,
    siblings: [
      ...new Set([
        ...c.siblings,
        ...v.pairs.flatMap(([a, b]) =>
          c.id === a ? [b!] : c.id === b ? [a!] : [],
        ),
        ...(v.forward ?? []).flatMap(([a,b]) => c.id === a ? [b!] : []),
      ]),
    ],
  }));
  const retriever = new Retriever(modified);
  const cases = inputs.map(({ scenario: s, turns }) => {
    const picked = turns.map((t) => retriever.retrieve(t).picks);
    const offered = new Set(picked.flat().map((p) => p.id));
    const need = s.expect.actions?.includes ?? [];
    return {
      id: s.id,
      need,
      missing: need.filter((id) => !id.split("|").some((x) => offered.has(x))),
      picks: picked.map((p) => p.length),
      chars: picked.map(
        (p) =>
          p
            .flatMap((x) =>
              registry.get(x.id) ? [card(registry.get(x.id)!)] : [],
            )
            .join("\n").length,
      ),
    };
  });
  const needs = cases.flatMap((c) => c.need),
    misses = cases.flatMap((c) => c.missing);
  const picks = cases.flatMap((c) => c.picks),
    chars = cases.flatMap((c) => c.chars);
  return {
    variant: v.name,
    recall: (needs.length - misses.length) / needs.length,
    allNeeded: cases.filter((c) => !c.missing.length).length / cases.length,
    meanPicks: picks.reduce((a, b) => a + b, 0) / picks.length,
    maxPicks: Math.max(...picks),
    meanPromptChars: chars.reduce((a, b) => a + b, 0) / chars.length,
    cases,
  };
});
const report = {
  at: new Date().toISOString(),
  git: gitState(root),
  folder: selection.scenarioDir,
  set: fingerprint(JSON.stringify(selection.scenarios)),
  mode: "hybrid",
  note: "development tool availability, not task pass rate; no reporting cases read",
  results,
};
const file = `${root}eval/results/retrieval-m45-m47-${regression ? "regression" : "development"}-ablation-${report.set}.json`;
writeFileSync(file, JSON.stringify(report, null, 2));
console.table(results.map(({ cases, ...r }) => r));
console.log(
  JSON.stringify(
    results[0]!.cases.filter((c) => c.missing.length),
    null,
    2,
  ),
);
console.log(`saved ${file}`);
