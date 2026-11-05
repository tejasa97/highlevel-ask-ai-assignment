import { createHash } from "node:crypto";
import { compile, type CompiledPlan } from "../core/compile.js";
import { narrowByRequest } from "../core/execute.js";
import { type Made, revisable } from "../core/revise.js";
import { lowerLookups } from "../core/lookups.js";
import { type IdentityBinding, type IdentityResolution, optionLabel, resolveIdentity } from "../core/identity.js";
import { card } from "../registry/card.js";
import type { LookupWhere, RegisteredAction, Registry } from "../registry/registry.js";
import { type Mention, mentions, withTextFields } from "../retrieval/mentions.js";
import type { NerSidecarResponse } from "../retrieval/ner_sidecar_contract.js";
import { askScopedExtract, askScopePushPending } from "../retrieval/ner_ask_scope.js";
import { bindNerLookups, fromNer, type IdentityDecision, typeDoubtOf } from "./ner_bind.js";
import {
  mergeMentions,
  nerBreaker,
  nerEmbed,
  type NerMode,
  nerMode,
  nerSidecarUrl,
  nerTimeoutMs,
  type NerTrace,
  runNer,
  spansToMentions,
} from "../retrieval/ner_client.js";
import type { Retrieval, Retriever } from "../retrieval/retrieve.js";
import type { Clock } from "../store/clock.js";
import type { Store } from "../store/db.js";
import { readOnlyIntentError, toldPart } from "./completion.js";
import { repairBlock, SYSTEM, userBlock } from "./prompt.js";
import { SUBMIT_PLAN_SCHEMA, SubmitPlan } from "./submit-plan.js";
import { type PlanResult, type Planner, PlannerError, type Tier } from "./types.js";
import { emptyTargets, leavesOutError, outcomeErrors, type Outcome, selectionReadback } from "./contracts.js";
import { assessClarification, namesField } from "./clarification.js";
import { appendPlannerDebug, debugReason, type PlannerDebug, plannerDebugEnabled } from "./debug.js";

// The planning half of a turn, shared by the dev server and the CLI:
//   retrieve a shortlist → prompt → plan, with at most two search_tools rounds (a second retrieval for what the
//   planner says is missing), at most two look rounds (read-only steps run now, their results fed back, so a
//   value can be worked out from a record: "same time, on Monday"; a second may build on the first) and at most
//   one repair round (compile errors fed back; a second when the first left fewer errors), plus at most one repair of a malformed clarification (its own allowance, so it can't use up the plan's) and at most
//   one grounded identity clarification retry → a compiled plan or a reply. The plan may only use
//   actions the planner was shown.
// Every turn also has a budget: at most MAX_PLANNER_CALLS calls, TURN_DEADLINE_MS of wall clock across them, and
// none at all once the caller's signal aborts (the client went away). A spent budget ends the turn with a reply.

/** How long one planner call may take before the turn gives up on it. */
export const PLANNER_TIMEOUT_MS = 120_000;
/** Planner calls one turn may make. Turns in the evals use 1–3, and 8 at the most. */
export const MAX_PLANNER_CALLS = 8;
/** How long one turn may spend planning, across all its calls. */
export const TURN_DEADLINE_MS = 180_000;

export interface TurnDeps {
  registry: Registry;
  retriever: Retriever;
  planner: Planner;
  clock: Clock;
  /** Records to link names in the message against (see mentions.ts). Without it, names aren't linked. */
  store?: Store;
  /** Per planner call; defaults to PLANNER_TIMEOUT_MS. */
  plannerTimeoutMs?: number;
  /** Defaults to MAX_PLANNER_CALLS. */
  maxPlannerCalls?: number;
  /** For the whole turn; defaults to TURN_DEADLINE_MS. */
  turnDeadlineMs?: number;
  /** Aborted when nobody is waiting for the turn any more: the call in flight is dropped and no other starts. */
  signal?: AbortSignal;
  /** Runs a read-only plan and gives back each step's output, for a look round. Without it, look isn't offered. */
  look?: (plan: CompiledPlan) => Promise<{ id: string; output?: unknown; error?: string }[]>;
  /** NER extract+link; defaults to the sidecar when NER_MODE is on or shadow (or NER_SIDECAR=1). Tests inject a fake. */
  ner?: (utterance: string, signal?: AbortSignal) => Promise<NerSidecarResponse>;
  /** Defaults to nerMode() from the environment; with an injected `ner` and no mode, on. */
  nerMode?: NerMode;
  /** Per NER call; defaults to NER_TIMEOUT_MS, and never more than what is left of the turn's deadline. */
  nerTimeoutMs?: number;
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
  /** Compact typed identities only, not previous records or their mutable contents. */
  records?: { entity: string; id: string; name: string; for?: string }[];
  /** Set on a retry: the plan that ran for this message and the errors it failed with, nothing changed. */
  failed?: string;
  /** Records the user picked for names in this message, answering a question a look asked: they bind, never ask again. */
  picks?: IdentityBinding[];
  /** The records the last turn made with revisable creates: a plan that makes them again revises them (core/revise.ts). */
  made?: Made[];
}

export interface Carry {
  prev: string[];
  entities: string[];
  /** Record types the plan made new records of, which a follow-up may amend. */
  made?: string[];
}

export type TurnEvent =
  | { type: "retrieval"; data: RetrievalTrace }
  | { type: "planner.request"; data: { label: string; tier: Tier; system: string; user: string; actions: string[] } }
  | { type: "planner.reply"; data: PlannerCallTrace & { json: unknown } }
  | { type: "planner.debug"; data: PlannerDebug }
  | { type: "compile.errors"; data: { errors: string[] } }
  /** An identity resolver decision made while binding the plan's lookups (see ner_bind.ts). */
  | { type: "identity.resolved"; data: IdentityDecision }
  | { type: "ner"; data: NerTrace };

export type TurnOutcome =
  | {
      kind: "plan";
      plan: CompiledPlan;
      carry: Carry;
      /** The planner's verdict on a question about records ("Yes, that's her only review"), read from a look the plan repeats. */
      answer?: string;
      /** The plan remakes the last turn's request: run it against `made`, keeping, editing and undoing those records. */
      revises?: boolean;
    }
  | {
      kind: "reply";
      status: "clarify" | "unsupported" | "answer" | "failed";
      text: string;
      options?: string[];
      /** Set when the planner couldn't be reached or didn't answer: the turn failed for a reason outside the app. */
      infra?: InfraKind;
      /**
       * A record question the resolver asked about one step of a compiled plan: the plan waits on the answer. `replan`
       * when the plan was a look: the answer plans the message again with the pick bound (`TurnInput.picks`).
       */
      paused?: { plan: CompiledPlan; stepId: string; resolution: IdentityResolution; replan?: true };
    };

export type InfraKind = Exclude<PlannerError["kind"], "bad_json">;

/** One planner call, as the execution trace keeps it. */
export interface PlannerCallTrace {
  label: string;
  /** 1-based, within the turn. */
  call: number;
  model: string;
  /** Hashes of the system prompt (the cacheable prefix, which should never change) and of system + user. */
  systemHash: string;
  promptHash: string;
  latencyMs: number;
  /** Model time the provider reported; latencyMs minus this is client and process overhead. */
  apiMs?: number;
  /** Requests the provider sent, its own retries included. */
  attempts: number;
  modelCalls: number;
  /** A repair round: compile or outcome errors fed back. */
  repair: boolean;
  usage: PlanResult["usage"];
}

export function callTrace(label: string, call: number, system: string, user: string, r: PlanResult): PlannerCallTrace {
  return {
    label,
    call,
    model: r.model,
    systemHash: hash(system),
    promptHash: hash(`${system}\n${user}`),
    latencyMs: Math.round(r.latencyMs),
    ...(r.apiMs !== undefined ? { apiMs: Math.round(r.apiMs) } : {}),
    attempts: r.attempts ?? 1,
    modelCalls: r.modelCalls ?? 1,
    repair: label.startsWith("repair"),
    usage: r.usage,
  };
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);

/** The turn stopped on its own budget or because its caller went away, not on a provider failure. */
export class TurnStopped extends Error {}

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
    const linked: Mention[] = [];
    const out = await planTurnUnguarded(input, deps, emit, linked);
    if (out.kind !== "plan") return out;
    // NER hints bind only the arguments that need an existing record; see ner_bind.ts.
    const bound = bindNerLookups(out.plan, linked, deps.registry, {
      store: deps.store,
      request: input.answering ? `${input.answering}\n${input.message}` : input.message,
      duplicates: process.env.NER_DUPLICATE_POLICY === "off" ? "off" : "warn",
      ...(input.picks ? { picks: input.picks } : {}),
      answering: !!input.answering,
    });
    for (const d of bound.decisions) emit({ type: "identity.resolved", data: d });
    if (bound.kind === "clarify") {
      const paused = bound.resolution && bound.stepId ? { plan: bound.plan, stepId: bound.stepId, resolution: bound.resolution } : undefined;
      return { kind: "reply", status: "clarify", text: bound.text, options: bound.options, ...(paused ? { paused } : {}) };
    }
    const answer = [bound.notice, out.answer].filter(Boolean).join("\n");
    return { ...out, plan: bound.plan, ...(answer ? { answer } : {}) };
  } catch (err) {
    // A provider failure, a call that never returned or a spent budget ends the turn with a reply; anything else is
    // a bug and surfaces.
    if (err instanceof TurnStopped) return failed(err.message);
    if (!(err instanceof PlannerError)) throw err;
    const text = err.kind === "timeout" ? `${err.message}. Nothing was changed; please try again.` : `The planner failed: ${err.message}`;
    return failed(text, err.kind === "bad_json" ? undefined : err.kind);
  }
}

