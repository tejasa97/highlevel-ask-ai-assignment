import assert from "node:assert/strict";
import { test } from "node:test";
import type { HistoryEntry } from "./history.js";
import { headlineScenarios, scenarioGroups } from "./trajectory-groups.js";

const row = (
  label: string,
  folder?: string,
  extra: Partial<HistoryEntry> = {},
): HistoryEntry => ({
  at: "2026-10-22",
  suite: "scenarios",
  label,
  git: null,
  set: "old",
  config: {
    planner: "claude-cli",
    tier: "strong",
    repeat: 3,
    ...(folder ? { scenarioDir: folder } : {}),
  },
  metrics: { measured: 23, passRate: 100 },
  ...extra,
});
test("interleaved folders form separate series; legacy regression runs remain the headline", () => {
  const rows = [
    row("old-before"),
    row("dev-before", "eval/module-scenarios/m45-m47/development"),
    row("old-after", "eval/scenarios", { set: "corrected" }),
    row("report", "eval/module-scenarios/m45-m47/reporting"),
  ];
  const groups = scenarioGroups(rows);
  assert.equal(groups.length, 3);
  assert.deepEqual(
    groups[0]!.runs.map((r) => r.label),
    ["old-before", "old-after"],
  );
  assert.deepEqual(
    headlineScenarios(rows).map((r) => r.label),
    ["old-before", "old-after"],
  );
  assert.deepEqual(
    groups[0]!.runs.map((r) => r.set),
    ["old", "corrected"],
    "fingerprint breaks remain visible within a folder",
  );
});
test("another folder's provider, reverted or unmeasured runs cannot hijack headline selection", () => {
  const old = row("old"),
    other = row("other", "eval/module-scenarios/m45-m47/reporting");
  other.config = {
    planner: "other",
    tier: "fast",
    repeat: 3,
    scenarioDir: "eval/module-scenarios/m45-m47/reporting",
  };
  const rows = [
    old,
    other,
    row("reverted", undefined, { reverted: true }),
    row("infra", undefined, { metrics: { measured: 0 } }),
  ];
  assert.deepEqual(headlineScenarios(rows), [old]);
  assert.deepEqual(headlineScenarios([other]), []);
  const once = row("once");
  once.config.repeat = 1;
  assert.deepEqual(headlineScenarios([once]), []);
});
