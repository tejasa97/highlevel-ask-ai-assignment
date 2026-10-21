import type { z } from "zod";
import type { Clock } from "../store/clock.js";
import type { Store } from "../store/db.js";

// One action = one catalog entry (M01.A01 …) with typed input/output and a real handler.
// The display name comes from catalog.json, so ids and names can't drift from HighLevel's catalog.

export type Risk = "read" | "write" | "destructive" | "external";

export interface ActionContext {
  store: Store;
  clock: Clock;
}

export interface ActionDef<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  id: string;
  /** User-language description: what it does, and how it differs from look-alikes. */
  description: string;
  risk: Risk;
  /** Use z.strictObject so made-up params are rejected instead of ignored. */
  input: I;
  output: O;
  /** Entity types this action produces and consumes, for dependency expansion in retrieval. */
  entities?: { produces?: string; consumes?: string[] };
  /** Look-alike actions in other modules, always retrieved together. */
  siblings?: string[];
  handler: (args: z.output<I>, ctx: ActionContext) => z.input<O> | Promise<z.input<O>>;
}

export function defineAction<I extends z.ZodType, O extends z.ZodType>(def: ActionDef<I, O>): ActionDef<I, O> {
  return def;
}

export type ErrorCode = "NOT_FOUND" | "DUPLICATE" | "INVALID" | "CONFLICT" | "PERMISSION" | "TIMEOUT";

/** A typed, expected failure. The executor reports it; it never crashes the run. */
export class ActionError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Get-or-throw helper for handlers. */
export function mustGet<T>(store: Store, entity: string, id: string, label = entity): T {
  const doc = store.get<T>(entity, id);
  if (!doc) throw new ActionError("NOT_FOUND", `No ${label} with id ${id}`, { entity, id });
  return doc;
}
