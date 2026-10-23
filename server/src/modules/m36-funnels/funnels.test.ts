import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";

function step(id: string, name: string, landingPageId: string | null = null, visits = 0, advanced = 0) {
  return { id, name, landingPageId, visits, advanced };
}

test("create rejects a duplicate funnel name", async () => {
  const w = await testWorld();
  w.call("M36.A01", { name: "Launch" });
  assert.equal(failure(() => w.call("M36.A01", { name: "launch" })).code, "DUPLICATE");
});

test("adding a step refuses an unpublished landing page", async () => {
  const w = await testWorld();
  const funnel = w.f.funnel();
  const draft = w.f.landingPage();
  assert.equal(failure(() => w.call("M36.A04", { funnelId: funnel.id, name: "Offer", landingPageId: draft.id })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M36.A04", { funnelId: funnel.id, name: "Offer", landingPageId: "lp_99999" })).code, "NOT_FOUND");
  const added = w.call("M36.A04", { funnelId: funnel.id, name: "Offer" });
  assert.equal(added.steps[0].landingPageId, null);
  assert.equal(added.steps[0].visits, 0);
});

test("reorder must be a real permutation", async () => {
  const w = await testWorld();
  const a = `st_${w.f.seq()}`;
  const b = `st_${w.f.seq()}`;
  const funnel = w.f.funnel({ steps: [step(a, "A"), step(b, "B")] });
  assert.equal(failure(() => w.call("M36.A05", { funnelId: funnel.id, stepIds: [a, b] })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M36.A05", { funnelId: funnel.id, stepIds: [a] })).code, "INVALID");
  assert.deepEqual(w.call("M36.A05", { funnelId: funnel.id, stepIds: [b, a] }).steps.map((s: { id: string }) => s.id), [b, a]);
});

test("remove refuses the goal step and the last step of a published funnel", async () => {
  const w = await testWorld();
  const only = `st_${w.f.seq()}`;
  const goal = w.f.funnel({ steps: [step(only, "Only")], goal: { type: "booking", stepId: only } });
  assert.equal(failure(() => w.call("M36.A06", { funnelId: goal.id, stepId: only })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M36.A06", { funnelId: goal.id, stepId: "st_404" })).code, "CONFLICT");
  const last = `st_${w.f.seq()}`;
  const live = w.f.funnel({ status: "published", publishedAt: w.f.now(), steps: [step(last, "Only")] });
  assert.equal(failure(() => w.call("M36.A06", { funnelId: live.id, stepId: last })).code, "CONFLICT");
});

test("link requires a landing page that exists and is published", async () => {
  const w = await testWorld();
  const stepId = `st_${w.f.seq()}`;
  const funnel = w.f.funnel({ steps: [step(stepId, "Offer")] });
  const draft = w.f.landingPage();
  assert.equal(failure(() => w.call("M36.A07", { funnelId: funnel.id, stepId, landingPageId: "lp_99999" })).code, "NOT_FOUND");
  assert.equal(failure(() => w.call("M36.A07", { funnelId: funnel.id, stepId, landingPageId: draft.id })).code, "CONFLICT");
  assert.match(failure(() => w.call("M36.A07", { funnelId: funnel.id, stepId, landingPageId: draft.id })).message, /publish/i);
  const live = w.f.landingPage({ status: "published", publishedAt: w.f.now() });
  const linked = w.call("M36.A07", { funnelId: funnel.id, stepId, landingPageId: live.id });
  assert.equal(linked.steps[0].landingPageId, live.id);
  assert.equal(failure(() => w.call("M36.A07", { funnelId: funnel.id, stepId, landingPageId: live.id })).code, "CONFLICT");
});

test("goal must name a step, and setting it twice is a no-op", async () => {
  const w = await testWorld();
  const empty = w.f.funnel();
  assert.equal(failure(() => w.call("M36.A08", { funnelId: empty.id, type: "purchase", stepId: "st_404" })).code, "CONFLICT");
  const stepId = `st_${w.f.seq()}`;
  const funnel = w.f.funnel({ steps: [step(stepId, "Checkout")] });
  w.call("M36.A08", { funnelId: funnel.id, type: "purchase", stepId });
  assert.equal(failure(() => w.call("M36.A08", { funnelId: funnel.id, type: "purchase", stepId })).code, "CONFLICT");
});

test("publish names a step whose landing page is not published, and needs a step", async () => {
  const w = await testWorld();
  const empty = w.f.funnel();
  assert.equal(failure(() => w.call("M36.A09", { funnelId: empty.id })).code, "CONFLICT");
  const page = w.f.landingPage({ title: "Checkout page" });
  const stepId = `st_${w.f.seq()}`;
  const funnel = w.f.funnel({ steps: [step(stepId, "Checkout", page.id)] });
  const err = failure(() => w.call("M36.A09", { funnelId: funnel.id }));
  assert.equal(err.code, "CONFLICT");
  assert.match(err.message, /Checkout/);
  const open = w.f.funnel({ steps: [step(`st_${w.f.seq()}`, "Start")] });
  assert.equal(w.call("M36.A09", { funnelId: open.id }).status, "published");
  const livePage = w.f.landingPage({ status: "published", publishedAt: w.f.now() });
  const ready = w.f.funnel({ steps: [step(`st_${w.f.seq()}`, "Offer", livePage.id, 8, 2)] });
  assert.equal(w.call("M36.A09", { funnelId: ready.id }).status, "published");
  assert.equal(failure(() => w.call("M36.A09", { funnelId: ready.id })).code, "CONFLICT");
});

test("metrics use step traffic and do not write", async () => {
  const w = await testWorld();
  const funnel = w.f.funnel({
    steps: [step("st_a", "Start", null, 100, 40), step("st_b", "End", null, 40, 10)],
  });
  const before = w.store.audit().length;
  const metrics = w.call("M36.A10", { funnelId: funnel.id });
  assert.equal(w.store.audit().length, before);
  assert.equal(metrics.steps[0].rate, 0.4);
  assert.equal(metrics.steps[1].rate, 0.25);
  assert.equal(metrics.conversionRate, 0.1);
});

test("list is sorted by name then id", async () => {
  const w = await testWorld();
  w.f.funnel({ name: "Beta" });
  w.f.funnel({ name: "Alpha" });
  const listed = w.call("M36.A03", {});
  assert.deepEqual(listed.items.map((f: { name: string }) => f.name), ["Alpha", "Beta"]);
});

test("unknown field is INVALID", async () => {
  const w = await testWorld();
  const funnel = w.f.funnel();
  assert.equal(failure(() => w.call("M36.A02", { funnelId: funnel.id, madeUp: 1 })).code, "INVALID");
});

test("M36.A09 publish needs messaging.send, and a refusal leaves the funnel a draft", async () => {
  const w = await testWorld();
  const billing = w.f.user({ roles: ["billing"] });
  const marketing = w.f.user({ roles: ["marketing"] });
  const funnel = w.f.funnel({ steps: [step(`st_${w.f.seq()}`, "Start")] });
  assert.equal(failure(() => w.call("M36.A09", { funnelId: funnel.id }, billing.id)).code, "PERMISSION");
  assert.equal(failure(() => w.call("M36.A09", { funnelId: funnel.id }, "us_missing")).code, "PERMISSION");
  assert.equal(w.call("M36.A02", { funnelId: funnel.id }).status, "draft");
  assert.equal(w.call("M36.A09", { funnelId: funnel.id }, marketing.id).status, "published");
});
