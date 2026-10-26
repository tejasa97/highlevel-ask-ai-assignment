import assert from "node:assert/strict";
import { before, test } from "node:test";
import { compile, type CompiledPlan } from "./compile.js";
import { execute } from "./execute.js";
import { emptyRead, runtimeNoMatch } from "./no-match.js";
import { loadRegistry, type Registry } from "../registry/registry.js";
import { world } from "../store/world.js";
import { Conversation } from "../server/conversation.js";
import { Retriever } from "../retrieval/retrieve.js";
import { buildCards } from "../retrieval/cards.js";
import type { PlanRequest, Planner } from "../planner/types.js";
import type { Step, SubmitPlan } from "../planner/submit-plan.js";

let registry: Registry;
before(async () => { registry = await loadRegistry(); });
const action = (id: string, action: string, args: unknown): Step => ({ id, kind: "action", action, argsJson: JSON.stringify(args) });
const wire = (steps: Step[]): SubmitPlan => ({ type: "plan", steps, question: null, options: null, reason: null, alternatives: null, query: null, text: null });
const miss = (query = "Unmatched fixture wording") => wire([action("s1", "M06.A03", { query }), action("s2", "M06.A01", { title: "$s1.items[0].title" })]);
function compiled(reply: SubmitPlan): CompiledPlan {
  const r = compile(reply, registry); assert.ok(r.ok); return r.plan;
}

test("a failed index after an empty read yields the step, concrete query and zero count", async () => {
  const w = world(), p = compiled(miss());
  const r = await execute(p, registry, w, { executionId: "miss" });
  assert.equal(r.writesAttempted, false);
  assert.match(runtimeNoMatch(p, r)!, /Step s1 \(M06.A03\).*Unmatched fixture wording.*0 items/);
  assert.equal(emptyRead(p, r)?.action, "M06.A03");
  w.store.close();
});

test("a lookup miss says what the run's other reads found, and in which field", async () => {
  const w = world();
  const p = compiled(wire([
    { id: "s1", kind: "resolve", entity: "company", name: "Wayne", whereJson: null } as Step,
    action("s2", "M01.A03", { query: "Wayne" }),
    action("s3", "M02.A05", { companyId: "$s1.id" }),
  ]));
  const r = await execute(p, registry, w, { executionId: "wayne" });
  assert.match(runtimeNoMatch(p, r)!, /looked for "Wayne" and found nothing\. Step s2 \(M01\.A03\) did find \d+ items whose (\w+\/)*company(\/\w+)* contains "Wayne"/);
  // A name lookup isn't a search the next plan would repeat by action and arguments.
  assert.equal(emptyRead(p, r), undefined);
  w.store.close();
});

test("successful empty reads, unrelated failures and any attempted write cannot replan", async () => {
  const w = world();
  const read = compiled(wire([action("s1", "M06.A03", { query: "Unmatched fixture wording" })]));
  assert.equal(runtimeNoMatch(read, await execute(read, registry, w, { executionId: "read" })), undefined);
  const p = compiled(wire([action("write", "M06.A01", { title: "First write" }), ...miss().steps!]));
  const r = await execute(p, registry, w, { executionId: "write-first" });
  assert.equal(r.writesAttempted, true);
  assert.equal(runtimeNoMatch(p, r), undefined);
  const noMatch = await execute(compiled(miss()), registry, w, { executionId: "unrelated" });
  noMatch.steps[1]!.error = { code: "INVALID", message: "bad enum" };
  assert.equal(runtimeNoMatch(compiled(miss()), noMatch), undefined);
  w.store.close();
});

test("a write loop over an empty search is a no-match even though the run is done; an emptying filter is not one", async () => {
  const w = world();
  const each = (input: string): Step => ({ id: "s3", kind: "op", op: "forEach", in: input, whereJson: null, by: null, set: null, roundRobin: null, do: [{ action: "M06.A05", argsJson: JSON.stringify({ taskId: "$item.id", assigneeId: "us_5" }) }] });
  const empty = compiled(wire([action("s1", "M06.A03", { query: "Unmatched fixture wording" }), each("$s1.items")]));
  const r = await execute(empty, registry, w, { executionId: "empty-loop" });
  assert.equal(r.status, "done");
  assert.match(runtimeNoMatch(empty, r)!, /Step s1 \(M06.A03\).*Unmatched fixture wording.*0 items.*step s3.*ran over nothing/);
  assert.deepEqual(emptyRead(empty, r), { action: "M06.A03", args: { query: "Unmatched fixture wording" } });
  // The search found tasks; the plan's own filter chose none of them.
  const filtered = compiled(wire([
    action("s1", "M06.A03", {}),
    { id: "s2", kind: "op", op: "filter", in: "$s1.items", whereJson: '{"title":"Unmatched fixture wording"}', by: null, set: null, roundRobin: null, do: null },
    each("$s2"),
  ]));
  const f = await execute(filtered, registry, w, { executionId: "filtered" });
  // The executor already fails that run with its own message about the filter.
  assert.doesNotMatch(runtimeNoMatch(filtered, f) ?? "", /ran over nothing/);
  assert.equal(emptyRead(filtered, f), undefined);
  w.store.close();
});

