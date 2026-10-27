import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { ClaudeCliPlanner } from "./claude-cli.js";
import { PlannerError } from "./types.js";

// A fake `claude` on PATH: reads the prompt, prints what $FAKE_OUT holds, then lingers like the real CLI does.
const RESULT = {
  type: "result",
  is_error: false,
  result: '{"type":"answer"}',
  structured_output: { type: "answer" },
  total_cost_usd: 0.0123,
  duration_ms: 1900,
  duration_api_ms: 1500,
  num_turns: 2,
  usage: {
    input_tokens: 10,
    cache_read_input_tokens: 4000,
    cache_creation_input_tokens: 600,
    output_tokens: 250,
    output_tokens_details: { thinking_tokens: 50 },
    iterations: [{ type: "message" }],
  },
};

let path: string | undefined;
const req = { tier: "fast" as const, system: "sys", user: "hi", schema: {} };

function fake(script: string) {
  const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
  writeFileSync(join(dir, "claude"), `#!/bin/sh\ncat > /dev/null\n${script}\n`);
  chmodSync(join(dir, "claude"), 0o755);
  process.env.PATH = `${dir}:${path}`;
}

describe("claude-cli planner", () => {
  before(() => (path = process.env.PATH));
  after(() => (process.env.PATH = path));

  test("maps every token kind, the cost estimate, model requests and model time", async () => {
    fake(`printf '%s\\n' '${JSON.stringify(RESULT)}'`);
    const r = await new ClaudeCliPlanner({ fast: "m", strong: "m" }).plan(req);
    assert.deepEqual(r.json, { type: "answer" });
    assert.deepEqual(r.usage, { billing: "api_estimate", input: 4610, cachedRead: 4000, cacheWrite: 600, output: 200, thinking: 50, costUsd: 0.0123 });
    assert.equal(r.modelCalls, 1);
    assert.equal(r.apiMs, 1500);
  });

  test("answers as soon as the result is printed, without waiting for the CLI to exit", async () => {
    fake(`printf '%s\\n' '${JSON.stringify(RESULT)}'\nsleep 3`);
    const started = performance.now();
    await new ClaudeCliPlanner({ fast: "m", strong: "m" }).plan(req);
    assert.ok(performance.now() - started < 2_000);
  });

  test("an abort kills the process and fails as a timeout", async () => {
    fake("sleep 10");
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 50);
    const started = performance.now();
    await assert.rejects(new ClaudeCliPlanner({ fast: "m", strong: "m" }).plan({ ...req, signal: ctl.signal }), (e) => e instanceof PlannerError && e.kind === "timeout");
    assert.ok(performance.now() - started < 2_000);
  });

  test("an error result is read from the JSON the CLI still prints", async () => {
    fake(`printf '%s\\n' '${JSON.stringify({ ...RESULT, is_error: true, result: "API Error: 429 rate limit" })}'\nexit 1`);
    await assert.rejects(new ClaudeCliPlanner({ fast: "m", strong: "m" }).plan(req), (e) => e instanceof PlannerError && e.kind === "rate_limited");
  });
});
