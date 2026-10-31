import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Mention } from "./mentions.js";
import {
  CircuitBreaker,
  clarifyFromSpans,
  entityForSpan,
  extractAndLink,
  mergeMentions,
  nerMode,
  nerSidecarEnabled,
  NerSidecarError,
  nerSidecarUrl,
  nerTimeoutMs,
  runNer,
  spansToMentions,
} from "./ner_client.js";
import type { NerLinkedSpan } from "./ner_sidecar_contract.js";

describe("ner_client flag / url", () => {
  test("NER_SIDECAR / ASK_NER enable the facade", () => {
    assert.equal(nerSidecarEnabled({}), false);
    assert.equal(nerSidecarEnabled({ NER_SIDECAR: "1" }), true);
    assert.equal(nerSidecarEnabled({ ASK_NER: "true" }), true);
    assert.equal(nerSidecarEnabled({ NER_SIDECAR: "0" }), false);
  });

  test("NER_MODE off|shadow|on wins over the older flag; an unknown mode is off", () => {
    assert.equal(nerMode({}), "off");
    assert.equal(nerMode({ NER_SIDECAR: "1" }), "on");
    assert.equal(nerMode({ NER_MODE: "shadow" }), "shadow");
    assert.equal(nerMode({ NER_MODE: "ON" }), "on");
    assert.equal(nerMode({ NER_MODE: "off", NER_SIDECAR: "1" }), "off");
    assert.equal(nerMode({ NER_MODE: "sometimes" }), "off");
    assert.equal(nerSidecarEnabled({ NER_MODE: "shadow" }), true);
  });

  test("NER_TIMEOUT_MS defaults to 1500 and ignores nonsense", () => {
    assert.equal(nerTimeoutMs({}), 1500);
    assert.equal(nerTimeoutMs({ NER_TIMEOUT_MS: "250" }), 250);
    assert.equal(nerTimeoutMs({ NER_TIMEOUT_MS: "0" }), 1500);
    assert.equal(nerTimeoutMs({ NER_TIMEOUT_MS: "soon" }), 1500);
  });

  test("NER_SIDECAR_URL defaults to localhost:8091", () => {
    assert.equal(nerSidecarUrl({}), "http://127.0.0.1:8091");
    assert.equal(nerSidecarUrl({ NER_SIDECAR_URL: "http://127.0.0.1:9091/" }), "http://127.0.0.1:9091");
  });
});

