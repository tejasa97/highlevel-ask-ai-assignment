import { Fixtures, type Input } from "../../store/fixtures.js";
import type { Course } from "../m40-courses/schema.js";
import "../m40-courses/fixtures.js";
import { Lesson } from "./schema.js";

declare module "../../store/fixtures.js" {
  interface Fixtures {
    lesson(o?: Input<Lesson>): Lesson;
  }
}

Fixtures.prototype.lesson = function (this: Fixtures, o: Input<Lesson> = {}): Lesson {
  const n = this.seq();
  const courseId = o.courseId ?? this.course().id;
  const course = this.store.get<Course>("courses", courseId);
  const sectionId = o.sectionId ?? course?.sections[0]?.id;
  if (!sectionId) throw new Error(`lesson fixture: course ${courseId} has no section`);
  const taken = this.store.find<Lesson>("lessons", (l) => l.sectionId === sectionId);
  const position = o.position ?? taken.reduce((m, l) => Math.max(m, l.position), 0) + 1;
  return this.make("lessons", "lsn", Lesson, {
    courseId,
    sectionId,
    title: `Lesson ${n}`,
    body: "Read this lesson.",
    position,
    mediaIds: [],
    releaseAfterDays: 0,
    completion: { type: "manual", minutes: null },
    status: "draft",
    createdAt: this.now(),
    updatedAt: this.now(),
    ...o,
  });
};
