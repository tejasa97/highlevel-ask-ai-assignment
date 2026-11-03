import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DISABLED, KEEP_ENV, MAX_BYTES, type Reasoning, TIMEOUT_MS, failure, parseUsage } from "./codex-cli.js";
import { type Planner, type PlanRequest, type PlanResult, PlannerError, type Tier } from "./types.js";

interface Options {
  executable?: string;
  reasoning?: Record<Tier, Reasoning>;
}

type Json = Record<string, any>;
type Usage = ReturnType<typeof parseUsage>;
const STARTUP_MS = 30_000;
// What a planning turn may contain. Anything else (a command, a file change, a tool call) means the sandbox settings failed.
const ITEMS = new Set(["agentMessage", "reasoning", "userMessage"]);

/**
 * Local development only, like CodexCliPlanner, but one long-lived `codex app-server` serves every call instead of
 * one `codex exec` process per call: calls skip process start-up and teardown (about 1 s of a 5 s call) and run
 * concurrently as separate ephemeral threads. The app-server protocol is experimental (CLI 0.159.0).
 */
export class CodexAppServerPlanner implements Planner {
  readonly name = "codex-app-server";
  readonly billing = "subscription";
  private server?: Promise<Connection>;

  constructor(readonly models: Record<Tier, string>, private readonly options: Options = {}) {
    for (const effort of Object.values(options.reasoning ?? {})) {
      if (!["low", "medium", "high", "xhigh"].includes(effort)) throw new Error(`invalid Codex reasoning effort: ${effort}`);
    }
  }

  async plan(req: PlanRequest): Promise<PlanResult> {
    const signal = AbortSignal.any([...(req.signal ? [req.signal] : []), AbortSignal.timeout(TIMEOUT_MS)]);
    if (signal.aborted) throw new PlannerError("Codex request cancelled", "timeout");
    const started = performance.now();
    const model = this.models[req.tier];
    let conn: Connection | undefined, threadId: string | undefined, turnId: string | undefined;
    try {
      conn = await this.connection();
      const thread = await conn.request("thread/start", {
        ephemeral: true, model, baseInstructions: req.system, cwd: conn.cwd,
        approvalPolicy: "never", sandbox: "read-only", serviceName: "ask-ai-planner",
      }, signal);
      threadId = thread.thread.id as string;
      const watch = conn.watch(threadId);
      const turn = await conn.request("turn/start", {
        threadId, input: [{ type: "text", text: req.user }], outputSchema: req.schema,
        effort: this.options.reasoning?.[req.tier] ?? "low",
      }, signal);
      turnId = turn.turn.id as string;
      const aborted = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new PlannerError("Codex request cancelled or timed out", "timeout")), { once: true }));
      const { text, usage } = await Promise.race([watch.finished, aborted]);
      let json: unknown;
      try {
        if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("final output exceeds limit");
        json = JSON.parse(text);
      } catch {
        throw new PlannerError("Codex produced missing or invalid final JSON", "bad_json");
      }
      return { model, json, text, latencyMs: performance.now() - started, usage: { ...usage, billing: "subscription", costUsd: null } };
    } catch (err) {
      if (signal.aborted && conn && threadId && turnId) conn.request("turn/interrupt", { threadId, turnId }).catch(() => {});
      if (err instanceof PlannerError) throw err;
      throw failure(`request failed: ${(err as Error).message}`);
    } finally {
      if (conn && threadId) {
        conn.unwatch(threadId);
        conn.request("thread/unsubscribe", { threadId }).catch(() => {});
      }
    }
  }

  /** Stops the server process; the next call starts a new one. */
  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    (await server?.catch(() => undefined))?.stop();
  }

  private connection(): Promise<Connection> {
    this.server ??= Connection.start(this.options.executable ?? "codex", () => { this.server = undefined; }).catch((err) => {
      this.server = undefined;
      throw err;
    });
    return this.server;
  }
}

/** One app-server process: JSON-RPC requests out, notifications in, routed to the call watching that thread. */
class Connection {
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  private turns = new Map<string, TurnWatch>();
  private stderr = "";
  private buffered = "";
  private ended?: PlannerError;
  private starting = true;

