import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { afterEach, before, describe, test } from "node:test";
import type { SubmitPlan } from "../planner/submit-plan.js";
import { type PlanRequest, type Planner, PlannerError } from "../planner/types.js";
import { loadRegistry, type Registry } from "../registry/registry.js";
import { buildCards } from "../retrieval/cards.js";
import { Retriever } from "../retrieval/retrieve.js";
import { world, type World } from "../store/world.js";
import { createApp } from "./app.js";

// The app over a scripted planner and a throwaway database, driven through real HTTP.

let registry: Registry;
let retriever: Retriever;
before(async () => {
  registry = await loadRegistry();
  retriever = new Retriever(buildCards(registry));
});

const reply = (fields: Partial<SubmitPlan>): SubmitPlan => ({ type: "plan", steps: null, question: null, options: null, reason: null, alternatives: null, query: null, text: null, ...fields });
const action = (act: string, args: unknown) => reply({ steps: [{ id: "s1", kind: "action", action: act, argsJson: JSON.stringify(args) }] });

interface Sse {
  event: string;
  data: any;
}

/** Answers with the scripted replies in order; a reply may be a promise, to hold a turn open. */
function scripted(...replies: (SubmitPlan | Promise<SubmitPlan>)[]): Planner & { requests: PlanRequest[] } {
  const requests: PlanRequest[] = [];
  return {
    name: "scripted",
    requests,
    async plan(req) {
      requests.push(req);
      const next = replies.shift();
      if (!next) throw new Error("planner called more times than scripted");
      const json = await next;
      return { model: "fake", json, text: JSON.stringify(json), usage: { input: 0, cachedRead: 0, cacheWrite: 0, output: 0, thinking: 0, costUsd: 0, billing: "none" }, latencyMs: 1 };
    },
  };
}

async function events(res: Response): Promise<Sse[]> {
  return (await res.text())
    .split("\n\n")
    .filter(Boolean)
    .map((chunk) => {
      const [e, d] = chunk.split("\n");
      return { event: e!.slice("event: ".length), data: JSON.parse(d!.slice("data: ".length)) };
    });
}

const running: { close: () => void }[] = [];
afterEach(() => {
  for (const s of running.splice(0)) s.close();
});

