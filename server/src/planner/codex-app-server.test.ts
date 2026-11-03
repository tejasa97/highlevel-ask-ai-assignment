import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { join } from "node:path";
import { CodexAppServerPlanner } from "./codex-app-server.js";
import { PlannerError } from "./types.js";

let dir: string, executable: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "codex-app-server-test-"));
  executable = join(dir, "fake-codex.mjs");
  await writeFile(executable, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
const out = m => process.stdout.write(JSON.stringify(m) + '\\n');
const apiKey = (() => { try { return readFileSync(new URL('login-mode', import.meta.url), 'utf8') === 'api'; } catch { return false; } })();
const threads = new Map();
let count = 0;
const usage = { inputTokens: 100, cachedInputTokens: 20, cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 3, totalTokens: 110 };
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  const reply = result => out({ id: m.id, result });
  if (m.method === 'initialize') reply({});
  else if (m.method === 'account/read') reply({ account: apiKey ? { type: 'apiKey' } : { type: 'chatgpt', email: null, planType: 'plus' } });
  else if (m.method === 'thread/start') { const id = 'th' + ++count; threads.set(id, m.params); reply({ thread: { id } }); }
  else if (m.method === 'thread/unsubscribe') reply({});
  else if (m.method === 'turn/interrupt') { writeFileSync(threads.get(m.params.threadId).marker, 'interrupted'); reply({}); }
  else if (m.method === 'turn/start') {
    const threadId = m.params.threadId, thread = threads.get(threadId);
    const { mode = 'ok', marker } = JSON.parse(m.params.input[0].text);
    thread.marker = marker;
    reply({ turn: { id: 'tu' + count } });
    const note = (method, params) => out({ method, params: { threadId, ...params } });
    const finish = (status = 'completed', error = null) => note('turn/completed', { turn: { id: 'tu', status, error } });
    const answer = (text, withUsage = true) => {
      note('item/completed', { item: { type: 'userMessage' } });
      note('item/completed', { item: { type: 'agentMessage', phase: 'final_answer', text } });
      if (withUsage) note('thread/tokenUsage/updated', { tokenUsage: { total: usage, last: usage } });
      finish();
    };
    const final = { pid: process.pid, args, system: thread.baseInstructions, model: thread.model, sandbox: thread.sandbox, ephemeral: thread.ephemeral, schema: m.params.outputSchema, effort: m.params.effort };
    if (mode === 'hang') return;
    if (mode === 'crash') process.exit(3);
    if (mode === 'rate') finish('failed', { message: 'exceeded retry limit, last status: 429 Too Many Requests' });
    else if (mode === 'tool') note('item/completed', { item: { type: 'commandExecution' } });
    else if (mode === 'approval') out({ id: 'srv1', method: 'item/commandExecution/requestApproval', params: { threadId } });
    else if (mode === 'bad_final') answer('{');
    else if (mode === 'no_usage') answer(JSON.stringify(final), false);
    else if (mode === 'no_message') finish();
    else if (mode === 'slow') setTimeout(() => answer(JSON.stringify(final)), 150);
    else answer(JSON.stringify(final));
  }
});
`, { mode: 0o700 });
});
after(async () => { await rm(dir, { recursive: true, force: true }); });

const open: CodexAppServerPlanner[] = [];
const planner = () => {
  const p = new CodexAppServerPlanner({ fast: "fast-model", strong: "strong-model" }, { executable, reasoning: { fast: "low", strong: "high" } });
  open.push(p);
  return p;
};
after(async () => { await Promise.all(open.map((p) => p.close())); });
const req = (mode = "ok", extra: object = {}) => ({ tier: "fast" as const, system: "App system instructions", user: JSON.stringify({ mode, ...extra }), schema: { type: "object" } });
const kind = (expected: PlannerError["kind"]) => (e: unknown) => e instanceof PlannerError && e.kind === expected;

describe("CodexAppServerPlanner", () => {
  it("runs each call as an ephemeral read-only thread with the system prompt, schema, model and effort, and reports subscription tokens", async () => {
    const p = planner();
    const result = await p.plan(req());
    const json = result.json as any;
    assert.equal(json.system, req().system);
    assert.deepEqual(json.schema, req().schema);
    assert.equal(json.model, "fast-model");
    assert.equal(json.effort, "low");
    assert.equal(json.sandbox, "read-only");
    assert.equal(json.ephemeral, true);
    assert.ok(json.args.includes("features.shell_tool=false"));
    assert.ok(json.args.includes("mcp_servers={}"));
    assert.ok(!json.args.some((a: string) => a.startsWith("forced_login_method")));
    assert.deepEqual(result.usage, { input: 100, cachedRead: 20, cacheWrite: 0, output: 7, thinking: 3, billing: "subscription", costUsd: null });
    assert.equal(result.model, "fast-model");
    const strong = await p.plan({ ...req(), tier: "strong" });
    assert.equal(strong.model, "strong-model");
    assert.equal((strong.json as any).effort, "high");
  });

  it("serves every call, concurrent ones included, from one process", async () => {
    const p = planner();
    const results = await Promise.all([p.plan(req("slow")), p.plan(req("slow")), p.plan(req())]);
    const after = await p.plan(req());
    const pids = new Set([...results, after].map((r) => (r.json as any).pid));
    assert.equal(pids.size, 1);
  });

  it("maps a 429 turn failure to rate_limited and keeps serving", async () => {
    const p = planner();
    await assert.rejects(p.plan(req("rate")), kind("rate_limited"));
    assert.equal((await p.plan(req())).model, "fast-model");
  });

  it("rejects tool use, server requests, bad JSON, and replies without a message or usage", async () => {
    const p = planner();
    await assert.rejects(p.plan(req("tool")), /unexpected planner tool\/item/);
    await assert.rejects(p.plan(req("approval")), /unexpected server request/);
    await assert.rejects(p.plan(req("bad_final")), kind("bad_json"));
    await assert.rejects(p.plan(req("no_message")), /no final message/);
    await assert.rejects(p.plan(req("no_usage")), /no usage/);
  });

  it("starts a new process after the server dies, failing only the call that was in flight", async () => {
    const p = planner();
    const first = (await p.plan(req())).json as any;
    await assert.rejects(p.plan(req("crash")), kind("provider"));
    const next = (await p.plan(req())).json as any;
    assert.notEqual(next.pid, first.pid);
  });

  it("interrupts the turn when the caller aborts", async () => {
    const marker = join(dir, "interrupt-marker");
    const controller = new AbortController();
    const call = planner().plan({ ...req("hang", { marker }), signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(call, kind("timeout"));
    for (let i = 0; i < 50 && !(await access(marker).then(() => true, () => false)); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(await readFile(marker, "utf8"), "interrupted");
  });

  it("refuses an API-key login without touching it", async () => {
    const mode = new URL("login-mode", `file://${executable}`);
    await writeFile(mode, "api");
    try {
      const p = planner();
      await assert.rejects(p.plan(req()), /ChatGPT sign-in is required/);
      await assert.rejects(p.plan(req()), /ChatGPT sign-in is required/);
    } finally {
      await rm(mode);
    }
  });

  it("lets a script exit once its calls are done, without close(), but not while one is in flight", async () => {
    const script = join(dir, "idle.mts");
    await writeFile(script, `import { CodexAppServerPlanner } from ${JSON.stringify(new URL("./codex-app-server.ts", import.meta.url).href)};
const p = new CodexAppServerPlanner({ fast: "m", strong: "m" }, { executable: ${JSON.stringify(executable)} });
const r = await p.plan({ tier: "fast", system: "s", user: JSON.stringify({ mode: "slow" }), schema: {} });
console.log("done", typeof (r.json as { pid: number }).pid);
`);
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", script], { timeout: 15_000 });
    assert.equal(stdout.trim(), "done number");
  });

  it("reports a missing executable as a provider error", async () => {
    const p = new CodexAppServerPlanner({ fast: "m", strong: "m" }, { executable: join(dir, "missing") });
    await assert.rejects(p.plan(req()), kind("provider"));
  });

  it("rejects an invalid reasoning effort up front", () => {
    assert.throws(() => new CodexAppServerPlanner({ fast: "m", strong: "m" }, { reasoning: { fast: "bogus" as never, strong: "low" } }), /invalid Codex reasoning effort/);
  });
});
