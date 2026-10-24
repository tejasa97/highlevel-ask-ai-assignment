import assert from "node:assert/strict";
import { before, test } from "node:test";
import { compile, type CompiledPlan } from "../core/compile.js";
import { loadRegistry, type Registry } from "../registry/registry.js";
import { readOnlyIntentError } from "./completion.js";
import type { SubmitPlan } from "./submit-plan.js";

let registry: Registry;
let read: CompiledPlan;
before(async () => {
  registry = await loadRegistry();
  const parsed = compile({ type: "plan", steps: [{ id: "s1", kind: "action", action: "M28.A10", argsJson: "{}" }], question: null, options: null, reason: null, alternatives: null, query: null, text: null } satisfies SubmitPlan, registry);
  assert.ok(parsed.ok);
  read = parsed.plan;
});

test("a read-only plan for a matched write verb is sent to repair", () => {
  assert.equal(readOnlyIntentError("Please send payment reminders", read, [registry.get("M28.A08")!]).length, 1);
});

test("informational questions and absent write cards never trigger completion repair", () => {
  for (const message of ["which invoices are overdue?", "who sent the payment reminders?", "show overdue invoices"]) {
    assert.deepEqual(readOnlyIntentError(message, read, [registry.get("M28.A08")!]), []);
  }
  assert.deepEqual(readOnlyIntentError("send payment reminders", read, [registry.get("M28.A10")!]), []);
});

test("a plan containing a write already is left alone", () => {
  const action = registry.get("M28.A08")!;
  const plan: CompiledPlan = { hash: "write", steps: [{ id: "s1", kind: "action", deps: [], type: action.outputSchema, call: { action, args: {} } }] };
  assert.deepEqual(readOnlyIntentError("send reminders", plan, [action]), []);
});