async function planTurnUnguarded(input: TurnInput, deps: TurnDeps, emit: (e: TurnEvent) => void, linked: Mention[]): Promise<TurnOutcome> {
  const { registry, retriever, planner, clock, store } = deps;
  const resolvable = registry.resolverEntities();
  const request = input.answering ? `${input.answering}\n${input.message}` : input.message;
  // Mentions: Title-Case Store resolvers by default. With NER_SIDECAR=1 (or ASK_NER=1), the GLiNER sidecar's links
  // (ids, ambiguity candidates, did-you-mean suggestions) join them as hints for retrieval and the planner. They never
  // end the turn here: only an argument that needs an existing record is bound against them, after planning.
  let named: Mention[] = store ? mentions(request, registry, store) : [];
  // The Ask app only ever links against its own records (scope "ask"); with no store there is nothing to scope to,
  // so no NER at all rather than the sidecar's default fine-tuning index.
  // NER is optional: slow, down or wrong means no hints this turn, never a failed turn; a user cancel ends it.
  // Shadow mode calls the sidecar and traces what it found, but nothing reaches retrieval or the planner.
  const mode = deps.nerMode ?? (deps.ner ? "on" : nerMode());
  const nerRequestId = `ner_${createHash("sha1").update(`${request}\0${performance.now()}\0${Math.random()}`).digest("hex").slice(0, 12)}`;
  const ner = mode === "off" ? undefined : deps.ner ?? (store ? (utterance: string, signal?: AbortSignal) => askScopedExtract(store, { requestId: nerRequestId, utterance, tier: input.tier }, { signal }) : undefined);
  // The turn's clock starts before NER: NER time is the turn's, and NER gets only what is left of it.
  const budget = turnBudget(deps);
  if (mode !== "off" && ner && request.trim()) {
    const timeoutMs = Math.min(deps.nerTimeoutMs ?? nerTimeoutMs(), budget.left());
    const sidecar = deps.ner ? undefined : nerSidecarUrl();
    const { response, trace } = await runNer((signal) => ner(request, signal), { requestId: nerRequestId, mode, timeoutMs, signal: deps.signal, breaker: sidecar ? nerBreaker(sidecar) : undefined, pending: sidecar ? () => (askScopePushPending(sidecar) ? "scope_push" : undefined) : undefined, ...(sidecar ? { embed: nerEmbed() } : {}) });
    emit({ type: "ner", data: trace });
    if (trace.outcome === "cancelled") throw cancelled();
    if (response && trace.applied) {
      const fromSpans = spansToMentions(response.spans);
      named = store ? mergeMentions(fromSpans, named) : fromSpans;
    }
  }
  if (store) named = withTextFields(named, registry, store);
  linked.push(...named);
  const allChars = registry.list().map(card).join("\n").length;
  const exists = (id: string) => !store || store.holds(id);

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
  let identityCheck: string | undefined;
  let outcome: Outcome | undefined;
  // The reply the outcome was frozen from. If that reply is rejected and repaired, the repair may state the outcome
  // afresh: a stepless look that called its own reads the outcome shouldn't hold the corrected plan to them. Only a
  // read outcome is let go, so a change is never downgraded.
  let outcomeFrom: unknown;
  const unfreezeRejected = () => { if (outcomeFrom === reply && outcome?.effect === "read") outcome = undefined; };
  // The actions a change needs are a guess until the reads are in: a look may find that the last turn's tasks are to
  // be moved, not made again. The first reply after a look may name them afresh; it is still a change.
  let restate = false;
  // Whether the read outcome held was stated by a look about its own reads.
  let lookStated = false;
  // Whether a plan that makes again what the last turn made was sent back once: the reply after that stands.
  let remadeChecked = false;
  let editsChecked = false;
  // What the reply right after a remake was flagged said it would do: still make them, or change the ones there.
  let remakeAnswer: string[] | null | undefined;
  // Identity checks already run, by "entity:name": one more is allowed for a different record ("Sales" then "Noah").
  const checkedIdentity: string[] = [];
  const deliverySurfaces = registry.deliverySurfaces();
  let lookSteps: Step[] = [];
  // An answer to a question is planned with the message it answers in view: a bare "The lead from Wayne." loses what
  // was asked for ("as partner") however much <context> says.
  const prompt = () =>
    userBlock({ clock, actions: offered, notAvailable, resolvable, lookupQualifiers: registry.resolverQualifiers(), records: input.records, ...(input.made?.length ? { lastMade: lastMade(input.made) } : {}), mentions: named, message: request, context: input.context, failed: input.failed, looked, lookIds: lookSteps.map((l) => l.id), deliverySurfaces, identityCheck, outcome });
  let resampled = false;
  let round = 0;
  const debug = (label: string, user: string, d: Pick<PlannerDebug, "raw" | "parsed" | "model" | "usage" | "latencyMs" | "error">) => {
    round++;
    if (!plannerDebugEnabled()) return;
    const entry: PlannerDebug = { at: new Date().toISOString(), round, reason: debugReason(label, !!input.failed), label, tier: input.tier, system: SYSTEM, user, ...d, latencyMs: Math.round(d.latencyMs) };
    emit({ type: "planner.debug", data: entry });
    appendPlannerDebug(entry);
  };
  const call = async (user: string, label: string) => {
    emit({ type: "planner.request", data: { label, tier: input.tier, system: SYSTEM, user, actions: offered.map((a) => a.id) } });
    // A resample is a call of its own, so it takes from the turn's budget too.
    const ask = async () => {
      const { n, ms } = budget.next();
      const started = performance.now();
      try {
        const r = await withDeadline(ms, (signal) => planner.plan({ tier: input.tier, system: SYSTEM, user, schema: SUBMIT_PLAN_SCHEMA, signal }), deps.signal);
        debug(label, user, { raw: r.text, parsed: r.json, model: r.model, usage: r.usage, latencyMs: r.latencyMs });
        return { r, n };
      } catch (err) {
        debug(label, user, { raw: err instanceof PlannerError ? (err.text ?? null) : null, parsed: null, model: planner.models?.[input.tier] ?? planner.name, usage: null, latencyMs: performance.now() - started, error: err instanceof Error ? err.message : String(err) });
        throw err;
      }
    };
    let got: { r: PlanResult; n: number };
    try {
      got = await ask();
    } catch (err) {
      // A reply that isn't JSON (often a weaker model looping until the token cap) is a bad sample of a good request,
      // and there are no errors to repair it with: ask the same thing once more per turn.
      if (!(err instanceof PlannerError) || err.kind !== "bad_json" || resampled) throw err;
      resampled = true;
      emit({ type: "compile.errors", data: { errors: [`${err.message}; asked again`] } });
      got = await ask();
    }
    const { r, n } = got;
    emit({ type: "planner.reply", data: { ...callTrace(label, n, SYSTEM, user, r), json: r.json } });
    return r;
  };

  await shortlist("retrieve", request, input.carry, named);
  let user = prompt();
  let reply = await call(user, "plan");
  let searched = false;
  let searchedAgain = false;
  // What the planner searched for, and the unsupported reply it gave before a search: if what it plans after the search
  // still doesn't hold up, the turn ends on that verdict, not on the plan's errors.
  let searchedFor: string | undefined;
  let verdict: TurnOutcome | undefined;
  let repaired = false;
  let plannedFromQuestion = false;
  // A plan that doesn't compile gets one repair, and a second when the first got closer (fewer errors, or it fixed them
  // all and met new ones): a weaker model fixes a long plan a few mistakes at a time. Any other repair already spent
  // counts as the first.
  let planRepairs = 0;
  let lastErrors: string[] | undefined;
  const mayRepair = (errors: string[]) => {
    const closer = !!lastErrors && (errors.length < lastErrors.length || !errors.some((e) => lastErrors!.includes(e)));
    if (repaired && !(planRepairs === 1 && closer)) return false;
    repaired = true;
    planRepairs++;
    lastErrors = errors;
    return true;
  };
  let clarifyRepaired = false;
  let lookResults: Awaited<ReturnType<NonNullable<TurnDeps["look"]>>> = [];
  let emptyChecked = false;
  // The plan whose records were said back to the planner. It compiled and passed every check, so when the reply after
  // it doesn't hold up, that plan runs rather than nothing.
  let selectionChecked: CompiledPlan | undefined;
  let leavesOutChecked = false;
  const failedAfterCheck = (text: string) => (selectionChecked ? { kind: "plan" as const, plan: selectionChecked, carry: carryOf(selectionChecked, registry) } : failed(text));
  let lookPlan: CompiledPlan | undefined;
  let looks = 0;
  let lookClosed = false;
  let verdictAsked = false;
  // A look's lookups bind against the NER hints too, so a look never asks the store about an ambiguous name.
  let nerClarify: TurnOutcome | undefined;
  const runLook = async (raw: CompiledPlan, steps: Step[]) => {
    const bound = bindNerLookups(raw, named, registry, { store, request, duplicates: "off", ...(input.picks ? { picks: input.picks } : {}), answering: !!input.answering });
    for (const d of bound.decisions) emit({ type: "identity.resolved", data: d });
    if (bound.kind === "clarify") {
      // Stored like a plan's question; the answer plans the message again with the pick bound, since a look isn't the plan.
      const paused = bound.resolution && bound.stepId ? { plan: bound.plan, stepId: bound.stepId, resolution: bound.resolution, replan: true as const } : undefined;
      nerClarify = { kind: "reply", status: "clarify", text: bound.text, options: bound.options, ...(paused ? { paused } : {}) };
      return;
    }
    const plan = bound.plan;
    looks++;
    lookPlan = plan;
    // <looked> contains compiler-generated resolve IDs too. Preserve those exact read steps so
    // the next plan can reference them just like any explicit look step. A second look reruns the first's steps it
    // needs; the ones it doesn't stay available to the plan, results and all. A second look that gives a first-look
    // id to a different read (its own s1 beside the first's s1) keeps the first's under a fresh id.
    const lowered = lowerLookups(steps, registry).steps;
    const taken = new Set([...lookSteps, ...lowered].map((l) => l.id));
    const moved = new Map<string, string>();
    for (const l of lookSteps) {
      const now = lowered.find((s) => s.id === l.id);
      if (!now || JSON.stringify(now) === JSON.stringify(l)) continue;
      let n = 2, fresh: string;
      do { fresh = `${l.id}_${n++}`; } while (taken.has(fresh));
      taken.add(fresh);
      moved.set(l.id, fresh);
    }
    const follow = <T>(x: T): T => (moved.size ? JSON.parse(JSON.stringify(x).replace(/\$([A-Za-z_]\w*)/g, (all, root: string) => (moved.has(root) ? `$${moved.get(root)}` : all))) as T : x);
    const kept = lookSteps.filter((l) => moved.has(l.id) || !lowered.some((s) => s.id === l.id)).map((l) => follow({ ...l, id: moved.get(l.id) ?? l.id }));
    const keptIds = new Set(kept.map((l) => l.id));
    lookSteps = [...kept, ...lowered];
    const fresh = await deps.look!(plan);
    lookResults = [...lookResults.map((r) => ({ ...r, id: moved.get(r.id) ?? r.id })).filter((r) => keptIds.has(r.id)), ...fresh];
    looked = JSON.stringify(lookResults);
    if (looked.length > LOOKED_MAX) looked = `${looked.slice(0, LOOKED_MAX)}…(cut)`;
  };
  // Each reply is one of: search_tools (retrieve once more, re-plan), a plan (compile; repair once if invalid),
  // or a reply for the user. The repair prompt may itself say "reply search_tools" or "reply unsupported".
  for (;;) {
    const parsed = SubmitPlan.safeParse(reply.json);
    if (!parsed.success) {
      // A malformed reply is repaired like a plan that doesn't compile: the errors go back once.
      const errors = parsed.error.issues.map((i) => `submit_plan ${i.path.join(".") || "(reply)"}: ${i.message}`);
      emit({ type: "compile.errors", data: { errors } });
      if (repaired) return failedAfterCheck(`The planner's reply still didn't match submit_plan after one repair:\n${errors.join("\n")}`);
      repaired = true;
      reply = await call(repairBlock(user, reply.json, errors), "repair");
      continue;
    }
    const d = parsed.data;
    // An id the catalog doesn't have ("M03.A??", written before the planner had searched) names no operation. Kept,
    // it would be a requested operation no plan can ever include; dropped, the real id fills in once it's found.
    if (d.outcome?.actions.some((id) => !registry.get(id))) d.outcome = { ...d.outcome, actions: d.outcome.actions.filter((id) => registry.get(id)) };
    // A real action the shortlist missed but the planner named (a card's "to put a tag on a record, use M08.A06"):
    // offer it, rather than turn a right plan away and send the planner searching for what it already has.
    for (const id of namedActions(d)) {
      const impl = !offered.some((a) => a.id === id) ? registry.get(id) : undefined;
      if (impl) { offered.push(impl); seen.add(id); }
    }
    if (remadeChecked && remakeAnswer === undefined) remakeAnswer = d.outcome?.actions ?? null;
    // An outcome that makes again what the last turn made is asked about once, before its actions bind the repairs.
    if (!remadeChecked && !outcome?.actions.length && (d.type === "plan" || d.type === "look")) {
      const errors = remakesStated(d.outcome, input, registry);
      if (errors.length) {
        remadeChecked = true;
        emit({ type: "compile.errors", data: { errors } });
        reply = await call(repairBlock(user, reply.json, errors), "repair remake");
        continue;
      }
    }
    // Freeze the first stated outcome across all subsequent reads, searches and repairs. A search may
    // initially lack action IDs; fill those once discovered, but never downgrade a change into a read.
    // An unsupported reply states what it thinks it can do, which isn't what was asked: the plan after its search states that.
    if (!outcome && d.outcome && d.type !== "unsupported") { outcome = d.outcome; outcomeFrom = reply; }
    else if (restate && outcome?.effect === "change" && d.outcome?.effect === "change" && d.outcome.actions.length) { outcome = { ...outcome, actions: d.outcome.actions }; outcomeFrom = reply; }
    // A look that called its own reads the outcome, for a message that also tells ("Which leads never replied? Split
    // them between the reps"), described the look: the change the reply after it states is the request's, when the message
    // names a change (a plain "compare" does not: the reply that adds a range change to it is wrong, not the look).
    else if (restate && outcome?.effect === "read" && lookStated && d.outcome?.effect === "change" && d.outcome.actions.length && toldPart(input.message) && (!lookPlan || readOnlyIntentError(input.message, lookPlan, offered, registry).length)) { outcome = d.outcome; outcomeFrom = reply; }
    else if (outcome && !outcome.actions.length && d.outcome?.actions.length) outcome = { ...outcome, actions: d.outcome.actions };
    restate = false;
    if (outcome?.destination && !deliverySurfaces.some((s) => s.id === outcome!.destination)) {
      return { kind: "reply", status: "unsupported", text: `Delivery to ${outcome.destination} isn't supported. Nothing was sent or published. Supported surfaces: ${deliverySurfaces.map((s) => s.label).join(", ")}.` };
    }

    if (d.type === "clarify") {
      let assessed, identityKey = "";
      try {
        assessed = assessClarification(d, registry, new Set(offered.map((a) => a.id)), input.message, store);
      } catch (err) {
        if (!(err instanceof Error)) throw err;
        const errors = [err.message];
        emit({ type: "compile.errors", data: { errors } });
        if (clarifyRepaired) return failed(`The clarification was still invalid after one repair: ${err.message}. Nothing was changed.`);
        clarifyRepaired = true;
        user = prompt();
        reply = await call(repairBlock(user, reply.json, errors), "repair clarification binding");
        continue;
      }
      // A question with no text is nothing to show the user; it is usually a value the message already gives.
      if (assessed.kind === "question" && !d.question?.trim() && !clarifyRepaired) {
        clarifyRepaired = true;
        const arg = d.missing ? `${d.missing.action} ${d.missing.argument}` : "the missing input";
        const errors = [`a clarify needs a question for the user, and this one has none. If the message already says what ${arg} should be (a title from what the task is for, a body from what to say), write it and plan; otherwise ask in question.`];
        emit({ type: "compile.errors", data: { errors } });
        user = prompt();
        reply = await call(repairBlock(user, reply.json, errors), "repair empty question");
        continue;
      }
      if (assessed.kind === "question") return { kind: "reply", status: "clarify", text: d.question ?? "Please supply the missing input.", options: d.options ?? undefined };
      if (assessed.kind === "identity") {
        const { check, lookup } = assessed;
        // "Contact or lead?" about a name that is exactly both is the app's question, whatever the planner found by one type.
        const doubt = !input.answering && store ? typeDoubtOf(lookup.name, lookup.entity, named, registry, store, input.message) : undefined;
        if (doubt) return { kind: "reply", status: "clarify", ...doubt };
        identityKey = `${lookup.entity}:${lookup.name.trim().toLowerCase()}`;
        // The user already picked one for this name (the message is planned again after their answer): that's the answer.
        const pick = input.picks?.find((p) => p.entity === lookup.entity && p.text.trim().toLowerCase() === lookup.name.trim().toLowerCase());
        identityCheck = pick ? JSON.stringify({ entity: lookup.entity, name: lookup.name, chosenByUser: { id: pick.id, name: pick.name }, instruction: "The user chose this record. Plan with its id; don't ask again." }) : check.digest;
        if (pick && !checkedIdentity.includes(identityKey)) {
          checkedIdentity.push(identityKey);
          user = prompt();
          reply = await call(user, "plan after identity check");
          continue;
        }
        // Told whom the user chose, the planner asked again: its question already holds the call, so that is the plan.
        // The pick binds the name, and a second lookup of it in the same call skips the pick ("the other Sarah").
        if (pick && d.missing?.argsJson && !plannedFromQuestion) {
          plannedFromQuestion = true;
          const steps = [{ id: "s1", kind: "action", action: d.missing.action, argsJson: d.missing.argsJson }];
          reply = { ...reply, json: { ...(reply.json as object), type: "plan", steps, question: null, options: null, clarification: null, missing: null, lookup: null } };
          continue;
        }
        if (check.count > 1) {
          const paused = store && check.options ? namePause(lookup, registry, store) : undefined;
          if (paused) return { kind: "reply", status: "clarify", text: `I found ${paused.resolution.candidates.length} ${lookup.entity.replaceAll("_", " ")} records named ${lookup.name}. ${roleQuestion(registry, d.missing)}`, options: paused.resolution.candidates.map(optionLabel), paused };
          return { kind: "reply", status: "clarify", text: `I found ${check.count} matching ${lookup.entity.replaceAll("_", " ")} records. ${check.options ? roleQuestion(registry, d.missing) : "Please give a more specific name or qualifier."}`, options: check.options };
        }
        // The only match can't be used (e.g. a deactivated user): that is the answer, whatever the planner asks next.
        if (check.match?.inactive) return { kind: "reply", status: "clarify", text: `${check.match.name} is ${check.match.inactive}, so I can't use ${lookup.entity.replaceAll("_", " ")} ${check.match.name}. Nothing was changed. Who should I use instead?` };
        if (checkedIdentity.includes(identityKey) || checkedIdentity.length > 1) {
          if (!check.count) {
            // Nothing in the account is close to the name: "who is Dana Whitfield?" is a question nobody can answer from
            // here, so not found is the reply. A near miss ("Victor Browne") is still offered.
            const what = lookup.entity.replaceAll("_", " ");
            const where = lookup.whereJson ? JSON.parse(lookup.whereJson) as LookupWhere : undefined;
            const near = resolveIdentity({ entity: lookup.entity, text: lookup.name, ...(where ? { where } : {}), actionRisk: "write" }, { registry, store: store! });
            if (near.kind === "suggest" && near.candidates.length) return { kind: "reply", status: "clarify", text: `I couldn't find a ${what} named "${lookup.name}". Did you mean ${near.candidates.length === 1 ? optionLabel(near.candidates[0]!) : "one of these"}?`, options: near.candidates.map(optionLabel) };
            return failed(`I couldn't find a ${what} named "${lookup.name}", so nothing was changed.`);
          }
          return failed("The account lookup found one matching record, but the planner still asked which one. Nothing was changed; please try again.");
        }
      } else {
        identityCheck = assessed.digest;
        identityKey = "";
        // Shown the records, the planner still asks which one: when the message's name fits several, that is the question.
        if (checkedIdentity.length && assessed.ambiguous) return { kind: "reply", status: "clarify", text: d.question ?? "Which one did you mean?", options: d.options ?? undefined };
        if (checkedIdentity.length && assessed.none) return failed(`I couldn't find a ${assessed.none.entity.replaceAll("_", " ")} named "${assessed.none.name}", so nothing was changed.`);
        if (checkedIdentity.length) return failed("Matching account records were already supplied, but the planner still asked for that identity. Nothing was changed; please try again.");
      }
      checkedIdentity.push(identityKey);
      user = prompt();
      reply = await call(user, "plan after identity check");
      continue;
    }

    if (d.type === "search_tools") {
      const gaveUp = { kind: "reply" as const, status: "unsupported" as const, text: `I couldn't find an action for that${d.query ? ` (${d.query})` : ""}.` };
      if (searched && searchedAgain) return gaveUp;
      if (searched) {
        // A second search is often for something no action does because ops do it (matching or de-duplicating lists).
        // Search once more, then give one last round that says so, instead of ending the turn.
        searchedAgain = true;
        await shortlist("search_tools", d.query || input.message);
        user = prompt();
        const errors = [`search_tools ran again for "${d.query ?? ""}"; whatever it found is now in <actions>. Matching, combining or de-duplicating lists is done with filter/exclude ops over those actions' results, not by an action. Plan with <actions>, or reply unsupported naming the missing capability`];
        emit({ type: "compile.errors", data: { errors } });
        reply = await call(repairBlock(user, reply.json, errors), "plan after second search_tools");
        continue;
      }
      searched = true;
      searchedFor = d.query || input.message;
      // Retrieve again on the planner's own description of what's missing; the new cards join the old ones.
      await shortlist("search_tools", searchedFor);
      user = prompt();
      reply = await call(user, "plan after search_tools");
      continue;
    }

    if (d.type === "look") {
      // Reads only, run now; a write waits for the real plan (and its approval). A bad look is repaired like a plan.
      // Asked for a verdict, a model may want to look again: the reads it has are the answer, so they run as the plan.
      // A yes/no question is first asked once for its Yes or No, which the reads can't say on their own.
      // Not for a message that also tells: a second look's own read outcome describes that look, not the request.
      // A second look that calls an action the first didn't (the workflow found, now its runs) reads something new: it runs.
      const had = new Set(lookPlan?.steps.flatMap((s) => callsOf(s).map((a) => a.id)));
      const readsNew = (d.steps ?? []).some((s) => s.kind === "action" && !had.has(s.action));
      if (looked !== undefined && lookPlan && !readsNew && outcome?.effect === "read" && !readOnlyIntentError(input.message, lookPlan, offered, registry).length) {
        if (verdictAsked || !isYesNo(input.message)) return { kind: "plan", plan: lookPlan, carry: carryOf(lookPlan, registry) };
        verdictAsked = true;
        user = `${prompt()}\n${ANSWER_FROM_LOOKED}`;
        reply = await call(user, "answer after second look");
        continue;
      }
      if (deps.look && looks >= LOOKS_MAX && !lookClosed) {
        // One plain nudge, so asking for a third look doesn't spend the one repair.
        lookClosed = true;
        user = prompt();
        reply = await call(`${user}\n<errors>You already looked twice; plan with the results in <looked>.</errors>`, "plan after look limit");
        continue;
      }
      // A second look builds on the first (a contact found, then its invoices), so it may refer to the first's steps.
      const lookSource = withLookSteps({ ...d, type: "plan" }, lookSteps);
      const compiled = compile(lookSource, registry, new Set(offered.map((a) => a.id)));
      const errors = !deps.look
        ? ["look isn't available here; reply with a plan or a question"]
        : looks >= LOOKS_MAX
          ? ["you already looked twice; plan with the results in <looked>"]
          : !compiled.ok
            ? compiled.errors
            : [...compiled.plan.steps.flatMap((s) => callsOf(s).filter((a) => a.risk !== "read").map((a) => `${s.id}: ${a.id} is a ${a.risk} action; a look may only read`)), ...staffInQuery(compiled.plan, named)];
      if (errors.length || !compiled.ok) {
        emit({ type: "compile.errors", data: { errors } });
        if (!mayRepair(errors)) return failedAfterCheck(`The plan was still invalid after repair:\n${errors.join("\n")}`);
        unfreezeRejected();
        reply = await call(repairBlock(user, reply.json, errors), "repair");
        continue;
      }
      // A look that states its own reads as a read outcome, for a message that asks for a change ("only the Facebook
      // ones, and make those tasks due tomorrow"), described the look, not the request: the plan after it states it.
      if (outcomeFrom === reply && outcome?.effect === "read" && readOnlyIntentError(input.message, compiled.plan, offered, registry).length) outcome = undefined;
      lookStated = outcomeFrom === reply && outcome?.effect === "read";
      await runLook(compiled.plan, lookSource.steps ?? []);
      if (nerClarify) return nerClarify;
      // What the look found is new to the planner: the plan after it gets its own repair, not the one a reply before it spent.
      repaired = false;
      planRepairs = 0;
      lastErrors = undefined;
      restate = true;
      user = prompt();
      reply = await call(user, "plan after look");
      continue;
    }

    // After a look, the reads were the plan: they run again, so the records shown are current and the code's
    // summary stays. A question that only reads ("is that the only one?") also keeps the planner's verdict on
    // top, unless it leaks raw ids.
    if (d.type === "answer" && (lookPlan || outcome?.effect === "change") && !emptyChecked) {
      // A look that only found the record ("resolve campaign Holiday Offer") shows its id and name, not whether it is
      // live: an answer from that is a guess. One nudge to read it; a second answer stands.
      const onlyFound = lookPlan && !repaired && !lookPlan.steps.some((s) => callsOf(s).length) && offered.some((a) => a.risk === "read")
        ? ["<looked> only found which record it is (its id and name), not what was asked about it; plan the listed action that reads it (its result is the answer)"]
        : [];
      const errors = lookPlan ? [...outcomeErrors(lookPlan, outcome, undefined, (id) => registry.get(id)), ...(outcome ? [] : readOnlyIntentError(input.message, lookPlan, offered, registry)), ...onlyFound] : ["a prose answer does not complete the requested change; plan the final operations or report a blocker"];
      if (!errors.length && lookPlan) {
        const answer = outcome?.effect !== "change" ? d.text?.trim() : undefined;
        return { kind: "plan", plan: lookPlan, carry: carryOf(lookPlan, registry), ...(answer && !RAW_ID.test(answer) ? { answer } : {}) };
      }
      if (repaired) return failedAfterCheck(`The requested outcome is still incomplete:\n${errors.join("\n")}`);
      repaired = true;
      emit({ type: "compile.errors", data: { errors } });
      user = prompt();
      reply = await call(repairBlock(user, reply.json, errors), "repair incomplete outcome");
      continue;
    }

    // An answer is what <context> already says. With no earlier turn, no remembered records and nothing looked up, there
    // is nothing to answer from, so the account must be read first ("Has tic_1 breached its SLA?"). One nudge; a
    // second answer stands.
    if (d.type === "answer" && !input.context && !input.records?.length && !lookPlan && !repaired && offered.some((a) => a.risk === "read")) {
      const errors = ["there is no <context> or <looked> to answer from; if a listed action reads or checks what was asked, plan it (its result is the answer); otherwise reply answer again"];
      emit({ type: "compile.errors", data: { errors } });
      repaired = true;
      // The reply sent back for having nothing to answer from also stated a read outcome ("no request here"): that
      // outcome must not hold the plan that replaces it to reading, when the message is a change.
      unfreezeRejected();
      reply = await call(repairBlock(user, reply.json, errors), "repair");
      continue;
    }

    if (d.type !== "plan") {
      const text = [d.question ?? d.reason ?? d.text ?? "", d.alternatives?.length ? `Alternatives: ${d.alternatives.join("; ")}` : ""].filter(Boolean).join("\n");
      // "Unsupported" only means nothing on the shortlist fits, and the shortlist came from the user's loose wording.
      // Before believing it, retrieve once more on the planner's own description; re-plan only if that finds new cards.
      const said = { kind: "reply" as const, status: d.type, text, options: d.options ?? (d.alternatives?.length ? d.alternatives : undefined) };
      if (d.type === "unsupported" && !searched) {
        searched = true;
        const before = offered.length;
        await shortlist("search_tools", `${text}\n${input.message}`);
        if (offered.length > before) {
          verdict = said;
          user = prompt();
          reply = await call(user, "plan after search_tools");
          continue;
        }
      }
      return said;
    }

    const compiled = compile(withLookSteps(d, lookSteps), registry, new Set(offered.map((a) => a.id)));
    // A plan that only finds records does nothing the user can see: run, it would end "done" with no reply.
    const errors = !compiled.ok
      ? compiled.errors
      : inventedIds(compiled.plan, user, exists).length
        ? inventedIds(compiled.plan, user, exists)
        : compiled.plan.steps.some((s) => callsOf(s).length)
          ? [
              // A revision runs the edits and undoes its creates stand for (core/revise.ts).
              ...outcomeErrors(compiled.plan, outcome, { message: input.message, offered }, (id) => registry.get(id)).filter((e) => ![...revisedBy(compiled.plan, input.made, registry), ...stillStands(compiled.plan, input, registry)].some((id) => e.startsWith(`requested operation ${id} `))),
              // Without a stated outcome, the message's own verbs are the only sign a write was asked for. A read outcome
              // this reply states for a message that asks, then tells, may describe only the asking.
              ...(outcome && !(outcomeFrom === reply && outcome.effect === "read") ? [] : readOnlyIntentError(input.message, compiled.plan, offered, registry)),
              ...duplicateCreates(compiled.plan, named.filter((m) => !fromNer(m)), input.message, (entity, name) => !!store && (registry.resolver(entity)?.(store, name) ?? []).some((c) => !c.inactive && squash(c.name) === name)),
              ...staffInQuery(compiled.plan, named),
              ...unfilledNamedFields(compiled.plan, input.message),
              // Asked once, a remake stands, unless the reply since said it would change those records instead.
              ...remakes(compiled.plan, input, remadeChecked ? remakeAnswer ?? null : undefined),
              ...repeatsEmpty(compiled.plan, input.failed, registry),
              ...(editsChecked ? [] : editsMade(compiled.plan, input)),
            ]
          : ["the plan only finds records and calls no action; add the actions that do what was asked, or look to read what you need first"];
    if (compiled.ok && !errors.length) {
      // The reads found nothing to change: say so (once the planner has had the chance to widen its search or answer),
      // rather than run a loop over nothing.
      const empty = outcome?.effect === "change" ? emptyTargets(compiled.plan, lookResults) : [];
      // A yes/no or count question planned as plain reads: run them as a look and ask for the verdict, so the reply
      // says "No, ..." above the records whichever model planned it. If it plans again instead, that plan runs.
      if (!empty.length && deps.look && looked === undefined && isQuestion(input.message) && readsOnly(compiled.plan)) {
        await runLook(compiled.plan, d.steps ?? []);
        if (nerClarify) return nerClarify;
        user = `${prompt()}\n${ANSWER_FROM_LOOKED}`;
        reply = await call(user, "answer after look");
        continue;
      }
      const kept = leavesOutChecked ? [] : leavesOutError(compiled.plan, outcome);
      if (kept.length) {
        leavesOutChecked = true;
        emit({ type: "compile.errors", data: { errors: kept } });
        user = prompt();
        reply = await call(repairBlock(user, reply.json, kept), "repair leaves out");
        continue;
      }
      const picked = !empty.length && !selectionChecked && outcome?.effect === "change" ? selectionReadback(compiled.plan, lookResults, input.message) : [];
      if (picked.length) {
        selectionChecked = compiled.plan;
        emit({ type: "compile.errors", data: { errors: picked } });
        user = prompt();
        reply = await call(repairBlock(user, reply.json, picked), "check selection");
        continue;
      }
      if (!empty.length) {
        const when = inventedTime(compiled.plan, `${input.context ?? ""}\n${input.message}`);
        if (when) return { kind: "reply", status: "clarify", text: when, options: [] };
        const which = store && oneOfSameNamed(compiled.plan, named, registry, store, request, input.picks);
        if (which) return { kind: "reply", status: "clarify", ...which };
        const revises = !!input.made?.length && revisable(compiled.plan, input.made);
        return { kind: "plan", plan: compiled.plan, carry: carryOf(compiled.plan, registry), ...(revises ? { revises } : {}) };
      }
      if (emptyChecked) return { kind: "reply", status: "answer", text: "Nothing matched, so nothing was changed." };
      emptyChecked = true;
      const errors = empty.map((e) => `${e.step}: ${e.list} was already read and is empty, so this changes nothing. If the search was too narrow, plan again with a wider search inside the plan; if nothing should match, reply with type answer saying so`);
      emit({ type: "compile.errors", data: { errors } });
      user = prompt();
      reply = await call(repairBlock(user, reply.json, errors), "repair empty target");
      continue;
    }
    // A change planned as only the reads it needs first is the look those errors ask for: run it, then plan again with
    // what it found, rather than spend the repair on a reply labelled plan instead of look. Once looked, it is repaired.
    if (compiled.ok && outcome?.effect === "change" && outcome.actions.length && readsOnly(compiled.plan) && deps.look && looked === undefined && errors.every((e) => PREREQUISITES_ONLY.test(e))) {
      await runLook(compiled.plan, withLookSteps(d, lookSteps).steps ?? []);
      restate = true;
      user = prompt();
      reply = await call(user, "plan after reads");
      continue;
    }
    emit({ type: "compile.errors", data: { errors } });
    if (!mayRepair(errors)) {
      // Told to leave out a write for a read-only outcome and sent it again: the reads are the answer, so they run alone,
      // when what's left still does the outcome and the message asks for no change.
      if (compiled.ok && outcome?.effect === "read" && errors.length && errors.every((e) => READ_ONLY_WRITE.test(e))) {
        const kept = withoutWrites(compiled.plan);
        if (kept.steps.length && !outcomeErrors(kept, outcome, undefined, (id) => registry.get(id)).length && !readOnlyIntentError(input.message, kept, offered, registry).length) {
          return { kind: "plan", plan: kept, carry: carryOf(kept, registry) };
        }
      }
      if (verdict) return verdict;
      // Searched, and still naming no action that makes the change: no action does it.
      if (searchedFor && outcome?.effect === "change" && !outcome.actions.length) return { kind: "reply", status: "unsupported", text: `I couldn't find an action for that (${searchedFor}).` };
      return failedAfterCheck(`The plan was still invalid after repair:\n${errors.join("\n")}`);
    }
    unfreezeRejected();
    if (compiled.ok && remakes(compiled.plan, input).length) remadeChecked = true;
    if (compiled.ok && editsMade(compiled.plan, input).length) editsChecked = true;
    // Told to use a record that exists instead of creating it, the planner's next outcome no longer includes the create.
    if (errors.some((e) => e.includes(ALREADY_EXISTS))) restate = true;
    reply = await call(repairBlock(user, reply.json, errors), "repair");
  }
}

