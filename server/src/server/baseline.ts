// The baseline agent: the usual tool-calling loop, one action per model call, for comparison with the planner.
// It gets what the planner gets (the same retrieval shortlist, name mentions, resolvers, context and approval
// rules) and differs only in how it plans: each model call picks one call, sees its result, and picks the next,
// until it replies to the user. No $refs, no forEach: ids are copied from results by the model.
// Same ask/confirm API and events as Conversation, so the scenario runner drives either one.
import { compile, type CompiledPlan } from "../core/compile.js";
import { execute, type Pending, type RunResult } from "../core/execute.js";
import { userBlock } from "../planner/prompt.js";
import { type Carry, callTrace, carryOf, type InfraKind, PLANNER_TIMEOUT_MS, TurnStopped, withDeadline } from "../planner/turn.js";
import { type Planner, PlannerError, type Tier } from "../planner/types.js";
import type { CallTrace } from "../registry/define.js";
import type { RegisteredAction, Registry } from "../registry/registry.js";
import { mentions } from "../retrieval/mentions.js";
import type { Retriever } from "../retrieval/retrieve.js";
import type { Clock } from "../store/clock.js";
import type { Store } from "../store/db.js";
import type { ConversationDeps, Emit } from "./conversation.js";
import { diff, snapshot } from "./diff.js";
import { z } from "zod";

const HISTORY_TURNS = 4;
/** Model calls per turn before the agent gives up. */
export const MAX_STEPS = 15;
/** Characters of one result shown to the model. */
const RESULT_MAX = 3000;

export const BASELINE_SYSTEM = `You are Ask AI, an assistant inside a CRM. You act by calling tools, one per reply, and see each result before the next.
Reply with one object. Set unused fields to null.
  call          run one action from <actions>: action id, args in argsJson as a JSON object string
  resolve       turn a person or team name into a record id: entity (one of <resolvable>) and name
  search_tools  the actions you need are not in <actions>; put what's missing in query ("send an SMS")
  done          the request is finished; text tells the user what was done, from the results
  clarify       ONE question in text, only when a required detail is missing; options if there are choices
  unsupported   no listed action can do this; say why in text
  answer        a direct answer in text, from <context> or the results
Rules:
- Use only action ids from <actions>. Results of your calls are in <steps>; copy ids from them. Never invent ids.
- <mentions> says which record type each name in the message matched; resolve it as that entity.
- <not_available> lists catalog actions that fit the request but aren't in this version. If the request
  needs one, reply unsupported and name it.
- To do something to many records, call the action once per record.
- If a call fails, fix the args and retry, or tell the user what failed in done.
- Text the user reads names actions in plain words, never by id.
- Don't invent values the user didn't give (no due dates, no emails). Dates come from <now>.
- Don't ask for confirmation; the app asks the user before risky changes.`;

const nullable = (t: string) => ({ type: [t, "null"] });
export const BASELINE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["type", "action", "argsJson", "entity", "name", "query", "text", "options"],
  properties: {
    type: { enum: ["call", "resolve", "search_tools", "done", "clarify", "unsupported", "answer"] },
    action: nullable("string"),
    argsJson: nullable("string"),
    entity: nullable("string"),
    name: nullable("string"),
    query: nullable("string"),
    text: nullable("string"),
    options: { type: ["array", "null"], items: { type: "string" } },
  },
} as const;

const Reply = z.object({
  type: z.enum(["call", "resolve", "search_tools", "done", "clarify", "unsupported", "answer"]),
  action: z.string().nullish(),
  argsJson: z.string().nullish(),
  entity: z.string().nullish(),
  name: z.string().nullish(),
  query: z.string().nullish(),
  text: z.string().nullish(),
  options: z.array(z.string()).nullish(),
});
type Reply = z.infer<typeof Reply>;

/** One tool call and what came of it, as the model sees it in <steps>. */
interface Step {
  call: string;
  result: string;
  /** Set for action calls: the action and whether it worked, for the turn's final status. */
  action?: { id: string; ok: boolean };
}

