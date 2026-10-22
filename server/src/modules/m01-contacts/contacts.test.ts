import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";

test("create: same email (any case) is DUPLICATE, even if archived; inactive owner refused", async () => {
  const w = await testWorld();
  assert.equal(failure(() => w.call("M01.A01", { firstName: "S", email: "SARAH.johnson@brightside.example" })).code, "DUPLICATE");
  assert.equal(failure(() => w.call("M01.A01", { firstName: "O", email: "old@defunct.example" })).code, "DUPLICATE");
  assert.equal(failure(() => w.call("M01.A01", { firstName: "N", ownerId: "us_9" })).code, "CONFLICT");
  const c = w.call("M01.A01", { firstName: "Ana", tags: ["vip", "vip"] });
  assert.deepEqual(c.tags, ["vip"]);
  assert.equal(c.lastName, null);
});

test("update: changing the company name unlinks the company record; other edits keep the link", async () => {
  const w = await testWorld();
  const c = w.f.contact({ company: "Acme", companyId: "co_1" });
  assert.equal(w.call("M01.A04", { contactId: c.id, firstName: "Renamed" }).companyId, "co_1");
  assert.equal(w.call("M01.A04", { contactId: c.id, company: "Acme" }).companyId, "co_1");
  assert.equal(w.call("M01.A04", { contactId: c.id, company: "Globex" }).companyId, null);
});

test("archived contacts are read-only and hidden from default search", async () => {
  const w = await testWorld();
  const old = w.store.find<{ id: string; name: string }>("contacts", (c) => c.name === "Old Customer")[0]!;
  for (const [id, args] of [
    ["M01.A04", { contactId: old.id, company: "X" }],
    ["M01.A07", { contactId: old.id, ownerId: "us_2" }],
    ["M01.A08", { contactId: old.id, sms: false }],
    ["M01.A05", { contactId: old.id }],
  ] as const) {
    assert.equal(failure(() => w.call(id, args)).code, "CONFLICT", id);
  }
  assert.equal(w.call("M01.A03", { query: "Old Customer" }).total, 0);
  assert.equal(w.call("M01.A03", { query: "Old Customer", status: "archived" }).total, 1);
});

test("update: empty patch INVALID; email taken by another contact is DUPLICATE and suggests merge", async () => {
  const w = await testWorld();
  assert.equal(failure(() => w.call("M01.A04", { contactId: "ct_1" })).code, "INVALID");
  const [a, b] = w.store.find<{ id: string; name: string; email: string }>("contacts", (c) => c.name === "Sarah Johnson");
  const e = failure(() => w.call("M01.A04", { contactId: b!.id, email: a!.email }));
  assert.equal(e.code, "DUPLICATE");
  assert.match(e.message, /M01\.A06/);
});

test("merge Sarah Johnson duplicates: fills gaps, unions tags, moves records, keeps the stricter preferences", async () => {
  const w = await testWorld();
  const [keep, dup] = w.store.find<{ id: string; name: string }>("contacts", (c) => c.name === "Sarah Johnson");
  w.store.update("contacts", keep!.id, { tags: ["vip"], company: null });
  w.store.update("contacts", dup!.id, { tags: ["newsletter"], company: "Brightside LLC", companyId: "co_7", preferences: { email: false, sms: true, call: true, dnd: false } });
  const task = w.f.task({ relatedTo: { type: "contact", id: dup!.id } });
  const opp = w.f.opportunity({ contactId: dup!.id });
  const friend = w.f.contact({ relationships: [{ contactId: dup!.id, type: "colleague" }] });

  const r = w.call("M01.A06", { keepId: keep!.id, duplicateId: dup!.id });
  assert.deepEqual(r.filled, ["company"]);
  assert.equal(r.contact.companyId, "co_7", "the company link comes with the name");
  assert.deepEqual(r.contact.tags, ["vip", "newsletter"]);
  assert.equal(r.contact.preferences.email, false);
  assert.deepEqual(r.moved, { tasks: 1, opportunities: 1, leads: 0 });
  assert.equal(w.store.get<{ relatedTo: { id: string } }>("tasks", task.id)!.relatedTo.id, keep!.id);
  assert.equal(w.store.get<{ contactId: string }>("opportunities", opp.id)!.contactId, keep!.id);
  assert.equal(w.store.get<{ relationships: { contactId: string }[] }>("contacts", friend.id)!.relationships[0]!.contactId, keep!.id);

  const gone = w.store.get<{ status: string; mergedInto: string }>("contacts", dup!.id)!;
  assert.deepEqual([gone.status, gone.mergedInto], ["merged", keep!.id]);
  assert.match(failure(() => w.call("M01.A04", { contactId: dup!.id, company: "X" })).message, /merged into/);
  assert.equal(failure(() => w.call("M01.A06", { keepId: keep!.id, duplicateId: dup!.id })).code, "CONFLICT", "can't merge twice");
  assert.equal(failure(() => w.call("M01.A06", { keepId: keep!.id, duplicateId: keep!.id })).code, "INVALID");
});

test("relationships are two-way and can't be duplicated or self-referencing", async () => {
  const w = await testWorld();
  const boss = w.f.contact();
  const report = w.f.contact();
  w.call("M01.A09", { contactId: report.id, relatedId: boss.id, type: "manager" });
  assert.deepEqual(w.store.get<{ relationships: unknown[] }>("contacts", boss.id)!.relationships, [{ contactId: report.id, type: "report" }]);
  assert.equal(failure(() => w.call("M01.A09", { contactId: report.id, relatedId: boss.id, type: "manager" })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M01.A09", { contactId: boss.id, relatedId: boss.id, type: "other" })).code, "INVALID");
});

test("preferences: only given channels change; empty patch INVALID", async () => {
  const w = await testWorld();
  const c = w.call("M01.A08", { contactId: "ct_1", dnd: true });
  assert.equal(c.preferences.dnd, true);
  assert.equal(c.preferences.email, w.store.get<{ preferences: { email: boolean } }>("contacts", "ct_1")!.preferences.email);
  assert.equal(failure(() => w.call("M01.A08", { contactId: "ct_1" })).code, "INVALID");
});

test("timeline: creation, audited changes, tasks and deals, newest first", async () => {
  const w = await testWorld();
  const c = w.f.contact({ createdAt: w.f.at(-30) });
  w.f.task({ title: "Send brochure", relatedTo: { type: "contact", id: c.id }, createdAt: w.f.at(-5) });
  w.call("M01.A07", { contactId: c.id, ownerId: "us_4" });
  const items = w.call("M01.A10", { contactId: c.id }).items as { kind: string; at: string }[];
  assert.deepEqual(items.map((i) => i.kind), ["M01.A07", "task", "created"]);
  assert.equal(w.call("M01.A10", { contactId: c.id, to: w.f.day(-1) }).total, 2);
});

test("search: tag match ignores case; unowned filter", async () => {
  const w = await testWorld();
  const c = w.f.contact({ tags: ["VIP"] });
  assert.ok(w.call("M01.A03", { tag: "vip" }).items.some((x: { id: string }) => x.id === c.id));
  assert.ok(w.call("M01.A03", { unowned: true, limit: 500 }).items.every((x: { ownerId: string | null }) => x.ownerId === null));
});
