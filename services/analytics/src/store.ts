/**
 * Every statement Analytics runs. Three writes (the event row, the two rollup
 * upserts), one delete (the retention roll), and the reads the two read models
 * need.
 *
 * The rollup upserts are `ON CONFLICT … DO UPDATE SET value = value + excluded.value`
 * — an ADDITION, which is only correct because it rides in the same batch as
 * the `analytics_processed_events` row: a redelivery aborts the batch and adds
 * nothing (`01-TARGET.md` §9.2, "idempotently by `processed_events`").
 */
import type { DailyMerchantPoint, DailyPlatformPoint } from '@levonis/contracts/http/analytics';
import type { MetricPoint } from './metrics';
import type { Projection } from './projection';

export function insertEventStatement(db: D1Database, p: Projection, ingestedAt: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO analytics_events
         (event_id, event_type, version, day, occurred_at, ingested_at, source_service, aggregate_type, aggregate_id, aggregate_seq, correlation_id, actor_hash, merchant_id, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      p.event_id,
      p.event_type,
      p.version,
      p.day,
      p.occurred_at,
      ingestedAt,
      p.source_service,
      p.aggregate_type,
      p.aggregate_id,
      p.aggregate_seq,
      p.correlation_id,
      p.actor_hash,
      p.merchant_id,
      JSON.stringify(p.payload)
    );
}

export function addPlatformStatement(db: D1Database, day: string, metric: string, value: number, at: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO analytics_daily_platform (day, metric, value, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(day, metric) DO UPDATE SET value = value + excluded.value, updated_at = excluded.updated_at`
    )
    .bind(day, metric, Math.trunc(value), at);
}

export function addMerchantStatement(
  db: D1Database,
  day: string,
  merchantId: string,
  metric: string,
  value: number,
  at: string
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO analytics_daily_merchant (day, merchant_id, metric, value, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(day, merchant_id, metric) DO UPDATE SET value = value + excluded.value, updated_at = excluded.updated_at`
    )
    .bind(day, merchantId, metric, Math.trunc(value), at);
}

/** The repair pass REPLACES rather than adds: it recomputed the whole day. */
export function setPlatformStatement(db: D1Database, day: string, metric: string, value: number, at: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO analytics_daily_platform (day, metric, value, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(day, metric) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(day, metric, Math.trunc(value), at);
}

export function setMerchantStatement(
  db: D1Database,
  day: string,
  merchantId: string,
  metric: string,
  value: number,
  at: string
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO analytics_daily_merchant (day, merchant_id, metric, value, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(day, merchant_id, metric) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(day, merchantId, metric, Math.trunc(value), at);
}

/** The statements one event contributes to the rollups. */
export function rollupStatements(db: D1Database, day: string, points: MetricPoint[], at: string): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [];
  for (const point of points) {
    out.push(addPlatformStatement(db, day, point.metric, point.value, at));
    if (point.merchant_id) out.push(addMerchantStatement(db, day, point.merchant_id, point.metric, point.value, at));
  }
  return out;
}

export interface RawRow {
  event_id: string;
  event_type: string;
  version: number;
  merchant_id: string | null;
  payload: string;
}

/** One page of a day's raw rows, for the repair pass. */
export async function rawRowsForDay(db: D1Database, day: string, afterId: string, limit: number): Promise<RawRow[]> {
  const { results } = await db
    .prepare('SELECT event_id, event_type, version, merchant_id, payload FROM analytics_events WHERE day = ? AND event_id > ? ORDER BY event_id LIMIT ?')
    .bind(day, afterId, limit)
    .all<RawRow>();
  return results ?? [];
}

export async function countForDay(db: D1Database, day: string): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM analytics_events WHERE day = ?').bind(day).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** The retention roll (`03-EVENTS.md` §5 rule 6: raw events roll 30 days, rollups do not). */
export function pruneRawStatement(db: D1Database, beforeDay: string): D1PreparedStatement {
  return db.prepare('DELETE FROM analytics_events WHERE day < ?').bind(beforeDay);
}

export interface DayRange {
  from?: string;
  to?: string;
}

/** Sums per metric over a day range — what `overview()` reads. */
export async function platformTotals(db: D1Database, range: DayRange): Promise<Record<string, number>> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (range.from) {
    where.push('day >= ?');
    params.push(range.from);
  }
  if (range.to) {
    where.push('day <= ?');
    params.push(range.to);
  }
  const sql = `SELECT metric, SUM(value) AS total FROM analytics_daily_platform${where.length ? ` WHERE ${where.join(' AND ')}` : ''} GROUP BY metric`;
  const { results } = await db
    .prepare(sql)
    .bind(...params)
    .all<{ metric: string; total: number }>();
  const out: Record<string, number> = {};
  for (const r of results ?? []) out[String(r.metric)] = Number(r.total ?? 0);
  return out;
}

export const DAILY_POINTS_MAX = 2000;

/** The platform series behind `GET /api/v1/analytics/admin/daily`. */
export async function platformDaily(db: D1Database, opts: DayRange & { metric?: string; limit?: number }): Promise<DailyPlatformPoint[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.metric) {
    where.push('metric = ?');
    params.push(opts.metric);
  }
  if (opts.from) {
    where.push('day >= ?');
    params.push(opts.from);
  }
  if (opts.to) {
    where.push('day <= ?');
    params.push(opts.to);
  }
  const sql = `SELECT day, metric, value FROM analytics_daily_platform${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY day, metric LIMIT ?`;
  const { results } = await db
    .prepare(sql)
    .bind(...params, Math.min(opts.limit ?? DAILY_POINTS_MAX, DAILY_POINTS_MAX))
    .all<{ day: string; metric: string; value: number }>();
  return (results ?? []).map((r) => ({ day: String(r.day), metric: String(r.metric), value: Number(r.value ?? 0) }));
}

/** One merchant's series — never more than one merchant per call. */
export async function merchantDaily(
  db: D1Database,
  merchantId: string,
  opts: DayRange & { metric?: string; limit?: number }
): Promise<DailyMerchantPoint[]> {
  const where = ['merchant_id = ?'];
  const params: unknown[] = [merchantId];
  if (opts.metric) {
    where.push('metric = ?');
    params.push(opts.metric);
  }
  if (opts.from) {
    where.push('day >= ?');
    params.push(opts.from);
  }
  if (opts.to) {
    where.push('day <= ?');
    params.push(opts.to);
  }
  const sql = `SELECT day, merchant_id, metric, value FROM analytics_daily_merchant WHERE ${where.join(' AND ')} ORDER BY day, metric LIMIT ?`;
  const { results } = await db
    .prepare(sql)
    .bind(...params, Math.min(opts.limit ?? DAILY_POINTS_MAX, DAILY_POINTS_MAX))
    .all<{ day: string; merchant_id: string; metric: string; value: number }>();
  return (results ?? []).map((r) => ({
    day: String(r.day),
    merchant_id: String(r.merchant_id),
    metric: String(r.metric),
    value: Number(r.value ?? 0),
  }));
}

/** Freshness for `health()`: how long ago the newest event was ingested. */
export async function ingestLagSeconds(db: D1Database, nowMs = Date.now()): Promise<number | null> {
  const row = await db.prepare('SELECT MAX(ingested_at) AS newest FROM analytics_events').first<{ newest: string | null }>();
  if (!row?.newest) return 0;
  const t = Date.parse(row.newest);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((nowMs - t) / 1000));
}
