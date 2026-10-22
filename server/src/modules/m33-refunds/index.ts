import { z } from "zod";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import { cents, inDateRange, Limit, listOf, page, requirePermission, requireState } from "../../registry/helpers.js";
import type { ModuleExports } from "../../registry/registry.js";
import type { Store } from "../../store/db.js";
import { applyPayment } from "../m28-invoices/billing.js";
import type { Invoice } from "../m28-invoices/schema.js";
import type { Payment } from "../m29-payments/schema.js";
import { REFUND_STATUSES, Refund } from "./schema.js";

import "./fixtures.js";

// Refunds sit on a succeeded payment. Requested, approved and executed amounts count against the refundable balance.
// Executing peels allocations newest-first and reopens those invoices. Cash is a simulated decline.

const RefundId = z.string().describe("refund id (rf_…)");
const OPEN_REFUND = ["requested", "approved", "executed"] as const;

function load(store: Store, id: string): Refund {
  return mustGet<Refund>(store, "refunds", id, "refund");
}

function paymentOf(store: Store, id: string): Payment {
  const payment = mustGet<Payment>(store, "payments", id, "payment");
  if (payment.status !== "succeeded") throw new ActionError("CONFLICT", `Payment ${payment.id} did not succeed; only a succeeded payment can be refunded`);
  return payment;
}

function committed(store: Store, paymentId: string, exceptId?: string): number {
  const sum = store
    .find<Refund>("refunds", (r) => r.paymentId === paymentId && r.id !== exceptId && (OPEN_REFUND as readonly string[]).includes(r.status))
    .reduce((n, r) => n + r.amount, 0);
  return cents(sum);
}

function refundableOf(store: Store, payment: Payment, exceptId?: string): number {
  return cents(payment.amount - committed(store, payment.id, exceptId));
}

const createRefund = defineAction({
  id: "M33.A01",
  description:
    "Request a refund against a succeeded payment. The amount defaults to whatever is still refundable (payment amount minus requested, approved and executed refunds). Unlike M29.A01 Record payment, this does not move money until the request is approved and executed.",
  risk: "write",
  input: z.strictObject({
    paymentId: z.string().describe("payment id (pay_…)"),
    amount: z.number().positive().optional().describe("defaults to the refundable balance"),
    reason: z.string().min(1).optional(),
  }),
  output: Refund,
  siblings: ["M29.A01"],
  entities: { produces: "refund" },
  example: (f) => ({ paymentId: f.payment({ amount: 25, unallocated: 25 }).id, reason: "Duplicate charge" }),
  handler: (a, { store, clock, actorId }) => {
    const payment = paymentOf(store, a.paymentId);
    const refundable = refundableOf(store, payment);
    const amount = cents(a.amount ?? refundable);
    if (amount <= 0) throw new ActionError("CONFLICT", `Nothing left to refund on payment ${payment.id}`);
    if (amount > refundable) throw new ActionError("CONFLICT", `Only ${refundable} is left to refund on payment ${payment.id}`);
    const now = clock.now().toISOString();
    return store.insert("refunds", "rf", {
      paymentId: payment.id,
      contactId: payment.contactId,
      amount,
      reason: a.reason ?? null,
      status: "requested" as const,
      requestedBy: actorId ?? "us_1",
      decidedBy: null,
      decisionNote: null,
      failure: null,
      createdAt: now,
      decidedAt: null,
      executedAt: null,
    });
  },
});

const getRefund = defineAction({
  id: "M33.A02",
  description: "Get one refund request: amount, reason, status and who asked. To find several, use M33.A03 Search refund requests. M33.A10 is only the execution outcome.",
  risk: "read",
  input: z.strictObject({ refundId: RefundId }),
  output: Refund,
  entities: { consumes: ["refund"] },
  example: (f) => ({ refundId: f.refund().id }),
  handler: ({ refundId }, { store }) => load(store, refundId),
});

const searchRefunds = defineAction({
  id: "M33.A03",
  description:
    "Find refund requests by payment, contact, status or the date requested. Newest first, then by id. Unlike M33.A06 Check refundable balance, this lists requests rather than the amount still available.",
  risk: "read",
  input: z.strictObject({
    paymentId: z.string().optional(),
    contactId: z.string().optional(),
    status: z.enum(REFUND_STATUSES).optional(),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    limit: Limit,
  }),
  output: listOf(Refund),
  entities: { produces: "refund" },
  example: () => ({ status: "requested" as const }),
  handler: (a, { store }) => {
    const items = store.find<Refund>(
      "refunds",
      (r) => (!a.paymentId || r.paymentId === a.paymentId) && (!a.contactId || r.contactId === a.contactId) && (!a.status || r.status === a.status) && inDateRange(r.createdAt, a.from, a.to),
    );
    items.sort((x, y) => y.createdAt.localeCompare(x.createdAt) || x.id.localeCompare(y.id));
    return page(items, a.limit);
  },
});

