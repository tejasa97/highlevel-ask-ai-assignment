import { createHash } from "node:crypto";
import type { z } from "zod";
import { ActionError, type ActionContext } from "../registry/define.js";
import { DEFAULT_ACTOR, invoke } from "../registry/invoke.js";
import type { Candidate, Registry } from "../registry/registry.js";
import type { Call, CompiledPlan, CStep } from "./compile.js";
import { parseRef, RefError, type Ref, substitute, valueAt } from "./refs.js";

// Stage 2: run a compiled plan.
// - Refs are substituted, then the concrete args are parsed with the action's Zod schema.
// - Risk is decided here, never by the model: destructive/external actions, and writes repeated over
//   BULK_MIN or more items, pause for confirmation. The approval is bound to the plan hash and to a hash of
//   the exact targets, so if the data changed between preview and approval, the user is asked again.
// - Resume = run the same executionId again with approvals. Reads re-run; writes are deduped through the
//   `writes` ledger (key executionId:stepId:itemKey:callIndex), so nothing is done twice.
// - Each forEach item runs in one transaction: its calls all land or none do. Items fail independently.

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
}

type ConcreteCall = { call: Call; args: Record<string, unknown>; label?: string; binding?: Record<string, unknown> };

export interface Clarification {
  stepId: string;
  entity: string;
  name: string;
  candidates: Candidate[];
}

export interface StepError {
  code: string;
  message: string;
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
}

