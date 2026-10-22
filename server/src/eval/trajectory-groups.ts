import type { HistoryEntry } from "./history.js";

export const scenarioFolder = (h: HistoryEntry): string =>
  String(h.config.scenarioDir ?? "eval/scenarios")
    .replaceAll("\\", "/")
    .replace(/\/$/, "");
/** Each folder chooses its own planner/tier. A reporting run cannot replace the regression headline. */
export function scenarioGroups(history: HistoryEntry[]) {
  const eligible = history.filter(
    (h) =>
      h.suite === "scenarios" && !h.reverted && (h.metrics.measured ?? 0) > 0,
  );
  return [...new Set(eligible.map(scenarioFolder))].map((folder) => {
    const rows = eligible.filter((h) => scenarioFolder(h) === folder),
      latest = rows.at(-1)!;
    return {
      folder,
      planner: latest.config.planner,
      tier: latest.config.tier,
      runs: rows.filter(
        (h) =>
          h.config.planner === latest.config.planner &&
          h.config.model === latest.config.model &&
          h.config.reasoning === latest.config.reasoning &&
          h.config.tier === latest.config.tier,
      ),
    };
  });
}
export function headlineScenarios(history: HistoryEntry[]) {
  return (
    scenarioGroups(history)
      .find((g) => g.folder === "eval/scenarios")
      ?.runs.filter((h) => Number(h.config.repeat) >= 3) ?? []
  );
}
