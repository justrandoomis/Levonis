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
 * wrappers; `batch` unwraps them before the real binding sees them. It is
 * registered as a view of the binding (d1Count.ts `registerD1View`), so the
 * event bus treats it as the binding it wraps.
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

/**
 * D1 refuses a call of any SQL function with more than 32 arguments ("too many arguments on function …"). Neither
 * workerd's local D1 (127) nor node:sqlite (1000) enforces it: tests/fixtures/d1Limits.ts `LimitD1` does.
 */
export const D1_FUNCTION_ARGS_MAX = 32;

/**
 * The counting view itself lives in worker/lib/invocationCounter.ts, a neutral module the owner's estimator
 * shares (docs/SMART_PRICING.md §4.8) without importing the import's code; re-exported here unchanged.
 */
export { countingD1, type CountedD1, type InvocationCounter } from '../invocationCounter';

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
