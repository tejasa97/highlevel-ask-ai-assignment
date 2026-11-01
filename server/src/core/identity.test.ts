// The identity resolver decides which record a name means; NER and embeddings only suggest. Execution revalidates a
// binding made before it ran.
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import type { SubmitPlan } from "../planner/submit-plan.js";
import { loadRegistry, type Registry } from "../registry/registry.js";
import { world } from "../store/world.js";
import { testWorld } from "../testkit.js";
import { compile, type CompiledPlan } from "./compile.js";
import { execute, type ExecEvent } from "./execute.js";
import { heldWhere, identityConfig, type IdentityQuery, resolveIdentity, revalidate, userSelected } from "./identity.js";

let registry: Registry;
before(async () => {
  registry = await loadRegistry();
});

const resolve = (q: Omit<IdentityQuery, "entity"> & { entity?: string }, w = world()) => resolveIdentity({ entity: "contact", ...q }, { registry, store: w.store });
const action = (id: string, act: string, args: unknown) => ({ id, kind: "action" as const, action: act, argsJson: JSON.stringify(args) });
const plan = (steps: SubmitPlan["steps"]): SubmitPlan => ({ type: "plan", steps, question: null, options: null, reason: null, alternatives: null, query: null, text: null });
const lookup = (name: string) => ({ $lookup: { entity: "contact", name } });
function compiled(steps: SubmitPlan["steps"]): CompiledPlan {
  const r = compile(plan(steps), registry);
  if (!r.ok) assert.fail(r.errors.join("\n"));
  return r.plan;
}
const draft = (who: string) => compiled([action("s1", "M13.A01", { contactId: lookup(who), subject: "Renewal", body: "About your renewal." })]);
let runs = 0;
async function run(p: CompiledPlan, w = world(), request?: string) {
  const events: ExecEvent[] = [];
  const r = await execute(p, registry, w, { executionId: `id${++runs}`, onEvent: (e) => events.push(e), ...(request ? { request } : {}) });
  return { r, events, w };
}

