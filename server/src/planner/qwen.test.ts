import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import { needsJsonObject, QwenPlanner } from "./qwen.js";
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

    respond = (res, body) => {
      const r = reply(body.model, '{"type":"pl');
      r.choices[0]!.finish_reason = "length";
      send(res, 200, r);
    };
    await assert.rejects(planner().plan(req()), (err) => {
      assert.ok(kind("bad_json")(err));
      assert.match((err as Error).message, /cut off at 8192 tokens/);
      return true;
    });

    respond = (res, body) => {
      const r = reply(body.model, "");
      r.choices[0]!.finish_reason = "content_filter";
      send(res, 200, r);
    };
    await assert.rejects(planner().plan(req()), (err) => {
      assert.ok(kind("provider")(err));
      assert.match((err as Error).message, /content filter/);
      return true;
    });
  });

  it("keeps a valid plan when usage is missing or inconsistent", async () => {
    respond = (res, body) => send(res, 200, { choices: reply(body.model, "{}").choices });
    const bare = await planner().plan(req());
    assert.deepEqual(bare.json, {});
    assert.deepEqual([bare.usage.input, bare.usage.output, bare.usage.thinking], [0, 0, 0]);

    respond = (res, body) =>
      send(res, 200, {
        ...reply(body.model, "{}"),
        usage: { prompt_tokens: 10, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: 3 } },
      });
    const odd = await planner().plan(req());
    assert.deepEqual([odd.usage.output, odd.usage.thinking], [0, 2]);
  });

  it("retries a gateway error or a short rate-limit wait once, but not a quota", async () => {
    let calls = 0;
    respond = (res, body) => (++calls === 1 ? send(res, 503, { error: { message: "busy" } }) : send(res, 200, reply(body.model, "{}")));
    assert.deepEqual((await planner().plan(req())).json, {});
    assert.equal(captured.length, 2);

    captured = [];
    respond = (res) => send(res, 502, { error: { message: "bad gateway" } });
    await assert.rejects(planner().plan(req()), kind("provider"));
    assert.equal(captured.length, 2);

    captured = [];
    calls = 0;
    respond = (res, body) => (++calls === 1 ? send(res, 429, { error: { message: "slow down" } }, { "retry-after": "0" }) : send(res, 200, reply(body.model, "{}")));
    assert.deepEqual((await planner().plan(req())).json, {});
    assert.equal(captured.length, 2);

    captured = [];
    respond = (res) => send(res, 429, { error: { message: "quota exceeded" } });
    await assert.rejects(planner().plan(req()), kind("rate_limited"));
    assert.equal(captured.length, 1);
  });

  it("turns thinking off unless asked", async () => {
    await planner().plan(req());
    assert.equal(captured[0]!.body.enable_thinking, false);
    await new QwenPlanner({ apiKey: "k", baseUrl, models: { fast: "f", strong: "s" }, thinking: true }).plan(req());
    assert.equal(captured[1]!.body.enable_thinking, true);
  });

  it("falls back to json_object with the schema in the prompt when asked", async () => {
    await new QwenPlanner({ apiKey: "k", baseUrl, models: { fast: "f", strong: "s" }, responseFormat: "json_object" }).plan(req());
    assert.deepEqual(captured[0]!.body.response_format, { type: "json_object" });
    assert.match(captured[0]!.body.messages[0].content, /^Planner instructions\n\nReply with one JSON object.*"properties"/s);
  });

  it("picks the format from the model: json_object for one without json_schema", async () => {
    const ds = new QwenPlanner({ apiKey: "k", baseUrl, models: { fast: "deepseek-v4.1-flash-1017", strong: "deepseek-v4.1-flash-1017" } });
    await ds.plan(req());
    assert.deepEqual(captured[0]!.body.response_format, { type: "json_object" });
    assert.match(captured[0]!.body.messages[0].content, /Reply with one JSON object.*"properties"/s);

    assert.equal(needsJsonObject("deepseek-v4.1-flash-1017"), true);
    assert.equal(needsJsonObject(" DeepSeek-V5 "), true);
    assert.equal(needsJsonObject("qwen3.8-flash"), false);

    // An explicit setting still wins over what the model name says.
    const pinned = new QwenPlanner({ apiKey: "k", baseUrl, models: { fast: "deepseek-v4.1-flash-1017", strong: "x" }, responseFormat: "json_schema" });
    await pinned.plan(req());
    assert.equal(captured[1]!.body.response_format.type, "json_schema");
  });

  it("retries a rejected response format as json_object, then remembers the model", async () => {
    // The fallback covers a model whose name doesn't advertise the limitation (qwen3.6 rejected the schema
    // keyword the plan needs): one wasted call, then the process stops asking.
    let calls = 0;
    respond = (res, body) =>
      ++calls === 1
        ? send(res, 400, { error: { code: "invalid_parameter_error", message: "This response_format type is unavailable now" } })
        : send(res, 200, reply(body.model, "{}"));
    const ds = planner();

    assert.deepEqual((await ds.plan(req())).json, {});
    assert.equal(captured.length, 2);
    assert.equal(captured[0]!.body.response_format.type, "json_schema");
    assert.deepEqual(captured[1]!.body.response_format, { type: "json_object" });

    // The model is remembered, so the next turn doesn't pay for the same 400.
    assert.deepEqual((await ds.plan(req())).json, {});
    assert.equal(captured.length, 3);
    assert.deepEqual(captured[2]!.body.response_format, { type: "json_object" });
  });

  it("does not retry a 400 that isn't about the response format", async () => {
    respond = (res) => send(res, 400, { error: { message: "invalid messages" } });
    await assert.rejects(planner().plan(req()), (err) => {
      assert.ok(kind("provider")(err));
      assert.match((err as Error).message, /qwen-fast: HTTP 400: invalid messages/);
      return true;
    });
    assert.equal(captured.length, 1);
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

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", connection: "close", ...headers });
  res.end(JSON.stringify(body));
}
