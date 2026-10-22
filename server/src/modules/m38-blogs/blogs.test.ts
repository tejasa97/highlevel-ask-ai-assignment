import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";

test("slug is unique across posts, and a deactivated author is refused", async () => {
  const w = await testWorld();
  w.call("M38.A01", { title: "Notes", slug: "Notes", body: "Hello" });
  assert.equal(failure(() => w.call("M38.A01", { title: "Other", slug: "notes", body: "Hello" })).code, "DUPLICATE");
  const gone = w.f.user({ status: "deactivated" });
  assert.equal(failure(() => w.call("M38.A01", { title: "Other", slug: "other-notes", body: "Hello", authorId: gone.id })).code, "CONFLICT");
});

test("published posts keep their text, and an unchanged draft is a no-op", async () => {
  const w = await testWorld();
  const live = w.f.blogPost({ status: "published", publishedAt: w.f.now(), title: "Live" });
  assert.equal(failure(() => w.call("M38.A04", { postId: live.id, body: "Changed" })).code, "CONFLICT");
  const asset = w.f.mediaAsset();
  assert.deepEqual(w.call("M38.A04", { postId: live.id, mediaIds: [asset.id] }).mediaIds, [asset.id]);
  const draft = w.f.blogPost({ title: "Same", body: "Body" });
  assert.equal(failure(() => w.call("M38.A04", { postId: draft.id, title: "Same" })).code, "CONFLICT");
});

test("author, categories and SEO are no-ops when unchanged and blocked while published", async () => {
  const w = await testWorld();
  const post = w.f.blogPost({ authorId: "us_1" });
  assert.equal(failure(() => w.call("M38.A05", { postId: post.id, authorId: "us_1" })).code, "CONFLICT");
  const author = w.f.user();
  assert.equal(w.call("M38.A05", { postId: post.id, authorId: author.id }).authorId, author.id);
  assert.equal(failure(() => w.call("M38.A06", { postId: post.id, categories: [] })).code, "CONFLICT");
  assert.deepEqual(w.call("M38.A06", { postId: post.id, categories: ["News", "news"] }).categories, ["News"]);
  assert.equal(failure(() => w.call("M38.A07", { postId: post.id, title: null })).code, "CONFLICT");
  const live = w.f.blogPost({ status: "published", publishedAt: w.f.now() });
  assert.equal(failure(() => w.call("M38.A05", { postId: live.id, authorId: author.id })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M38.A06", { postId: live.id, categories: ["News"] })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M38.A07", { postId: live.id, title: "Seo" })).code, "CONFLICT");
});

test("schedule requires a future publishAt, and a past time is invalid", async () => {
  const w = await testWorld();
  const post = w.f.blogPost();
  assert.equal(failure(() => w.call("M38.A08", { postId: post.id, publishAt: "2020-01-01T00:00:00.000Z" })).code, "INVALID");
  assert.match(failure(() => w.call("M38.A08", { postId: post.id, publishAt: "2020-01-01T00:00:00.000Z" })).message, /past/);
  assert.equal(failure(() => w.call("M38.A08", { postId: post.id, publishAt: "2026-10-21T14:00:00.000Z" })).code, "INVALID");
  const scheduled = w.call("M38.A08", { postId: post.id, publishAt: "2026-12-01T15:00:00.000Z" });
  assert.equal(scheduled.status, "scheduled");
  assert.equal(failure(() => w.call("M38.A08", { postId: post.id, publishAt: "2026-12-02T15:00:00.000Z" })).code, "CONFLICT");
});

test("publish runs from scheduled or unpublished, and unpublish is only for a live post", async () => {
  const w = await testWorld();
  const draft = w.f.blogPost();
  assert.equal(failure(() => w.call("M38.A09", { postId: draft.id })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M38.A10", { postId: draft.id })).code, "CONFLICT");
  w.call("M38.A08", { postId: draft.id, publishAt: "2026-12-01T15:00:00.000Z" });
  const live = w.call("M38.A09", { postId: draft.id });
  assert.equal(live.status, "published");
  assert.ok(live.publishedAt);
  const down = w.call("M38.A10", { postId: draft.id });
  assert.equal(down.status, "unpublished");
  assert.equal(w.call("M38.A09", { postId: draft.id }).status, "published");
});

test("search is newest createdAt first, then id", async () => {
  const w = await testWorld();
  const older = w.f.blogPost({ title: "Older", slug: "older-post", createdAt: "2026-01-01T00:00:00.000Z" });
  const newer = w.f.blogPost({ title: "Newer", slug: "newer-post", createdAt: "2026-06-01T00:00:00.000Z", categories: ["News"] });
  const found = w.call("M38.A03", { category: "news" });
  assert.deepEqual(found.items.map((p: { id: string }) => p.id), [newer.id]);
  const all = w.call("M38.A03", {});
  assert.deepEqual(all.items.map((p: { id: string }) => p.id), [newer.id, older.id]);
});

test("unknown field is INVALID", async () => {
  const w = await testWorld();
  const post = w.f.blogPost();
  assert.equal(failure(() => w.call("M38.A02", { postId: post.id, madeUp: 1 })).code, "INVALID");
});

test("M38.A09 publish and M38.A10 unpublish need messaging.send", async () => {
  const w = await testWorld();
  const billing = w.f.user({ roles: ["billing"] });
  const marketing = w.f.user({ roles: ["marketing"] });
  const post = w.f.blogPost();
  w.call("M38.A08", { postId: post.id, publishAt: "2026-12-01T15:00:00.000Z" });
  assert.equal(failure(() => w.call("M38.A09", { postId: post.id }, billing.id)).code, "PERMISSION");
  assert.equal(failure(() => w.call("M38.A09", { postId: post.id }, "us_missing")).code, "PERMISSION");
  assert.equal(w.call("M38.A02", { postId: post.id }).status, "scheduled");
  assert.equal(w.call("M38.A09", { postId: post.id }, marketing.id).status, "published");
  assert.equal(failure(() => w.call("M38.A10", { postId: post.id }, billing.id)).code, "PERMISSION");
  assert.equal(w.call("M38.A02", { postId: post.id }).status, "published");
  assert.equal(w.call("M38.A10", { postId: post.id }, marketing.id).status, "unpublished");
});
