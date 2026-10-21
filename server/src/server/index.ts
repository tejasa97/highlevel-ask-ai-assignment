// Dev server for the web UI: one chat over the dev database, with everything the debug view needs.
// POST /api/ask and /api/confirm stream the turn as server-sent events; the rest is plain JSON.
// Run: npm run serve (port 8787; the Vite dev server in web/ proxies /api here).
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { CompiledPlan, CStep } from "../core/compile.js";
import { execute, type Pending, type RunResult } from "../core/execute.js";
import { summarize } from "../core/summarize.js";
import { makePlanner } from "../planner/index.js";
import { type Carry, planTurn } from "../planner/turn.js";
import type { Tier } from "../planner/types.js";
import type { CallTrace } from "../registry/define.js";
import { DEFAULT_ACTOR } from "../registry/invoke.js";
import { loadRegistry } from "../registry/registry.js";
import { buildCards } from "../retrieval/cards.js";
import { Retriever } from "../retrieval/retrieve.js";
import { DEV_DB, devStore, resetDevStore } from "../store/dev.js";
import { diff, snapshot } from "./diff.js";

const PORT = Number(process.env.PORT ?? 8787);
const HISTORY_TURNS = 4;

const registry = await loadRegistry();
const planner = makePlanner();
const retriever = new Retriever(buildCards(registry));
if (!existsSync(DEV_DB)) resetDevStore();
let world = devStore();

interface Turn {
  id: string;
  message: string;
  plan: CompiledPlan;
  executionId: string;
  pending?: Pending;
}
const turns = new Map<string, Turn>();
const history: { user: string; assistant: string }[] = [];
/** The last planned turn's actions, carried into the next retrieval so follow-ups keep their tools. */
let carry: Carry | undefined;
/** The messages the last reply asked a question about, if it did (kept across a chain of questions). */
let answering: string | undefined;
let busy = false;

type Emit = (event: string, data: unknown) => void;

async function ask(message: string, tier: Tier, actorId: string, emit: Emit): Promise<void> {
  const turnId = `t${turns.size + 1}_${Date.now().toString(36)}`;
  emit("turn", { turnId, message });
  const context = history.length ? history.slice(-HISTORY_TURNS).map((h) => `user: ${h.user}\nassistant: ${h.assistant}`).join("\n") : undefined;
  const outcome = await planTurn({ message, tier, context, carry, answering }, { registry, retriever, planner, clock: world.clock }, (e) => emit(e.type, e.data));
  if (outcome.kind === "reply") return finish(message, outcome.status, outcome.text, emit, outcome.options);
  carry = outcome.carry;
  const turn: Turn = { id: turnId, message, plan: outcome.plan, executionId: `ex_${turnId}` };
  turns.set(turnId, turn);
  emit("plan", { hash: turn.plan.hash, steps: turn.plan.steps.map(describeStep) });
  await run(turn, actorId, emit);
}

async function confirm(turnId: string, approve: boolean, actorId: string, emit: Emit): Promise<void> {
  const turn = turns.get(turnId);
  if (!turn?.pending) throw new Error(`Nothing is waiting for approval in turn ${turnId}`);
  emit("turn", { turnId, message: turn.message, resumed: true });
  if (!approve) {
    turn.pending = undefined;
    return finish(turn.message, "cancelled", "Cancelled. Nothing was changed by that step.", emit);
  }
  await run(turn, actorId, emit, [turn.pending]);
}

async function run(turn: Turn, actorId: string, emit: Emit, approvals?: Pending[]): Promise<void> {
  const before = snapshot(world.store);
  const auditBefore = world.store.audit().length;
  const t = performance.now();
  const onCall = (c: CallTrace) => emit("call", { ...c, ms: Math.round(c.ms * 10) / 10 });
  const result: RunResult = await execute(
    turn.plan,
    registry,
    { ...world, actorId, onCall },
    { executionId: turn.executionId, approvals, onEvent: (e) => emit("exec", e) },
  );
  emit("run", { status: result.status, ms: Math.round(performance.now() - t), steps: result.steps });
  emit("diff", { changes: diff(before, world.store), audit: world.store.audit().slice(0, world.store.audit().length - auditBefore) });

  turn.pending = result.pending;
  const text = summarize(turn.plan, result, registry);
  if (result.status === "awaiting_confirmation") {
    emit("confirm", { turnId: turn.id, pending: result.pending });
    emit("reply", { status: result.status, text });
    return;
  }
  finish(turn.message, result.status, text, emit, result.clarification?.candidates.map((c) => (c.detail ? `${c.name} (${c.detail})` : c.name)));
}

