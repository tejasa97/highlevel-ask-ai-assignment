import { z } from "zod";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import { cents, inDateRange, Limit, listOf, page, requirePermission, requireState } from "../../registry/helpers.js";
import type { ModuleExports } from "../../registry/registry.js";
import type { Store } from "../../store/db.js";
import type { Contact } from "../m01-contacts/schema.js";
import { applyPayment } from "../m28-invoices/billing.js";
import type { Invoice } from "../m28-invoices/schema.js";
import { FAILURE_CODES, Payment, PAYMENT_METHODS, PaymentRequest } from "./schema.js";

export { Payment, PaymentRequest } from "./schema.js";

// Payments are simulated: recording one says "this money arrived (or was declined)". Succeeded payments
// are allocated to invoices, which marks them paid; anything left over stays unallocated on the payment.

const RequestId = z.string().describe("payment request id (prq_…)");
const PaymentId = z.string().describe("payment id (pay_…)");

const FAILURES: Record<(typeof FAILURE_CODES)[number], { message: string; advice: string }> = {
  card_declined: { message: "The card was declined by the issuing bank", advice: "Ask the customer to call their bank or use a different card." },
  insufficient_funds: { message: "The account doesn't have enough funds", advice: "Ask the customer to try again later or pay part now." },
  expired_card: { message: "The card has expired", advice: "Ask the customer to update their card details." },
  bank_rejected: { message: "The bank rejected the transfer", advice: "Check the account details with the customer and retry." },
};

function contactName(store: Store, id: string): string {
  return store.get<Contact>("contacts", id)?.name ?? id;
}

function openInvoice(store: Store, id: string, contactId: string | undefined): Invoice {
  const inv = mustGet<Invoice>(store, "invoices", id, "invoice");
  if (contactId && inv.contactId !== contactId) throw new ActionError("INVALID", `Invoice ${inv.number} belongs to contact ${inv.contactId}, not ${contactId}`);
  requireState(`Invoice ${inv.number}`, inv.status, ["open"], "take payments (issue it first if it's a draft)");
  return inv;
}

function allocate(store: Store, p: Payment, inv: Invoice, amount: number, at: string): Payment {
  if (amount > p.unallocated) throw new ActionError("CONFLICT", `Payment ${p.id} only has $${p.unallocated} left to allocate`, { unallocated: p.unallocated });
  applyPayment(store, inv, amount, at);
  return store.update<Payment>("payments", p.id, { allocations: [...p.allocations, { invoiceId: inv.id, amount, at }], unallocated: cents(p.unallocated - amount) });
}

const createRequest = defineAction({
  id: "M29.A01",
  description: "Create a payment link asking a contact to pay an amount, optionally for an open invoice (the amount defaults to what's still due on it). Returns the link; nothing is sent.",
  risk: "write",
  input: z.strictObject({
    contactId: z.string(),
    invoiceId: z.string().optional(),
    amount: z.number().positive().optional().describe("USD; required without invoiceId"),
    description: z.string().optional(),
  }),
  output: PaymentRequest,
  siblings: ["M28.A07"],
  entities: { produces: "payment_request", consumes: ["contact", "invoice"] },
  example: () => ({ contactId: "ct_31", amount: 250, description: "Deposit for website project" }),
  handler: (a, { store, clock, actorId }) => {
    const c = mustGet<Contact>(store, "contacts", a.contactId, "contact");
    requireState(c.name, c.status, ["active"], "be asked to pay");
    const inv = a.invoiceId ? openInvoice(store, a.invoiceId, c.id) : undefined;
    const amount = a.amount ?? inv?.amountDue;
    if (!amount) throw new ActionError("INVALID", "Give an amount (or an invoiceId to request what's due on it)");
    if (inv && amount > inv.amountDue) throw new ActionError("CONFLICT", `Invoice ${inv.number} only has $${inv.amountDue} due`);
    const id = store.nextId("payment_requests", "prq");
    return store.put("payment_requests", {
      id,
      contactId: c.id,
      invoiceId: inv?.id ?? null,
      amount,
      description: a.description ?? (inv ? `Payment for invoice ${inv.number}` : "Payment"),
      status: "pending" as const,
      link: `https://pay.ourco.example/r/${id}`,
      paymentId: null,
      createdBy: actorId ?? "us_1",
      createdAt: clock.now().toISOString(),
      paidAt: null,
      cancelledAt: null,
    });
  },
});

