import "./fixtures.js";
import { z } from "zod";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import { atLeastOne, contains, Limit, listOf, page, requireState } from "../../registry/helpers.js";
import type { ModuleExports } from "../../registry/registry.js";
import type { Store } from "../../store/db.js";
import type { MediaAsset } from "../m39-media-assets/schema.js";
import { MediaAsset as MediaAssetSchema } from "../m39-media-assets/schema.js";
import type { Course } from "../m40-courses/schema.js";
import { Lesson } from "./schema.js";

export { Lesson } from "./schema.js";

// Lessons belong to one section of a course. Publishing a lesson is what lets a course publish
// and what lets a learner complete it. Drip and completion rules live on the lesson.

const LessonId = z.string().describe("lesson id (lsn_…)");
const CourseId = z.string().describe("course id (crs_…)");
const Title = z.string().trim().min(1);
const CompletionType = z.enum(["view", "time", "manual"]);

const lessonOf = (store: Store, id: string) => mustGet<Lesson>(store, "lessons", id, "lesson");

function openCourse(store: Store, id: string, doing: string): Course {
  const c = mustGet<Course>(store, "courses", id, "course");
  requireState(`Course "${c.title}"`, c.status, ["draft", "published"], doing);
  return c;
}

function sectionOn(c: Course, sectionId: string): void {
  if (!c.sections.some((s) => s.id === sectionId)) throw new ActionError("CONFLICT", `Section ${sectionId} isn't on ${c.title}`);
}

const DEFAULT_SECTION = "Lessons";

/**
 * Where a new lesson goes when the caller names no section: the course's only section, or a default one
 * when it has none yet. With several sections the caller has to choose.
 */
function sectionFor(store: Store, c: Course, sectionId: string | undefined, now: string): string {
  if (sectionId) {
    sectionOn(c, sectionId);
    return sectionId;
  }
  const [only, ...rest] = c.sections;
  if (rest.length) throw new ActionError("INVALID", `${c.title} has several sections (${c.sections.map((s) => `${s.title} ${s.id}`).join(", ")}); give sectionId`);
  if (only) return only.id;
  const section = { id: store.nextId("_nested", "sc"), title: DEFAULT_SECTION };
  store.update<Course>("courses", c.id, { sections: [section], updatedAt: now });
  return section.id;
}

function titleTaken(store: Store, courseId: string, title: string, exceptId?: string): boolean {
  const n = title.toLowerCase();
  return store.find<Lesson>("lessons", (l) => l.courseId === courseId && l.id !== exceptId && l.title.toLowerCase() === n).length > 0;
}

function nextPosition(store: Store, sectionId: string): number {
  return store.find<Lesson>("lessons", (l) => l.sectionId === sectionId).reduce((m, l) => Math.max(m, l.position), 0) + 1;
}

function positionTaken(store: Store, sectionId: string, position: number, exceptId?: string): boolean {
  return store.find<Lesson>("lessons", (l) => l.sectionId === sectionId && l.position === position && l.id !== exceptId).length > 0;
}

function completionOf(c?: { type: "view" | "time" | "manual"; minutes?: number | null }): Lesson["completion"] {
  if (!c) return { type: "manual", minutes: null };
  if (c.type === "time") {
    if (c.minutes == null) throw new ActionError("INVALID", "A time-based lesson needs minutes of at least 1");
    return { type: "time", minutes: c.minutes };
  }
  if (c.minutes != null) throw new ActionError("INVALID", "Only a time-based lesson takes minutes");
  return { type: c.type, minutes: null };
}

