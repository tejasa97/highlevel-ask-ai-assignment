import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";

function openInvoice(w: Awaited<ReturnType<typeof testWorld>>, total = 500) {
  const c = w.f.contact();
  return w.f.invoice({ contactId: c.id, status: "open", issueDate: w.f.day(-5), dueDate: w.f.day(25), lineItems: [{ description: "S", quantity: 1, unitPrice: total, amount: total }], total, amountDue: total });
}

test("request: defaults to what's due on the invoice; not more; drafts can't take one", async () => {
  const w = await testWorld();
  const inv = openInvoice(w);
  const r = w.call("M29.A01", { contactId: inv.contactId, invoiceId: inv.id });
  assert.deepEqual([r.amount, r.status, r.link], [500, "pending", `https://pay.ourco.example/r/${r.id}`]);
  assert.equal(failure(() => w.call("M29.A01", { contactId: inv.contactId, invoiceId: inv.id, amount: 501 })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M29.A01", { contactId: inv.contactId })).code, "INVALID", "no amount");
  assert.equal(failure(() => w.call("M29.A01", { contactId: "ct_31", invoiceId: inv.id })).code, "INVALID", "someone else's invoice");
  const d = w.f.invoice();
  assert.equal(failure(() => w.call("M29.A01", { contactId: d.contactId, invoiceId: d.id })).code, "CONFLICT");
});

test("record: paying a request applies it to the invoice and marks both paid", async () => {
  const w = await testWorld();
  const inv = openInvoice(w);
  const r = w.call("M29.A01", { contactId: inv.contactId, invoiceId: inv.id });
  const p = w.call("M29.A04", { contactId: inv.contactId, amount: 500, paymentRequestId: r.id });
  assert.deepEqual([p.status, p.unallocated, p.allocations.length], ["succeeded", 0, 1]);
  assert.equal(w.call("M28.A02", { invoiceId: inv.id }).status, "paid");
  assert.deepEqual([w.call("M29.A02", { paymentRequestId: r.id }).status, w.call("M29.A02", { paymentRequestId: r.id }).paymentId], ["paid", p.id]);
  assert.equal(failure(() => w.call("M29.A03", { paymentRequestId: r.id })).code, "CONFLICT", "paid requests can't be cancelled");
});

test("record: a payment that isn't the request's amount can't settle the request", async () => {
  const w = await testWorld();
  const inv = openInvoice(w);
  const r = w.call("M29.A01", { contactId: inv.contactId, invoiceId: inv.id });
  const short = failure(() => w.call("M29.A04", { contactId: inv.contactId, amount: 100, paymentRequestId: r.id }));
  assert.equal(short.code, "CONFLICT");
  assert.match(short.message, /500/);
  assert.equal(w.call("M29.A02", { paymentRequestId: r.id }).status, "pending");
  assert.equal(w.call("M29.A04", { contactId: inv.contactId, amount: 100, paymentRequestId: r.id, outcome: "failed" }).status, "failed");
});

test("record: overpaying an invoice CONFLICT; failure code only with failed; failed payments touch nothing", async () => {
  const w = await testWorld();
  const inv = openInvoice(w);
  assert.equal(failure(() => w.call("M29.A04", { contactId: inv.contactId, amount: 600, invoiceId: inv.id })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M29.A04", { contactId: inv.contactId, amount: 100, failureCode: "expired_card" })).code, "INVALID");
  const p = w.call("M29.A04", { contactId: inv.contactId, amount: 500, invoiceId: inv.id, outcome: "failed", failureCode: "insufficient_funds" });
  assert.deepEqual([p.status, p.unallocated, p.allocations.length], ["failed", 0, 0]);
  assert.equal(w.call("M28.A02", { invoiceId: inv.id }).amountDue, 500);
  const why = w.call("M29.A10", { paymentId: p.id });
  assert.equal(why.code, "insufficient_funds");
  assert.ok(why.advice.length > 0);
  assert.equal(failure(() => w.call("M29.A09", { paymentId: p.id })).code, "CONFLICT", "no receipt for a failed payment");
  assert.equal(failure(() => w.call("M29.A04", { contactId: inv.contactId, amount: 1 }, "us_4")).code, "PERMISSION");
});

test("allocate: as much as fits by default; partial payments leave the invoice open; removing reopens it", async () => {
  const w = await testWorld();
  const inv = openInvoice(w, 300);
  const p = w.f.payment({ contactId: inv.contactId, amount: 500 });
  const a = w.call("M29.A07", { paymentId: p.id, invoiceId: inv.id });
  assert.deepEqual([a.unallocated, w.call("M28.A02", { invoiceId: inv.id }).status], [200, "paid"]);
  assert.equal(failure(() => w.call("M29.A07", { paymentId: p.id, invoiceId: inv.id })).code, "CONFLICT", "already paid");
  const back = w.call("M29.A08", { paymentId: p.id, invoiceId: inv.id });
  assert.deepEqual([back.unallocated, back.allocations.length], [500, 0]);
  const reopened = w.call("M28.A02", { invoiceId: inv.id });
  assert.deepEqual([reopened.status, reopened.amountDue, reopened.paidAt], ["open", 300, null]);
  w.call("M29.A07", { paymentId: p.id, invoiceId: inv.id, amount: 100 });
  assert.equal(w.call("M28.A02", { invoiceId: inv.id }).amountDue, 200);
  assert.equal(failure(() => w.call("M29.A07", { paymentId: p.id, invoiceId: openInvoice(w).id })).code, "INVALID", "another contact's invoice");
});

test("receipts list the invoices paid", async () => {
  const w = await testWorld();
  const inv = openInvoice(w);
  const p = w.call("M29.A04", { contactId: inv.contactId, amount: 500, invoiceId: inv.id, method: "check" });
  const r = w.call("M29.A09", { paymentId: p.id });
  assert.match(r.receiptNumber, /^RCPT-\d{5}$/);
  assert.deepEqual([r.method, r.invoices], ["check", [{ number: inv.number, amount: 500 }]]);
});

test("search: seeded failed and unallocated payments", async () => {
  const w = await testWorld();
  const failed = w.call("M29.A06", { status: "failed" }).items as { failure: { code: string } }[];
  assert.deepEqual(failed.map((p) => p.failure.code), ["card_declined"]);
  const loose = w.call("M29.A06", { unallocated: true }).items as { method: string; unallocated: number }[];
  assert.ok(loose.some((p) => p.method === "bank_transfer" && p.unallocated === 300));
  assert.equal((w.call("M29.A06", { invoiceId: "inv_1" }).items as unknown[]).length, 1);
});
