import { compile, type CompiledPlan } from "../core/compile.js";
import { lowerLookups } from "../core/lookups.js";
import { card } from "../registry/card.js";
import type { RegisteredAction, Registry } from "../registry/registry.js";
import { type Mention, mentions } from "../retrieval/mentions.js";
import type { Retrieval, Retriever } from "../retrieval/retrieve.js";
import type { Clock } from "../store/clock.js";
import type { Store } from "../store/db.js";
import { repairBlock, SYSTEM, userBlock } from "./prompt.js";
import { SUBMIT_PLAN_SCHEMA, SubmitPlan } from "./submit-plan.js";
import { type PlanResult, type Planner, PlannerError, type Tier } from "./types.js";
import { emptyTargets, outcomeErrors, type Outcome } from "./contracts.js";
import { assessClarification } from "./clarification.js";

// The planning half of a turn, shared by the dev server and the CLI:
//   retrieve a shortlist → prompt → plan, with at most one search_tools round (a second retrieval for what the
//   planner says is missing), at most one look round (read-only steps run now, their results fed back, so a
//   value can be worked out from a record: "same time, on Monday") and at most one repair round (compile errors
//   fed back), plus at most one repair of a malformed clarification (its own allowance, so it can't use up the plan's) and at most
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
  records?: { entity: string; id: string; name: string }[];
  /** Set on a retry: the plan that ran for this message and the errors it failed with, nothing changed. */
  failed?: string;
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
  let identityCheck: string | undefined;
  let outcome: Outcome | undefined;
  // Identity checks already run, by "entity:name": one more is allowed for a different record ("Sales" then "Noah").
  const checkedIdentity: string[] = [];
  const deliverySurfaces = registry.deliverySurfaces();
  const prompt = () =>
    userBlock({ clock, actions: offered, notAvailable, resolvable, lookupQualifiers: registry.resolverQualifiers(), records: input.records, mentions: named, message: input.message, context: input.context, failed: input.failed, looked, deliverySurfaces, identityCheck, outcome });
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
  let searchedAgain = false;
  let repaired = false;
  let clarifyRepaired = false;
  let lookResults: Awaited<ReturnType<NonNullable<TurnDeps["look"]>>> = [];
  let emptyChecked = false;
  let lookPlan: CompiledPlan | undefined;
  let lookSteps: Step[] = [];
  // Each reply is one of: search_tools (retrieve once more, re-plan), a plan (compile; repair once if invalid),
  // or a reply for the user. The repair prompt may itself say "reply search_tools" or "reply unsupported".
  for (;;) {
    const parsed = SubmitPlan.safeParse(reply.json);
    if (!parsed.success) return failed(`The planner's reply didn't match submit_plan: ${parsed.error.message}`);
    const d = parsed.data;
    // Freeze the first stated outcome across all subsequent reads, searches and repairs. A search may
    // initially lack action IDs; fill those once discovered, but never downgrade a change into a read.
    if (!outcome && d.outcome) outcome = d.outcome;
    else if (outcome && !outcome.actions.length && d.outcome?.actions.length) outcome = { ...outcome, actions: d.outcome.actions };
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
        if (check.count > 1) return { kind: "reply", status: "clarify", text: `I found ${check.count} matching ${lookup.entity.replaceAll("_", " ")} records. ${check.options ? "Which one do you mean?" : "Please give a more specific name or qualifier."}`, options: check.options };
        // The only match can't be used (e.g. a deactivated user): that is the answer, whatever the planner asks next.
        if (check.match?.inactive) return { kind: "reply", status: "clarify", text: `${check.match.name} is ${check.match.inactive}, so I can't use ${lookup.entity.replaceAll("_", " ")} ${check.match.name}. Nothing was changed. Who should I use instead?` };
        if (checkedIdentity.includes(identityKey) || checkedIdentity.length > 1) {
          if (!check.count) return { kind: "reply", status: "clarify", text: `I couldn't find a matching ${lookup.entity.replaceAll("_", " ")}. Please give a fuller name or qualifier.` };
          return failed("The account lookup found one matching record, but the planner still asked which one. Nothing was changed; please try again.");
        }
      } else {
        identityCheck = assessed.digest;
        identityKey = "";
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
      // <looked> contains compiler-generated resolve IDs too. Preserve those exact read steps so
      // the next plan can reference them just like any explicit look step.
      lookSteps = lowerLookups(d.steps ?? [], registry).steps;
      lookResults = await deps.look!(compiled.plan);
      looked = JSON.stringify(lookResults);
      if (looked.length > LOOKED_MAX) looked = `${looked.slice(0, LOOKED_MAX)}…(cut)`;
      user = prompt();
      reply = await call(user, "plan after look");
      continue;
    }

    // Answering from <looked> would put the planner's prose (and raw ids) where the summary of the reads belongs:
    // the reads were the plan.
    if (d.type === "answer" && (lookPlan || outcome?.effect === "change") && !emptyChecked) {
      const errors = lookPlan ? outcomeErrors(lookPlan, outcome) : ["a prose answer does not complete the requested change; plan the final operations or report a blocker"];
      if (!errors.length && lookPlan) return { kind: "plan", plan: lookPlan, carry: carryOf(lookPlan, registry) };
      if (repaired) return failed(`The requested outcome is still incomplete:\n${errors.join("\n")}`);
      repaired = true;
      emit({ type: "compile.errors", data: { errors } });
      user = prompt();
      reply = await call(repairBlock(user, reply.json, errors), "repair incomplete outcome");
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
      return { kind: "reply", status: d.type, text, options: d.options ?? undefined };
    }

    const compiled = compile(withLookSteps(d, lookSteps), registry, new Set(offered.map((a) => a.id)));
    // A plan that only finds records does nothing the user can see: run, it would end "done" with no reply.
    const errors = !compiled.ok
      ? compiled.errors
      : compiled.plan.steps.some((s) => callsOf(s).length)
        ? [...outcomeErrors(compiled.plan, outcome, { message: input.message, offered }), ...duplicateCreates(compiled.plan, named, input.message)]
        : ["the plan only finds records and calls no action; add the actions that do what was asked, or look to read what you need first"];
    if (compiled.ok && !errors.length) {
      // The reads found nothing to change: say so (once the planner has had the chance to widen its search or answer),
      // rather than run a loop over nothing.
      const empty = outcome?.effect === "change" ? emptyTargets(compiled.plan, lookResults) : [];
      if (!empty.length) return { kind: "plan", plan: compiled.plan, carry: carryOf(compiled.plan, registry) };
      if (emptyChecked) return { kind: "reply", status: "answer", text: "Nothing matched, so nothing was changed." };
      emptyChecked = true;
      const errors = empty.map((e) => `${e.step}: ${e.list} was already read and is empty, so this changes nothing. If the search was too narrow, plan again with a wider search inside the plan; if nothing should match, reply with type answer saying so`);
      emit({ type: "compile.errors", data: { errors } });
      user = prompt();
      reply = await call(repairBlock(user, reply.json, errors), "repair empty target");
      continue;
    }
    emit({ type: "compile.errors", data: { errors } });
    if (repaired) return failed(`The plan was still invalid after one repair:\n${errors.join("\n")}`);
    repaired = true;
    reply = await call(repairBlock(user, reply.json, errors), "repair");
  }
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

