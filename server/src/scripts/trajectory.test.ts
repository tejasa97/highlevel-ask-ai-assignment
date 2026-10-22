import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { readHistory } from "../eval/history.js";
import { parseJourney, render } from "./trajectory.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

describe("trajectory", () => {
  test("parses entries: number, title, commit, date, runs and labelled parts", () => {
    const { preface, entries } = parseJourney(
      "# Journey\n\nintro\n\n## 3. BM25 retrieval\n`d3d9942` · 2026-10-21 · runs: a → b\n\n**Problem.** Needs `cards`.\n\n**Result.** **82%** now.\n",
    );
    assert.match(preface, /intro/);
    assert.equal(entries.length, 1);
    const e = entries[0]!;
    assert.deepEqual([e.n, e.title, e.commit, e.date, e.runs], [3, "BM25 retrieval", "d3d9942", "2026-10-21", ["a", "b"]]);
    assert.deepEqual(e.parts, [
      { label: "Problem", html: "Needs <code>cards</code>." },
      { label: "Result", html: "<b>82%</b> now." },
    ]);
  });

  test("every run JOURNEY.md cites is in the history", () => {
    const labels = new Set(readHistory(ROOT).map((h) => h.label));
    const { entries } = parseJourney(readFileSync(`${ROOT}docs/JOURNEY.md`, "utf8"));
    for (const e of entries) for (const r of e.runs) assert.ok(labels.has(r), `entry ${e.n} cites run "${r}", which isn't in eval/results/history.jsonl`);
  });

  test("the embedded data can't close the script tag, and $ in it is kept as is", () => {
    const html = render({ preface: "", entries: [{ n: 1, title: "</script> $& $'", runs: [], parts: [] }] }, [], "2026-10-22");
    assert.ok(!html.includes("</script> $&"));
    assert.ok(html.includes("\\u003c/script> $& $'"));
  });
});
