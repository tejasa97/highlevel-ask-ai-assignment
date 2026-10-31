/**
 * Thin TypeScript facade for the Python GLiNER NER sidecar: an optional dependency. Without it, or when it is slow,
 * down or wrong, a turn goes on with no NER hints and behaves as if NER were off.
 *
 * NER_MODE=off|shadow|on (default off; NER_SIDECAR=1 or ASK_NER=1 still mean on). shadow calls the sidecar and traces
 * what it found, but nothing reaches retrieval or the planner.
 * NER_SIDECAR_URL (default http://127.0.0.1:8091). NER_TIMEOUT_MS caps each call (default 1500), and the turn's own
 * deadline caps it further. NER_BREAKER_FAILURES consecutive failures (default 3) skip the sidecar for
 * NER_BREAKER_COOLDOWN_MS (default 30000), then one probe call decides. NER_LOG=errors|all|off (default errors): one
 * JSON line per call on stderr, keyed by requestId.
 *
 * Every response is validated against the shared contract (ner_sidecar_contract.ts). Failures are classified as
 * unreachable | timeout | http | invalid | cancelled. A cancel is the user's: it ends the turn, it never counts
 * against the sidecar.
 *
 * Does not call Store resolvers. Ambiguous spans never auto-pick candidates[0].
 */
import type { Mention } from "./mentions.js";
import {
  ambiguousOptions,
  clarifyFromAmbiguousSpan,
  describeIssues,
  isUniqueLink,
  type NerClarifyReply,
  type NerLinkedSpan,
  type NerSidecarRequest,
  type NerSidecarResponse,
  nerSidecarResponseSchema,
  type NerVersions,
} from "./ner_sidecar_contract.js";

const DEFAULT_URL = "http://127.0.0.1:8091";
const EXTRACT_PATH = "/v1/extract";
const truthy = (v: string | undefined) => v === "1" || v === "true" || v === "yes";

export type NerMode = "off" | "shadow" | "on";

/** NER_MODE, else the older NER_SIDECAR / ASK_NER flag (on), else off. An unknown NER_MODE is off. */
export function nerMode(env: NodeJS.ProcessEnv = process.env): NerMode {
  const m = env.NER_MODE?.trim().toLowerCase();
  if (m) return m === "on" || m === "shadow" ? m : "off";
  return truthy(env.NER_SIDECAR ?? env.ASK_NER) ? "on" : "off";
}

/** True when the ask path should call the NER sidecar at all (on or shadow). */
export function nerSidecarEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return nerMode(env) !== "off";
}

export function nerSidecarUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.NER_SIDECAR_URL ?? DEFAULT_URL).trim().replace(/\/$/, "");
  return raw || DEFAULT_URL;
}

const intEnv = (v: string | undefined, fallback: number, min = 0) => {
  const n = v === undefined || v.trim() === "" ? NaN : Number(v);
  return Number.isInteger(n) && n >= min ? n : fallback;
};

/** Upper bound for one sidecar call (extract, plus a scope push when the index changed). */
export const nerTimeoutMs = (env: NodeJS.ProcessEnv = process.env) => intEnv(env.NER_TIMEOUT_MS, 1500, 1);

export type NerFailureKind = "unreachable" | "timeout" | "http" | "invalid" | "cancelled";

