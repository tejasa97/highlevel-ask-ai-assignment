import { ClaudeCliPlanner } from "./claude-cli.js";
import { CodexCliPlanner, type Reasoning } from "./codex-cli.js";
import { QwenPlanner } from "./qwen.js";
import type { Planner } from "./types.js";

/** Local development providers: Claude (default), opt-in Codex subscription access, or Qwen Token Plan. */
export function makePlanner(kind = process.env.PLANNER ?? "claude-cli"): Planner {
  if (kind === "claude-cli") {
    return new ClaudeCliPlanner({
      strong: process.env.CLAUDE_MODEL ?? "claude-sonnet-5-5",
      // Sonnet for both tiers: through claude -p, Haiku 5.5 always thinks (~1k tokens; MAX_THINKING_TOKENS=0
      // and --effort low only trim it), so it is ~2x slower than Sonnet here. Set CLAUDE_FAST_MODEL to compare.
      fast: process.env.CLAUDE_FAST_MODEL ?? "claude-sonnet-5-5",
    });
  }
  if (kind === "codex-cli") {
    return new CodexCliPlanner({
      strong: process.env.CODEX_MODEL ?? "gpt-6.1-sol",
      fast: process.env.CODEX_FAST_MODEL ?? process.env.CODEX_MODEL ?? "gpt-6.1-sol",
    }, {
      executable: process.env.CODEX_BIN,
      reasoning: {
        strong: (process.env.CODEX_REASONING ?? "low") as Reasoning,
        fast: (process.env.CODEX_FAST_REASONING ?? process.env.CODEX_REASONING ?? "low") as Reasoning,
      },
    });
  }
  if (kind === "qwen" || kind === "qwen-token-plan") {
    // `||`, not `??`: a blank `QWEN_BASE_URL=` line in .env must fall back to the default, not post to "/chat/completions".
    const apiKey = process.env.QWEN_API_KEY || process.env.ALIBABA_TOKEN_PLAN_API_KEY;
    if (!apiKey?.trim()) {
      throw new Error("PLANNER=qwen needs QWEN_API_KEY (or ALIBABA_TOKEN_PLAN_API_KEY) in the environment");
    }
    const timeout = Number(process.env.QWEN_TIMEOUT_MS);
    // Default measured 2026-10-25 over 68 scenarios: 95.7% of regression and 97.8% of development, at a third
    // of the turn latency, against 90.9% and 97.8% for qwen3.8-flash. It has no json_schema on the Token Plan,
    // so the client infers json_object from the model name and QWEN_RESPONSE_FORMAT stays an override.
    const strong = process.env.QWEN_MODEL || "deepseek-v4.1-flash-1017";
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

/** `QWEN_RESPONSE_FORMAT` pins the reply format; blank or anything else leaves it to the model. */
function pinnedFormat(value: string | undefined): "json_schema" | "json_object" | undefined {
  return value === "json_schema" || value === "json_object" ? value : undefined;
}
