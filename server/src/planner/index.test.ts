import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { makePlanner } from "./index.js";

const KEYS = ["PLANNER", "CLAUDE_MODEL", "CLAUDE_FAST_MODEL", "CODEX_MODEL", "QWEN_API_KEY", "ALIBABA_TOKEN_PLAN_API_KEY", "QWEN_MODEL", "QWEN_FAST_MODEL"];
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("makePlanner defaults", () => {
  it("runs claude-cli on Haiku 5.5 for both tiers, by its full id", () => {
    delete process.env.CLAUDE_MODEL;
    delete process.env.CLAUDE_FAST_MODEL;
    const planner = makePlanner("claude-cli");
    assert.equal(planner.name, "claude-cli");
    assert.deepEqual(planner.models, { strong: "claude-haiku-5-5", fast: "claude-haiku-5-5" });
  });

  it("lets CLAUDE_MODEL pick another model per tier", () => {
    process.env.CLAUDE_MODEL = "claude-sonnet-5-5";
    delete process.env.CLAUDE_FAST_MODEL;
    assert.deepEqual(makePlanner("claude-cli").models, { strong: "claude-sonnet-5-5", fast: "claude-haiku-5-5" });

    process.env.CLAUDE_FAST_MODEL = "claude-sonnet-5-5";
    assert.deepEqual(makePlanner("claude-cli").models, { strong: "claude-sonnet-5-5", fast: "claude-sonnet-5-5" });
  });

  it("treats a blank model variable as unset", () => {
    // A blank line in .env reached `claude -p --model ""`, which answers "model: String should have at least 1
    // character" on every turn.
    process.env.CLAUDE_MODEL = "";
    process.env.CLAUDE_FAST_MODEL = "";
    assert.deepEqual(makePlanner("claude-cli").models, { strong: "claude-haiku-5-5", fast: "claude-haiku-5-5" });

    process.env.CODEX_MODEL = "";
    assert.deepEqual(makePlanner("codex-cli").models, { strong: "gpt-6.1-sol", fast: "gpt-6.1-sol" });
  });

  it("runs the Token Plan on DeepSeek, with the Qwen flagship one variable away", () => {
    process.env.QWEN_API_KEY = "sk-sp-test";
    delete process.env.QWEN_MODEL;
    delete process.env.QWEN_FAST_MODEL;
    assert.deepEqual(makePlanner("qwen").models, { strong: "deepseek-v4.1-flash-1017", fast: "deepseek-v4.1-flash-1017" });

    process.env.QWEN_MODEL = "qwen3.8-flash";
    assert.deepEqual(makePlanner("qwen").models, { strong: "qwen3.8-flash", fast: "qwen3.8-flash" });
  });
});

describe("makePlanner provider choice", () => {
  it("picks qwen when PLANNER is unset and a Token Plan key is present", () => {
    delete process.env.PLANNER;
    delete process.env.ALIBABA_TOKEN_PLAN_API_KEY;
    process.env.QWEN_API_KEY = "sk-sp-test";
    assert.equal(makePlanner().name, "qwen");
  });

  it("falls back to claude-cli on Haiku 5.5 without a key, or with a blank one", () => {
    process.env.PLANNER = "";
    delete process.env.ALIBABA_TOKEN_PLAN_API_KEY;
    delete process.env.CLAUDE_MODEL;
    delete process.env.CLAUDE_FAST_MODEL;
    process.env.QWEN_API_KEY = " ";
    const planner = makePlanner();
    assert.equal(planner.name, "claude-cli");
    assert.deepEqual(planner.models, { strong: "claude-haiku-5-5", fast: "claude-haiku-5-5" });
  });

  it("accepts ALIBABA_TOKEN_PLAN_API_KEY alone, and behind a blank QWEN_API_KEY", () => {
    delete process.env.PLANNER;
    process.env.ALIBABA_TOKEN_PLAN_API_KEY = "sk-sp-alias";
    delete process.env.QWEN_API_KEY;
    assert.equal(makePlanner().name, "qwen");

    process.env.QWEN_API_KEY = " ";
    assert.equal(makePlanner().name, "qwen");
    assert.equal(makePlanner("qwen").name, "qwen");
  });

  it("treats the sk-sp-... placeholder as no key", () => {
    delete process.env.PLANNER;
    delete process.env.ALIBABA_TOKEN_PLAN_API_KEY;
    process.env.QWEN_API_KEY = "sk-sp-...";
    assert.equal(makePlanner().name, "claude-cli");
    assert.throws(() => makePlanner("qwen"), /needs QWEN_API_KEY/);
  });

  it("lets PLANNER=claude-cli override a present key", () => {
    process.env.PLANNER = "claude-cli";
    process.env.QWEN_API_KEY = "sk-sp-test";
    assert.equal(makePlanner().name, "claude-cli");
  });
});
