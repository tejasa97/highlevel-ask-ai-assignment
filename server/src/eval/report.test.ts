import assert from "node:assert/strict";
import { test } from "node:test";
import { GROUPS, groupStats, quantile, renderReport, type Targets, verdict } from "./report.js";
import { type Scenario, ScenarioSchema, type ScenarioRun } from "./scenario.js";

const scenario = (id: string, category: Scenario["category"], expect: object = {}): Scenario => ScenarioSchema.parse({ id, category, modules: ["M01"], turns: [{ user: "hi" }], expect });

function run(id: string, category: Scenario["category"], o: { pass?: boolean; kinds?: string[]; infra?: string; ms?: number; first?: number; rounds?: number; cost?: number } = {}): ScenarioRun {
  const kinds = o.kinds ?? (o.pass === false ? ["status"] : []);
  return {
    id,
    category,
    pass: !o.infra && kinds.length === 0,
    ...(o.infra ? { infra: o.infra } : {}),
    failures: kinds.map((kind) => ({ kind, detail: "x" })),
    turns: [],
    metrics: { ms: o.ms ?? 1000, firstReplyMs: o.first ?? 500, plannerMs: 0, plannerRounds: o.rounds ?? 1, calls: 1, usage: { input: 100, cachedRead: 40, cacheWrite: 0, output: 10, thinking: 0, costUsd: o.cost ?? 0.01, billing: "none" } },
  };
}

const defs = new Map(
  [
    scenario("d1", "direct", { actions: { includes: ["M01.A01"] }, args: [{ action: "M01.A01", match: {} }], state: [{ sql: "SELECT 1", equals: 1 }] }),
    scenario("m1", "multi", { actions: { includes: ["M06.A01"] } }),
    scenario("u1", "unsupported", { noChanges: true }),
  ].map((s) => [s.id, s]),
);

test("rates count only the runs of scenarios that check that thing, and leave infra runs out", () => {
  const runs = [run("d1", "direct"), run("d1", "direct", { kinds: ["args"] }), run("m1", "multi", { kinds: ["action-missing"] }), run("u1", "unsupported", { kinds: ["changes"] }), run("u1", "unsupported", { infra: "timeout" })];
  const g = groupStats(runs, defs, GROUPS.all);
  assert.deepEqual(g.success, { ok: 1, of: 4 });
  assert.deepEqual(g.actions, { ok: 2, of: 3 }); // d1 twice, m1 once; u1 checks no actions
  assert.deepEqual(g.args, { ok: 1, of: 2 });
  assert.deepEqual(g.state, { ok: 2, of: 3 }); // d1 twice, u1's clean run changed data
});

test("cost per success divides everything spent, infra and failed runs included, by the passes", () => {
  const runs = [run("d1", "direct", { cost: 0.02 }), run("d1", "direct", { pass: false, cost: 0.03 }), run("d1", "direct", { infra: "timeout", cost: 0.01 })];
  const g = groupStats(runs, defs, GROUPS.direct);
  assert.equal(g.costUsd.total!.toFixed(2), "0.06");
  assert.equal(g.costUsd.perSuccess!.toFixed(2), "0.06");
  assert.equal(g.costUsd.perRun!.toFixed(2), "0.02");
  assert.equal(groupStats([run("d1", "direct", { pass: false })], defs, GROUPS.direct).costUsd.perSuccess, null);
});

test("groups split latency: direct and complex don't mix", () => {
  const runs = [run("d1", "direct", { first: 1000, ms: 1000 }), run("m1", "multi", { first: 4000, ms: 9000, rounds: 3 })];
  assert.equal(groupStats(runs, defs, GROUPS.direct).firstReplyMs.p50, 1000);
  assert.equal(groupStats(runs, defs, GROUPS.complex).e2eMs.p95, 9000);
  assert.equal(groupStats(runs, defs, GROUPS.complex).modelCalls.p50, 3);
  assert.equal(quantile([], 0.5), 0);
  assert.equal(quantile([3, 1, 2, 4], 0.5), 3);
});

test("unknown subscription costs propagate through benchmark totals and cost per success", () => {
  const subscription = run("d1", "direct");
  subscription.metrics.usage.costUsd = null;
  subscription.metrics.usage.billing = "subscription";
  const g = groupStats([run("d1", "direct"), subscription], defs, GROUPS.direct);
  assert.deepEqual(g.costUsd, { total: null, perRun: null, perSuccess: null, listRate: false });
});

test("prepaid runs of one model with a list rate are priced from their tokens and marked as list rate", () => {
  const prepaid = (models: string[]) => {
    const r = run("d1", "direct");
    Object.assign(r.metrics.usage, { input: 10_000, output: 200, thinking: 100, costUsd: null, billing: "subscription" });
    return { ...r, models };
  };
  const g = groupStats([prepaid(["deepseek-v4.1-flash-1017"]), prepaid(["deepseek-v4.1-flash-1017"])], defs, GROUPS.direct);
  // 10,000 input at $0.30/M plus 300 output and thinking at $1.20/M, twice.
  assert.equal(g.costUsd.total!.toFixed(5), "0.00672");
  assert.equal(g.costUsd.perSuccess!.toFixed(5), "0.00336");
  assert.equal(g.costUsd.listRate, true);
  // A model without a rate, or a run that mixed models, still leaves the total unknown.
  assert.equal(groupStats([prepaid(["qwen-unpriced"])], defs, GROUPS.direct).costUsd.total, null);
  assert.equal(groupStats([prepaid(["deepseek-v4.1-flash-1017", "qwen-unpriced"])], defs, GROUPS.direct).costUsd.total, null);
});

test("a target is judged only when committed on or before the run's date", () => {
  const t = { name: "x", group: "direct" as const, metric: "firstReplyP50Ms" as const, max: 1500 };
  assert.equal(verdict(t, 1200, null, "2026-10-22T07:00:00Z"), "not judged");
  assert.equal(verdict(t, 1200, "2026-10-23", "2026-10-22T07:00:00Z"), "not judged");
  assert.equal(verdict(t, 1200, "2026-10-22", "2026-10-22T07:00:00Z"), "met");
  assert.equal(verdict(t, 1600, "2026-10-21", "2026-10-22T07:00:00Z"), "missed");
  assert.equal(verdict(t, null, "2026-10-21", "2026-10-22T07:00:00Z"), "no data");
});

test("the report lists every failing run and warns when the scenario files changed", () => {
  const targets: Targets = { committed: null, targets: [{ name: "Direct p50", group: "direct", metric: "firstReplyP50Ms", max: 1500 }] };
  const md = renderReport({
    measured: [
      {
        result: { summary: { label: "a", planner: "claude-cli", tier: "strong", scenarios: 2, repeat: 1, runs: 2, infraRuns: 0, notRun: 0 }, runs: [run("d1", "direct"), run("m1", "multi", { kinds: ["action-missing"] })] },
        entry: { at: "2026-10-22T07:00:00Z", suite: "scenarios", label: "a", git: { sha: "abc1234", dirty: false }, set: "old", config: {}, metrics: {} },
      },
    ],
    defs: [...defs.values()],
    setNow: "new",
    targets,
    coverage: { implemented: 150, modules: 15, catalogActions: 500, catalogModules: 50 },
    built: "2026-10-22",
  });
  assert.match(md, /\| m1 \| multi \| action-missing: x \|/);
  assert.match(md, /Warning:\*\* the scenario files changed/);
  assert.match(md, /\| Direct p50 \| ≤ 1\.5 s \| 0\.5 s \| not judged \|/);
  assert.match(md, /150 of 500 catalog actions/);
});
