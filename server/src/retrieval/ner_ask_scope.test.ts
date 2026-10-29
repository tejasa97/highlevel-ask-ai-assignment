// The Ask app links NER only against its own records (scope "ask"), never the sidecar's fine-tuning index.
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { world } from "../store/world.js";
import { ASK_SCOPE, askEntities, askScopedExtract, keepAskIds, resetAskScopeCache } from "./ner_ask_scope.js";
import { NerSidecarError, nerSidecarUrl } from "./ner_client.js";
import type { NerLinkedSpan } from "./ner_sidecar_contract.js";

const BIG = ["ct_2984", "ct_4803", "ct_dupe_2_1", "ct_dupe_2_2", "co_1"];
const ids = (s: NerLinkedSpan) => [...(s.candidates ?? []).map((c) => c.id), ...(s.linkedId ? [s.linkedId] : [])];

/** A fake sidecar: records what Ask registered and sent, and answers with whatever `answer` builds. */
function fakeSidecar(answer: (body: any, registered: any) => { status?: number; json?: unknown }) {
  const calls: { method: string; path: string; body: any }[] = [];
  let registered: any;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init.body));
    calls.push({ method: init.method ?? "GET", path, body });
    if (init.method === "PUT") { registered = body; return new Response(JSON.stringify({ ok: true }), { status: 200 }); }
    const r = answer(body, registered);
    return new Response(JSON.stringify(r.json ?? { detail: "x" }), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl, registered: () => registered };
}

const sarahSpan = (cands: { id: string; entity: string }[]): NerLinkedSpan => ({ text: "Sarah Johnson", label: "person", start: 6, end: 19, status: "ambiguous", method: "exact", score: 1, candidates: cands.map((c) => ({ ...c, name: "Sarah Johnson" })) });

beforeEach(() => resetAskScopeCache());

