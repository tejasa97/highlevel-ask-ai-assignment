import assert from "node:assert/strict";
import { before, test } from "node:test";
import { compile } from "../core/compile.js";
import { loadRegistry, Registry } from "../registry/registry.js";
import { world } from "../store/world.js";
import { checkIdentity, emptyTargets, outcomeErrors } from "./contracts.js";
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

test("read outcomes may run queries with bookkeeping without lowering execution risk", () => {
  for (const [id, args] of [["M50.A07", { reportId: "rpt_1" }], ["M17.A09", { triggerId: "trg_1", payload: {} }]] as const) {
    const plan = compiled(id, args);
    assert.deepEqual(outcomeErrors(plan, { effect: "read", actions: [id], destination: null }), []);
    assert.equal(registry.get(id)!.risk, "write");
    assert.equal(registry.get(id)!.query, true);
  }
});

test("query metadata cannot disguise an external or destructive action", () => {
  for (const id of ["M13.A03", "M01.A05"]) {
    const action = registry.get(id)!;
    assert.ok(["external", "destructive"].includes(action.risk));
    assert.throws(() => new Registry().register({ actions: [{ ...action, query: true }] }), /cannot hide/);
  }
});

test("delivery metadata distinguishes similarly named posting actions", () => {
  const surfaces = registry.deliverySurfaces();
  assert.ok(surfaces.some((s) => s.id === "community" && s.actions.includes("M43.A07")));
  assert.ok(surfaces.some((s) => s.id === "blog" && s.actions.includes("M38.A09")));
  // Scheduling a draft is how it reaches the blog later; publishing now refuses drafts.
  assert.deepEqual(outcomeErrors(compiled("M38.A08", { postId: "bp_1", publishAt: "2026-12-01T15:00:00.000Z" }), { effect: "change", actions: ["M38.A08"], destination: "blog" }), []);
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

test("a change looped over a list that was already read and found empty is reported; reads and non-empty lists are not", () => {
  const each = (act: string) => {
    const r = compile({ type: "plan", steps: [
      { id: "s1", kind: "action", action: "M06.A03", argsJson: "{}" },
      { id: "each", kind: "op", op: "forEach", in: "$s1.items", whereJson: null, by: null, set: null, roundRobin: null, do: [{ action: act, argsJson: JSON.stringify({ taskId: "$item.id", assigneeId: "us_5" }) }] },
    ], question: null, options: null, reason: null, alternatives: null, query: null, text: null } satisfies SubmitPlan, registry);
    assert.ok(r.ok, r.ok ? "" : r.errors.join("\n"));
    return r.plan;
  };
  const plan = each("M06.A05");
  assert.deepEqual(emptyTargets(plan, [{ id: "s1", output: { items: [] } }]), [{ step: "each", list: "$s1.items" }]);
  assert.deepEqual(emptyTargets(plan, [{ id: "s1", output: { items: [{ id: "tk_1" }] } }]), []);
  assert.deepEqual(emptyTargets(plan, [{ id: "s1", error: "boom" }]), []);
  assert.deepEqual(emptyTargets(plan, []), []);
});

test("a request to send is not done by only creating the draft that would be sent", () => {
  const plan = compiled("M45.A01", { contactId: "ct_1", subject: "Visit feedback", body: "Please review your visit." });
  const outcome = { effect: "change" as const, actions: ["M45.A01"], destination: null };
  const offered = ["M45.A01", "M45.A02"].map((id) => registry.get(id)!);
  assert.match(outcomeErrors(plan, outcome, { message: "Send a review request to Ana", offered }).join("\n"), /M45.A02/);
  assert.deepEqual(outcomeErrors(plan, outcome, { message: "Draft a review request for Ana, don't send it yet", offered }), []);
  assert.deepEqual(outcomeErrors(plan, outcome, { message: "Create a review request for Ana", offered }), []);
});

test("an action that emails its own record already sends it", () => {
  const plan = compiled("M28.A08", { invoiceId: "inv_1" });
  const outcome = { effect: "change" as const, actions: ["M28.A08"], destination: "email" };
  const offered = ["M28.A08", "M13.A03"].map((id) => registry.get(id)!);
  assert.deepEqual(outcomeErrors(plan, outcome, { message: "Send a reminder for invoice INV-1003", offered }), []);
  for (const id of ["M27.A08", "M28.A07", "M28.A08"]) assert.equal(registry.get(id)!.destination?.id, "email", id);
});

test("course qualifiers on lessons and enrollments take the course's title as well as its id", () => {
  const w = world();
  const course = w.f.course({ title: "Sales 101", status: "published" });
  const lesson = w.f.lesson({ courseId: course.id, title: "Intro" });
  w.f.enrollment({ courseId: course.id, contactId: "ct_11" });
  for (const where of [{ course: "Sales 101" }, { courseId: "sales 101" }, { courseId: course.id }]) {
    assert.equal(checkIdentity({ entity: "lesson", name: lesson.title, whereJson: JSON.stringify(where) }, registry, w.store).count, 1, JSON.stringify(where));
  }
  const enrolled = w.store.all<{ contactId: string; courseId: string }>("enrollments").find((e) => e.courseId === course.id)!;
  const owner = w.store.get<{ name: string }>("contacts", enrolled.contactId)!.name;
  for (const where of [{ course: "Sales 101", contact: owner }, { courseId: "Sales 101", contactId: owner }]) {
    assert.ok(checkIdentity({ entity: "enrollment", name: "enrollment", whereJson: JSON.stringify(where) }, registry, w.store).count >= 1, JSON.stringify(where));
  }
  assert.equal(checkIdentity({ entity: "enrollment", name: "enrollment", whereJson: JSON.stringify({ course: "No Such Course" }) }, registry, w.store).count, 0);
});
