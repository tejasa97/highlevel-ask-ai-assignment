import { tableResolver } from "../../registry/lookup.js";
import { z } from "zod";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import { contains, freshId, Limit, listOf, page, requirePermission, requireState } from "../../registry/helpers.js";
import type { ModuleExports } from "../../registry/registry.js";
import type { Store } from "../../store/db.js";
import type { Clock } from "../../store/clock.js";
import type { EventTrigger } from "../m17-event-triggers/schema.js";
import { Workflow, WorkflowRun, WorkflowStep } from "./schema.js";

import "./fixtures.js";

// A workflow is an ordered list of action, wait, and condition steps. It can be edited while draft or
// paused. Publishing requires the same checks as validate, and a published workflow stays locked until paused.

const WorkflowId = z.string().describe("workflow id (wf_…)");
const StepId = z.string().describe("step id");
const ConditionInput = z.strictObject({ field: z.string().min(1), equals: z.unknown() });
const StepKind = z.enum(["action", "wait", "condition"]);

const iso = (clock: Clock) => clock.now().toISOString();

function byName(store: Store, name: string): Workflow | undefined {
  const key = name.trim().toLowerCase();
  return store.find<Workflow>("workflows", (wf) => wf.name.trim().toLowerCase() === key)[0];
}

/** Same rules publish uses. Empty workflows fail, and each step must carry the field its kind needs. */
export function workflowErrors(wf: Workflow): string[] {
  const errors: string[] = [];
  if (wf.steps.length === 0) errors.push("Add at least one step");
  for (const step of wf.steps) {
    if (step.kind === "action" && !step.actionId) errors.push(`Step "${step.name}" needs an actionId`);
    if (step.kind === "wait" && !(typeof step.waitMinutes === "number" && step.waitMinutes >= 1)) errors.push(`Step "${step.name}" needs waitMinutes of at least 1`);
    if (step.kind === "condition" && !step.condition) errors.push(`Step "${step.name}" needs a condition`);
  }
  return errors;
}

function editable(wf: Workflow): void {
  if (wf.status === "published") throw new ActionError("CONFLICT", "Pause the workflow first");
}

function stepOf(wf: Workflow, stepId: string): WorkflowStep {
  const step = wf.steps.find((s) => s.id === stepId);
  if (!step) throw new ActionError("NOT_FOUND", `No step with id ${stepId} on workflow ${wf.id}`, { id: stepId });
  return step;
}

function blankStep(id: string, kind: WorkflowStep["kind"], name: string): WorkflowStep {
  return { id, kind, name, actionId: null, args: {}, waitMinutes: null, condition: null };
}

const OWN_FIELDS: Record<WorkflowStep["kind"], string[]> = { action: ["actionId", "args"], wait: ["waitMinutes"], condition: ["condition"] };

/** A step only carries the settings of its own kind; anything else was a mistake, not something to drop quietly. */
function refuseForeignFields(kind: WorkflowStep["kind"], given: Record<string, unknown>): void {
  for (const key of ["actionId", "args", "waitMinutes", "condition"]) {
    if (given[key] !== undefined && !OWN_FIELDS[kind].includes(key)) {
      throw new ActionError("INVALID", `A${kind === "action" ? "n" : ""} ${kind} step has no ${key}; it only has ${OWN_FIELDS[kind].join(" and ")}`);
    }
  }
}

const createWorkflow = defineAction({
  id: "M16.A01",
  description: "Creates a new, empty automation workflow with a name so steps can be added afterward. Use it to start a new automation, not to edit an existing one.",
  risk: "write",
  input: z.strictObject({
    name: z.string().min(1),
    description: z.string().nullable().optional(),
  }),
  output: Workflow,
  siblings: ["M17.A01"],
  entities: { produces: "workflow" },
  example: () => ({ name: "Welcome sequence", description: "Tags a new contact, then waits" }),
  handler: (a, { store, clock, actorId }) => {
    const name = a.name.trim();
    if (!name) throw new ActionError("INVALID", "Name can't be blank");
    const existing = byName(store, name);
    if (existing) throw new ActionError("DUPLICATE", `A workflow named "${name}" already exists (${existing.id})`, { existingId: existing.id });
    const now = iso(clock);
    return store.insert("workflows", "wf", {
      name,
      description: a.description ?? null,
      status: "draft" as const,
      steps: [],
      createdBy: actorId ?? "us_1",
      createdAt: now,
      updatedAt: now,
      publishedAt: null,
    });
  },
});

