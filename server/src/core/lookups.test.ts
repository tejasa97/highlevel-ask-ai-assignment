import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import type { SubmitPlan } from "../planner/submit-plan.js";
import { loadRegistry, type Registry } from "../registry/registry.js";
import { world } from "../store/world.js";
import { compile } from "./compile.js";
import { execute } from "./execute.js";
import { summarize } from "./summarize.js";
import { bindNerLookups } from "../planner/ner_bind.js";

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

  test("funnel step names are scoped by funnel, and removing one still asks first", async () => {
    const ctx = world();
    const steps = ["Registration", "Thank You"].map((name, i) => ({ id: `st_${i + 1}`, name, landingPageId: null, visits: 0, advanced: 0 }));
    const funnel = ctx.f.funnel({ name: "Webinar Signup", steps });
    ctx.f.funnel({ name: "Other", steps: [{ id: "st_9", name: "Registration", landingPageId: null, visits: 0, advanced: 0 }] });
    const parent = lookup("funnel", "Webinar Signup");
    const order = compiled(plan([action("order", "M36.A05", { funnelId: parent, stepIds: [lookup("funnel_step", "Thank You"), lookup("funnel_step", "Registration")] })]), new Set(["M36.A05"]));
    const r = await execute(order, registry, ctx, { executionId: "funnel-order" });
    assert.equal(r.status, "done");
    assert.deepEqual(ctx.store.get<{ steps: { name: string }[] }>("funnels", funnel.id)!.steps.map((s) => s.name), ["Thank You", "Registration"]);

    const drop = compiled(plan([action("drop", "M36.A06", { funnelId: parent, stepId: lookup("funnel_step", "Registration") })]), new Set(["M36.A06"]));
    const paused = await execute(drop, registry, ctx, { executionId: "funnel-drop" });
    assert.equal(paused.status, "awaiting_confirmation");
    assert.equal(ctx.store.get<{ steps: unknown[] }>("funnels", funnel.id)!.steps.length, 2);
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
    const ref = compiled(plan([action("find", "M50.A03", {}), action("run", "M50.A07", { reportId: "$find.items[0].id" })]));
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
    const sent = ctx.f.quote({ number: "QT-9141", contactId: elena.id, status: "sent" });
    assert.equal(resolve(ctx.store, "Elena Costa").length, 2);
    // Its state tells two of hers apart: "Elena Costa's sent quote".
    assert.deepEqual(resolve(ctx.store, "Elena Costa's sent quote").map((c) => c.id), [sent.id]);
    // A number in an ID field becomes a lookup, never an invented id.
    assert.deepEqual(compiled(plan([action("get", "M27.A02", { quoteId: "QT-9139" })])).steps.map((s) => s.kind), ["resolve", "action"]);
  });

  test("one name in two arguments of a call is two records: the qualified one, then the other", async () => {
    const ctx = world();
    const sarahs = ctx.store.find<{ id: string; name: string; company: string | null }>("contacts", (c) => c.name === "Sarah Johnson");
    const brightside = sarahs.find((c) => c.company === "Brightside")!, other = sarahs.find((c) => c !== brightside)!;
    const p = compiled(plan([action("merge", "M01.A06", { keepId: lookup("contact", "Sarah Johnson"), duplicateId: lookup("contact", "Sarah Johnson", { company: "Brightside" }) })]));
    const gate = await execute(p, registry, ctx, { executionId: "merge-sarahs" });
    assert.equal(gate.status, "awaiting_confirmation");
    assert.deepEqual(gate.pending?.preview[0]?.args, { keepId: other.id, duplicateId: brightside.id });
  });

  test("a name looked up next to an id the call already holds is the other record", async () => {
    const ctx = world();
    const sarahs = ctx.store.find<{ id: string; name: string; company: string | null }>("contacts", (c) => c.name === "Sarah Johnson");
    const brightside = sarahs.find((c) => c.company === "Brightside")!, other = sarahs.find((c) => c !== brightside)!;
    const p = compiled(plan([action("merge", "M01.A06", { keepId: brightside.id, duplicateId: lookup("contact", "Sarah Johnson") })]));
    const gate = await execute(p, registry, ctx, { executionId: "merge-sarahs-held" });
    assert.equal(gate.status, "awaiting_confirmation");
    assert.deepEqual(gate.pending?.preview[0]?.args, { keepId: brightside.id, duplicateId: other.id });
  });

  test("the user's pick for a name is not bound to a lookup told to skip that record", () => {
    const ctx = world();
    const brightside = ctx.store.find<{ id: string; name: string; company: string | null }>("contacts", (c) => c.name === "Sarah Johnson" && c.company === "Brightside")[0]!;
    const p = compiled(plan([action("merge", "M01.A06", { keepId: brightside.id, duplicateId: lookup("contact", "Sarah Johnson") })]));
    const pick = { entity: "contact", id: brightside.id, name: brightside.name, text: "Sarah Johnson", provenance: "user-selected" as const, matchReason: "exact-name" as const, fingerprint: "" };
    const bound = bindNerLookups(p, [], registry, { store: ctx.store, picks: [pick] });
    assert.equal(bound.kind, "plan");
    assert.ok(bound.kind === "plan" && bound.plan.steps.every((s) => s.kind !== "resolve" || !s.bound));
  });

  test("a lookup whose name is an id is that id, even for a record type nothing resolves by name", () => {
    const p = compiled(plan([action("s1", "M45.A09", { reviewId: lookup("review", "rv_2"), body: "Thank you." })]));
    assert.deepEqual(p.steps.map((s) => s.kind), ["action"]);
    assert.equal((p.steps[0] as unknown as { call: { args: { reviewId: string } } }).call.args.reviewId, "rv_2");
  });

  test("a resolve step given a record's own id finds that record, for a write too", async () => {
    const ctx = world();
    const contact = ctx.store.all<{ id: string }>("contacts")[0]!.id;
    const made = await execute(compiled(plan([action("s1", "M47.A01", { title: "Login loop", body: "Stuck", contactId: contact })])), registry, ctx, { executionId: "by-id-make" });
    const ticket = (made.steps[0]!.output as { id: string }).id;
    const r = await execute(compiled(plan([{ id: "s1", kind: "resolve", entity: "ticket", name: ticket, whereJson: null }, action("s2", "M47.A06", { ticketId: "$s1.id", status: "in_progress" })])), registry, ctx, { executionId: "by-id-write" });
    assert.equal(r.status, "done", JSON.stringify(r.steps));
    assert.equal(ctx.store.get<{ status: string }>("tickets", ticket)?.status, "in_progress");
    for (const [entity, table] of [["contact", "contacts"], ["user", "users"]] as const) {
      const own = ctx.store.all<{ id: string }>(table)[0]!.id;
      const read = await execute(compiled(plan([{ id: "s1", kind: "resolve", entity, name: own, whereJson: null }])), registry, ctx, { executionId: `by-id-${entity}` });
      assert.equal(read.status, "done", entity);
      assert.equal((read.steps[0]!.output as { id: string }).id, own);
    }
  });

  test("an ID that can be several kinds of record takes a lookup of any of them, and no other kind", () => {
    const set = (entity: string) => plan([action("s1", "M10.A09", { fieldId: "cf_1", recordId: lookup(entity, "Sarah Johnson"), value: "x" })]);
    for (const entity of ["contact", "lead", "opportunity", "company"]) assert.ok(compile(set(entity), registry).ok, entity);
    const wrong = compile(set("course"), registry);
    assert.ok(!wrong.ok);
    assert.match(wrong.errors.join("\n"), /arg recordId: invalid \$lookup/);
  });

  test("an entitlement's target is looked up as the kind its type names", () => {
    const add = (type: string) => plan([action("s1", "M44.A05", { planId: "mp_1", type, targetId: lookup(type, "Starter") })]);
    for (const type of ["course", "community"]) assert.ok(compile(add(type), registry).ok, type);
  });

  test("the same name twice with no qualifier asks which one fills the first argument, by its role", async () => {
    const ctx = world();
    const p = compiled(plan([action("merge", "M01.A06", { keepId: lookup("contact", "Sarah Johnson"), duplicateId: lookup("contact", "Sarah Johnson") })]));
    const r = await execute(p, registry, ctx, { executionId: "merge-sarahs-ask" });
    assert.equal(r.status, "needs_clarification");
    assert.equal(r.clarification?.candidates.length, 2);
    assert.match(summarize(p, r, registry), /Which one is the contact that stays\?$/);
  });
});

