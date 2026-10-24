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

test("read commands can contain write-shaped adjectives without becoming action requests", () => {
  const draft = { ...registry.get("M45.A08")!, name: "Draft response" };
  for (const message of ["List draft responses", "Please show the draft responses", "Find draft responses"]) {
    assert.deepEqual(readOnlyIntentError(message, read, [draft]), [], message);
  }
  assert.equal(readOnlyIntentError("Find invoices, then send payment reminders", read, [registry.get("M28.A08")!]).length, 1);
  assert.equal(readOnlyIntentError("List responses and draft a response", read, [draft]).length, 1);
});

test("a plan containing a write already is left alone", () => {
  const action = registry.get("M28.A08")!;
  const plan: CompiledPlan = { hash: "write", steps: [{ id: "s1", kind: "action", deps: [], type: action.outputSchema, call: { action, args: {} } }] };
  assert.deepEqual(readOnlyIntentError("send reminders", plan, [action]), []);
});

test("a clause opened by a word the catalog uses for writes is a command, even when no offered name starts with it", () => {
  const offered = [registry.get("M46.A03")!, registry.get("M46.A06")!];
  assert.equal(readOnlyIntentError("Change Maple Dental's listing phone to +15550987654", read, offered, registry).length, 1);
  assert.deepEqual(readOnlyIntentError("Show Maple Dental's listing phone", read, offered, registry), []);
  assert.deepEqual(readOnlyIntentError("Maple Dental's listing, the one with the change", read, offered, registry), [], "only a clause's first word counts");
});
