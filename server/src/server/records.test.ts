import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { compile } from "../core/compile.js";
import { execute } from "../core/execute.js";
import type { SubmitPlan } from "../planner/submit-plan.js";
import type { Planner, PlanRequest } from "../planner/types.js";
import { loadRegistry, type Registry } from "../registry/registry.js";
import { buildCards } from "../retrieval/cards.js";
import { Retriever } from "../retrieval/retrieve.js";
import { world } from "../store/world.js";
import { Conversation } from "./conversation.js";
import { MAX_RECORDS, rememberRecords } from "./records.js";

let registry: Registry;
before(async () => { registry = await loadRegistry(); });
const response = (steps: SubmitPlan["steps"]): SubmitPlan => ({ type: "plan", steps, question: null, options: null, reason: null, alternatives: null, query: null, text: null });
const action = (id: string, action: string, args: unknown) => ({ id, kind: "action" as const, action, argsJson: JSON.stringify(args) });

describe("typed session identities", () => {
  test("a fresh provider-independent call receives actual created identities, and reset forgets them", async () => {
    const requests: PlanRequest[] = [];
    const replies = [
      response([action("create", "M43.A01", { name: "Customer Hub" })]),
      response([action("join", "M43.A05", { communityId: { $lookup: { entity: "community", name: "Customer Hub" } }, contactId: "ct_35" })]),
      { ...response(null), type: "answer" as const, text: "Ready" },
    ];
    const planner: Planner = { name: "scripted", async plan(req) {
      requests.push(req);
      const json = replies.shift()!;
      return { model: "scripted-provider", json, text: JSON.stringify(json), usage: { input: 0, cachedRead: 0, cacheWrite: 0, output: 0, thinking: 0, costUsd: 0, billing: "none" }, latencyMs: 0 };
    } };
    const ctx = world();
    const chat = new Conversation({ registry, planner, retriever: new Retriever(buildCards(registry)) }, ctx);
    await chat.ask("Create a community called Customer Hub", "fast", "us_1", () => {});
    await chat.ask("Add Elodie Mercer to it", "fast", "us_1", () => {});
    const text = requests[1]!.user.match(/<recent_records>(.*?)<\/recent_records>/)![1]!;
    assert.deepEqual(JSON.parse(text), [{ entity: "community", id: "com_1", name: "Customer Hub" }]);
    assert.equal(ctx.store.all("community_members").length, 1);
    assert.equal(requests.length, 2, "inline name lookup must not need an extra planner call");
    chat.reset(world());
    await chat.ask("Hello", "fast", "us_1", () => {});
    assert.ok(!requests[2]!.user.includes("<recent_records>"));
  });

  test("only observed identities are kept, bounded and without mutable record contents", async () => {
    const ctx = world();
    for (let i = 0; i < MAX_RECORDS + 5; i++) ctx.f.savedReport({ name: `Report ${i}` });
    const c = compile(response([action("list", "M50.A03", {})]), registry);
    assert.ok(c.ok);
    const run = await execute(c.plan, registry, ctx, { executionId: "remember" });
    const remembered = rememberRecords([], c.plan, run);
    assert.equal(remembered.length, MAX_RECORDS);
    assert.ok(remembered.every((r) => Object.keys(r).sort().join() === "entity,id,name"));
    const again = rememberRecords(remembered, c.plan, run);
    assert.equal(again.length, MAX_RECORDS);
    assert.equal(new Set(again.map((r) => r.id)).size, MAX_RECORDS);
    const failed = { ...run, steps: run.steps.map((s) => ({ ...s, status: "failed" as const })) };
    assert.deepEqual(rememberRecords([], c.plan, failed), []);
  });

  test("a record read by a Get action is remembered, by its number when it has no name", async () => {
    const ctx = world();
    const quote = ctx.f.quote({ number: "QT-9139" });
    const c = compile(response([action("get", "M27.A02", { quoteId: quote.id })]), registry);
    assert.ok(c.ok);
    const run = await execute(c.plan, registry, ctx, { executionId: "remember-get" });
    assert.deepEqual(rememberRecords([], c.plan, run), [{ entity: "quote", id: quote.id, name: "QT-9139" }]);
  });

  test("a plan that fails on a fixable error before changing anything is planned again, once, with the errors", async () => {
    const requests: PlanRequest[] = [];
    const wrong = response([action("get", "M50.A07", { reportId: { $lookup: { entity: "report", name: "Monthly Revnue" } } })]);
    const right = response([action("get", "M50.A07", { reportId: { $lookup: { entity: "report", name: "Monthly Revenue" } } })]);
    const replies = [wrong, right, wrong, wrong];
    const planner: Planner = { name: "scripted", async plan(req) {
      requests.push(req);
      const json = replies.shift()!;
      return { model: "scripted-provider", json, text: JSON.stringify(json), usage: { input: 0, cachedRead: 0, cacheWrite: 0, output: 0, thinking: 0, costUsd: 0, billing: "none" }, latencyMs: 0 };
    } };
    const ctx = world();
    ctx.f.savedReport({ name: "Monthly Revenue" });
    const chat = new Conversation({ registry, planner, retriever: new Retriever(buildCards(registry)) }, ctx);
    const replies1: { status: string }[] = [];
    await chat.ask("Run the Monthly Revenue report", "fast", "us_1", (e, d) => { if (e === "reply") replies1.push(d as { status: string }); });
    assert.equal(requests.length, 2);
    assert.match(requests[1]!.user, /<failed_attempt>.*no report matches/);
    assert.equal(replies1.at(-1)?.status, "done");
    // A second failure is the answer: no third plan.
    const replies2: { status: string }[] = [];
    await chat.ask("Run the Monthly Revnue report", "fast", "us_1", (e, d) => { if (e === "reply") replies2.push(d as { status: string }); });
    assert.equal(requests.length, 4);
    assert.deepEqual(replies2.map((r) => r.status), ["failed"]);
  });
});

