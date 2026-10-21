import { ActionError } from "./registry/define.js";
import { invoke } from "./registry/invoke.js";
import { loadRegistry, type Registry } from "./registry/registry.js";
import { world, type World } from "./store/world.js";

// Test helpers: a world plus `call`, which validates args and runs one action the way the executor does.

export interface TestWorld extends World {
  /** Runs one action in a transaction. Invalid args throw ActionError INVALID, like the executor reports them. */
  call(id: string, args: Record<string, unknown>, actorId?: string): any;
}

let shared: Promise<Registry> | undefined;
export const registry = (): Promise<Registry> => (shared ??= loadRegistry());

export async function testWorld(opts: Parameters<typeof world>[0] = {}): Promise<TestWorld> {
  const reg = await registry();
  const w = world(opts);
  return { ...w, call: (id, args, actorId) => call(reg, w, id, args, actorId) };
}

export function call(reg: Registry, w: World, id: string, args: Record<string, unknown>, actorId?: string): unknown {
  const action = reg.get(id);
  if (!action) throw new Error(`${id} is not registered`);
  const parsed = action.input.safeParse(args);
  if (!parsed.success) throw new ActionError("INVALID", parsed.error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; "));
  return w.store.tx(() => invoke(action, parsed.data as Record<string, unknown>, { store: w.store, clock: w.clock, actorId }));
}

/** Runs fn, expecting an ActionError; returns it so the test can check code and message. */
export function failure(fn: () => unknown): ActionError {
  try {
    fn();
  } catch (e) {
    if (e instanceof ActionError) return e;
    throw e;
  }
  throw new Error("expected an ActionError, but the call succeeded");
}