describe("resolveIdentity", () => {
  test("an exact unique email binds a write, with the record's own name", () => {
    const r = resolve({ text: "sjohnson@gmail.example", actionRisk: "write" });
    assert.equal(r.kind, "bound", r.decision);
    assert.ok(r.kind === "bound");
    assert.deepEqual([r.binding.id, r.binding.name, r.binding.text, r.binding.provenance, r.binding.matchReason], ["ct_32", "Sarah Johnson", "sjohnson@gmail.example", "exact-unique", "email"]);
    assert.ok(r.binding.updatedAt && r.binding.fingerprint);
  });

  test("an exact id binds; an id of another record type does not", () => {
    const r = resolve({ text: "ct_3", actionRisk: "write" });
    assert.ok(r.kind === "bound" && r.binding.matchReason === "id" && r.binding.name === "Ana Ruiz");
    assert.equal(resolve({ text: "co_1", actionRisk: "write" }).kind, "not_found");
  });

  test("an exact name unique in scope binds a write, with or without its accents", () => {
    const r = resolve({ text: "ana ruiz", actionRisk: "write" });
    assert.ok(r.kind === "bound" && r.binding.provenance === "exact-unique" && r.binding.name === "Ana Ruiz");
    const w = world();
    w.f.contact({ firstName: "José", lastName: "Muñoz" });
    const jose = resolve({ text: "Jose Munoz", actionRisk: "write" }, w);
    assert.ok(jose.kind === "bound" && jose.binding.name === "José Muñoz", jose.decision);
  });

  test("two exact matches are ambiguous for a write, unless the request names a detail of one", () => {
    const r = resolve({ text: "Sarah Johnson", actionRisk: "write" });
    assert.equal(r.kind, "ambiguous");
    assert.deepEqual(r.candidates.map((c) => c.matchReason), ["exact-name", "exact-name"]);
    assert.ok(resolve({ text: "Sarah Johnson", actionRisk: "write", qualifiers: "Text Sarah Johnson, the one with the gmail address" }).candidates.length === 1);
    assert.equal(resolve({ text: "Sarah Johnson", actionRisk: "write", qualifiers: "Text Sarah Johnson" }).kind, "ambiguous", "her own name in an email is no detail");
    const narrowed = resolve({ text: "Sarah Johnson", actionRisk: "write", qualifiers: "email Sarah Johnson at Brightside" });
    assert.ok(narrowed.kind === "bound" && narrowed.binding.id === "ct_31" && narrowed.binding.provenance === "lookup");
  });

  test("a near-miss recipient (one edit) is a suggestion, never a binding", () => {
    const r = resolve({ text: "Ana Ruis", actionRisk: "write" });
    assert.equal(r.kind, "suggest");
    assert.deepEqual(r.candidates.map((c) => [c.id, c.matchReason]), [["ct_3", "edit"]]);
  });

  test("a missing person with a 0.92 embedding lookalike is a suggestion, never a binding", () => {
    const r = resolve({ text: "Sara Johnston", actionRisk: "write", hints: [{ id: "ct_31", score: 0.92, method: "embed" }] });
    assert.equal(r.kind, "suggest");
    assert.deepEqual(r.candidates.map((c) => [c.id, c.name, c.matchReason]), [["ct_31", "Sarah Johnson", "embed"]]);
    assert.ok(r.candidates[0]!.score < 1);
  });

  test("an exact NER link alone is not authority: an id outside the entity or not in the store is dropped", () => {
    assert.equal(resolve({ text: "Nobody Here", actionRisk: "write", hints: [{ id: "ct_9999", method: "exact", score: 1 }] }).kind, "not_found");
    assert.equal(resolve({ text: "Nobody Here", actionRisk: "write", hints: [{ id: "co_1", method: "exact", score: 1 }] }).kind, "not_found");
  });

  test("a unique partial name asks before a write; RESOLVER_WRITE_BIND=unique binds it as a lookup", () => {
    assert.equal(resolve({ text: "Rosa", actionRisk: "write" }).kind, "suggest");
    const loose = resolveIdentity({ entity: "contact", text: "Rosa", actionRisk: "write" }, { registry, store: world().store, config: { ...identityConfig({}), writeBind: "unique" } });
    assert.ok(loose.kind === "bound" && loose.binding.provenance === "lookup" && loose.binding.name.startsWith("Rosa "));
  });

  test("staff go by first name: a unique whole-word user match binds a write, a prefix still asks", () => {
    const r = resolve({ text: "Raj", entity: "user", actionRisk: "write" });
    assert.ok(r.kind === "bound" && r.binding.provenance === "lookup" && r.binding.name === "Raj Iyer", r.decision);
    assert.equal(resolve({ text: "Ra", entity: "user", actionRisk: "write" }).kind, "suggest");
  });

  test("a record described rather than named binds a write when it alone holds every word said; people never do", () => {
    for (const [entity, text] of [["ticket", "Portal export fails"], ["ticket", "Elodie Mercer's Portal export fails"]]) {
      const r = resolve({ text: text!, entity, actionRisk: "write" });
      assert.ok(r.kind === "bound" && r.binding.id === "tic_1" && r.binding.provenance === "lookup", `${text}: ${r.decision}`);
    }
    assert.equal(resolve({ text: "Portal export", entity: "ticket", actionRisk: "write" }).kind, "bound", "part of the title is still every word said");
    assert.notEqual(resolve({ text: "Portal export broken", entity: "ticket", actionRisk: "write" }).kind, "bound", "a word no ticket holds asks");
    assert.equal(resolve({ text: "Rosa", actionRisk: "write" }).kind, "suggest", "a contact's first name still asks");
  });

  test("a record said in the plural binds its singular name: \"2 Ceramic Mugs\"", async () => {
    const w = await testWorld();
    const mug = w.f.product({ name: "Ceramic Mug" });
    w.f.product({ name: "Ceramic Bowl" });
    const r = resolveIdentity({ entity: "product", text: "Ceramic Mugs", actionRisk: "write" }, { registry, store: w.store });
    assert.ok(r.kind === "bound" && r.binding.id === mug.id, r.decision);
    w.f.product({ name: "Ceramic Mug Set" });
    assert.notEqual(resolveIdentity({ entity: "product", text: "Ceramic Mugs", actionRisk: "write" }, { registry, store: w.store }).kind, "bound", "two records holding the words still ask");
  });

  test("a read uses the unique match whatever its strength, and offers near misses back", () => {
    const r = resolve({ text: "Raj", entity: "user", actionRisk: "read" });
    assert.ok(r.kind === "bound" && r.binding.provenance === "lookup");
    const near = resolve({ text: "Ana Ruis", actionRisk: "read" });
    assert.ok(near.kind === "suggest" && near.candidates.some((c) => c.name === "Ana Ruiz"), near.decision);
  });

  test("a qualifier that matches none offers the records the name alone matches", () => {
    const r = resolve({ text: "Sarah Johnson", actionRisk: "write", where: { company: "Nowhere Inc" } });
    assert.equal(r.kind, "suggest", r.decision);
    assert.deepEqual(r.candidates.map((c) => c.id).sort(), ["ct_31", "ct_32"]);
    assert.equal(resolve({ text: "Nobody Here", actionRisk: "write", where: { company: "Nowhere Inc" } }).kind, "not_found");
    const gmail = resolve({ text: "Sarah Johnson", actionRisk: "write", where: { email: "gmail.com" } });
    assert.ok(gmail.kind === "bound" && gmail.binding.id === "ct_32", gmail.decision);
    // A pick drops the qualifier that matched none, or revalidation would reject the very record offered.
    assert.equal(gmail.kind === "bound" && gmail.binding.where, undefined);
    assert.equal(heldWhere(r, { company: "Nowhere Inc" }), undefined);
    const { store } = world();
    assert.equal(revalidate(userSelected("contact", "Sarah Johnson", r.candidates[0]!, store, heldWhere(r, { company: "Nowhere Inc" })), { registry, store }), undefined);
    assert.deepEqual(heldWhere({ kind: "ambiguous" }, { company: "Brightside" }), { company: "Brightside" });
  });

  test("a create never binds or asks: a same-named record is a duplicate warning", () => {
    const r = resolve({ text: "Sarah Johnson", actionRisk: "create" });
    assert.equal(r.kind, "suggest");
    assert.match(r.decision, /duplicate warning/);
    assert.equal(resolve({ text: "Brand New Person", actionRisk: "create" }).kind, "not_found");
  });

  test("only unusable records: not found, with the reason", () => {
    const r = resolve({ text: "Old Customer", actionRisk: "write" });
    assert.ok(r.kind === "not_found" && r.unusable[0]?.inactive === "archived");
  });

  test("thresholds come from the environment", () => {
    assert.deepEqual(identityConfig({ RESOLVER_EDIT_MAX_DISTANCE: "0", RESOLVER_SUGGEST_MAX: "3", RESOLVER_WRITE_BIND: "unique" }), { editMaxDistance: 0, suggestMax: 3, hintMin: 0, writeBind: "unique" });
  });
});

