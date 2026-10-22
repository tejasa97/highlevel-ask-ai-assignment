import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";

test("M07.A01 create attaches to the record and the actor is the author", async () => {
  const w = await testWorld();
  const c = w.f.contact();
  const n = w.call("M07.A01", { body: "Called; wants a demo", attachTo: { type: "contact", id: c.id } }, "us_4");
  assert.deepEqual([n.authorId, n.attachedTo, n.pinned], ["us_4", [{ type: "contact", id: c.id }], false]);
});

test("M07.A01 create refuses a record that does not exist", async () => {
  const w = await testWorld();
  assert.equal(failure(() => w.call("M07.A01", { body: "x", attachTo: { type: "invoice", id: "inv_999" } })).code, "NOT_FOUND");
});

test("M07.A04 edit keeps the earlier text in its history", async () => {
  const w = await testWorld();
  const n = w.f.note({ body: "First" });
  w.call("M07.A04", { noteId: n.id, body: "Second" });
  const h = w.call("M07.A10", { noteId: n.id }).items as { version: number; body: string; current: boolean }[];
  assert.deepEqual(h.map((x) => [x.version, x.body, x.current]), [[1, "First", false], [2, "Second", true]]);
});

test("M07.A04 edit refuses the same text", async () => {
  const w = await testWorld();
  const n = w.f.note({ body: "First" });
  w.call("M07.A04", { noteId: n.id, body: "Second" });
  assert.equal(failure(() => w.call("M07.A04", { noteId: n.id, body: "Second" })).code, "CONFLICT");
});

test("M07.A06 attach refuses a record it is already on", async () => {
  const w = await testWorld();
  const n = w.f.note();
  const op = w.f.opportunity();
  w.call("M07.A06", { noteId: n.id, record: { type: "opportunity", id: op.id } });
  assert.equal(failure(() => w.call("M07.A06", { noteId: n.id, record: { type: "opportunity", id: op.id } })).code, "CONFLICT");
});

test("M07.A03 list finds a note by the record it is attached to", async () => {
  const w = await testWorld();
  const n = w.f.note();
  const op = w.f.opportunity();
  w.call("M07.A06", { noteId: n.id, record: { type: "opportunity", id: op.id } });
  assert.equal((w.call("M07.A03", { recordType: "opportunity", recordId: op.id }).items as unknown[]).length, 1);
});

test("M07.A07 detach removes the record", async () => {
  const w = await testWorld();
  const n = w.f.note();
  const op = w.f.opportunity();
  w.call("M07.A06", { noteId: n.id, record: { type: "opportunity", id: op.id } });
  assert.equal(w.call("M07.A07", { noteId: n.id, record: { type: "opportunity", id: op.id } }).attachedTo.length, 1);
});

test("M07.A07 detach refuses a record the note isn't on", async () => {
  const w = await testWorld();
  const n = w.f.note();
  const op = w.f.opportunity();
  w.call("M07.A06", { noteId: n.id, record: { type: "opportunity", id: op.id } });
  w.call("M07.A07", { noteId: n.id, record: { type: "opportunity", id: op.id } });
  assert.equal(failure(() => w.call("M07.A07", { noteId: n.id, record: { type: "opportunity", id: op.id } })).code, "CONFLICT");
});

test("M07.A08 pin refuses a note that is already pinned", async () => {
  const w = await testWorld();
  const n = w.f.note();
  w.call("M07.A08", { noteId: n.id });
  assert.equal(failure(() => w.call("M07.A08", { noteId: n.id })).code, "CONFLICT");
});

test("M07.A03 pinned notes come first", async () => {
  const w = await testWorld();
  const c = w.f.contact();
  const old = w.f.note({ attachedTo: [{ type: "contact", id: c.id }], createdAt: w.f.at(-5) });
  const recent = w.f.note({ attachedTo: [{ type: "contact", id: c.id }] });
  w.call("M07.A08", { noteId: old.id });
  assert.deepEqual((w.call("M07.A03", { recordId: c.id }).items as { id: string }[]).map((n) => n.id), [old.id, recent.id]);
});

test("M07.A09 unpin refuses a note that is not pinned", async () => {
  const w = await testWorld();
  const n = w.f.note();
  w.call("M07.A08", { noteId: n.id });
  w.call("M07.A09", { noteId: n.id });
  assert.equal(failure(() => w.call("M07.A09", { noteId: n.id })).code, "CONFLICT");
});

test("M07.A05 delete removes the note", async () => {
  const w = await testWorld();
  const n = w.f.note();
  w.call("M07.A05", { noteId: n.id });
  assert.equal(failure(() => w.call("M07.A02", { noteId: n.id })).code, "NOT_FOUND");
});

test("M07 the seeded note nt_3 has a revision and two records", async () => {
  const w = await testWorld();
  assert.equal(w.call("M07.A10", { noteId: "nt_3" }).items.length, 2);
  assert.equal(w.call("M07.A02", { noteId: "nt_3" }).attachedTo.length, 2);
});

test("M07.A03 list searches note text", async () => {
  const w = await testWorld();
  assert.equal((w.call("M07.A03", { query: "COO" }).items as unknown[]).length, 1);
});
