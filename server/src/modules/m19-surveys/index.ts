import { z } from "zod";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import { contains, freshId, Limit, listOf, page, requireState } from "../../registry/helpers.js";
import type { ModuleExports } from "../../registry/registry.js";
import type { Clock } from "../../store/clock.js";
import type { Store } from "../../store/db.js";
import type { Contact } from "../m01-contacts/schema.js";
import { QUESTION_TYPES, Survey, SurveyQuestion, SurveyResponse } from "./schema.js";

import "./fixtures.js";

// Surveys accept responses only while open. Branching jumps to another question or to "end"; anything
// that was not reached is left out of the stored answers. The summary counts those stored answers.

const SurveyId = z.string().describe("survey id (sv_…)");
const QuestionId = z.string().describe("question id");
const Answer = z.union([z.string(), z.number(), z.array(z.string())]);
const BranchInput = z.strictObject({
  ifAnswer: z.union([z.string(), z.number()]),
  goTo: z.string().min(1).describe("a question id, or end"),
});

type AnswerValue = string | number | string[];

const iso = (clock: Clock) => clock.now().toISOString();

function byName(store: Store, name: string): Survey | undefined {
  const key = name.trim().toLowerCase();
  return store.find<Survey>("surveys", (survey) => survey.name.trim().toLowerCase() === key)[0];
}

function questionOf(survey: Survey, questionId: string): SurveyQuestion {
  const question = survey.questions.find((item) => item.id === questionId);
  if (!question) throw new ActionError("NOT_FOUND", `No question with id ${questionId} on survey ${survey.id}`, { id: questionId });
  return question;
}

function draftOnly(survey: Survey): void {
  requireState(`Survey "${survey.name}"`, survey.status, ["draft"], "change questions");
}

function choiceNeedsOptions(type: SurveyQuestion["type"], options: string[], text: string): void {
  if ((type === "single_choice" || type === "multi_choice") && options.length === 0) {
    throw new ActionError("INVALID", `Question "${text}" needs at least one option`);
  }
}

function surveyErrors(survey: Survey): string[] {
  const errors: string[] = [];
  if (survey.questions.length === 0) errors.push("Add at least one question");
  const ids = new Set(survey.questions.map((question) => question.id));
  for (const question of survey.questions) {
    if ((question.type === "single_choice" || question.type === "multi_choice") && question.options.length === 0) {
      errors.push(`Question "${question.text}" needs at least one option`);
    }
    for (const branch of question.branching) {
      if (branch.goTo === question.id) errors.push(`Question "${question.text}" branches to itself`);
      else if (branch.goTo !== "end" && !ids.has(branch.goTo)) errors.push(`Question "${question.text}" branches to unknown question ${branch.goTo}`);
    }
  }
  return errors;
}

// Branches only skip ahead, so a response can never come back to a question it has already answered.
function checkBranch(survey: Survey, question: SurveyQuestion, branch: { ifAnswer: string | number; goTo: string }): void {
  if (branch.goTo !== "end") {
    const target = survey.questions.findIndex((item) => item.id === branch.goTo);
    if (target < 0) throw new ActionError("NOT_FOUND", `No question with id ${branch.goTo} on this survey`, { id: branch.goTo });
    if (branch.goTo === question.id) throw new ActionError("CONFLICT", "A question can't branch to itself");
    if (target < survey.questions.findIndex((item) => item.id === question.id)) throw new ActionError("CONFLICT", `Branches only skip ahead, and ${branch.goTo} comes before "${question.text}"`);
  }
  if (question.type === "yes_no") {
    if (typeof branch.ifAnswer !== "string" || !["yes", "no"].includes(branch.ifAnswer.trim().toLowerCase())) {
      throw new ActionError("INVALID", `Yes/no questions branch on yes or no, not ${JSON.stringify(branch.ifAnswer)}`);
    }
  } else if (question.type === "single_choice" || question.type === "multi_choice") {
    if (typeof branch.ifAnswer !== "string" || !question.options.includes(branch.ifAnswer)) {
      throw new ActionError("INVALID", `${JSON.stringify(branch.ifAnswer)} is not an option on "${question.text}"`);
    }
  } else if (question.type === "rating" && typeof branch.ifAnswer !== "number") {
    throw new ActionError("INVALID", "Rating questions branch on a number");
  }
}

