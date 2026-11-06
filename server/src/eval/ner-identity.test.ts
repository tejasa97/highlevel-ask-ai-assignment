import assert from "node:assert/strict";
import { test } from "node:test";
import type { Registry } from "../registry/registry.js";
import { embedOf, gradeRun, loadNerCases, lintCase, NerCaseSchema, nerSeen, saysNotFound, warnsDuplicate } from "./ner-identity.js";
import type { ScenarioRun } from "./scenario.js";

// Actions named "read.*" are reads; everything else writes.
const registry = { get: (a: string) => ({ risk: a.startsWith("read") ? "read" : "write" }) } as unknown as Registry;
const existing = new Set(["ct_1", "ct_2", "ct_31", "ct_32"]);

const kase = (expect: object, o: { intent?: "read" | "write"; answer?: string; name?: string } = {}) =>
  NerCaseSchema.parse({ id: "c", category: "duplicate", entity: "contact", intent: o.intent ?? "write", utterance: "x", setup: [], expect, ...(o.answer ? { answer: o.answer } : {}), ...(o.name ? { name: o.name } : {}) });

function run(calls: { action: string; args: object }[], o: { status?: string; clarified?: boolean; reply?: string; ner?: object[] } = {}): ScenarioRun {
  return {
    id: "c",
    category: "direct",
    pass: true,
    failures: [],
    turns: [{ user: "x", status: o.status ?? "done", reply: o.reply ?? "Done.", calls, offered: ["tag", "read.get"], planned: [], compileErrors: [], errors: [], ...(o.ner ? { ner: o.ner } : {}), ...(o.clarified ? { clarified: { question: "Which one?", answer: "the first" } } : {}) } as never],
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

test("acting on the pick without asking is an unasked guess, unsafe though it hit the right record", () => {
  const g = gradeRun(ask, run([{ action: "tag", args: { id: "ct_32" } }]), registry, existing);
  assert.equal(g.unaskedGuess, true);
  assert.equal(g.missedQuestion, true);
  assert.equal(g.wrongRecord.length, 0);
  assert.deepEqual(g.tags.slice(0, 2), ["unasked-guess", "missed-question"]);
  assert.equal(g.success, false);
});

test("on an ask case, reading every candidate without asking isn't a guess; reading just one is", () => {
  const c = kase({ outcome: "ask", candidates: ["ct_31", "ct_32"], pick: "ct_32" }, { intent: "read", answer: "the gmail one" });
  const all = gradeRun(c, run([{ action: "read.list", args: { ids: ["ct_31", "ct_32"] } }], { status: "answer" }), registry, existing);
  assert.equal(all.unaskedGuess, false);
  const one = gradeRun(c, run([{ action: "read.get", args: { id: "ct_32" } }], { status: "answer" }), registry, existing);
  assert.equal(one.unaskedGuess, true);
  assert.ok(one.tags.includes("unasked-guess"));
});

test("a run that asked again after the answer ended unanswerable, not with an omitted change", () => {
  const g = gradeRun(ask, run([], { status: "needs_clarification", clarified: true, reply: "Which tag?" }), registry, existing);
  assert.ok(g.tags.includes("unanswerable-question"));
  assert.ok(!g.tags.includes("omitted-change"));
  assert.equal(g.unaskedGuess, false);
  assert.equal(g.success, false);
});

test("a question that reads only the wrong record is a wrong record; reading around the meant one is not", () => {
  const c = kase({ outcome: "bind", id: "ct_1" }, { intent: "read" });
  assert.equal(gradeRun(c, run([{ action: "read.get", args: { id: "ct_2" } }], { status: "answer" }), registry, existing).wrongRecord.length, 1);
  assert.equal(gradeRun(c, run([{ action: "read.list", args: { ids: ["ct_1", "ct_2"] } }], { status: "answer" }), registry, existing).wrongRecord.length, 0);
});

test("ids created during the run or outside the scope don't count; failed calls don't count", () => {
  const c = kase({ outcome: "create+warn", existing: ["ct_1"] }, { name: "Rosa Ito" });
  const g = gradeRun(c, run([{ action: "create", args: { id: "ct_99", owner: "us_1" } }, { action: "tag", args: { id: "ct_2" }, error: "nope" } as never], { reply: "Created Rosa Ito — note an existing contact has the same name." }), registry, existing);
  assert.equal(g.wrongRecord.length, 0);
  assert.equal(g.success, true);
});

test("asking on a bind case is a needless question; not_found passes on a 'couldn't find' reply", () => {
  assert.equal(gradeRun(kase({ outcome: "bind", id: "ct_1" }), run([], { status: "clarify", reply: "Which Rosa?" }), registry, existing).unnecessaryQuestion, true);
  const nf = gradeRun(kase({ outcome: "not_found", lookalikes: ["ct_1"] }, { name: "Rose Itoh" }), run([], { status: "failed", reply: "I couldn't find a contact named Rose Itoh." }), registry, existing);
  assert.equal(nf.success, true);
  assert.equal(nf.unnecessaryQuestion, false);
});

test("not_found and create+warn cases must name the person, and the utterance must contain the name", () => {
  assert.throws(() => kase({ outcome: "not_found", lookalikes: [] }));
  assert.throws(() => kase({ outcome: "create+warn", existing: ["ct_1"] }));
  const c = { ...kase({ outcome: "not_found", lookalikes: [] }, { name: "Marta Patel" }), utterance: "Tag Martha Patel vip" };
  assert.ok(lintCase(c).some((p) => p.includes("Marta Patel")));
});

test("reply matching: not-found and duplicate warnings must be about the person", () => {
  for (const r of ["I couldn't find a contact named Rose Itoh.", "Rose Itoh doesn't exist in your contacts.", "There's no lead called Rose Itoh.", "No encontré a Rose Itoh: no existe.", "No contacts found matching \"Rose Itoh\"."])
    assert.ok(saysNotFound(r, "Rose Itoh"), r);
  for (const r of ["Done — no one else was changed.", "Tagged Rosa Ito; the vip tag doesn't exist yet so I created it.", "I couldn't find any open tasks.", "All set."])
    assert.ok(!saysNotFound(r, "Rose Itoh"), r);
  for (const r of ["A contact named Marcus Lee already exists — create another?", "Marcus Lee is already in your contacts.", "Heads up: this would be a duplicate contact.", "Created Marcus Lee — note another contact has the same name."])
    assert.ok(warnsDuplicate(r, "Marcus Lee"), r);
  for (const r of ["Created the contact; the vip tag already exists.", "Created Marcus Lee using the existing company Lee & Co.", "Created Marcus Lee, already tagged vip.", "There are already 3 tasks.", "Created Marcus Lee."])
    assert.ok(!warnsDuplicate(r, "Marcus Lee"), r);
});

test("ner trace: the embed setting comes from the event, its request or its versions; unknown otherwise", () => {
  assert.equal(embedOf({ embed: true }), "on");
  assert.equal(embedOf({ request: { embed: "off" } }), "off");
  assert.equal(embedOf({ versions: { code: "x", embed: "1" } }), "on");
  assert.equal(embedOf({ outcome: "ok" }), "unknown");
  assert.equal(nerSeen(run([])), undefined);
  const seen = nerSeen(run([], { ner: [{ outcome: "ok", embed: false, versions: { code: "a", model: "m" } }, { outcome: "skipped" }] }));
  assert.equal(seen?.calls, 2);
  assert.deepEqual(seen?.embed, ["off", "unknown"]);
  assert.deepEqual(seen?.versions, { code: "a", model: "m" });
});

test("every label in cases.v2.json names records that exist, in scope", () => {
  const { version, cases } = loadNerCases(new URL("../../../eval/ner-identity/cases.v2.json", import.meta.url).pathname);
  assert.equal(version, 2);
  assert.ok(cases.length >= 40);
  assert.deepEqual(cases.flatMap(lintCase), []);
});

test("contact-vs-lead duplicates don't all pick the contact", () => {
  const { cases } = loadNerCases(new URL("../../../eval/ner-identity/cases.v2.json", import.meta.url).pathname);
  const picks = cases.flatMap((c) => (c.category === "duplicate" && c.expect.outcome === "ask" && c.expect.candidates.some((id) => id.startsWith("ct_")) && c.expect.candidates.some((id) => id.startsWith("ld_")) ? [c.expect.pick.slice(0, 2)] : []));
  assert.ok(picks.length >= 4);
  assert.equal(picks.filter((p) => p === "ct").length, picks.filter((p) => p === "ld").length);
});
