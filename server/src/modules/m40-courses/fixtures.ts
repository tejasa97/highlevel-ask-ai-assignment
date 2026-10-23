import { Fixtures, type Input } from "../../store/fixtures.js";
import { Course } from "./schema.js";

declare module "../../store/fixtures.js" {
  interface Fixtures {
    course(o?: Input<Course>): Course;
  }
}

Fixtures.prototype.course = function (this: Fixtures, o: Input<Course> = {}): Course {
  const n = this.seq();
  const sections = o.sections ?? [{ id: this.store.nextId("_nested", "sc"), title: "Lessons" }];
  return this.make("courses", "crs", Course, {
    title: `Course ${n}`,
    description: null,
    sections,
    instructorId: null,
    prerequisiteCourseIds: [],
    status: "draft",
    createdAt: this.now(),
    updatedAt: this.now(),
    publishedAt: null,
    ...o,
  });
};
