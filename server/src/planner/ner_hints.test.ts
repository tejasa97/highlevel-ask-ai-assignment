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

async function run(message: string, planner: Planner, spans: (u: string) => NerLinkedSpan[], setup?: (w: ReturnType<typeof world>) => void) {
  const w = world();
  setup?.(w);
  const events: TurnEvent[] = [];
  const out = await planTurn({ message, tier: "fast" }, { registry, retriever, planner, clock: w.clock, store: w.store, ner: async (u) => ({ requestId: "t", spans: spans(u) }) }, (e) => events.push(e));
  return { out, events };
}

describe("NER hints", () => {
  test("count of leads named Sarah Johnson: the name is a filter value, no clarification", async () => {
    const planner = scripted(reply({ steps: [step("M03.A03", { query: "Sarah Johnson" })], outcome: { effect: "read", actions: ["M03.A03"], destination: null } }));
    const { out } = await run("How many leads are named Sarah Johnson?", planner, (u) => [sarahs(u)]);
    assert.equal(out.kind, "plan", JSON.stringify(out));
    assert.match(planner.requests[0]!.user, /Sarah Johnson: 2 contacts, ambiguous \(a \$lookup by this name; the app asks which\)/);
    // Nothing to pick one by: no ids, no details the user didn't give.
    assert.doesNotMatch(planner.requests[0]!.user, /<mentions>[^<]*ct_31/);
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
    // The resolver bound it (a unique exact name in the store), not the NER link: the record's own name and how.
    const b = resolve && resolve.kind === "resolve" ? resolve.bound : undefined;
    assert.deepEqual(b && [b.id, b.name, b.provenance, b.matchReason], ["ct_3", "Ana Ruiz", "exact-unique", "exact-name"]);
  });

  test("one-edit typo in a company argument: did you mean, at that argument", async () => {
    const u = "Link Ana Ruiz to Clear Finace";
    const planner = scripted(reply({ steps: [step("M02.A06", { contactId: lookup("contact", "Ana Ruiz"), companyId: lookup("company", "Clear Finace") })], outcome: { effect: "change", actions: ["M02.A06"], destination: null } }));
    const { out } = await run(u, planner, (u) => [{ text: "Clear Finace", label: "company", ...at(u, "Clear Finace"), status: "ambiguous", method: "edit", score: 0.5, candidates: [{ id: "co_1", name: "Clear Finance", entity: "company" }] }], (w) => {
      // The resolver only offers records the store holds: the seed has no companies.
      const co = w.store.insert("companies", "co", { name: "Clear Finance", domain: null, industry: null, size: null, phone: null, address: null, accountManagerId: null, status: "active", mergedInto: null });
      assert.equal(co.id, "co_1");
    });
    assert.ok(out.kind === "reply" && out.status === "clarify", JSON.stringify(out));
    assert.match(out.text, /^Did you mean Clear Finance for .*companyId/);
    assert.deepEqual(out.options, ["Clear Finance"]);
    assert.match(planner.requests[0]!.user, /Clear Finace: no exact company; did you mean co_1 Clear Finance\?/);
  });

  test("a planner that writes NER's suggestion instead of the user's name still gets the question, not the record", async () => {
    const u = "Link Ana Ruiz to Clear Finace";
    const planner = scripted(reply({ steps: [step("M02.A06", { contactId: lookup("contact", "Ana Ruiz"), companyId: lookup("company", "Clear Finance") })], outcome: { effect: "change", actions: ["M02.A06"], destination: null } }));
    const { out } = await run(u, planner, (u) => [{ text: "Clear Finace", label: "company", ...at(u, "Clear Finace"), status: "ambiguous", method: "edit", score: 0.5, candidates: [{ id: "co_1", name: "Clear Finance", entity: "company" }] }], (w) => {
      w.store.insert("companies", "co", { name: "Clear Finance", domain: null, industry: null, size: null, phone: null, address: null, accountManagerId: null, status: "active", mergedInto: null });
    });
    assert.ok(out.kind === "reply" && out.status === "clarify", JSON.stringify(out));
    assert.match(out.text, /^Did you mean Clear Finance/);
  });

  test("a read that searches a name only near a record asks did you mean, rather than coming back empty", async () => {
    const u = "What's Omar Lassen's email?";
    const planner = scripted(reply({ steps: [step("M01.A03", { query: "Omar Lassen" })], outcome: { effect: "read", actions: ["M01.A03"], destination: null } }));
    const { out } = await run(u, planner, (u) => [{ text: "Omar Lassen", label: "person", ...at(u, "Omar Lassen"), status: "ambiguous", method: "edit", score: 0.5, candidates: [{ id: "ct_7", name: "Omar Larsen", entity: "contact" }] }]);
    assert.ok(out.kind === "reply" && out.status === "clarify", JSON.stringify(out));
    assert.match(out.text, /^I couldn't find a contact named Omar Lassen\. Did you mean Omar Larsen\?$/);
  });

  test("a question about a later lookup keeps the earlier lookups' bindings in the paused plan", async () => {
    const u = "Link Ana Ruiz to Clear Finace";
    const planner = scripted(reply({ steps: [step("M02.A06", { contactId: lookup("contact", "Ana Ruiz"), companyId: lookup("company", "Clear Finace") })], outcome: { effect: "change", actions: ["M02.A06"], destination: null } }));
    const { out } = await run(u, planner, (u) => [
      { text: "Ana Ruiz", label: "person", ...at(u, "Ana Ruiz"), status: "linked", linkedId: "ct_3", linkedEntity: "contact", method: "exact", score: 1 },
      { text: "Clear Finace", label: "company", ...at(u, "Clear Finace"), status: "ambiguous", method: "edit", score: 0.5, candidates: [{ id: "co_1", name: "Clear Finance", entity: "company" }] },
    ], (w) => void w.store.insert("companies", "co", { name: "Clear Finance", domain: null, industry: null, size: null, phone: null, address: null, accountManagerId: null, status: "active", mergedInto: null }));
    assert.ok(out.kind === "reply" && out.paused, JSON.stringify(out));
    const ana = out.paused.plan.steps.find((s) => s.kind === "resolve" && s.entity === "contact");
    assert.ok(ana?.kind === "resolve" && ana.bound?.id === "ct_3", "Ana Ruiz stays bound for the resume");
    const asked = out.paused.plan.steps.find((s) => s.id === out.paused!.stepId);
    assert.ok(asked?.kind === "resolve" && asked.entity === "company" && !asked.bound);
  });

  test("a near-miss recipient NER linked by embedding asks, and never binds", async () => {
    const u = "Email Ana Ruis about the renewal";
    const planner = scripted(reply({ steps: [step("M13.A01", { contactId: lookup("contact", "Ana Ruis"), subject: "Renewal", body: "About your renewal." })], outcome: { effect: "change", actions: ["M13.A01"], destination: null } }));
    const { out, events } = await run(u, planner, (u) => [{ text: "Ana Ruis", label: "person", ...at(u, "Ana Ruis"), status: "linked", linkedId: "ct_3", linkedEntity: "contact", method: "embed", score: 0.95 }]);
    assert.ok(out.kind === "reply" && out.status === "clarify", JSON.stringify(out));
    assert.match(out.text, /^Did you mean Ana Ruiz\?$/);
    const d = events.find((e) => e.type === "identity.resolved");
    assert.ok(d && d.type === "identity.resolved" && d.data.kind === "suggest" && !d.data.binding, JSON.stringify(d));
  });

  test("a missing person with a 0.92 embedding lookalike asks, and never binds", async () => {
    const u = "Email Sara Johnston about the renewal";
    const planner = scripted(reply({ steps: [step("M13.A01", { contactId: lookup("contact", "Sara Johnston"), subject: "Renewal", body: "About your renewal." })], outcome: { effect: "change", actions: ["M13.A01"], destination: null } }));
    const { out } = await run(u, planner, (u) => [{ text: "Sara Johnston", label: "person", ...at(u, "Sara Johnston"), status: "linked", linkedId: "ct_31", linkedEntity: "contact", method: "embed", score: 0.92 }]);
    assert.ok(out.kind === "reply" && out.status === "clarify", JSON.stringify(out));
    assert.match(out.text, /^Did you mean Sarah Johnson/);
  });

  test("a read that names an ambiguous person neither asks nor binds before execution", async () => {
    const planner = scripted(reply({ steps: [step("M01.A02", { contactId: lookup("contact", "Sarah Johnson") })], outcome: { effect: "read", actions: ["M01.A02"], destination: null } }));
    const { out } = await run("Show me Sarah Johnson", planner, (u) => [sarahs(u)]);
    assert.equal(out.kind, "plan", JSON.stringify(out));
    assert.ok(out.kind === "plan" && out.plan.steps.every((s) => s.kind !== "resolve" || !s.bound));
  });

  test("ambiguous Sarah Johnson as an email recipient still asks which one", async () => {
    const planner = scripted(reply({ steps: [step("M13.A01", { contactId: lookup("contact", "Sarah Johnson"), subject: "Renewal", body: "About your renewal." })], outcome: { effect: "change", actions: ["M13.A01"], destination: null } }));
    const { out } = await run("Email Sarah Johnson about the renewal", planner, (u) => [sarahs(u)]);
    assert.ok(out.kind === "reply" && out.status === "clarify", JSON.stringify(out));
    assert.match(out.text, /2 contact records named Sarah Johnson\. Which one should I use\?$/);
    // The picker shows the store's own detail for each record, not the sidecar's.
    assert.deepEqual(out.options, ["Sarah Johnson (sarah.johnson@brightside.example, +15550100001, Brightside)", "Sarah Johnson (sjohnson@gmail.example, +15550100001)"]);
  });

  const femi = (u: string): NerLinkedSpan => ({
    text: "Femi Silva", label: "person", ...at(u, "Femi Silva"), status: "ambiguous", method: "exact", score: 1,
    candidates: [{ id: "ct_10", name: "Femi Silva", entity: "contact" }, { id: "ld_43", name: "Femi Silva", entity: "lead" }],
  });
  const emailFemi = () => scripted(reply({ steps: [step("M13.A01", { contactId: lookup("contact", "Femi Silva"), subject: "Renewal", body: "About your renewal." })], outcome: { effect: "change", actions: ["M13.A01"], destination: null } }));

  test("a write to a name that is both a contact and a lead asks which, before anything binds", async () => {
    const planner = emailFemi();
    const { out } = await run("Email Femi Silva about the renewal", planner, (u) => [femi(u)]);
    assert.match(planner.requests[0]!.user, /Femi Silva: a contact and a lead, ambiguous/);
    assert.ok(out.kind === "reply" && out.status === "clarify", JSON.stringify(out));
    assert.match(out.text, /Femi Silva is both a contact and a lead\. Which one did you mean\?/);
    assert.equal(out.options?.length, 2);
  });

  test("the planner asking about a name that is both a contact and a lead gets the app's type question", async () => {
    const ask = reply({ type: "clarify", clarification: "identity", question: "Which record?", lookup: null,
      missing: { action: "M01.A07", argument: "contactId", argsJson: JSON.stringify({ contactId: lookup("contact", "Femi Silva"), ownerId: lookup("user", "Tom") }) } });
    const { out } = await run("Assign Femi Silva to Tom", scripted(ask, ask), (u) => [femi(u)]);
    assert.ok(out.kind === "reply" && out.status === "clarify", JSON.stringify(out));
    assert.match(out.text, /Femi Silva is both a contact and a lead\. Which one did you mean\?/);
    assert.equal(out.options?.length, 2);
  });

  test("naming the type, or answering a question, settles it: no type question", async () => {
    const named = await run("Email the contact Femi Silva about the renewal", emailFemi(), (u) => [femi(u)]);
    assert.equal(named.out.kind, "plan", JSON.stringify(named.out));
    const w = world();
    const answered = await planTurn({ message: "Email Femi Silva about the renewal", answering: "Femi Silva is both a contact and a lead. Which one did you mean?", tier: "fast" }, { registry, retriever, planner: emailFemi(), clock: w.clock, store: w.store, ner: async (u) => ({ requestId: "t", spans: [femi(u)] }) });
    assert.equal(answered.kind, "plan", JSON.stringify(answered));
  });
});
