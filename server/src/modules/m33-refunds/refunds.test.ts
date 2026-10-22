import assert from "node:assert/strict";
import { test } from "node:test";
import type { Invoice } from "../m28-invoices/schema.js";
import type { Payment } from "../m29-payments/schema.js";
import { failure, testWorld } from "../../testkit.js";

function paidInvoice(w: Awaited<ReturnType<typeof testWorld>>, contactId: string, total: number): Invoice {
  return w.f.invoice({
    contactId,
    status: "paid",
    issueDate: w.f.day(-5),
    dueDate: w.f.day(10),
    lineItems: [{ description: "Item", quantity: 1, unitPrice: total, amount: total }],
    total,
    amountPaid: total,
    amountDue: 0,
    paidAt: w.f.at(-1),
  });
}

test("guards: permission, wrong status, no-ops, and unknown fields", async () => {
  const w = await testWorld();
  const sales = w.f.user({ roles: ["sales"] });
  const payment = w.f.payment({ amount: 50, unallocated: 50 });
  assert.equal(failure(() => w.call("M33.A01", { paymentId: "pay_99999" })).code, "NOT_FOUND");
  const refund = w.call("M33.A01", { paymentId: payment.id, amount: 20, reason: "x" });
  assert.equal(failure(() => w.call("M33.A04", { refundId: refund.id, reason: "x" })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M33.A05", { refundId: refund.id, amount: 20 })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M33.A07", { refundId: refund.id }, sales.id)).code, "PERMISSION");
  assert.equal(failure(() => w.call("M33.A08", { refundId: refund.id }, sales.id)).code, "PERMISSION");
  assert.equal(failure(() => w.call("M33.A09", { refundId: refund.id }, sales.id)).code, "PERMISSION");
  assert.equal(failure(() => w.call("M33.A02", { refundId: refund.id, madeUp: 1 })).code, "INVALID");
});

test("refundable balance ignores failed and rejected, and create cannot exceed it", async () => {
  const w = await testWorld();
  const payment = w.f.payment({ amount: 100, unallocated: 100 });
  w.f.refund({ paymentId: payment.id, contactId: payment.contactId, amount: 40, status: "requested" });
  w.f.refund({ paymentId: payment.id, contactId: payment.contactId, amount: 20, status: "approved" });
  w.f.refund({ paymentId: payment.id, contactId: payment.contactId, amount: 10, status: "executed", executedAt: w.f.now() });
  w.f.refund({ paymentId: payment.id, contactId: payment.contactId, amount: 30, status: "rejected" });
  w.f.refund({ paymentId: payment.id, contactId: payment.contactId, amount: 15, status: "failed", failure: "no" });
  const balance = w.call("M33.A06", { paymentId: payment.id });
  assert.equal(balance.refundable, 30);
  assert.equal(balance.pending, 60);
  assert.equal(balance.executed, 10);
  const over = failure(() => w.call("M33.A01", { paymentId: payment.id, amount: 31 }));
  assert.equal(over.code, "CONFLICT");
  const created = w.call("M33.A01", { paymentId: payment.id });
  assert.equal(created.amount, 30);
  assert.equal(w.call("M33.A06", { paymentId: payment.id }).refundable, 0);
  assert.equal(failure(() => w.call("M33.A01", { paymentId: w.f.payment({ status: "failed", failure: { code: "card_declined", message: "no" }, unallocated: 0 }).id })).code, "CONFLICT");
});

