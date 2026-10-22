import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";
import { MediaAsset } from "../m39-media-assets/schema.js";
import "../m40-courses/fixtures.js";
import "./fixtures.js";

test("M41.A01 duplicate title is DUPLICATE", async () => {
  const w = await testWorld();
  const c = w.f.course();
  const sectionId = c.sections[0]!.id;
  w.call("M41.A01", { courseId: c.id, sectionId, title: "Welcome" });
  assert.equal(failure(() => w.call("M41.A01", { courseId: c.id, sectionId, title: "welcome" })).code, "DUPLICATE");
});

test("M41.A04 no-op is CONFLICT", async () => {
  const w = await testWorld();
  const l = w.f.lesson({ title: "Keep", body: "Same" });
  assert.equal(failure(() => w.call("M41.A04", { lessonId: l.id, title: "Keep" })).code, "CONFLICT");
});

test("M41.A05 attaching twice is CONFLICT", async () => {
  const w = await testWorld();
  const l = w.f.lesson();
  const now = w.f.now();
  const media = w.f.make("media_assets", "md", MediaAsset, {
    name: "clip.mp4", mimeType: "video/mp4", sizeBytes: 10, folder: "", altText: null, url: "https://cdn.example/c.mp4", version: 1, accessLinks: [], uploadedBy: "us_1", createdAt: now, updatedAt: now,
  });
  w.call("M41.A05", { lessonId: l.id, mediaId: media.id });
  assert.equal(failure(() => w.call("M41.A05", { lessonId: l.id, mediaId: media.id })).code, "CONFLICT");
});

test("M41.A06 same place is CONFLICT", async () => {
  const w = await testWorld();
  const l = w.f.lesson();
  assert.equal(failure(() => w.call("M41.A06", { lessonId: l.id, sectionId: l.sectionId })).code, "CONFLICT");
});

test("M41.A07 same release is CONFLICT", async () => {
  const w = await testWorld();
  const l = w.f.lesson({ releaseAfterDays: 4 });
  assert.equal(failure(() => w.call("M41.A07", { lessonId: l.id, releaseAfterDays: 4 })).code, "CONFLICT");
});

test("M41.A08 same completion rule is CONFLICT", async () => {
  const w = await testWorld();
  const l = w.f.lesson();
  assert.equal(failure(() => w.call("M41.A08", { lessonId: l.id, type: "manual" })).code, "CONFLICT");
});

test("M41.A09 publishing twice is CONFLICT", async () => {
  const w = await testWorld();
  const l = w.f.lesson();
  w.call("M41.A09", { lessonId: l.id });
  assert.equal(failure(() => w.call("M41.A09", { lessonId: l.id })).code, "CONFLICT");
});

test("M41.A10 unpublishing a draft is CONFLICT", async () => {
  const w = await testWorld();
  const l = w.f.lesson();
  assert.equal(failure(() => w.call("M41.A10", { lessonId: l.id })).code, "CONFLICT");
});

test("unknown field is INVALID", async () => {
  const w = await testWorld();
  assert.equal(failure(() => w.call("M41.A02", { lessonId: w.f.lesson().id, madeUp: 1 })).code, "INVALID");
});

test("can't unpublish the last published lesson of a published course", async () => {
  const w = await testWorld();
  const c = w.f.course({ status: "published" });
  const sectionId = c.sections[0]!.id;
  const only = w.f.lesson({ courseId: c.id, sectionId, status: "published" });
  const err = failure(() => w.call("M41.A10", { lessonId: only.id }));
  assert.equal(err.code, "CONFLICT");
  assert.match(err.message, /published lesson/i);
  const other = w.f.lesson({ courseId: c.id, sectionId, status: "published" });
  assert.equal(w.call("M41.A10", { lessonId: only.id }).status, "draft");
  assert.equal(w.store.get<{ status: string }>("lessons", other.id)?.status, "published");
});
