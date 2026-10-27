import { compile, type CompiledPlan } from "../core/compile.js";
import { narrowByRequest } from "../core/execute.js";
import { lowerLookups } from "../core/lookups.js";
import { card } from "../registry/card.js";
import type { RegisteredAction, Registry } from "../registry/registry.js";
import { type Mention, mentions } from "../retrieval/mentions.js";
import type { Retrieval, Retriever } from "../retrieval/retrieve.js";
import type { Clock } from "../store/clock.js";
import type { Store } from "../store/db.js";
import { readOnlyIntentError, toldPart } from "./completion.js";
import { repairBlock, SYSTEM, userBlock } from "./prompt.js";
import { SUBMIT_PLAN_SCHEMA, SubmitPlan } from "./submit-plan.js";
import { type PlanResult, type Planner, PlannerError, type Tier } from "./types.js";
import { emptyTargets, outcomeErrors, type Outcome } from "./contracts.js";
import { assessClarification, namesField } from "./clarification.js";

// The planning half of a turn, shared by the dev server and the CLI:
//   retrieve a shortlist → prompt → plan, with at most two search_tools rounds (a second retrieval for what the
//   planner says is missing), at most two look rounds (read-only steps run now, their results fed back, so a
//   value can be worked out from a record: "same time, on Monday"; a second may build on the first) and at most
//   one repair round (compile errors fed back; a second when the first left fewer errors), plus at most one repair of a malformed clarification (its own allowance, so it can't use up the plan's) and at most
//   one grounded identity clarification retry → a compiled plan or a reply. At most six calls. The plan may only use
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
  /** Compact typed identities only, not previous records or their mutable contents. */
  records?: { entity: string; id: string; name: string; for?: string }[];
  /** Set on a retry: the plan that ran for this message and the errors it failed with, nothing changed. */
  failed?: string;
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
  | { type: "planner.reply"; data: { label: string; model: string; latencyMs: number; usage: PlanResult["usage"]; json: unknown } }
  | { type: "compile.errors"; data: { errors: string[] } };