describe("Ask-scoped NER", () => {
  test("the Ask index is Ask's records: two Sarah Johnson contacts, no Clear Finance, none of the seed ids", () => {
    const { store } = world();
    const es = askEntities(store);
    const sarahs = es.filter((e) => e.name === "Sarah Johnson");
    assert.equal(sarahs.length, 2);
    assert.ok(sarahs.every((e) => e.entity === "contact" && e.id.startsWith("ct_")));
    assert.ok(sarahs.some((e) => e.id === "ct_31"));
    assert.ok(!es.some((e) => /clear financ/i.test(e.name)));
    assert.ok(!es.some((e) => BIG.includes(e.id)));
  });

  test("registers scope ask, sends scope + version on extract, re-registers after a write", async () => {
    const { store, f } = world();
    const side = fakeSidecar((body) => ({ json: { requestId: body.requestId, scope: body.scope, spans: [] } }));
    await askScopedExtract(store, { requestId: "a", utterance: "Email Sarah Johnson" }, { fetchImpl: side.fetchImpl, url: "http://ner" });
    assert.deepEqual(side.calls.map((c) => `${c.method} ${c.path}`), ["PUT /v1/scopes/ask", "POST /v1/extract"]);
    assert.equal(side.calls[1]!.body.scope, ASK_SCOPE);
    assert.equal(side.calls[1]!.body.scopeVersion, side.registered().version);
    assert.equal(side.registered().entities.filter((e: any) => e.name === "Sarah Johnson").length, 2);
    // Unchanged store: no re-register. A new contact: the new version is pushed first.
    await askScopedExtract(store, { requestId: "b", utterance: "x" }, { fetchImpl: side.fetchImpl, url: "http://ner" });
    assert.equal(side.calls.filter((c) => c.method === "PUT").length, 1);
    f.contact({ name: "Sarah Johnson", email: "sarah.j2@example.com" });
    await askScopedExtract(store, { requestId: "c", utterance: "x" }, { fetchImpl: side.fetchImpl, url: "http://ner" });
    assert.equal(side.calls.filter((c) => c.method === "PUT").length, 2);
    assert.equal(side.registered().entities.filter((e: any) => e.name === "Sarah Johnson").length, 3);
  });

  test("ids that aren't Ask's never reach the planner, even if the sidecar returns them", async () => {
    const { store } = world();
    const side = fakeSidecar((body) => ({ json: { requestId: body.requestId, scope: "ask", spans: [
      sarahSpan([{ id: "ct_31", entity: "contact" }, { id: "ct_2984", entity: "lead" }, { id: "ct_dupe_2_1", entity: "contact" }]),
      { text: "Clear Finance", label: "company", start: 30, end: 43, status: "linked", linkedId: "co_1", linkedEntity: "company", method: "exact", score: 1 },
    ] } }));
    const res = await askScopedExtract(store, { requestId: "a", utterance: "Email Sarah Johnson at Clear Finance" }, { fetchImpl: side.fetchImpl, url: "http://ner" });
    for (const s of res.spans) assert.ok(!ids(s).some((id) => BIG.includes(id)), JSON.stringify(s));
    assert.ok(res.spans.every((s) => s.status === "miss"));
    assert.deepEqual(keepAskIds([sarahSpan([{ id: "ct_31", entity: "contact" }])], new Set(["ct_31"]))[0]!.candidates!.map((c) => c.id), ["ct_31"]);
  });

  test("fails closed: unregistered scope or an unscoped answer throws, it never falls back to the big index", async () => {
    const { store } = world();
    let n = 0;
    const stale = fakeSidecar(() => ({ status: 409, json: { detail: "scope 'ask' is not registered" } }));
    await assert.rejects(askScopedExtract(store, { requestId: "a", utterance: "Sarah Johnson" }, { fetchImpl: stale.fetchImpl, url: "http://ner" }), NerSidecarError);
    assert.equal(stale.calls.filter((c) => c.method === "PUT").length, 2, "re-registers once, then gives up");
    const unscoped = fakeSidecar((body) => (n++, { json: { requestId: body.requestId, spans: [sarahSpan([{ id: "ct_2984", entity: "lead" }])] } }));
    await assert.rejects(askScopedExtract(store, { requestId: "a", utterance: "Sarah Johnson" }, { fetchImpl: unscoped.fetchImpl, url: "http://ner" }), /not ask/);
    const down = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    await assert.rejects(askScopedExtract(store, { requestId: "a", utterance: "Sarah Johnson" }, { fetchImpl: down, url: "http://ner" }), NerSidecarError);
  });
});

// Against a running sidecar with scope support (skipped when there isn't one).
const live = await fetch(`${nerSidecarUrl()}/v1/scopes/${ASK_SCOPE}`).then((r) => r.status === 200 || r.status === 404, () => false);
describe("Ask-scoped NER, live sidecar", { skip: !live && "no scope-capable NER sidecar running" }, () => {
  test("Sarah Johnson is only Ask's two contacts; Clear Finance has no link; the default caller keeps the big index", async () => {
    const { store } = world();
    const sarah = await askScopedExtract(store, { requestId: "live1", utterance: "Email Sarah Johnson about the renewal" });
    const s = sarah.spans.find((x) => x.text === "Sarah Johnson");
    assert.ok(s, JSON.stringify(sarah));
    assert.deepEqual(new Set(ids(s)), new Set(askEntities(store).filter((e) => e.name === "Sarah Johnson").map((e) => e.id)));
    assert.ok(ids(s).includes("ct_31"));
    for (const u of ["What deals are open at Clear Finance?", "Email someone at Clear Finace about billing"]) {
      const r = await askScopedExtract(store, { requestId: "live2", utterance: u });
      for (const sp of r.spans) { assert.ok(!sp.linkedId, JSON.stringify(sp)); assert.ok(!ids(sp).some((id) => BIG.includes(id)), JSON.stringify(sp)); }
    }
    const big = await fetch(`${nerSidecarUrl()}/v1/extract`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: "live3", utterance: "What deals are open at Clear Finance?" }) }).then((r) => r.json() as Promise<{ spans: NerLinkedSpan[] }>);
    assert.ok(big.spans.some((sp) => sp.linkedId === "co_1"), JSON.stringify(big));
  });
});
