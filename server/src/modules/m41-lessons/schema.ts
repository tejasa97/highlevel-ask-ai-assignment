import { z } from "zod";

export const Lesson = z.object({
  id: z.string(),
  courseId: z.string(),
  sectionId: z.string(),
  title: z.string(),
  body: z.string(),
  /** Order within its section, 1-based. */
  position: z.number().int().min(1),
  /** Media assets (M39) attached to the lesson. */
  mediaIds: z.array(z.string()),
  /** Drip: available this many days after enrollment; 0 = immediately. */
  releaseAfterDays: z.number().int().min(0),
  /** How a learner finishes it: just viewing, a minimum time on the lesson, or an explicit "mark complete". */
  completion: z.object({ type: z.enum(["view", "time", "manual"]), minutes: z.number().int().min(1).nullable() }),
  status: z.enum(["draft", "published"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Lesson = z.infer<typeof Lesson>;
