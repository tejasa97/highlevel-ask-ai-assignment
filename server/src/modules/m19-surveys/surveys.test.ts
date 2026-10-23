import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";
import type { Survey, SurveyResponse } from "./schema.js";

async function guardedSurveys() {
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
  return { w, draft, open };
}

// A yes/no question that ends the survey on "no", a rating and a comment; open for responses.
async function visitSurvey() {
  const w = await testWorld();
  let survey = w.call("M19.A01", { name: "Visit" }) as Survey;
  survey = w.call("M19.A04", { surveyId: survey.id, text: "Stay?", type: "yes_no", required: true });
  survey = w.call("M19.A04", { surveyId: survey.id, text: "Score", type: "rating" });
  survey = w.call("M19.A04", { surveyId: survey.id, text: "Comment", type: "text" });
  const [stay, score, comment] = survey.questions;
  survey = w.call("M19.A06", { surveyId: survey.id, questionId: stay!.id, branching: [{ ifAnswer: "no", goTo: "end" }] });
  survey = w.call("M19.A07", { surveyId: survey.id });
  return { w, survey, stay: stay!, score: score!, comment: comment! };
}

// A single-choice question that jumps from "A" over "Only B" to "After"; open for responses.
async function pathsSurvey() {
  const w = await testWorld();
  const created = w.call("M19.A01", { name: "Paths" }) as Survey;
  let paths = w.call("M19.A04", { surveyId: created.id, text: "Path", type: "single_choice", options: ["A", "B"], required: true }) as Survey;
  paths = w.call("M19.A04", { surveyId: paths.id, text: "Only B", type: "text" });
  paths = w.call("M19.A04", { surveyId: paths.id, text: "After", type: "text" });
  const [path, onlyB, after] = paths.questions;
  w.call("M19.A06", { surveyId: paths.id, questionId: path!.id, branching: [{ ifAnswer: "A", goTo: after!.id }] });
  paths = w.call("M19.A07", { surveyId: paths.id });
  return { w, paths, path: path!, onlyB: onlyB!, after: after! };
}

test("M19.A01 unknown input field is INVALID", async () => {
  const w = await testWorld();
  assert.equal(failure(() => w.call("M19.A01", { name: "NPS", madeUp: 1 })).code, "INVALID");
});

test("M19.A01 create refuses a duplicate name", async () => {
  const { w } = await guardedSurveys();
  assert.equal(failure(() => w.call("M19.A01", { name: "Guard" })).code, "DUPLICATE");
});

test("M19.A04 add question is refused once the survey is open", async () => {
  const { w, open } = await guardedSurveys();
  assert.equal(failure(() => w.call("M19.A04", { surveyId: open.id, text: "Another", type: "text" })).code, "CONFLICT");
});

test("M19.A05 edit question is refused once the survey is open", async () => {
  const { w, open } = await guardedSurveys();
  assert.equal(failure(() => w.call("M19.A05", { surveyId: open.id, questionId: "q_one", text: "Changed" })).code, "CONFLICT");
});

test("M19.A06 branching is refused once the survey is open", async () => {
  const { w, open } = await guardedSurveys();
  assert.equal(failure(() => w.call("M19.A06", { surveyId: open.id, questionId: "q_one", branching: [] })).code, "CONFLICT");
});

test("M19.A06 branching to a question that does not exist is NOT_FOUND", async () => {
  const w = await testWorld();
  let survey = w.call("M19.A01", { name: "Visit" }) as Survey;
  survey = w.call("M19.A04", { surveyId: survey.id, text: "Stay?", type: "yes_no", required: true });
  const stay = survey.questions[0]!;
  assert.equal(failure(() => w.call("M19.A06", { surveyId: survey.id, questionId: stay.id, branching: [{ ifAnswer: "no", goTo: "qu_missing" }] })).code, "NOT_FOUND");
});

test("M19.A07 open refuses a survey with no questions", async () => {
  const { w } = await guardedSurveys();
  assert.equal(failure(() => w.call("M19.A07", { surveyId: w.f.survey({ name: "Empty" }).id })).code, "CONFLICT");
});

test("M19.A08 close refuses a survey that is still a draft", async () => {
  const { w, draft } = await guardedSurveys();
  assert.equal(failure(() => w.call("M19.A08", { surveyId: draft.id })).code, "CONFLICT");
});

test("M19.A09 respond refuses a survey that is still a draft", async () => {
  const { w, draft } = await guardedSurveys();
  assert.equal(failure(() => w.call("M19.A09", { surveyId: draft.id, answers: {} })).code, "CONFLICT");
});

test("M19.A07 open makes the survey take responses", async () => {
  const { survey } = await visitSurvey();
  assert.equal(survey.status, "open");
});

test("M19.A09 a branch to the end drops the answers after it", async () => {
  const { w, survey, stay, score, comment } = await visitSurvey();
  const ended = w.call("M19.A09", {
    surveyId: survey.id,
    answers: { [stay.id]: "No", [score.id]: 1, [comment.id]: "ignored" },
  }) as SurveyResponse;
  assert.deepEqual(ended.answers, { [stay.id]: "no" });
});

