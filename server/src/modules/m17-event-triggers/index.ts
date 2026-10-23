import { tableResolver } from "../../registry/lookup.js";
import { z } from "zod";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import { contains, Limit, listOf, Name, page, requireState } from "../../registry/helpers.js";
import type { ModuleExports } from "../../registry/registry.js";
import type { Clock } from "../../store/clock.js";
import type { Fixtures } from "../../store/fixtures.js";
import type { Store } from "../../store/db.js";
import { Workflow } from "../m16-workflows/schema.js";
import { EVENT_TYPES, EventTrigger, TriggerCondition, TriggerFiring } from "./schema.js";

import "./fixtures.js";

// A trigger watches one event and, once bound to a published workflow, can be enabled. Testing it records
// a firing and evaluates conditions, but it never starts a workflow run.

const TriggerId = z.string().describe("event trigger id (trg_…)");
const ConditionInput = z.strictObject({
  field: z.string().min(1),
  op: z.enum(["eq", "neq", "contains"]),
  value: z.unknown(),
});

const iso = (clock: Clock) => clock.now().toISOString();

function byName(store: Store, name: string): EventTrigger | undefined {
  const key = name.trim().toLowerCase();
  return store.find<EventTrigger>("event_triggers", (t) => t.name.trim().toLowerCase() === key)[0];
}

function publishedWorkflow(f: Fixtures, name: string): Workflow {
  return f.make("workflows", "wf", Workflow, {
    name,
    description: null,
    status: "published",
    steps: [{ id: "step_a", kind: "action", name: "Tag the contact", actionId: "M01.A04", args: {}, waitMinutes: null, condition: null }],
    createdBy: "us_1",
    createdAt: f.now(),
    updatedAt: f.now(),
    publishedAt: f.now(),
  });
}

/** One dot reads a nested object. Anything deeper is treated as missing. */
function readField(payload: Record<string, unknown>, field: string): unknown {
  const dot = field.indexOf(".");
  if (dot === -1) return payload[field];
  if (field.indexOf(".", dot + 1) !== -1) return undefined;
  const parent = payload[field.slice(0, dot)];
  if (!parent || typeof parent !== "object" || Array.isArray(parent)) return undefined;
  return (parent as Record<string, unknown>)[field.slice(dot + 1)];
}

function sameValue(a: unknown, b: unknown): boolean {
  return a === b || (typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b));
}

function holds(cond: TriggerCondition, payload: Record<string, unknown>): boolean {
  const got = readField(payload, cond.field);
  if (cond.op === "eq") return sameValue(got, cond.value);
  if (cond.op === "neq") return !sameValue(got, cond.value);
  if (typeof got === "string" && typeof cond.value === "string") return contains(got, cond.value);
  if (Array.isArray(got)) return got.some((item) => sameValue(item, cond.value));
  return false;
}

const createTrigger = defineAction({
  id: "M17.A01",
  description: "Creates a new event trigger that listens for a chosen kind of event and starts automation. Use it to set up a trigger from scratch, not to change an existing one.",
  risk: "write",
  input: z.strictObject({ name: Name, eventType: z.enum(EVENT_TYPES) }),
  output: EventTrigger,
  siblings: ["M16.A01"],
  entities: { produces: "trigger" },
  example: () => ({ name: "Contact created", eventType: "contact.created" }),
  handler: (a, { store, clock, actorId }) => {
    const name = a.name;
    const existing = byName(store, name);
    if (existing) throw new ActionError("DUPLICATE", `A trigger named "${name}" already exists (${existing.id})`, { existingId: existing.id });
    const now = iso(clock);
    return store.insert("event_triggers", "trg", {
      name,
      eventType: a.eventType,
      conditions: [],
      workflowId: null,
      enabled: false,
      createdBy: actorId ?? "us_1",
      createdAt: now,
      updatedAt: now,
    });
  },
});

const getTrigger = defineAction({
  id: "M17.A02",
  description: "Shows the full setup of one trigger: its event type, conditions, linked workflow and whether it is on. Use it to inspect a single trigger.",
  risk: "read",
  input: z.strictObject({ triggerId: TriggerId }),
  output: EventTrigger,
  entities: { produces: "trigger", consumes: ["trigger"] },
  example: (f) => ({ triggerId: f.eventTrigger().id }),
  handler: ({ triggerId }, { store }) => mustGet<EventTrigger>(store, "event_triggers", triggerId, "event trigger"),
});

