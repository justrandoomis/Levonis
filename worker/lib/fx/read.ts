/**
 * THE OWNER'S RATES READ MODEL (FX programme plan §8 `GET /rates`, `GET
 * /rates/history`). Explicit column lists only; every table here is private.
 * Null on a database without migration 0179 (the route answers 503
 * PRICING_NOT_INSTALLED).
 */
import { rateLimitKey } from '../ratelimit';
import { loadProcurementReference } from '../pricingEngine/load';
import { isMissingTable, loadPairs, type FxPairId } from './pairs';
import { LOG_COLUMNS, type FxLogRow, type RatesReadModel } from './dto';
import { FX_REFRESH_GLOBAL_BUCKET, FX_REFRESH_GLOBAL_KEY, FX_REFRESH_GLOBAL_WINDOW_S } from './limits';

/** How many engine-priced products exist (FX-2 creates the table; before it, 0). */
export async function engineProductCount(db: D1Database): Promise<number> {
  try {
    const row = await db.prepare("SELECT COUNT(*) AS n FROM product_pricing_state WHERE mode = 'engine'").first<{ n: number }>();
    return Number(row?.n ?? 0);
  } catch {
    return 0;
  }
}

export async function loadRatesReadModel(db: D1Database, now: Date): Promise<RatesReadModel | null> {
  const pairs = await loadPairs(db);
  if (pairs === null) return null;
  const window = Math.floor(now.getTime() / 1000);
  const windowStart = window - (window % FX_REFRESH_GLOBAL_WINDOW_S);
  const [derived, shipping, observedRows, used, reference, engineProducts] = await Promise.all([
    db
      .prepare("SELECT currency, rate_iqd, version, updated_at FROM pricing_fx_rates ORDER BY CASE currency WHEN 'USD' THEN 0 WHEN 'EUR' THEN 1 ELSE 2 END")
      .all<RatesReadModel['derived'][number]>(),
    db
      .prepare("SELECT profile, basis, rate_iqd, version, updated_at FROM pricing_shipping_rates ORDER BY CASE profile WHEN 'GERMANY_LAND' THEN 0 WHEN 'CHINA_AIR' THEN 1 ELSE 2 END")
      .all<RatesReadModel['shipping'][number]>(),
    // L14: the newest observation of each MANUAL pair (one indexed read).
    db
      .prepare(
        `SELECT ${LOG_COLUMNS} FROM fx_rate_log l
          WHERE l.event = 'observed' AND l.pending_rate IS NOT NULL
            AND l.created_at = (SELECT MAX(created_at) FROM fx_rate_log m WHERE m.pair = l.pair AND m.event = 'observed' AND m.pending_rate IS NOT NULL)`
      )
      .all<FxLogRow>(),
    db
      .prepare('SELECT count FROM rate_limits WHERE key = ? AND window_start = ?')
      .bind(rateLimitKey(FX_REFRESH_GLOBAL_BUCKET, null, '', FX_REFRESH_GLOBAL_KEY), windowStart)
      .first<{ count: number }>()
      .catch(() => null),
    loadProcurementReference(db),
    engineProductCount(db),
  ]);
  const observed = new Map<FxPairId, FxLogRow>();
  for (const r of observedRows.results ?? []) observed.set(r.pair, { ...r });
  return {
    pairs,
    observed,
    derived: (derived.results ?? []).map((r) => ({ ...r })),
    shipping: (shipping.results ?? []).map((r) => ({ ...r })),
    // The purchase screens' rate, offered as a one-tap suggestion — never seeded (§4.1 part 4).
    procurementShipping: {
      GERMANY_LAND: reference.shipping.GERMANY_LAND.rate,
      CHINA_AIR: reference.shipping.CHINA_AIR.rate,
      CHINA_SEA: reference.shipping.CHINA_SEA.rate,
    },
    refreshUsedToday: Number(used?.count ?? 0),
    engineProducts,
  };
}

export interface HistoryQuery {
  pair: FxPairId | null;
  before: string | null;
  limit: number;
}

/** The private history, newest first, paged by `created_at` (at most 100 a page). */
export async function loadHistory(db: D1Database, q: HistoryQuery): Promise<FxLogRow[] | null> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (q.pair) {
    where.push('pair = ?');
    binds.push(q.pair);
  }
  if (q.before) {
    where.push('created_at < ?');
    binds.push(q.before);
  }
  try {
    const { results } = await db
      .prepare(`SELECT ${LOG_COLUMNS} FROM fx_rate_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .bind(...binds, q.limit)
      .all<FxLogRow>();
    return (results ?? []).map((r) => ({ ...r }));
  } catch (e) {
    if (isMissingTable(e)) return null;
    throw e;
  }
}