/**
 * A follow-up that narrows what the last turn did ("only the Facebook ones, and make those tasks due tomorrow") is
 * planned by weaker models as the whole request again, so the records it made are made twice. A plan that makes the
 * kind of record the last turn made, and changes none of those, is sent back once to say which it means; asked for
 * more ("one for Tom too"), it isn't.
 */
export function remakes(plan: CompiledPlan, input: Pick<TurnInput, "carry" | "records" | "message" | "made">, stated?: string[] | null): string[] {
  return remadeBy(plan.steps.flatMap(callsOf), input, stated);
}

/**
 * The same question asked of the outcome a reply states, before it is frozen. A weaker model states the outcome from
 * the message alone, as the last turn's request again, and the frozen outcome then holds every repair to making the
 * records again. Stated, making them again beside changing them is still the remake: which stay is only known once
 * they are read.
 */
export function remakesStated(outcome: Outcome | null | undefined, input: Pick<TurnInput, "carry" | "records" | "message" | "made">, registry: Registry): string[] {
  if (outcome?.effect !== "change") return [];
  return remadeBy(outcome.actions.flatMap((id) => registry.get(id) ?? []), input, undefined, true);
}

function remadeBy(actions: RegisteredAction[], input: Pick<TurnInput, "carry" | "records" | "message" | "made">, stated?: string[] | null, evenIfChanged = false): string[] {
  if (stated === null || stated?.length === 0) return [];
  if (/\b(also|too|another|more|as well|again|new)\b/i.test(input.message)) return [];
  const calls = actions.filter((a) => a.risk !== "read");
  return [...new Set(input.carry?.made ?? [])].flatMap((entity) => {
    const mine = (input.records ?? []).filter((r) => r.entity === entity);
    const makes = calls.find((a) => a.entities?.produces === entity && !(a.entities?.consumes ?? []).includes(entity));
    const changes = calls.some((a) => (a.entities?.consumes ?? []).includes(entity));
    if (!mine.length || !makes || (changes && !evenIfChanged) || stated?.includes(makes.id)) return [];
    // Made again, these are revised to match (core/revise.ts): the planner need not work out which stay.
    if (makes.revise && input.made?.some((m) => m.entity === entity)) return [];
    const names = mine.slice(-8).map((r) => `${r.name} (${r.id}${r.for ? `, for ${r.for}` : ""})`).join(", ");
    return [`the last turn already made ${mine.length} ${entity} record${mine.length > 1 ? "s" : ""} (${names}); if this message narrows or changes what it did, update those that stay and cancel or undo those now left out instead of ${makes.id} again (look first to read which still fit, when that takes their fields). If it asks for new ones as well, plan the same again`];
  });
}