const getRequest = defineAction({
  id: "M29.A02",
  description: "Get a payment request (link): who it's for, amount, invoice, and whether it's pending, paid or cancelled.",
  risk: "read",
  input: z.strictObject({ paymentRequestId: RequestId }),
  output: PaymentRequest.extend({ contactName: z.string() }),
  entities: { consumes: ["payment_request"] },
  example: (f) => ({ paymentRequestId: f.paymentRequest().id }),
  handler: ({ paymentRequestId }, { store }) => {
    const r = mustGet<PaymentRequest>(store, "payment_requests", paymentRequestId, "payment request");
    return { ...r, contactName: contactName(store, r.contactId) };
  },
});

const cancelRequest = defineAction({
  id: "M29.A03",
  description: "Cancel a pending payment request so its link stops working.",
  risk: "write",
  input: z.strictObject({ paymentRequestId: RequestId }),
  output: PaymentRequest,
  entities: { consumes: ["payment_request"] },
  example: (f) => ({ paymentRequestId: f.paymentRequest().id }),
  handler: ({ paymentRequestId }, { store, clock }) => {
    const r = mustGet<PaymentRequest>(store, "payment_requests", paymentRequestId, "payment request");
    requireState("The payment request", r.status, ["pending"], "be cancelled");
    return store.update<PaymentRequest>("payment_requests", r.id, { status: "cancelled", cancelledAt: clock.now().toISOString() });
  },
});

const recordPayment = defineAction({
  id: "M29.A04",
  description:
    "Record a payment from a contact (simulated): card, bank transfer, cash or check, succeeded or failed. A succeeded payment for an invoice or payment request is applied to that invoice; otherwise it stays unallocated.",
  risk: "write",
  input: z.strictObject({
    contactId: z.string(),
    amount: z.number().positive().describe("USD"),
    method: z.enum(PAYMENT_METHODS).optional().describe("default card"),
    invoiceId: z.string().optional(),
    paymentRequestId: z.string().optional(),
    outcome: z.enum(["succeeded", "failed"]).optional().describe("default succeeded"),
    failureCode: z.enum(FAILURE_CODES).optional().describe("when outcome is failed; default card_declined"),
  }),
  output: Payment,
  siblings: ["M29.A07"],
  entities: { produces: "payment", consumes: ["contact", "invoice", "payment_request"] },
  example: () => ({ contactId: "ct_31", amount: 100, method: "cash" }),
  handler: (a, { store, clock, actorId }) => {
    requirePermission(store, actorId, "billing.manage");
    mustGet<Contact>(store, "contacts", a.contactId, "contact");
    const req = a.paymentRequestId ? mustGet<PaymentRequest>(store, "payment_requests", a.paymentRequestId, "payment request") : undefined;
    if (req) {
      if (req.contactId !== a.contactId) throw new ActionError("INVALID", `Payment request ${req.id} is for contact ${req.contactId}, not ${a.contactId}`);
      requireState("The payment request", req.status, ["pending"], "be paid");
      if (a.invoiceId && req.invoiceId && a.invoiceId !== req.invoiceId) throw new ActionError("INVALID", `Payment request ${req.id} is for invoice ${req.invoiceId}`);
    }
    const invoiceId = a.invoiceId ?? req?.invoiceId ?? undefined;
    const failed = a.outcome === "failed";
    if (!failed && a.failureCode) throw new ActionError("INVALID", "failureCode only applies when outcome is failed");
    const inv = invoiceId && !failed ? openInvoice(store, invoiceId, a.contactId) : undefined;
    if (inv && a.amount > inv.amountDue) throw new ActionError("CONFLICT", `Invoice ${inv.number} only has $${inv.amountDue} due; record the payment without invoiceId and allocate part of it`);
    const at = clock.now().toISOString();
    const code = failed ? (a.failureCode ?? "card_declined") : null;
    let p: Payment = store.insert("payments", "pay", {
      contactId: a.contactId,
      amount: a.amount,
      currency: "USD" as const,
      method: a.method ?? "card",
      status: failed ? ("failed" as const) : ("succeeded" as const),
      failure: code ? { code, message: FAILURES[code].message } : null,
      paymentRequestId: req?.id ?? null,
      allocations: [] as Payment["allocations"],
      unallocated: failed ? 0 : a.amount,
      recordedBy: actorId ?? "us_1",
      createdAt: at,
    });
    if (failed) return p;
    if (inv) p = allocate(store, p, inv, a.amount, at);
    if (req) store.update<PaymentRequest>("payment_requests", req.id, { status: "paid", paymentId: p.id, paidAt: at });
    return p;
  },
});