const getWorkflow = defineAction({
  id: "M16.A02",
  description: "Shows the full definition of one workflow, including its steps, order and current status. Use it to inspect a single automation rather than list all.",
  risk: "read",
  input: z.strictObject({ workflowId: WorkflowId }),
  output: Workflow,
  entities: { produces: "workflow", consumes: ["workflow"] },
  example: (f) => ({ workflowId: f.workflow().id }),
  handler: ({ workflowId }, { store }) => mustGet<Workflow>(store, "workflows", workflowId, "workflow"),
});

const listWorkflows = defineAction({
  id: "M16.A03",
  description: "Lists the workflows in the account with their names and statuses, so you can browse or find an automation. Does not show steps of one workflow.",
  risk: "read",
  input: z.strictObject({
    status: z.enum(["draft", "published", "paused"]).optional(),
    query: z.string().optional().describe("part of the name or description"),
    limit: Limit,
  }),
  output: listOf(Workflow),
  entities: { produces: "workflow" },
  example: (f) => {
    f.workflow({ name: "Onboarding" });
    return { query: "Onboarding" };
  },
  handler: (a, { store }) => {
    const items = store.find<Workflow>(
      "workflows",
      (wf) => (!a.status || wf.status === a.status) && (!a.query || contains(wf.name, a.query) || contains(wf.description, a.query)),
    );
    items.sort((x, y) => x.name.localeCompare(y.name) || x.id.localeCompare(y.id));
    return page(items, a.limit);
  },
});

const addStep = defineAction({
  id: "M16.A04",
  description: "Adds a new step, such as an action, wait or condition, to a workflow. Use it to extend an automation, unlike editing or deleting an existing step.",
  risk: "write",
  input: z.strictObject({
    workflowId: WorkflowId,
    kind: StepKind,
    name: z.string().min(1),
    actionId: z.string().min(1).optional().describe("catalog action id, for an action step"),
    args: z.record(z.string(), z.unknown()).optional(),
    waitMinutes: z.number().int().min(1).optional(),
    condition: ConditionInput.optional(),
  }),
  output: Workflow,
  entities: { produces: "workflow", consumes: ["workflow"] },
  example: (f) => ({ workflowId: f.workflow().id, kind: "action", name: "Tag the contact", actionId: "M01.A04" }),
  handler: (a, { store, clock }) => {
    const wf = mustGet<Workflow>(store, "workflows", a.workflowId, "workflow");
    editable(wf);
    const name = a.name.trim();
    if (!name) throw new ActionError("INVALID", "Name can't be blank");
    refuseForeignFields(a.kind, a);
    const step = blankStep(freshId(store, "st", wf.steps.map((s) => s.id)), a.kind, name);
    if (a.kind === "action") {
      step.actionId = a.actionId ?? null;
      step.args = a.args ?? {};
    } else if (a.kind === "wait") {
      step.waitMinutes = a.waitMinutes ?? null;
    } else {
      step.condition = a.condition ?? null;
    }
    return store.update<Workflow>("workflows", wf.id, { steps: [...wf.steps, step], updatedAt: iso(clock) });
  },
});

