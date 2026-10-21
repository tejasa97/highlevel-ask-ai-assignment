import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";

const DND = { email: true, sms: true, call: true, dnd: true };

test("create: names are unique (case-insensitive); owner defaults to whoever created it", async () => {
  const w = await testWorld();
  const c = w.call("M15.A01", { name: "Winter Check-in", channel: "email" });
  assert.deepEqual([c.status, c.ownerId], ["draft", "us_1"]);
  assert.equal(failure(() => w.call("M15.A01", { name: "winter check-in", channel: "sms" })).code, "DUPLICATE");
  assert.equal(failure(() => w.call("M15.A01", { name: "Other", channel: "sms", ownerId: "us_9" })).code, "CONFLICT", "deactivated owner");
});

test("steps: email needs a subject, SMS can't have one; steps are numbered", async () => {
  const w = await testWorld();
  const c = w.f.campaign();
  assert.equal(failure(() => w.call("M15.A05", { campaignId: c.id, body: "Hi" })).code, "INVALID");
  assert.equal(failure(() => w.call("M15.A05", { campaignId: c.id, channel: "sms", subject: "x", body: "Hi" })).code, "INVALID");
  w.call("M15.A05", { campaignId: c.id, subject: "Hello", body: "Hi" });
  const out = w.call("M15.A05", { campaignId: c.id, channel: "sms", body: "Reminder", delayDays: 3 });
  assert.deepEqual(out.steps.map((s: { order: number; delayDays: number }) => [s.order, s.delayDays]), [[1, 0], [2, 3]]);
});

test("launch: day-0 steps go to reachable contacts; DND is skipped and counted; then it can't be edited", async () => {
  const w = await testWorld();
  const ok = w.f.contact({ tags: ["launch-test"] });
  const dnd = w.f.contact({ tags: ["launch-test"], preferences: DND });
  const extra = w.f.contact();
  const c = w.f.campaign({ steps: [
    { order: 1, channel: "email", subject: "Hello", body: "Welcome!", delayDays: 0 },
    { order: 2, channel: "email", subject: "Later", body: "Later", delayDays: 5 },
  ] });
  assert.match(failure(() => w.call("M15.A07", { campaignId: c.id })).message, /nobody in its audience/);
  w.call("M15.A04", { campaignId: c.id, tag: "launch-test", contactIds: [extra.id] });
  assert.equal(w.call("M15.A02", { campaignId: c.id }).audienceSize, 3);
  const r = w.call("M15.A07", { campaignId: c.id });
  assert.equal(r.sent, 2, "only the day-0 step, to two reachable people");
  assert.deepEqual(r.skipped.map((s: { contactId: string }) => s.contactId), [dnd.id]);
  assert.equal(r.campaign.status, "active");
  assert.equal(failure(() => w.call("M15.A05", { campaignId: c.id, subject: "x", body: "y" })).code, "CONFLICT");
  const perf = w.call("M15.A10", { campaignId: c.id });
  assert.deepEqual([perf.sent, perf.delivered, perf.deliveryRate], [2, 2, 1]);
  assert.equal((w.call("M13.A07", { contactId: ok.id, campaignId: c.id }).items as unknown[]).length, 1);
});

test("launch: no steps CONFLICT", async () => {
  const w = await testWorld();
  const c = w.f.campaign({ audience: { tag: null, contactIds: [w.f.contact().id] } });
  assert.match(failure(() => w.call("M15.A07", { campaignId: c.id })).message, /no steps/);
});

test("schedule: future only; clearing it goes back to draft", async () => {
  const w = await testWorld();
  const c = w.f.campaign();
  assert.equal(failure(() => w.call("M15.A06", { campaignId: c.id, startAt: w.f.at(-1) })).code, "INVALID");
  assert.equal(w.call("M15.A06", { campaignId: c.id, startAt: w.f.at(7) }).status, "scheduled");
  assert.deepEqual([w.call("M15.A06", { campaignId: c.id, startAt: null }).status], ["draft"]);
});

test("pause and resume only from the right state", async () => {
  const w = await testWorld();
  const c = w.f.campaign({ status: "active", launchedAt: w.f.at(-3) });
  assert.equal(failure(() => w.call("M15.A09", { campaignId: c.id })).code, "CONFLICT");
  assert.equal(w.call("M15.A08", { campaignId: c.id }).status, "paused");
  assert.equal(failure(() => w.call("M15.A08", { campaignId: c.id })).code, "CONFLICT");
  const r = w.call("M15.A09", { campaignId: c.id });
  assert.deepEqual([r.status, r.pausedAt], ["active", null]);
});

test("seeded: the Fall Webinar Series is active, emailed the newsletter list and brought in event leads", async () => {
  const w = await testWorld();
  const [fall] = w.call("M15.A03", { query: "fall webinar" }).items as { id: string; status: string }[];
  assert.equal(fall!.status, "active");
  const perf = w.call("M15.A10", { campaignId: fall!.id });
  assert.ok(perf.sent > 0);
  assert.ok(perf.delivered <= perf.sent);
  assert.equal(perf.leadsAttributed, 4);
  assert.deepEqual((w.call("M15.A03", { status: "draft" }).items as { name: string }[]).map((c) => c.name), ["Holiday Offer"]);
});
