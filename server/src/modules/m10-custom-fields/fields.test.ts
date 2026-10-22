import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";

test("strict input rejects an unknown field", async () => {
  const w = await testWorld();
  assert.equal(failure(() => w.call("M10.A01", { key: "budget", label: "Budget", module: "contact", type: "text", madeUpParam: 1 })).code, "INVALID");
});

test("M10.A01 duplicate key in a module is DUPLICATE", async () => {
  const w = await testWorld();
  w.call("M10.A01", { key: "budget", label: "Budget", module: "contact", type: "number" });
  assert.equal(failure(() => w.call("M10.A01", { key: "budget", label: "Other", module: "contact", type: "text" })).code, "DUPLICATE");
  assert.ok(w.call("M10.A01", { key: "budget", label: "Budget", module: "lead", type: "number" }).id);
});

test("M10.A04 the same label is CONFLICT and M10.A05 the same help text is CONFLICT", async () => {
  const w = await testWorld();
  const field = w.f.customField({ label: "Budget", helpText: null });
  assert.equal(failure(() => w.call("M10.A04", { fieldId: field.id, label: "Budget" })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M10.A05", { fieldId: field.id, helpText: null })).code, "CONFLICT");
});

test("M10.A06 unchanged validation is CONFLICT and a bad pattern is INVALID", async () => {
  const w = await testWorld();
  const field = w.f.customField();
  assert.equal(failure(() => w.call("M10.A06", { fieldId: field.id, required: false })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M10.A06", { fieldId: field.id, pattern: "[" })).code, "INVALID");
  const box = w.f.customField({ type: "checkbox" });
  assert.equal(failure(() => w.call("M10.A06", { fieldId: box.id, min: 1 })).code, "INVALID");
});

test("M10.A07 a repeated option is DUPLICATE and M10.A08 retiring it twice is CONFLICT", async () => {
  const w = await testWorld();
  const field = w.f.customField({ type: "dropdown", options: [{ value: "a", label: "A", retired: false }] });
  assert.equal(failure(() => w.call("M10.A07", { fieldId: field.id, value: "a", label: "Again" })).code, "DUPLICATE");
  w.call("M10.A08", { fieldId: field.id, value: "a" });
  assert.equal(failure(() => w.call("M10.A08", { fieldId: field.id, value: "a" })).code, "CONFLICT");
});

test("M10.A09 refuses a retired option, the wrong type, and a repeated value", async () => {
  const w = await testWorld();
  const contact = w.f.contact();
  const drop = w.f.customField({ type: "dropdown", options: [{ value: "old", label: "Old", retired: true }, { value: "new", label: "New", retired: false }] });
  assert.equal(failure(() => w.call("M10.A09", { fieldId: drop.id, recordId: contact.id, value: "old" })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M10.A09", { fieldId: drop.id, recordId: "ct_99999", value: "new" })).code, "NOT_FOUND");
  const num = w.f.customField({ type: "number", key: "score" });
  assert.equal(failure(() => w.call("M10.A09", { fieldId: num.id, recordId: contact.id, value: "twelve" })).code, "INVALID");
  w.call("M10.A09", { fieldId: num.id, recordId: contact.id, value: 12 });
  assert.equal(failure(() => w.call("M10.A09", { fieldId: num.id, recordId: contact.id, value: 12 })).code, "CONFLICT");
});

test("M10.A10 archiving twice is CONFLICT and blocks a new value", async () => {
  const w = await testWorld();
  const field = w.f.customField();
  w.call("M10.A10", { fieldId: field.id });
  assert.equal(failure(() => w.call("M10.A10", { fieldId: field.id })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M10.A09", { fieldId: field.id, recordId: w.f.contact().id, value: "x" })).code, "CONFLICT");
});
