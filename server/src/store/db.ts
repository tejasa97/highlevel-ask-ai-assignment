import { DatabaseSync } from "node:sqlite";

// The mock store: one SQLite table per entity, each row a JSON document.
// - Ids are deterministic per entity (ld_1, ld_2, ...), so a reseed gives the same ids every run.
// - Evals assert final state with SQL, e.g. SELECT count(*) FROM tasks WHERE json_extract(data,'$.assigneeId')='us_3'.
// - `writes` is the idempotency ledger: one row per executed write, keyed executionId:stepId:itemKey.

export type Doc = { id: string } & Record<string, unknown>;

const NAME = /^[a-z][a-z0-9_]*$/;

export class Store {
  readonly db: DatabaseSync;
  private readonly known = new Set<string>();

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _ids (entity TEXT PRIMARY KEY, next INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS writes (key TEXT PRIMARY KEY, action TEXT NOT NULL, result TEXT NOT NULL, at TEXT NOT NULL);
    `);
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
}
