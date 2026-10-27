import { readdirSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { Pending } from "../core/execute.js";
import type { Planner, Tier, Usage } from "../planner/types.js";
import type { PlannerCallTrace } from "../planner/turn.js";
import { sumUsd } from "../planner/usage.js";
import type { Registry } from "../registry/registry.js";
import type { Retriever } from "../retrieval/retrieve.js";
import { BaselineConversation } from "../server/baseline.js";
import { Conversation } from "../server/conversation.js";
import type { Fixtures } from "../store/fixtures.js";
import { world } from "../store/world.js";
import { classifyFailure, type FailureClass } from "./failure-class.js";

// End-to-end scenarios (eval/scenarios/*.json): each one starts from a fresh seeded database, sends its
// messages through the same Conversation the web app uses, approves what asks for approval, then checks
// what was planned, the arguments of the calls that ran, the data afterwards (SQL) and the reply.

const Match = z.record(z.string(), z.unknown());
const Expect = z.strictObject({
  /** Allowed statuses of the last reply. */
  status: z.array(z.string()).optional(),
  /** Planned action ids, over all turns. "M05.A02|M05.A03" in includes is met by either, for reads that answer equally well. */
  actions: z.strictObject({ includes: z.array(z.string()).default([]), excludes: z.array(z.string()).default([]) }).optional(),
  /** For each entry, some call of that action ran with args containing `match` (see matches()). */
  args: z.array(z.strictObject({ action: z.string(), match: Match })).default([]),
  /** The first column of the first row must equal `equals`. */
  state: z.array(z.strictObject({ sql: z.string(), equals: z.unknown() })).default([]),
  /** Regexes (case-insensitive) on the last reply text. `excludes` is how to catch false claims. */
  reply: z.strictObject({ includes: z.array(z.string()).default([]), excludes: z.array(z.string()).default([]) }).optional(),
  /** Nothing in the data changed, over all turns. */
  noChanges: z.boolean().optional(),
  /** Some actual approval must contain these fields; asking an LLM question is not approval. */
  confirmation: Match.optional(),
});

export const ScenarioSchema = z.strictObject({
  id: z.string(),
  category: z.enum(["direct", "indirect", "multi", "followup", "ambiguous", "unsupported", "failure"]),
  modules: z.array(z.string()),
  note: z.string().optional(),
  setup: z
    .array(
      z.union([
        z.strictObject({ fixture: z.string(), with: z.record(z.string(), z.unknown()).default({}) }),
        z.strictObject({ fault: z.string(), code: z.string(), message: z.string().optional(), match: Match.optional(), times: z.number().int().optional() }),
      ]),
    )
    .default([]),
  turns: z
    .array(
      z.strictObject({
        user: z.string(),
        /** Approve what the turn asks approval for (the default), or decline it. */
        approve: z.boolean().default(true),
        /** Allowed statuses of this turn's last reply. */
        status: z.array(z.string()).optional(),
        /** What this user says if the assistant asks a question here; without it they say to go ahead (DEFAULT_ANSWER). */
        answer: z.string().optional(),
      }),
    )
    .min(1),
  expect: Expect,
});
export type Scenario = z.infer<typeof ScenarioSchema>;

export function loadScenarios(dir: string): Scenario[] {
  const out: Scenario[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const raw = JSON.parse(readFileSync(`${dir}/${file}`, "utf8")) as unknown[];
    raw.forEach((s, i) => {
      const parsed = ScenarioSchema.safeParse(s);
      if (!parsed.success) throw new Error(`${file} #${i + 1}: ${parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")}`);
      out.push(parsed.data);
    });
  }
  const ids = out.map((s) => s.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new Error(`duplicate scenario id ${dup}`);
  return out;
}

export interface Failure {
  /** status | action-missing | action-unwanted | args | state | reply | changes | error */
  kind: string;
  detail: string;
}

export interface PlannerReplyTrace {
  tier: Tier;
  /** The round the reply answered: plan, repair, plan after search_tools, ... */
  round: string;
  /** The parsed submit_plan object, before Zod validation. */
  reply: unknown;
}

export interface TurnTrace {
  user: string;
  status: string;
  reply: string;
  /** Actions the planner was shown, over its rounds: tells a retrieval miss from a planning one. */
  offered: string[];
  planned: string[];
  calls: { action: string; args: Record<string, unknown>; error?: string }[];
  plannerRounds: number;
  /** Every raw planner reply, with only the request's tier and round kept. */
  planner: PlannerReplyTrace[];
  /** Every planner call of the turn: model, prompt hashes, tokens, latency, retries, repairs (the execution trace). */
  plannerCalls?: PlannerCallTrace[];
  compileErrors: string[];
  errors: string[];
  approvals: number;
  confirmations?: Pending[];
  /** Why the planner couldn't answer, when that was outside the app (quota, timeout, provider down). */
  infra?: string;
  /** From sending the message to the first reply (the approval prompt, when there is one). */
  firstReplyMs: number;
  ms: number;
  /** The one clarifying question the run answered, and the answer it got. */
  clarified?: { question: string; answer: string };
}

export interface RunMetrics {
  ms: number;
  firstReplyMs: number;
  plannerMs: number;
  plannerRounds: number;
  /** Requests to the model behind those rounds, provider retries and agent-CLI tool turns included. */
  modelCalls?: number;
  /** Planner time the provider reported as model time; plannerMs minus this is client and process overhead. */
  plannerApiMs?: number;
  calls: number;
  /** Clarifying questions answered (at most one a run). */
  clarifications?: number;
  usage: Usage;
}

export interface ScenarioRun {
  id: string;
  category: Scenario["category"];
  pass: boolean;
  /** The run hit an infrastructure failure (see TurnTrace.infra): it measures nothing about the app. */
  infra?: string;
  failures: Failure[];
  /** The first system layer that failed; null on a pass or an infra run. See failure-class.ts. */
  failureClass?: FailureClass | null;
  turns: TurnTrace[];
  metrics: RunMetrics;
  /** Models the planner replied with, in order of first use. */
  models?: string[];
}

export interface RunDeps {
  registry: Registry;
  planner: Planner;
  retriever: Retriever;
  tier?: Tier;
  /** Which agent answers: the planner (default) or the one-call-per-step baseline (server/baseline.ts). */
  agent?: "planner" | "baseline";
}

const MAX_APPROVALS = 5;
/**
 * A run may ask one clarifying question it wasn't scripted to ask: the user answers it and the run is graded
 * on what happens next, as with a real user. A question for something the request already gave gets this reply,
 * so it can still succeed, but costs a turn and is counted (metrics.clarifications).
 */
export const DEFAULT_ANSWER = "That's everything I have. Please go ahead with what I asked, using sensible defaults for anything I didn't say.";


export async function runScenario(s: Scenario, deps: RunDeps): Promise<ScenarioRun> {
  const w = world();
  for (const step of s.setup) {
    if ("fault" in step) w.f.fault(step.fault, { code: step.code, message: step.message, match: step.match, times: step.times });
    else {
      const make = (w.f as unknown as Record<string, (o: unknown) => unknown>)[step.fixture];
      if (typeof make !== "function") throw new Error(`${s.id}: no fixture "${step.fixture}"`);
      make.call(w.f as Fixtures, step.with);
    }
  }
  const chat = deps.agent === "baseline" ? new BaselineConversation(deps, w) : new Conversation(deps, w);
  const turns: TurnTrace[] = [];
  const subscription = deps.planner.billing === "subscription";
  const usage: Usage = { input: 0, cachedRead: 0, cacheWrite: 0, output: 0, thinking: 0, costUsd: subscription ? null : 0, billing: subscription ? "subscription" : "none" };
  let plannerMs = 0;
  let changes = 0;
  const models: string[] = [];

  for (const t of s.turns) {
    const trace: TurnTrace = { user: t.user, status: "", reply: "", offered: [], planned: [], calls: [], plannerRounds: 0, planner: [], compileErrors: [], errors: [], approvals: 0, firstReplyMs: 0, ms: 0 };
    const started = performance.now();
    let pendingTurn: string | undefined;
    let roundTier: Tier = deps.tier ?? "strong";
    const emit = (event: string, data: any) => {
      if (event === "planner.request") {
        roundTier = data.tier;
        trace.offered.push(...data.actions.filter((a: string) => !trace.offered.includes(a)));
      } else if (event === "planner.reply") {
        trace.plannerRounds++;
        trace.planner.push({ tier: roundTier, round: data.label, reply: data.json });
        const { json: _, ...call } = data as PlannerCallTrace & { json: unknown };
        (trace.plannerCalls ??= []).push(call);
        plannerMs += data.latencyMs;
        if (data.model && !models.includes(data.model)) models.push(data.model);
        const next: Usage = data.usage;
        for (const k of ["input", "cachedRead", "cacheWrite", "output", "thinking"] as const) usage[k] += next[k];
        usage.costUsd = sumUsd([usage.costUsd, next.costUsd]);
        usage.billing = next.billing;
      } else if (event === "compile.errors") trace.compileErrors.push(...data.errors);
      else if (event === "plan") trace.planned.push(...data.steps.flatMap((st: { calls?: { action: string }[] }) => (st.calls ?? []).map((c) => c.action)));
      else if (event === "call") trace.calls.push({ action: data.action, args: data.args, ...(data.error ? { error: `${data.error.code}: ${data.error.message}` } : {}) });
      else if (event === "diff") changes += data.changes.length;
      else if (event === "confirm") {
        pendingTurn = data.turnId;
        (trace.confirmations ??= []).push(data.pending);
      }
      else if (event === "reply") {
        if (!trace.firstReplyMs) trace.firstReplyMs = Math.round(performance.now() - started);
        trace.status = data.status;
        trace.reply = data.text;
        if (data.infra) trace.infra = data.infra;
      }
    };
    const approve = async () => {
      while (pendingTurn && trace.approvals < MAX_APPROVALS) {
        const id = pendingTurn;
        pendingTurn = undefined;
        trace.approvals++;
        await chat.confirm(id, t.approve, "us_1", emit);
      }
    };
    const last = t === s.turns.at(-1);
    const askedFor = (t.status ?? []).includes("clarify") || (last && (s.expect.status ?? []).includes("clarify"));
    try {
      await chat.ask(t.user, deps.tier ?? "strong", "us_1", emit);
      await approve();
      if (trace.status === "clarify" && !askedFor && !turns.some((x) => x.clarified)) {
        trace.clarified = { question: trace.reply, answer: t.answer ?? DEFAULT_ANSWER };
        await chat.ask(trace.clarified.answer, deps.tier ?? "strong", "us_1", emit);
        await approve();
      }
    } catch (err) {
      trace.errors.push(err instanceof Error ? err.message : String(err));
    }
    trace.ms = Math.round(performance.now() - started);
    turns.push(trace);
  }

  const calls = turns.flatMap((t) => t.plannerCalls ?? []);
  const failures = check(s, turns, changes, (sql) => (Object.values((w.store.db.prepare(sql).get() as Record<string, unknown> | undefined) ?? {})[0]));
  w.store.close();
  const infra = turns.find((t) => t.infra)?.infra;
  return {
    id: s.id,
    category: s.category,
    pass: failures.length === 0,
    ...(infra ? { infra } : {}),
    failures,
    failureClass: infra ? null : classifyFailure({ category: s.category, expectedActions: s.expect.actions?.includes ?? [], failures, turns }),
    turns,
    metrics: {
      ms: turns.reduce((a, t) => a + t.ms, 0),
      firstReplyMs: turns[0]!.firstReplyMs,
      plannerMs,
      plannerRounds: turns.reduce((a, t) => a + t.plannerRounds, 0),
      modelCalls: calls.reduce((a, c) => a + c.attempts * c.modelCalls, 0),
      ...(calls.length && calls.every((c) => c.apiMs !== undefined) ? { plannerApiMs: calls.reduce((a, c) => a + c.apiMs!, 0) } : {}),
      calls: turns.reduce((a, t) => a + t.calls.length, 0),
      clarifications: turns.filter((t) => t.clarified).length,
      usage,
    },
    models,
  };
}

export function check(s: Scenario, turns: TurnTrace[], changes: number, query: (sql: string) => unknown): Failure[] {
  const out: Failure[] = [];
  const e = s.expect;
  const last = turns.at(-1)!;
  for (const t of turns) for (const msg of t.errors) out.push({ kind: "error", detail: msg });
  s.turns.forEach((t, i) => {
    if (t.status && !t.status.includes(turns[i]!.status)) out.push({ kind: "status", detail: `turn ${i + 1}: ${turns[i]!.status || "(no reply)"}, wanted ${t.status.join("|")}` });
  });
  if (e.status && !e.status.includes(last.status)) out.push({ kind: "status", detail: `${last.status || "(no reply)"}, wanted ${e.status.join("|")}` });

  const planned = new Set(turns.flatMap((t) => t.planned));
  const offered = new Set(turns.flatMap((t) => t.offered));
  // A read the planner ran in a look round never reaches the final plan, but it did the work the scenario asks for.
  const executed = new Set(turns.flatMap((t) => t.calls.filter((c) => !c.error).map((c) => c.action)));
  for (const id of e.actions?.includes ?? []) {
    if (!id.split("|").some((x) => planned.has(x) || executed.has(x))) out.push({ kind: "action-missing", detail: `${id} not planned (${id.split("|").some((x) => offered.has(x)) ? "was offered" : "not offered"}; planned: ${[...planned].join(", ") || "nothing"})` });
  }
  for (const id of e.actions?.excludes ?? []) if (planned.has(id)) out.push({ kind: "action-unwanted", detail: `${id} was planned` });

  const calls = turns.flatMap((t) => t.calls);
  for (const a of e.args) {
    const ran = calls.filter((c) => c.action === a.action);
    if (!ran.some((c) => matches(c.args, a.match))) {
      out.push({ kind: "args", detail: `${a.action} ${JSON.stringify(a.match)}; ran with ${ran.length ? ran.map((c) => JSON.stringify(c.args)).slice(0, 3).join(" / ") : "no calls"}` });
    }
  }

  for (const st of e.state) {
    let got: unknown;
    try {
      got = query(st.sql);
    } catch (err) {
      got = `SQL error: ${(err as Error).message}`;
    }
    if (!same(got, st.equals)) out.push({ kind: "state", detail: `${st.sql} → ${JSON.stringify(got)}, wanted ${JSON.stringify(st.equals)}` });
  }

  for (const re of e.reply?.includes ?? []) if (!new RegExp(re, "i").test(last.reply)) out.push({ kind: "reply", detail: `missing /${re}/` });
  for (const re of e.reply?.excludes ?? []) if (new RegExp(re, "i").test(last.reply)) out.push({ kind: "reply", detail: `says /${re}/` });
  if (e.noChanges && changes > 0) out.push({ kind: "changes", detail: `${changes} records changed` });
  if (e.confirmation && !turns.flatMap((t) => t.confirmations ?? []).some((p) => matches(p, e.confirmation)))
    out.push({ kind: "confirmation", detail: `no approval matched ${JSON.stringify(e.confirmation)}` });
  return out;
}

/** Objects match by subset, arrays when every expected element matches some actual one, strings
 *  case-insensitively; `{ "$contains": "x" }` matches a string containing x, `{ "$absent": true }` a missing value. */
export function matches(actual: unknown, expected: unknown): boolean {
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    const o = expected as Record<string, unknown>;
    if ("$contains" in o) return typeof actual === "string" && actual.toLowerCase().includes(String(o.$contains).toLowerCase());
    if ("$absent" in o) return actual === undefined || actual === null;
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
    return Object.entries(o).every(([k, v]) => matches((actual as Record<string, unknown>)[k], v));
  }
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.every((x) => actual.some((y) => matches(y, x)));
  return same(actual, expected);
}

function same(a: unknown, b: unknown): boolean {
  if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase();
  // SQLite gives back numbers for counts and 0/1 for booleans.
  if (typeof b === "boolean") return a === b || a === (b ? 1 : 0);
  return a === b || (a == null && b == null);
}
