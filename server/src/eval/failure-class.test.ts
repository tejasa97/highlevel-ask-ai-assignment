import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Failure, TurnTrace } from "./scenario.js";
import { classifyFailure, type ClassifyInput } from "./failure-class.js";

const turn = (over: Partial<Pick<TurnTrace, "status" | "reply" | "offered" | "planned" | "compileErrors" | "errors" | "calls">> = {}) => ({
  status: "done",
  reply: "Done.",
  offered: ["M06.A01"],
  planned: ["M06.A01"],
  compileErrors: [],
  errors: [],
  calls: [] as { action: string; args: Record<string, unknown>; error?: string }[],
  ...over,
});

const input = (over: Partial<ClassifyInput> = {}): ClassifyInput => ({
  category: "direct",
  expectedActions: ["M06.A01"],
  failures: [{ kind: "state", detail: "wrong" }],
  turns: [turn()],
  ...over,
});

describe("classifyFailure", () => {
  test("a passing run has no class", () => {
    assert.equal(classifyFailure(input({ failures: [] })), null);
  });

  test("a question where an action was expected is clarification", () => {
    assert.equal(classifyFailure(input({ turns: [turn({ status: "clarify" })] })), "clarification");
    assert.equal(classifyFailure(input({ turns: [turn({ status: "needs_clarification" })] })), "clarification");
  });

  test("a reply that fails submit_plan is schema", () => {
    assert.equal(classifyFailure(input({ turns: [turn({ status: "failed", reply: "The planner's reply didn't match submit_plan: bad" })] })), "schema");
  });

  test("invented refs and ref-shape errors are ref-grammar", () => {
    for (const error of [
      "step s2: $looked is not an earlier step (refs can only point back)",
      'step s1: "[\"tic_1\"]" is not a valid $ref',
      "step s2: $item only works inside forEach \"do\"",
      'step s3: "in" $s2.members is not a list',
    ])
      assert.equal(classifyFailure(input({ turns: [turn({ status: "failed", compileErrors: [error] })] })), "ref-grammar", error);
  });

  test("a read-only plan that never became a plan is read-only-plan", () => {
    const errors = ["the plan only finds records and calls no action; add the actions that do what was asked"];
    assert.equal(classifyFailure(input({ turns: [turn({ status: "failed", compileErrors: errors })] })), "read-only-plan");
  });

  test("a required action that retrieval never offered is retrieval-miss", () => {
    const failures: Failure[] = [{ kind: "action-missing", detail: "M49.A05 not planned (not offered; planned: M49.A03)" }];
    assert.equal(classifyFailure(input({ expectedActions: ["M49.A05"], failures, turns: [turn({ offered: ["M49.A03"], planned: ["M49.A03"] })] })), "retrieval-miss");
  });

  test("an offered action that was not used is not a retrieval miss", () => {
    const failures: Failure[] = [{ kind: "action-missing", detail: "M49.A05 not planned (was offered; planned: M49.A03)" }];
    assert.equal(classifyFailure(input({ expectedActions: ["M49.A05"], failures, turns: [turn({ offered: ["M49.A03", "M49.A05"], planned: ["M49.A03"] })] })), "other");
  });

  test("a lookup that found nothing at run time is runtime-no-match", () => {
    const failures: Failure[] = [{ kind: "action-missing", detail: "M04.A03 not planned (was offered; planned: M04.A03)" }];
    const calls = [{ action: "M04.A03", args: { query: "Soylent Pro" }, error: "NOT_FOUND: no opportunity matches \"Soylent Pro\"" }];
    assert.equal(classifyFailure(input({ expectedActions: [], failures, turns: [turn({ calls })] })), "runtime-no-match");
  });

  test("an ambiguous name acted on without a question is ambiguity-fanout", () => {
    assert.equal(classifyFailure(input({ category: "ambiguous" })), "ambiguity-fanout");
  });

  test("an unexplained failure is other", () => {
    assert.equal(classifyFailure(input()), "other");
  });
});
