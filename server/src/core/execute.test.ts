import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import type { SubmitPlan } from "../planner/submit-plan.js";
import { loadRegistry, type Registry } from "../registry/registry.js";
import { world } from "../store/world.js";
import { compile, type CompiledPlan } from "./compile.js";
import { execute } from "./execute.js";
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
  fields: { in: string; where?: unknown; by?: string; set?: string; roundRobin?: string; do?: { action: string; args: unknown }[] },
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

  test("forward ref", () => {
    assert.match(errs(plan([action("s1", "M03.A05", { leadId: "$s2.id", ownerId: "us_2" }), action("s2", "M03.A03", {})])), /not an earlier step/);
  });

  test("made-up param and bad enum", () => {
    const e = errs(plan([action("s1", "M03.A03", { source: "facebook", color: "red" })]));
    assert.match(e, /source/);
    assert.match(e, /color/);
  });

  test("list where a single value is needed", () => {
    const e = errs(plan([action("s1", "M03.A03", {}), action("s2", "M03.A05", { leadId: "$s1.items[*].id", ownerId: "us_2" })]));
    assert.match(e, /needs a single value/);
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

describe("runtime outcomes", () => {
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
