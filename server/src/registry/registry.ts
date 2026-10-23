import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { CATALOG_ACTIONS } from "./catalog.js";
import type { ActionDef } from "./define.js";
import type { Store } from "../store/db.js";

// The action registry. Modules register themselves: adding a capability is one new folder
// under modules/, with no change to the core agent.

export interface Candidate {
  id: string;
  name: string;
  detail?: string;
  /** Set when the record can't be used (its status, e.g. "deactivated"): returned only when nothing usable
   *  matches, so a step can say why rather than "no match". */
  inactive?: string;
}

/** Turns a name ("Sales", "Jo Park") into matching records of one entity type. */
export type LookupWhere = Record<string, string>;
export type Resolver = ((store: Store, name: string, where?: LookupWhere) => Candidate[]) & {
  /** Exact-match qualifiers understood by this resolver (never silently ignored). */
  qualifiers?: readonly string[];
  /** Titles/configuration labels should only be linked when the full label was mentioned. */
  exactMention?: boolean;
};

export interface ModuleExports {
  actions: ActionDef[];
  resolvers?: Record<string, Resolver>;
}

export interface RegisteredAction extends ActionDef {
  name: string;
  module: string;
  moduleId: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
}

export type JsonSchema = Record<string, unknown>;

export class Registry {
  private readonly actions = new Map<string, RegisteredAction>();
  private readonly resolvers = new Map<string, Resolver>();

  register(mod: ModuleExports): void {
    for (const def of mod.actions) {
      if (def.query && (def.risk === "external" || def.risk === "destructive")) throw new Error(`${def.id}: query metadata cannot hide external or destructive effects`);
      const entry = CATALOG_ACTIONS.get(def.id);
      if (!entry) throw new Error(`${def.id} is not in the catalog`);
      if (this.actions.has(def.id)) throw new Error(`${def.id} is registered twice`);
      this.actions.set(def.id, {
        ...def,
        name: entry.name,
        module: entry.module,
        moduleId: entry.moduleId,
        inputSchema: z.toJSONSchema(def.input, { io: "input", unrepresentable: "any" }) as JsonSchema,
        outputSchema: z.toJSONSchema(def.output, { io: "output", unrepresentable: "any" }) as JsonSchema,
      });
    }
    for (const [entity, fn] of Object.entries(mod.resolvers ?? {})) {
      if (this.resolvers.has(entity)) throw new Error(`resolver for ${entity} is registered twice`);
      this.resolvers.set(entity, fn);
    }
  }

  get(id: string): RegisteredAction | undefined {
    return this.actions.get(id);
  }

  list(): RegisteredAction[] {
    return [...this.actions.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  resolver(entity: string): Resolver | undefined {
    return this.resolvers.get(entity);
  }

  resolverEntities(): string[] {
    return [...this.resolvers.keys()].sort();
  }

  resolverQualifiers(): Record<string, readonly string[]> {
    return Object.fromEntries([...this.resolvers].filter(([, r]) => r.qualifiers?.length).map(([e, r]) => [e, r.qualifiers!]));
  }

  deliverySurfaces(): { id: string; label: string; actions: string[] }[] {
    const surfaces = new Map<string, { id: string; label: string; actions: string[] }>();
    for (const action of this.list()) {
      if (!action.destination) continue;
      const { id, label } = action.destination;
      const surface = surfaces.get(id) ?? { id, label, actions: [] };
      surface.actions.push(action.id);
      surfaces.set(id, surface);
    }
    return [...surfaces.values()];
  }
}

/** Builds a registry from every folder in modules/ that has an index file. */
export async function loadRegistry(dir = new URL("../modules/", import.meta.url).pathname): Promise<Registry> {
  const reg = new Registry();
  const folders = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  for (const folder of folders) {
    const file = ["index.ts", "index.js"].map((f) => join(dir, folder, f)).find((f) => existsSync(f));
    if (!file) continue;
    const mod = (await import(pathToFileURL(file).href)) as { default?: ModuleExports };
    if (!mod.default?.actions) throw new Error(`${folder}/index must default-export { actions }`);
    reg.register(mod.default);
  }
  return reg;
}
