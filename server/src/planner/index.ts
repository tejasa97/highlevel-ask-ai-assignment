import { ClaudeCliPlanner } from "./claude-cli.js";
import { CodexCliPlanner, type Reasoning } from "./codex-cli.js";
import { QwenPlanner } from "./qwen.js";
import type { Planner } from "./types.js";

/** Local development providers: Claude (default), opt-in Codex subscription access, or Qwen Token Plan. */
export function makePlanner(kind = process.env.PLANNER ?? "claude-cli"): Planner {
  if (kind === "claude-cli") {
    // The default path runs Haiku, for cost. The alias rather than an id: CLI 2.1.284 ships
    // claude-haiku-4-5-20251001 and tags claude-haiku-5-5 as unrecognized_model, so "haiku" tracks whichever
    // Haiku the installed CLI actually supports. Through claude -p it always thinks (~1k tokens;
    // MAX_THINKING_TOKENS=0 and --effort low only trim it), so it is ~2x slower than Sonnet: set
    // CLAUDE_MODEL=claude-sonnet-5-5 to trade cost for latency, and CLAUDE_FAST_MODEL to vary the fast tier.
    return new ClaudeCliPlanner({
      strong: process.env.CLAUDE_MODEL ?? "haiku",
      fast: process.env.CLAUDE_FAST_MODEL ?? "haiku",
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
    // This adapter defaults to the Qwen flagship. DeepSeek measured 95.7% on regression against 90.9% here, at a
    // third of the turn latency (97.8% on development for both), and is one variable away: point QWEN_MODEL at
    // deepseek-v4.1-flash-1017. No format flag is needed, because the client infers json_object from the name.
    const strong = process.env.QWEN_MODEL || "qwen3.8-flash";
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
