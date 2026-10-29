import { createHash } from "node:crypto";
import type { z } from "zod";
import { ActionError, type ActionContext } from "../registry/define.js";
import { LIMIT_DEFAULT, LIMIT_MAX, norm } from "../registry/helpers.js";
import { DEFAULT_ACTOR, invoke } from "../registry/invoke.js";
import type { Candidate, Registry } from "../registry/registry.js";
import type { Call, CompiledPlan, CStep } from "./compile.js";
import { ENTITIES } from "../store/entities.js";
import { normalizeDateTimes } from "./datetimes.js";
import { OTHER_THAN } from "./lookups.js";
import { collectRefs, loopRead, parseRef, pathOf, RefError, type Ref, substitute, valueAt } from "./refs.js";

// Stage 2: run a compiled plan.
// - Refs are substituted, then the concrete args are parsed with the action's Zod schema.
// - Risk is decided here, never by the model: destructive/external actions, and writes repeated over
//   BULK_MIN or more items, pause for confirmation. The approval is bound to the plan hash and to a hash of
//   the exact targets, so if the data changed between preview and approval, the user is asked again.
// - Resume = run the same executionId again with approvals. Reads re-run; writes are deduped through the
//   `writes` ledger (key executionId:stepId:itemKey:callIndex), so nothing is done twice.
// - Each forEach item runs in one transaction: its calls all land or none do. Items fail independently.
// - Names are resolved before anything else runs. A name that finds nothing stops every write, so a request
//   is never left half-done because one of the records it names was misread (the turn can then replan).

export const BULK_MIN = 3;
const PREVIEW_MAX = 10;

export interface Approval {
  stepId: string;
  planHash: string;
  targetsHash: string;
}

export interface Pending extends Approval {
  reason: string;
  /** What will happen: one entry per call, with concrete args. */
  preview: { action: string; name: string; args: Record<string, unknown>; label?: string; target?: Record<string, unknown> }[];
  count: number;
  /** Set when an earlier approval no longer matches the targets. */
  changed?: boolean;
  /** Known ineligible targets; never included in the approved send subset. */
  blocked?: { label: string; error: StepError }[];
  blockedCount?: number;
  /** Every step this one approval decides, when it covers a run of steps (several sends checked together). */
  covers?: string[];
}

type ConcreteCall = {
  call: Call;
  args: Record<string, unknown>;
  label?: string;
  binding?: Record<string, unknown>;
  /** Args that use $prev: filled in from the previous call's result just before this call runs. */
  late?: (prev: unknown) => Record<string, unknown>;
};

/** What $prev shows in a preview, before the call it refers to has run. */
const LATER = (call: Call) => `(from ${call.action.name.toLowerCase()})`;

export interface Clarification {
  stepId: string;
  entity: string;
  name: string;
  candidates: Candidate[];
}

export interface StepError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type StepStatus = "done" | "partial" | "failed" | "skipped" | "awaiting_confirmation" | "needs_clarification";

export interface ItemResult {
  key: string;
  label?: string;
  status: "done" | "failed";
  results?: unknown[];
  error?: StepError;
  /** Writes that came from the ledger instead of running again. */
  replayed?: number;
}

export interface StepResult {
  id: string;
  kind: CStep["kind"];
  status: StepStatus;
  output?: unknown;
  error?: StepError;
  items?: ItemResult[];
  /** A create that found its record already there, whose existing record the later steps used instead. */
  existing?: StepError;
  /** A write over the first `loaded` of a search's `total` matches, because the plan asked for that many. */
  capped?: Cut;
}

/** A search whose page stopped short of its matches. */
export interface Cut {
  search: string;
  loaded: number;
  total: number;
}

export type RunStatus = "done" | "partial" | "failed" | "awaiting_confirmation" | "needs_clarification";

export interface RunResult {
  executionId: string;
  planHash: string;
  status: RunStatus;
  steps: StepResult[];
  pending?: Pending;
  clarification?: Clarification;
  /** Conservative recovery boundary: even an attempted write that rolled back prevents replanning. */
  writesAttempted?: boolean;
}

export type ExecEvent =
  | { type: "step.started"; stepId: string }
  | { type: "step.done"; stepId: string; status: StepStatus }
  | { type: "step.failed"; stepId: string; error: StepError }
  | { type: "confirm.required"; pending: Pending }
  | { type: "clarify.required"; clarification: Clarification };

export interface ExecOptions {
  executionId: string;
  approvals?: Approval[];
  onEvent?: (e: ExecEvent) => void;
  /** The user's words. A name that matches several records is narrowed by what else the request says about it. */
  request?: string;
  /** Everything the user said in the turns the planner saw: a limit their words never give was not asked for. */
  said?: string;
}

