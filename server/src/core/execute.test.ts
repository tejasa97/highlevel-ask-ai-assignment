import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import type { SubmitPlan } from "../planner/submit-plan.js";
import { loadRegistry, type Registry } from "../registry/registry.js";
import { world } from "../store/world.js";
import { compile, type CompiledPlan } from "./compile.js";
import { execute, matches, narrowByRequest } from "./execute.js";
import { valueAt } from "./refs.js";

let registry: Registry;
before(async () => {
  registry = await loadRegistry();
});

const fresh = () => world();

const action = (id: string, act: string, args: unknown) => ({ id, kind: "action" as const, action: act, argsJson: JSON.stringify(args) });
const op = (
  id: string,
  o: "filter" | "exclude" | "forEach",
  fields: { in: string | string[]; where?: unknown; by?: string; set?: string; roundRobin?: string; do?: { action: string; args: unknown }[] },
) => ({
  id,
  kind: "op" as const,
  op: o,
  in: fields.in,
  whereJson: fields.where === undefined ? null : JSON.stringify(fields.where),
  by: fields.by ?? null,
  set: fields.set ?? null,
  roundRobin: fields.roundRobin ?? null,
  do: fields.do?.map((c) => ({ action: c.action, argsJson: JSON.stringify(c.args) })) ?? null,
});
const plan = (steps: SubmitPlan["steps"]): SubmitPlan => ({
  type: "plan",
  steps,
  question: null,
  options: null,
  reason: null,
  alternatives: null,
  query: null,
  text: null,
});

function compiled(p: SubmitPlan): CompiledPlan {
  const r = compile(p, registry);
  if (!r.ok) assert.fail(r.errors.join("\n"));
  return r.plan;
}

// "Assign last week's Facebook leads round-robin to available members of the Sales team, and create a follow-up task for each."
const facebookWorkflow = plan([
  { id: "s1", kind: "resolve", entity: "team", name: "Sales" },
  action("s2", "M49.A09", { teamId: "$s1.id" }),
  op("s3", "filter", { in: "$s2.members", where: { available: true } }),
  action("s4", "M03.A03", { source: "facebook_ads", createdFrom: "2026-10-12", createdTo: "2026-10-18", unassigned: true }),
  op("s5", "forEach", {
    in: "$s4.items",
    roundRobin: "$s3",
    do: [
      { action: "M03.A05", args: { leadId: "$item.id", ownerId: "$rr.userId" } },
      {
        action: "M06.A01",
        args: { title: "Follow up with {{$item.name}}", assigneeId: "$rr.userId", dueDate: "2026-10-22", relatedTo: { type: "lead", id: "$item.id" } },
      },
    ],
  }),
]);

