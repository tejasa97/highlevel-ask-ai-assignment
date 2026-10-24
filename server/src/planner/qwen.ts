import { type Planner, type PlanRequest, type PlanResult, PlannerError, type Tier } from "./types.js";

export const QWEN_DEFAULT_BASE_URL = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_TOKENS = 8192;

interface Options {
  apiKey: string;
  baseUrl?: string;
  models: Record<Tier, string>;
  timeoutMs?: number;
}

/** Raw, tool-free calls to an OpenAI-compatible endpoint (Qwen Token Plan by default). */
export class QwenPlanner implements Planner {
  readonly name = "qwen";
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: Options) {
    const apiKey = options.apiKey.trim();
    if (!apiKey) throw new Error("Qwen: an API key is required");
    this.apiKey = apiKey;
    this.endpoint = `${(options.baseUrl ?? QWEN_DEFAULT_BASE_URL).replace(/\/+$/, "")}/chat/completions`;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async plan(req: PlanRequest): Promise<PlanResult> {
    const model = this.options.models[req.tier];
    const signal = AbortSignal.any([
      ...(req.signal ? [req.signal] : []),
      AbortSignal.timeout(this.timeoutMs),
    ]);
    if (signal.aborted) throw failure("request cancelled", "timeout");

    const started = performance.now();
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.user },
          ],
          response_format: {
            type: "json_schema",
            json_schema: { name: "submit_plan", strict: true, schema: req.schema },
          },
          max_tokens: MAX_TOKENS,
        }),
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw failure("request cancelled or timed out", "timeout");
      throw failure(`request failed: ${(err as Error).message}`);
    }

    let raw: string;
    try {
      raw = await response.text();
    } catch (err) {
      if (signal.aborted) throw failure("request cancelled or timed out", "timeout");
      throw failure(`could not read the reply: ${(err as Error).message}`);
    }
    if (Buffer.byteLength(raw) > MAX_BYTES) throw failure("response exceeds 4 MiB limit");

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      body = undefined;
    }
    if (!response.ok) {
      const detail = errorMessage(body) ?? raw.trim().slice(0, 500);
      const message = `HTTP ${response.status}${detail ? `: ${detail}` : ""}`;
      throw failure(message, rateLimited(response.status, detail));
    }
    if (body === undefined) throw failure("reply is not JSON", "provider");

    const message = record(record(choiceAt(body))?.message);
    const content = typeof message?.content === "string" ? message.content : "";
    if (!content.trim()) throw new PlannerError("Qwen returned no message content", "bad_json", raw.slice(0, 500));

    let json: unknown;
    try {
      json = JSON.parse(unfence(content));
    } catch {
      throw new PlannerError("Qwen returned invalid JSON", "bad_json", content);
    }

    return {
      model,
      json,
      text: content,
      latencyMs: performance.now() - started,
      usage: { ...parseUsage(record(body)?.usage), billing: "subscription", costUsd: null },
    };
  }
}

function choiceAt(body: unknown): unknown {
  const choices = record(body)?.choices;
  return Array.isArray(choices) ? choices[0] : undefined;
}

function unfence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```[a-z]*\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed);
  return (fenced?.[1] ?? trimmed).trim();
}

function parseUsage(value: unknown) {
  const u = record(value);
  const prompt = record(u?.prompt_tokens_details);
  const completion = record(u?.completion_tokens_details);
  const input = count(u?.prompt_tokens, "prompt_tokens");
  const outputTotal = count(u?.completion_tokens, "completion_tokens");
  const cachedRead = count(prompt?.cached_tokens, "cached_tokens", 0);
  const thinking = count(completion?.reasoning_tokens, "reasoning_tokens", 0);
  if (cachedRead > input) throw failure("cached tokens exceed total input");
  if (thinking > outputTotal) throw failure("reasoning tokens exceed total output");
  return { input, cachedRead, cacheWrite: 0, output: outputTotal - thinking, thinking };
}

function count(value: unknown, name: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw failure(`invalid or missing ${name} usage`);
  }
  return value;
}

function errorMessage(body: unknown): string | undefined {
  const error = record(record(body)?.error);
  const message = error?.message;
  return typeof message === "string" ? message.slice(0, 500) : undefined;
}

function rateLimited(status: number, detail?: string): "rate_limited" | "provider" {
  return status === 429 || /rate.?limit|quota|usage.?limit|credit|balance|arrear/i.test(detail ?? "")
    ? "rate_limited"
    : "provider";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function failure(message: string, kind: PlannerError["kind"] = "provider"): PlannerError {
  return new PlannerError(`Qwen: ${message.slice(0, 500)}`, kind);
}
