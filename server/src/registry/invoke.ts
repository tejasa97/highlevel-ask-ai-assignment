import type { z } from "zod";
import { ActionError, type ActionContext, type ErrorCode } from "./define.js";
import type { RegisteredAction } from "./registry.js";

// The one place an action's handler runs. The executor, the tests and the smoke test all go through it,
// so injected faults and the audit log behave the same everywhere. Args must already be validated.

export const DEFAULT_ACTOR = "us_1";

const ID = /^[a-z]{2,3}_\d+$/;

export function invoke(action: RegisteredAction, args: Record<string, unknown>, ctx: ActionContext): unknown {
  const actor = ctx.actorId ?? DEFAULT_ACTOR;
  for (const f of ctx.store.faults(action.id)) {
    if (Object.entries(f.match).every(([k, v]) => JSON.stringify(args[k]) === JSON.stringify(v))) {
      ctx.store.consumeFault(f.seq);
      throw new ActionError(f.code as ErrorCode, f.message);
    }
  }
  const out = (action.output as z.ZodType).parse(action.handler(args, { ...ctx, actorId: actor }));
  if (action.risk !== "read") {
    const refs = [...new Set([...ids(args), ...ids(out, 1)])];
    ctx.store.logAudit({ at: ctx.clock.now().toISOString(), actor, action: action.id, summary: summary(action, out), refs });
  }
  return out;
}

/** Record ids in a value: every id-shaped string in args, and the top-level ids of a result. */
function ids(v: unknown, depth = Infinity): string[] {
  if (typeof v === "string") return ID.test(v) ? [v] : [];
  if (depth < 0 || v === null || typeof v !== "object") return [];
  const vals = Array.isArray(v) ? v : Object.values(v);
  return vals.flatMap((x) => ids(x, depth - 1));
}

function summary(action: RegisteredAction, out: unknown): string {
  const o = out as Record<string, unknown> | null;
  const label = o?.name ?? o?.title ?? o?.subject ?? o?.number;
  return typeof label === "string" ? `${action.name}: ${label}` : action.name;
}