const setReason = defineAction({
  id: "M33.A04",
  description:
    "Set the reason on a requested or approved refund. Unlike M33.A05 Set partial refund amount, this does not change how much money would go back.",
  risk: "write",
  input: z.strictObject({ refundId: RefundId, reason: z.string().min(1) }),
  output: Refund,
  entities: { consumes: ["refund"] },
  example: (f) => ({ refundId: f.refund({ reason: null }).id, reason: "Item arrived damaged" }),
  handler: ({ refundId, reason }, { store }) => {
    const refund = load(store, refundId);
    requireState(`Refund ${refund.id}`, refund.status, ["requested", "approved"], "change the reason");
    if (refund.reason === reason) throw new ActionError("CONFLICT", `Refund ${refund.id} already has that value`);
    return store.update<Refund>("refunds", refund.id, { reason });
  },
});

const setAmount = defineAction({
  id: "M33.A05",
  description:
    "Change the amount of a refund that is still only requested, up to the payment's refundable balance. Unlike M33.A04 Set refund reason, this changes the money, and an approved refund can no longer be resized.",
  risk: "write",
  input: z.strictObject({ refundId: RefundId, amount: z.number().positive() }),
  output: Refund,
  entities: { consumes: ["refund"] },
  example: (f) => {
    const payment = f.payment({ amount: 80, unallocated: 80 });
    return { refundId: f.refund({ paymentId: payment.id, contactId: payment.contactId, amount: 80 }).id, amount: 20 };
  },
  handler: ({ refundId, amount }, { store }) => {
    const refund = load(store, refundId);
    requireState(`Refund ${refund.id}`, refund.status, ["requested"], "change the amount");
    const next = cents(amount);
    if (next === refund.amount) throw new ActionError("CONFLICT", `Refund ${refund.id} already has that value`);
    const payment = paymentOf(store, refund.paymentId);
    const refundable = refundableOf(store, payment, refund.id);
    if (next > refundable) throw new ActionError("CONFLICT", `Only ${refundable} is left to refund on payment ${payment.id}`);
    return store.update<Refund>("refunds", refund.id, { amount: next });
  },
});

const checkBalance = defineAction({
  id: "M33.A06",
  description:
    "Check how much of a payment can still be refunded: its amount minus refunds in requested, approved or executed. Failed and rejected refunds do not count. Unlike M33.A01 Create refund request, this does not open a request.",
  risk: "read",
  input: z.strictObject({ paymentId: z.string().describe("payment id (pay_…)") }),
  output: z.object({
    paymentId: z.string(),
    amount: z.number(),
    refundable: z.number(),
    pending: z.number(),
    executed: z.number(),
  }),
  entities: { consumes: ["payment"] },
  example: (f) => ({ paymentId: f.payment().id }),
  handler: ({ paymentId }, { store }) => {
    const payment = mustGet<Payment>(store, "payments", paymentId, "payment");
    const rows = store.find<Refund>("refunds", (r) => r.paymentId === payment.id);
    const sum = (statuses: readonly string[]) => cents(rows.filter((r) => statuses.includes(r.status)).reduce((n, r) => n + r.amount, 0));
    const pending = sum(["requested", "approved"]);
    const executed = sum(["executed"]);
    return { paymentId: payment.id, amount: cents(payment.amount), refundable: cents(payment.amount - pending - executed), pending, executed };
  },
});

const approveRefund = defineAction({
  id: "M33.A07",
  description:
    "Approve a requested refund so it can be executed. Rejected, executed and failed requests cannot be approved. Unlike M33.A08 Reject refund request, this moves it forward. Requires billing.manage.",
  risk: "write",
  input: z.strictObject({ refundId: RefundId, note: z.string().min(1).optional() }),
  output: Refund,
  entities: { consumes: ["refund"] },
  example: (f) => ({ refundId: f.refund().id, note: "Confirmed with the customer" }),
  handler: ({ refundId, note }, { store, clock, actorId }) => {
    requirePermission(store, actorId, "billing.manage");
    const refund = load(store, refundId);
    requireState(`Refund ${refund.id}`, refund.status, ["requested"], "be approved");
    const now = clock.now().toISOString();
    return store.update<Refund>("refunds", refund.id, { status: "approved", decidedBy: actorId ?? "us_1", decidedAt: now, decisionNote: note ?? null });
  },
});

