import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import type { Step, SubmitPlan } from "../planner/submit-plan.js";
import { loadRegistry, type Registry } from "../registry/registry.js";
import { compile } from "./compile.js";

let registry: Registry;
before(async () => {
  registry = await loadRegistry();
});

const plan = (steps: Step[]): SubmitPlan => ({
  type: "plan",
  steps,
  question: null,
  options: null,
  reason: null,
  alternatives: null,
  query: null,
  text: null,
});
const op = (id: string, o: "filter" | "exclude" | "forEach", fields: Partial<{ in: string | string[]; where: unknown; by: string; set: string; roundRobin: string; do: { action: string; args: unknown }[] }>): Step => ({
  id,
  kind: "op",
  op: o,
  in: fields.in ?? "$s0",
  whereJson: fields.where === undefined ? null : JSON.stringify(fields.where),
  by: fields.by ?? null,
  set: fields.set ?? null,
  roundRobin: fields.roundRobin ?? null,
  do: fields.do?.map((c) => ({ action: c.action, argsJson: JSON.stringify(c.args) })) ?? null,
});
const action = (id: string, action: string, args: unknown): Step => ({ id, kind: "action", action, argsJson: JSON.stringify(args) });

describe("forEach over a literal list", () => {
  test("takes a JSON array of strings, with $item as the string", () => {
    const r = compile(plan([op("s1", "forEach", { in: ["literal_alpha", "literal_beta"], do: [{ action: "M06.A01", args: { title: "$item" } }] })]), registry);
    assert.ok(r.ok, r.ok ? "" : r.errors.join("\n"));
    const step = r.ok ? r.plan.steps[0]! : undefined;
    assert.deepEqual(step?.kind === "forEach" ? step.in : undefined, ["literal_alpha", "literal_beta"]);
    assert.equal(step?.kind === "forEach" ? step.calls[0]!.args.title : undefined, "$item");
    const item = step?.type.items as { properties?: Record<string, { type?: string }> } | undefined;
    assert.equal(item?.properties?.item?.type, "string");
    assert.ok(item?.properties?.results, "the output keeps each item's results");
  });

  test("takes the array written as a JSON string, as json_object models send it", () => {
    const r = compile(plan([op("s1", "forEach", { in: JSON.stringify(["literal_alpha", "literal_beta"]), do: [{ action: "M06.A01", args: { title: "$item" } }] })]), registry);
    assert.ok(r.ok, r.ok ? "" : r.errors.join("\n"));
    assert.deepEqual(r.ok ? (r.plan.steps[0]!.kind === "forEach" ? r.plan.steps[0]!.in : null) : null, ["literal_alpha", "literal_beta"]);
  });

  test("rejects a malformed literal with what to write instead", () => {
    const r = compile(plan([op("s1", "forEach", { in: "[\"literal_alpha\",", do: [{ action: "M06.A01", args: { title: "$item" } }] })]), registry);
    assert.ok(!r.ok);
    assert.match(r.ok ? "" : r.errors.join("\n"), /not valid JSON; write a JSON array of strings/);
  });

  test("empty arrays compile; mixed and empty-string literals do not", () => {
    assert.ok(compile(plan([op("s1", "forEach", { in: [], do: [{ action: "M06.A01", args: { title: "$item" } }] })]), registry).ok);
    for (const input of ['["a", 1]', '[""]', '[{"id":"a"}]']) {
      const r = compile(plan([op("s1", "forEach", { in: input, do: [{ action: "M06.A01", args: { title: "$item" } }] })]), registry);
      assert.ok(!r.ok);
      assert.match(r.errors.join("\n"), /JSON array of non-empty strings/);
    }
  });

  test("a literal array is not a filter or exclude input", () => {
    const r = compile(plan([op("s1", "filter", { in: ["a"], where: {} })]), registry);
    assert.ok(!r.ok);
    assert.match(r.ok ? "" : r.errors.join("\n"), /a literal array is only for forEach/);
  });
});

describe("ref errors name the legal steps", () => {
  const badRef = (ref: string) =>
    compile(
      plan([
        { id: "s1", kind: "resolve", entity: "contact", name: "Ana" },
        action("s2", "M06.A01", { title: ref }),
      ]),
      registry,
    );

  test("lists each earlier step and its kind", () => {
    const r = badRef("$s0");
    assert.ok(!r.ok);
    assert.match(r.ok ? "" : r.errors.join("\n"), /\$s0 is not an earlier step; your steps are s1 \(resolve\)/);
  });

  test("lists action kinds too, without offering forward references", () => {
    const r = compile(plan([action("s1", "M06.A03", {}), action("s2", "M06.A01", { title: "$future" }), action("future", "M06.A01", { title: "later" })]), registry);
    assert.ok(!r.ok);
    assert.match(r.errors.join("\n"), /your steps are s1 \(action\)/);
    assert.doesNotMatch(r.errors.join("\n"), /future \(action\)/);
  });

  test("says a prompt block is not a step and to copy its value in as plain text", () => {
    for (const block of ["$looked", "$mentions", "$context"]) {
      const r = badRef(block);
      assert.ok(!r.ok);
      const errors = r.ok ? "" : r.errors.join("\n");
      assert.match(errors, new RegExp(`<${block.slice(1)}> is a prompt block, not a step`), block);
      assert.match(errors, /copy the value you need into args as plain text/, block);
    }
  });
});


describe("ambiguous linked write targets", () => {
  const named = [{ name: "Avery Lane", entity: "contact", count: 2 }];
  const write = action("w", "M01.A08", { contactId: "ct_generic", sms: false });
  test("literal writes and forEach both require resolution", () => {
    for (const steps of [[write], [action("s", "M01.A03", { query: "Avery Lane" }), op("w", "forEach", { in: "$s.items", do: [{ action: "M01.A08", args: { contactId: "$item.id", sms: false } }] })]]) {
      const r = compile(plan(steps), registry, undefined, named);
      assert.ok(!r.ok);
      assert.match(r.errors.join("\n"), /Avery Lane matches 2 contacts; use resolve so the user can choose, or ask/);
    }
  });
  test("a resolve for that name and entity satisfies the guard", () => {
    assert.ok(compile(plan([{ id: "s", kind: "resolve", entity: "contact", name: "avery lane" }, write]), registry, undefined, named).ok);
  });
  test("resolving a different name or entity does not bypass it", () => {
    for (const s of [{ id: "s", kind: "resolve" as const, entity: "contact", name: "Other Person" }, { id: "s", kind: "resolve" as const, entity: "user", name: "Avery Lane" }]) {
      assert.ok(!compile(plan([s, write]), registry, undefined, named).ok);
    }
  });
  test("reads, unrelated writes and unambiguous mentions are unaffected", () => {
    assert.ok(compile(plan([action("s", "M01.A03", {})]), registry, undefined, named).ok);
    assert.ok(compile(plan([action("s", "M06.A01", { title: "Prepare report" })]), registry, undefined, named).ok);
    assert.ok(compile(plan([write]), registry, undefined, [{ ...named[0]!, count: 1 }]).ok);
  });
});
