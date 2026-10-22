import { z } from "zod";

export const QUESTION_TYPES = ["rating", "single_choice", "multi_choice", "text", "yes_no"] as const;

export const SurveyQuestion = z.object({
  id: z.string(),
  text: z.string(),
  type: z.enum(QUESTION_TYPES),
  options: z.array(z.string()),
  required: z.boolean(),
  /** After this question, an answer equal to `ifAnswer` jumps to `goTo` (a question id, or "end"). Otherwise the next question follows. */
  branching: z.array(z.object({ ifAnswer: z.union([z.string(), z.number()]), goTo: z.string() })),
});
export type SurveyQuestion = z.infer<typeof SurveyQuestion>;

export const Survey = z.object({
  id: z.string(),
  name: z.string(),
  questions: z.array(SurveyQuestion),
  /** draft → open (published) → closed. Responses are accepted only while open. */
  status: z.enum(["draft", "open", "closed"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  publishedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
});
export type Survey = z.infer<typeof Survey>;

export const SurveyResponse = z.object({
  id: z.string(),
  surveyId: z.string(),
  contactId: z.string().nullable(),
  /** question id → answer, only for the questions the respondent reached. */
  answers: z.record(z.string(), z.union([z.string(), z.number(), z.array(z.string())])),
  submittedAt: z.string(),
});
export type SurveyResponse = z.infer<typeof SurveyResponse>;
