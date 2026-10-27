import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Planner, type PlanRequest, type PlanResult, PlannerError, type Tier } from "./types.js";

// DEV ONLY: plans through `claude -p` on the user's Claude subscription, so no API key is needed.
// Measured with care: no temperature control, Claude Code places its own cache breakpoints, cost is
// Claude Code's estimate at API list prices (billing "api_estimate"), and latency includes the CLI's own
// start-up (~0.7 s per call; apiMs is the part spent in model requests).
// - The child gets a clean environment so it uses the CLI's own login, not a parent Claude Code session's.
// - Isolation: no tools, no MCP, no user/project settings or hooks, an empty cwd, our system prompt only.
// - `--json-schema` returns the reply in `structured_output` (num_turns is 2: a forced output tool, then the end;
//   usage.iterations has one entry per model request).
// - The result is read as soon as stdout holds the whole JSON: the CLI takes ~0.8 s more to exit after printing it.
//   A long-lived `--input-format stream-json` process would save start-up too, but it is one session: every
//   earlier plan would stay in the context of the next.

interface CliResult {
  is_error: boolean;
  result: string;
  structured_output?: unknown;
  total_cost_usd: number;
  duration_ms: number;
  duration_api_ms?: number;
  num_turns: number;
  usage: {
    input_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    output_tokens: number; // thinking included
    output_tokens_details?: { thinking_tokens?: number };
    iterations?: unknown[];
  };
}

const KEEP_ENV = ["HOME", "PATH", "USER", "LANG", "TMPDIR"];

export class ClaudeCliPlanner implements Planner {
  readonly name = "claude-cli";
  readonly billing = "api_estimate";
  private readonly cwd = mkdtempSync(join(tmpdir(), "ask-ai-claude-"));

  constructor(readonly models: Record<Tier, string>) {}

  async plan(req: PlanRequest): Promise<PlanResult> {
    const model = this.models[req.tier];
    const args = [
      "-p", "--model", model, "--output-format", "json",
      "--tools", "", "--strict-mcp-config", "--setting-sources", "",
      "--no-session-persistence", "--disable-slash-commands",
      "--system-prompt", req.system, "--json-schema", JSON.stringify(req.schema),
    ];
    const env = Object.fromEntries(KEEP_ENV.flatMap((k) => (process.env[k] ? [[k, process.env[k]]] : [])));

    const started = performance.now();
    const stdout = await run(args, req.user, { cwd: this.cwd, env, signal: req.signal });
    const latencyMs = performance.now() - started;

    let out: CliResult;
    try {
      out = JSON.parse(stdout) as CliResult;
    } catch {
      throw new PlannerError("claude -p printed no JSON result", "provider", stdout);
    }
    if (out.is_error) {
      throw new PlannerError(out.result, /rate|limit|429/i.test(out.result) ? "rate_limited" : "provider");
    }
    if (out.structured_output === undefined) throw new PlannerError("no structured_output in reply", "bad_json", out.result);

    const u = out.usage;
    const cachedRead = u.cache_read_input_tokens;
    const cacheWrite = u.cache_creation_input_tokens;
    const thinking = u.output_tokens_details?.thinking_tokens ?? 0;
    return {
      model,
      json: out.structured_output,
      text: out.result,
      latencyMs,
      modelCalls: u.iterations?.length || 1,
      ...(out.duration_api_ms !== undefined ? { apiMs: out.duration_api_ms } : {}),
      usage: {
        billing: "api_estimate",
        input: u.input_tokens + cachedRead + cacheWrite, // total input: uncached + cache read + cache write
        cachedRead,
        cacheWrite,
        output: u.output_tokens - thinking,
        thinking,
        costUsd: out.total_cost_usd, // Claude Code's estimate at API list prices
      },
    };
  }
}

function run(args: string[], stdin: string, opts: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal }): Promise<string> {
  const { signal, ...spawnOpts } = opts;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new PlannerError("claude call cancelled or timed out", "timeout"));
    const child = spawn("claude", args, { ...spawnOpts, stdio: ["pipe", "pipe", "pipe"] });
    const abort = () => {
      child.kill();
      reject(new PlannerError("claude call cancelled or timed out", "timeout"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d;
      // The result is one JSON object; once it parses, it is whole, and the CLI's exit needn't be waited for.
      if (out.trimEnd().endsWith("}") && parses(out)) resolve(out);
    });
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e: NodeJS.ErrnoException) => reject(new PlannerError(e.code === "ENOENT"
      ? "Claude CLI not found on PATH: install it and run `claude auth login`, or set QWEN_API_KEY to plan with DeepSeek on the Qwen Token Plan"
      : `could not start claude: ${e.message}`, "provider")));
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      // claude -p exits 1 on an error result but still prints the JSON, so let the caller read it
      if (out.trim()) resolve(out);
      else reject(new PlannerError(`claude exited ${code}: ${err.trim().slice(0, 300)}`, "provider"));
    });
    child.stdin.end(stdin);
  });
}

function parses(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
