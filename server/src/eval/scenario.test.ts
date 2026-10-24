import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import type { SubmitPlan } from "../planner/submit-plan.js";
import { type Planner, PlannerError } from "../planner/types.js";
import { loadRegistry, type Registry } from "../registry/registry.js";
import { buildCards } from "../retrieval/cards.js";
import { Retriever } from "../retrieval/retrieve.js";
import { check, matches, runScenario, type Scenario, ScenarioSchema } from "./scenario.js";

// The scenario runner over a scripted planner: does it drive the turn, approve, and check the right things?

let registry: Registry;
let retriever: Retriever;
before(async () => {
  registry = await loadRegistry();
  retriever = new Retriever(buildCards(registry));
});

const reply = (fields: Partial<SubmitPlan>): SubmitPlan => ({ type: "plan", steps: null, question: null, options: null, reason: null, alternatives: null, query: null, text: null, ...fields });
const action = (act: string, args: unknown) => reply({ steps: [{ id: "s1", kind: "action", action: act, argsJson: JSON.stringify(args) }] });

function scripted(...replies: SubmitPlan[]): Planner {
  return {
    name: "scripted",
    async plan() {
      const json = replies.shift();
      if (!json) throw new Error("planner called more times than scripted");
      return { model: "fake", json, text: JSON.stringify(json), usage: { input: 100, cachedRead: 0, cacheWrite: 0, output: 10, thinking: 0, costUsd: 0.01, billing: "none" }, latencyMs: 5 };
    },
  };
}

const scenario = (s: Record<string, unknown>): Scenario => ScenarioSchema.parse({ id: "t", category: "direct", modules: [], ...s });
const run = (s: Scenario, ...replies: SubmitPlan[]) => runScenario(s, { registry, retriever, planner: scripted(...replies) });