const createSurvey = defineAction({
  id: "M19.A01",
  description: "Creates a new survey with a name and purpose so questions can be added afterwards. Starts as an unpublished draft, not yet visible to respondents. Unlike M18.A01 Create form, this is for asking questions (with branching) rather than capturing contact details.",
  risk: "write",
  input: z.strictObject({ name: z.string().min(1) }),
  output: Survey,
  siblings: ["M18.A01"],
  entities: { produces: "survey" },
  example: () => ({ name: "Post-visit NPS" }),
  handler: (a, { store, clock }) => {
    const name = a.name.trim();
    if (!name) throw new ActionError("INVALID", "Name can't be blank");
    const existing = byName(store, name);
    if (existing) throw new ActionError("DUPLICATE", `A survey named "${name}" already exists (${existing.id})`, { existingId: existing.id });
    const now = iso(clock);
    return store.insert("surveys", "sv", {
      name,
      questions: [],
      status: "draft" as const,
      createdAt: now,
      updatedAt: now,
      publishedAt: null,
      closedAt: null,
    });
  },
});

const getSurvey = defineAction({
  id: "M19.A02",
  description: "Shows the full setup of one survey: its questions, order, branching rules and status. Use it to inspect a survey, not to see answers.",
  risk: "read",
  input: z.strictObject({ surveyId: SurveyId }),
  output: Survey,
  entities: { consumes: ["survey"] },
  example: (f) => ({ surveyId: f.survey().id }),
  handler: ({ surveyId }, { store }) => mustGet<Survey>(store, "surveys", surveyId, "survey"),
});

const listSurveys = defineAction({
  id: "M19.A03",
  description: "Lists existing surveys with their status such as draft, published or closed. Use it to browse or find a survey before opening it.",
  risk: "read",
  input: z.strictObject({
    status: z.enum(["draft", "open", "closed"]).optional(),
    query: z.string().optional().describe("part of the name"),
    limit: Limit,
  }),
  output: listOf(Survey),
  entities: { produces: "survey" },
  example: (f) => {
    f.survey({ name: "NPS spring" });
    return { query: "NPS" };
  },
  handler: (a, { store }) => {
    const items = store.find<Survey>("surveys", (survey) => (!a.status || survey.status === a.status) && (!a.query || contains(survey.name, a.query)));
    items.sort((x, y) => x.name.localeCompare(y.name) || x.id.localeCompare(y.id));
    return page(items, a.limit);
  },
});

const addQuestion = defineAction({
  id: "M19.A04",
  description: "Adds a new question to a survey, such as multiple choice, rating or free text. Use Update question to change an existing one. Unlike M18.A04 Add form field, this adds a question that can branch.",
  risk: "write",
  input: z.strictObject({
    surveyId: SurveyId,
    text: z.string().min(1),
    type: z.enum(QUESTION_TYPES),
    options: z.array(z.string().min(1)).optional(),
    required: z.boolean().optional(),
  }),
  output: Survey,
  siblings: ["M18.A04"],
  entities: { consumes: ["survey"] },
  example: (f) => ({ surveyId: f.survey().id, text: "How did we do?", type: "text" }),
  handler: (a, { store, clock }) => {
    const survey = mustGet<Survey>(store, "surveys", a.surveyId, "survey");
    draftOnly(survey);
    const text = a.text.trim();
    if (!text) throw new ActionError("INVALID", "Question text can't be blank");
    if (survey.questions.some((question) => question.text.toLowerCase() === text.toLowerCase())) {
      throw new ActionError("DUPLICATE", `This survey already has a question "${text}"`);
    }
    const options = a.options ?? [];
    choiceNeedsOptions(a.type, options, text);
    const question: SurveyQuestion = {
      id: freshId(store, "qu", survey.questions.map((item) => item.id)),
      text,
      type: a.type,
      options,
      required: a.required ?? false,
      branching: [],
    };
    return store.update<Survey>("surveys", survey.id, { questions: [...survey.questions, question], updatedAt: iso(clock) });
  },
});

