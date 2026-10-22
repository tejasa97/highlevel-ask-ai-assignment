import "./fixtures.js";
import { z } from "zod";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import { Limit, listOf, page, person, requireState } from "../../registry/helpers.js";
import type { ModuleExports } from "../../registry/registry.js";
import type { Store } from "../../store/db.js";
import type { Course } from "../m40-courses/schema.js";
import type { Lesson } from "../m41-lessons/schema.js";
import { released, stillOpen, unlocksAt } from "./clock-local.js";
import { ENROLLMENT_STATUSES, Enrollment } from "./schema.js";

export { Enrollment } from "./schema.js";

// An enrollment is one contact's access to one course. Completing a lesson records progress.
// A certificate is issued only when every published lesson is done.

const EnrollmentId = z.string().describe("enrollment id (enr_…)");
const CourseId = z.string().describe("course id (crs_…)");
const ContactId = z.string().describe("contact id (ct_…)");
const LessonId = z.string().describe("lesson id (lsn_…)");
const When = z.string().refine((s) => !Number.isNaN(Date.parse(s.length === 10 ? `${s}T00:00:00.000Z` : s)), "expected an ISO date or timestamp");

const enrollmentOf = (store: Store, id: string) => mustGet<Enrollment>(store, "enrollments", id, "enrollment");

function openEnrollment(store: Store, courseId: string, contactId: string): Enrollment | undefined {
  return store.find<Enrollment>(
    "enrollments",
    (e) => e.courseId === courseId && e.contactId === contactId && e.status !== "revoked",
  )[0];
}

const Progress = z.object({
  enrollmentId: z.string(),
  status: z.enum(ENROLLMENT_STATUSES),
  completed: z.number(),
  total: z.number(),
  lessons: z.array(z.object({ lessonId: z.string(), title: z.string(), done: z.boolean(), available: z.boolean() })),
});

const enroll = defineAction({
  id: "M42.A01",
  description: "Enroll an active contact in a published course. Prerequisites must already be completed. Unlike M40.A09 Publish course or M41.A09 Publish lesson, this grants one learner access and does not publish content.",
  risk: "write",
  input: z.strictObject({ courseId: CourseId, contactId: ContactId, expiresAt: When.nullable().optional() }),
  output: Enrollment,
  siblings: ["M41.A09", "M40.A09"],
  entities: { produces: "enrollment", consumes: ["course", "contact"] },
  example: (f) => ({ courseId: f.course({ status: "published" }).id, contactId: f.contact().id }),
  handler: (a, { store, clock }) => {
    const c = mustGet<Course>(store, "courses", a.courseId, "course");
    requireState(`Course "${c.title}"`, c.status, ["published"], "accept learners");
    const who = person(store, { contactId: a.contactId }, "enroll");
    const dup = openEnrollment(store, c.id, who.id);
    if (dup) throw new ActionError("DUPLICATE", `${who.name} is already enrolled in ${c.title} (${dup.id}, ${dup.status})`, { existingId: dup.id });
    for (const id of c.prerequisiteCourseIds) {
      const prior = mustGet<Course>(store, "courses", id, "course");
      const done = store.find<Enrollment>("enrollments", (e) => e.courseId === prior.id && e.contactId === who.id && e.status === "completed");
      if (done.length === 0) throw new ActionError("CONFLICT", `Complete "${prior.title}" before enrolling in this course`);
    }
    return store.insert("enrollments", "enr", {
      courseId: c.id,
      contactId: who.id,
      status: "active" as const,
      enrolledAt: clock.now().toISOString(),
      expiresAt: a.expiresAt ?? null,
      completions: [],
      certificate: null,
      membershipId: null,
      suspendedAt: null,
      revokedAt: null,
      revokeReason: null,
    });
  },
});

const getEnrollment = defineAction({
  id: "M42.A02",
  description: "Get one enrollment: status, expiry, completed lessons and certificate. Unlike Search enrollments, this loads a single enrollment by id.",
  risk: "read",
  input: z.strictObject({ enrollmentId: EnrollmentId }),
  output: Enrollment,
  entities: { consumes: ["enrollment"] },
  example: (f) => ({ enrollmentId: f.enrollment().id }),
  handler: ({ enrollmentId }, { store }) => enrollmentOf(store, enrollmentId),
});

const searchEnrollments = defineAction({
  id: "M42.A03",
  description: "Find enrollments by course, contact or status. Results are sorted by enrolledAt descending, then id. Unlike Get enrollment details, this returns a page of matches.",
  risk: "read",
  input: z.strictObject({
    courseId: CourseId.optional(),
    contactId: ContactId.optional(),
    status: z.enum(ENROLLMENT_STATUSES).optional(),
    limit: Limit,
  }),
  output: listOf(Enrollment),
  entities: { produces: "enrollment" },
  example: () => ({}),
  handler: (a, { store }) => {
    const items = store.find<Enrollment>(
      "enrollments",
      (e) => (!a.courseId || e.courseId === a.courseId) && (!a.contactId || e.contactId === a.contactId) && (!a.status || e.status === a.status),
    );
    items.sort((x, y) => y.enrolledAt.localeCompare(x.enrolledAt) || y.id.localeCompare(x.id));
    return page(items, a.limit);
  },
});

