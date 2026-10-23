import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";
import "./fixtures.js";

test("M43.A01 duplicate name is DUPLICATE", async () => {
  const w = await testWorld();
  w.call("M43.A01", { name: "Builders" });
  assert.equal(failure(() => w.call("M43.A01", { name: "builders" })).code, "DUPLICATE");
});

test("M43.A03 same guidelines is CONFLICT", async () => {
  const w = await testWorld();
  const c = w.f.community({ guidelines: "Be nice" });
  assert.equal(failure(() => w.call("M43.A03", { communityId: c.id, guidelines: "Be nice" })).code, "CONFLICT");
});

test("M43.A04 duplicate channel is DUPLICATE", async () => {
  const w = await testWorld();
  const c = w.f.community();
  assert.equal(failure(() => w.call("M43.A04", { communityId: c.id, name: "general" })).code, "DUPLICATE");
});

test("M43.A05 joining twice is CONFLICT", async () => {
  const w = await testWorld();
  const c = w.f.community();
  const contact = w.f.contact();
  w.call("M43.A05", { communityId: c.id, contactId: contact.id });
  assert.equal(failure(() => w.call("M43.A05", { communityId: c.id, contactId: contact.id })).code, "CONFLICT");
});

test("M43.A06 leaving when not a member is CONFLICT", async () => {
  const w = await testWorld();
  const c = w.f.community();
  const contact = w.f.contact();
  assert.equal(failure(() => w.call("M43.A06", { communityId: c.id, contactId: contact.id })).code, "CONFLICT");
});

test("M43.A07 non-member post is CONFLICT", async () => {
  const w = await testWorld();
  const c = w.f.community();
  const contact = w.f.contact();
  assert.equal(failure(() => w.call("M43.A07", { communityId: c.id, channelId: c.channels[0]!.id, body: "Hi", contactId: contact.id })).code, "CONFLICT");
});

test("M43.A08 reply to a reply is CONFLICT", async () => {
  const w = await testWorld();
  const parent = w.f.communityPost();
  const reply = w.f.communityPost({ communityId: parent.communityId, channelId: parent.channelId, parentId: parent.id });
  assert.equal(failure(() => w.call("M43.A08", { postId: reply.id, body: "Nested" })).code, "CONFLICT");
});

test("M43.A09 pinning a reply is CONFLICT", async () => {
  const w = await testWorld();
  const parent = w.f.communityPost();
  const reply = w.f.communityPost({ communityId: parent.communityId, channelId: parent.channelId, parentId: parent.id });
  assert.equal(failure(() => w.call("M43.A09", { postId: reply.id })).code, "CONFLICT");
});

test("M43.A10 a post with no reports is CONFLICT", async () => {
  const w = await testWorld();
  const post = w.f.communityPost();
  assert.equal(failure(() => w.call("M43.A10", { postId: post.id })).code, "CONFLICT");
});

test("M43.A10 removing a pinned post unpins it", async () => {
  const w = await testWorld();
  const post = w.f.communityPost({ reports: [{ by: "us_1", reason: "spam", at: w.f.now() }] });
  assert.equal(w.call("M43.A09", { postId: post.id }).pinned, true);
  const removed = w.call("M43.A10", { postId: post.id });
  assert.deepEqual([removed.status, removed.pinned], ["removed", false]);
});

test("unknown field is INVALID", async () => {
  const w = await testWorld();
  assert.equal(failure(() => w.call("M43.A02", { communityId: w.f.community().id, madeUp: 1 })).code, "INVALID");
});

test("leaving keeps the row, and rejoining clears leftAt", async () => {
  const w = await testWorld();
  const c = w.f.community();
  const contact = w.f.contact();
  const joined = w.call("M43.A05", { communityId: c.id, contactId: contact.id });
  const left = w.call("M43.A06", { communityId: c.id, contactId: contact.id });
  assert.equal(left.id, joined.id);
  assert.ok(left.leftAt);
  const again = w.call("M43.A05", { communityId: c.id, contactId: contact.id });
  assert.equal(again.id, joined.id);
  assert.equal(again.leftAt, null);
});
