import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";

const QUALIFIED = { budget: "$10k", authority: "CEO", need: "CRM", timeline: "Q1" };

test("create: an email already on an open lead or active contact is DUPLICATE and names it", async () => {
  const w = await testWorld();
  const c = w.f.contact({ email: "taken@acme.example" });
  const e = failure(() => w.call("M03.A01", { firstName: "T", email: "TAKEN@acme.example" }));
  assert.equal(e.code, "DUPLICATE");
  assert.match(e.message, new RegExp(c.id));
  const l = w.f.lead();
  assert.equal(failure(() => w.call("M03.A01", { firstName: "T", email: l.email })).code, "DUPLICATE");
  const dead = w.f.lead({ status: "disqualified" });
  assert.equal(w.call("M03.A01", { firstName: "T", email: dead.email }).source, "manual", "a closed lead's email is free");
});

test("closed leads (disqualified, converted) can't be edited", async () => {
  const w = await testWorld();
  const l = w.f.lead({ status: "disqualified" });
  for (const [id, args] of [
    ["M03.A04", { leadId: l.id, company: "X" }],
    ["M03.A05", { leadId: l.id, ownerId: "us_2" }],
    ["M03.A08", { leadId: l.id, delta: 5 }],
    ["M03.A09", { leadId: l.id, reason: "spam" }],
  ] as const) {
    assert.equal(failure(() => w.call(id, args)).code, "CONFLICT", id);
  }
});

test("update: status contacted only from new", async () => {
  const w = await testWorld();
  const l = w.f.lead();
  assert.equal(w.call("M03.A04", { leadId: l.id, status: "contacted" }).status, "contacted");
  assert.equal(failure(() => w.call("M03.A04", { leadId: l.id, status: "contacted" })).code, "CONFLICT");
});

test("qualification: answers merge; marking qualified lists what's missing", async () => {
  const w = await testWorld();
  const l = w.f.lead();
  w.call("M03.A07", { leadId: l.id, budget: "$10k", need: "CRM" });
  const e = failure(() => w.call("M03.A07", { leadId: l.id, authority: "CEO", markQualified: true }));
  assert.equal(e.code, "INVALID");
  assert.deepEqual(e.details, { missing: ["timeline"] });
  assert.equal(w.store.get<{ qualification: { authority: string | null } }>("leads", l.id)!.qualification.authority, null, "a failed call changes nothing");
  const q = w.call("M03.A07", { leadId: l.id, authority: "CEO", timeline: "Q1", markQualified: true });
  assert.deepEqual([q.status, q.qualification], ["qualified", QUALIFIED]);
  assert.equal(failure(() => w.call("M03.A07", { leadId: l.id })).code, "INVALID");
});

test("score: exactly one of score or delta, clamped to 0–100", async () => {
  const w = await testWorld();
  const l = w.f.lead({ score: 95 });
  assert.equal(w.call("M03.A08", { leadId: l.id, delta: 20 }).score, 100);
  assert.equal(w.call("M03.A08", { leadId: l.id, delta: -100 }).score, 0);
  assert.equal(w.call("M03.A08", { leadId: l.id, score: 40 }).score, 40);
  assert.equal(failure(() => w.call("M03.A08", { leadId: l.id, score: 40, delta: 1 })).code, "INVALID");
  assert.equal(failure(() => w.call("M03.A08", { leadId: l.id })).code, "INVALID");
  assert.equal(failure(() => w.call("M03.A08", { leadId: l.id, score: 101 })).code, "INVALID");
});

test("disqualify: reason other needs a note", async () => {
  const w = await testWorld();
  const l = w.f.lead();
  assert.equal(failure(() => w.call("M03.A09", { leadId: l.id, reason: "other" })).code, "INVALID");
  const d = w.call("M03.A09", { leadId: l.id, reason: "other", note: "Went with a spreadsheet" });
  assert.deepEqual([d.status, d.disqualifyReason, d.disqualifyNote], ["disqualified", "other", "Went with a spreadsheet"]);
});

test("source: unknown campaign is NOT_FOUND", async () => {
  const w = await testWorld();
  assert.equal(failure(() => w.call("M03.A06", { leadId: "ld_1", source: "event", campaignId: "cp_404" })).code, "NOT_FOUND");
});

test("convert: needs qualified, an active owner; links the contact with the same email", async () => {
  const w = await testWorld();
  assert.equal(failure(() => w.call("M03.A10", { leadId: w.f.lead({ ownerId: "us_2" }).id })).code, "CONFLICT");
  assert.match(failure(() => w.call("M03.A10", { leadId: w.f.lead({ status: "qualified" }).id })).message, /M03\.A05/);
  assert.equal(failure(() => w.call("M03.A10", { leadId: w.f.lead({ status: "qualified", ownerId: "us_9" }).id })).code, "CONFLICT");

  const c = w.f.contact({ email: "buyer@acme.example" });
  const l = w.f.lead({ status: "qualified", ownerId: "us_2", email: "Buyer@Acme.example", company: "Acme" });
  const r = w.call("M03.A10", { leadId: l.id, value: 1200 });
  assert.deepEqual([r.contactId, r.contactCreated, r.lead.status], [c.id, false, "converted"]);
  assert.deepEqual([r.opportunity.name, r.opportunity.value, r.opportunity.contactId, r.opportunity.ownerId], ["Acme deal", 1200, c.id, "us_2"]);
  const again = failure(() => w.call("M03.A10", { leadId: l.id }));
  assert.equal(again.code, "CONFLICT");
  assert.match(again.message, new RegExp(r.opportunity.id));
});

test("convert: creates a contact when no email matches", async () => {
  const w = await testWorld();
  const l = w.f.lead({ status: "qualified", ownerId: "us_4" });
  const before = w.store.all("contacts").length;
  const r = w.call("M03.A10", { leadId: l.id });
  assert.equal(r.contactCreated, true);
  assert.equal(w.store.all("contacts").length, before + 1);
  assert.equal(w.store.get<{ ownerId: string; email: string }>("contacts", r.contactId)!.email, l.email);
});

test("search: score range and unassigned", async () => {
  const w = await testWorld();
  const items = w.call("M03.A03", { minScore: 80, maxScore: 90, unassigned: true, limit: 500 }).items as { score: number; ownerId: string | null }[];
  assert.ok(items.every((l) => l.score >= 80 && l.score <= 90 && l.ownerId === null));
});
