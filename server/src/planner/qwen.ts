import { type Planner, type PlanRequest, type PlanResult, PlannerError, type Tier } from "./types.js";

export const QWEN_DEFAULT_BASE_URL = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_TOKENS = 8192;
const RETRIES = 1;
const RETRY_MS = 1000;
const MAX_RETRY_AFTER_MS = 10_000;

interface Options {
  apiKey: string;
  baseUrl?: string;
  models: Record<Tier, string>;
  timeoutMs?: number;
  /** Qwen3 hybrid models think by default; planning doesn't need it and it costs latency and tokens. */
  thinking?: boolean;
}

/** Raw, tool-free calls to an OpenAI-compatible endpoint (Qwen Token Plan by default). */
export class QwenPlanner implements Planner {
  readonly name = "qwen";
  readonly billing = "subscription";
  readonly models: Record<Tier, string>;
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: Options) {
    const apiKey = options.apiKey.trim();
    if (!apiKey) throw new Error("Qwen: an API key is required");
    this.apiKey = apiKey;
    this.models = options.models;
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
    const payload = JSON.stringify({
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
      enable_thinking: this.options.thinking ?? false,
    });
    // One retry for a dropped connection, a gateway error or a short rate-limit wait;
    // a quota or a bad request fails at once, so the caller sees it.
    let response: Response | undefined;
    for (let attempt = 0; !response; attempt++) {
      let retryIn: number;
      try {
        const reply = await fetch(this.endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
          body: payload,
          signal,
        });
        const delay = attempt < RETRIES ? retryDelay(reply) : undefined;
        if (delay === undefined) {
          response = reply;
          break;
        }
        await reply.body?.cancel().catch(() => {});
        retryIn = delay;
      } catch (err) {
        if (signal.aborted) throw failure("request cancelled or timed out", "timeout");
        if (attempt >= RETRIES) throw failure(`request failed: ${(err as Error).message}`);
        retryIn = RETRY_MS;
      }
      try {
        await sleep(retryIn, signal);
      } catch {
        throw failure("request cancelled or timed out", "timeout");
      }
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

    const choice = record(choiceAt(body));
    const finish = choice?.finish_reason;
    if (finish === "content_filter") throw failure("the reply was blocked by the content filter");
    const message = record(choice?.message);
    const content = typeof message?.content === "string" ? message.content : "";
    if (!content.trim()) throw new PlannerError("Qwen returned no message content", "bad_json", raw.slice(0, 500));

    let json: unknown;
    try {
      json = JSON.parse(unfence(content));
    } catch {
      const why = finish === "length" ? `the reply was cut off at ${MAX_TOKENS} tokens` : "invalid JSON";
      throw new PlannerError(`Qwen returned ${why}`, "bad_json", content);
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

/** How long to wait before retrying this response, or undefined when it shouldn't be retried. */
function retryDelay(response: Response): number | undefined {
  if ([500, 502, 503, 504].includes(response.status)) return RETRY_MS;
  if (response.status !== 429) return undefined;
  // Only a short, explicit Retry-After (seconds) is a burst limit; anything else may be the plan's quota.
  const header = response.headers.get("retry-after")?.trim();
  const seconds = header ? Number(header) : NaN;
  return Number.isFinite(seconds) && seconds >= 0 && seconds * 1000 <= MAX_RETRY_AFTER_MS ? seconds * 1000 : undefined;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, ms);
    const stop = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener("abort", stop, { once: true });
  });
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

/** Usage is bookkeeping: a missing or odd count reads as 0 rather than discarding a valid plan. */
function parseUsage(value: unknown) {
  const u = record(value);
  const prompt = record(u?.prompt_tokens_details);
  const completion = record(u?.completion_tokens_details);
  const input = count(u?.prompt_tokens);
  const outputTotal = count(u?.completion_tokens);
  const cachedRead = Math.min(count(prompt?.cached_tokens), input);
  const thinking = Math.min(count(completion?.reasoning_tokens), outputTotal);
  return { input, cachedRead, cacheWrite: 0, output: outputTotal - thinking, thinking };
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
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
