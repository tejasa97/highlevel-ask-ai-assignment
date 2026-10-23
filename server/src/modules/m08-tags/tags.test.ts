import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";

async function hotTagOnContact() {
  const w = await testWorld();
  const t = w.f.tag({ name: "hot" });
  const c = w.f.contact();
  return { w, t, c };
}

async function vipVariants() {
  const w = await testWorld();
  const src = w.f.tag({ name: "V.I.P." });
  const both = w.f.contact({ tags: ["V.I.P.", "vip"] });
  const one = w.f.contact({ tags: ["V.I.P."] });
  return { w, src, both, one };
}

test("M08.A01 create defaults the color to gray", async () => {
  const w = await testWorld();
  assert.equal(w.call("M08.A01", { name: "Hot prospect" }).color, "gray");
});

test("M08.A01 create refuses a name that is taken, ignoring case", async () => {
  const w = await testWorld();
  assert.equal(failure(() => w.call("M08.A01", { name: "VIP" })).code, "DUPLICATE");
});

test("M08.A06 apply adds the tag to the record", async () => {
  const { w, t, c } = await hotTagOnContact();
  assert.deepEqual(w.call("M08.A06", { tagId: t.id, recordType: "contact", recordId: c.id }).tags, ["hot"]);
});

test("M08.A06 apply refuses a tag the record already has", async () => {
  const { w, t, c } = await hotTagOnContact();
  w.call("M08.A06", { tagId: t.id, recordType: "contact", recordId: c.id });
  assert.equal(failure(() => w.call("M08.A06", { tagId: t.id, recordType: "contact", recordId: c.id })).code, "CONFLICT");
});

test("M08.A07 remove takes the tag off the record", async () => {
  const { w, t, c } = await hotTagOnContact();
  w.call("M08.A06", { tagId: t.id, recordType: "contact", recordId: c.id });
  assert.deepEqual(w.call("M08.A07", { tagId: t.id, recordType: "contact", recordId: c.id }).tags, []);
});

test("M08.A07 remove refuses a tag the record doesn't have", async () => {
  const { w, t, c } = await hotTagOnContact();
  w.call("M08.A06", { tagId: t.id, recordType: "contact", recordId: c.id });
  w.call("M08.A07", { tagId: t.id, recordType: "contact", recordId: c.id });
  assert.equal(failure(() => w.call("M08.A07", { tagId: t.id, recordType: "contact", recordId: c.id })).code, "CONFLICT");
});

test("M08.A06 apply refuses an archived contact", async () => {
  const { w, t } = await hotTagOnContact();
  const gone = w.f.contact({ status: "archived" });
  assert.match(failure(() => w.call("M08.A06", { tagId: t.id, recordType: "contact", recordId: gone.id })).message, /archived/);
});

test("M08.A03 rename rewrites every tagged record", async () => {
  const w = await testWorld();
  const t = w.f.tag({ name: "hot" });
  const a = w.f.contact({ tags: ["hot", "vip"] });
  const b = w.f.contact({ tags: ["HOT"] });
  assert.equal(w.call("M08.A03", { tagId: t.id, name: "Hot lead" }).recordsUpdated, 2);
  assert.deepEqual(w.call("M01.A02", { contactId: a.id }).tags, ["vip", "Hot lead"]);
  assert.deepEqual(w.call("M01.A02", { contactId: b.id }).tags, ["Hot lead"]);
});

test("M08.A03/A09 rename and merge keep a campaign's audience tag in step until it launches", async () => {
  const w = await testWorld();
  const t = w.f.tag({ name: "hot" });
  const c = w.f.contact({ tags: ["hot"] });
  const draft = w.f.campaign({ audience: { tag: "HOT", contactIds: [] } });
  const live = w.f.campaign({ name: "Live", status: "active", launchedAt: w.f.at(-1), audience: { tag: "hot", contactIds: [] } });
  assert.equal(w.call("M15.A02", { campaignId: draft.id }).audienceSize, 1);
  w.call("M08.A03", { tagId: t.id, name: "Hot lead" });
  assert.equal(w.call("M15.A02", { campaignId: draft.id }).audience.tag, "Hot lead");
  assert.equal(w.call("M15.A02", { campaignId: draft.id }).audienceSize, 1);
  assert.equal(w.call("M15.A02", { campaignId: live.id }).audience.tag, "hot");
  w.call("M08.A09", { sourceTagId: t.id, targetTagId: "tg_1" });
  assert.equal(w.call("M15.A02", { campaignId: draft.id }).audience.tag, "vip");
  assert.deepEqual(w.call("M01.A02", { contactId: c.id }).tags, ["vip"]);
});