describe("preflight subset approval", () => {
  const tickets = () => compiled(plan([
    action("s1", "M47.A03", {}),
    op("s2", "filter", { in: "$s1.items", where: { id: { in: ["tic_1", "tic_4"] } } }),
    op("s3", "forEach", { in: "$s2", do: [{ action: "M47.A08", args: { ticketId: "$item.id", body: "Update" } }] }),
  ]));
  test("forEach previews eligible/blocked items, rechecks a changed subset, then sends exactly once", async () => {
    const ctx = fresh(), p = tickets(), baseline = ctx.store.all("emails").length;
    const first = await execute(p, registry, ctx, { executionId: "subset" });
    assert.equal(first.status, "awaiting_confirmation");
    assert.equal(first.pending?.count, 1);
    assert.equal(first.pending?.blockedCount, 1);
    assert.equal(ctx.store.all("emails").length, baseline);
    ctx.store.update("contacts", "ct_38", { email: "owen@example.com" });
    const changed = await execute(p, registry, ctx, { executionId: "subset", approvals: [first.pending!] });
    assert.equal(changed.status, "awaiting_confirmation");
    assert.equal(changed.pending?.changed, true);
    assert.equal(changed.pending?.count, 2);
    assert.equal(changed.pending?.blockedCount, undefined);
    assert.equal(ctx.store.all("emails").length, baseline);
    const done = await execute(p, registry, ctx, { executionId: "subset", approvals: [changed.pending!] });
    assert.equal(done.status, "done");
    assert.equal(ctx.store.all("emails").length, baseline + 2);
    const again = await execute(p, registry, ctx, { executionId: "subset", approvals: [changed.pending!] });
    assert.equal(again.status, "done");
    assert.equal(ctx.store.all("emails").length, baseline + 2);
  });
  test("recipient changes invalidate an approval even if ticket ids/body are unchanged", async () => {
    const ctx = fresh(), p = tickets();
    const first = await execute(p, registry, ctx, { executionId: "recipient" });
    ctx.store.update("contacts", "ct_35", { email: "new@example.com" });
    ctx.store.update("tickets", "tic_1", { requesterEmail: "new@example.com" });
    const next = await execute(p, registry, ctx, { executionId: "recipient", approvals: [first.pending!] });
    assert.equal(next.status, "awaiting_confirmation");
    assert.equal(next.pending?.changed, true);
    assert.equal(next.pending?.preview[0]?.target?.to, "new@example.com");
  });
  test("all-blocked plans fail without an empty approval or effects", async () => {
    const ctx = fresh();
    const p = compiled(plan([action("s1", "M47.A08", { ticketId: "tic_4", body: "Update" })]));
    const baseline = ctx.store.all("emails").length;
    const r = await execute(p, registry, ctx, { executionId: "blocked" });
    assert.equal(r.status, "failed");
    assert.equal(r.pending, undefined);
    assert.match(r.steps[0]!.error!.message, /email address/);
    assert.equal(ctx.store.all("emails").length, baseline);
  });
  test("one approval over a run of sends names every step it covers", async () => {
    const ctx = fresh();
    const p = compiled(plan([
      action("s1", "M47.A08", { ticketId: "tic_4", body: "Update" }),
      action("s2", "M47.A08", { ticketId: "tic_1", body: "Update" }),
      action("s3", "M06.A01", { title: "Follow up" }),
    ]));
    const r = await execute(p, registry, ctx, { executionId: "covers" });
    assert.equal(r.status, "awaiting_confirmation");
    assert.deepEqual(r.pending?.covers, ["s1", "s2"]);
    assert.equal(r.pending?.blockedCount, 1);
    const single = await execute(compiled(plan([action("s1", "M47.A08", { ticketId: "tic_1", body: "Update" })])), registry, fresh(), { executionId: "single" });
    assert.equal(single.pending?.covers, undefined);
  });
  test("a revoked permission after preview blocks delivery despite the old approval", async () => {
    const ctx = { ...fresh(), actorId: "us_1" }, p = tickets(), baseline = ctx.store.all("emails").length;
    const first = await execute(p, registry, ctx, { executionId: "revoked" });
    ctx.store.update("users", "us_1", { status: "deactivated" });
    const result = await execute(p, registry, ctx, { executionId: "revoked", approvals: [first.pending!] });
    assert.equal(result.status, "failed");
    assert.equal(ctx.store.all("emails").length, baseline);
  });
  test("preflight does not consume injected delivery faults", async () => {
    const ctx = fresh(), p = tickets(), baseline = ctx.store.all("emails").length;
    ctx.f.fault("M47.A08", { code: "UNAVAILABLE", match: { ticketId: "tic_1" }, times: 1 });
    const first = await execute(p, registry, ctx, { executionId: "fault" });
    assert.equal(first.pending?.count, 1);
    const result = await execute(p, registry, ctx, { executionId: "fault", approvals: [first.pending!] });
    assert.equal(result.status, "failed");
    assert.equal(ctx.store.all("emails").length, baseline);
  });
});

