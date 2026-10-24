import { compile, type CompiledPlan } from "../core/compile.js";
import { card } from "../registry/card.js";
import type { RegisteredAction, Registry } from "../registry/registry.js";
import { type Mention, mentions } from "../retrieval/mentions.js";
import type { Retrieval, Retriever } from "../retrieval/retrieve.js";
import type { Clock } from "../store/clock.js";
import type { Store } from "../store/db.js";
import { readOnlyIntentError } from "./completion.js";
import { repairBlock, SYSTEM, userBlock } from "./prompt.js";
import { SUBMIT_PLAN_SCHEMA, SubmitPlan, type Step } from "./submit-plan.js";
import { type PlanResult, type Planner, PlannerError, type Tier } from "./types.js";

// The planning half of a turn, shared by the dev server and the CLI:
//   retrieve a shortlist → prompt → plan, with at most two search_tools rounds (the second only when the
//   first added new actions), at most one look round (read-only steps run now, their results fed back, so a
//   value can be worked out from a record) and at most one repair round, in any order. An exhausted search
//   budget gets one instruction to plan with the offered cards. At most six planner calls; only offered
//   actions may be used.

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
  /** A proven runtime lookup miss from a previous, write-free attempt of this turn. */
  runtimeNoMatch?: string;
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
  mode: Retrieval["mode"];
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
        mode: r.mode,
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
    userBlock({ clock, actions: offered, notAvailable, resolvable, mentions: named, message: input.message, context: input.context, looked, runtimeNoMatch: input.runtimeNoMatch });
  const call = async (user: string, label: string) => {
    emit({ type: "planner.request", data: { label, tier: input.tier, system: SYSTEM, user, actions: offered.map((a) => a.id) } });
    const r = await withDeadline(deps.plannerTimeoutMs ?? PLANNER_TIMEOUT_MS, (signal) => planner.plan({ tier: input.tier, system: SYSTEM, user, schema: SUBMIT_PLAN_SCHEMA, signal }));
    emit({ type: "planner.reply", data: { label, model: r.model, latencyMs: Math.round(r.latencyMs), usage: r.usage, json: r.json } });
    return r;
  };

  await shortlist("retrieve", input.answering ? `${input.answering}\n${input.message}` : input.message, input.carry, named);
  let user = prompt();
  let reply = await call(user, "plan");
  let searches = 0;
  let searchAdded = false;
  let searchClosed = false;
  let repaired = false;
  let lookPlan: CompiledPlan | undefined;
  let lookSteps: Step[] = [];
  // Search and repair have independent, bounded budgets.
  for (;;) {
    const parsed = SubmitPlan.safeParse(reply.json);
    if (!parsed.success) {
      const errors = parsed.error.issues.map((i) => `submit_plan ${i.path.join(".") || "(reply)"}: ${i.message}`);
      emit({ type: "compile.errors", data: { errors } });
      if (repaired) return failed(`The planner's reply still didn't match submit_plan after one repair:\n${errors.join("\n")}`);
      repaired = true;
      reply = await call(repairBlock(user, reply.json, errors), "repair");
      continue;
    }
    const d = parsed.data;

    if (d.type === "search_tools") {
      if (searches >= 2 || (searches > 0 && !searchAdded)) {
        if (searchClosed) return { kind: "reply", status: "unsupported", text: "No further tool search is available for this request." };
        searchClosed = true;
        reply = await call(`${prompt()}\n<errors>Tool search is exhausted; plan with the actions already listed, or reply unsupported if none does it.</errors>`, "plan after search limit");
        continue;
      }
      searches++;
      const before = offered.length;
      // Retrieve again on the planner's own description; only progress allows another search.
      await shortlist("search_tools", d.query || input.message);
      searchAdded = offered.length > before;
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
      lookSteps = d.steps ?? [];
      looked = JSON.stringify(await deps.look!(compiled.plan));
      if (looked.length > LOOKED_MAX) looked = `${looked.slice(0, LOOKED_MAX)}…(cut)`;
      user = prompt();
      reply = await call(user, "plan after look");
      continue;
    }

    // Answering from <looked> would put the planner's prose (and raw ids) where the summary of the reads belongs:
    // the reads were the plan. But an answer must not bypass the read-only completion check for a write request.
    if (d.type === "answer" && lookPlan) {
      const errors = readOnlyIntentError(input.message, lookPlan, offered);
      if (!errors.length) return { kind: "plan", plan: lookPlan, carry: carryOf(lookPlan, registry) };
      emit({ type: "compile.errors", data: { errors } });
      if (repaired) return failed(`The plan was still incomplete after one repair:\n${errors.join("\n")}`);
      repaired = true;
      reply = await call(repairBlock(user, reply.json, errors), "repair");
      continue;
    }

    if (d.type !== "plan") {
      const text = [d.question ?? d.reason ?? d.text ?? "", d.alternatives?.length ? `Alternatives: ${d.alternatives.join("; ")}` : ""].filter(Boolean).join("\n");
      // "Unsupported" only means nothing on the shortlist fits, and the shortlist came from the user's loose wording.
      // Before believing it, retrieve once more on the planner's own description; re-plan only if that finds new cards.
      if (d.type === "unsupported" && searches === 0) {
        searches++;
        const before = offered.length;
        await shortlist("search_tools", `${text}\n${input.message}`);
        searchAdded = offered.length > before;
        if (searchAdded) {
          user = prompt();
          reply = await call(user, "plan after search_tools");
          continue;
        }
      }
      return { kind: "reply", status: d.type, text, options: d.options ?? undefined };
    }

    const compiled = compile(withLookSteps(d, lookSteps), registry, new Set(offered.map((a) => a.id)));
    // A plan that only finds records does nothing the user can see: run, it would end "done" with no reply.
    const errors = !compiled.ok
      ? compiled.errors
      : compiled.plan.steps.some((s) => callsOf(s).length)
        ? readOnlyIntentError(input.message, compiled.plan, offered)
        : ["the plan only finds records and calls no action; add the actions that do what was asked, or look to read what you need first"];
    if (compiled.ok && !errors.length) return { kind: "plan", plan: compiled.plan, carry: carryOf(compiled.plan, registry) };
    emit({ type: "compile.errors", data: { errors } });
    if (repaired) return failed(`The plan was still invalid after one repair:\n${errors.join("\n")}`);
    repaired = true;
    reply = await call(repairBlock(user, reply.json, errors), "repair");
  }
}

/**
 * The planner plans again after a look and may still refer to the look's steps ("$s1"), as it did while writing them.
 * Those reads are cheap and safe to run again, so a plan that refers to one gets it (and what it reads from) put first.
 */
export function withLookSteps(plan: SubmitPlan, look: Step[]): SubmitPlan {
  if (!look.length || !plan.steps) return plan;
  const own = new Set(plan.steps.map((s) => s.id));
  const byId = new Map(look.filter((s) => !own.has(s.id)).map((s) => [s.id, s]));
  // argsJson and whereJson are strings holding JSON, so scan the step's text for "$id" rather than walking it.
  const rootsOf = (s: Step) => [...JSON.stringify(s).matchAll(/\$([A-Za-z_]\w*)/g)].map((m) => m[1]!);
  const needed = new Set<string>();
  const visit = (s: Step) => {
    for (const root of rootsOf(s)) {
      const dep = byId.get(root);
      if (dep && !needed.has(root)) {
        needed.add(root);
        visit(dep);
      }
    }
  };
  plan.steps.forEach(visit);
  return needed.size ? { ...plan, steps: [...look.filter((s) => needed.has(s.id)), ...plan.steps] } : plan;
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
export async function withDeadline<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
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
