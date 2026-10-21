import { z } from "zod";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import { contains } from "../../registry/helpers.js";
import type { ModuleExports } from "../../registry/registry.js";
import type { User } from "../m48-users/index.js";

const RELATED = { contact: "contacts", lead: "leads" } as const;

export const Task = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  assigneeId: z.string().nullable(),
  dueDate: z.string().nullable(),
  priority: z.enum(["low", "normal", "high"]),
  status: z.enum(["open", "completed", "cancelled"]),
  relatedTo: z.object({ type: z.enum(["contact", "lead"]), id: z.string() }).nullable(),
  createdAt: z.string(),
});
export type Task = z.infer<typeof Task>;

const createTask = defineAction({
  id: "M06.A01",
  description: "Create a to-do for a staff user, optionally linked to a contact or lead. Leave dueDate out unless the user gave one.",
  risk: "write",
  input: z.strictObject({
    title: z.string().min(1),
    description: z.string().optional(),
    assigneeId: z.string().optional().describe("user id"),
    dueDate: z.iso.date().optional(),
    priority: Task.shape.priority.optional(),
    relatedTo: z.strictObject({ type: z.enum(["contact", "lead"]), id: z.string() }).optional(),
  }),
  output: Task,
  entities: { produces: "task" },
  handler: (a, { store, clock }) => {
    if (a.assigneeId) {
      const u = mustGet<User>(store, "users", a.assigneeId, "user");
      if (u.status !== "active") throw new ActionError("CONFLICT", `${u.name} is ${u.status} and can't be assigned tasks`);
    }
    if (a.relatedTo) mustGet(store, RELATED[a.relatedTo.type], a.relatedTo.id, a.relatedTo.type);
    return store.insert("tasks", "tk", {
      title: a.title,
      description: a.description ?? null,
      assigneeId: a.assigneeId ?? null,
      dueDate: a.dueDate ?? null,
      priority: a.priority ?? "normal",
      status: "open" as const,
      relatedTo: a.relatedTo ?? null,
      createdAt: clock.now().toISOString(),
    });
  },
});

const searchTasks = defineAction({
  id: "M06.A03",
  description: "Find tasks by assignee, status, due date range, linked record or title text. Dates are inclusive.",
  risk: "read",
  input: z.strictObject({
    assigneeId: z.string().optional(),
    status: Task.shape.status.optional(),
    dueFrom: z.iso.date().optional(),
    dueTo: z.iso.date().optional(),
    relatedId: z.string().optional().describe("contact or lead id"),
    query: z.string().optional(),
  }),
  output: z.object({ items: z.array(Task), total: z.number() }),
  handler: (a, { store }) => {
    const items = store.find<Task>(
      "tasks",
      (t) =>
        (!a.assigneeId || t.assigneeId === a.assigneeId) &&
        (!a.status || t.status === a.status) &&
        (!a.dueFrom || (t.dueDate !== null && t.dueDate >= a.dueFrom)) &&
        (!a.dueTo || (t.dueDate !== null && t.dueDate <= a.dueTo)) &&
        (!a.relatedId || t.relatedTo?.id === a.relatedId) &&
        (!a.query || contains(t.title, a.query)),
    );
    return { items, total: items.length };
  },
});

const setDueDate = defineAction({
  id: "M06.A06",
  description: "Set or change when an open task is due.",
  risk: "write",
  input: z.strictObject({ taskId: z.string(), dueDate: z.iso.date() }),
  output: Task,
  handler: ({ taskId, dueDate }, { store }) => {
    const t = mustGet<Task>(store, "tasks", taskId, "task");
    if (t.status !== "open") throw new ActionError("CONFLICT", `Task ${taskId} is ${t.status}`);
    return store.update<Task>("tasks", taskId, { dueDate });
  },
});

const cancelTask = defineAction({
  id: "M06.A10",
  description: "Cancel an open task that is no longer needed (it stays on record as cancelled).",
  risk: "destructive",
  input: z.strictObject({ taskId: z.string(), reason: z.string().optional() }),
  output: Task,
  handler: ({ taskId, reason }, { store }) => {
    const t = mustGet<Task>(store, "tasks", taskId, "task");
    if (t.status !== "open") throw new ActionError("CONFLICT", `Task ${taskId} is already ${t.status}`);
    return store.update<Task>("tasks", taskId, { status: "cancelled", cancelReason: reason ?? null });
  },
});

export default { actions: [createTask, searchTasks, setDueDate, cancelTask] } satisfies ModuleExports;
