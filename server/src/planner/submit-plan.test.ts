import assert from "node:assert/strict";
import { test } from "node:test";
import { SubmitPlan, SUBMIT_PLAN_SCHEMA } from "./submit-plan.js";

const base = { type: "plan", steps: null, question: null, options: null, reason: null, alternatives: null, query: null, text: null };

test("absent optional op fields become null without weakening the provider wire schema", () => {
  const parsed = SubmitPlan.parse({ ...base, steps: [{ id: "s2", kind: "op", op: "filter", in: "$s1.items" }] });
  const op = parsed.steps![0]!;
  assert.ok(op.kind === "op");
  for (const field of ["whereJson", "by", "set", "roundRobin", "do"] as const) assert.equal(op[field], null);
  const wire = SUBMIT_PLAN_SCHEMA.properties.steps.items.anyOf[2]!;
  assert.deepEqual(wire.required, ["id", "kind", "op", "in", "whereJson", "by", "set", "roundRobin", "do"]);
  assert.equal(wire.additionalProperties, false);
  assert.ok(!SubmitPlan.safeParse({ ...base, steps: [{ ...op, do: "bad" }] }).success);
});

test("forEach literal lists parse and the provider schema describes both input forms", () => {
  for (const input of [["literal_alpha", "literal_beta"], '$s1.items', '[]']) {
    assert.ok(SubmitPlan.safeParse({ ...base, steps: [{ id: "s2", kind: "op", op: "forEach", in: input, whereJson: null, by: null, set: null, roundRobin: null, do: [{ action: "M06.A01", argsJson: '{"title":"$item"}' }] }] }).success);
  }
  const op = SUBMIT_PLAN_SCHEMA.properties.steps.items.anyOf[2];
  assert.deepEqual(op!.properties.in!.anyOf, [{ type: "string" }, { type: "array", items: { type: "string" } }]);
});
