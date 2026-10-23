import assert from "node:assert/strict";
import { test } from "node:test";
import { Workflow } from "../m16-workflows/schema.js";
import { failure, testWorld } from "../../testkit.js";
import type { EventTrigger, TriggerFiring } from "./schema.js";

type World = Awaited<ReturnType<typeof testWorld>>;

function workflow(w: World, name: string, status: "draft" | "published" | "paused") {
  return w.f.make("workflows", "wf", Workflow, {
    name,
    description: null,
    status,
    steps: [{ id: "step_a", kind: "action", name: "Tag", actionId: "M01.A04", args: {}, waitMinutes: null, condition: null }],
    createdBy: "us_1",
    createdAt: w.f.now(),
    updatedAt: w.f.now(),
    publishedAt: status === "draft" ? null : w.f.now(),
  });
}

async function guardedTrigger() {
  const w = await testWorld();
  const trigger = w.f.eventTrigger({ name: "Guard", conditions: [{ field: "source", op: "eq", value: "web" }] });
  return { w, trigger };
}

async function unboundTrigger() {
  const w = await testWorld();
  const trigger = w.call("M17.A01", { name: "On create", eventType: "contact.created" }) as EventTrigger;
  return { w, trigger };
}

// An enabled trigger on a published workflow that wants a web contact, a "demo" note and a status other than lost.
async function sampleTrigger() {
  const w = await testWorld();
  const live = workflow(w, "Runnable", "published");
  const trigger = w.f.eventTrigger({
    name: "Sample",
    eventType: "contact.created",
    workflowId: live.id,
    enabled: true,
    conditions: [
      { field: "contact.source", op: "eq", value: "web" },
      { field: "note", op: "contains", value: "demo" },
      { field: "status", op: "neq", value: "lost" },
    ],
  });
  const fire = (payload: Record<string, unknown>, eventType?: string) =>
    w.call("M17.A09", { triggerId: trigger.id, payload, ...(eventType ? { eventType } : {}) }) as TriggerFiring;
  const matching = { contact: { source: "web" }, note: "Book a demo", status: "open" };
  const missing = { contact: { source: "web" }, note: "hello", status: "open" };
  return { w, trigger, fire, matching, missing };
}

test("M17.A01 unknown input field is INVALID", async () => {
  const w = await testWorld();
  assert.equal(failure(() => w.call("M17.A01", { name: "Watch", eventType: "contact.created", madeUp: 1 })).code, "INVALID");
});

test("M17.A01 create refuses a duplicate name", async () => {
  const { w } = await guardedTrigger();
  assert.equal(failure(() => w.call("M17.A01", { name: "Guard", eventType: "lead.created" })).code, "DUPLICATE");
});

test("M17.A04 event type refuses a no-op", async () => {
  const { w, trigger } = await guardedTrigger();
  assert.equal(failure(() => w.call("M17.A04", { triggerId: trigger.id, eventType: "contact.created" })).code, "CONFLICT");
});

test("M17.A05 conditions refuse a no-op", async () => {
  const { w, trigger } = await guardedTrigger();
  assert.equal(failure(() => w.call("M17.A05", { triggerId: trigger.id, conditions: [{ field: "source", op: "eq", value: "web" }] })).code, "CONFLICT");
});

test("M17.A06 bind refuses a draft workflow", async () => {
  const { w, trigger } = await guardedTrigger();
  const draft = workflow(w, "Draft flow", "draft");
  assert.equal(failure(() => w.call("M17.A06", { triggerId: trigger.id, workflowId: draft.id })).code, "CONFLICT");
});

test("M17.A07 enable refuses a trigger with no workflow", async () => {
  const { w, trigger } = await guardedTrigger();
  assert.equal(failure(() => w.call("M17.A07", { triggerId: trigger.id })).code, "CONFLICT");
});

test("M17.A08 disable refuses a trigger that is not enabled", async () => {
  const { w, trigger } = await guardedTrigger();
  assert.equal(failure(() => w.call("M17.A08", { triggerId: trigger.id })).code, "CONFLICT");
});

test("M17.A09 a test firing of an unknown trigger is NOT_FOUND", async () => {
  const w = await testWorld();
  assert.equal(failure(() => w.call("M17.A09", { triggerId: "trg_99999", payload: {} })).code, "NOT_FOUND");
});