describe("facebook leads workflow", () => {
  test("pauses at the bulk gate, then resumes without doing anything twice", async () => {
    const ctx = fresh();
    const p = compiled(facebookWorkflow);
    const targets = ctx.store.find<{ source: string; ownerId: string | null; createdAt: string }>(
      "leads",
      (l) => l.source === "facebook_ads" && l.ownerId === null && l.createdAt.slice(0, 10) >= "2026-10-12" && l.createdAt.slice(0, 10) <= "2026-10-18",
    );
    assert.ok(targets.length >= 4, `seed should have ≥4 targets, has ${targets.length}`);

    const baseTasks = ctx.store.all("tasks").length;
    const first = await execute(p, registry, ctx, { executionId: "ex1" });
    assert.equal(first.status, "awaiting_confirmation");
    assert.equal(first.pending?.stepId, "s5");
    assert.equal(first.pending?.count, targets.length);
    assert.equal(ctx.store.all("tasks").length, baseTasks, "nothing written before approval");

    const second = await execute(p, registry, ctx, { executionId: "ex1", approvals: [first.pending!] });
    assert.equal(second.status, "done", JSON.stringify(second.steps.at(-1)));
    const owners = targets.map((t) => ctx.store.get<{ ownerId: string }>("leads", (t as unknown as { id: string }).id)!.ownerId);
    assert.ok(!owners.includes("us_3"), "Lucia is unavailable and gets nothing");
    assert.deepEqual([...new Set(owners)].sort(), ["us_2", "us_4", "us_5"].slice(0, Math.min(3, targets.length)).sort());
    assert.equal(ctx.store.all("tasks").length, baseTasks + targets.length);

    // Running it again with the same id replays from the ledger.
    const third = await execute(p, registry, ctx, { executionId: "ex1", approvals: [first.pending!] });
    assert.equal(ctx.store.all("tasks").length, baseTasks + targets.length, "no duplicate tasks");
    assert.ok(third.steps.at(-1)!.items!.every((i) => i.replayed === 2));
  });

  test("asks again when the targets changed after the preview", async () => {
    const ctx = fresh();
    const p = compiled(facebookWorkflow);
    const first = await execute(p, registry, ctx, { executionId: "ex2" });
    ctx.f.lead({ source: "facebook_ads", createdAt: "2026-10-14T10:00:00.000Z" });
    const second = await execute(p, registry, ctx, { executionId: "ex2", approvals: [first.pending!] });
    assert.equal(second.status, "awaiting_confirmation");
    assert.equal(second.pending?.changed, true);
    assert.equal(second.pending?.count, first.pending!.count + 1);
  });
});

describe("compile errors the planner can act on", () => {
  const errs = (p: SubmitPlan) => {
    const r = compile(p, registry);
    assert.equal(r.ok, false);
    return (r as { errors: string[] }).errors.join("\n");
  };

  test("field on a list", () => {
    const e = errs(plan([action("s1", "M03.A03", {}), action("s2", "M03.A05", { leadId: "$s1.items.id", ownerId: "us_2" })]));
    assert.match(e, /\$s1\.items is a list; use \$s1\.items\[\*\]\.id/);
  });

  test("a filter's result is the list itself: .items on it is read as the list, any other field is refused", () => {
    const withRef = (leadId: string) => plan([action("s1", "M03.A03", {}), op("f", "filter", { in: "$s1.items", where: { score: { gte: 0 } } }), op("e", "forEach", { in: "$f.items", do: [{ action: "M03.A05", args: { leadId, ownerId: "us_2" } }] })]);
    assert.equal(compile(withRef("$item.id"), registry).ok, true);
    const e = errs(plan([action("s1", "M03.A03", {}), op("f", "filter", { in: "$s1.items", where: { score: { gte: 0 } } }), action("s2", "M03.A05", { leadId: "$f.leads[*].id", ownerId: "us_2" })]));
    assert.match(e, /already the list of records/);
  });

  test("at run time too, .items on a list is the list unless its records have an items field", () => {
    assert.deepEqual(valueAt([{ id: 1 }, { id: 2 }], [{ field: "items" }, { all: true }, { field: "id" }], "$f"), [1, 2]);
    assert.throws(() => valueAt([{ id: 1 }], [{ field: "id" }], "$f"), /has no field "id"/);
    assert.deepEqual(valueAt([{ items: [1] }], [{ index: 0 }, { field: "items" }], "$f"), [1]);
  });

  test("a filter's result is the list itself, and .items on it reads as that list", () => {
    const p = plan([action("s1", "M03.A03", {}), op("f", "filter", { in: "$s1.items", where: { score: { gte: 0 } } }), action("s2", "M03.A05", { leadId: "$f.items[*].id", ownerId: "us_2" })]);
    const one = compile(p, registry);
    assert.ok(one.ok, "a list in a single-value arg must hold exactly one value when it runs");
    assert.deepEqual(one.ok && one.plan.steps[2]!.kind === "action" ? one.plan.steps[2]!.call.one : null, [["leadId"]]);
    assert.equal(compile(plan([action("s1", "M03.A03", {}), op("f", "filter", { in: "$s1.items", where: { score: { gte: 0 } } }), op("g", "filter", { in: "$f.items", where: { score: { gte: 0 } } })]), registry).ok, true);
    const e = errs(plan([action("s1", "M03.A03", {}), op("f", "filter", { in: "$s1.items", where: { score: { gte: 0 } } }), action("s2", "M03.A05", { leadId: "$f.nope", ownerId: "us_2" })]));
    assert.match(e, /already the list of records/);
  });

  test("forward ref", () => {
    assert.match(errs(plan([action("s1", "M03.A05", { leadId: "$s2.id", ownerId: "us_2" }), action("s2", "M03.A05", { leadId: "$s1.leadId", ownerId: "us_2" })])), /not an earlier step/);
  });

  test("made-up param and bad enum", () => {
    const e = errs(plan([action("s1", "M03.A03", { source: "facebook", color: "red" })]));
    assert.match(e, /source/);
    assert.match(e, /color/);
  });

  test("list where a single value is needed", () => {
    assert.match(errs(plan([action("s1", "M03.A03", {}), action("s2", "M03.A05", { leadId: "$s1.items", ownerId: "us_2" })])), /needs a single value/);
    const inLoop = op("s2", "forEach", { in: "$s1.items", do: [{ action: "M03.A05", args: { leadId: "$s1.items[*].id", ownerId: "us_2" } }] });
    assert.match(errs(plan([action("s1", "M03.A03", {}), inLoop])), /needs a single value/);
  });

  test("$item outside forEach, $rr without roundRobin", () => {
    const e = errs(
      plan([
        action("s1", "M03.A03", {}),
        action("s2", "M03.A05", { leadId: "$item.id", ownerId: "us_2" }),
        op("s3", "forEach", { in: "$s1.items", do: [{ action: "M03.A05", args: { leadId: "$item.id", ownerId: "$rr.userId" } }] }),
      ]),
    );
    assert.match(e, /\$item only works inside forEach/);
    assert.match(e, /\$rr needs "roundRobin"/);
  });

  test("in that isn't a list", () => {
    assert.match(
      errs(plan([action("s1", "M03.A03", {}), op("s2", "forEach", { in: "$s1", do: [{ action: "M03.A05", args: { leadId: "$item.id", ownerId: "us_2" } }] })])),
      /did you mean \$s1\.items/,
    );
  });
});

