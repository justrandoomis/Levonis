/**
 * (Copied from the e2e review probes, scratchpad/review-e2e/limits.ts.)
 *
 * A D1 adapter over the repo's SqliteD1 that ENFORCES the live limits the local
 * engine does not: > 100 bound parameters, > 5 compound-SELECT terms in one
 * compound chain (approximated per statement: UNION/INTERSECT/EXCEPT tokens + 1
 * outside string literals). Violations throw like D1 would AND are recorded.
 */
import type { DatabaseSync } from 'node:sqlite';
import { SqliteD1, SqliteStatement } from './d1';

export const violations: string[] = [];
export let maxParams = 0;
export let maxTerms = 0;

function compoundTerms(sql: string): number {
  const s = sql.replace(/--[^\n]*/g, '').replace(/'(?:[^']|'')*'/g, "''");
  return (s.match(/\b(UNION|INTERSECT|EXCEPT)\b/gi) ?? []).length + 1;
}
function paramCount(sql: string, values: unknown[]): number {
  let maxIdx = 0;
  for (const m of sql.matchAll(/\?(\d+)/g)) maxIdx = Math.max(maxIdx, Number(m[1]));
  return Math.max(maxIdx, values.length);
}

class LimitStatement {
  constructor(private readonly inner: SqliteStatement, private readonly sql: string, private readonly values: unknown[] = []) {}
  bind(...values: unknown[]) {
    const n = paramCount(this.sql, values);
    maxParams = Math.max(maxParams, n);
    if (n > 100) {
      const msg = `D1_LIMIT too many SQL variables (${n}) :: ${this.sql.replace(/\s+/g, ' ').slice(0, 140)}`;
      violations.push(msg);
      throw new Error(msg);
    }
    return new LimitStatement(this.inner.bind(...values), this.sql, values);
  }
  run() { return this.inner.run(); }
  first<T = Record<string, unknown>>() { return this.inner.first<T>(); }
  all<T = Record<string, unknown>>() { return this.inner.all<T>(); }
  get raw() { return this.inner; }
}

export class LimitD1 {
  private readonly inner: SqliteD1;
  constructor(raw: DatabaseSync) { this.inner = new SqliteD1(raw); }
  prepare(sql: string) {
    const t = compoundTerms(sql);
    maxTerms = Math.max(maxTerms, t);
    if (t > 5) {
      const msg = `D1_LIMIT too many terms in compound SELECT (${t}) :: ${sql.replace(/\s+/g, ' ').slice(0, 140)}`;
      violations.push(msg);
      throw new Error(msg);
    }
    return new LimitStatement(this.inner.prepare(sql), sql);
  }
  async batch(statements: LimitStatement[]) {
    return this.inner.batch(statements.map((s) => s.raw));
  }
}
export const limitD1 = (raw: DatabaseSync) => new LimitD1(raw) as unknown as D1Database;