export async function execute(plan: CompiledPlan, registry: Registry, ctx: ActionContext, opts: ExecOptions): Promise<RunResult> {
  const outputs = new Map<string, unknown>();
  // What each search was asked for by name, and how long each filter's input was: for the guards below.
  const searched = new Map<string, { query: string; entity: string }>();
  const filteredFrom = new Map<string, number>();
  // A search returns one page of its matches. A write over that page alone would quietly skip the rest,
  // so a search feeding writes loads as many as a search can, and writes refuse a list that is still short.
  // A limit the plan set ("the 10 newest") is kept (`asked`), and is said wherever the write shows: `capped`.
  const cuts = new Map<string, Cut & { asked: boolean }>();
  const writeFeeds = new Set<string>();
  for (const s of [...plan.steps].reverse()) {
    const writes = s.kind === "forEach" ? s.calls.some((c) => c.action.risk !== "read") : s.kind === "action" && s.call.action.risk !== "read";
    if (writes || ((s.kind === "filter" || s.kind === "exclude") && writeFeeds.has(s.id))) for (const root of listRoots(s)) writeFeeds.add(root);
  }
  const results: StepResult[] = [];
  const bad = new Set<string>(); // failed or skipped: dependents are skipped
  // Consecutive independent preflight-capable sends share one approval, including known exclusions.
  const checkedActions = new Map<string, { error?: StepError; gate: Pending | null }>();
  const emit = opts.onEvent ?? (() => {});
  let writesAttempted = false;
  let nameMissing: string | undefined;
  const finish = (status: RunStatus, extra: Partial<RunResult> = {}): RunResult => ({
    writesAttempted,
    executionId: opts.executionId,
    planHash: plan.hash,
    status,
    steps: results,
    ...extra,
  });

  const lookup =
    (scope: { item?: unknown; rr?: unknown; prev?: unknown } = {}) =>
    (ref: Ref): unknown => {
      const label = `$${ref.root}`;
      if (ref.root === "item") return valueAt(scope.item, ref.path, label);
      if (ref.root === "rr") return valueAt(scope.rr, ref.path, label);
      if (ref.root === "prev") return typeof scope.prev === "function" ? (scope.prev as () => string)() : valueAt(scope.prev, ref.path, label);
      if (!outputs.has(ref.root)) throw new RefError(`${label} has no output`);
      return valueAt(outputs.get(ref.root), ref.path, label);
    };
  const refValue = (raw: string, scope?: { item?: unknown; rr?: unknown }) => lookup(scope)(parseRef(raw)!);
  // A written-out list holds plain strings and $refs to single values (["$s1", "us_2"]).
  const written = (list: string[]): unknown[] => list.map((x) => (parseRef(x) ? refValue(x) : x));

  /** A name search that found several records, used as if it found one: ask which, never take the first. */
  const several = (raw: string): Clarification | undefined => {
    const ref = parseRef(raw);
    const search = ref && searched.get(ref.root);
    const items = (outputs.get(ref?.root ?? "") as { items?: unknown[] } | undefined)?.items;
    if (!search || !Array.isArray(items) || items.length < 2) return undefined;
    const candidates = items.slice(0, 20).map((x, i) => ({ id: itemKey(x, i), name: labelOf(x) ?? itemKey(x, i), ...(detailOf(x) ? { detail: detailOf(x) } : {}) }));
    return { stepId: ref!.root, entity: search.entity, name: search.query, candidates };
  };
  const pickedFirst = (step: CStep & { kind: "action" }) => {
    for (const { ref } of collectRefs(step.call.args)) {
      const r = parseRef(ref);
      if (r?.path[0] && "field" in r.path[0] && r.path[0].field === "items" && r.path[1] && "index" in r.path[1]) {
        const c = several(ref);
        if (c) return c;
      }
    }
    return undefined;
  };
  // Looping a change over a search for one name that found several records with exactly that name.
  const sameNamed = (raw: string, list: unknown[]) => {
    const c = several(raw);
    if (!c || !/\.items$/.test(raw)) return undefined;
    return list.filter((x) => norm(labelOf(x) ?? "") === norm(c.name)).length >= 2 ? c : undefined;
  };
  /** Fills each arg the compiler marked as one value of a list, or says why the list doesn't hold exactly one. */
  const onlyOne = (call: Call): { call: Call } | { error: StepError } | { ask: Clarification } => {
    if (!call.one?.length) return { call };
    const args = structuredClone(call.args);
    for (const at of call.one) {
      const parent = at.slice(0, -1).reduce<any>((o, k) => o[k], args);
      const raw = parent[at.at(-1)!] as string;
      const values = asList(refValue(raw), raw);
      if (values.length === 1) {
        parent[at.at(-1)!] = values[0];
        continue;
      }
      if (values.length === 0) return { error: { code: "NOT_FOUND", message: `${raw} found nothing, so there is no ${at.at(-1)} to ${call.action.name.toLowerCase()} with` } };
      const ref = parseRef(raw)!;
      const items = asList(valueAt(outputs.get(ref.root), ref.path.slice(0, ref.path.findIndex((p) => "all" in p)), `$${ref.root}`), raw);
      const candidates = items.slice(0, 20).map((x, i) => ({ id: itemKey(x, i), name: labelOf(x) ?? itemKey(x, i), ...(detailOf(x) ? { detail: detailOf(x) } : {}) }));
      const search = searched.get(ref.root);
      return { ask: { stepId: ref.root, entity: search?.entity ?? call.action.entities?.consumes?.[0] ?? "record", name: search?.query ?? String(at.at(-1)), candidates } };
    }
    return { call: { ...call, args } };
  };
  const rootOf = (raw: string) => parseRef(raw)?.root ?? "";
  /**
   * A filter or exclude over a short list is short too: records it never saw may belong in it. A capped list stays
   * capped; but a capped set it checks against (who to exclude, who to keep) leaves out records it should have
   * removed or kept, which no limit asked for, so that is short.
   */
  const carry = (id: string, list: string, checks: string[]) => {
    const short = [list, ...checks].map((raw) => cuts.get(rootOf(raw))).find((c) => c && !c.asked);
    const check = checks.map((raw) => cuts.get(rootOf(raw))).find(Boolean);
    const c = short ?? (check && { ...check, asked: false }) ?? cuts.get(rootOf(list));
    if (c) cuts.set(id, c);
  };
  const cutOf = (step: CStep): Cut | undefined => {
    const c = listRoots(step).map((root) => cuts.get(root)).find((x) => x?.asked);
    return c && { search: c.search, loaded: c.loaded, total: c.total };
  };
  /** Refuses a write over a list that stops short of everything it matched; nothing is changed. */
  const shortList = (step: CStep): StepError | undefined => {
    for (const root of listRoots(step)) {
      const p = cuts.get(root);
      if (p && !p.asked) {
        const why = p.loaded === LIMIT_MAX ? `one search loads at most ${p.loaded}` : `only the first ${p.loaded} were loaded`;
        return { code: "INVALID", message: `$${p.search} matched ${p.total} records but ${why}, so nothing was changed rather than only part of them; narrow the search (by date, tag, owner…) and run it in parts` };
      }
    }
  };
  const ask = (step: CStep, clarification: Clarification) => {
    results.push({ id: step.id, kind: step.kind, status: "needs_clarification" });
    emit({ type: "clarify.required", clarification });
    return finish("needs_clarification", { clarification });
  };

  // A resolve with no deps can run first, which keeps every ref backward; one scoped by an earlier step (a lookup
  // within a parent) stays where it is.
  const first = (s: CStep) => s.kind === "resolve" && s.deps.length === 0;
  const ordered = [...plan.steps.filter(first), ...plan.steps.filter((s) => !first(s))];
  for (const step of ordered) {
    if (nameMissing && isWrite(step)) {
      bad.add(step.id);
      results.push({ id: step.id, kind: step.kind, status: "skipped", error: { code: "NOT_RUN", message: `${nameMissing}, so nothing was changed` } });
      continue;
    }
    if (step.deps.some((d) => bad.has(d))) {
      bad.add(step.id);
      results.push({
        id: step.id,
        kind: step.kind,
        status: "skipped",
        error: { code: "SKIPPED", message: `depends on a step that did not complete (${step.deps.filter((d) => bad.has(d)).join(", ")})` },
      });
      continue;
    }
    emit({ type: "step.started", stepId: step.id });
    const fail = (error: StepError, extra: Partial<StepResult> = {}) => {
      bad.add(step.id);
      results.push({ id: step.id, kind: step.kind, status: "failed", error, ...extra });
      emit({ type: "step.failed", stepId: step.id, error });
    };
    const done = (output: unknown, extra: Partial<StepResult> = {}) => {
      outputs.set(step.id, output);
      const status = extra.status ?? "done";
      results.push({ id: step.id, kind: step.kind, status, output, ...extra });
      emit({ type: "step.done", stepId: step.id, status });
    };

    try {
      switch (step.kind) {
        case "resolve": {
          if (step.pinned) {
            done({ ...step.pinned });
            break;
          }
          const { [OTHER_THAN]: other, ...where } = substitute(step.where ?? {}, lookup()) as Record<string, string>;
          // The same name in two arguments of one call (merge the two Sarah Johnsons) means two different records.
          const all = registry.resolver(step.entity)!(ctx.store, step.name, where).filter((c) => c.id !== other);
          const usable = all.filter((c) => !c.inactive);
          const found = usable.length > 1 && opts.request ? narrowByRequest(usable, opts.request) : usable;
          if (found.length === 0 && all.length > 0) {
            // Only unusable records match (a deactivated user, a closed deal): say so, rather than "no match".
            fail({ code: "CONFLICT", message: all.map((c) => `${c.name} is ${c.inactive}`).join("; ") });
            nameMissing = `"${step.name}" can't be used`;
          } else if (found.length === 0) {
            // The planner sometimes guesses the wrong record type for a name; say where the name does exist.
            const elsewhere = Object.keys(where).length ? [] : registry
              .resolverEntities()
              .filter((e) => e !== step.entity && !registry.resolver(e)!.parentQualifiers?.length && registry.resolver(e)!(ctx.store, step.name).some((c) => !c.inactive));
            const hint = elsewhere.length ? ` (but a ${elsewhere.join(" and a ")} does)` : "";
            fail({ code: "NOT_FOUND", message: `no ${step.entity} matches "${step.name}"${hint}` });
            nameMissing = `no ${step.entity} matches "${step.name}"`;
          } else if (found.length > 1) {
            const clarification = { stepId: step.id, entity: step.entity, name: step.name, candidates: found };
            results.push({ id: step.id, kind: step.kind, status: "needs_clarification" });
            emit({ type: "clarify.required", clarification });
            return finish("needs_clarification", { clarification });
          } else {
            done({ id: found[0]!.id, name: found[0]!.name });
          }
          break;
        }

        case "filter": {
          const list = asList(refValue(step.in), step.in);
          const where = substitute(step.where, lookup()) as Record<string, unknown>;
          filteredFrom.set(step.id, list.length);
          carry(step.id, step.in, whereLists(step.where));
          done(list.filter((x) => matches(x, where)));
          break;
        }

        case "exclude": {
          const list = asList(refValue(step.in), step.in);
          const set = new Set(asList(refValue(step.set), step.set).map(String));
          carry(step.id, step.in, [step.set]);
          done(list.filter((x) => !set.has(String(fieldOf(x, step.by)))));
          break;
        }

        case "action": {
          const single = onlyOne(step.call);
          if ("ask" in single) return ask(step, single.ask);
          if ("error" in single) {
            fail(single.error);
            break;
          }
          const args = concreteArgs(single.call, lookup());
          if (!args.ok) {
            fail(args.error);
            break;
          }
          const short = step.call.action.risk === "read" ? undefined : shortList(step);
          if (short) {
            fail(short);
            break;
          }
          // Left alone when the plan asked for a number ("the 10 newest"); otherwise every match it can. A large limit the
          // user's words never give asks for nothing: planners copy the schema's 50, or write 100 "to be safe". A small one
          // ("the newest", "top three") is the user's even when they didn't write it as a number.
          const words = opts.said ?? opts.request;
          const limit = args.value.limit;
          if (writeFeeds.has(step.id) && words !== undefined && typeof limit === "number" && limit >= LIMIT_DEFAULT && !says(words, limit)) delete args.value.limit;
          const widened = writeFeeds.has(step.id) && args.value.limit === undefined && takesLimit(step.call.action);
          if (widened) args.value.limit = LIMIT_MAX;
          const picked = step.call.action.risk === "read" ? undefined : pickedFirst(step);
          if (picked) return ask(step, picked);
          if (step.call.action.preflight && !checkedActions.has(step.id)) {
            const group: { step: CStep; calls: ConcreteCall[]; error?: StepError }[] = [];
            for (const next of plan.steps.slice(plan.steps.indexOf(step))) {
              if (next.kind !== "action" || !next.call.action.preflight || next.deps.some((d) => !outputs.has(d))) break;
              const a = concreteArgs(next.call, lookup());
              const calls: ConcreteCall[] = a.ok ? [{ call: next.call, args: a.value }] : [];
              const error = a.ok ? checkCalls(calls, ctx) : a.error;
              group.push({ step: next, calls, error });
            }
            const blocked = group.filter((g) => g.error).map((g) => ({ label: `${g.calls[0]?.call.action.name ?? "action"} (${g.calls[0]?.args.ticketId ?? g.step.id})`, error: g.error! }));
            const eligible = group.filter((g) => !g.error).flatMap((g) => g.calls);
            const cut = group.map((g) => cutOf(g.step)).find(Boolean);
            const gate = gateFor(step, eligible, plan.hash, opts.approvals, eligible.length, blocked, group.map((g) => g.step.id), cut);
            for (const g of group) checkedActions.set(g.step.id, { error: g.error, gate });
          }
          const checked = checkedActions.get(step.id);
          const cut = step.call.action.risk === "read" ? undefined : cutOf(step);
          const gate = checked ? checked.gate : gateFor(step, [{ call: step.call, args: args.value }], plan.hash, opts.approvals, 1, [], [step.id], cut);
          if (gate) {
            results.push({ id: step.id, kind: step.kind, status: "awaiting_confirmation" });
            emit({ type: "confirm.required", pending: gate });
            return finish("awaiting_confirmation", { pending: gate });
          }
          if (checked?.error) {
            fail(checked.error);
            break;
          }
          if (step.call.action.risk !== "read") writesAttempted = true;
          const r = runItem(ctx, opts.executionId, step.id, "-", [{ call: step.call, args: args.value }]);
          const existing = r.status === "failed" ? alreadyThere(step, r.error!, plan, ctx) : undefined;
          if (existing) done(existing, { existing: r.error! });
          else if (r.status === "failed") fail(r.error!);
          else {
            const query = args.value.query ?? args.value.name;
            if (step.call.action.risk === "read" && typeof query === "string" && query.trim()) searched.set(step.id, { query, entity: step.call.action.entities?.produces ?? "record" });
            const out = r.results![0];
            if (writeFeeds.has(step.id) && isPage(out) && out.total > out.items.length) cuts.set(step.id, { search: step.id, loaded: out.items.length, total: out.total, asked: !widened });
            done(r.results![0], { ...(r.replayed ? { items: [r] } : {}), ...(cut ? { capped: cut } : {}) });
          }
          break;
        }

        case "forEach": {
          let list = Array.isArray(step.in) ? written(step.in) : asList(refValue(step.in), step.in);
          const rr = Array.isArray(step.roundRobin) ? written(step.roundRobin) : step.roundRobin ? asList(refValue(step.roundRobin), step.roundRobin) : null;
          if (rr && rr.length === 0 && list.length > 0) {
            fail({ code: "INVALID", message: `round-robin list ${step.roundRobin} is empty, so there is no one to assign to` });
            break;
          }
          const writes = step.calls.some((c) => c.action.risk !== "read");
          const duplicate = writes && typeof step.in === "string" ? sameNamed(step.in, list) : undefined;
          if (duplicate) {
            // A detail of exactly one of them in the user's words ("Sarah Johnson at Acme") picks it.
            // The resolver says best what tells them apart ("Brightside", an email).
            const resolved = new Map((registry.resolver(duplicate.entity)?.(ctx.store, duplicate.name) ?? []).map((c) => [c.id, c]));
            const candidates = duplicate.candidates.map((c) => resolved.get(c.id) ?? c);
            const picked = opts.request ? narrowByRequest(candidates, opts.request) : candidates;
            if (picked.length > 1) return ask(step, { ...duplicate, candidates });
            list = list.filter((x, i) => itemKey(x, i) === picked[0]!.id);
          }
          const short = writes ? shortList(step) : undefined;
          if (short) {
            fail(short);
            break;
          }
          const root = typeof step.in === "string" ? parseRef(step.in)?.root : undefined;
          if (writes && list.length === 0 && root && filteredFrom.get(root)) {
            fail({ code: "NOT_FOUND", message: `the filter ${root} kept none of the ${filteredFrom.get(root)} records found, so nothing was changed; check its conditions against the found records` });
            break;
          }
          // Resolve every item's args first: the preview shows exactly these, and the hash binds them.
          const prepared: { key: string; label?: string; item: unknown; calls: ConcreteCall[]; error?: StepError }[] = [];
          list.forEach((item, i) => {
            const scope = { item, rr: rr ? rr[i % rr.length] : undefined };
            const key = itemKey(item, i);
            const calls: ConcreteCall[] = [];
            for (const [n, call] of step.calls.entries()) {
              const earlier = step.calls[n - 1];
              const a = concreteArgs(call, lookup({ ...scope, ...(earlier ? { prev: () => LATER(earlier) } : {}) }));
              if (!a.ok) return prepared.push({ key, label: labelOf(item), item, calls, error: a.error });
              const late = collectRefs(call.args).some((r) => parseRef(r.ref)?.root === "prev")
                ? (prev: unknown) => {
                    const b = concreteArgs(call, lookup({ ...scope, prev }));
                    if (!b.ok) throw new RefError(b.error.message);
                    return b.value;
                  }
                : undefined;
              calls.push({ call, args: a.value, ...(late ? { late } : {}) });
            }
            // Only a single call can be checked against the current state: earlier calls in a
            // transactional item may create/change prerequisites for later calls.
            const error = calls.length === 1 ? checkCalls(calls, ctx) : undefined;
            prepared.push({ key, label: labelOf(item), item, calls, error });
          });

          const cut = writes ? cutOf(step) : undefined;
          const gate = gateFor(
            step,
            prepared.filter((p) => !p.error).flatMap((p) => p.calls.map((c) => ({ ...c, label: p.label }))),
            plan.hash,
            opts.approvals,
            prepared.filter((p) => !p.error).length,
            prepared.filter((p) => p.error).map((p) => ({ label: p.label ?? p.key, error: p.error! })),
            [step.id],
            cut,
          );
          if (gate) {
            results.push({ id: step.id, kind: step.kind, status: "awaiting_confirmation" });
            emit({ type: "confirm.required", pending: gate });
            return finish("awaiting_confirmation", { pending: gate });
          }

          if (prepared.some((p) => !p.error && p.calls.some((c) => c.call.action.risk !== "read"))) writesAttempted = true;
          const items: ItemResult[] = prepared.map((p) =>
            p.error
              ? { key: p.key, label: p.label, status: "failed", error: p.error }
              : { label: p.label, ...runItem(ctx, opts.executionId, step.id, p.key, p.calls) },
          );
          const output = prepared.map((p, i) => ({ item: p.item, results: items[i]!.results ?? [] }));
          const failed = items.filter((x) => x.status === "failed").length;
          if (failed > 0 && failed === items.length) fail({ code: "ALL_FAILED", message: `all ${failed} items failed` }, { items });
          else done(output, { items, status: failed ? "partial" : "done", ...(cut ? { capped: cut } : {}) });
          break;
        }
      }
    } catch (e) {
      fail(toError(e));
    }
  }

  // Run status: done if every step is; failed if no final step got anything done; partial otherwise.
  const used = new Set(plan.steps.flatMap((s) => s.deps));
  const finals = results.filter((r) => !used.has(r.id));
  if (results.every((r) => r.status === "done")) return finish("done");
  if (finals.every((r) => r.status === "failed" || r.status === "skipped")) return finish("failed");
  return finish("partial");
}

