import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";
import type { Workflow, WorkflowStep } from "./schema.js";

const actionStep = (id: string, actionId: string | null = "M01.A04"): WorkflowStep => ({
  id,
  kind: "action",
  name: "Tag",
  actionId,
  args: {},
  waitMinutes: null,
  condition: null,
});

test("unknown input field is INVALID", async () => {
  const w = await testWorld();
  assert.equal(failure(() => w.call("M16.A01", { name: "Welcome", madeUp: 1 })).code, "INVALID");
});

test("write actions refuse a bad call", async () => {
  const w = await testWorld();
  const draft = w.f.workflow({ name: "Guard" });
  assert.equal(failure(() => w.call("M16.A01", { name: "Guard" })).code, "DUPLICATE");
  const live = w.f.workflow({ name: "Live", status: "published", publishedAt: w.f.now(), steps: [actionStep("step_a")] });
  assert.equal(failure(() => w.call("M16.A04", { workflowId: live.id, kind: "action", name: "Again", actionId: "M01.A04" })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M16.A05", { workflowId: live.id, stepId: "step_a", name: "Renamed" })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M16.A06", { workflowId: live.id, stepId: "step_a" })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M16.A08", { workflowId: live.id })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M16.A09", { workflowId: draft.id })).code, "CONFLICT");
});

test("publish needs a passing validation, and a published workflow stays locked until paused", async () => {
  const w = await testWorld();
  const empty = w.call("M16.A01", { name: "Empty" }) as Workflow;
  const checked = w.call("M16.A07", { workflowId: empty.id }) as { ok: boolean; errors: string[] };
  assert.equal(checked.ok, false);
  assert.match(checked.errors.join(" "), /at least one step/);
  assert.match(failure(() => w.call("M16.A08", { workflowId: empty.id })).message, /at least one step/);
  assert.equal(w.call("M16.A02", { workflowId: empty.id }).status, "draft");

  const bad = w.f.workflow({
    name: "Broken",
    steps: [
      actionStep("step_a", null),
      { id: "step_b", kind: "wait", name: "Wait", actionId: null, args: {}, waitMinutes: null, condition: null },
      { id: "step_c", kind: "condition", name: "Check", actionId: null, args: {}, waitMinutes: null, condition: null },
    ],
  });
  const errors = (w.call("M16.A07", { workflowId: bad.id }) as { errors: string[] }).errors.join(" ");
  assert.match(errors, /needs an actionId/);
  assert.match(errors, /waitMinutes/);
  assert.match(errors, /needs a condition/);
  assert.match(failure(() => w.call("M16.A08", { workflowId: bad.id })).message, /actionId/);

  let wf = w.call("M16.A01", { name: "Welcome" }) as Workflow;
  wf = w.call("M16.A04", { workflowId: wf.id, kind: "action", name: "Tag", actionId: "M01.A04" });
  wf = w.call("M16.A04", { workflowId: wf.id, kind: "wait", name: "Wait", waitMinutes: 5 });
  wf = w.call("M16.A04", { workflowId: wf.id, kind: "condition", name: "Is vip", condition: { field: "tag", equals: "vip" } });
  assert.equal((w.call("M16.A07", { workflowId: wf.id }) as { ok: boolean }).ok, true);
  wf = w.call("M16.A08", { workflowId: wf.id });
  assert.equal(wf.status, "published");
  assert.ok(wf.publishedAt);
  const locked = failure(() => w.call("M16.A04", { workflowId: wf.id, kind: "action", name: "Nope", actionId: "M01.A04" }));
  assert.equal(locked.code, "CONFLICT");
  assert.equal(locked.message, "Pause the workflow first");
  assert.equal(failure(() => w.call("M16.A06", { workflowId: wf.id, stepId: wf.steps[0]!.id })).message, "Pause the workflow first");
  wf = w.call("M16.A09", { workflowId: wf.id });
  assert.equal(wf.status, "paused");
  wf = w.call("M16.A05", { workflowId: wf.id, stepId: wf.steps[0]!.id, name: "Tag the contact" });
  wf = w.call("M16.A06", { workflowId: wf.id, stepId: wf.steps[2]!.id });
  assert.equal(wf.steps.length, 2);
  wf = w.call("M16.A08", { workflowId: wf.id });
  assert.equal(wf.status, "published");
  assert.equal(failure(() => w.call("M16.A09", { workflowId: wf.id }) && w.call("M16.A09", { workflowId: wf.id })).code, "CONFLICT");
});

test("a no-op step edit conflicts, lists sort by name, and history is newest first", async () => {
  const w = await testWorld();
  const wf = w.f.workflow({ name: "Zebra", steps: [actionStep("step_a")] });
  w.f.workflow({ name: "Alpha" });
  assert.equal(failure(() => w.call("M16.A05", { workflowId: wf.id, stepId: "step_a", name: "Tag" })).code, "CONFLICT");
  assert.match(failure(() => w.call("M16.A05", { workflowId: wf.id, stepId: "step_a", name: "Tag" })).message, /already has that value/);
  assert.equal(failure(() => w.call("M16.A05", { workflowId: wf.id, stepId: "missing", name: "X" })).code, "NOT_FOUND");
  const listed = w.call("M16.A03", {}) as { items: { name: string }[]; total: number };
  assert.deepEqual(listed.items.map((item) => item.name), ["Alpha", "Zebra"]);
  assert.equal(listed.total, 2);
  w.f.workflowRun({ workflowId: wf.id, startedAt: "2026-01-01T00:00:00.000Z" });
  w.f.workflowRun({ workflowId: wf.id, startedAt: "2026-06-01T00:00:00.000Z", status: "failed" });
  const runs = w.call("M16.A10", { workflowId: wf.id }) as { items: { startedAt: string; status: string }[]; total: number };
  assert.deepEqual(runs.items.map((run) => run.startedAt), ["2026-06-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"]);
  assert.equal(runs.total, 2);
  assert.equal((w.call("M16.A10", { workflowId: wf.id, status: "failed" }) as { total: number }).total, 1);
});

test("M16.A08 publishing starts messages going out, so it needs messaging.send", async () => {
  const w = await testWorld();
  const billing = w.f.user({ roles: ["billing"] });
  const marketing = w.f.user({ roles: ["marketing"] });
  const wf = w.f.workflow({ name: "Welcome", steps: [actionStep("step_a")] });

  assert.equal(failure(() => w.call("M16.A08", { workflowId: wf.id }, billing.id)).code, "PERMISSION");
  assert.equal(failure(() => w.call("M16.A08", { workflowId: wf.id }, "us_missing")).code, "PERMISSION");
  assert.equal(w.store.get<Workflow>("workflows", wf.id)?.status, "draft");

  assert.equal((w.call("M16.A08", { workflowId: wf.id }, marketing.id) as Workflow).status, "published");
});
