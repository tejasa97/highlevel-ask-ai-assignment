import assert from "node:assert/strict";
import { before, test } from "node:test";
import type { SubmitPlan } from "../planner/submit-plan.js";
import { loadRegistry, type Registry } from "../registry/registry.js";
import { world } from "../store/world.js";
import { compile } from "./compile.js";
import { execute } from "./execute.js";
import { lowerLookups } from "./lookups.js";
import type { FormField } from "../modules/m18-forms/schema.js";

let registry: Registry;
before(async () => { registry = await loadRegistry(); });
const named = (entity: string, name: string, where?: Record<string, string>) => ({ $lookup: { entity, name, ...(where ? { where } : {}) } });
const action = (action: string, args: unknown) => ({ id: "do_it", kind: "action" as const, action, argsJson: JSON.stringify(args) });
const plan = (steps: SubmitPlan["steps"]): SubmitPlan => ({ type: "plan", steps, question: null, options: null, reason: null, alternatives: null, query: null, text: null });
function compiled(steps: SubmitPlan["steps"]) {
  const p = compile(plan(steps), registry);
  if (!p.ok) assert.fail(p.errors.join("\n"));
  return p.plan;
}
const field = (id: string, label = "Email"): FormField => ({ id, label, type: "email", required: true, options: [], validation: { minLength: null, maxLength: null, pattern: null }, mapsTo: "email" });

test("nested form answers find the right parent's field regardless of JSON argument order", async () => {
  const w = world();
  const form = w.f.form({ name: "North Intake", status: "published", publishedAt: w.f.now(), fields: [field("field_north")] });
  w.f.form({ name: "South Intake", status: "published", fields: [field("field_south")] });
  const p = compiled([action("M18.A09", { answers: [{ fieldId: named("form_field", "Email"), value: "north@example.com" }], formId: named("form", form.name) })]);
  assert.deepEqual(p.steps.map((s) => s.kind), ["resolve", "resolve", "action"]);
  const result = await execute(p, registry, w, { executionId: "nested-form" });
  assert.equal(result.status, "done");
  assert.deepEqual((result.steps.at(-1)!.output as { values: object }).values, { field_north: "north@example.com" });
  assert.equal((result.steps.at(-1)!.output as { formId: string }).formId, form.id);
});

test("literal ID-keyed form values remain compatible", async () => {
  const w = world();
  const form = w.f.form({ name: "Legacy Intake", status: "published", fields: [field("field_legacy")] });
  const result = await execute(compiled([action("M18.A09", { formId: form.id, values: { field_legacy: "legacy@example.com" } })]), registry, w, { executionId: "legacy-form" });
  assert.equal(result.status, "done");
});

test("duplicate and absent field labels never choose a different parent's field", async () => {
  for (const duplicate of [false, true]) {
    const w = world();
    const form = w.f.form({ name: "Ambiguous Intake", status: "published", fields: duplicate ? [field("field_a"), { ...field("field_b"), mapsTo: null }] : [field("field_other", "Work address")] });
    w.f.form({ name: "Other Intake", fields: [field("field_elsewhere")] });
    const before = w.store.all("form_submissions");
    const result = await execute(compiled([action("M18.A09", { formId: form.id, answers: [{ fieldId: named("form_field", "Email"), value: "a@example.com" }] })]), registry, w, { executionId: `field-${duplicate}` });
    assert.equal(result.status, duplicate ? "needs_clarification" : "failed");
    assert.deepEqual(w.store.all("form_submissions"), before);
  }
});

test("child lookup rejects contradictory scope, wrong entity and missing parent before execution", () => {
  for (const args of [
    { formId: "fm_one", answers: [{ fieldId: named("form_field", "Email", { formId: "fm_other" }), value: "x" }] },
    { formId: "fm_one", answers: [{ fieldId: named("custom_field", "Email"), value: "x" }] },
    { answers: [{ fieldId: named("form_field", "Email"), value: "x" }] },
  ]) assert.equal(compile(plan([action("M18.A09", args)]), registry).ok, false);
  for (const entity of ["form_field", "community_channel"]) {
    const result = compile(plan([{ id: "child", kind: "resolve", entity, name: "Email" }]), registry);
    assert.ok(!result.ok && result.errors.some((e) => e.includes("parent qualifier")));
  }
});

test("new child resolvers also enforce parent scope at runtime", () => {
  const w = world();
  for (const entity of ["form_field", "community_channel"]) assert.throws(() => registry.resolver(entity)!(w.store, "Email"), /parent qualifier/);
});

test("named stage array items inherit the selected pipeline, not another same-named stage", async () => {
  const w = world();
  const p = w.f.pipeline({ name: "Scoped Stages", stages: [{ id: "st_a", name: "New", probability: 10 }, { id: "st_b", name: "Review", probability: 50 }] });
  w.f.pipeline({ name: "Other Stages", stages: [{ id: "st_elsewhere", name: "Review", probability: 20 }] });
  const result = await execute(compiled([action("M05.A08", { stageIds: [named("stage", "Review"), named("stage", "New")], pipelineId: named("pipeline", p.name) })]), registry, w, { executionId: "stage-order" });
  assert.equal(result.status, "done");
  assert.deepEqual(w.store.get<{ stages: { id: string }[] }>("pipelines", p.id)!.stages.map((s) => s.id), ["st_b", "st_a"]);
});