test("partial amount is only while requested; approve and reject only from requested", async () => {
  const w = await testWorld();
  const payment = w.f.payment({ amount: 100, unallocated: 100 });
  const refund = w.call("M33.A01", { paymentId: payment.id, amount: 40 });
  w.f.refund({ paymentId: payment.id, contactId: payment.contactId, amount: 50, status: "executed", executedAt: w.f.now() });
  assert.equal(failure(() => w.call("M33.A05", { refundId: refund.id, amount: 60 })).code, "CONFLICT");
  const resized = w.call("M33.A05", { refundId: refund.id, amount: 50 });
  assert.equal(resized.amount, 50);
  const approved = w.call("M33.A07", { refundId: refund.id, note: "ok" });
  assert.equal(approved.status, "approved");
  assert.equal(failure(() => w.call("M33.A05", { refundId: refund.id, amount: 10 })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M33.A07", { refundId: refund.id })).code, "CONFLICT");
  const fresh = w.f.payment({ amount: 40, unallocated: 40 });
  const other = w.call("M33.A01", { paymentId: fresh.id, amount: 10 });
  const rejected = w.call("M33.A08", { refundId: other.id, note: "no" });
  assert.equal(rejected.status, "rejected");
  assert.equal(failure(() => w.call("M33.A08", { refundId: other.id })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M33.A09", { refundId: other.id })).code, "CONFLICT");
  const listed = w.call("M33.A03", { paymentId: payment.id });
  assert.equal(listed.total, 2);
});

test("execute reopens invoices newest allocation first, including two peels of one invoice", async () => {
  const w = await testWorld();
  const contact = w.f.contact();
  const older = paidInvoice(w, contact.id, 30);
  const newer = paidInvoice(w, contact.id, 20);
  const same = paidInvoice(w, contact.id, 20);
  const payment = w.f.payment({
    contactId: contact.id,
    amount: 100,
    unallocated: 40,
    allocations: [
      { invoiceId: older.id, amount: 30, at: "2026-10-01T14:00:00.000Z" },
      { invoiceId: newer.id, amount: 20, at: "2026-10-10T14:00:00.000Z" },
      { invoiceId: same.id, amount: 10, at: "2026-10-10T14:00:00.000Z" },
    ],
  });
  // Newest at is the tie: later index (same, 10) peels before newer (20). Refund 25 takes 10 + 15.
  const refund = w.f.refund({ paymentId: payment.id, contactId: contact.id, amount: 25, status: "approved", decidedBy: "us_1", decidedAt: w.f.now() });
  const done = w.call("M33.A09", { refundId: refund.id });
  assert.equal(done.status, "executed");
  const after = w.store.get<Payment>("payments", payment.id);
  assert.equal(after?.unallocated, 65);
  assert.deepEqual(
    after?.allocations.map((a) => [a.invoiceId, a.amount]),
    [
      [older.id, 30],
      [newer.id, 5],
    ],
  );
  assert.equal(w.store.get<Invoice>("invoices", same.id)?.status, "open");
  assert.equal(w.store.get<Invoice>("invoices", same.id)?.amountPaid, 10);
  assert.equal(w.store.get<Invoice>("invoices", same.id)?.amountDue, 10);
  assert.equal(w.store.get<Invoice>("invoices", newer.id)?.amountPaid, 5);
  assert.equal(w.store.get<Invoice>("invoices", newer.id)?.status, "open");
  assert.equal(w.store.get<Invoice>("invoices", older.id)?.status, "paid");
  assert.equal(w.call("M33.A10", { refundId: refund.id }).status, "executed");

  const twice = paidInvoice(w, contact.id, 20);
  const stacked = w.f.payment({
    contactId: contact.id,
    amount: 20,
    unallocated: 0,
    allocations: [
      { invoiceId: twice.id, amount: 10, at: "2026-10-02T14:00:00.000Z" },
      { invoiceId: twice.id, amount: 10, at: "2026-10-08T14:00:00.000Z" },
    ],
  });
  const peel = w.f.refund({ paymentId: stacked.id, contactId: contact.id, amount: 15, status: "approved", decidedBy: "us_1", decidedAt: w.f.now() });
  w.call("M33.A09", { refundId: peel.id });
  const reopened = w.store.get<Invoice>("invoices", twice.id);
  assert.equal(reopened?.amountPaid, 5);
  assert.equal(reopened?.amountDue, 15);
  assert.equal(reopened?.status, "open");
  assert.equal(w.store.get<Payment>("payments", stacked.id)?.unallocated, 15);
});

test("a cash payment is declined and its allocations are left alone", async () => {
  const w = await testWorld();
  const contact = w.f.contact();
  const inv = paidInvoice(w, contact.id, 40);
  const payment = w.f.payment({
    contactId: contact.id,
    amount: 40,
    method: "cash",
    unallocated: 0,
    allocations: [{ invoiceId: inv.id, amount: 40, at: w.f.at(-1) }],
  });
  const refund = w.f.refund({ paymentId: payment.id, contactId: contact.id, amount: 40, status: "approved", decidedBy: "us_1", decidedAt: w.f.now() });
  const failed = w.call("M33.A09", { refundId: refund.id });
  assert.equal(failed.status, "failed");
  assert.equal(failed.failure, "Cash payments can't be reversed by the processor");
  const after = w.store.get<Payment>("payments", payment.id);
  assert.equal(after?.status, "succeeded");
  assert.deepEqual(after?.allocations, payment.allocations);
  assert.equal(after?.unallocated, 0);
  assert.equal(w.store.get<Invoice>("invoices", inv.id)?.status, "paid");
  assert.equal(w.call("M33.A10", { refundId: refund.id }).failure, failed.failure);
});