/** One message in progress: what was offered, what ran, and the call waiting for approval, if any. */
interface Turn {
  id: string;
  message: string;
  offered: RegisteredAction[];
  notAvailable: string[];
  seen: Set<string>;
  searched: boolean;
  steps: Step[];
  rounds: number;
  context?: string;
  tier: Tier;
  named: { name: string; entity: string; count: number }[];
  ran: CompiledPlan[];
  pending?: { plan: CompiledPlan; executionId: string; approval: Pending; label: string };
  signal?: AbortSignal;
}

export class BaselineConversation {
  private turns = new Map<string, Turn>();
  private history: { user: string; assistant: string }[] = [];
  private carry: Carry | undefined;
  private answering: string | undefined;

  constructor(
    private readonly deps: ConversationDeps & { plannerTimeoutMs?: number },
    public world: { store: Store; clock: Clock },
  ) {}

  reset(world: { store: Store; clock: Clock }): void {
    this.world = world;
    this.carry = this.answering = undefined;
    this.turns.clear();
    this.history.length = 0;
  }

  async ask(message: string, tier: Tier, actorId: string, emit: Emit, signal?: AbortSignal): Promise<void> {
    const { registry, retriever } = this.deps;
    const id = `t${this.turns.size + 1}_${Date.now().toString(36)}`;
    emit("turn", { turnId: id, message });
    const query = this.answering ? `${this.answering}\n${message}` : message;
    const turn: Turn = {
      id,
      message,
      offered: [],
      notAvailable: [],
      seen: new Set(),
      searched: false,
      steps: [],
      rounds: 0,
      tier,
      ran: [],
      context: this.history.length ? this.history.slice(-HISTORY_TURNS).map((h) => `user: ${h.user}\nassistant: ${h.assistant}`).join("\n") : undefined,
      named: mentions(query, registry, this.world.store),
      signal,
    };
    this.turns.set(id, turn);
    await shortlist(turn, retriever, registry, query, this.carry, emit);
    await this.loop(turn, actorId, emit);
  }

  async confirm(turnId: string, approve: boolean, actorId: string, emit: Emit): Promise<void> {
    const turn = this.turns.get(turnId);
    const p = turn?.pending;
    if (!turn || !p) throw new Error(`Nothing is waiting for approval in turn ${turnId}`);
    emit("turn", { turnId, message: turn.message, resumed: true });
    turn.pending = undefined;
    if (!approve) return this.finish(turn.message, "cancelled", "Cancelled. Nothing was changed by that step.", emit);
    const r = await this.exec(p.plan, p.executionId, actorId, emit, [p.approval]);
    turn.steps.push(observe(p.label, p.plan, r));
    if (r.status === "awaiting_confirmation") return this.hold(turn, p.plan, p.executionId, r, p.label, emit);
    await this.loop(turn, actorId, emit);
  }

