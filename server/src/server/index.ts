// Dev server for the web UI over the dev database.
// Run: npm run serve (port 8787; the Vite dev server in web/ proxies /api here).
import { existsSync } from "node:fs";
import { makePlanner } from "../planner/index.js";
import { loadRegistry } from "../registry/registry.js";
import { buildCards } from "../retrieval/cards.js";
import { Retriever } from "../retrieval/retrieve.js";
import { DEV_DB, devStore, resetDevStore } from "../store/dev.js";
import { createApp } from "./app.js";

const PORT = Number(process.env.PORT ?? 8787);

const registry = await loadRegistry();
const planner = makePlanner();
const retriever = new Retriever(buildCards(registry));
if (!existsSync(DEV_DB)) resetDevStore();

const server = createApp({
  registry,
  planner,
  retriever,
  openWorld: ({ reset }) => {
    if (reset) resetDevStore();
    return devStore();
  },
});
server.listen(PORT, () => console.log(`ask-ai dev server on http://localhost:${PORT} (db ${DEV_DB}, planner ${planner.name})`));
