import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import type { SubmitPlan } from "../planner/submit-plan.js";
import { loadRegistry, type Registry } from "../registry/registry.js";
import { frozenClock } from "../store/clock.js";
import { Store } from "../store/db.js";
import { seed } from "../store/seed.js";
import { compile, type CompiledPlan } from "./compile.js";
import { execute } from "./execute.js";

let registry: Registry;
before(async () => {
  registry = await loadRegistry();
});

function fresh() {
  const clock = frozenClock();
  const store = new Store();
  seed(store, clock);
  return { store, clock };
}

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

describe("facebook leads workflow", () => {
  test("pauses at the bulk gate, then resumes without doing anything twice", async () => {
    const ctx = fresh();
    const p = compiled(facebookWorkflow);
    const targets = ctx.store.find<{ source: string; ownerId: string | null; createdAt: string }>(
      "leads",
      (l) => l.source === "facebook_ads" && l.ownerId === null && l.createdAt.slice(0, 10) >= "2026-10-12" && l.createdAt.slice(0, 10) <= "2026-10-18",
    );
    assert.ok(targets.length >= 4, `seed should have ≥4 targets, has ${targets.length}`);

    const first = await execute(p, registry, ctx, { executionId: "ex1" });
    assert.equal(first.status, "awaiting_confirmation");
    assert.equal(first.pending?.stepId, "s5");
    assert.equal(first.pending?.count, targets.length);
    assert.equal(ctx.store.all("tasks").length, 12, "nothing written before approval");

    const second = await execute(p, registry, ctx, { executionId: "ex1", approvals: [first.pending!] });
    assert.equal(second.status, "done", JSON.stringify(second.steps.at(-1)));
    const owners = targets.map((t) => ctx.store.get<{ ownerId: string }>("leads", (t as unknown as { id: string }).id)!.ownerId);
    assert.ok(!owners.includes("us_3"), "Lucia is unavailable and gets nothing");
    assert.deepEqual([...new Set(owners)].sort(), ["us_2", "us_4", "us_5"].slice(0, Math.min(3, targets.length)).sort());
    assert.equal(ctx.store.all("tasks").length, 12 + targets.length);

    // Running it again with the same id replays from the ledger.
    const third = await execute(p, registry, ctx, { executionId: "ex1", approvals: [first.pending!] });
    assert.equal(ctx.store.all("tasks").length, 12 + targets.length, "no duplicate tasks");
    assert.ok(third.steps.at(-1)!.items!.every((i) => i.replayed === 2));
  });

  test("asks again when the targets changed after the preview", async () => {
    const ctx = fresh();
    const p = compiled(facebookWorkflow);
    const first = await execute(p, registry, ctx, { executionId: "ex2" });
    ctx.store.insert("leads", "ld", {
      firstName: "New",
      lastName: "Lead",
      name: "New Lead",
      email: null,
      source: "facebook_ads",
      status: "new",
      score: 10,
      ownerId: null,
      createdAt: "2026-10-14T10:00:00.000Z",
    });
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
