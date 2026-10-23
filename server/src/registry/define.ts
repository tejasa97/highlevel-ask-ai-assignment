import type { z } from "zod";
import type { Clock } from "../store/clock.js";
import type { Store } from "../store/db.js";
import type { Fixtures } from "../store/fixtures.js";

// One action = one catalog entry (M01.A01 …) with typed input/output and a real handler.
// The display name comes from catalog.json, so ids and names can't drift from HighLevel's catalog.

export type Risk = "read" | "write" | "destructive" | "external";

export interface ActionContext {
  store: Store;
  clock: Clock;
  /** User id of the person asking. Defaults to the account admin (see store/seed.ts). */
  actorId?: string;
  /** Told about every handler run, for tracing (the debug view). */
  onCall?: (c: CallTrace) => void;
}

export interface CallTrace {
  action: string;
  name: string;
  risk: string;
  args: Record<string, unknown>;
  ms: number;
  result?: unknown;
  error?: { code: string; message: string };
}

export interface ActionDef<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  id: string;
  /** User-language description: what it does, and how it differs from look-alikes. */
  description: string;
  /** General user-language paraphrases; indexed by both lexical and semantic retrieval. */
  synonyms?: string[];
  risk: Risk;
  /** Use z.strictObject so made-up params are rejected instead of ignored. */
  input: I;
  output: O;
  /** Entity types this action produces and consumes, for dependency expansion in retrieval. */
  entities?: { produces?: string; consumes?: string[]; optionalConsumes?: string[]; lookup?: string };
  /** Explicit delivery surface, not an inferred match on words like "post". */
  destination?: { id: string; label: string };
  /** Look-alike actions in other modules, always retrieved together. */
  siblings?: string[];
  /** Optional side-effect-free eligibility check. Throw an ActionError for a known blocker;
   * return recipient/target details that must be bound to approval. Never deliver, audit or consume faults.
   * The handler must still repeat its checks at execution time. */
  preflight?: (args: z.output<I>, ctx: ActionContext) => Record<string, unknown>;
  /** Synchronous: every call runs inside a transaction. Throw ActionError for expected failures. */
  handler: (args: z.output<I>, ctx: ActionContext) => z.input<O>;
  /**
   * For an action that records an outcome which did not go through (a bounced email, a failed sync) instead of throwing,
   * so the trail survives. Returns the clause the reply adds after "Done: …, but ", or nothing when it all went through.
   */
  caveat?: (out: z.output<O>) => string | undefined;
  /**
   * A valid call for the smoke test: create whatever records it needs with `f`, return the args.
   * The smoke test also derives the invalid call from it (an unknown id, or a made-up param).
   */
  example: (f: Fixtures) => z.input<I>;
}

type DeepReadonly<T> = T extends (infer U)[] ? readonly DeepReadonly<U>[] : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;

/**
 * `X` exists only so examples type-check with their literals intact. Typed directly against z.input<I>,
 * an example's enum strings widen to `string` (the return is checked before I is known) and fail.
 */
export function defineAction<I extends z.ZodType, O extends z.ZodType, const X extends DeepReadonly<z.input<I>>>(
  def: Omit<ActionDef<I, O>, "example"> & { example: (f: Fixtures) => X },
): ActionDef<I, O> {
  return def as ActionDef<I, O>;
}

export type ErrorCode = "NOT_FOUND" | "DUPLICATE" | "INVALID" | "CONFLICT" | "PERMISSION" | "TIMEOUT" | "UNAVAILABLE";

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
