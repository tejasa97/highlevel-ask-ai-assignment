import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import type { SubmitPlan } from "../planner/submit-plan.js";
import { loadRegistry, type Registry } from "../registry/registry.js";
import { world } from "../store/world.js";
import { compile } from "./compile.js";
import { execute } from "./execute.js";
import { asksForMore, leftOut, reviseCall, reviseErrors, tableOf, type Made } from "./revise.js";
import { summarize } from "./summarize.js";

let registry: Registry;
before(async () => {
  registry = await loadRegistry();
});

const task = (leadId: string, args: Record<string, unknown> = {}, id = "s1") => ({
  id,
  kind: "action" as const,
  action: "M06.A01",
  argsJson: JSON.stringify({ title: "Call back", relatedTo: { type: "lead", id: leadId }, ...args }),
});
const plan = (steps: SubmitPlan["steps"]): SubmitPlan => ({ type: "plan", steps, question: null, options: null, reason: null, alternatives: null, query: null, text: null });
const compiled = (p: SubmitPlan) => {
  const r = compile(p, registry);
  if (!r.ok) assert.fail(r.errors.join("\n"));
  return r.plan;
};

/** Two leads with an open task each, as the last turn would have made them. */
function lastTurn() {
  const ctx = world();
  const [a, b] = [ctx.f.lead(), ctx.f.lead()];
  const [ta, tb] = [a, b].map((l) => ctx.f.task({ title: `Call ${l.id}`, dueDate: "2026-10-28", priority: "normal", relatedTo: { type: "lead", id: l.id } }));
  const made: Made[] = [
    { entity: "task", id: ta!.id, name: ta!.title, for: a.id },
    { entity: "task", id: tb!.id, name: tb!.title, for: b.id },
  ];
  return { ctx, a, b, ta: ta!, tb: tb!, made };
}
const status = (ctx: ReturnType<typeof world>, id: string) => ctx.store.get<{ status: string; dueDate: string | null; priority: string }>("tasks", id)!;

describe("revise declarations", () => {
  test("every create that declares revise names real edits, an undo, and an argument to match on", () => {
    const declared = registry.list().filter((a) => a.revise);
    assert.ok(declared.length > 0);
    for (const a of declared) assert.deepEqual(reviseErrors(a, registry), [], a.id);
  });

  test("a declaration that names a missing edit or undo is reported", () => {
    const create = registry.get("M06.A01")!;
    const bad = { ...create, revise: { key: "nope", edits: { dueDate: "M99.A01", title: "M06.A06" }, undo: "M99.A02" } };
    const errors = reviseErrors(bad, registry).join("\n");
    assert.match(errors, /key nope is not an argument/);
    assert.match(errors, /M99\.A01, which is not an action/);
    assert.match(errors, /M06\.A06 must take taskId and title/);
    assert.match(errors, /M99\.A02, which is not an action/);
  });

  test("asking for more is told apart from changing what was made", () => {
    assert.ok(asksForMore("Make one for Tom too"));
    assert.ok(asksForMore("Add another"));
    assert.ok(!asksForMore("Only the Facebook ones, due Friday"));
  });

  test("tableOf finds the table of an id by its prefix", () => {
    assert.equal(tableOf("tk_1"), "tasks");
    assert.equal(tableOf("zz_1"), undefined);
  });
});

describe("reviseCall and leftOut", () => {
  test("a create for the same thing becomes the edits for the fields that differ", () => {
    const { ctx, a, ta, made } = lastTurn();
    const create = registry.get("M06.A01")!;
    const taken = new Set<string>();
    const args = { title: "Call back", dueDate: "2026-10-30", priority: "normal", relatedTo: { type: "lead", id: a.id } };
    const rev = reviseCall(create, args, made, taken, ctx, registry)!;
    assert.equal(rev.id, ta.id);
    assert.deepEqual(rev.edits.map((e) => [e.action.id, e.args]), [["M06.A06", { taskId: ta.id, dueDate: "2026-10-30" }]]);
    assert.ok(taken.has(ta.id));
    // The record is taken: a second create for the same lead makes a new one.
    assert.equal(reviseCall(create, args, made, taken, ctx, registry), undefined);
  });

  test("nothing differs: the record is kept with no edits", () => {
    const { ctx, a, made } = lastTurn();
    const rev = reviseCall(registry.get("M06.A01")!, { title: "x", dueDate: "2026-10-28", relatedTo: { type: "lead", id: a.id } }, made, new Set(), ctx, registry)!;
    assert.deepEqual(rev.edits, []);
  });

  test("a finished or unrelated record is not revised", () => {
    const { ctx, a, ta, made } = lastTurn();
    ctx.store.update("tasks", ta.id, { status: "completed" });
    const create = registry.get("M06.A01")!;
    assert.equal(reviseCall(create, { title: "x", relatedTo: { type: "lead", id: a.id } }, made, new Set(), ctx, registry), undefined);
    assert.equal(reviseCall(create, { title: "x", relatedTo: { type: "lead", id: "ld_other" } }, made, new Set(), ctx, registry), undefined);
    assert.equal(reviseCall(create, { title: "x" }, made, new Set(), ctx, registry), undefined);
  });

  test("leftOut lists the open records nobody took", () => {
    const { ctx, tb, made, ta } = lastTurn();
    const create = registry.get("M06.A01")!;
    assert.deepEqual(leftOut([create], made, new Set([ta.id]), ctx).map((l) => l.record.id), [tb.id]);
    ctx.store.update("tasks", tb.id, { status: "cancelled" });
    assert.deepEqual(leftOut([create], made, new Set([ta.id]), ctx), []);
    assert.deepEqual(leftOut([registry.get("M06.A03")!], made, new Set(), ctx), []);
  });
});

