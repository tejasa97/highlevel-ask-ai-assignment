import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import type { SubmitPlan } from "../planner/submit-plan.js";
import { loadRegistry, type Registry } from "../registry/registry.js";
import { world } from "../store/world.js";
import { compile } from "./compile.js";
import { execute } from "./execute.js";

let registry: Registry;
before(async () => { registry = await loadRegistry(); });
const lookup = (entity: string, name: string, where?: Record<string, string>) => ({ $lookup: { entity, name, ...(where ? { where } : {}) } });
const action = (id: string, action: string, args: unknown) => ({ id, kind: "action" as const, action, argsJson: JSON.stringify(args) });
const plan = (steps: SubmitPlan["steps"]): SubmitPlan => ({ type: "plan", steps, question: null, options: null, reason: null, alternatives: null, query: null, text: null });
function compiled(p: SubmitPlan, offered?: Set<string>) {
  const c = compile(p, registry, offered);
  if (!c.ok) assert.fail(c.errors.join("\n"));
  return c.plan;
}

describe("model-independent named arguments", () => {
  test("one action finds and runs an existing report, with no extra planner round", async () => {
    const ctx = world();
    const report = ctx.f.savedReport({ name: "Monthly Revenue", metric: "revenue" });
    const p = compiled(plan([action("run", "M50.A07", { reportId: lookup("report", report.name) })]), new Set(["M50.A07"]));
    assert.deepEqual(p.steps.map((s) => s.kind), ["resolve", "action"]);
    const r = await execute(p, registry, ctx, { executionId: "named-report" });
    assert.equal(r.status, "done");
    assert.ok(ctx.store.get<{ lastRunAt: string }>("saved_reports", report.id)?.lastRunAt);
  });

  test("zero matches fails without creating a replacement or writing", async () => {
    const ctx = world();
    const before = ctx.store.all("saved_reports");
    const r = await execute(compiled(plan([action("run", "M50.A07", { reportId: lookup("report", "Missing report") })])), registry, ctx, { executionId: "missing-report" });
    assert.equal(r.status, "failed");
    assert.equal(r.steps[0]?.error?.code, "NOT_FOUND");
    assert.equal(r.steps[1]?.status, "skipped");
    assert.deepEqual(ctx.store.all("saved_reports"), before);
  });

  test("duplicate names require clarification rather than taking the first", async () => {
    const ctx = world();
    ctx.f.savedReport({ name: "Monthly Revenue" });
    ctx.f.savedReport({ name: "Monthly Revenue" });
    const r = await execute(compiled(plan([action("run", "M50.A07", { reportId: lookup("report", "Monthly Revenue") })])), registry, ctx, { executionId: "ambiguous-report" });
    assert.equal(r.status, "needs_clarification");
    assert.equal(r.clarification?.candidates.length, 2);
    assert.equal(ctx.store.audit().length, 0);
  });

  test("company qualifiers narrow duplicate contacts BEFORE name ranking", async () => {
    const ctx = world();
    const sarahs = ctx.store.find<{ id: string; name: string; company: string }>("contacts", (r) => r.name === "Sarah Johnson");
    assert.equal(sarahs.length, 2);
    const expected = sarahs.find((s) => s.company === "Brightside")!;
    const p = compiled(plan([action("get", "M01.A02", { contactId: lookup("contact", "Sarah Johnson", { company: "brightside" }) })]));
    const r = await execute(p, registry, ctx, { executionId: "qualified-sarah" });
    assert.equal(r.status, "done");
    assert.equal((r.steps.at(-1)?.output as { id: string }).id, expected.id);
    assert.deepEqual(registry.resolver("contact")!(ctx.store, "Sarah Johnson", { company: "Unknown" }), []);
  });

  test("nested stage names are scoped by pipeline, including references to an earlier resolve", async () => {
    const ctx = world();
    const pipeline = ctx.f.pipeline({ name: "Partners", stages: [{ id: "st_partner", name: "Proposal", probability: 20 }] });
    ctx.f.pipeline({ name: "Enterprise", stages: [{ id: "st_enterprise", name: "Proposal", probability: 30 }] });
    const p = compiled(plan([
      { id: "parent", kind: "resolve", entity: "pipeline", name: "Partners" },
      action("probability", "M05.A10", { pipelineId: "$parent.id", stageId: lookup("stage", "Proposal", { pipelineId: "$parent.id" }), probability: 70 }),
    ]));
    const r = await execute(p, registry, ctx, { executionId: "qualified-stage" });
    assert.equal(r.status, "done");
    assert.equal(ctx.store.get<{ stages: { probability: number }[] }>("pipelines", pipeline.id)?.stages[0]?.probability, 70);
  });

  test("the normal permission check still applies after name resolution", async () => {
    const ctx = world();
    ctx.f.savedReport({ name: "Monthly Revenue" });
    const actor = ctx.f.user({ roles: ["support"] });
    const p = compiled(plan([action("run", "M50.A07", { reportId: lookup("report", "Monthly Revenue") })]));
    const r = await execute(p, registry, { ...ctx, actorId: actor.id }, { executionId: "permission" });
    assert.equal(r.status, "failed");
    assert.equal(r.steps.at(-1)?.error?.code, "PERMISSION");
  });

  test("external actions still need approval, and changing a lookup target invalidates approval", async () => {
    const ctx = world();
    const first = ctx.f.website({ name: "Acme", pages: [{ id: "pg_a", title: "Home", slug: "home", landingPageId: null }], homePageId: "pg_a" });
    const p = compiled(plan([action("publish", "M35.A09", { websiteId: lookup("website", "Acme") })]));
    const gate = await execute(p, registry, ctx, { executionId: "approval" });
    assert.equal(gate.status, "awaiting_confirmation");
    assert.equal(gate.pending?.preview[0]?.args.websiteId, first.id);
    ctx.store.update("websites", first.id, { name: "Old Acme" });
    const second = ctx.f.website({ name: "Acme", pages: [{ id: "pg_b", title: "Home", slug: "home", landingPageId: null }], homePageId: "pg_b" });
    const changed = await execute(p, registry, ctx, { executionId: "approval", approvals: [gate.pending!] });
    assert.equal(changed.status, "awaiting_confirmation");
    assert.equal(changed.pending?.changed, true);
    assert.equal(changed.pending?.preview[0]?.args.websiteId, second.id);
  });

  test("invalid entities, qualifiers and wrong ID types fail before any execution", () => {
    for (const args of [
      { reportId: lookup("calendar", "Sales") },
      { reportId: lookup("report", "Monthly", { company: "Acme" }) },
      { reportId: lookup("report", " ") },
      { reportId: { $lookup: { entity: "report", name: "Monthly", surprise: true } } },
    ]) assert.equal(compile(plan([action("s1", "M50.A07", args)]), registry).ok, false);
    assert.equal(compile(plan([action("s1", "M06.A01", { title: lookup("report", "Monthly") })]), registry).ok, false);
    assert.equal(compile(plan([action("s1", "M50.A07", { reportId: lookup("report", "Monthly") })]), registry, new Set()).ok, false);
  });

  test("generated resolve IDs cannot collide with user step IDs, and qualifiers affect the plan hash", () => {
    const one = compiled(plan([action("lookup_1", "M01.A02", { contactId: lookup("contact", "Sarah Johnson", { company: "Brightside" }) })]));
    const two = compiled(plan([action("lookup_1", "M01.A02", { contactId: lookup("contact", "Sarah Johnson", { company: "Umbrella" }) })]));
    assert.equal(new Set(one.steps.map((s) => s.id)).size, one.steps.length);
    assert.notEqual(one.hash, two.hash);
  });

  test("qualifier interpolation is dependency checked, including forward and array references", () => {
    for (const company of ["prefix {{$future.id}}", "$future.id", "{{$find.items[*].company}}"])
      assert.equal(compile(plan([
        action("find", "M01.A03", {}),
        action("get", "M01.A02", { contactId: lookup("contact", "Sarah Johnson", { company }) }),
      ]), registry).ok, false, company);
    const c = compiled(plan([
      action("find", "M01.A02", { contactId: "ct_31" }),
      action("get", "M01.A02", { contactId: lookup("contact", "Sarah Johnson", { company: "{{$find.company}}" }) }),
    ]));
    const resolved = c.steps.find((s) => s.kind === "resolve")!;
    assert.ok(resolved.deps.includes("find"));
  });

  test("a name written in an ID field becomes a lookup; IDs, refs and ambiguous fields are left alone", () => {
    const named = compiled(plan([action("run", "M50.A07", { reportId: "Monthly Revenue" })]));
    assert.deepEqual(named.steps.map((s) => s.kind), ["resolve", "action"]);
    assert.equal((named.steps[0] as { name: string }).name, "Monthly Revenue");
    const id = compiled(plan([action("run", "M50.A07", { reportId: "rpt_1" })]));
    assert.deepEqual(id.steps.map((s) => s.kind), ["action"]);
    const ref = compiled(plan([action("find", "M01.A03", {}), action("run", "M50.A07", { reportId: "$find.items[0].id" })]));
    assert.equal(ref.steps.filter((s) => s.kind === "resolve").length, 0);
    // fieldId means a custom field in one module and a form field in another: never guessed from a label.
    const label = compile(plan([action("sim", "M18.A09", { formId: "fm_1", values: {}, fieldId: "email" })]), registry);
    assert.ok(!label.ok || label.plan.steps.every((s) => s.kind !== "resolve"));
  });

  test("an unknown argument name is reported with the real names and the nearest one", () => {
    const r = compile(plan([action("s1", "M06.A01", { title: "Call Ana", dueDat: "2026-10-30" })]), registry);
    assert.ok(!r.ok);
    assert.match(r.errors.join("\n"), /arguments: .*dueDate.*did you mean dueDate/);
  });
  test("a polymorphic ID takes its entity from the sibling type, and executes", async () => {
    const ctx = world();
    const sarah = ctx.store.find<{ id: string; name: string }>("contacts", (r) => r.name === "Marco Patel")[0] ?? ctx.f.contact({ name: "Marco Patel" });
    const task = (relatedTo: unknown) => plan([action("t", "M06.A01", { title: "Send the proposal", relatedTo })]);
    const p = compiled(task({ type: "contact", id: lookup("contact", "Marco Patel") }));
    assert.deepEqual(p.steps.map((s) => s.kind), ["resolve", "action"]);
    const r = await execute(p, registry, ctx, { executionId: "typed-related" });
    assert.equal(r.status, "done");
    assert.deepEqual((r.steps.at(-1)?.output as { relatedTo: unknown }).relatedTo, { type: "contact", id: sarah.id });
    // A bare name is a lookup too, and the entity must agree with the type.
    assert.deepEqual(compiled(task({ type: "contact", id: "Marco Patel" })).steps.map((s) => s.kind), ["resolve", "action"]);
    assert.equal(compile(task({ type: "lead", id: lookup("contact", "Marco Patel") }), registry).ok, false);
    assert.equal(compile(task({ id: lookup("contact", "Marco Patel") }), registry).ok, false);
    const list = compiled(plan([action("l", "M06.A03", { relatedType: "contact", relatedId: lookup("contact", "Marco Patel") })]));
    assert.deepEqual(list.steps.map((s) => s.kind), ["resolve", "action"]);
  });

  test("records that belong to a contact are found by number, or by whose they are", async () => {
    const ctx = world();
    const elena = ctx.f.contact({ name: "Elena Costa" });
    const other = ctx.f.contact({ name: "Omar Haddad" });
    const quote = ctx.f.quote({ number: "QT-9139", contactId: elena.id });
    ctx.f.quote({ number: "QT-9140", contactId: other.id });
    const resolve = registry.resolver("quote")!;
    assert.deepEqual(resolve(ctx.store, "QT-9139").map((c) => c.id), [quote.id]);
    assert.deepEqual(resolve(ctx.store, "Elena Costa's quote").map((c) => c.id), [quote.id]);
    assert.deepEqual(resolve(ctx.store, "quote", { contact: "Elena Costa" }).map((c) => c.id), [quote.id]);
    ctx.f.quote({ number: "QT-9141", contactId: elena.id });
    assert.equal(resolve(ctx.store, "Elena Costa").length, 2);
    // A number in an ID field becomes a lookup, never an invented id.
    assert.deepEqual(compiled(plan([action("get", "M27.A02", { quoteId: "QT-9139" })])).steps.map((s) => s.kind), ["resolve", "action"]);
  });
});