const createLesson = defineAction({
  id: "M41.A01",
  description: "Add a draft lesson to an existing course. Without sectionId it goes in the course's only section, and a course with no section gets a default one called Lessons. Unlike M40.A01 Create course, this does not create a program; it adds one lesson inside a course that already exists.",
  risk: "write",
  input: z.strictObject({
    courseId: CourseId,
    sectionId: z.string().describe("section id on the course; leave out when the course has one section or none").optional(),
    title: Title,
    body: z.string().optional(),
    position: z.number().int().min(1).optional(),
    releaseAfterDays: z.number().int().min(0).optional(),
    completion: z.strictObject({ type: CompletionType, minutes: z.number().int().min(1).nullable().optional() }).optional(),
  }),
  output: Lesson,
  siblings: ["M40.A01"],
  entities: { produces: "lesson", consumes: ["course"] },
  example: (f) => {
    const c = f.course();
    const section = c.sections[0];
    if (!section) throw new Error("course fixture has no section");
    return { courseId: c.id, sectionId: section.id, title: "Welcome lesson" };
  },
  handler: (a, { store, clock }) => {
    const c = openCourse(store, a.courseId, "receive a lesson");
    const title = a.title.trim();
    if (titleTaken(store, c.id, title)) throw new ActionError("DUPLICATE", `This course already has a lesson called "${title}"`);
    const now = clock.now().toISOString();
    const sectionId = sectionFor(store, c, a.sectionId, now);
    const position = a.position ?? nextPosition(store, sectionId);
    if (positionTaken(store, sectionId, position)) throw new ActionError("DUPLICATE", `Position ${position} is already used in that section`);
    return store.insert("lessons", "lsn", {
      courseId: c.id,
      sectionId,
      title,
      body: a.body ?? "",
      position,
      mediaIds: [],
      releaseAfterDays: a.releaseAfterDays ?? 0,
      completion: completionOf(a.completion),
      status: "draft" as const,
      createdAt: now,
      updatedAt: now,
    });
  },
});

const getLesson = defineAction({
  id: "M41.A02",
  description: "Get one lesson: its course, section, body, drip rule, completion rule and status. Unlike Search lessons, this loads a single lesson by id.",
  risk: "read",
  input: z.strictObject({ lessonId: LessonId }),
  output: Lesson,
  entities: { consumes: ["lesson"] },
  example: (f) => ({ lessonId: f.lesson().id }),
  handler: ({ lessonId }, { store }) => lessonOf(store, lessonId),
});

const searchLessons = defineAction({
  id: "M41.A03",
  description: "Find lessons by course, section, status or words in the title or body. Results are sorted by course, section, position, then id. Unlike Get lesson details, this returns a page of matches.",
  risk: "read",
  input: z.strictObject({
    courseId: CourseId.optional(),
    sectionId: z.string().optional(),
    status: z.enum(["draft", "published"]).optional(),
    query: z.string().optional(),
    limit: Limit,
  }),
  output: listOf(Lesson),
  entities: { produces: "lesson" },
  example: () => ({}),
  handler: (a, { store }) => {
    const items = store.find<Lesson>(
      "lessons",
      (l) =>
        (!a.courseId || l.courseId === a.courseId) &&
        (!a.sectionId || l.sectionId === a.sectionId) &&
        (!a.status || l.status === a.status) &&
        (!a.query || contains(l.title, a.query) || contains(l.body, a.query)),
    );
    items.sort((x, y) => x.courseId.localeCompare(y.courseId) || x.sectionId.localeCompare(y.sectionId) || x.position - y.position || x.id.localeCompare(y.id));
    return page(items, a.limit);
  },
});

const updateLesson = defineAction({
  id: "M41.A04",
  description: "Rewrite a lesson's title or body on a draft or published course. Unlike Set lesson completion criteria, this changes the text learners read, and a no-op is refused.",
  risk: "write",
  input: z.strictObject({ lessonId: LessonId, title: Title.optional(), body: z.string().optional() }),
  output: Lesson,
  entities: { consumes: ["lesson"] },
  example: (f) => ({ lessonId: f.lesson().id, title: "Welcome, revised" }),
  handler: (a, { store, clock }) => {
    atLeastOne(a, ["title", "body"]);
    const l = lessonOf(store, a.lessonId);
    openCourse(store, l.courseId, "change its lessons");
    const title = a.title?.trim() ?? l.title;
    if (titleTaken(store, l.courseId, title, l.id)) throw new ActionError("DUPLICATE", `This course already has a lesson called "${title}"`);
    const body = a.body === undefined ? l.body : a.body;
    if (title === l.title && body === l.body) throw new ActionError("CONFLICT", "The lesson already has that value");
    return store.update<Lesson>("lessons", l.id, { title, body, updatedAt: clock.now().toISOString() });
  },
});