describe("an amended request, run", () => {

  test("updates the kept task, asks before cancelling the one left out, then cancels it", async () => {
    const { ctx, a, ta, tb, made } = lastTurn();
    const p = compiled(plan([task(a.id, { dueDate: "2026-10-30" })]));
    const baseTasks = ctx.store.all("tasks").length;
    const revises = { made, message: "Only the first one, due Friday" };

    const first = await execute(p, registry, ctx, { executionId: "amend1", revises });
    assert.equal(first.status, "awaiting_confirmation");
    assert.equal(first.pending?.stepId, "revise");
    assert.equal(first.pending?.count, 1);
    assert.equal(first.pending?.preview?.[0]?.label, tb.title);
    assert.equal(ctx.store.all("tasks").length, baseTasks, "no new task");
    assert.equal(status(ctx, ta.id).dueDate, "2026-10-30");
    assert.equal(status(ctx, tb.id).status, "open", "nothing cancelled before approval");

    const second = await execute(p, registry, ctx, { executionId: "amend1", revises, approvals: [first.pending!] });
    assert.equal(second.status, "done", JSON.stringify(second));
    assert.deepEqual(second.cancelled?.map((c) => c.id), [tb.id]);
    assert.equal(status(ctx, tb.id).status, "cancelled");
    assert.equal(status(ctx, ta.id).status, "open");
    assert.equal(ctx.store.all("tasks").length, baseTasks);

    const said = summarize(p, second, registry);
    assert.match(said, /Updated the existing task/);
    assert.match(said, new RegExp(tb.title));
  });

  test("a run that keeps every record has nothing to cancel", async () => {
    const { ctx, a, b, ta, tb, made } = lastTurn();
    const p = compiled(plan([task(a.id, { dueDate: "2026-10-30" }, "s1"), task(b.id, { dueDate: "2026-10-30" }, "s2")]));
    const r = await execute(p, registry, ctx, { executionId: "amend2", revises: { made, message: "Make them due Friday" } });
    assert.equal(r.status, "done");
    assert.equal(r.pending, undefined);
    assert.equal(status(ctx, ta.id).dueDate, "2026-10-30");
    assert.equal(status(ctx, tb.id).dueDate, "2026-10-30");
  });

  test("asking for more neither updates nor cancels the rest", async () => {
    const { ctx, a, tb, made } = lastTurn();
    const p = compiled(plan([task(a.id, { dueDate: "2026-10-30" })]));
    const r = await execute(p, registry, ctx, { executionId: "amend3", revises: { made, message: "One for Ana too, due Friday" } });
    assert.equal(r.status, "done");
    assert.equal(r.pending, undefined);
    assert.equal(r.cancelled, undefined);
    assert.equal(status(ctx, tb.id).status, "open");
  });

  test("a narrowing that took no earlier record but made new ones cancels the ones it replaces, after asking", async () => {
    const { ctx, ta, tb, made } = lastTurn();
    const fresh = ctx.f.lead();
    const p = compiled(plan([task(fresh.id, { dueDate: "2026-10-30" })]));
    const revises = { made, message: "Only the other lead" };
    const first = await execute(p, registry, ctx, { executionId: "amend4", revises });
    assert.equal(first.status, "awaiting_confirmation");
    assert.equal(first.pending?.stepId, "revise");
    assert.equal(first.pending?.count, 2);
    const second = await execute(p, registry, ctx, { executionId: "amend4", revises, approvals: [first.pending!] });
    assert.equal(second.status, "done");
    assert.deepEqual(second.cancelled?.map((c) => c.id).sort(), [ta.id, tb.id].sort());
  });

  test("an amended request that makes and updates nothing (nothing matched) cancels nothing", async () => {
    const { ctx, ta, tb, made } = lastTurn();
    const p = compiled(plan([
      { id: "s1", kind: "action" as const, action: "M03.A03", argsJson: JSON.stringify({ createdFrom: "2001-01-01", createdTo: "2001-01-02" }) },
      { id: "s2", kind: "op" as const, op: "forEach" as const, in: "$s1.items", whereJson: null, by: null, set: null, roundRobin: null, do: [{ action: "M06.A01", argsJson: JSON.stringify({ title: "Call back", relatedTo: { type: "lead", id: "$item.id" } }) }] },
    ] as SubmitPlan["steps"]));
    const r = await execute(p, registry, ctx, { executionId: "amend4b", revises: { made, message: "Only the leads from long ago" } });
    assert.equal(r.pending, undefined);
    assert.equal(r.cancelled, undefined);
    assert.equal(status(ctx, ta.id).status, "open");
    assert.equal(status(ctx, tb.id).status, "open");
  });

  test("without revises a repeat create makes a new record", async () => {
    const { ctx, a } = lastTurn();
    const baseTasks = ctx.store.all("tasks").length;
    const r = await execute(compiled(plan([task(a.id)])), registry, ctx, { executionId: "amend5" });
    assert.equal(r.status, "done");
    assert.equal(ctx.store.all("tasks").length, baseTasks + 1);
  });
});
