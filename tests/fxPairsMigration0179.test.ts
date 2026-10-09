/**
 * MIGRATION 0179 — THE EXCHANGE-RATE TABLES, PROVEN ON THE REAL SCHEMA (FX
 * programme plan §4.1, §15.2; the 24 scenarios of the planning probe
 * fx-plan/probe/check0179.mjs, here against migrations/0179_fx_rates.sql as
 * every database applies it).
 *
 *   seeds        three pairs, three derived rows, three shipping rows; the
 *                NOT EXISTS-guarded seeds re-run as a no-op (migrate-check --twice)
 *   H1           the status is DERIVED: a failed fetch while a value is held keeps
 *                REVIEW_REQUIRED; a non-derived status is refused
 *   version      effective_version moves by exactly one, and only with the value
 *   F1           an out-of-bounds effective rate, and a USD/IQD outside
 *                500–10,000 in the derived table, are refused by the database
 *   F7           a provider time is the 24 characters of toISOString or nothing
 *   F6           an error code is [A-Z0-9_], at most 40 — never a message
 *   F2 / M1      a derived row is written only from the CURRENT effective pairs
 *   F8           INSERT OR REPLACE is refused on every 0179 table; nothing is deleted
 *   other        the dead band below the threshold, drift not below it, no
 *                pending candidate while MANUAL, the purchase snapshot columns
 *
 * Run: node --import tsx --test tests/fxPairsMigration0179.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ROOT } from './fixtures/d1';
import { dbThrough, freshDb, hasColumn, row, count } from './fixtures/app';

const NOW = '2026-10-08T12:00:00.000Z';

function ok(db: DatabaseSync, sql: string) {
  db.exec(sql);
}
function refused(db: DatabaseSync, sql: string, message: RegExp) {
  assert.throws(() => db.exec(sql), message, sql.slice(0, 90));
}

test('the seeds: three pairs NOT_CONFIGURED with the Q6 dead band, three empty derived rows, three empty shipping rows', () => {
  const db = freshDb();
  const pairs = db.prepare('SELECT pair, provider, mode, interval_hours, status, fetch_status, min_change_pct, anomaly_threshold_pct, drift_threshold_pct, bound_min, bound_max, max_age_hours, effective_rate FROM fx_rate_pairs ORDER BY pair').all();
  assert.deepEqual(pairs.map((p) => ({ ...p })), [
    { pair: 'CNY_USD', provider: 'ecb', mode: 'AUTO', interval_hours: 24, status: 'NOT_CONFIGURED', fetch_status: 'NOT_CONFIGURED', min_change_pct: '0.3', anomaly_threshold_pct: '3', drift_threshold_pct: '6', bound_min: '0.08', bound_max: '0.25', max_age_hours: 168, effective_rate: null },
    { pair: 'EUR_USD', provider: 'ecb', mode: 'AUTO', interval_hours: 24, status: 'NOT_CONFIGURED', fetch_status: 'NOT_CONFIGURED', min_change_pct: '0.3', anomaly_threshold_pct: '3', drift_threshold_pct: '6', bound_min: '0.8', bound_max: '1.6', max_age_hours: 168, effective_rate: null },
    { pair: 'USD_IQD', provider: 'iqwealth', mode: 'AUTO', interval_hours: 6, status: 'NOT_CONFIGURED', fetch_status: 'NOT_CONFIGURED', min_change_pct: '0.5', anomaly_threshold_pct: '3', drift_threshold_pct: '6', bound_min: '1000', bound_max: '3000', max_age_hours: 72, effective_rate: null },
  ]);
  assert.equal(count(db, 'SELECT COUNT(*) n FROM pricing_fx_rates WHERE rate_iqd IS NULL'), 3);
  assert.equal(count(db, 'SELECT COUNT(*) n FROM pricing_shipping_rates WHERE rate_iqd IS NULL'), 3);
  assert.equal(count(db, 'SELECT COUNT(*) n FROM fx_rate_log'), 0);
});

test('the seeds re-run as a no-op: NOT EXISTS-guarded, so migrate-check --twice adds no row', () => {
  const db = freshDb();
  const sql = readFileSync(join(ROOT, 'migrations/0179_fx_rates.sql'), 'utf8');
  const seeds = sql.split(/;\s*\n/).filter((s) => /^\s*INSERT INTO/m.test(s.replace(/^\s*--.*$/gm, '')));
  assert.equal(seeds.length, 3);
  for (const s of seeds) db.exec(s.replace(/^(\s*--[^\n]*\n)*/, ''));
  assert.equal(count(db, 'SELECT COUNT(*) n FROM fx_rate_pairs'), 3);
  assert.equal(count(db, 'SELECT COUNT(*) n FROM pricing_fx_rates'), 3);
  assert.equal(count(db, 'SELECT COUNT(*) n FROM pricing_shipping_rates'), 3);
});

