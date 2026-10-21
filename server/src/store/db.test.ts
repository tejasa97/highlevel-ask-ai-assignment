import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "./db.js";

test("a table first touched in a rolled-back transaction is still usable afterwards", () => {
  const s = new Store();
  assert.throws(() =>
    s.tx(() => {
      s.all("notes");
      throw new Error("boom");
    }),
  );
  assert.deepEqual(s.all("notes"), []);
  s.insert("notes", "nt", { body: "x" });
  assert.equal(s.all("notes").length, 1);
});
