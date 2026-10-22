import { z } from "zod";

export const CourseSection = z.object({ id: z.string(), title: z.string() });
export type CourseSection = z.infer<typeof CourseSection>;

export const Course = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  /** In display order. Lessons (M41) point at a section by id and carry their own position. */
  sections: z.array(CourseSection),
  /** A user (M48). */
  instructorId: z.string().nullable(),
  /** Courses a learner must have completed before enrolling in this one. */
  prerequisiteCourseIds: z.array(z.string()),
  /** A course can be published only with at least one published lesson. */
  status: z.enum(["draft", "published", "archived"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  publishedAt: z.string().nullable(),
});
export type Course = z.infer<typeof Course>;
