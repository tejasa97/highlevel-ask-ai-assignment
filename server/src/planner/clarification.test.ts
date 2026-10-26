import assert from "node:assert/strict";
import { before, test } from "node:test";
import { loadRegistry, type Registry } from "../registry/registry.js";
import { world } from "../store/world.js";
import { assessClarification } from "./clarification.js";
import { SUBMIT_PLAN_SCHEMA, type SubmitPlan } from "./submit-plan.js";

let registry: Registry;
before(async () => { registry = await loadRegistry(); });
const named = (entity: string, name: string, where?: Record<string, string>) => ({ $lookup: { entity, name, ...(where ? { where } : {}) } });
const question = (action: string, argument: string, args: object = {}, extra: Partial<SubmitPlan> = {}): SubmitPlan => ({
  type: "clarify", question: "Please clarify", steps: null, options: null, reason: null, alternatives: null, query: null, text: null,
  clarification: "choice", lookup: null, missing: { action, argument, argsJson: JSON.stringify(args) }, ...extra,
});
const offered = () => new Set(registry.list().map((a) => a.id));

test("new wire replies require an argument binding field", () => {
  assert.ok(SUBMIT_PLAN_SCHEMA.required.includes("missing"));
});

test("a genuine required content input can be asked without a store", () => {
  assert.deepEqual(assessClarification(question("M06.A01", "title"), registry, offered(), "Create a task"), { kind: "question" });
});

test("unbound, unknown, unoffered, optional and already-supplied questions are rejected", () => {
  const w = world();
  for (const q of [
    question("M06.A01", "title", {}, { missing: null }),
    question("M99.A99", "title"), question("M06.A01", "madeUp"),
    question("M06.A01", "dueDate", { title: "Call" }),
    question("M06.A01", "title", { title: "Already supplied" }),
    question("M06.A01", "title", { injectedArgument: true }),
  ]) assert.throws(() => assessClarification(q, registry, offered(), "Create a task", w.store));
  assert.throws(() => assessClarification(question("M06.A01", "title"), registry, new Set(), "Create a task", w.store), /<actions>/);
});

test("a lookup sent with a question about a plain value is ignored, not a reason to reject it", () => {
  const w = world();
  const post = named("blog_post", "Fall product update");
  const ask = question("M38.A08", "publishAt", { postId: post }, { clarification: "content", lookup: { entity: "blog_post", name: "Fall product update", whereJson: null } });
  assert.deepEqual(assessClarification(ask, registry, offered(), "Schedule the Fall product update post to go live on November 2", w.store), { kind: "question" });
  const wrong = question("M01.A07", "contactId", {}, { clarification: "identity", lookup: { entity: "blog_post", name: "Fall product update", whereJson: null } });
  assert.throws(() => assessClarification(wrong, registry, offered(), "Give Zoe to Aisha", w.store), /does not match/);
});

test("an optional input the message points at but never gives can be asked for", () => {
  const w = world();
  const ask = (message: string) => assessClarification(question("M01.A01", "email", { firstName: "Sarah" }), registry, offered(), message, w.store);
  assert.deepEqual(ask("Create a contact named Sarah with this email address."), { kind: "question" });
  assert.throws(() => ask("Create a contact named Sarah"), /optional/);
  assert.equal(ask("Add Sarah as a new contact using the email I'm pasting.").kind, "question");
  assert.throws(() => ask("Create Sarah and send her an email"), /optional/);
  assert.throws(() => ask("Email Sarah and create her as a contact"), /optional/);
});

test("ID questions cannot bypass grounding by choosing the choice/content category", () => {
  const w = world();
  for (const clarification of ["choice", "content", "identity", null] as const) {
    const result = assessClarification(question("M49.A05", "teamId", { userId: "us_6", teamId: named("team", "Sales") }, { clarification }), registry, offered(), "Noah helps Sales", w.store);
    assert.equal(result.kind, "identity");
    if (result.kind === "identity") assert.equal(result.check.match?.id, "tm_1");
  }
});

