import { z } from "zod";

/** What a report measures. Each is computed live from the tables named beside it; reports store no results. */
export const REPORT_METRICS = [
  "new_contacts", // contacts.createdAt
  "new_leads", // leads.createdAt
  "won_deals", // opportunities status=won, closedAt
  "pipeline_value", // opportunities status=open, value
  "revenue", // payments status=succeeded, createdAt
  "appointments_booked", // appointments.createdAt
  "orders_submitted", // orders.submittedAt
] as const;

export const REPORT_GROUPINGS = ["day", "week", "month", "owner", "source"] as const;

export const DateRange = z.object({ from: z.string(), to: z.string() });
export type DateRange = z.infer<typeof DateRange>;

export const SavedReport = z.object({
  id: z.string(),
  name: z.string(),
  metric: z.enum(REPORT_METRICS),
  /** Field → value, narrowing the records counted (ownerId, source, pipelineId). */
  filters: z.record(z.string(), z.string()),
  dateRange: DateRange,
  groupBy: z.enum(REPORT_GROUPINGS).nullable(),
  /** Set by scheduling (A10): the report is emailed to these addresses. Delivery is simulated. */
  schedule: z.object({ frequency: z.enum(["daily", "weekly", "monthly"]), recipients: z.array(z.string()) }).nullable(),
  lastRunAt: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SavedReport = z.infer<typeof SavedReport>;
