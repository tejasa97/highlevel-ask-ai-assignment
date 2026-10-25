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

  test("a written-out list may hold $refs to single values, but not to lists", () => {
    const r = compile(plan([action("s1", "M06.A03", {}), op("s2", "forEach", { in: ["$s1.items[0].id", "tk_9"], do: [{ action: "M06.A07", args: { taskId: "$item", priority: "high" } }] })]), registry);
    assert.ok(r.ok, r.ok ? "" : r.errors.join("\n"));
    assert.deepEqual(r.ok ? r.plan.steps[1]!.deps : [], ["s1"]);
    const list = compile(plan([action("s1", "M06.A03", {}), op("s2", "forEach", { in: ["$s1.items"], do: [{ action: "M06.A07", args: { taskId: "$item.id", priority: "high" } }] })]), registry);
    assert.match(list.ok ? "" : list.errors.join("\n"), /"in" element "\$s1\.items" is a list; give "in" that \$ref itself/);
  });

  test("a loop over a resolve is a loop over its one record", () => {
    for (const [inRef, arg, want] of [["$s1", "$item.id", "$s1"], ["$s1.items", "$item.id", "$s1"], ["$s1.items[*]", "$item.id", "$s1"], ["$s1.items[*].id", "$item", "$s1.id"]] as const) {
      const r = compile(plan([{ id: "s1", kind: "resolve", entity: "user", name: "Aisha" }, op("s2", "forEach", { in: inRef, do: [{ action: "M06.A01", args: { title: "Call", assigneeId: arg } }] })]), registry);
      assert.ok(r.ok, `${inRef}: ${r.ok ? "" : r.errors.join("\n")}`);
      assert.deepEqual(r.ok && r.plan.steps[1]!.kind === "forEach" ? r.plan.steps[1]!.in : null, [want], inRef);
    }
    const rr = compile(plan([{ id: "u1", kind: "resolve", entity: "user", name: "Ana" }, { id: "u2", kind: "resolve", entity: "user", name: "Raj" }, action("s1", "M06.A03", {}), op("s2", "forEach", { in: "$s1.items", roundRobin: JSON.stringify(["$u1.id", "$u2.id"]), do: [{ action: "M06.A05", args: { taskId: "$item.id", assigneeId: "$rr" } }] })]), registry);
    assert.ok(rr.ok, rr.ok ? "" : rr.errors.join("\n"));
  });

  test("empty arrays compile; mixed and empty-string literals do not", () => {
    assert.ok(compile(plan([op("s1", "forEach", { in: [], do: [{ action: "M06.A01", args: { title: "$item" } }] })]), registry).ok);
    for (const input of ['["a", 1]', '[""]', '[{"id":"a"}]']) {
      const r = compile(plan([op("s1", "forEach", { in: input, do: [{ action: "M06.A01", args: { title: "$item" } }] })]), registry);
      assert.ok(!r.ok);
      assert.match(r.errors.join("\n"), /JSON array of non-empty strings/);
    }
  });

  test("roundRobin takes a written-out list too, with $rr as the string", () => {
    const r = compile(plan([action("s1", "M06.A03", {}), op("s2", "forEach", { in: "$s1.items", roundRobin: JSON.stringify(["us_2", "us_4"]), do: [{ action: "M06.A02", args: { taskId: "$item.id", assigneeId: "$rr" } }] })]), registry);
    assert.ok(r.ok, r.ok ? "" : r.errors.join("\n"));
    assert.deepEqual(r.ok && r.plan.steps[1]!.kind === "forEach" ? r.plan.steps[1]!.roundRobin : null, ["us_2", "us_4"]);
    const bad = compile(plan([action("s1", "M06.A03", {}), op("s2", "forEach", { in: "$s1.items", roundRobin: '["us_2",', do: [{ action: "M06.A02", args: { taskId: "$item.id", assigneeId: "$rr" } }] })]), registry);
    assert.match(bad.ok ? "" : bad.errors.join("\n"), /"roundRobin" .* not valid JSON/);
  });

  test("a field that names the projected value is the value itself; other fields stay errors", () => {
    const steps = (rrArg: string) => plan([action("s1", "M06.A03", {}), action("s2", "M06.A03", {}), op("s3", "forEach", { in: "$s1.items", roundRobin: "$s2.items[*].assigneeId", do: [{ action: "M06.A05", args: { taskId: "$item.id", assigneeId: rrArg } }] })]);
    for (const arg of ["$rr", "$rr.assigneeId", "$rr.id"]) {
      const r = compile(steps(arg), registry);
      assert.ok(r.ok, `${arg}: ${r.ok ? "" : r.errors.join("\n")}`);
      assert.equal(r.ok && r.plan.steps[2]!.kind === "forEach" ? r.plan.steps[2]!.calls[0]!.args.assigneeId : null, "$rr", arg);
    }
    const other = compile(steps("$rr.name"), registry);
    assert.match(other.ok ? "" : other.errors.join("\n"), /\$rr is a string, it has no field "name"/);
  });

  test("a literal array is not a filter or exclude input", () => {
    const r = compile(plan([op("s1", "filter", { in: ["a"], where: {} })]), registry);
    assert.ok(!r.ok);
    assert.match(r.ok ? "" : r.errors.join("\n"), /a literal array is only for forEach/);
  });
});

