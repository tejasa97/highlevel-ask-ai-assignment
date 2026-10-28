/**
 * Orchestration proof: NER sidecar → mentions/retrieval → ambiguous clarify
 * without calling a real LLM. Requires the sidecar on NER_SIDECAR_URL (8091).
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, describe, test } from "node:test";
import type { SubmitPlan } from "../planner/submit-plan.js";
import { type PlanRequest, type Planner } from "../planner/types.js";
import { loadRegistry, type Registry } from "../registry/registry.js";
import { buildCards } from "./cards.js";
import { nerSidecarUrl } from "./ner_client.js";
import { Retriever } from "./retrieve.js";
import { world, type World } from "../store/world.js";
import { createApp } from "../server/app.js";

const SIDECAR = nerSidecarUrl();

async function sidecarUp(): Promise<boolean> {
  try {
    const r = await fetch(`${SIDECAR}/health`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return false;
    const j = (await r.json()) as { ok?: boolean };
    return !!j.ok;
  } catch {
    return false;
  }
}

const up = await sidecarUp();

interface Sse {
  event: string;
  data: any;
}

async function events(res: Response): Promise<Sse[]> {
  return (await res.text())
    .split("\n\n")
    .filter(Boolean)
    .map((chunk) => {
      const [e, d] = chunk.split("\n");
      return { event: e!.slice("event: ".length), data: JSON.parse(d!.slice("data: ".length)) };
    });
}

const reply = (fields: Partial<SubmitPlan>): SubmitPlan => ({
  type: "plan",
  steps: null,
  question: null,
  options: null,
  reason: null,
  alternatives: null,
  query: null,
  text: null,
  ...fields,
});

function scripted(...replies: SubmitPlan[]): Planner & { requests: PlanRequest[]; calls: number } {
  const requests: PlanRequest[] = [];
  let calls = 0;
  return {
    name: "scripted",
    get calls() {
      return calls;
    },
    requests,
    async plan(req) {
      calls++;
      requests.push(req);
      const next = replies.shift();
      if (!next) throw new Error("planner called more times than scripted");
      return {
        model: "fake",
        json: next,
        text: JSON.stringify(next),
        usage: { input: 0, cachedRead: 0, cacheWrite: 0, output: 0, thinking: 0, costUsd: 0, billing: "none" },
        latencyMs: 1,
      };
    },
  };
}

/** Throws if the planner is ever invoked — proves ambiguous path skips the LLM. */
function refusePlanner(): Planner & { calls: number } {
  let calls = 0;
  return {
    name: "refuse",
    get calls() {
      return calls;
    },
    async plan() {
      calls++;
      throw new Error("planner must not be called when NER returns ambiguous");
    },
  };
}

describe("NER orchestration (sidecar + /api/ask)", { skip: !up }, () => {
  let registry: Registry;
  let retriever: Retriever;
  const saved: Record<string, string | undefined> = {};
  const running: { close: () => void }[] = [];

  before(async () => {
    registry = await loadRegistry();
    retriever = new Retriever(buildCards(registry));
    for (const k of ["NER_SIDECAR", "ASK_NER", "NER_SIDECAR_URL"]) {
      saved[k] = process.env[k];
    }
    process.env.NER_SIDECAR = "1";
    process.env.NER_SIDECAR_URL = SIDECAR;
    delete process.env.ASK_NER;
  });

  after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  afterEach(() => {
    for (const s of running.splice(0)) s.close();
  });

  async function start(planner: Planner) {
    const worlds: World[] = [];
    const server = createApp({
      registry,
      planner,
      retriever,
      openWorld: () => {
        // Empty store: avoids node:sqlite serialize() quirks on this box; NER
        // links against the PoC sidecar index, not Store rows.
        const w = world({ base: false });
        worlds.push(w);
        return w;
      },
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    running.push({ close: () => (server.closeAllConnections(), server.close()) });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const ask = async (message: string) =>
      events(
        await fetch(base + "/api/ask", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message, tier: "fast" }),
        }),
      );
    return { base, ask, world: () => worlds.at(-1)! };
  }

  const last = (evs: Sse[], event: string) => evs.findLast((e) => e.event === event)?.data;

  test("ambiguous person: clarify options, retrieval mentions, no planner call", async () => {
    const planner = refusePlanner();
    const app = await start(planner);
    const evs = await app.ask("What is Sarah Johnson's status?");
    assert.equal(planner.calls, 0, "planner must not run for ambiguous NER");
    assert.ok(!evs.some((e) => e.event === "planner.request"), "no planner.request SSE");
    assert.ok(!evs.some((e) => e.event === "planner.reply"), "no planner.reply SSE");

    const retrieval = last(evs, "retrieval");
    assert.ok(retrieval, "retrieval SSE expected before clarify");
    const named = (retrieval.mentions as { name: string; ambiguous?: boolean; count: number; linkedId?: string }[]) ?? [];
    assert.ok(
      named.some((m) => m.name === "Sarah Johnson" && (m.ambiguous || m.count > 1) && !m.linkedId),
      `expected ambiguous Sarah mention, got ${JSON.stringify(named)}`,
    );

    const replyEv = last(evs, "reply");
    assert.equal(replyEv?.status, "clarify");
    assert.ok(Array.isArray(replyEv?.options) && replyEv.options.length >= 2, "clarify options required");
    assert.match(String(replyEv?.text ?? ""), /Sarah Johnson|Which one/i);
  });

  test("resolved company: retrieval shows Store-prefix linkedId; planner may run", async () => {
    const planner = scripted(reply({ type: "answer", text: "Linked Clear Finance in retrieval." }));
    const app = await start(planner);
    const evs = await app.ask("Email the vendor at Clear Finance about billing");
    const retrieval = last(evs, "retrieval");
    assert.ok(retrieval, "retrieval SSE expected");
    const named = (retrieval.mentions as { name: string; entity: string; linkedId?: string; count: number }[]) ?? [];
    const hit = named.find((m) => /clear finance/i.test(m.name));
    assert.ok(hit, `expected Clear Finance mention, got ${JSON.stringify(named)}`);
    assert.equal(hit!.entity, "company");
    assert.equal(hit!.count, 1);
    assert.ok(hit!.linkedId?.startsWith("co_"), `expected co_ linkedId, got ${hit!.linkedId}`);
    assert.ok(planner.calls >= 1, "resolved path may call planner");
    assert.ok(!evs.some((e) => e.event === "reply" && e.data?.status === "clarify"));
  });
});

describe("NER orchestration skip notice", { skip: up }, () => {
  test("sidecar not reachable — start ner-sidecar on 8091 to run orchestration proofs", () => {
    // Skipped when sidecar is up; when down this suite is the only reminder.
    assert.ok(true, `sidecar not up at ${SIDECAR}`);
  });
});
