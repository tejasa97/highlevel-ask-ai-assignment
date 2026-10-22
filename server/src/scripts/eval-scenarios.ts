// Runs the end-to-end scenarios (eval/scenarios/*.json) against the real planner and reports pass rates,
// failure kinds, latency, cost and calls. Each run starts from a fresh seeded database. Runs the planner couldn't
// serve (quota, timeout, provider down) are "infra": counted apart, never in the pass rate. Hitting the quota stops
// the run, since every later job would fail the same way. A run with --label is also recorded in
// eval/results/history.jsonl, unless it's a spot check (--only) or no run reached the app.
// Run: npm run eval:scenarios -- [--repeat 3] [--concurrency 4] [--only id-or-prefix,...] [--label name] [--fast]
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { appendHistory, fingerprint, gitState } from "../eval/history.js";
import { loadScenarios, runScenario, type ScenarioRun } from "../eval/scenario.js";
import { makePlanner } from "../planner/index.js";
import { loadRegistry } from "../registry/registry.js";
import { buildCards } from "../retrieval/cards.js";
import { loadDense } from "../retrieval/embed.js";
import { Retriever } from "../retrieval/retrieve.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const EVAL = `${ROOT}eval/`;
const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const repeat = Number(opt("repeat") ?? 1);
const concurrency = Number(opt("concurrency") ?? 4);
const only = opt("only")?.split(",");
const label = opt("label") ?? "latest";
const tier = args.includes("--fast") ? "fast" : "strong";

const registry = await loadRegistry();
const cards = buildCards(registry);
const retriever = new Retriever(cards, {}, await loadDense(cards, () => {}));
const planner = makePlanner();
const scenarios = loadScenarios(`${EVAL}scenarios`).filter((s) => !only || only.some((o) => s.id.startsWith(o)));
if (!scenarios.length) {
  console.error("no scenarios match");
  process.exit(2);
}

const jobs = scenarios.flatMap((s) => Array.from({ length: repeat }, () => s));
const runs: ScenarioRun[] = [];
let next = 0;
let quotaHit = false;
const started = performance.now();
console.log(`${scenarios.length} scenarios × ${repeat} on ${planner.name} (${tier}), ${concurrency} at a time\n`);
await Promise.all(
  Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (next < jobs.length) {
      const s = jobs[next++]!;
      const r = await runScenario(s, { registry, planner, retriever, tier });
      runs.push(r);
      if (r.infra === "rate_limited" && !quotaHit) {
        quotaHit = true;
        next = jobs.length;
        console.log(`\nquota hit: stopping; ${jobs.length - runs.length} runs not started\n`);
      }
      console.log(`${r.infra ? "INFRA" : r.pass ? "pass" : "FAIL"}  ${r.id.padEnd(34)} ${String(r.metrics.ms).padStart(6)} ms${r.pass ? "" : `  ${r.failures.map((f) => `${f.kind}: ${f.detail}`).join(" · ")}`}`);
    }
  }),
);

// --- report ---------------------------------------------------------------------------------
const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "-");
const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))]! : 0;
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

// Everything below measures the app, so it's over clean runs (no infra failure); only the total cost counts every run.
const clean = runs.filter((r) => !r.infra);
console.log("\nper scenario (passes / clean runs):");
const byId = new Map<string, ScenarioRun[]>();
for (const r of clean) byId.set(r.id, [...(byId.get(r.id) ?? []), r]);
for (const s of scenarios) {
  const rs = byId.get(s.id) ?? [];
  const passed = rs.filter((r) => r.pass).length;
  const infra = runs.filter((r) => r.id === s.id && r.infra).length;
  console.log(`  ${`${passed}/${rs.length}`.padEnd(5)} ${s.id.padEnd(34)} ${s.category}${infra ? `  (+${infra} infra)` : ""}`);
}

console.log("\nby category:");
for (const cat of [...new Set(scenarios.map((s) => s.category))]) {
  const rs = clean.filter((r) => r.category === cat);
  console.log(`  ${cat.padEnd(12)} ${pct(rs.filter((r) => r.pass).length, rs.length).padStart(4)}  (${rs.length} runs)`);
}

const kinds = new Map<string, number>();
for (const r of clean) for (const k of new Set(r.failures.map((f) => f.kind))) kinds.set(k, (kinds.get(k) ?? 0) + 1);
if (kinds.size) console.log(`\nfailing runs by check: ${[...kinds].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ")}`);

