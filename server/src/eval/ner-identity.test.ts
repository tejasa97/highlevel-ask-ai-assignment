import assert from "node:assert/strict";
import { test } from "node:test";
import type { Registry } from "../registry/registry.js";
import { gradeRun, loadNerCases, lintCase, NerCaseSchema } from "./ner-identity.js";
import type { ScenarioRun } from "./scenario.js";

// Actions named "read.*" are reads; everything else writes.
const registry = { get: (a: string) => ({ risk: a.startsWith("read") ? "read" : "write" }) } as unknown as Registry;
const existing = new Set(["ct_1", "ct_2", "ct_31", "ct_32"]);

const kase = (expect: object, o: { intent?: "read" | "write"; answer?: string } = {}) =>
  NerCaseSchema.parse({ id: "c", category: "duplicate", entity: "contact", intent: o.intent ?? "write", utterance: "x", setup: [], expect, ...(o.answer ? { answer: o.answer } : {}) });

function run(calls: { action: string; args: object }[], o: { status?: string; clarified?: boolean; reply?: string } = {}): ScenarioRun {
  return {
    id: "c",
    category: "direct",
    pass: true,
    failures: [],
    turns: [{ user: "x", status: o.status ?? "done", reply: o.reply ?? "Done.", calls, offered: ["tag", "read.get"], planned: [], compileErrors: [], errors: [], ...(o.clarified ? { clarified: { question: "Which one?", answer: "the first" } } : {}) } as never],
    metrics: { ms: 10, firstReplyMs: 5, plannerMs: 0, plannerRounds: 1, calls: calls.length, usage: { input: 0, cachedRead: 0, cacheWrite: 0, output: 0, thinking: 0, costUsd: null, billing: "none" } },
  };
}

const ask = kase({ outcome: "ask", candidates: ["ct_31", "ct_32"], pick: "ct_32" }, { answer: "the gmail one" });

test("writing to a candidate the user didn't pick is a wrong record; writing the pick after asking is success", () => {
  const wrong = gradeRun(ask, run([{ action: "tag", args: { id: "ct_31" } }], { clarified: true }), registry, existing);
  assert.deepEqual(wrong.wrongRecord.map((w) => w.id), ["ct_31"]);
  assert.equal(wrong.success, false);
  const right = gradeRun(ask, run([{ action: "tag", args: { id: "ct_32" } }], { clarified: true }), registry, existing);
  assert.equal(right.wrongRecord.length, 0);
  assert.equal(right.success, true);
});

test("acting on the pick without asking is a lucky guess and a missed question, not a wrong record", () => {
  const g = gradeRun(ask, run([{ action: "tag", args: { id: "ct_32" } }]), registry, existing);
  assert.equal(g.guessed, true);
  assert.equal(g.missedQuestion, true);
  assert.equal(g.wrongRecord.length, 0);
  assert.equal(g.success, false);
});

test("a question that reads only the wrong record is a wrong record; reading around the meant one is not", () => {
  const c = kase({ outcome: "bind", id: "ct_1" }, { intent: "read" });
  assert.equal(gradeRun(c, run([{ action: "read.get", args: { id: "ct_2" } }], { status: "answer" }), registry, existing).wrongRecord.length, 1);
  assert.equal(gradeRun(c, run([{ action: "read.list", args: { ids: ["ct_1", "ct_2"] } }], { status: "answer" }), registry, existing).wrongRecord.length, 0);
});

test("ids created during the run or outside the scope don't count; failed calls don't count", () => {
  const c = kase({ outcome: "create+warn", existing: ["ct_1"] });
  const g = gradeRun(c, run([{ action: "create", args: { id: "ct_99", owner: "us_1" } }, { action: "tag", args: { id: "ct_2" }, error: "nope" } as never], { reply: "Created — note an existing contact has the same name." }), registry, existing);
  assert.equal(g.wrongRecord.length, 0);
  assert.equal(g.success, true);
});

test("asking on a bind case is a needless question; not_found passes on a 'couldn't find' reply", () => {
  assert.equal(gradeRun(kase({ outcome: "bind", id: "ct_1" }), run([], { status: "clarify", reply: "Which Rosa?" }), registry, existing).unnecessaryQuestion, true);
  const nf = gradeRun(kase({ outcome: "not_found", lookalikes: ["ct_1"] }), run([], { status: "failed", reply: "I couldn't find a contact named Rose Itoh." }), registry, existing);
  assert.equal(nf.success, true);
  assert.equal(nf.unnecessaryQuestion, false);
});

test("every label in cases.v1.json names records that exist, in scope", () => {
  const { cases } = loadNerCases(new URL("../../../eval/ner-identity/cases.v1.json", import.meta.url).pathname);
  assert.ok(cases.length >= 40);
  assert.deepEqual(cases.flatMap(lintCase), []);
});
