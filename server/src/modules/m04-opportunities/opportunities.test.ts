import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";

test("create: first stage of the first active pipeline; duplicate open deal DUPLICATE; past close date INVALID", async () => {
  const w = await testWorld();
  const c = w.f.contact();
  const o = w.call("M04.A01", { name: "Pro plan", contactId: c.id, value: 4800 });
  const d = w.call("M04.A02", { opportunityId: o.id });
  assert.deepEqual([d.stageName, d.probability, d.weightedValue, d.contactName], ["New", 10, 480, c.name]);
  assert.equal(failure(() => w.call("M04.A01", { name: "pro PLAN", contactId: c.id })).code, "DUPLICATE");
  assert.equal(failure(() => w.call("M04.A01", { name: "Other", contactId: c.id, expectedCloseDate: w.f.day(-1) })).code, "INVALID");
  assert.equal(w.call("M04.A01", { name: "Other", contactId: c.id, stage: "proposal" }).stageId, w.call("M04.A02", { opportunityId: o.id }).stageId.replace(/_1$/, "_3"));
});

test("move stage: by name or id; same stage CONFLICT; unknown stage lists the stages", async () => {
  const w = await testWorld();
  const o = w.f.opportunity();
  assert.equal(w.call("M04.A05", { opportunityId: o.id, stage: "negotiation" }).probability, 75);
  assert.equal(failure(() => w.call("M04.A05", { opportunityId: o.id, stage: "Negotiation" })).code, "CONFLICT");
  const e = failure(() => w.call("M04.A05", { opportunityId: o.id, stage: "Signed" }));
  assert.equal(e.code, "NOT_FOUND");
  assert.match(e.message, /New, Qualified, Proposal, Negotiation/);
});

test("value and owner must change; owners must be active", async () => {
  const w = await testWorld();
  const o = w.f.opportunity({ value: 1000 });
  assert.equal(failure(() => w.call("M04.A04", { opportunityId: o.id, value: 1000 })).code, "CONFLICT");
  w.call("M04.A06", { opportunityId: o.id, ownerId: "us_5" });
  assert.equal(failure(() => w.call("M04.A06", { opportunityId: o.id, ownerId: "us_5" })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M04.A06", { opportunityId: o.id, ownerId: "us_9" })).code, "CONFLICT");
});

test("won, lost, reopen: only open deals close; reopening clears the reason", async () => {
  const w = await testWorld();
  const o = w.f.opportunity({ value: 1000 });
  const won = w.call("M04.A08", { opportunityId: o.id, value: 1200 });
  assert.deepEqual([won.status, won.value, won.closedAt], ["won", 1200, w.clock.now().toISOString()]);
  assert.equal(w.call("M04.A02", { opportunityId: o.id }).probability, 100);
  for (const [id, args] of [
    ["M04.A09", { opportunityId: o.id, reason: "x" }],
    ["M04.A04", { opportunityId: o.id, value: 5 }],
    ["M04.A07", { opportunityId: o.id, expectedCloseDate: w.f.day(5) }],
  ] as const) assert.equal(failure(() => w.call(id, args)).code, "CONFLICT", id);
  const lost = w.f.opportunity({ status: "lost", lostReason: "No budget", closedAt: w.f.at(-1) });
  const back = w.call("M04.A10", { opportunityId: lost.id });
  assert.deepEqual([back.status, back.lostReason, back.closedAt], ["open", null, null]);
  assert.equal(failure(() => w.call("M04.A10", { opportunityId: lost.id })).code, "CONFLICT");
});

test("search: open by default, biggest first; seeded won and lost deals", async () => {
  const w = await testWorld();
  const open = w.call("M04.A03", {}).items as { value: number; status: string }[];
  assert.ok(open.length > 0 && open.every((o) => o.status === "open"));
  assert.deepEqual(open.map((o) => o.value), [...open.map((o) => o.value)].sort((a, b) => b - a));
  assert.deepEqual((w.call("M04.A03", { status: "won" }).items as { value: number }[]).map((o) => o.value), [4800]);
  const [lost] = w.call("M04.A03", { status: "lost" }).items as { lostReason: string; value: number }[];
  assert.deepEqual([lost!.value, lost!.lostReason], [24000, "Went with a competitor"]);
  assert.ok((w.call("M04.A03", { minValue: 1e9 }).items as unknown[]).length === 0);
});
