import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";

test("create: on an existing record only; the actor is the author", async () => {
  const w = await testWorld();
  const c = w.f.contact();
  const n = w.call("M07.A01", { body: "Called; wants a demo", attachTo: { type: "contact", id: c.id } }, "us_4");
  assert.deepEqual([n.authorId, n.attachedTo, n.pinned], ["us_4", [{ type: "contact", id: c.id }], false]);
  assert.equal(failure(() => w.call("M07.A01", { body: "x", attachTo: { type: "invoice", id: "inv_999" } })).code, "NOT_FOUND");
});

test("edit keeps the earlier text in its history; the same text CONFLICT", async () => {
  const w = await testWorld();
  const n = w.f.note({ body: "First" });
  w.call("M07.A04", { noteId: n.id, body: "Second" });
  assert.equal(failure(() => w.call("M07.A04", { noteId: n.id, body: "Second" })).code, "CONFLICT");
  const h = w.call("M07.A10", { noteId: n.id }).items as { version: number; body: string; current: boolean }[];
  assert.deepEqual(h.map((x) => [x.version, x.body, x.current]), [[1, "First", false], [2, "Second", true]]);
});

test("attach and detach: no doubles; detaching from a record it isn't on CONFLICT", async () => {
  const w = await testWorld();
  const n = w.f.note();
  const op = w.f.opportunity();
  w.call("M07.A06", { noteId: n.id, record: { type: "opportunity", id: op.id } });
  assert.equal(failure(() => w.call("M07.A06", { noteId: n.id, record: { type: "opportunity", id: op.id } })).code, "CONFLICT");
  assert.equal((w.call("M07.A03", { recordType: "opportunity", recordId: op.id }).items as unknown[]).length, 1);
  assert.equal(w.call("M07.A07", { noteId: n.id, record: { type: "opportunity", id: op.id } }).attachedTo.length, 1);
  assert.equal(failure(() => w.call("M07.A07", { noteId: n.id, record: { type: "opportunity", id: op.id } })).code, "CONFLICT");
});

test("pin and unpin must change state; pinned notes come first", async () => {
  const w = await testWorld();
  const c = w.f.contact();
  const old = w.f.note({ attachedTo: [{ type: "contact", id: c.id }], createdAt: w.f.at(-5) });
  const recent = w.f.note({ attachedTo: [{ type: "contact", id: c.id }] });
  w.call("M07.A08", { noteId: old.id });
  assert.equal(failure(() => w.call("M07.A08", { noteId: old.id })).code, "CONFLICT");
  assert.deepEqual((w.call("M07.A03", { recordId: c.id }).items as { id: string }[]).map((n) => n.id), [old.id, recent.id]);
  w.call("M07.A09", { noteId: old.id });
  assert.equal(failure(() => w.call("M07.A09", { noteId: old.id })).code, "CONFLICT");
});

test("delete removes it; seeded nt_3 has a revision and two records", async () => {
  const w = await testWorld();
  const n = w.f.note();
  w.call("M07.A05", { noteId: n.id });
  assert.equal(failure(() => w.call("M07.A02", { noteId: n.id })).code, "NOT_FOUND");
  assert.equal(w.call("M07.A10", { noteId: "nt_3" }).items.length, 2);
  assert.equal(w.call("M07.A02", { noteId: "nt_3" }).attachedTo.length, 2);
  assert.equal((w.call("M07.A03", { query: "COO" }).items as unknown[]).length, 1);
});
