import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { compile } from "../core/compile.js";
import { loadRegistry, type Registry } from "../registry/registry.js";
import { buildCards } from "../retrieval/cards.js";
import { Retriever } from "../retrieval/retrieve.js";
import { frozenClock } from "../store/clock.js";
import { world } from "../store/world.js";
import type { SubmitPlan } from "./submit-plan.js";
import { planTurn, type TurnDeps, type TurnEvent, withLookSteps } from "./turn.js";
import { type PlanRequest, type Planner, PlannerError } from "./types.js";

let registry: Registry;
let retriever: Retriever;
before(async () => {
  registry = await loadRegistry();
  retriever = new Retriever(buildCards(registry));
});

const reply = (fields: Partial<SubmitPlan>): SubmitPlan => ({
  type: "plan",
  steps: null,
  question: null,
  options: null,
  reason: null,
  alternatives: null,
  query: null,
  text: null,
  ...fields,
});
const createTask = (action = "M06.A01") => reply({ steps: [{ id: "s1", kind: "action", action, argsJson: JSON.stringify({ title: "Call Ana" }) }] });

/** Answers with the scripted replies in order and keeps every request it was sent. */
function scripted(...replies: SubmitPlan[]): Planner & { requests: PlanRequest[] } {
  const requests: PlanRequest[] = [];
  return {
    name: "scripted",
    requests,
    async plan(req) {
      requests.push(req);
      const json = replies.shift();
      if (!json) throw new Error("planner called more times than scripted");
      return { model: "fake", json, text: JSON.stringify(json), usage: { input: 0, cachedRead: 0, cacheWrite: 0, output: 0, thinking: 0, costUsd: 0, billing: "none" }, latencyMs: 1 };
    },
  };
}

async function run(message: string, planner: Planner, extra: { answering?: string } = {}, look?: TurnDeps["look"]) {
  const events: TurnEvent[] = [];
  const out = await planTurn({ message, tier: "fast", ...extra }, { registry, retriever, planner, clock: frozenClock(), look }, (e) => events.push(e));
  return { out, events };
}
const offeredIn = (req: PlanRequest) => [...req.user.matchAll(/\b(M\d\d\.A\d\d)\b/g)].map((m) => m[1]!);

describe("compile against what was offered", () => {
  test("rejects an implemented action the planner wasn't shown", () => {
    const r = compile(createTask(), registry, new Set(["M01.A01"]));
    assert.ok(!r.ok);
    assert.match(r.errors.join("\n"), /M06\.A01 was not in <actions>/);
  });

  test("rejects a catalog action that isn't built yet, by name", () => {
    const r = compile(createTask("M02.A03"), registry, new Set(["M02.A03"]));
    assert.ok(!r.ok);
    assert.match(r.errors.join("\n"), /M02\.A03 \(.+\) is not available in this version/);
  });

  test("without an offered set, any implemented action compiles", () => {
    assert.ok(compile(createTask(), registry).ok);
  });
});

