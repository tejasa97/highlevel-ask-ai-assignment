import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { compile } from "../core/compile.js";
import { loadRegistry, type Registry } from "../registry/registry.js";
import { buildCards } from "../retrieval/cards.js";
import { Retriever } from "../retrieval/retrieve.js";
import { frozenClock } from "../store/clock.js";
import { world } from "../store/world.js";
import type { SubmitPlan } from "./submit-plan.js";
import { planTurn, renameReusedIds, withLookSteps, type TurnDeps, type TurnEvent } from "./turn.js";
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
const missing = (action: string, argument: string, args = {}) => ({ action, argument, argsJson: JSON.stringify(args) });

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

async function run(message: string, planner: Planner, extra: { answering?: string } = {}, look?: TurnDeps["look"], reg: Registry = registry) {
  const events: TurnEvent[] = [];
  const out = await planTurn({ message, tier: "fast", ...extra }, { registry: reg, retriever, planner, clock: frozenClock(), look }, (e) => events.push(e));
  return { out, events };
}
// Every catalog action is registered. Hiding one handler is how these tests still reach the "not in this version" branch.
function hiding(id: string): Registry {
  return new Proxy(registry, {
    get(target, prop, receiver) {
      if (prop === "get") return (actionId: string) => (actionId === id ? undefined : target.get(actionId));
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
const offeredIn = (req: PlanRequest) => [...req.user.matchAll(/\b(M\d\d\.A\d\d)\b/g)].map((m) => m[1]!);

describe("grounded outcomes and clarifications", () => {
  const change = { effect: "change" as const, actions: ["M06.A01"], destination: null };
  const tasks = (type: "look" | "plan") => reply({ type, steps: [{ id: "read", kind: "action", action: "M06.A03", argsJson: "{}" }], outcome: change });

  test("a choice-labelled team question with no selector is grounded from its required argument", async () => {
    const planner = scripted(reply({ type: "clarify", clarification: "choice", question: "Which sales team?", missing: missing("M49.A05", "teamId", { userId: "us_6" }) }), reply({ steps: [{ id: "join", kind: "action", action: "M49.A05", argsJson: '{"teamId":"tm_1","userId":"us_6"}' }] }));
    const w = world();
    const before = w.store.get("teams", "tm_1");
    const out = await planTurn({ message: "Noah will help the sales team", tier: "fast" }, { registry, retriever, planner, clock: w.clock, store: w.store });
    assert.ok(out.kind === "plan");
    assert.equal(planner.requests.length, 2);
    assert.match(planner.requests[1]!.user, /identity_check.*tm_1/);
    assert.deepEqual(w.store.get("teams", "tm_1"), before, "grounding never executes the membership change");
  });

  test("an unbound or optional-input clarification gets one repair, not an unnecessary user question", async () => {
    for (const q of [reply({ type: "clarify", question: "Which Friday?" }), reply({ type: "clarify", question: "Which due date?", missing: missing("M06.A01", "dueDate", { title: "Call Ana" }) })]) {
      const planner = scripted(q, createTask());
      const { out } = await run("Create a task to call Ana", planner);
      assert.ok(out.kind === "plan");
      assert.equal(planner.requests.length, 2);
      assert.match(planner.requests[1]!.user, /<errors>/);
    }
  });

  test("nested field lookup IDs survive the look/replan loop", async () => {
    const form = { $lookup: { entity: "form", name: "Contact Us" } };
    const inspect = reply({ type: "look", steps: [{ id: "inspect", kind: "action", action: "M18.A02", argsJson: JSON.stringify({ formId: form }) }] });
    const submit = reply({ steps: [{ id: "submit", kind: "action", action: "M18.A09", argsJson: JSON.stringify({ formId: "$lookup_1.id", answers: [{ fieldId: { $lookup: { entity: "form_field", name: "Email" } }, value: "a@example.com" }] }) }] });
    const planner = scripted(inspect, submit);
    const out = await planTurn({ message: "Submit Contact Us with email a@example.com", tier: "fast", carry: { prev: ["M18.A02", "M18.A09"], entities: ["form"] } }, {
      registry, retriever, planner, clock: frozenClock(), look: async () => [{ id: "lookup_1", output: { id: "fm_1", name: "Contact Us" } }],
    });
    assert.ok(out.kind === "plan", JSON.stringify(out));
    assert.equal(new Set(out.plan.steps.map((s) => s.id)).size, out.plan.steps.length);
    assert.equal(planner.requests.length, 2);
  });

  test("a prerequisite-only plan is repaired rather than returned as completed", async () => {
    const planner = scripted(tasks("plan"), { ...createTask(), outcome: change });
    const { out } = await run("Create a task like my other tasks", planner);
    assert.ok(out.kind === "plan");
    assert.equal(planner.requests.length, 2);
    assert.match(planner.requests[1]!.user, /only reads/);
  });

  test("look then answer cannot drop the requested change, even if the next reply declares a read", async () => {
    const planner = scripted(tasks("look"), reply({ type: "answer", text: "Found tasks", outcome: { effect: "read", actions: ["M06.A03"], destination: null } }), createTask());
    const { out } = await run("Create a task like my other tasks", planner, {}, async () => []);
    assert.ok(out.kind === "plan");
    assert.equal(planner.requests.length, 3);
    assert.match(planner.requests[2]!.user, /requested_outcome.*M06.A01/);
    assert.match(planner.requests[2]!.user, /only reads/);
  });

  test("a change cannot end with a prose-only answer, and retries are bounded", async () => {
    const answer = reply({ type: "answer", text: "Done", outcome: change });
    const planner = scripted(answer, answer);
    const { out } = await run("Create a task", planner);
    assert.ok(out.kind === "reply" && out.status === "failed");
    assert.equal(planner.requests.length, 2);
  });

  test("a genuine read-only look may still end with an answer", async () => {
    const read = { effect: "read" as const, actions: ["M06.A03"], destination: null };
    const planner = scripted({ ...tasks("look"), outcome: read }, reply({ type: "answer", text: "Found tasks", outcome: read }));
    const { out } = await run("Show my tasks", planner, {}, async () => []);
    assert.ok(out.kind === "plan");
    assert.equal(planner.requests.length, 2);
  });

  test("a plan step that reuses a looked step's id keeps the read and refers to it, with no repair round", async () => {
    const read = { id: "s1", kind: "action" as const, action: "M06.A03", argsJson: "{}" };
    const reuse = reply({ steps: [{ id: "s1", kind: "action", action: "M06.A05", argsJson: JSON.stringify({ taskId: "$s1.items[0].id", assigneeId: "us_5" }) }], outcome: { effect: "change", actions: ["M06.A05"], destination: null } });
    const planner = scripted(reply({ type: "look", steps: [read], outcome: { effect: "change", actions: ["M06.A05"], destination: null } }), reuse);
    const { out } = await run("Reassign my first task to Noah", planner, {}, async () => []);
    assert.ok(out.kind === "plan", JSON.stringify(out));
    assert.equal(planner.requests.length, 2);
    assert.deepEqual(out.plan.steps.map((s) => s.id), ["s1", "s1_2"]);
  });

  test("a change over a list the look found empty gets one chance to widen, then says nothing matched", async () => {
    const read = { id: "s1", kind: "action" as const, action: "M06.A03", argsJson: "{}" };
    const outcome = { effect: "change" as const, actions: ["M06.A05"], destination: null };
    const each = reply({ steps: [read, { id: "each", kind: "op", op: "forEach", in: "$s1.items", whereJson: null, by: null, set: null, roundRobin: null, do: [{ action: "M06.A05", argsJson: JSON.stringify({ taskId: "$item.id", assigneeId: "us_5" }) }] }], outcome });
    const looking = reply({ type: "look", steps: [read], outcome });
    const empty = async () => [{ id: "s1", output: { items: [] } }];
    const answered = scripted(looking, each, reply({ type: "answer", text: "No tasks matched.", outcome }));
    const a = await run("Reassign Ana's overdue tasks to Noah", answered, {}, empty);
    assert.ok(a.out.kind === "reply" && a.out.status === "answer", JSON.stringify(a.out));
    const stubborn = scripted(looking, each, each);
    const b = await run("Reassign Ana's overdue tasks to Noah", stubborn, {}, empty);
    assert.ok(b.out.kind === "reply" && b.out.status === "answer", JSON.stringify(b.out));
    assert.match(b.out.text, /nothing was changed/i);
    const found = scripted(looking, each);
    const c = await run("Reassign Ana's overdue tasks to Noah", found, {}, async () => [{ id: "s1", output: { items: [{ id: "tk_1" }] } }]);
    assert.ok(c.out.kind === "plan", JSON.stringify(c.out));
  });

  test("a duplicated id inside one plan is renamed and later references follow the new step", () => {
    const step = (id: string, argsJson: string) => ({ id, kind: "action" as const, action: "M06.A03", argsJson });
    const fixed = renameReusedIds(reply({ steps: [step("s1", "{}"), step("s1", "{}"), step("s2", '{"q":"$s1.items"}')] }));
    assert.deepEqual(fixed.steps!.map((s) => s.id), ["s1", "s1_2", "s2"]);
    assert.match((fixed.steps![2] as { argsJson: string }).argsJson, /\$s1_2\.items/);
    const same = reply({ steps: [step("s1", "{}"), step("s2", '{"q":"$s1.items"}')] });
    assert.equal(renameReusedIds(same), same);
  });

  test("a plan that reuses a look step's id still gets the look steps it needs, in order", () => {
    const step = (id: string, argsJson: string) => ({ id, kind: "action" as const, action: "M21.A02", argsJson });
    const looks = [{ id: "s1", kind: "resolve" as const, entity: "appointment", name: "Agency plan walkthrough", whereJson: null }, step("s2", '{"appointmentId":"$s1.id"}')] as NonNullable<SubmitPlan["steps"]>;
    const fixed = withLookSteps(reply({ steps: [{ ...step("s1", '{"appointmentId":"$s2.id"}'), action: "M21.A04" }] }), looks);
    assert.deepEqual(fixed.steps!.map((s) => s.id), ["s1", "s2", "s1_2"]);
    const plan = compile(fixed, registry, new Set(["M21.A02", "M21.A04"]));
    assert.ok(plan.ok, JSON.stringify(plan));
  });

  test("repairing a malformed clarification does not use up the plan's repair", async () => {
    const planner = scripted(reply({ type: "clarify", clarification: "content", question: "Which task?", outcome: change }), { ...tasks("plan"), outcome: change }, { ...createTask(), outcome: change });
    const { out } = await run("Create a task like my other tasks", planner);
    assert.ok(out.kind === "plan");
    assert.equal(planner.requests.length, 3);
    assert.match(planner.requests[1]!.user, /missing \{action, argument, argsJson\}/);
    assert.match(planner.requests[2]!.user, /only reads/);
  });

  test("a search can discover final operation IDs without losing its original effect", async () => {
    const planner = scripted(reply({ type: "search_tools", query: "create task", outcome: { ...change, actions: [] } }), { ...createTask(), outcome: change });
    const { out } = await run("Remind me to call", planner);
    assert.ok(out.kind === "plan");
    assert.match(planner.requests[1]!.user, /requested_outcome.*change/);
  });

  test("checks a unique identity before passing a speculative question to the user", async () => {
    const planner = scripted(reply({ type: "clarify", missing: missing("M08.A03", "tagId", { name: "referral-partner" }), clarification: "identity", question: "Which partner tag?", lookup: { entity: "tag", name: "partner", whereJson: null } }), reply({ steps: [{ id: "rename", kind: "action", action: "M08.A03", argsJson: JSON.stringify({ tagId: { $lookup: { entity: "tag", name: "partner" } }, name: "referral-partner" }) }] }));
    const w = world();
    const out = await planTurn({ message: "Rename partner tag to referral-partner", tier: "fast" }, { registry, retriever, planner, clock: w.clock, store: w.store });
    assert.ok(out.kind === "plan");
    assert.equal(planner.requests.length, 2);
    assert.match(planner.requests[1]!.user, /identity_check.*tg_4/);
    assert.equal(w.store.get<{ name: string }>("tags", "tg_4")!.name, "partner", "lookup never executes the rename");
  });

  test("real duplicate identities still ask the user, without selecting the first", async () => {
    const planner = scripted(reply({ type: "clarify", missing: missing("M13.A03", "contactId", { subject: "Hello", body: "Hi" }), clarification: "identity", question: "Which Sarah?", options: ["Brightside", "Acme"], lookup: { entity: "contact", name: "Sarah Johnson", whereJson: null } }));
    const w = world();
    const out = await planTurn({ message: "Email Sarah Johnson", tier: "fast" }, { registry, retriever, planner, clock: w.clock, store: w.store });
    assert.ok(out.kind === "reply" && out.status === "clarify");
    assert.equal(planner.requests.length, 1);
  });

  test("unsupported destination is reported before asking for content or executing look", async () => {
    const planner = scripted(reply({ type: "clarify", clarification: "content", question: "What should the post say?", outcome: { effect: "change", actions: [], destination: "linkedin" } }));
    const { out } = await run("Publish a LinkedIn post", planner);
    assert.ok(out.kind === "reply" && out.status === "unsupported");
    assert.match(out.text, /linkedin isn't supported/);
    assert.doesNotMatch(out.text, /What should/);
    assert.equal(planner.requests.length, 1);
  });

  test("destination validation uses capabilities, not a platform-specific blacklist", async () => {
    const planner = scripted(reply({ type: "clarify", clarification: "content", question: "What should it say?", outcome: { effect: "change", actions: [], destination: "unconnected_network" } }));
    const { out } = await run("Post to an unconnected network", planner);
    assert.ok(out.kind === "reply" && out.status === "unsupported");
    const supported = scripted(reply({ type: "clarify", missing: missing("M38.A01", "title", { slug: "article", body: "Article" }), clarification: "content", question: "What is the article about?", outcome: { effect: "change", actions: [], destination: "blog" } }));
    const result = await run("Write a blog post", supported);
    assert.ok(result.out.kind === "reply" && result.out.status === "clarify");
  });

  test("repeating an identity question after a unique lookup fails safely instead of asking the user again", async () => {
    const question = reply({ type: "clarify", missing: missing("M08.A03", "tagId"), clarification: "identity", question: "Which partner?", lookup: { entity: "tag", name: "partner", whereJson: null } });
    const planner = scripted(question, question);
    const w = world();
    const out = await planTurn({ message: "Rename partner tag", tier: "fast" }, { registry, retriever, planner, clock: w.clock, store: w.store });
    assert.ok(out.kind === "reply" && out.status === "failed");
    assert.equal(planner.requests.length, 2);
    assert.equal(w.store.get<{ name: string }>("tags", "tg_4")!.name, "partner");
  });

  test("an identity question about a second record gets its own check", async () => {
    const team = reply({ type: "clarify", clarification: "choice", question: "Which sales team?", missing: missing("M49.A05", "teamId", { userId: { $lookup: { entity: "user", name: "Noah" } } }) });
    const user = reply({ type: "clarify", clarification: "identity", question: "Which Noah?", missing: missing("M49.A05", "userId", { teamId: "tm_1" }), lookup: { entity: "user", name: "Noah", whereJson: null } });
    const planner = scripted(team, user, reply({ steps: [{ id: "join", kind: "action", action: "M49.A05", argsJson: '{"teamId":"tm_1","userId":"us_6"}' }] }));
    const w = world();
    const out = await planTurn({ message: "Noah will help the sales team", tier: "fast" }, { registry, retriever, planner, clock: w.clock, store: w.store });
    assert.ok(out.kind === "plan", JSON.stringify(out));
    assert.equal(planner.requests.length, 3);
    assert.match(planner.requests[2]!.user, /identity_check.*us_6/);
  });

  test("an invalid selector cannot turn into an unchecked identity question after the one retry", async () => {
    const question = reply({ type: "clarify", missing: missing("M13.A03", "contactId"), clarification: "identity", question: "Which Sarah?", lookup: { entity: "contact", name: "Sarah Johnson", whereJson: '{"invented":"value"}' } });
    const planner = scripted(question, question);
    const w = world();
    const out = await planTurn({ message: "Email Sarah Johnson", tier: "fast" }, { registry, retriever, planner, clock: w.clock, store: w.store });
    assert.ok(out.kind === "reply" && out.status === "failed");
    assert.equal(planner.requests.length, 2);
  });

  test("a corrected selector is checked again without spending another model retry", async () => {
    const question = reply({ type: "clarify", missing: missing("M13.A03", "contactId"), clarification: "identity", question: "Which Sarah?", lookup: { entity: "contact", name: "Sarah Johnson", whereJson: '{"invented":"value"}' } });
    const planner = scripted(question, { ...question, lookup: { entity: "contact", name: "Sarah Johnson", whereJson: null }, options: ["Invented person"] });
    const w = world();
    const out = await planTurn({ message: "Email Sarah Johnson", tier: "fast" }, { registry, retriever, planner, clock: w.clock, store: w.store });
    assert.ok(out.kind === "reply" && out.status === "clarify");
    assert.equal(out.options?.length, 2);
    assert.ok(!out.options?.includes("Invented person"));
    assert.equal(planner.requests.length, 2);
  });
});

describe("compile against what was offered", () => {
  test("rejects an implemented action the planner wasn't shown", () => {
    const r = compile(createTask(), registry, new Set(["M01.A01"]));
    assert.ok(!r.ok);
    assert.match(r.errors.join("\n"), /M06\.A01 was not in <actions>/);
  });

  test("rejects a catalog action that isn't built yet, by name", () => {
    const r = compile(createTask("M02.A03"), hiding("M02.A03"), new Set(["M02.A03"]));
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

  test("a second search_tools gets one more round; a third gives up as unsupported", async () => {
    const search = (query: string) => reply({ type: "search_tools", query });
    const planner = scripted(search("book a flight"), search("airline booking"), search("flight booking"));
    const { out } = await run("book me a flight to Austin", planner);
    assert.equal(out.kind, "reply");
    if (out.kind === "reply") {
      assert.equal(out.status, "unsupported");
      assert.match(out.text, /flight booking/);
    }
    assert.equal(planner.requests.length, 3);
  });

  test("after a second search_tools, a plan built from the offered actions still runs", async () => {
    const planner = scripted(reply({ type: "search_tools", query: "create a task" }), reply({ type: "search_tools", query: "create a task" }), createTask());
    const { out } = await run("remind me to call Ana tomorrow", planner);
    assert.equal(out.kind, "plan");
    assert.equal(planner.requests.length, 3);
    assert.match(planner.requests[2]!.user, /search_tools ran again for "create a task".*filter\/exclude ops/s);
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
    test("an automatically generated lookup ID survives look/replan without repair", async () => {
      const inspect = reply({ type: "look", steps: [{ id: "inspect", kind: "action", action: "M36.A02", argsJson: JSON.stringify({ funnelId: { $lookup: { entity: "funnel", name: "Webinar Signup" } } }) }] });
      const metrics = reply({ steps: [{ id: "metrics", kind: "action", action: "M36.A10", argsJson: JSON.stringify({ funnelId: "$lookup_1.id" }) }] });
      const planner = scripted(inspect, metrics);
      const { out, events } = await run("How is the Webinar Signup funnel converting?", planner, {}, async (p) => {
        assert.deepEqual(p.steps.map((s) => s.id), ["lookup_1", "inspect"]);
        return [{ id: "lookup_1", output: { id: "fn_1", name: "Webinar Signup" } }, { id: "inspect", output: { id: "fn_1", steps: [] } }];
      });
      assert.ok(out.kind === "plan");
      assert.deepEqual(out.plan.steps.map((s) => s.id), ["lookup_1", "metrics"]);
      assert.equal(planner.requests.length, 2);
      assert.equal(events.filter((e) => e.type === "compile.errors").length, 0);
    });

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

    test("a ref to a look step re-runs that read as part of the plan, with no repair round", async () => {
      const refsLook = reply({ steps: [{ id: "s2", kind: "action", action: "M06.A01", argsJson: JSON.stringify({ title: "$s1.items[0].title" }) }] });
      const planner = scripted(listTasks, refsLook);
      const { out } = await run("create a task like the Ana one", planner, {}, async () => [{ id: "s1", output: { items: [{ title: "Call Ana" }], total: 1 } }]);
      assert.equal(planner.requests.length, 2);
      assert.ok(out.kind === "plan");
      assert.deepEqual(out.plan.steps.map((s) => s.id), ["s1", "s2"]);
    });

    test("a plan that defines its own step with a look step's id keeps its own", async () => {
      const ownS1 = reply({ steps: [{ id: "s1", kind: "action", action: "M06.A01", argsJson: JSON.stringify({ title: "Call Ana" }) }, { id: "s2", kind: "action", action: "M06.A01", argsJson: JSON.stringify({ title: "$s1.title" }) }] });
      const planner = scripted(listTasks, ownS1);
      const { out } = await run("create two tasks", planner, {}, async () => []);
      assert.ok(out.kind === "plan");
      assert.deepEqual(out.plan.steps.map((s) => s.id), ["s1", "s2"]);
      const first = out.plan.steps[0]!;
      assert.ok(first.kind === "action" && first.call.action.id === "M06.A01");
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

  test("a plan still invalid after the repair fails the turn", async () => {
    const planner = scripted(createTask("M48.A01"), createTask("M48.A01"));
    const { out } = await run("create a task to call Ana", planner);
    assert.ok(out.kind === "reply" && out.status === "failed");
  });

  test("the repair round may answer unsupported, as the error for an unbuilt action asks", async () => {
    const planner = scripted(createTask("M02.A03"), reply({ type: "unsupported", reason: "Companies aren't in this version." }), reply({ type: "unsupported", reason: "Still not." }));
    const { out } = await run("create a task to call Ana", planner, {}, undefined, hiding("M02.A03"));
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
    const q = await run("create a task", scripted(reply({ type: "clarify", missing: missing("M06.A01", "title"), question: "What should the task say?", options: ["Call Ana", "Email Ana"] })));
    assert.deepEqual(q.out, { kind: "reply", status: "clarify", text: "What should the task say?", options: ["Call Ana", "Email Ana"] });
    const u = await run("send Priya an invoice reminder", scripted(reply({ type: "unsupported", reason: "Invoices aren't in this version." }), reply({ type: "unsupported", reason: "Invoices aren't in this version.", alternatives: ["Create a task to follow up"] })));
    assert.ok(u.out.kind === "reply" && u.out.status === "unsupported");
    if (u.out.kind === "reply") assert.match(u.out.text, /Alternatives: Create a task to follow up/);
  });

  test("a reply that doesn't match submit_plan fails the turn", async () => {
    const { out } = await run("create a task", scripted({ type: "plan" } as SubmitPlan));
    assert.ok(out.kind === "reply" && out.status === "failed");
  });

  test("an answer to a question is retrieved together with the question", async () => {
    const picked = async (answering?: string) => {
      const { events } = await run("Ana Ruiz", scripted(reply({ type: "answer", text: "?" })), { answering });
      const t = events.find((e) => e.type === "retrieval")!;
      return t.type === "retrieval" && t.data.picks.some((p) => p.id === "M06.A01");
    };
    assert.equal(await picked(), false, "the bare answer alone shouldn't find the task action");
    assert.equal(await picked("create a task to call her"), true);
  });

  test("the prompt offers the product and invoice actions for adding a product to an invoice", async () => {
    const planner = scripted(reply({ type: "unsupported", reason: "x" }), reply({ type: "unsupported", reason: "x" }));
    await run("add a product called Gold Plan to Priya's invoice", planner);
    const user = planner.requests[0]!.user;
    assert.match(user, /<actions>[\s\S]*M28\.A04[\s\S]*<\/actions>/);
    assert.match(user, /<actions>[\s\S]*M25\.A01[\s\S]*<\/actions>/);
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
    const planner = scripted(reply({ type: "answer", text: "?" }));
    await planTurn({ message: "Create a task to call Quinn Leadonly tomorrow", tier: "fast" }, { registry, retriever, planner, clock: frozenClock(), store: ctx.store });
    const user = planner.requests[0]!.user;
    assert.match(user, /<mentions>Quinn Leadonly: lead<\/mentions>/);
    assert.ok(offeredIn(planner.requests[0]!).includes("M03.A02"));
  });

  test("without a store nothing is linked", async () => {
    const planner = scripted(reply({ type: "answer", text: "?" }));
    await run("What is Sarah Johnson's status?", planner);
    assert.doesNotMatch(planner.requests[0]!.user, /<mentions>/);
  });
});
