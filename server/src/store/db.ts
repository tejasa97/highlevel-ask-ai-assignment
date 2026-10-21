import { DatabaseSync } from "node:sqlite";

// The mock store: one SQLite table per entity, each row a JSON document.
// - Ids are deterministic per entity (ld_1, ld_2, ...), so a reseed gives the same ids every run.
// - Evals assert final state with SQL, e.g. SELECT count(*) FROM tasks WHERE json_extract(data,'$.assigneeId')='us_3'.
// - `writes` is the idempotency ledger: one row per executed write, keyed executionId:stepId:itemKey.
// - `audit` logs every write action (who, what, which records); timelines and user activity read it.
// - `faults` holds injected failures for tests and scenarios (see registry/invoke.ts).
// - snapshot()/fromSnapshot() copy a whole database in memory, so tests seed once and start from a copy.

export type Doc = { id: string } & Record<string, unknown>;

const NAME = /^[a-z][a-z0-9_]*$/;

export class Store {
  readonly db: DatabaseSync;
  private readonly known = new Set<string>();
  /** Fault uses, kept outside SQLite: a fault fires inside a transaction that it then rolls back. */
  private readonly faultUses = new Map<number, number>();

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _ids (entity TEXT PRIMARY KEY, next INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS writes (key TEXT PRIMARY KEY, action TEXT NOT NULL, result TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, summary TEXT NOT NULL, refs TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS faults (seq INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, match TEXT NOT NULL, code TEXT NOT NULL, message TEXT NOT NULL, remaining INTEGER);
    `);
  }

  /** The whole database as bytes. */
  snapshot(): Uint8Array {
    return this.db.serialize();
  }

  /** A new in-memory store holding a copy of a snapshot. */
  static fromSnapshot(bytes: Uint8Array): Store {
    const store = new Store();
    store.db.deserialize(bytes);
    return store;
  }

  close(): void {
    this.db.close();
  }

  private table(entity: string): string {
    if (!this.known.has(entity)) {
      if (!NAME.test(entity)) throw new Error(`bad entity name: ${entity}`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS ${entity} (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
      this.known.add(entity);
    }
    return entity;
  }

  nextId(entity: string, prefix: string): string {
    const row = this.db
      .prepare("INSERT INTO _ids (entity, next) VALUES (?, 2) ON CONFLICT(entity) DO UPDATE SET next = next + 1 RETURNING next")
      .get(entity) as { next: number };
    return `${prefix}_${row.next - 1}`;
  }

  insert<T extends Record<string, unknown>>(entity: string, prefix: string, doc: T): T & { id: string } {
    const full = { id: this.nextId(entity, prefix), ...doc };
    this.db.prepare(`INSERT INTO ${this.table(entity)} (id, data) VALUES (?, ?)`).run(full.id, JSON.stringify(full));
    return full;
  }

  /** Inserts a document that already has its id. */
  put<T extends { id: string }>(entity: string, doc: T): T {
    this.db.prepare(`INSERT INTO ${this.table(entity)} (id, data) VALUES (?, ?)`).run(doc.id, JSON.stringify(doc));
    return doc;
  }

  /** Entity tables that have been created, in name order. */
  tables(): string[] {
    const rows = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT IN ('writes', 'audit', 'faults', 'sqlite_sequence') ORDER BY name").all() as { name: string }[];
    return rows.map((r) => r.name);
  }

  get<T = Doc>(entity: string, id: string): T | undefined {
    const row = this.db.prepare(`SELECT data FROM ${this.table(entity)} WHERE id = ?`).get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as T) : undefined;
  }

  all<T = Doc>(entity: string): T[] {
    const rows = this.db.prepare(`SELECT data FROM ${this.table(entity)} ORDER BY rowid`).all() as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as T);
  }

  find<T = Doc>(entity: string, pred: (d: T) => boolean): T[] {
    return this.all<T>(entity).filter(pred);
  }

  /** Shallow-merges `patch` into the document and returns the new version. */
  update<T = Doc>(entity: string, id: string, patch: Record<string, unknown>): T {
    const cur = this.get<Record<string, unknown>>(entity, id);
    if (!cur) throw new Error(`${entity} ${id} not found`);
    const next = { ...cur, ...patch, id };
    this.db.prepare(`UPDATE ${this.table(entity)} SET data = ? WHERE id = ?`).run(JSON.stringify(next), id);
    return next as T;
  }

  delete(entity: string, id: string): boolean {
    return this.db.prepare(`DELETE FROM ${this.table(entity)} WHERE id = ?`).run(id).changes > 0;
  }

  /** Runs fn in one transaction; any throw rolls back every write it made. */
  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      // A table first touched in this transaction was rolled back with it; let table() create it again.
      this.known.clear();
      throw err;
    }
  }

  recordedWrite(key: string): unknown | undefined {
    const row = this.db.prepare("SELECT result FROM writes WHERE key = ?").get(key) as { result: string } | undefined;
    return row ? JSON.parse(row.result) : undefined;
  }

  recordWrite(key: string, action: string, result: unknown, at: Date): void {
    this.db.prepare("INSERT INTO writes (key, action, result, at) VALUES (?, ?, ?, ?)").run(key, action, JSON.stringify(result ?? null), at.toISOString());
  }

  logAudit(e: Omit<AuditEntry, "seq">): void {
    this.db.prepare("INSERT INTO audit (at, actor, action, summary, refs) VALUES (?, ?, ?, ?, ?)").run(e.at, e.actor, e.action, e.summary, JSON.stringify(e.refs));
  }

  /** Audit entries, newest first, optionally only those by one actor or touching one record. */
  audit(filter: { actor?: string; ref?: string } = {}): AuditEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM audit WHERE (?1 IS NULL OR actor = ?1) AND (?2 IS NULL OR EXISTS (SELECT 1 FROM json_each(refs) WHERE value = ?2)) ORDER BY at DESC, seq DESC`,
      )
      .all(filter.actor ?? null, filter.ref ?? null) as (Omit<AuditEntry, "refs"> & { refs: string })[];
    return rows.map((r) => ({ ...r, refs: JSON.parse(r.refs) as string[] }));
  }

  addFault(f: Omit<Fault, "seq">): void {
    this.db.prepare("INSERT INTO faults (action, match, code, message, remaining) VALUES (?, ?, ?, ?, ?)").run(f.action, JSON.stringify(f.match), f.code, f.message, f.remaining);
  }

  faults(action: string): Fault[] {
    const rows = this.db.prepare("SELECT * FROM faults WHERE action = ? ORDER BY seq").all(action) as (Omit<Fault, "match"> & { match: string })[];
    return rows
      .map((r) => ({ ...r, match: JSON.parse(r.match) as Record<string, unknown>, remaining: r.remaining === null ? null : r.remaining - (this.faultUses.get(r.seq) ?? 0) }))
      .filter((f) => f.remaining === null || f.remaining > 0);
  }

  consumeFault(seq: number): void {
    this.faultUses.set(seq, (this.faultUses.get(seq) ?? 0) + 1);
  }
}

export interface AuditEntry {
  seq: number;
  at: string;
  /** User id of whoever ran the action. */
  actor: string;
  /** Action id, e.g. M01.A07. */
  action: string;
  summary: string;
  /** Record ids the action read or wrote. */
  refs: string[];
}

/** An injected failure: calls to `action` whose args contain `match` fail with `code`, `remaining` times (null = always). */
export interface Fault {
  seq: number;
  action: string;
  match: Record<string, unknown>;
  code: string;
  message: string;
  remaining: number | null;
}
