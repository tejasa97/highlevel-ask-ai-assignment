import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { createContext, runInContext } from "node:vm";
import { readHistory, type HistoryEntry } from "../eval/history.js";
import { parseJourney, render } from "./trajectory.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

describe("trajectory", () => {
  test("rendered browser script parses and embeds separated scenario groups", () => {
    const html = render({preface:"",entries:[]},[],"2026-10-22");
    const script=html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
    assert.doesNotThrow(()=>new Function(script));
    assert.match(script,/scenarioGroups/);
    assert.match(script,/No eligible 3× eval\/scenarios run/);
  });
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

  for (const costs of [[undefined], [0.02], [undefined, 0.02], [0]] as const) {
    test(`renders costs, journey entries and hover tips for ${costs.map((cost) => cost ?? "unavailable").join(", ")}`, () => {
      const history: HistoryEntry[] = costs.map((cost, i) => ({
        at: "2026-10-22T00:00:00Z", suite: "scenarios", label: `run-${i}`, git: null, set: "same",
        config: { planner: "codex-cli", tier: "fast", repeat: 1 },
        metrics: { measured: 1, runs: 1, infraRuns: 0, passRate: 100, allPass: 1, flaky: 0,
          e2eP50Ms: 1000, e2eP95Ms: 1500, plannerRoundsPerRun: 1,
          ...(cost === undefined ? {} : { costPerRunUsd: cost }) },
      }));
      const html = render({ preface: "", entries: history.map((h, i) => ({ n: i + 1, title: h.label, runs: [h.label], parts: [] })) }, history, "2026-10-22");
      // Execute the generated page script against a small DOM stub, including its hover handlers.
      const elements = new Map<string, ReturnType<typeof element>>();
      const hovers: (() => void)[] = [];
      function element() {
        let html = "", text = "";
        const children: any[] = [];
        return {
          get innerHTML() { return html + children.map(c => c.innerHTML).join(""); },
          set innerHTML(value: string) { html = value; children.length = 0; },
          get textContent() { return text + children.map(c => c.textContent).join(""); },
          set textContent(value: string) { text = value; children.length = 0; },
          append(...items: any[]) { children.push(...items); },
          replaceChildren() { children.length = 0; html = text = ""; },
          dataset: {} as Record<string,string>, clientWidth: 800, offsetWidth: 100, offsetHeight: 50, style: {},
          querySelectorAll: () => [],
          querySelector() {
            const hits = [...this.innerHTML.matchAll(/<rect data-i="(\d+)"/g)];
            return { firstChild: null, insertBefore() {}, querySelectorAll: () => hits.map((hit) => ({
              dataset: { i: hit[1] },
              addEventListener: (name: string, cb: (event: object) => void) => {
                if (name === "mousemove") hovers.push(() => cb({ clientX: 10, clientY: 10 }));
              },
            })) };
          },
        };
      }
      const context = createContext({
        document: {
          createElement: () => element(),
          getElementById(id: string) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id)!; },
          createElementNS: () => ({ style: {}, setAttribute() {} }),
        },
        window: { scrollX: 0, scrollY: 0, innerWidth: 1000 }, innerWidth: 1000, addEventListener() {},
      });
      runInContext(html.match(/<script>([\s\S]*?)<\/script>/)![1]!, context);
      const tips = hovers.map((hover) => { hover(); return elements.get("tip")!.innerHTML; });
      const output = [...elements.values()].map((el) => el.innerHTML + el.textContent).join("\n");
      assert.doesNotMatch(output, /NaN|undefined/);
      if (costs.some((cost) => cost === undefined)) {
        assert.match(elements.get("timeline")!.innerHTML, /USD unavailable/);
        assert.match(elements.get("table")!.innerHTML, /USD unavailable/);
      }
      if (costs.every((cost) => cost === undefined)) assert.match(elements.get("cost")!.textContent, /USD unavailable/);
      else {
        assert.match(elements.get("cost")!.innerHTML, /<circle/);
        assert.match(elements.get("tip")!.innerHTML, /\$[\d.]+ per run/);
        if (costs.some((cost) => cost === undefined)) assert.ok(tips.some((tip) => tip.includes("USD unavailable per run")));
      }
    });
  }
});
