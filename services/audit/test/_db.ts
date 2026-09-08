/**
 * `node:sqlite` behind the D1 surface, plus the service's REAL migration.
 *
 * The schema under test is `migrations/0001_audit_init.sql` read from disk, not
 * a hand-written copy: a test that passes against a schema the deploy never
 * applies proves nothing. `batch()` is a transaction with the same
 * all-or-nothing semantics D1 gives, which is what makes the chain fence
 * testable at all.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVICE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const migrationSql = (file = '0001_audit_init.sql'): string => readFileSync(join(SERVICE_ROOT, 'migrations', file), 'utf8');

type Row = Record<string, unknown>;

class SqliteStatement {
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

class SqliteD1 {
  constructor(readonly raw: DatabaseSync) {}

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.raw, sql);
  }

  async exec(sql: string) {
    this.raw.exec(sql);
    return { count: 1, duration: 0 };
  }

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

/** A fresh in-memory store with the service's migration applied. */
export function auditDb(): { db: D1Database; raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  raw.exec(migrationSql());
  return { db: new SqliteD1(raw) as unknown as D1Database, raw };
}

export const count = (raw: DatabaseSync, sql: string, ...params: unknown[]) => Number((raw.prepare(sql).get(...(params as never[])) as { n: number }).n);
export const rows = <T = Row>(raw: DatabaseSync, sql: string, ...params: unknown[]) =>
  (raw.prepare(sql).all(...(params as never[])) as object[]).map((r) => ({ ...r })) as T[];
export const one = <T = Row>(raw: DatabaseSync, sql: string, ...params: unknown[]) => {
  const r = raw.prepare(sql).get(...(params as never[]));
  return (r === undefined ? undefined : { ...(r as object) }) as T | undefined;
};
