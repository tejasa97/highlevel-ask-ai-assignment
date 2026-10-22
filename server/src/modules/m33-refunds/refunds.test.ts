import assert from "node:assert/strict";
import { test } from "node:test";
import type { Invoice } from "../m28-invoices/schema.js";
import type { Payment } from "../m29-payments/schema.js";
import { failure, testWorld } from "../../testkit.js";

type World = Awaited<ReturnType<typeof testWorld>>;

function paidInvoice(w: World, contactId: string, total: number): Invoice {
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

async function requestedRefund() {
  const w = await testWorld();
  const payment = w.f.payment({ amount: 50, unallocated: 50 });
  const refund = w.call("M33.A01", { paymentId: payment.id, amount: 20, reason: "x" });
  return { w, payment, refund };
}

// A $100 payment with requested 40, approved 20, executed 10, rejected 30 and failed 15 refunds against it.
async function mixedRefunds() {
  const w = await testWorld();
  const payment = w.f.payment({ amount: 100, unallocated: 100 });
  w.f.refund({ paymentId: payment.id, contactId: payment.contactId, amount: 40, status: "requested" });
  w.f.refund({ paymentId: payment.id, contactId: payment.contactId, amount: 20, status: "approved" });
  w.f.refund({ paymentId: payment.id, contactId: payment.contactId, amount: 10, status: "executed", executedAt: w.f.now() });
  w.f.refund({ paymentId: payment.id, contactId: payment.contactId, amount: 30, status: "rejected" });
  w.f.refund({ paymentId: payment.id, contactId: payment.contactId, amount: 15, status: "failed", failure: "no" });
  return { w, payment };
}

// A $100 payment with a requested 40 refund and a $50 executed one.
async function resizableRefund() {
  const w = await testWorld();
  const payment = w.f.payment({ amount: 100, unallocated: 100 });
  const refund = w.call("M33.A01", { paymentId: payment.id, amount: 40 });
  w.f.refund({ paymentId: payment.id, contactId: payment.contactId, amount: 50, status: "executed", executedAt: w.f.now() });
  return { w, payment, refund };
}

function approvedRefund(w: World, paymentId: string, contactId: string, amount: number) {
  return w.f.refund({ paymentId, contactId, amount, status: "approved", decidedBy: "us_1", decidedAt: w.f.now() });
}

async function cashPayment() {
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
  return { w, contact, inv, payment };
}

test("M33.A01 create refuses an unknown payment", async () => {
  const w = await testWorld();
  assert.equal(failure(() => w.call("M33.A01", { paymentId: "pay_99999" })).code, "NOT_FOUND");
});

test("M33.A04 reason refuses a no-op", async () => {
  const { w, refund } = await requestedRefund();
  assert.equal(failure(() => w.call("M33.A04", { refundId: refund.id, reason: "x" })).code, "CONFLICT");
});

test("M33.A05 amount refuses a no-op", async () => {
  const { w, refund } = await requestedRefund();
  assert.equal(failure(() => w.call("M33.A05", { refundId: refund.id, amount: 20 })).code, "CONFLICT");
});

test("M33.A07 approve needs the refund permission", async () => {
  const { w, refund } = await requestedRefund();
  const sales = w.f.user({ roles: ["sales"] });
  assert.equal(failure(() => w.call("M33.A07", { refundId: refund.id }, sales.id)).code, "PERMISSION");
});

test("M33.A08 reject needs the refund permission", async () => {
  const { w, refund } = await requestedRefund();
  const sales = w.f.user({ roles: ["sales"] });
  assert.equal(failure(() => w.call("M33.A08", { refundId: refund.id }, sales.id)).code, "PERMISSION");
});

test("M33.A09 execute needs the refund permission", async () => {
  const { w, refund } = await requestedRefund();
  const sales = w.f.user({ roles: ["sales"] });
  assert.equal(failure(() => w.call("M33.A09", { refundId: refund.id }, sales.id)).code, "PERMISSION");
});

test("M33.A02 unknown input field is INVALID", async () => {
  const { w, refund } = await requestedRefund();
  assert.equal(failure(() => w.call("M33.A02", { refundId: refund.id, madeUp: 1 })).code, "INVALID");
});

test("M33.A06 refundable balance ignores failed and rejected refunds", async () => {
  const { w, payment } = await mixedRefunds();
  const balance = w.call("M33.A06", { paymentId: payment.id });
  assert.equal(balance.refundable, 30);
  assert.equal(balance.pending, 60);
  assert.equal(balance.executed, 10);
});

test("M33.A01 create cannot exceed the refundable balance", async () => {
  const { w, payment } = await mixedRefunds();
  const over = failure(() => w.call("M33.A01", { paymentId: payment.id, amount: 31 }));
  assert.equal(over.code, "CONFLICT");
});

test("M33.A01 create defaults to the whole refundable balance", async () => {
  const { w, payment } = await mixedRefunds();
  const created = w.call("M33.A01", { paymentId: payment.id });
  assert.equal(created.amount, 30);
  assert.equal(w.call("M33.A06", { paymentId: payment.id }).refundable, 0);
});

test("M33.A01 create refuses a failed payment", async () => {
  const w = await testWorld();
  assert.equal(failure(() => w.call("M33.A01", { paymentId: w.f.payment({ status: "failed", failure: { code: "card_declined", message: "no" }, unallocated: 0 }).id })).code, "CONFLICT");
});

test("M33.A05 resize is limited to the refundable balance", async () => {
  const { w, refund } = await resizableRefund();
  assert.equal(failure(() => w.call("M33.A05", { refundId: refund.id, amount: 60 })).code, "CONFLICT");
  const resized = w.call("M33.A05", { refundId: refund.id, amount: 50 });
  assert.equal(resized.amount, 50);
});

test("M33.A07 approve only from requested, and it freezes the amount", async () => {
  const { w, refund } = await resizableRefund();
  const approved = w.call("M33.A07", { refundId: refund.id, note: "ok" });
  assert.equal(approved.status, "approved");
  assert.equal(failure(() => w.call("M33.A05", { refundId: refund.id, amount: 10 })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M33.A07", { refundId: refund.id })).code, "CONFLICT");
});

test("M33.A08 reject only from requested, and a rejected refund can't be executed", async () => {
  const w = await testWorld();
  const fresh = w.f.payment({ amount: 40, unallocated: 40 });
  const other = w.call("M33.A01", { paymentId: fresh.id, amount: 10 });
  const rejected = w.call("M33.A08", { refundId: other.id, note: "no" });
  assert.equal(rejected.status, "rejected");
  assert.equal(failure(() => w.call("M33.A08", { refundId: other.id })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M33.A09", { refundId: other.id })).code, "CONFLICT");
});

test("M33.A03 list filters by payment", async () => {
  const { w, payment } = await resizableRefund();
  const listed = w.call("M33.A03", { paymentId: payment.id });
  assert.equal(listed.total, 2);
});

test("M33.A09 execute reopens invoices newest allocation first", async () => {
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
  const refund = approvedRefund(w, payment.id, contact.id, 25);
  const done = w.call("M33.A09", { refundId: refund.id });
  assert.equal(done.status, "executed");
  const after = w.store.get<Payment>("payments", payment.id);
  assert.equal(after?.unallocated, 40);
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
});

test("M33.A09 execute can peel one invoice twice", async () => {
  const w = await testWorld();
  const contact = w.f.contact();
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
  const peel = approvedRefund(w, stacked.id, contact.id, 15);
  w.call("M33.A09", { refundId: peel.id });
  const reopened = w.store.get<Invoice>("invoices", twice.id);
  assert.equal(reopened?.amountPaid, 5);
  assert.equal(reopened?.amountDue, 15);
  assert.equal(reopened?.status, "open");
  assert.equal(w.store.get<Payment>("payments", stacked.id)?.unallocated, 0);
});

test("M33.A09 execute on an unallocated payment gives the money back to the balance", async () => {
  const w = await testWorld();
  const contact = w.f.contact();
  const loose = w.f.payment({ contactId: contact.id, amount: 40, unallocated: 40 });
  const back = approvedRefund(w, loose.id, contact.id, 15);
  w.call("M33.A09", { refundId: back.id });
  assert.equal(w.store.get<Payment>("payments", loose.id)?.unallocated, 25);
});

test("M33.A01 a cash payment can't be refunded here", async () => {
  const { w, payment } = await cashPayment();
  const asked = failure(() => w.call("M33.A01", { paymentId: payment.id, amount: 40 }));
  assert.equal(asked.code, "CONFLICT");
  assert.match(asked.message, /cash/i);
  assert.equal(w.call("M33.A03", { paymentId: payment.id }).total, 0);
});

test("M33.A07 approving a refund on a cash payment is refused", async () => {
  const { w, contact, payment } = await cashPayment();
  const requested = w.f.refund({ paymentId: payment.id, contactId: contact.id, amount: 40 });
  assert.equal(failure(() => w.call("M33.A07", { refundId: requested.id })).code, "CONFLICT");
  assert.equal(w.call("M33.A02", { refundId: requested.id }).status, "requested");
});

test("M33.A09 executing a refund on a cash payment is refused and nothing is recorded as refunded", async () => {
  const { w, contact, inv, payment } = await cashPayment();
  const approved = approvedRefund(w, payment.id, contact.id, 40);
  const executed = failure(() => w.call("M33.A09", { refundId: approved.id }));
  assert.equal(executed.code, "CONFLICT");
  assert.match(executed.message, /cash/i);
  assert.equal(w.call("M33.A10", { refundId: approved.id }).status, "approved");

  const after = w.store.get<Payment>("payments", payment.id);
  assert.equal(after?.status, "succeeded");
  assert.deepEqual(after?.allocations, payment.allocations);
  assert.equal(after?.unallocated, 0);
  assert.equal(w.store.get<Invoice>("invoices", inv.id)?.status, "paid");
});