const setExpiry = defineAction({
  id: "M42.A04",
  description: "Set or clear when an active or suspended enrollment expires. Null keeps it open-ended. Unlike Suspend enrollment, the learner stays in the same status. The same expiry is refused.",
  risk: "write",
  input: z.strictObject({ enrollmentId: EnrollmentId, expiresAt: When.nullable() }),
  output: Enrollment,
  entities: { consumes: ["enrollment"] },
  example: (f) => ({ enrollmentId: f.enrollment().id, expiresAt: f.at(30) }),
  handler: (a, { store }) => {
    const e = enrollmentOf(store, a.enrollmentId);
    requireState("Enrollment", e.status, ["active", "suspended"], "have its expiry changed");
    if (a.expiresAt === e.expiresAt) throw new ActionError("CONFLICT", "The enrollment already has that value");
    return store.update<Enrollment>("enrollments", e.id, { expiresAt: a.expiresAt });
  },
});

const suspend = defineAction({
  id: "M42.A05",
  description: "Suspend an active enrollment so the learner can't complete lessons until it is resumed. Unlike Revoke enrollment, this can be undone with Resume enrollment.",
  risk: "write",
  input: z.strictObject({ enrollmentId: EnrollmentId }),
  output: Enrollment,
  entities: { consumes: ["enrollment"] },
  example: (f) => ({ enrollmentId: f.enrollment().id }),
  handler: ({ enrollmentId }, { store, clock }) => {
    const e = enrollmentOf(store, enrollmentId);
    requireState("Enrollment", e.status, ["active"], "be suspended");
    return store.update<Enrollment>("enrollments", e.id, { status: "suspended", suspendedAt: clock.now().toISOString() });
  },
});

const resume = defineAction({
  id: "M42.A06",
  description: "Resume a suspended enrollment and clear suspendedAt. An enrollment that has already expired must get a later expiry first. Unlike Suspend enrollment, this restores access.",
  risk: "write",
  input: z.strictObject({ enrollmentId: EnrollmentId }),
  output: Enrollment,
  entities: { consumes: ["enrollment"] },
  example: (f) => ({ enrollmentId: f.enrollment({ status: "suspended", suspendedAt: f.now() }).id }),
  handler: ({ enrollmentId }, { store, clock }) => {
    const e = enrollmentOf(store, enrollmentId);
    requireState("Enrollment", e.status, ["suspended"], "be resumed");
    const now = clock.now().toISOString();
    if (!stillOpen(e.expiresAt, now)) throw new ActionError("CONFLICT", `The enrollment expired ${e.expiresAt}; set a later expiry with M42.A04 first`);
    return store.update<Enrollment>("enrollments", e.id, { status: "active", suspendedAt: null });
  },
});

const revoke = defineAction({
  id: "M42.A07",
  description: "Revoke an active or suspended enrollment for good. Unlike Suspend enrollment, this is final and the learner must be enrolled again to return.",
  risk: "destructive",
  input: z.strictObject({ enrollmentId: EnrollmentId, reason: z.string().trim().min(1) }),
  output: Enrollment,
  entities: { consumes: ["enrollment"] },
  example: (f) => ({ enrollmentId: f.enrollment().id, reason: "Left the program" }),
  handler: (a, { store, clock }) => {
    const e = enrollmentOf(store, a.enrollmentId);
    requireState("Enrollment", e.status, ["active", "suspended"], "be revoked");
    return store.update<Enrollment>("enrollments", e.id, { status: "revoked", revokedAt: clock.now().toISOString(), revokeReason: a.reason.trim() });
  },
});

