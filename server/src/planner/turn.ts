import { compile, type CompiledPlan } from "../core/compile.js";
import { narrowByRequest } from "../core/execute.js";
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
//   first added new actions), at most two look rounds (read-only steps run now, their results fed back, so a
//   value can be worked out from a record; a second may build on the first) and at most one repair round, in any order. An exhausted search
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
  const request = input.answering ? `${input.answering}\n${input.message}` : input.message;
  const named: Mention[] = store ? mentions(request, registry, store) : [];
  const allChars = registry.list().map(card).join("\n").length;
  const exists = (id: string) => !store || store.tables().some((t) => store.get(t, id) !== undefined);

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

  await shortlist("retrieve", request, input.carry, named);
  let user = prompt();
  let reply = await call(user, "plan");
  let searches = 0;
  let searchAdded = false;
  let searchClosed = false;
  let repaired = false;
  let lookPlan: CompiledPlan | undefined;
  let lookSteps: Step[] = [];
  let looks = 0;
  let lookClosed = false;
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

    if (d.type === "look" && deps.look && looks >= LOOKS_MAX && !lookClosed) {
      // Like the search limit: one plain nudge, so asking for a third look doesn't spend the one repair.
      lookClosed = true;
      reply = await call(`${prompt()}\n<errors>You already looked twice; plan with the results in <looked>.</errors>`, "plan after look limit");
      continue;
    }

    if (d.type === "look") {
      // Reads only, run now; a write waits for the real plan (and its approval). A bad look is repaired like a plan.
      // A second look builds on the first (a contact found, then its invoices), so it may refer to the first's steps.
      const compiled = compile(withLookSteps({ ...d, type: "plan" }, lookSteps), registry, new Set(offered.map((a) => a.id)));
      const errors = !deps.look
        ? ["look isn't available here; reply with a plan or a question"]
        : looks >= LOOKS_MAX
          ? ["you already looked twice; plan with the results in <looked>"]
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
      looks++;
      lookPlan = compiled.plan;
      lookSteps = withLookSteps({ ...d, type: "plan" }, lookSteps).steps ?? [];
      looked = JSON.stringify(await deps.look!(compiled.plan));
      if (looked.length > LOOKED_MAX) looked = `${looked.slice(0, LOOKED_MAX)}…(cut)`;
      user = prompt();
      reply = await call(user, "plan after look");
      continue;
    }

    // Answering from <looked> would put the planner's prose (and raw ids) where the summary of the reads belongs:
    // the reads were the plan. But an answer must not bypass the read-only completion check for a write request.
    if (d.type === "answer" && lookPlan) {
      const errors = readOnlyIntentError(input.message, lookPlan, offered, registry);
      if (!errors.length) return { kind: "plan", plan: lookPlan, carry: carryOf(lookPlan, registry) };
      emit({ type: "compile.errors", data: { errors } });
      if (repaired) return failed(`The plan was still incomplete after one repair:\n${errors.join("\n")}`);
      repaired = true;
      reply = await call(repairBlock(user, reply.json, errors), "repair");
      continue;
    }

    // An answer is what <context> already says. With no earlier turn and nothing looked up, there is nothing to answer
    // from, so the account must be read first ("Has tic_1 breached its SLA?"). One nudge; a second answer stands.
    if (d.type === "answer" && !input.context && !lookPlan && !repaired && offered.some((a) => a.risk === "read")) {
      const errors = ["there is no <context> or <looked> to answer from; if a listed action reads or checks what was asked, plan it (its result is the answer); otherwise reply answer again"];
      emit({ type: "compile.errors", data: { errors } });
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
      : inventedIds(compiled.plan, user, exists).length
        ? inventedIds(compiled.plan, user, exists)
        : compiled.plan.steps.some((s) => callsOf(s).length)
          ? readOnlyIntentError(input.message, compiled.plan, offered, registry)
          : ["the plan only finds records and calls no action; add the actions that do what was asked, or look to read what you need first"];
    if (compiled.ok && !errors.length) {
      const which = store && oneOfSameNamed(compiled.plan, named, registry, store, request);
      if (which) return { kind: "reply", status: "clarify", ...which };
      return { kind: "plan", plan: compiled.plan, carry: carryOf(compiled.plan, registry) };
    }
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
const LOOKS_MAX = 2;

/** A record id is short letters, an underscore, then the rest: ct_31, tic_1, us_5. */
const ID_SHAPED = /^[a-z]{2,4}_[A-Za-z0-9_]+$/;

/**
 * Literal ids the planner wrote that appear nowhere it was shown (the message, <context>, <looked>, the cards) and
 * that no record has: "tk_placeholder", "ct_sarah_johnson_1". Each would fail as "not found" at run time.
 * Only id-valued args (…Id, …Ids, id) and literal forEach lists are checked, so enum values like "in_progress" pass.
 */
export function inventedIds(plan: CompiledPlan, shown: string, exists: (id: string) => boolean = () => false): string[] {
  const found = new Set<string>();
  const invented = (v: string) => ID_SHAPED.test(v) && !shown.includes(v) && !exists(v);
  const visit = (v: unknown, key: string) => {
    if (typeof v === "string") {
      if (/(?:^id|Ids?)$/.test(key) && invented(v)) found.add(v);
    } else if (Array.isArray(v)) v.forEach((x) => visit(x, key));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) visit(x, k);
  };
  for (const s of plan.steps) {
    for (const a of s.kind === "action" ? [s.call] : s.kind === "forEach" ? s.calls : []) visit(a.args, "");
    if (s.kind === "forEach") [s.in, s.roundRobin].forEach((l) => Array.isArray(l) && l.filter(invented).forEach((x) => found.add(x)));
  }
  return [...found].map((id) => `"${id}" is not an id from the message, <context> or <looked>; never invent ids. Resolve the name, read the record with a listed action (or look), or use a $ref to an earlier step.`);
}

/**
 * A write that names one of several same-named records by id ("Maple Dental" twice; it looked and took bl_1) when
 * the user's words don't say which: the user is asked, as a resolve step would. Writing to all of them is a choice.
 */
export function oneOfSameNamed(plan: CompiledPlan, named: Mention[], registry: Registry, store: Store, request: string): { text: string; options: string[] } | undefined {
  const ids = new Set<string>();
  const visit = (v: unknown): void => {
    if (typeof v === "string") ids.add(v);
    else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") Object.values(v).forEach(visit);
  };
  for (const s of plan.steps) {
    const calls = s.kind === "action" ? [s.call] : s.kind === "forEach" ? s.calls : [];
    if (calls.some((c) => c.action.risk !== "read")) {
      calls.forEach((c) => visit(c.args));
      if (s.kind === "forEach" && Array.isArray(s.in)) visit(s.in);
    }
  }
  for (const m of named.filter((n) => n.count > 1)) {
    const found = (registry.resolver(m.entity)?.(store, m.name) ?? []).filter((c) => !c.inactive);
    const hit = found.filter((c) => ids.has(c.id));
    if (found.length < 2 || !hit.length || hit.length === found.length || narrowByRequest(found, request).length === 1) continue;
    const options = found.map((c) => (c.detail ? `${c.name} (${c.detail})` : c.name));
    return { text: `More than one ${m.entity} matches "${m.name}": ${options.join(", ")}. Which one?`, options };
  }
  return undefined;
}

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
