import assert from "node:assert/strict";
import { test } from "node:test";
import { world } from "../../store/world.js";
import "./fixtures.js";

test("module-local fixtures extend w.f, validate against the schema, and use the registered id prefix", () => {
  const w = world({ base: false });
  const co = w.f.company({ name: "Acme" });
  assert.match(co.id, /^co_\d+$/);
  assert.equal(w.store.get<{ name: string }>("companies", co.id)!.name, "Acme");
  const c = w.f.contact({ company: "Acme", companyId: co.id });
  assert.equal(c.companyId, co.id);
  assert.throws(() => w.f.company({ size: "huge" as never }));
});
