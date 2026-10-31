// Workstream D: runs the labelled identity set (eval/ner-identity/cases.v1.json) over a matrix of
//   setup    (NER / resolver flags)  × pipeline (PLANNER_PIPELINE)  × model (planner provider + model)
// and reports, per cell: pass rate (and cases passing every repeat), wrong-record bindings (the safety metric),
// failures by root cause, questions asked, model calls / tokens / cost per turn, p50/p95 latency.
// See docs/NER-IDENTITY-EVAL.md. GPT 6 Luna at low reasoning is the primary model; others are comparisons.
//
// Each cell runs in its own child process with its env set, so flags read at import time take effect. A cell whose
// flags this build doesn't read is skipped with "not available on this build", never faked. Any wrong-record
// binding in a cell that ran makes the exit code 1.
//
// Run: npm run eval:ner -- [--setups 1,2,3,4] [--pipelines classic,staged] [--models luna,sol,env] [--repeat 3]
//        [--concurrency 4] [--only id-or-prefix,...] [--label name] [--fast] [--cache] [--lint]
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprint, gitState } from "../eval/history.js";
import { existingIds, FAILURE_TAGS, gradeRun, lintCase, loadNerCases, type NerGrade, toScenario } from "../eval/ner-identity.js";
import { replayPlanner } from "../eval/replay.js";
import { runScenario } from "../eval/scenario.js";
import { formatCost, sumUsd } from "../planner/usage.js";
import { nerSidecarUrl } from "../retrieval/ner_client.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const OUT = `${ROOT}eval/results/ner-identity/`;
const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const casesFile = `${ROOT}${opt("cases") ?? "eval/ner-identity/cases.v1.json"}`;
const { version, cases: all } = loadNerCases(casesFile);
const only = opt("only")?.split(",");
const cases = all.filter((c) => !only || only.some((o) => c.id.startsWith(o)));
if (!cases.length) throw new Error("no cases match");

/** One value of a dimension: the env it sets, and what a build must read for it to mean anything. */
interface Option { key: string; what: string; env: Record<string, string>; requires: string[]; sidecar?: boolean }

export const SETUPS: Option[] = [
  { key: "1-off", what: "NER off, today's behaviour", env: { NER_MODE: "off", NER_SIDECAR: "0", ASK_NER: "0", RESOLVER: "off" }, requires: [] },
  { key: "2-resolver", what: "identity resolver only", env: { NER_MODE: "off", NER_SIDECAR: "0", ASK_NER: "0", RESOLVER: "on" }, requires: ["RESOLVER"] },
  { key: "3-gliner", what: "resolver + GLiNER, embedding match off", env: { NER_MODE: "on", NER_SIDECAR: "1", RESOLVER: "on", NER_EMBED: "off" }, requires: ["RESOLVER", "NER_MODE", "NER_EMBED"], sidecar: true },
  { key: "4-embed", what: "resolver + GLiNER + embedding match", env: { NER_MODE: "on", NER_SIDECAR: "1", RESOLVER: "on", NER_EMBED: "on" }, requires: ["RESOLVER", "NER_MODE", "NER_EMBED"], sidecar: true },
];
/** `"staged"` must appear as a string literal too: reading the flag isn't enough if only classic exists. */
export const PIPELINES: Option[] = [
  { key: "classic", what: "today's planner pipeline", env: { PLANNER_PIPELINE: "classic" }, requires: [] },
  { key: "staged", what: "staged planner pipeline", env: { PLANNER_PIPELINE: "staged" }, requires: ["PLANNER_PIPELINE", '"staged"'] },
];
/** Planner models, through the provider env vars makePlanner reads. Luna is the target; the rest are comparisons. */
export const MODELS: Option[] = [
  { key: "luna", what: "GPT 6 Luna, low reasoning (codex-cli)", env: { PLANNER: "codex-cli", CODEX_MODEL: "gpt-6-luna", CODEX_FAST_MODEL: "gpt-6-luna", CODEX_REASONING: "low", CODEX_FAST_REASONING: "low" }, requires: [] },
  { key: "sol", what: "GPT 6.1 Sol, low reasoning (codex-cli)", env: { PLANNER: "codex-cli", CODEX_MODEL: "gpt-6.1-sol", CODEX_FAST_MODEL: "gpt-6.1-sol", CODEX_REASONING: "low", CODEX_FAST_REASONING: "low" }, requires: [] },
  { key: "env", what: "whatever PLANNER and the model vars in the environment select", env: {}, requires: [] },
];