const ADDS_MORE = /\b(also|too|another|more|as well|again|new)\b/i;

/**
 * The other way a weaker model plans a narrowing follow-up: edits to the records the last turn made, which leaves the
 * ones now left out as they were. Revisable records are better planned as the whole request again (core/revise.ts), so
 * such a plan is sent back once; resubmitted, it runs as written ("move Ben's task to Friday").
 */
export function editsMade(plan: CompiledPlan, input: Pick<TurnInput, "made" | "message">): string[] {
  if (!input.made?.length || ADDS_MORE.test(input.message)) return [];
  const calls = plan.steps.flatMap(callsOf).filter((a) => a.risk !== "read");
  return [...new Set(input.made.map((m) => m.entity))].flatMap((entity) => {
    const of = input.made!.filter((m) => m.entity === entity);
    const makes = calls.some((a) => a.entities?.produces === entity && !(a.entities?.consumes ?? []).includes(entity));
    const edits = calls.filter((a) => (a.entities?.consumes ?? []).includes(entity)).map((a) => a.id);
    if (makes || !edits.length) return [];
    return [`the last turn made ${of.length} ${entity.replace(/_/g, " ")} records with ${of[0]!.action}, and this plan changes them with ${[...new Set(edits)].join(", ")}. If this message narrows or changes the last turn's request, plan that whole request again with the new terms and no steps that change or cancel those records: running it edits each one that still fits and cancels the rest. If it only changes those records, submit this plan again`];
  });
}

