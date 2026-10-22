import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";

test("strict input rejects an unknown field", async () => {
  const w = await testWorld();
  assert.equal(failure(() => w.call("M02.A01", { name: "Acme", madeUpParam: 1 })).code, "INVALID");
});

test("M02.A01 duplicate domain is DUPLICATE; name may repeat", async () => {
  const w = await testWorld();
  const first = w.call("M02.A01", { name: "Acme", domain: "https://Acme.example/about" });
  assert.equal(first.domain, "acme.example");
  assert.equal(failure(() => w.call("M02.A01", { name: "Other", domain: "acme.example" })).code, "DUPLICATE");
  assert.equal(w.call("M02.A01", { name: "Acme" }).name, "Acme");
  assert.equal(failure(() => w.call("M02.A02", { companyId: "co_99999" })).code, "NOT_FOUND");
});

test("M02.A04 rename keeps linked contacts in step; a no-op is CONFLICT", async () => {
  const w = await testWorld();
  const co = w.f.company({ name: "Old Co", domain: "old.example" });
  const c = w.f.contact({ companyId: co.id, company: "Old Co" });
  assert.equal(w.call("M02.A04", { companyId: co.id, name: "New Co" }).name, "New Co");
  assert.equal(w.store.get<{ company: string }>("contacts", c.id)!.company, "New Co");
  assert.equal(failure(() => w.call("M02.A04", { companyId: co.id, name: "New Co" })).code, "CONFLICT");
  w.call("M02.A05", { companyId: co.id });
  assert.equal(failure(() => w.call("M02.A04", { companyId: co.id, industry: "Software" })).code, "CONFLICT");
});

test("M02.A06 link sets companyId and name; M02.A07 unlink clears the id and keeps the name", async () => {
  const w = await testWorld();
  const co = w.f.company({ name: "Acme" });
  const other = w.f.company({ name: "Other" });
  const c = w.f.contact();
  const linked = w.call("M02.A06", { companyId: co.id, contactId: c.id });
  assert.deepEqual([linked.contact.companyId, linked.contact.company], [co.id, "Acme"]);
  assert.equal(failure(() => w.call("M02.A06", { companyId: co.id, contactId: c.id })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M02.A06", { companyId: other.id, contactId: c.id })).code, "CONFLICT");
  const unlinked = w.call("M02.A07", { companyId: co.id, contactId: c.id });
  assert.equal(unlinked.contact.companyId, null);
  assert.equal(unlinked.contact.company, "Acme");
  assert.equal(failure(() => w.call("M02.A07", { companyId: co.id, contactId: c.id })).code, "CONFLICT");
});

test("M02.A08 assigning the same manager is CONFLICT", async () => {
  const w = await testWorld();
  const co = w.f.company();
  const u = w.f.user();
  w.call("M02.A08", { companyId: co.id, accountManagerId: u.id });
  assert.equal(failure(() => w.call("M02.A08", { companyId: co.id, accountManagerId: u.id })).code, "CONFLICT");
  const gone = w.f.user({ status: "deactivated" });
  assert.equal(failure(() => w.call("M02.A08", { companyId: co.id, accountManagerId: gone.id })).code, "CONFLICT");
});

test("M02.A09 merge moves the duplicate's contacts and marks it merged", async () => {
  const w = await testWorld();
  const keep = w.f.company({ name: "Keep" });
  const dup = w.f.company({ name: "Dup" });
  const c = w.f.contact({ companyId: dup.id, company: "Dup" });
  const stay = w.f.contact({ companyId: keep.id, company: "Keep" });
  assert.equal(failure(() => w.call("M02.A09", { companyId: keep.id, duplicateId: keep.id })).code, "CONFLICT");
  const merged = w.call("M02.A09", { companyId: keep.id, duplicateId: dup.id });
  assert.equal(merged.contactsMoved, 1);
  assert.equal(merged.merged.status, "merged");
  assert.equal(merged.merged.mergedInto, keep.id);
  const moved = w.store.get<{ companyId: string; company: string }>("contacts", c.id)!;
  assert.deepEqual([moved.companyId, moved.company], [keep.id, "Keep"]);
  assert.equal(w.store.get<{ companyId: string }>("contacts", stay.id)!.companyId, keep.id);
  assert.equal(failure(() => w.call("M02.A09", { companyId: keep.id, duplicateId: dup.id })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M02.A05", { companyId: dup.id })).code, "CONFLICT");
});

test("M02.A05 archive twice is CONFLICT; M02.A10 lists only that company's contacts", async () => {
  const w = await testWorld();
  const co = w.f.company({ name: "Listed" });
  const a = w.f.contact({ name: "Zed Person", companyId: co.id, company: "Listed" });
  const b = w.f.contact({ name: "Amy Person", companyId: co.id, company: "Listed" });
  w.f.contact();
  const listed = w.call("M02.A10", { companyId: co.id });
  assert.deepEqual(listed.items.map((c: { id: string }) => c.id), [b.id, a.id]);
  assert.equal(listed.total, 2);
  w.call("M02.A05", { companyId: co.id });
  assert.equal(failure(() => w.call("M02.A05", { companyId: co.id })).code, "CONFLICT");
});

test("M02.A03 search totals before the limit and sorts by name", async () => {
  const w = await testWorld();
  w.f.company({ name: "Zeta", domain: "zeta.example" });
  w.f.company({ name: "Alpha", domain: "alpha.example" });
  const page = w.call("M02.A03", { query: ".example", limit: 1 });
  assert.equal(page.total, 2);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].name, "Alpha");
});