const updateStep = defineAction({
  id: "M16.A05",
  description: "Changes the settings or content of an existing step in a workflow, such as its action, delay or condition. Does not add or delete steps.",
  risk: "write",
  input: z.strictObject({
    workflowId: WorkflowId,
    stepId: StepId,
    name: z.string().min(1).optional(),
    actionId: z.string().min(1).nullable().optional(),
    args: z.record(z.string(), z.unknown()).optional(),
    waitMinutes: z.number().int().min(1).nullable().optional(),
    condition: ConditionInput.nullable().optional(),
  }),
  output: Workflow,
  entities: { produces: "workflow", consumes: ["workflow"] },
  example: (f) => {
    const wf = f.workflow({
      steps: [{ id: "step_a", kind: "action", name: "Tag", actionId: "M01.A04", args: {}, waitMinutes: null, condition: null }],
    });
    return { workflowId: wf.id, stepId: "step_a", name: "Tag the contact" };
  },
  handler: (a, { store, clock }) => {
    atLeastStep(a);
    const wf = mustGet<Workflow>(store, "workflows", a.workflowId, "workflow");
    const current = stepOf(wf, a.stepId);
    editable(wf);
    const next: WorkflowStep = { ...current, args: { ...current.args }, condition: current.condition ? { ...current.condition } : null };
    if (a.name !== undefined) {
      const name = a.name.trim();
      if (!name) throw new ActionError("INVALID", "Name can't be blank");
      next.name = name;
    }
    refuseForeignFields(current.kind, a);
    if (a.actionId !== undefined) next.actionId = a.actionId;
    if (a.args !== undefined) next.args = a.args;
    if (a.waitMinutes !== undefined) next.waitMinutes = a.waitMinutes;
    if (a.condition !== undefined) next.condition = a.condition;
    if (JSON.stringify(next) === JSON.stringify(current)) throw new ActionError("CONFLICT", "The record already has that value");
    return store.update<Workflow>("workflows", wf.id, {
      steps: wf.steps.map((s) => (s.id === current.id ? next : s)),
      updatedAt: iso(clock),
    });
  },
});

function atLeastStep(a: { name?: string; actionId?: string | null; args?: unknown; waitMinutes?: number | null; condition?: unknown }): void {
  if (a.name === undefined && a.actionId === undefined && a.args === undefined && a.waitMinutes === undefined && a.condition === undefined) {
    throw new ActionError("INVALID", "Nothing to change: give at least one of name, actionId, args, waitMinutes, condition");
  }
}

const removeStep = defineAction({
  id: "M16.A06",
  description: "Deletes a single step from a workflow so it no longer runs. Use it to take out a step, not to pause or delete the whole workflow.",
  risk: "destructive",
  input: z.strictObject({ workflowId: WorkflowId, stepId: StepId }),
  output: Workflow,
  entities: { produces: "workflow", consumes: ["workflow"] },
  example: (f) => {
    const wf = f.workflow({
      steps: [{ id: "step_a", kind: "action", name: "Tag", actionId: "M01.A04", args: {}, waitMinutes: null, condition: null }],
    });
    return { workflowId: wf.id, stepId: "step_a" };
  },
  handler: ({ workflowId, stepId }, { store, clock }) => {
    const wf = mustGet<Workflow>(store, "workflows", workflowId, "workflow");
    stepOf(wf, stepId);
    editable(wf);
    return store.update<Workflow>("workflows", wf.id, { steps: wf.steps.filter((s) => s.id !== stepId), updatedAt: iso(clock) });
  },
});

const validateWorkflow = defineAction({
  id: "M16.A07",
  description: "Checks a workflow for errors such as missing settings or broken step order, without publishing it. Run it before going live.",
  risk: "read",
  input: z.strictObject({ workflowId: WorkflowId }),
  output: z.object({ ok: z.boolean(), errors: z.array(z.string()) }),
  entities: { consumes: ["workflow"] },
  example: (f) => ({
    workflowId: f.workflow({
      steps: [{ id: "step_a", kind: "action", name: "Tag", actionId: "M01.A04", args: {}, waitMinutes: null, condition: null }],
    }).id,
  }),
  handler: ({ workflowId }, { store }) => {
    const wf = mustGet<Workflow>(store, "workflows", workflowId, "workflow");
    const errors = workflowErrors(wf);
    return { ok: errors.length === 0, errors };
  },
});