test("M17.A06 bind needs a published workflow that exists", async () => {
  const { w, trigger } = await unboundTrigger();
  const paused = workflow(w, "Paused flow", "paused");
  assert.match(failure(() => w.call("M17.A06", { triggerId: trigger.id, workflowId: paused.id })).message, /published/);
  assert.equal(failure(() => w.call("M17.A06", { triggerId: trigger.id, workflowId: "wf_99999" })).code, "NOT_FOUND");
});

test("M17.A06 bind to a published workflow, once", async () => {
  const { w, trigger } = await unboundTrigger();
  const live = workflow(w, "Live flow", "published");
  const bound = w.call("M17.A06", { triggerId: trigger.id, workflowId: live.id }) as EventTrigger;
  assert.equal(bound.workflowId, live.id);
  assert.equal(failure(() => w.call("M17.A06", { triggerId: trigger.id, workflowId: live.id })).code, "CONFLICT");
});

test("M17.A07 enable a bound trigger, once", async () => {
  const { w, trigger } = await unboundTrigger();
  const live = workflow(w, "Live flow", "published");
  w.call("M17.A06", { triggerId: trigger.id, workflowId: live.id });
  const enabled = w.call("M17.A07", { triggerId: trigger.id }) as EventTrigger;
  assert.equal(enabled.enabled, true);
  assert.equal(failure(() => w.call("M17.A07", { triggerId: trigger.id })).code, "CONFLICT");
});

test("M17.A07 enable refuses once the bound workflow is no longer published", async () => {
  const { w, trigger } = await unboundTrigger();
  const live = workflow(w, "Live flow", "published");
  w.call("M17.A06", { triggerId: trigger.id, workflowId: live.id });
  w.call("M17.A07", { triggerId: trigger.id });
  w.call("M17.A08", { triggerId: trigger.id });
  const rebound = workflow(w, "Other live", "published");
  w.call("M17.A06", { triggerId: trigger.id, workflowId: rebound.id });
  w.store.update("workflows", rebound.id, { status: "paused" });
  assert.equal(failure(() => w.call("M17.A07", { triggerId: trigger.id })).code, "CONFLICT");
  assert.match(failure(() => w.call("M17.A07", { triggerId: trigger.id })).message, /published/);
});

test("M17.A09 a test firing that meets every condition matches and starts nothing", async () => {
  const { fire, matching } = await sampleTrigger();
  const match = fire(matching);
  assert.equal(match.test, true);
  assert.equal(match.matched, true);
  assert.equal(match.workflowRunId, null);
});

test("M17.A09 a test firing that misses a condition does not match", async () => {
  const { fire, missing } = await sampleTrigger();
  const missed = fire(missing);
  assert.equal(missed.matched, false);
  assert.equal(missed.workflowRunId, null);
});

test("M17.A09 a test firing for another event type does not match", async () => {
  const { fire, matching } = await sampleTrigger();
  const wrongEvent = fire(matching, "lead.created");
  assert.equal(wrongEvent.matched, false);
  assert.equal(wrongEvent.eventType, "lead.created");
});

test("M17.A09 test firings never start a workflow run", async () => {
  const { w, fire, matching, missing } = await sampleTrigger();
  const before = w.store.all("workflow_runs").length;
  fire(matching);
  fire(missing);
  fire(matching, "lead.created");
  assert.equal(w.store.all("workflow_runs").length, before);
});

test("M17.A10 history lists every test firing", async () => {
  const { w, trigger, fire, matching, missing } = await sampleTrigger();
  const match = fire(matching);
  const missed = fire(missing);
  const wrongEvent = fire(matching, "lead.created");
  const history = w.call("M17.A10", { triggerId: trigger.id }) as { items: { id: string }[]; total: number };
  assert.equal(history.total, 3);
  assert.deepEqual(history.items.map((item) => item.id), [match.id, missed.id, wrongEvent.id]);
});

test("M17.A03 list filters by event type", async () => {
  const { w, trigger } = await sampleTrigger();
  const listed = w.call("M17.A03", { eventType: "contact.created" }) as { items: { id: string }[] };
  assert.ok(listed.items.some((item) => item.id === trigger.id));
});
