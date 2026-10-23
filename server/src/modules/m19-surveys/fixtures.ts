import { Fixtures, type Input } from "../../store/fixtures.js";
import { Survey, SurveyResponse } from "./schema.js";

declare module "../../store/fixtures.js" {
  interface Fixtures {
    survey(o?: Input<Survey>): Survey;
    surveyResponse(o?: Input<SurveyResponse>): SurveyResponse;
  }
}

Fixtures.prototype.survey = function (this: Fixtures, o: Input<Survey> = {}): Survey {
  const n = this.seq();
  return this.make("surveys", "sv", Survey, {
    name: `Survey ${n}`,
    questions: [],
    status: "draft",
    createdAt: this.now(),
    updatedAt: this.now(),
    publishedAt: null,
    closedAt: null,
    ...o,
  });
};

Fixtures.prototype.surveyResponse = function (this: Fixtures, o: Input<SurveyResponse> = {}): SurveyResponse {
  return this.make("survey_responses", "svr", SurveyResponse, {
    surveyId: o.surveyId ?? this.survey().id,
    contactId: null,
    answers: {},
    submittedAt: this.now(),
    ...o,
  });
};
