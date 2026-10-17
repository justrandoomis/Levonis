/**
 * (Copied from the e2e review probes, scratchpad/review-e2e/limits.ts.)
 *
 * A D1 adapter over the repo's SqliteD1 that ENFORCES the live limits the local
 * engines do not (developers.cloudflare.com/d1/platform/limits; node:sqlite
 * allows 1000 function arguments and workerd's local D1 127):
 *
 *   > 100 bound parameters a statement;
 *   > 100,000 bytes of SQL a statement;
 *   > 32 arguments to one SQL function call (`json_array(a, b, …)`), counted
 *     on the SQL text: a name written against its `(` is a call, outside
 *     strings, quoted names and comments (not VALUES, IN, a table after INTO);
 *   > 5 compound-SELECT terms in one compound chain (approximated per
 *     statement: UNION/INTERSECT/EXCEPT tokens + 1 outside string literals).
 *
 * Violations throw like D1 would AND are recorded. `limitD1(raw, batches)`
 * also records the shape of every statement of every batch it runs.
 */
import type { DatabaseSync } from 'node:sqlite';
import { SqliteD1, SqliteStatement } from './d1';

/** D1's per-statement limits; a batch's limits are each of its statements' (and the invocation's 1,000). */
export const D1_LIMITS = Object.freeze({ params: 100, sqlBytes: 100_000, functionArgs: 32, compoundTerms: 5 });

export const violations: string[] = [];
export let maxParams = 0;
export let maxTerms = 0;
export let maxFunctionArgsSeen = 0;

/** What D1's limits read of one statement. */
export interface StatementShape {
  sql: string;
  params: number;
  bytes: number;
  functionArgs: number;
  terms: number;
}

function compoundTerms(sql: string): number {
  const s = sql.replace(/--[^\n]*/g, '').replace(/'(?:[^']|'')*'/g, "''");
  return (s.match(/\b(UNION|INTERSECT|EXCEPT)\b/gi) ?? []).length + 1;
}
function paramCount(sql: string, values: unknown[]): number {
  let maxIdx = 0;
  for (const m of sql.matchAll(/\?(\d+)/g)) maxIdx = Math.max(maxIdx, Number(m[1]));
  return Math.max(maxIdx, values.length);
}

/** Parenthesised lists that are not function calls, when written against their `(`. */
const NOT_CALLS = new Set(['IN', 'VALUES', 'EXISTS', 'AS', 'USING', 'ON', 'AND', 'OR', 'NOT', 'WHEN', 'THEN', 'ELSE', 'SELECT', 'FROM', 'WHERE', 'IS', 'BY', 'KEY', 'CHECK', 'CONFLICT']);

/** The most arguments any one SQL function call in `sql` takes. */
export function maxFunctionArgs(sql: string): number {
  // One pass: strings, quoted names and comments become blanks (their parentheses and commas are not SQL).
  let s = '';
  for (let i = 0; i < sql.length; ) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === c && sql[j + 1] !== c)) j += sql[j] === c ? 2 : 1;
      s += c === "'" ? "''" : 'q';
      i = j + 1;
    } else if (c === '-' && sql[i + 1] === '-') {
      const j = sql.indexOf('\n', i);
      i = j < 0 ? sql.length : j;
    } else if (c === '/' && sql[i + 1] === '*') {
      const j = sql.indexOf('*/', i + 2);
      s += ' ';
      i = j < 0 ? sql.length : j + 2;
    } else {
      s += c;
      i++;
    }
  }
  const stack: Array<{ call: boolean; commas: number; empty: boolean }> = [];
  let max = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') {
      const name = /([A-Za-z_][A-Za-z0-9_]*)$/.exec(s.slice(Math.max(0, i - 80), i))?.[1];
      const before = name ? s.slice(0, i - name.length).trimEnd() : '';
      stack.push({ call: !!name && !NOT_CALLS.has(name.toUpperCase()) && !/\b(INTO|TABLE)$/i.test(before), commas: 0, empty: true });
    } else if (c === ')') {
      const f = stack.pop();
      if (f?.call) max = Math.max(max, f.empty ? 0 : f.commas + 1);
    } else if (stack.length) {
      const f = stack[stack.length - 1];
      if (c === ',') f.commas++;
      else if (!/\s/.test(c)) f.empty = false;
    }
  }
  return max;
}

export function statementShape(sql: string, values: unknown[] = []): StatementShape {
  return { sql, params: paramCount(sql, values), bytes: Buffer.byteLength(sql, 'utf8'), functionArgs: maxFunctionArgs(sql), terms: compoundTerms(sql) };
}

function refuse(msg: string, sql: string): never {
  const m = `${msg} :: ${sql.replace(/\s+/g, ' ').slice(0, 140)}`;
  violations.push(m);
  throw new Error(m);
}

class LimitStatement {
  constructor(private readonly inner: SqliteStatement, private readonly sql: string, private readonly values: unknown[] = []) {}
  bind(...values: unknown[]) {
    const n = paramCount(this.sql, values);
    maxParams = Math.max(maxParams, n);
    if (n > D1_LIMITS.params) refuse(`D1_LIMIT too many SQL variables (${n})`, this.sql);
    return new LimitStatement(this.inner.bind(...values), this.sql, values);
  }
  run() { return this.inner.run(); }
  first<T = Record<string, unknown>>() { return this.inner.first<T>(); }
  all<T = Record<string, unknown>>() { return this.inner.all<T>(); }
  get raw() { return this.inner; }
  get shape(): StatementShape { return statementShape(this.sql, this.values); }
}

export class LimitD1 {
  private readonly inner: SqliteD1;
  constructor(raw: DatabaseSync, private readonly batches?: StatementShape[][]) { this.inner = new SqliteD1(raw); }
  prepare(sql: string) {
    const t = compoundTerms(sql);
    maxTerms = Math.max(maxTerms, t);
    if (t > D1_LIMITS.compoundTerms) refuse(`D1_LIMIT too many terms in compound SELECT (${t})`, sql);
    const bytes = Buffer.byteLength(sql, 'utf8');
    if (bytes > D1_LIMITS.sqlBytes) refuse(`D1_LIMIT statement too long (${bytes} bytes)`, sql);
    const args = maxFunctionArgs(sql);
    maxFunctionArgsSeen = Math.max(maxFunctionArgsSeen, args);
    if (args > D1_LIMITS.functionArgs) refuse(`D1_LIMIT too many arguments on a function (${args})`, sql);
    return new LimitStatement(this.inner.prepare(sql), sql);
  }
  async batch(statements: LimitStatement[]) {
    this.batches?.push(statements.map((s) => s.shape));
    return this.inner.batch(statements.map((s) => s.raw));
  }
}
export const limitD1 = (raw: DatabaseSync, batches?: StatementShape[][]) => new LimitD1(raw, batches) as unknown as D1Database;