const passRate = clean.length ? clean.filter((r) => r.pass).length / clean.length : 0;
const ms = clean.map((r) => r.metrics.ms);
const first = clean.map((r) => r.metrics.firstReplyMs);
const measured = scenarios.filter((s) => byId.has(s.id));
const cost = runs.map((r) => r.metrics.usage.costUsd);
const cleanCost = clean.map((r) => r.metrics.usage.costUsd);
const summary = {
  label,
  planner: planner.name,
  tier,
  scenarios: scenarios.length,
  repeat,
  runs: runs.length,
  /** Runs that failed outside the app; the rates below leave them out. */
  infraRuns: runs.length - clean.length,
  /** Jobs never started because the quota ran out. */
  notRun: jobs.length - runs.length,
  passRate: Math.round(passRate * 1000) / 10,
  /** Scenarios that passed every run, and those that passed some but not all (flaky). */
  allPass: measured.filter((s) => byId.get(s.id)!.every((r) => r.pass)).length,
  /** Scenarios with at least one clean run. */
  measured: measured.length,
  flaky: measured.filter((s) => {
    const rs = byId.get(s.id)!;
    return rs.some((r) => r.pass) && rs.some((r) => !r.pass);
  }).length,
  e2eMs: { p50: quantile(ms, 0.5), p95: quantile(ms, 0.95) },
  firstReplyMs: { p50: quantile(first, 0.5), p95: quantile(first, 0.95) },
  plannerRoundsPerRun: Math.round(mean(clean.map((r) => r.metrics.plannerRounds)) * 100) / 100,
  callsPerRun: Math.round(mean(clean.map((r) => r.metrics.calls)) * 10) / 10,
  costUsd: { perRun: Math.round(mean(cleanCost) * 10000) / 10000, total: Math.round(cost.reduce((a, b) => a + b, 0) * 100) / 100 },
  wallMs: Math.round(performance.now() - started),
};
console.log(`\npass ${summary.passRate}% of clean runs · ${summary.allPass}/${summary.measured} scenarios pass every run · ${summary.flaky} flaky`);
if (summary.infraRuns || summary.notRun) console.log(`NOT A CLEAN RUN: ${summary.infraRuns} runs failed outside the app, ${summary.notRun} not started; ${scenarios.length - summary.measured} scenarios unmeasured`);
console.log(`e2e p50 ${summary.e2eMs.p50} ms, p95 ${summary.e2eMs.p95} ms · first reply p50 ${summary.firstReplyMs.p50} ms, p95 ${summary.firstReplyMs.p95} ms`);
console.log(`planner rounds/run ${summary.plannerRoundsPerRun} · calls/run ${summary.callsPerRun} · cost/run $${summary.costUsd.perRun} (total $${summary.costUsd.total}) · wall ${Math.round(summary.wallMs / 1000)} s`);

mkdirSync(`${EVAL}results`, { recursive: true });
const file = `${EVAL}results/scenarios-${label}.json`;
writeFileSync(file, JSON.stringify({ summary, runs: [...runs].sort((a, b) => a.id.localeCompare(b.id)) }, null, 1));
console.log(`\nwrote ${file}`);

if (!opt("label") || only) console.log("not recorded in the history: give it a --label, and run every scenario");
else if (!clean.length) console.log("not recorded in the history: no run reached the app, so there's nothing to measure");
else {
  appendHistory(ROOT, {
    at: new Date().toISOString(),
    suite: "scenarios",
    label,
    git: gitState(ROOT),
    set: fingerprint(JSON.stringify(scenarios)),
    config: { planner: planner.name, tier, repeat },
    metrics: {
      scenarios: scenarios.length,
      runs: summary.runs,
      infraRuns: summary.infraRuns,
      notRun: summary.notRun,
      passRate: summary.passRate,
      allPass: summary.allPass,
      measured: summary.measured,
      flaky: summary.flaky,
      e2eP50Ms: summary.e2eMs.p50,
      e2eP95Ms: summary.e2eMs.p95,
      firstReplyP50Ms: summary.firstReplyMs.p50,
      plannerRoundsPerRun: summary.plannerRoundsPerRun,
      costPerRunUsd: summary.costUsd.perRun,
    },
    file: `eval/results/scenarios-${label}.json`,
  });
  console.log("recorded in eval/results/history.jsonl");
}
