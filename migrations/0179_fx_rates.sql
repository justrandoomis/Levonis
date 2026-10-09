-- 0179 — FX: automatic exchange rates (owner brief 2026-10-08 §2–§10, §21, §27–§33).
-- ADDITIVE ONLY. Changes no price, wallet, order or batch. PRIVATE (owner only, never joined by
-- a public read): every table here. The ONE public figure — the effective USD/IQD the display
-- currency divides by — is read from pricing_fx_rates('USD') by /api/settings/public.
-- Every freeze here is an UPDATE/DELETE trigger PLUS a BEFORE INSERT "no re-insert" trigger:
-- SQLite's INSERT OR REPLACE fires neither UPDATE nor DELETE triggers (recursive_triggers is off).
-- Consequence: no writer may use INSERT OR IGNORE / OR REPLACE / ON CONFLICT on these tables,
-- and the seeds are NOT EXISTS-guarded INSERT … SELECT (migrate-check --twice re-runs them).
-- The decimal and timestamp CHECKs are written out in full (SQLite has no macros): a positive
-- canonical decimal is digits with at most one '.', no exponent, no trailing '.', a length cap and a
-- value above zero (FX plan §4 DEC_POS); the signed adjustment allows one leading '+' or '-'
-- (DEC_SIGNED); a provider time is exactly the 24 characters of `new Date(ms).toISOString()` (TS24).