export class NerSidecarError extends Error {
  readonly status?: number;
  readonly cause?: unknown;
  constructor(
    message: string,
    readonly kind: NerFailureKind = "unreachable",
    opts: { status?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "NerSidecarError";
    this.status = opts.status;
    this.cause = opts.cause;
  }
}

/** A failed fetch: timeout or cancel when the signal says so, else the sidecar is unreachable. */
export function fetchFailure(err: unknown, base: string, signal?: AbortSignal): NerSidecarError {
  if (signal?.aborted) {
    const timedOut = (signal.reason as { name?: string } | undefined)?.name === "TimeoutError";
    return new NerSidecarError(timedOut ? `NER sidecar at ${base} timed out` : "NER call cancelled", timedOut ? "timeout" : "cancelled", { cause: err });
  }
  return new NerSidecarError(`NER sidecar unreachable at ${base}: ${err instanceof Error ? err.message : String(err)}`, "unreachable", { cause: err });
}

/** A non-2xx answer, with its status and the start of its body. */
export async function httpFailure(res: Response, what: string): Promise<NerSidecarError> {
  const body = await res.text().catch(() => "");
  return new NerSidecarError(`${what}: HTTP ${res.status}${body ? ` ${body.slice(0, 200)}` : ""}`, "http", { status: res.status });
}

/** POST /v1/extract against the sidecar; the answer is checked against the contract and must echo the requestId. */
export async function extractAndLink(
  request: NerSidecarRequest,
  opts: { url?: string; signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<NerSidecarResponse> {
  const base = opts.url ?? nerSidecarUrl();
  const fetchImpl = opts.fetchImpl ?? fetch;
  let res: Response;
  let json: unknown;
  try {
    res = await fetchImpl(`${base}${EXTRACT_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "x-request-id": request.requestId },
      body: JSON.stringify(request),
      signal: opts.signal,
    });
    if (!res.ok) throw await httpFailure(res, "NER sidecar");
    json = await res.json().catch((err: unknown) => {
      if (opts.signal?.aborted) throw err;
      throw new NerSidecarError(`NER sidecar response is not JSON: ${err instanceof Error ? err.message : String(err)}`, "invalid", { cause: err });
    });
  } catch (err) {
    if (err instanceof NerSidecarError) throw err;
    throw fetchFailure(err, base, opts.signal);
  }
  const parsed = nerSidecarResponseSchema.safeParse(json);
  if (!parsed.success) throw new NerSidecarError(`NER sidecar response breaks the contract: ${describeIssues(parsed.error)}`, "invalid");
  if (parsed.data.requestId !== request.requestId) throw new NerSidecarError(`NER sidecar answered requestId ${parsed.data.requestId}, not ${request.requestId}`, "invalid");
  return parsed.data;
}

export type BreakerState = "closed" | "open" | "half_open";

/**
 * In-process circuit breaker: `threshold` consecutive failures open it, and while open the sidecar isn't called.
 * After `cooldownMs` one probe call is let through (half-open): success closes it, failure opens it again.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private probing = false;
  state: BreakerState = "closed";

  constructor(
    readonly threshold: number,
    readonly cooldownMs: number,
    private readonly onChange: (from: BreakerState, to: BreakerState, failures: number) => void = () => {},
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** May a call go out now? A true from a half-open breaker claims its one probe. */
  allow(): boolean {
    if (this.state === "open" && this.now() - this.openedAt >= this.cooldownMs) this.move("half_open");
    if (this.state === "closed") return true;
    if (this.state === "half_open" && !this.probing) return (this.probing = true);
    return false;
  }

  success(): void {
    this.failures = 0;
    this.probing = false;
    if (this.state !== "closed") this.move("closed");
  }

  failure(): void {
    this.failures += 1;
    this.probing = false;
    if (this.state === "half_open" || (this.state === "closed" && this.failures >= this.threshold)) {
      this.openedAt = this.now();
      this.move("open");
    }
  }

  /** A call that ended for a reason that says nothing about the sidecar (the user cancelled): no verdict. */
  release(): void {
    this.probing = false;
  }

  private move(to: BreakerState) {
    const from = this.state;
    this.state = to;
    this.onChange(from, to, this.failures);
  }
}

export type NerLog = (line: Record<string, unknown>) => void;

/** One JSON line on stderr. NER_LOG=all logs successful calls too; off logs nothing. */
export function nerLog(env: NodeJS.ProcessEnv = process.env): NerLog {
  const level = (env.NER_LOG ?? "errors").toLowerCase();
  return (line) => {
    if (level === "off" || (level !== "all" && line.outcome === "ok")) return;
    console.error(JSON.stringify({ ts: new Date().toISOString(), ...line }));
  };
}

const breakers = new Map<string, CircuitBreaker>();

/** The process-wide breaker for a sidecar URL. */
export function nerBreaker(url = nerSidecarUrl(), env: NodeJS.ProcessEnv = process.env, log: NerLog = nerLog(env)): CircuitBreaker {
  let b = breakers.get(url);
  if (!b) {
    b = new CircuitBreaker(intEnv(env.NER_BREAKER_FAILURES, 3, 1), intEnv(env.NER_BREAKER_COOLDOWN_MS, 30_000), (from, to, failures) =>
      log({ evt: "ner.breaker", url, from, to, failures, outcome: "breaker" }));
    breakers.set(url, b);
  }
  return b;
}

/** Tests: forget every breaker. */
export const resetNerBreakers = () => breakers.clear();

/** What one turn's NER call did; emitted as the turn's `ner` event and logged. */
export interface NerTrace {
  requestId: string;
  mode: Exclude<NerMode, "off">;
  /** ok, a failure kind, or skipped (breaker open, or no time left in the turn). */
  outcome: "ok" | "skipped" | NerFailureKind;
  latencyMs: number;
  timeoutMs: number;
  breaker?: BreakerState;
  /** Set when skipped. */
  reason?: "breaker_open" | "no_time_left";
  status?: number;
  error?: string;
  spans?: number;
  scope?: string;
  model?: string;
  versions?: NerVersions;
  /** Whether the spans reached retrieval and the planner (only in mode on, only on ok). */
  applied: boolean;
}

export interface RunNerOpts {
  requestId: string;
  mode: Exclude<NerMode, "off">;
  timeoutMs: number;
  /** The turn's signal: when it aborts, the outcome is cancelled. */
  signal?: AbortSignal;
  breaker?: CircuitBreaker;
  log?: NerLog;
}

/** Rejects as soon as the signal aborts, even if `p` ignores it. */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * One NER call with the turn's guard rails: a timeout (combined with the turn's signal), the breaker, failure
 * classification, a trace and a log line. Never throws for a sidecar problem; the caller checks
 * `trace.outcome === "cancelled"` to end the turn. Anything that isn't a sidecar problem (a bug) is rethrown.
 */
export async function runNer(call: (signal: AbortSignal) => Promise<NerSidecarResponse>, opts: RunNerOpts): Promise<{ response?: NerSidecarResponse; trace: NerTrace }> {
  const log = opts.log ?? nerLog();
  const base = { requestId: opts.requestId, mode: opts.mode, timeoutMs: opts.timeoutMs, applied: false };
  const finish = (trace: NerTrace, response?: NerSidecarResponse) => {
    log({ evt: "ner", ...trace });
    return { response, trace };
  };
  if (opts.signal?.aborted) return finish({ ...base, outcome: "cancelled", latencyMs: 0 });
  if (opts.timeoutMs <= 0) return finish({ ...base, outcome: "skipped", reason: "no_time_left", latencyMs: 0, breaker: opts.breaker?.state });
  if (opts.breaker && !opts.breaker.allow()) return finish({ ...base, outcome: "skipped", reason: "breaker_open", latencyMs: 0, breaker: opts.breaker.state });

  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  try {
    const res = await untilAborted(call(signal), signal);
    opts.breaker?.success();
    return finish(
      {
        ...base,
        outcome: "ok",
        latencyMs: ms(),
        breaker: opts.breaker?.state,
        spans: res.spans.length,
        ...(res.scope ? { scope: res.scope } : {}),
        ...(res.model ? { model: res.model } : {}),
        ...(res.versions ? { versions: res.versions } : {}),
        applied: opts.mode === "on",
      },
      res,
    );
  } catch (err) {
    // The turn's own signal wins: a user cancel is never the sidecar's fault, whatever the call reported.
    const kind: NerFailureKind | undefined = opts.signal?.aborted ? "cancelled" : timeout.aborted ? "timeout" : err instanceof NerSidecarError ? err.kind : undefined;
    if (!kind) throw err;
    if (kind === "cancelled") opts.breaker?.release();
    else opts.breaker?.failure();
    const status = err instanceof NerSidecarError ? err.status : undefined;
    const error = err instanceof Error ? err.message : String(err);
    return finish({ ...base, outcome: kind, latencyMs: ms(), breaker: opts.breaker?.state, ...(status ? { status } : {}), error });
  }
}

/** Map PoC / GLiNER labels onto CRM entity names used by Mention / retrieval. */
export function entityForSpan(span: NerLinkedSpan): string | undefined {
  if (span.linkedEntity) return span.linkedEntity;
  const fromCand = span.candidates?.find((c) => c.entity)?.entity;
  if (fromCand) return fromCand;
  switch (span.label) {
    case "company":
      return "company";
    case "team":
      return "team";
    case "contact":
    case "lead":
    case "user":
      return span.label;
    case "person":
      return "contact";
    default:
      return undefined;
  }
}

/**
 * Turn linked / ambiguous NER spans into Mention[]. Misses and rule-only
 * (email/phone/id without CRM entity) are omitted so existing create/search
 * behavior still owns unknowns.
 */
export function spansToMentions(spans: NerLinkedSpan[]): Mention[] {
  const out: Mention[] = [];
  for (const span of spans) {
    if (span.status === "miss") continue;
    const entity = entityForSpan(span);
    if (!entity) continue;
    if (span.status === "ambiguous") {
      const count = Math.max(2, span.candidates?.length ?? 2);
      if (!out.some((m) => m.name === span.text && m.entity === entity)) {
        out.push({
          name: span.text,
          entity,
          count,
          ambiguous: true,
          candidates: span.candidates?.map((c) => ({
            id: c.id,
            name: c.name,
            detail: c.detail,
            entity: c.entity,
          })),
          method: span.method,
          score: span.score,
          ...(isNearMissSuggestion(span) ? { suggestion: true } : {}),
        });
      }
      continue;
    }
    if (!isUniqueLink(span)) continue;
    if (!out.some((m) => m.name === span.text && m.entity === entity)) {
      out.push({
        name: span.text,
        entity,
        count: 1,
        linkedId: span.linkedId,
        ...(span.candidates?.length ? { candidates: span.candidates.map((c) => ({ id: c.id, name: c.name, detail: c.detail, entity: c.entity })) } : {}),
        method: span.method,
        score: span.score,
        ...(span.method === "edit" ? { suggestion: true } : {}),
      });
    }
  }
  return out;
}

/**
 * Prefer NER-linked / NER-ambiguous mentions; keep Title-Case Store mentions
 * for names the sidecar did not cover.
 */
export function mergeMentions(ner: Mention[], legacy: Mention[]): Mention[] {
  const covered = new Set(ner.map((m) => normKey(m.name)));
  const kept = legacy.filter((m) => !covered.has(normKey(m.name)));
  return [...ner, ...kept];
}

const normKey = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();

function normSurface(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when candidates look like near-miss suggestions (typo/partial), not exact-name dupes. */
export function isNearMissSuggestion(span: NerLinkedSpan): boolean {
  const cands = span.candidates ?? [];
  if (cands.length === 0) return false;
  const surface = normSurface(span.text);
  const nameDiffers = cands.some((c) => normSurface(c.name) !== surface);
  const softScore = typeof span.score === "number" && span.score < 0.9;
  const embedNonExact =
    span.method === "embed" && cands.some((c) => normSurface(c.name) !== surface);
  const editMethod = span.method === "edit";
  return nameDiffers || softScore || embedNonExact || editMethod;
}

/** First ambiguous span → planner-style clarify reply (never picks a winner). */
export function clarifyFromSpans(spans: NerLinkedSpan[]): NerClarifyReply | undefined {
  for (const span of spans) {
    if (span.status !== "ambiguous") continue;
    const entity = entityForSpan(span) ?? "record";
    const n = span.candidates?.length ?? 0;
    const firstName = span.candidates?.[0]?.name;
    let text: string;
    if (n > 0 && isNearMissSuggestion(span)) {
      text =
        n === 1 && firstName
          ? `Did you mean ${firstName}?`
          : `Did you mean one of these instead of ${span.text}?`;
    } else if (n > 0) {
      text = `I found ${n} matching ${entity.replaceAll("_", " ")} records named ${span.text}. Which one did you mean?`;
    } else {
      text = `Which ${entity.replaceAll("_", " ")} did you mean by ${span.text}?`;
    }
    return clarifyFromAmbiguousSpan(span, text) ?? { status: "clarify", text, options: ambiguousOptions(span) };
  }
  return undefined;
}

export { ambiguousOptions, clarifyFromAmbiguousSpan, isUniqueLink };
