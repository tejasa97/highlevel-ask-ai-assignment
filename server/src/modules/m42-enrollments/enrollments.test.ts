import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";
import "./fixtures.js";

test("M42.A01 duplicate enrollment is DUPLICATE", async () => {
  const w = await testWorld();
  const course = w.f.course({ status: "published" });
  const contact = w.f.contact();
  w.call("M42.A01", { courseId: course.id, contactId: contact.id });
  assert.equal(failure(() => w.call("M42.A01", { courseId: course.id, contactId: contact.id })).code, "DUPLICATE");
});

test("M42.A04 same expiry is CONFLICT", async () => {
  const w = await testWorld();
  const e = w.f.enrollment({ expiresAt: w.f.at(5) });
  assert.equal(failure(() => w.call("M42.A04", { enrollmentId: e.id, expiresAt: e.expiresAt })).code, "CONFLICT");
});

test("M42.A05 suspending twice is CONFLICT", async () => {
  const w = await testWorld();
  const e = w.f.enrollment();
  w.call("M42.A05", { enrollmentId: e.id });
  assert.equal(failure(() => w.call("M42.A05", { enrollmentId: e.id })).code, "CONFLICT");
});

test("M42.A06 resuming an active enrollment is CONFLICT", async () => {
  const w = await testWorld();
  const e = w.f.enrollment();
  assert.equal(failure(() => w.call("M42.A06", { enrollmentId: e.id })).code, "CONFLICT");
});

test("M42.A07 revoking twice is CONFLICT", async () => {
  const w = await testWorld();
  const e = w.f.enrollment();
  w.call("M42.A07", { enrollmentId: e.id, reason: "Done" });
  assert.equal(failure(() => w.call("M42.A07", { enrollmentId: e.id, reason: "Again" })).code, "CONFLICT");
});

test("M42.A08 lesson on another course is CONFLICT", async () => {
  const w = await testWorld();
  const e = w.f.enrollment();
  const lesson = w.f.lesson({ status: "published" });
  assert.equal(failure(() => w.call("M42.A08", { enrollmentId: e.id, lessonId: lesson.id })).code, "CONFLICT");
});

test("M42.A10 unfinished lessons is CONFLICT", async () => {
  const w = await testWorld();
  const course = w.f.course({ status: "published" });
  const sectionId = course.sections[0]!.id;
  w.f.lesson({ courseId: course.id, sectionId, status: "published" });
  const e = w.f.enrollment({ courseId: course.id });
  assert.equal(failure(() => w.call("M42.A10", { enrollmentId: e.id })).code, "CONFLICT");
});

test("unknown field is INVALID", async () => {
  const w = await testWorld();
  assert.equal(failure(() => w.call("M42.A02", { enrollmentId: w.f.enrollment().id, madeUp: 1 })).code, "INVALID");
});

test("completion requires a published lesson on the course, respects drip and expiry", async () => {
  const w = await testWorld();
  const course = w.f.course({ status: "published" });
  const sectionId = course.sections[0]!.id;
  const lesson = w.f.lesson({ courseId: course.id, sectionId, status: "published", releaseAfterDays: 2 });
  const draft = w.f.lesson({ courseId: course.id, sectionId, status: "draft" });
  const fresh = w.f.enrollment({ courseId: course.id, enrolledAt: w.f.now() });
  assert.equal(failure(() => w.call("M42.A08", { enrollmentId: fresh.id, lessonId: draft.id })).code, "CONFLICT");
  assert.match(failure(() => w.call("M42.A08", { enrollmentId: fresh.id, lessonId: lesson.id })).message, /days after enrollment/);
  const ready = w.f.enrollment({ courseId: course.id, enrolledAt: w.f.at(-3) });
  w.call("M42.A08", { enrollmentId: ready.id, lessonId: lesson.id });
  assert.equal(failure(() => w.call("M42.A08", { enrollmentId: ready.id, lessonId: lesson.id })).code, "CONFLICT");
  const expired = w.f.enrollment({ courseId: course.id, enrolledAt: w.f.at(-3), expiresAt: w.f.at(-1) });
  assert.match(failure(() => w.call("M42.A08", { enrollmentId: expired.id, lessonId: lesson.id })).message, /expired/);
  const suspended = w.f.enrollment({ courseId: course.id, status: "suspended", suspendedAt: w.f.now(), enrolledAt: w.f.at(-3) });
  assert.equal(failure(() => w.call("M42.A08", { enrollmentId: suspended.id, lessonId: lesson.id })).code, "CONFLICT");
});

test("certificate only when every published lesson is complete", async () => {
  const w = await testWorld();
  const course = w.f.course({ status: "published" });
  const sectionId = course.sections[0]!.id;
  const a = w.f.lesson({ courseId: course.id, sectionId, status: "published" });
  const b = w.f.lesson({ courseId: course.id, sectionId, status: "published" });
  w.f.lesson({ courseId: course.id, sectionId, status: "draft" });
  const e = w.f.enrollment({ courseId: course.id, completions: [{ lessonId: a.id, at: w.f.now() }] });
  const early = failure(() => w.call("M42.A10", { enrollmentId: e.id }));
  assert.equal(early.code, "CONFLICT");
  assert.match(early.message, /1 lessons still unfinished/);
  w.call("M42.A08", { enrollmentId: e.id, lessonId: b.id });
  const done = w.call("M42.A10", { enrollmentId: e.id });
  assert.equal(done.status, "completed");
  assert.equal(done.certificate.number, `CERT-${e.id}`);
  assert.equal(failure(() => w.call("M42.A10", { enrollmentId: e.id })).code, "CONFLICT");
});

test("enroll requires a published course and completed prerequisites", async () => {
  const w = await testWorld();
  const draft = w.f.course({ status: "draft" });
  const contact = w.f.contact();
  assert.equal(failure(() => w.call("M42.A01", { courseId: draft.id, contactId: contact.id })).code, "CONFLICT");
  const prior = w.f.course({ status: "published", title: "Basics" });
  const course = w.f.course({ status: "published", prerequisiteCourseIds: [prior.id] });
  assert.match(failure(() => w.call("M42.A01", { courseId: course.id, contactId: contact.id })).message, /Basics/);
  w.f.enrollment({ courseId: prior.id, contactId: contact.id, status: "completed" });
  assert.equal(w.call("M42.A01", { courseId: course.id, contactId: contact.id }).status, "active");
});