test('the 24 probe scenarios (fx-plan/probe/check0179.mjs) hold on the real migration', () => {
  const db = freshDb();
  ok(db, `UPDATE fx_rate_pairs SET market_rate='1660', fetch_status='OK', status='REVIEW_REQUIRED', pending_market_rate='1660', pending_effective_rate='1660', pending_reason='FIRST_VALUE', pending_observed_at='${NOW}', published_at='2026-10-08T12:41:58.000Z', version=version+1 WHERE pair='USD_IQD'`);
  ok(db, `UPDATE fx_rate_pairs SET fetch_status='FAILED', last_error_code='NETWORK', failing_since='${NOW}', version=version+1 WHERE pair='USD_IQD'`);
  assert.equal(row<{ status: string }>(db, "SELECT status FROM fx_rate_pairs WHERE pair='USD_IQD'")!.status, 'REVIEW_REQUIRED', 'H1: a failed fetch while a value is held keeps REVIEW_REQUIRED');
  refused(db, `UPDATE fx_rate_pairs SET status='FAILED' WHERE pair='USD_IQD'`, /CHECK constraint failed: status = CASE/);
  ok(db, `UPDATE fx_rate_pairs SET effective_rate='1660', effective_version=1, drift_anchor_rate='1660', drift_anchor_at='${NOW}', pending_market_rate=NULL, pending_effective_rate=NULL, pending_reason=NULL, pending_observed_at=NULL, status=fetch_status WHERE pair='USD_IQD'`);
  refused(db, `UPDATE fx_rate_pairs SET effective_version=2 WHERE pair='USD_IQD'`, /FX_VERSION_DISCIPLINE/);
  refused(db, `UPDATE fx_rate_pairs SET effective_rate='1670' WHERE pair='USD_IQD'`, /FX_VERSION_DISCIPLINE/);
  refused(db, `UPDATE fx_rate_pairs SET effective_rate='999', effective_version=2, drift_anchor_rate='999' WHERE pair='USD_IQD'`, /CHECK constraint failed: effective_rate IS NULL OR/);
  refused(db, `UPDATE fx_rate_pairs SET published_at='Thu, 08 Oct 2026 12:41:58 GMT (xxxxxxxx)' WHERE pair='USD_IQD'`, /CHECK constraint failed/);
  refused(db, `UPDATE fx_rate_pairs SET last_error_code='fetch failed: iqw_SECRET' WHERE pair='USD_IQD'`, /CHECK constraint failed: last_error_code/);
  refused(db, `UPDATE fx_rate_pairs SET min_change_pct='3' WHERE pair='USD_IQD'`, /min_change_pct AS REAL\) < CAST\(anomaly_threshold_pct/);
  refused(db, `UPDATE fx_rate_pairs SET drift_threshold_pct='2' WHERE pair='USD_IQD'`, /drift_threshold_pct AS REAL\) >= CAST\(anomaly_threshold_pct/);
  ok(db, `UPDATE pricing_fx_rates SET rate_iqd='1660', usd_iqd_rate='1660', usd_version=1, version=version+1 WHERE currency='USD'`);
  refused(db, `UPDATE pricing_fx_rates SET rate_iqd='1856.876', usd_iqd_rate='1660', usd_version=1, cross_rate='1.1186', cross_version=1 WHERE currency='EUR'`, /FX_DERIVED_STALE/);
  ok(db, `UPDATE fx_rate_pairs SET fetch_status='OK', status='OK', effective_rate='1.1186', effective_version=1, drift_anchor_rate='1.1186', drift_anchor_at='${NOW}' WHERE pair='EUR_USD'`);
  ok(db, `UPDATE pricing_fx_rates SET rate_iqd='1856.876', usd_iqd_rate='1660', usd_version=1, cross_rate='1.1186', cross_version=1 WHERE currency='EUR'`);
  ok(db, `UPDATE fx_rate_pairs SET effective_rate='1670', effective_version=2 WHERE pair='USD_IQD'`);
  refused(db, `UPDATE pricing_fx_rates SET rate_iqd='1868.062', usd_iqd_rate='1660', usd_version=1, cross_rate='1.1186', cross_version=1 WHERE currency='EUR'`, /FX_DERIVED_STALE/);
  refused(db, `UPDATE pricing_fx_rates SET rate_iqd='1840.000', usd_iqd_rate='1670', usd_version=2, cross_rate='1.1018', cross_version=1 WHERE currency='EUR'`, /FX_DERIVED_STALE/);
  ok(db, `UPDATE fx_rate_pairs SET bound_min='1', effective_rate='400', effective_version=3, drift_anchor_rate='400' WHERE pair='USD_IQD'`);
  refused(db, `UPDATE pricing_fx_rates SET rate_iqd='400', usd_iqd_rate='400', usd_version=3 WHERE currency='USD'`, /usd_iqd_rate AS REAL\) >= 500/);
  refused(db, `INSERT OR REPLACE INTO fx_rate_pairs (pair, provider, interval_hours, bound_min, bound_max, max_age_hours, updated_at) VALUES ('USD_IQD','iqwealth',6,'1','5000',72,'x')`, /FX_PAIR_PERMANENT/);
  refused(db, `INSERT OR REPLACE INTO pricing_fx_rates (currency, rate_iqd, usd_iqd_rate) VALUES ('USD','1','1')`, /PRICING_RATE_PERMANENT/);
  ok(db, `INSERT INTO fx_rate_log (id,pair,event,trigger_kind,result,created_at) VALUES ('l1','USD_IQD','check','cron','UNCHANGED','${NOW}')`);
  refused(db, `INSERT OR REPLACE INTO fx_rate_log (id,pair,event,trigger_kind,result,created_at) VALUES ('l1','USD_IQD','apply','cron','APPLIED','${NOW}')`, /FX_LOG_IMMUTABLE/);
  refused(db, `UPDATE fx_rate_pairs SET mode='MANUAL', manual_rate=effective_rate, pending_market_rate='1', pending_effective_rate='1', pending_reason='ANOMALY', pending_observed_at='x', status='REVIEW_REQUIRED' WHERE pair='EUR_USD'`, /mode = 'AUTO' OR pending_effective_rate IS NULL/);
});