/** On a retry, a search the failed attempt ran and found nothing with, run again unchanged, finds nothing again. */
export function repeatsEmpty(plan: CompiledPlan, failed: string | undefined, registry: Registry): string[] {
  let empty: { action: string; args: unknown }[] = [];
  try {
    empty = (failed && (JSON.parse(failed) as { empty?: typeof empty }).empty) || [];
  } catch { return []; }
  const key = (args: unknown) => JSON.stringify(args, (_, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v));
  // Dropping the scope a search found nothing under (an id filter: contactId, companyId…) finds the wrong records.
  const widened = (args: unknown) => empty.find((e) => {
    const was = (e.args ?? {}) as Record<string, unknown>, now = (args ?? {}) as Record<string, unknown>;
    return Object.keys(was).some((k) => /Id$/.test(k) && !(k in now)) && Object.keys(now).every((k) => k in was);
  });
  return plan.steps.flatMap((s) => {
    if (s.kind === "action" && empty.some((e) => e.action === s.call.action.id) && widened(s.call.args)) {
      const was = widened(s.call.args)!;
      return [`${s.id}: ${s.call.action.id} found nothing scoped by ${JSON.stringify(was.args)} in <failed_attempt>; dropping that scope would return records outside it. Keep the scope and reply with type answer saying nothing matched`];
    }
    if (s.kind !== "action" || !empty.some((e) => e.action === s.call.action.id && key(e.args) === key(s.call.args))) return [];
    const others = (s.call.action.siblings ?? []).map((id) => registry.get(id)).filter((a) => !!a).map((a) => `${a.id} ${a.name}`);
    return [`${s.id}: ${s.call.action.id} ${JSON.stringify(s.call.args)} already found nothing in <failed_attempt>, so it finds nothing again; search another way${others.length ? ` (a look-alike that searches other records: ${others.join(", ")})` : ""}, or reply with type answer if nothing should match`];
  });
}