describe("spansToMentions / clarify", () => {
  const linked: NerLinkedSpan = {
    text: "Clear Finance",
    label: "company",
    start: 0,
    end: 13,
    status: "linked",
    linkedId: "co_1",
    linkedEntity: "company",
    method: "exact",
    score: 1,
  };
  const ambiguous: NerLinkedSpan = {
    text: "Sarah Johnson",
    label: "person",
    start: 8,
    end: 21,
    status: "ambiguous",
    candidates: [
      { id: "ct_a", name: "Sarah Johnson", detail: "Brightside", entity: "contact" },
      { id: "ct_b", name: "Sarah Johnson", detail: "gmail", entity: "contact" },
    ],
    method: "exact",
    score: 1,
  };
  const miss: NerLinkedSpan = {
    text: "Zed Nowhere",
    label: "person",
    start: 0,
    end: 11,
    status: "miss",
  };

  test("unique link becomes a count-1 mention with Store linkedId", () => {
    const m = spansToMentions([linked]);
    assert.deepEqual(m, [
      {
        name: "Clear Finance",
        entity: "company",
        count: 1,
        linkedId: "co_1",
        method: "exact",
        score: 1,
      },
    ]);
  });

  test("ambiguous becomes count>1 with candidates; never sets linkedId", () => {
    const m = spansToMentions([ambiguous]);
    assert.equal(m.length, 1);
    assert.equal(m[0]!.ambiguous, true);
    assert.equal(m[0]!.count, 2);
    assert.equal(m[0]!.linkedId, undefined);
    assert.equal(m[0]!.candidates?.[0]?.id, "ct_a");
  });

  test("miss spans are omitted (create/search owns unknowns)", () => {
    assert.deepEqual(spansToMentions([miss]), []);
  });

  test("clarifyFromSpans never picks candidates[0] as a winner", () => {
    const c = clarifyFromSpans([linked, ambiguous]);
    assert.ok(c);
    assert.equal(c!.status, "clarify");
    assert.deepEqual(c!.options, ["Sarah Johnson (Brightside)", "Sarah Johnson (gmail)"]);
    assert.match(c!.text, /Sarah Johnson/);
    assert.match(c!.text, /I found 2 matching/);
  });

  test("near-miss typo with one candidate uses Did you mean <name>?", () => {
    const nearMiss: NerLinkedSpan = {
      text: "Klar Finance",
      label: "company",
      start: 16,
      end: 28,
      status: "ambiguous",
      candidates: [{ id: "co_1", name: "Clear Finance", score: 0.82, entity: "company" }],
      method: "embed",
      score: 0.82,
    };
    const c = clarifyFromSpans([nearMiss]);
    assert.ok(c);
    assert.equal(c!.status, "clarify");
    assert.equal(c!.text, "Did you mean Clear Finance?");
    assert.deepEqual(c!.options, ["Clear Finance"]);
    assert.equal(c!.options?.[0], nearMiss.candidates?.[0]?.name);
  });

  test("near-miss with several candidates uses Did you mean one of these instead of …?", () => {
    const nearMiss: NerLinkedSpan = {
      text: "Sara Jonson",
      label: "person",
      start: 8,
      end: 19,
      status: "ambiguous",
      candidates: [
        { id: "ct_a", name: "Sarah Johnson", detail: "Brightside", entity: "contact", score: 0.81 },
        { id: "ct_b", name: "Sarah Johnson", detail: "gmail", entity: "contact", score: 0.8 },
      ],
      method: "embed",
      score: 0.81,
    };
    const c = clarifyFromSpans([nearMiss]);
    assert.ok(c);
    assert.equal(c!.text, "Did you mean one of these instead of Sara Jonson?");
    assert.deepEqual(c!.options, ["Sarah Johnson (Brightside)", "Sarah Johnson (gmail)"]);
  });

  test("miss without candidates still omits from spansToMentions and clarify", () => {
    assert.deepEqual(spansToMentions([miss]), []);
    assert.equal(clarifyFromSpans([miss, linked]), undefined);
  });

  test("near-miss ambiguous still becomes a mention with candidates (no linkedId)", () => {
    const nearMiss: NerLinkedSpan = {
      text: "Clear Fin",
      label: "company",
      start: 0,
      end: 9,
      status: "ambiguous",
      candidates: [{ id: "co_1", name: "Clear Finance", score: 0.88, entity: "company" }],
      method: "embed",
      score: 0.88,
    };
    const m = spansToMentions([nearMiss]);
    assert.equal(m.length, 1);
    assert.equal(m[0]!.ambiguous, true);
    assert.equal(m[0]!.linkedId, undefined);
    assert.equal(m[0]!.candidates?.[0]?.name, "Clear Finance");
  });

  test("entityForSpan prefers linkedEntity / candidate entity over person→contact", () => {
    assert.equal(entityForSpan(linked), "company");
    assert.equal(entityForSpan(ambiguous), "contact");
    assert.equal(entityForSpan({ ...miss, label: "person" }), "contact");
  });
});

describe("mergeMentions", () => {
  test("NER replaces same-name Title-Case mentions and keeps uncovered legacy", () => {
    const ner: Mention[] = [{ name: "Clear Finance", entity: "company", count: 1, linkedId: "co_1" }];
    const legacy: Mention[] = [
      { name: "Clear Finance", entity: "company", count: 1 },
      { name: "Yusuf Silva", entity: "contact", count: 1 },
    ];
    const merged = mergeMentions(ner, legacy);
    assert.equal(merged.filter((m) => m.name === "Clear Finance").length, 1);
    assert.equal(merged.find((m) => m.name === "Clear Finance")?.linkedId, "co_1");
    assert.ok(merged.some((m) => m.name === "Yusuf Silva"));
  });
});

const fetchOf = (fn: (init: RequestInit) => Promise<Response>) => ((_url: string, init: RequestInit) => fn(init)) as unknown as typeof fetch;
/** Never answers; rejects like fetch does when its signal aborts. */
const hang = fetchOf((init) => new Promise((_res, rej) => init.signal?.addEventListener("abort", () => rej(init.signal!.reason))));
const kindOf = async (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof NerSidecarError ? e.kind : `not a NerSidecarError: ${e}`));
const req = { requestId: "r1", utterance: "Email Sarah" };

describe("extractAndLink failure classes", () => {
  test("unreachable, http (with status), invalid JSON, invalid shape", async () => {
    assert.equal(await kindOf(extractAndLink(req, { url: "http://ner", fetchImpl: fetchOf(async () => { throw new TypeError("fetch failed"); }) })), "unreachable");
    const busy = extractAndLink(req, { url: "http://ner", fetchImpl: fetchOf(async () => new Response('{"overloaded":true}', { status: 503 })) });
    await assert.rejects(busy, (e: unknown) => e instanceof NerSidecarError && e.kind === "http" && e.status === 503);
    assert.equal(await kindOf(extractAndLink(req, { url: "http://ner", fetchImpl: fetchOf(async () => new Response("<html>")) })), "invalid");
    assert.equal(await kindOf(extractAndLink(req, { url: "http://ner", fetchImpl: fetchOf(async () => new Response('{"requestId":"r1"}')) })), "invalid");
  });

  test("an aborted signal is a timeout when it timed out, else a cancel", async () => {
    assert.equal(await kindOf(extractAndLink(req, { url: "http://ner", fetchImpl: hang, signal: AbortSignal.timeout(10) })), "timeout");
    const ctl = new AbortController();
    const call = kindOf(extractAndLink(req, { url: "http://ner", fetchImpl: hang, signal: ctl.signal }));
    ctl.abort();
    assert.equal(await call, "cancelled");
  });
});

