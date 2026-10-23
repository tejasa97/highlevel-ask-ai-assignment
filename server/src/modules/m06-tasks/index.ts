import { z } from "zod";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import { activeUser, candidates, contains, Limit, listOf, notPast, page, requireState } from "../../registry/helpers.js";
import type { ModuleExports } from "../../registry/registry.js";
import { localDate } from "../../store/clock.js";
import type { Store } from "../../store/db.js";
import { PRIORITIES, RELATED_TABLES, RELATED_TYPES, Related, Task } from "./schema.js";

export { Task } from "./schema.js";

// To-dos for staff users, optionally about a contact, lead or opportunity.

const TaskId = z.string().describe("task id (tk_…)");

function openTask(store: Store, id: string, doing: string): Task {
  const t = mustGet<Task>(store, "tasks", id, "task");
  requireState(`Task "${t.title}"`, t.status, ["open"], doing);
  return t;
}

const createTask = defineAction({
  id: "M06.A01",
  description:
    "Create a to-do for a staff user, optionally about a contact, lead or opportunity. Leave dueDate out unless the user gave one; it can't be in the past.",
  risk: "write",
  input: z.strictObject({
    title: z.string().min(1),
    description: z.string().optional(),
    assigneeId: z.string().optional().describe("user id"),
    dueDate: z.iso.date().optional(),
    priority: z.enum(PRIORITIES).optional().describe("default normal"),
    relatedTo: z.strictObject(Related.shape).optional(),
  }),
  output: Task,
  entities: { produces: "task", optionalConsumes: ["user", "contact", "lead", "opportunity"] },
  example: () => ({ title: "Call back about pricing", assigneeId: "us_4", dueDate: "2026-10-23", relatedTo: { type: "contact", id: "ct_1" } }),
  handler: (a, { store, clock, actorId }) => {
    if (a.assigneeId) activeUser(store, a.assigneeId, "be assigned tasks");
    if (a.dueDate) notPast(a.dueDate, localDate(clock.now()), "Due date");
    if (a.relatedTo) mustGet(store, RELATED_TABLES[a.relatedTo.type], a.relatedTo.id, a.relatedTo.type);
    return store.insert("tasks", "tk", {
      title: a.title,
      description: a.description ?? null,
      assigneeId: a.assigneeId ?? null,
      dueDate: a.dueDate ?? null,
      priority: a.priority ?? "normal",
      status: "open" as const,
      relatedTo: a.relatedTo ?? null,
      createdBy: actorId ?? "us_1",
      createdAt: clock.now().toISOString(),
      completedAt: null,
      cancelReason: null,
    });
  },
});

const getTask = defineAction({
  id: "M06.A02",
  description: "Get one task's details: assignee, due date, priority, status and what it's about.",
  risk: "read",
  input: z.strictObject({ taskId: TaskId }),
  output: Task.extend({ overdue: z.boolean() }),
  entities: { consumes: ["task"] },
  example: () => ({ taskId: "tk_1" }),
  handler: ({ taskId }, { store, clock }) => {
    const t = mustGet<Task>(store, "tasks", taskId, "task");
    return { ...t, overdue: t.status === "open" && t.dueDate !== null && t.dueDate < localDate(clock.now()) };
  },
});

const searchTasks = defineAction({
  id: "M06.A03",
  description:
    "Find tasks by assignee, status, priority, due date range, overdue, linked record or title text. Dates are inclusive. Without status, returns open tasks.",
  risk: "read",
  input: z.strictObject({
    assigneeId: z.string().optional(),
    unassigned: z.boolean().optional().describe("true = only tasks with no assignee"),
    status: z.enum(["open", "completed", "cancelled"]).optional().describe("default open"),
    priority: z.enum(PRIORITIES).optional(),
    dueFrom: z.iso.date().optional(),
    dueTo: z.iso.date().optional(),
    overdue: z.boolean().optional().describe("true = open and past due"),
    relatedType: z.enum(RELATED_TYPES).optional(),
    relatedId: z.string().optional().describe("contact, lead or opportunity id"),
    query: z.string().optional().describe("part of the title or description"),
    limit: Limit,
  }),
  output: listOf(Task),
  entities: { produces: "task" },
  example: () => ({ assigneeId: "us_3", overdue: true }),
  handler: (a, { store, clock }) => {
    const today = localDate(clock.now());
    const items = store.find<Task>(
      "tasks",
      (t) =>
        t.status === (a.overdue ? "open" : (a.status ?? "open")) &&
        (!a.assigneeId || t.assigneeId === a.assigneeId) &&
        (a.unassigned === undefined || (t.assigneeId === null) === a.unassigned) &&
        (!a.priority || t.priority === a.priority) &&
        (!a.dueFrom || (t.dueDate !== null && t.dueDate >= a.dueFrom)) &&
        (!a.dueTo || (t.dueDate !== null && t.dueDate <= a.dueTo)) &&
        (a.overdue === undefined || (t.dueDate !== null && t.dueDate < today) === a.overdue) &&
        (!a.relatedType || t.relatedTo?.type === a.relatedType) &&
        (!a.relatedId || t.relatedTo?.id === a.relatedId) &&
        (!a.query || contains(t.title, a.query) || contains(t.description, a.query)),
    );
    items.sort((x, y) => (x.dueDate ?? "9999").localeCompare(y.dueDate ?? "9999"));
    return page(items, a.limit);
  },
});