const listTriggers = defineAction({
  id: "M17.A03",
  description: "Lists all event triggers in the account with their basic status, so you can browse or find one. For one trigger's full setup, use Get trigger configuration.",
  risk: "read",
  input: z.strictObject({
    eventType: z.enum(EVENT_TYPES).optional(),
    enabled: z.boolean().optional(),
    query: z.string().optional().describe("part of the name"),
    limit: Limit,
  }),
  output: listOf(EventTrigger),
  entities: { produces: "trigger" },
  example: (f) => {
    f.eventTrigger({ name: "Signup watch" });
    return { query: "Signup" };
  },
  handler: (a, { store }) => {
    const items = store.find<EventTrigger>(
      "event_triggers",
      (t) => (a.eventType === undefined || t.eventType === a.eventType) && (a.enabled === undefined || t.enabled === a.enabled) && (!a.query || contains(t.name, a.query)),
    );
    items.sort((x, y) => x.name.localeCompare(y.name) || x.id.localeCompare(y.id));
    return page(items, a.limit);
  },
});

const setEventType = defineAction({
  id: "M17.A04",
  description: "Changes which kind of event a trigger reacts to, such as form submitted or appointment booked. Does not edit the filter conditions.",
  risk: "write",
  input: z.strictObject({ triggerId: TriggerId, eventType: z.enum(EVENT_TYPES) }),
  output: EventTrigger,
  entities: { produces: "trigger", consumes: ["trigger"] },
  example: (f) => ({ triggerId: f.eventTrigger().id, eventType: "lead.created" }),
  handler: ({ triggerId, eventType }, { store, clock }) => {
    const trigger = mustGet<EventTrigger>(store, "event_triggers", triggerId, "event trigger");
    if (trigger.eventType === eventType) throw new ActionError("CONFLICT", "The record already has that value");
    return store.update<EventTrigger>("event_triggers", trigger.id, { eventType, updatedAt: iso(clock) });
  },
});

const updateConditions = defineAction({
  id: "M17.A05",
  description: "Edits the conditions or filters a trigger checks before it fires, such as only for certain tags or sources. Does not change the event type.",
  risk: "write",
  input: z.strictObject({ triggerId: TriggerId, conditions: z.array(ConditionInput) }),
  output: EventTrigger,
  entities: { produces: "trigger", consumes: ["trigger"] },
  example: (f) => ({ triggerId: f.eventTrigger().id, conditions: [{ field: "source", op: "eq", value: "web" }] }),
  handler: ({ triggerId, conditions }, { store, clock }) => {
    const trigger = mustGet<EventTrigger>(store, "event_triggers", triggerId, "event trigger");
    if (JSON.stringify(trigger.conditions) === JSON.stringify(conditions)) throw new ActionError("CONFLICT", "The record already has that value");
    return store.update<EventTrigger>("event_triggers", trigger.id, { conditions, updatedAt: iso(clock) });
  },
});

const bindWorkflow = defineAction({
  id: "M17.A06",
  description: "Connects a trigger to a workflow so the workflow runs whenever the trigger fires. Use it to link or change the workflow a trigger starts.",
  risk: "write",
  input: z.strictObject({ triggerId: TriggerId, workflowId: z.string().describe("workflow id (wf_…)") }),
  output: EventTrigger,
  siblings: ["M16.A08"],
  entities: { produces: "trigger", consumes: ["trigger", "workflow"] },
  example: (f) => ({ triggerId: f.eventTrigger().id, workflowId: publishedWorkflow(f, "Bind target").id }),
  handler: ({ triggerId, workflowId }, { store, clock }) => {
    const trigger = mustGet<EventTrigger>(store, "event_triggers", triggerId, "event trigger");
    const wf = mustGet<Workflow>(store, "workflows", workflowId, "workflow");
    requireState(`Workflow "${wf.name}"`, wf.status, ["published"], "be bound to a trigger");
    if (trigger.workflowId === wf.id) throw new ActionError("CONFLICT", "The record already has that value");
    return store.update<EventTrigger>("event_triggers", trigger.id, { workflowId: wf.id, updatedAt: iso(clock) });
  },
});

