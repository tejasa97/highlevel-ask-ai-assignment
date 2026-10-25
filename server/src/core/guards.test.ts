import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import type { SubmitPlan } from "../planner/submit-plan.js";
import { loadRegistry, type Registry } from "../registry/registry.js";
import { world } from "../store/world.js";
import { compile } from "./compile.js";
import { execute } from "./execute.js";

let registry: Registry;
before(async () => { registry = await loadRegistry(); });
const action = (id: string, action: string, args: unknown) => ({ id, kind: "action" as const, action, argsJson: JSON.stringify(args) });
const op = (id: string, o: "filter" | "forEach", rest: Record<string, unknown>) => ({ id, kind: "op" as const, op: o, ...rest }) as unknown as NonNullable<SubmitPlan["steps"]>[number];
const plan = (steps: SubmitPlan["steps"]): SubmitPlan => ({ type: "plan", steps, question: null, options: null, reason: null, alternatives: null, query: null, text: null });
async function run(steps: SubmitPlan["steps"], ctx = world()) {
  const c = compile(plan(steps), registry);
  if (!c.ok) assert.fail(c.errors.join("\n"));
  return { ctx, r: await execute(c.plan, registry, ctx, { executionId: "guard" }) };
}

describe("a search used as if it found one record", () => {
  test("a change to every record of one duplicated name asks which", async () => {
    const ctx = world();
    ctx.f.listing({ name: "Birchwood Clinic" });
    ctx.f.listing({ name: "Birchwood Clinic" });
    const { r } = await run([
      action("s1", "M46.A03", { query: "Birchwood Clinic" }),
      op("each", "forEach", { in: "$s1.items", do: [{ action: "M46.A06", argsJson: JSON.stringify({ listingId: "$item.id", phone: "+15550987654" }) }] }),
    ], ctx);
    assert.equal(r.status, "needs_clarification");
    assert.equal(r.clarification?.candidates.length, 2);
    assert.equal(ctx.store.audit().length, 0);
  });

  test("taking the first of several matches asks which; one match goes ahead", async () => {
    const ctx = world();
    const one = ctx.f.listing({ name: "Birchwood Clinic" });
    const steps = [action("s1", "M46.A03", { query: "Birchwood Clinic" }), action("s2", "M46.A06", { listingId: "$s1.items[0].id", phone: "+15550987654" })];
    assert.equal((await run(steps, ctx)).r.status, "done");
    assert.equal(ctx.store.get<{ phone: string }>("listings", one.id)?.phone, "+15550987654");
    ctx.f.listing({ name: "Birchwood Clinic East" });
    assert.equal((await run(steps, ctx)).r.status, "needs_clarification");
  });

  test("a filter that empties a non-empty search fails instead of reporting done", async () => {
    const ctx = world();
    ctx.f.listing({ name: "Birchwood Clinic" });
    const { r } = await run([
      action("s1", "M46.A03", { query: "Birchwood Clinic" }),
      op("f1", "filter", { in: "$s1.items", whereJson: JSON.stringify({ name: "Nope" }) }),
      op("each", "forEach", { in: "$f1", do: [{ action: "M46.A06", argsJson: JSON.stringify({ listingId: "$item.id", phone: "+15550987654" }) }] }),
    ], ctx);
    assert.equal(r.status, "failed");
    assert.match(r.steps.at(-1)?.error?.message ?? "", /kept none of the 1/);
  });
});
