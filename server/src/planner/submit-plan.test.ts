import assert from "node:assert/strict";
import { test } from "node:test";
import { SubmitPlan, SUBMIT_PLAN_SCHEMA } from "./submit-plan.js";

const base = { type: "plan", steps: null, question: null, options: null, reason: null, alternatives: null, query: null, text: null };

test("forEach literal lists parse and the provider schema describes both input forms", () => {
  for (const input of [["literal_alpha", "literal_beta"], '$s1.items', '[]']) {
    assert.ok(SubmitPlan.safeParse({ ...base, steps: [{ id: "s2", kind: "op", op: "forEach", in: input, whereJson: null, by: null, set: null, roundRobin: null, do: [{ action: "M06.A01", argsJson: '{"title":"$item"}' }] }] }).success);
  }
  const op = SUBMIT_PLAN_SCHEMA.properties.steps.items.anyOf[2];
  assert.deepEqual(op!.properties.in!.anyOf, [{ type: "string" }, { type: "array", items: { type: "string" } }]);
});