export type TurnOutcome =
  | {
      kind: "plan";
      plan: CompiledPlan;
      carry: Carry;
      /** The planner's verdict on a question about records ("Yes, that's her only review"), read from a look the plan repeats. */
      answer?: string;
    }
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
  // What the reply right after a remake was flagged said it would do: still make them, or change the ones there.
  let remakeAnswer: string[] | null | undefined;
  // Identity checks already run, by "entity:name": one more is allowed for a different record ("Sales" then "Noah").
  const checkedIdentity: string[] = [];
  const deliverySurfaces = registry.deliverySurfaces();
  const prompt = () =>
    userBlock({ clock, actions: offered, notAvailable, resolvable, lookupQualifiers: registry.resolverQualifiers(), records: input.records, mentions: named, message: input.message, context: input.context, failed: input.failed, looked, deliverySurfaces, identityCheck, outcome });
  let resampled = false;
  const call = async (user: string, label: string) => {
    emit({ type: "planner.request", data: { label, tier: input.tier, system: SYSTEM, user, actions: offered.map((a) => a.id) } });
    const ask = () => withDeadline(deps.plannerTimeoutMs ?? PLANNER_TIMEOUT_MS, (signal) => planner.plan({ tier: input.tier, system: SYSTEM, user, schema: SUBMIT_PLAN_SCHEMA, signal }));
    let r: PlanResult;
    try {
      r = await ask();
    } catch (err) {
      // A reply that isn't JSON (often a weaker model looping until the token cap) is a bad sample of a good request,
      // and there are no errors to repair it with: ask the same thing once more per turn.
      if (!(err instanceof PlannerError) || err.kind !== "bad_json" || resampled) throw err;
      resampled = true;
      emit({ type: "compile.errors", data: { errors: [`${err.message}; asked again`] } });
      r = await ask();
    }
    emit({ type: "planner.reply", data: { label, model: r.model, latencyMs: Math.round(r.latencyMs), usage: r.usage, json: r.json } });
    return r;
  };

  await shortlist("retrieve", request, input.carry, named);
  let user = prompt();
  let reply = await call(user, "plan");
  let searched = false;
  let searchedAgain = false;
  let repaired = false;
  // A plan that doesn't compile gets one repair, and a second when the first got closer (fewer errors): a weaker model
  // fixes a long plan a few mistakes at a time. Any other repair already spent counts as the first.
  let planRepairs = 0;
  let lastErrors = Infinity;
  const mayRepair = (errors: string[]) => {
    if (repaired && !(planRepairs === 1 && errors.length < lastErrors)) return false;
    repaired = true;
    planRepairs++;
    lastErrors = errors.length;
    return true;
  };
  let clarifyRepaired = false;
  let lookResults: Awaited<ReturnType<NonNullable<TurnDeps["look"]>>> = [];
  let emptyChecked = false;
  let lookPlan: CompiledPlan | undefined;
  let lookSteps: Step[] = [];
  let looks = 0;
  let lookClosed = false;
  const runLook = async (plan: CompiledPlan, steps: Step[]) => {
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
      if (repaired) return failed(`The planner's reply still didn't match submit_plan after one repair:\n${errors.join("\n")}`);
      repaired = true;
      reply = await call(repairBlock(user, reply.json, errors), "repair");
      continue;
    }
    const d = parsed.data;
    if (remadeChecked && remakeAnswer === undefined) remakeAnswer = d.outcome?.actions ?? null;
    // Freeze the first stated outcome across all subsequent reads, searches and repairs. A search may
    // initially lack action IDs; fill those once discovered, but never downgrade a change into a read.
    if (!outcome && d.outcome) { outcome = d.outcome; outcomeFrom = reply; }
    else if (restate && outcome?.effect === "change" && d.outcome?.effect === "change" && d.outcome.actions.length) { outcome = { ...outcome, actions: d.outcome.actions }; outcomeFrom = reply; }
    // A look that called its own reads the outcome, for a message that also tells ("Which leads never replied? Split
    // them between the reps"), described the look: the change the reply after it states is the request's.
    else if (restate && outcome?.effect === "read" && lookStated && d.outcome?.effect === "change" && d.outcome.actions.length && toldPart(input.message)) { outcome = d.outcome; outcomeFrom = reply; }
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
      if (assessed.kind === "question") return { kind: "reply", status: "clarify", text: d.question ?? "Please supply the missing input.", options: d.options ?? undefined };
      if (assessed.kind === "identity") {
        const { check, lookup } = assessed;
        identityCheck = check.digest;
        identityKey = `${lookup.entity}:${lookup.name.trim().toLowerCase()}`;
        if (check.count > 1) return { kind: "reply", status: "clarify", text: `I found ${check.count} matching ${lookup.entity.replaceAll("_", " ")} records. ${check.options ? roleQuestion(registry, d.missing) : "Please give a more specific name or qualifier."}`, options: check.options };
        // The only match can't be used (e.g. a deactivated user): that is the answer, whatever the planner asks next.
        if (check.match?.inactive) return { kind: "reply", status: "clarify", text: `${check.match.name} is ${check.match.inactive}, so I can't use ${lookup.entity.replaceAll("_", " ")} ${check.match.name}. Nothing was changed. Who should I use instead?` };
        if (checkedIdentity.includes(identityKey) || checkedIdentity.length > 1) {
          if (!check.count) return { kind: "reply", status: "clarify", text: `I couldn't find a matching ${lookup.entity.replaceAll("_", " ")}. Please give a fuller name or qualifier.` };
          return failed("The account lookup found one matching record, but the planner still asked which one. Nothing was changed; please try again.");
        }
      } else {
        identityCheck = assessed.digest;
        identityKey = "";
        // Shown the records, the planner still asks which one: when the message's name fits several, that is the question.
        if (checkedIdentity.length && assessed.ambiguous) return { kind: "reply", status: "clarify", text: d.question ?? "Which one did you mean?", options: d.options ?? undefined };
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
      // Retrieve again on the planner's own description of what's missing; the new cards join the old ones.
      await shortlist("search_tools", d.query || input.message);
      user = prompt();
      reply = await call(user, "plan after search_tools");
      continue;
    }

    if (d.type === "look") {
      // Reads only, run now; a write waits for the real plan (and its approval). A bad look is repaired like a plan.
      // Asked for a verdict, a model may want to look again: the reads it has are the answer, so they run as the plan.
      // Not for a message that also tells: a second look's own read outcome describes that look, not the request.
      if (looked !== undefined && lookPlan && outcome?.effect === "read" && !readOnlyIntentError(input.message, lookPlan, offered, registry).length) return { kind: "plan", plan: lookPlan, carry: carryOf(lookPlan, registry) };
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
        if (!mayRepair(errors)) return failed(`The plan was still invalid after repair:\n${errors.join("\n")}`);
        unfreezeRejected();
        reply = await call(repairBlock(user, reply.json, errors), "repair");
        continue;
      }
      // A look that states its own reads as a read outcome, for a message that asks for a change ("only the Facebook
      // ones, and make those tasks due tomorrow"), described the look, not the request: the plan after it states it.
      if (outcomeFrom === reply && outcome?.effect === "read" && readOnlyIntentError(input.message, compiled.plan, offered, registry).length) outcome = undefined;
      lookStated = outcomeFrom === reply && outcome?.effect === "read";
      await runLook(compiled.plan, lookSource.steps ?? []);
      restate = true;
      user = prompt();
      reply = await call(user, "plan after look");
      continue;
    }

    // After a look, the reads were the plan: they run again, so the records shown are current and the code's
    // summary stays. A question that only reads ("is that the only one?") also keeps the planner's verdict on
    // top, unless it leaks raw ids.
    if (d.type === "answer" && (lookPlan || outcome?.effect === "change") && !emptyChecked) {
      const errors = lookPlan ? [...outcomeErrors(lookPlan, outcome), ...(outcome ? [] : readOnlyIntentError(input.message, lookPlan, offered, registry))] : ["a prose answer does not complete the requested change; plan the final operations or report a blocker"];
      if (!errors.length && lookPlan) {
        const answer = outcome?.effect !== "change" ? d.text?.trim() : undefined;
        return { kind: "plan", plan: lookPlan, carry: carryOf(lookPlan, registry), ...(answer && !RAW_ID.test(answer) ? { answer } : {}) };
      }
      if (repaired) return failed(`The requested outcome is still incomplete:\n${errors.join("\n")}`);
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
      reply = await call(repairBlock(user, reply.json, errors), "repair");
      continue;
    }

    if (d.type !== "plan") {
      const text = [d.question ?? d.reason ?? d.text ?? "", d.alternatives?.length ? `Alternatives: ${d.alternatives.join("; ")}` : ""].filter(Boolean).join("\n");
      // "Unsupported" only means nothing on the shortlist fits, and the shortlist came from the user's loose wording.
      // Before believing it, retrieve once more on the planner's own description; re-plan only if that finds new cards.
      if (d.type === "unsupported" && !searched) {
        searched = true;
        const before = offered.length;
        await shortlist("search_tools", `${text}\n${input.message}`);
        if (offered.length > before) {
          user = prompt();
          reply = await call(user, "plan after search_tools");
          continue;
        }
      }
      return { kind: "reply", status: d.type, text, options: d.options ?? (d.alternatives?.length ? d.alternatives : undefined) };
    }

    const compiled = compile(withLookSteps(d, lookSteps), registry, new Set(offered.map((a) => a.id)));
    // A plan that only finds records does nothing the user can see: run, it would end "done" with no reply.
    const errors = !compiled.ok
      ? compiled.errors
      : inventedIds(compiled.plan, user, exists).length
        ? inventedIds(compiled.plan, user, exists)
        : compiled.plan.steps.some((s) => callsOf(s).length)
          ? [
              ...outcomeErrors(compiled.plan, outcome, { message: input.message, offered }),
              // Without a stated outcome, the message's own verbs are the only sign a write was asked for. A read outcome
              // this reply states for a message that asks, then tells, may describe only the asking.
              ...(outcome && !(outcomeFrom === reply && outcome.effect === "read") ? [] : readOnlyIntentError(input.message, compiled.plan, offered, registry)),
              ...duplicateCreates(compiled.plan, named, input.message, (entity, name) => !!store && (registry.resolver(entity)?.(store, name) ?? []).some((c) => !c.inactive && squash(c.name) === name)),
              ...staffInQuery(compiled.plan, named),
              ...unfilledNamedFields(compiled.plan, input.message),
              // Asked once, a remake stands, unless the reply since said it would change those records instead.
              ...remakes(compiled.plan, input, remadeChecked ? remakeAnswer ?? null : undefined),
              ...repeatsEmpty(compiled.plan, input.failed, registry),
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
        user = `${prompt()}\n${ANSWER_FROM_LOOKED}`;
        reply = await call(user, "answer after look");
        continue;
      }
      if (!empty.length) {
        const which = store && oneOfSameNamed(compiled.plan, named, registry, store, request);
        if (which) return { kind: "reply", status: "clarify", ...which };
        return { kind: "plan", plan: compiled.plan, carry: carryOf(compiled.plan, registry) };
      }
      if (emptyChecked) return { kind: "reply", status: "answer", text: "Nothing matched, so nothing was changed." };
      emptyChecked = true;
      const errors = empty.map((e) => `${e.step}: ${e.list} was already read and is empty, so this changes nothing. If the search was too narrow, plan again with a wider search inside the plan; if nothing should match, reply with type answer saying so`);
      emit({ type: "compile.errors", data: { errors } });
      user = prompt();
      reply = await call(repairBlock(user, reply.json, errors), "repair empty target");
      continue;
    }
    emit({ type: "compile.errors", data: { errors } });
    if (!mayRepair(errors)) return failed(`The plan was still invalid after repair:\n${errors.join("\n")}`);
    unfreezeRejected();
    if (compiled.ok && remakes(compiled.plan, input).length) remadeChecked = true;
    reply = await call(repairBlock(user, reply.json, errors), "repair");
  }
}