const attachMedia = defineAction({
  id: "M41.A05",
  description: "Attach an existing media asset to a lesson. Unlike Update lesson content, this adds a file reference and does not change the lesson text. Attaching the same asset again is refused.",
  risk: "write",
  input: z.strictObject({ lessonId: LessonId, mediaId: z.string().describe("media asset id (md_…)") }),
  output: Lesson,
  entities: { consumes: ["lesson"] },
  example: (f) => {
    const now = f.now();
    const media = f.make("media_assets", "md", MediaAssetSchema, {
      name: "intro.mp4",
      mimeType: "video/mp4",
      sizeBytes: 1200,
      folder: "courses",
      altText: null,
      url: "https://cdn.example/intro.mp4",
      version: 1,
      accessLinks: [],
      uploadedBy: "us_1",
      createdAt: now,
      updatedAt: now,
    });
    return { lessonId: f.lesson().id, mediaId: media.id };
  },
  handler: (a, { store, clock }) => {
    const l = lessonOf(store, a.lessonId);
    openCourse(store, l.courseId, "change its lessons");
    mustGet<MediaAsset>(store, "media_assets", a.mediaId, "media asset");
    if (l.mediaIds.includes(a.mediaId)) throw new ActionError("CONFLICT", "The lesson already has that media");
    return store.update<Lesson>("lessons", l.id, { mediaIds: [...l.mediaIds, a.mediaId], updatedAt: clock.now().toISOString() });
  },
});

const moveLesson = defineAction({
  id: "M41.A06",
  description: "Move a lesson into another section of the same course, optionally to a position. Unlike Create lesson, this does not add a lesson. Leaving it where it already is is refused.",
  risk: "write",
  input: z.strictObject({
    lessonId: LessonId,
    sectionId: z.string().describe("section id on the same course"),
    position: z.number().int().min(1).optional(),
  }),
  output: Lesson,
  entities: { consumes: ["lesson"] },
  example: (f) => {
    const extra = f.store.nextId("_nested", "sc");
    const c = f.course({ sections: [{ id: f.store.nextId("_nested", "sc"), title: "Start" }, { id: extra, title: "Later" }] });
    const lesson = f.lesson({ courseId: c.id, sectionId: c.sections[0]!.id });
    return { lessonId: lesson.id, sectionId: extra };
  },
  handler: (a, { store, clock }) => {
    const l = lessonOf(store, a.lessonId);
    const c = openCourse(store, l.courseId, "change its lessons");
    sectionOn(c, a.sectionId);
    const position = a.position ?? (a.sectionId === l.sectionId ? l.position : nextPosition(store, a.sectionId));
    if (a.sectionId === l.sectionId && position === l.position) throw new ActionError("CONFLICT", "The lesson already has that place");
    if (positionTaken(store, a.sectionId, position, l.id)) throw new ActionError("CONFLICT", `Position ${position} is already used in that section`);
    return store.update<Lesson>("lessons", l.id, { sectionId: a.sectionId, position, updatedAt: clock.now().toISOString() });
  },
});

