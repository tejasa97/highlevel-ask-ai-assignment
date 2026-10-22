import { z } from "zod";

export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const TICKET_STATUSES = [
  "open",
  "in_progress",
  "resolved",
  "closed",
] as const;
export const SLA_HOURS = { urgent: 1, high: 4, normal: 24, low: 72 } as const;
export const Ticket = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  contactId: z.string().nullable(),
  requesterEmail: z.string().nullable(),
  ownerId: z.string().nullable(),
  priority: z.enum(PRIORITIES),
  status: z.enum(TICKET_STATUSES),
  notes: z.array(
    z.object({ body: z.string(), by: z.string(), at: z.string() }),
  ),
  replies: z.array(
    z.object({ body: z.string(), emailId: z.string(), at: z.string() }),
  ),
  createdAt: z.string(),
  updatedAt: z.string(),
  resolvedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  firstResponseAt: z.string().nullable(),
  firstResponseDueAt: z.string().nullable(),
  history: z.array(
    z.object({
      from: z.enum(TICKET_STATUSES),
      to: z.enum(TICKET_STATUSES),
      at: z.string(),
      by: z.string(),
    }),
  ),
});
export type Ticket = z.infer<typeof Ticket>;
export function dueAt(ticket: Ticket): string {
  return (
    ticket.firstResponseDueAt ??
    new Date(
      Date.parse(ticket.createdAt) + SLA_HOURS[ticket.priority] * 3_600_000,
    ).toISOString()
  );
}
