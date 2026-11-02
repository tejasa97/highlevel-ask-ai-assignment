import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import type { SubmitPlan } from "../planner/submit-plan.js";
import { editsMade } from "../planner/turn.js";
import { loadRegistry, type Registry } from "../registry/registry.js";
import { world } from "../store/world.js";
import { compile, type CompiledPlan } from "./compile.js";
import { execute } from "./execute.js";
import { leftOut, madeBy, revisable, reviser, undoPlan } from "./revise.js";

let registry: Registry;
before(async () => {
  registry = await loadRegistry();
});

const task = (id: string, lead: string, dueDate: string) => ({
  id,
  kind: "action" as const,
  action: "M06.A01",
  argsJson: JSON.stringify({ title: `Follow up ${lead}`, dueDate, relatedTo: { type: "lead", id: lead } }),
});
function compiled(steps: SubmitPlan["steps"]): CompiledPlan {
  const r = compile({ type: "plan", steps, question: null, options: null, reason: null, alternatives: null, query: null, text: null }, registry);
  if (!r.ok) assert.fail(r.errors.join("\n"));
  return r.plan;
}
type Task = { id: string; status: string; dueDate: string; relatedTo: { id: string } };

describe("revising what the last turn made", () => {
  test("keeps and edits the records that still fit, makes the new one, and undoes the rest", async () => {
    const ctx = world();
    const first = compiled([task("s1", "ld_41", "2026-10-21"), task("s2", "ld_42", "2026-10-21")]);
    const made = madeBy(first, await execute(first, registry, ctx, { executionId: "t1" }), registry);
    assert.deepEqual(made.map((m) => (m.record as Task).relatedTo.id), ["ld_41", "ld_42"]);

    const next = compiled([task("s1", "ld_41", "2026-10-22"), task("s2", "ld_43", "2026-10-22")]);
    assert.ok(revisable(next, made));
    const before = ctx.store.all("tasks").length;
    const result = await execute(next, registry, { ...ctx, revise: reviser(made, registry) }, { executionId: "t2" });
    assert.equal(result.status, "done");
    assert.equal(ctx.store.all("tasks").length, before + 1, "only ld_43's task is new");
    assert.equal(ctx.store.get<Task>("tasks", made[0]!.id)!.dueDate, "2026-10-22", "ld_41's task was edited in place");

    const left = leftOut(made, next, result, registry);
    assert.deepEqual(left.map((m) => m.id), [made[1]!.id]);
    const undo = undoPlan(left, registry)!;
    const paused = await execute(undo, registry, ctx, { executionId: "t2_undo" });
    const done = paused.pending ? await execute(undo, registry, ctx, { executionId: "t2_undo", approvals: [paused.pending] }) : paused;
    assert.equal(done.status, "done");
    assert.notEqual(ctx.store.get<Task>("tasks", made[1]!.id)!.status, "open", "ld_42's task is cancelled");
  });

  test("the planner's own cancel of a made record is left to the reconcile", async () => {
    const ctx = world();
    const first = compiled([task("s1", "ld_41", "2026-10-21")]);
    const made = madeBy(first, await execute(first, registry, ctx, { executionId: "t1" }), registry);
    const cancel = compiled([{ id: "s1", kind: "action", action: "M06.A10", argsJson: JSON.stringify({ taskId: made[0]!.id }) }]);
    const run = await execute(cancel, registry, { ...ctx, revise: reviser(made, registry) }, { executionId: "t2" });
    const done = run.pending ? await execute(cancel, registry, { ...ctx, revise: reviser(made, registry) }, { executionId: "t2", approvals: [run.pending] }) : run;
    assert.equal(done.status, "done");
    assert.equal(ctx.store.get<Task>("tasks", made[0]!.id)!.status, "open");
  });

  test("a plan that only edits the made records is sent back once", async () => {
    const ctx = world();
    const first = compiled([task("s1", "ld_41", "2026-10-21")]);
    const made = madeBy(first, await execute(first, registry, ctx, { executionId: "t1" }), registry);
    const edit = compiled([{ id: "s1", kind: "action", action: "M06.A06", argsJson: JSON.stringify({ taskId: made[0]!.id, dueDate: "2026-10-22" }) }]);
    assert.equal(editsMade(edit, { made, message: "only the Facebook ones, due tomorrow" }).length, 1);
    assert.deepEqual(editsMade(edit, { made, message: "also add one for Tom" }), []);
    assert.deepEqual(editsMade(edit, { made: [], message: "only the Facebook ones" }), []);
  });
});

describe("revise specs in the registry", () => {
  test("edit and undo actions exist and take the made record's id", () => {
    for (const a of registry.list()) {
      if (!a.revise) continue;
      const entity = a.entities!.produces!;
      for (const id of [...Object.values(a.revise.edits), a.revise.undo]) {
        const e = registry.get(id);
        assert.ok(e, `${a.id} names ${id}`);
        assert.ok(e!.entities?.consumes?.includes(entity), `${id} consumes ${entity}`);
        assert.ok(`${entity}Id` in ((e!.input as { shape?: object }).shape ?? {}), `${id} takes ${entity}Id`);
      }
    }
  });
});