type Step = NonNullable<SubmitPlan["steps"]>[number];

/**
 * A plan after a look round may write `$s1.items` for a step it only saw in <looked>. A look is read-only, so
 * the read can simply run again as part of the plan: look steps the plan refers to, and doesn't define itself,
 * are put in front of it (with the look steps they in turn refer to).
 */
export function withLookSteps(source: SubmitPlan, looks: Step[]): SubmitPlan {
  let plan = renameReusedIds(lookedPrefix(source, looks), new Set(looks.map((l) => l.id)));
  const roots = (s: Step) => [...JSON.stringify(s).matchAll(/\$([A-Za-z_]\w*)/g)].map((m) => m[1]!);
  const own = new Set((plan.steps ?? []).map((s) => s.id));
  const wanted = new Set<string>();
  // A look step's own references always mean look steps, even where the plan reuses one of their ids.
  const queue = (plan.steps ?? []).flatMap(roots).filter((r) => !own.has(r));
  for (let root = queue.shift(); root; root = queue.shift()) {
    const look = looks.find((l) => l.id === root);
    if (look && !wanted.has(root)) (wanted.add(root), queue.push(...roots(look)));
  }
  if (!wanted.size) return plan;
  // The plan's own step that took a needed look id (the look's s1 beside the plan's s1) gets a fresh id.
  const taken = new Set([...own, ...looks.map((l) => l.id)]);
  for (const id of [...own].filter((id) => wanted.has(id))) {
    let n = 2, fresh: string;
    do { fresh = `${id}_${n++}`; } while (taken.has(fresh));
    taken.add(fresh);
    const ref = new RegExp(`\\$${id}(?!\\w)`, "g");
    plan = { ...plan, steps: (plan.steps ?? []).map((s) => JSON.parse(JSON.stringify(s.id === id ? { ...s, id: fresh } : s).replace(ref, `$${fresh}`)) as Step) };
  }
  return { ...plan, steps: [...looks.filter((l) => wanted.has(l.id)), ...(plan.steps ?? [])] };
}

/** `$looked.s2.items` names the look step s2 by the block it was shown in; it means `$s2.items`. */
function lookedPrefix(plan: SubmitPlan, looks: Step[]): SubmitPlan {
  const ids = new Set(looks.map((l) => l.id));
  const text = JSON.stringify(plan.steps ?? []);
  const next = text.replace(/\$looked\.([A-Za-z_]\w*)/g, (all, id: string) => (ids.has(id) ? `$${id}` : all));
  return next === text ? plan : { ...plan, steps: JSON.parse(next) as Step[] };
}

/**
 * A model that has seen `$s1` in <looked> (or just wrote s1 twice) often defines another step s1 that refers to the
 * earlier one: a self or forward reference, which the compiler can only reject. Which step each reference means is
 * not in doubt: a reference at or before the redefinition means the earlier step, one after it the new step. So the
 * new step gets a fresh id and later references follow it.
 */