describe("forEach over a literal list of ids", () => {
  test("each occurrence runs once and resuming does not duplicate writes", async () => {
    const ctx = fresh();
    const p = compiled(plan([op("s1", "forEach", { in: ["repeated", "repeated"], do: [{ action: "M06.A01", args: { title: "$item" } }] })]));
    await execute(p, registry, ctx, { executionId: "literal-repeat" });
    await execute(p, registry, ctx, { executionId: "literal-repeat" });
    assert.equal(ctx.store.all<{ title: string }>("tasks").filter((t) => t.title === "repeated").length, 2);
  });

  test("runs once per id, with $item set to the string", async () => {
    const ctx = fresh();
    const p = compiled(plan([op("s1", "forEach", { in: ["literal_alpha", "literal_beta"], do: [{ action: "M06.A01", args: { title: "$item" } }] })]));
    const r = await execute(p, registry, ctx, { executionId: "ids" });
    assert.equal(r.status, "done", JSON.stringify(r.steps[0]));
    assert.deepEqual(r.steps[0]!.items!.map((i) => i.label), ["literal_alpha", "literal_beta"]);
    assert.deepEqual((r.steps[0]!.output as { item: string }[]).map((x) => x.item), ["literal_alpha", "literal_beta"]);
    assert.deepEqual(ctx.store.all<{ title: string }>("tasks").filter((t) => t.title === "literal_alpha" || t.title === "literal_beta").map((t) => t.title).sort(), ["literal_alpha", "literal_beta"]);
  });
});

