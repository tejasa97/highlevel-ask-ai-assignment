import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";

test("create: line items total up; past due date INVALID; archived contact CONFLICT", async () => {
  const w = await testWorld();
  const inv = w.call("M28.A01", { contactId: "ct_31", lineItems: [{ description: "Audit", unitPrice: 750 }, { description: "Hours", quantity: 2.5, unitPrice: 99.99 }] });
  assert.deepEqual([inv.status, inv.total, inv.amountDue, inv.issueDate], ["draft", 999.98, 999.98, null]);
  assert.match(inv.number, /^INV-\d+$/);
  assert.equal(failure(() => w.call("M28.A01", { contactId: "ct_31", dueDate: w.f.day(-1) })).code, "INVALID");
  const archived = w.f.contact({ status: "archived" });
  assert.equal(failure(() => w.call("M28.A01", { contactId: archived.id })).code, "CONFLICT");
});

test("only drafts take line items or edits; updating needs a field", async () => {
  const w = await testWorld();
  const d = w.f.invoice();
  assert.equal(w.call("M28.A04", { invoiceId: d.id, description: "Extra", quantity: 2, unitPrice: 120 }).total, 740);
  assert.equal(failure(() => w.call("M28.A05", { invoiceId: d.id })).code, "INVALID");
  assert.equal(w.call("M28.A05", { invoiceId: d.id, lineItems: [{ description: "Only", unitPrice: 10 }] }).amountDue, 10);
  const open = w.f.invoice({ status: "open", issueDate: w.f.day(-1), dueDate: w.f.day(29) });
  assert.equal(failure(() => w.call("M28.A04", { invoiceId: open.id, description: "x", unitPrice: 1 })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M28.A05", { invoiceId: open.id, memo: "x" })).code, "CONFLICT");
});

test("issue: opens the invoice, due in 30 days, and emails it even to a contact who opted out of marketing", async () => {
  const w = await testWorld();
  const c = w.f.contact({ preferences: { email: false, sms: true, call: true, dnd: true } });
  const d = w.f.invoice({ contactId: c.id });
  const inv = w.call("M28.A07", { invoiceId: d.id });
  assert.deepEqual([inv.status, inv.issueDate, inv.dueDate], ["open", w.f.today, w.f.day(30)]);
  const emails = w.call("M13.A07", { contactId: c.id }).items as { kind: string; invoiceId: string }[];
  assert.deepEqual(emails.map((e) => [e.kind, e.invoiceId]), [["invoice", d.id]]);
  assert.equal(failure(() => w.call("M28.A07", { invoiceId: d.id })).code, "CONFLICT", "already issued");
});

test("issue: an empty draft can't be issued; only billing can issue", async () => {
  const w = await testWorld();
  const empty = w.f.invoice({ lineItems: [], total: 0, amountDue: 0 });
  assert.equal(failure(() => w.call("M28.A07", { invoiceId: empty.id })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M28.A07", { invoiceId: w.f.invoice().id }, "us_4")).code, "PERMISSION");
});

test("reminders: open invoices only, one per 24 hours, logged on the invoice", async () => {
  const w = await testWorld();
  const inv = w.f.invoice({ status: "open", issueDate: w.f.day(-40), dueDate: w.f.day(-10) });
  const r = w.call("M28.A08", { invoiceId: inv.id });
  assert.equal(r.status, "delivered");
  assert.equal(r.invoice.reminders.length, 1);
  assert.equal(r.invoice.lastReminderAt, w.clock.now().toISOString());
  assert.match(failure(() => w.call("M28.A08", { invoiceId: inv.id })).message, /24 hours/);
  assert.equal(failure(() => w.call("M28.A08", { invoiceId: w.f.invoice().id })).code, "CONFLICT", "draft");
  // inv_4 got one 2 days ago: allowed again.
  assert.equal(w.call("M28.A08", { invoiceId: "inv_4" }).invoice.reminders.length, 2);
});

test("void: drafts and unpaid open invoices; not once money is on it", async () => {
  const w = await testWorld();
  const v = w.call("M28.A09", { invoiceId: w.f.invoice().id, reason: "mistake" });
  assert.deepEqual([v.status, v.amountDue, v.voidReason], ["void", 0, "mistake"]);
  assert.equal(failure(() => w.call("M28.A09", { invoiceId: v.id, reason: "again" })).code, "CONFLICT");
  assert.match(failure(() => w.call("M28.A09", { invoiceId: "inv_6", reason: "x" })).message, /M29\.A08/, "inv_6 is part paid");
});

test("due date: draft or open, not in the past, must change", async () => {
  const w = await testWorld();
  const inv = w.f.invoice({ status: "open", issueDate: w.f.day(-10), dueDate: w.f.day(-2) });
  assert.equal(w.call("M28.A06", { invoiceId: inv.id, dueDate: w.f.day(14) }).dueDate, w.f.day(14));
  assert.equal(w.call("M28.A02", { invoiceId: inv.id }).daysOverdue, 0);
  assert.equal(failure(() => w.call("M28.A06", { invoiceId: inv.id, dueDate: w.f.day(14) })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M28.A06", { invoiceId: inv.id, dueDate: w.f.day(-1) })).code, "INVALID");
  assert.equal(failure(() => w.call("M28.A06", { invoiceId: "inv_1", dueDate: w.f.day(5) })).code, "CONFLICT", "paid");
});

test("overdue list: seeded invoices, most overdue first; 'more than 15 days' leaves out the 5-day one", async () => {
  const w = await testWorld();
  const all = w.call("M28.A10", {}).items as { number: string; daysOverdue: number; amountDue: number }[];
  assert.deepEqual(all.map((i) => i.daysOverdue), [45, 30, 20, 18, 5]);
  const over15 = w.call("M28.A10", { minDaysOverdue: 16 }).items as { daysOverdue: number }[];
  assert.ok(over15.every((i) => i.daysOverdue > 15) && over15.length === 4);
  assert.equal(all[0]!.amountDue, w.call("M28.A02", { invoiceId: "inv_6" }).amountDue);
  const search = w.call("M28.A03", { overdue: true }).items as unknown[];
  assert.equal(search.length, 5);
});

test("get: shows the payments applied to it", async () => {
  const w = await testWorld();
  const inv = w.call("M28.A02", { invoiceId: "inv_6" });
  assert.equal(inv.payments.length, 1);
  assert.equal(inv.amountPaid, 400);
  assert.equal(inv.daysOverdue, 45);
});
