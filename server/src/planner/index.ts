import { ClaudeCliPlanner } from "./claude-cli.js";
import { CodexCliPlanner, type Reasoning } from "./codex-cli.js";
import type { Planner } from "./types.js";

/** Local development providers: Claude (default) or opt-in Codex subscription access. */
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
  throw new Error(`unknown PLANNER "${kind}"; supported: claude-cli, codex-cli`);
}