describe("action ids", () => {
  test("an id followed by exactly its own name is that id; any other trailing words are not", () => {
    const r = compile(plan([action("s1", "M06.A01 Create task", { title: "Prep" })]), registry);
    assert.ok(r.ok, r.ok ? "" : r.errors.join("\n"));
    assert.equal(r.ok && r.plan.steps[0]!.kind === "action" ? r.plan.steps[0]!.call.action.id : "", "M06.A01");
    const wrong = compile(plan([action("s1", "M06.A01 Delete everything", { title: "Prep" })]), registry);
    assert.ok(!wrong.ok);
    assert.match(wrong.errors.join("\n"), /unknown action M06\.A01 Delete everything/);
  });

  test("malformed argsJson says where the JSON breaks, including past the excerpt", () => {
    const step: Step = { id: "s1", kind: "action", action: "M06.A01", argsJson: '{"title":"Call every lead from the spring campaign about the renewal pricing"}}' };
    const r = compile(plan([step]), registry);
    assert.ok(!r.ok);
    assert.match(r.errors.join("\n"), /not valid JSON: .*position \d+.*…"e renewal pricing\\"}}"/);
  });
});

describe("ref errors name the legal steps", () => {
  test("resolve path errors explain the singleton output without broadening it", () => {
    for (const ref of ["$s1.items[0].id", "$s1.userId", "$s1.memberIds"]) {
      const r = compile(plan([
        { id: "s1", kind: "resolve", entity: "user", name: "Ana" },
        action("s2", "M06.A01", { title: ref }),
      ]), registry);
      assert.ok(!r.ok);
      assert.match(r.errors.join("\n"), /Resolve returns one \{id, name\}, not a list or a full record; use \$s1\.id/);
      assert.match(r.errors.join("\n"), /Read other record fields with a listed action/);
    }
  });

  test("projected list elements use bare $item or $rr, not a record field", () => {
    for (const root of ["item", "rr"]) {
      const r = compile(plan([
        action("s1", "M06.A03", {}),
        op("s2", "forEach", { in: "$s1.items[*].id", roundRobin: "$s1.items[*].id", do: [{ action: "M06.A01", args: { title: `$${root}.title` } }] }),
      ]), registry);
      assert.ok(!r.ok);
      assert.ok(r.errors.some((e) => e.includes(`$${root} is the scalar element of its input list; use $${root} directly, without a field.`)));
    }
  });

  test("an empty loop gets a call-shape diagnostic, not a list-building suggestion", () => {
    const r = compile(plan([op("s1", "forEach", { in: ["one"] })]), registry);
    assert.ok(!r.ok);
    assert.match(r.errors.join("\n"), /does not construct a list.*action\/argsJson calls/);
  });

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

  test("an id that counts from 0, or names the step being written, is told the id to use", () => {
    const zero = badRef("$s0");
    assert.match(zero.ok ? "" : zero.errors.join("\n"), /Step ids count from s1, so the first step is s1/);

    const loop = compile(plan([
      action("s1", "M06.A03", {}),
      op("s2", "forEach", { in: "$s1.items[*].id", do: [{ action: "M06.A01", args: { title: "$s2" } }] }),
    ]), registry);
    assert.ok(!loop.ok);
    assert.match(loop.errors.join("\n"), /\$s2 is the step you are writing; a step can only use earlier ids, and the step just before it is \$s1\. Inside "do", the current item is \$item\./);
  });

  test("a ref to a step listed later says it comes later", () => {
    const r = compile(plan([action("s1", "M06.A01", { title: "$s2" }), action("s2", "M06.A01", { title: "later" })]), registry);
    assert.ok(!r.ok);
    assert.match(r.errors.join("\n"), /\$s2 comes later in your plan; list it before this step/);
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

describe("ids carry their record type", () => {
  const errorsOf = (steps: Step[]) => {
    const r = compile(plan(steps), registry);
    return r.ok ? "" : r.errors.join("\n");
  };

  test("an id of one record type can't fill an arg that takes another", () => {
    const errors = errorsOf([action("s1", "M21.A03", { status: "completed" }), action("s2", "M45.A02", { requestId: "$s1.items[0].id" })]);
    assert.match(errors, /M45\.A02 arg requestId takes a review request id, but \$s1\.items\[0\]\.id is an appointment id/);
  });

  test("inside a do, points at the sibling call that makes the record and how to loop over its results", () => {
    const errors = errorsOf([
      action("s1", "M21.A03", { status: "completed" }),
      op("s2", "forEach", { in: "$s1.items", do: [{ action: "M45.A01", args: { contactId: "$item.contactId", subject: "Review", body: "Thanks" } }, { action: "M45.A02", args: { requestId: "$item.id" } }] }),
    ]);
    assert.match(errors, /\$item\.id is an appointment id/);
    assert.match(errors, /Calls in one "do" can't use each other's results: move M45\.A02 into its own forEach step after s2, with "in": "\$s2\[\*\]\.results\[0\]\.id"/);
  });

  test("the suggested two-loop plan compiles", () => {
    const errors = errorsOf([
      action("s1", "M21.A03", { status: "completed" }),
      op("s2", "forEach", { in: "$s1.items", do: [{ action: "M45.A01", args: { contactId: "$item.contactId", subject: "Review", body: "Thanks" } }] }),
      op("s3", "forEach", { in: "$s2[*].results[0].id", do: [{ action: "M45.A02", args: { requestId: "$item" } }] }),
    ]);
    assert.equal(errors, "");
  });

  test("a field named for a type is that type, and matching types pass", () => {
    assert.equal(errorsOf([action("s1", "M21.A03", { status: "completed" }), op("s2", "forEach", { in: "$s1.items", do: [{ action: "M45.A01", args: { contactId: "$item.contactId", subject: "Review", body: "Thanks" } }] })]), "");
    assert.match(errorsOf([action("s1", "M21.A03", { status: "completed" }), op("s2", "forEach", { in: "$s1.items", do: [{ action: "M45.A01", args: { contactId: "$item.leadId", subject: "Review", body: "Thanks" } }] })]), /takes a contact id, but \$item\.leadId is a lead id/);
  });

  test("ids of unknown type, and args that don't name one, are not checked", () => {
    assert.equal(errorsOf([action("s1", "M21.A03", { status: "completed" }), action("s2", "M06.A01", { title: "Call", assigneeId: "$s1.items[0].hostId" })]), "");
    assert.equal(errorsOf([action("s1", "M21.A03", { status: "completed" }), action("s2", "M06.A01", { title: "$s1.items[0].id" })]), "");
  });

  test("a resolve's id has the resolved type", () => {
    assert.match(errorsOf([{ id: "s1", kind: "resolve", entity: "user", name: "Ana" }, action("s2", "M45.A01", { contactId: "$s1.id", subject: "Review", body: "Thanks" })]), /takes a contact id, but \$s1\.id is a user id/);
  });

  test("over ids of a known type, .<type>Id names the element itself", () => {
    const r = compile(plan([action("s1", "M48.A03", {}), action("s2", "M03.A03", {}), op("s3", "forEach", { in: "$s2.items", roundRobin: "$s1.items[*].id", do: [{ action: "M03.A05", args: { leadId: "$item.id", ownerId: "$rr.userId" } }] })]), registry);
    assert.ok(r.ok, r.ok ? "" : r.errors.join("\n"));
    const step = r.ok ? r.plan.steps[2]! : undefined;
    assert.equal(step?.kind === "forEach" ? step.calls[0]!.args.ownerId : undefined, "$rr");
  });
});
