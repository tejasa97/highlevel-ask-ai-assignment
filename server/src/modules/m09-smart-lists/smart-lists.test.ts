import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";

test("strict input rejects an unknown field", async () => {
  const w = await testWorld();
  assert.equal(failure(() => w.call("M09.A01", { name: "People", target: "contact", madeUpParam: 1 })).code, "INVALID");
});

test("M09.A01 duplicate name is DUPLICATE and an unknown field is INVALID", async () => {
  const w = await testWorld();
  w.call("M09.A01", { name: "Vip people", target: "contact", rules: [] });
  assert.equal(failure(() => w.call("M09.A01", { name: "vip people", target: "lead" })).code, "DUPLICATE");
  assert.equal(failure(() => w.call("M09.A01", { name: "Bad", target: "contact", rules: [{ field: "nope", op: "eq", value: "x" }] })).code, "INVALID");
});

test("M09.A04 the same name is CONFLICT and M09.A05 the same rules are CONFLICT", async () => {
  const w = await testWorld();
  const list = w.f.smartList({ name: "Steady" });
  assert.equal(failure(() => w.call("M09.A04", { smartListId: list.id, name: "Steady" })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M09.A05", { smartListId: list.id, rules: [] })).code, "CONFLICT");
});

test("M09.A09 copying onto an existing name is DUPLICATE", async () => {
  const w = await testWorld();
  const list = w.f.smartList({ name: "Source" });
  w.call("M09.A09", { smartListId: list.id });
  assert.equal(failure(() => w.call("M09.A09", { smartListId: list.id })).code, "DUPLICATE");
});

test("M09.A10 deleting twice is CONFLICT", async () => {
  const w = await testWorld();
  const list = w.f.smartList();
  assert.equal(w.call("M09.A10", { smartListId: list.id }).status, "deleted");
  assert.equal(failure(() => w.call("M09.A10", { smartListId: list.id })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M09.A06", { smartListId: list.id })).code, "CONFLICT");
});

test("cf.<key> filters read custom field values and the total ignores the limit", async () => {
  const w = await testWorld();
  const field = w.f.customField({ key: "budget", label: "Budget", module: "contact", type: "number" });
  const rich = w.f.contact({ name: "Rich Person" });
  const poor = w.f.contact({ name: "Poor Person" });
  w.f.customFieldValue({ fieldId: field.id, recordType: "contact", recordId: rich.id, value: 80 });
  w.f.customFieldValue({ fieldId: field.id, recordType: "contact", recordId: poor.id, value: 10 });
  const list = w.call("M09.A01", {
    name: "Big budgets",
    target: "contact",
    rules: [{ field: "cf.budget", op: "gt", value: 50 }],
  });
  const preview = w.call("M09.A06", { smartListId: list.id, limit: 1 });
  assert.equal(preview.total, 1);
  assert.equal(preview.items[0].id, rich.id);
  assert.equal(w.call("M09.A07", { smartListId: list.id }).count, 1);
  const exported = w.call("M09.A08", { smartListId: list.id });
  assert.equal(exported.items[0].fields["cf.budget"], 80);
  assert.equal(failure(() => w.call("M09.A05", { smartListId: list.id, rules: [{ field: "cf.missing", op: "eq", value: 1 }] })).code, "CONFLICT");
});
