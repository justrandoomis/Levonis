/**
 * node:sqlite with the D1 surface (prepare/bind/run/first/all/batch/exec).
 *
 * A copy of the platform kit's test adapter rather than an import of it: a
 * service's test suite must not depend on another workspace's test directory,
 * which is not part of that package's published surface. Real constraints,
 * real UNIQUE indexes, real "any error rolls the whole batch back" — which is
 * the property every idempotency test in this suite turns on.
 */
import { DatabaseSync } from 'node:sqlite';

type Row = Record<string, unknown>;

export class SqliteStatement {
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
    private readonly params: unknown[] = []
  ) {}

  bind(...values: unknown[]): SqliteStatement {
    return new SqliteStatement(this.db, this.sql, values);
  }

  private args(): never[] {
    return this.params.map((p) => (typeof p === 'boolean' ? (p ? 1 : 0) : p)) as never[];
  }

  async run() {
    const res = this.db.prepare(this.sql).run(...this.args());
    return { success: true, results: [], meta: { changes: Number(res.changes), last_row_id: Number(res.lastInsertRowid), duration: 0 } };
  }

  async first<T = Row>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.args());
    return (row === undefined ? null : ({ ...(row as object) } as T)) as T | null;
  }

  async all<T = Row>() {
    const rows = (this.db.prepare(this.sql).all(...this.args()) as object[]).map((r) => ({ ...r })) as T[];
    return { success: true, results: rows, meta: { changes: 0, duration: 0 } };
  }
}

export class SqliteD1 {
  constructor(readonly raw: DatabaseSync) {}

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.raw, sql);
  }

  async exec(sql: string) {
    this.raw.exec(sql);
    return { count: 1, duration: 0 };
  }

  /** D1 semantics: one transaction; any SQL error rolls the whole batch back. */
  async batch(statements: SqliteStatement[]) {
    this.raw.exec('BEGIN');
    try {
      const out = [];
      for (const s of statements) out.push(await s.run());
      this.raw.exec('COMMIT');
      return out;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    }
  }
}

export function memoryDb(schemaSql = ''): { db: D1Database; raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  if (schemaSql) raw.exec(schemaSql);
  return { db: new SqliteD1(raw) as unknown as D1Database, raw };
}

export const count = (raw: DatabaseSync, sql: string, ...params: unknown[]) => (raw.prepare(sql).get(...(params as never[])) as { n: number }).n;
export const row = <T = Row>(raw: DatabaseSync, sql: string, ...params: unknown[]) => {
  const r = raw.prepare(sql).get(...(params as never[]));
  return (r === undefined ? undefined : { ...(r as object) }) as T | undefined;
};
export const all = <T = Row>(raw: DatabaseSync, sql: string, ...params: unknown[]) =>
  (raw.prepare(sql).all(...(params as never[])) as object[]).map((r) => ({ ...r })) as T[];