export async function execute(plan: CompiledPlan, registry: Registry, ctx: ActionContext, opts: ExecOptions): Promise<RunResult> {
  const outputs = new Map<string, unknown>();
  const results: StepResult[] = [];
  const bad = new Set<string>(); // failed or skipped: dependents are skipped
  // Consecutive independent preflight-capable sends share one approval, including known exclusions.
  const checkedActions = new Map<string, { error?: StepError; gate: Pending | null }>();
  const emit = opts.onEvent ?? (() => {});
  let writesAttempted = false;
  const finish = (status: RunStatus, extra: Partial<RunResult> = {}): RunResult => ({
    writesAttempted,
    executionId: opts.executionId,
    planHash: plan.hash,
    status,
    steps: results,
    ...extra,
  });

  const lookup =
    (scope: { item?: unknown; rr?: unknown } = {}) =>
    (ref: Ref): unknown => {
      const label = `$${ref.root}`;
      if (ref.root === "item") return valueAt(scope.item, ref.path, label);
      if (ref.root === "rr") return valueAt(scope.rr, ref.path, label);
      if (!outputs.has(ref.root)) throw new RefError(`${label} has no output`);
      return valueAt(outputs.get(ref.root), ref.path, label);
    };
  const refValue = (raw: string, scope?: { item?: unknown; rr?: unknown }) => lookup(scope)(parseRef(raw)!);

  for (const step of plan.steps) {
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
          const all = registry.resolver(step.entity)!(ctx.store, step.name);
          const found = all.filter((c) => !c.inactive);
          if (found.length === 0 && all.length > 0) {
            // Only unusable records match (a deactivated user, a closed deal): say so, rather than "no match".
            fail({ code: "CONFLICT", message: all.map((c) => `${c.name} is ${c.inactive}`).join("; ") });
          } else if (found.length === 0) {
            // The planner sometimes guesses the wrong record type for a name; say where the name does exist.
            const elsewhere = registry
              .resolverEntities()
              .filter((e) => e !== step.entity && registry.resolver(e)!(ctx.store, step.name).some((c) => !c.inactive));
            const hint = elsewhere.length ? ` (but a ${elsewhere.join(" and a ")} does)` : "";
            fail({ code: "NOT_FOUND", message: `no ${step.entity} matches "${step.name}"${hint}` });
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
          done(list.filter((x) => matches(x, where)));
          break;
        }

        case "exclude": {
          const list = asList(refValue(step.in), step.in);
          const set = new Set(asList(refValue(step.set), step.set).map(String));
          done(list.filter((x) => !set.has(String((x as Record<string, unknown>)?.[step.by]))));
          break;
        }

        case "action": {
          const args = concreteArgs(step.call, lookup());
          if (!args.ok) {
            fail(args.error);
            break;
          }
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
            const gate = gateFor(step, eligible, plan.hash, opts.approvals, eligible.length, blocked);
            for (const g of group) checkedActions.set(g.step.id, { error: g.error, gate });
          }
          const checked = checkedActions.get(step.id);
          const gate = checked ? checked.gate : gateFor(step, [{ call: step.call, args: args.value }], plan.hash, opts.approvals);
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
          if (r.status === "failed") fail(r.error!);
          else done(r.results![0], r.replayed ? { items: [r] } : {});
          break;
        }

        case "forEach": {
          const list = Array.isArray(step.in) ? step.in : asList(refValue(step.in), step.in);
          const rr = Array.isArray(step.roundRobin) ? step.roundRobin : step.roundRobin ? asList(refValue(step.roundRobin), step.roundRobin) : null;
          if (rr && rr.length === 0 && list.length > 0) {
            fail({ code: "INVALID", message: `round-robin list ${step.roundRobin} is empty, so there is no one to assign to` });
            break;
          }
          // Resolve every item's args first: the preview shows exactly these, and the hash binds them.
          const prepared: { key: string; label?: string; item: unknown; calls: ConcreteCall[]; error?: StepError }[] = [];
          list.forEach((item, i) => {
            const scope = { item, rr: rr ? rr[i % rr.length] : undefined };
            const key = itemKey(item, i);
            const calls: ConcreteCall[] = [];
            for (const call of step.calls) {
              const a = concreteArgs(call, lookup(scope));
              if (!a.ok) return prepared.push({ key, label: labelOf(item), item, calls, error: a.error });
              calls.push({ call, args: a.value });
            }
            // Only a single call can be checked against the current state: earlier calls in a
            // transactional item may create/change prerequisites for later calls.
            const error = calls.length === 1 ? checkCalls(calls, ctx) : undefined;
            prepared.push({ key, label: labelOf(item), item, calls, error });
          });

          const gate = gateFor(
            step,
            prepared.filter((p) => !p.error).flatMap((p) => p.calls.map((c) => ({ ...c, label: p.label }))),
            plan.hash,
            opts.approvals,
            prepared.filter((p) => !p.error).length,
            prepared.filter((p) => p.error).map((p) => ({ label: p.label ?? p.key, error: p.error! })),
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
          else done(output, { items, status: failed ? "partial" : "done" });
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

function concreteArgs(call: Call, lookup: (r: Ref) => unknown): { ok: true; value: Record<string, unknown> } | { ok: false; error: StepError } {
  try {
    const raw = substitute(call.args, lookup);
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

/** Runs one item's calls in one transaction, replaying any write the ledger already has. */
function runItem(ctx: ActionContext, executionId: string, stepId: string, key: string, calls: { call: Call; args: Record<string, unknown> }[]): ItemResult {
  let replayed = 0;
  try {
    const results = ctx.store.tx(() =>
      calls.map(({ call, args }, i) => {
        const writes = call.action.risk !== "read";
        const ledgerKey = `${executionId}:${stepId}:${key}:${i}`;
        if (writes) {
          const prior = ctx.store.recordedWrite(ledgerKey);
          if (prior !== undefined) {
            replayed++;
            return prior;
          }
        }
        const value = invoke(call.action, args, ctx);
        if (writes) ctx.store.recordWrite(ledgerKey, call.action.id, value, ctx.clock.now());
        return value;
      }),
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
): Pending | null {
  const risks = new Set(calls.map((c) => c.call.action.risk));
  const writes = calls.filter((c) => c.call.action.risk !== "read");
  let reason: string | null = null;
  if (risks.has("destructive")) reason = "deletes or cancels records";
  else if (risks.has("external")) reason = "sends something outside the account";
  else if (step.kind === "forEach" && writes.length > 0 && count >= BULK_MIN) reason = `changes ${count} records at once`;
  if (!reason) return null;

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
  };
}

export function matches(x: unknown, where: Record<string, unknown>): boolean {
  const obj = (x ?? {}) as Record<string, unknown>;
  return Object.entries(where).every(([field, cond]) => {
    const v = obj[field];
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
  const name = o?.name ?? o?.title;
  return typeof name === "string" ? name : undefined;
}

function toError(e: unknown): StepError {
  if (e instanceof ActionError) return { code: e.code, message: e.message };
  if (e instanceof RefError) return { code: "INVALID", message: e.message };
  return { code: "INTERNAL", message: e instanceof Error ? e.message : String(e) };
}
