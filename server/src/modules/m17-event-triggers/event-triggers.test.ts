import assert from "node:assert/strict";
import { test } from "node:test";
import { Workflow } from "../m16-workflows/schema.js";
import { failure, testWorld } from "../../testkit.js";
import type { EventTrigger, TriggerFiring } from "./schema.js";

function workflow(w: Awaited<ReturnType<typeof testWorld>>, name: string, status: "draft" | "published" | "paused") {
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

test("unknown input field is INVALID", async () => {
  const w = await testWorld();
  assert.equal(failure(() => w.call("M17.A01", { name: "Watch", eventType: "contact.created", madeUp: 1 })).code, "INVALID");
});

test("write actions refuse a bad call", async () => {
  const w = await testWorld();
  const trigger = w.f.eventTrigger({ name: "Guard", conditions: [{ field: "source", op: "eq", value: "web" }] });
  const draft = workflow(w, "Draft flow", "draft");
  assert.equal(failure(() => w.call("M17.A01", { name: "Guard", eventType: "lead.created" })).code, "DUPLICATE");
  assert.equal(failure(() => w.call("M17.A04", { triggerId: trigger.id, eventType: "contact.created" })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M17.A05", { triggerId: trigger.id, conditions: [{ field: "source", op: "eq", value: "web" }] })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M17.A06", { triggerId: trigger.id, workflowId: draft.id })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M17.A07", { triggerId: trigger.id })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M17.A08", { triggerId: trigger.id })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M17.A09", { triggerId: "trg_99999", payload: {} })).code, "NOT_FOUND");
});

test("bind and enable require a published workflow", async () => {
  const w = await testWorld();
  const trigger = w.call("M17.A01", { name: "On create", eventType: "contact.created" }) as EventTrigger;
  const paused = workflow(w, "Paused flow", "paused");
  assert.match(failure(() => w.call("M17.A06", { triggerId: trigger.id, workflowId: paused.id })).message, /published/);
  assert.equal(failure(() => w.call("M17.A06", { triggerId: trigger.id, workflowId: "wf_99999" })).code, "NOT_FOUND");
  const live = workflow(w, "Live flow", "published");
  const bound = w.call("M17.A06", { triggerId: trigger.id, workflowId: live.id }) as EventTrigger;
  assert.equal(bound.workflowId, live.id);
  assert.equal(failure(() => w.call("M17.A06", { triggerId: trigger.id, workflowId: live.id })).code, "CONFLICT");
  const enabled = w.call("M17.A07", { triggerId: trigger.id }) as EventTrigger;
  assert.equal(enabled.enabled, true);
  assert.equal(failure(() => w.call("M17.A07", { triggerId: trigger.id })).code, "CONFLICT");
  w.call("M17.A08", { triggerId: trigger.id });
  const rebound = workflow(w, "Other live", "published");
  w.call("M17.A06", { triggerId: trigger.id, workflowId: rebound.id });
  w.store.update("workflows", rebound.id, { status: "paused" });
  assert.equal(failure(() => w.call("M17.A07", { triggerId: trigger.id })).code, "CONFLICT");
  assert.match(failure(() => w.call("M17.A07", { triggerId: trigger.id })).message, /published/);
});

test("a test firing evaluates conditions and never starts a workflow run", async () => {
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
  const before = w.store.all("workflow_runs").length;
  const match = w.call("M17.A09", {
    triggerId: trigger.id,
    payload: { contact: { source: "web" }, note: "Book a demo", status: "open" },
  }) as TriggerFiring;
  assert.equal(match.test, true);
  assert.equal(match.matched, true);
  assert.equal(match.workflowRunId, null);
  const missed = w.call("M17.A09", {
    triggerId: trigger.id,
    payload: { contact: { source: "web" }, note: "hello", status: "open" },
  }) as TriggerFiring;
  assert.equal(missed.matched, false);
  assert.equal(missed.workflowRunId, null);
  const wrongEvent = w.call("M17.A09", {
    triggerId: trigger.id,
    eventType: "lead.created",
    payload: { contact: { source: "web" }, note: "Book a demo", status: "open" },
  }) as TriggerFiring;
  assert.equal(wrongEvent.matched, false);
  assert.equal(wrongEvent.eventType, "lead.created");
  assert.equal(w.store.all("workflow_runs").length, before);
  const history = w.call("M17.A10", { triggerId: trigger.id }) as { items: { id: string }[]; total: number };
  assert.equal(history.total, 3);
  assert.deepEqual(history.items.map((item) => item.id), [match.id, missed.id, wrongEvent.id]);
  const listed = w.call("M17.A03", { eventType: "contact.created" }) as { items: { id: string }[] };
  assert.ok(listed.items.some((item) => item.id === trigger.id));
});
