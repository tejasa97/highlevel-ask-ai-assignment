import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";

test("create: names are unique ignoring case; default color gray", async () => {
  const w = await testWorld();
  assert.equal(w.call("M08.A01", { name: "Hot prospect" }).color, "gray");
  assert.equal(failure(() => w.call("M08.A01", { name: "VIP" })).code, "DUPLICATE");
});

test("apply and remove: no doubles; merged or archived records can't change", async () => {
  const w = await testWorld();
  const t = w.f.tag({ name: "hot" });
  const c = w.f.contact();
  assert.deepEqual(w.call("M08.A06", { tagId: t.id, recordType: "contact", recordId: c.id }).tags, ["hot"]);
  assert.equal(failure(() => w.call("M08.A06", { tagId: t.id, recordType: "contact", recordId: c.id })).code, "CONFLICT");
  assert.deepEqual(w.call("M08.A07", { tagId: t.id, recordType: "contact", recordId: c.id }).tags, []);
  assert.equal(failure(() => w.call("M08.A07", { tagId: t.id, recordType: "contact", recordId: c.id })).code, "CONFLICT");
  const gone = w.f.contact({ status: "archived" });
  assert.match(failure(() => w.call("M08.A06", { tagId: t.id, recordType: "contact", recordId: gone.id })).message, /archived/);
});

test("rename rewrites every tagged record; same name CONFLICT; taken name DUPLICATE", async () => {
  const w = await testWorld();
  const t = w.f.tag({ name: "hot" });
  const a = w.f.contact({ tags: ["hot", "vip"] });
  const b = w.f.contact({ tags: ["HOT"] });
  assert.equal(w.call("M08.A03", { tagId: t.id, name: "Hot lead" }).recordsUpdated, 2);
  assert.deepEqual(w.call("M01.A02", { contactId: a.id }).tags, ["vip", "Hot lead"]);
  assert.deepEqual(w.call("M01.A02", { contactId: b.id }).tags, ["Hot lead"]);
  assert.equal(failure(() => w.call("M08.A03", { tagId: t.id, name: "Hot lead" })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M08.A03", { tagId: t.id, name: "newsletter" })).code, "DUPLICATE");
});

test("delete only when unused; merge moves records without doubling up", async () => {
  const w = await testWorld();
  const src = w.f.tag({ name: "V.I.P." });
  const both = w.f.contact({ tags: ["V.I.P.", "vip"] });
  const one = w.f.contact({ tags: ["V.I.P."] });
  assert.equal(failure(() => w.call("M08.A05", { tagId: src.id })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M08.A09", { sourceTagId: src.id, targetTagId: src.id })).code, "INVALID");
  const m = w.call("M08.A09", { sourceTagId: src.id, targetTagId: "tg_1" });
  assert.deepEqual([m.name, m.recordsUpdated, m.deleted.id], ["vip", 2, src.id]);
  assert.deepEqual(w.call("M01.A02", { contactId: both.id }).tags, ["vip"]);
  assert.deepEqual(w.call("M01.A02", { contactId: one.id }).tags, ["vip"]);
  assert.equal(failure(() => w.call("M08.A04", { tagId: src.id, color: "red" })).code, "NOT_FOUND");
  const unused = w.f.tag();
  w.call("M08.A05", { tagId: unused.id });
});

test("color must change; usage counts, most used first; seeded newsletter list", async () => {
  const w = await testWorld();
  assert.equal(failure(() => w.call("M08.A04", { tagId: "tg_1", color: "yellow" })).code, "CONFLICT");
  const counts = w.call("M08.A10", {}).items as { name: string; total: number }[];
  assert.deepEqual(counts.map((c) => c.total), [...counts.map((c) => c.total)].sort((a, b) => b - a));
  assert.equal(counts.find((c) => c.name === "newsletter")!.total, 12);
  assert.equal((w.call("M08.A08", { tagId: "tg_4" }).items as unknown[]).length, 1, "one partner");
});
