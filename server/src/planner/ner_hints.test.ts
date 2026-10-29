// NER as non-blocking hints (offline: the sidecar is a fake). A name only asks a question when an argument needs an
// existing record, and then about that argument.
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { loadRegistry, type Registry } from "../registry/registry.js";
import { buildCards } from "../retrieval/cards.js";
import type { NerLinkedSpan } from "../retrieval/ner_sidecar_contract.js";
import { Retriever } from "../retrieval/retrieve.js";
import { world } from "../store/world.js";
import type { SubmitPlan } from "./submit-plan.js";
import { planTurn, type TurnEvent } from "./turn.js";
import type { PlanRequest, Planner } from "./types.js";

let registry: Registry;
let retriever: Retriever;
before(async () => {
  registry = await loadRegistry();
  retriever = new Retriever(buildCards(registry));
});

const reply = (fields: Partial<SubmitPlan>): SubmitPlan => ({ type: "plan", steps: null, question: null, options: null, reason: null, alternatives: null, query: null, text: null, ...fields });
const step = (action: string, args: object, id = "s1") => ({ id, kind: "action" as const, action, argsJson: JSON.stringify(args) });
const lookup = (entity: string, name: string) => ({ $lookup: { entity, name } });

function scripted(...replies: SubmitPlan[]): Planner & { requests: PlanRequest[] } {
  const requests: PlanRequest[] = [];
  return {
    name: "scripted",
    requests,
    async plan(req) {
      requests.push(req);
      const json = replies.shift();
      if (!json) throw new Error("planner called more times than scripted");
      return { model: "fake", json, text: JSON.stringify(json), usage: { input: 0, cachedRead: 0, cacheWrite: 0, output: 0, thinking: 0, costUsd: 0, billing: "none" }, latencyMs: 1 };
    },
  };
}

const at = (u: string, text: string) => ({ start: u.indexOf(text), end: u.indexOf(text) + text.length });
const sarahs = (u: string): NerLinkedSpan => ({
  text: "Sarah Johnson", label: "person", ...at(u, "Sarah Johnson"), status: "ambiguous", method: "exact", score: 1,
  candidates: [
    { id: "ct_31", name: "Sarah Johnson", entity: "contact", detail: "Brightside" },
    { id: "ct_32", name: "Sarah Johnson", entity: "contact", detail: "sjohnson@gmail.example" },
  ],
});

async function run(message: string, planner: Planner, spans: (u: string) => NerLinkedSpan[]) {
  const w = world();
  const events: TurnEvent[] = [];
  const out = await planTurn({ message, tier: "fast" }, { registry, retriever, planner, clock: w.clock, store: w.store, ner: async (u) => ({ requestId: "t", spans: spans(u) }) }, (e) => events.push(e));
  return { out, events };
}

describe("NER hints", () => {
  test("count of leads named Sarah Johnson: the name is a filter value, no clarification", async () => {
    const planner = scripted(reply({ steps: [step("M03.A03", { query: "Sarah Johnson" })], outcome: { effect: "read", actions: ["M03.A03"], destination: null } }));
    const { out } = await run("How many leads are named Sarah Johnson?", planner, (u) => [sarahs(u)]);
    assert.equal(out.kind, "plan", JSON.stringify(out));
    assert.match(planner.requests[0]!.user, /Sarah Johnson: 2 contacts \(ct_31 Sarah Johnson, Brightside; .*\), ambiguous/);
  });

  test("create a new contact named Sarah Johnson: a duplicate warning, never a which-one picker", async () => {
    const planner = scripted(reply({ steps: [step("M01.A01", { firstName: "Sarah", lastName: "Johnson", email: "sarah.j2@example.com" })], outcome: { effect: "change", actions: ["M01.A01"], destination: null } }));
    const { out } = await run("Create a new contact named Sarah Johnson with email sarah.j2@example.com", planner, (u) => [sarahs(u)]);
    assert.equal(out.kind, "plan", JSON.stringify(out));
    assert.ok(out.kind === "plan" && /a contact named Sarah Johnson already exists/.test(out.answer ?? ""));
  });

  test("a name inside an email body is not a recipient", async () => {
    const u = "Email Ana Ruiz that Sarah Johnson will join the call";
    const planner = scripted(reply({ steps: [step("M13.A01", { contactId: lookup("contact", "Ana Ruiz"), subject: "Call", body: "Sarah Johnson will join the call." })], outcome: { effect: "change", actions: ["M13.A01"], destination: null } }));
    const { out } = await run(u, planner, (u) => [{ text: "Ana Ruiz", label: "person", ...at(u, "Ana Ruiz"), status: "linked", linkedId: "ct_3", linkedEntity: "contact", method: "exact", score: 1 }, sarahs(u)]);
    assert.equal(out.kind, "plan", JSON.stringify(out));
    const resolve = out.kind === "plan" ? out.plan.steps.find((s) => s.kind === "resolve") : undefined;
    assert.deepEqual(resolve && resolve.kind === "resolve" && resolve.pinned, { id: "ct_3", name: "Ana Ruiz" });
  });

  test("one-edit typo in a company argument: did you mean, at that argument", async () => {
    const u = "Link Ana Ruiz to Clear Finace";
    const planner = scripted(reply({ steps: [step("M02.A06", { contactId: lookup("contact", "Ana Ruiz"), companyId: lookup("company", "Clear Finace") })], outcome: { effect: "change", actions: ["M02.A06"], destination: null } }));
    const { out } = await run(u, planner, (u) => [{ text: "Clear Finace", label: "company", ...at(u, "Clear Finace"), status: "ambiguous", method: "edit", score: 0.5, candidates: [{ id: "co_1", name: "Clear Finance", entity: "company" }] }]);
    assert.ok(out.kind === "reply" && out.status === "clarify", JSON.stringify(out));
    assert.match(out.text, /^Did you mean Clear Finance for .*companyId/);
    assert.deepEqual(out.options, ["Clear Finance"]);
    assert.match(planner.requests[0]!.user, /Clear Finace: no exact company; did you mean co_1 Clear Finance\?/);
  });

  test("ambiguous Sarah Johnson as an email recipient still asks which one, for contactId", async () => {
    const planner = scripted(reply({ steps: [step("M13.A01", { contactId: lookup("contact", "Sarah Johnson"), subject: "Renewal", body: "About your renewal." })], outcome: { effect: "change", actions: ["M13.A01"], destination: null } }));
    const { out } = await run("Email Sarah Johnson about the renewal", planner, (u) => [sarahs(u)]);
    assert.ok(out.kind === "reply" && out.status === "clarify", JSON.stringify(out));
    assert.match(out.text, /2 contact records named Sarah Johnson\. Which one should I use for .*contactId/);
    assert.deepEqual(out.options, ["Sarah Johnson (Brightside)", "Sarah Johnson (sjohnson@gmail.example)"]);
  });
});
