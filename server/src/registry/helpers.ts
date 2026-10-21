import type { Candidate } from "./registry.js";

// Small helpers shared by module handlers.

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();

/**
 * Name matching for resolvers: exact (case-insensitive) beats a whole-word match, which beats a prefix.
 * Returns only the best tier, so "Jo" doesn't match "Jo Park" and "Joan Silva" equally when "Jo Park" is exact.
 */
export function matchByName<T>(docs: T[], name: string, label: (d: T) => string): T[] {
  const q = norm(name);
  if (!q) return [];
  const tiers: T[][] = [[], [], []];
  for (const d of docs) {
    const n = norm(label(d));
    if (n === q) tiers[0]!.push(d);
    else if (n.split(" ").includes(q) || q.split(" ").every((w) => n.split(" ").includes(w))) tiers[1]!.push(d);
    else if (n.split(" ").some((w) => w.startsWith(q))) tiers[2]!.push(d);
  }
  return tiers.find((t) => t.length > 0) ?? [];
}

export function candidates<T extends { id: string }>(docs: T[], name: string, label: (d: T) => string, detail?: (d: T) => string): Candidate[] {
  return matchByName(docs, name, label).map((d) => ({ id: d.id, name: label(d), ...(detail ? { detail: detail(d) } : {}) }));
}

/** Inclusive YYYY-MM-DD range check on an ISO timestamp. */
export function inDateRange(iso: string, from?: string, to?: string): boolean {
  const day = iso.slice(0, 10);
  return (!from || day >= from) && (!to || day <= to);
}

export function contains(hay: unknown, needle: string): boolean {
  return typeof hay === "string" && hay.toLowerCase().includes(needle.toLowerCase());
}
