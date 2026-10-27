import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ANY, arrayOf, parseRef, typeAt, valueAt } from "./refs.js";

const found = { type: "object", properties: { items: arrayOf({ type: "object", properties: { leadId: { type: "string" } } }), total: { type: "number" } } };
const loop = arrayOf({ type: "object", properties: { item: { type: "string" }, results: { ...arrayOf(ANY), prefixItems: [found] } } });
const ran = [
  { item: "a", results: [{ items: [{ leadId: "ld_1" }], total: 1 }] },
  { item: "b", results: [{ items: [], total: 0 }] },
];
const at = (ref: string) => parseRef(ref)!.path;

describe("reading a loop's results", () => {
  test("[*] twice is one flat list, in its type and its value", () => {
    assert.deepEqual(typeAt(loop, at("$s2[*].results[0].items[*].leadId"), "$s2"), { type: arrayOf({ type: "string" }) });
    assert.deepEqual(valueAt(ran, at("$s2[*].results[0].items[*].leadId"), "$s2"), ["ld_1"]);
  });

  test("a field the entry doesn't have is read from its one call, or from each record that call found", () => {
    assert.deepEqual(typeAt(loop, at("$s2[*].total"), "$s2"), { type: arrayOf({ type: "number" }) });
    assert.deepEqual(valueAt(ran, at("$s2[*].total"), "$s2"), [1, 0]);
    assert.deepEqual(typeAt(loop, at("$s2[*].leadId"), "$s2"), { type: arrayOf({ type: "string" }) });
    assert.deepEqual(valueAt(ran, at("$s2[*].leadId"), "$s2"), ["ld_1"]);
  });

  test(".results on the loop's list is that field of every entry", () => {
    assert.deepEqual(valueAt(ran, at("$s2.results[*].items[*].leadId"), "$s2"), ["ld_1"]);
    assert.ok("type" in typeAt(loop, at("$s2.results[*].items[*].leadId"), "$s2"));
  });
});
