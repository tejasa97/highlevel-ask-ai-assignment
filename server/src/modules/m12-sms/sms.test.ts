import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";

test("segments: GSM-7 160 / 153 per part; an emoji makes it UCS-2", async () => {
  const w = await testWorld();
  const seg = (body: string) => w.call("M12.A02", { body });
  assert.deepEqual([seg("a".repeat(160)).segments, seg("a".repeat(161)).segments], [1, 2]);
  const u = seg("Confirmed 🎉");
  assert.deepEqual([u.encoding, u.nonGsmCharacters], ["UCS-2", ["🎉"]]);
  assert.equal(seg("{}").units, 4, "extension characters count twice");
});

test("send: delivered to a mobile, failed to a landline (…0000); no phone CONFLICT", async () => {
  const w = await testWorld();
  const ok = w.call("M12.A03", { contactId: w.f.contact({ phone: "+15550123456" }).id, body: "Hi" });
  assert.equal(ok.status, "delivered");
  const land = w.call("M12.A03", { contactId: w.f.contact({ phone: "+15550120000" }).id, body: "Hi" });
  assert.equal(land.status, "failed");
  assert.match(w.call("M12.A08", { smsId: land.id }).failureReason, /landline/);
  assert.equal(failure(() => w.call("M12.A03", { contactId: w.f.contact({ phone: null }).id, body: "Hi" })).code, "CONFLICT");
});

test("send: refused for do-not-disturb and SMS opt-outs; drafts are sent by id alone", async () => {
  const w = await testWorld();
  const dnd = w.f.contact({ phone: "+15550123456", preferences: { email: true, sms: true, call: true, dnd: true } });
  assert.equal(failure(() => w.call("M12.A03", { contactId: dnd.id, body: "Hi" })).code, "CONFLICT");
  const c = w.f.contact({ phone: "+15550123457" });
  const d = w.call("M12.A01", { contactId: c.id, body: "Draft" });
  assert.equal(failure(() => w.call("M12.A03", { smsId: d.id, body: "x" })).code, "INVALID");
  w.call("M12.A10", { contactId: c.id });
  assert.match(failure(() => w.call("M12.A03", { smsId: d.id })).message, /opted out/);
});

test("receive: STOP opts the sender out; unknown numbers NOT_FOUND", async () => {
  const w = await testWorld();
  const c = w.f.contact({ phone: "+15550123458" });
  const r = w.call("M12.A09", { from: c.phone!, body: " Stop " });
  assert.deepEqual([r.optedOut, r.direction, r.contactId], [true, "inbound", c.id]);
  assert.equal(w.call("M01.A02", { contactId: c.id }).preferences.sms, false);
  assert.equal(failure(() => w.call("M12.A03", { contactId: c.id, body: "Hi" })).code, "CONFLICT");
  assert.equal(w.call("M12.A09", { from: c.phone!, body: "sorry, ignore that" }).optedOut, false);
  assert.equal(failure(() => w.call("M12.A09", { from: "+19999999999", body: "hi" })).code, "NOT_FOUND");
});

test("receive: a second STOP from someone already opted out is recorded, not refused", async () => {
  const w = await testWorld();
  const c = w.f.contact({ phone: "+15550123461" });
  w.call("M12.A09", { from: c.phone!, body: "STOP" });
  const again = w.call("M12.A09", { from: c.phone!, body: "stop" });
  assert.equal(again.optedOut, true);
  assert.equal(w.call("M12.A07", { contactId: c.id, direction: "inbound" }).total, 2);
});

test("send: consent is checked against the number the draft will go to, not the contact's current one", async () => {
  const w = await testWorld();
  const c = w.f.contact({ phone: "+15550123462" });
  const draft = w.call("M12.A01", { contactId: c.id, body: "Hi" });
  w.call("M12.A10", { contactId: c.id });
  w.store.update("contacts", c.id, { phone: "+15550123463", preferences: { ...c.preferences, sms: true } });
  assert.match(failure(() => w.call("M12.A03", { smsId: draft.id })).message, /opted out/);
});

test("schedule and cancel", async () => {
  const w = await testWorld();
  const c = w.f.contact({ phone: "+15550123459" });
  assert.equal(failure(() => w.call("M12.A04", { contactId: c.id, body: "x", sendAt: w.f.at(0, 9) })).code, "INVALID", "earlier today");
  const s = w.call("M12.A04", { contactId: c.id, body: "x", sendAt: w.f.at(1, 9) });
  assert.equal(s.status, "scheduled");
  assert.equal(w.call("M12.A05", { smsId: s.id }).status, "cancelled");
  assert.equal(failure(() => w.call("M12.A05", { smsId: s.id })).code, "CONFLICT");
});

test("search: seeded inbound texts, newest first", async () => {
  const w = await testWorld();
  const items = w.call("M12.A07", { direction: "inbound" }).items as { sentAt: string }[];
  assert.ok(items.length >= 3);
  assert.deepEqual(items.map((s) => s.sentAt), [...items.map((s) => s.sentAt)].sort().reverse());
});