test("named community channels preserve the normal membership and state rules", async () => {
  const w = world();
  const community = w.f.community({ name: "North Hub", channels: [{ id: "ch_north", name: "News" }] });
  w.f.community({ name: "South Hub", channels: [{ id: "ch_south", name: "News" }] });
  const nonmember = w.f.contact();
  const run = (contactId?: string) => execute(compiled([action("M43.A07", { channelId: named("community_channel", "News"), communityId: named("community", community.name), body: "Hello", ...(contactId ? { contactId } : {}) })]), registry, w, { executionId: contactId ?? "staff-post" });
  const denied = await run(nonmember.id);
  assert.equal(denied.status, "failed");
  assert.equal(w.store.all("community_posts").length, 0);
  const staff = await run();
  assert.equal(staff.status, "done");
  assert.equal((staff.steps.at(-1)!.output as { channelId: string }).channelId, "ch_north");
});

test("duplicate answer entries and mixed input routes fail without creating a contact/submission", async () => {
  for (const extra of [
    { answers: [{ fieldId: named("form_field", "Email"), value: "a@example.com" }, { fieldId: named("form_field", "Email"), value: "b@example.com" }] },
    { answers: [{ fieldId: named("form_field", "Email"), value: "a@example.com" }], values: {} },
  ]) {
    const w = world();
    const form = w.f.form({ name: "Duplicate Intake", status: "published", fields: [field("field_once")] });
    const contacts = w.store.all("contacts").length;
    const result = await execute(compiled([action("M18.A09", { formId: form.id, ...extra })]), registry, w, { executionId: "invalid-answers" });
    assert.equal(result.status, "failed");
    assert.equal(w.store.all("contacts").length, contacts);
    assert.equal(w.store.all("form_submissions").length, 0);
  }
  // Neither values nor answers: refused before it runs.
  const none = compile(plan([action("M18.A09", { formId: "frm_1" })]), registry);
  assert.ok(!none.ok && none.errors.some((e) => /input groups/.test(e)));
});

test("a per-item variable parent cannot be silently hoisted into a global child lookup", () => {
  const result = compile(plan([
    { id: "forms", kind: "action", action: "M18.A03", argsJson: "{}" },
    { id: "each", kind: "op", op: "forEach", in: "$forms.items", whereJson: null, by: null, set: null, roundRobin: null,
      do: [{ action: "M18.A09", argsJson: JSON.stringify({ formId: "$item.id", answers: [{ fieldId: named("form_field", "Email"), value: "a@example.com" }] }) }] },
  ]), registry);
  assert.ok(!result.ok && result.errors.some((e) => e.includes("Per-item child lookups")));
});

test("generated child resolve IDs survive a second lowering pass and are collision-safe", () => {
  const p = compiled([{ ...action("M18.A09", { formId: named("form", "Intake"), answers: [{ fieldId: named("form_field", "Email"), value: "a@example.com" }] }), id: "lookup_1" }]);
  assert.deepEqual(p.steps.map((s) => s.id), ["lookup_2", "lookup_3", "lookup_1"]);
});

test("a missing lookup reference cannot be shadowed by a new generated child ID", () => {
  const steps = [action("M18.A09", { formId: "$lookup_1.id", answers: [{ fieldId: named("form_field", "Email"), value: "a@example.com" }] })];
  assert.equal(lowerLookups(steps, registry).steps[0]!.id, "lookup_2");
  const result = compile(plan(steps), registry);
  assert.ok(!result.ok && result.errors.some((e) => e.includes("$lookup_1 is not an earlier step")));
});

test("changed child identities invalidate destructive approval, just like changed top-level targets", async () => {
  const w = world();
  const p = w.f.pipeline({ name: "Approval Pipeline", stages: [{ id: "st_keep", name: "New", probability: 10 }, { id: "st_old", name: "Review", probability: 30 }] });
  const compiledPlan = compiled([action("M05.A09", { pipelineId: named("pipeline", p.name), stageId: named("stage", "Review") })]);
  const gate = await execute(compiledPlan, registry, w, { executionId: "child-approval" });
  assert.equal(gate.status, "awaiting_confirmation");
  assert.equal(gate.pending!.preview[0]!.args.stageId, "st_old");
  w.store.update("pipelines", p.id, { stages: [{ id: "st_keep", name: "New", probability: 10 }, { id: "st_old", name: "Previous Review", probability: 30 }, { id: "st_new", name: "Review", probability: 50 }] });
  const changed = await execute(compiledPlan, registry, w, { executionId: "child-approval", approvals: [gate.pending!] });
  assert.equal(changed.status, "awaiting_confirmation");
  assert.equal(changed.pending!.changed, true);
  assert.equal(changed.pending!.preview[0]!.args.stageId, "st_new");
  assert.equal(w.store.get<{ stages: unknown[] }>("pipelines", p.id)!.stages.length, 3);
});
