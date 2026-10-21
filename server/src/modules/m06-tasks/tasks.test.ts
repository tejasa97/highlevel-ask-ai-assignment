import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";

test("create: past due date INVALID; missing related record NOT_FOUND; inactive assignee CONFLICT", async () => {
  const w = await testWorld();
  assert.equal(failure(() => w.call("M06.A01", { title: "T", dueDate: w.f.day(-1) })).code, "INVALID");
  assert.equal(failure(() => w.call("M06.A01", { title: "T", relatedTo: { type: "lead", id: "ld_99999" } })).code, "NOT_FOUND");
  assert.equal(failure(() => w.call("M06.A01", { title: "T", assigneeId: "us_9" })).code, "CONFLICT");
  const t = w.call("M06.A01", { title: "T", dueDate: w.f.today });
  assert.deepEqual([t.status, t.priority, t.assigneeId, t.createdBy], ["open", "normal", null, "us_1"]);
  assert.equal(w.call("M06.A01", { title: "U" }, "us_4").createdBy, "us_4");
});

test("only open tasks can be completed, rescheduled, reprioritised or cancelled", async () => {
  const w = await testWorld();
  const t = w.f.task();
  w.call("M06.A08", { taskId: t.id });
  for (const [id, args] of [
    ["M06.A08", { taskId: t.id }],
    ["M06.A06", { taskId: t.id, dueDate: w.f.day(3) }],
    ["M06.A07", { taskId: t.id, priority: "low" }],
    ["M06.A10", { taskId: t.id }],
  ] as const) {
    assert.equal(failure(() => w.call(id, args)).code, "CONFLICT", id);
  }
});

test("reopen: completed or cancelled only, clears the close fields, optional new due date", async () => {
  const w = await testWorld();
  assert.equal(failure(() => w.call("M06.A09", { taskId: w.f.task().id })).code, "CONFLICT");
  const t = w.f.task({ dueDate: w.f.day(-3) });
  w.call("M06.A10", { taskId: t.id, reason: "dup" });
  assert.equal(failure(() => w.call("M06.A09", { taskId: t.id, dueDate: w.f.day(-1) })).code, "INVALID");
  const r = w.call("M06.A09", { taskId: t.id, dueDate: w.f.day(2) });
  assert.deepEqual([r.status, r.cancelReason, r.completedAt, r.dueDate], ["open", null, null, w.f.day(2)]);
});

test("assign: same assignee CONFLICT; deactivated user refused", async () => {
  const w = await testWorld();
  const t = w.f.task({ assigneeId: "us_4" });
  assert.equal(failure(() => w.call("M06.A05", { taskId: t.id, assigneeId: "us_4" })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M06.A05", { taskId: t.id, assigneeId: "us_9" })).code, "CONFLICT");
});

test("search: overdue means open and past due, sorted by due date; Lucia has one", async () => {
  const w = await testWorld();
  const late = w.f.task({ assigneeId: "us_6", dueDate: w.f.day(-5) });
  const later = w.f.task({ assigneeId: "us_6", dueDate: w.f.day(-1) });
  w.f.task({ assigneeId: "us_6", dueDate: w.f.day(-9), status: "completed" });
  w.f.task({ assigneeId: "us_6", dueDate: w.f.day(1) });
  const ids = w.call("M06.A03", { assigneeId: "us_6", overdue: true }).items.map((t: { id: string }) => t.id);
  assert.deepEqual(ids, [late.id, later.id]);
  const lucia = w.call("M06.A03", { assigneeId: "us_3", overdue: true }).items as { priority: string }[];
  assert.ok(lucia.some((t) => t.priority === "high"));
  assert.equal(w.call("M06.A02", { taskId: late.id }).overdue, true);
});

test("update description: needs a change", async () => {
  const w = await testWorld();
  assert.equal(failure(() => w.call("M06.A04", { taskId: w.f.task().id })).code, "INVALID");
});

test("a fault with one use fires once, rolls nothing in, then the call succeeds", async () => {
  const w = await testWorld();
  const t = w.f.task();
  w.store.addFault({ action: "M06.A08", match: { taskId: t.id }, code: "TIMEOUT", message: "Upstream timed out", remaining: 1 });
  assert.equal(w.call("M06.A08", { taskId: w.f.task().id }).status, "completed", "other args don't match");
  assert.equal(failure(() => w.call("M06.A08", { taskId: t.id })).code, "TIMEOUT");
  assert.equal(w.store.get<{ status: string }>("tasks", t.id)!.status, "open");
  assert.equal(w.call("M06.A08", { taskId: t.id }).status, "completed");
});
