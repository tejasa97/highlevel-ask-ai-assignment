// One chat over one database: plan a message, run it, hold it for approval, remember the last few turns.
// The HTTP app streams its events to the web UI; the scenario evals drive it headless, so both take the same path.
import type { CompiledPlan, CStep } from "../core/compile.js";
import { execute, type Approval, type Pending, type RunResult } from "../core/execute.js";
import { summarize } from "../core/summarize.js";
import { type Carry, type InfraKind, planTurn } from "../planner/turn.js";
import type { Planner, Tier } from "../planner/types.js";
import type { CallTrace } from "../registry/define.js";
import type { Registry } from "../registry/registry.js";
import type { Retriever } from "../retrieval/retrieve.js";
import type { Clock } from "../store/clock.js";
import type { Store } from "../store/db.js";
import { diff, snapshot } from "./diff.js";
import { rememberRecords, type WorkingRecord } from "./records.js";

const HISTORY_TURNS = 4;

export type Emit = (event: string, data: unknown) => void;

export interface ConversationDeps {
  registry: Registry;
  planner: Planner;
  retriever: Retriever;
}

interface Turn {
  id: string;
  message: string;
  plan: CompiledPlan;
  executionId: string;
  pending?: Pending;
  approvals?: Approval[];
}

export class Conversation {
  private turns = new Map<string, Turn>();
  private history: { user: string; assistant: string }[] = [];
  /** The last planned turn's actions, carried into the next retrieval so follow-ups keep their tools. */
  private carry: Carry | undefined;
  /** The messages the last reply asked a question about, if it did (kept across a chain of questions). */
  private answering: string | undefined;
  private records: WorkingRecord[] = [];

  constructor(
    private readonly deps: ConversationDeps,
    public world: { store: Store; clock: Clock },
  ) {}

  /** Forgets the chat and switches to another database. */
  reset(world: { store: Store; clock: Clock }): void {
    this.world = world;
    this.carry = this.answering = undefined;
    this.turns.clear();
    this.history.length = 0;
    this.records = [];
  }