-- 1. The three source pairs. USD_IQD = IQD per 1 USD (Iraqi parallel market, IQWealth);
--    EUR_USD = USD per 1 EUR; CNY_USD = USD per 1 CNY (both from the ECB daily reference).
CREATE TABLE IF NOT EXISTS fx_rate_pairs (
  pair                   TEXT PRIMARY KEY CHECK (pair IN ('USD_IQD','EUR_USD','CNY_USD')),
  provider               TEXT NOT NULL CHECK (provider IN ('iqwealth','ecb')),
  mode                   TEXT NOT NULL DEFAULT 'AUTO' CHECK (mode IN ('AUTO','MANUAL')),   -- «إيقاف» = MANUAL
  interval_hours         INTEGER NOT NULL CHECK (interval_hours IN (6, 12, 24)),
  -- provider figures of the last VALIDATED fetch (display + audit; never read by pricing)
  market_rate            TEXT CHECK (market_rate IS NULL OR (market_rate GLOB '[0-9]*' AND market_rate NOT GLOB '*[^0-9.]*' AND market_rate NOT GLOB '*.*.*' AND market_rate NOT GLOB '*.' AND length(market_rate) <= 32 AND CAST(market_rate AS REAL) > 0)),      -- USD_IQD: parallel SELL
  market_buy             TEXT CHECK (market_buy IS NULL OR (market_buy GLOB '[0-9]*' AND market_buy NOT GLOB '*[^0-9.]*' AND market_buy NOT GLOB '*.*.*' AND market_buy NOT GLOB '*.' AND length(market_buy) <= 32 AND CAST(market_buy AS REAL) > 0)),        -- USD_IQD only
  official_rate          TEXT CHECK (official_rate IS NULL OR (official_rate GLOB '[0-9]*' AND official_rate NOT GLOB '*[^0-9.]*' AND official_rate NOT GLOB '*.*.*' AND official_rate NOT GLOB '*.' AND length(official_rate) <= 32 AND CAST(official_rate AS REAL) > 0)),  -- CBI, USD_IQD only
  source_usd_per_eur     TEXT CHECK (source_usd_per_eur IS NULL OR (source_usd_per_eur GLOB '[0-9]*' AND source_usd_per_eur NOT GLOB '*[^0-9.]*' AND source_usd_per_eur NOT GLOB '*.*.*' AND source_usd_per_eur NOT GLOB '*.' AND length(source_usd_per_eur) <= 16 AND CAST(source_usd_per_eur AS REAL) > 0)),
  source_cny_per_eur     TEXT CHECK (source_cny_per_eur IS NULL OR (source_cny_per_eur GLOB '[0-9]*' AND source_cny_per_eur NOT GLOB '*[^0-9.]*' AND source_cny_per_eur NOT GLOB '*.*.*' AND source_cny_per_eur NOT GLOB '*.' AND length(source_cny_per_eur) <= 16 AND CAST(source_cny_per_eur AS REAL) > 0)),
  adjustment             TEXT NOT NULL DEFAULT '0' CHECK ((ltrim(adjustment,'+-') GLOB '[0-9]*' AND ltrim(adjustment,'+-') NOT GLOB '*[^0-9.]*' AND ltrim(adjustment,'+-') NOT GLOB '*.*.*' AND ltrim(adjustment,'+-') NOT GLOB '*.' AND length(adjustment) - length(ltrim(adjustment,'+-')) <= 1 AND length(adjustment) <= 16)),       -- IQD per USD (Q1)
  manual_rate            TEXT CHECK (manual_rate IS NULL OR (manual_rate GLOB '[0-9]*' AND manual_rate NOT GLOB '*[^0-9.]*' AND manual_rate NOT GLOB '*.*.*' AND manual_rate NOT GLOB '*.' AND length(manual_rate) <= 32 AND CAST(manual_rate AS REAL) > 0)),
  -- THE rate in use (= what pricing_fx_rates was built from)
  effective_rate         TEXT CHECK (effective_rate IS NULL OR (effective_rate GLOB '[0-9]*' AND effective_rate NOT GLOB '*[^0-9.]*' AND effective_rate NOT GLOB '*.*.*' AND effective_rate NOT GLOB '*.' AND length(effective_rate) <= 32 AND CAST(effective_rate AS REAL) > 0)),
  effective_version      INTEGER NOT NULL DEFAULT 0 CHECK (effective_version >= 0),   -- +1 exactly when effective_rate changes VALUE
  effective_source       TEXT CHECK (effective_source IS NULL OR effective_source IN ('provider','manual','review_approved')),
  effective_applied_at   TEXT,
  effective_applied_by   TEXT,                                   -- user id or 'system:fx'
  -- last provider value that passed every guard and was applied (§29; kept while MANUAL)
  last_known_good_rate   TEXT CHECK (last_known_good_rate IS NULL OR (last_known_good_rate GLOB '[0-9]*' AND last_known_good_rate NOT GLOB '*[^0-9.]*' AND last_known_good_rate NOT GLOB '*.*.*' AND last_known_good_rate NOT GLOB '*.' AND length(last_known_good_rate) <= 32 AND CAST(last_known_good_rate AS REAL) > 0)),
  last_known_good_at     TEXT,
  -- the last OWNER-CONFIRMED effective rate (first approval, review approval, manual set,
  -- approved back-to-auto, «تأكيد السعر الحالي»). Automatic applies never move it (critique F1).
  drift_anchor_rate      TEXT CHECK (drift_anchor_rate IS NULL OR (drift_anchor_rate GLOB '[0-9]*' AND drift_anchor_rate NOT GLOB '*[^0-9.]*' AND drift_anchor_rate NOT GLOB '*.*.*' AND drift_anchor_rate NOT GLOB '*.' AND length(drift_anchor_rate) <= 32 AND CAST(drift_anchor_rate AS REAL) > 0)),
  drift_anchor_at        TEXT,
  published_at           TEXT CHECK ((published_at IS NULL OR (length(published_at) = 24 AND published_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'))),        -- provider's own time, normalised; never goes backwards
  last_checked_at        TEXT,                                   -- every attempt
  last_check_result      TEXT CHECK (last_check_result IS NULL OR last_check_result IN
                           ('APPLIED','UNCHANGED','REVIEW_HELD','DEFERRED','SUPERSEDED','FAILED','STALE','INVALID','NOT_CONFIGURED','OBSERVED')),
  last_successful_at     TEXT,                                   -- last attempt whose figure passed validation
  last_cron_success_at   TEXT,                                   -- the CRON's scheduledTime of that attempt: the due-logic phase
  fetch_status           TEXT NOT NULL DEFAULT 'NOT_CONFIGURED' CHECK (fetch_status IN ('OK','FAILED','STALE','NOT_CONFIGURED')),
  status                 TEXT NOT NULL DEFAULT 'NOT_CONFIGURED' CHECK (status IN
                           ('OK','REVIEW_REQUIRED','FAILED','STALE','NOT_CONFIGURED')),   -- derived, see CHECK below
  last_error_code        TEXT CHECK (last_error_code IS NULL OR (length(last_error_code) <= 40 AND last_error_code NOT GLOB '*[^A-Z0-9_]*')),
  failing_since          TEXT,
  pending_market_rate    TEXT CHECK (pending_market_rate IS NULL OR (pending_market_rate GLOB '[0-9]*' AND pending_market_rate NOT GLOB '*[^0-9.]*' AND pending_market_rate NOT GLOB '*.*.*' AND pending_market_rate NOT GLOB '*.' AND length(pending_market_rate) <= 32 AND CAST(pending_market_rate AS REAL) > 0)),
  pending_effective_rate TEXT CHECK (pending_effective_rate IS NULL OR (pending_effective_rate GLOB '[0-9]*' AND pending_effective_rate NOT GLOB '*[^0-9.]*' AND pending_effective_rate NOT GLOB '*.*.*' AND pending_effective_rate NOT GLOB '*.' AND length(pending_effective_rate) <= 32 AND CAST(pending_effective_rate AS REAL) > 0)),
  pending_published_at   TEXT CHECK ((pending_published_at IS NULL OR (length(pending_published_at) = 24 AND pending_published_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'))),
  pending_observed_at    TEXT,
  pending_reason         TEXT CHECK (pending_reason IS NULL OR pending_reason IN ('FIRST_VALUE','ANOMALY','ANOMALY_24H','DRIFT','BACK_TO_AUTO')),
  pending_notified_at    TEXT,                                   -- last bell for this pending candidate (re-rung every 24 h)
  rejected_rate          TEXT CHECK (rejected_rate IS NULL OR (rejected_rate GLOB '[0-9]*' AND rejected_rate NOT GLOB '*[^0-9.]*' AND rejected_rate NOT GLOB '*.*.*' AND rejected_rate NOT GLOB '*.' AND length(rejected_rate) <= 32 AND CAST(rejected_rate AS REAL) > 0)),   -- the candidate the owner rejected
  rejected_at            TEXT,
  anomaly_threshold_pct  TEXT NOT NULL DEFAULT '3'
                           CHECK ((anomaly_threshold_pct GLOB '[0-9]*' AND anomaly_threshold_pct NOT GLOB '*[^0-9.]*' AND anomaly_threshold_pct NOT GLOB '*.*.*' AND anomaly_threshold_pct NOT GLOB '*.' AND length(anomaly_threshold_pct) <= 6 AND CAST(anomaly_threshold_pct AS REAL) > 0) AND CAST(anomaly_threshold_pct AS REAL) <= 50),
  drift_threshold_pct    TEXT NOT NULL DEFAULT '6'
                           CHECK ((drift_threshold_pct GLOB '[0-9]*' AND drift_threshold_pct NOT GLOB '*[^0-9.]*' AND drift_threshold_pct NOT GLOB '*.*.*' AND drift_threshold_pct NOT GLOB '*.' AND length(drift_threshold_pct) <= 6 AND CAST(drift_threshold_pct AS REAL) > 0) AND CAST(drift_threshold_pct AS REAL) <= 25),
  min_change_pct         TEXT NOT NULL DEFAULT '0' CHECK (min_change_pct = '0' OR
                           ((min_change_pct GLOB '[0-9]*' AND min_change_pct NOT GLOB '*[^0-9.]*' AND min_change_pct NOT GLOB '*.*.*' AND min_change_pct NOT GLOB '*.' AND length(min_change_pct) <= 6 AND CAST(min_change_pct AS REAL) > 0) AND CAST(min_change_pct AS REAL) <= 5)),
  bound_min              TEXT NOT NULL CHECK ((bound_min GLOB '[0-9]*' AND bound_min NOT GLOB '*[^0-9.]*' AND bound_min NOT GLOB '*.*.*' AND bound_min NOT GLOB '*.' AND length(bound_min) <= 32 AND CAST(bound_min AS REAL) > 0)),
  bound_max              TEXT NOT NULL CHECK ((bound_max GLOB '[0-9]*' AND bound_max NOT GLOB '*[^0-9.]*' AND bound_max NOT GLOB '*.*.*' AND bound_max NOT GLOB '*.' AND length(bound_max) <= 32 AND CAST(bound_max AS REAL) > 0)),
  max_age_hours          INTEGER NOT NULL CHECK (max_age_hours BETWEEN 1 AND 336),
  provider_calls_day     TEXT CHECK (provider_calls_day IS NULL OR (length(provider_calls_day) = 10
                           AND provider_calls_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')),
  provider_calls_count   INTEGER NOT NULL DEFAULT 0 CHECK (provider_calls_count BETWEEN 0 AND 1000),
  lease_token            TEXT,
  lease_until            TEXT,
  version                INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),        -- every write (scheduler fence)
  owner_version          INTEGER NOT NULL DEFAULT 1 CHECK (owner_version > 0),  -- owner-visible changes only (owner fence)
  updated_by             TEXT,
  updated_at             TEXT NOT NULL,
  CHECK ((pair = 'USD_IQD') = (provider = 'iqwealth')),
  CHECK ((pair = 'USD_IQD' AND interval_hours IN (6, 12)) OR (pair <> 'USD_IQD' AND interval_hours = 24)),
  CHECK (pair = 'USD_IQD' OR adjustment = '0'),
  CHECK (pair = 'USD_IQD' OR (market_buy IS NULL AND official_rate IS NULL)),
  CHECK (pair <> 'USD_IQD' OR (source_usd_per_eur IS NULL AND source_cny_per_eur IS NULL)),
  CHECK (mode = 'AUTO' OR (manual_rate IS NOT NULL AND effective_rate = manual_rate)),
  -- H1: one status, derived; a failed fetch while a review is pending is legal.
  CHECK (status = CASE WHEN pending_effective_rate IS NOT NULL THEN 'REVIEW_REQUIRED' ELSE fetch_status END),
  CHECK ((pending_effective_rate IS NULL) = (pending_reason IS NULL)),
  CHECK ((pending_effective_rate IS NULL) = (pending_observed_at IS NULL)),
  CHECK (mode = 'AUTO' OR pending_effective_rate IS NULL),
  CHECK ((effective_rate IS NULL) = (effective_version = 0)),
  CHECK ((effective_rate IS NULL) = (drift_anchor_rate IS NULL)),
  CHECK ((rejected_rate IS NULL) = (rejected_at IS NULL)),
  CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
  CHECK (CAST(bound_min AS REAL) < CAST(bound_max AS REAL)),
  -- F1: defence in depth — no code path can store an out-of-bounds effective rate.
  CHECK (effective_rate IS NULL OR (CAST(effective_rate AS REAL) >= CAST(bound_min AS REAL)
                                AND CAST(effective_rate AS REAL) <= CAST(bound_max AS REAL))),
  CHECK (CAST(min_change_pct AS REAL) < CAST(anomaly_threshold_pct AS REAL)),
  CHECK (CAST(drift_threshold_pct AS REAL) >= CAST(anomaly_threshold_pct AS REAL))
);
INSERT INTO fx_rate_pairs (pair, provider, mode, interval_hours, min_change_pct, bound_min, bound_max, max_age_hours, updated_by, updated_at)
SELECT v.column1, v.column2, 'AUTO', v.column3, v.column4, v.column5, v.column6, v.column7,
       'migration:0179', strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM (VALUES ('USD_IQD', 'iqwealth',  6, '0.5', '1000', '3000',  72),
               ('EUR_USD', 'ecb',      24, '0.3', '0.8',  '1.6',  168),
               ('CNY_USD', 'ecb',      24, '0.3', '0.08', '0.25', 168)) AS v
 WHERE NOT EXISTS (SELECT 1 FROM fx_rate_pairs p WHERE p.pair = v.column1);
CREATE TRIGGER IF NOT EXISTS fx_rate_pairs_no_delete BEFORE DELETE ON fx_rate_pairs
BEGIN SELECT RAISE(ABORT, 'FX_PAIR_PERMANENT'); END;
CREATE TRIGGER IF NOT EXISTS fx_rate_pairs_no_reinsert BEFORE INSERT ON fx_rate_pairs
WHEN EXISTS (SELECT 1 FROM fx_rate_pairs WHERE pair = NEW.pair)
BEGIN SELECT RAISE(ABORT, 'FX_PAIR_PERMANENT'); END;
-- effective_version moves by exactly one, and only when the effective VALUE changes (§31; F2's fences rely on it).
CREATE TRIGGER IF NOT EXISTS fx_rate_pairs_effective_version BEFORE UPDATE OF effective_rate, effective_version ON fx_rate_pairs
WHEN (NEW.effective_rate IS NOT OLD.effective_rate AND NEW.effective_version <> OLD.effective_version + 1)
  OR (NEW.effective_rate IS OLD.effective_rate AND NEW.effective_version <> OLD.effective_version)
BEGIN SELECT RAISE(ABORT, 'FX_VERSION_DISCIPLINE'); END;

-- 2. Append-only FX history (values live HERE, never in audit_log).
CREATE TABLE IF NOT EXISTS fx_rate_log (
  id                TEXT PRIMARY KEY,
  pair              TEXT NOT NULL CHECK (pair IN ('USD_IQD','EUR_USD','CNY_USD')),
  event             TEXT NOT NULL CHECK (event IN ('check','apply','review_held','review_approved','review_rejected',
                      'review_cleared','review_expired','manual_set','mode_change','settings_change','failure','observed',
                      'deferred','superseded','commit_refused','anchor_confirmed')),
  trigger_kind      TEXT NOT NULL CHECK (trigger_kind IN ('cron','refresh','owner','back_to_auto')),
  provider          TEXT CHECK (provider IS NULL OR provider IN ('iqwealth','ecb','owner')),
  market_rate       TEXT CHECK (market_rate IS NULL OR (market_rate GLOB '[0-9]*' AND market_rate NOT GLOB '*[^0-9.]*' AND market_rate NOT GLOB '*.*.*' AND market_rate NOT GLOB '*.' AND length(market_rate) <= 32 AND CAST(market_rate AS REAL) > 0)),
  effective_before  TEXT CHECK (effective_before IS NULL OR (effective_before GLOB '[0-9]*' AND effective_before NOT GLOB '*[^0-9.]*' AND effective_before NOT GLOB '*.*.*' AND effective_before NOT GLOB '*.' AND length(effective_before) <= 32 AND CAST(effective_before AS REAL) > 0)),
  effective_after   TEXT CHECK (effective_after IS NULL OR (effective_after GLOB '[0-9]*' AND effective_after NOT GLOB '*[^0-9.]*' AND effective_after NOT GLOB '*.*.*' AND effective_after NOT GLOB '*.' AND length(effective_after) <= 32 AND CAST(effective_after AS REAL) > 0)),   -- the rate in force after this row (r24 reads it)
  pending_rate      TEXT CHECK (pending_rate IS NULL OR (pending_rate GLOB '[0-9]*' AND pending_rate NOT GLOB '*[^0-9.]*' AND pending_rate NOT GLOB '*.*.*' AND pending_rate NOT GLOB '*.' AND length(pending_rate) <= 32 AND CAST(pending_rate AS REAL) > 0)),
  change_ppm        INTEGER,                    -- |after−before|/before × 1e6, display only
  published_at      TEXT CHECK ((published_at IS NULL OR (length(published_at) = 24 AND published_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'))),
  result            TEXT NOT NULL CHECK (length(result) <= 20),
  error_code        TEXT CHECK (error_code IS NULL OR (length(error_code) <= 40 AND error_code NOT GLOB '*[^A-Z0-9_]*')),
  repriced_products INTEGER CHECK (repriced_products IS NULL OR repriced_products >= 0),   -- FX-5
  actor_id          TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fx_rate_log_pair ON fx_rate_log(pair, created_at);
CREATE INDEX IF NOT EXISTS idx_fx_rate_log_owner ON fx_rate_log(created_at) WHERE trigger_kind = 'owner';
CREATE TRIGGER IF NOT EXISTS fx_rate_log_immutable BEFORE UPDATE ON fx_rate_log
BEGIN SELECT RAISE(ABORT, 'FX_LOG_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS fx_rate_log_no_delete BEFORE DELETE ON fx_rate_log
BEGIN SELECT RAISE(ABORT, 'FX_LOG_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS fx_rate_log_no_reinsert BEFORE INSERT ON fx_rate_log
WHEN EXISTS (SELECT 1 FROM fx_rate_log WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'FX_LOG_IMMUTABLE'); END;

-- 3. The effective IQD rates the engine reads (E1 CentralRates.fx). Written ONLY in the same
--    batch as the fx_rate_pairs change that produced them. rate_iqd: IQD per 1 unit, exact.
CREATE TABLE IF NOT EXISTS pricing_fx_rates (
  currency      TEXT PRIMARY KEY CHECK (currency IN ('USD','EUR','CNY')),
  rate_iqd      TEXT CHECK (rate_iqd IS NULL OR (rate_iqd GLOB '[0-9]*' AND rate_iqd NOT GLOB '*[^0-9.]*' AND rate_iqd NOT GLOB '*.*.*' AND rate_iqd NOT GLOB '*.' AND length(rate_iqd) <= 48 AND CAST(rate_iqd AS REAL) > 0)),
  usd_iqd_rate  TEXT CHECK (usd_iqd_rate IS NULL OR (usd_iqd_rate GLOB '[0-9]*' AND usd_iqd_rate NOT GLOB '*[^0-9.]*' AND usd_iqd_rate NOT GLOB '*.*.*' AND usd_iqd_rate NOT GLOB '*.' AND length(usd_iqd_rate) <= 32 AND CAST(usd_iqd_rate AS REAL) > 0)),
  cross_rate    TEXT CHECK (cross_rate IS NULL OR (cross_rate GLOB '[0-9]*' AND cross_rate NOT GLOB '*[^0-9.]*' AND cross_rate NOT GLOB '*.*.*' AND cross_rate NOT GLOB '*.' AND length(cross_rate) <= 32 AND CAST(cross_rate AS REAL) > 0)),     -- effective E or C
  usd_version   INTEGER,                                                        -- fx_rate_pairs USD_IQD effective_version
  cross_version INTEGER,                                                        -- EUR_USD / CNY_USD effective_version
  version       INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),                 -- +1 only when rate_iqd changes
  updated_by    TEXT,
  updated_at    TEXT,
  CHECK ((rate_iqd IS NULL) = (usd_iqd_rate IS NULL)),
  CHECK (currency <> 'USD' OR (cross_rate IS NULL AND cross_version IS NULL AND (rate_iqd IS NULL OR rate_iqd = usd_iqd_rate))),
  CHECK (currency = 'USD' OR ((rate_iqd IS NULL) = (cross_rate IS NULL))),
  -- F1: a fixed sanity band on the one figure every price multiplies by.
  CHECK (usd_iqd_rate IS NULL OR (CAST(usd_iqd_rate AS REAL) >= 500 AND CAST(usd_iqd_rate AS REAL) <= 10000))
);
INSERT INTO pricing_fx_rates (currency)
SELECT v.column1 FROM (VALUES ('USD'), ('EUR'), ('CNY')) AS v
 WHERE NOT EXISTS (SELECT 1 FROM pricing_fx_rates r WHERE r.currency = v.column1);
CREATE TRIGGER IF NOT EXISTS pricing_fx_rates_no_delete BEFORE DELETE ON pricing_fx_rates
BEGIN SELECT RAISE(ABORT, 'PRICING_RATE_PERMANENT'); END;
CREATE TRIGGER IF NOT EXISTS pricing_fx_rates_no_reinsert BEFORE INSERT ON pricing_fx_rates
WHEN EXISTS (SELECT 1 FROM pricing_fx_rates WHERE currency = NEW.currency)
BEGIN SELECT RAISE(ABORT, 'PRICING_RATE_PERMANENT'); END;
-- F2/M1: a derived row is written only from the CURRENT effective pairs (fx_rate_pairs is updated
-- earlier in the same batch, so the subqueries see the new values).
CREATE TRIGGER IF NOT EXISTS pricing_fx_rates_in_step BEFORE UPDATE OF rate_iqd ON pricing_fx_rates
WHEN NEW.rate_iqd IS NOT NULL AND (
     NEW.usd_version  IS NOT (SELECT effective_version FROM fx_rate_pairs WHERE pair = 'USD_IQD')
  OR NEW.usd_iqd_rate IS NOT (SELECT effective_rate    FROM fx_rate_pairs WHERE pair = 'USD_IQD')
  OR (NEW.currency = 'EUR' AND (NEW.cross_version IS NOT (SELECT effective_version FROM fx_rate_pairs WHERE pair = 'EUR_USD')
                             OR NEW.cross_rate    IS NOT (SELECT effective_rate    FROM fx_rate_pairs WHERE pair = 'EUR_USD')))
  OR (NEW.currency = 'CNY' AND (NEW.cross_version IS NOT (SELECT effective_version FROM fx_rate_pairs WHERE pair = 'CNY_USD')
                             OR NEW.cross_rate    IS NOT (SELECT effective_rate    FROM fx_rate_pairs WHERE pair = 'CNY_USD'))))
BEGIN SELECT RAISE(ABORT, 'FX_DERIVED_STALE'); END;

-- 4. Central shipping rates in IQD (§21; answers MVP D8). Owner-entered only; no seeds from
--    procurement (the panel offers the procurement value as a one-tap suggestion).
CREATE TABLE IF NOT EXISTS pricing_shipping_rates (
  profile    TEXT PRIMARY KEY CHECK (profile IN ('GERMANY_LAND','CHINA_AIR','CHINA_SEA')),
  basis      TEXT NOT NULL CHECK (basis IN ('weight','volume')),
  rate_iqd   TEXT CHECK (rate_iqd IS NULL OR (rate_iqd GLOB '[0-9]*' AND rate_iqd NOT GLOB '*[^0-9.]*' AND rate_iqd NOT GLOB '*.*.*' AND rate_iqd NOT GLOB '*.' AND length(rate_iqd) <= 20 AND CAST(rate_iqd AS REAL) > 0)),   -- IQD per kg / per CBM
  version    INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by TEXT,
  updated_at TEXT,
  CHECK ((profile = 'CHINA_SEA' AND basis = 'volume') OR (profile <> 'CHINA_SEA' AND basis = 'weight'))
);
INSERT INTO pricing_shipping_rates (profile, basis)
SELECT v.column1, v.column2 FROM (VALUES ('GERMANY_LAND','weight'), ('CHINA_AIR','weight'), ('CHINA_SEA','volume')) AS v
 WHERE NOT EXISTS (SELECT 1 FROM pricing_shipping_rates s WHERE s.profile = v.column1);
CREATE TRIGGER IF NOT EXISTS pricing_shipping_rates_no_delete BEFORE DELETE ON pricing_shipping_rates
BEGIN SELECT RAISE(ABORT, 'PRICING_RATE_PERMANENT'); END;
CREATE TRIGGER IF NOT EXISTS pricing_shipping_rates_no_reinsert BEFORE INSERT ON pricing_shipping_rates
WHEN EXISTS (SELECT 1 FROM pricing_shipping_rates WHERE profile = NEW.profile)
BEGIN SELECT RAISE(ABORT, 'PRICING_RATE_PERMANENT'); END;

-- 5. §17 groundwork: a purchase document snapshots the CENTRAL effective rates once, when it is
--    first confirmed 'ordered', by a SEPARATE statement guarded on fx_snapshot_at IS NULL — never
--    through planDocument's header rewrite (adminProcurement.ts:487-493 rewrites every header key on
--    every save). 0181 adds the database freeze. NULL = the rate was not known then (UNKNOWN).
ALTER TABLE purchase_orders ADD COLUMN fx_usd_iqd_at_purchase TEXT
  CHECK (fx_usd_iqd_at_purchase IS NULL OR (fx_usd_iqd_at_purchase GLOB '[0-9]*' AND fx_usd_iqd_at_purchase NOT GLOB '*[^0-9.]*' AND fx_usd_iqd_at_purchase NOT GLOB '*.*.*' AND fx_usd_iqd_at_purchase NOT GLOB '*.' AND length(fx_usd_iqd_at_purchase) <= 32 AND CAST(fx_usd_iqd_at_purchase AS REAL) > 0));
ALTER TABLE purchase_orders ADD COLUMN fx_eur_usd_at_purchase TEXT
  CHECK (fx_eur_usd_at_purchase IS NULL OR (fx_eur_usd_at_purchase GLOB '[0-9]*' AND fx_eur_usd_at_purchase NOT GLOB '*[^0-9.]*' AND fx_eur_usd_at_purchase NOT GLOB '*.*.*' AND fx_eur_usd_at_purchase NOT GLOB '*.' AND length(fx_eur_usd_at_purchase) <= 32 AND CAST(fx_eur_usd_at_purchase AS REAL) > 0));
ALTER TABLE purchase_orders ADD COLUMN fx_cny_usd_at_purchase TEXT
  CHECK (fx_cny_usd_at_purchase IS NULL OR (fx_cny_usd_at_purchase GLOB '[0-9]*' AND fx_cny_usd_at_purchase NOT GLOB '*[^0-9.]*' AND fx_cny_usd_at_purchase NOT GLOB '*.*.*' AND fx_cny_usd_at_purchase NOT GLOB '*.' AND length(fx_cny_usd_at_purchase) <= 32 AND CAST(fx_cny_usd_at_purchase AS REAL) > 0));
ALTER TABLE purchase_orders ADD COLUMN fx_snapshot_at TEXT;
