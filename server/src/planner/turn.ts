import { compile, type CompiledPlan } from "../core/compile.js";
import { card } from "../registry/card.js";
import type { RegisteredAction, Registry } from "../registry/registry.js";
import { type Mention, mentions } from "../retrieval/mentions.js";
import type { Retrieval, Retriever } from "../retrieval/retrieve.js";
import type { Clock } from "../store/clock.js";
import type { Store } from "../store/db.js";
import { repairBlock, SYSTEM, userBlock } from "./prompt.js";
import { SUBMIT_PLAN_SCHEMA, SubmitPlan } from "./submit-plan.js";
import { type PlanResult, type Planner, PlannerError, type Tier } from "./types.js";

// The planning half of a turn, shared by the dev server and the CLI:
//   retrieve a shortlist → prompt → plan, with at most one search_tools round (a second retrieval for what the
//   planner says is missing), at most one look round (read-only steps run now, their results fed back, so a
//   value can be worked out from a record: "same time, on Monday") and at most one repair round (compile errors
//   fed back), in any order → a compiled plan or a reply. At most four planner calls. The plan may only use
//   actions the planner was shown.

/** How long one planner call may take before the turn gives up on it. */
export const PLANNER_TIMEOUT_MS = 120_000;

export interface TurnDeps {
  registry: Registry;
  retriever: Retriever;
  planner: Planner;
  clock: Clock;
  /** Records to link names in the message against (see mentions.ts). Without it, names aren't linked. */
  store?: Store;
  /** Per planner call; defaults to PLANNER_TIMEOUT_MS. */
  plannerTimeoutMs?: number;
  /** Runs a read-only plan and gives back each step's output, for a look round. Without it, look isn't offered. */
  look?: (plan: CompiledPlan) => Promise<{ id: string; output?: unknown; error?: string }[]>;
}

export interface TurnInput {
  message: string;
  tier: Tier;
  /** Recent conversation, for the <context> block. */
  context?: string;
  /** The previous turn's actions and the record types they returned, so a follow-up keeps its tools. */
  carry?: Carry;
  /** Set when the last reply was a question: the message it asked about, so retrieval sees both. */
  answering?: string;
}

export interface Carry {
  prev: string[];
  entities: string[];
}

export type TurnEvent =
  | { type: "retrieval"; data: RetrievalTrace }
  | { type: "planner.request"; data: { label: string; tier: Tier; system: string; user: string; actions: string[] } }
  | { type: "planner.reply"; data: { label: string; model: string; latencyMs: number; usage: PlanResult["usage"]; json: unknown } }
  | { type: "compile.errors"; data: { errors: string[] } };

export type TurnOutcome =
  | { kind: "plan"; plan: CompiledPlan; carry: Carry }
  | {
      kind: "reply";
      status: "clarify" | "unsupported" | "answer" | "failed";
      text: string;
      options?: string[];
      /** Set when the planner couldn't be reached or didn't answer: the turn failed for a reason outside the app. */
      infra?: InfraKind;
    };

export type InfraKind = Exclude<PlannerError["kind"], "bad_json">;

export interface RetrievalTrace {
  label: string;
  query: string;
  clauses: string[];
  terms: string[];
  noMatch: boolean;
  mentions: Mention[];
  topScore: number;
  ms: number;
  /** Time spent embedding the question, with the embedding model loaded. */
  embedMs?: number;
  picks: (Retrieval["picks"][number] & { name: string; module: string; available: boolean })[];
  /** Characters of action cards in the prompt: what was sent vs. every implemented action. */
  promptChars: { sent: number; allImplemented: number };
}

export async function planTurn(input: TurnInput, deps: TurnDeps, emit: (e: TurnEvent) => void = () => {}): Promise<TurnOutcome> {
  try {
    return await planTurnUnguarded(input, deps, emit);
  } catch (err) {
    // A provider failure or a call that never returned ends the turn with a reply; anything else is a bug and surfaces.
    if (!(err instanceof PlannerError)) throw err;
    const text = err.kind === "timeout" ? `${err.message}. Nothing was changed; please try again.` : `The planner failed: ${err.message}`;
    return failed(text, err.kind === "bad_json" ? undefined : err.kind);
  }
}

