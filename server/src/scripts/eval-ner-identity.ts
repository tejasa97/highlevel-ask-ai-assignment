// Workstream D: runs the labelled identity set (eval/ner-identity/cases.v2.json) over a matrix of
//   setup    (NER / resolver flags)  × pipeline (PLANNER_PIPELINE)  × model (planner provider + model)
// and reports, per cell: pass rate (and cases passing every repeat), the two safety metrics (wrong-record bindings,
// unasked guesses on ambiguous names), failures by root cause, questions asked, model calls / tokens / cost per turn,
// p50/p95 latency. See docs/NER-IDENTITY-EVAL.md. GPT 6 Luna at low reasoning is the primary model.
//
// Each cell runs in its own child process with its env set, so flags read at import time take effect. A cell whose
// flags this build doesn't read is skipped ("not available on this build", or "pending F" for the staged pipeline),
// never faked. The exit code is 1 when a cell that ran has a wrong-record binding or an unasked guess, when a cell
// errored (its child failed) or when its NER calls didn't use the setup's NER_EMBED; the reports are written anyway.
// A --label report needs a clean tree (--allow-dirty overrides it, and marks the report).
//
// Run: npm run eval:ner -- [--setups 1,2,3,4] [--pipelines classic,staged] [--models luna,sol,env] [--repeat 3]
//        [--concurrency 4] [--only id-or-prefix,...] [--label name] [--allow-dirty] [--fast] [--cache] [--lint]
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprint, gitState } from "../eval/history.js";
import { ASKING, existingIds, FAILURE_TAGS, gradeRun, lintCase, loadNerCases, type NerGrade, toScenario } from "../eval/ner-identity.js";
import { cellEnv, embedProblem, envMismatch, MODELS, type Option, PIPELINES, readiness, SETUPS, skipReason, summarize, type Summary } from "../eval/ner-matrix.js";
import { replayPlanner } from "../eval/replay.js";
import { runScenario } from "../eval/scenario.js";
import { formatCost } from "../planner/usage.js";
import { nerSidecarUrl } from "../retrieval/ner_client.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const OUT = `${ROOT}eval/results/ner-identity/`;
const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const casesFile = `${ROOT}${opt("cases") ?? "eval/ner-identity/cases.v2.json"}`;
const { version, cases: all } = loadNerCases(casesFile);
const only = opt("only")?.split(",");
const cases = all.filter((c) => !only || only.some((o) => c.id.startsWith(o)));
if (!cases.length) throw new Error("no cases match");

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

/** The sidecar's readiness: GET /health/ready answers 200 only once its models and index are loaded. */
async function sidecarReady(): Promise<ReturnType<typeof readiness> & { url: string }> {
  const url = `${nerSidecarUrl()}/health/ready`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return { url, ...readiness(res.status, await res.json().catch(() => undefined)) };
  } catch {
    return { url, ready: false, reason: "not reachable" };
  }
}