test("M19.A09 a full response is stored with text trimmed", async () => {
  const { w, survey, stay, score, comment } = await visitSurvey();
  const full = w.call("M19.A09", {
    surveyId: survey.id,
    answers: { [stay.id]: "yes", [score.id]: 4, [comment.id]: "  fine  " },
  }) as SurveyResponse;
  assert.deepEqual(full.answers, { [stay.id]: "yes", [score.id]: 4, [comment.id]: "fine" });
});

test("M19.A10 the summary counts submitted answers only", async () => {
  const { w, survey, stay, score, comment } = await visitSurvey();
  w.call("M19.A09", { surveyId: survey.id, answers: { [stay.id]: "No", [score.id]: 1, [comment.id]: "ignored" } });
  w.call("M19.A09", { surveyId: survey.id, answers: { [stay.id]: "yes", [score.id]: 4, [comment.id]: "  fine  " } });
  w.call("M19.A09", { surveyId: survey.id, answers: { [stay.id]: "YES", [score.id]: 5 } });

  const report = w.call("M19.A10", { surveyId: survey.id }) as {
    total: number;
    questions: { questionId: string; answered: number; average: number | null; breakdown: { answer: string; count: number }[] }[];
  };
  assert.equal(report.total, 3);
  const byId = new Map(report.questions.map((question) => [question.questionId, question]));
  assert.equal(byId.get(stay.id)?.answered, 3);
  assert.deepEqual(byId.get(stay.id)?.breakdown, [
    { answer: "yes", count: 2 },
    { answer: "no", count: 1 },
  ]);
  assert.equal(byId.get(score.id)?.answered, 2);
  assert.equal(byId.get(score.id)?.average, 4.5);
  assert.equal(byId.get(comment.id)?.answered, 1);
  assert.deepEqual(byId.get(comment.id)?.breakdown, [{ answer: "fine", count: 1 }]);
});

test("M19.A09 a branch jumps over the questions in between", async () => {
  const { w, paths, path, onlyB, after } = await pathsSurvey();
  const skipped = w.call("M19.A09", { surveyId: paths.id, answers: { [path.id]: "A", [onlyB.id]: "nope", [after.id]: "landed" } }) as SurveyResponse;
  assert.deepEqual(Object.keys(skipped.answers), [path.id, after.id]);
  assert.equal(skipped.answers[after.id], "landed");
});

test("M19.A06 branches only skip ahead", async () => {
  const w = await testWorld();
  const created = w.call("M19.A01", { name: "Order" }) as Survey;
  let survey = w.call("M19.A04", { surveyId: created.id, text: "First", type: "yes_no" }) as Survey;
  survey = w.call("M19.A04", { surveyId: survey.id, text: "Second", type: "yes_no" });
  const [first, second] = survey.questions;
  const err = failure(() => w.call("M19.A06", { surveyId: survey.id, questionId: second!.id, branching: [{ ifAnswer: "yes", goTo: first!.id }] }));
  assert.equal(err.code, "CONFLICT");
  assert.match(err.message, /skip ahead/);
  assert.equal((w.call("M19.A06", { surveyId: survey.id, questionId: first!.id, branching: [{ ifAnswer: "yes", goTo: second!.id }] }) as Survey).questions[0]!.branching.length, 1);
});

test("M19.A05 changing a question can't leave its branching invalid", async () => {
  const w = await testWorld();
  const created = w.call("M19.A01", { name: "Retype" }) as Survey;
  let survey = w.call("M19.A04", { surveyId: created.id, text: "Pick", type: "single_choice", options: ["A", "B"] }) as Survey;
  survey = w.call("M19.A04", { surveyId: survey.id, text: "After", type: "text" });
  const [pick, after] = survey.questions;
  w.call("M19.A06", { surveyId: survey.id, questionId: pick!.id, branching: [{ ifAnswer: "A", goTo: after!.id }] });
  const dropped = failure(() => w.call("M19.A05", { surveyId: survey.id, questionId: pick!.id, options: ["B", "C"] }));
  assert.equal(dropped.code, "CONFLICT");
  assert.match(dropped.message, /clear its branching first/);
  assert.equal(failure(() => w.call("M19.A05", { surveyId: survey.id, questionId: pick!.id, type: "yes_no" })).code, "CONFLICT");
  w.call("M19.A06", { surveyId: survey.id, questionId: pick!.id, branching: [] });
  assert.deepEqual((w.call("M19.A05", { surveyId: survey.id, questionId: pick!.id, options: ["B", "C"] }) as Survey).questions[0]!.options, ["B", "C"]);
});

test("M19.A09 answers for questions the survey doesn't have are refused", async () => {
  const { w, paths, path } = await pathsSurvey();
  const err = failure(() => w.call("M19.A09", { surveyId: paths.id, answers: { [path.id]: "B", qu_typo: "x" } }));
  assert.equal(err.code, "INVALID");
  assert.match(err.message, /qu_typo/);
});

test("M19.A08 close stops responses, and closing twice conflicts", async () => {
  const { w, paths, path, onlyB } = await pathsSurvey();
  const closed = w.call("M19.A08", { surveyId: paths.id }) as Survey;
  assert.equal(closed.status, "closed");
  assert.ok(closed.closedAt);
  assert.equal(failure(() => w.call("M19.A09", { surveyId: paths.id, answers: { [path.id]: "B", [onlyB.id]: "still here" } })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M19.A08", { surveyId: paths.id })).code, "CONFLICT");
});