describe("execution", () => {
  test("a near-miss recipient asks did-you-mean, and nothing is written", async () => {
    const { r, events } = await run(draft("Ana Ruis"));
    assert.equal(r.status, "needs_clarification");
    assert.equal(r.clarification?.kind, "suggest");
    assert.deepEqual(r.clarification?.candidates.map((c) => c.name), ["Ana Ruiz"]);
    assert.ok(events.some((e) => e.type === "identity.resolved" && e.kind === "suggest"));
  });

  test("an exact unique email recipient binds and runs", async () => {
    const { r, events } = await run(draft("sjohnson@gmail.example"));
    assert.equal(r.status, "done", JSON.stringify(r.steps));
    assert.deepEqual(r.steps.find((s) => s.kind === "resolve")?.output, { id: "ct_32", name: "Sarah Johnson" });
    const e = events.find((e) => e.type === "identity.resolved");
    assert.ok(e && e.type === "identity.resolved" && e.binding?.provenance === "exact-unique");
  });

  test("a count or filter by name never asks", async () => {
    const { r } = await run(compiled([action("s1", "M01.A03", { query: "Sarah Johnson" })]));
    assert.equal(r.status, "done", JSON.stringify(r.steps));
  });

  test("a record deleted between resolve and execute is refused, and nothing is written", async () => {
    const w = world();
    const p = draft("Ana Ruiz");
    const r0 = resolve({ text: "Ana Ruiz", actionRisk: "write" }, w);
    assert.ok(r0.kind === "bound");
    const bound: CompiledPlan = { ...p, steps: p.steps.map((s) => (s.kind === "resolve" ? { ...s, bound: r0.binding } : s)) };
    w.store.delete("contacts", "ct_3");
    const before = w.store.all("emails").length;
    const { r, events } = await run(bound, w);
    const step = r.steps.find((s) => s.kind === "resolve");
    assert.equal(step?.error?.code, "STALE_IDENTITY");
    assert.match(step!.error!.message, /no longer exists; ask the user/);
    assert.equal(r.steps.find((s) => s.kind === "action")?.status, "skipped");
    assert.equal(w.store.all("emails").length, before);
    assert.ok(events.some((e) => e.type === "identity.resolved" && e.kind === "refused"));
  });

  test("a bound record that changed or was merged since it was chosen is refused", async () => {
    for (const patch of [{ email: "ana@elsewhere.example" }, { status: "merged", mergedInto: "ct_2" }]) {
      const w = world();
      const p = draft("Ana Ruiz");
      const r0 = resolve({ text: "Ana Ruiz", actionRisk: "write" }, w);
      assert.ok(r0.kind === "bound");
      w.store.update("contacts", "ct_3", patch);
      assert.ok(revalidate(r0.binding, { registry, store: w.store }));
      const { r } = await run({ ...p, steps: p.steps.map((s) => (s.kind === "resolve" ? { ...s, bound: r0.binding } : s)) }, w);
      assert.equal(r.steps.find((s) => s.kind === "resolve")?.error?.code, "STALE_IDENTITY", JSON.stringify(patch));
    }
  });

  test("a binding that still holds runs, and the approval preview says how each record was bound", async () => {
    const w = world();
    const p = compiled([action("s1", "M13.A03", { contactId: lookup("Ana Ruiz"), subject: "Renewal", body: "About your renewal." })]);
    const r0 = resolve({ text: "Ana Ruiz", actionRisk: "write" }, w);
    assert.ok(r0.kind === "bound");
    const { r } = await run({ ...p, steps: p.steps.map((s) => (s.kind === "resolve" ? { ...s, bound: r0.binding } : s)) }, w);
    assert.equal(r.status, "awaiting_confirmation", JSON.stringify(r.steps));
    assert.deepEqual(r.pending?.identities?.map((b) => [b.id, b.name, b.provenance]), [["ct_3", "Ana Ruiz", "exact-unique"]]);
  });
});