async function start(planner: Planner) {
  const worlds: World[] = [];
  const server = createApp({
    registry,
    planner,
    retriever,
    openWorld: () => {
      const w = world();
      worlds.push(w);
      return w;
    },
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  running.push({ close: () => (server.closeAllConnections(), server.close()) });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return {
    base,
    /** The world the app is currently running over. */
    world: () => worlds.at(-1)!,
    get: (path: string) => fetch(base + path),
    post,
    ask: async (message: string) => events(await post("/api/ask", { message })),
    confirm: async (turnId: string, approve: boolean) => events(await post("/api/confirm", { turnId, approve })),
  };
}

const kinds = (evs: Sse[]) => evs.map((e) => e.event);
const last = (evs: Sse[], event: string) => evs.findLast((e) => e.event === event)?.data;

describe("GET", () => {
  test("/api/meta lists the clock, tables, users and the implemented actions", async () => {
    const app = await start(scripted());
    const meta = (await (await app.get("/api/meta")).json()) as any;
    assert.match(meta.now, /^\d{4}-\d\d-\d\dT/);
    assert.ok(meta.tables.some((t: any) => t.name === "tasks" && t.count > 0));
    assert.ok(meta.users.length > 0 && meta.users.every((u: any) => !("email" in u)));
    assert.ok(meta.actions.some((a: any) => a.id === "M06.A01"));
  });

  test("/api/tables/:name returns the rows; an unknown table is a 404", async () => {
    const app = await start(scripted());
    const tasks = (await (await app.get("/api/tables/tasks")).json()) as unknown[];
    assert.equal(tasks.length, app.world().store.all("tasks").length);
    const res = await app.get("/api/tables/nope");
    assert.equal(res.status, 404);
  });

  test("an unknown path is a 404", async () => {
    const app = await start(scripted());
    assert.equal((await app.get("/api/nothing")).status, 404);
  });
});

describe("POST /api/ask", () => {
  test("an empty message is a 400 and never reaches the planner", async () => {
    const planner = scripted();
    const app = await start(planner);
    const res = await app.post("/api/ask", { message: "   " });
    assert.equal(res.status, 400);
    assert.equal(planner.requests.length, 0);
  });

  test("a plan streams every stage in order, runs, and changes the database", async () => {
    const app = await start(scripted(action("M06.A01", { title: "Call Ana" })));
    const before = app.world().store.all("tasks").length;
    const evs = await app.ask("create a task to call Ana");
    const order = ["turn", "retrieval", "planner.request", "planner.reply", "plan", "call", "run", "diff", "reply", "done"];
    assert.deepEqual(kinds(evs).filter((k, i, all) => all.indexOf(k) === i && order.includes(k)), order);
    assert.equal(last(evs, "run").status, "done");
    assert.equal(last(evs, "reply").status, "done");
    assert.match(last(evs, "reply").text, /Call Ana/);
    assert.equal(last(evs, "diff").changes.length, 1);
    assert.equal(app.world().store.all("tasks").length, before + 1);
  });

  test("a clarifying question comes back as a reply with its options and changes nothing", async () => {
    const app = await start(scripted(reply({ type: "clarify", question: "What should the task say?", options: ["Call Ana", "Email Ana"] })));
    const audit = app.world().store.audit().length;
    const evs = await app.ask("create a task");
    assert.deepEqual(last(evs, "reply"), { status: "clarify", text: "What should the task say?", options: ["Call Ana", "Email Ana"] });
    assert.ok(!kinds(evs).includes("plan"));
    assert.equal(app.world().store.audit().length, audit);
  });

  test("the next message is planned together with the question it answers, and with the chat so far", async () => {
    const planner = scripted(reply({ type: "clarify", question: "What should the task say?" }), action("M06.A01", { title: "Call Ana" }));
    const app = await start(planner);
    await app.ask("create a task");
    await app.ask("Call Ana");
    const second = planner.requests[1]!.user;
    assert.match(second, /create a task/);
    assert.match(second, /What should the task say\?/);
  });

  test("a failing planner ends the turn with a failed reply, then done, and frees the app", async () => {
    const down: Planner = { name: "down", plan: () => Promise.reject(new PlannerError("provider is down", "provider")) };
    const app = await start(down);
    const evs = await app.ask("create a task to call Ana");
    assert.equal(last(evs, "reply").status, "failed");
    assert.match(last(evs, "reply").text, /provider is down/);
    assert.ok(!kinds(evs).includes("plan"));
    assert.equal(kinds(evs).at(-1), "done");
    // The server isn't stuck busy.
    assert.equal((await app.post("/api/ask", { message: "again" })).status, 200);
  });

  test("a bug in the turn, as opposed to the planner, comes back as an error event and still frees the app", async () => {
    const app = await start(scripted());
    const evs = await app.ask("create a task to call Ana");
    assert.match(last(evs, "error").message, /planner called more times than scripted/);
    assert.equal(kinds(evs).at(-1), "done");
    assert.equal((await app.post("/api/ask", { message: "again" })).status, 200);
  });

  test("a second ask while one is running is refused with 409", async () => {
    let release!: (p: SubmitPlan) => void;
    const held = new Promise<SubmitPlan>((ok) => (release = ok));
    const app = await start(scripted(held));
    const first = app.post("/api/ask", { message: "create a task to call Ana" });
    // Wait until the planner has the request, i.e. the app is busy.
    for (let i = 0; i < 100 && !(await busyNow(app)); i++) await new Promise((ok) => setTimeout(ok, 10));
    assert.equal((await app.post("/api/ask", { message: "another" })).status, 409);
    assert.equal((await app.post("/api/reset", {})).status, 409);
    release(action("M06.A01", { title: "Call Ana" }));
    assert.equal(last(await events(await first), "run").status, "done");
  });
});

/** True when a further ask is refused. */
async function busyNow(app: { post: (p: string, b: unknown) => Promise<Response> }) {
  return (await app.post("/api/confirm", { turnId: "probe", approve: false })).status === 409;
}

describe("confirmation", () => {
  // Every world starts from the same seed, so one world's open task is the next one's.
  const target = world().store.find<{ id: string }>("tasks", (t: any) => t.status === "open")[0]!.id;
  const statusOf = (app: Awaited<ReturnType<typeof start>>) => app.world().store.get<{ status: string }>("tasks", target)!.status;
  const cancel = () => start(scripted(action("M06.A10", { taskId: target })));

  test("a destructive step pauses with a preview and changes nothing until approved", async () => {
    const app = await cancel();
    const evs = await app.ask("cancel that task");
    assert.equal(last(evs, "run").status, "awaiting_confirmation");
    assert.ok(last(evs, "confirm").pending.reason);
    assert.equal(statusOf(app), "open");
  });

  test("approving runs the step once; the turn can't be confirmed twice", async () => {
    const app = await cancel();
    const turnId = last(await app.ask("cancel that task"), "confirm").turnId;
    assert.equal(last(await app.confirm(turnId, true), "run").status, "done");
    assert.equal(statusOf(app), "cancelled");
    assert.match(last(await app.confirm(turnId, true), "error").message, /Nothing is waiting for approval/);
  });

  test("cancelling leaves the record alone and says so", async () => {
    const app = await cancel();
    const turnId = last(await app.ask("cancel that task"), "confirm").turnId;
    assert.equal(last(await app.confirm(turnId, false), "reply").status, "cancelled");
    assert.equal(statusOf(app), "open");
  });

  test("confirming a turn that doesn't exist is an error event, not a crash", async () => {
    const app = await start(scripted());
    assert.match(last(await app.confirm("t99_none", true), "error").message, /Nothing is waiting for approval in turn t99_none/);
  });
});

describe("POST /api/reset", () => {
  test("reopens the database and forgets the conversation", async () => {
    const planner = scripted(reply({ type: "clarify", question: "What should the task say?" }), reply({ type: "clarify", question: "?" }));
    const app = await start(planner);
    await app.ask("create a task");
    const old = app.world();
    assert.equal((await app.post("/api/reset", {})).status, 200);
    assert.notEqual(app.world(), old);
    await app.ask("hello");
    const user = planner.requests[1]!.user;
    assert.doesNotMatch(user, /What should the task say\?/);
  });
});
