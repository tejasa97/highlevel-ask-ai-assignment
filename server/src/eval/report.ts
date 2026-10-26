// Turns saved scenario results (eval/results/scenarios-<label>.json) into the benchmark report: quality checked
// against calls and final data, latency split into direct and complex requests, tokens and cost per successful
// task, every failure listed, and the targets as committed in eval/targets.json. Pure functions; the file reading
// and writing is in scripts/report.ts.
import type { HistoryEntry } from "./history.js";
import type { Scenario, ScenarioRun } from "./scenario.js";
import { DEFAULT_SCENARIO_DIR } from "./selection.js";
import { sumUsd } from "../planner/usage.js";

export interface ResultFile {
  summary: { label: string; planner: string; tier: string; agent?: string; scenarioDir?: string; scenarios: number; repeat: number; runs: number; infraRuns: number; notRun: number };
  runs: ScenarioRun[];
}

/** A result file with what the history knows about its run. */
export interface Measured {
  result: ResultFile;
  entry?: HistoryEntry;
}

export const GROUPS = {
  /** One request, one action. */
  direct: ["direct"],
  /** Several steps across modules, with filters, exclusions and conditions. */
  complex: ["multi"],
  all: ["direct", "indirect", "multi", "followup", "ambiguous", "unsupported", "failure"],
} as const;
export type Group = keyof typeof GROUPS;

export interface Rate {
  ok: number;
  of: number;
}

export interface GroupStats {
  runs: number;
  scenarios: number;
  /** Runs where every check passed. */
  success: Rate;
  /** Runs of scenarios that name the actions to plan (or not): none missing, none unwanted. */
  actions: Rate;
  /** Runs of scenarios that check call arguments: every expected call ran with those arguments. */
  args: Rate;
  /** Runs of scenarios that check the data afterwards: every SQL check held, and nothing changed when nothing should. */
  state: Rate;
  firstReplyMs: { p50: number; p95: number };
  e2eMs: { p50: number; p95: number };
  /** Planner calls per run, repair rounds and looks included. */
  modelCalls: { mean: number; p50: number };
  actionCalls: { mean: number };
  tokens: { input: number; cachedRead: number; cacheWrite: number; output: number };
  costUsd: { total: number | null; perRun: number | null; perSuccess: number | null };
}

export function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))]! : 0;
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/**
 * Stats over the clean runs (no infrastructure failure) in some categories. Cost is the exception: what was
 * spent on every run, infra runs and failed ones included, divided by the runs that passed.
 */
export function groupStats(runs: ScenarioRun[], defs: Map<string, Scenario>, categories: readonly string[]): GroupStats {
  const all = runs.filter((r) => categories.includes(r.category));
  const clean = all.filter((r) => !r.infra);
  const rate = (applies: (s: Scenario) => boolean, kinds: string[]): Rate => {
    const rs = clean.filter((r) => defs.has(r.id) && applies(defs.get(r.id)!));
    return { ok: rs.filter((r) => !r.failures.some((f) => kinds.includes(f.kind))).length, of: rs.length };
  };
  const passed = clean.filter((r) => r.pass).length;
  const total = sumUsd(all.map((r) => r.metrics.usage.costUsd));
  const usage = (k: "input" | "cachedRead" | "cacheWrite" | "output") => sum(clean.map((r) => r.metrics.usage[k]));
  return {
    runs: clean.length,
    scenarios: new Set(clean.map((r) => r.id)).size,
    success: { ok: passed, of: clean.length },
    actions: rate((s) => !!(s.expect.actions?.includes.length || s.expect.actions?.excludes.length), ["action-missing", "action-unwanted"]),
    args: rate((s) => s.expect.args.length > 0, ["args"]),
    state: rate((s) => s.expect.state.length > 0 || !!s.expect.noChanges, ["state", "changes"]),
    firstReplyMs: { p50: quantile(clean.map((r) => r.metrics.firstReplyMs), 0.5), p95: quantile(clean.map((r) => r.metrics.firstReplyMs), 0.95) },
    e2eMs: { p50: quantile(clean.map((r) => r.metrics.ms), 0.5), p95: quantile(clean.map((r) => r.metrics.ms), 0.95) },
    modelCalls: { mean: mean(clean.map((r) => r.metrics.plannerRounds)), p50: quantile(clean.map((r) => r.metrics.plannerRounds), 0.5) },
    actionCalls: { mean: mean(clean.map((r) => r.metrics.calls)) },
    tokens: { input: usage("input"), cachedRead: usage("cachedRead"), cacheWrite: usage("cacheWrite"), output: usage("output") },
    costUsd: { total, perRun: total === null ? null : all.length ? total / all.length : 0, perSuccess: passed && total !== null ? total / passed : null },
  };
}

