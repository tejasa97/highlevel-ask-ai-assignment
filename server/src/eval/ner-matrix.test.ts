import assert from "node:assert/strict";
import { test } from "node:test";
import type { NerGrade } from "./ner-identity.js";
import { cellEnv, embedProblem, envMismatch, MODELS, PIPELINES, readiness, SETUPS, skipReason, summarize } from "./ner-matrix.js";

const opt = (key: string, dim = SETUPS) => dim.find((o) => o.key === key)!;
const grade = (o: Partial<NerGrade> = {}) =>
  ({ id: "c", category: "duplicate", label: "ask", success: true, tags: [], wrongRecord: [], unaskedGuess: false, asked: false, ms: 10, messages: 1, modelCalls: 1, usage: { input: 0, cachedRead: 0, output: 0, thinking: 0, costUsd: null }, ...o }) as unknown as NerGrade;
const ner = (...embed: string[]) => ({ calls: embed.length, outcomes: embed.map(() => "ok"), embed });

test("1-off sets RESOLVER=off over an inherited RESOLVER=on, and the child sees the mismatch otherwise", () => {
  const want = cellEnv(opt("1-off"), opt("classic", PIPELINES), opt("luna", MODELS));
  assert.equal(want.RESOLVER, "off");
  assert.deepEqual(envMismatch(want, { ...{ RESOLVER: "on" }, ...want }), []);
  assert.deepEqual(envMismatch(want, { ...want, RESOLVER: "on" }), ["RESOLVER=on, want off"]);
  assert.deepEqual(envMismatch({ NER_EMBED: "off" }, {}), ["NER_EMBED=(unset), want off"]);
});

test("a staged pipeline this build lacks is pending F, not a build gap; a missing flag is a build gap", () => {
  const none = () => [] as string[];
  assert.equal(skipReason([opt("4-embed"), opt("classic", PIPELINES)], none), undefined);
  const all = (o: { requires: string[] }) => o.requires;
  assert.deepEqual(skipReason([opt("1-off"), opt("staged", PIPELINES)], all), { kind: "pending", reason: "pending F (orchestration adds PLANNER_PIPELINE=staged)" });
  assert.deepEqual(skipReason([opt("3-gliner"), opt("classic", PIPELINES)], (o) => o.requires.filter((f) => f === "NER_EMBED")), { kind: "missing", reason: "this build reads no NER_EMBED" });
});

test("the NER embed check: every ner call must report the setup's setting", () => {
  assert.equal(embedProblem(undefined, [grade()]), undefined);
  assert.equal(embedProblem("on", [grade({ ner: ner("on", "on") }), grade({ ner: ner("on") })]), undefined);
  assert.match(embedProblem("off", [grade({ ner: ner("off", "on") })])!, /1\/2 ner calls reported embed on/);
  assert.match(embedProblem("on", [grade({ ner: ner("unknown") })])!, /reported embed unknown/);
  assert.match(embedProblem("on", [grade()])!, /no run reported a ner call/);
  assert.equal(embedProblem("on", [grade({ infra: "rate_limited" } as never)]), undefined);
});

test("/health/ready: 200 is ready with its versions; anything else says why", () => {
  assert.deepEqual(readiness(200, { ok: true, versions: { code: "c1", model: "m1" } }), { ready: true, versions: { code: "c1", model: "m1" } });
  assert.deepEqual(readiness(200, undefined), { ready: true });
  assert.deepEqual(readiness(503, { ok: false, error: "index loading" }), { ready: false, reason: "HTTP 503: index loading" });
});

test("summary counts unasked guesses apart from wrong records, and ner calls by embed", () => {
  const s = summarize([
    grade({ id: "a", success: false, unaskedGuess: true, observed: "tag ct_32", tags: ["unasked-guess", "missed-question"], ner: { ...ner("on"), versions: { code: "c1" } } } as never),
    grade({ id: "b", success: false, wrongRecord: [{ id: "ct_1", how: "write", why: "x" }] as never, tags: ["wrong-record"], ner: ner("on", "off") }),
    grade({ id: "c" }),
  ]);
  assert.equal(s.unaskedGuessRuns, 1);
  assert.deepEqual(s.unaskedGuesses, ["a: tag ct_32"]);
  assert.equal(s.wrongRecordRuns, 1);
  assert.equal(s.failuresByCause["unasked-guess"], 1);
  assert.deepEqual(s.ner.embed, { on: 2, off: 1 });
  assert.deepEqual(s.ner.versions, [{ code: "c1" }]);
});
