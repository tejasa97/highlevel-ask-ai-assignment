import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexCliPlanner } from "./codex-cli.js";
import { PlannerError } from "./types.js";
import { formatCost, sumUsd } from "./usage.js";

let dir: string, executable: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "codex-adapter-test-"));
  executable = join(dir, "fake-codex.mjs");
  await writeFile(executable, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
if (args[0] === 'login') {
  const mode = (() => { try { return readFileSync(new URL('login-mode', import.meta.url), 'utf8'); } catch { return 'chatgpt'; } })();
  if (mode === 'api') process.stderr.write('Logged in using an API key - sk-test-private-hint');
  else if (mode === 'signed-out') { process.stderr.write('Not logged in'); process.exitCode = 1; }
  else process.stderr.write('Logged in using ChatGPT');
} else {
let input = ''; for await (const chunk of process.stdin) input += chunk;
const { mode = 'ok', marker, usage: providedUsage } = JSON.parse(input);
const event = value => process.stdout.write(JSON.stringify(value) + '\\n');
if (marker) writeFileSync(marker, JSON.stringify({ cwd: process.cwd(), pid: process.pid }));
if (mode === 'hang') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
else if (mode === 'large') process.stdout.write('x'.repeat(5 * 1024 * 1024));
else {
  const settings = args.filter((_, i) => args[i - 1] === '-c');
  const file = JSON.parse(settings.find(s => s.startsWith('model_instructions_file=')).split('=').slice(1).join('='));
  const final = { cwd: process.cwd(), args, system: readFileSync(file, 'utf8'), schema: JSON.parse(readFileSync(option('--output-schema'), 'utf8')), env: Object.keys(process.env) };
  if (mode !== 'missing') writeFileSync(option('--output-last-message'), mode === 'large_final' ? 'x'.repeat(5 * 1024 * 1024) : mode === 'bad_final' ? '{' : JSON.stringify(final));
  if (mode === 'malformed') process.stdout.write('not json\\n');
  else if (mode === 'rate') event({ type: 'turn.failed', error: { message: 'usage limit reached' } });
  else if (mode === 'auth') { process.stderr.write('Please run codex login'); process.exitCode = 1; }
  else if (mode === 'warning') event({ type: 'item.completed', item: { type: 'error', message: 'unrecognized configuration setting' } });
  else if (mode === 'tool') event({ type: 'item.started', item: { type: 'command_execution' } });
  else if (mode === 'no_completion') event({ type: 'turn.started' });
  else {
    event({ type: 'item.completed', item: { type: 'agent_message', text: 'é' } });
    const usage = mode === 'bad_usage' ? {} : providedUsage ?? { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10, reasoning_output_tokens: 3 };
    const last = JSON.stringify({ type: 'turn.completed', usage });
    // Exercise incremental JSONL parsing with the last line lacking a newline.
    process.stdout.write(last.slice(0, 15)); process.stdout.write(last.slice(15));
    if (mode === 'exit') process.exitCode = 2;
  }
}
}
`, { mode: 0o700 });
});
after(async () => { await rm(dir, { recursive: true, force: true }); });

const planner = () => new CodexCliPlanner({ fast: "fast-model", strong: "strong-model" }, { executable, reasoning: { fast: "low", strong: "high" } });
const req = (mode = "ok", extra: object = {}) => ({ tier: "fast" as const, system: "App system instructions", user: JSON.stringify({ mode, ...extra }), schema: { type: "object" } });
const kind = (expected: PlannerError["kind"]) => (e: unknown) => e instanceof PlannerError && e.kind === expected;

describe("CodexCliPlanner", () => {
  it("passes schema/system in private files, strips inherited secrets and reports subscription tokens", async () => {
    const old = process.env.CODEX_API_KEY;
    process.env.CODEX_API_KEY = "test-secret";
    try {
      const result = await planner().plan(req());
      const json = result.json as any;
      assert.equal(json.system, req().system);
      assert.deepEqual(json.schema, req().schema);
      assert.ok(!json.env.includes("CODEX_API_KEY"));
      assert.ok(!json.env.includes("OPENAI_API_KEY"));
      assert.ok(!json.env.includes("NODE_OPTIONS"));
      assert.ok(json.args.includes("--ignore-user-config"));
      assert.ok(json.args.includes('forced_login_method="chatgpt"'));
      assert.ok(json.args.includes("features.shell_tool=false"));
      assert.ok(json.args.includes("features.plugins=false"));
      assert.deepEqual(result.usage, { input: 100, cachedRead: 20, cacheWrite: 0, output: 7, thinking: 3, billing: "subscription", costUsd: null });
      assert.equal(result.model, "fast-model");
      await assert.rejects(access(json.cwd));
      const strong = await planner().plan({ ...req(), tier: "strong" });
      assert.equal(strong.model, "strong-model");
      assert.ok((strong.json as any).args.includes('model_reasoning_effort="high"'));
      assert.notEqual((strong.json as any).cwd, json.cwd);
    } finally {
      if (old === undefined) delete process.env.CODEX_API_KEY; else process.env.CODEX_API_KEY = old;
    }
  });

  it("splits total output into visible and reasoning tokens without double counting", async () => {
    for (const [total, reasoning] of [[314, 47], [10, undefined], [10, 10]] as const) {
      const { usage } = await planner().plan(req("ok", { usage: {
        input_tokens: 100, output_tokens: total, reasoning_output_tokens: reasoning,
      } }));
      assert.equal(usage.output, total - (reasoning ?? 0));
      assert.equal(usage.thinking, reasoning ?? 0);
      assert.equal(usage.output + usage.thinking, total);
    }
    await assert.rejects(planner().plan(req("ok", { usage: {
      input_tokens: 100, output_tokens: 2, reasoning_output_tokens: 3,
    } })), (err) => kind("provider")(err) && /reasoning tokens exceed total output/.test((err as Error).message));
  });

  for (const [mode, expected] of [
    ["malformed", "provider"], ["rate", "rate_limited"], ["auth", "provider"], ["exit", "provider"],
    ["warning", "provider"], ["tool", "provider"], ["no_completion", "provider"], ["bad_usage", "provider"],
    ["missing", "bad_json"], ["bad_final", "bad_json"], ["large_final", "bad_json"], ["large", "provider"],
  ] as const) {
    it(`rejects ${mode} and removes temporary request files`, async () => {
      const marker = join(dir, `${mode}.json`);
      await assert.rejects(planner().plan(req(mode, { marker })), kind(expected));
      const { cwd } = JSON.parse(await readFile(marker, "utf8"));
      await assert.rejects(access(cwd));
    });
  }

  it("terminates an unresponsive child before rejecting cancellation and cleaning files", async () => {
    const ctl = new AbortController();
    const marker = join(dir, "hang.json");
    const work = planner().plan({ ...req("hang", { marker }), signal: ctl.signal });
    // Attach immediately so a timeout/failure cannot become an unhandled rejection.
    const checked = assert.rejects(work, kind("timeout"));
    let child: { cwd: string; pid: number } | undefined;
    for (let i = 0; i < 100; i++) {
      try { child = JSON.parse(await readFile(marker, "utf8")); break; } catch { await new Promise(r => setTimeout(r, 10)); }
    }
    ctl.abort();
    await checked;
    assert.ok(child, "fake child started");
    assert.throws(() => process.kill(child.pid, 0), /ESRCH/);
    await assert.rejects(access(child.cwd));
  });

  it("handles missing executables, pre-aborted requests and invalid reasoning settings", async () => {
    await assert.rejects(new CodexCliPlanner({ fast: "m", strong: "m" }, { executable: join(dir, "absent") }).plan(req()), kind("provider"));
    await assert.rejects(planner().plan({ ...req(), signal: AbortSignal.abort() }), kind("timeout"));
    assert.throws(() => new CodexCliPlanner({ fast: "m", strong: "m" }, { reasoning: { fast: "invalid", strong: "high" } as any }), /invalid Codex reasoning/);
  });

  it("rejects API-key and signed-out sessions before inference, preserving credentials and hiding status details", async () => {
    const loginMode = join(dir, "login-mode");
    try {
      for (const mode of ["api", "signed-out"]) {
        await writeFile(loginMode, mode);
        const marker = join(dir, `should-not-execute-${mode}.json`);
        await assert.rejects(planner().plan(req("ok", { marker })), (err) => {
          assert.ok(err instanceof PlannerError);
          assert.match(err.message, /ChatGPT sign-in is required/);
          assert.ok(!err.message.includes("sk-test-private-hint"));
          return true;
        });
        await assert.rejects(access(marker), "inference was never started");
        assert.equal(await readFile(loginMode, "utf8"), mode);
      }
    } finally { await rm(loginMode, { force: true }); }
  });

  it("checks the sign-in once per planner, and a failed check is not remembered", async () => {
    const loginMode = join(dir, "login-mode");
    try {
      const p = planner();
      await writeFile(loginMode, "signed-out");
      await assert.rejects(p.plan(req()), /ChatGPT sign-in is required/);
      await writeFile(loginMode, "chatgpt");
      await p.plan(req());
      // The login check has passed, so it isn't run again: a later signed-out status goes unnoticed here.
      await writeFile(loginMode, "signed-out");
      await p.plan(req());
    } finally { await rm(loginMode, { force: true }); }
  });
});

it("keeps unknown costs unknown in totals and labels estimates separately", () => {
  assert.equal(sumUsd([1, 2]), 3);
  assert.equal(sumUsd([1, null]), null);
  assert.equal(formatCost(null, "subscription"), "subscription usage (USD unavailable)");
  assert.equal(formatCost(0.2, "api_estimate"), "$0.20000 (API estimate)");
  assert.equal(formatCost(null), "USD unavailable");
});
