/**
 * A thin adapter that gives node:sqlite the D1 surface (prepare/bind/run/
 * first/all/batch, batch in ONE transaction, meta.changes from the driver).
 *
 * Tests built on it are not mock tests: real CHECK constraints, real UNIQUE
 * indexes, real conditional-UPDATE guards and real "0 rows updated aborts the
 * dependent writes" behaviour all execute. What it cannot prove is D1's own
 * concurrency behaviour on Cloudflare's storage — races here are simulated by
 * interleaving operations in one process.
 */
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

type Row = Record<string, unknown>;

export class SqliteStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly params: unknown[] = []
  ) {}

  bind(...values: unknown[]): SqliteStatement {
    return new SqliteStatement(this.db, this.sql, values);
  }

  private args(): never[] {
    return this.params as never[];
  }

  async run() {
    const res = this.db.prepare(this.sql).run(...this.args());
    return {
      success: true,
      results: [],
      meta: { changes: Number(res.changes), last_row_id: Number(res.lastInsertRowid), duration: 0 },
    };
  }

  async first<T = Row>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.args());
    return (row === undefined ? null : (row as T)) as T | null;
  }

  async all<T = Row>() {
    const rows = this.db.prepare(this.sql).all(...this.args()) as T[];
    return { success: true, results: rows, meta: { changes: 0, duration: 0 } };
  }
}

export class SqliteD1 {
  constructor(private readonly db: DatabaseSync) {}

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.db, sql);
  }

  /** D1 semantics: one transaction; any SQL error rolls the whole batch back. */
  async batch(statements: SqliteStatement[]) {
    this.db.exec('BEGIN');
    try {
      const out = [];
      for (const s of statements) out.push(await s.run());
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
}


/** Lifts one CREATE TABLE block out of a migration file, verbatim, so tests
 *  run against the real schema instead of a hand-written copy of it. */
export function createTableSql(file: string, table: string): string {
  const src = readFileSync(join(ROOT, 'migrations', file), 'utf8');
  const start = src.indexOf(`CREATE TABLE ${table} (`);
  assert.ok(start >= 0, `${table} not found in ${file}`);
  const end = src.indexOf('\n);', start);
  assert.ok(end > start, `${table} block not terminated in ${file}`);
  return `${src.slice(start, end)}\n);`;
}

/** Lifts a CREATE TABLE ... IF NOT EXISTS block (migration 0018 style). */
export function createTableIfNotExistsSql(file: string, table: string): string {
  const src = readFileSync(join(ROOT, 'migrations', file), 'utf8');
  const marker = `CREATE TABLE IF NOT EXISTS ${table} (`;
  const start = src.indexOf(marker);
  assert.ok(start >= 0, `${table} not found in ${file}`);
  const end = src.indexOf('\n);', start);
  assert.ok(end > start, `${table} block not terminated in ${file}`);
  return `${src.slice(start, end)}\n);`;
}

export function newSqlite(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}
