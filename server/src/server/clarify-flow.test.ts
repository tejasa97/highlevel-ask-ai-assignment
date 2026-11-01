import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import type { NerLinkedSpan } from "../retrieval/ner_sidecar_contract.js";
import type { SubmitPlan } from "../planner/submit-plan.js";
import type { Planner, PlanRequest } from "../planner/types.js";
import { loadRegistry, type Registry } from "../registry/registry.js";
import { buildCards } from "../retrieval/cards.js";
import { Retriever } from "../retrieval/retrieve.js";
import { world } from "../store/world.js";
import { Conversation } from "./conversation.js";

// A "which one?" question answered in the chat: the stored plan resumes, it is never planned again.

let registry: Registry;
let retriever: Retriever;
before(async () => {
  registry = await loadRegistry();
  retriever = new Retriever(buildCards(registry));
});

const response = (steps: SubmitPlan["steps"]): SubmitPlan => ({ type: "plan", steps, question: null, options: null, reason: null, alternatives: null, query: null, text: null });
/** Rename one of the two seeded Sarah Johnsons, picked by a $lookup on her name. */
const renameSarah = () => response([{ id: "s1", kind: "action", action: "M01.A04", argsJson: JSON.stringify({ contactId: { $lookup: { entity: "contact", name: "Sarah Johnson" } }, lastName: "Johnson-Lee" }) }]);

function scripted(...replies: SubmitPlan[]): Planner & { requests: PlanRequest[] } {
  const requests: PlanRequest[] = [];
  return {
    name: "scripted",
    requests,
    async plan(req) {
      requests.push(req);
      const json = replies.shift();
      if (!json) throw new Error("planner called more times than scripted");
      return { model: "fake", json, text: JSON.stringify(json), usage: { input: 0, cachedRead: 0, cacheWrite: 0, output: 0, thinking: 0, costUsd: 0, billing: "none" }, latencyMs: 0 };
    },
  };
}

type Ev = { event: string; data: any };
/** A reply that asks the user something: the planner says "clarify", the executor "needs_clarification". */
const asks = (r: { status: string }) => r.status === "clarify" || r.status === "needs_clarification";
const recorder = () => {
  const evs: Ev[] = [];
  return { evs, emit: (event: string, data: unknown) => evs.push({ event, data }), reply: () => evs.findLast((e) => e.event === "reply")?.data };
};

