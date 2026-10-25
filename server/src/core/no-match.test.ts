import assert from "node:assert/strict";
import { before, test } from "node:test";
import { compile, type CompiledPlan } from "./compile.js";
import { execute } from "./execute.js";
import { runtimeNoMatch } from "./no-match.js";
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
const miss = () => wire([action("s1", "M06.A03", { query: "Unmatched fixture wording" }), action("s2", "M06.A01", { title: "$s1.items[0].title" })]);
function compiled(reply: SubmitPlan): CompiledPlan {
  const r = compile(reply, registry); assert.ok(r.ok); return r.plan;
}

test("a failed index after an empty read yields the step, concrete query and zero count", async () => {
  const w = world(), p = compiled(miss());
  const r = await execute(p, registry, w, { executionId: "miss" });
  assert.equal(r.writesAttempted, false);
  assert.match(runtimeNoMatch(p, r)!, /Step s1 \(M06.A03\).*Unmatched fixture wording.*0 items/);
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

test("a second miss ends the turn rather than calling the planner again", async () => {
  const w = world(); let calls = 0;
  const planner: Planner = { name: "scripted", plan: async () => {
    calls++; const json = miss();
    return { model: "fake", json, text: JSON.stringify(json), usage: { input: 0, output: 0, cachedRead: 0, cacheWrite: 0, thinking: 0, costUsd: 0, billing: "none" }, latencyMs: 1 };
  } };
  const chat = new Conversation({ registry, planner, retriever: new Retriever(buildCards(registry)) }, w);
  let status: string | undefined;
  await chat.ask("create a task based on an existing task", "fast", "us_1", (e, d: any) => { if (e === "reply") status = d.status; });
  assert.equal(calls, 2);
  assert.equal(status, "failed");
  w.store.close();
});