const pick = (dim: Option[], flag: string, fallback: string) =>
  (opt(flag) ?? fallback).split(",").map((k) => {
    const o = dim.find((x) => x.key === k || x.key.split("-")[0] === k);
    if (!o) throw new Error(`--${flag}: unknown ${k}; have ${dim.map((x) => x.key).join(", ")}`);
    return o;
  });

/** Runtime sources (not evals, scripts or tests) that could read a flag: the server and the sidecar. */
function runtimeSource(): string {
  const out: string[] = [];
  const walk = (dir: string, ext: RegExp) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) { if (!["eval", "scripts", "node_modules", "tests", "__pycache__"].includes(f)) walk(p, ext); }
      else if (ext.test(f) && !/\.test\.ts$|^test_/.test(f)) out.push(readFileSync(p, "utf8"));
    }
  };
  walk(`${ROOT}server/src`, /\.ts$/);
  walk(`${ROOT}server/ner-sidecar`, /\.py$/);
  return out.join("\n");
}

async function sidecarDown(): Promise<string | undefined> {
  const url = `${nerSidecarUrl()}/health`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return res.ok ? undefined : `sidecar ${url} answered HTTP ${res.status}`;
  } catch {
    return `sidecar not reachable at ${url}`;
  }
}

// --- child: run every case under the env the parent set, write the grades ---------------------
async function child(cell: string, out: string) {
  const { loadRegistry } = await import("../registry/registry.js");
  const { buildCards } = await import("../retrieval/cards.js");
  const { loadDense } = await import("../retrieval/embed.js");
  const { Retriever } = await import("../retrieval/retrieve.js");
  const { makePlanner } = await import("../planner/index.js");
  const tier = args.includes("--fast") ? "fast" : "strong";
  const registry = await loadRegistry();
  const cards = buildCards(registry);
  const retriever = new Retriever(cards, {}, await loadDense(cards, () => {}));
  const live = makePlanner();
  const model = live.models?.[tier] ?? "default";
  const useCache = args.includes("--cache");
  const planner = useCache ? replayPlanner(live, `${ROOT}eval/cache/${live.name}-${model}-${tier}-ner-${cell}.jsonl`) : live;
  const repeat = Number(opt("repeat") ?? 1);
  const concurrency = Number(opt("concurrency") ?? 4);
  const jobs = Array.from({ length: repeat }, () => cases).flat();
  const grades: NerGrade[] = [];
  const existing = new Map(cases.map((c) => [c.id, existingIds(c)]));
  let next = 0;
  let quotaHit = false;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
      while (next < jobs.length) {
        const c = jobs[next++]!;
        const run = await runScenario(toScenario(c), { registry, planner, retriever, tier });
        const g = gradeRun(c, run, registry, existing.get(c.id));
        grades.push(g);
        if (run.infra === "rate_limited" && !quotaHit) { quotaHit = true; next = jobs.length; }
        console.log(`[${cell}] ${g.infra ? "INFRA" : g.success ? "ok  " : "FAIL"} ${c.id.padEnd(30)} ${g.label.padEnd(11)} → ${g.observed.padEnd(14)} ${String(g.ms).padStart(6)} ms ${g.tags.join(" ")}${g.success ? "" : `  ${g.why.join(" · ") || g.infra}`}`);
      }
    }),
  );
  writeFileSync(out, JSON.stringify({ planner: planner.name, model, billing: planner.billing ?? "api_estimate", tier, repeat, replayed: useCache, notRun: jobs.length - grades.length, grades }));
}

// --- parent: availability, one child per cell, the reports ---------------------------------------
const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))]! : 0;
};
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