describe("answering a which-contact question", () => {
  test("the answer resumes the stored plan: the question is not asked again", async () => {
    // The planner, asked again, plans the same lookup: with text concatenation the same question came back.
    const planner = scripted(renameSarah(), renameSarah(), renameSarah());
    const w = world();
    const chat = new Conversation({ registry, planner, retriever }, w);
    const first = recorder();
    await chat.ask("Change Sarah Johnson's last name to Johnson-Lee", "fast", "us_1", first.emit);
    assert.equal(first.reply().status, "needs_clarification");
    const second = recorder();
    await chat.ask("the second one", "fast", "us_1", second.emit);
    assert.equal(second.reply().status, "done", JSON.stringify(second.reply()));
    assert.equal(planner.requests.length, 1, "the answer resumes the stored plan, no second planner call");
    const renamed = w.store.all<{ name: string; lastName?: string }>("contacts").filter((c) => /Johnson-Lee/.test(c.name) || c.lastName === "Johnson-Lee");
    assert.equal(renamed.length, 1);
  });

  test("the chosen record changed before the answer: nothing is written, the question is asked again", async () => {
    const planner = scripted(renameSarah());
    const w = world();
    const chat = new Conversation({ registry, planner, retriever }, w);
    const first = recorder();
    await chat.ask("Change Sarah Johnson's last name to Johnson-Lee", "fast", "us_1", first.emit);
    const { clarification } = first.reply();
    w.store.update("contacts", "ct_32", { email: "sarah.new@gmail.example" });
    const audit = w.store.audit().length;
    const second = recorder();
    await chat.choose(clarification.id, clarification.options.find((o: { label: string }) => /gmail/.test(o.label)).token, "us_1", second.emit);
    assert.ok(asks(second.reply()), JSON.stringify(second.reply()));
    assert.match(second.reply().text, /changed since it was chosen.*nothing was changed/);
    assert.notEqual(second.reply().clarification.id, clarification.id, "a new question, with fresh tokens");
    assert.equal(w.store.audit().length, audit, "no write");
    const third = recorder();
    await chat.ask("sarah.new@gmail.example", "fast", "us_1", third.emit);
    assert.equal(third.reply().status, "done", JSON.stringify(third.reply()));
    assert.equal(w.store.get<{ lastName?: string }>("contacts", "ct_32")!.lastName, "Johnson-Lee");
    assert.equal(planner.requests.length, 1);
  });

  test("a new request supersedes the question and is planned fresh; the old option tokens no longer act", async () => {
    const planner = scripted(renameSarah(), response([{ id: "s1", kind: "action", action: "M01.A04", argsJson: JSON.stringify({ contactId: "ct_3", lastName: "Ruiz-Diaz" }) }]));
    const w = world();
    const chat = new Conversation({ registry, planner, retriever }, w);
    const first = recorder();
    await chat.ask("Change Sarah Johnson's last name to Johnson-Lee", "fast", "us_1", first.emit);
    const { clarification } = first.reply();
    const second = recorder();
    await chat.ask("Set Ana Ruiz's last name to Ruiz-Diaz", "fast", "us_1", second.emit);
    assert.equal(second.reply().status, "done");
    assert.equal(planner.requests.length, 2);
    assert.doesNotMatch(planner.requests[1]!.user.split("<message>").at(-1)!, /Johnson-Lee/, "not concatenated onto the old request");
    const late = recorder();
    await chat.choose(clarification.id, clarification.options[1].token, "us_1", late.emit);
    assert.equal(late.reply().status, "cancelled");
    assert.equal(w.store.get<{ lastName?: string }>("contacts", "ct_32")!.lastName === "Johnson-Lee", false);
  });

  test("after it expires, the next message is planned fresh", async () => {
    let t = 0;
    const planner = scripted(renameSarah(), renameSarah());
    const chat = new Conversation({ registry, planner, retriever, clarify: { ttlMs: 1_000, now: () => t } }, world());
    await chat.ask("Change Sarah Johnson's last name to Johnson-Lee", "fast", "us_1", recorder().emit);
    t = 1_000;
    const second = recorder();
    await chat.ask("the second one", "fast", "us_1", second.emit);
    assert.equal(planner.requests.length, 2, "planned fresh");
    assert.doesNotMatch(planner.requests[1]!.user.split("<message>").at(-1)!, /Johnson-Lee/, "not concatenated onto the old request");
  });

  test("an answer that matches neither asks again, then gives up honestly with nothing changed", async () => {
    const w = world();
    const chat = new Conversation({ registry, planner: scripted(renameSarah()), retriever }, w);
    await chat.ask("Change Sarah Johnson's last name to Johnson-Lee", "fast", "us_1", recorder().emit);
    const audit = w.store.audit().length;
    const a = recorder();
    await chat.ask("hmm", "fast", "us_1", a.emit);
    assert.ok(asks(a.reply()));
    assert.equal(a.reply().clarification.round, 2);
    const b = recorder();
    await chat.ask("not sure", "fast", "us_1", b.emit);
    assert.equal(b.reply().status, "cancelled");
    assert.match(b.reply().text, /couldn't pin down.*nothing was changed/);
    assert.equal(w.store.audit().length, audit);
  });
});

describe("answering a question the identity resolver asked (NER path)", () => {
  const at = (u: string, text: string) => ({ start: u.indexOf(text), end: u.indexOf(text) + text.length });
  const sarahs = (u: string): NerLinkedSpan => ({
    text: "Sarah Johnson", label: "person", ...at(u, "Sarah Johnson"), status: "ambiguous", method: "exact", score: 1,
    candidates: [
      { id: "ct_31", name: "Sarah Johnson", entity: "contact", detail: "Brightside" },
      { id: "ct_32", name: "Sarah Johnson", entity: "contact", detail: "sjohnson@gmail.example" },
    ],
  });

  test("the resolver's question is stored with the compiled plan and resumes it without planning again", async () => {
    const planner = scripted(renameSarah(), renameSarah());
    const w = world();
    const chat = new Conversation({ registry, planner, retriever, ner: async (u) => ({ requestId: "t", spans: [sarahs(u)] }) }, w);
    const first = recorder();
    await chat.ask("Change Sarah Johnson's last name to Johnson-Lee", "fast", "us_1", first.emit);
    assert.ok(asks(first.reply()), JSON.stringify(first.reply()));
    assert.equal(first.reply().clarification.options.length, 2);
    const second = recorder();
    await chat.ask("the one at Brightside", "fast", "us_1", second.emit);
    assert.equal(second.reply().status, "done", JSON.stringify(second.reply()));
    assert.equal(planner.requests.length, 1);
    const resolved = second.evs.find((e) => e.event === "clarify.resolved")!.data;
    assert.equal(resolved.binding.provenance, "user-selected");
    assert.equal(w.store.get<{ lastName?: string }>("contacts", "ct_31")!.lastName, "Johnson-Lee");
    assert.notEqual(w.store.get<{ lastName?: string }>("contacts", "ct_32")!.lastName, "Johnson-Lee");
  });
});

describe("resuming a run that paused part-way", () => {
  const field = (id: string, required = true) => ({ id, label: "Email", type: "email", required, options: [], validation: { minLength: null, maxLength: null, pattern: null }, mapsTo: null });
  /** Write a note, then submit a form whose field is looked up by label within the form: two fields are labelled Email. */
  const noteThenSubmit = () => response([
    { id: "s1", kind: "action", action: "M07.A01", argsJson: JSON.stringify({ body: "Called about the intake form" }) },
    { id: "s2", kind: "action", action: "M18.A09", argsJson: JSON.stringify({ formId: { $lookup: { entity: "form", name: "Twin Intake" } }, answers: [{ fieldId: { $lookup: { entity: "form_field", name: "Email" } }, value: "a@example.com" }] }) },
  ]);
  const twinForm = () => {
    const w = world();
    w.f.form({ name: "Twin Intake", status: "published", publishedAt: w.f.now(), fields: [field("field_a"), field("field_b", false)] as never });
    return w;
  };

  test("a write that ran before the paused scoped lookup is not written again on the answer", async () => {
    const w = twinForm();
    const chat = new Conversation({ registry, planner: scripted(noteThenSubmit()), retriever }, w);
    const notes = w.store.all("notes").length;
    const first = recorder();
    await chat.ask("Note that I called, then submit the Twin Intake form", "fast", "us_1", first.emit);
    assert.ok(asks(first.reply()), JSON.stringify(first.reply()));
    assert.equal(w.store.all("notes").length, notes + 1, "the note ran before the pause");
    const form = (chat as any).clarifications.awaiting().paused.plan.steps.find((s: { kind: string; entity?: string }) => s.kind === "resolve" && s.entity === "form");
    assert.equal(form.bound?.name, "Twin Intake", "the form looked up before the pause stays bound for the resume");
    const { clarification } = first.reply();
    const second = recorder();
    await chat.choose(clarification.id, clarification.options[0].token, "us_1", second.emit);
    assert.equal(second.reply().status, "done", JSON.stringify(second.reply()));
    assert.equal(w.store.all("notes").length, notes + 1, "the note is written once");
    assert.equal(w.store.all("form_submissions").length, 1);
  });

  test("a paused plan changed after the question was asked is refused, nothing written", async () => {
    const w = twinForm();
    const chat = new Conversation({ registry, planner: scripted(noteThenSubmit()), retriever }, w);
    const first = recorder();
    await chat.ask("Note that I called, then submit the Twin Intake form", "fast", "us_1", first.emit);
    const paused = (chat as any).clarifications.awaiting().paused;
    paused.plan = { ...paused.plan, steps: paused.plan.steps.filter((s: { id: string }) => s.id !== "s1") };
    const audit = w.store.audit().length;
    const second = recorder();
    await chat.choose(first.reply().clarification.id, first.reply().clarification.options[0].token, "us_1", second.emit);
    assert.equal(second.reply().status, "failed");
    assert.match(second.reply().text, /doesn't match/);
    assert.equal(w.store.audit().length, audit);
  });
});

describe("RESOLVER=off: the binding path from before the resolver", () => {
  const at = (u: string, text: string) => ({ start: u.indexOf(text), end: u.indexOf(text) + text.length });
  const sarahs = (u: string): NerLinkedSpan => ({
    text: "Sarah Johnson", label: "person", ...at(u, "Sarah Johnson"), status: "ambiguous", method: "exact", score: 1,
    candidates: [
      { id: "ct_31", name: "Sarah Johnson", entity: "contact", detail: "Brightside" },
      { id: "ct_32", name: "Sarah Johnson", entity: "contact", detail: "sjohnson@gmail.example" },
    ],
  });
  const off = <T>(fn: () => Promise<T>) => async () => {
    const was = process.env.RESOLVER;
    process.env.RESOLVER = "off";
    try { return await fn(); } finally { if (was === undefined) delete process.env.RESOLVER; else process.env.RESOLVER = was; }
  };
  /** Read the contact first (a look), then rename her. */
  const lookAtSarah = (): SubmitPlan => ({ ...response([{ id: "s1", kind: "action", action: "M01.A02", argsJson: JSON.stringify({ contactId: { $lookup: { entity: "contact", name: "Sarah Johnson" } } }) }]), type: "look" });

  test("a question a look asked is stored, and the answer plans the message again with the pick bound", off(async () => {
    const planner = scripted(lookAtSarah(), lookAtSarah(), renameSarah());
    const w = world();
    const chat = new Conversation({ registry, planner, retriever, ner: async (u) => ({ requestId: "t", spans: [sarahs(u)] }) }, w);
    const first = recorder();
    await chat.ask("Look up Sarah Johnson, then change her last name to Johnson-Lee", "fast", "us_1", first.emit);
    assert.ok(asks(first.reply()), JSON.stringify(first.reply()));
    assert.ok(first.reply().clarification, "the look's question is stored, so the answer can be resolved");
    assert.equal(planner.requests.length, 1);
    const second = recorder();
    await chat.ask("the one at Brightside", "fast", "us_1", second.emit);
    assert.equal(second.reply().status, "done", JSON.stringify(second.reply()));
    assert.equal(planner.requests.length, 3, "planned again: the look, then the plan, with no second question");
    assert.equal(w.store.get<{ lastName?: string }>("contacts", "ct_31")!.lastName, "Johnson-Lee");
    assert.notEqual(w.store.get<{ lastName?: string }>("contacts", "ct_32")!.lastName, "Johnson-Lee");
  }));

  test("a unique NER link is pinned and used without a store lookup, as before the resolver", off(async () => {
    // The store has two Sarah Johnsons; NER linked the name to one of them, so the old path never asks.
    const planner = scripted(renameSarah());
    const w = world();
    const linked = (u: string): NerLinkedSpan => ({ text: "Sarah Johnson", label: "person", ...at(u, "Sarah Johnson"), status: "linked", method: "exact", score: 1, linkedId: "ct_32", linkedEntity: "contact", candidates: [{ id: "ct_32", name: "Sarah Johnson", entity: "contact" }] });
    const chat = new Conversation({ registry, planner, retriever, ner: async (u) => ({ requestId: "t", spans: [linked(u)] }) }, w);
    const r = recorder();
    await chat.ask("Change Sarah Johnson's last name to Johnson-Lee", "fast", "us_1", r.emit);
    assert.equal(r.reply().status, "done", JSON.stringify(r.reply()));
    assert.equal(w.store.get<{ lastName?: string }>("contacts", "ct_32")!.lastName, "Johnson-Lee");
  }));

  test("the store lookup as it was: two matches ask, and the stored question still resumes the plan", off(async () => {
    const planner = scripted(renameSarah());
    const w = world();
    const chat = new Conversation({ registry, planner, retriever }, w);
    const first = recorder();
    await chat.ask("Change Sarah Johnson's last name to Johnson-Lee", "fast", "us_1", first.emit);
    assert.equal(first.reply().status, "needs_clarification", JSON.stringify(first.reply()));
    const resolved = first.evs.filter((e) => e.event === "exec" && e.data.type === "identity.resolved");
    assert.equal(resolved.length, 0, "the resolver never ran");
    const { clarification } = first.reply();
    const second = recorder();
    await chat.choose(clarification.id, clarification.options.find((o: { label: string }) => /gmail/.test(o.label)).token, "us_1", second.emit);
    assert.equal(second.reply().status, "done", JSON.stringify(second.reply()));
    assert.equal(w.store.get<{ lastName?: string }>("contacts", "ct_32")!.lastName, "Johnson-Lee");
  }));

  test("the switch is read on every call: with the resolver on, the same link only hints and the store's two matches ask", async () => {
    const w = world();
    const linked = (u: string): NerLinkedSpan => ({ text: "Sarah Johnson", label: "person", ...at(u, "Sarah Johnson"), status: "linked", method: "exact", score: 1, linkedId: "ct_32", linkedEntity: "contact", candidates: [{ id: "ct_32", name: "Sarah Johnson", entity: "contact" }] });
    const chat = new Conversation({ registry, planner: scripted(renameSarah()), retriever, ner: async (u) => ({ requestId: "t", spans: [linked(u)] }) }, w);
    const r = recorder();
    await chat.ask("Change Sarah Johnson's last name to Johnson-Lee", "fast", "us_1", r.emit);
    assert.ok(asks(r.reply()), JSON.stringify(r.reply()));
  });
});
