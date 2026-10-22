// One line per recorded eval run in eval/results/history.jsonl: which code was measured (commit, uncommitted
// edits), against which question set, and the headline numbers. docs/trajectory.html reads it to show how the
// app got where it is; docs/JOURNEY.md says why each change was made.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";

export interface HistoryEntry {
  /** When the run finished (for a backfilled entry: when it was originally run, or the commit's date). */
  at: string;
  suite: "scenarios" | "retrieval";
  label: string;
  /** The commit measured, and whether the tree had uncommitted edits; null outside a git checkout. */
  git: { sha: string; dirty: boolean } | null;
  /** Fingerprint of the questions (scenario files, retrieval split): runs are comparable only when it matches. */
  set: string;
  /** What was varied: planner and tier, or retrieval mode, split and settings. */
  config: Record<string, unknown>;
  metrics: Record<string, number>;
  /** The full result file, relative to the repo root. */
  file?: string;
  /** Added afterwards from a saved result file or a re-run of an old commit, not by the run itself. */
  backfilled?: string;
  /** The change it measured was reverted: the run stays in the history, off the main lines. */
  reverted?: boolean;
  note?: string;
}

export const fingerprint = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);

/** The commit checked out under `root`; eval results don't count as uncommitted edits. */
export function gitState(root: string): HistoryEntry["git"] {
  try {
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return { sha: git("rev-parse", "--short", "HEAD"), dirty: git("status", "--porcelain", "--", ".", ":!eval/results").length > 0 };
  } catch {
    return null;
  }
}

export function appendHistory(root: string, entry: HistoryEntry): void {
  appendFileSync(`${root}eval/results/history.jsonl`, `${JSON.stringify(entry)}\n`);
}

export function readHistory(root: string): HistoryEntry[] {
  const file = `${root}eval/results/history.jsonl`;
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as HistoryEntry);
}