  async ask(message: string, tier: Tier, actorId: string, emit: Emit): Promise<void> {
    const { registry, retriever, planner } = this.deps;
    const turnId = `t${this.turns.size + 1}_${Date.now().toString(36)}`;
    emit("turn", { turnId, message });
    const context = this.history.length ? this.history.slice(-HISTORY_TURNS).map((h) => `user: ${h.user}\nassistant: ${h.assistant}`).join("\n") : undefined;
    // A look runs reads only (planTurn checks), as this user, before the real plan.
    const look = async (plan: CompiledPlan) => {
      const onCall = (c: CallTrace) => emit("call", { ...c, ms: Math.round(c.ms * 10) / 10 });
      const r = await execute(plan, registry, { ...this.world, actorId, onCall }, { executionId: `look_${turnId}` });
      const steps = r.steps.map((s) => ({ id: s.id, ...(s.error ? { error: s.error.message } : { output: s.output }) }));
      const c = r.clarification;
      return c ? [...steps, { id: c.stepId, error: `more than one ${c.entity} matches "${c.name}": ${c.candidates.map((x) => x.name).join(", ")}` }] : steps;
    };
    const answering = this.answering;
    // A plan that fails on something the planner can fix (a record not found, a bad argument) before changing
    // anything gets one more try, with what went wrong.
    let failed: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const outcome = await planTurn(
        { message, tier, context, carry: this.carry, answering, records: this.records, failed },
        { registry, retriever, planner, clock: this.world.clock, store: this.world.store, look },
        (e) => emit(e.type, e.data),
      );
      if (outcome.kind === "reply") return this.finish(message, outcome.status, outcome.text, emit, outcome.options, outcome.infra);
      this.carry = outcome.carry;
      const id = attempt ? `${turnId}_retry` : turnId;
      const turn: Turn = { id, message, plan: outcome.plan, executionId: `ex_${id}` };
      this.turns.set(id, turn);
      emit("plan", { hash: turn.plan.hash, steps: turn.plan.steps.map(describeStep) });
      failed = await this.run(turn, actorId, emit, undefined, attempt === 0);
      if (!failed) return;
      emit("retry", { turnId: id, failed });
    }
  }

  async confirm(turnId: string, approve: boolean, actorId: string, emit: Emit): Promise<void> {
    const turn = this.turns.get(turnId);
    if (!turn?.pending) throw new Error(`Nothing is waiting for approval in turn ${turnId}`);
    emit("turn", { turnId, message: turn.message, resumed: true });
    if (!approve) {
      turn.pending = undefined;
      return this.finish(turn.message, "cancelled", "Cancelled. Nothing was changed by that step.", emit);
    }
    // A plan can have several independent external steps. Retain earlier approvals as later gates
    // are answered; passing only the newest one otherwise ping-pongs between the first two gates.
    // Replacement is per step, so changed targets still require their own new bound approval.
    turn.approvals = [...(turn.approvals ?? []).filter((a) => a.stepId !== turn.pending!.stepId), turn.pending];
    await this.run(turn, actorId, emit, turn.approvals);
  }

  /** Runs a turn's plan and replies, or with `mayRetry`, returns what went wrong instead when another plan could fix it. */
  private async run(turn: Turn, actorId: string, emit: Emit, approvals?: Approval[], mayRetry = false): Promise<string | undefined> {
    const { store } = this.world;
    const before = snapshot(store);
    const auditBefore = store.audit().length;
    const t = performance.now();
    const onCall = (c: CallTrace) => emit("call", { ...c, ms: Math.round(c.ms * 10) / 10 });
    const result: RunResult = await execute(
      turn.plan,
      this.deps.registry,
      { ...this.world, actorId, onCall },
      { executionId: turn.executionId, approvals, onEvent: (e) => emit("exec", e) },
    );
    emit("run", { status: result.status, ms: Math.round(performance.now() - t), steps: result.steps });
    this.records = rememberRecords(this.records, turn.plan, result);
    const audit = store.audit();
    emit("diff", { changes: diff(before, store), audit: audit.slice(0, audit.length - auditBefore) });

    turn.pending = result.pending;
    if (mayRetry && audit.length === auditBefore) {
      const failed = retryable(turn.plan, result);
      if (failed) return failed;
    }
    const text = summarize(turn.plan, result, this.deps.registry);
    if (result.status === "awaiting_confirmation") {
      emit("confirm", { turnId: turn.id, pending: result.pending });
      emit("reply", { status: result.status, text });
      return;
    }
    this.finish(turn.message, result.status, text, emit, result.clarification?.candidates.map((c) => (c.detail ? `${c.name} (${c.detail})` : c.name)));
  }

  private finish(message: string, status: string, text: string, emit: Emit, options?: string[], infra?: InfraKind): void {
    this.history.push({ user: message, assistant: text });
    const asked = status === "clarify" || status === "needs_clarification";
    this.answering = asked ? (this.answering ? `${this.answering}\n${message}` : message) : undefined;
    emit("reply", { status, text, options, ...(infra ? { infra } : {}) });
  }
}

const FIXABLE = new Set(["NOT_FOUND", "INVALID"]);

/** The failed plan and its errors, when the run failed only on errors a different plan could fix. */
function retryable(plan: CompiledPlan, result: RunResult): string | undefined {
  if (result.status !== "failed") return undefined;
  const errors = result.steps.flatMap((s) => {
    if (s.status !== "failed" || !s.error) return [];
    if (s.error.code === "ALL_FAILED") return (s.items ?? []).filter((i) => i.error).slice(0, 3).map((i) => ({ step: s.id, ...i.error! }));
    return [{ step: s.id, ...s.error }];
  });
  if (!errors.length || !errors.every((e) => FIXABLE.has(e.code))) return undefined;
  return JSON.stringify({ steps: plan.steps.map(describeStep), errors: errors.map((e) => `${e.step}: ${e.message}`) });
}

function describeStep(s: CStep) {
  const call = (c: { action: { id: string; name: string; risk: string }; args: unknown }) => ({ action: c.action.id, name: c.action.name, risk: c.action.risk, args: c.args });
  const base = { id: s.id, kind: s.kind, deps: s.deps };
  switch (s.kind) {
    case "action":
      return { ...base, calls: [call(s.call)] };
    case "resolve":
      return { ...base, entity: s.entity, name: s.name, ...(s.where ? { where: s.where } : {}) };
    case "filter":
      return { ...base, in: s.in, where: s.where };
    case "exclude":
      return { ...base, in: s.in, by: s.by, set: s.set };
    case "forEach":
      return { ...base, in: s.in, roundRobin: s.roundRobin, calls: s.calls.map(call) };
  }
}