// --- child: run every case under the env the parent set, write the grades ---------------------
async function child(cell: string, out: string) {
  // The cell's flags must be what this process sees, or its numbers would belong to another setup.
  const [s, p, m] = cell.split(".");
  const want = cellEnv(SETUPS.find((x) => x.key === s)!, PIPELINES.find((x) => x.key === p)!, MODELS.find((x) => x.key === m)!);
  const bad = envMismatch(want, process.env);
  if (bad.length) throw new Error(`${cell}: environment doesn't match the cell: ${bad.join("; ")}`);
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
        // Either spelling of a question gets the case's answer once: the conversation resumes from both.
        const run = await runScenario(toScenario(c), { registry, planner, retriever, tier, answerOn: ASKING });
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
interface Cell {
  cell: string;
  setup: string;
  pipeline: string;
  model: string;
  env: Record<string, string>;
  /** Not run: pending other work, or a flag this build doesn't read, or the sidecar isn't ready. */
  skipped?: { kind: "pending" | "missing" | "sidecar"; reason: string };
  /** Ran but produced no grades: the child failed. */
  errored?: string;
  /** Ran, but its numbers don't belong to its setup (the NER calls used another embed setting). */
  invalid?: string;
  planner?: string;
  plannerModel?: string;
  billing?: string;
  repeat?: number;
  replayed?: boolean;
  notRun?: number;
  summary?: Summary;
  grades?: NerGrade[];
}
interface Head {
  label: string;
  at: string;
  git: ReturnType<typeof gitState>;
  /** Written from a tree with uncommitted changes (--allow-dirty): not a baseline. */
  dirty: boolean;
  cases: string;
  version: number;
  set: string;
  caseCount: number;
  byCategory: Record<string, number>;
  args: string[];
  sidecar?: { url: string; versions?: Record<string, unknown> };
}

async function parent() {
  if (args.includes("--lint")) {
    const problems = cases.flatMap(lintCase);
    for (const p of problems) console.log(p);
    console.log(problems.length ? `${problems.length} label problems` : `${cases.length} cases, labels ok`);
    process.exit(problems.length ? 1 : 0);
  }
  const git = gitState(ROOT);
  const dirty = !git || git.dirty;
  if (opt("label") && dirty && !args.includes("--allow-dirty")) {
    console.error(`--label ${opt("label")}: the tree has uncommitted changes (${git ? `at ${git.sha}` : "git state unknown"}); commit first, or pass --allow-dirty to write a report marked dirty`);
    process.exit(2);
  }
  const setups = pick(SETUPS, "setups", "1,2,3,4");
  const pipelines = pick(PIPELINES, "pipelines", "classic,staged");
  const models = pick(MODELS, "models", "luna");
  const label = opt("label") ?? "latest";
  const source = runtimeSource();
  const missing = (o: Option) => o.requires.filter((f) => !(f.startsWith('"') ? source.includes(f) : new RegExp(`\\b${f}\\b`).test(source)));
  const counts = Object.fromEntries([...new Set(cases.map((c) => c.category))].map((k) => [k, cases.filter((c) => c.category === k).length]));
  console.log(`${casesFile.slice(ROOT.length)} v${version}: ${cases.length} cases (${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(", ")})${dirty ? " · DIRTY TREE" : ""}\n`);

  const cells: Cell[] = [];
  let sidecar: Head["sidecar"];
  let failed = false;
  mkdirSync(`${OUT}raw`, { recursive: true });
  for (const s of setups) for (const p of pipelines) for (const m of models) {
    const cell = `${s.key}.${p.key}.${m.key}`;
    const env = cellEnv(s, p, m);
    const base = { cell, setup: s.key, pipeline: p.key, model: m.key, env };
    let skipped: Cell["skipped"] = skipReason([s, p], missing);
    if (!skipped && s.sidecar) {
      const r = (sidecar && { url: sidecar.url, ready: true as const }) || (await sidecarReady());
      if (r.ready) sidecar ??= { url: r.url, ...("versions" in r && r.versions ? { versions: r.versions } : {}) };
      else skipped = { kind: "sidecar", reason: `sidecar not ready at ${r.url}: ${r.reason}` };
    }
    if (skipped) {
      console.log(`${cell}: ${skipped.kind === "pending" ? skipped.reason : `not available on this build — ${skipped.reason}`}; skipped\n`);
      cells.push({ ...base, skipped });
      continue;
    }
    console.log(`${cell} (${s.what}; ${p.what}; ${m.what}): ${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(" ")}`);
    const tmp = `${OUT}raw/.${cell}.tmp.json`;
    const r = spawnSync(process.execPath, [...process.execArgv, SELF, ...args, "--child", cell, "--out", tmp], { env: { ...process.env, ...env }, stdio: "inherit" });
    // A failed child loses only its own cell: record why, keep the others, still write the reports.
    let res: { grades: NerGrade[]; planner: string; model: string; billing: string; repeat: number; replayed: boolean; notRun: number } | undefined;
    let errored: string | undefined;
    if (r.status !== 0) errored = `child exited ${r.status ?? r.signal ?? r.error?.message}`;
    else if (!existsSync(tmp)) errored = "child wrote no results";
    else {
      try { res = JSON.parse(readFileSync(tmp, "utf8")); } catch (err) { errored = `unreadable results: ${err instanceof Error ? err.message : err}`; }
    }
    if (existsSync(tmp)) unlinkSync(tmp);
    if (!res) {
      failed = true;
      console.log(`\n  ERRORED: ${errored}\n`);
      cells.push({ ...base, errored });
      continue;
    }
    const sum = summarize(res.grades);
    const invalid = embedProblem(env.NER_EMBED, res.grades);
    if (sum.wrongRecordRuns || sum.unaskedGuessRuns || invalid) failed = true;
    cells.push({ ...base, ...(invalid ? { invalid } : {}), planner: res.planner, plannerModel: res.model, billing: res.billing, repeat: res.repeat, replayed: res.replayed, notRun: res.notRun, summary: sum, grades: [...res.grades].sort((a, b) => a.id.localeCompare(b.id)) });
    const t = sum.perTurn;
    console.log(`\n  pass ${sum.pass}/${sum.runs - sum.infraRuns} (${sum.passRate}%) · ${sum.casesPassingEveryRepeat}/${sum.caseCount} cases pass every repeat${sum.infraRuns ? ` · ${sum.infraRuns} infra runs left out` : ""}${res.notRun ? ` · ${res.notRun} not run (quota)` : ""}`);
    console.log(`  wrong-record runs ${sum.wrongRecordRuns} · unasked guesses ${sum.unaskedGuessRuns}${sum.wrongRecordRuns || sum.unaskedGuessRuns ? "  ← UNSAFE" : ""} · causes: ${Object.entries(sum.failuresByCause).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`);
    console.log(`  asked ${sum.asked} (${sum.askedThenFinished} then finished) · per turn: ${t.modelCalls} model calls (max ${t.modelCallsMax}), tokens in ${t.input} (cached ${t.cachedRead}) out ${t.output}, cost ${formatCost(t.costUsd, res.billing as never)}`);
    console.log(`  latency p50 ${sum.ms.p50} ms, p95 ${sum.ms.p95} ms${Object.keys(sum.ner.embed).length ? ` · ner calls by embed: ${JSON.stringify(sum.ner.embed)}` : ""}`);
    if (invalid) console.log(`  INVALID: ${invalid}`);
    console.log("");
  }

  const head: Head = { label, at: new Date().toISOString(), git, dirty, cases: casesFile.slice(ROOT.length), version, set: fingerprint(JSON.stringify(cases)), caseCount: cases.length, byCategory: counts, args, ...(sidecar ? { sidecar } : {}) };
  // Raw grades (replies, per-run detail) stay out of git; the summary and the markdown are the committed record.
  writeFileSync(`${OUT}raw/${label}.json`, `${JSON.stringify({ ...head, cells }, null, 1)}\n`);
  const compact = cells.map(({ grades, ...c }) => ({ ...c, failing: grades?.filter((g) => !g.success).map((g) => `${g.id}: ${g.tags.join(",") || `infra ${g.infra}`}`) }));
  writeFileSync(`${OUT}${label}.summary.json`, `${JSON.stringify({ ...head, cells: compact }, null, 1)}\n`);
  writeFileSync(`${OUT}${label}.md`, markdown(head, cells));
  console.log(`wrote ${OUT.slice(ROOT.length)}${label}.md and .summary.json (raw: ${OUT.slice(ROOT.length)}raw/${label}.json, git-ignored)`);
  if (failed) {
    console.log("a cell errored, used the wrong NER_EMBED, or has wrong-record bindings / unasked guesses: exit 1");
    process.exit(1);
  }
}

function markdown(h: Head, cells: Cell[]): string {
  const ran = cells.filter((c): c is Cell & { summary: Summary; grades: NerGrade[] } => !!c.summary);
  const row = (name: string, f: (c: (typeof ran)[number]) => string) => `| ${name} | ${ran.map(f).join(" | ")} |`;
  const lines = [
    `# NER identity eval — ${h.label}`,
    "",
    ...(h.dirty ? ["> **DIRTY TREE**: written with uncommitted changes (`--allow-dirty`). Not a baseline.", ""] : []),
    `${h.at} · ${h.cases} v${h.version} · ${h.caseCount} cases · \`${h.args.join(" ") || "(defaults)"}\` · git ${h.git ? `${h.git.sha}${h.git.dirty ? " (dirty)" : ""}` : "unknown"}`,
    "",
    ...(h.sidecar ? [`Sidecar ${h.sidecar.url}: ${h.sidecar.versions ? `\`${JSON.stringify(h.sidecar.versions)}\`` : "ready, no versions reported"}`, ""] : []),
    ...cells.filter((c) => c.skipped).map((c) => `- \`${c.cell}\`: ${c.skipped!.kind === "pending" ? `**${c.skipped!.reason}**` : `**not available on this build** — ${c.skipped!.reason}`}`),
    ...cells.filter((c) => c.errored).map((c) => `- \`${c.cell}\`: **errored** — ${c.errored}`),
    ...cells.filter((c) => c.invalid).map((c) => `- \`${c.cell}\`: **invalid** — ${c.invalid}`),
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
      row("**unasked guesses on ambiguous cases** (must be 0)", (c) => `**${c.summary.unaskedGuessRuns}**`),
      ...FAILURE_TAGS.map((t) => row(`failures: ${t}`, (c) => String(c.summary.failuresByCause[t]))),
      row("asked → finished task", (c) => `${c.summary.askedThenFinished}/${c.summary.asked}`),
      row("infra runs (left out)", (c) => String(c.summary.infraRuns)),
      row("model calls / turn (max)", (c) => `${c.summary.perTurn.modelCalls} (${c.summary.perTurn.modelCallsMax})`),
      row("tokens / turn in (cached) / out", (c) => `${c.summary.perTurn.input} (${c.summary.perTurn.cachedRead}) / ${c.summary.perTurn.output}`),
      row("cost / turn", (c) => (c.summary.perTurn.costUsd === null ? "subscription" : `$${c.summary.perTurn.costUsd}`)),
      row("latency p50 / p95", (c) => `${c.summary.ms.p50} / ${c.summary.ms.p95} ms`),
      row("ner calls by embed", (c) => Object.entries(c.summary.ner.embed).map(([k, n]) => `${k} ${n}`).join(", ") || "-"),
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
      if (c.summary.unaskedGuesses.length) lines.push("Unasked guesses:", "", ...c.summary.unaskedGuesses.map((w) => `- ${w}`), "");
    }
  }
  return `${lines.join("\n")}\n`;
}

const childCell = opt("child");
if (childCell) await child(childCell, opt("out")!);
else await parent();