test('F8 on every 0179 table: REPLACE, OR IGNORE and an upsert on an existing key are refused; nothing is ever deleted; the log is immutable', () => {
  const db = freshDb();
  refused(db, `INSERT OR IGNORE INTO fx_rate_pairs (pair, provider, interval_hours, bound_min, bound_max, max_age_hours, updated_at) VALUES ('EUR_USD','ecb',24,'1','2',72,'x')`, /FX_PAIR_PERMANENT/);
  refused(db, `INSERT OR REPLACE INTO pricing_shipping_rates (profile, basis, rate_iqd) VALUES ('CHINA_SEA','volume','1')`, /PRICING_RATE_PERMANENT/);
  refused(db, `INSERT INTO pricing_shipping_rates (profile, basis) VALUES ('CHINA_AIR','weight') ON CONFLICT(profile) DO UPDATE SET rate_iqd='9'`, /PRICING_RATE_PERMANENT/);
  for (const [table, key] of [['fx_rate_pairs', "pair='USD_IQD'"], ['pricing_fx_rates', "currency='USD'"], ['pricing_shipping_rates', "profile='CHINA_AIR'"]] as const) {
    refused(db, `DELETE FROM ${table} WHERE ${key}`, /PERMANENT/);
  }
  ok(db, `INSERT INTO fx_rate_log (id,pair,event,trigger_kind,result,created_at) VALUES ('l1','USD_IQD','check','cron','UNCHANGED','${NOW}')`);
  refused(db, `UPDATE fx_rate_log SET result='APPLIED' WHERE id='l1'`, /FX_LOG_IMMUTABLE/);
  refused(db, `DELETE FROM fx_rate_log WHERE id='l1'`, /FX_LOG_IMMUTABLE/);
});

test('the shipping basis is fixed per profile, the rate is decimal text > 0, and an ECB pair carries no adjustment or 6/12-hour interval', () => {
  const db = freshDb();
  refused(db, `UPDATE pricing_shipping_rates SET basis='weight' WHERE profile='CHINA_SEA'`, /CHECK constraint failed/);
  refused(db, `UPDATE pricing_shipping_rates SET rate_iqd='0' WHERE profile='CHINA_AIR'`, /CHECK constraint failed/);
  refused(db, `UPDATE pricing_shipping_rates SET rate_iqd='1e3' WHERE profile='CHINA_AIR'`, /CHECK constraint failed/);
  ok(db, `UPDATE pricing_shipping_rates SET rate_iqd='12000.5', version=version+1 WHERE profile='CHINA_AIR'`);
  refused(db, `UPDATE fx_rate_pairs SET adjustment='20' WHERE pair='EUR_USD'`, /CHECK constraint failed: pair = 'USD_IQD' OR adjustment = '0'/);
  refused(db, `UPDATE fx_rate_pairs SET interval_hours=6 WHERE pair='EUR_USD'`, /CHECK constraint failed/);
  refused(db, `UPDATE fx_rate_pairs SET interval_hours=24 WHERE pair='USD_IQD'`, /CHECK constraint failed/);
  ok(db, `UPDATE fx_rate_pairs SET adjustment='-20.5' WHERE pair='USD_IQD'`);
  refused(db, `UPDATE fx_rate_pairs SET adjustment='--20' WHERE pair='USD_IQD'`, /CHECK constraint failed/);
  refused(db, `UPDATE fx_rate_pairs SET market_rate='0' WHERE pair='USD_IQD'`, /CHECK constraint failed/);
});

test('the purchase snapshot columns exist after 0179 and not before; a 0177 database has no FX table', () => {
  const db = freshDb();
  for (const c of ['fx_usd_iqd_at_purchase', 'fx_eur_usd_at_purchase', 'fx_cny_usd_at_purchase', 'fx_snapshot_at']) assert.ok(hasColumn(db, 'purchase_orders', c), c);
  const before = dbThrough('0177');
  assert.equal(hasColumn(before, 'purchase_orders', 'fx_snapshot_at'), false, 'a 0177 database does not have them');
  assert.throws(() => before.prepare('SELECT 1 FROM fx_rate_pairs').get(), /no such table/);
});