describe("null-aware filters", () => {
  test("orNull admits null and missing values but preserves bounds and other fields", async () => {
    const ctx = fresh();
    const empty = ctx.f.task({ title: "Nullfilter fixture", dueDate: null });
    const early = ctx.f.task({ title: "Nullfilter fixture", dueDate: "2026-01-01" });
    ctx.f.task({ title: "Nullfilter fixture", dueDate: "2027-01-01" });
    ctx.f.task({ title: "Nullfilter fixture", dueDate: null, status: "completed" });
    assert.equal(matches({}, { dueDate: { lt: "2026-06-01", orNull: true } }), true);
    assert.equal(matches({}, { dueDate: { lt: "2026-06-01" } }), false);
    const run = async (orNull: boolean) => execute(compiled(plan([
      action("s1", "M06.A03", { query: "Nullfilter fixture" }),
      op("s2", "filter", { in: "$s1.items", where: { dueDate: { lt: "2026-06-01", orNull }, status: "open" } }),
    ])), registry, ctx, { executionId: `null-${orNull}` });
    const yes = await run(true), no = await run(false);
    assert.deepEqual((yes.steps[1]!.output as { id: string }[]).map((x) => x.id).sort(), [empty.id, early.id].sort());
    assert.deepEqual((no.steps[1]!.output as { id: string }[]).map((x) => x.id), [early.id]);
  });

  test("a dotted path reaches a field inside a field, in a filter and an exclude", async () => {
    const ctx = fresh();
    const lead = { type: "lead" as const, id: "ld_41" };
    const mine = ctx.f.task({ title: "Dotted fixture", relatedTo: lead });
    const other = ctx.f.task({ title: "Dotted fixture", relatedTo: { type: "lead" as const, id: "ld_3" } });
    ctx.f.task({ title: "Dotted fixture", relatedTo: null });
    const r = await execute(compiled(plan([
      action("s1", "M06.A03", { query: "Dotted fixture" }),
      op("s2", "filter", { in: "$s1.items", where: { "relatedTo.id": { in: ["ld_41"] } } }),
      op("s3", "exclude", { in: "$s1.items", by: "relatedTo.id", set: "$s2[*].relatedTo.id" }),
    ])), registry, ctx, { executionId: "dotted" });
    assert.deepEqual((r.steps[1]!.output as { id: string }[]).map((x) => x.id), [mine.id]);
    assert.ok(!(r.steps[2]!.output as { id: string }[]).some((x) => x.id === mine.id));
    assert.ok((r.steps[2]!.output as { id: string }[]).some((x) => x.id === other.id));
    const bad = compile(plan([action("s1", "M06.A03", {}), op("s2", "filter", { in: "$s1.items", where: { "relatedTo.lead": "ld_41" } })]), registry);
    assert.ok(!bad.ok);
    assert.match(bad.errors.join("\n"), /no field "relatedTo.lead"; fields of relatedTo: /);
  });

  test("orNull must be a literal boolean", () => {
    const r = compile(plan([action("s1", "M06.A03", {}), op("s2", "filter", { in: "$s1.items", where: { dueDate: { lt: "2026-06-01", orNull: "yes" } } })]), registry);
    assert.ok(!r.ok);
    assert.match(r.errors.join("\n"), /orNull must be a boolean/);
  });
});

