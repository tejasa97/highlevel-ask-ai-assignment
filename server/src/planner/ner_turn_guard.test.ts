// NER is optional at the turn level: shadow mode traces without changing the plan, a slow sidecar costs at most its
// timeout, and the user's cancel still ends the turn (offline: the sidecar is a fake).
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { loadRegistry, type Registry } from "../registry/registry.js";
import { buildCards } from "../retrieval/cards.js";
import type { NerMode, NerTrace } from "../retrieval/ner_client.js";
import type { NerSidecarResponse } from "../retrieval/ner_sidecar_contract.js";
import { Retriever } from "../retrieval/retrieve.js";
import { world } from "../store/world.js";
import type { SubmitPlan } from "./submit-plan.js";
import { planTurn, type TurnDeps, type TurnEvent } from "./turn.js";
import type { PlanRequest, Planner } from "./types.js";

let registry: Registry;
let retriever: Retriever;
before(async () => {
  registry = await loadRegistry();
  retriever = new Retriever(buildCards(registry));
});

const reply: SubmitPlan = {
  type: "plan", steps: [{ id: "s1", kind: "action", action: "M03.A03", argsJson: JSON.stringify({ query: "Sarah Johnson" }) }],
  question: null, options: null, reason: null, alternatives: null, query: null, text: null, outcome: { effect: "read", actions: ["M03.A03"], destination: null },
};

function planner(): Planner & { requests: PlanRequest[] } {
  const requests: PlanRequest[] = [];
  return {
    name: "scripted",
    requests,
    async plan(req) {
      requests.push(req);
      return { model: "fake", json: reply, text: JSON.stringify(reply), usage: { input: 0, cachedRead: 0, cacheWrite: 0, output: 0, thinking: 0, costUsd: 0, billing: "none" }, latencyMs: 1 };
    },
  };
}

const message = "How many leads are named Sarah Johnson?";
const sarahs = async (u: string): Promise<NerSidecarResponse> => ({
  requestId: "t",
  spans: [{
    text: "Sarah Johnson", label: "person", start: u.indexOf("Sarah"), end: u.indexOf("Sarah") + 13, status: "ambiguous", method: "exact", score: 1,
    candidates: [{ id: "ct_31", name: "Sarah Johnson", entity: "contact" }, { id: "ct_32", name: "Sarah Johnson", entity: "contact" }],
  }],
});

async function run(mode: NerMode, ner: TurnDeps["ner"], extra: Partial<TurnDeps> = {}) {
  const w = world();
  const p = planner();
  const events: TurnEvent[] = [];
  const out = await planTurn({ message, tier: "fast" }, { registry, retriever, planner: p, clock: w.clock, store: w.store, ner, nerMode: mode, ...extra }, (e) => events.push(e));
  const trace = events.find((e): e is { type: "ner"; data: NerTrace } => e.type === "ner")?.data;
  return { out, user: p.requests[0]?.user, calls: p.requests.length, trace };
}

describe("NER turn guard", () => {
  test("shadow: the sidecar is called and traced, the planner sees exactly what mode off sees", async () => {
    const off = await run("off", sarahs);
    const shadow = await run("shadow", sarahs);
    const on = await run("on", sarahs);
    assert.equal(off.trace, undefined);
    assert.deepEqual([shadow.trace?.outcome, shadow.trace?.applied, shadow.trace?.spans], ["ok", false, 1]);
    assert.equal(shadow.user, off.user);
    // The hint is real: in mode on it reaches the planner.
    assert.notEqual(on.user, off.user);
    assert.match(on.user ?? "", /2 contacts/);
  });

  test("a sidecar that never answers costs only the NER timeout; the turn still plans", async () => {
    const started = performance.now();
    const { out, trace } = await run("on", () => new Promise(() => {}), { nerTimeoutMs: 50 });
    assert.equal(out.kind, "plan", JSON.stringify(out));
    assert.equal(trace?.outcome, "timeout");
    assert.ok(performance.now() - started < 2000);
  });

  test("a sidecar error is no hints, not a failed turn", async () => {
    const { NerSidecarError } = await import("../retrieval/ner_client.js");
    const { out, trace } = await run("on", () => Promise.reject(new NerSidecarError("bad body", "invalid")));
    assert.equal(out.kind, "plan", JSON.stringify(out));
    assert.equal(trace?.outcome, "invalid");
  });

  test("the user's cancel during NER ends the turn before the planner is called", async () => {
    const ctl = new AbortController();
    const ner: TurnDeps["ner"] = (_u, signal) => new Promise((_res, rej) => {
      signal?.addEventListener("abort", () => rej(signal.reason));
      setTimeout(() => ctl.abort(), 5);
    });
    const { out, calls, trace } = await run("on", ner, { signal: ctl.signal });
    assert.equal(trace?.outcome, "cancelled");
    assert.equal(calls, 0);
    assert.notEqual(out.kind, "plan");
    assert.match(JSON.stringify(out), /cancelled/);
  });
});