function summarize(grades: NerGrade[]) {
  const clean = grades.filter((g) => !g.infra);
  const asked = clean.filter((g) => g.asked);
  const msgs = clean.reduce((a, g) => a + g.messages, 0) || 1;
  const perCase = new Map<string, boolean[]>();
  for (const g of clean) (perCase.get(g.id) ?? perCase.set(g.id, []).get(g.id)!).push(g.success);
  const by = (key: (g: NerGrade) => string) => {
    const m: Record<string, { runs: number; pass: number }> = {};
    for (const g of clean) { const k = (m[key(g)] ??= { runs: 0, pass: 0 }); k.runs++; if (g.success) k.pass++; }
    return m;
  };
  const cost = sumUsd(clean.map((g) => g.usage.costUsd));
  const pass = clean.filter((g) => g.success).length;
  return {
    runs: grades.length,
    infraRuns: grades.length - clean.length,
    pass,
    passRate: clean.length ? round((100 * pass) / clean.length, 1) : 0,
    /** Cases that passed on every one of their (clean) repeats: the bar Luna must clear. */
    casesPassingEveryRepeat: [...perCase.values()].filter((xs) => xs.every(Boolean)).length,
    caseCount: perCase.size,
    /** The safety metric: runs that acted on or answered about a record the user didn't mean. Must be 0. */
    wrongRecordRuns: clean.filter((g) => g.wrongRecord.length).length,
    wrongRecords: clean.flatMap((g) => g.wrongRecord.map((w) => `${g.id}: ${w.how} ${w.id} (${w.why})`)),
    failuresByCause: Object.fromEntries(FAILURE_TAGS.map((t) => [t, clean.filter((g) => g.tags.includes(t)).length])) as Record<string, number>,
    asked: asked.length,
    /** Of the runs that asked, those whose answer led to a finished task. */
    askedThenFinished: asked.filter((g) => g.success).length,
    luckyGuesses: clean.filter((g) => g.guessed).length,
    byCategory: by((g) => g.category),
    byLabel: by((g) => g.label),
    ms: { p50: quantile(clean.map((g) => g.ms), 0.5), p95: quantile(clean.map((g) => g.ms), 0.95) },
    /** Per user message (utterance, plus the answer when it asked). Max is the worst run's per-message average. */
    perTurn: {
      modelCalls: round(clean.reduce((a, g) => a + g.modelCalls, 0) / msgs),
      modelCallsMax: round(Math.max(0, ...clean.map((g) => g.modelCalls / g.messages))),
      input: Math.round(clean.reduce((a, g) => a + g.usage.input, 0) / msgs),
      cachedRead: Math.round(clean.reduce((a, g) => a + g.usage.cachedRead, 0) / msgs),
      output: Math.round(clean.reduce((a, g) => a + g.usage.output + g.usage.thinking, 0) / msgs),
      costUsd: cost === null ? null : round(cost / msgs, 5),
    },
    costUsd: cost,
  };
}
type Summary = ReturnType<typeof summarize>;
interface Cell { cell: string; setup: string; pipeline: string; model: string; env: Record<string, string>; skipped?: string; planner?: string; plannerModel?: string; billing?: string; repeat?: number; replayed?: boolean; notRun?: number; summary?: Summary; grades?: NerGrade[] }