  /** Ask the model for the next call, run it, show it the result; until it replies or a call needs approval. */
  private async loop(turn: Turn, actorId: string, emit: Emit): Promise<void> {
    const { registry } = this.deps;
    try {
      for (;;) {
        if (turn.rounds >= MAX_STEPS) return this.close(turn, "failed", `I stopped after ${MAX_STEPS} steps without finishing.`, emit);
        turn.rounds++;
        const raw = await this.call(turn, emit);
        const parsed = Reply.safeParse(raw);
        if (!parsed.success) return this.close(turn, "failed", `The model's reply didn't match the schema: ${parsed.error.message}`, emit);
        const d = parsed.data;

        if (d.type === "search_tools") {
          if (turn.searched) turn.steps.push({ call: `search_tools ${d.query ?? ""}`, result: "error: you already searched once; use <actions> or reply unsupported" });
          else {
            turn.searched = true;
            await shortlist(turn, this.deps.retriever, registry, d.query || turn.message, undefined, emit);
            turn.steps.push({ call: `search_tools ${d.query ?? ""}`, result: "new actions were added to <actions>" });
          }
          continue;
        }

        if (d.type === "call" || d.type === "resolve") {
          const label = d.type === "call" ? `call ${d.action} ${d.argsJson ?? "{}"}` : `resolve ${d.entity} "${d.name}"`;
          const step =
            d.type === "call"
              ? { id: `s${turn.ran.length + 1}`, kind: "action" as const, action: d.action ?? "", argsJson: d.argsJson ?? "{}" }
              : { id: `s${turn.ran.length + 1}`, kind: "resolve" as const, entity: d.entity ?? "", name: d.name ?? "" };
          const compiled = compile(
            { type: "plan", steps: [step], question: null, options: null, reason: null, alternatives: null, query: null, text: null },
            registry,
            new Set(turn.offered.map((a) => a.id)),
          );
          if (!compiled.ok) {
            emit("compile.errors", { errors: compiled.errors });
            turn.steps.push({ call: label, result: `error: ${compiled.errors.join("; ")}` });
            continue;
          }
          const plan = compiled.plan;
          turn.ran.push(plan);
          emit("plan", { hash: plan.hash, steps: plan.steps.map((s) => ({ id: s.id, kind: s.kind, ...(s.kind === "action" ? { calls: [{ action: s.call.action.id, name: s.call.action.name, risk: s.call.action.risk, args: s.call.args }] } : {}) })) });
          const executionId = `ex_${turn.id}_${turn.ran.length}`;
          const r = await this.exec(plan, executionId, actorId, emit);
          if (r.status === "awaiting_confirmation") return this.hold(turn, plan, executionId, r, label, emit);
          turn.steps.push(observe(label, plan, r));
          continue;
        }

        const text = d.text ?? "";
        if (d.type === "clarify" || d.type === "unsupported") return this.close(turn, d.type, text, emit, d.options ?? undefined);
        // done, or an answer after calls ran: the status comes from what the calls did.
        const acted = turn.steps.filter((s) => s.action);
        if (d.type === "answer" && !acted.length) return this.close(turn, "answer", text, emit);
        return this.close(turn, outcome(acted.map((s) => s.action!)), text, emit);
      }
    } catch (err) {
      if (err instanceof TurnStopped) return this.close(turn, "failed", err.message, emit);
      if (!(err instanceof PlannerError)) throw err;
      const text = err.kind === "timeout" ? `${err.message}. Please try again.` : `The model failed: ${err.message}`;
      return this.close(turn, "failed", text, emit, undefined, err.kind === "bad_json" ? undefined : err.kind);
    }
  }

  private async call(turn: Turn, emit: Emit): Promise<unknown> {
    const { clock } = this.world;
    const resolvable = this.deps.registry.resolverEntities();
    const user = [
      userBlock({ clock, actions: turn.offered, notAvailable: turn.notAvailable, resolvable, mentions: turn.named, message: turn.message, context: turn.context }),
      `<steps>\n${turn.steps.length ? turn.steps.map((s, i) => `${i + 1}. ${s.call}\n   → ${s.result}`).join("\n") : "none yet"}\n</steps>`,
    ].join("\n");
    const label = `step ${turn.rounds}`;
    emit("planner.request", { label, tier: turn.tier, system: BASELINE_SYSTEM, user, actions: turn.offered.map((a) => a.id) });
    const r = await withDeadline(
      this.deps.plannerTimeoutMs ?? PLANNER_TIMEOUT_MS,
      (signal) => this.deps.planner.plan({ tier: turn.tier, system: BASELINE_SYSTEM, user, schema: BASELINE_SCHEMA, signal }),
      turn.signal,
    );
    emit("planner.reply", { ...callTrace(label, turn.rounds, BASELINE_SYSTEM, user, r), json: r.json });
    return r.json;
  }

