import { sumUsd } from "../planner/usage.js";
import { FAILURE_TAGS, type NerGrade } from "./ner-identity.js";

// The matrix eval-ner-identity.ts runs the identity set over (setup × pipeline × model), and the pure parts of its
// report: availability, the env a cell's child process gets, the NER embed check, the per-cell summary.

/** One value of a dimension: the env it sets, and what a build must read for it to mean anything. */
export interface Option {
  key: string;
  what: string;
  env: Record<string, string>;
  requires: string[];
  sidecar?: boolean;
  /** Set when the option waits on work that hasn't landed yet: a skip then reads "pending <this>", not a build gap. */
  pending?: string;
}

export const SETUPS: Option[] = [
  { key: "1-off", what: "NER off, resolver off: today's behaviour", env: { NER_MODE: "off", NER_SIDECAR: "0", ASK_NER: "0", RESOLVER: "off" }, requires: [] },
  { key: "2-resolver", what: "identity resolver only", env: { NER_MODE: "off", NER_SIDECAR: "0", ASK_NER: "0", RESOLVER: "on" }, requires: ["RESOLVER"] },
  { key: "3-gliner", what: "resolver + GLiNER, embedding match off", env: { NER_MODE: "on", NER_SIDECAR: "1", RESOLVER: "on", NER_EMBED: "off" }, requires: ["RESOLVER", "NER_MODE", "NER_EMBED"], sidecar: true },
  { key: "4-embed", what: "resolver + GLiNER + embedding match", env: { NER_MODE: "on", NER_SIDECAR: "1", RESOLVER: "on", NER_EMBED: "on" }, requires: ["RESOLVER", "NER_MODE", "NER_EMBED"], sidecar: true },
];
/** `"staged"` must appear as a string literal too: reading the flag isn't enough if only classic exists. */
export const PIPELINES: Option[] = [
  { key: "classic", what: "today's planner pipeline", env: { PLANNER_PIPELINE: "classic" }, requires: [] },
  { key: "staged", what: "staged planner pipeline", env: { PLANNER_PIPELINE: "staged" }, requires: ["PLANNER_PIPELINE", '"staged"'], pending: "F (orchestration adds PLANNER_PIPELINE=staged)" },
];
/** Planner models, through the provider env vars makePlanner reads. Luna is the target; the rest are comparisons. */
export const MODELS: Option[] = [
  { key: "luna", what: "GPT 6 Luna, low reasoning (codex-cli)", env: { PLANNER: "codex-cli", CODEX_MODEL: "gpt-6-luna", CODEX_FAST_MODEL: "gpt-6-luna", CODEX_REASONING: "low", CODEX_FAST_REASONING: "low" }, requires: [] },
  { key: "sol", what: "GPT 6.1 Sol, low reasoning (codex-cli)", env: { PLANNER: "codex-cli", CODEX_MODEL: "gpt-6.1-sol", CODEX_FAST_MODEL: "gpt-6.1-sol", CODEX_REASONING: "low", CODEX_FAST_REASONING: "low" }, requires: [] },
  { key: "env", what: "whatever PLANNER and the model vars in the environment select", env: {}, requires: [] },
];

/** The flags a cell sets: setup, then pipeline, then model, each over what the environment had. */
export const cellEnv = (s: Option, p: Option, m: Option): Record<string, string> => ({ ...s.env, ...p.env, ...m.env });

/** Flags of the cell the child's environment doesn't hold: the child refuses to run on them. */
export const envMismatch = (want: Record<string, string>, env: NodeJS.ProcessEnv) =>
  Object.entries(want).filter(([k, v]) => env[k] !== v).map(([k, v]) => `${k}=${env[k] ?? "(unset)"}, want ${v}`);

/** Why a cell can't run on this build, or undefined. `missing` lists the required flags the runtime source doesn't read. */
export function skipReason(opts: Option[], missing: (o: Option) => string[]): { kind: "pending" | "missing"; reason: string } | undefined {
  const gaps = opts.flatMap((o) => missing(o).map((f) => ({ o, f })));
  if (!gaps.length) return undefined;
  const pending = gaps.find((g) => g.o.pending);
  if (pending) return { kind: "pending", reason: `pending ${pending.o.pending}` };
  return { kind: "missing", reason: `this build reads no ${gaps.map((g) => g.f).join(", ")}` };
}

/**
 * For a setup that sets NER_EMBED, whether every NER call reported that same setting (the per-request flag the Node
 * client sends the sidecar). A cell fails when NER never ran, a call doesn't say, or one says the other setting.
 */
export function embedProblem(want: string | undefined, grades: NerGrade[]): string | undefined {
  if (!want) return undefined;
  const clean = grades.filter((g) => !g.infra);
  const seen = clean.flatMap((g) => g.ner?.embed ?? []);
  if (!clean.length) return undefined;
  if (!seen.length) return `NER_EMBED=${want} but no run reported a ner call`;
  const off = seen.filter((e) => e !== want);
  if (off.length) return `NER_EMBED=${want} but ${off.length}/${seen.length} ner calls reported embed ${[...new Set(off)].join("/")}`;
  return undefined;
}

/** What GET /health/ready answered: ready with the sidecar's versions, or why not. */
export function readiness(status: number, body: unknown): { ready: true; versions?: Record<string, unknown> } | { ready: false; reason: string } {
  const b = (body && typeof body === "object" ? body : {}) as { versions?: Record<string, unknown>; error?: string | null };
  if (status === 200) return { ready: true, ...(b.versions ? { versions: b.versions } : {}) };
  return { ready: false, reason: `HTTP ${status}${b.error ? `: ${b.error}` : ""}` };
}

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))]! : 0;
};
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

export function summarize(grades: NerGrade[]) {
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
  const embed: Record<string, number> = {};
  for (const e of clean.flatMap((g) => g.ner?.embed ?? [])) embed[e] = (embed[e] ?? 0) + 1;
  const versions = [...new Set(clean.flatMap((g) => (g.ner?.versions ? [JSON.stringify(g.ner.versions)] : [])))].map((v) => JSON.parse(v) as Record<string, unknown>);
  return {
    runs: grades.length,
    infraRuns: grades.length - clean.length,
    pass,
    passRate: clean.length ? round((100 * pass) / clean.length, 1) : 0,
    /** Cases that passed on every one of their (clean) repeats: the bar Luna must clear. */
    casesPassingEveryRepeat: [...perCase.values()].filter((xs) => xs.every(Boolean)).length,
    caseCount: perCase.size,
    /** Safety: runs that acted on or answered about a record the user didn't mean. Must be 0. */
    wrongRecordRuns: clean.filter((g) => g.wrongRecord.length).length,
    wrongRecords: clean.flatMap((g) => g.wrongRecord.map((w) => `${g.id}: ${w.how} ${w.id} (${w.why})`)),
    /** Safety: ambiguous-name runs that wrote, or singled a record out, without asking, whichever record. Must be 0. */
    unaskedGuessRuns: clean.filter((g) => g.unaskedGuess).length,
    unaskedGuesses: clean.filter((g) => g.unaskedGuess).map((g) => `${g.id}: ${g.observed}`),
    failuresByCause: Object.fromEntries(FAILURE_TAGS.map((t) => [t, clean.filter((g) => g.tags.includes(t)).length])) as Record<string, number>,
    asked: asked.length,
    /** Of the runs that asked, those whose answer led to a finished task. */
    askedThenFinished: asked.filter((g) => g.success).length,
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
    /** NER calls by the embed setting they reported, and the distinct sidecar versions seen. */
    ner: { embed, versions },
  };
}
export type Summary = ReturnType<typeof summarize>;
