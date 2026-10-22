import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";

test("strict input rejects an unknown field", async () => {
  const w = await testWorld();
  assert.equal(failure(() => w.call("M14.A01", { name: "Intro", channel: "email", subject: "Hi", body: "Hello", madeUpParam: 1 })).code, "INVALID");
});

test("M14.A01 duplicate name is DUPLICATE and an SMS subject is INVALID", async () => {
  const w = await testWorld();
  w.call("M14.A01", { name: "Intro", channel: "email", subject: "Hi", body: "Hello" });
  assert.equal(failure(() => w.call("M14.A01", { name: "intro", channel: "email", subject: "Hi", body: "Hello" })).code, "DUPLICATE");
  assert.equal(failure(() => w.call("M14.A01", { name: "Ping", channel: "sms", subject: "Hi", body: "Hello" })).code, "INVALID");
  assert.equal(w.call("M14.A01", { name: "Ping", channel: "sms", body: "Hello" }).subject, null);
});

test("M14.A04 keeps the previous text and a no-op is CONFLICT", async () => {
  const w = await testWorld();
  const t = w.f.messageTemplate({ body: "First" });
  assert.equal(failure(() => w.call("M14.A04", { templateId: t.id, body: "First" })).code, "CONFLICT");
  const next = w.call("M14.A04", { templateId: t.id, body: "Second" });
  assert.equal(next.version, 2);
  assert.equal(next.versions[0].body, "First");
  assert.equal(w.call("M14.A10", { templateId: t.id, version: 1 }).body, "First");
  assert.equal(failure(() => w.call("M14.A10", { templateId: t.id, version: 9 })).code, "CONFLICT");
});

test("M14.A05 archiving twice is CONFLICT", async () => {
  const w = await testWorld();
  const t = w.f.messageTemplate();
  w.call("M14.A05", { templateId: t.id });
  assert.equal(failure(() => w.call("M14.A05", { templateId: t.id })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M14.A04", { templateId: t.id, body: "Changed" })).code, "CONFLICT");
});

test("M14.A06 a name that already exists is DUPLICATE", async () => {
  const w = await testWorld();
  const t = w.f.messageTemplate({ name: "Welcome" });
  w.call("M14.A06", { templateId: t.id, name: "Welcome two" });
  assert.equal(failure(() => w.call("M14.A06", { templateId: t.id, name: "Welcome two" })).code, "DUPLICATE");
});

test("M14.A07 the same variables are CONFLICT and a repeated name is DUPLICATE", async () => {
  const w = await testWorld();
  const t = w.f.messageTemplate();
  assert.equal(failure(() => w.call("M14.A07", { templateId: t.id, variables: [{ name: "firstName", required: true, sample: "Ada" }] })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M14.A07", { templateId: t.id, variables: [{ name: "a", required: false }, { name: "a", required: true }] })).code, "DUPLICATE");
});

test("M14.A08 unknown placeholders are INVALID and M14.A09 fills sample data", async () => {
  const w = await testWorld();
  const t = w.f.messageTemplate({ body: "Hi {{firstName}} from {{company}}" });
  assert.equal(failure(() => w.call("M14.A08", { templateId: t.id })).code, "INVALID");
  const ok = w.f.messageTemplate();
  assert.equal(w.call("M14.A08", { templateId: ok.id }).valid, true);
  assert.equal(w.call("M14.A09", { templateId: ok.id, data: { firstName: "Ada" } }).body, "Hi Ada");
  const bare = w.f.messageTemplate({ variables: [{ name: "firstName", required: true, sample: null }] });
  assert.equal(failure(() => w.call("M14.A09", { templateId: bare.id, data: {} })).code, "INVALID");
});

test("M14.A03 search skips archived templates unless asked", async () => {
  const w = await testWorld();
  const t = w.f.messageTemplate({ name: "Hidden note", body: "secret words" });
  w.call("M14.A05", { templateId: t.id });
  assert.equal(w.call("M14.A03", { query: "secret words" }).total, 0);
  assert.equal(w.call("M14.A03", { query: "secret words", status: "archived" }).total, 1);
});