/**
 * A follow-up that narrows what the last turn did ("only the Facebook ones, and make those tasks due tomorrow") is
 * planned by weaker models as the whole request again, so the records it made are made twice. A plan that makes the
 * kind of record the last turn made, and changes none of those, is sent back once to say which it means; asked for
 * more ("one for Tom too"), it isn't.
 */
export function remakes(plan: CompiledPlan, input: Pick<TurnInput, "carry" | "records" | "message">, stated?: string[] | null): string[] {
  if (stated === null || stated?.length === 0) return [];
  if (/\b(also|too|another|more|as well|again|new)\b/i.test(input.message)) return [];
  const calls = plan.steps.flatMap(callsOf).filter((a) => a.risk !== "read");
  return [...new Set(input.carry?.made ?? [])].flatMap((entity) => {
    const mine = (input.records ?? []).filter((r) => r.entity === entity);
    const makes = calls.find((a) => a.entities?.produces === entity && !(a.entities?.consumes ?? []).includes(entity));
    const changes = calls.some((a) => (a.entities?.consumes ?? []).includes(entity));
    if (!mine.length || !makes || changes || stated?.includes(makes.id)) return [];
    const names = mine.slice(-8).map((r) => `${r.name} (${r.id}${r.for ? `, for ${r.for}` : ""})`).join(", ");
    return [`the last turn already made ${mine.length} ${entity} record${mine.length > 1 ? "s" : ""} (${names}); if this message narrows or changes what it did, update those that stay and cancel or undo those now left out instead of ${makes.id} again. If it asks for new ones as well, plan the same again`];
  });
}

