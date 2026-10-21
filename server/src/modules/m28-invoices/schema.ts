import { z } from "zod";

export const INVOICE_STATUSES = ["draft", "open", "paid", "void"] as const;

export const LineItem = z.object({
  description: z.string(),
  quantity: z.number().positive(),
  unitPrice: z.number().min(0).describe("USD"),
  amount: z.number().describe("quantity × unitPrice"),
});
export type LineItem = z.infer<typeof LineItem>;

export const Invoice = z.object({
  id: z.string(),
  number: z.string().describe("e.g. INV-1001"),
  contactId: z.string(),
  /** draft → open (issued) → paid; void cancels an unpaid one. */
  status: z.enum(INVOICE_STATUSES),
  lineItems: z.array(LineItem),
  total: z.number(),
  amountPaid: z.number(),
  amountDue: z.number(),
  currency: z.literal("USD"),
  issueDate: z.string().nullable(),
  dueDate: z.string().nullable(),
  paidAt: z.string().nullable(),
  voidedAt: z.string().nullable(),
  voidReason: z.string().nullable(),
  /** Reminder emails sent, oldest first. */
  reminders: z.array(z.object({ at: z.string(), emailId: z.string() })),
  lastReminderAt: z.string().nullable(),
  memo: z.string().nullable(),
  createdAt: z.string(),
});
export type Invoice = z.infer<typeof Invoice>;