export function renameReusedIds(plan: SubmitPlan, lookIds: ReadonlySet<string> = new Set()): SubmitPlan {
  const steps = plan.steps ?? [];
  const taken = new Set([...steps.map((s) => s.id), ...lookIds]);
  const seen = new Set<string>(), referenced = new Set<string>(), env = new Map<string, string>();
  let changed = false;
  const out = steps.map((step) => {
    const text = JSON.stringify(step);
    const roots = [...text.matchAll(/\$([A-Za-z_]\w*)/g)].map((m) => m[1]!);
    for (const root of roots) referenced.add(root);
    let next = env.size ? text.replace(/\$([A-Za-z_]\w*)/g, (all, root: string) => (env.has(root) ? `$${env.get(root)}` : all)) : text;
    const rewritten = JSON.parse(next) as Step;
    const id = step.id;
    if (seen.has(id) || (lookIds.has(id) && referenced.has(id))) {
      let n = 2, fresh: string;
      do { fresh = `${id}_${n++}`; } while (taken.has(fresh));
      taken.add(fresh);
      env.set(id, fresh);
      changed = true;
      return { ...rewritten, id: fresh };
    }
    seen.add(id);
    env.delete(id);
    if (rewritten !== step && next !== text) changed = true;
    return rewritten;
  });
  return changed ? { ...plan, steps: out } : plan;
}

/**
 * Characters of look results shown to the planner: enough for a few reads of a dozen records each (last week's leads,
 * their conversations, appointments, staff). A cut list sends the planner back to read it again.
 */
const LOOKED_MAX = 16000;
const LOOKS_MAX = 2;
/** A record id such as rv_12 or ct_3: users never see these. */
const RAW_ID = /\b[a-z]{2,4}_\d+\b/;

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
 * A record the user picked when asked is not asked about again.
 */
export function oneOfSameNamed(plan: CompiledPlan, named: Mention[], registry: Registry, store: Store, request: string, picks: IdentityBinding[] = []): { text: string; options: string[] } | undefined {
  const ids = new Set<string>();
  const visit = (v: unknown): void => {
    if (typeof v === "string") ids.add(v);
    else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") Object.values(v).forEach(visit);
  };
  const writes = plan.steps.flatMap((s) => {
    const calls = s.kind === "action" ? [s.call] : s.kind === "forEach" ? s.calls : [];
    if (!calls.some((c) => c.action.risk !== "read")) return [];
    calls.forEach((c) => visit(c.args));
    if (s.kind === "forEach" && Array.isArray(s.in)) visit(s.in);
    return calls.filter((c) => c.action.risk !== "read");
  });
  for (const m of named.filter((n) => n.count > 1)) {
    const found = (registry.resolver(m.entity)?.(store, m.name) ?? []).filter((c) => !c.inactive);
    const hit = found.filter((c) => ids.has(c.id));
    // The one the user picked when asked: the question was answered.
    if (hit.every((c) => picks.some((p) => p.id === c.id))) continue;
    if (found.length < 2 || !hit.length || narrowByRequest(found, request).length === 1) continue;
    // Every one of them taken is "email both Sarahs", unless one call gives them different roles ("merge the two
    // Sarahs": which one stays is still the user's call).
    const role = hit.length === found.length ? splitRole(writes, new Set(found.map((c) => c.id))) : "";
    if (role === undefined) continue;
    // The user picked one of them when asked which stays: the other is the one merged into it.
    if (hit.length === found.length && picks.some((p) => found.some((c) => c.id === p.id))) continue;
    const options = found.map(optionLabel);
    return { text: `More than one ${m.entity} matches "${m.name}": ${options.join(", ")}. ${role ? `Which one is ${role}?` : "Which one?"}`, options };
  }
  return undefined;
}

/** The role of the first of two arguments one call fills with different records of the set (a merge's "the contact
 * that stays"), "" when that argument says no role, undefined when no call splits them. */