  private constructor(private readonly child: ChildProcess, readonly cwd: string, private readonly onEnd: () => void) {
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (d: string) => this.read(d));
    child.stderr!.on("data", (d: Buffer) => { this.stderr = (this.stderr + d.toString()).slice(-2000); });
    child.stdin!.on("error", () => { /* the close handler reports the useful error */ });
    child.on("error", (err) => this.end(failure(`could not start codex app-server: ${err.message}`)));
    child.on("close", (code) => this.end(failure(`app-server exited ${code}: ${this.stderr.trim() || "no diagnostic"}. Check codex login status.`)));
    this.hold();
  }

  /** The idle server must not keep a finished script alive (it exits when our stdin closes), but a call in flight must. */
  private hold(): void {
    const busy = this.pending.size + this.turns.size > 0 || this.starting;
    for (const handle of [this.child, this.child.stdin, this.child.stdout, this.child.stderr] as unknown as { ref(): void; unref(): void }[]) busy ? handle.ref() : handle.unref();
  }

  static async start(executable: string, onEnd: () => void): Promise<Connection> {
    const cwd = await mkdtemp(join(tmpdir(), "ask-ai-codex-server-"));
    // No forced_login_method here: applying it to an API-key login deletes the shared login cache. account/read below
    // refuses anything but a ChatGPT login instead. mcp_servers={} keeps the user's own MCP servers out of the planner.
    const config = [
      'cli_auth_credentials_store="auto"', "mcp_servers={}",
      "project_doc_max_bytes=0", 'web_search="disabled"',
      "suppress_unstable_features_warning=true", "features.skip_host_skill_discovery=true",
      ...DISABLED.map((feature) => `features.${feature}=false`),
    ];
    const env = Object.fromEntries(KEEP_ENV.flatMap((k) => process.env[k] ? [[k, process.env[k]]] : []));
    const child = spawn(executable, ["app-server", ...config.flatMap((c) => ["-c", c])], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const conn = new Connection(child, cwd, onEnd);
    try {
      const signal = AbortSignal.timeout(STARTUP_MS);
      await conn.request("initialize", { clientInfo: { name: "ask-ai-planner", version: "0.0.1" } }, signal);
      conn.send({ method: "initialized" });
      const { account } = await conn.request("account/read", { refreshToken: false }, signal);
      conn.starting = false;
      conn.hold();
      if (account?.type !== "chatgpt") throw failure("ChatGPT sign-in is required. Run codex login to choose an account. The adapter did not change the existing login.");
      return conn;
    } catch (err) {
      conn.stop();
      throw err instanceof PlannerError ? err : failure(`could not start app-server: ${(err as Error).message}`);
    }
  }

  request(method: string, params: Json, signal?: AbortSignal): Promise<Json> {
    if (this.ended) return Promise.reject(this.ended);
    if (signal?.aborted) return Promise.reject(new PlannerError("Codex request cancelled", "timeout"));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      this.hold();
      signal?.addEventListener("abort", () => {
        if (this.pending.delete(id)) { reject(new PlannerError("Codex request cancelled or timed out", "timeout")); this.hold(); }
      }, { once: true });
      this.send({ id, method, params });
    });
  }

  send(message: Json): void {
    this.child.stdin!.write(`${JSON.stringify(message)}\n`);
  }

  watch(threadId: string): TurnWatch {
    const watch = new TurnWatch();
    this.turns.set(threadId, watch);
    this.hold();
    return watch;
  }

  unwatch(threadId: string): void {
    this.turns.delete(threadId);
    this.hold();
  }

  stop(reason = "app-server stopped"): void {
    this.end(failure(reason));
    try { this.child.kill("SIGTERM"); } catch { /* already exited */ }
  }

  private end(err: PlannerError): void {
    if (this.ended) return;
    this.ended = err;
    this.onEnd();
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    for (const t of this.turns.values()) t.fail(err);
    this.turns.clear();
    this.hold();
    void rm(this.cwd, { recursive: true, force: true });
  }

  private read(chunk: string): void {
    this.buffered += chunk;
    let i: number;
    while ((i = this.buffered.indexOf("\n")) >= 0) {
      const line = this.buffered.slice(0, i);
      this.buffered = this.buffered.slice(i + 1);
      if (line.trim()) this.handle(line);
    }
    if (this.buffered.length > MAX_BYTES) this.stop("app-server output exceeds 4 MiB without a newline");
  }

  private handle(line: string): void {
    let m: Json;
    try { m = JSON.parse(line); } catch { return this.stop("malformed JSON-RPC message"); }
    if (m.method && m.id !== undefined) {
      // A request from the server (an approval, a tool call): a planning turn has nobody to answer it.
      this.send({ id: m.id, error: { code: -32601, message: "the planner is non-interactive" } });
      this.turns.get(m.params?.threadId)?.fail(failure(`unexpected server request: ${m.method}`));
    } else if (m.method) {
      this.turns.get(m.params?.threadId)?.event(m.method, m.params);
    } else if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      this.hold();
      if (m.error) p?.reject(failure(m.error.message ?? "request failed"));
      else p?.resolve(m.result ?? {});
    }
  }
}

/** What one thread's turn has reported so far; settles when the turn completes or fails. */
class TurnWatch {
  readonly finished: Promise<{ text: string; usage: Usage }>;
  private resolve!: (v: { text: string; usage: Usage }) => void;
  private reject!: (e: Error) => void;
  private text?: string;
  private usage?: Usage;

  constructor() {
    this.finished = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    this.finished.catch(() => {}); // a failure after the caller stopped waiting is not an unhandled rejection
  }

  fail(err: Error): void {
    this.reject(err);
  }

  event(method: string, params: Json): void {
    try {
      if (method === "item/completed") {
        const item = params.item as Json;
        if (!ITEMS.has(item?.type)) throw failure(`unexpected planner tool/item: ${item?.type}`);
        if (item.type === "agentMessage" && typeof item.text === "string") this.text = item.text;
      } else if (method === "thread/tokenUsage/updated") {
        const t = params.tokenUsage?.total as Json | undefined;
        this.usage = parseUsage({
          input_tokens: t?.inputTokens, cached_input_tokens: t?.cachedInputTokens, cache_write_input_tokens: t?.cacheWriteInputTokens,
          output_tokens: t?.outputTokens, reasoning_output_tokens: t?.reasoningOutputTokens,
        });
      } else if (method === "error" && !params.willRetry) {
        throw failure(params.error?.message ?? "turn failed");
      } else if (method === "turn/completed") {
        const turn = params.turn as Json;
        if (turn.status === "failed") throw failure(turn.error?.message ?? "turn failed");
        if (turn.status !== "completed") throw failure(`turn ${turn.status}`);
        if (this.text === undefined) throw failure("no final message in reply");
        if (!this.usage) throw failure("no usage in reply");
        this.resolve({ text: this.text, usage: this.usage });
      }
    } catch (err) {
      this.fail(err as Error);
    }
  }
}
