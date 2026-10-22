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

describe("M45–M47 through real HTTP (scripted plans, not AI evaluation)", () => {
  for (const approve of [true, false]) test(`mixed ticket replies show the exact subset before ${approve ? "approval" : "cancellation"}`, async () => {
    const p = scripted(reply({ steps: [
      { id: "s1", kind: "action", action: "M47.A08", argsJson: JSON.stringify({ ticketId: "tic_4", body: "We received your report" }) },
      { id: "s2", kind: "action", action: "M47.A08", argsJson: JSON.stringify({ ticketId: "tic_1", body: "We received your report" }) },
    ] }));
    const app = await start(p), store = app.world().store;
    const emails = store.all("emails").length, audit = store.audit().length;
    const first = await app.ask("Reply to support tickets tic_4 and tic_1");
    const pending = last(first, "confirm").pending;
    assert.equal(pending.count, 1);
    assert.equal(pending.blockedCount, 1);
    assert.match(pending.blocked[0].error.message, /email address/i);
    assert.equal(pending.preview[0].args.ticketId, "tic_1");
    assert.ok(pending.preview[0].target.to);
    assert.match(last(first, "reply").text, /Proceed with only these/);
    assert.equal(store.all("emails").length, emails, "no sends before user choice");
    assert.equal(store.audit().length, audit, "preflight is side-effect free");
    assert.deepEqual(last(first, "diff").changes, []);
    const id = last(first, "turn").turnId;
    const done = await app.confirm(id, approve);
    assert.equal(last(done, "reply").status, approve ? "partial" : "cancelled");
    assert.equal(store.all("emails").length, emails + Number(approve));
    assert.equal(store.get<any>("tickets", "tic_1").status, approve ? "in_progress" : "open");
    assert.equal(store.get<any>("tickets", "tic_4").firstResponseAt, null);
    assert.equal(p.requests.length, 1, "choice resumes the saved plan, not another LLM call");
    assert.ok(last(await app.confirm(id, true), "error"), "duplicate confirmation refused");
  });
  test("different external actions retain earlier approvals instead of ping-ponging gates", async () => {
    const p=scripted(reply({steps:[
      {id:"s1",kind:"action",action:"M47.A08",argsJson:JSON.stringify({ticketId:"tic_1",body:"We received your report"})},
      {id:"s2",kind:"action",action:"M45.A02",argsJson:JSON.stringify({requestId:"rrq_1"})},
    ]}));
    const app=await start(p),store=app.world().store,emails=store.all("emails").length;
    const first=await app.ask("Reply to support ticket tic_1 and send review request rrq_1 to Elodie Mercer");
    assert.equal(last(first,"confirm").pending.stepId,"s1");
    const turnId=last(first,"turn").turnId;
    const second=await app.confirm(turnId,true);
    assert.equal(last(second,"confirm").pending.stepId,"s2");
    assert.equal(store.all("emails").length,emails+1);
    const done=await app.confirm(turnId,true);
    assert.equal(last(done,"reply").status,"done",JSON.stringify(done));
    assert.equal(store.all("emails").length,emails+2,"approved earlier send must not repeat");
    assert.equal(store.get<any>("tickets","tic_4").firstResponseAt,null);
    assert.equal(p.requests.length,1,"approval progression never replans");
  });
  test("search_tools offers additional tools without dropping a previously offered ticket action", async () => {
    const p = scripted(reply({type:"search_tools",query:"create support ticket"}),action("M47.A01",{contactId:"ct_31",title:"Invoice follow-up",body:"Recent reply and overdue invoice"}));
    const app = await start(p);
    const done = await app.ask("Find contacts with overdue invoices who replied in the last seven days, then open a support ticket for each");
    assert.equal(last(done,"reply").status,"done",JSON.stringify(done));
    assert.equal(p.requests.length,2);
    assert.ok(done.filter(e=>e.event==="retrieval").length===2);
    assert.match(p.requests[1]!.user,/M47.A01/);
    assert.equal(app.world().store.find<any>("tickets",t=>t.title==="Invoice follow-up").length,1);
  });
  test("all thirty actions and their tables are visible to the existing UI", async () => {
    const app = await start(scripted());
    const meta = await (await app.get("/api/meta")).json() as any;
    assert.equal(meta.actions.length, 180);
    for (const module of ["M45", "M46", "M47"]) assert.equal(meta.actions.filter((a:any) => a.id.startsWith(module)).length, 10);
    for (const table of ["review_requests", "reviews", "listings", "tickets"]) {
      assert.ok(meta.tables.some((t:any) => t.name === table && t.count > 0));
      assert.ok((await (await app.get(`/api/tables/${table}`)).json() as any[]).length > 0);
    }
  });

  test("review send pauses, decline sends nothing, approve updates both email and request exactly once", async () => {
    const p = scripted(action("M45.A02", {requestId:"rrq_1"}), action("M45.A02", {requestId:"rrq_1"}));
    const app = await start(p), store = app.world().store;
    const before = store.all("emails").length;
    const first = await app.ask("Send draft review request rrq_1");
    assert.equal(last(first,"reply").status, "awaiting_confirmation");
    assert.equal(store.all("emails").length, before);
    const id1 = last(first,"turn").turnId;
    assert.equal(last(await app.confirm(id1,false),"reply").status,"cancelled");
    assert.equal(store.get<any>("review_requests","rrq_1").status,"draft");
    const second = await app.ask("Send draft review request rrq_1");
    const id2 = last(second,"turn").turnId;
    const done = await app.confirm(id2,true);
    assert.equal(last(done,"reply").status,"done");
    assert.equal(store.get<any>("review_requests","rrq_1").status,"sent");
    assert.equal(store.all("emails").length,before+1);
    const duplicate = await app.confirm(id2,true);
    assert.match(last(duplicate,"error").message,/Nothing is waiting/);
    assert.equal(store.all("emails").length,before+1);
    assert.equal(p.requests.length,2,"approvals never call the planner");
  });

  test("ticket reply + task uses one execution path, waits for consent, and streams both changes", async () => {
    const p = scripted(reply({steps:[
      {id:"s1",kind:"action",action:"M47.A08",argsJson:JSON.stringify({ticketId:"tic_1",body:"We are investigating"})},
      {id:"s2",kind:"action",action:"M06.A01",argsJson:JSON.stringify({title:"Follow up on export",relatedTo:{type:"contact",id:"ct_35"}})},
    ]}));
    const app = await start(p), store = app.world().store, tasks = store.all("tasks").length;
    const first = await app.ask("Reply to ticket tic_1 and create a follow-up task");
    assert.equal(last(first,"reply").status,"awaiting_confirmation");
    assert.equal(store.all("tasks").length,tasks);
    const done = await app.confirm(last(first,"turn").turnId,true);
    assert.equal(last(done,"reply").status,"done");
    assert.equal(store.all("tasks").length,tasks+1);
    assert.equal(store.get<any>("tickets","tic_1").status,"in_progress");
    assert.ok(store.get<any>("tickets","tic_1").firstResponseAt);
    const tables = new Set(last(done,"diff").changes.map((c:any) => c.table));
    for(const table of ["tickets","emails","tasks"])assert.ok(tables.has(table),table);
    const conversation = last(done,"diff").changes.find((c:any)=>c.table==="conversations").after;
    assert.match(conversation.id,/^cv_\d+$/);
    assert.equal("body" in conversation,false,"message payload must not leak into a conversation row");
    assert.equal(p.requests.length,1);
  });

  test("missing requester email fails before asking approval without advancing the ticket or SLA", async () => {
    const app = await start(scripted(action("M47.A08",{ticketId:"tic_4",body:"An update"})));
    const store = app.world().store, before = store.get("tickets","tic_4"), emails = store.all("emails");
    const first = await app.ask("Reply to ticket tic_4 by email");
    assert.equal(last(first,"reply").status,"failed");
    assert.equal(last(first,"confirm"),undefined);
    const done = first;
    assert.equal(last(done,"reply").status,"failed");
    assert.match(last(done,"reply").text,/no email|email address/i);
    assert.deepEqual(store.get("tickets","tic_4"),before);
    assert.deepEqual(store.all("emails"),emails);
    assert.deepEqual(last(done,"diff").changes,[]);
  });

  test("listing name collision asks for the directory; the specified listing resolves next turn", async () => {
    const planFor = (name:string) => reply({steps:[
      {id:"s1",kind:"resolve",entity:"listing",name},
      {id:"s2",kind:"action",action:"M46.A02",argsJson:JSON.stringify({listingId:"$s1.id"})},
    ]});
    const app = await start(scripted(planFor("Maple Dental"),planFor("Maple Dental google")));
    const first = await app.ask("Show Maple Dental's business listing");
    assert.equal(last(first,"reply").status,"needs_clarification");
    assert.match(last(first,"reply").text,/google/);
    assert.match(last(first,"reply").text,/yelp/);
    const done = await app.ask("The Google listing");
    assert.equal(last(done,"reply").status,"done");
    assert.match(last(done,"reply").text,/Maple Dental.*directory google/);
  });

  test("internal ticket note never becomes a contact note or a delivered message", async () => {
    const app = await start(scripted(action("M47.A07",{ticketId:"tic_1",body:"Private triage"})));
    const store = app.world().store, notes = store.all("notes"), emails = store.all("emails");
    const done = await app.ask("Add a private internal ticket note to tic_1");
    assert.equal(last(done,"reply").status,"done");
    assert.equal(store.get<any>("tickets","tic_1").notes.at(-1).body,"Private triage");
    assert.deepEqual(store.all("notes"),notes);
    assert.deepEqual(store.all("emails"),emails);
    assert.equal(store.get<any>("tickets","tic_1").firstResponseAt,null);
  });

  for(const [id,args,message,table,recordId,field] of [
    ["M45.A09",{reviewId:"rv_2",body:"Thanks for the feedback"},"Publish a response to customer review rv_2","reviews","rv_2","responsePublishedAt"],
    ["M46.A09",{listingId:"bl_3"},"Publish business listing bl_3 to its directory","listings","bl_3","publishedAt"],
  ] as const) test(`${id} publication is gated and emits audited state changes`,async()=>{
    const app = await start(scripted(action(id,args))), store = app.world().store;
    const before = store.get(table,recordId);
    const first = await app.ask(message);
    assert.equal(last(first,"reply").status,"awaiting_confirmation");
    assert.deepEqual(store.get(table,recordId),before);
    const done = await app.confirm(last(first,"turn").turnId,true);
    assert.equal(last(done,"reply").status,"done",JSON.stringify(done));
    assert.ok(last(done,"diff").audit.some((a:any)=>a.action===id));
    assert.notDeepEqual(store.get(table,recordId),before);
  });
});

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