/**
 * "Tag Omar as a partner" planned as create the tag, then apply it, when a "partner" tag already exists: the
 * create was only a way to get a tag to apply, so the steps after it use the one that's there. A create nothing
 * later builds on still reports the duplicate, and an existing record of another type (a lead's email that
 * belongs to a contact) is never taken for it.
 */
function alreadyThere(step: CStep & { kind: "action" }, error: StepError, plan: CompiledPlan, ctx: ActionContext): unknown {
  const entity = step.call.action.entities?.produces;
  const id = error.details?.existingId;
  if (error.code !== "DUPLICATE" || !entity || typeof id !== "string") return undefined;
  if (error.details?.kind !== undefined && error.details.kind !== entity) return undefined;
  if (!plan.steps.some((s) => s.deps.includes(step.id))) return undefined;
  const table = Object.entries(ENTITIES).find(([, d]) => id.startsWith(`${d.prefix}_`))?.[0];
  return (table && ctx.store.get(table, id)) ?? { id };
}

const isWrite = (s: CStep) =>
  (s.kind === "action" && s.call.action.risk !== "read") || (s.kind === "forEach" && s.calls.some((c) => c.action.risk !== "read"));

/** norm drops line breaks outright, which would glue the lines of an answered question together. */
const normText = (s: string) => norm(s.replace(/\s+/g, " "));

