import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import { QwenPlanner } from "./qwen.js";
import { PlannerError, type PlanRequest } from "./types.js";

interface Captured {
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body: any;
}

let server: Server;
let baseUrl: string;
let captured: Captured[] = [];
let respond: (res: ServerResponse, body: any) => void;

before(async () => {
  server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    captured.push({ url: req.url, headers: req.headers, body });
    respond(res, body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/compatible-mode/v1`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  captured = [];
  respond = (res, body) => send(res, 200, reply(body.model, '{"type":"clarify"}'));
});

const planner = (timeoutMs?: number) =>
  new QwenPlanner({
    apiKey: "sk-sp-test",
    baseUrl: `${baseUrl}/`,
    models: { fast: "qwen-fast", strong: "qwen-strong" },
    ...(timeoutMs ? { timeoutMs } : {}),
  });

const req = (extra: Partial<PlanRequest> = {}): PlanRequest => ({
  tier: "fast",
  system: "Planner instructions",
  user: "<message>create a task</message>",
  schema: { type: "object", properties: { type: { type: "string" } } },
  ...extra,
});

const kind = (expected: PlannerError["kind"]) => (err: unknown) =>
  err instanceof PlannerError && err.kind === expected;

describe("QwenPlanner", () => {
  it("sends the OpenAI-compatible request and reports token-plan usage", async () => {
    const result = await planner().plan(req());

    assert.deepEqual(result.json, { type: "clarify" });
    assert.equal(result.text, '{"type":"clarify"}');
    assert.equal(result.model, "qwen-fast");
    assert.equal(typeof result.latencyMs, "number");
    assert.deepEqual(result.usage, {
      input: 100,
      cachedRead: 0,
      cacheWrite: 0,
      output: 20,
      thinking: 0,
      billing: "subscription",
      costUsd: null,
    });

    const sent = captured[0]!;
    assert.equal(sent.url, "/compatible-mode/v1/chat/completions");
    assert.equal(sent.headers.authorization, "Bearer sk-sp-test");
    assert.equal(sent.headers["content-type"], "application/json");
    assert.equal(sent.body.model, "qwen-fast");
    assert.equal(sent.body.max_tokens, 8192);
    assert.deepEqual(sent.body.messages, [
      { role: "system", content: "Planner instructions" },
      { role: "user", content: "<message>create a task</message>" },
    ]);
    assert.deepEqual(sent.body.response_format, {
      type: "json_schema",
      json_schema: { name: "submit_plan", strict: true, schema: req().schema },
    });
  });

  it("accepts fenced JSON and splits cached and reasoning tokens", async () => {
    respond = (res, body) =>
      send(res, 200, {
        ...reply(body.model, '```json\n{"type":"plan","steps":[]}\n```'),
        usage: {
          prompt_tokens: 100,
          completion_tokens: 30,
          prompt_tokens_details: { cached_tokens: 40 },
          completion_tokens_details: { reasoning_tokens: 12 },
        },
      });

    const result = await planner().plan(req());
    assert.deepEqual(result.json, { type: "plan", steps: [] });
    assert.deepEqual(result.usage, {
      input: 100,
      cachedRead: 40,
      cacheWrite: 0,
      output: 18,
      thinking: 12,
      billing: "subscription",
      costUsd: null,
    });
  });

  it("maps rate limits, HTTP errors and bad replies to planner errors", async () => {
    respond = (res) => send(res, 429, { error: { message: "quota exceeded" } });
    await assert.rejects(planner().plan(req()), (err) => {
      assert.ok(kind("rate_limited")(err));
      assert.match((err as Error).message, /quota exceeded/);
      assert.ok(!(err as Error).message.includes("sk-sp-test"));
      return true;
    });

    respond = (res) => send(res, 503, { error: { message: "service unavailable" } });
    await assert.rejects(planner().plan(req()), kind("provider"));

    respond = (res, body) => send(res, 200, reply(body.model, "not json"));
    await assert.rejects(planner().plan(req()), (err) => {
      assert.ok(kind("bad_json")(err));
      assert.equal((err as PlannerError).text, "not json");
      return true;
    });

    respond = (res) => send(res, 200, { choices: [] });
    await assert.rejects(planner().plan(req()), kind("bad_json"));

    respond = (res, body) => send(res, 200, { choices: reply(body.model, "{}").choices });
    await assert.rejects(planner().plan(req()), (err) => {
      assert.ok(kind("provider")(err));
      assert.match((err as Error).message, /prompt_tokens/);
      return true;
    });

    respond = (res, body) =>
      send(res, 200, {
        ...reply(body.model, "{}"),
        usage: { prompt_tokens: 10, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: 3 } },
      });
    await assert.rejects(planner().plan(req()), (err) => {
      assert.ok(kind("provider")(err));
      assert.match((err as Error).message, /reasoning tokens exceed total output/);
      return true;
    });
  });

  it("times out a stalled request and never sends a pre-aborted one", async () => {
    respond = () => {};
    await assert.rejects(planner(50).plan(req()), kind("timeout"));
    server.closeAllConnections();

    await new Promise((resolve) => setTimeout(resolve, 10));
    const count = captured.length;
    await assert.rejects(planner().plan(req({ signal: AbortSignal.abort() })), kind("timeout"));
    assert.equal(captured.length, count);
  });

  it("rejects an empty key", () => {
    assert.throws(
      () => new QwenPlanner({ apiKey: "  ", models: { fast: "f", strong: "s" } }),
      /API key is required/,
    );
  });
});

function reply(model: string, content: string) {
  return {
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 20 },
  };
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", connection: "close" });
  res.end(JSON.stringify(body));
}