const setRelease = defineAction({
  id: "M41.A07",
  description: "Set how many days after enrollment a lesson unlocks. Zero means immediately. Unlike Set lesson completion criteria, this changes when it opens, not how the learner finishes it.",
  risk: "write",
  input: z.strictObject({ lessonId: LessonId, releaseAfterDays: z.number().int().min(0) }),
  output: Lesson,
  entities: { consumes: ["lesson"] },
  example: (f) => ({ lessonId: f.lesson().id, releaseAfterDays: 3 }),
  handler: (a, { store, clock }) => {
    const l = lessonOf(store, a.lessonId);
    openCourse(store, l.courseId, "change its lessons");
    if (l.releaseAfterDays === a.releaseAfterDays) throw new ActionError("CONFLICT", "The lesson already has that release schedule");
    return store.update<Lesson>("lessons", l.id, { releaseAfterDays: a.releaseAfterDays, updatedAt: clock.now().toISOString() });
  },
});

const setCompletion = defineAction({
  id: "M41.A08",
  description: "Set how a learner finishes a lesson: by viewing it, spending a number of minutes, or marking it complete. Unlike Set lesson release schedule, this changes the finish rule, not when it unlocks.",
  risk: "write",
  input: z.strictObject({
    lessonId: LessonId,
    type: CompletionType,
    minutes: z.number().int().min(1).nullable().optional(),
  }),
  output: Lesson,
  entities: { consumes: ["lesson"] },
  example: (f) => ({ lessonId: f.lesson().id, type: "time", minutes: 5 }),
  handler: (a, { store, clock }) => {
    const l = lessonOf(store, a.lessonId);
    openCourse(store, l.courseId, "change its lessons");
    const completion = completionOf({ type: a.type, minutes: a.minutes });
    if (l.completion.type === completion.type && l.completion.minutes === completion.minutes) {
      throw new ActionError("CONFLICT", "The lesson already has that completion rule");
    }
    return store.update<Lesson>("lessons", l.id, { completion, updatedAt: clock.now().toISOString() });
  },
});

const publishLesson = defineAction({
  id: "M41.A09",
  description: "Publish a draft lesson so learners can complete it and the course can be published. Unlike M40.A09 Publish course, this publishes one lesson, not the program. Unlike M42.A08, this does not record that a learner finished it.",
  risk: "external",
  input: z.strictObject({ lessonId: LessonId }),
  output: Lesson,
  siblings: ["M42.A01", "M42.A08", "M42.A10"],
  entities: { consumes: ["lesson"] },
  example: (f) => ({ lessonId: f.lesson().id }),
  handler: ({ lessonId }, { store, clock }) => {
    const l = lessonOf(store, lessonId);
    openCourse(store, l.courseId, "publish a lesson");
    requireState(`Lesson "${l.title}"`, l.status, ["draft"], "be published");
    return store.update<Lesson>("lessons", l.id, { status: "published", updatedAt: clock.now().toISOString() });
  },
});

const unpublishLesson = defineAction({
  id: "M41.A10",
  description: "Return a published lesson to draft so learners can no longer complete it. Unlike Publish lesson, this hides the lesson. The last published lesson of a published course is refused.",
  risk: "destructive",
  input: z.strictObject({ lessonId: LessonId }),
  output: Lesson,
  entities: { consumes: ["lesson"] },
  example: (f) => ({ lessonId: f.lesson({ status: "published" }).id }),
  handler: ({ lessonId }, { store, clock }) => {
    const l = lessonOf(store, lessonId);
    requireState(`Lesson "${l.title}"`, l.status, ["published"], "be unpublished");
    const c = mustGet<Course>(store, "courses", l.courseId, "course");
    if (c.status === "published") {
      const others = store.find<Lesson>("lessons", (x) => x.courseId === c.id && x.status === "published" && x.id !== l.id);
      if (others.length === 0) throw new ActionError("CONFLICT", "Publish another lesson first; a published course needs at least one published lesson");
    }
    return store.update<Lesson>("lessons", l.id, { status: "draft", updatedAt: clock.now().toISOString() });
  },
});

export default {
  actions: [createLesson, getLesson, searchLessons, updateLesson, attachMedia, moveLesson, setRelease, setCompletion, publishLesson, unpublishLesson],
} satisfies ModuleExports;