const updateQuestion = defineAction({
  id: "M19.A05",
  description: "Edits an existing survey question, such as its wording, type, options or required setting. Use Add question to create a new one instead.",
  risk: "write",
  input: z.strictObject({
    surveyId: SurveyId,
    questionId: QuestionId,
    text: z.string().min(1).optional(),
    type: z.enum(QUESTION_TYPES).optional(),
    options: z.array(z.string().min(1)).optional(),
    required: z.boolean().optional(),
  }),
  output: Survey,
  entities: { consumes: ["survey"] },
  example: (f) => {
    const survey = f.survey({
      questions: [{ id: "q_score", text: "Old prompt", type: "text", options: [], required: false, branching: [] }],
    });
    return { surveyId: survey.id, questionId: "q_score", text: "How did we do?" };
  },
  handler: (a, { store, clock }) => {
    if (a.text === undefined && a.type === undefined && a.options === undefined && a.required === undefined) {
      throw new ActionError("INVALID", "Nothing to change: give at least one of text, type, options, required");
    }
    const survey = mustGet<Survey>(store, "surveys", a.surveyId, "survey");
    const current = questionOf(survey, a.questionId);
    draftOnly(survey);
    const next: SurveyQuestion = { ...current, options: [...current.options], branching: current.branching.map((branch) => ({ ...branch })) };
    if (a.text !== undefined) {
      const text = a.text.trim();
      if (!text) throw new ActionError("INVALID", "Question text can't be blank");
      if (survey.questions.some((question) => question.id !== current.id && question.text.toLowerCase() === text.toLowerCase())) {
        throw new ActionError("DUPLICATE", `This survey already has a question "${text}"`);
      }
      next.text = text;
    }
    if (a.type !== undefined) next.type = a.type;
    if (a.required !== undefined) next.required = a.required;
    if (a.options !== undefined) next.options = a.options;
    choiceNeedsOptions(next.type, next.options, next.text);
    for (const branch of next.branching) {
      try {
        checkBranch(survey, next, branch);
      } catch (error) {
        if (error instanceof ActionError) throw new ActionError("CONFLICT", `${error.message}; clear its branching first (M19.A06)`);
        throw error;
      }
    }
    if (JSON.stringify(next) === JSON.stringify(current)) throw new ActionError("CONFLICT", "The record already has that value");
    return store.update<Survey>("surveys", survey.id, {
      questions: survey.questions.map((question) => (question.id === current.id ? next : question)),
      updatedAt: iso(clock),
    });
  },
});

const setBranching = defineAction({
  id: "M19.A06",
  description: "Defines skip logic so the next question shown depends on a respondent's answer. Controls the flow between questions, not their content.",
  risk: "write",
  input: z.strictObject({ surveyId: SurveyId, questionId: QuestionId, branching: z.array(BranchInput) }),
  output: Survey,
  entities: { consumes: ["survey"] },
  example: (f) => {
    const survey = f.survey({
      questions: [
        { id: "q_start", text: "Continue?", type: "yes_no", options: [], required: true, branching: [] },
        { id: "q_next", text: "Tell us more", type: "text", options: [], required: false, branching: [] },
      ],
    });
    return { surveyId: survey.id, questionId: "q_start", branching: [{ ifAnswer: "no", goTo: "end" }] };
  },
  handler: ({ surveyId, questionId, branching }, { store, clock }) => {
    const survey = mustGet<Survey>(store, "surveys", surveyId, "survey");
    const current = questionOf(survey, questionId);
    draftOnly(survey);
    const seen = new Set<string>();
    for (const branch of branching) {
      checkBranch(survey, current, branch);
      const key = JSON.stringify(branch.ifAnswer);
      if (seen.has(key)) throw new ActionError("CONFLICT", "Two branches use the same answer");
      seen.add(key);
    }
    if (JSON.stringify(current.branching) === JSON.stringify(branching)) throw new ActionError("CONFLICT", "The record already has that value");
    const questions = survey.questions.map((question) => (question.id === current.id ? { ...question, branching } : question));
    return store.update<Survey>("surveys", survey.id, { questions, updatedAt: iso(clock) });
  },
});

const publishSurvey = defineAction({
  id: "M19.A07",
  description: "Makes a draft survey live so respondents can answer it. Opposite of Close survey, which stops collecting answers. Unlike M18.A08 Publish form, this opens a survey rather than a form.",
  risk: "external",
  input: z.strictObject({ surveyId: SurveyId }),
  output: Survey,
  siblings: ["M18.A08"],
  entities: { consumes: ["survey"] },
  example: (f) => ({
    surveyId: f.survey({
      questions: [{ id: "q_score", text: "How did we do?", type: "text", options: [], required: false, branching: [] }],
    }).id,
  }),
  handler: ({ surveyId }, { store, clock }) => {
    const survey = mustGet<Survey>(store, "surveys", surveyId, "survey");
    requireState(`Survey "${survey.name}"`, survey.status, ["draft"], "be published");
    const errors = surveyErrors(survey);
    if (errors.length) throw new ActionError("CONFLICT", `Fix the survey before publishing: ${errors.join("; ")}`);
    const now = iso(clock);
    return store.update<Survey>("surveys", survey.id, { status: "open", publishedAt: now, updatedAt: now });
  },
});