const completeLesson = defineAction({
  id: "M42.A08",
  description: "Record that an active learner finished one published lesson on their course. Drip (releaseAfterDays after enrolledAt) and enrollment expiry are enforced. A second completion is refused. Unlike M41.A09 Publish lesson, this records progress and does not change the lesson.",
  risk: "write",
  input: z.strictObject({ enrollmentId: EnrollmentId, lessonId: LessonId }),
  output: Enrollment,
  siblings: ["M41.A09", "M40.A09"],
  entities: { consumes: ["enrollment", "lesson"] },
  example: (f) => {
    const course = f.course({ status: "published" });
    const section = course.sections[0];
    if (!section) throw new Error("course fixture has no section");
    const lesson = f.lesson({ courseId: course.id, sectionId: section.id, status: "published" });
    const row = f.enrollment({ courseId: course.id });
    return { enrollmentId: row.id, lessonId: lesson.id };
  },
  handler: (a, { store, clock }) => {
    const e = enrollmentOf(store, a.enrollmentId);
    requireState("Enrollment", e.status, ["active"], "record a lesson completion");
    const now = clock.now().toISOString();
    if (!stillOpen(e.expiresAt, now)) throw new ActionError("CONFLICT", `The enrollment expired ${e.expiresAt}; set a later expiry with M42.A04`);
    const lesson = mustGet<Lesson>(store, "lessons", a.lessonId, "lesson");
    if (lesson.courseId !== e.courseId) throw new ActionError("CONFLICT", "That lesson isn't on this learner's course");
    requireState(`Lesson "${lesson.title}"`, lesson.status, ["published"], "be marked complete");
    if (!released(e.enrolledAt, lesson.releaseAfterDays, now)) {
      throw new ActionError("CONFLICT", `This lesson unlocks ${lesson.releaseAfterDays} days after enrollment (${unlocksAt(e.enrolledAt, lesson.releaseAfterDays)})`);
    }
    if (e.completions.some((c) => c.lessonId === lesson.id)) throw new ActionError("CONFLICT", "This lesson is already marked complete");
    return store.update<Enrollment>("enrollments", e.id, { completions: [...e.completions, { lessonId: lesson.id, at: now }] });
  },
});

const progress = defineAction({
  id: "M42.A09",
  description: "Show how many published lessons an enrollment has finished, and whether each one is unlocked. Unlike Record lesson completion, this only reads progress and does not mark anything done.",
  risk: "read",
  input: z.strictObject({ enrollmentId: EnrollmentId }),
  output: Progress,
  entities: { consumes: ["enrollment"] },
  example: (f) => ({ enrollmentId: f.enrollment().id }),
  handler: ({ enrollmentId }, { store, clock }) => {
    const e = enrollmentOf(store, enrollmentId);
    const now = clock.now().toISOString();
    const lessons = store.find<Lesson>("lessons", (l) => l.courseId === e.courseId && l.status === "published");
    lessons.sort((x, y) => x.position - y.position || x.id.localeCompare(y.id));
    const done = new Set(e.completions.map((c) => c.lessonId));
    const open = e.status === "active" && stillOpen(e.expiresAt, now);
    return {
      enrollmentId: e.id,
      status: e.status,
      completed: lessons.filter((l) => done.has(l.id)).length,
      total: lessons.length,
      lessons: lessons.map((l) => ({
        lessonId: l.id,
        title: l.title,
        done: done.has(l.id),
        available: open && released(e.enrolledAt, l.releaseAfterDays, now),
      })),
    };
  },
});

const certificate = defineAction({
  id: "M42.A10",
  description: "Issue a course completion certificate once every published lesson is in the enrollment's completions, then mark it completed. The number is CERT- plus the enrollment id. Unlike M40.A09 or M41.A09, this certifies a learner and does not publish content. Draft lessons do not count.",
  risk: "external",
  input: z.strictObject({ enrollmentId: EnrollmentId }),
  output: Enrollment,
  siblings: ["M41.A09", "M40.A09"],
  entities: { consumes: ["enrollment"] },
  example: (f) => {
    const course = f.course({ status: "published" });
    const section = course.sections[0];
    if (!section) throw new Error("course fixture has no section");
    const lesson = f.lesson({ courseId: course.id, sectionId: section.id, status: "published" });
    const row = f.enrollment({ courseId: course.id, completions: [{ lessonId: lesson.id, at: f.now() }] });
    return { enrollmentId: row.id };
  },
  handler: ({ enrollmentId }, { store, clock }) => {
    const e = enrollmentOf(store, enrollmentId);
    if (e.certificate) throw new ActionError("CONFLICT", `A certificate was already issued (${e.certificate.number})`);
    requireState("Enrollment", e.status, ["active"], "be certified");
    const now = clock.now().toISOString();
    if (!stillOpen(e.expiresAt, now)) throw new ActionError("CONFLICT", `The enrollment expired ${e.expiresAt}; set a later expiry with M42.A04`);
    const lessons = store.find<Lesson>("lessons", (l) => l.courseId === e.courseId && l.status === "published");
    if (lessons.length === 0) throw new ActionError("CONFLICT", "The course has no published lessons to complete");
    const done = new Set(e.completions.map((c) => c.lessonId));
    const unfinished = lessons.filter((l) => !done.has(l.id));
    if (unfinished.length > 0) throw new ActionError("CONFLICT", `${unfinished.length} lessons still unfinished`);
    return store.update<Enrollment>("enrollments", e.id, {
      status: "completed",
      certificate: { number: `CERT-${e.id}`, issuedAt: now },
    });
  },
});

export default {
  actions: [enroll, getEnrollment, searchEnrollments, setExpiry, suspend, resume, revoke, completeLesson, progress, certificate],
} satisfies ModuleExports;
