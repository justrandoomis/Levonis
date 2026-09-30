-- ============================================================================
--  0161 — «سرعة متجري»: A STORE'S SPEED AS ITS REAL VISITORS MEASURE IT,
--         KEPT ONLY AS DAILY BUCKETS (docs/MERCHANT_PLATFORM_V2.md §0 «Vitals»,
--         §4.5 S1–S7, §C.1 P4)
-- ============================================================================
-- The store page's own script (src/lib/storeVitals.ts, loaded after first
-- paint) reads the browser's Largest Contentful Paint, Cumulative Layout
-- Shift, Interaction to Next Paint and Time to First Byte and sends ONE beacon
-- when the page is hidden (POST /api/storefront/events/vitals,
-- worker/routes/storefrontEvents.ts). The Worker buckets each value at the Web
-- Vitals thresholds (LCP 2.5 / 4 s, INP 200 / 500 ms, CLS 0.1 / 0.25,
-- TTFB 0.8 / 1.8 s) and adds ONE to the day's bucket. Nothing else is kept:
-- no value per visit, no page, no address, no user agent.
--
-- ADDITIVE. Two new tables, IF NOT EXISTS; nothing rebuilt, nothing dropped.
-- `storefront_event_marks.event` is CHECK-constrained to the five traffic
-- events (0125:91) and is never rebuilt, so the vitals dedupe has a marks
-- table of its own rather than a sixth event name.
--
-- THE PRIVACY STATEMENT (owner question §D.4): daily buckets only; one sample
-- per visitor per Baghdad day per device; the same Do-Not-Track / Global
-- Privacy Control opt-out as the traffic beacon; a 28-day window; no word is
-- shown under 50 samples; the store's own owner is never counted.
--
-- ---------------------------------------------------------------------------
--  1. THE STORE'S DAY, PER DEVICE
-- ---------------------------------------------------------------------------
--   samples        beacons counted (one per visitor per day per device)
--   <vital>_good / _ok / _poor
--                  how many of those samples fell in each bucket; a beacon that
--                  carried no reading for a vital (no interaction, so no INP)
--                  adds to none of that vital's three — so a vital's total is
--                  its own count, not `samples`
--   lcp_sum_ms, ttfb_sum_ms
--                  sums for a mean beside the bucket word; never a p75 (the
--                  75th percentile is reported as the BUCKET holding it —
--                  workspace §4.8: «a word, never an interpolated number»)
-- Days are BAGHDAD calendar days (worker/lib/baghdadTime.ts). The store's
-- deletion cascades; the day rows are the history and are never pruned.
CREATE TABLE IF NOT EXISTS storefront_vitals_daily (
  store_id TEXT NOT NULL REFERENCES merchant_stores(id) ON DELETE CASCADE,
  day TEXT NOT NULL,                          -- YYYY-MM-DD, Baghdad
  device TEXT NOT NULL CHECK (device IN ('phone','desktop')),
  samples INTEGER NOT NULL DEFAULT 0,
  lcp_good INTEGER NOT NULL DEFAULT 0,
  lcp_ok INTEGER NOT NULL DEFAULT 0,
  lcp_poor INTEGER NOT NULL DEFAULT 0,
  inp_good INTEGER NOT NULL DEFAULT 0,
  inp_ok INTEGER NOT NULL DEFAULT 0,
  inp_poor INTEGER NOT NULL DEFAULT 0,
  cls_good INTEGER NOT NULL DEFAULT 0,
  cls_ok INTEGER NOT NULL DEFAULT 0,
  cls_poor INTEGER NOT NULL DEFAULT 0,
  ttfb_good INTEGER NOT NULL DEFAULT 0,
  ttfb_ok INTEGER NOT NULL DEFAULT 0,
  ttfb_poor INTEGER NOT NULL DEFAULT 0,
  lcp_sum_ms INTEGER NOT NULL DEFAULT 0,
  ttfb_sum_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (store_id, day, device)
);

-- ---------------------------------------------------------------------------
--  2. THE ONCE-PER-DAY MARKS (the dedupe; short-lived)
-- ---------------------------------------------------------------------------
-- `visitor` is the salted hash the traffic beacon also uses — SHA-256 of that
-- day's random salt (storefront_salts, 0125), the store and the sender (the
-- signed-in account, else address + user agent) — so a stored mark cannot be
-- linked to a person or to the same visitor on another day. `nonce` is the
-- request that wrote the mark: the day's counters, in the SAME batch, add 1
-- only when a mark carrying THIS request's nonce exists, i.e. this request
-- created it (the exact pattern of storefront_event_marks). Pruned with the
-- event marks once the day is over (worker/lib/storefrontAnalytics.ts
-- pruneStorefrontAnalytics); the day rows above are the history.
-- `net` is the traffic beacon's network cap carried over (review 2026-09-30):
-- the salted hash of an ANONYMOUS sender's network ('' for a signed-in
-- account), so one address rotating its user agent adds at most
-- ANON_VISITORS_PER_NETWORK samples to a store's day — it cannot set a
-- store's speed word or raise its «slow» attention row by itself.
CREATE TABLE IF NOT EXISTS storefront_vitals_marks (
  store_id TEXT NOT NULL,
  day TEXT NOT NULL,
  device TEXT NOT NULL,
  visitor TEXT NOT NULL,
  nonce TEXT NOT NULL,
  net TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (store_id, day, device, visitor)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_storefront_vitals_marks_day
  ON storefront_vitals_marks(day);
CREATE INDEX IF NOT EXISTS idx_storefront_vitals_marks_net
  ON storefront_vitals_marks(store_id, day, device, net)
  WHERE net <> '';