// --- targets ------------------------------------------------------------------------------------------------

/** eval/targets.json. `committed` is the date the targets were fixed; until then they're placeholders, not judged. */
export interface Targets {
  committed: string | null;
  note?: string;
  targets: { name: string; group: Group; metric: TargetMetric; max?: number; min?: number }[];
}
export type TargetMetric = "firstReplyP50Ms" | "firstReplyP95Ms" | "e2eP50Ms" | "e2eP95Ms" | "actionSelectionPct" | "taskSuccessPct" | "modelCallsP50";

export function metricValue(g: GroupStats, m: TargetMetric): number | null {
  const pct = (r: Rate) => (r.of ? (100 * r.ok) / r.of : null);
  switch (m) {
    case "firstReplyP50Ms":
      return g.firstReplyMs.p50;
    case "firstReplyP95Ms":
      return g.firstReplyMs.p95;
    case "e2eP50Ms":
      return g.e2eMs.p50;
    case "e2eP95Ms":
      return g.e2eMs.p95;
    case "actionSelectionPct":
      return pct(g.actions);
    case "taskSuccessPct":
      return pct(g.success);
    case "modelCallsP50":
      return g.modelCalls.p50;
  }
}

export type Verdict = "met" | "missed" | "not judged" | "no data";

/** Targets are judged only when they were committed before the run being judged; else they'd be fitted to it. */
export function verdict(t: Targets["targets"][number], value: number | null, committed: string | null, ranAt: string | undefined): Verdict {
  if (value === null || Number.isNaN(value)) return "no data";
  if (!committed || !ranAt || committed > ranAt.slice(0, 10)) return "not judged";
  const ok = (t.max === undefined || value <= t.max) && (t.min === undefined || value >= t.min);
  return ok ? "met" : "missed";
}

// --- markdown -----------------------------------------------------------------------------------------------

export interface ReportInput {
  measured: Measured[];
  defs: Scenario[];
  /** Fingerprint of the scenario files as they are now, to tell whether a run used the same ones. */
  setNow: string;
  targets: Targets;
  /** Implemented actions per catalog module, and the catalog's size. */
  coverage: { implemented: number; modules: number; catalogActions: number; catalogModules: number };
  retrieval?: HistoryEntry;
  built: string;
}

const pctOf = (r: Rate) => (r.of ? `${((100 * r.ok) / r.of).toFixed(1)}%` : "–");
const rateCell = (r: Rate) => (r.of ? `${pctOf(r)} (${r.ok}/${r.of})` : "–");
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const usd = (x: number | null) => (x === null ? "–" : `$${x < 0.1 ? x.toFixed(4) : x.toFixed(2)}`);
const int = (x: number) => Math.round(x).toLocaleString("en-US");
const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

function fmtMetric(m: TargetMetric, v: number | null): string {
  if (v === null) return "–";
  if (m.endsWith("Ms")) return secs(v);
  if (m.endsWith("Pct")) return `${v.toFixed(1)}%`;
  return String(v);
}

function fmtLimit(t: Targets["targets"][number]): string {
  const v = t.max ?? t.min!;
  return `${t.max !== undefined ? "≤" : "≥"} ${fmtMetric(t.metric, v)}`;
}

function models(runs: ScenarioRun[]): string {
  const ms = [...new Set(runs.flatMap((r) => r.models ?? []))];
  return ms.length ? ms.join(", ") : "not recorded in this result file";
}