function finish(message: string, status: string, text: string, emit: Emit, options?: string[]): void {
  history.push({ user: message, assistant: text });
  const asked = status === "clarify" || status === "needs_clarification";
  answering = asked ? (answering ? `${answering}\n${message}` : message) : undefined;
  emit("reply", { status, text, options });
}

function describeStep(s: CStep) {
  const call = (c: { action: { id: string; name: string; risk: string }; args: unknown }) => ({ action: c.action.id, name: c.action.name, risk: c.action.risk, args: c.args });
  const base = { id: s.id, kind: s.kind, deps: s.deps };
  switch (s.kind) {
    case "action":
      return { ...base, calls: [call(s.call)] };
    case "resolve":
      return { ...base, entity: s.entity, name: s.name };
    case "filter":
      return { ...base, in: s.in, where: s.where };
    case "exclude":
      return { ...base, in: s.in, by: s.by, set: s.set };
    case "forEach":
      return { ...base, in: s.in, roundRobin: s.roundRobin, calls: s.calls.map(call) };
  }
}

// --- HTTP ---------------------------------------------------------------------------------

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let s = "";
  for await (const chunk of req) s += chunk;
  return s ? (JSON.parse(s) as Record<string, unknown>) : {};
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

async function stream(res: ServerResponse, fn: (emit: Emit) => Promise<void>): Promise<void> {
  if (busy) return json(res, 409, { error: "Another request is still running" });
  busy = true;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const emit: Emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const t = performance.now();
  try {
    await fn(emit);
  } catch (err) {
    emit("error", { message: err instanceof Error ? err.message : String(err) });
  } finally {
    busy = false;
    emit("done", { ms: Math.round(performance.now() - t) });
    res.end();
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  try {
    if (req.method === "POST" && path === "/api/ask") {
      const b = await body(req);
      const message = String(b.message ?? "").trim();
      if (!message) return json(res, 400, { error: "message is required" });
      const tier: Tier = b.tier === "fast" ? "fast" : "strong";
      return stream(res, (emit) => ask(message, tier, String(b.actorId ?? DEFAULT_ACTOR), emit));
    }
    if (req.method === "POST" && path === "/api/confirm") {
      const b = await body(req);
      return stream(res, (emit) => confirm(String(b.turnId), b.approve === true, String(b.actorId ?? DEFAULT_ACTOR), emit));
    }
    if (req.method === "GET" && path === "/api/meta") {
      return json(res, 200, {
        now: world.clock.now().toISOString(),
        tables: world.store.tables().map((name) => ({ name, count: world.store.all(name).length })),
        users: world.store.all<{ id: string; name: string; roles: string[]; status: string }>("users").map(({ id, name, roles, status }) => ({ id, name, roles, status })),
        actions: registry.list().map((a) => ({ id: a.id, name: a.name, risk: a.risk, description: a.description })),
      });
    }
    const table = path.match(/^\/api\/tables\/([a-z_]+)$/);
    if (req.method === "GET" && table) {
      if (!world.store.tables().includes(table[1]!)) return json(res, 404, { error: `no table ${table[1]}` });
      return json(res, 200, world.store.all(table[1]!));
    }
    if (req.method === "GET" && path === "/api/audit") return json(res, 200, world.store.audit().slice(0, Number(url.searchParams.get("limit") ?? 200)));
    if (req.method === "POST" && path === "/api/reset") {
      if (busy) return json(res, 409, { error: "A request is still running" });
      carry = answering = undefined;
      world.store.close();
      resetDevStore();
      world = devStore();
      turns.clear();
      history.length = 0;
      return json(res, 200, { ok: true });
    }
    json(res, 404, { error: "not found" });
  } catch (err) {
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(PORT, () => console.log(`ask-ai dev server on http://localhost:${PORT} (db ${DEV_DB}, planner ${planner.name})`));
