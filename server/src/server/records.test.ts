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

  test("records a loop made are kept for a follow-up, and the loop's reads are not", async () => {
    const ctx = world();
    const c = compile(response([
      action("s1", "M03.A03", { status: "new", limit: 2 }),
      { id: "s2", kind: "op", op: "forEach", in: "$s1.items", whereJson: null, by: null, set: null, roundRobin: null, do: [{ action: "M06.A01", argsJson: JSON.stringify({ title: "Follow up with {{$item.name}}", relatedTo: { type: "lead", id: "$item.id" } }) }] },
    ] as SubmitPlan["steps"]), registry);
    assert.ok(c.ok, JSON.stringify(c));
    const run = await execute(c.plan, registry, ctx, { executionId: "loop" });
    const tasks = rememberRecords([], c.plan, run).filter((r) => r.entity === "task");
    assert.equal(tasks.length, 2);
    assert.ok(tasks.every((t) => /^Follow up with /.test(t.name)));
  });

  test("with writesOnly, the records a search read are left out: a read-only attempt must not stand for what an amend revises", async () => {
    const ctx = world();
    const c = compile(response([action("s1", "M03.A03", { status: "new", limit: 2 })]), registry);
    assert.ok(c.ok, JSON.stringify(c));
    const run = await execute(c.plan, registry, ctx, { executionId: "reads" });
    assert.equal(rememberRecords([], c.plan, run).length, 2);
    assert.deepEqual(rememberRecords([], c.plan, run, Infinity, true), []);
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

  test("a record read by a Get action is remembered, by its number when it has no name, with the contact it is for", async () => {
    const ctx = world();
    const quote = ctx.f.quote({ number: "QT-9139" });
    const c = compile(response([action("get", "M27.A02", { quoteId: quote.id })]), registry);
    assert.ok(c.ok);
    const run = await execute(c.plan, registry, ctx, { executionId: "remember-get" });
    assert.deepEqual(rememberRecords([], c.plan, run), [{ entity: "quote", id: quote.id, name: "QT-9139", for: quote.contactId }]);
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

  test("a plan refused for a missing prerequisite (\"join ... first\") is planned again with that error", async () => {
    const ctx = world();
    const community = ctx.f.community();
    const channelId = community.channels[0]!.id;
    const who = ctx.f.contact();
    const post = action("post", "M43.A07", { communityId: community.id, channelId, body: "Hi all", contactId: who.id });
    const join = action("join", "M43.A05", { communityId: community.id, contactId: who.id });
    const replies = [response([post]), response([join, post])];
    const requests: PlanRequest[] = [];
    const planner: Planner = { name: "scripted", async plan(req) {
      requests.push(req);
      const json = replies.shift()!;
      return { model: "scripted-provider", json, text: JSON.stringify(json), usage: { input: 0, cachedRead: 0, cacheWrite: 0, output: 0, thinking: 0, costUsd: 0, billing: "none" }, latencyMs: 0 };
    } };
    const chat = new Conversation({ registry, planner, retriever: new Retriever(buildCards(registry)) }, ctx);
    const got: { status: string }[] = [];
    await chat.ask(`Post "Hi all" as ${who.name}`, "fast", "us_1", (e, d) => { if (e === "reply") got.push(d as { status: string }); });
    assert.equal(requests.length, 2);
    assert.match(requests[1]!.user, /<failed_attempt>.*first/);
    assert.equal(got.at(-1)?.status, "done");
  });
});


describe("amending the last turn", () => {
  test("an amend updates the kept record, asks before cancelling the one left out, and leaves no extra task", async () => {
    const ctx = world();
    const [ana, ben] = [ctx.f.lead(), ctx.f.lead()];
    const task = (id: string, lead: string, extra: object = {}) => action(id, "M06.A01", { title: `Call ${lead}`, relatedTo: { type: "lead", id: lead }, ...extra });
    const change = { effect: "change" as const, actions: ["M06.A01"], destination: null };
    const replies = [
      { ...response([task("s1", ana.id), task("s2", ben.id)]), outcome: change },
      { ...response([task("s1", ana.id, { dueDate: "2026-10-30" })]), outcome: { ...change, amends: true } },
    ];
    const planner: Planner = { name: "scripted", async plan() {
      const json = replies.shift()!;
      return { model: "scripted-provider", json, text: JSON.stringify(json), usage: { input: 0, cachedRead: 0, cacheWrite: 0, output: 0, thinking: 0, costUsd: 0, billing: "none" }, latencyMs: 0 };
    } };
    const chat = new Conversation({ registry, planner, retriever: new Retriever(buildCards(registry)) }, ctx);
    const quiet = () => {};
    await chat.ask(`Follow up with ${ana.id} and ${ben.id}`, "fast", "us_1", quiet);
    const made = ctx.store.all<{ id: string; status: string; dueDate: string | null; relatedTo: { id: string } | null }>("tasks").filter((t) => t.relatedTo?.id === ana.id || t.relatedTo?.id === ben.id);
    assert.equal(made.length, 2);

    const seen: { event: string; data: any }[] = [];
    await chat.ask(`Only ${ana.id}, due Friday`, "fast", "us_1", (event, data) => seen.push({ event, data }));
    const confirm = seen.find((s) => s.event === "confirm");
    assert.equal(confirm?.data.pending.stepId, "revise", JSON.stringify(seen.map((s) => s.event)));
    const row = (lead: string) => ctx.store.all<{ id: string; status: string; dueDate: string | null; relatedTo: { id: string } | null }>("tasks").filter((t) => t.relatedTo?.id === lead);
    assert.equal(row(ana.id).length, 1, "updated in place, not made again");
    assert.equal(row(ana.id)[0]!.dueDate, "2026-10-30");
    assert.equal(row(ben.id)[0]!.status, "open", "not cancelled before approval");

    const after: { event: string; data: any }[] = [];
    await chat.confirm(confirm!.data.turnId, true, "us_1", (event, data) => after.push({ event, data }));
    assert.equal(after.find((s) => s.event === "reply")?.data.status, "done", JSON.stringify(after.at(-1)));
    assert.equal(row(ben.id)[0]!.status, "cancelled");
    assert.equal(row(ana.id)[0]!.status, "open");
  });
  test("a loop that assigns the lead and makes the task is amended the same way", async () => {
    const ctx = world();
    const [ana, ben] = [ctx.f.lead(), ctx.f.lead()];
    const loop = (leads: string[], extra: object = {}) => ({
      id: "s1", kind: "op" as const, op: "forEach" as const, in: leads, whereJson: null, by: null, set: null, roundRobin: null,
      do: [
        { action: "M03.A05", argsJson: JSON.stringify({ leadId: "$item", ownerId: "us_2" }) },
        { action: "M06.A01", argsJson: JSON.stringify({ title: "Follow up", relatedTo: { type: "lead", id: "$item" }, ...extra }) },
      ],
    });
    const change = { effect: "change" as const, actions: ["M03.A05", "M06.A01"], destination: null };
    const replies = [
      { ...response([loop([ana.id, ben.id])]), outcome: change },
      { ...response([loop([ana.id], { dueDate: "2026-10-30" })]), outcome: { ...change, amends: true } },
    ];
    const planner: Planner = { name: "scripted", async plan() {
      const json = replies.shift()!;
      return { model: "scripted-provider", json, text: JSON.stringify(json), usage: { input: 0, cachedRead: 0, cacheWrite: 0, output: 0, thinking: 0, costUsd: 0, billing: "none" }, latencyMs: 0 };
    } };
    const chat = new Conversation({ registry, planner, retriever: new Retriever(buildCards(registry)) }, ctx);
    const events: { event: string; data: any }[] = [];
    const go = async (message: string) => {
      events.length = 0;
      await chat.ask(message, "fast", "us_1", (event, data) => events.push({ event, data }));
      for (let i = 0; i < 3 && events.some((e) => e.event === "confirm"); i++) {
        const turnId = events.filter((e) => e.event === "confirm").at(-1)!.data.turnId;
        events.length = 0;
        await chat.confirm(turnId, true, "us_1", (event, data) => events.push({ event, data }));
      }
    };
    await go(`Follow up with ${ana.id} and ${ben.id}`);
    await go(`Only ${ana.id}, due Friday`);
    const tasks = (lead: string) => ctx.store.all<{ status: string; dueDate: string | null; relatedTo: { id: string } | null }>("tasks").filter((t) => t.relatedTo?.id === lead);
    assert.equal(tasks(ana.id).length, 1, JSON.stringify(events.map((e) => e.event)) + JSON.stringify(events.find((e) => e.event === "reply")?.data));
    assert.equal(tasks(ana.id)[0]!.dueDate, "2026-10-30");
    assert.equal(tasks(ben.id)[0]!.status, "cancelled");
  });
});
