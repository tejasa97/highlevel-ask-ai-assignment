import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { compile } from "../core/compile.js";
import { loadRegistry, type Registry } from "../registry/registry.js";
import { buildCards } from "../retrieval/cards.js";
import { Retriever } from "../retrieval/retrieve.js";
import { frozenClock } from "../store/clock.js";
import type { SubmitPlan } from "./submit-plan.js";
import { planTurn, type TurnEvent } from "./turn.js";
import type { PlanRequest, Planner } from "./types.js";

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
      return { model: "fake", json, text: JSON.stringify(json), usage: { input: 0, cachedRead: 0, cacheWrite: 0, output: 0, thinking: 0, costUsd: 0 }, latencyMs: 1 };
    },
  };
}

async function run(message: string, planner: Planner, extra: { answering?: string } = {}) {
  const events: TurnEvent[] = [];
  const out = await planTurn({ message, tier: "fast", ...extra }, { registry, retriever, planner, clock: frozenClock() }, (e) => events.push(e));
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

  test("a second search_tools gives up as unsupported", async () => {
    const planner = scripted(reply({ type: "search_tools", query: "book a flight" }), reply({ type: "search_tools", query: "airline booking" }));
    const { out } = await run("book me a flight to Austin", planner);
    assert.equal(out.kind, "reply");
    if (out.kind === "reply") {
      assert.equal(out.status, "unsupported");
      assert.match(out.text, /airline booking/);
    }
    assert.equal(planner.requests.length, 2);
  });

  test("using an action that wasn't offered gets one repair round", async () => {
    const planner = scripted(createTask("M48.A01"), createTask());
    const { out, events } = await run("create a task to call Ana", planner);
    assert.equal(out.kind, "plan");
    const errs = events.flatMap((e) => (e.type === "compile.errors" ? e.data.errors : []));
    assert.match(errs.join("\n"), /M48\.A01 was not in <actions>/);
    assert.match(planner.requests[1]!.user, /M48\.A01 was not in <actions>/);
  });

  test("a plan still invalid after the repair fails the turn", async () => {
    const planner = scripted(createTask("M48.A01"), createTask("M48.A01"));
    const { out } = await run("create a task to call Ana", planner);
    assert.ok(out.kind === "reply" && out.status === "failed");
  });

  test("the repair round may answer unsupported, as the error for an unbuilt action asks", async () => {
    const planner = scripted(createTask("M02.A03"), reply({ type: "unsupported", reason: "Companies aren't in this version." }));
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
    const u = await run("send Priya an invoice reminder", scripted(reply({ type: "unsupported", reason: "Invoices aren't in this version.", alternatives: ["Create a task to follow up"] })));
    assert.ok(u.out.kind === "reply" && u.out.status === "unsupported");
    if (u.out.kind === "reply") assert.match(u.out.text, /Alternatives: Create a task to follow up/);
  });

  test("a reply that doesn't match submit_plan fails the turn", async () => {
    const { out } = await run("create a task", scripted({ type: "plan" } as SubmitPlan));
    assert.ok(out.kind === "reply" && out.status === "failed");
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
    const planner = scripted(reply({ type: "unsupported", reason: "x" }));
    await run("send an invoice reminder to Priya", planner);
    const user = planner.requests[0]!.user;
    assert.match(user, /<not_available>[\s\S]*invoice[\s\S]*<\/not_available>/i);
  });
});