export function renderReport(input: ReportInput): string {
  const defs = new Map(input.defs.map((s) => [s.id, s]));
  const [primary, ...others] = input.measured;
  if (!primary) throw new Error("no results to report");
  const p = primary.result;
  const stats = (m: Measured, g: Group) => groupStats(m.result.runs, defs, GROUPS[g]);
  const out: string[] = [];
  const line = (s = "") => out.push(s);

  line("# Benchmark");
  line();
  line(`Generated by \`npm run report\` on ${input.built} from \`eval/results/scenarios-${p.summary.label}.json\`. Don't edit by hand.`);
  line();

  // What was measured.
  const e = primary.entry;
  line("## What was measured");
  line();
  line(`- **Code:** ${e?.git ? `commit \`${e.git.sha}\`${e.git.dirty ? " with uncommitted edits" : ""}` : "commit not recorded"}${e ? `, run ${e.at.slice(0, 16).replace("T", " ")} UTC` : ""}.`);
  line(`- **Planner:** \`${p.summary.planner}\`, ${p.summary.tier} tier; model ${models(p.runs)}.`);
  line(`- **Scenarios:** ${p.summary.scenarios} scenarios × ${p.summary.repeat} runs = ${p.summary.runs} runs; each run starts from a fresh seeded database and goes through the same conversation code as the web app, approving what asks for approval unless the scenario declines.`);
  if (e && e.set !== input.setNow) line(`- **Warning:** the scenario files changed since this run (set \`${e.set}\` then, \`${input.setNow}\` now). Rates that depend on what a scenario checks use today's files.`);
  if (p.summary.infraRuns || p.summary.notRun) line(`- **Not a clean run:** ${p.summary.infraRuns} runs failed outside the app (quota, timeout, provider down) and ${p.summary.notRun} were never started. They're left out of every rate and latency below, but their cost counts.`);
  line(`- **Coverage:** ${input.coverage.implemented} of ${input.coverage.catalogActions} catalog actions are implemented, in ${input.coverage.modules} of ${input.coverage.catalogModules} modules. The scenarios touch ${new Set(input.defs.flatMap((s) => s.modules)).size} modules.`);
  line();

  // Headline, side by side when comparing.
  line("## Headline");
  line();
  const cols = input.measured.map((m) => `\`${m.result.summary.label}\``);
  line(`| | ${cols.join(" | ")} |`);
  line(`|---|${cols.map(() => "---:").join("|")}|`);
  const row = (name: string, f: (m: Measured) => string) => line(`| ${name} | ${input.measured.map(f).join(" | ")} |`);
  row("Agent", (m) => (m.result.summary.agent === "baseline" ? "baseline: one call per step" : "planner: whole plan per call"));
  row("Planner", (m) => `${m.result.summary.planner} (${m.result.summary.tier})`);
  row("Task success, all runs", (m) => rateCell(stats(m, "all").success));
  row("Action selection", (m) => rateCell(stats(m, "all").actions));
  row("Parameter accuracy", (m) => rateCell(stats(m, "all").args));
  row("Final data correct", (m) => rateCell(stats(m, "all").state));
  row("Direct: first reply p50 / p95", (m) => `${secs(stats(m, "direct").firstReplyMs.p50)} / ${secs(stats(m, "direct").firstReplyMs.p95)}`);
  row("Complex: first reply p50 / p95", (m) => `${secs(stats(m, "complex").firstReplyMs.p50)} / ${secs(stats(m, "complex").firstReplyMs.p95)}`);
  row("Complex: end-to-end p50 / p95", (m) => `${secs(stats(m, "complex").e2eMs.p50)} / ${secs(stats(m, "complex").e2eMs.p95)}`);
  row("Model calls per complex task, median", (m) => String(stats(m, "complex").modelCalls.p50));
  row("Cost per run", (m) => usd(stats(m, "all").costUsd.perRun));
  row("Cost per successful task", (m) => usd(stats(m, "all").costUsd.perSuccess));
  line();
  if (input.measured.some((m) => m.result.summary.agent === "baseline")) {
    line("The baseline (`server/src/server/baseline.ts`) is the usual tool-calling loop: each model call picks one action or name lookup, sees its result, and picks the next. It gets the same shortlist of actions, name matches, context and approval rules as the planner; only the planning differs.");
    line();
  }
  if (others.length) {
    line("Columns are comparable only when they ran the same scenario files; check the set fingerprints under each label in `eval/results/history.jsonl`.");
    line();
  }

  // Targets.
  line("## Targets");
  line();
  const t = input.targets;
  if (!t.committed) line("**The targets below are placeholders and are not judged yet.** They get committed, with a date, before the full benchmark run; a target committed after a run isn't judged against that run.");
  else line(`Committed ${t.committed}. A run before that date isn't judged against them.`);
  if (t.note) line(`\n${t.note}`);
  line();
  line("| Target | Limit | Measured | Verdict |");
  line("|---|---:|---:|---|");
  for (const x of t.targets) {
    const v = metricValue(stats(primary, x.group), x.metric);
    line(`| ${x.name} | ${fmtLimit(x)} | ${fmtMetric(x.metric, v)} | ${verdict(x, v, t.committed, e?.at)} |`);
  }
  line();

  // Quality.
  line("## Quality by category");
  line();
  line("Each rate counts runs of the scenarios that check that thing, so the denominators differ. A run passes when every check holds: status, planned actions, call arguments, final data (SQL) and the reply.");
  line();
  line("| Category | Scenarios | Runs | Task success | Action selection | Parameters | Final data |");
  line("|---|---:|---:|---:|---:|---:|---:|");
  for (const cat of GROUPS.all) {
    const g = groupStats(p.runs, defs, [cat]);
    if (g.runs) line(`| ${cat} | ${g.scenarios} | ${g.runs} | ${rateCell(g.success)} | ${rateCell(g.actions)} | ${rateCell(g.args)} | ${rateCell(g.state)} |`);
  }
  const all = stats(primary, "all");
  line(`| **all** | ${all.scenarios} | ${all.runs} | ${rateCell(all.success)} | ${rateCell(all.actions)} | ${rateCell(all.args)} | ${rateCell(all.state)} |`);
  line();

  // Latency.
  line("## Latency");
  line();
  line("**First reply** is the time from sending the message to the first useful reply: the answer, a clarifying question, or the approval prompt that shows the plan. A loading indicator doesn't count. **End-to-end** runs until the last reply, approvals and every turn included.");
  line();
  line("| Group | Runs | First reply p50 | First reply p95 | End-to-end p50 | End-to-end p95 |");
  line("|---|---:|---:|---:|---:|---:|");
  for (const [name, cats] of [["direct", GROUPS.direct], ["complex (multi)", GROUPS.complex], ...GROUPS.all.filter((c) => c !== "direct" && c !== "multi").map((c) => [c, [c]] as const), ["all", GROUPS.all]] as const) {
    const g = groupStats(p.runs, defs, cats);
    if (g.runs) line(`| ${name} | ${g.runs} | ${secs(g.firstReplyMs.p50)} | ${secs(g.firstReplyMs.p95)} | ${secs(g.e2eMs.p50)} | ${secs(g.e2eMs.p95)} |`);
  }
  line();

  // Cost.
  line("## Tokens, calls and cost");
  line();
  const cachedShare = all.tokens.input ? (100 * all.tokens.cachedRead) / all.tokens.input : 0;
  line("| | Per run (mean) | Total |");
  line("|---|---:|---:|");
  line(`| Input tokens (cached ones included) | ${int(all.tokens.input / (all.runs || 1))} | ${int(all.tokens.input)} |`);
  line(`| … read from cache | ${int(all.tokens.cachedRead / (all.runs || 1))} | ${int(all.tokens.cachedRead)} (${cachedShare.toFixed(0)}%) |`);
  line(`| … written to cache | ${int(all.tokens.cacheWrite / (all.runs || 1))} | ${int(all.tokens.cacheWrite)} |`);
  line(`| Output tokens | ${int(all.tokens.output / (all.runs || 1))} | ${int(all.tokens.output)} |`);
  line(`| Model calls (repairs and looks included) | ${all.modelCalls.mean.toFixed(2)} | |`);
  line(`| Action calls executed | ${all.actionCalls.mean.toFixed(1)} | |`);
  line(`| Cost | ${usd(all.costUsd.perRun)} | ${usd(all.costUsd.total)} |`);
  line(`| Cost per successful task | ${usd(all.costUsd.perSuccess)} | |`);
  line();
  line("Cost per successful task is everything spent, failed and infra runs and repair rounds included, divided by the runs that passed.");
  line();
  line(pricingNote(p.summary.planner));
  line();

  // Retrieval.
  const r = input.retrieval;
  if (r) {
    line("## Tool retrieval");
    line();
    line(`From \`${r.file ?? r.label}\` (${r.config.split} split, ${r.config.retrieval} retrieval, commit \`${r.git?.sha ?? "?"}\`): over ${r.metrics.questions} questions, the right actions are in the first 15 offered ${r.metrics.r15}% of the time (all of a question's actions: ${r.metrics.all15}%), with mean reciprocal rank ${r.metrics.mrr}. The planner is shown ${r.metrics.picks} actions on average.`);
    line();
  }

  // Failures.
  line("## Every failing run");
  line();
  const failed = p.runs.filter((x) => !x.pass || x.infra).sort((a, b) => a.id.localeCompare(b.id));
  if (!failed.length) line("None.");
  else {
    line("| Scenario | Category | What failed |");
    line("|---|---|---|");
    for (const x of failed) line(`| ${x.id} | ${x.category} | ${x.infra ? `infra: ${x.infra}` : esc(x.failures.map((f) => `${f.kind}: ${f.detail}`).join("; "))} |`);
  }
  line();

  // Reproduce.
  line("## Reproduce");
  line();
  line("From `server/`:");
  line();
  line("```bash");
  for (const m of input.measured) {
    const r = m.result.summary;
    const dir = r.scenarioDir && r.scenarioDir !== DEFAULT_SCENARIO_DIR ? ` --scenario-dir ${r.scenarioDir}` : "";
    line(`npm run eval:scenarios --${dir} --repeat ${r.repeat} --label ${r.label}${r.tier === "fast" ? " --fast" : ""}${r.agent === "baseline" ? " --agent baseline" : ""}`);
  }
  line(`npm run report -- --label ${p.summary.label}${others.length ? ` --compare ${others.map((m) => m.result.summary.label).join(",")}` : ""}`);
  line("```");
  line();
  line(`The planner comes from \`PLANNER\` in \`.env\` (see \`server/src/planner/index.ts\`). The scenarios are in ${(p.summary.scenarioDir ?? DEFAULT_SCENARIO_DIR).split(",").map((d) => `\`${d}/\``).join(", ")}, the targets in \`eval/targets.json\`, and every recorded run in \`eval/results/history.jsonl\`.`);
  return out.join("\n") + "\n";
}

