// One chat over one database: plan a message, run it, hold it for approval, remember the last few turns.
// The HTTP app streams its events to the web UI; the scenario evals drive it headless, so both take the same path.
import { type CompiledPlan, type CStep, fedArgument, planDigest } from "../core/compile.js";
import { execute, type Approval, type Pending, type RunResult } from "../core/execute.js";
import { type IdentityBinding, type IdentityResolution, heldWhere, optionLabel, resolveIdentity, revalidate, tableOfId, userSelected } from "../core/identity.js";
import { emptyRead, runtimeNoMatch } from "../core/no-match.js";
import { shownRecords, summarize, type Shown } from "../core/summarize.js";
import { type Carry, type InfraKind, planTurn, type TurnDeps } from "../planner/turn.js";
import type { Planner, Tier } from "../planner/types.js";
import type { CallTrace } from "../registry/define.js";
import type { Registry } from "../registry/registry.js";
import type { Retriever } from "../retrieval/retrieve.js";
import type { Clock } from "../store/clock.js";
import type { Doc, Store } from "../store/db.js";
import { type Answer, type ClarificationView, Clarifications, type ClarifyConfig, clarifyConfig, type OpenInput, type Paused } from "./clarify.js";
import { diff, snapshot } from "./diff.js";
import { rememberRecords, type WorkingRecord } from "./records.js";

const HISTORY_TURNS = 4;

export type Emit = (event: string, data: unknown) => void;

export interface ConversationDeps {
  registry: Registry;
  planner: Planner;
  retriever: Retriever;
  /** NER extract+link for planTurn; tests inject a fake. */
  ner?: TurnDeps["ner"];
  /** Record questions: how long one stays open and how many rounds it gets. `now` is for tests. */
  clarify?: Partial<ClarifyConfig> & { now?: () => number };
}

interface Turn {
  id: string;
  message: string;
  /** The message with the ones it answers ("the one at Umbrella" after "move Zoe Costa…"), for telling names apart. */
  request: string;
  /** Everything the user said in the turns the planner saw, this one included. */
  said: string;
  plan: CompiledPlan;
  executionId: string;
  /** The planner's verdict on a question, said above what the reads found. */
  answer?: string;
  pending?: Pending;
  approvals?: Approval[];
}

export class Conversation {
  private turns = new Map<string, Turn>();
  private history: { user: string; assistant: string }[] = [];
  /** The last planned turn's actions, carried into the next retrieval so follow-ups keep their tools. */
  private carry: Carry | undefined;
  /**
   * The messages the last reply asked a question about, if it did (kept across a chain of questions). Only for the
   * planner's own questions (a missing title): a question about which record is stored in `clarifications` instead.
   */
  private answering: string | undefined;
  private records: WorkingRecord[] = [];
  private clarifications: Clarifications;

  constructor(
    private readonly deps: ConversationDeps,
    public world: { store: Store; clock: Clock },
  ) {
    this.clarifications = this.newClarifications();
  }

  private newClarifications(): Clarifications {
    const { now, ...config } = this.deps.clarify ?? {};
    return new Clarifications({ ...clarifyConfig(), ...config }, now);
  }

  /** Forgets the chat and switches to another database. */
  reset(world: { store: Store; clock: Clock }): void {
    this.world = world;
    this.carry = this.answering = undefined;
    this.turns.clear();
    this.history.length = 0;
    this.records = [];
    this.clarifications = this.newClarifications();
  }

  /** `signal` aborts when the client stops listening: planning stops, and a plan already made doesn't run. */
  async ask(message: string, tier: Tier, actorId: string, emit: Emit, signal?: AbortSignal): Promise<void> {
    const turnId = `t${this.turns.size + 1}_${Date.now().toString(36)}`;
    emit("turn", { turnId, message });
    // An open record question takes the message first, matched against its own candidates only. A message that
    // reads as a new request, or arrives after the question expired, is planned fresh.
    const answered = this.clarifications.reply(message);
    if (answered && answered.kind !== "superseded" && answered.kind !== "expired") return this.settle(answered, message, actorId, emit);
    return this.plan(message, tier, actorId, emit, turnId, { answering: this.answering, signal });
  }

