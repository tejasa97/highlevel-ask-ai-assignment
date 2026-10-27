import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { compile } from "../core/compile.js";
import { loadRegistry, type Registry } from "../registry/registry.js";
import { buildCards } from "../retrieval/cards.js";
import { Retriever } from "../retrieval/retrieve.js";
import { frozenClock } from "../store/clock.js";
import { world } from "../store/world.js";
import type { SubmitPlan } from "./submit-plan.js";
import { carryOf, duplicateCreates, inventedIds, isQuestion, oneOfSameNamed, planTurn, staffInQuery, renameReusedIds, unfilledNamedFields, withLookSteps, type TurnDeps, type TurnEvent } from "./turn.js";
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

async function run(message: string, planner: Planner, extra: { answering?: string; context?: string } = {}, look?: TurnDeps["look"], reg: Registry = registry) {
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

  test("a rejected first reply's read outcome gives way to the repair's change", async () => {
    const read = { effect: "read" as const, actions: ["M06.A03"], destination: null };
    const stepless = reply({ type: "look", steps: null, outcome: read });
    const planner = scripted(stepless, { ...tasks("look"), outcome: change }, createTask());
    const { out } = await run("Look at my tasks and create one like them", planner, {}, async () => []);
    assert.ok(out.kind === "plan", JSON.stringify(out));
    assert.match(planner.requests[2]!.user, /requested_outcome.*M06.A01/);
  });

  test("a look that calls its own reads the outcome doesn't hold the change asked for after it to them", async () => {
    const read = { effect: "read" as const, actions: ["M06.A03"], destination: null };
    const planner = scripted({ ...tasks("look"), outcome: read }, createTask());
    const { out } = await run("Look at my tasks and create one like them", planner, {}, async () => []);
    assert.ok(out.kind === "plan", JSON.stringify(out));
    assert.equal(planner.requests.length, 2);
  });

  test("a question that goes on to ask for a change gets the change the reply after its look states", async () => {
    const read = { effect: "read" as const, actions: ["M06.A03"], destination: null };
    const asked = scripted({ ...tasks("look"), outcome: read }, tasks("look"), createTask());
    const { out } = await run("Which tasks are open? Give Ana one more like them.", asked, {}, async () => []);
    assert.ok(out.kind === "plan" && out.plan.steps.some((s) => s.kind === "action" && s.call.action.id === "M06.A01"), JSON.stringify(out));
    assert.equal(asked.requests.length, 3);
    const only = scripted({ ...tasks("look"), outcome: read }, tasks("look"));
    const answered = await run("Which tasks are open?", only, {}, async () => []);
    assert.ok(answered.out.kind === "plan" && answered.out.plan.steps.every((s) => s.kind !== "action" || s.call.action.risk === "read"));
    assert.equal(only.requests.length, 2);
  });

  test("a command whose looks each call themselves reads is not answered with those reads when it looks again", async () => {
    const read = { effect: "read" as const, actions: ["M06.A03"], destination: null };
    const looks = scripted({ ...tasks("look"), outcome: read }, { ...tasks("look"), outcome: read }, { ...createTask(), outcome: change });
    const { out } = await run("Find my open tasks and create one more like them for Ana", looks, {}, async () => []);
    assert.ok(out.kind === "plan" && out.plan.steps.some((s) => s.kind === "action" && s.call.action.id === "M06.A01"), JSON.stringify(out));
    assert.equal(looks.requests.length, 3);
  });

  test("a plan of reads it calls a read, for a message that asks and then tells, is sent back for the change", async () => {
    const read = { effect: "read" as const, actions: [], destination: null };
    const planner = scripted({ ...tasks("plan"), outcome: read }, { ...createTask(), outcome: change });
    const { out } = await run("Which tasks are open? Give Ana one more like them.", planner, {}, async () => []);
    assert.ok(out.kind === "plan" && out.plan.steps.some((s) => s.kind === "action" && s.call.action.id === "M06.A01"), JSON.stringify(out));
    assert.match(planner.requests[1]!.user, /only finds records/);
  });

  test("a follow-up that makes again what the last turn made is asked once which it means", async () => {
    const last = { carry: { prev: ["M06.A01"], entities: ["task"], made: ["task"] }, records: [{ entity: "task", id: "tsk_90", name: "Call Ana" }] };
    const again = scripted(createTask(), createTask());
    const out = await planTurn({ message: "Only the Austin ones, and make those due Friday", tier: "fast", ...last }, { registry, retriever, planner: again, clock: frozenClock() });
    assert.equal(out.kind, "plan");
    assert.equal(again.requests.length, 2);
    assert.match(again.requests[1]!.user, /already made 1 task record \(Call Ana \(tsk_90\)\)/);
    const more = scripted(createTask());
    assert.equal((await planTurn({ message: "Make one for Tom too", tier: "fast", ...last }, { registry, retriever, planner: more, clock: frozenClock() })).kind, "plan");
    assert.equal(more.requests.length, 1);
  });

  test("asked about a remake, a reply that says it will change those records but makes them again is not let through", async () => {
    const last = { carry: { prev: ["M06.A01"], entities: ["task"], made: ["task"] }, records: [{ entity: "task", id: "tsk_90", name: "Call Ana", for: "ld_4" }] };
    const message = "Only the Austin ones, and make those due Friday";
    const said = (actions: string[]) => ({ ...createTask(), outcome: { effect: "change" as const, actions, destination: null } });
    // The stated remake is asked about; the reply that then says "change" but makes them gets its one repair, and fails.
    const contradicts = scripted(said(["M06.A01"]), said(["M06.A06"]), said(["M06.A06"]));
    const out = await planTurn({ message, tier: "fast", ...last }, { registry, retriever, planner: contradicts, clock: frozenClock() });
    assert.ok(out.kind === "reply" && out.status === "failed", JSON.stringify(out));
    assert.match(contradicts.requests[1]!.user, /Call Ana \(tsk_90, for ld_4\)/);
    assert.equal(contradicts.requests.length, 3);
    const means = scripted(said(["M06.A01"]), said(["M06.A01"]));
    assert.equal((await planTurn({ message, tier: "fast", ...last }, { registry, retriever, planner: means, clock: frozenClock() })).kind, "plan");
  });

  test("a follow-up whose stated outcome makes again what the last turn made is asked before that outcome binds the repairs", async () => {
    const last = { carry: { prev: ["M06.A01"], entities: ["task"], made: ["task"] }, records: [{ entity: "task", id: "tsk_90", name: "Call Ana", for: "ld_4" }] };
    const message = "Only the Austin ones, and make those due Friday";
    // Stated as the last request again, beside an update, over a plan that doesn't even compile yet.
    const remake = { ...reply({ steps: [{ id: "s1", kind: "action", action: "M06.A01", argsJson: JSON.stringify({ title: "$item.name" }) }] }), outcome: { effect: "change" as const, actions: ["M06.A01", "M06.A06"], destination: null } };
    const update = { ...reply({ steps: [{ id: "s1", kind: "action", action: "M06.A06", argsJson: JSON.stringify({ taskId: "tsk_90", dueDate: "2026-10-23" }) }] }), outcome: { effect: "change" as const, actions: ["M06.A06"], destination: null } };
    const planner = scripted(remake, update);
    const out = await planTurn({ message, tier: "fast", ...last }, { registry, retriever, planner, clock: frozenClock() });
    assert.ok(out.kind === "plan" && out.plan.steps.some((s) => s.kind === "action" && s.call.action.id === "M06.A06"), JSON.stringify(out));
    assert.equal(planner.requests.length, 2);
    assert.match(planner.requests[1]!.user, /already made 1 task record[\s\S]*look first to read which still fit/);
    assert.doesNotMatch(planner.requests[1]!.user, /requested operation M06\.A01 is missing/);
    // Nor when a prose reply came first, stating a change it named no actions for.
    const prose = { ...reply({ steps: null }), type: "answer" as const, text: "I can't amend that from here.", outcome: { effect: "change" as const, actions: [], destination: null } };
    const after = scripted(prose, remake, update);
    const late = await planTurn({ message, tier: "fast", ...last }, { registry, retriever, planner: after, clock: frozenClock() });
    assert.ok(late.kind === "plan" && late.plan.steps.some((s) => s.kind === "action" && s.call.action.id === "M06.A06"), JSON.stringify(late));
    assert.match(after.requests[2]!.user, /already made 1 task record/);
    // Asked for more, the same outcome is the request.
    const more = scripted({ ...createTask(), outcome: { effect: "change" as const, actions: ["M06.A01"], destination: null } });
    assert.equal((await planTurn({ message: "Make one for Tom too", tier: "fast", ...last }, { registry, retriever, planner: more, clock: frozenClock() })).kind, "plan");
    assert.equal(more.requests.length, 1);
  });

  test("the records a change runs on are said back once after a look; a reply that then breaks runs the plan said back", async () => {
    const outcome = { effect: "change" as const, actions: ["M06.A05"], destination: null };
    const read = (id: string, args: object) => ({ id, kind: "action" as const, action: "M06.A03", argsJson: JSON.stringify(args) });
    const op = (id: string, o: Record<string, unknown>) => ({ id, kind: "op", whereJson: null, by: null, set: null, roundRobin: null, do: null, ...o }) as unknown as NonNullable<SubmitPlan["steps"]>[number];
    const looks = reply({ type: "look", steps: [read("s1", {}), read("s2", { status: "open" })], outcome });
    const pick = reply({ steps: [op("s3", { op: "exclude", in: "$s1.items", by: "id", set: "$s2.items[*].id" }), op("s4", { op: "forEach", in: "$s3", do: [{ action: "M06.A05", argsJson: JSON.stringify({ taskId: "$item.id", assigneeId: "us_5" }) }] })], outcome });
    const looked = async () => [
      { id: "s1", output: { items: [{ id: "tk_1", title: "Call Ana" }, { id: "tk_2", title: "Call Ben" }], total: 2 } },
      { id: "s2", output: { items: [{ id: "tk_2", title: "Call Ben" }], total: 1 } },
    ];
    const broken = reply({ steps: [read("s5", { nope: 1 })], outcome });
    const planner = scripted(looks, pick, broken, broken);
    const { out } = await run("Give Kim the tasks that aren't open", planner, {}, looked);
    assert.ok(out.kind === "plan", JSON.stringify(out));
    assert.match(planner.requests[2]!.user, /s3 keeps 1 of the 2 \(Call Ana\) items of \$s1\.items whose id is NOT among/);
    assert.ok(out.plan.steps.some((s) => s.id === "s3" && s.kind === "exclude"));
    // Planned the same again, it runs; it is not said back twice.
    const again = scripted(looks, pick, pick);
    assert.equal((await run("Give Kim the tasks that aren't open", again, {}, looked)).out.kind, "plan");
    assert.equal(again.requests.length, 3);
  });

  test("the reply after a look may name the change's actions afresh, but not turn it into a read", async () => {
    const guess = { effect: "change" as const, actions: ["M06.A01", "M06.A06"], destination: null };
    const planner = scripted({ ...tasks("look"), outcome: guess }, { ...createTask(), outcome: change });
    const { out } = await run("Create a task like my other tasks", planner, {}, async () => []);
    assert.ok(out.kind === "plan", JSON.stringify(out));
    assert.equal(planner.requests.length, 2);

    const reads = scripted({ ...tasks("look"), outcome: guess }, { ...tasks("plan"), outcome: { effect: "read", actions: ["M06.A03"], destination: null } }, createTask(), createTask());
    await run("Create a task like my other tasks", reads, {}, async () => []);
    assert.match(reads.requests[2]!.user, /only reads/);
  });

  test("a change cannot end with a prose-only answer, and retries are bounded", async () => {
    const answer = reply({ type: "answer", text: "Done", outcome: change });
    const planner = scripted(answer, answer);
    const { out } = await run("Create a task", planner);
    assert.ok(out.kind === "reply" && out.status === "failed");
    assert.equal(planner.requests.length, 2);
  });

  test("a plan gets a second repair only when the first left fewer errors", async () => {
    const two = reply({ steps: [{ id: "s1", kind: "action", action: "M06.A01", argsJson: JSON.stringify({ title: "$nope", color: "red" }) }], outcome: change });
    const one = reply({ steps: [{ id: "s1", kind: "action", action: "M06.A01", argsJson: JSON.stringify({ title: "$nope" }) }], outcome: change });
    const closer = scripted(two, one, createTask());
    assert.equal((await run("Create a task", closer)).out.kind, "plan");
    assert.equal(closer.requests.length, 3);
    const stuck = scripted(one, one, createTask());
    const { out } = await run("Create a task", stuck);
    assert.ok(out.kind === "reply" && out.status === "failed");
    assert.equal(stuck.requests.length, 2);
  });

  test("a genuine read-only look may still end with an answer", async () => {
    const read = { effect: "read" as const, actions: ["M06.A03"], destination: null };
    const planner = scripted({ ...tasks("look"), outcome: read }, reply({ type: "answer", text: "Found tasks", outcome: read }));
    const { out } = await run("Show my tasks", planner, {}, async () => []);
    assert.ok(out.kind === "plan");
    assert.equal(planner.requests.length, 2);
  });

  test("a question answered after a look keeps its verdict above the reads", async () => {
    const read = { effect: "read" as const, actions: ["M06.A03"], destination: null };
    const planner = scripted({ ...tasks("look"), outcome: read }, reply({ type: "answer", text: " Yes, that's your only task. ", outcome: read }));
    const { out } = await run("Is that my only task?", planner, {}, async () => []);
    assert.ok(out.kind === "plan" && out.answer === "Yes, that's your only task.", JSON.stringify(out));
    assert.equal(out.plan.steps.length, 1, "the look's read runs again as the plan");
  });

  test("a verdict that leaks a record id is dropped; the reads still answer", async () => {
    const read = { effect: "read" as const, actions: ["M06.A03"], destination: null };
    const planner = scripted({ ...tasks("look"), outcome: read }, reply({ type: "answer", text: "Yes, tk_4 is the only one.", outcome: read }));
    const { out } = await run("Is that my only task?", planner, {}, async () => []);
    assert.ok(out.kind === "plan" && out.answer === undefined);
  });

  test("a question planned as plain reads runs them as a look, and the verdict goes above them", async () => {
    const read = { effect: "read" as const, actions: ["M06.A03"], destination: null };
    const planner = scripted({ ...tasks("plan"), outcome: read }, reply({ type: "answer", text: "No, you have 2 open tasks.", outcome: read }));
    let looks = 0;
    const { out } = await run("Is that my only task?", planner, {}, async () => (looks++, []));
    assert.ok(out.kind === "plan" && out.answer === "No, you have 2 open tasks.", JSON.stringify(out));
    assert.equal(looks, 1);
    assert.equal(planner.requests.length, 2);
  });

  test("a question whose model plans again after the look runs that plan, without a verdict or another look", async () => {
    const read = { effect: "read" as const, actions: ["M06.A03"], destination: null };
    const planner = scripted({ ...tasks("plan"), outcome: read }, { ...tasks("plan"), outcome: read });
    const { out } = await run("How many tasks do I have?", planner, {}, async () => []);
    assert.ok(out.kind === "plan" && out.answer === undefined, JSON.stringify(out));
    assert.equal(planner.requests.length, 2);
  });

  test("a request to list records is planned once, with no look", async () => {
    const read = { effect: "read" as const, actions: ["M06.A03"], destination: null };
    const planner = scripted({ ...tasks("plan"), outcome: read });
    let looks = 0;
    const { out } = await run("List my open tasks", planner, {}, async () => (looks++, []));
    assert.ok(out.kind === "plan", JSON.stringify(out));
    assert.equal(looks, 0);
    assert.equal(planner.requests.length, 1);
  });

  test("a question whose model wants a second look gets the first look's reads, not a failure", async () => {
    const read = { effect: "read" as const, actions: ["M06.A03"], destination: null };
    const planner = scripted({ ...tasks("plan"), outcome: read }, { ...tasks("look"), outcome: read });
    const { out } = await run("Has Ana got any tasks?", planner, {}, async () => []);
    assert.ok(out.kind === "plan" && out.answer === undefined, JSON.stringify(out));
    assert.equal(planner.requests.length, 2);
  });

  test("the next turn learns which record types this one made, not those it only changed", () => {
    const made = compile(createTask(), registry);
    assert.ok(made.ok);
    assert.deepEqual(carryOf(made.plan, registry).made, ["task"]);
    const changed = compile(reply({ steps: [{ id: "s1", kind: "action", action: "M06.A06", argsJson: JSON.stringify({ taskId: "tk_1", dueDate: "2026-10-22" }) }] }), registry);
    assert.ok(changed.ok, JSON.stringify(changed));
    assert.equal(carryOf(changed.plan, registry).made, undefined);
  });

  test("a staff user's name searched as text is sent back to go in the owner argument", () => {
    const r = compile(reply({ steps: [{ id: "s1", kind: "action", action: "M47.A03", argsJson: JSON.stringify({ query: "Noah Park", status: "open" }) }] }), registry);
    assert.ok(r.ok);
    const errors = staffInQuery(r.plan, [{ name: "Noah Park", entity: "user", count: 1 }]);
    assert.match(errors.join(), /Noah Park is a staff user; resolve them and pass ownerId/);
    assert.deepEqual(staffInQuery(r.plan, [{ name: "Noah Park", entity: "contact", count: 1 }]), []);
  });

  test("questions are told apart from requests to show records", () => {
    for (const q of ["Is that the only review?", "How many leads are qualified?", "Has Aisha won any deals?", "Did Yusuf's payment go through?", "Which team is Dan on?", "Any open tickets?"]) assert.ok(isQuestion(q), q);
    for (const r of ["List open tickets", "Show Elodie's review", "Can you list my tasks?", "Please find Ana's invoice", "Reassign my tasks to Noah"]) assert.ok(!isQuestion(r), r);
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

  test("$looked.<step> means the look step itself", () => {
    const looks = [{ id: "s1", kind: "resolve" as const, entity: "contact", name: "Marcus Lee", whereJson: null }, { id: "s2", kind: "action" as const, action: "M28.A03", argsJson: '{"contactId":"$s1.id"}' }] as NonNullable<SubmitPlan["steps"]>;
    const fixed = withLookSteps(reply({ steps: [{ id: "s1", kind: "action", action: "M29.A01", argsJson: '{"contactId":"$looked.s1.id","invoiceId":"$looked.s2.items[0].id"}' }] }), looks);
    assert.deepEqual(fixed.steps!.map((s) => s.id), ["s1", "s2", "s1_2"]);
    assert.equal((fixed.steps![2] as { argsJson: string }).argsJson, '{"contactId":"$s1.id","invoiceId":"$s2.items[0].id"}');
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

  test("asked again after seeing the records, a question about a name that fits two of them goes to the user", async () => {
    const ask = reply({ type: "clarify", missing: missing("M01.A07", "contactId", { ownerId: "us_5" }), clarification: "identity", question: "Which Zoe Costa?" });
    const planner = scripted(ask, ask);
    const w = world();
    const out = await planTurn({ message: "Make Aisha the owner of Zoe Costa", tier: "fast" }, { registry, retriever, planner, clock: w.clock, store: w.store });
    assert.ok(out.kind === "reply" && out.status === "clarify", JSON.stringify(out));
    assert.match(planner.requests[1]!.user, /ct_26.*ct_30|ct_30.*ct_26/);
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

describe("invented ids", () => {
  const ids = (args: object, shown: string, exists?: (id: string) => boolean) => {
    const r = compile(reply({ steps: [{ id: "s1", kind: "action", action: "M06.A01", argsJson: JSON.stringify({ title: "Call", ...args }) }] }), registry);
    assert.ok(r.ok, JSON.stringify(r));
    return inventedIds(r.plan, shown, exists).map((e) => e.match(/^"([^"]+)"/)![1]);
  };

  test("an id-valued arg that was never shown and no record has is flagged", () => {
    assert.deepEqual(ids({ assigneeId: "us_sarah_johnson_1" }, "create a task for Sarah"), ["us_sarah_johnson_1"]);
  });

  test("ids from the prompt or the store pass, and so do non-id values", () => {
    assert.deepEqual(ids({ assigneeId: "us_2" }, "records: user us_2 \"Raj\""), []);
    assert.deepEqual(ids({ assigneeId: "us_2" }, "", (id) => id === "us_2"), []);
    assert.deepEqual(ids({ priority: "high" }, ""), []);
  });
});

describe("a write by id to one of several same-named records", () => {
  const sarahs = [{ name: "Sarah Johnson", entity: "contact", count: 2 }];
  const owner = (contactIds: string[]) => {
    const steps = contactIds.map((id, i) => ({ id: `s${i + 1}`, kind: "action" as const, action: "M01.A07", argsJson: JSON.stringify({ contactId: id, ownerId: "us_5" }) }));
    const r = compile(reply({ steps }), registry);
    assert.ok(r.ok, JSON.stringify(r));
    return r.plan;
  };

  test("asks which one when the request doesn't say", () => {
    const q = oneOfSameNamed(owner(["ct_31"]), sarahs, registry, world().store, "make Aisha the owner of Sarah Johnson");
    assert.match(q?.text ?? "", /More than one contact matches "Sarah Johnson": .*Brightside.*Which one\?/);
    assert.equal(q?.options.length, 2);
  });

  test("passes when the request picks one, or the plan writes to all of them", () => {
    assert.equal(oneOfSameNamed(owner(["ct_31"]), sarahs, registry, world().store, "make Aisha the owner of Sarah Johnson\nthe one at Brightside"), undefined);
    assert.equal(oneOfSameNamed(owner(["ct_31", "ct_32"]), sarahs, registry, world().store, "make Aisha the owner of both Sarah Johnsons"), undefined);
  });
});

describe("planTurn", () => {
  test("a plan from the first shortlist compiles, and carries its actions forward", async () => {
    const planner = scripted(createTask());
    const { out, events } = await run("create a task to call Ana", planner);
    assert.equal(out.kind, "plan");
    if (out.kind === "plan") assert.deepEqual(out.carry, { prev: ["M06.A01"], entities: ["task"], made: ["task"] });
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

    test("at most two looks per turn, and the second sees the first's results", async () => {
      const planner = scripted(listTasks, listTasks, listTasks, createTask());
      let looks = 0;
      const { out } = await run("create a task like the Ana one", planner, {}, async () => (looks++, [{ id: "s1", output: { items: [], total: looks } }]));
      assert.equal(out.kind, "plan");
      assert.equal(looks, 2);
      assert.match(planner.requests[1]!.user, /<looked>/);
      assert.match(planner.requests[3]!.user, /You already looked twice/);
    });

    test("a second look that reuses the first's ids for other reads keeps the first's results in view", async () => {
      const others = reply({ type: "look", steps: [{ id: "s1", kind: "action", action: "M06.A03", argsJson: JSON.stringify({ query: "Bo" }) }] });
      const planner = scripted(listTasks, others, createTask());
      let looks = 0;
      const { out } = await run("create a task like the Ana one", planner, {}, async (plan) => {
        looks++;
        return plan.steps.map((s) => ({ id: s.id, output: { items: [], total: looks === 1 ? "ana-first" : "bo-second" } }));
      });
      assert.equal(out.kind, "plan");
      const third = planner.requests[2]!.user;
      assert.match(third, /ana-first/);
      assert.match(third, /bo-second/);
      assert.match(third, /s1_2/);
    });

    test("asking for a third look is nudged without spending the repair", async () => {
      const bad = reply({ type: "plan", steps: [{ id: "s1", kind: "action", action: "M06.A01", argsJson: JSON.stringify({ title: "$s0" }) }] });
      const planner = scripted(listTasks, listTasks, listTasks, bad, createTask());
      const { out } = await run("create a task like the Ana one", planner, {}, async () => [{ id: "s1", output: { items: [], total: 0 } }]);
      assert.equal(out.kind, "plan", JSON.stringify(out));
      assert.equal(planner.requests.length, 5);
    });

    test("an answer after looking still repairs an unfulfilled write request", async () => {
      const planner = scripted(listTasks, reply({ type: "answer", text: "I found the existing task." }), createTask());
      let looks = 0;
      const { out, events } = await run("create a task like the Ana one", planner, {}, async () => (looks++, [{ id: "s1", output: { items: [{ title: "Call Ana" }], total: 1 } }]));
      assert.equal(out.kind, "plan");
      assert.equal(looks, 1);
      assert.equal(planner.requests.length, 3);
      assert.match(planner.requests[2]!.user, /the plan only finds records; add the action that does it/);
      assert.match(planner.requests[2]!.user, /<looked>/);
      assert.ok(events.some((e) => e.type === "compile.errors"));
      assert.ok(out.kind === "plan" && out.plan.steps.some((s) => s.kind === "action" && s.call.action.id === "M06.A01"));
    });

    test("incomplete answers after a look share the one-repair budget", async () => {
      const answer = reply({ type: "answer" as const, text: "I can create it if you want." });
      const planner = scripted(listTasks, answer, answer);
      const { out } = await run("create a task like the Ana one", planner, {}, async () => [{ id: "s1", output: { items: [], total: 0 } }]);
      assert.ok(out.kind === "reply" && out.status === "failed");
      assert.equal(planner.requests.length, 3);
      assert.match(out.text, /still incomplete/);
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
      const { events } = await run("Ana Ruiz", scripted(reply({ type: "answer", text: "?" }), reply({ type: "answer", text: "?" })), { answering });
      const t = events.find((e) => e.type === "retrieval")!;
      return t.type === "retrieval" && t.data.picks.some((p) => p.id === "M06.A01");
    };
    assert.equal(await picked(), false, "the bare answer alone shouldn't find the task action");
    assert.equal(await picked("create a task to call her"), true);
  });

  test("an answer with nothing to answer from is nudged once to read; with <context> it stands", async () => {
    const answer = reply({ type: "answer", text: "It has not breached." });
    const nudged = scripted(answer, answer);
    const { out } = await run("has task tk_1 gone overdue?", nudged);
    assert.ok(out.kind === "reply" && out.status === "answer", JSON.stringify(out));
    assert.equal(nudged.requests.length, 2);
    assert.match(nudged.requests[1]!.user, /there is no <context> or <looked> to answer from/);
    const told = scripted(answer);
    await run("has task tk_1 gone overdue?", told, { context: "user: is tk_1 overdue?\nassistant: No, it's due Friday." });
    assert.equal(told.requests.length, 1);
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

  test("a reply that isn't JSON is asked for once more per turn; a second one ends the turn", async () => {
    const bad = new PlannerError("fake: the reply was cut off at 8192 tokens", "bad_json");
    const good = createTask();
    let calls = 0;
    const once: Planner = { name: "once", plan: async () => { if (calls++ === 0) throw bad; return { model: "fake", json: good, text: "", usage: { input: 0, cachedRead: 0, cacheWrite: 0, output: 0, thinking: 0, costUsd: 0, billing: "none" }, latencyMs: 1 }; } };
    const { out, events } = await run("create a task to call Ana", once);
    assert.equal(out.kind, "plan", JSON.stringify(out));
    assert.equal(calls, 2);
    assert.ok(events.some((e) => e.type === "compile.errors" && e.data.errors.some((m) => /cut off at 8192 tokens; asked again/.test(m))));
    let tries = 0;
    const always: Planner = { name: "always", plan: async () => { tries++; throw bad; } };
    const twice = await run("create a task to call Ana", always);
    assert.ok(twice.out.kind === "reply" && twice.out.status === "failed");
    assert.equal(tries, 2);
    tries = 0;
    await run("create a task to call Ana", { name: "down", plan: async () => { tries++; throw new PlannerError("HTTP 503", "provider"); } });
    assert.equal(tries, 1, "a provider failure is not resampled here; the client already retried it");
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
    const planner = scripted(reply({ type: "answer", text: "?" }), reply({ type: "answer", text: "?" }));
    await planTurn({ message: "Create a task to call Quinn Leadonly tomorrow", tier: "fast" }, { registry, retriever, planner, clock: frozenClock(), store: ctx.store });
    const user = planner.requests[0]!.user;
    assert.match(user, /<mentions>Quinn Leadonly: lead<\/mentions>/);
    assert.ok(offeredIn(planner.requests[0]!).includes("M03.A02"));
  });

  test("without a store nothing is linked", async () => {
    const planner = scripted(reply({ type: "answer", text: "?" }), reply({ type: "answer", text: "?" }));
    await run("What is Sarah Johnson's status?", planner);
    assert.doesNotMatch(planner.requests[0]!.user, /<mentions>/);
  });
});

describe("creating a record the message names", () => {
  const plan = (args: object) => {
    const r = compile(reply({ steps: [{ id: "s1", kind: "action", action: "M01.A01", argsJson: JSON.stringify(args) }] }), registry);
    assert.ok(r.ok, r.ok ? "" : r.errors.join("\n"));
    return r.plan;
  };
  const elodie = [{ name: "Elodie Mercer", entity: "contact", count: 1 }];

  test("is a duplicate when that record already exists, unless a new one is asked for", () => {
    const p = plan({ firstName: "Elodie", lastName: "Mercer" });
    assert.match(duplicateCreates(p, elodie, "Add Elodie Mercer, then post as her").join("\n"), /already exists as a contact/);
    assert.deepEqual(duplicateCreates(p, elodie, "Add a new contact Elodie Mercer"), []);
    assert.deepEqual(duplicateCreates(plan({ firstName: "Ana", lastName: "Mercer" }), elodie, "Add Ana Mercer"), []);
  });

  test("is not a duplicate when the name only matches part of an existing record's name", () => {
    const sarahs = [{ name: "Sarah", entity: "contact", count: 2 }];
    const fullNames = ["sarah johnson"];
    const sameName = (_: string, name: string) => fullNames.includes(name);
    assert.deepEqual(duplicateCreates(plan({ firstName: "Sarah" }), sarahs, "Create a contact named Sarah", sameName), []);
    assert.match(duplicateCreates(plan({ firstName: "Sarah", lastName: "Johnson" }), [{ name: "Sarah Johnson", entity: "contact", count: 2 }], "Add Sarah Johnson", sameName).join("\n"), /already exists/);
  });

  test("leaving out a field the message says comes with it is sent back to be set or asked for", () => {
    const sarah = plan({ firstName: "Sarah" });
    assert.match(unfilledNamedFields(sarah, "Add Sarah as a new contact with the email I'm pasting.").join("\n"), /leaves out email.*clarify/);
    assert.match(unfilledNamedFields(sarah, "Create a contact named Sarah with this email address.").join("\n"), /leaves out email/);
    assert.deepEqual(unfilledNamedFields(plan({ firstName: "Sarah", email: "s@x.example" }), "Add Sarah with this email: s@x.example"), []);
    assert.deepEqual(unfilledNamedFields(sarah, "Create a contact named Sarah"), []);
    assert.deepEqual(unfilledNamedFields(sarah, "Email Sarah and create her as a contact"), []);
    assert.deepEqual(unfilledNamedFields(sarah, "Create Sarah and send her an email"), []);
  });
});

test("a retry that runs the search the failed attempt found nothing with, unchanged, is sent back with the look-alike search", async () => {
  const archive = (search: SubmitPlan["steps"]) => reply({ steps: [...search!, { id: "s9", kind: "op", op: "forEach", in: "$s2.items", whereJson: null, by: null, set: null, roundRobin: null, do: [{ action: "M01.A05", argsJson: '{"contactId":"$item.id"}' }] }] });
  const companies = archive([
    { id: "s1", kind: "action", action: "M02.A03", argsJson: '{"query":"Wayne"}' },
    { id: "s2", kind: "action", action: "M02.A10", argsJson: '{"companyId":"$s1.items[0].id"}' },
  ]);
  const contacts = archive([
    { id: "s1", kind: "action", action: "M01.A03", argsJson: '{"query":"Wayne"}' },
    { id: "s2", kind: "op", op: "filter", in: "$s1.items", whereJson: '{"company":"Wayne"}', by: null, set: null, roundRobin: null, do: null },
  ]);
  const planner = scripted(companies, contacts);
  const failed = JSON.stringify({ steps: [], errors: ["s2: $s1.items has 0 items, no [0]."], empty: [{ action: "M02.A03", args: { query: "Wayne" } }] });
  const out = await planTurn({ message: "Archive every contact at Wayne", tier: "fast", failed }, { registry, retriever, planner, clock: frozenClock() }, () => {});
  assert.equal(out.kind, "plan");
  assert.match(planner.requests[1]!.user, /s1: M02\.A03 \{"query":"Wayne"\} already found nothing in <failed_attempt>.*M01\.A03 Search contacts/);
});