/**
 * Same-named records ("Sarah Johnson" twice) told apart by the request: a detail of exactly one of them (a company,
 * an email) named in the user's words picks it. Details every candidate shares tell nothing apart, so they're ignored.
 */
export function narrowByRequest(found: Candidate[], request: string): Candidate[] {
  const words = ` ${normText(request)} `;
  const partsOf = (c: Candidate) => (c.detail ?? "").split(",").map((p) => norm(p)).filter((p) => p.length > 1);
  const shared = (p: string) => found.every((c) => partsOf(c).includes(p));
  const hit = found.filter((c) => partsOf(c).some((p) => !shared(p) && words.includes(` ${p} `)));
  return hit.length === 1 ? hit : found;
}

function concreteArgs(call: Call, lookup: (r: Ref) => unknown): { ok: true; value: Record<string, unknown> } | { ok: false; error: StepError } {
  try {
    const raw = normalizeDateTimes(dropMissing(call, substitute(call.args, lookup)), call.action.inputSchema);
    const parsed = (call.action.input as z.ZodType).safeParse(raw);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join(".") || "(args)"}: ${i.message}`).join("; ");
      return { ok: false, error: { code: "INVALID", message: `${call.action.id} args: ${msg}` } };
    }
    return { ok: true, value: parsed.data as Record<string, unknown> };
  } catch (e) {
    return { ok: false, error: toError(e) };
  }
}

/**
 * An optional argument set from a reference that came out empty ("assigneeId": "$item.ownerId" for a lead with no
 * owner) is left out, as if it weren't given, unless the field takes null.
 */
function dropMissing(call: Call, value: unknown): unknown {
  const args = call.args as Record<string, unknown> | undefined;
  if (!value || typeof value !== "object" || Array.isArray(value) || !args) return value;
  const schema = call.action.inputSchema as { required?: string[]; properties?: Record<string, unknown> };
  const out = { ...(value as Record<string, unknown>) };
  for (const [k, v] of Object.entries(out)) {
    if (v !== null && v !== undefined) continue;
    const from = args[k];
    if (typeof from !== "string" || !parseRef(from) || schema.required?.includes(k) || takesNull(schema.properties?.[k])) continue;
    delete out[k];
  }
  return out;
}

const takesNull = (s: unknown): boolean => {
  const o = s as { type?: unknown; anyOf?: unknown[]; oneOf?: unknown[] } | undefined;
  if (!o) return true;
  if (o.type === "null" || (Array.isArray(o.type) && o.type.includes("null"))) return true;
  return [...(o.anyOf ?? []), ...(o.oneOf ?? [])].some(takesNull);
};

/** Runs one item's calls in one transaction, replaying any write the ledger already has. */
/**
 * The lists a step takes whole: a loop's input, a filter's input and the lists its conditions check against
 * (`{ id: { in: "$s2.items[*].leadId" } }`), an exclude's sets, an action arg that takes every item ($s1.items[*].id).
 */
function listRoots(step: CStep): string[] {
  const roots =
    step.kind === "forEach" ? [step.in]
    : step.kind === "filter" ? [step.in, ...whereLists(step.where)]
    : step.kind === "exclude" ? [step.in, step.set]
    : step.kind === "action" ? collectRefs(step.call.args).map((r) => r.ref).filter((raw) => parseRef(raw)?.path.some((p) => "all" in p))
    : [];
  return roots.flatMap((raw) => (typeof raw === "string" ? [parseRef(raw)?.root] : [])).filter((r): r is string => !!r);
}

/** The every-item lists ($s2.items[*].leadId) a filter's conditions check against. */
const whereLists = (where: Record<string, unknown>) => collectRefs(where).map((r) => r.ref).filter((raw) => parseRef(raw)?.path.some((p) => "all" in p));
/** Whether the user's words give this count ("the first 50"), not an amount, a share or a span ("$50", "50%", "50 days"). */
const says = (words: string, n: number) =>
  new RegExp(`(^|[^\\d.,$€£₹])${n}(?![\\d%]|[.,]\\d|\\s*(?:k|percent|dollars?|usd|days?|weeks?|months?|years?|hours?|minutes?|mins?|miles?|km)\\b)`, "i").test(words);
const takesLimit = (action: { input: unknown }) => !!(action.input as { shape?: Record<string, unknown> }).shape?.limit;
const isPage = (x: unknown): x is { items: unknown[]; total: number } =>
  !!x && typeof x === "object" && Array.isArray((x as { items?: unknown }).items) && typeof (x as { total?: unknown }).total === "number";

function runItem(ctx: ActionContext, executionId: string, stepId: string, key: string, calls: ConcreteCall[]): ItemResult {
  let replayed = 0;
  try {
    const results = ctx.store.tx(() =>
      calls.reduce<unknown[]>((done, { call, args, late }, i) => {
        const writes = call.action.risk !== "read";
        const ledgerKey = `${executionId}:${stepId}:${key}:${i}`;
        const prior = writes ? ctx.store.recordedWrite(ledgerKey) : undefined;
        if (prior !== undefined) {
          replayed++;
          return [...done, prior];
        }
        const value = invoke(call.action, late ? late(done[i - 1]) : args, ctx);
        if (writes) ctx.store.recordWrite(ledgerKey, call.action.id, value, ctx.clock.now());
        return [...done, value];
      }, []),
    );
    return { key, status: "done", results, ...(replayed ? { replayed } : {}) };
  } catch (e) {
    return { key, status: "failed", error: toError(e) };
  }
}

/** Never invokes handlers, consumes faults, creates records or emits delivery traces. */
function checkCalls(calls: ConcreteCall[], ctx: ActionContext): StepError | undefined {
  try {
    for (const c of calls) if (c.call.action.preflight) c.binding = c.call.action.preflight(c.args, { ...ctx, actorId: ctx.actorId ?? DEFAULT_ACTOR });
  } catch (e) {
    return toError(e);
  }
}

function gateFor(
  step: CStep,
  calls: ConcreteCall[],
  planHash: string,
  approvals: Approval[] = [],
  count = calls.length,
  blocked: { label: string; error: StepError }[] = [],
  covers: string[] = [step.id],
  cut?: Cut,
): Pending | null {
  const risks = new Set(calls.map((c) => c.call.action.risk));
  const writes = calls.filter((c) => c.call.action.risk !== "read");
  let reason: string | null = null;
  if (risks.has("destructive")) reason = "deletes or cancels records";
  else if (risks.has("external")) reason = "sends something outside the account";
  else if (step.kind === "forEach" && writes.length > 0 && count >= BULK_MIN) reason = `changes ${count} records at once`;
  if (!reason) return null;
  if (cut) reason += ` (only the first ${cut.loaded} of the ${cut.total} found were looked at)`;

  const targets = writes.map((c) => ({ action: c.call.action.id, args: c.args, ...(c.binding ? { binding: c.binding } : {}) }));
  const targetsHash = createHash("sha256").update(JSON.stringify({ targets, blocked })).digest("hex").slice(0, 16);
  const prior = approvals.find((a) => a.stepId === step.id && a.planHash === planHash);
  if (prior?.targetsHash === targetsHash) return null;
  return {
    stepId: step.id,
    planHash,
    targetsHash,
    reason,
    count,
    preview: writes
      .slice(0, PREVIEW_MAX)
      .map((c) => ({ action: c.call.action.id, name: c.call.action.name, args: c.args, ...(c.label ? { label: c.label } : {}), ...(c.binding ? { target: c.binding } : {}) })),
    ...(blocked.length ? { blocked: blocked.slice(0, PREVIEW_MAX), blockedCount: blocked.length } : {}),
    ...(prior ? { changed: true } : {}),
    ...(covers.length > 1 ? { covers } : {}),
  };
}

/** An item's field, or a dotted path into it ("relatedTo.id"). */
export function fieldOf(x: unknown, field: string): unknown {
  return pathOf(field).reduce<unknown>((v, k) => {
    if (!v || typeof v !== "object") return undefined;
    const o = v as Record<string, unknown>;
    // A loop entry's field it doesn't have is what its one "do" call returned, as the plan compiled it.
    if (!(k in o) && loopRead(o, k)) return ((o.results as Record<string, unknown>[])[0] ?? {})[k];
    return o[k];
  }, x);
}

export function matches(x: unknown, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([field, cond]) => {
    const v = fieldOf(x, field);
    const conds = cond && typeof cond === "object" && !Array.isArray(cond) ? Object.entries(cond) : [["eq", cond] as const];
    // orNull admits null/missing for this field only; non-null values must still meet every condition.
    if ((v === null || v === undefined) && conds.some(([op, want]) => op === "orNull" && want === true)) return true;
    return conds.every(([op, want]) => {
      switch (op) {
        case "orNull":
          return true;
        case "eq":
          return v === want;
        case "ne":
          return v !== want;
        case "gt":
          return cmp(v, want) > 0;
        case "gte":
          return cmp(v, want) >= 0;
        case "lt":
          return cmp(v, want) < 0;
        case "lte":
          return cmp(v, want) <= 0;
        case "in":
          return Array.isArray(want) && want.includes(v);
        case "nin":
          return Array.isArray(want) && !want.includes(v);
        case "contains":
          return Array.isArray(v) ? v.includes(want) : typeof v === "string" && typeof want === "string" && v.toLowerCase().includes(want.toLowerCase());
        case "exists":
          return (v !== null && v !== undefined) === Boolean(want);
        default:
          return false;
      }
    });
  });
}

function cmp(a: unknown, b: unknown): number {
  if (a === null || a === undefined || b === null || b === undefined) return NaN;
  return typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));
}

function asList(v: unknown, ref: string): unknown[] {
  if (!Array.isArray(v)) throw new RefError(`${ref} is not a list at run time`);
  return v;
}

function itemKey(item: unknown, i: number): string {
  if (typeof item === "string") return `#${i}:${item}`;
  const id = (item as Record<string, unknown> | null)?.id;
  return typeof id === "string" || typeof id === "number" ? String(id) : `#${i}`;
}

function labelOf(item: unknown): string | undefined {
  if (typeof item === "string") return item;
  const o = item as Record<string, unknown> | null;
  const name = o?.name ?? o?.title ?? o?.number;
  return typeof name === "string" ? name : undefined;
}

/** A couple of short descriptive fields, so same-named records can be told apart: "Austin, active". */
function detailOf(item: unknown): string | undefined {
  const o = (item ?? {}) as Record<string, unknown>;
  const skip = /^(id|name|title|createdAt|updatedAt)$|Id$|At$/;
  const parts = Object.entries(o).filter(([k, v]) => !skip.test(k) && typeof v === "string" && v && v.length <= 40).map(([, v]) => v as string);
  return parts.slice(0, 2).join(", ") || undefined;
}

function toError(e: unknown): StepError {
  if (e instanceof ActionError) return { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) };
  if (e instanceof RefError) return { code: "INVALID", message: e.message };
  return { code: "INTERNAL", message: e instanceof Error ? e.message : String(e) };
}