const closeSurvey = defineAction({
  id: "M19.A08",
  description: "Stops a survey from accepting new responses while keeping existing answers. Opposite of Publish survey.",
  risk: "write",
  input: z.strictObject({ surveyId: SurveyId }),
  output: Survey,
  entities: { consumes: ["survey"] },
  example: (f) => ({
    surveyId: f.survey({
      status: "open",
      publishedAt: f.now(),
      questions: [{ id: "q_score", text: "How did we do?", type: "text", options: [], required: false, branching: [] }],
    }).id,
  }),
  handler: ({ surveyId }, { store, clock }) => {
    const survey = mustGet<Survey>(store, "surveys", surveyId, "survey");
    requireState(`Survey "${survey.name}"`, survey.status, ["open"], "be closed");
    const now = iso(clock);
    return store.update<Survey>("surveys", survey.id, { status: "closed", closedAt: now, updatedAt: now });
  },
});

const submitResponse = defineAction({
  id: "M19.A09",
  description: "Creates a test survey response with made-up answers to try out the flow and branching. Does not come from a real respondent. Unlike M18.A09 Submit simulated form response, this answers survey questions rather than filling form fields.",
  risk: "write",
  input: z.strictObject({
    surveyId: SurveyId,
    contactId: z.string().optional().describe("contact id (ct_…), if the respondent is known"),
    answers: z.record(z.string(), Answer),
  }),
  output: SurveyResponse,
  siblings: ["M18.A09"],
  entities: { consumes: ["survey", "contact"] },
  example: (f) => {
    const survey = f.survey({
      status: "open",
      publishedAt: f.now(),
      questions: [{ id: "q_comment", text: "Comment", type: "text", options: [], required: true, branching: [] }],
    });
    return { surveyId: survey.id, answers: { q_comment: "Great visit" } };
  },
  handler: (a, { store, clock }) => {
    const survey = mustGet<Survey>(store, "surveys", a.surveyId, "survey");
    requireState(`Survey "${survey.name}"`, survey.status, ["open"], "take responses");
    if (a.contactId) mustGet<Contact>(store, "contacts", a.contactId, "contact");
    const answers = walk(survey, a.answers);
    return store.insert("survey_responses", "svr", {
      surveyId: survey.id,
      contactId: a.contactId ?? null,
      answers,
      submittedAt: iso(clock),
    });
  },
});

function answerMatches(answer: AnswerValue, ifAnswer: string | number): boolean {
  if (Array.isArray(answer)) return answer.some((item) => item === ifAnswer || item === String(ifAnswer));
  if (typeof answer === "string" && (answer === "yes" || answer === "no") && typeof ifAnswer === "string") {
    return answer === ifAnswer.trim().toLowerCase();
  }
  return answer === ifAnswer || String(answer) === String(ifAnswer);
}

function normalize(question: SurveyQuestion, value: AnswerValue): AnswerValue {
  if (question.type === "yes_no") {
    if (typeof value !== "string" || !["yes", "no"].includes(value.trim().toLowerCase())) {
      throw new ActionError("INVALID", `Question "${question.text}" must be yes or no`);
    }
    return value.trim().toLowerCase();
  }
  if (question.type === "rating") {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new ActionError("INVALID", `Question "${question.text}" must be a number`);
    return value;
  }
  if (question.type === "single_choice") {
    if (typeof value !== "string" || !question.options.includes(value)) throw new ActionError("INVALID", `Question "${question.text}" must be one of the options`);
    return value;
  }
  if (question.type === "multi_choice") {
    if (!Array.isArray(value) || value.length === 0) throw new ActionError("INVALID", `Question "${question.text}" needs at least one option`);
    if (new Set(value).size !== value.length) throw new ActionError("INVALID", `Question "${question.text}" repeats an option`);
    if (value.some((item) => !question.options.includes(item))) throw new ActionError("INVALID", `Question "${question.text}" must use its options`);
    return value;
  }
  if (typeof value !== "string" || !value.trim()) throw new ActionError("INVALID", `Question "${question.text}" must be text`);
  return value.trim();
}