const Detail = Payment.extend({ contactName: z.string() });

const getPayment = defineAction({
  id: "M29.A05",
  description: "Get one payment: amount, method, whether it succeeded, and which invoices it was applied to.",
  risk: "read",
  input: z.strictObject({ paymentId: PaymentId }),
  output: Detail,
  entities: { consumes: ["payment"] },
  example: (f) => ({ paymentId: f.payment().id }),
  handler: ({ paymentId }, { store }) => {
    const p = mustGet<Payment>(store, "payments", paymentId, "payment");
    return { ...p, contactName: contactName(store, p.contactId) };
  },
});

const searchPayments = defineAction({
  id: "M29.A06",
  description: "Find payments by contact, invoice, status (succeeded/failed), method, date range, or only those with money not yet applied to an invoice. Newest first.",
  risk: "read",
  input: z.strictObject({
    contactId: z.string().optional(),
    invoiceId: z.string().optional(),
    status: z.enum(["succeeded", "failed"]).optional(),
    method: z.enum(PAYMENT_METHODS).optional(),
    unallocated: z.boolean().optional().describe("true: only payments with money not applied to an invoice"),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    limit: Limit,
  }),
  output: listOf(Detail),
  entities: { produces: "payment" },
  example: () => ({ status: "failed" }),
  handler: (a, { store }) => {
    const items = store
      .find<Payment>(
        "payments",
        (p) =>
          (!a.contactId || p.contactId === a.contactId) &&
          (!a.invoiceId || p.allocations.some((x) => x.invoiceId === a.invoiceId)) &&
          (!a.status || p.status === a.status) &&
          (!a.method || p.method === a.method) &&
          (a.unallocated === undefined || p.unallocated > 0 === a.unallocated) &&
          inDateRange(p.createdAt, a.from, a.to),
      )
      .map((p) => ({ ...p, contactName: contactName(store, p.contactId) }));
    items.sort((x, y) => y.createdAt.localeCompare(x.createdAt));
    return page(items, a.limit);
  },
});

const allocatePayment = defineAction({
  id: "M29.A07",
  description: "Apply money from a succeeded payment to one of the same contact's open invoices. The amount defaults to as much as fits.",
  risk: "write",
  input: z.strictObject({ paymentId: PaymentId, invoiceId: z.string(), amount: z.number().positive().optional() }),
  output: Payment,
  siblings: ["M29.A04"],
  entities: { consumes: ["payment", "invoice"] },
  example: (f) => {
    const c = f.contact();
    return { paymentId: f.payment({ contactId: c.id, amount: 100, unallocated: 100 }).id, invoiceId: f.invoice({ contactId: c.id, status: "open", issueDate: f.day(-5), dueDate: f.day(25) }).id };
  },
  handler: (a, { store, clock, actorId }) => {
    requirePermission(store, actorId, "billing.manage");
    const p = mustGet<Payment>(store, "payments", a.paymentId, "payment");
    requireState(`Payment ${p.id}`, p.status, ["succeeded"], "be allocated");
    const inv = openInvoice(store, a.invoiceId, p.contactId);
    if (p.unallocated <= 0) throw new ActionError("CONFLICT", `Payment ${p.id} is already fully allocated`);
    return allocate(store, p, inv, a.amount ?? Math.min(p.unallocated, inv.amountDue), clock.now().toISOString());
  },
});

