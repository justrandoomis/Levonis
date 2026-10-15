/**
 * IS TRADE-IN V2 ON THIS DATABASE? (Services S-P2, migration 0192, DECISIONS row 238)
 *
 * Code can run ahead of its migrations (CLAUDE.md rule 2: a manual redeploy of
 * an older commit's database, or the minutes before workflow 7's migration
 * step). The v2 doors — intake, the device hand-back, the owner's valuation,
 * policy, references and P&L, the product-page entry and the services summary —
 * read columns and tables 0192 adds. Without them:
 *
 *   - every EXISTING door behaves exactly as it did before S-P2 (the v1 flow);
 *   - every NEW door answers 503 `TRADE_IN_V2_NOT_INSTALLED` (ar/en/ckb on the
 *     client), never a 500.
 *
 * The probe is two statements, asked once per database binding while unknown:
 * "present" is remembered for good (a migration lands and never un-lands), an
 * "absent" answer is asked again after a minute — the listing.ts shape.
 */
import { HttpError } from './http';

const PRESENT = new WeakMap<object, true>();
const ASKING = new WeakMap<object, Promise<boolean>>();
const ABSENT_UNTIL = new WeakMap<object, number>();
const ABSENT_RECHECK_MS = 60_000;

const isMissing = (e: unknown) => /no such (table|column)/i.test(e instanceof Error ? e.message : String(e));

/** 0192 is applied: the request columns and the provenance table exist. */
export function tradeInV2Installed(db: D1Database): Promise<boolean> {
  if (PRESENT.has(db)) return Promise.resolve(true);
  if ((ABSENT_UNTIL.get(db) ?? 0) > Date.now()) return Promise.resolve(false);
  const asking = ASKING.get(db);
  if (asking) return asking;
  const probe = (async () => {
    try {
      await db.prepare('SELECT intake_at, valuation_version FROM trade_in_requests LIMIT 0').all();
      await db.prepare('SELECT 1 FROM trade_in_stock LIMIT 0').all();
      PRESENT.set(db, true);
      return true;
    } catch (e) {
      if (!isMissing(e)) throw e;
      ABSENT_UNTIL.set(db, Date.now() + ABSENT_RECHECK_MS);
      return false;
    }
  })().finally(() => ASKING.delete(db));
  ASKING.set(db, probe);
  return probe;
}

/** Tests only: forget what a binding answered (a test migrates the same database in place). */
export function forgetTradeInV2(db: D1Database): void {
  PRESENT.delete(db);
  ABSENT_UNTIL.delete(db);
}

export const TRADE_IN_V2_NOT_INSTALLED = 'TRADE_IN_V2_NOT_INSTALLED';

/** The new doors' answer on a database without 0192. */
export async function requireTradeInV2(db: D1Database): Promise<void> {
  if (!(await tradeInV2Installed(db))) {
    throw new HttpError(503, 'The trade-in service is being updated. Try again shortly.', TRADE_IN_V2_NOT_INSTALLED);
  }
}