describe("runNer", () => {
  const lines: Record<string, unknown>[] = [];
  const log = (l: Record<string, unknown>) => void lines.push(l);
  const base = { requestId: "r1", mode: "on" as const, timeoutMs: 1000, log };

  test("ok: traced with versions, applied only in mode on", async () => {
    const call = async () => ({ requestId: "r1", spans: [], scope: "ask", versions: { code: "0.2.0", model: "m@abc", index: "ask:v1" } });
    const on = await runNer(call, base);
    assert.equal(on.trace.outcome, "ok");
    assert.equal(on.trace.applied, true);
    assert.deepEqual(on.trace.versions, { code: "0.2.0", model: "m@abc", index: "ask:v1" });
    const shadow = await runNer(call, { ...base, mode: "shadow" });
    assert.equal(shadow.trace.applied, false);
    assert.ok(shadow.response);
    assert.ok(lines.some((l) => l.evt === "ner" && l.requestId === "r1"));
  });

  test("a call that ignores its signal still ends at the timeout", async () => {
    const started = performance.now();
    const { response, trace } = await runNer(() => new Promise(() => {}), { ...base, timeoutMs: 30 });
    assert.equal(trace.outcome, "timeout");
    assert.equal(response, undefined);
    assert.ok(performance.now() - started < 500);
  });

  test("the turn's cancel is a cancel, even mid-call, and doesn't count against the sidecar", async () => {
    const breaker = new CircuitBreaker(1, 60_000);
    const ctl = new AbortController();
    const run = runNer((signal) => extractAndLink(req, { url: "http://ner", fetchImpl: hang, signal }), { ...base, signal: ctl.signal, breaker });
    ctl.abort();
    assert.equal((await run).trace.outcome, "cancelled");
    assert.equal(breaker.state, "closed");
  });

  test("failures carry their class and HTTP status; a bug is not swallowed", async () => {
    const t = await runNer(() => Promise.reject(new NerSidecarError("NER sidecar: HTTP 503", "http", { status: 503 })), base);
    assert.deepEqual([t.trace.outcome, t.trace.status], ["http", 503]);
    await assert.rejects(runNer(() => Promise.reject(new RangeError("bug")), base), RangeError);
  });

  test("breaker: opens after N failures, skips while open, one probe after the cooldown", async () => {
    let now = 0;
    const changes: string[] = [];
    const breaker = new CircuitBreaker(2, 1000, (from, to) => void changes.push(`${from}>${to}`), () => now);
    const down = () => Promise.reject(new NerSidecarError("down", "unreachable"));
    let calls = 0;
    const counted = <T,>(f: () => Promise<T>) => () => { calls++; return f(); };
    const o = { ...base, breaker };
    assert.equal((await runNer(counted(down), o)).trace.outcome, "unreachable");
    assert.equal((await runNer(counted(down), o)).trace.outcome, "unreachable");
    assert.equal(breaker.state, "open");
    const skipped = await runNer(counted(down), o);
    assert.deepEqual([skipped.trace.outcome, skipped.trace.reason, calls], ["skipped", "breaker_open", 2]);
    now = 1000;
    // Half-open: exactly one probe goes out; a failed probe opens it again.
    assert.equal(breaker.allow(), true);
    assert.equal(breaker.allow(), false);
    breaker.failure();
    assert.equal(breaker.state, "open");
    now = 3000;
    const healed = await runNer(async () => ({ requestId: "r1", spans: [] }), o);
    assert.deepEqual([healed.trace.outcome, healed.trace.breaker], ["ok", "closed"]);
    assert.deepEqual(changes, ["closed>open", "open>half_open", "half_open>open", "open>half_open", "half_open>closed"]);
  });

  test("no time left in the turn: skipped without calling", async () => {
    let called = false;
    const t = await runNer(async () => { called = true; return { requestId: "r1", spans: [] }; }, { ...base, timeoutMs: 0 });
    assert.deepEqual([t.trace.outcome, t.trace.reason, called], ["skipped", "no_time_left", false]);
  });
});