test("a name of only spaces is refused where tags, teams, deals, campaigns, products and prices are named", async () => {
  const w = await testWorld();
  const c = w.f.contact();
  const t = w.f.tag();
  const team = w.f.team();
  for (const [id, args] of [
    ["M08.A01", { name: "   " }],
    ["M08.A03", { tagId: t.id, name: "  " }],
    ["M49.A01", { name: " " }],
    ["M49.A04", { teamId: team.id, name: " " }],
    ["M04.A01", { name: "  ", contactId: c.id }],
    ["M15.A01", { name: " ", channel: "email" }],
    ["M25.A01", { name: "   " }],
    ["M26.A01", { productId: w.f.product().id, label: " ", amount: 5 }],
  ] as const) assert.equal(failure(() => w.call(id, args)).code, "INVALID", id);
});

test("M08.A03 rename refuses the same name", async () => {
  const w = await testWorld();
  const t = w.f.tag({ name: "hot" });
  w.call("M08.A03", { tagId: t.id, name: "Hot lead" });
  assert.equal(failure(() => w.call("M08.A03", { tagId: t.id, name: "Hot lead" })).code, "CONFLICT");
});

test("M08.A03 rename refuses a name that is taken", async () => {
  const w = await testWorld();
  const t = w.f.tag({ name: "hot" });
  assert.equal(failure(() => w.call("M08.A03", { tagId: t.id, name: "newsletter" })).code, "DUPLICATE");
});

test("M08.A05 delete refuses a tag that is still in use", async () => {
  const { w, src } = await vipVariants();
  assert.equal(failure(() => w.call("M08.A05", { tagId: src.id })).code, "CONFLICT");
});

test("M08.A05 delete removes an unused tag", async () => {
  const w = await testWorld();
  const unused = w.f.tag();
  w.call("M08.A05", { tagId: unused.id });
  assert.equal(failure(() => w.call("M08.A05", { tagId: unused.id })).code, "NOT_FOUND");
});

test("M08.A09 merge refuses a tag into itself", async () => {
  const { w, src } = await vipVariants();
  assert.equal(failure(() => w.call("M08.A09", { sourceTagId: src.id, targetTagId: src.id })).code, "INVALID");
});

test("M08.A09 merge moves records without doubling up", async () => {
  const { w, src, both, one } = await vipVariants();
  const m = w.call("M08.A09", { sourceTagId: src.id, targetTagId: "tg_1" });
  assert.deepEqual([m.name, m.recordsUpdated, m.deleted.id], ["vip", 2, src.id]);
  assert.deepEqual(w.call("M01.A02", { contactId: both.id }).tags, ["vip"]);
  assert.deepEqual(w.call("M01.A02", { contactId: one.id }).tags, ["vip"]);
});

test("M08.A09 merge removes the source tag", async () => {
  const { w, src } = await vipVariants();
  w.call("M08.A09", { sourceTagId: src.id, targetTagId: "tg_1" });
  assert.equal(failure(() => w.call("M08.A04", { tagId: src.id, color: "red" })).code, "NOT_FOUND");
});

test("M08.A04 color refuses a no-op", async () => {
  const w = await testWorld();
  assert.equal(failure(() => w.call("M08.A04", { tagId: "tg_1", color: "yellow" })).code, "CONFLICT");
});

test("M08.A10 usage counts come most used first", async () => {
  const w = await testWorld();
  const counts = w.call("M08.A10", {}).items as { name: string; total: number }[];
  assert.deepEqual(counts.map((c) => c.total), [...counts.map((c) => c.total)].sort((a, b) => b - a));
  assert.equal(counts.find((c) => c.name === "newsletter")!.total, 12);
});

test("M08.A08 the seeded partner tag is on one record", async () => {
  const w = await testWorld();
  assert.equal((w.call("M08.A08", { tagId: "tg_4" }).items as unknown[]).length, 1, "one partner");
});