const rejectRefund = defineAction({
  id: "M33.A08",
  description:
    "Reject a requested refund. The amount stops counting against the payment's refundable balance. Unlike M33.A07 Approve refund request, it will not be executed. Requires billing.manage.",
  risk: "write",
  input: z.strictObject({ refundId: RefundId, note: z.string().min(1).optional() }),
  output: Refund,
  entities: { consumes: ["refund"] },
  example: (f) => ({ refundId: f.refund().id, note: "Outside the return window" }),
  handler: ({ refundId, note }, { store, clock, actorId }) => {
    requirePermission(store, actorId, "billing.manage");
    const refund = load(store, refundId);
    requireState(`Refund ${refund.id}`, refund.status, ["requested"], "be rejected");
    const now = clock.now().toISOString();
    return store.update<Refund>("refunds", refund.id, { status: "rejected", decidedBy: actorId ?? "us_1", decidedAt: now, decisionNote: note ?? null });
  },
});

const executeRefund = defineAction({
  id: "M33.A09",
  description:
    "Execute an approved refund. Invoice allocations are peeled newest first (later array index breaks a tie) and those invoices reopen. That money leaves: unallocated does not grow, and any part of the refund that was already unallocated is subtracted from it. A cash payment is declined instead and its allocations stay put. Unlike M29.A08 Remove payment allocation, this does not keep the money on the payment. Requires billing.manage.",
  risk: "destructive",
  input: z.strictObject({ refundId: RefundId }),
  output: Refund,
  siblings: ["M29.A01"],
  entities: { consumes: ["refund", "payment", "invoice"] },
  example: (f) => {
    const payment = f.payment({ amount: 40, unallocated: 40 });
    return { refundId: f.refund({ paymentId: payment.id, contactId: payment.contactId, amount: 40, status: "approved", decidedBy: "us_1", decidedAt: f.now() }).id };
  },
  handler: ({ refundId }, { store, clock, actorId }) => {
    requirePermission(store, actorId, "billing.manage");
    const refund = load(store, refundId);
    requireState(`Refund ${refund.id}`, refund.status, ["approved"], "be executed");
    const payment = paymentOf(store, refund.paymentId);
    if (payment.method === "cash") {
      return store.update<Refund>("refunds", refund.id, { status: "failed", failure: "Cash payments can't be reversed by the processor" });
    }
    const now = clock.now().toISOString();
    const left = payment.allocations.map((a) => a.amount);
    const order = payment.allocations.map((a, index) => ({ index, at: a.at }));
    order.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.index - a.index));
    let remaining = refund.amount;
    for (const slot of order) {
      if (remaining <= 0) break;
      const have = left[slot.index] ?? 0;
      const peel = Math.min(have, remaining);
      if (peel <= 0) continue;
      const source = payment.allocations[slot.index];
      if (!source) continue;
      const inv = mustGet<Invoice>(store, "invoices", source.invoiceId, "invoice");
      applyPayment(store, inv, -peel, now);
      left[slot.index] = cents(have - peel);
      remaining = cents(remaining - peel);
    }
    const allocations = payment.allocations.flatMap((a, index) => {
      const amount = left[index] ?? 0;
      return amount > 0 ? [{ invoiceId: a.invoiceId, amount, at: a.at }] : [];
    });
    if (remaining > payment.unallocated) {
      throw new ActionError("CONFLICT", `Refund ${refund.id} is larger than payment ${payment.id}'s allocations plus its unallocated balance; reduce the amount first`);
    }
    store.update<Payment>("payments", payment.id, { allocations, unallocated: cents(payment.unallocated - remaining) });
    return store.update<Refund>("refunds", refund.id, { status: "executed", executedAt: now });
  },
});

const executionStatus = defineAction({
  id: "M33.A10",
  description:
    "Show whether a refund was executed or the processor declined it, including the failure text. Unlike M33.A02 Get refund request, this is only the execution outcome, not the request itself.",
  risk: "read",
  input: z.strictObject({ refundId: RefundId }),
  output: z.object({
    refundId: z.string(),
    status: z.enum(REFUND_STATUSES),
    amount: z.number(),
    failure: z.string().nullable(),
    executedAt: z.string().nullable(),
  }),
  entities: { consumes: ["refund"] },
  example: (f) => ({ refundId: f.refund({ status: "executed", executedAt: f.now() }).id }),
  handler: ({ refundId }, { store }) => {
    const refund = load(store, refundId);
    return { refundId: refund.id, status: refund.status, amount: cents(refund.amount), failure: refund.failure, executedAt: refund.executedAt };
  },
});

export default {
  actions: [createRefund, getRefund, searchRefunds, setReason, setAmount, checkBalance, approveRefund, rejectRefund, executeRefund, executionStatus],
} satisfies ModuleExports;