describe("planTurn", () => {
  test("a plan from the first shortlist compiles, and carries its actions forward", async () => {
    const planner = scripted(createTask());
    const { out, events } = await run("create a task to call Ana", planner);
    assert.equal(out.kind, "plan");
    if (out.kind === "plan") assert.deepEqual(out.carry, { prev: ["M06.A01"], entities: ["task"] });
    assert.equal(planner.requests.length, 1);
    assert.ok(offeredIn(planner.requests[0]!).includes("M06.A01"));
    assert.equal(events.filter((e) => e.type === "retrieval").length, 1);
  });

  test("search_tools retrieves once more with the planner's query, then plans", async () => {
    const planner = scripted(reply({ type: "search_tools", query: "create a task" }), createTask());
    const { out, events } = await run("remind me to call Ana tomorrow", planner);
    assert.equal(out.kind, "plan");
    const traces = events.flatMap((e) => (e.type === "retrieval" ? [e.data] : []));
    assert.deepEqual(traces.map((t) => t.label), ["retrieve", "search_tools"]);
    assert.equal(traces[1]!.query, "create a task");
    // The second shortlist adds to the first; nothing is offered twice.
    const firstIds = traces[0]!.picks.map((p) => p.id);
    assert.ok(traces[1]!.picks.every((p) => !firstIds.includes(p.id)));
    assert.ok(offeredIn(planner.requests[1]!).length > offeredIn(planner.requests[0]!).length);
  });

  test("a second search without new cards gets one plan-with-what-you-have instruction", async () => {
    const planner = scripted(reply({ type: "search_tools", query: "cook risotto" }), reply({ type: "search_tools", query: "airline booking" }), reply({ type: "unsupported", reason: "No flight tools." }));
    const { out, events } = await run("book me a flight to Austin", planner);
    assert.ok(out.kind === "reply" && out.status === "unsupported");
    assert.equal(planner.requests.length, 3);
    assert.match(planner.requests[2]!.user, /Tool search is exhausted; plan with the actions already listed/);
    assert.equal(events.filter((e) => e.type === "retrieval").length, 2);
  });

  test("a productive search permits one extra search, but repeated searches cannot run away", async () => {
    const search = reply({ type: "search_tools", query: "create a task" });
    const planner = scripted(search, reply({ type: "search_tools", query: "send email" }), search, search);
    const { out, events } = await run("cook risotto", planner);
    assert.ok(out.kind === "reply" && out.status === "unsupported");
    assert.equal(planner.requests.length, 4);
    assert.equal(events.filter((e) => e.type === "retrieval").length, 3);
    assert.match(planner.requests[3]!.user, /Tool search is exhausted/);
  });

  test("an unsupported reply is checked with one more retrieval on its own words, and re-planned if that finds actions", async () => {
    const planner = scripted(reply({ type: "unsupported", reason: "I can't create a task to call Ana." }), createTask());
    const { out, events } = await run("remind me to call Ana tomorrow", planner);
    assert.equal(out.kind, "plan");
    assert.deepEqual(events.flatMap((e) => (e.type === "retrieval" ? [e.data.label] : [])), ["retrieve", "search_tools"]);
    assert.match(events.flatMap((e) => (e.type === "retrieval" ? [e.data.query] : []))[1]!, /create a task to call Ana/);
  });

  test("an unsupported reply stands once the extra retrieval has been spent", async () => {
    const planner = scripted(reply({ type: "search_tools", query: "x" }), reply({ type: "unsupported", reason: "No." }));
    const { out } = await run("have Ana join the follow-up", planner);
    assert.ok(out.kind === "reply" && out.status === "unsupported");
    assert.equal(planner.requests.length, 2);
  });

  describe("look", () => {
    const listTasks = reply({ type: "look", steps: [{ id: "s1", kind: "action", action: "M06.A03", argsJson: JSON.stringify({ query: "Ana" }) }] });

    test("runs the reads, then plans again with their results in <looked>", async () => {
      const planner = scripted(listTasks, createTask());
      const ran: string[][] = [];
      const { out } = await run("create a task like the Ana one", planner, {}, async (plan) => {
        ran.push(plan.steps.map((s) => (s.kind === "action" ? s.call.action.id : s.kind)));
        return [{ id: "s1", output: { items: [{ title: "Call Ana <soon>" }], total: 1 } }];
      });
      assert.equal(out.kind, "plan");
      assert.deepEqual(ran, [["M06.A03"]]);
      assert.equal(planner.requests.length, 2);
      assert.match(planner.requests[1]!.user, /<looked>\[\{"id":"s1","output":\{"items":\[\{"title":"Call Ana &lt;soon&gt;"\}\]/);
      assert.doesNotMatch(planner.requests[0]!.user, /<looked>/);
    });

    test("a plan after a look may still refer to the look's steps; they run first", async () => {
      const refers = reply({
        steps: [{ id: "s2", kind: "action", action: "M06.A01", argsJson: JSON.stringify({ title: "Call {{$s1.items[0].title}}" }) }],
      });
      const planner = scripted(listTasks, refers);
      const { out, events } = await run("create a task like the Ana one", planner, {}, async () => [{ id: "s1", output: { items: [{ title: "Ana" }], total: 1 } }]);
      assert.equal(out.kind, "plan");
      assert.deepEqual(out.kind === "plan" ? out.plan.steps.map((s) => s.id) : [], ["s1", "s2"]);
      assert.equal(events.filter((e) => e.type === "compile.errors").length, 0);
      assert.equal(planner.requests.length, 2, "no repair round");
    });

    test("only the look steps a plan refers to (and what they read from) are added", () => {
      const read = (id: string, args: object) => ({ id, kind: "action" as const, action: "M06.A03", argsJson: JSON.stringify(args) });
      const look = [read("s1", {}), read("s2", { query: "{{$s1.items[0].title}}" }), read("s3", {})];
      const write = (id: string, ref: string) => ({ id, kind: "action" as const, action: "M06.A01", argsJson: JSON.stringify({ title: ref }) });
      const ids = (p: SubmitPlan) => p.steps!.map((s) => s.id);
      assert.deepEqual(ids(withLookSteps(reply({ steps: [write("s4", "{{$s2.items[0].title}}")] }), look)), ["s1", "s2", "s4"]);
      assert.deepEqual(ids(withLookSteps(reply({ steps: [write("s4", "plain")] }), look)), ["s4"]);
      assert.deepEqual(ids(withLookSteps(reply({ steps: [read("s1", {}), write("s4", "{{$s1.items[0].title}}")] }), look)), ["s1", "s4"], "its own s1 wins");
    });

    test("a write in a look is never run; it goes to repair", async () => {
      const planner = scripted(reply({ ...createTask(), type: "look" }), createTask());
      let looks = 0;
      const { out, events } = await run("create a task to call Ana", planner, {}, async () => (looks++, []));
      assert.equal(out.kind, "plan");
      assert.equal(looks, 0);
      assert.match(events.flatMap((e) => (e.type === "compile.errors" ? e.data.errors : [])).join("\n"), /M06\.A01 is a write action; a look may only read/);
    });

    test("only one look per turn", async () => {
      const planner = scripted(listTasks, listTasks, createTask());
      let looks = 0;
      const { out } = await run("create a task like the Ana one", planner, {}, async () => (looks++, []));
      assert.equal(out.kind, "plan");
      assert.equal(looks, 1);
      assert.match(planner.requests[2]!.user, /you already looked/);
    });

    test("an answer after a look runs the look as the plan, so the reply is the summary of the reads", async () => {
      const planner = scripted(listTasks, reply({ type: "answer", text: "Ana has one task, owned by us_2." }));
      const { out } = await run("show me Ana's tasks", planner, {}, async () => [{ id: "s1", output: { items: [], total: 0 } }]);
      assert.ok(out.kind === "plan", JSON.stringify(out));
      assert.deepEqual(out.plan.steps.map((s) => (s.kind === "action" ? s.call.action.id : s.kind)), ["M06.A03"]);
    });

    test("without a way to look, a look is sent back for repair", async () => {
      const planner = scripted(listTasks, createTask());
      const { out } = await run("create a task like the Ana one", planner);
      assert.equal(out.kind, "plan");
      assert.match(planner.requests[1]!.user, /look isn't available here/);
    });
  });

  test("using an action that wasn't offered gets one repair round", async () => {
    const planner = scripted(createTask("M48.A01"), createTask());
    const { out, events } = await run("create a task to call Ana", planner);
    assert.equal(out.kind, "plan");
    const errs = events.flatMap((e) => (e.type === "compile.errors" ? e.data.errors : []));
    assert.match(errs.join("\n"), /M48\.A01 was not in <actions>/);
    assert.match(planner.requests[1]!.user, /M48\.A01 was not in <actions>/);
  });

  test("a plan that only finds records gets one repair round, so it never ends done with nothing said", async () => {
    const findOnly = reply({ steps: [{ id: "s1", kind: "resolve", entity: "contact", name: "Ana" }] });
    const { out, events } = await run("create a task to call Ana", scripted(findOnly, createTask()));
    assert.equal(out.kind, "plan");
    assert.match(events.flatMap((e) => (e.type === "compile.errors" ? e.data.errors : [])).join("\n"), /calls no action/);
    const again = await run("create a task to call Ana", scripted(findOnly, findOnly));
    assert.ok(again.out.kind === "reply" && again.out.status === "failed");
  });

  test("a listed write verb repairs an all-read plan, but a pure question uses it directly", async () => {
    const reads = reply({ steps: [{ id: "s1", kind: "action", action: "M06.A03", argsJson: "{}" }] });
    const planner = scripted(reads, createTask());
    const result = await run("create a task", planner);
    assert.equal(result.out.kind, "plan");
    assert.match(planner.requests[1]!.user, /the plan only finds records; add the action that does it/);
    const question = scripted(reads);
    assert.equal((await run("which tasks are overdue?", question)).out.kind, "plan");
    assert.equal(question.requests.length, 1);
  });

  test("a plan still invalid after the repair fails the turn", async () => {
    const planner = scripted(createTask("M48.A01"), createTask("M48.A01"));
    const { out } = await run("create a task to call Ana", planner);
    assert.ok(out.kind === "reply" && out.status === "failed");
  });

  test("the repair round may answer unsupported, as the error for an unbuilt action asks", async () => {
    const planner = scripted(createTask("M02.A03"), reply({ type: "unsupported", reason: "Companies aren't in this version." }), reply({ type: "unsupported", reason: "Still not." }));
    const { out } = await run("create a task to call Ana", planner);
    assert.ok(out.kind === "reply" && out.status === "unsupported", JSON.stringify(out));
    assert.match(planner.requests[1]!.user, /M02\.A03 \(.+\) is not available in this version/);
  });

  test("the repair round may ask for search_tools; the plan after it is the last chance", async () => {
    const planner = scripted(createTask("M48.A01"), reply({ type: "search_tools", query: "create a task" }), createTask());
    const { out, events } = await run("remind me to call Ana tomorrow", planner);
    assert.equal(out.kind, "plan", JSON.stringify(out));
    assert.deepEqual(
      events.flatMap((e) => (e.type === "planner.request" ? [e.data.label] : [])),
      ["plan", "repair", "plan after search_tools"],
    );
    // Both budgets are spent: an invalid plan now ends the turn instead of a fourth call.
    const again = scripted(createTask("M48.A01"), reply({ type: "search_tools", query: "create a task" }), createTask("M48.A01"));
    const r = await run("remind me to call Ana tomorrow", again);
    assert.ok(r.out.kind === "reply" && r.out.status === "failed");
    assert.equal(again.requests.length, 3);
  });

  test("clarify and unsupported pass through with their options and alternatives", async () => {
    const q = await run("create a task", scripted(reply({ type: "clarify", question: "What should the task say?", options: ["Call Ana", "Email Ana"] })));
    assert.deepEqual(q.out, { kind: "reply", status: "clarify", text: "What should the task say?", options: ["Call Ana", "Email Ana"] });
    const u = await run("send Priya an invoice reminder", scripted(reply({ type: "unsupported", reason: "Invoices aren't in this version." }), reply({ type: "unsupported", reason: "Invoices aren't in this version.", alternatives: ["Create a task to follow up"] })));
    assert.ok(u.out.kind === "reply" && u.out.status === "unsupported");
    if (u.out.kind === "reply") assert.match(u.out.text, /Alternatives: Create a task to follow up/);
  });

  test("schema issues get one repair, with the rejected JSON and issue paths", async () => {
    const malformed = { type: "plan", steps: 42 } as unknown as SubmitPlan;
    const planner = scripted(malformed, createTask());
    const { out, events } = await run("create a task", planner);
    assert.equal(out.kind, "plan");
    assert.match(planner.requests[1]!.user, /submit_plan steps:/);
    assert.match(planner.requests[1]!.user, /<rejected_plan>\{"type":"plan","steps":42\}/);
    assert.ok(events.some((e) => e.type === "compile.errors"));
    const again = scripted(malformed, malformed);
    const { out: failed } = await run("create a task", again);
    assert.ok(failed.kind === "reply" && failed.status === "failed");
    assert.equal(again.requests.length, 2);
  });

  test("schema and compilation share one repair budget", async () => {
    const planner = scripted({ type: "plan", steps: 42 } as unknown as SubmitPlan, createTask("M48.A01"));
    const { out } = await run("create a task", planner);
    assert.ok(out.kind === "reply" && out.status === "failed");
    assert.equal(planner.requests.length, 2);
  });

  test("an answer to a question is retrieved together with the question", async () => {
    const picked = async (answering?: string) => {
      const { events } = await run("Ana Ruiz", scripted(reply({ type: "clarify", question: "?" })), { answering });
      const t = events.find((e) => e.type === "retrieval")!;
      return t.type === "retrieval" && t.data.picks.some((p) => p.id === "M06.A01");
    };
    assert.equal(await picked(), false, "the bare answer alone shouldn't find the task action");
    assert.equal(await picked("create a task to call her"), true);
  });

  test("the prompt names built and unbuilt matches separately", async () => {
    const planner = scripted(reply({ type: "unsupported", reason: "x" }), reply({ type: "unsupported", reason: "x" }));
    await run("add a product called Gold Plan to Priya's invoice", planner);
    const user = planner.requests[0]!.user;
    assert.match(user, /<actions>[\s\S]*M28\.A04[\s\S]*<\/actions>/);
    assert.match(user, /<not_available>[\s\S]*product[\s\S]*<\/not_available>/i);
  });
});

describe("a planner that fails", () => {
  const failing = (err: Error): Planner => ({ name: "failing", plan: async () => Promise.reject(err) });

  test("a provider error ends the turn with a failed reply instead of throwing", async () => {
    const { out } = await run("create a task to call Ana", failing(new PlannerError("claude exited 1: overloaded", "provider")));
    assert.ok(out.kind === "reply" && out.status === "failed");
    assert.match(out.text, /The planner failed: claude exited 1: overloaded/);
  });

  test("a quota, timeout or provider failure is marked infra; a reply that isn't valid JSON is the planner's own failure", async () => {
    const quota = await run("create a task to call Ana", failing(new PlannerError("You've hit your session limit", "rate_limited")));
    assert.ok(quota.out.kind === "reply" && quota.out.infra === "rate_limited");
    const garbled = await run("create a task to call Ana", failing(new PlannerError("no structured_output in reply", "bad_json")));
    assert.ok(garbled.out.kind === "reply" && garbled.out.status === "failed" && garbled.out.infra === undefined);
  });

  test("a call that never returns is abandoned after the deadline, and told to stop", async () => {
    let signal: AbortSignal | undefined;
    const hung: Planner = { name: "hung", plan: (req) => ((signal = req.signal), new Promise(() => {})) };
    const events: TurnEvent[] = [];
    const out = await planTurn({ message: "create a task to call Ana", tier: "fast" }, { registry, retriever, planner: hung, clock: frozenClock(), plannerTimeoutMs: 20 }, (e) => events.push(e));
    assert.ok(out.kind === "reply" && out.status === "failed");
    assert.match(out.text, /didn't answer within \d+ s\. Nothing was changed/);
    assert.equal(out.infra, "timeout");
    assert.equal(signal?.aborted, true);
    assert.ok(events.some((e) => e.type === "planner.request"), "the request was traced before the wait");
  });

  test("a reply inside the deadline is not affected by it", async () => {
    const planner = scripted(createTask());
    const out = await planTurn({ message: "create a task to call Ana", tier: "fast" }, { registry, retriever, planner, clock: frozenClock(), plannerTimeoutMs: 5_000 });
    assert.equal(out.kind, "plan");
  });

  test("an error that isn't the planner's still surfaces", async () => {
    await assert.rejects(run("create a task to call Ana", failing(new TypeError("bug"))), /bug/);
  });
});

describe("names in the message", () => {
  test("are linked to their record type in the prompt, and their lookups are offered", async () => {
    const ctx = world();
    ctx.f.lead({ firstName: "Quinn", lastName: "Leadonly" });
    const planner = scripted(reply({ type: "clarify", question: "?" }));
    await planTurn({ message: "Create a task to call Quinn Leadonly tomorrow", tier: "fast" }, { registry, retriever, planner, clock: frozenClock(), store: ctx.store });
    const user = planner.requests[0]!.user;
    assert.match(user, /<mentions>Quinn Leadonly: lead<\/mentions>/);
    assert.ok(offeredIn(planner.requests[0]!).includes("M03.A02"));
  });

  test("without a store nothing is linked", async () => {
    const planner = scripted(reply({ type: "clarify", question: "?" }));
    await run("What is Sarah Johnson's status?", planner);
    assert.doesNotMatch(planner.requests[0]!.user, /<mentions>/);
  });
});