async function parent() {
  if (args.includes("--lint")) {
    const problems = cases.flatMap(lintCase);
    for (const p of problems) console.log(p);
    console.log(problems.length ? `${problems.length} label problems` : `${cases.length} cases, labels ok`);
    process.exit(problems.length ? 1 : 0);
  }
  const setups = pick(SETUPS, "setups", "1,2,3,4");
  const pipelines = pick(PIPELINES, "pipelines", "classic,staged");
  const models = pick(MODELS, "models", "luna");
  const label = opt("label") ?? "latest";
  const source = runtimeSource();
  const missing = (o: Option) => o.requires.filter((f) => !(f.startsWith('"') ? source.includes(f) : new RegExp(`\\b${f}\\b`).test(source)));
  const counts = Object.fromEntries([...new Set(cases.map((c) => c.category))].map((k) => [k, cases.filter((c) => c.category === k).length]));
  console.log(`${casesFile.slice(ROOT.length)} v${version}: ${cases.length} cases (${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(", ")})\n`);

  const cells: Cell[] = [];
  let unsafe = false;
  mkdirSync(`${OUT}raw`, { recursive: true });
  for (const s of setups) for (const p of pipelines) for (const m of models) {
    const cell = `${s.key}.${p.key}.${m.key}`;
    const env = { ...s.env, ...p.env, ...m.env };
    const gaps = [...missing(s), ...missing(p)];
    const reason = gaps.length ? `this build reads no ${gaps.join(", ")}` : s.sidecar ? await sidecarDown() : undefined;
    if (reason) {
      console.log(`${cell}: not available on this build — ${reason}; skipped\n`);
      cells.push({ cell, setup: s.key, pipeline: p.key, model: m.key, env, skipped: reason });
      continue;
    }
    console.log(`${cell} (${s.what}; ${p.what}; ${m.what}): ${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(" ")}`);
    const tmp = `${OUT}raw/.${cell}.tmp.json`;
    const r = spawnSync(process.execPath, [...process.execArgv, SELF, ...args, "--child", cell, "--out", tmp], { env: { ...process.env, ...env }, stdio: "inherit" });
    if (r.status !== 0) throw new Error(`${cell}: child exited ${r.status}`);
    const res = JSON.parse(readFileSync(tmp, "utf8")) as { grades: NerGrade[]; planner: string; model: string; billing: string; repeat: number; replayed: boolean; notRun: number };
    unlinkSync(tmp);
    const sum = summarize(res.grades);
    if (sum.wrongRecordRuns) unsafe = true;
    cells.push({ cell, setup: s.key, pipeline: p.key, model: m.key, env, planner: res.planner, plannerModel: res.model, billing: res.billing, repeat: res.repeat, replayed: res.replayed, notRun: res.notRun, summary: sum, grades: [...res.grades].sort((a, b) => a.id.localeCompare(b.id)) });
    const t = sum.perTurn;
    console.log(`\n  pass ${sum.pass}/${sum.runs - sum.infraRuns} (${sum.passRate}%) · ${sum.casesPassingEveryRepeat}/${sum.caseCount} cases pass every repeat${sum.infraRuns ? ` · ${sum.infraRuns} infra runs left out` : ""}${res.notRun ? ` · ${res.notRun} not run (quota)` : ""}`);
    console.log(`  wrong-record runs ${sum.wrongRecordRuns}${sum.wrongRecordRuns ? "  ← UNSAFE" : ""} · causes: ${Object.entries(sum.failuresByCause).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`);
    console.log(`  asked ${sum.asked} (${sum.askedThenFinished} then finished) · per turn: ${t.modelCalls} model calls (max ${t.modelCallsMax}), tokens in ${t.input} (cached ${t.cachedRead}) out ${t.output}, cost ${formatCost(t.costUsd, res.billing as never)}`);
    console.log(`  latency p50 ${sum.ms.p50} ms, p95 ${sum.ms.p95} ms\n`);
  }

  const head = { label, at: new Date().toISOString(), git: gitState(ROOT), cases: casesFile.slice(ROOT.length), version, set: fingerprint(JSON.stringify(cases)), caseCount: cases.length, byCategory: counts, args };
  // Raw grades (replies, per-run detail) stay out of git; the summary and the markdown are the committed record.
  writeFileSync(`${OUT}raw/${label}.json`, `${JSON.stringify({ ...head, cells }, null, 1)}\n`);
  const compact = cells.map(({ grades, ...c }) => ({ ...c, failing: grades?.filter((g) => !g.success).map((g) => `${g.id}: ${g.tags.join(",") || `infra ${g.infra}`}`) }));
  writeFileSync(`${OUT}${label}.summary.json`, `${JSON.stringify({ ...head, cells: compact }, null, 1)}\n`);
  writeFileSync(`${OUT}${label}.md`, markdown(head, cells));
  console.log(`wrote ${OUT.slice(ROOT.length)}${label}.md and .summary.json (raw: ${OUT.slice(ROOT.length)}raw/${label}.json, git-ignored)`);
  if (unsafe) {
    console.log("wrong-record bindings > 0: exit 1");
    process.exit(1);
  }
}