/** On a retry, a search the failed attempt ran and found nothing with, run again unchanged, finds nothing again. */
export function repeatsEmpty(plan: CompiledPlan, failed: string | undefined, registry: Registry): string[] {
  let empty: { action: string; args: unknown }[] = [];
  try {
    empty = (failed && (JSON.parse(failed) as { empty?: typeof empty }).empty) || [];
  } catch { return []; }
  const key = (args: unknown) => JSON.stringify(args, (_, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v));
  return plan.steps.flatMap((s) => {
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

/** "Is that the only one?", "how many deals are open?", "who owns it?": not "can you list…?" or "show me…". */
export const isQuestion = (message: string) => {
  const m = message.trim();
  if (/^(please\s+)?((can|could|would|will) you|show|list|find|get|give|pull|display|open)\b/i.test(m)) return false;
  return /^(is|isn't|are|aren't|was|wasn't|were|does|doesn't|do|don't|did|didn't|has|hasn't|have|haven't|had|can|could|will|would|should|how many|how much|which|who|whose|any)\b/i.test(m);
};

const readsOnly = (plan: CompiledPlan) => plan.steps.every((s) => callsOf(s).every((a) => a.risk === "read"));

const ANSWER_FROM_LOOKED = "The reads in <looked> ran. Reply type answer to the question in <message>: start with the verdict (Yes, No, or the number), one or two sentences, records by name, never ids. Keep outcome.";

const callsOf = (s: CompiledPlan["steps"][number]) => (s.kind === "action" ? [s.call.action] : s.kind === "forEach" ? s.calls.map((c) => c.action) : []);

const squash = (s: unknown) => (typeof s === "string" ? s.toLowerCase().replace(/\s+/g, " ").trim() : "");

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
    const existing = named.find((m) => !m.of && m.entity === made && squash(m.name) === name);
    if (existing && (!sameName || sameName(made, name))) errors.push(`${s.id}: ${existing.name} already exists as a ${made}${existing.count > 1 ? ` (${existing.count} of them)` : ""}; resolve and use it instead of creating a duplicate with ${action.id}`);
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

/** "Which one is the contact that stays?" for an argument named for its role (a merge's keepId); otherwise "Which one do you mean?". */
function roleQuestion(registry: Registry, missing: SubmitPlan["missing"]): string {
  const action = missing && registry.get(missing.action);
  const role = action?.idTypes?.[missing!.argument] && ((action.inputSchema.properties ?? {}) as Record<string, { description?: string }>)[missing!.argument]?.description;
  return role ? `Which one is ${role}?` : "Which one do you mean?";
}
