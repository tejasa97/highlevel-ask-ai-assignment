import { ClaudeCliPlanner } from "./claude-cli.js";
import type { Planner } from "./types.js";

/** PLANNER=claude-cli (dev only, Claude subscription). The Anthropic API adapter for benchmark runs isn't built yet. */
export function makePlanner(kind = process.env.PLANNER ?? "claude-cli"): Planner {
  if (kind === "claude-cli") {
    return new ClaudeCliPlanner({
      strong: process.env.CLAUDE_MODEL ?? "claude-sonnet-5-5",
      // Sonnet for both tiers: through claude -p, Haiku 5.5 always thinks (~1k tokens; MAX_THINKING_TOKENS=0
      // and --effort low only trim it), so it is ~2x slower than Sonnet here. Set CLAUDE_FAST_MODEL to compare.
      fast: process.env.CLAUDE_FAST_MODEL ?? "claude-sonnet-5-5",
    });
  }
  throw new Error(`unknown PLANNER "${kind}"; supported: claude-cli`);
}
