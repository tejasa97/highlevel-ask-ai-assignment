import { z } from "zod";

export const WorkflowStep = z.object({
  id: z.string(),
  kind: z.enum(["action", "wait", "condition"]),
  name: z.string(),
  /** kind=action: a catalog action id (M01.A04) and its arguments. */
  actionId: z.string().nullable(),
  args: z.record(z.string(), z.unknown()),
  /** kind=wait. */
  waitMinutes: z.number().int().min(1).nullable(),
  /** kind=condition: continue only when `field` of the triggering record equals `equals`. */
  condition: z.object({ field: z.string(), equals: z.unknown() }).nullable(),
});
export type WorkflowStep = z.infer<typeof WorkflowStep>;

export const Workflow = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  /** draft → published ⇄ paused. Only a published workflow runs; editing a published one is refused until it is paused. */
  status: z.enum(["draft", "published", "paused"]),
  steps: z.array(WorkflowStep),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  publishedAt: z.string().nullable(),
});
export type Workflow = z.infer<typeof Workflow>;

/** One run of a workflow for one record. Written by seeds and by M17 test firings, read by M16.A10. */
export const WorkflowRun = z.object({
  id: z.string(),
  workflowId: z.string(),
  triggerId: z.string().nullable(),
  subject: z.object({ type: z.string(), id: z.string() }),
  status: z.enum(["running", "completed", "failed"]),
  stepResults: z.array(z.object({ stepId: z.string(), status: z.enum(["done", "skipped", "failed"]), at: z.string(), error: z.string().nullable() })),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type WorkflowRun = z.infer<typeof WorkflowRun>;
