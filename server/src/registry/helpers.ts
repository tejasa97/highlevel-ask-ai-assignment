import { z } from "zod";
import type { Contact } from "../modules/m01-contacts/schema.js";
import type { Lead } from "../modules/m03-leads/schema.js";
import { ROLE_PERMISSIONS, type User } from "../modules/m48-users/schema.js";
import type { Store } from "../store/db.js";
import { ActionError, mustGet } from "./define.js";
import type { Candidate } from "./registry.js";

// Small helpers shared by module handlers.

// A possessive is dropped before punctuation is, so "Sarah Johnson's walkthrough" names the same words as "Sarah Johnson walkthrough".
export const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/['\u2019]s\b/gu, "").replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();

/**
 * Name matching for resolvers: exact (case-insensitive) beats a whole-word match, which beats a prefix.
 * Last, a name of two or more words that the request contains whole, with words of its own around it:
 * "Zoe Costa at Umbrella" names the contact "Zoe Costa"; "Mailbox delivery support" names "Mailbox delivery".
 * Returns only the best tier, so "Jo" doesn't match "Jo Park" and "Joan Silva" equally when "Jo Park" is exact.
 */
export function matchByName<T>(docs: T[], name: string, label: (d: T) => string): T[] {
  const q = norm(name);
  if (!q) return [];
  const qWords = new Set(q.split(" "));
  const tiers: T[][] = [[], [], [], []];
  for (const d of docs) {
    const n = norm(label(d));
    const words = n.split(" ");
    if (n === q) tiers[0]!.push(d);
    else if (words.includes(q) || q.split(" ").every((w) => words.includes(w))) tiers[1]!.push(d);
    else if (words.some((w) => w.startsWith(q))) tiers[2]!.push(d);
    else if (words.length >= 2 && words.every((w) => qWords.has(w))) tiers[3]!.push(d);
  }
  return tiers.find((t) => t.length > 0) ?? [];
}

/** Records matching `name`. With `inactive` (a record's status when it can't be used, else undefined), usable
 *  records are matched first; only when none match are the unusable ones returned, marked with their status. */
export function candidates<T extends { id: string }>(
  docs: T[],
  name: string,
  label: (d: T) => string,
  detail?: (d: T) => string,
  inactive?: (d: T) => string | undefined,
): Candidate[] {
  const out = (ds: T[]) => ds.map((d) => ({ id: d.id, name: label(d), ...(detail ? { detail: detail(d) } : {}), ...(inactive?.(d) ? { inactive: inactive(d) } : {}) }));
  if (!inactive) return out(matchByName(docs, name, label));
  const usable = matchByName(docs.filter((d) => !inactive(d)), name, label);
  return out(usable.length ? usable : matchByName(docs.filter((d) => inactive(d)), name, label));
}

/** Inclusive YYYY-MM-DD range check on an ISO timestamp. */
export function inDateRange(iso: string, from?: string, to?: string): boolean {
  const day = iso.slice(0, 10);
  return (!from || day >= from) && (!to || day <= to);
}

export function contains(hay: unknown, needle: string): boolean {
  return typeof hay === "string" && hay.toLowerCase().includes(needle.toLowerCase());
}

/** Search output: `items` is capped at `limit`, `total` counts every match. */
export function listOf<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), total: z.number().describe("all matches, even past the limit") });
}

export const Limit = z.number().int().min(1).max(500).optional().describe("max items to return (default 50)");

export function page<T>(items: T[], limit = 50): { items: T[]; total: number } {
  return { items: items.slice(0, limit), total: items.length };
}

/** "Ana" + "Ruiz" → "Ana Ruiz"; a missing last name is dropped. */
export function fullName(first: string, last: string | null | undefined): string {
  return [first, last].filter(Boolean).join(" ");
}

/** A user who can be given work right now: exists and is active. Availability is the caller's call. */
export function activeUser(store: Store, id: string, purpose: string): User {
  const u = mustGet<User>(store, "users", id, "user");
  if (u.status !== "active") throw new ActionError("CONFLICT", `${u.name} is ${u.status} and can't ${purpose}`, { userId: id, status: u.status });
  return u;
}

/** Throws CONFLICT unless `current` is one of `allowed`. */
export function requireState<S extends string>(label: string, current: S, allowed: readonly S[], doing: string): void {
  if (!allowed.includes(current)) throw new ActionError("CONFLICT", `${label} is ${current}; can only ${doing} when ${allowed.join(" or ")}`, { status: current });
}

/** Throws CONFLICT for an update that would leave the record exactly as it is. */
export function noChange(): never {
  throw new ActionError("CONFLICT", "The record already has that value");
}

