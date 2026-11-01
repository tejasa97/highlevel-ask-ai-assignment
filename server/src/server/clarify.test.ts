import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type CompiledPlan, planDigest } from "../core/compile.js";
import type { RankedCandidate } from "../core/identity.js";
import { Clarifications, matchCandidates, type OpenInput, readsAsRequest } from "./clarify.js";

// The stored record question, without a planner or a store: each transition, tokens, matching and expiry.

const sarahs: RankedCandidate[] = [
  { id: "ct_31", name: "Sarah Johnson", detail: "sarah.johnson@brightside.example, Brightside", matchReason: "exact-name", score: 1 },
  { id: "ct_32", name: "Sarah Johnson", detail: "sjohnson@gmail.example", matchReason: "exact-name", score: 1 },
];
const keys = { ct_31: ["sarah.johnson@brightside.example"], ct_32: ["sjohnson@gmail.example"] };
const plan = { hash: "plan_h1", steps: [] } as unknown as CompiledPlan;
const input = (over: Partial<OpenInput> = {}): OpenInput => ({
  source: "lookup", plan, request: "Rename Sarah Johnson", said: "Rename Sarah Johnson", ranked: sarahs, keys,
  turnId: "t1", stepId: "s1", argument: "contactId", resolution: { entity: "contact", text: "Sarah Johnson", candidates: sarahs }, ...over,
});
const clock = (start = 1_000) => {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};
const store = (c = clock()) => new Clarifications({ ttlMs: 60_000, maxRounds: 2 }, c.now);

describe("opening a question", () => {
  test("stores the record awaiting, with its plan, step, argument and opaque tokens", () => {
    const s = store();
    const c = s.open(input());
    assert.equal(c.status, "awaiting");
    assert.equal(c.planHash, planDigest(plan));
    assert.equal(c.stepId, "s1");
    assert.equal(c.argument, "contactId");
    assert.equal(c.round, 1);
    assert.equal(c.expiresAt, 61_000);
    assert.deepEqual(c.candidates.map((o) => o.id), ["ct_31", "ct_32"]);
    for (const o of c.candidates) {
      assert.doesNotMatch(o.token, /ct_|sarah|johnson/i, "a token says nothing about the record");
      assert.ok(o.token.length >= 16);
    }
    assert.notEqual(c.candidates[0]!.token, c.candidates[1]!.token);
  });

  test("the view sent to the client has labels and tokens, never record ids", () => {
    const s = store();
    const v = s.view(s.open(input()));
    assert.doesNotMatch(JSON.stringify(v), /ct_3/);
    assert.deepEqual(v.options.map((o) => o.label), ["Sarah Johnson (sarah.johnson@brightside.example, Brightside)", "Sarah Johnson (sjohnson@gmail.example)"]);
  });

  test("a new question supersedes the one still awaiting", () => {
    const s = store();
    const a = s.open(input());
    const b = s.open(input({ turnId: "t2" }));
    assert.equal(s.get(a.id)!.status, "superseded");
    assert.equal(s.get(b.id)!.status, "awaiting");
    assert.equal(s.awaiting()!.record.id, b.id);
  });

  test("the record is frozen: status changes only through the store's methods", () => {
    const s = store();
    const c = s.open(input());
    assert.throws(() => ((c as { status: string }).status = "resolved"), TypeError);
    assert.throws(() => ((c.candidates as unknown as unknown[]).push({})), TypeError);
    assert.equal(s.get(c.id)!.status, "awaiting");
  });
});

