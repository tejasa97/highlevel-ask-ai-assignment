import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Planner, type PlanRequest, type PlanResult, PlannerError, type Tier } from "./types.js";

export type Reasoning = "low" | "medium" | "high" | "xhigh";
interface Options {
  executable?: string;
  reasoning?: Record<Tier, Reasoning>;
}

const KEEP_ENV = ["HOME", "PATH", "USER", "LANG", "TMPDIR", "CODEX_HOME"];
const MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 120_000;
// Verified against CLI 0.159.0. Unknown/ignored settings fail closed below.
const DISABLED = [
  "shell_tool", "unified_exec", "apps", "plugins", "remote_plugin", "hooks", "memories",
  "multi_agent", "multi_agent_v2", "view_image", "image_generation", "browser_use",
  "browser_use_external", "computer_use", "workspace_dependencies", "skill_search",
  "skill_mcp_dependency_install", "tool_suggest", "sleep_tool", "goals",
];

/** Local development only: use the CLI's ChatGPT login, never inherited API credentials. */
export class CodexCliPlanner implements Planner {
  readonly name = "codex-cli";
  readonly billing = "subscription";
  /** Set once the ChatGPT login check has passed, so later calls skip the extra process. */
  private signedIn = false;

  constructor(readonly models: Record<Tier, string>, private readonly options: Options = {}) {
    for (const effort of Object.values(options.reasoning ?? {})) {
      if (!["low", "medium", "high", "xhigh"].includes(effort)) throw new Error(`invalid Codex reasoning effort: ${effort}`);
    }
  }

