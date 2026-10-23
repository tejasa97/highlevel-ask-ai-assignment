import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { fingerprint } from "./history.js";
import { selectScenarios } from "./selection.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
test("default regression, development and reporting sets stay isolated and independently fingerprinted", () => {
  const old = selectScenarios(root),
    dev = selectScenarios(root, "eval/module-scenarios/m45-m47/development"),
    report = selectScenarios(root, "eval/module-scenarios/m45-m47/reporting");
  assert.equal(old.scenarios.length, 23);
  assert.equal(fingerprint(JSON.stringify(old.scenarios)), "90b43d538455");
  assert.equal(dev.scenarios.length, 45);
  assert.equal(report.scenarios.length, 12);
  assert.ok(!old.scenarios.some((s) => s.id.startsWith("report-")));
  assert.ok(!dev.scenarios.some((s) => s.id.startsWith("report-")));
  assert.deepEqual(
    selectScenarios(root, root + "eval/module-scenarios/m45-m47/reporting"),
    report,
  );
  const covered = new Set(
    dev.scenarios.flatMap((s) => s.expect.actions?.includes ?? []),
  );
  for (const m of [45, 46, 47])
    for (let i = 1; i <= 10; i++)
      assert.ok(covered.has(`M${m}.A${String(i).padStart(2, "0")}`));
  assert.equal(
    new Set(
      [old, dev, report].map((s) => fingerprint(JSON.stringify(s.scenarios))),
    ).size,
    3,
  );
});
test("comma-separated folders load as one set and a repeated folder is a duplicate id", () => {
  const both = selectScenarios(root, "eval/module-scenarios/m45-m47/development, eval/module-scenarios/m45-m47/reporting");
  assert.equal(both.scenarios.length, 57);
  assert.equal(both.scenarioDir, "eval/module-scenarios/m45-m47/development,eval/module-scenarios/m45-m47/reporting");
  assert.throws(() => selectScenarios(root, "eval/scenarios,eval/scenarios"), /Duplicate scenario id/);
  assert.throws(() => selectScenarios(root, "eval/scenarios,"));
});
test("missing, empty and malformed directory selections fail without falling back to the regression set", () => {
  assert.throws(() => selectScenarios(root, "missing-folder"));
  assert.throws(() => selectScenarios(root, "docs"), /No scenarios/);
  assert.throws(() => selectScenarios(root, "--repeat"), /needs a directory/);
  assert.throws(() => selectScenarios(root, ""), /needs a directory/);
});