describe("runtime outcomes", () => {
  test("a filter read through .items gives the same records as read directly", async () => {
    const ctx = fresh();
    const viaItems = compiled(plan([action("s1", "M03.A03", {}), op("f", "filter", { in: "$s1.items", where: { score: { gte: 0 } } }), op("g", "filter", { in: "$f.items", where: { score: { gte: 0 } } })]));
    const direct = compiled(plan([action("s1", "M03.A03", {}), op("f", "filter", { in: "$s1.items", where: { score: { gte: 0 } } }), op("g", "filter", { in: "$f", where: { score: { gte: 0 } } })]));
    const a = await execute(viaItems, registry, ctx, { executionId: "alias-a" });
    const b = await execute(direct, registry, ctx, { executionId: "alias-b" });
    assert.equal(a.status, "done");
    assert.ok((a.steps.at(-1)!.output as unknown[]).length > 0);
    assert.deepEqual(a.steps.at(-1)!.output, b.steps.at(-1)!.output);
  });

  test("a name that isn't the asked-for type says which type it is", async () => {
    const ctx = fresh();
    ctx.f.lead({ firstName: "Quinn", lastName: "Leadonly" });
    const p = compiled(plan([{ id: "s1", kind: "resolve", entity: "contact", name: "Quinn Leadonly" }]));
    const r = await execute(p, registry, ctx, { executionId: "wrong-type" });
    assert.equal(r.steps[0]!.error?.message, 'no contact matches "Quinn Leadonly" (but a lead does)');
  });

  test("a name that only matches an unusable record says why, and nothing runs on it", async () => {
    const ctx = fresh();
    const p = compiled(plan([{ id: "s1", kind: "resolve", entity: "user", name: "Dan Ortiz" }, action("s2", "M06.A01", { title: "Forecast", assigneeId: "$s1.id" })]));
    const r = await execute(p, registry, ctx, { executionId: "inactive" });
    assert.deepEqual(r.steps[0]!.error, { code: "CONFLICT", message: "Dan Ortiz is deactivated" });
    assert.equal(r.steps[1]!.status, "skipped");
  });

  test("an active record wins over an inactive one that matches as well", async () => {
    const ctx = fresh();
    ctx.f.user({ name: "Jo", status: "deactivated" });
    ctx.f.user({ name: "Jo Quarry" });
    const found = registry.resolver("user")!(ctx.store, "Jo");
    assert.deepEqual(found.map((c) => [c.name, c.inactive]), [["Jo Quarry", undefined]]);
  });

  test("unknown name fails, dependents are skipped", async () => {
    const ctx = fresh();
    const p = compiled(plan([{ id: "s1", kind: "resolve", entity: "team", name: "Finance" }, action("s2", "M49.A09", { teamId: "$s1.id" })]));
    const r = await execute(p, registry, ctx, { executionId: "ex3" });
    assert.equal(r.status, "failed");
    assert.deepEqual(
      r.steps.map((s) => s.status),
      ["failed", "skipped"],
    );
  });

  test("a name that finds nothing stops every write, even one that doesn't use it", async () => {
    const ctx = fresh();
    const before = ctx.store.all("tasks").length;
    const p = compiled(plan([action("s1", "M06.A01", { title: "Prep" }), { id: "s2", kind: "resolve", entity: "contact", name: "Nobody Atall" }]));
    const r = await execute(p, registry, ctx, { executionId: "name-first" });
    assert.equal(r.status, "failed");
    assert.equal(ctx.store.all("tasks").length, before);
    const s1 = r.steps.find((s) => s.id === "s1")!;
    assert.equal(s1.status, "skipped");
    assert.match(s1.error!.message, /no contact matches "Nobody Atall", so nothing was changed/);
  });

  test("same names are told apart by what else the request says", async () => {
    const ctx = fresh();
    const p = compiled(plan([{ id: "s1", kind: "resolve", entity: "contact", name: "Sarah Johnson" }]));
    const vague = await execute(p, registry, ctx, { executionId: "two-sarahs", request: "email Sarah Johnson" });
    assert.equal(vague.status, "needs_clarification");
    const r = await execute(p, registry, ctx, { executionId: "brightside-sarah", request: "email Sarah Johnson at Brightside" });
    assert.equal(r.status, "done", JSON.stringify(r.steps));
    assert.equal((r.steps[0]!.output as { id: string }).id, "ct_31");
  });

  test("a write loop over a search for one shared name asks which one, or runs on the one the request picks", async () => {
    const ctx = fresh();
    const before = ctx.store.all("tasks").length;
    const p = compiled(plan([
      action("s1", "M01.A03", { query: "Sarah Johnson" }),
      op("s2", "forEach", { in: "$s1.items", do: [{ action: "M06.A01", args: { title: "$item.name" } }] }),
    ]));
    const vague = await execute(p, registry, ctx, { executionId: "loop-sarahs", request: "make a call task for Sarah Johnson" });
    assert.equal(vague.status, "needs_clarification", JSON.stringify(vague.steps));
    assert.equal(vague.clarification?.candidates.length, 2);
    assert.equal(ctx.store.all("tasks").length, before);
    const r = await execute(p, registry, ctx, { executionId: "loop-brightside", request: "make a call task for Sarah Johnson\nthe one at Brightside" });
    assert.equal(r.status, "done", JSON.stringify(r.steps));
    assert.equal(ctx.store.all("tasks").length, before + 1);
    const bare = await execute(p, registry, fresh(), { executionId: "loop-no-request" });
    assert.equal(bare.status, "needs_clarification", "without the user's words nothing picks one, so it still asks");
  });

  test("narrowing needs exactly one candidate with a detail the request names and the others lack", () => {
    const c = (id: string, detail: string) => ({ id, name: "Sarah Johnson", detail });
    const two = [c("a", "Brightside, sarah@b.example"), c("b", "sj@gmail.example")];
    assert.deepEqual(narrowByRequest(two, "email Sarah at brightside").map((x) => x.id), ["a"]);
    assert.equal(narrowByRequest(two, "email Sarah").length, 2);
    const shared = [c("a", "Acme, x"), c("b", "Acme, y")];
    assert.equal(narrowByRequest(shared, "Sarah at Acme").length, 2);
  });

  test("one bad item doesn't stop the others", async () => {
    const ctx = fresh();
    const p = compiled(
      plan([
        action("s1", "M03.A03", { status: "new" }),
        op("s2", "filter", { in: "$s1.items", where: { score: { gte: 0 } } }),
        // us_404 doesn't exist, so every item fails on its own.
        op("s3", "forEach", { in: "$s2", do: [{ action: "M03.A05", args: { leadId: "$item.id", ownerId: "us_404" } }] }),
      ]),
    );
    const first = await execute(p, registry, ctx, { executionId: "ex4" });
    const r = await execute(p, registry, ctx, { executionId: "ex4", approvals: [first.pending!] });
    assert.equal(r.steps.at(-1)!.status, "failed");
    assert.ok(r.steps.at(-1)!.items!.every((i) => i.error?.code === "NOT_FOUND"));
  });
});

