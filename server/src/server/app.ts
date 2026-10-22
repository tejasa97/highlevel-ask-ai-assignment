// The HTTP app behind the web UI: one chat over one database, with everything the debug view needs.
// POST /api/ask and /api/confirm stream the turn as server-sent events; the rest is plain JSON.
// index.ts wires it to the dev database and a real planner; the tests wire it to a scripted one.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Planner, Tier } from "../planner/types.js";
import { DEFAULT_ACTOR } from "../registry/invoke.js";
import type { Registry } from "../registry/registry.js";
import type { Retriever } from "../retrieval/retrieve.js";
import type { Clock } from "../store/clock.js";
import type { Store } from "../store/db.js";
import { Conversation, type Emit } from "./conversation.js";

export interface AppDeps {
  registry: Registry;
  planner: Planner;
  retriever: Retriever;
  /** Opens the database the chat runs over; called once at start and again after every reset. */
  openWorld: (opts: { reset: boolean }) => { store: Store; clock: Clock };
}

/** An HTTP server that is not listening yet. All conversation state lives inside this call, so apps don't share it. */
export function createApp({ registry, planner, retriever, openWorld }: AppDeps): Server {
  let world = openWorld({ reset: false });

  const chat = new Conversation({ registry, planner, retriever }, world);
  let busy = false;

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

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    try {
      if (req.method === "POST" && path === "/api/ask") {
        const b = await body(req);
        const message = String(b.message ?? "").trim();
        if (!message) return json(res, 400, { error: "message is required" });
        const tier: Tier = b.tier === "fast" ? "fast" : "strong";
        return stream(res, (emit) => chat.ask(message, tier, String(b.actorId ?? DEFAULT_ACTOR), emit));
      }
      if (req.method === "POST" && path === "/api/confirm") {
        const b = await body(req);
        return stream(res, (emit) => chat.confirm(String(b.turnId), b.approve === true, String(b.actorId ?? DEFAULT_ACTOR), emit));
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
        world.store.close();
        world = openWorld({ reset: true });
        chat.reset(world);
        return json(res, 200, { ok: true });
      }
      json(res, 404, { error: "not found" });
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}
