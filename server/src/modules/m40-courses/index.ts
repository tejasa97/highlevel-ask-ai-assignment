import { tableResolver } from "../../registry/lookup.js";
import "./fixtures.js";
import { z } from "zod";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import { activeUser, atLeastOne, contains, Limit, listOf, page, requireState } from "../../registry/helpers.js";
import type { ModuleExports } from "../../registry/registry.js";
import type { Store } from "../../store/db.js";
import type { Lesson } from "../m41-lessons/schema.js";
import { Lesson as LessonSchema } from "../m41-lessons/schema.js";
import { Course } from "./schema.js";

export { Course } from "./schema.js";

// A course is the shell of a learning program: sections, an instructor and prerequisites.
// Lessons live in M41. Publishing needs at least one published lesson. Archived is terminal.

const CourseId = z.string().describe("course id (crs_…)");
const Title = z.string().trim().min(1);
const UserId = z.string().describe("user id (us_…)");

const course = (store: Store, id: string) => mustGet<Course>(store, "courses", id, "course");

function editable(store: Store, id: string): Course {
  const c = course(store, id);
  requireState(`Course "${c.title}"`, c.status, ["draft", "published"], "be edited");
  return c;
}

function titleTaken(store: Store, title: string, exceptId?: string): Course | undefined {
  const n = title.trim().toLowerCase();
  return store.find<Course>("courses", (c) => c.id !== exceptId && c.title.toLowerCase() === n)[0];
}

function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const as = [...a].sort();
  const bs = [...b].sort();
  return as.every((id, i) => id === bs[i]);
}

function prerequisites(store: Store, ids: string[], selfId?: string): string[] {
  if (new Set(ids).size !== ids.length) throw new ActionError("INVALID", "List each prerequisite course once");
  for (const id of ids) {
    if (selfId && id === selfId) throw new ActionError("CONFLICT", "A course can't be a prerequisite of itself");
    const other = course(store, id);
    if (other.status === "archived") throw new ActionError("CONFLICT", `${other.title} is archived; pick a draft or published course`);
    if (selfId && requires(store, other, selfId)) throw new ActionError("CONFLICT", `${other.title} already requires this course, so it can't also be a prerequisite of it`);
  }
  return ids;
}

/** Whether `from` needs `targetId` finished, directly or through other prerequisites. */
function requires(store: Store, from: Course, targetId: string, seen = new Set<string>()): boolean {
  if (seen.has(from.id)) return false;
  seen.add(from.id);
  return from.prerequisiteCourseIds.some((id) => id === targetId || requires(store, course(store, id), targetId, seen));
}

const createCourse = defineAction({
  id: "M40.A01",
  description: "Create a draft course with a title and optional instructor and prerequisites. This only builds the program shell. Add lessons with M41.A01 Create lesson, which fills a course instead of creating one.",
  risk: "write",
  input: z.strictObject({
    title: Title,
    description: z.string().trim().min(1).nullable().optional(),
    instructorId: UserId.optional(),
    prerequisiteCourseIds: z.array(z.string()).optional(),
  }),
  output: Course,
  siblings: ["M41.A01"],
  entities: { produces: "course" },
  example: () => ({ title: "Onboarding Academy" }),
  handler: (a, { store, clock }) => {
    const title = a.title.trim();
    const dup = titleTaken(store, title);
    if (dup) throw new ActionError("DUPLICATE", `A course called "${dup.title}" already exists (${dup.id})`, { existingId: dup.id });
    const instructorId = a.instructorId ? activeUser(store, a.instructorId, "teach courses").id : null;
    const prerequisiteCourseIds = prerequisites(store, a.prerequisiteCourseIds ?? []);
    const now = clock.now().toISOString();
    return store.insert("courses", "crs", {
      title,
      description: a.description ?? null,
      sections: [],
      instructorId,
      prerequisiteCourseIds,
      status: "draft" as const,
      createdAt: now,
      updatedAt: now,
      publishedAt: null,
    });
  },
});

const getCourse = defineAction({
  id: "M40.A02",
  description: "Get one course: its sections, instructor, prerequisites, status and publish time. Unlike Search courses, this loads a single course by id.",
  risk: "read",
  input: z.strictObject({ courseId: CourseId }),
  output: Course,
  entities: { consumes: ["course"] },
  example: (f) => ({ courseId: f.course().id }),
  handler: ({ courseId }, { store }) => course(store, courseId),
});