describe("one value of a list in a single-ID argument", () => {
  const assign = (where: unknown) => compiled(plan([
    action("s1", "M03.A03", {}),
    op("s2", "filter", { in: "$s1.items", where }),
    action("s3", "M03.A05", { leadId: "$s2[*].id", ownerId: "us_2" }),
  ]));

  test("runs when the list holds exactly one", async () => {
    const w = fresh();
    const lead = w.store.all<{ id: string }>("leads")[0]!;
    const r = await execute(assign({ id: lead.id }), registry, w, { executionId: "one-lead" });
    assert.equal(r.status, "done", JSON.stringify(r));
    assert.equal(w.store.get<{ ownerId: string }>("leads", lead.id)!.ownerId, "us_2");
  });

  test("asks which when the list holds several, and fails without changes when it holds none", async () => {
    const w = fresh();
    const several = await execute(assign({}), registry, w, { executionId: "many-leads" });
    assert.equal(several.status, "needs_clarification");
    assert.ok(several.clarification!.candidates.length > 1);
    const none = await execute(assign({ id: "nope" }), registry, w, { executionId: "no-lead" });
    assert.equal(none.status, "failed");
    assert.match(JSON.stringify(none.steps.at(-1)!.error), /NOT_FOUND.*found nothing/);
  });
});

describe("optional arguments from empty references", () => {
  test("a lead with no owner gets its task unassigned instead of failing", async () => {
    const ctx = fresh();
    const leads = ctx.store.all<{ id: string; ownerId: string | null; status: string }>("leads").filter((l) => l.status === "new");
    assert.ok(leads.some((l) => !l.ownerId) && leads.some((l) => l.ownerId), "fixture has new leads with and without an owner");
    const p = compiled(plan([
      action("s1", "M03.A03", { status: "new", limit: 100 }),
      op("s2", "forEach", { in: "$s1.items", do: [{ action: "M06.A01", args: { title: "Follow up with {{$item.name}}", assigneeId: "$item.ownerId", relatedTo: { type: "lead", id: "$item.id" } } }] }),
    ]));
    const asked = await execute(p, registry, ctx, { executionId: "unowned" });
    assert.ok(asked.pending, "a bulk create waits for approval");
    const r = await execute(p, registry, ctx, { executionId: "unowned", approvals: [asked.pending] });
    assert.equal(r.status, "done");
    const tasks = ctx.store.all<{ assigneeId?: string | null; relatedTo?: { id: string } }>("tasks").filter((t) => leads.some((l) => l.id === t.relatedTo?.id));
    assert.equal(tasks.length, leads.length);
    for (const t of tasks) assert.equal(t.assigneeId ?? null, leads.find((l) => l.id === t.relatedTo!.id)!.ownerId);
  });
});

