/**
 * The analytics store's schema, in one place;
 * `migrations/0001_analytics_init.sql` is this text verbatim and a test
 * compares them statement by statement.
 *
 * Three tables of our own (`01-TARGET.md` §2.1: Analytics owns
 * `analytics_events`, `analytics_daily_platform`, `analytics_daily_merchant`)
 * plus the platform tables every consumer has. `merchant_store_analytics_daily`
 * — the dead table the design re-owns — is NOT created here: it exists in the
 * shared database, and moving its rows is a data decision, not a migration this
 * slice may take.
 */
import { processedEventsSchemaSql, idempotencySchemaSql } from '@levonis/platform-kit/idempotency';

export const ANALYTICS_PREFIX = 'analytics';

/**
 * One row per accepted event, holding the PROJECTION — never the envelope.
 * Every field the schema annotates `pii` has already been dropped
 * (`src/projection.ts`), the actor is a daily-salted hash, and `payload` is what
 * survived. Raw rows roll at the retention window; the rollups they feed do not.
 *
 * `day` is materialised (UTC) rather than derived in SQL so the rollup and the
 * retention sweep are index scans, not expression scans.
 */
export const ANALYTICS_EVENTS_DDL = `CREATE TABLE IF NOT EXISTS analytics_events (
  event_id       TEXT PRIMARY KEY,
  event_type     TEXT NOT NULL,
  version        INTEGER NOT NULL,
  day            TEXT NOT NULL,
  occurred_at    TEXT NOT NULL,
  ingested_at    TEXT NOT NULL,
  source_service TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id   TEXT NOT NULL,
  aggregate_seq  INTEGER NOT NULL,
  correlation_id TEXT NOT NULL DEFAULT '',
  actor_hash     TEXT,
  merchant_id    TEXT,
  payload        TEXT NOT NULL
);`;

/** `analytics_daily_platform(day, metric, value)` — `01-TARGET.md` §9.2, verbatim. */
export const ANALYTICS_DAILY_PLATFORM_DDL = `CREATE TABLE IF NOT EXISTS analytics_daily_platform (
  day        TEXT NOT NULL,
  metric     TEXT NOT NULL,
  value      INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (day, metric)
);`;

/** `analytics_daily_merchant(day, merchant_id, metric, value)` — the rollups that replace the live merchant aggregates. */
export const ANALYTICS_DAILY_MERCHANT_DDL = `CREATE TABLE IF NOT EXISTS analytics_daily_merchant (
  day         TEXT NOT NULL,
  merchant_id TEXT NOT NULL,
  metric      TEXT NOT NULL,
  value       INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (day, merchant_id, metric)
);`;

export const ANALYTICS_INDEXES_DDL = [
  'CREATE INDEX IF NOT EXISTS idx_analytics_events_day ON analytics_events(day, event_type);',
  'CREATE INDEX IF NOT EXISTS idx_analytics_events_ingested ON analytics_events(ingested_at);',
  'CREATE INDEX IF NOT EXISTS idx_analytics_events_aggregate ON analytics_events(aggregate_type, aggregate_id, aggregate_seq);',
  'CREATE INDEX IF NOT EXISTS idx_analytics_daily_merchant_lookup ON analytics_daily_merchant(merchant_id, day);',
].join('\n');

export function analyticsSchemaSql(): string {
  return [
    ANALYTICS_EVENTS_DDL,
    ANALYTICS_DAILY_PLATFORM_DDL,
    ANALYTICS_DAILY_MERCHANT_DDL,
    ANALYTICS_INDEXES_DDL,
    processedEventsSchemaSql(ANALYTICS_PREFIX),
    idempotencySchemaSql(ANALYTICS_PREFIX),
  ].join('\n\n');
}