/** Characters of look results shown to the planner. */
const LOOKED_MAX = 6000;

const callsOf = (s: CompiledPlan["steps"][number]) => (s.kind === "action" ? [s.call.action] : s.kind === "forEach" ? s.calls.map((c) => c.action) : []);

const squash = (s: unknown) => (typeof s === "string" ? s.toLowerCase().replace(/\s+/g, " ").trim() : "");

/**
 * "Add Elodie Mercer, then post as her" when Elodie Mercer is already a contact: creating her again makes a
 * duplicate that later steps can't tell apart. Unless the message asks for a new or second one, the existing
 * record is meant.
 */
export function duplicateCreates(plan: CompiledPlan, named: Mention[], message: string): string[] {
  if (/\b(new|another|second|duplicate|separate)\b/i.test(message)) return [];
  const errors: string[] = [];
  for (const s of plan.steps) {
    if (s.kind !== "action") continue;
    const { action, args } = s.call;
    const made = action.entities?.produces;
    const name = squash(args.name) || squash([args.firstName, args.lastName].filter((v) => typeof v === "string").join(" "));
    if (!made || !name) continue;
    const existing = named.find((m) => !m.of && m.entity === made && squash(m.name) === name);
    if (existing) errors.push(`${s.id}: ${existing.name} already exists as a ${made}${existing.count > 1 ? ` (${existing.count} of them)` : ""}; resolve and use it instead of creating a duplicate with ${action.id}`);
  }
  return errors;
}

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
