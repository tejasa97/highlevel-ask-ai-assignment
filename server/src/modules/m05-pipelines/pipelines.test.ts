import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";

test("strict input rejects an unknown field", async () => {
  const w = await testWorld();
  assert.equal(failure(() => w.call("M05.A01", { name: "Expansion", madeUpParam: 1 })).code, "INVALID");
});

test("M05.A01 duplicate pipeline name is DUPLICATE", async () => {
  const w = await testWorld();
  assert.equal(failure(() => w.call("M05.A01", { name: "Sales Pipeline" })).code, "DUPLICATE");
  const p = w.call("M05.A01", { name: "Partner Pipeline" });
  assert.equal(p.stages.length, 1);
  assert.equal(failure(() => w.call("M05.A02", { pipelineId: "pl_99999" })).code, "NOT_FOUND");
});

test("M05.A04 same name is CONFLICT and M05.A05 archive twice is CONFLICT", async () => {
  const w = await testWorld();
  const p = w.f.pipeline();
  assert.equal(failure(() => w.call("M05.A04", { pipelineId: p.id, name: p.name })).code, "CONFLICT");
  w.call("M05.A05", { pipelineId: p.id });
  assert.equal(failure(() => w.call("M05.A05", { pipelineId: p.id })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M05.A04", { pipelineId: p.id, name: "After archive" })).code, "CONFLICT");
});

test("M05.A06 duplicate stage name is DUPLICATE", async () => {
  const w = await testWorld();
  const p = w.f.pipeline();
  assert.equal(failure(() => w.call("M05.A06", { pipelineId: p.id, name: "New" })).code, "DUPLICATE");
});

test("M05.A07 renaming a stage to itself is CONFLICT", async () => {
  const w = await testWorld();
  const p = w.f.pipeline();
  assert.equal(failure(() => w.call("M05.A07", { pipelineId: p.id, stageId: p.stages[0]!.id, name: "New" })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M05.A07", { pipelineId: p.id, stageId: "st_99999", name: "Other" })).code, "NOT_FOUND");
});

test("M05.A08 the current order is CONFLICT", async () => {
  const w = await testWorld();
  const p = w.f.pipeline();
  const ids = p.stages.map((s) => s.id);
  assert.equal(failure(() => w.call("M05.A08", { pipelineId: p.id, stageIds: ids })).code, "CONFLICT");
  const reversed = w.call("M05.A08", { pipelineId: p.id, stageIds: [...ids].reverse() });
  assert.deepEqual(reversed.stages.map((s: { id: string }) => s.id), [...ids].reverse());
});

test("M05.A09 a stage with a deal, or the last stage, is CONFLICT", async () => {
  const w = await testWorld();
  const p = w.f.pipeline();
  w.f.opportunity({ pipelineId: p.id, stageId: p.stages[0]!.id });
  assert.equal(failure(() => w.call("M05.A09", { pipelineId: p.id, stageId: p.stages[0]!.id })).code, "CONFLICT");
  const tiny = w.call("M05.A01", { name: "Tiny Pipeline", stages: [{ name: "Only", probability: 10 }] });
  assert.equal(failure(() => w.call("M05.A09", { pipelineId: tiny.id, stageId: tiny.stages[0]!.id })).code, "CONFLICT");
  const removed = w.call("M05.A09", { pipelineId: p.id, stageId: p.stages[3]!.id });
  assert.equal(removed.stages.length, 3);
});

test("M05.A10 the same win probability is CONFLICT", async () => {
  const w = await testWorld();
  const p = w.f.pipeline();
  assert.equal(failure(() => w.call("M05.A10", { pipelineId: p.id, stageId: p.stages[0]!.id, probability: 10 })).code, "CONFLICT");
  assert.equal(w.call("M05.A10", { pipelineId: p.id, stageId: p.stages[0]!.id, probability: 15 }).stages[0].probability, 15);
});

test("M05.A03 lists pipelines by name and counts past the limit", async () => {
  const w = await testWorld();
  w.f.pipeline({ name: "Zulu Pipeline" });
  const page = w.call("M05.A03", { limit: 1 });
  assert.ok(page.total >= 2);
  assert.equal(page.items.length, 1);
});
