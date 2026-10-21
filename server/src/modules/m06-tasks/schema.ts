import { z } from "zod";

/** Record types a task can be about, and the table each lives in. */
export const RELATED_TABLES = { contact: "contacts", lead: "leads", opportunity: "opportunities" } as const;
export const RELATED_TYPES = ["contact", "lead", "opportunity"] as const;
export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;

export const Related = z.object({ type: z.enum(RELATED_TYPES), id: z.string() });

export const Task = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  assigneeId: z.string().nullable(),
  dueDate: z.string().nullable(),
  priority: z.enum(PRIORITIES),
  status: z.enum(["open", "completed", "cancelled"]),
  relatedTo: Related.nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
});
export type Task = z.infer<typeof Task>;