function walk(survey: Survey, raw: Record<string, AnswerValue>): Record<string, AnswerValue> {
  const index = new Map(survey.questions.map((question, position) => [question.id, position]));
  const stray = Object.keys(raw).find((id) => !index.has(id));
  if (stray) throw new ActionError("INVALID", `Survey ${survey.id} has no question ${stray}`);
  const answers: Record<string, AnswerValue> = {};
  const seen = new Set<string>();
  let cursor = 0;
  while (cursor < survey.questions.length) {
    const question = survey.questions[cursor];
    if (!question) break;
    if (seen.has(question.id)) throw new ActionError("CONFLICT", `Branching loops at question ${question.id}`);
    seen.add(question.id);
    const given = raw[question.id];
    const empty = given === undefined || given === "" || (Array.isArray(given) && given.length === 0);
    if (empty) {
      if (question.required) throw new ActionError("INVALID", `Question "${question.text}" is required`);
    } else {
      answers[question.id] = normalize(question, given as AnswerValue);
    }
    const stored = answers[question.id];
    const branch = stored === undefined ? undefined : question.branching.find((item) => answerMatches(stored, item.ifAnswer));
    if (!branch) {
      cursor += 1;
      continue;
    }
    if (branch.goTo === "end") break;
    const next = index.get(branch.goTo);
    if (next === undefined) throw new ActionError("CONFLICT", `Question "${question.text}" branches to unknown question ${branch.goTo}`);
    cursor = next;
  }
  return answers;
}

const Summary = z.object({
  surveyId: z.string(),
  name: z.string(),
  status: z.enum(["draft", "open", "closed"]),
  total: z.number(),
  questions: z.array(z.object({
    questionId: z.string(),
    text: z.string(),
    type: z.enum(QUESTION_TYPES),
    answered: z.number(),
    average: z.number().nullable(),
    breakdown: z.array(z.object({ answer: z.string(), count: z.number() })),
  })),
});

const summary = defineAction({
  id: "M19.A10",
  description: "Shows aggregated results for a survey, like response counts and answer breakdowns per question. Gives totals rather than the survey setup. Unlike M18.A10 List form submissions, this aggregates answers per question instead of listing each submission.",
  risk: "read",
  input: z.strictObject({ surveyId: SurveyId }),
  output: Summary,
  siblings: ["M18.A10"],
  entities: { produces: "report", consumes: ["survey"] },
  example: (f) => ({
    surveyId: f.survey({
      questions: [{ id: "q_score", text: "How did we do?", type: "rating", options: [], required: false, branching: [] }],
    }).id,
  }),
  handler: ({ surveyId }, { store }) => {
    const survey = mustGet<Survey>(store, "surveys", surveyId, "survey");
    const responses = store.find<SurveyResponse>("survey_responses", (row) => row.surveyId === survey.id);
    const questions = survey.questions.map((question) => {
      const counts = new Map<string, number>();
      let answered = 0;
      let sum = 0;
      let nums = 0;
      for (const response of responses) {
        const answer = response.answers[question.id];
        if (answer === undefined) continue;
        answered += 1;
        if (typeof answer === "number") {
          sum += answer;
          nums += 1;
          counts.set(String(answer), (counts.get(String(answer)) ?? 0) + 1);
        } else if (Array.isArray(answer)) {
          for (const item of answer) counts.set(item, (counts.get(item) ?? 0) + 1);
        } else {
          counts.set(answer, (counts.get(answer) ?? 0) + 1);
        }
      }
      const breakdown = [...counts.entries()].map(([answer, count]) => ({ answer, count }));
      breakdown.sort((a, b) => b.count - a.count || a.answer.localeCompare(b.answer));
      return {
        questionId: question.id,
        text: question.text,
        type: question.type,
        answered,
        average: question.type === "rating" && nums > 0 ? Math.round((sum / nums) * 100) / 100 : null,
        breakdown,
      };
    });
    return { surveyId: survey.id, name: survey.name, status: survey.status, total: responses.length, questions };
  },
});

export default {
  actions: [createSurvey, getSurvey, listSurveys, addQuestion, updateQuestion, setBranching, publishSurvey, closeSurvey, submitResponse, summary],
} satisfies ModuleExports;
