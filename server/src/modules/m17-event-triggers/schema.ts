import { z } from "zod";

/** The events a trigger can listen for: `<record>.<what happened>`. */
export const EVENT_TYPES = [
  "contact.created",
  "contact.tag_added",
  "lead.created",
  "lead.converted",
  "opportunity.stage_changed",
  "opportunity.won",
  "appointment.booked",
  "appointment.cancelled",
  "form.submitted",
  "survey.submitted",
  "invoice.paid",
  "order.submitted",
  "enrollment.created",
] as const;

export const TriggerCondition = z.object({ field: z.string(), op: z.enum(["eq", "neq", "contains"]), value: z.unknown() });
export type TriggerCondition = z.infer<typeof TriggerCondition>;

export const EventTrigger = z.object({
  id: z.string(),
  name: z.string(),
  eventType: z.enum(EVENT_TYPES),
  /** Every condition must hold for the event payload (AND). */
  conditions: z.array(TriggerCondition),
  /** The workflow (M16) it starts; null until bound. Only a published workflow can be bound. */
  workflowId: z.string().nullable(),
  enabled: z.boolean(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type EventTrigger = z.infer<typeof EventTrigger>;

export const TriggerFiring = z.object({
  id: z.string(),
  triggerId: z.string(),
  eventType: z.enum(EVENT_TYPES),
  payload: z.record(z.string(), z.unknown()),
  matched: z.boolean(),
  /** Set when it matched and started a run. */
  workflowRunId: z.string().nullable(),
  /** A test firing evaluates the conditions but never starts a run. */
  test: z.boolean(),
  at: z.string(),
});
export type TriggerFiring = z.infer<typeof TriggerFiring>;