describe("a click: clarificationId + optionToken", () => {
  test("a valid token resolves to that candidate, with the paused plan", () => {
    const s = store();
    const c = s.open(input());
    const a = s.choose(c.id, c.candidates[1]!.token);
    assert.equal(a.kind, "picked");
    assert.ok(a.kind === "picked" && a.candidate.id === "ct_32" && a.paused.plan === plan);
    assert.equal(s.get(c.id)!.status, "resolved");
    assert.equal(s.awaiting(), undefined);
  });

  test("an unknown token, a token of another question, or another conversation's id is refused and changes nothing", () => {
    const s = store(), other = store();
    const c = s.open(input());
    const elsewhere = other.open(input());
    assert.deepEqual(s.choose(c.id, "forged-token"), { kind: "refused", reason: "unknown option" });
    assert.deepEqual(s.choose(c.id, elsewhere.candidates[0]!.token), { kind: "refused", reason: "unknown option" });
    assert.deepEqual(s.choose(elsewhere.id, elsewhere.candidates[0]!.token), { kind: "refused", reason: "unknown clarification" });
    assert.deepEqual(s.choose(c.id, "ct_31"), { kind: "refused", reason: "unknown option" }, "a raw record id is not a token");
    assert.deepEqual(s.choose(c.id, c.candidates[0]!.label), { kind: "refused", reason: "unknown option" }, "nor is a label");
    assert.equal(s.get(c.id)!.status, "awaiting");
    assert.equal(other.get(elsewhere.id)!.status, "awaiting");
  });

  test("answering twice is idempotent: the second answer replays the first result", () => {
    const s = store();
    const c = s.open(input());
    assert.equal(s.choose(c.id, c.candidates[0]!.token).kind, "picked");
    // Still running: nothing to replay yet, and nothing runs again.
    assert.deepEqual(s.choose(c.id, c.candidates[0]!.token), { kind: "replay", clarification: s.get(c.id) });
    s.remember(c.id, { status: "done", text: "Renamed" });
    for (const token of [c.candidates[0]!.token, c.candidates[1]!.token]) {
      const again = s.choose(c.id, token);
      assert.equal(again.kind, "replay");
      assert.ok(again.kind === "replay" && (again.result as { text: string }).text === "Renamed");
    }
    assert.equal(s.get(c.id)!.status, "resolved");
  });

  test("none of these cancels; a later click replays the cancellation", () => {
    const s = store();
    const c = s.open(input());
    assert.equal(s.cancel(c.id).kind, "cancelled");
    assert.equal(s.get(c.id)!.status, "cancelled");
    s.remember(c.id, { status: "cancelled" });
    const later = s.choose(c.id, c.candidates[0]!.token);
    assert.ok(later.kind === "replay" && (later.result as { status: string }).status === "cancelled");
    assert.deepEqual(s.cancel("clr_nope"), { kind: "refused", reason: "unknown clarification" });
  });

  test("a click after expiry is expired, never a pick", () => {
    const k = clock();
    const s = store(k);
    const c = s.open(input());
    k.advance(60_000);
    assert.equal(s.choose(c.id, c.candidates[0]!.token).kind, "expired");
    assert.equal(s.get(c.id)!.status, "expired");
  });

  test("a resolved pick that failed revalidation is superseded, never reopened", () => {
    const s = store();
    const c = s.open(input());
    s.choose(c.id, c.candidates[0]!.token);
    s.replace(c.id);
    assert.equal(s.get(c.id)!.status, "superseded");
    assert.equal(s.choose(c.id, c.candidates[1]!.token).kind, "superseded");
  });
});

