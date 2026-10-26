// Writes BENCHMARK.md at the repo root from saved scenario results (see eval/report.ts for what it measures).
// Without --label it reports the latest recorded scenario run that wasn't reverted.
// Run: npm run report -- [--label name] [--compare name,...] [--out path]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fingerprint, readHistory } from "../eval/history.js";
import { type Measured, type ResultFile, renderReport, type Targets } from "../eval/report.js";
import { selectScenarios } from "../eval/selection.js";
import { CATALOG } from "../registry/catalog.js";
import { loadRegistry } from "../registry/registry.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const EVAL = `${ROOT}eval/`;
const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const history = readHistory(ROOT);
const scenarioRuns = history.filter((h) => h.suite === "scenarios");
const primary = opt("label") ?? scenarioRuns.filter((h) => !h.reverted).at(-1)?.label;
if (!primary) {
  console.error("no recorded scenario run; pass --label");
  process.exit(2);
}
const labels = [primary, ...(opt("compare")?.split(",").filter(Boolean) ?? [])];

const measured: Measured[] = labels.map((label) => {
  const file = `${EVAL}results/scenarios-${label}.json`;
  if (!existsSync(file)) {
    console.error(`no results file ${file}`);
    process.exit(2);
  }
  return { result: JSON.parse(readFileSync(file, "utf8")) as ResultFile, entry: scenarioRuns.filter((h) => h.label === label).at(-1) };
});

// The scenarios the reported run used, so checks and the set fingerprint match it.
const { scenarios: defs } = selectScenarios(ROOT, measured[0]?.result.summary.scenarioDir);
const registry = await loadRegistry();
const implemented = registry.list();
const md = renderReport({
  measured,
  defs,
  setNow: fingerprint(JSON.stringify(defs)),
  targets: JSON.parse(readFileSync(`${EVAL}targets.json`, "utf8")) as Targets,
  coverage: {
    implemented: implemented.length,
    modules: new Set(implemented.map((a) => a.moduleId)).size,
    catalogActions: CATALOG.reduce((n, m) => n + m.actions.length, 0),
    catalogModules: CATALOG.length,
  },
  retrieval: history.filter((h) => h.suite === "retrieval" && h.config.split === "test" && !h.config.ablation && !h.reverted).at(-1),
  built: new Date().toISOString().slice(0, 10),
});
const out = opt("out") ?? `${ROOT}BENCHMARK.md`;
writeFileSync(out, md);
console.log(`wrote ${out} from ${labels.join(", ")}`);