  /** Plans a message and runs it. `picks` are records the user chose for names in it, after a look asked which. */
  private async plan(message: string, tier: Tier, actorId: string, emit: Emit, turnId: string, opts: { answering?: string; picks?: IdentityBinding[]; signal?: AbortSignal }): Promise<void> {
    const { registry, retriever, planner } = this.deps;
    const { answering, picks, signal } = opts;
    const context = this.history.length ? this.history.slice(-HISTORY_TURNS).map((h) => `user: ${h.user}\nassistant: ${h.assistant}`).join("\n") : undefined;
    const request = answering ? `${answering}\n${message}` : message;
    const said = [...this.history.slice(-HISTORY_TURNS).map((h) => h.user), request].join("\n");
    // A look runs reads only (planTurn checks), as this user, before the real plan.
    const look = async (plan: CompiledPlan) => {
      const onCall = (c: CallTrace) => emit("call", { ...c, ms: Math.round(c.ms * 10) / 10 });
      const r = await execute(plan, registry, { ...this.world, actorId, onCall }, { executionId: `look_${turnId}`, request, said });
      const steps = r.steps.map((s) => ({ id: s.id, ...(s.error ? { error: s.error.message } : { output: s.output }) }));
      const c = r.clarification;
      return c ? [...steps, { id: c.stepId, error: `more than one ${c.entity} matches "${c.name}": ${c.candidates.map((x) => x.name).join(", ")}` }] : steps;
    };
    // A plan that fails on something the planner can fix (a record not found, a bad argument) before changing
    // anything gets one more try, with what went wrong.
    let failed: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const outcome = await planTurn(
        { message, tier, context, carry: this.carry, answering, records: this.records, failed, ...(picks?.length ? { picks } : {}) },
        { registry, retriever, planner, clock: this.world.clock, store: this.world.store, look, signal, ...(this.deps.ner ? { ner: this.deps.ner } : {}) },
        (e) => emit(e.type, e.data),
      );
      if (outcome.kind === "reply" && outcome.paused) {
        // The resolver asked about one lookup of a compiled plan: store the question with the plan, to resume it.
        const { plan, stepId, resolution, replan } = outcome.paused;
        const step = plan.steps.find((s) => s.id === stepId);
        const scope = step?.kind === "resolve" ? heldWhere(resolution, step.where) : undefined;
        const c = this.open({
          source: replan ? "look" : "resolver", plan, turnId, stepId, resolution, request, said, ...(scope ? { where: scope } : {}),
          ...(replan ? { replan: { message, tier, ...(answering ? { answering } : {}), picks: picks ?? [] } } : {}),
        });
        return this.finish(message, outcome.status, outcome.text, emit, outcome.options, undefined, undefined, c);
      }
      if (outcome.kind === "reply") return this.finish(message, outcome.status, outcome.text, emit, outcome.options, outcome.infra);
      if (signal?.aborted) return this.finish(message, "failed", "The request was cancelled. Nothing was changed.", emit);
      this.carry = outcome.carry;
      const id = attempt ? `${turnId}_retry` : turnId;
      const turn: Turn = { id, message, request, said, plan: outcome.plan, executionId: `ex_${id}`, answer: outcome.answer };
      this.turns.set(id, turn);
      emit("plan", { hash: turn.plan.hash, steps: turn.plan.steps.map(describeStep) });
      failed = await this.run(turn, actorId, emit, undefined, attempt === 0);
      if (!failed) return;
      emit("retry", { turnId: id, failed });
    }
  }

  /** A click on one option of a record question. A token this conversation didn't issue is refused. */
  async choose(clarificationId: string, optionToken: string | null, actorId: string, emit: Emit): Promise<void> {
    const answered = optionToken === null ? this.clarifications.cancel(clarificationId) : this.clarifications.choose(clarificationId, optionToken);
    if (answered.kind === "refused") throw new Error(`That choice isn't one this chat offered (${answered.reason}). Nothing was changed.`);
    const c = this.clarifications.get(clarificationId)!;
    const picked = answered.kind === "picked" ? c.candidates.find((o) => o.id === answered.candidate.id)?.label : undefined;
    emit("turn", { turnId: c.turnId, message: picked ?? "None of these", resumed: true });
    return this.settle(answered, picked ?? "None of these", actorId, emit);
  }

  /** Acts on an answer to a record question; the question's state has already moved. */
  private async settle(answered: Exclude<Answer, { kind: "refused" }>, message: string, actorId: string, emit: Emit): Promise<void> {
    const c = answered.clarification;
    const what = c.entity.replaceAll("_", " ");
    // Every reply this answer ends with is kept, so answering the same question again gives it back.
    const remembering: Emit = (event, data) => {
      if (event === "reply") this.clarifications.remember(c.id, data);
      emit(event, data);
    };
    switch (answered.kind) {
      case "replay":
        return void emit("reply", answered.result ? { ...(answered.result as object), replayed: true } : { status: "answer", text: "That answer is already being handled.", replayed: true });
      case "expired":
      case "superseded":
        return this.finish(message, "cancelled", `That question is no longer open, so nothing was changed. Ask again if you still want it.`, emit);
      case "cancelled":
        return this.finish(message, "cancelled", `OK, none of them. Nothing was changed.`, remembering);
      case "gave_up":
        return this.finish(message, "cancelled", `I couldn't pin down which ${what} you meant by "${c.text}", so nothing was changed.`, remembering);
      case "again": {
        const lead = answered.why === "several" ? `More than one of them matches "${message}".` : `I couldn't match "${message}" to one of them.`;
        return this.finish(message, "clarify", `${lead} Which ${what} did you mean by "${c.text}"? Pick one, or say "none of these".`, emit, c.candidates.map((o) => o.label), undefined, undefined, c);
      }
      case "picked":
        return this.resume(answered, message, actorId, remembering);
    }
  }

  /** Binds the pick as user-selected and runs the stored plan from where it paused, after checking the record still holds. */
  private async resume(answered: Extract<Answer, { kind: "picked" }>, message: string, actorId: string, emit: Emit): Promise<void> {
    const { clarification: c, candidate, paused } = answered;
    const { registry } = this.deps;
    const { store } = this.world;
    const what = c.entity.replaceAll("_", " ");
    if (planDigest(paused.plan) !== c.planHash) return this.finish(message, "failed", "The paused plan doesn't match the question it asked, so nothing was changed.", emit);
    const binding = userSelected(c.entity, c.text, candidate, store, paused.where);
    // The record may have changed since the question was asked: never write to it silently.
    const stale = revalidate(binding, { registry, store });
    if (stale) {
      this.clarifications.replace(c.id);
      const again = c.round < this.clarifyRounds() ? resolveIdentity({ entity: c.entity, text: c.text, ...(paused.where ? { where: paused.where } : {}), actionRisk: "write", qualifiers: paused.request }, { registry, store }) : undefined;
      const cands = again ? (again.kind === "bound" ? again.candidates : again.kind === "not_found" ? [] : again.candidates) : [];
      if (!again || !cands.length) return this.finish(message, "cancelled", `${stale.message}, so nothing was changed. I couldn't find another ${what} to use for "${c.text}".`, emit);
      const next = this.open({ ...paused, turnId: c.turnId, stepId: c.stepId, ...(c.argument ? { argument: c.argument } : {}), resolution: { ...again, candidates: cands }, ranked: cands, round: c.round + 1 });
      return this.finish(message, "clarify", `${stale.message}, so nothing was changed. Which ${what} should I use for "${c.text}"?`, emit, next.candidates.map((o) => o.label), undefined, undefined, next);
    }
    const id = `${c.turnId}_${c.round}_${this.turns.size + 1}`;
    if (paused.replan) {
      // A look asked: plan the message again, the pick (and any before it) bound to its name.
      emit("clarify.resolved", { clarificationId: c.id, stepId: c.stepId, binding });
      const { message: asked, tier, answering, picks } = paused.replan;
      return this.plan(asked, tier, actorId, emit, id, { ...(answering ? { answering } : {}), picks: [...picks, binding] });
    }
    const plan = bindSteps(paused.plan, { [c.stepId]: binding });
    // The paused run's execution id: what it wrote before the pause comes back from the ledger instead of running again.
    const turn: Turn = { id, message, request: paused.request, said: paused.said, plan, executionId: paused.executionId ?? `ex_${id}`, ...(paused.approvals ? { approvals: paused.approvals } : {}) };
    this.turns.set(id, turn);
    emit("clarify.resolved", { clarificationId: c.id, stepId: c.stepId, binding });
    emit("plan", { hash: plan.hash, steps: plan.steps.map(describeStep) });
    await this.run(turn, actorId, emit, turn.approvals);
  }

  private clarifyRounds(): number {
    return this.deps.clarify?.maxRounds ?? clarifyConfig().maxRounds;
  }

  /** Stores a record question, with each candidate's other keys (an email) for answers in the user's words. */
  private open(input: Omit<OpenInput, "keys" | "ranked"> & { ranked?: OpenInput["ranked"]; resolution: Pick<IdentityResolution, "entity" | "text" | "candidates"> }) {
    const keys: Record<string, string[]> = {};
    for (const c of input.resolution.candidates) {
      const t = tableOfId(c.id);
      const row = t ? this.world.store.get<Doc>(t, c.id) : undefined;
      if (typeof row?.email === "string") keys[c.id] = [row.email];
    }
    return this.clarifications.open({ ...input, ranked: input.ranked ?? input.resolution.candidates, keys, ...(input.argument ?? fedArgument(input.plan, input.stepId) ? { argument: input.argument ?? fedArgument(input.plan, input.stepId)!.arg } : {}) });
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
      { executionId: turn.executionId, approvals, onEvent: (e) => emit("exec", e), request: turn.request, said: turn.said },
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
    const summary = summarize(turn.plan, result, this.deps.registry);
    // The verdict was read from the look; if the same reads didn't finish this time, it may no longer hold.
    const text = turn.answer && result.status === "done" ? `${turn.answer}\n${summary}` : summary;
    const records = shownRecords(turn.plan, result, this.deps.registry);
    if (result.status === "awaiting_confirmation") {
      emit("confirm", { turnId: turn.id, pending: result.pending });
      emit("reply", { status: result.status, text, ...(records.length ? { records } : {}) });
      return;
    }
    // A lookup that found several records (or only near misses) pauses the plan at that step: store the question.
    const asked = result.clarification;
    const step = asked && turn.plan.steps.find((s) => s.id === asked.stepId);
    const stored = asked?.resolution && step?.kind === "resolve"
      ? this.open({
          source: "lookup", plan: bindSteps(turn.plan, asked.bindings ?? {}), turnId: turn.id, stepId: asked.stepId, resolution: asked.resolution, request: turn.request, said: turn.said,
          executionId: turn.executionId, ...(approvals?.length ? { approvals } : {}), ...(asked.where ? { where: asked.where } : {}),
        })
      : undefined;
    this.finish(turn.message, result.status, text, emit, asked?.candidates.map(optionLabel), undefined, records, stored);
  }

  private finish(message: string, status: string, text: string, emit: Emit, options?: string[], infra?: InfraKind, records?: Shown[], stored?: Parameters<Clarifications["view"]>[0]): void {
    this.history.push({ user: message, assistant: text });
    // A stored record question is answered by its own state; only the planner's other questions carry the text over.
    const asked = !stored && (status === "clarify" || status === "needs_clarification");
    this.answering = asked ? (this.answering ? `${this.answering}\n${message}` : message) : undefined;
    const clarification: ClarificationView | undefined = stored && this.clarifications.view(stored);
    emit("reply", { status, text, options, ...(clarification ? { clarification } : {}), ...(infra ? { infra } : {}), ...(records?.length ? { records } : {}) });
  }
}