  private async exec(plan: CompiledPlan, executionId: string, actorId: string, emit: Emit, approvals?: Pending[]): Promise<RunResult> {
    const { store } = this.world;
    const before = snapshot(store);
    const auditBefore = store.audit().length;
    const t = performance.now();
    const onCall = (c: CallTrace) => emit("call", { ...c, ms: Math.round(c.ms * 10) / 10 });
    const r = await execute(plan, this.deps.registry, { ...this.world, actorId, onCall }, { executionId, approvals, onEvent: (e) => emit("exec", e) });
    emit("run", { status: r.status, ms: Math.round(performance.now() - t), steps: r.steps });
    const audit = store.audit();
    emit("diff", { changes: diff(before, store), audit: audit.slice(0, audit.length - auditBefore) });
    return r;
  }

  private hold(turn: Turn, plan: CompiledPlan, executionId: string, r: RunResult, label: string, emit: Emit): void {
    turn.pending = { plan, executionId, approval: r.pending!, label };
    emit("confirm", { turnId: turn.id, pending: r.pending });
    emit("reply", { status: r.status, text: `This needs your approval: ${r.pending!.reason}.` });
  }

  private close(turn: Turn, status: string, text: string, emit: Emit, options?: string[], infra?: InfraKind): void {
    if (turn.ran.length) this.carry = carryOf({ ...turn.ran[0]!, steps: turn.ran.flatMap((p) => p.steps) }, this.deps.registry);
    this.finish(turn.message, status, text, emit, options, infra);
  }

  private finish(message: string, status: string, text: string, emit: Emit, options?: string[], infra?: InfraKind): void {
    this.history.push({ user: message, assistant: text });
    const asked = status === "clarify" || status === "needs_clarification";
    this.answering = asked ? (this.answering ? `${this.answering}\n${message}` : message) : undefined;
    emit("reply", { status, text, options, ...(infra ? { infra } : {}) });
  }
}

/** Adds the retriever's picks for `message` to what the turn offers (the planner's shortlist, same options). */
async function shortlist(turn: Turn, retriever: Retriever, registry: Registry, message: string, context: Carry | undefined, emit: Emit): Promise<void> {
  const r = retriever.retrieve(await retriever.prepare({ message, context, resolvable: registry.resolverEntities(), mentions: turn.named, exclude: [...turn.seen] }));
  for (const p of r.picks) {
    turn.seen.add(p.id);
    const impl = registry.get(p.id);
    if (impl) turn.offered.push(impl);
    else if (p.why === "bm25" || p.why === "dense") turn.notAvailable.push(`${p.id} ${retriever.card(p.id)!.name}`);
  }
  emit("retrieval", { label: "retrieve", query: r.query, picks: r.picks, ms: r.ms });
}

/** What one call did, as a line for <steps>. */
function observe(label: string, plan: CompiledPlan, r: RunResult): Step {
  const s = r.steps[0];
  const planned = plan.steps[0]!;
  const action = planned.kind === "action" ? { id: planned.call.action.id, ok: s?.status === "done" } : undefined;
  let result: string;
  if (r.clarification) result = `more than one ${r.clarification.entity} matches "${r.clarification.name}": ${r.clarification.candidates.map((c) => (c.detail ? `${c.name} (${c.detail})` : c.name)).join(", ")}`;
  else if (s?.error) result = `error ${s.error.code}: ${s.error.message}`;
  else result = JSON.stringify(s?.output ?? null);
  if (result.length > RESULT_MAX) result = `${result.slice(0, RESULT_MAX)}…(cut)`;
  return { call: label, result, ...(action ? { action } : {}) };
}

/** done when every action that failed was later made to work; failed when none worked; partial otherwise. */
export function outcome(calls: { id: string; ok: boolean }[]): "done" | "partial" | "failed" {
  if (!calls.length) return "done";
  if (!calls.some((c) => c.ok)) return "failed";
  const fixed = calls.every((c, i) => c.ok || calls.slice(i + 1).some((l) => l.id === c.id && l.ok));
  return fixed ? "done" : "partial";
}