const searchCourses = defineAction({
  id: "M40.A03",
  description: "Find courses by words in the title or description, by status or by instructor. Results are sorted by title, then id. Unlike Get course details, this returns a page of matches.",
  risk: "read",
  input: z.strictObject({
    query: z.string().optional(),
    status: z.enum(["draft", "published", "archived"]).optional(),
    instructorId: UserId.optional(),
    limit: Limit,
  }),
  output: listOf(Course),
  entities: { produces: "course" },
  example: () => ({}),
  handler: (a, { store }) => {
    const items = store.find<Course>(
      "courses",
      (c) =>
        (!a.status || c.status === a.status) &&
        (!a.instructorId || c.instructorId === a.instructorId) &&
        (!a.query || contains(c.title, a.query) || contains(c.description, a.query)),
    );
    items.sort((x, y) => x.title.localeCompare(y.title) || x.id.localeCompare(y.id));
    return page(items, a.limit);
  },
});

const updateCourse = defineAction({
  id: "M40.A04",
  description: "Change a draft or published course's title or description. Archived courses can't be edited. Unlike Create course, this updates a course that already exists, and a no-op is refused.",
  risk: "write",
  input: z.strictObject({
    courseId: CourseId,
    title: Title.optional(),
    description: z.string().trim().min(1).nullable().optional(),
  }),
  output: Course,
  entities: { consumes: ["course"] },
  example: (f) => ({ courseId: f.course().id, title: "Renamed onboarding course" }),
  handler: (a, { store, clock }) => {
    atLeastOne(a, ["title", "description"]);
    const c = editable(store, a.courseId);
    const title = a.title?.trim();
    if (title) {
      const dup = titleTaken(store, title, c.id);
      if (dup) throw new ActionError("DUPLICATE", `A course called "${dup.title}" already exists (${dup.id})`, { existingId: dup.id });
    }
    const description = a.description === undefined ? c.description : a.description;
    const nextTitle = title ?? c.title;
    if (nextTitle === c.title && description === c.description) throw new ActionError("CONFLICT", "The course already has that value");
    return store.update<Course>("courses", c.id, { title: nextTitle, description, updatedAt: clock.now().toISOString() });
  },
});

const addSection = defineAction({
  id: "M40.A05",
  description: "Append a named section to a draft or published course. Lessons are placed in a section. Unlike Reorder course sections, this adds one section at the end instead of changing order.",
  risk: "write",
  input: z.strictObject({ courseId: CourseId, title: Title }),
  output: Course,
  entities: { consumes: ["course"] },
  example: (f) => ({ courseId: f.course().id, title: "Advanced" }),
  handler: (a, { store, clock }) => {
    const c = editable(store, a.courseId);
    const title = a.title.trim();
    if (c.sections.some((s) => s.title.toLowerCase() === title.toLowerCase())) {
      throw new ActionError("DUPLICATE", `This course already has a section called "${title}"`);
    }
    const section = { id: store.nextId("_nested", "sc"), title };
    return store.update<Course>("courses", c.id, { sections: [...c.sections, section], updatedAt: clock.now().toISOString() });
  },
});

const reorderSections = defineAction({
  id: "M40.A06",
  description: "Set the display order of a course's sections by listing every section id. Unlike Add course section, this does not create a section, and the same order is refused.",
  risk: "write",
  input: z.strictObject({ courseId: CourseId, sectionIds: z.array(z.string()).min(1) }),
  output: Course,
  entities: { consumes: ["course"] },
  example: (f) => {
    const first = f.store.nextId("_nested", "sc");
    const second = f.store.nextId("_nested", "sc");
    const c = f.course({ sections: [{ id: first, title: "Start" }, { id: second, title: "Next" }] });
    return { courseId: c.id, sectionIds: [second, first] };
  },
  handler: (a, { store, clock }) => {
    const c = editable(store, a.courseId);
    if (a.sectionIds.length !== c.sections.length || new Set(a.sectionIds).size !== c.sections.length) {
      throw new ActionError("INVALID", "sectionIds must list every section of the course exactly once");
    }
    const byId = new Map(c.sections.map((s) => [s.id, s]));
    const sections = a.sectionIds.map((id) => {
      const s = byId.get(id);
      if (!s) throw new ActionError("NOT_FOUND", `No section ${id} on this course`);
      return s;
    });
    if (sections.every((s, i) => s.id === c.sections[i]?.id)) throw new ActionError("CONFLICT", "The course already has that section order");
    return store.update<Course>("courses", c.id, { sections, updatedAt: clock.now().toISOString() });
  },
});

