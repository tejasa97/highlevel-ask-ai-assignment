import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";
import { Lesson } from "../m41-lessons/schema.js";

test("upload rejects a duplicate name in the same folder", async () => {
  const w = await testWorld();
  w.call("M39.A01", { name: "Logo", mimeType: "image/png", sizeBytes: 10, folder: "Brand" });
  assert.equal(failure(() => w.call("M39.A01", { name: "logo", mimeType: "image/png", sizeBytes: 10, folder: "brand" })).code, "DUPLICATE");
  assert.equal(failure(() => w.call("M39.A01", { name: "Logo", mimeType: "image/png", sizeBytes: 10, folder: "../secret" })).code, "INVALID");
  assert.equal(w.call("M39.A01", { name: "Logo", mimeType: "image/png", sizeBytes: 10, folder: "other" }).folder, "other");
});

test("rename, alt text and move refuse a no-op and a taken name", async () => {
  const w = await testWorld();
  const asset = w.f.mediaAsset({ name: "Logo", folder: "brand" });
  w.f.mediaAsset({ name: "Mark", folder: "brand" });
  w.f.mediaAsset({ name: "Wordmark", folder: "icons" });
  assert.equal(failure(() => w.call("M39.A04", { assetId: asset.id, name: "Logo" })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M39.A04", { assetId: asset.id, name: "Mark" })).code, "DUPLICATE");
  assert.equal(w.call("M39.A04", { assetId: asset.id, name: "Wordmark" }).name, "Wordmark");
  assert.equal(failure(() => w.call("M39.A05", { assetId: asset.id, altText: null })).code, "CONFLICT");
  assert.equal(w.call("M39.A05", { assetId: asset.id, altText: "Mark" }).altText, "Mark");
  assert.equal(failure(() => w.call("M39.A06", { assetId: asset.id, folder: "Brand" })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M39.A06", { assetId: asset.id, folder: "icons" })).code, "DUPLICATE");
  assert.equal(w.call("M39.A06", { assetId: asset.id, folder: "" }).folder, "");
});

test("replace bumps the version and refuses an identical file", async () => {
  const w = await testWorld();
  const asset = w.f.mediaAsset({ url: "https://cdn.example/a.png", mimeType: "image/png", sizeBytes: 10, version: 1 });
  assert.equal(failure(() => w.call("M39.A07", { assetId: asset.id, url: asset.url })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M39.A07", { assetId: asset.id })).code, "INVALID");
  const next = w.call("M39.A07", { assetId: asset.id, sizeBytes: 20 });
  assert.equal(next.version, 2);
  assert.equal(next.id, asset.id);
  assert.equal(next.sizeBytes, 20);
});

test("references list every landing page, post and lesson, once each", async () => {
  const w = await testWorld();
  const asset = w.f.mediaAsset();
  const other = w.f.mediaAsset();
  const page = w.f.landingPage({ title: "Offer", mediaIds: [asset.id, asset.id] });
  const post = w.f.blogPost({ title: "Notes", mediaIds: [asset.id] });
  w.f.blogPost({ mediaIds: [other.id] });
  const lesson = w.f.make("lessons", "lsn", Lesson, {
    courseId: "crs_1",
    sectionId: "sx_1",
    title: "Welcome",
    body: "Hello",
    position: 1,
    mediaIds: [asset.id],
    releaseAfterDays: 0,
    completion: { type: "view", minutes: null },
    status: "draft",
    createdAt: w.f.now(),
    updatedAt: w.f.now(),
  });
  const listed = w.call("M39.A08", { assetId: asset.id });
  assert.equal(listed.total, 3);
  assert.deepEqual(listed.items.map((item: { recordType: string; recordId: string }) => [item.recordType, item.recordId]), [
    ["blog_post", post.id],
    ["landing_page", page.id],
    ["lesson", lesson.id],
  ]);
  assert.equal(failure(() => w.call("M39.A08", { assetId: "md_99999" })).code, "NOT_FOUND");
});

test("an access link is stored and a past expiry is invalid", async () => {
  const w = await testWorld();
  const asset = w.f.mediaAsset();
  assert.equal(failure(() => w.call("M39.A09", { assetId: asset.id, expiresAt: "2020-01-01T00:00:00.000Z" })).code, "INVALID");
  assert.equal(failure(() => w.call("M39.A09", { assetId: asset.id, expiresAt: "2026-10-21T14:00:00.000Z" })).code, "INVALID");
  const linked = w.call("M39.A09", { assetId: asset.id, expiresAt: "2027-01-01T00:00:00.000Z" });
  assert.equal(linked.accessLinks.length, 1);
  assert.equal(linked.accessLinks[0].expiresAt, "2027-01-01T00:00:00.000Z");
  assert.match(linked.accessLinks[0].url, /access=ak_/);
  assert.equal(linked.version, asset.version);
});

test("delete is refused while any record still lists the asset", async () => {
  const w = await testWorld();
  const asset = w.f.mediaAsset();
  const page = w.f.landingPage({ mediaIds: [asset.id] });
  const post = w.f.blogPost({ mediaIds: [asset.id] });
  const lesson = w.f.make("lessons", "lsn", Lesson, {
    courseId: "crs_1",
    sectionId: "sx_1",
    title: "Welcome",
    body: "Hello",
    position: 1,
    mediaIds: [asset.id],
    releaseAfterDays: 0,
    completion: { type: "view", minutes: null },
    status: "published",
    createdAt: w.f.now(),
    updatedAt: w.f.now(),
  });
  const err = failure(() => w.call("M39.A10", { assetId: asset.id }));
  assert.equal(err.code, "CONFLICT");
  assert.match(err.message, /3 records/);
  assert.match(err.message, /Remove it from 3 records first/);
  w.store.update("landing_pages", page.id, { mediaIds: [] });
  w.store.update("blog_posts", post.id, { mediaIds: [] });
  const one = failure(() => w.call("M39.A10", { assetId: asset.id }));
  assert.equal(one.code, "CONFLICT");
  assert.match(one.message, /Remove it from 1 record first/);
  w.store.update("lessons", lesson.id, { mediaIds: [] });
  assert.equal(w.call("M39.A10", { assetId: asset.id }).id, asset.id);
  assert.equal(failure(() => w.call("M39.A02", { assetId: asset.id })).code, "NOT_FOUND");
});

test("search is sorted by name then id", async () => {
  const w = await testWorld();
  w.f.mediaAsset({ name: "Beta", folder: "brand" });
  w.f.mediaAsset({ name: "Alpha", folder: "brand" });
  w.f.mediaAsset({ name: "Alpha", folder: "other" });
  const found = w.call("M39.A03", { folder: "brand" });
  assert.equal(found.total, 2);
  assert.deepEqual(found.items.map((a: { name: string }) => a.name), ["Alpha", "Beta"]);
});

test("unknown field is INVALID", async () => {
  const w = await testWorld();
  const asset = w.f.mediaAsset();
  assert.equal(failure(() => w.call("M39.A02", { assetId: asset.id, madeUp: 1 })).code, "INVALID");
});
