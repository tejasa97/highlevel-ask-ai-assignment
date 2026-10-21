import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { type Clock, frozenClock } from "./clock.js";
import { Store } from "./db.js";
import { seed } from "./seed.js";

// The dev database: a file, so a demo or the server keeps its changes between runs.
// Tests never touch it; they use world(). Reset it with `npm run db:reset`.

export const DEV_DB = fileURLToPath(new URL("../../data/dev.sqlite", import.meta.url));

export function devStore(): { store: Store; clock: Clock } {
  if (!existsSync(DEV_DB)) throw new Error(`No dev database at ${DEV_DB}; run npm run db:reset`);
  return { store: new Store(DEV_DB), clock: frozenClock() };
}

/** Deletes the dev database and seeds a new one. */
export function resetDevStore(): string {
  rmSync(DEV_DB, { force: true });
  mkdirSync(dirname(DEV_DB), { recursive: true });
  const store = new Store(DEV_DB);
  seed(store, frozenClock());
  store.close();
  return DEV_DB;
}