describe("runScenario", () => {
  test("confirmation checks require an actual bound approval, not a planner clarification", async () => {
    const s = scenario({ turns: [{ user: "Reply to tickets tic_1 and tic_4", approve: false }], expect: {
      status: ["cancelled"], noChanges: true, confirmation: { count: 1, blockedCount: 1 },
    } });
    const mixed = reply({ steps: [
      { id: "s1", kind: "action", action: "M47.A08", argsJson: JSON.stringify({ ticketId: "tic_1", body: "Update" }) },
      { id: "s2", kind: "action", action: "M47.A08", argsJson: JSON.stringify({ ticketId: "tic_4", body: "Update" }) },
    ] });
    assert.equal((await run(s, mixed)).pass, true);
    const failed = await run(s, reply({ type: "clarify", question: "Proceed with tic_1 only?" }));
    assert.ok(failed.failures.some((f) => f.kind === "confirmation"));
  });
  test("subscription usage stays unknown while numeric tokens accumulate across turns", async () => {
    const base = scripted(reply({ type: "clarify", question: "What should the task say?" }), action("M06.A01", { title: "Call Ana" }));
    const planner: Planner = { name: "codex-cli", async plan(req) {
      const result = await base.plan(req);
      return { ...result, usage: { ...result.usage, costUsd: null, billing: "subscription" } };
    } };
    const r = await runScenario(scenario({
      turns: [{ user: "Create a task", status: ["clarify"] }, { user: "Call Ana", status: ["done"] }],
      expect: { status: ["done"] },
    }), { registry, retriever, planner });
    assert.equal(r.pass, true);
    assert.equal(r.metrics.usage.input, 200);
    assert.equal(r.metrics.usage.output, 20);
    assert.equal(r.metrics.usage.costUsd, null);
    assert.equal(r.metrics.usage.billing, "subscription");
  });

  test("a plan that does what was asked passes every kind of check", async () => {
    const s = scenario({
      turns: [{ user: "create a task to call Ana for Raj", status: ["done"] }],
      expect: {
        status: ["done"],
        actions: { includes: ["M06.A01"], excludes: ["M06.A10"] },
        args: [{ action: "M06.A01", match: { title: { $contains: "call ana" }, assigneeId: "us_2" } }],
        state: [{ sql: "SELECT count(*) FROM tasks WHERE json_extract(data, '$.title') = 'Call Ana'", equals: 1 }],
        reply: { includes: ["Call Ana"], excludes: ["failed"] },
      },
    });
    const r = await run(s, action("M06.A01", { title: "Call Ana", assigneeId: "us_2" }));
    assert.deepEqual(r.failures, []);
    assert.equal(r.pass, true);
    assert.deepEqual(r.turns[0]!.planned, ["M06.A01"]);
    assert.equal(r.metrics.plannerRounds, 1);
    assert.equal(r.metrics.calls, 1);
    assert.equal(r.metrics.usage.costUsd, 0.01);
    assert.ok(r.metrics.firstReplyMs > 0 && r.metrics.firstReplyMs <= r.metrics.ms);
  });

  test("each failed check is reported with its kind", async () => {
    const s = scenario({
      turns: [{ user: "create a task to call Ana" }],
      expect: {
        status: ["clarify"],
        actions: { includes: ["M06.A05"], excludes: ["M06.A01"] },
        args: [{ action: "M06.A01", match: { assigneeId: "us_3" } }],
        state: [{ sql: "SELECT count(*) FROM tasks WHERE json_extract(data, '$.title') = 'Call Ana'", equals: 0 }],
        reply: { includes: ["nothing like this"], excludes: ["Call Ana"] },
        noChanges: true,
      },
    });
    const r = await run(s, action("M06.A01", { title: "Call Ana" }));
    assert.equal(r.pass, false);
    assert.deepEqual(r.failures.map((f) => f.kind).sort(), ["action-missing", "action-unwanted", "args", "changes", "reply", "reply", "state", "status"]);
  });

  test("a read run in a look round counts as done, a failed one or one never run does not", () => {
    const s = scenario({ turns: [{ user: "x" }], expect: { actions: { includes: ["M28.A10", "M47.A01"] } } });
    const turn = (calls: { action: string; args: Record<string, unknown>; error?: string }[]) => ({
      user: "x", status: "done", reply: "", offered: ["M28.A10", "M47.A01"], planned: ["M47.A01"], calls, plannerRounds: 2, planner: [], compileErrors: [], errors: [], approvals: 0, firstReplyMs: 1, ms: 1,
    });
    const detail = (calls: Parameters<typeof turn>[0]) => check(s, [turn(calls)], 0, () => 0).map((f) => f.detail);
    assert.deepEqual(detail([{ action: "M28.A10", args: {} }, { action: "M47.A01", args: {} }]), []);
    assert.match(detail([{ action: "M28.A10", args: {}, error: "boom" }])[0]!, /^M28\.A10 not planned/);
    assert.match(detail([])[0]!, /^M28\.A10 not planned/);
  });

  test("approval: approved by default, declined when the turn says so", async () => {
    const del = action("M07.A05", { noteId: "nt_1" });
    const gone = { sql: "SELECT count(*) FROM notes WHERE id = 'nt_1'", equals: 0 };
    const approved = await run(scenario({ turns: [{ user: "delete note nt_1" }], expect: { status: ["done"], state: [gone] } }), del);
    assert.deepEqual(approved.failures, []);
    assert.equal(approved.turns[0]!.approvals, 1);

    const declined = await run(scenario({ turns: [{ user: "delete note nt_1", approve: false }], expect: { status: ["cancelled"], noChanges: true, state: [{ ...gone, equals: 1 }] } }), del);
    assert.deepEqual(declined.failures, []);
  });

  test("setup adds fixtures and faults before the first turn", async () => {
    const s = scenario({
      setup: [
        { fixture: "tag", with: { name: "scenario-tag" } },
        { fault: "M06.A01", code: "UNAVAILABLE", message: "tasks are down" },
      ],
      turns: [{ user: "create a task to call Ana" }],
      expect: {
        status: ["failed"],
        state: [
          { sql: "SELECT count(*) FROM tags WHERE json_extract(data, '$.name') = 'scenario-tag'", equals: 1 },
          { sql: "SELECT count(*) FROM tasks WHERE json_extract(data, '$.title') = 'Call Ana'", equals: 0 },
        ],
      },
    });
    const r = await run(s, action("M06.A01", { title: "Call Ana" }));
    assert.deepEqual(r.failures, []);
    assert.match(r.turns[0]!.calls[0]!.error!, /UNAVAILABLE/);
  });

  test("a look reads the real record before the plan, as the same user", async () => {
    const s = scenario({
      turns: [{ user: "get appointment ap_1 and reschedule it to Monday at the same time" }],
      expect: { status: ["done"], state: [{ sql: "SELECT json_extract(data,'$.startAt') FROM appointments WHERE id='ap_1'", equals: "2026-10-26T15:00:00.000Z" }] },
    });
    const look = reply({ type: "look", steps: [{ id: "s1", kind: "action", action: "M21.A02", argsJson: JSON.stringify({ appointmentId: "ap_1" }) }] });
    const r = await run(s, look, action("M21.A04", { appointmentId: "ap_1", startAt: "2026-10-26T15:00:00.000Z" }));
    assert.deepEqual(r.failures, []);
    assert.deepEqual(r.turns[0]!.calls.map((c) => c.action), ["M21.A02", "M21.A04"]);
    assert.equal(r.metrics.plannerRounds, 2);
  });

  test("a turn that throws is recorded as an error, and the run still finishes", async () => {
    const r = await run(scenario({ turns: [{ user: "hi" }, { user: "hello again" }], expect: {} }));
    assert.equal(r.pass, false);
    assert.equal(r.turns.length, 2);
    assert.ok(r.failures.some((f) => f.kind === "error" && /more times than scripted/.test(f.detail)));
  });

  test("a run the planner couldn't serve (quota) is marked infra, apart from the app's own failures", async () => {
    const quota: Planner = { name: "quota", plan: async () => Promise.reject(new PlannerError("You've hit your session limit", "rate_limited")) };
    const r = await runScenario(scenario({ turns: [{ user: "create a task to call Ana" }], expect: { status: ["done"] } }), { registry, retriever, planner: quota });
    assert.equal(r.infra, "rate_limited");
    assert.equal(r.turns[0]!.infra, "rate_limited");
    assert.equal(r.pass, false);
    const own = await run(scenario({ turns: [{ user: "create a task to call Ana" }], expect: { status: ["clarify"] } }), action("M06.A01", { title: "Call Ana" }));
    assert.equal(own.infra, undefined);
  });

  test("an unknown fixture is a scenario error", async () => {
    await assert.rejects(run(scenario({ setup: [{ fixture: "nope" }], turns: [{ user: "x" }], expect: {} })), /no fixture "nope"/);
  });
});

describe("matches", () => {
  test("subset objects, contains-all arrays, case-insensitive strings, $contains, $absent", () => {
    assert.ok(matches({ a: 1, b: { c: "Hello", d: 2 } }, { b: { c: "hello" } }));
    assert.ok(!matches({ a: 1 }, { a: 2 }));
    assert.ok(matches({ ids: ["x", "y", "z"] }, { ids: ["z", "x"] }));
    assert.ok(!matches({ ids: ["x"] }, { ids: ["x", "y"] }));
    assert.ok(matches([{ id: 1, n: "a" }, { id: 2 }], [{ id: 2 }]));
    assert.ok(matches({ body: "Hi Sarah, the plan costs $99" }, { body: { $contains: "sarah" } }));
    assert.ok(matches({ a: 1 }, { b: { $absent: true } }));
    assert.ok(!matches({ b: 1 }, { b: { $absent: true } }));
    assert.ok(!matches("x", { a: 1 }));
  });
});