const enableTrigger = defineAction({
  id: "M17.A07",
  description: "Turns a trigger on so it starts reacting to incoming events and launching its workflow. The opposite of Disable trigger.",
  risk: "write",
  input: z.strictObject({ triggerId: TriggerId }),
  output: EventTrigger,
  entities: { produces: "trigger", consumes: ["trigger"] },
  example: (f) => {
    const wf = publishedWorkflow(f, "Enable target");
    return { triggerId: f.eventTrigger({ workflowId: wf.id }).id };
  },
  handler: ({ triggerId }, { store, clock }) => {
    const trigger = mustGet<EventTrigger>(store, "event_triggers", triggerId, "event trigger");
    if (trigger.enabled) throw new ActionError("CONFLICT", "The record already has that value");
    if (!trigger.workflowId) throw new ActionError("CONFLICT", "Bind a published workflow first");
    const wf = mustGet<Workflow>(store, "workflows", trigger.workflowId, "workflow");
    requireState(`Workflow "${wf.name}"`, wf.status, ["published"], "have this trigger enabled");
    return store.update<EventTrigger>("event_triggers", trigger.id, { enabled: true, updatedAt: iso(clock) });
  },
});

const disableTrigger = defineAction({
  id: "M17.A08",
  description: "Turns a trigger off so it stops firing and starting workflows, without deleting it. The opposite of Enable trigger.",
  risk: "write",
  input: z.strictObject({ triggerId: TriggerId }),
  output: EventTrigger,
  entities: { produces: "trigger", consumes: ["trigger"] },
  example: (f) => ({ triggerId: f.eventTrigger({ enabled: true }).id }),
  handler: ({ triggerId }, { store, clock }) => {
    const trigger = mustGet<EventTrigger>(store, "event_triggers", triggerId, "event trigger");
    if (!trigger.enabled) throw new ActionError("CONFLICT", "The record already has that value");
    return store.update<EventTrigger>("event_triggers", trigger.id, { enabled: false, updatedAt: iso(clock) });
  },
});

const testTrigger = defineAction({
  id: "M17.A09",
  description: "Runs a trigger against a made-up sample event to check whether its conditions match and the workflow would start. Nothing real is affected.",
  risk: "write",
  input: z.strictObject({
    triggerId: TriggerId,
    payload: z.record(z.string(), z.unknown()),
    eventType: z.enum(EVENT_TYPES).optional().describe("defaults to the trigger's event"),
  }),
  output: TriggerFiring,
  entities: { produces: "event", consumes: ["trigger"] },
  example: (f) => {
    const trigger = f.eventTrigger({ conditions: [{ field: "source", op: "eq", value: "web" }] });
    return { triggerId: trigger.id, payload: { source: "web" } };
  },
  handler: (a, { store, clock }) => {
    const trigger = mustGet<EventTrigger>(store, "event_triggers", a.triggerId, "event trigger");
    const eventType = a.eventType ?? trigger.eventType;
    const matched = eventType === trigger.eventType && trigger.conditions.every((cond) => holds(cond, a.payload));
    // A test evaluates conditions and records the firing. It never inserts a workflow run.
    return store.insert("trigger_firings", "trf", {
      triggerId: trigger.id,
      eventType,
      payload: a.payload,
      matched,
      workflowRunId: null,
      test: true,
      at: iso(clock),
    });
  },
});

const firingHistory = defineAction({
  id: "M17.A10",
  description: "Shows the past record of when a trigger fired, with times and outcomes. Use it to see whether and why a trigger ran.",
  risk: "read",
  input: z.strictObject({
    triggerId: TriggerId,
    matched: z.boolean().optional(),
    test: z.boolean().optional(),
    limit: Limit,
  }),
  output: listOf(TriggerFiring),
  entities: { produces: "report", consumes: ["trigger"] },
  example: (f) => ({ triggerId: f.eventTrigger().id }),
  handler: (a, { store }) => {
    const trigger = mustGet<EventTrigger>(store, "event_triggers", a.triggerId, "event trigger");
    const items = store.find<TriggerFiring>(
      "trigger_firings",
      (row) => row.triggerId === trigger.id && (a.matched === undefined || row.matched === a.matched) && (a.test === undefined || row.test === a.test),
    );
    items.sort((x, y) => y.at.localeCompare(x.at) || x.id.localeCompare(y.id));
    return page(items, a.limit);
  },
});

export default {
  resolvers: {
    trigger: tableResolver("event_triggers"),
  },
  actions: [createTrigger, getTrigger, listTriggers, setEventType, updateConditions, bindWorkflow, enableTrigger, disableTrigger, testTrigger, firingHistory],
} satisfies ModuleExports;
