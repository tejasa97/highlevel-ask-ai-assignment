import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { type Planner, type PlanRequest, PlannerError } from "../planner/types.js";
import { replayPlanner } from "./replay.js";

const req = (user: string): PlanRequest => ({ tier: "strong", system: "sys", user, schema: { type: "object" } });
const usage = { input: 10, cachedRead: 0, cacheWrite: 0, output: 5, thinking: 0, costUsd: 0.01, billing: "api" as const };

/** A planner that answers "reply N" with N counting its live calls, so a replay is told apart from a new answer. */
function counting() {
  let calls = 0;
  const planner: Planner = { name: "fake", async plan() { calls++; return { model: "m", json: { n: calls }, text: "", usage, latencyMs: 1 }; } };
  return { planner, calls: () => calls };
}
const file = () => join(mkdtempSync(join(tmpdir(), "replay-")), "cache.jsonl");

describe("replayPlanner", () => {
  test("the same prompt in a later run replays the recorded reply without calling the model", async () => {
    const f = file();
    const first = counting();
    const a = replayPlanner(first.planner, f);
    assert.deepEqual((await a.plan(req("x"))).json, { n: 1 });
    const second = counting();
    const b = replayPlanner(second.planner, f);
    assert.deepEqual((await b.plan(req("x"))).json, { n: 1 });
    assert.equal(second.calls(), 0);
    assert.deepEqual({ hits: b.stats.hits, live: b.stats.live, saved: b.stats.savedUsd }, { hits: 1, live: 0, saved: 0.01 });
  });

  test("a prompt that changed, in any part, goes live", async () => {
    const f = file();
    await replayPlanner(counting().planner, f).plan(req("x"));
    for (const changed of [req("y"), { ...req("x"), system: "sys2" }, { ...req("x"), schema: { type: "array" } }, { ...req("x"), tier: "fast" as const }]) {
      const c = counting();
      await replayPlanner(c.planner, f).plan(changed);
      assert.equal(c.calls(), 1);
    }
  });

  test("repeats keep separate samples; more repeats than recorded go live for the extra ones", async () => {
    const f = file();
    const first = counting();
    const a = replayPlanner(first.planner, f);
    const run = async (p: Planner, n: number) => { const out = []; for (let i = 0; i < n; i++) out.push((await p.plan(req("x"))).json); return out; };
    assert.deepEqual(await run(a, 2), [{ n: 1 }, { n: 2 }]);
    const second = counting();
    assert.deepEqual(await run(replayPlanner(second.planner, f), 3), [{ n: 1 }, { n: 2 }, { n: 1 }]);
    assert.equal(second.calls(), 1);
  });

  test("refresh ignores the recording and records anew; a failed call is not recorded", async () => {
    const f = file();
    await replayPlanner(counting().planner, f).plan(req("x"));
    const c = counting();
    assert.deepEqual((await replayPlanner(c.planner, f, { refresh: true }).plan(req("x"))).json, { n: 1 });
    assert.equal(c.calls(), 1);
    const down: Planner = { name: "down", plan: async () => Promise.reject(new PlannerError("limit", "rate_limited")) };
    await assert.rejects(replayPlanner(down, f).plan(req("never seen")), /limit/);
    assert.equal(readFileSync(f, "utf8").split("\n").filter(Boolean).length, 2);
  });
});
