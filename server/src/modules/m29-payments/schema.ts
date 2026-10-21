import { z } from "zod";

export const PAYMENT_METHODS = ["card", "bank_transfer", "cash", "check"] as const;
export const FAILURE_CODES = ["card_declined", "insufficient_funds", "expired_card", "bank_rejected"] as const;

/** A link sent to a customer asking them to pay an amount, optionally for an invoice. */
export const PaymentRequest = z.object({
  id: z.string(),
  contactId: z.string(),
  invoiceId: z.string().nullable(),
  amount: z.number().positive(),
  description: z.string(),
  status: z.enum(["pending", "paid", "cancelled"]),
  link: z.string(),
  paymentId: z.string().nullable().describe("the payment that settled it"),
  createdBy: z.string(),
  createdAt: z.string(),
  paidAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
});
export type PaymentRequest = z.infer<typeof PaymentRequest>;

export const Payment = z.object({
  id: z.string(),
  contactId: z.string(),
  amount: z.number().positive(),
  currency: z.literal("USD"),
  method: z.enum(PAYMENT_METHODS),
  status: z.enum(["succeeded", "failed"]),
  failure: z.object({ code: z.enum(FAILURE_CODES), message: z.string() }).nullable(),
  paymentRequestId: z.string().nullable(),
  /** Which invoices this money paid; what's left is `unallocated`. */
  allocations: z.array(z.object({ invoiceId: z.string(), amount: z.number(), at: z.string() })),
  unallocated: z.number(),
  recordedBy: z.string(),
  createdAt: z.string(),
});
export type Payment = z.infer<typeof Payment>;
