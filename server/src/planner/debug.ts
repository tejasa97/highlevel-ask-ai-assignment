// Opt-in planner debug log (PLANNER_DEBUG=1): every planner LLM call, with the full prompt and raw reply, as a
// `planner.debug` event and as one JSONL line in PLANNER_DEBUG_FILE (default logs/planner_debug.jsonl).
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Usage } from "./types.js";

export type DebugReason = "initial" | "retry" | "after retrieval" | "after call" | "after identity check" | "repair";

export interface PlannerDebug {
  at: string;
  /** 1-based planner call within this planTurn. */
  round: number;
  reason: DebugReason;
  label: string;
  tier: string;
  model: string;
  system: string;
  user: string;
  /** The raw text the model returned; on a failed call, whatever text the error carried. */
  raw: string | null;
  parsed: unknown;
  usage: Usage | null;
  latencyMs: number;
  error?: string;
}

export const plannerDebugEnabled = () => /^(1|true|yes)$/i.test(process.env.PLANNER_DEBUG?.trim() ?? "");

/** Why a call with this label happened. `retrying` is set when the turn re-plans after a failed run. */
export function debugReason(label: string, retrying: boolean): DebugReason {
  if (label.includes("search_tools")) return "after retrieval";
  if (label.startsWith("repair") || label === "check selection") return "repair";
  if (label.includes("look")) return "after call";
  if (label.includes("identity")) return "after identity check";
  return retrying ? "retry" : "initial";
}

export function appendPlannerDebug(entry: PlannerDebug): void {
  const file = resolve(process.env.PLANNER_DEBUG_FILE || "logs/planner_debug.jsonl");
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch (err) {
    console.error(`planner debug: could not write ${file}: ${err instanceof Error ? err.message : err}`);
  }
}
