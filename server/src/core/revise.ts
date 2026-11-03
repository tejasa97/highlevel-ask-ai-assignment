import type { ActionContext } from "../registry/define.js";
import type { RegisteredAction, Registry } from "../registry/registry.js";
import { ENTITIES } from "../store/entities.js";
import { pathOf } from "./refs.js";

// A follow-up that narrows or changes what the last turn made ("only the Facebook ones, due tomorrow") is planned as
// the request whole, and this decides what that means for the records already made. Code does it, not the planner:
// a create that declares `revise` finds the record the last turn made for the same thing (`revise.key`), changes
// the fields that now differ with the action `revise.edits` names, and leaves it be when none do; the records the
// request no longer includes are the ones cancelled afterwards.

/** A message that asks for more ("one for Tom too") is not a change to what was made, whatever the planner flagged. */
const MORE = /\b(also|too|another|more|as well|again|new)\b/i;
export const asksForMore = (message: string): boolean => MORE.test(message);

/** What a create becomes when its record already exists: the edits that bring it in line, possibly none. */
export interface Revision {
  entity: string;
  id: string;
  edits: { action: RegisteredAction; args: Record<string, unknown> }[];
}

/** What the last turn made: the identities its records hold, by record type. */
export interface Made { entity: string; id: string; name: string; for?: string }

export const tableOf = (id: string): string | undefined => Object.entries(ENTITIES).find(([, d]) => id.startsWith(`${d.prefix}_`))?.[0];

const at = (value: unknown, path: (string | number)[]): unknown =>
  path.reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string | number, unknown>)[k] : undefined), value);

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The argument of an edit that says which record it changes, by the convention `<entity>Id` ("taskId"). */
export const idArg = (entity: string) => `${entity.replace(/_(\w)/g, (_, c: string) => c.toUpperCase())}Id`;

export const inputKeys = (action: RegisteredAction): string[] => Object.keys((action.input as { shape?: Record<string, unknown> }).shape ?? {});

/** Whether every edit a create declares can be made: it exists, and takes the record's id and the field. */
export function reviseErrors(action: RegisteredAction, registry: Pick<Registry, "get">): string[] {
  const { revise } = action;
  const entity = action.entities?.produces;
  if (!revise) return [];
  if (!entity) return [`${action.id}: revise needs the action to declare what it produces`];
  const errors: string[] = [];
  if (!inputKeys(action).includes(revise.key.split(".")[0]!)) errors.push(`${action.id}: revise key ${revise.key} is not an argument of the action`);
  for (const [field, id] of Object.entries(revise.edits)) {
    const edit = registry.get(id);
    if (!edit) errors.push(`${action.id}: revise edit for ${field} names ${id}, which is not an action`);
    else if (!inputKeys(edit).includes(idArg(entity)) || !inputKeys(edit).includes(field)) errors.push(`${action.id}: ${id} must take ${idArg(entity)} and ${field} to edit ${field}`);
  }
  const undo = registry.get(revise.undo);
  if (!undo) errors.push(`${action.id}: revise undo names ${revise.undo}, which is not an action`);
  else if (!inputKeys(undo).includes(idArg(entity))) errors.push(`${action.id}: ${revise.undo} must take ${idArg(entity)} to cancel one`);
  return errors;
}

/** An open record is one a follow-up may still change; a finished or cancelled one is left as it is. */
const open = (record: Record<string, unknown>) => typeof record.status !== "string" || record.status === "open";

/**
 * The revision of one create call, if the last turn made a record for the same thing and nobody has taken it in this
 * run. `taken` collects the ids used, so two calls never share one record.
 */
export function reviseCall(
  action: RegisteredAction,
  args: Record<string, unknown>,
  made: Made[],
  taken: Set<string>,
  ctx: Pick<ActionContext, "store">,
  registry: Pick<Registry, "get">,
): Revision | undefined {
  const { revise } = action;
  const entity = action.entities?.produces;
  if (!revise || !entity || reviseErrors(action, registry).length) return undefined;
  const key = at(args, pathOf(revise.key));
  if (typeof key !== "string") return undefined;
  const prior = made.find((r) => r.entity === entity && r.for === key && !taken.has(r.id));
  const table = prior && tableOf(prior.id);
  const record = prior && table ? ctx.store.get<Record<string, unknown>>(table, prior.id) : undefined;
  if (!prior || !record || !open(record)) return undefined;
  taken.add(prior.id);
  const edits = Object.entries(revise.edits).flatMap(([field, id]) => {
    const edit = registry.get(id);
    return edit && args[field] !== undefined && !same(record[field], args[field]) ? [{ action: edit, args: { [idArg(entity)]: prior.id, [field]: args[field] } }] : [];
  });
  return { entity, id: prior.id, edits };
}

/** The records of the last turn that this run's creates did not take, and that can still be cancelled. */
export function leftOut(
  actions: RegisteredAction[],
  made: Made[],
  taken: Set<string>,
  ctx: Pick<ActionContext, "store">,
): { action: RegisteredAction; record: Made }[] {
  const entities = new Map(actions.flatMap((a) => (a.revise && a.entities?.produces ? [[a.entities.produces, a] as const] : [])));
  return made.flatMap((record) => {
    const action = entities.get(record.entity);
    const table = tableOf(record.id);
    const now = action && !taken.has(record.id) && table ? ctx.store.get<Record<string, unknown>>(table, record.id) : undefined;
    return action && now && open(now) ? [{ action, record }] : [];
  });
}
