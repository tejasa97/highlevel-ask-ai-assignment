import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { makePlanner } from "./index.js";

const KEYS = ["CLAUDE_MODEL", "CLAUDE_FAST_MODEL", "QWEN_API_KEY", "QWEN_MODEL", "QWEN_FAST_MODEL"];
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("makePlanner defaults", () => {
  it("runs claude-cli on haiku for both tiers", () => {
    delete process.env.CLAUDE_MODEL;
    delete process.env.CLAUDE_FAST_MODEL;
    const planner = makePlanner("claude-cli");
    assert.equal(planner.name, "claude-cli");
    assert.deepEqual(planner.models, { strong: "haiku", fast: "haiku" });
  });

  it("lets CLAUDE_MODEL pick another model per tier", () => {
    process.env.CLAUDE_MODEL = "claude-sonnet-5-5";
    delete process.env.CLAUDE_FAST_MODEL;
    assert.deepEqual(makePlanner("claude-cli").models, { strong: "claude-sonnet-5-5", fast: "haiku" });

    process.env.CLAUDE_FAST_MODEL = "claude-sonnet-5-5";
    assert.deepEqual(makePlanner("claude-cli").models, { strong: "claude-sonnet-5-5", fast: "claude-sonnet-5-5" });
  });

  it("treats a blank model variable as unset", () => {
    // A blank line in .env reached `claude -p --model ""`, which answers "model: String should have at least 1
    // character" on every turn.
    process.env.CLAUDE_MODEL = "";
    process.env.CLAUDE_FAST_MODEL = "";
    assert.deepEqual(makePlanner("claude-cli").models, { strong: "haiku", fast: "haiku" });

    process.env.CODEX_MODEL = "";
    assert.deepEqual(makePlanner("codex-cli").models, { strong: "gpt-6.1-sol", fast: "gpt-6.1-sol" });
  });

  it("keeps the Token Plan on qwen3.8-flash, with deepseek one variable away", () => {
    process.env.QWEN_API_KEY = "sk-sp-test";
    delete process.env.QWEN_MODEL;
    delete process.env.QWEN_FAST_MODEL;
    assert.deepEqual(makePlanner("qwen").models, { strong: "qwen3.8-flash", fast: "qwen3.8-flash" });

    process.env.QWEN_MODEL = "deepseek-v4.1-flash-1017";
    assert.deepEqual(makePlanner("qwen").models, { strong: "deepseek-v4.1-flash-1017", fast: "deepseek-v4.1-flash-1017" });
  });
});
