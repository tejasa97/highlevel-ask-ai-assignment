import { ClaudeCliPlanner } from "./claude-cli.js";
import { CodexCliPlanner, type Reasoning } from "./codex-cli.js";
import { QwenPlanner } from "./qwen.js";
import type { Planner } from "./types.js";

const HAIKU = "claude-haiku-5-5";
const DEEPSEEK = "deepseek-v4.1-flash-1017";
/** The key shown in the README and older copies of .env.example; a .env that still carries it has no key. */
const PLACEHOLDER = "sk-sp-...";

/**
 * Local development providers: Qwen Token Plan running DeepSeek (default), Claude CLI on Haiku 5.5, or opt-in Codex
 * subscription access. With PLANNER unset or blank, a Token Plan key selects qwen, as benchmarked; without one the
 * app runs on claude-cli, so a checkout with only a Claude login works with no configuration.
 */
export function makePlanner(kind = process.env.PLANNER?.trim() || defaultPlanner()): Planner {
  if (kind === "claude-cli") {
    // The default path runs Haiku 5.5, for cost, by its full id. Not the "haiku" alias: CLI 2.1.284 maps that to
    // claude-haiku-4-5-20251001, which measured 91.3% on regression at 23.9 s p50, against 100% (8x) at 7.2 s for
    // claude-haiku-5-5. The CLI logs claude-haiku-5-5 as unrecognized_model on stderr but serves it.
    // Set CLAUDE_MODEL=claude-sonnet-5-5 for the strong tier, and CLAUDE_FAST_MODEL to vary the fast tier.
    return new ClaudeCliPlanner({
      // `||`, not `??`: a blank `CLAUDE_MODEL=` line must fall back, or the CLI gets an empty --model.
      strong: process.env.CLAUDE_MODEL || HAIKU,
      fast: process.env.CLAUDE_FAST_MODEL || HAIKU,
    });
  }
  if (kind === "codex-cli") {
    return new CodexCliPlanner({
      strong: process.env.CODEX_MODEL || "gpt-6.1-sol",
      fast: process.env.CODEX_FAST_MODEL || process.env.CODEX_MODEL || "gpt-6.1-sol",
    }, {
      executable: process.env.CODEX_BIN,
      reasoning: {
        strong: (process.env.CODEX_REASONING || "low") as Reasoning,
        fast: (process.env.CODEX_FAST_REASONING || process.env.CODEX_REASONING || "low") as Reasoning,
      },
    });
  }
  if (kind === "qwen" || kind === "qwen-token-plan") {
    // `||`, not `??`: a blank `QWEN_BASE_URL=` line in .env must fall back to the default, not post to "/chat/completions".
    const apiKey = qwenKey();
    if (!apiKey) {
      throw new Error(`PLANNER=qwen needs QWEN_API_KEY (or ALIBABA_TOKEN_PLAN_API_KEY) in the environment; "${PLACEHOLDER}" doesn't count`);
    }
    const timeout = Number(process.env.QWEN_TIMEOUT_MS);
    // DeepSeek is the benchmarked model: 95.7% on regression against 90.9% for qwen3.8-flash, at a third of the turn
    // latency (97.8% on development for both). Set QWEN_MODEL=qwen3.8-flash for the Qwen flagship on the same key.
    // No format flag is needed, because the client infers json_object from the model name.
    const strong = process.env.QWEN_MODEL || DEEPSEEK;
    return new QwenPlanner({
      apiKey,
      baseUrl: process.env.QWEN_BASE_URL || undefined,
      models: { strong, fast: process.env.QWEN_FAST_MODEL || strong },
      timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : undefined,
      thinking: process.env.QWEN_THINKING === "1" || process.env.QWEN_THINKING === "true",
      responseFormat: pinnedFormat(process.env.QWEN_RESPONSE_FORMAT),
    });
  }
  throw new Error(`unknown PLANNER "${kind}"; supported: claude-cli, codex-cli, qwen`);
}

/** Picks the provider when PLANNER is unset, and says so on stderr: every entry point (serve, ask, probe, eval) gets the line. */
function defaultPlanner(): string {
  const kind = qwenKey() ? "qwen" : "claude-cli";
  console.error(kind === "qwen"
    ? `PLANNER unset: using qwen (${process.env.QWEN_MODEL || DEEPSEEK}), since a Token Plan key is set`
    : "PLANNER unset and no Token Plan key: using claude-cli on your Claude subscription (run `claude auth login` once). " +
      "Set QWEN_API_KEY to plan with DeepSeek on the Qwen Token Plan instead.");
  return kind;
}

/** The first Token Plan key that is set, trimmed. Blank values and the .env.example placeholder don't count. */
function qwenKey(): string | undefined {
  for (const value of [process.env.QWEN_API_KEY, process.env.ALIBABA_TOKEN_PLAN_API_KEY]) {
    const key = value?.trim();
    if (key && key !== PLACEHOLDER) return key;
  }
  return undefined;
}

/** `QWEN_RESPONSE_FORMAT` pins the reply format; blank or anything else leaves it to the model. */
function pinnedFormat(value: string | undefined): "json_schema" | "json_object" | undefined {
  return value === "json_schema" || value === "json_object" ? value : undefined;
}