test("a missing selector still finds lowercase team references, without selecting a write target", () => {
  const w = world();
  const before = w.store.get("teams", "tm_1");
  const result = assessClarification(question("M49.A05", "teamId", { userId: "us_6" }), registry, offered(), "Noah is going to help out on the sales team for a while", w.store);
  assert.equal(result.kind, "facts");
  if (result.kind === "facts") assert.match(result.digest, /tm_1/);
  assert.deepEqual(w.store.get("teams", "tm_1"), before);
});

test("real missing identities with no supplied name remain a user question", () => {
  const w = world();
  const result = assessClarification(question("M13.A03", "contactId", { subject: "Hello", body: "Hello" }), registry, offered(), "Send a message; no recipient specified", w.store);
  assert.equal(result.kind, "question");
});

test("an optional identity explicitly named in the request can still be genuinely ambiguous", () => {
  const w = world();
  w.f.user({ name: "Jordan Resolver" }); w.f.user({ name: "Jordan Resolver" });
  const result = assessClarification(question("M06.A01", "assigneeId", { title: "Follow up", assigneeId: named("user", "Jordan Resolver") }), registry, offered(), "Assign to Jordan Resolver", w.store);
  assert.equal(result.kind, "identity");
  if (result.kind === "identity") assert.equal(result.check.count, 2);
});

test("wrong entity and unknown qualifiers cannot be hidden inside an argument binding", () => {
  const w = world();
  assert.throws(() => assessClarification(question("M49.A05", "teamId", { teamId: named("contact", "Sarah Johnson") }), registry, offered(), "Add a member", w.store), /does not match/);
  assert.throws(() => assessClarification(question("M13.A03", "contactId", {}, { lookup: { entity: "contact", name: "Sarah Johnson", whereJson: '{"invented":"value"}' } }), registry, offered(), "Email Sarah Johnson", w.store), /qualifier/);
});

test("equivalent inline/root qualifiers do not conflict merely because JSON key order differs", () => {
  const w = world();
  const result = assessClarification(question("M13.A03", "contactId", { contactId: named("contact", "Sarah Johnson", { company: "Brightside", email: "sarah@brightside.example" }) }, {
    lookup: { entity: "contact", name: "Sarah Johnson", whereJson: '{"email":"sarah@brightside.example","company":"Brightside"}' },
  }), registry, offered(), "Email Sarah Johnson", w.store);
  assert.equal(result.kind, "identity");
});

test("a saved email route does not require a new body or recipient", () => {
  assert.throws(() => assessClarification(question("M13.A03", "body", { emailId: "em_1" }), registry, offered(), "Send the draft"), /complete input alternative/);
});

test("nested field questions bind to the actual form, including a named parent", () => {
  const w = world();
  const field = { id: "field_north", label: "Work email", type: "email" as const, required: true, options: [], validation: { minLength: null, maxLength: null, pattern: null }, mapsTo: "email" };
  const form = w.f.form({ name: "North Scope", fields: [field] });
  w.f.form({ name: "South Scope", fields: [{ ...field, id: "field_south" }] });
  const result = assessClarification(question("M18.A09", "answers[0].fieldId", { formId: named("form", form.name), answers: [{ fieldId: named("form_field", field.label), value: "x@example.com" }] }), registry, offered(), "Use Work email", w.store);
  assert.equal(result.kind, "identity");
  if (result.kind === "identity") assert.equal(result.check.match?.id, "field_north");
});

test("ambiguous parents are asked about before any child is selected", () => {
  const w = world();
  w.f.form({ name: "Twin Intake" }); w.f.form({ name: "Twin Intake" });
  const result = assessClarification(question("M18.A09", "answers[0].fieldId", { formId: named("form", "Twin Intake"), answers: [{ fieldId: named("form_field", "Email"), value: "x@example.com" }] }), registry, offered(), "Use Twin Intake", w.store);
  assert.equal(result.kind, "identity");
  if (result.kind === "identity") { assert.equal(result.lookup.entity, "form"); assert.equal(result.check.count, 2); }
});

test("an absent array item cannot be fabricated to claim a nested required field", () => {
  assert.throws(() => assessClarification(question("M18.A09", "answers[0].fieldId", { formId: "fm_1", answers: [] }), registry, offered(), "Submit the form"), /does not exist/);
});