function splitRole(calls: { action: RegisteredAction; args: unknown }[], set: Set<string>): string | undefined {
  for (const c of calls) {
    const args = Object.entries((c.args ?? {}) as Record<string, unknown>).filter(([, v]) => typeof v === "string" && set.has(v));
    if (new Set(args.map(([, v]) => v)).size < 2) continue;
    const props = (c.action.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
    return props[args[0]![0]]?.description ?? "";
  }
  return undefined;
}

/** "Is that the only one?", "how many deals are open?", "who owns it?": not "can you list…?" or "show me…". */
export const isQuestion = (message: string) => {
  const m = message.trim();
  if (/^(please\s+)?((can|could|would|will) you|show|list|find|get|give|pull|display|open)\b/i.test(m)) return false;
  return /^(is|isn't|are|aren't|was|wasn't|were|does|doesn't|do|don't|did|didn't|has|hasn't|have|haven't|had|can|could|will|would|should|how many|how much|which|who|whose|any)\b/i.test(m);
};

/** "Is that the only one?", "has Ana got any tasks?": answered Yes or No, which a list of records doesn't say. */
const isYesNo = (message: string) => isQuestion(message) && /^(is|isn't|are|aren't|was|wasn't|were|does|doesn't|do|don't|did|didn't|has|hasn't|have|haven't|had)\b/i.test(message.trim());

/** The outcome errors a plan of prerequisite reads gets, and no others. */
const PREREQUISITES_ONLY = /^(requested operation \S+ (is missing; prerequisite reads|.*is not in the plan: add a step that calls)|the requested outcome changes records, but this plan only reads)/;

/** The error a plan gets for a write under a read-only outcome (see outcomeErrors). */
const READ_ONLY_WRITE = /^the requested outcome is read-only, but /;

/** The plan without the steps that change anything, and without any step built on one that does. */
function withoutWrites(plan: CompiledPlan): CompiledPlan {
  const dropped = new Set<string>();
  const steps = plan.steps.filter((s) => {
    const keep = (s.kind === "action" ? [s.call] : s.kind === "forEach" ? s.calls : []).every((c) => c.action.risk === "read" || c.action.query) && !s.deps.some((d) => dropped.has(d));
    if (!keep) dropped.add(s.id);
    return keep;
  });
  return { ...plan, steps };
}

const readsOnly = (plan: CompiledPlan) => plan.steps.every((s) => callsOf(s).every((a) => a.risk === "read"));

const ANSWER_FROM_LOOKED = "The reads in <looked> ran. Reply type answer to the question in <message>: start with the verdict (Yes, No, or the number), one or two sentences, records by name, never ids. Keep outcome.";

const callsOf = (s: CompiledPlan["steps"][number]) => (s.kind === "action" ? [s.call.action] : s.kind === "forEach" ? s.calls.map((c) => c.action) : []);

/** Every action id a reply names: its outcome, its clarification, and its steps' calls. */
export const namedActions = (d: SubmitPlan): string[] => [
  ...(d.outcome?.actions ?? []),
  ...(d.missing?.action ? [d.missing.action] : []),
  ...(d.steps ?? []).flatMap((s) => (s.kind === "action" ? [s.action] : "do" in s ? (s.do ?? []).map((c) => c.action) : [])),
];

const squash = (s: unknown) => (typeof s === "string" ? s.toLowerCase().replace(/\s+/g, " ").trim() : "");

const ALREADY_EXISTS = " already exists as a ";

/**
 * "Add Elodie Mercer, then post as her" when Elodie Mercer is already a contact: creating her again makes a
 * duplicate that later steps can't tell apart. Unless the message asks for a new or second one, the existing
 * record is meant. "Create a contact named Sarah" is not a duplicate of Sarah Johnson: `sameName`, when given, says
 * whether a record carries the whole name being created.
 */
export function duplicateCreates(plan: CompiledPlan, named: Mention[], message: string, sameName?: (entity: string, name: string) => boolean): string[] {
  if (/\b(new|another|second|duplicate|separate)\b/i.test(message)) return [];
  const errors: string[] = [];
  for (const s of plan.steps) {
    if (s.kind !== "action") continue;
    const { action, args } = s.call;
    const made = action.entities?.produces;
    const name = squash(args.name) || squash([args.firstName, args.lastName].filter((v) => typeof v === "string").join(" "));
    if (!made || !name) continue;
    // A name the mentions missed ("Tag Elena as vip": no extractor knows tags) still counts when the message says it,
    // the store holds it, and the create only feeds a later step. "Create a contact called Marcus Lee" asks for the
    // record itself; two people can share a name, and the resolver warns about it instead.
    const feeds = plan.steps.some((t) => t.deps.includes(s.id));
    const existing = named.find((m) => !m.of && m.entity === made && squash(m.name) === name) ??
      (sameName && feeds && ` ${squash(message.replace(/["'“”.,!?]/g, " "))} `.includes(` ${name} `) ? { name: String(args.name ?? name), count: 1 } : undefined);
    if (existing && (!sameName || sameName(made, name))) errors.push(`${s.id}: ${existing.name}${ALREADY_EXISTS}${made}${existing.count > 1 ? ` (${existing.count} of them)` : ""}; resolve and use it instead of creating a duplicate with ${action.id}`);
  }
  return errors;
}

/**
 * "Add Sarah as a new contact with the email I'm pasting" with nothing pasted: a create that leaves out a field the
 * message says comes with it would invent the record without it. Set it from the message, or ask for it.
 */
export function unfilledNamedFields(plan: CompiledPlan, message: string): string[] {
  const errors: string[] = [];
  for (const s of plan.steps) {
    if (s.kind !== "action") continue;
    const { action, args } = s.call;
    const made = action.entities?.produces;
    if (action.risk === "read" || !made || action.entities?.consumes?.includes(made)) continue;
    const properties = (action.inputSchema.properties ?? {}) as Record<string, { type?: unknown }>;
    const required = new Set((action.inputSchema.required ?? []) as string[]);
    for (const [key, schema] of Object.entries(properties)) {
      if (required.has(key) || args[key] !== undefined && args[key] !== "" || !["string", "number", "integer"].includes(schema.type as string)) continue;
      if (namesField(message, key)) errors.push(`${s.id}: ${action.id} leaves out ${key}, which the message says comes with it; set it from the message, or if the message doesn't give it, reply clarify asking for ${key}; never invent it`);
    }
  }
  return errors;
}

/** Arguments that say the moment something happens, which a date alone doesn't give. */
const MOMENT_ARGS: Record<string, string> = { sendAt: "be sent", publishAt: "go live", startAt: "start", startsAt: "start" };
const TIME_HINT = /\d\s*(?:am|pm|a\.m|p\.m)\b|\b\d{1,2}:\d\d|\b(?:noon|midnight|morning|afternoon|evening|night|tonight|o'clock|asap|now|right away|same time|end of (?:the )?day|eod)\b|\bat \d|\bin \d+\s*\w+|\bhours?\b|\bminutes?\b/i;

/**
 * "Schedule the post for November 2" gives a date, not a time. A scheduled send, post, appointment or event whose
 * moment is written out while nothing said so far (the message or the recent conversation) names a time of day would
 * pick one for the user: the user is asked for it instead, as a model's own clarify would, without asking the model.
 */
export function inventedTime(plan: CompiledPlan, said: string): string | undefined {
  if (TIME_HINT.test(said)) return undefined;
  for (const s of plan.steps) {
    for (const { action, args } of s.kind === "action" ? [s.call] : s.kind === "forEach" ? s.calls : []) {
      if (action.risk === "read") continue;
      for (const [key, v] of Object.entries(args)) {
        if (key in MOMENT_ARGS && typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v)) return `What time of day should it ${MOMENT_ARGS[key]}? You gave the date but not the time.`;
      }
    }
  }
  return undefined;
}

const STAFF_ARGS = ["ownerId", "hostId", "assigneeId", "authorId", "memberId", "userId"];

/**
 * "How many tickets does Noah have?" searched as query "Noah Park" finds tickets that mention Noah, not his: a staff user
 * the message names goes in the action's owner/host/assignee argument instead, when it has one.
 */
export function staffInQuery(plan: CompiledPlan, named: Mention[]): string[] {
  const errors: string[] = [];
  for (const s of plan.steps) {
    if (s.kind !== "action") continue;
    const { action, args } = s.call;
    const user = named.find((m) => m.entity === "user" && !m.of && squash(args.query) === squash(m.name));
    const shape = (action.input as { shape?: Record<string, unknown> }).shape ?? {};
    const arg = STAFF_ARGS.find((k) => k in shape);
    if (user && arg) errors.push(`${s.id}: ${user.name} is a staff user; resolve them and pass ${arg} instead of searching ${action.id}'s text for their name`);
  }
  return errors;
}

/** What a follow-up turn inherits: the actions this plan used, the record types they return, and those it made. */
export function carryOf(plan: CompiledPlan, registry: Registry): Carry {
  const prev = [...new Set(plan.steps.flatMap((s) => callsOf(s).map((a) => a.id)))];
  const entities = [...new Set(prev.map((id) => registry.get(id)?.entities?.produces).filter((e): e is string => !!e))];
  // An action that returns a type it doesn't take made a new record of it (a create); one that takes it changed one.
  const made = [...new Set(prev.flatMap((id) => {
    const a = registry.get(id);
    const out = a?.risk !== "read" ? a?.entities?.produces : undefined;
    return out && !(a?.entities?.consumes ?? []).includes(out) ? [out] : [];
  }))];
  return { prev, entities, ...(made.length ? { made } : {}) };
}

/**
 * Hands out one turn's planner calls: each gets its number and how long it may take (the per-call timeout, or
 * what is left of the turn's deadline if that is less). Throws once the calls or the time are spent, or the
 * caller has gone.
 */
export function turnBudget(deps: Pick<TurnDeps, "plannerTimeoutMs" | "maxPlannerCalls" | "turnDeadlineMs" | "signal">) {
  const max = deps.maxPlannerCalls ?? MAX_PLANNER_CALLS;
  const deadlineMs = deps.turnDeadlineMs ?? TURN_DEADLINE_MS;
  const ends = performance.now() + deadlineMs;
  let n = 0;
  return {
    /** Milliseconds left of the turn's deadline (0 once spent). */
    left: () => Math.max(0, Math.round(ends - performance.now())),
    next(): { n: number; ms: number } {
      if (deps.signal?.aborted) throw cancelled();
      if (n >= max) throw new TurnStopped(`The planner used all ${max} of its calls for this message without settling on a plan. Nothing was changed; please rephrase it or split it up.`);
      const left = ends - performance.now();
      if (left <= 0) throw new PlannerError(`The planner used all ${Math.round(deadlineMs / 1000)} s this message may take`, "timeout");
      return { n: ++n, ms: Math.min(deps.plannerTimeoutMs ?? PLANNER_TIMEOUT_MS, left) };
    },
  };
}

const cancelled = () => new TurnStopped("The request was cancelled. Nothing was changed.");

/** Runs `fn`, aborting its signal and rejecting if it hasn't settled after `ms` or once `parent` aborts. */
export async function withDeadline<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T> {
  if (parent?.aborted) throw cancelled();
  const ctl = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort();
      reject(new PlannerError(`The planner didn't answer within ${Math.round(ms / 1000)} s`, "timeout"));
    }, ms);
    onAbort = () => {
      ctl.abort();
      reject(cancelled());
    };
    parent?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([fn(ctl.signal), expired]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", onAbort!);
  }
}

const failed = (text: string, infra?: InfraKind): TurnOutcome => ({ kind: "reply", status: "failed", text, ...(infra ? { infra } : {}) });

/** The planner's question about a name several records share, stored like a look's: the answer ("the one with the gmail
 * address") picks a record, and the message is planned again with that pick bound to the name. Left to the planner as
 * plain text, the answer was searched for again and every match written to. */
function namePause(lookup: NonNullable<SubmitPlan["lookup"]>, registry: Registry, store: Store): Extract<TurnOutcome, { kind: "reply" }>["paused"] {
  const where = lookup.whereJson ? JSON.parse(lookup.whereJson) as LookupWhere : undefined;
  const resolution = resolveIdentity({ entity: lookup.entity, text: lookup.name, ...(where ? { where } : {}), actionRisk: "write" }, { registry, store });
  if (resolution.kind !== "ambiguous" || resolution.candidates.length < 2) return undefined;
  const c = compile(SubmitPlan.parse({ type: "plan", steps: [{ id: "who", kind: "resolve", entity: lookup.entity, name: lookup.name, whereJson: lookup.whereJson }] }), registry);
  return c.ok ? { plan: c.plan, stepId: "who", resolution, replan: true } : undefined;
}

/** "Which one is the contact that stays?" for an argument named for its role (a merge's keepId); otherwise "Which one do you mean?". */
function roleQuestion(registry: Registry, missing: SubmitPlan["missing"]): string {
  const action = missing && registry.get(missing.action);
  const role = action?.idTypes?.[missing!.argument] && ((action.inputSchema.properties ?? {}) as Record<string, { description?: string }>)[missing!.argument]?.description;
  return role ? `Which one is ${role}?` : "Which one do you mean?";
}

/** "5 task (M06.A01)": the last turn's revisable records, for <last_made>. */
function lastMade(made: Made[]): string {
  return [...new Set(made.map((m) => m.action))].map((a) => { const of = made.filter((m) => m.action === a); return `${of.length} ${of[0]!.entity.replace(/_/g, " ")} (${a})`; }).join(", ");
}

/**
 * "Actually, just the Facebook ones": a plan that edits what the last turn made leaves the rest of that turn standing,
 * so an operation that turn ran isn't asked for again, unless this message names it ("assign them to Bob instead").
 */
export function stillStands(plan: CompiledPlan, input: Pick<TurnInput, "carry" | "made" | "message">, registry: Registry): string[] {
  if (!input.made?.length || ADDS_MORE.test(input.message)) return [];
  const entities = new Set(input.made.map((m) => m.entity));
  if (!plan.steps.flatMap(callsOf).some((a) => a.risk !== "read" && a.entities?.consumes?.some((e) => entities.has(e)))) return [];
  const message = input.message.toLowerCase();
  return (input.carry?.prev ?? []).filter((id) => {
    const verb = registry.get(id)?.name.split(" ")[0]?.toLowerCase();
    return !!verb && !message.includes(verb);
  });
}

/** The edit and undo actions a plan's creates stand for when it revises what the last turn made. */
function revisedBy(plan: CompiledPlan, made: Made[] | undefined, registry: Registry): string[] {
  if (!made?.length || !revisable(plan, made)) return [];
  return [...new Set(made.map((m) => m.action))].flatMap((a) => { const r = registry.get(a)!.revise!; return [...Object.values(r.edits), r.undo]; });
}
