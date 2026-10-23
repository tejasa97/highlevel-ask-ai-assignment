import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { z } from "zod";
import { call, failure, registry } from "../testkit.js";
import { world } from "../store/world.js";

// Every registered action, twice: its example must succeed, and two broken versions of it must fail
// with the right code (a made-up param → INVALID; an unknown id in a required id field → NOT_FOUND).

const reg = await registry();
const catalog = JSON.parse(readFileSync(new URL("./catalog.json", import.meta.url), "utf8")) as { modules: { id: string; actions: { id: string }[] }[] };

// A module is either absent or complete: any registered action means all of its catalog actions are registered.
test("every module that has handlers has all of its catalog actions, and no others", () => {
  for (const m of catalog.modules) {
    const have = reg.list().filter((a) => a.moduleId === m.id).map((a) => a.id).sort();
    if (have.length === 0) continue;
    assert.deepEqual(have, m.actions.map((a) => a.id).sort(), m.id);
  }
});

for (const action of reg.list()) {
  describe(`${action.id} ${action.name}`, () => {
    test("example succeeds", () => {
      const w = world();
      const args = action.example(w.f) as Record<string, unknown>;
      const before = w.store.audit().length;
      call(reg, w, action.id, args);
      assert.equal(w.store.audit().length - before, action.risk === "read" ? 0 : 1, "writes are audited, reads aren't");
    });

    test("made-up param is INVALID", () => {
      const w = world();
      const args = { ...(action.example(w.f) as Record<string, unknown>), madeUpParam: 1 };
      assert.equal(failure(() => call(reg, w, action.id, args)).code, "INVALID");
    });

    const shape = (action.input as z.ZodObject).shape;
    const idKey = Object.keys(shape).find((k) => /Id$/.test(k) && !shape[k]!.safeParse(undefined).success);
    if (idKey) {
      test(`unknown ${idKey} is NOT_FOUND`, () => {
        const w = world();
        const args = action.example(w.f) as Record<string, unknown>;
        const unknown = String(args[idKey]).replace(/_\d+$/, "_99999");
        const err = failure(() => call(reg, w, action.id, { ...args, [idKey]: unknown }));
        assert.equal(err.code, "NOT_FOUND", err.message);
      });
    }
  });
}
