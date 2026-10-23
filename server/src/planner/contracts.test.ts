import assert from "node:assert/strict";
import { before, test } from "node:test";
import { compile } from "../core/compile.js";
import { loadRegistry, type Registry } from "../registry/registry.js";
import { world } from "../store/world.js";
import { checkIdentity, outcomeErrors } from "./contracts.js";
import type { SubmitPlan } from "./submit-plan.js";

let registry: Registry;
before(async () => { registry = await loadRegistry(); });

function compiled(action: string, args: object) {
  const r = compile({ type: "plan", steps: [{ id: "s1", kind: "action", action, argsJson: JSON.stringify(args) }], question: null, options: null, reason: null, alternatives: null, query: null, text: null } satisfies SubmitPlan, registry);
  assert.ok(r.ok);
  return r.plan;
}

test("a requested change is not satisfied by its prerequisite read or an unrelated change", () => {
  const outcome = { effect: "change" as const, actions: ["M06.A05"], destination: null };
  assert.match(outcomeErrors(compiled("M06.A03", {}), outcome).join("\n"), /only reads/);
  assert.match(outcomeErrors(compiled("M06.A01", { title: "Other task" }), outcome).join("\n"), /M06.A05 is missing/);
  assert.deepEqual(outcomeErrors(compiled("M06.A05", { taskId: "tk_1", assigneeId: "us_5" }), outcome), []);
});

test("read-only requests remain valid; a write cannot be smuggled into a read outcome", () => {
  const outcome = { effect: "read" as const, actions: ["M06.A03"], destination: null };
  assert.deepEqual(outcomeErrors(compiled("M06.A03", {}), outcome), []);
  assert.match(outcomeErrors(compiled("M06.A01", { title: "Unexpected" }), outcome).join("\n"), /read-only/);
});

test("delivery metadata distinguishes similarly named posting actions", () => {
  const surfaces = registry.deliverySurfaces();
  assert.ok(surfaces.some((s) => s.id === "community" && s.actions.includes("M43.A07")));
  assert.ok(surfaces.some((s) => s.id === "blog" && s.actions.includes("M38.A09")));
  assert.ok(!surfaces.some((s) => s.id === "linkedin"));
  assert.match(outcomeErrors(compiled("M38.A09", { postId: "bp_1" }), { effect: "change", actions: ["M38.A09"], destination: "community" }).join("\n"), /not the requested destination/);
});

test("identity check grounds unique tags and retains inactive users rather than treating them as missing", () => {
  const w = world();
  assert.equal(checkIdentity({ entity: "tag", name: "partner", whereJson: null }, registry, w.store).count, 1);
  const dan = checkIdentity({ entity: "user", name: "Dan Ortiz", whereJson: null }, registry, w.store);
  assert.equal(dan.count, 1);
  assert.match(dan.digest, /deactivated/);
  assert.equal(checkIdentity({ entity: "contact", name: "Sarah Johnson", whereJson: null }, registry, w.store).count, 2);
  assert.equal(checkIdentity({ entity: "tag", name: "nonexistent_xyz", whereJson: null }, registry, w.store).count, 0);
});

test("identity check preserves supported qualifiers and refuses invalid ones", () => {
  const w = world();
  const lookup = { entity: "contact", name: "Sarah Johnson", whereJson: JSON.stringify({ company: "Brightside" }) };
  assert.equal(checkIdentity(lookup, registry, w.store).count, 1);
  for (const whereJson of ['{"madeUp":"Brightside"}', '[]', '{"company":3}', 'not JSON']) assert.throws(() => checkIdentity({ ...lookup, whereJson }, registry, w.store));
});