function markdown(h: { label: string; at: string; git: unknown; cases: string; version: number; caseCount: number; byCategory: Record<string, number>; args: string[] }, cells: Cell[]): string {
  const ran = cells.filter((c): c is Cell & { summary: Summary; grades: NerGrade[] } => !!c.summary);
  const row = (name: string, f: (c: (typeof ran)[number]) => string) => `| ${name} | ${ran.map(f).join(" | ")} |`;
  const lines = [
    `# NER identity eval — ${h.label}`,
    "",
    `${h.at} · ${h.cases} v${h.version} · ${h.caseCount} cases · \`${h.args.join(" ") || "(defaults)"}\` · git ${JSON.stringify(h.git)}`,
    "",
    ...cells.filter((c) => c.skipped).map((c) => `- \`${c.cell}\`: **not available on this build** — ${c.skipped}`),
    "",
  ];
  if (ran.length) {
    lines.push(
      `| | ${ran.map((c) => `\`${c.cell}\``).join(" | ")} |`,
      `|---|${ran.map(() => "---").join("|")}|`,
      row("planner", (c) => `${c.planner} ${c.plannerModel}${c.replayed ? " (replayed)" : ""}`),
      row("repeats", (c) => String(c.repeat)),
      row("**pass rate**", (c) => `**${c.summary.pass}/${c.summary.runs - c.summary.infraRuns} (${c.summary.passRate}%)**`),
      row("cases passing every repeat", (c) => `${c.summary.casesPassingEveryRepeat}/${c.summary.caseCount}`),
      row("**wrong-record runs** (must be 0)", (c) => `**${c.summary.wrongRecordRuns}**`),
      ...FAILURE_TAGS.map((t) => row(`failures: ${t}`, (c) => String(c.summary.failuresByCause[t]))),
      row("asked → finished task", (c) => `${c.summary.askedThenFinished}/${c.summary.asked}`),
      row("lucky guesses", (c) => String(c.summary.luckyGuesses)),
      row("infra runs (left out)", (c) => String(c.summary.infraRuns)),
      row("model calls / turn (max)", (c) => `${c.summary.perTurn.modelCalls} (${c.summary.perTurn.modelCallsMax})`),
      row("tokens / turn in (cached) / out", (c) => `${c.summary.perTurn.input} (${c.summary.perTurn.cachedRead}) / ${c.summary.perTurn.output}`),
      row("cost / turn", (c) => (c.summary.perTurn.costUsd === null ? "subscription" : `$${c.summary.perTurn.costUsd}`)),
      row("latency p50 / p95", (c) => `${c.summary.ms.p50} / ${c.summary.ms.p95} ms`),
      "",
      "Pass by category:",
      "",
      `| category (cases) | ${ran.map((c) => `\`${c.cell}\``).join(" | ")} |`,
      `|---|${ran.map(() => "---").join("|")}|`,
      ...Object.entries(h.byCategory).map(([k, n]) => `| ${k} (${n}) | ${ran.map((c) => { const v = c.summary.byCategory[k]; return v ? `${v.pass}/${v.runs}` : "-"; }).join(" | ")} |`),
      "",
    );
    for (const c of ran) {
      lines.push(`## \`${c.cell}\`: failing runs`, "");
      const bad = c.grades.filter((g) => !g.success);
      lines.push(...(bad.length ? bad.map((g) => `- \`${g.id}\` (${g.label} → ${g.observed}) **${g.tags.join(", ") || `infra ${g.infra}`}**: ${g.why.join(" · ") || g.infra}`) : ["none"]), "");
      if (c.summary.wrongRecords.length) lines.push("Wrong records:", "", ...c.summary.wrongRecords.map((w) => `- ${w}`), "");
    }
  }
  return `${lines.join("\n")}\n`;
}

const childCell = opt("child");
if (childCell) await child(childCell, opt("out")!);
else await parent();
