import { z } from "zod";

// Opportunities and pipelines. M04's actions come after v1; M03 Convert lead already creates opportunities.

export const Pipeline = z.object({
  id: z.string(),
  name: z.string(),
  stages: z.array(z.object({ id: z.string(), name: z.string(), probability: z.number().min(0).max(100) })),
  status: z.enum(["active", "archived"]),
  createdAt: z.string(),
});
export type Pipeline = z.infer<typeof Pipeline>;

export const Opportunity = z.object({
  id: z.string(),
  name: z.string(),
  contactId: z.string(),
  leadId: z.string().nullable(),
  pipelineId: z.string(),
  stageId: z.string(),
  value: z.number().min(0),
  currency: z.literal("USD"),
  ownerId: z.string().nullable(),
  status: z.enum(["open", "won", "lost"]),
  expectedCloseDate: z.string().nullable(),
  lostReason: z.string().nullable(),
  createdAt: z.string(),
  closedAt: z.string().nullable(),
});
export type Opportunity = z.infer<typeof Opportunity>;
