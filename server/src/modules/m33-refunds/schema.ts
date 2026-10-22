import { z } from "zod";

export const REFUND_STATUSES = ["requested", "approved", "rejected", "executed", "failed"] as const;

export const Refund = z.object({
  id: z.string(),
  /** The successful payment (M29) being refunded. */
  paymentId: z.string(),
  contactId: z.string(),
  amount: z.number().positive(),
  reason: z.string().nullable(),
  /** requested → approved | rejected; approved → executed | failed (the simulated processor can decline). */
  status: z.enum(REFUND_STATUSES),
  requestedBy: z.string(),
  decidedBy: z.string().nullable(),
  decisionNote: z.string().nullable(),
  failure: z.string().nullable(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  executedAt: z.string().nullable(),
});
export type Refund = z.infer<typeof Refund>;

// Refundable balance of a payment = amount − refunds in requested/approved/executed (A06). Executing one reopens the invoices it had paid.
