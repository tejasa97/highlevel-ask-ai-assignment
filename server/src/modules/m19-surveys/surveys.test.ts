import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";
import type { Survey, SurveyResponse } from "./schema.js";

test("unknown input field is INVALID", async () => {
  const w = await testWorld();
  assert.equal(failure(() => w.call("M19.A01", { name: "NPS", madeUp: 1 })).code, "INVALID");
});

test("write actions refuse a bad call", async () => {
  const w = await testWorld();
  const draft = w.f.survey({
    name: "Guard",
    questions: [{ id: "q_one", text: "How did we do?", type: "text", options: [], required: false, branching: [] }],
  });
  const open = w.f.survey({
    name: "Open",
    status: "open",
    publishedAt: w.f.now(),
    questions: [{ id: "q_one", text: "Score", type: "text", options: [], required: false, branching: [] }],
  });
  assert.equal(failure(() => w.call("M19.A01", { name: "Guard" })).code, "DUPLICATE");
  assert.equal(failure(() => w.call("M19.A04", { surveyId: open.id, text: "Another", type: "text" })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M19.A05", { surveyId: open.id, questionId: "q_one", text: "Changed" })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M19.A06", { surveyId: open.id, questionId: "q_one", branching: [] })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M19.A07", { surveyId: w.f.survey({ name: "Empty" }).id })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M19.A08", { surveyId: draft.id })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M19.A09", { surveyId: draft.id, answers: {} })).code, "CONFLICT");
});

test("responses are stored only while open, branching skips or ends, and the summary counts submitted answers", async () => {
  const w = await testWorld();
  let survey = w.call("M19.A01", { name: "Visit" }) as Survey;
  survey = w.call("M19.A04", { surveyId: survey.id, text: "Stay?", type: "yes_no", required: true });
  survey = w.call("M19.A04", { surveyId: survey.id, text: "Score", type: "rating" });
  survey = w.call("M19.A04", { surveyId: survey.id, text: "Comment", type: "text" });
  const [stay, score, comment] = survey.questions;
  survey = w.call("M19.A06", { surveyId: survey.id, questionId: stay!.id, branching: [{ ifAnswer: "no", goTo: "end" }] });
  assert.equal(failure(() => w.call("M19.A06", { surveyId: survey.id, questionId: stay!.id, branching: [{ ifAnswer: "no", goTo: "qu_missing" }] })).code, "NOT_FOUND");
  survey = w.call("M19.A07", { surveyId: survey.id });
  assert.equal(survey.status, "open");

  const ended = w.call("M19.A09", {
    surveyId: survey.id,
    answers: { [stay!.id]: "No", [score!.id]: 1, [comment!.id]: "ignored" },
  }) as SurveyResponse;
  assert.deepEqual(ended.answers, { [stay!.id]: "no" });

  const full = w.call("M19.A09", {
    surveyId: survey.id,
    answers: { [stay!.id]: "yes", [score!.id]: 4, [comment!.id]: "  fine  " },
  }) as SurveyResponse;
  assert.deepEqual(full.answers, { [stay!.id]: "yes", [score!.id]: 4, [comment!.id]: "fine" });

  w.call("M19.A09", { surveyId: survey.id, answers: { [stay!.id]: "YES", [score!.id]: 5 } });

  const report = w.call("M19.A10", { surveyId: survey.id }) as {
    total: number;
    questions: { questionId: string; answered: number; average: number | null; breakdown: { answer: string; count: number }[] }[];
  };
  assert.equal(report.total, 3);
  const byId = new Map(report.questions.map((question) => [question.questionId, question]));
  assert.equal(byId.get(stay!.id)?.answered, 3);
  assert.deepEqual(byId.get(stay!.id)?.breakdown, [
    { answer: "yes", count: 2 },
    { answer: "no", count: 1 },
  ]);
  assert.equal(byId.get(score!.id)?.answered, 2);
  assert.equal(byId.get(score!.id)?.average, 4.5);
  assert.equal(byId.get(comment!.id)?.answered, 1);
  assert.deepEqual(byId.get(comment!.id)?.breakdown, [{ answer: "fine", count: 1 }]);

  const jumped = w.call("M19.A01", { name: "Paths" }) as Survey;
  let paths = w.call("M19.A04", { surveyId: jumped.id, text: "Path", type: "single_choice", options: ["A", "B"], required: true }) as Survey;
  paths = w.call("M19.A04", { surveyId: paths.id, text: "Only B", type: "text" });
  paths = w.call("M19.A04", { surveyId: paths.id, text: "After", type: "text" });
  const [path, onlyB, after] = paths.questions;
  w.call("M19.A06", { surveyId: paths.id, questionId: path!.id, branching: [{ ifAnswer: "A", goTo: after!.id }] });
  paths = w.call("M19.A07", { surveyId: paths.id });
  const skipped = w.call("M19.A09", { surveyId: paths.id, answers: { [path!.id]: "A", [onlyB!.id]: "nope", [after!.id]: "landed" } }) as SurveyResponse;
  assert.deepEqual(Object.keys(skipped.answers), [path!.id, after!.id]);
  assert.equal(skipped.answers[after!.id], "landed");

  paths = w.call("M19.A08", { surveyId: paths.id });
  assert.equal(paths.status, "closed");
  assert.ok(paths.closedAt);
  assert.equal(failure(() => w.call("M19.A09", { surveyId: paths.id, answers: { [path!.id]: "B", [onlyB!.id]: "still here" } })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M19.A08", { surveyId: paths.id })).code, "CONFLICT");
});
