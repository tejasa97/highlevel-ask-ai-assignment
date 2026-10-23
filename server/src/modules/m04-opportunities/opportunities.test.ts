import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";

async function wonOpportunity() {
  const w = await testWorld();
  const o = w.f.opportunity({ value: 1000 });
  const won = w.call("M04.A08", { opportunityId: o.id, value: 1200 });
  return { w, o, won };
}

test("M04 deal values round to cents and a blank lost reason is refused", async () => {
  const w = await testWorld();
  const deal = w.call("M04.A01", { name: "Odd price", contactId: w.f.contact().id, value: 10.005 });
  assert.equal(deal.value, 10.01);
  assert.equal(w.call("M04.A04", { opportunityId: deal.id, value: 20.126 }).value, 20.13);
  assert.equal(failure(() => w.call("M04.A09", { opportunityId: deal.id, reason: "  " })).code, "INVALID");
  assert.equal(w.call("M04.A08", { opportunityId: deal.id, value: 30.999 }).value, 31);
});

test("M04.A01 create lands on the first stage of the first active pipeline", async () => {
  const w = await testWorld();
  const c = w.f.contact();
  const o = w.call("M04.A01", { name: "Pro plan", contactId: c.id, value: 4800 });
  const d = w.call("M04.A02", { opportunityId: o.id });
  assert.deepEqual([d.stageName, d.probability, d.weightedValue, d.contactName], ["New", 10, 480, c.name]);
});

test("M04.A01 create refuses a duplicate open deal for the contact, ignoring case", async () => {
  const w = await testWorld();
  const c = w.f.contact();
  w.call("M04.A01", { name: "Pro plan", contactId: c.id, value: 4800 });
  assert.equal(failure(() => w.call("M04.A01", { name: "pro PLAN", contactId: c.id })).code, "DUPLICATE");
});

test("M04.A01 create refuses a close date in the past", async () => {
  const w = await testWorld();
  const c = w.f.contact();
  assert.equal(failure(() => w.call("M04.A01", { name: "Other", contactId: c.id, expectedCloseDate: w.f.day(-1) })).code, "INVALID");
});

test("M04.A01 create can start on a named stage", async () => {
  const w = await testWorld();
  const c = w.f.contact();
  const o = w.call("M04.A01", { name: "Pro plan", contactId: c.id, value: 4800 });
  assert.equal(w.call("M04.A01", { name: "Other", contactId: c.id, stage: "proposal" }).stageId, w.call("M04.A02", { opportunityId: o.id }).stageId.replace(/_1$/, "_3"));
});

test("M04.A05 move stage by name", async () => {
  const w = await testWorld();
  const o = w.f.opportunity();
  assert.equal(w.call("M04.A05", { opportunityId: o.id, stage: "negotiation" }).probability, 75);
});

test("M04.A05 move stage refuses the stage it is already on", async () => {
  const w = await testWorld();
  const o = w.f.opportunity();
  w.call("M04.A05", { opportunityId: o.id, stage: "negotiation" });
  assert.equal(failure(() => w.call("M04.A05", { opportunityId: o.id, stage: "Negotiation" })).code, "CONFLICT");
});

test("M04.A05 an unknown stage lists the stages", async () => {
  const w = await testWorld();
  const o = w.f.opportunity();
  const e = failure(() => w.call("M04.A05", { opportunityId: o.id, stage: "Signed" }));
  assert.equal(e.code, "NOT_FOUND");
  assert.match(e.message, /New, Qualified, Proposal, Negotiation/);
});

test("M04.A04 value refuses a no-op", async () => {
  const w = await testWorld();
  const o = w.f.opportunity({ value: 1000 });
  assert.equal(failure(() => w.call("M04.A04", { opportunityId: o.id, value: 1000 })).code, "CONFLICT");
});

test("M04.A06 owner refuses a no-op", async () => {
  const w = await testWorld();
  const o = w.f.opportunity({ value: 1000 });
  w.call("M04.A06", { opportunityId: o.id, ownerId: "us_5" });
  assert.equal(failure(() => w.call("M04.A06", { opportunityId: o.id, ownerId: "us_5" })).code, "CONFLICT");
});

test("M04.A06 owner must be an active user", async () => {
  const w = await testWorld();
  const o = w.f.opportunity({ value: 1000 });
  assert.equal(failure(() => w.call("M04.A06", { opportunityId: o.id, ownerId: "us_9" })).code, "CONFLICT");
});

test("M04.A08 won closes the deal at the final value", async () => {
  const { w, won } = await wonOpportunity();
  assert.deepEqual([won.status, won.value, won.closedAt], ["won", 1200, w.clock.now().toISOString()]);
});

test("M04.A02 a won deal is at probability 100", async () => {
  const { w, o } = await wonOpportunity();
  assert.equal(w.call("M04.A02", { opportunityId: o.id }).probability, 100);
});

test("M04.A09 lost refuses a deal that is already closed", async () => {
  const { w, o } = await wonOpportunity();
  assert.equal(failure(() => w.call("M04.A09", { opportunityId: o.id, reason: "x" })).code, "CONFLICT");
});

test("M04.A04 value refuses a closed deal", async () => {
  const { w, o } = await wonOpportunity();
  assert.equal(failure(() => w.call("M04.A04", { opportunityId: o.id, value: 5 })).code, "CONFLICT");
});

test("M04.A07 close date refuses a closed deal", async () => {
  const { w, o } = await wonOpportunity();
  assert.equal(failure(() => w.call("M04.A07", { opportunityId: o.id, expectedCloseDate: w.f.day(5) })).code, "CONFLICT");
});

test("M04.A10 reopen clears the reason and the close time", async () => {
  const w = await testWorld();
  const lost = w.f.opportunity({ status: "lost", lostReason: "No budget", closedAt: w.f.at(-1) });
  const back = w.call("M04.A10", { opportunityId: lost.id });
  assert.deepEqual([back.status, back.lostReason, back.closedAt], ["open", null, null]);
});

test("M04.A10 reopen refuses a deal that is already open", async () => {
  const w = await testWorld();
  const lost = w.f.opportunity({ status: "lost", lostReason: "No budget", closedAt: w.f.at(-1) });
  w.call("M04.A10", { opportunityId: lost.id });
  assert.equal(failure(() => w.call("M04.A10", { opportunityId: lost.id })).code, "CONFLICT");
});

test("M04.A03 search shows open deals by default, biggest first", async () => {
  const w = await testWorld();
  const open = w.call("M04.A03", {}).items as { value: number; status: string }[];
  assert.ok(open.length > 0 && open.every((o) => o.status === "open"));
  assert.deepEqual(open.map((o) => o.value), [...open.map((o) => o.value)].sort((a, b) => b - a));
});

test("M04.A03 search finds the seeded won and lost deals", async () => {
  const w = await testWorld();
  assert.deepEqual((w.call("M04.A03", { status: "won" }).items as { value: number }[]).map((o) => o.value), [4800]);
  const [lost] = w.call("M04.A03", { status: "lost" }).items as { lostReason: string; value: number }[];
  assert.deepEqual([lost!.value, lost!.lostReason], [24000, "Went with a competitor"]);
});

test("M04.A03 search by minimum value can come back empty", async () => {
  const w = await testWorld();
  assert.ok((w.call("M04.A03", { minValue: 1e9 }).items as unknown[]).length === 0);
});
