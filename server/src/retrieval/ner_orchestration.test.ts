/**
 * Orchestration proof: NER sidecar (scope "ask": Ask's own records only) → mentions/retrieval → planner hints,
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
        // A small store built here (base: false avoids node:sqlite serialize() quirks on this box). NER links against
        // these rows only: the Ask app registers them as scope "ask", never the sidecar's fine-tuning index.
        const w = world({ base: false });
        w.f.contact({ name: "Sarah Johnson", email: "sarah.johnson@brightside.example", company: "Brightside" });
        w.f.contact({ name: "Sarah Johnson", email: "sjohnson@gmail.example", company: null });
        w.f.company({ name: "Globex" });
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

  test("ambiguous person is a hint, not an early clarify: the planner runs with the candidates", async () => {
    const planner = scripted(reply({ type: "answer", text: "Two people share that name." }));
    const app = await start(planner);
    const evs = await app.ask("What is Sarah Johnson's status?");
    assert.ok(planner.calls >= 1, "planner runs; NER no longer ends the turn early");
    const retrieval = last(evs, "retrieval");
    const named = (retrieval?.mentions as { name: string; ambiguous?: boolean; count: number; linkedId?: string }[]) ?? [];
    assert.ok(
      named.some((m) => m.name === "Sarah Johnson" && (m.ambiguous || m.count > 1) && !m.linkedId),
      `expected ambiguous Sarah mention, got ${JSON.stringify(named)}`,
    );
    assert.match(planner.requests[0]!.user, /Sarah Johnson: 2 contacts \(.*ambiguous/);
    const sarahIds = app.world().store.all<{ id: string; name: string }>("contacts").filter((c) => c.name === "Sarah Johnson").map((c) => c.id);
    const hinted = [...planner.requests[0]!.user.matchAll(/\b(?:ct|ld|co)_[\w]+/g)].map((m) => m[0]);
    assert.ok(hinted.length && hinted.every((id) => sarahIds.includes(id)), `only Ask's Sarahs (${sarahIds}), got ${hinted}`);
    assert.ok(!/ct_2984|ct_dupe_2_1|co_1\b/.test(planner.requests[0]!.user));
  });

  test("company: an Ask company links to its own id; Clear Finance (only in the fine-tuning index) does not link", async () => {
    const planner = scripted(reply({ type: "answer", text: "ok" }), reply({ type: "answer", text: "ok" }));
    const app = await start(planner);
    const evs = await app.ask("Email the vendor at Globex about billing");
    const named = (last(evs, "retrieval")?.mentions as { name: string; entity: string; linkedId?: string; count: number }[]) ?? [];
    const globex = app.world().store.all<{ id: string; name: string }>("companies").find((c) => c.name === "Globex")!;
    const hit = named.find((m) => /globex/i.test(m.name));
    assert.ok(hit, `expected Globex mention, got ${JSON.stringify(named)}`);
    assert.equal(hit!.linkedId, globex.id);
    const evs2 = await app.ask("Email the vendor at Clear Finance about billing");
    const named2 = (last(evs2, "retrieval")?.mentions as { name: string; linkedId?: string; candidates?: { id: string }[] }[]) ?? [];
    assert.ok(!named2.some((m) => m.linkedId === "co_1" || m.candidates?.some((c) => c.id === "co_1")), JSON.stringify(named2));
    assert.ok(!planner.requests.some((r) => /\bco_1\b.*Clear Finance|Clear Finance: company/.test(r.user)));
  });
});

describe("NER orchestration skip notice", { skip: up }, () => {
  test("sidecar not reachable — start ner-sidecar on 8091 to run orchestration proofs", () => {
    // Skipped when sidecar is up; when down this suite is the only reminder.
    assert.ok(true, `sidecar not up at ${SIDECAR}`);
  });
});
