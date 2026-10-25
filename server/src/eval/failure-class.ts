import type { Failure, TurnTrace } from "./scenario.js";

// One tag per failing run, so a suite result can be read without replaying every plan. The tag names the
// first system layer that went wrong, from the outside in: what the model said, what the compiler made of it,
// what retrieval offered, and only then how the run ended.

export type FailureClass =
  | "retrieval-miss"
  | "ref-grammar"
  | "read-only-plan"
  | "schema"
  | "clarification"
  | "ambiguity-fanout"
  | "runtime-no-match"
  | "other";

export const FAILURE_CLASSES: FailureClass[] = [
  "retrieval-miss",
  "ref-grammar",
  "read-only-plan",
  "schema",
  "clarification",
  "ambiguity-fanout",
  "runtime-no-match",
  "other",
];

export interface ClassifyInput {
  category: string;
  /** Action ids the scenario requires. */
  expectedActions: string[];
  failures: Failure[];
  turns: Pick<TurnTrace, "status" | "reply" | "offered" | "planned" | "compileErrors" | "errors" | "calls">[];
}

const REF_GRAMMAR =
  /not an earlier step|not a valid \$ref|only works inside forEach|needs "roundRobin"|duplicate step id|is reserved|is already the list of records|has no field|is not a list|is not a step/;
const READ_ONLY = /only finds records|calls no action/i;
const RUNTIME_NO_MATCH =
  /NOT_FOUND|no .{0,60}matches|has no output|returned nothing|found nothing|no items|0 items|has 0 items|no \[\d+\]|is empty, so/i;

/** The first failing layer, or null for a passing/infra run (callers only pass failing runs). */
export function classifyFailure(input: ClassifyInput): FailureClass | null {
  const { turns, failures, expectedActions, category } = input;
  if (!failures.length) return null;
  const last = turns.at(-1);
  const compile = turns.flatMap((t) => t.compileErrors);
  const replies = turns.map((t) => t.reply).join("\n");
  const errors = turns.flatMap((t) => t.errors).join("\n");
  const callErrors = turns.flatMap((t) => t.calls.map((c) => c.error ?? "")).join("\n");

  if (last?.status === "clarify" || last?.status === "needs_clarification") return "clarification";
  if (/didn't match submit_plan|submit_plan/i.test(`${replies}\n${errors}`)) return "schema";
  if (compile.some((e) => REF_GRAMMAR.test(e))) return "ref-grammar";
  if (compile.some((e) => READ_ONLY.test(e))) return "read-only-plan";

  const missing = new Set(
    failures.filter((f) => f.kind === "action-missing").flatMap((f) => expectedActions.filter((id) => f.detail.includes(id))),
  );
  const offered = new Set(turns.flatMap((t) => t.offered));
  if (missing.size && [...missing].every((id) => !offered.has(id))) return "retrieval-miss";

  if (RUNTIME_NO_MATCH.test(`${callErrors}\n${errors}`)) return "runtime-no-match";
  if (category === "ambiguous") return "ambiguity-fanout";
  return "other";
}