async function planTurnUnguarded(input: TurnInput, deps: TurnDeps, emit: (e: TurnEvent) => void): Promise<TurnOutcome> {
  const { registry, retriever, planner, clock, store } = deps;
  const resolvable = registry.resolverEntities();
  const named: Mention[] = store ? mentions(input.answering ? `${input.answering}\n${input.message}` : input.message, registry, store) : [];
  const allChars = registry.list().map(card).join("\n").length;

  const offered: RegisteredAction[] = [];
  const notAvailable: string[] = [];
  const seen = new Set<string>();
  const shortlist = async (label: string, message: string, context?: Carry, linked: Mention[] = []) => {
    const started = performance.now();
    const r = retriever.retrieve(await retriever.prepare({ message, context, resolvable, mentions: linked, exclude: [...seen] }));
    const embedMs = retriever.hybrid ? Math.round(performance.now() - started - r.ms) : undefined;
    for (const p of r.picks) {
      seen.add(p.id);
      const impl = registry.get(p.id);
      if (impl) offered.push(impl);
      else if (p.why === "bm25" || p.why === "dense") notAvailable.push(`${p.id} ${retriever.card(p.id)!.name}`);
    }
    emit({
      type: "retrieval",
      data: {
        label,
        query: r.query,
        clauses: r.clauses,
        terms: r.terms,
        noMatch: r.noMatch,
        mentions: linked,
        topScore: r.topScore,
        ms: r.ms,
        embedMs,
        picks: r.picks.map((p) => {
          const c = retriever.card(p.id)!;
          return { ...p, name: c.name, module: c.module, available: c.available };
        }),
        promptChars: { sent: offered.map(card).join("\n").length, allImplemented: allChars },
      },
    });
  };
  let looked: string | undefined;
  const prompt = () =>
    userBlock({ clock, actions: offered, notAvailable, resolvable, mentions: named, message: input.message, context: input.context, looked });
  const call = async (user: string, label: string) => {
    emit({ type: "planner.request", data: { label, tier: input.tier, system: SYSTEM, user, actions: offered.map((a) => a.id) } });
    const r = await withDeadline(deps.plannerTimeoutMs ?? PLANNER_TIMEOUT_MS, (signal) => planner.plan({ tier: input.tier, system: SYSTEM, user, schema: SUBMIT_PLAN_SCHEMA, signal }));
    emit({ type: "planner.reply", data: { label, model: r.model, latencyMs: Math.round(r.latencyMs), usage: r.usage, json: r.json } });
    return r;
  };

  await shortlist("retrieve", input.answering ? `${input.answering}\n${input.message}` : input.message, input.carry, named);
  let user = prompt();
  let reply = await call(user, "plan");
  let searched = false;
  let repaired = false;
  let lookPlan: CompiledPlan | undefined;
  // Each reply is one of: search_tools (retrieve once more, re-plan), a plan (compile; repair once if invalid),
  // or a reply for the user. The repair prompt may itself say "reply search_tools" or "reply unsupported".
  for (;;) {
    const parsed = SubmitPlan.safeParse(reply.json);
    if (!parsed.success) return failed(`The planner's reply didn't match submit_plan: ${parsed.error.message}`);
    const d = parsed.data;

    if (d.type === "search_tools") {
      if (searched) return { kind: "reply", status: "unsupported", text: `I couldn't find an action for that${d.query ? ` (${d.query})` : ""}.` };
      searched = true;
      // Retrieve again on the planner's own description of what's missing; the new cards join the old ones.
      await shortlist("search_tools", d.query || input.message);
      user = prompt();
      reply = await call(user, "plan after search_tools");
      continue;
    }

    if (d.type === "look") {
      // Reads only, run now; a write waits for the real plan (and its approval). A bad look is repaired like a plan.
      const compiled = compile({ ...d, type: "plan" }, registry, new Set(offered.map((a) => a.id)));
      const errors = !deps.look
        ? ["look isn't available here; reply with a plan or a question"]
        : looked !== undefined
          ? ["you already looked; plan with the results in <looked>"]
          : !compiled.ok
            ? compiled.errors
            : compiled.plan.steps.flatMap((s) => callsOf(s).filter((a) => a.risk !== "read").map((a) => `${s.id}: ${a.id} is a ${a.risk} action; a look may only read`));
      if (errors.length || !compiled.ok) {
        emit({ type: "compile.errors", data: { errors } });
        if (repaired) return failed(`The plan was still invalid after one repair:\n${errors.join("\n")}`);
        repaired = true;
        reply = await call(repairBlock(user, reply.json, errors), "repair");
        continue;
      }
      lookPlan = compiled.plan;
      looked = JSON.stringify(await deps.look!(compiled.plan));
      if (looked.length > LOOKED_MAX) looked = `${looked.slice(0, LOOKED_MAX)}…(cut)`;
      user = prompt();
      reply = await call(user, "plan after look");
      continue;
    }

    // Answering from <looked> would put the planner's prose (and raw ids) where the summary of the reads belongs:
    // the reads were the plan.
    if (d.type === "answer" && lookPlan) return { kind: "plan", plan: lookPlan, carry: carryOf(lookPlan, registry) };

    if (d.type !== "plan") {
      const text = [d.question ?? d.reason ?? d.text ?? "", d.alternatives?.length ? `Alternatives: ${d.alternatives.join("; ")}` : ""].filter(Boolean).join("\n");
      return { kind: "reply", status: d.type, text, options: d.options ?? undefined };
    }

    const compiled = compile(d, registry, new Set(offered.map((a) => a.id)));
    // A plan that only finds records does nothing the user can see: run, it would end "done" with no reply.
    const errors = !compiled.ok
      ? compiled.errors
      : compiled.plan.steps.some((s) => callsOf(s).length)
        ? []
        : ["the plan only finds records and calls no action; add the actions that do what was asked, or look to read what you need first"];
    if (compiled.ok && !errors.length) return { kind: "plan", plan: compiled.plan, carry: carryOf(compiled.plan, registry) };
    emit({ type: "compile.errors", data: { errors } });
    if (repaired) return failed(`The plan was still invalid after one repair:\n${errors.join("\n")}`);
    repaired = true;
    reply = await call(repairBlock(user, reply.json, errors), "repair");
  }
}

/** Characters of look results shown to the planner. */
const LOOKED_MAX = 6000;

const callsOf = (s: CompiledPlan["steps"][number]) => (s.kind === "action" ? [s.call.action] : s.kind === "forEach" ? s.calls.map((c) => c.action) : []);

/** What a follow-up turn inherits: the actions this plan used and the record types they return. */
export function carryOf(plan: CompiledPlan, registry: Registry): Carry {
  const prev = [...new Set(plan.steps.flatMap((s) => callsOf(s).map((a) => a.id)))];
  const entities = [...new Set(prev.map((id) => registry.get(id)?.entities?.produces).filter((e): e is string => !!e))];
  return { prev, entities };
}

/** Runs `fn`, aborting its signal and rejecting if it hasn't settled after `ms`. */
async function withDeadline<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort();
      reject(new PlannerError(`The planner didn't answer within ${Math.round(ms / 1000)} s`, "timeout"));
    }, ms);
  });
  try {
    return await Promise.race([fn(ctl.signal), expired]);
  } finally {
    clearTimeout(timer);
  }
}

const failed = (text: string, infra?: InfraKind): TurnOutcome => ({ kind: "reply", status: "failed", text, ...(infra ? { infra } : {}) });