function pricingNote(planner: string): string {
  if (planner === "claude-cli") {
    return "**Pricing and test conditions:** this planner runs `claude -p` on a Claude subscription. Cost is Claude Code's own estimate at Anthropic API list prices (`total_cost_usd`), not money spent. Each model call also starts a process, about 1.5 s of every call's latency, which an API client wouldn't pay. Prompt caching is Claude's automatic prefix cache: the system prompt is kept byte-identical between calls so it can be read from cache.";
  }
  if (planner === "codex-cli") {
    return "**Pricing and test conditions:** this planner uses Codex CLI with ChatGPT subscription access. Token counts include runtime context and latency includes process startup. Subscription USD cost is unavailable; cost cells show –. See docs/CODEX-PROVIDER-CAPTURE.md for the measured prompt and tool framing.";
  }
  if (planner === "qwen") {
    return "**Pricing and test conditions:** this planner calls a Qwen Token Plan's OpenAI-compatible endpoint directly (strict `json_schema` output, or `json_object` with the schema in the prompt when `QWEN_RESPONSE_FORMAT=json_object`; thinking off unless `QWEN_THINKING` is set). Token Plan usage is prepaid, so USD cost is unavailable; cost cells show –. Latency is a direct HTTPS call with no process startup.";
  }
  return `**Pricing and test conditions:** cost is computed by the \`${planner}\` adapter from the tokens the provider reports and the list prices in \`server/src/planner/index.ts\`.`;
}
