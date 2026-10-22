import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { world } from "./world.js";
import { MODULE_SEED_URL } from "./module-seed.js";

test("seed and scenario bytes still match the pre-handler freeze", () => {
  const dir = new URL(
    "../../../eval/module-scenarios/m45-m47/",
    import.meta.url,
  );
  const frozen = JSON.parse(readFileSync(new URL("freeze.json", dir), "utf8"));
  for (const [file, expected] of Object.entries(frozen.files)) {
    assert.equal(
      createHash("sha256")
        .update(readFileSync(new URL(file, dir)))
        .digest("hex"),
      expected,
      file,
    );
  }
});

test("frozen module manifest loads exactly, while every legacy row and id remains unchanged", () => {
  const w = world();
  const baseline = JSON.parse(
    readFileSync(
      new URL(
        "../../../eval/module-scenarios/m45-m47/legacy-seed-baseline.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  for (const b of baseline.legacyTables) {
    const old = w.store.all(b.table).slice(0, b.count);
    assert.equal(
      createHash("sha256").update(JSON.stringify(old)).digest("hex"),
      b.sha,
      b.table,
    );
  }
  const m = JSON.parse(readFileSync(MODULE_SEED_URL, "utf8"));
  for (const { table, record } of m.records)
    assert.deepEqual(w.store.get(table, record.id), record);
  assert.equal(w.f.contact().id, "ct_39");
  assert.equal(w.f.ticket().id, "tic_5");
  w.store.close();
});
