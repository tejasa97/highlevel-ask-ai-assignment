import { relative, resolve } from "node:path";
import { loadScenarios } from "./scenario.js";

export const DEFAULT_SCENARIO_DIR = "eval/scenarios";
/** Only the selected folder is loaded, so development never discovers reporting cases recursively. */
export function selectScenarios(root: string, option?: string) {
  if (option !== undefined && (!option.trim() || option.startsWith("--")))
    throw Error("--scenario-dir needs a directory path");
  const absolute = resolve(root, option ?? DEFAULT_SCENARIO_DIR);
  const scenarios = loadScenarios(absolute);
  if (!scenarios.length) throw Error(`No scenarios in ${absolute}`);
  return {
    scenarioDir: relative(root, absolute).split("\\").join("/"),
    scenarios,
  };
}