const publishWorkflow = defineAction({
  id: "M16.A08",
  description: "Makes a workflow live so it starts running for contacts. Use it to activate a draft or resume after changes; the opposite of Pause workflow.",
  risk: "external",
  input: z.strictObject({ workflowId: WorkflowId }),
  output: Workflow,
  siblings: ["M17.A06"],
  entities: { produces: "workflow", consumes: ["workflow"] },
  example: (f) => ({
    workflowId: f.workflow({
      steps: [{ id: "step_a", kind: "action", name: "Tag", actionId: "M01.A04", args: {}, waitMinutes: null, condition: null }],
    }).id,
  }),
  handler: ({ workflowId }, { store, clock, actorId }) => {
    // A live workflow messages contacts on its own, so publishing is held to the same bar as sending.
    requirePermission(store, actorId, "messaging.send");
    const wf = mustGet<Workflow>(store, "workflows", workflowId, "workflow");
    requireState(`Workflow "${wf.name}"`, wf.status, ["draft", "paused"], "be published");
    const errors = workflowErrors(wf);
    if (errors.length) throw new ActionError("CONFLICT", `Fix the workflow before publishing: ${errors.join("; ")}`);
    const now = iso(clock);
    return store.update<Workflow>("workflows", wf.id, { status: "published", publishedAt: now, updatedAt: now });
  },
});

const pauseWorkflow = defineAction({
  id: "M16.A09",
  description: "Temporarily stops a live workflow from running without deleting it or its steps. Differs from Publish, which turns it on.",
  risk: "write",
  input: z.strictObject({ workflowId: WorkflowId }),
  output: Workflow,
  entities: { produces: "workflow", consumes: ["workflow"] },
  example: (f) => ({
    workflowId: f.workflow({
      status: "published",
      publishedAt: f.now(),
      steps: [{ id: "step_a", kind: "action", name: "Tag", actionId: "M01.A04", args: {}, waitMinutes: null, condition: null }],
    }).id,
  }),
  handler: ({ workflowId }, { store, clock }) => {
    const wf = mustGet<Workflow>(store, "workflows", workflowId, "workflow");
    requireState(`Workflow "${wf.name}"`, wf.status, ["published"], "be paused");
    const live = store.find<EventTrigger>("event_triggers", (t) => t.enabled && t.workflowId === wf.id)[0];
    if (live) throw new ActionError("CONFLICT", `Trigger "${live.name}" is enabled and starts this workflow; disable it (M17.A08) before pausing`);
    return store.update<Workflow>("workflows", wf.id, { status: "paused", updatedAt: iso(clock) });
  },
});

const history = defineAction({
  id: "M16.A10",
  description: "Shows the past runs of a workflow, including which contacts went through it and whether steps succeeded or failed. Useful for troubleshooting.",
  risk: "read",
  input: z.strictObject({
    workflowId: WorkflowId,
    status: z.enum(["running", "completed", "failed"]).optional(),
    limit: Limit,
  }),
  output: listOf(WorkflowRun),
  entities: { produces: "workflow", consumes: ["workflow"] },
  example: (f) => ({ workflowId: f.workflow().id }),
  handler: (a, { store }) => {
    const wf = mustGet<Workflow>(store, "workflows", a.workflowId, "workflow");
    const items = store.find<WorkflowRun>("workflow_runs", (run) => run.workflowId === wf.id && (!a.status || run.status === a.status));
    items.sort((x, y) => y.startedAt.localeCompare(x.startedAt) || x.id.localeCompare(y.id));
    return page(items, a.limit);
  },
});

export default {
  resolvers: {
    workflow: tableResolver("workflows"),
  },
  actions: [createWorkflow, getWorkflow, listWorkflows, addStep, updateStep, removeStep, validateWorkflow, publishWorkflow, pauseWorkflow, history],
} satisfies ModuleExports;