const FIXABLE = new Set(["NOT_FOUND", "INVALID"]);
/** "isn't a current member; join the community first": a conflict a plan can fix by doing the named step before. */
const prerequisite = (e: { code: string; message: string }) => e.code === "CONFLICT" && /\bfirst\b/i.test(e.message);

/** The failed plan and its errors, when the run failed only on errors a different plan could fix. */
export function retryable(plan: CompiledPlan, result: RunResult): string | undefined {
  // What a lookup that found nothing searched for, so the next plan can widen or correct it.
  const noMatch = runtimeNoMatch(plan, result);
  const empty = emptyRead(plan, result);
  const attempt = (errors: string[]) => JSON.stringify({ steps: plan.steps.map(describeStep), errors: noMatch ? [...errors, noMatch] : errors, ...(empty ? { empty: [empty] } : {}) });
  const errors = result.status !== "failed" ? [] : result.steps.flatMap((s) => {
    if (s.status !== "failed" || !s.error) return [];
    if (s.error.code === "ALL_FAILED") return (s.items ?? []).filter((i) => i.error).slice(0, 3).map((i) => ({ step: s.id, ...i.error! }));
    return [{ step: s.id, ...s.error }];
  });
  if (errors.length && errors.every((e) => FIXABLE.has(e.code) || prerequisite(e))) return attempt(errors.map((e) => `${e.step}: ${e.message}`));
  return noMatch ? attempt([]) : undefined;
}

/** The plan with these resolve steps bound: execution revalidates each binding instead of resolving the name again. */
function bindSteps(plan: CompiledPlan, bound: Record<string, IdentityBinding>): CompiledPlan {
  if (!Object.keys(bound).length) return plan;
  return { ...plan, steps: plan.steps.map((s) => (s.kind === "resolve" && bound[s.id] ? { ...s, bound: bound[s.id] } : s)) };
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
