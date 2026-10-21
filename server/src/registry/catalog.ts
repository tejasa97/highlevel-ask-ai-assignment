import { existsSync, readFileSync } from "node:fs";

// HighLevel's 50 × 10 catalog. catalog.json is generated from the assignment PDF by `npm run catalog`
// and gitignored, so HighLevel's material never lands in the repo.

export interface CatalogModule {
  id: string;
  name: string;
  description: string;
  actions: { id: string; name: string }[];
}

const FILE = new URL("./catalog.json", import.meta.url);
if (!existsSync(FILE)) throw new Error("src/registry/catalog.json is missing. Run `npm run catalog` (needs docs/assignment/ask-ai-50-modules-500-actions.pdf).");

export const CATALOG: CatalogModule[] = JSON.parse(readFileSync(FILE, "utf8")).modules;

export const CATALOG_ACTIONS = new Map(
  CATALOG.flatMap((m) => m.actions.map((a) => [a.id, { ...a, module: m.name, moduleId: m.id }] as const)),
);
