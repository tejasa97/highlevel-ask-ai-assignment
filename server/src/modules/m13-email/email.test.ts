import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";

const DND = { email: true, sms: true, call: true, dnd: true };

test("send: delivers, opens the conversation; a 'bounce' domain bounces", async () => {
  const w = await testWorld();
  const c = w.f.contact({ email: "amy@acme.example" });
  const e = w.call("M13.A03", { contactId: c.id, subject: "Hi", body: "Hello" });
  assert.deepEqual([e.status, e.kind, e.sentAt], ["delivered", "general", w.clock.now().toISOString()]);
  assert.equal(w.call("M11.A01", { conversationId: e.conversationId }).lastDirection, "outbound");
  const b = w.f.contact({ email: "x@bounce.example" });
  const out = w.call("M13.A03", { contactId: b.id, subject: "Hi", body: "Hello" });
  assert.equal(out.status, "bounced");
  assert.ok(w.call("M13.A08", { emailId: out.id }).failureReason);
});

test("send: consent is checked; drafts can be sent once", async () => {
  const w = await testWorld();
  const dnd = w.f.contact({ preferences: DND });
  assert.match(failure(() => w.call("M13.A03", { contactId: dnd.id, subject: "Hi", body: "Hello" })).message, /do-not-disturb/);
  const c = w.f.contact();
  w.call("M13.A10", { contactId: c.id });
  assert.match(failure(() => w.call("M13.A03", { contactId: c.id, subject: "Hi", body: "Hello" })).message, /unsubscribed/);
  assert.equal(failure(() => w.call("M13.A10", { contactId: c.id })).code, "CONFLICT", "already unsubscribed");

  const ok = w.f.contact();
  const d = w.call("M13.A01", { contactId: ok.id, subject: "Draft", body: "Body" });
  assert.equal(failure(() => w.call("M13.A03", { emailId: d.id, subject: "x" })).code, "INVALID", "emailId and fields together");
  assert.equal(w.call("M13.A03", { emailId: d.id }).status, "delivered");
  assert.equal(failure(() => w.call("M13.A03", { emailId: d.id })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M13.A03", { contactId: ok.id, subject: "Hi" })).code, "INVALID", "no body");
});

test("invoice reminder drafts: filled in, go to the invoice's contact, and ignore marketing preferences", async () => {
  const w = await testWorld();
  const c = w.f.contact({ preferences: DND });
  const inv = w.f.invoice({ contactId: c.id, status: "open", issueDate: w.f.day(-40), dueDate: w.f.day(-10) });
  const d = w.call("M13.A01", { invoiceId: inv.id });
  assert.deepEqual([d.kind, d.contactId, d.invoiceId], ["invoice_reminder", c.id, inv.id]);
  assert.match(d.subject, /10 days overdue/);
  const pre = w.call("M13.A02", { emailId: d.id });
  assert.deepEqual([pre.canSend, pre.blockers], [true, []]);
  w.call("M13.A03", { emailId: d.id });
  assert.equal(w.call("M28.A02", { invoiceId: inv.id }).reminders.length, 1, "logged on the invoice");
  // A second draft is fine, but sending it within 24 hours isn't.
  const again = w.call("M13.A01", { invoiceId: inv.id });
  assert.match(w.call("M13.A02", { emailId: again.id }).blockers.join(), /24 hours/);
  assert.equal(failure(() => w.call("M13.A01", { invoiceId: inv.id, contactId: w.f.contact().id })).code, "INVALID");
  assert.equal(failure(() => w.call("M13.A01", { invoiceId: w.f.invoice().id })).code, "CONFLICT", "draft invoice");
});

test("preview lists every blocker", async () => {
  const w = await testWorld();
  const c = w.f.contact({ preferences: DND });
  const e = w.f.email({ contactId: c.id, to: c.email!, status: "delivered" });
  const pre = w.call("M13.A02", { emailId: e.id });
  assert.equal(pre.canSend, false);
  assert.equal(pre.blockers.length, 2);
});

test("schedule: future only; cancel only while scheduled", async () => {
  const w = await testWorld();
  const c = w.f.contact();
  assert.equal(failure(() => w.call("M13.A04", { contactId: c.id, subject: "s", body: "b", sendAt: w.f.at(-1) })).code, "INVALID");
  const s = w.call("M13.A04", { contactId: c.id, subject: "s", body: "b", sendAt: w.f.at(1, 9) });
  assert.equal(s.status, "scheduled");
  assert.equal(w.call("M13.A05", { emailId: s.id }).status, "cancelled");
  assert.equal(failure(() => w.call("M13.A05", { emailId: s.id })).code, "CONFLICT");
});

test("receive: lands unread in the sender's conversation; unknown senders NOT_FOUND", async () => {
  const w = await testWorld();
  const c = w.f.contact();
  const e = w.call("M13.A09", { from: c.email!.toUpperCase(), subject: "Re: hi", body: "Thursday works" });
  assert.deepEqual([e.contactId, e.direction, e.status], [c.id, "inbound", "received"]);
  assert.equal(w.call("M11.A01", { conversationId: e.conversationId }).unread, true);
  assert.equal(failure(() => w.call("M13.A09", { from: "nobody@nowhere.example", subject: "s", body: "b" })).code, "NOT_FOUND");
});

test("search: seeded reminders and campaign email", async () => {
  const w = await testWorld();
  const reminders = w.call("M13.A07", { kind: "invoice_reminder" }).items as { invoiceId: string }[];
  assert.deepEqual(new Set(reminders.map((r) => r.invoiceId)), new Set(["inv_4", "inv_5", "inv_6"]));
  assert.ok((w.call("M13.A07", { campaignId: "cp_1" }).items as unknown[]).length > 0);
});