const assignInstructor = defineAction({
  id: "M40.A07",
  description: "Set the instructor of a draft or published course to an active user. Unlike Update course details, this changes who teaches it, and assigning the current instructor is refused.",
  risk: "write",
  input: z.strictObject({ courseId: CourseId, instructorId: UserId }),
  output: Course,
  entities: { consumes: ["course"] },
  example: (f) => ({ courseId: f.course().id, instructorId: "us_1" }),
  handler: (a, { store, clock }) => {
    const c = editable(store, a.courseId);
    const instructor = activeUser(store, a.instructorId, "teach courses");
    if (c.instructorId === instructor.id) throw new ActionError("CONFLICT", "The course already has that instructor");
    return store.update<Course>("courses", c.id, { instructorId: instructor.id, updatedAt: clock.now().toISOString() });
  },
});

const setPrerequisites = defineAction({
  id: "M40.A08",
  description: "Replace the courses a learner must finish before enrolling in this one. Unlike Assign course instructor, this changes required courses, not the teacher. The same set is refused.",
  risk: "write",
  input: z.strictObject({ courseId: CourseId, prerequisiteCourseIds: z.array(z.string()) }),
  output: Course,
  entities: { consumes: ["course"] },
  example: (f) => {
    const prior = f.course({ title: "Prerequisite workshop" });
    return { courseId: f.course().id, prerequisiteCourseIds: [prior.id] };
  },
  handler: (a, { store, clock }) => {
    const c = editable(store, a.courseId);
    const ids = prerequisites(store, a.prerequisiteCourseIds, c.id);
    if (sameIds(ids, c.prerequisiteCourseIds)) throw new ActionError("CONFLICT", "The course already has that value");
    return store.update<Course>("courses", c.id, { prerequisiteCourseIds: ids, updatedAt: clock.now().toISOString() });
  },
});

const publishCourse = defineAction({
  id: "M40.A09",
  destination: { id: "course", label: "Course" },
  description: "Publish a draft course so learners can enroll. Unlike M42.A01 Enroll learner, this does not give anyone access. At least one lesson on the course must already be published (M41.A09). Unlike Archive course, this makes the course available.",
  risk: "external",
  input: z.strictObject({ courseId: CourseId }),
  output: Course,
  siblings: ["M42.A01", "M42.A08", "M42.A10"],
  entities: { consumes: ["course"] },
  example: (f) => {
    const created = f.course();
    const section = created.sections[0];
    if (!section) throw new Error("course fixture has no section");
    const now = f.now();
    f.make("lessons", "lsn", LessonSchema, {
      courseId: created.id,
      sectionId: section.id,
      title: "Welcome",
      body: "Start here",
      position: 1,
      mediaIds: [],
      releaseAfterDays: 0,
      completion: { type: "manual", minutes: null },
      status: "published",
      createdAt: now,
      updatedAt: now,
    });
    return { courseId: created.id };
  },
  handler: ({ courseId }, { store, clock }) => {
    const c = course(store, courseId);
    requireState(`Course "${c.title}"`, c.status, ["draft"], "be published");
    const ready = store.find<Lesson>("lessons", (l) => l.courseId === c.id && l.status === "published");
    if (ready.length === 0) throw new ActionError("CONFLICT", "This course needs at least one published lesson before it can be published");
    const now = clock.now().toISOString();
    return store.update<Course>("courses", c.id, { status: "published", publishedAt: now, updatedAt: now });
  },
});

const archiveCourse = defineAction({
  id: "M40.A10",
  description: "Archive a draft or published course. Archived courses can't be edited or published again. Unlike Publish course, this takes the course out of use instead of making it available.",
  risk: "destructive",
  input: z.strictObject({ courseId: CourseId }),
  output: Course,
  entities: { consumes: ["course"] },
  example: (f) => ({ courseId: f.course().id }),
  handler: ({ courseId }, { store, clock }) => {
    const c = course(store, courseId);
    requireState(`Course "${c.title}"`, c.status, ["draft", "published"], "be archived");
    return store.update<Course>("courses", c.id, { status: "archived", updatedAt: clock.now().toISOString() });
  },
});

export default {
  resolvers: {
    course: tableResolver("courses", "title"),
  },
  actions: [createCourse, getCourse, searchCourses, updateCourse, addSection, reorderSections, assignInstructor, setPrerequisites, publishCourse, archiveCourse],
} satisfies ModuleExports;