  async plan(req: PlanRequest): Promise<PlanResult> {
    const signal = AbortSignal.any([...(req.signal ? [req.signal] : []), AbortSignal.timeout(TIMEOUT_MS)]);
    if (signal.aborted) throw new PlannerError("Codex request cancelled", "timeout");
    const started = performance.now();
    const cwd = await mkdtemp(join(tmpdir(), "ask-ai-codex-"));
    try {
      const env = Object.fromEntries(KEEP_ENV.flatMap((k) => process.env[k] ? [[k, process.env[k]]] : []));
      const executable = this.options.executable ?? "codex";
      // Applying forced_login_method to an API-key login deletes the shared login cache.
      // Check first without that override; never echo login-status output (it may include key hints).
      if (!this.signedIn) {
        await run(executable, ["login", "status", "-c", 'cli_auth_credentials_store="auto"'], "", { cwd, env, signal }, "auth");
        this.signedIn = true;
      }
      const schema = join(cwd, "schema.json");
      const instructions = join(cwd, "instructions.txt");
      const final = join(cwd, "final.json");
      await Promise.all([writeFile(schema, JSON.stringify(req.schema)), writeFile(instructions, req.system)]);
      const config = [
        `model_instructions_file=${JSON.stringify(instructions)}`,
        'forced_login_method="chatgpt"', 'cli_auth_credentials_store="auto"',
        `model_reasoning_effort=${JSON.stringify(this.options.reasoning?.[req.tier] ?? "low")}`,
        "project_doc_max_bytes=0", 'web_search="disabled"',
        // CLI 0.159 labels host-skill isolation experimental; suppress only that generic banner.
        "suppress_unstable_features_warning=true",
        "features.skip_host_skill_discovery=true",
        ...DISABLED.map((feature) => `features.${feature}=false`),
      ];
      const args = [
        "exec", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check",
        "--sandbox", "read-only", "--json", "--model", this.models[req.tier],
        "--output-schema", schema, "--output-last-message", final,
        ...config.flatMap((c) => ["-c", c]), "-",
      ];
      const usage = await run(executable, args, req.user, { cwd, env, signal });
      if (!usage) throw failure("no usage in reply");
      let text: string;
      let json: unknown;
      try {
        if ((await stat(final)).size > MAX_BYTES) throw new Error("final output exceeds limit");
        text = await readFile(final, "utf8");
        if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("final output exceeds limit");
        json = JSON.parse(text);
      } catch {
        throw new PlannerError("Codex produced missing or invalid final JSON", "bad_json");
      }
      return { model: this.models[req.tier], json, text, latencyMs: performance.now() - started,
        usage: { ...usage, billing: "subscription", costUsd: null } };
    } catch (err) {
      if (err instanceof PlannerError) throw err;
      throw failure(`request failed: ${(err as Error).message}`);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
}

function failure(message: string): PlannerError {
  return new PlannerError(`Codex: ${message.slice(0, 500)}`, /429|rate.?limit|usage.?limit|quota|credit.?balance/i.test(message) ? "rate_limited" : "provider");
}

function parseUsage(value: unknown) {
  const u = value as Record<string, unknown> | undefined;
  const count = (key: string, optional = false): number => {
    const v = u?.[key] ?? (optional ? 0 : undefined);
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw failure(`invalid or missing ${key} usage`);
    return v;
  };
  const input = count("input_tokens"), cachedRead = count("cached_input_tokens", true);
  if (cachedRead > input) throw failure("cached input exceeds total input");
  const totalOutput = count("output_tokens"), thinking = count("reasoning_output_tokens", true);
  if (thinking > totalOutput) throw failure("reasoning tokens exceed total output");
  // Codex's total output includes reasoning; the app tracks visible output separately.
  return { input, cachedRead, cacheWrite: count("cache_write_input_tokens", true),
    output: totalOutput - thinking, thinking };
}

function run(command: string, args: string[], stdin: string, opts: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal }, mode: "auth" | "plan" = "plan"): Promise<ReturnType<typeof parseUsage> | null> {
  return new Promise((resolve, reject) => {
    if (opts.signal.aborted) return reject(new PlannerError("Codex request cancelled", "timeout"));
    // A process group lets cancellation also stop any runtime helper children on POSIX.
    const grouped = process.platform !== "win32";
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, detached: grouped, stdio: ["pipe", "pipe", "pipe"] });
    let pending = "", stderr = "", authStatus = "", bytes = 0;
    let error: PlannerError | undefined;
    let usage: ReturnType<typeof parseUsage> | undefined;
    let completed = false;
    let killTimer: NodeJS.Timeout | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (grouped && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { /* already exited */ }
    };
    const stop = (err: PlannerError) => {
      if (error) return;
      error = err;
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 500);
    };
    const abort = () => stop(new PlannerError("Codex request cancelled or timed out", "timeout"));
    opts.signal.addEventListener("abort", abort, { once: true });
    if (opts.signal.aborted) abort();
    const line = (s: string) => {
      if (!s.trim() || error) return;
      try {
        const e = JSON.parse(s);
        if (!e || typeof e.type !== "string") throw failure("malformed JSONL event");
        if (e.type === "error" || e.type === "turn.failed") throw failure(e.message ?? e.error?.message ?? "turn failed");
        if (e.type.startsWith("item.")) {
          if (e.item?.type === "error") throw failure(e.item.message ?? "configuration/runtime error");
          if (!["agent_message", "reasoning"].includes(e.item?.type)) throw failure(`unexpected planner tool/item: ${e.item?.type}`);
        }
        if (e.type === "turn.completed") {
          if (completed) throw failure("multiple completed turns");
          usage = parseUsage(e.usage);
          completed = true;
        }
      } catch (err) {
        stop(err instanceof PlannerError ? err : failure("invalid JSONL event"));
      }
    };
    const withinLimit = (d: Buffer) => {
      bytes += d.length;
      if (bytes > MAX_BYTES) stop(failure("process output exceeds 4 MiB limit"));
      return !error;
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      if (!withinLimit(Buffer.from(d))) return;
      if (mode === "auth") { authStatus += d; return; }
      pending += d;
      let i: number;
      while ((i = pending.indexOf("\n")) >= 0) {
        line(pending.slice(0, i));
        pending = pending.slice(i + 1);
      }
    });
    child.stderr.on("data", (d: Buffer) => { if (withinLimit(d)) stderr = (stderr + d.toString()).slice(-2000); });
    child.stdin.on("error", () => { /* EPIPE on an early CLI failure; close handles the useful error. */ });
    child.on("error", (err) => { error ??= failure(`could not start ${command}: ${err.message}`); });
    child.on("close", (code) => {
      opts.signal.removeEventListener("abort", abort);
      if (mode === "plan") line(pending);
      if (error) kill("SIGKILL"); // Stop surviving helpers even if the main process exited on SIGTERM.
      if (killTimer) clearTimeout(killTimer);
      if (error) reject(error);
      else if (mode === "auth") {
        if (code === 0 && /^Logged in using ChatGPT\b/m.test(`${authStatus}\n${stderr}`)) resolve(null);
        else reject(failure("ChatGPT sign-in is required. Run codex login to choose an account. The adapter did not change the existing login."));
      }
      else if (code !== 0) reject(failure(`exited ${code}: ${stderr.trim() || "no diagnostic"}. Check codex login status.`));
      else if (!usage) reject(failure("no completed turn/usage in reply"));
      else resolve(usage);
    });
    child.stdin.end(stdin);
  });
}
