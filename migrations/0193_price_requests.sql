-- 0193 — «طلب السعر» (DECISIONS row 239 point 4; row 240). Signed-in customers only. One row per
-- (person, product, selection): a repeat tap is an UPDATE of the same row (click_count + 1), never a new row,
-- so the distinct-requester count cannot be inflated. Touches no order, cart, wallet, reservation or money table.
--
-- ADDITIVE ONLY: two new tables and their indexes. No existing table is altered, no row is updated or
-- deleted, and no trigger is put on an existing table. A database without this migration answers the
-- customer doors 503 PRICE_REQUESTS_UNAVAILABLE and the admin reads fall back (worker/lib/priceRequests.ts).
-- The REFERENCES are declarative: D1 does not enforce foreign keys; worker/lib/productDeletion.ts deletes
-- the rows of both tables before a product row.
CREATE TABLE IF NOT EXISTS product_price_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  -- The canonical SKU key (packages/pricing/src/skuChannel.ts skuComboKey): the empty string is the product
  -- itself (an option-less product), o:<id>|…|c:<id> otherwise. Empty never means unknown (the 0092 sentinel
  -- rule: NOT NULL so the UNIQUE index below really constrains every row).
  selection TEXT NOT NULL DEFAULT '' CHECK (length(selection) <= 400 AND (selection = '' OR selection GLOB 'o:?*' OR selection GLOB 'c:?*')),
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','priced','notified','closed')),
  close_reason TEXT NOT NULL DEFAULT '' CHECK (close_reason IN ('','withdrawn','priced')),
  notify INTEGER NOT NULL DEFAULT 0 CHECK (notify IN (0,1)),
  -- Bumped on every reopen; part of the notification event key.
  cycle INTEGER NOT NULL DEFAULT 1 CHECK (cycle >= 1),
  click_count INTEGER NOT NULL DEFAULT 1 CHECK (click_count >= 1),
  first_requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- The latest (re)open; a repeat tap does NOT move it.
  requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_clicked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- The cursor of the sweep.
  checked_at TEXT NOT NULL DEFAULT '',
  priced_at TEXT NOT NULL DEFAULT '',
  notified_at TEXT NOT NULL DEFAULT '',
  closed_at TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_price_requests_target ON product_price_requests(user_id, product_id, selection);
CREATE INDEX IF NOT EXISTS idx_price_requests_open ON product_price_requests(product_id, selection, user_id) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS idx_price_requests_user ON product_price_requests(user_id, state, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_price_requests_sweep ON product_price_requests(checked_at, product_id) WHERE state IN ('open','priced');

-- Per-product aggregates, RECOMPUTED FROM SOURCE inside the same db.batch as every write (never incremented),
-- so they are exact under concurrency (D1 serialises batches). Read by the ORDER BY of the admin queue and the
-- products-list sort; carries the claim columns of the admin digest.
CREATE TABLE IF NOT EXISTS product_price_request_stats (
  product_id TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  -- COUNT(DISTINCT user_id) over open rows.
  requesters INTEGER NOT NULL DEFAULT 0 CHECK (requesters >= 0),
  -- COUNT(DISTINCT selection) over open rows.
  selections INTEGER NOT NULL DEFAULT 0 CHECK (selections >= 0),
  -- SUM(click_count) over open rows (the separate click counter).
  clicks INTEGER NOT NULL DEFAULT 0 CHECK (clicks >= 0),
  -- MAX(requested_at) over open rows.
  last_request_at TEXT NOT NULL DEFAULT '',
  digest_requesters INTEGER NOT NULL DEFAULT 0 CHECK (digest_requesters >= 0),
  digest_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_price_request_stats_rank ON product_price_request_stats(requesters DESC, last_request_at DESC);
