import { relative, resolve } from "node:path";
import { loadScenarios } from "./scenario.js";

export const DEFAULT_SCENARIO_DIR = "eval/scenarios";
/** Only the selected folders are loaded, so development never discovers reporting cases recursively.
 *  Several folders may be joined with commas to run them as one set; ids must stay unique across them. */
export function selectScenarios(root: string, option?: string) {
  if (option !== undefined && (!option.trim() || option.startsWith("--")))
    throw Error("--scenario-dir needs a directory path");
  const absolute = (option ?? DEFAULT_SCENARIO_DIR).split(",").map((d) => resolve(root, d.trim()));
  const scenarios = absolute.flatMap((dir) => {
    const found = loadScenarios(dir);
    if (!found.length) throw Error(`No scenarios in ${dir}`);
    return found;
  });
  const seen = new Set<string>();
  for (const s of scenarios) {
    if (seen.has(s.id)) throw Error(`Duplicate scenario id ${s.id} across --scenario-dir folders`);
    seen.add(s.id);
  }
  return {
    scenarioDir: absolute.map((dir) => relative(root, dir).split("\\").join("/")).join(","),
    scenarios,
  };
}