const updateDescription = defineAction({
  id: "M06.A04",
  description: "Rewrite an open task's title and/or description.",
  risk: "write",
  input: z.strictObject({ taskId: TaskId, title: z.string().min(1).optional(), description: z.string().optional() }),
  output: Task,
  entities: { consumes: ["task"] },
  example: () => ({ taskId: "tk_1", description: "Ask about the renewal date too" }),
  handler: ({ taskId, title, description }, { store }) => {
    if (title === undefined && description === undefined) throw new ActionError("INVALID", "Nothing to change: give title or description");
    const t = openTask(store, taskId, "edit it");
    return store.update<Task>("tasks", t.id, { ...(title ? { title } : {}), ...(description !== undefined ? { description } : {}) });
  },
});

const assignTask = defineAction({
  id: "M06.A05",
  description: "Give an open task to a staff user (or take it from whoever has it).",
  synonyms: ["reassign tasks", "cover a colleague's tasks", "transfer workload", "handoff open work"],
  risk: "write",
  input: z.strictObject({ taskId: TaskId, assigneeId: z.string().describe("user id") }),
  output: Task,
  entities: { consumes: ["task", "user"] },
  example: (f) => ({ taskId: f.task().id, assigneeId: "us_5" }),
  handler: ({ taskId, assigneeId }, { store }) => {
    const t = openTask(store, taskId, "reassign it");
    const u = activeUser(store, assigneeId, "be assigned tasks");
    if (t.assigneeId === assigneeId) throw new ActionError("CONFLICT", `Task "${t.title}" is already assigned to ${u.name}`);
    return store.update<Task>("tasks", t.id, { assigneeId });
  },
});

const setDueDate = defineAction({
  id: "M06.A06",
  description: "Set or change when an open task is due. The date can't be in the past.",
  risk: "write",
  input: z.strictObject({ taskId: TaskId, dueDate: z.iso.date() }),
  output: Task,
  entities: { consumes: ["task"] },
  example: () => ({ taskId: "tk_1", dueDate: "2026-10-28" }),
  handler: ({ taskId, dueDate }, { store, clock }) => {
    const t = openTask(store, taskId, "change its due date");
    notPast(dueDate, localDate(clock.now()), "Due date");
    return store.update<Task>("tasks", t.id, { dueDate });
  },
});

const setPriority = defineAction({
  id: "M06.A07",
  description: "Set an open task's priority: low, normal, high or urgent.",
  risk: "write",
  input: z.strictObject({ taskId: TaskId, priority: z.enum(PRIORITIES) }),
  output: Task,
  entities: { consumes: ["task"] },
  example: () => ({ taskId: "tk_1", priority: "urgent" }),
  handler: ({ taskId, priority }, { store }) => {
    const t = openTask(store, taskId, "change its priority");
    return store.update<Task>("tasks", t.id, { priority });
  },
});

const completeTask = defineAction({
  id: "M06.A08",
  description: "Mark an open task done.",
  risk: "write",
  input: z.strictObject({ taskId: TaskId }),
  output: Task,
  entities: { consumes: ["task"] },
  example: () => ({ taskId: "tk_1" }),
  handler: ({ taskId }, { store, clock }) => {
    const t = openTask(store, taskId, "complete it");
    return store.update<Task>("tasks", t.id, { status: "completed", completedAt: clock.now().toISOString() });
  },
});

const reopenTask = defineAction({
  id: "M06.A09",
  description: "Reopen a completed or cancelled task. If its due date has passed, give a new one or it will show as overdue.",
  risk: "write",
  input: z.strictObject({ taskId: TaskId, dueDate: z.iso.date().optional().describe("new due date") }),
  output: Task,
  entities: { consumes: ["task"] },
  example: (f) => ({ taskId: f.task({ status: "completed", completedAt: f.at(-1) }).id }),
  handler: ({ taskId, dueDate }, { store, clock }) => {
    const t = mustGet<Task>(store, "tasks", taskId, "task");
    requireState(`Task "${t.title}"`, t.status, ["completed", "cancelled"], "reopen it");
    if (dueDate) notPast(dueDate, localDate(clock.now()), "Due date");
    return store.update<Task>("tasks", t.id, { status: "open", completedAt: null, cancelReason: null, ...(dueDate ? { dueDate } : {}) });
  },
});

const cancelTask = defineAction({
  id: "M06.A10",
  description: "Cancel an open task that is no longer needed (it stays on record as cancelled). Not for finished work: use M06.A08 Mark task complete.",
  risk: "destructive",
  input: z.strictObject({ taskId: TaskId, reason: z.string().optional() }),
  output: Task,
  entities: { consumes: ["task"] },
  example: (f) => ({ taskId: f.task().id, reason: "Customer already called back" }),
  handler: ({ taskId, reason }, { store }) => {
    const t = openTask(store, taskId, "cancel it");
    return store.update<Task>("tasks", t.id, { status: "cancelled", cancelReason: reason ?? null });
  },
});

export default {
  actions: [createTask, getTask, searchTasks, updateDescription, assignTask, setDueDate, setPriority, completeTask, reopenTask, cancelTask],
  resolvers: {
    task: (store, name) => candidates(store.all<Task>("tasks"), name, (t) => t.title, (t) => t.dueDate ?? "no due date", (t) => (t.status === "open" ? undefined : t.status)),
  },
} satisfies ModuleExports;