const removeAllocation = defineAction({
  id: "M29.A08",
  description: "Take a payment back off an invoice (e.g. it was applied to the wrong one). The invoice reopens and the money goes back to unallocated.",
  risk: "write",
  input: z.strictObject({ paymentId: PaymentId, invoiceId: z.string() }),
  output: Payment,
  entities: { consumes: ["payment", "invoice"] },
  example: (f) => {
    const c = f.contact();
    const inv = f.invoice({ contactId: c.id, status: "paid", issueDate: f.day(-5), dueDate: f.day(25), amountPaid: 500, amountDue: 0, paidAt: f.at(-1) });
    return { paymentId: f.payment({ contactId: c.id, amount: 500, unallocated: 0, allocations: [{ invoiceId: inv.id, amount: 500, at: f.at(-1) }] }).id, invoiceId: inv.id };
  },
  handler: (a, { store, clock, actorId }) => {
    requirePermission(store, actorId, "billing.manage");
    const p = mustGet<Payment>(store, "payments", a.paymentId, "payment");
    const inv = mustGet<Invoice>(store, "invoices", a.invoiceId, "invoice");
    const mine = p.allocations.filter((x) => x.invoiceId === inv.id);
    if (!mine.length) throw new ActionError("CONFLICT", `Payment ${p.id} isn't applied to invoice ${inv.number}`);
    const amount = cents(mine.reduce((n, x) => n + x.amount, 0));
    requireState(`Invoice ${inv.number}`, inv.status, ["open", "paid"], "have a payment removed");
    applyPayment(store, inv, -amount, clock.now().toISOString());
    return store.update<Payment>("payments", p.id, { allocations: p.allocations.filter((x) => x.invoiceId !== inv.id), unallocated: cents(p.unallocated + amount) });
  },
});

const receipt = defineAction({
  id: "M29.A09",
  description: "Get a receipt for a succeeded payment: receipt number, who paid, amount, method, date and the invoices it paid.",
  risk: "read",
  input: z.strictObject({ paymentId: PaymentId }),
  output: z.object({
    receiptNumber: z.string(),
    paymentId: z.string(),
    contactName: z.string(),
    amount: z.number(),
    currency: z.string(),
    method: z.enum(PAYMENT_METHODS),
    paidAt: z.string(),
    invoices: z.array(z.object({ number: z.string(), amount: z.number() })),
  }),
  entities: { consumes: ["payment"] },
  example: (f) => ({ paymentId: f.payment().id }),
  handler: ({ paymentId }, { store }) => {
    const p = mustGet<Payment>(store, "payments", paymentId, "payment");
    if (p.status !== "succeeded") throw new ActionError("CONFLICT", `Payment ${p.id} failed (${p.failure?.code}); there's no receipt. See M29.A10.`);
    return {
      receiptNumber: `RCPT-${p.id.slice(4).padStart(5, "0")}`,
      paymentId: p.id,
      contactName: contactName(store, p.contactId),
      amount: p.amount,
      currency: p.currency,
      method: p.method,
      paidAt: p.createdAt,
      invoices: p.allocations.map((x) => ({ number: store.get<Invoice>("invoices", x.invoiceId)?.number ?? x.invoiceId, amount: x.amount })),
    };
  },
});

const failureDetails = defineAction({
  id: "M29.A10",
  description: "Explain why a payment failed (declined card, insufficient funds, expired card, bank rejection) and what to do next.",
  risk: "read",
  input: z.strictObject({ paymentId: PaymentId }),
  output: z.object({ paymentId: z.string(), contactName: z.string(), amount: z.number(), code: z.enum(FAILURE_CODES), message: z.string(), advice: z.string() }),
  entities: { consumes: ["payment"] },
  example: (f) => ({ paymentId: f.payment({ status: "failed", unallocated: 0, failure: { code: "card_declined", message: FAILURES.card_declined.message } }).id }),
  handler: ({ paymentId }, { store }) => {
    const p = mustGet<Payment>(store, "payments", paymentId, "payment");
    if (p.status !== "failed" || !p.failure) throw new ActionError("CONFLICT", `Payment ${p.id} succeeded; nothing failed`);
    return { paymentId: p.id, contactName: contactName(store, p.contactId), amount: p.amount, code: p.failure.code, message: p.failure.message, advice: FAILURES[p.failure.code].advice };
  },
});

export default {
  actions: [createRequest, getRequest, cancelRequest, recordPayment, getPayment, searchPayments, allocatePayment, removeAllocation, receipt, failureDetails],
} satisfies ModuleExports;
