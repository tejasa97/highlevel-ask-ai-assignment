import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";

test("messages in and out keep one conversation per person, across channels", async () => {
  const w = await testWorld();
  const c = w.f.contact({ phone: "+15550123456" });
  const out = w.call("M13.A03", { contactId: c.id, subject: "Hi", body: "Hello" });
  const back = w.call("M12.A09", { from: c.phone!, body: "Hey!" });
  assert.equal(back.conversationId, out.conversationId);
  const conv = w.call("M11.A01", { conversationId: out.conversationId });
  assert.deepEqual([conv.channels, conv.unread, conv.lastDirection], [["email", "sms"], true, "inbound"]);
  const s = w.call("M11.A09", { conversationId: conv.id });
  assert.deepEqual([s.inbound, s.outbound, s.waitingOn], [{ sms: 1, email: 0 }, { sms: 0, email: 1 }, "team"]);
});

test("close, reopen, and an inbound message reopens a closed conversation", async () => {
  const w = await testWorld();
  const c = w.f.contact({ phone: "+15550123456" });
  const id = w.call("M12.A03", { contactId: c.id, body: "Hi" }).conversationId;
  w.call("M11.A06", { conversationId: id });
  assert.equal(failure(() => w.call("M11.A06", { conversationId: id })).code, "CONFLICT");
  assert.equal(w.call("M11.A09", { conversationId: id }).waitingOn, "nobody");
  w.call("M12.A09", { from: c.phone!, body: "one more thing" });
  assert.equal(w.call("M11.A01", { conversationId: id }).status, "open");
  assert.equal(failure(() => w.call("M11.A07", { conversationId: id })).code, "CONFLICT");
});

test("read state and owner must change; owners must be active", async () => {
  const w = await testWorld();
  const conv = w.f.conversation({ unread: true });
  w.call("M11.A04", { conversationId: conv.id });
  assert.equal(failure(() => w.call("M11.A04", { conversationId: conv.id })).code, "CONFLICT");
  w.call("M11.A03", { conversationId: conv.id, ownerId: "us_5" });
  assert.equal(failure(() => w.call("M11.A03", { conversationId: conv.id, ownerId: "us_5" })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M11.A03", { conversationId: conv.id, ownerId: "us_9" })).code, "CONFLICT", "deactivated");
});

test("unanswered: seeded leads who never replied to our follow-up", async () => {
  const w = await testWorld();
  const silent = w.call("M11.A10", { waitingOn: "contact", personType: "lead" }).items as { leadId: string; hoursWaiting: number }[];
  assert.ok(silent.length > 0);
  assert.ok(silent.every((x) => x.leadId));
  assert.deepEqual(silent.map((x) => x.hoursWaiting), [...silent.map((x) => x.hoursWaiting)].sort((a, b) => b - a), "longest wait first");
  const waitingOnUs = w.call("M11.A10", { waitingOn: "team" }).items as unknown[];
  assert.ok(waitingOnUs.length > 0);
});

test("comments are internal: they don't change who's waiting", async () => {
  const w = await testWorld();
  const before = w.call("M11.A09", { conversationId: "cv_1" });
  const after = w.call("M11.A08", { conversationId: "cv_1", body: "Raj, can you take this?" });
  assert.equal(after.comments.at(-1).body, "Raj, can you take this?");
  assert.equal(w.call("M11.A09", { conversationId: "cv_1" }).waitingOn, before.waitingOn);
});
