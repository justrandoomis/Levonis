/**
 * THE IMPORT'S STATEMENT BUDGET (Bambu import spec §A.5, §A.6;
 * owner-questions §E.4).
 *
 * D1 allows 1,000 queries per Worker invocation, a batch counting each of its
 * statements (`D1_INVOCATION_STATEMENT_LIMIT`, worker/lib/quarterHourBudget.ts).
 * One `/write` is one invocation, so what it may spend is counted over the
 * WHOLE invocation, not over the batch alone:
 *
 *   reads so far (auth, rate limit, lease, reviewed checks, preflight,
 *                 media verification, planner reads)
 *   + the batch's length
 *   + the post-commit estimate (audit rows, the media queue, the digest row)
 *   ≤ IMPORT_INVOCATION_LIMIT = 1,000 − IMPORT_RESERVE (100) = 900
 *
 * Over it the item goes BLOCKED `PLAN_TOO_LARGE` before anything is written.
 *
 * `countingD1` is the counting view the ops router puts in front of
 * `c.env.DB` (and the writer, when called without one): every `first`, `all`,
 * `run` and `raw` of a statement prepared through it counts one, a `batch`
 * counts its length, an `exec` one. The statements it hands out are its own
 * wrappers; `batch` unwraps them before the real binding sees them.
 *
 * `packedInserts` is how the writer keeps the side tables inside that budget
 * (owner-questions §E.4: one statement per side row put `pla-basic-filament`
 * at ~906): rows of ONE shape as multi-row `INSERT … VALUES (…), (…)`, at most
 * `IMPORT_PACKED_PARAMS_MAX` bound parameters a statement — D1 refuses more
 * than 100 (tests/fixtures/d1Limits.ts `LimitD1` enforces it, and a multi-row
 * VALUES list is not a compound SELECT there or in SQLite ≥ 3.8.8). Per-row
 * triggers fire per row, exactly as with one statement each.
 */
import { D1_INVOCATION_STATEMENT_LIMIT } from '../quarterHourBudget';

/** Kept free under D1's 1,000 for anything a counter could miss. */
export const IMPORT_RESERVE = 100;

/** What one import invocation may spend in all (§A.5). */
export const IMPORT_INVOCATION_LIMIT = D1_INVOCATION_STATEMENT_LIMIT - IMPORT_RESERVE;

/** D1 binds at most 100 parameters a statement; a packed insert stays at or under this. */
export const IMPORT_PACKED_PARAMS_MAX = 100;

/** How many statements an invocation has sent so far. */
export interface InvocationCounter {
  readonly count: number;
  /** Charges statements sent outside the counted binding (none in this codebase; kept for callers). */
  charge(n: number): void;
}

export interface CountedD1 {
  db: D1Database;
  counter: InvocationCounter;
}

type AnyStatement = D1PreparedStatement & Record<string, unknown>;

/**
 * Wraps a D1 binding so every statement it sends is counted. The wrapper is a
 * Proxy: every other member of the binding passes through untouched.
 */
export function countingD1(inner: D1Database): CountedD1 {
  let n = 0;
  const counter: InvocationCounter = {
    get count() {
      return n;
    },
    charge(k: number) {
      n += Math.max(0, Math.trunc(k));
    },
  };
  const innerOf = new WeakMap<object, D1PreparedStatement>();
  const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(stmt as AnyStatement, {
      get(target, key, receiver) {
        if (key === 'bind') {
          return (...values: unknown[]) => wrap((target.bind as (...v: unknown[]) => D1PreparedStatement)(...values));
        }
        if (key === 'first' || key === 'all' || key === 'run' || key === 'raw') {
          const fn = Reflect.get(target, key, receiver);
          // A test double may expose `raw` as a property (tests/fixtures/d1Limits.ts); only a call is a statement.
          if (typeof fn !== 'function') return fn;
          return (...args: unknown[]) => {
            n += 1;
            return (fn as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        const v = Reflect.get(target, key, receiver);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    innerOf.set(proxy, stmt);
    return proxy as D1PreparedStatement;
  };
  const db = new Proxy(inner as D1Database & Record<string, unknown>, {
    get(target, key, receiver) {
      if (key === 'prepare') {
        return (sql: string) => wrap(target.prepare(sql));
      }
      if (key === 'batch') {
        return (statements: D1PreparedStatement[]) => {
          n += statements.length;
          return target.batch(statements.map((s) => innerOf.get(s as object) ?? s));
        };
      }
      if (key === 'exec') {
        return (sql: string) => {
          n += 1;
          return target.exec(sql);
        };
      }
      const v = Reflect.get(target, key, receiver);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  return { db: db as D1Database, counter };
}

/**
 * Rows of ONE shape as multi-row INSERTs. `head` is everything before
 * `VALUES` (`INSERT INTO t (a, b, c)`), `row` the placeholder tuple of one row
 * (`(?, ?, ?)`), `tail` what follows the VALUES list (an `ON CONFLICT` clause).
 * Each statement binds at most `maxParams` values; a row wider than that is a
 * programming error and throws.
 */
export function packedInserts(
  db: D1Database,
  head: string,
  row: string,
  rows: readonly unknown[][],
  tail = '',
  maxParams = IMPORT_PACKED_PARAMS_MAX
): D1PreparedStatement[] {
  if (!rows.length) return [];
  const width = (row.match(/\?/g) ?? []).length;
  if (width === 0 || rows.some((r) => r.length !== width)) throw new Error(`packedInserts: ${width} placeholders for rows of another width`);
  if (width > maxParams) throw new Error(`packedInserts: one row binds ${width} values, over ${maxParams}`);
  const per = Math.max(1, Math.floor(maxParams / width));
  const out: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per);
    out.push(db.prepare(`${head} VALUES ${chunk.map(() => row).join(', ')}${tail ? ` ${tail}` : ''}`).bind(...chunk.flat()));
  }
  return out;
}

/** The statement count `packedInserts` produces for `rows` rows of `width` values. */
export function packedStatementCount(rows: number, width: number, maxParams = IMPORT_PACKED_PARAMS_MAX): number {
  if (rows <= 0) return 0;
  return Math.ceil(rows / Math.max(1, Math.floor(maxParams / width)));
}
