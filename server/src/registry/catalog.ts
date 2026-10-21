import { readFileSync } from "node:fs";

// HighLevel's 50 × 10 catalog. catalog.json is generated from the assignment PDF by `npm run catalog`
// and committed, so nothing needs the PDF at runtime.

export interface CatalogModule {
  id: string;
  name: string;
  description: string;
  actions: { id: string; name: string }[];
}

export const CATALOG: CatalogModule[] = JSON.parse(readFileSync(new URL("./catalog.json", import.meta.url), "utf8")).modules;

export const CATALOG_ACTIONS = new Map(
  CATALOG.flatMap((m) => m.actions.map((a) => [a.id, { ...a, module: m.name, moduleId: m.id }] as const)),
);
