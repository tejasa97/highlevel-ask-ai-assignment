import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import type { PlanRequest, Planner } from "../planner/types.js";
import { loadRegistry, type Registry } from "../registry/registry.js";
import { buildCards } from "../retrieval/cards.js";
import { Retriever } from "../retrieval/retrieve.js";
import { world } from "../store/world.js";
import { BaselineConversation, MAX_STEPS, outcome } from "./baseline.js";

// The baseline agent over a scripted model and a fresh database.

let registry: Registry;
let retriever: Retriever;
before(async () => {
  registry = await loadRegistry();
  retriever = new Retriever(buildCards(registry));
});

const NULLS = { action: null, argsJson: null, entity: null, name: null, query: null, text: null, options: null };
const call = (action: string, args: unknown) => ({ ...NULLS, type: "call", action, argsJson: JSON.stringify(args) });
const say = (type: string, text: string) => ({ ...NULLS, type, text });

/** Answers with the scripted replies in order (a function as the last one answers every later request) and keeps what it was sent. */
function scripted(...replies: (object | ((req: PlanRequest) => object))[]): Planner & { requests: PlanRequest[] } {
  const requests: PlanRequest[] = [];
  return {
    name: "scripted",
    requests,
    async plan(req) {
      requests.push(req);
      const next = replies.length === 1 && typeof replies[0] === "function" ? replies[0] : replies.shift();
      if (!next) throw new Error("model called more times than scripted");
      const json = typeof next === "function" ? next(req) : next;
      return { model: "fake", json, text: JSON.stringify(json), usage: { input: 0, cachedRead: 0, cacheWrite: 0, output: 0, thinking: 0, costUsd: 0, billing: "none" }, latencyMs: 1 };
    },
  };
}

function chat(planner: Planner) {
  const w = world();
  const events: { event: string; data: any }[] = [];
  const c = new BaselineConversation({ registry, retriever, planner }, w);
  const emit = (event: string, data: unknown) => events.push({ event, data });
  const replies = () => events.filter((e) => e.event === "reply").map((e) => e.data);
  return { w, c, emit, events, replies };
}

describe("baseline agent", () => {
  test("one call per model reply: resolves a name, sees the id, uses it, then replies", async () => {
    const planner = scripted({ ...NULLS, type: "resolve", entity: "contact", name: "Rosa Ito" }, (req) => {
      const id = /"id":"(ct_\w+)"/.exec(req.user)![1];
      return call("M06.A01", { title: "Call Rosa Ito", relatedTo: { type: "contact", id } });
    }, say("done", "Created a task to call Rosa Ito."));
    const { w, c, emit, events, replies } = chat(planner);
    const before = w.store.db.prepare("SELECT count(*) n FROM tasks").get() as { n: number };
    await c.ask("Create a task to call Rosa Ito", "fast", "us_1", emit);

    assert.equal(planner.requests.length, 3);
    assert.match(planner.requests[1]!.user, /<steps>\n1\. resolve contact "Rosa Ito"\n   → /);
    assert.deepEqual(replies(), [{ status: "done", text: "Created a task to call Rosa Ito.", options: undefined }]);
    assert.ok(events.some((e) => e.event === "plan" && e.data.steps[0].calls?.[0].action === "M06.A01"));
    assert.equal((w.store.db.prepare("SELECT count(*) n FROM tasks").get() as { n: number }).n, before.n + 1);
  });

  test("an invalid call comes back to the model as an error, not to the user", async () => {
    const planner = scripted(call("M99.A99", {}), say("clarify", "Which task?"));
    const { c, emit, events, replies } = chat(planner);
    await c.ask("Create a task to call Rosa Ito", "fast", "us_1", emit);
    assert.ok(events.some((e) => e.event === "compile.errors"));
    assert.match(planner.requests[1]!.user, /1\. call M99\.A99 \{\}\n   → error: /);
    assert.equal(replies()[0].status, "clarify");
  });

  test("a risky call waits for approval; approving runs it and the loop goes on, declining cancels", async () => {
    for (const approve of [true, false]) {
      const planner = scripted((req) => (req.user.includes("<steps>\nnone yet") ? call("M06.A10", { taskId: TASK }) : say("done", "Cancelled the task.")));
      const { w, c, emit, events, replies } = chat(planner);
      const TASK = w.f.task({ title: "Send the brochure" }).id;
      await c.ask("Cancel the task to send the brochure", "fast", "us_1", emit);
      assert.equal(replies()[0].status, "awaiting_confirmation");
      const turnId = events.find((e) => e.event === "confirm")!.data.turnId;
      await c.confirm(turnId, approve, "us_1", emit);
      const status = (w.store.db.prepare("SELECT json_extract(data,'$.status') s FROM tasks WHERE id=?").get(TASK) as { s: string }).s;
      assert.equal(replies()[1].status, approve ? "done" : "cancelled");
      assert.equal(status, approve ? "cancelled" : "open");
    }
  });

  test(`gives up after ${MAX_STEPS} model calls`, async () => {
    const planner = scripted(() => call("M99.A99", {}));
    const { c, emit, replies } = chat(planner);
    await c.ask("Create a task to call Rosa Ito", "fast", "us_1", emit);
    assert.equal(planner.requests.length, MAX_STEPS);
    assert.equal(replies()[0].status, "failed");
  });

  test("the turn's status: a failure fixed by a later retry still counts as done", () => {
    assert.equal(outcome([{ id: "a", ok: false }, { id: "a", ok: true }]), "done");
    assert.equal(outcome([{ id: "a", ok: true }, { id: "b", ok: false }]), "partial");
    assert.equal(outcome([{ id: "a", ok: false }]), "failed");
  });
});