/** Rejects dates before today, which almost always means a date was worked out wrong. */
export function notPast(date: string, today: string, what: string): void {
  if (date < today) throw new ActionError("INVALID", `${what} ${date} is in the past (today is ${today})`);
}

export function sameEmail(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Throws PERMISSION unless the acting user holds `permission` through one of their roles. */
export function requirePermission(store: Store, actorId: string | undefined, permission: string): void {
  const actor = actorId ? store.get<User>("users", actorId) : undefined;
  if (!actor || actor.status !== "active") throw new ActionError("PERMISSION", `Acting user ${actorId ?? "(none)"} isn't an active user`);
  if (!permissionsOf(actor).includes(permission)) {
    throw new ActionError("PERMISSION", `${actor.name} (${actor.roles.join(", ")}) doesn't have ${permission}`, { permission });
  }
}

export function permissionsOf(u: Pick<User, "roles">): string[] {
  return [...new Set(u.roles.flatMap((r) => ROLE_PERMISSIONS[r]))].sort();
}

/** At least one of `keys` must be present: update actions with nothing to change are a planning mistake. */
export function atLeastOne<T extends Record<string, unknown>>(args: T, keys: (keyof T)[]): void {
  if (!keys.some((k) => args[k] !== undefined)) throw new ActionError("INVALID", `Nothing to change: give at least one of ${keys.join(", ")}`);
}

/** A contact or a lead: messages, conversations and appointments can be with either. */
export interface Person {
  type: "contact" | "lead";
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
}

/** Input fields for "a contact or a lead": exactly one must be given. */
export const PersonArgs = {
  contactId: z.string().optional().describe("contact id (ct_…); give this or leadId"),
  leadId: z.string().optional().describe("lead id (ld_…); give this or contactId"),
};

/** The contact or lead named by exactly one of contactId / leadId. Archived and merged contacts and converted leads are refused. */
export function person(store: Store, a: { contactId?: string; leadId?: string }, doing: string): Person {
  if (!!a.contactId === !!a.leadId) throw new ActionError("INVALID", "Give exactly one of contactId or leadId");
  if (a.contactId) {
    const c = mustGet<Contact>(store, "contacts", a.contactId, "contact");
    if (c.status === "merged") throw new ActionError("CONFLICT", `${c.name} was merged into ${c.mergedInto}; use that contact instead`, { mergedInto: c.mergedInto });
    requireState(c.name, c.status, ["active"], doing);
    return { type: "contact", id: c.id, name: c.name, email: c.email, phone: c.phone };
  }
  const l = mustGet<Lead>(store, "leads", a.leadId!, "lead");
  if (l.status === "converted") throw new ActionError("CONFLICT", `Lead ${l.name} was converted; use contact ${l.convertedTo?.contactId} instead`, { convertedTo: l.convertedTo });
  return { type: "lead", id: l.id, name: l.name, email: l.email, phone: l.phone };
}

/** The contactId / leadId pair stored on records that belong to a person. */
export function personRef(p: Person): { contactId: string | null; leadId: string | null } {
  return { contactId: p.type === "contact" ? p.id : null, leadId: p.type === "lead" ? p.id : null };
}

/** Display name of whoever a contactId / leadId pair points at. */
export function personName(store: Store, ref: { contactId: string | null; leadId: string | null }): string | null {
  const doc = ref.contactId ? store.get<Contact>("contacts", ref.contactId) : ref.leadId ? store.get<Lead>("leads", ref.leadId) : undefined;
  return doc?.name ?? null;
}

/** Money rounded to cents, so sums of line items don't drift. */
export const cents = (n: number): number => Math.round(n * 100) / 100;

/** An id for a record nested inside another one, skipping any already in `used`. */
export function freshId(store: Store, prefix: string, used: readonly string[]): string {
  const taken = new Set(used);
  let id = store.nextId("_nested", prefix);
  while (taken.has(id)) id = store.nextId("_nested", prefix);
  return id;
}

/** Trims a string, and turns an empty or whitespace-only one into null. */
export function blankToNull(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Throws INVALID unless `iso` is a valid timestamp strictly after `nowIso`. */
export function requireFuture(iso: string, nowIso: string, label: string): void {
  const when = Date.parse(iso);
  const now = Date.parse(nowIso);
  if (Number.isNaN(when)) throw new ActionError("INVALID", `${label} is not a valid timestamp`);
  if (when < now) throw new ActionError("INVALID", `${label} ${iso} is in the past (now is ${nowIso})`);
  if (when === now) throw new ActionError("INVALID", `${label} ${iso} is not in the future (now is ${nowIso})`);
}
