import type { Store } from "../store/db.js";

// Before/after picture of the data for the debug view: what one turn inserted, changed or deleted.

export type Snapshot = Map<string, Map<string, string>>;

export interface Change {
  table: string;
  id: string;
  op: "insert" | "update" | "delete";
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  /** For updates: the top-level fields that changed. */
  fields?: string[];
}

export function snapshot(store: Store): Snapshot {
  return new Map(store.tables().map((t) => [t, new Map(store.all<{ id: string }>(t).map((d) => [d.id, JSON.stringify(d)]))]));
}

export function diff(before: Snapshot, store: Store): Change[] {
  const out: Change[] = [];
  for (const table of store.tables()) {
    const old = before.get(table) ?? new Map<string, string>();
    const seen = new Set<string>();
    for (const doc of store.all<Record<string, unknown> & { id: string }>(table)) {
      seen.add(doc.id);
      const prev = old.get(doc.id);
      if (prev === undefined) out.push({ table, id: doc.id, op: "insert", after: doc });
      else if (prev !== JSON.stringify(doc)) {
        const b = JSON.parse(prev) as Record<string, unknown>;
        const fields = [...new Set([...Object.keys(b), ...Object.keys(doc)])].filter((k) => JSON.stringify(b[k]) !== JSON.stringify(doc[k]));
        out.push({ table, id: doc.id, op: "update", before: b, after: doc, fields });
      }
    }
    for (const [id, prev] of old) if (!seen.has(id)) out.push({ table, id, op: "delete", before: JSON.parse(prev) });
  }
  return out;
}