describe("a create whose record is already there", () => {
  test("the steps after it use the existing record, and a create on its own still reports the duplicate", async () => {
    const ctx = fresh();
    const tag = ctx.store.all<{ id: string; name: string }>("tags")[0]!;
    const contact = ctx.store.all<{ id: string; name: string; tags: string[] }>("contacts").find((c) => !c.tags.includes(tag.name))!;
    const p = compiled(plan([
      { id: "s1", kind: "resolve", entity: "contact", name: contact.name, whereJson: null } as never,
      action("s2", "M08.A01", { name: tag.name }),
      action("s3", "M08.A06", { tagId: "$s2.id", recordType: "contact", recordId: "$s1.id" }),
    ]));
    const r = await execute(p, registry, ctx, { executionId: "tag-again" });
    assert.equal(r.status, "done", JSON.stringify(r.steps));
    assert.equal((r.steps.find((s) => s.id === "s2")!.output as { id: string }).id, tag.id);
    assert.ok(ctx.store.get<{ tags: string[] }>("contacts", contact.id)!.tags.includes(tag.name));
    assert.equal(ctx.store.all("tags").filter((t: any) => t.name === tag.name).length, 1);
    const alone = await execute(compiled(plan([action("s1", "M08.A01", { name: tag.name })])), registry, ctx, { executionId: "tag-alone" });
    assert.equal(alone.status, "failed");
    assert.equal(alone.steps[0]!.error?.code, "DUPLICATE");
  });
});

describe("writes over a search see every match", () => {
  const tagged = (n: number) => {
    const ctx = fresh();
    const { id: _, ...base } = ctx.store.get<Record<string, unknown>>("contacts", "ct_1")!;
    for (let i = 0; i < n; i++) ctx.store.insert("contacts", "ct", { ...base, firstName: `Bulk${i}`, email: `bulk${i}@example.com`, tags: ["bulk"] });
    return ctx;
  };
  const bulk = (limit?: number) =>
    compiled(plan([
      action("s1", "M01.A03", { tag: "bulk", ...(limit ? { limit } : {}) }),
      op("s2", "forEach", { in: "$s1.items", do: [{ action: "M01.A04", args: { contactId: "$item.id", company: "Bulk Co" } }] }),
    ]));
  const changed = (ctx: ReturnType<typeof fresh>) => ctx.store.all<{ company: string }>("contacts").filter((c) => c.company === "Bulk Co").length;

  test("a loop over 120 matches changes all 120, not the first page", async () => {
    const ctx = tagged(120), p = bulk();
    const first = await execute(p, registry, ctx, { executionId: "bulk-120" });
    assert.equal(first.status, "awaiting_confirmation");
    assert.equal(first.pending?.count, 120);
    const r = await execute(p, registry, ctx, { executionId: "bulk-120", approvals: [first.pending!] });
    assert.equal(r.status, "done");
    assert.equal(changed(ctx), 120);
  });
  test("more matches than one search loads: refuses and changes nothing", async () => {
    const ctx = tagged(600);
    const r = await execute(bulk(), registry, ctx, { executionId: "bulk-600" });
    assert.equal(r.status, "failed");
    assert.match(r.steps.at(-1)!.error!.message, /matched 600 records but one search loads at most 500, so nothing was changed/);
    assert.equal(changed(ctx), 0);
  });
  test("a filter over a short search is short too", async () => {
    const ctx = tagged(600);
    const p = compiled(plan([
      action("s1", "M01.A03", { tag: "bulk" }),
      op("s2", "filter", { in: "$s1.items", where: { tags: { contains: "bulk" } } }),
      op("s3", "forEach", { in: "$s2.items", do: [{ action: "M01.A04", args: { contactId: "$item.id", company: "Bulk Co" } }] }),
    ]));
    const r = await execute(p, registry, ctx, { executionId: "bulk-filter" });
    assert.equal(r.status, "failed");
    assert.match(r.steps.at(-1)!.error!.message, /\$s1 matched 600/);
    assert.equal(changed(ctx), 0);
  });
  test("a limit the plan asked for is kept", async () => {
    const ctx = tagged(120), p = bulk(10);
    const first = await execute(p, registry, ctx, { executionId: "bulk-10" });
    assert.equal(first.pending?.count, 10);
    const r = await execute(p, registry, ctx, { executionId: "bulk-10", approvals: [first.pending!] });
    assert.equal(r.status, "done");
    assert.equal(changed(ctx), 10);
  });
});
