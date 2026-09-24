-- ============================================================================
--  0125 — A STORE'S TRAFFIC, COUNTED ONCE PER VISITOR PER DAY, FROM ITS OWN
--         PAGES — AND NOTHING ELSE INVENTED.
-- ============================================================================
-- Wave 2 of the merchant platform (docs/MERCHANT_PLATFORM.md §4.8), stream W2-E.
--
-- NONDESTRUCTIVE. Seven defaulted ADD COLUMNs on the table 0030 created and
-- nothing ever wrote, and three new tables created IF NOT EXISTS. Nothing is
-- dropped or rebuilt; no row is backfilled (there is no past traffic to
-- invent). The ADD COLUMNs cannot run twice; the runner records the file.
--
-- ---------------------------------------------------------------------------
--  WHERE THE NUMBERS COME FROM (worker/lib/storefrontAnalytics.ts)
-- ---------------------------------------------------------------------------
-- The store's pages send a first-party beacon (POST /api/storefront/events):
-- store_view, product_view, add_to_cart, checkout_started. The Worker drops
-- crawlers by user agent, never counts the store's own owner, rate-limits per
-- network, and turns the visitor into a HASH: SHA-256 of that day's random
-- salt, the store and an anonymous id (or the signed-in account). The salt is
-- deleted two days later, so a hash can never be linked to a person or to the
-- same visitor on another day — and no id, IP address or user agent is stored.
--
-- Each (store, day, event, product, visitor) is recorded ONCE
-- (`storefront_event_marks`, primary key), and the daily counters below are
-- incremented in the SAME batch only when that mark was new — so a counter is
-- exactly the number of distinct marks, a refresh loop adds nothing, and a
-- retried beacon adds nothing. Marks are pruned after the day closes; the
-- counters are the history.
--
-- Days are BAGHDAD calendar days (UTC+3, worker/lib/baghdadTime.ts), the same
-- days the finance report uses, so "today" means the merchant's today.
--
-- Orders are NOT counted here. Orders, revenue, customers, coupons and
-- governorates are read live from `orders` by the analytics API, so a
-- cancellation next week is reflected in last week's figures. That is why
-- 0030's order and money columns below (orders_count … followers_gained) stay
-- unwritten: a second, staler copy of `orders` is exactly what the analytics
-- must not become. Nothing reads them.

-- ---------------------------------------------------------------------------
--  1. THE STORE'S DAY (0030's table, finally written)
-- ---------------------------------------------------------------------------
--   store_views       distinct visitors who opened the store's own page
--   product_views     distinct (visitor, product) pairs — a visitor who opens
--                     three products is three product views
--   visitors          distinct visitors who produced any event that day
--   add_to_cart       distinct (visitor, product) adds
--   checkout_started  distinct visitors who reached the store checkout
--   source_*          the visitors of the day by where their first page of the
--                     day came from: direct (no referrer / the store itself),
--                     search, social, other. Coarse on purpose; only the host
--                     of the referrer is ever looked at, and it is not stored.
ALTER TABLE merchant_store_analytics_daily ADD COLUMN visitors INTEGER NOT NULL DEFAULT 0;
ALTER TABLE merchant_store_analytics_daily ADD COLUMN add_to_cart INTEGER NOT NULL DEFAULT 0;
ALTER TABLE merchant_store_analytics_daily ADD COLUMN checkout_started INTEGER NOT NULL DEFAULT 0;
ALTER TABLE merchant_store_analytics_daily ADD COLUMN source_direct INTEGER NOT NULL DEFAULT 0;
ALTER TABLE merchant_store_analytics_daily ADD COLUMN source_search INTEGER NOT NULL DEFAULT 0;
ALTER TABLE merchant_store_analytics_daily ADD COLUMN source_social INTEGER NOT NULL DEFAULT 0;
ALTER TABLE merchant_store_analytics_daily ADD COLUMN source_other INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
--  2. EACH PRODUCT'S DAY
-- ---------------------------------------------------------------------------
-- Keyed by product first (a product's insight reads one product's days);
-- the store index serves "top / least viewed in this range".
CREATE TABLE IF NOT EXISTS merchant_product_analytics_daily (
  store_id TEXT NOT NULL REFERENCES merchant_stores(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  day TEXT NOT NULL,                          -- YYYY-MM-DD, Baghdad
  views INTEGER NOT NULL DEFAULT 0,
  add_to_cart INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, day)
);
CREATE INDEX IF NOT EXISTS idx_product_analytics_store_day
  ON merchant_product_analytics_daily(store_id, day);

-- ---------------------------------------------------------------------------
--  3. THE ONCE-PER-DAY MARKS (the dedupe; short-lived)
-- ---------------------------------------------------------------------------
-- `visitor` is the salted hash (hex); `event` 'visit' is the visitor's first
-- event of the day in this store (it carries the day's source and the
-- anonymous-per-network cap). `nonce` is the request that wrote the mark: the
-- counters in the same batch add 1 only for a mark carrying THIS request's
-- nonce, i.e. one this request created. `net` is the salted hash of the
-- sender's network for anonymous visitors ('' for a signed-in account), used
-- only to cap how many distinct anonymous visitors one network may add to one
-- store in one day.
CREATE TABLE IF NOT EXISTS storefront_event_marks (
  store_id TEXT NOT NULL,
  day TEXT NOT NULL,
  event TEXT NOT NULL CHECK (event IN ('visit','store_view','product_view','add_to_cart','checkout_started')),
  product_id TEXT NOT NULL DEFAULT '',
  visitor TEXT NOT NULL,
  nonce TEXT NOT NULL,
  net TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (store_id, day, event, product_id, visitor)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_storefront_marks_net
  ON storefront_event_marks(store_id, day, net)
  WHERE event = 'visit' AND net <> '';
CREATE INDEX IF NOT EXISTS idx_storefront_marks_day
  ON storefront_event_marks(day);

-- ---------------------------------------------------------------------------
--  4. THE DAILY SALT
-- ---------------------------------------------------------------------------
-- One random value per Baghdad day, created by the first beacon of the day
-- (INSERT OR IGNORE, so every isolate reads the same one) and deleted by the
-- daily sweep once the day and the one after it are over.
CREATE TABLE IF NOT EXISTS storefront_salts (
  day TEXT PRIMARY KEY,
  salt TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