describe("an answer in the user's words", () => {
  test("is matched against the stored candidates: position, email, detail", () => {
    for (const [text, id] of [["the second one", "ct_32"], ["2", "ct_32"], ["first", "ct_31"], ["the last one", "ct_32"], ["sjohnson@gmail.example", "ct_32"], ["the one at Brightside", "ct_31"], ["Sarah Johnson (sjohnson@gmail.example)", "ct_32"], ["ct_31", "ct_31"]] as const) {
      const s = store();
      const c = s.open(input());
      const a = s.reply(text);
      assert.ok(a?.kind === "picked" && a.candidate.id === id, `${text} → ${JSON.stringify(a)}`);
      assert.equal(s.get(c.id)!.status, "resolved");
    }
  });

  test("matches nothing outside the list", () => {
    assert.deepEqual(matchCandidates("the third one", sarahs, keys), []);
    assert.deepEqual(matchCandidates("Ana Ruiz", sarahs, keys), []);
    assert.deepEqual(matchCandidates("Sarah Johnson", sarahs, keys).length, 2, "the shared name matches both");
    assert.deepEqual(matchCandidates("the Google listing", [{ id: "bl_1", name: "Maple Dental google", matchReason: "exact-name", score: 1 }, { id: "bl_2", name: "Maple Dental yelp", matchReason: "exact-name", score: 1 }]).map((c) => c.id), ["bl_1"]);
  });

  test("several or none ask again with round+1, then give up honestly after the cap", () => {
    const s = store();
    const c = s.open(input());
    const a = s.reply("Sarah Johnson");
    assert.ok(a?.kind === "again" && a.why === "several" && a.clarification.round === 2);
    assert.equal(s.get(c.id)!.status, "awaiting");
    assert.equal(s.get(c.id)!.round, 2);
    const b = s.reply("hmm");
    assert.equal(b?.kind, "gave_up");
    assert.equal(s.get(c.id)!.status, "cancelled");
    assert.equal(s.reply("the first one"), undefined, "nothing is open any more");
  });

  test("the round cap is configurable", () => {
    const s = new Clarifications({ ttlMs: 60_000, maxRounds: 3 }, () => 0);
    s.open(input());
    assert.equal(s.reply("hmm")?.kind, "again");
    assert.equal(s.reply("hmm")?.kind, "again");
    assert.equal(s.reply("hmm")?.kind, "gave_up");
  });

  test("'none of these' cancels with no pick", () => {
    for (const text of ["None of these", "neither", "none of them.", "cancel", "never mind"]) {
      const s = store();
      const c = s.open(input());
      assert.equal(s.reply(text)?.kind, "cancelled", text);
      assert.equal(s.get(c.id)!.status, "cancelled");
    }
  });

  test("a new request that mentions a candidate's detail supersedes the question, never picks", () => {
    const acme: RankedCandidate[] = [{ ...sarahs[0]!, detail: "Acme" }, { ...sarahs[1]!, detail: "Brightside" }];
    for (const text of ["Email Acme about the renewal", "Show me the deals at Brightside", "What does Brightside owe us?"]) {
      const s = store();
      const c = s.open(input({ ranked: acme, resolution: { entity: "contact", text: "Sarah", candidates: acme } }));
      assert.equal(s.reply(text)?.kind, "superseded", text);
      assert.equal(s.get(c.id)!.status, "superseded");
    }
    // Short, answer-shaped replies still pick, a question mark included.
    for (const [text, id] of [["the one at Acme", "ct_31"], ["the Brightside one?", "ct_32"], ["Acme", "ct_31"]] as const) {
      const s = store();
      s.open(input({ ranked: acme, resolution: { entity: "contact", text: "Sarah", candidates: acme } }));
      const a = s.reply(text);
      assert.ok(a?.kind === "picked" && a.candidate.id === id, `${text} → ${JSON.stringify(a)}`);
    }
  });

  test("the single-word fallback needs a distinctive word in a short answer", () => {
    const listings = (names: string[]): RankedCandidate[] => names.map((name, i) => ({ id: `bl_${i + 1}`, name, matchReason: "exact-name", score: 1 }));
    const three = listings(["Maple Dental google", "Maple Dental yelp", "Oak Dental yelp"]);
    assert.deepEqual(matchCandidates("the yelp listing", three), [], "a word two of them share picks neither");
    assert.deepEqual(matchCandidates("the oak listing", three).map((c) => c.id), ["bl_3"]);
    assert.deepEqual(matchCandidates("google or oak", three).length, 2, "words pointing at two candidates leave it open");
    assert.deepEqual(matchCandidates("I was thinking of the one that oak people use", three), [], "a long reply is not matched by one word in it");
    assert.deepEqual(matchCandidates("not the google one", three), [], "a candidate named to rule it out is not picked");
    assert.deepEqual(matchCandidates("not the one at Brightside", sarahs, keys), []);
    assert.deepEqual(matchCandidates("the listing please", three), [], "filler picks nothing");
  });

  test("a clearly new request supersedes the question", () => {
    const s = store();
    const c = s.open(input());
    assert.equal(s.reply("Create a task to call Ana tomorrow")?.kind, "superseded");
    assert.equal(s.get(c.id)!.status, "superseded");
    assert.ok(readsAsRequest("how many open deals do we have?"));
    assert.ok(!readsAsRequest("the one at Acme"));
    assert.ok(!readsAsRequest("second"));
  });

  test("a message after expiry marks it expired once, then nothing is open", () => {
    const k = clock();
    const s = store(k);
    const c = s.open(input());
    k.advance(59_999);
    assert.ok(s.awaiting());
    k.advance(1);
    assert.equal(s.reply("the second one")?.kind, "expired");
    assert.equal(s.get(c.id)!.status, "expired");
    assert.equal(s.reply("the second one"), undefined);
  });
});
