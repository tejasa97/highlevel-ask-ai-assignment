import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";
import "../m41-lessons/fixtures.js";
import "./fixtures.js";

test("M40.A01 duplicate title is DUPLICATE", async () => {
  const w = await testWorld();
  w.call("M40.A01", { title: "Shared Title" });
  assert.equal(failure(() => w.call("M40.A01", { title: "shared title" })).code, "DUPLICATE");
});

test("M40.A04 no-op is CONFLICT", async () => {
  const w = await testWorld();
  const c = w.f.course({ title: "Keep", description: "Same" });
  assert.equal(failure(() => w.call("M40.A04", { courseId: c.id, title: "Keep" })).code, "CONFLICT");
});

test("M40.A05 duplicate section is DUPLICATE", async () => {
  const w = await testWorld();
  const c = w.f.course();
  assert.equal(failure(() => w.call("M40.A05", { courseId: c.id, title: "lessons" })).code, "DUPLICATE");
});

test("M40.A06 same order is CONFLICT", async () => {
  const w = await testWorld();
  const c = w.f.course();
  assert.equal(failure(() => w.call("M40.A06", { courseId: c.id, sectionIds: c.sections.map((s) => s.id) })).code, "CONFLICT");
});

test("M40.A07 same instructor is CONFLICT", async () => {
  const w = await testWorld();
  const c = w.f.course({ instructorId: "us_1" });
  assert.equal(failure(() => w.call("M40.A07", { courseId: c.id, instructorId: "us_1" })).code, "CONFLICT");
});

test("M40.A08 same prerequisites is CONFLICT", async () => {
  const w = await testWorld();
  const prior = w.f.course();
  const c = w.f.course({ prerequisiteCourseIds: [prior.id] });
  assert.equal(failure(() => w.call("M40.A08", { courseId: c.id, prerequisiteCourseIds: [prior.id] })).code, "CONFLICT");
});

test("M40.A09 publish with no published lesson is CONFLICT", async () => {
  const w = await testWorld();
  const c = w.f.course();
  assert.equal(failure(() => w.call("M40.A09", { courseId: c.id })).code, "CONFLICT");
});

test("M40.A10 archiving twice is CONFLICT", async () => {
  const w = await testWorld();
  const c = w.f.course();
  w.call("M40.A10", { courseId: c.id });
  assert.equal(failure(() => w.call("M40.A10", { courseId: c.id })).code, "CONFLICT");
});

test("unknown field is INVALID", async () => {
  const w = await testWorld();
  const c = w.f.course();
  assert.equal(failure(() => w.call("M40.A02", { courseId: c.id, madeUp: 1 })).code, "INVALID");
});

test("publish needs a published lesson; archived courses can't be edited", async () => {
  const w = await testWorld();
  const c = w.f.course();
  const section = c.sections[0];
  assert.ok(section);
  w.f.lesson({ courseId: c.id, sectionId: section.id, status: "draft" });
  assert.match(failure(() => w.call("M40.A09", { courseId: c.id })).message, /published lesson/);
  w.f.lesson({ courseId: c.id, sectionId: section.id, status: "published" });
  const published = w.call("M40.A09", { courseId: c.id });
  assert.equal(published.status, "published");
  assert.ok(published.publishedAt);
  w.call("M40.A10", { courseId: c.id });
  assert.equal(failure(() => w.call("M40.A04", { courseId: c.id, title: "Renamed after archive" })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M40.A05", { courseId: c.id, title: "Nope" })).code, "CONFLICT");
});

test("search sorts by title then id", async () => {
  const w = await testWorld();
  const b = w.f.course({ title: "Bravo extra" });
  const a = w.f.course({ title: "Alpha extra" });
  const items = w.call("M40.A03", { query: "extra" }).items as { id: string }[];
  const ids = items.map((c) => c.id);
  assert.ok(ids.indexOf(a.id) < ids.indexOf(b.id));
});
