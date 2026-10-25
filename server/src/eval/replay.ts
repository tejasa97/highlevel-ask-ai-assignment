import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Planner, PlanRequest, PlanResult } from "../planner/types.js";

// Record/replay for the eval's planner calls. The planner is the only slow, paid, nondeterministic part of a
// scenario run; everything after it (compile, execute, summarize, checks) is code. Keyed on exactly what the
// model is sent, a change that doesn't alter a prompt replays the recorded reply through the new code for free,
// and a change that does alter one goes live for just those calls.

export interface ReplayStats {
  hits: number;
  live: number;
  /** Cost of the live calls, and of what the hits would have cost. */
  liveUsd: number;
  savedUsd: number;
}

export const promptKey = (req: PlanRequest, salt = ""): string =>
  createHash("sha256").update(JSON.stringify([salt, req.tier, req.system, req.user, req.schema])).digest("hex").slice(0, 24);

interface Line {
  key: string;
  sample: number;
  result: PlanResult;
}

/**
 * `file` is a JSONL of recorded replies. The Nth call with the same prompt in this process gets the Nth recorded
 * sample, so `--repeat 3` keeps three independent samples instead of replaying one; samples missing from the file
 * go live and are appended. `refresh` ignores what is recorded and records anew.
 */
export function replayPlanner(inner: Planner, file: string, opts: { refresh?: boolean; salt?: string } = {}): Planner & { stats: ReplayStats } {
  const recorded = new Map<string, PlanResult>();
  if (existsSync(file))
    for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
      const l = JSON.parse(line) as Line;
      recorded.set(`${l.key}#${l.sample}`, l.result);
    }
  mkdirSync(dirname(file), { recursive: true });
  const seen = new Map<string, number>();
  const stats: ReplayStats = { hits: 0, live: 0, liveUsd: 0, savedUsd: 0 };
  return {
    name: inner.name,
    billing: inner.billing,
    models: inner.models,
    stats,
    async plan(req) {
      const key = promptKey(req, opts.salt);
      const sample = seen.get(key) ?? 0;
      seen.set(key, sample + 1);
      const hit = opts.refresh ? undefined : recorded.get(`${key}#${sample}`);
      if (hit) {
        stats.hits++;
        stats.savedUsd += hit.usage.costUsd ?? 0;
        return hit;
      }
      const result = await inner.plan(req); // a failed call throws and is never recorded
      stats.live++;
      stats.liveUsd += result.usage.costUsd ?? 0;
      recorded.set(`${key}#${sample}`, result);
      appendFileSync(file, `${JSON.stringify({ key, sample, result } satisfies Line)}\n`);
      return result;
    },
  };
}