test("Conversation replans once with the fact and retains the original request", async () => {
  const w = world();
  const requests: PlanRequest[] = [];
  const replies = [miss(), wire([action("s1", "M06.A01", { title: "Recovered fixture task" })])];
  const planner: Planner = { name: "scripted", plan: async (req) => {
    requests.push(req);
    const json = replies.shift(); assert.ok(json);
    return { model: "fake", json, text: JSON.stringify(json), usage: { input: 0, output: 0, cachedRead: 0, cacheWrite: 0, thinking: 0, costUsd: 0, billing: "none" }, latencyMs: 1 };
  } };
  const chat = new Conversation({ registry, planner, retriever: new Retriever(buildCards(registry)) }, w);
  let status: string | undefined;
  await chat.ask("create a task based on an existing task", "fast", "us_1", (e, d: any) => { if (e === "reply") status = d.status; });
  assert.equal(status, "done");
  assert.equal(requests.length, 2);
  assert.match(requests[1]!.user, /<failed_attempt>.*Step s1 .*found nothing/, "the fact rides the failed-attempt retry");
  assert.match(requests[1]!.user, /create a task based on an existing task/);
  w.store.close();
});

test("Conversation replans a write loop that ran over an empty search, and the retry's write runs", async () => {
  const w = world();
  const requests: PlanRequest[] = [];
  const loop = wire([
    action("s1", "M06.A03", { query: "Unmatched fixture wording" }),
    { id: "s2", kind: "op", op: "forEach", in: "$s1.items", whereJson: null, by: null, set: null, roundRobin: null, do: [{ action: "M06.A05", argsJson: JSON.stringify({ taskId: "$item.id", assigneeId: "us_5" }) }] },
  ]);
  const replies = [loop, wire([action("s1", "M06.A01", { title: "Recovered fixture task" })])];
  const planner: Planner = { name: "scripted", plan: async (req) => {
    requests.push(req);
    const json = replies.shift(); assert.ok(json);
    return { model: "fake", json, text: JSON.stringify(json), usage: { input: 0, output: 0, cachedRead: 0, cacheWrite: 0, thinking: 0, costUsd: 0, billing: "none" }, latencyMs: 1 };
  } };
  const chat = new Conversation({ registry, planner, retriever: new Retriever(buildCards(registry)) }, w);
  let status: string | undefined;
  await chat.ask("give the fixture tasks to Noah", "fast", "us_1", (e, d: any) => { if (e === "reply") status = d.status; });
  assert.equal(requests.length, 2);
  assert.match(requests[1]!.user, /<failed_attempt>.*step s2 .*ran over nothing/);
  assert.match(requests[1]!.user, /"empty":\[\{"action":"M06.A03"/, "the empty search rides along so a repeat of it can be refused");
  assert.equal(status, "done");
  assert.equal(w.store.all<{ title: string }>("tasks").filter((t) => t.title === "Recovered fixture task").length, 1);
  w.store.close();
});

test("a second miss ends the turn rather than calling the planner again", async () => {
  const w = world(); let calls = 0;
  // The retry searches differently and misses too; the same search again is refused before it runs (planner/turn.ts).
  const planner: Planner = { name: "scripted", plan: async () => {
    calls++; const json = miss(`Unmatched fixture wording ${calls}`);
    return { model: "fake", json, text: JSON.stringify(json), usage: { input: 0, output: 0, cachedRead: 0, cacheWrite: 0, thinking: 0, costUsd: 0, billing: "none" }, latencyMs: 1 };
  } };
  const chat = new Conversation({ registry, planner, retriever: new Retriever(buildCards(registry)) }, w);
  let status: string | undefined;
  await chat.ask("create a task based on an existing task", "fast", "us_1", (e, d: any) => { if (e === "reply") status = d.status; });
  assert.equal(calls, 2);
  assert.equal(status, "failed");
  w.store.close();
});
