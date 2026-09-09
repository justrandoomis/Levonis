-- 0061 — MYSTERY POOLS, OFFERS AND ALLOCATIONS (docs/BUNDLES_MYSTERY.md §1.9)
--
-- A random-filament offer is a `products` row carrying `composition='mystery'`
-- (0058). What it adds here is WHERE the drawn item comes from — a pool of real
-- catalogue entries with weights — and WHAT WAS DRAWN, frozen for ever.
--
-- Nothing here creates a stock or reserved column: a pool entry names a real
-- product, a real option-value set and a real colour, and every availability
-- number is computed from the four real stock tables at every read (§15.2 pins
-- that with a static test). Pools come first because `mystery_offers`
-- references them.
--
-- Every statement is re-runnable: CREATE ... IF NOT EXISTS only.

-- --------------------------------------------------------------- the pools
-- 'direct' and 'preorder' are SEPARATE pools, never mixed, so a direct-sale
-- purchase can never silently become a pre-order (§7.6). Eligibility is
-- STRUCTURED — catalog ids and facet value ids — and never a product-name
-- match (§7.2).
CREATE TABLE IF NOT EXISTS mystery_pools (
  id                  TEXT PRIMARY KEY,                  -- 'mpl_<20 hex>'
  name                TEXT NOT NULL,
  kind                TEXT NOT NULL DEFAULT 'direct',    -- 'direct' | 'preorder'
  active              INTEGER NOT NULL DEFAULT 1,
  require_catalog_ids TEXT NOT NULL DEFAULT '[]',        -- JSON array of catalog ids
  require_facet_ids   TEXT NOT NULL DEFAULT '[]',        -- JSON array of facet ids
  min_available       INTEGER NOT NULL DEFAULT 1,        -- free stock an entry needs to be a candidate
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ------------------------------------------------------------- the entries
-- ON DELETE RESTRICT, symmetrical with bundle_components.member_product_id:
-- deleting a product a pool draws from must be REFUSED with the pool named,
-- never silently empty a live pool.
--
-- `weight = 0` is EXCLUDED, kept for history — which is also why the admin
-- whole-set replace deactivates instead of deleting: an entry that has ever
-- been drawn is named by mystery_allocations.pool_entry_id for ever.
CREATE TABLE IF NOT EXISTS mystery_pool_entries (
  id               TEXT PRIMARY KEY,                     -- 'mpe_<20 hex>'
  pool_id          TEXT NOT NULL REFERENCES mystery_pools(id) ON DELETE CASCADE,
  product_id       TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  option_value_ids TEXT NOT NULL DEFAULT '[]',           -- JSON, SORTED; [] = no option needed
  color_id         TEXT NOT NULL DEFAULT '',
  family_id        TEXT NOT NULL DEFAULT '',             -- a catalog/facet id — NEVER a name
  weight           INTEGER NOT NULL DEFAULT 1 CHECK (weight >= 0),
  active           INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_mystery_entries_pool
  ON mystery_pool_entries(pool_id, active, weight);
CREATE INDEX IF NOT EXISTS idx_mystery_entries_product
  ON mystery_pool_entries(product_id);

-- --------------------------------------------------------------- the offer
CREATE TABLE IF NOT EXISTS mystery_offers (
  product_id            TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  direct_pool_id        TEXT REFERENCES mystery_pools(id) ON DELETE RESTRICT,
  preorder_pool_id      TEXT REFERENCES mystery_pools(id) ON DELETE RESTRICT,
  spool_qty             INTEGER NOT NULL DEFAULT 1 CHECK (spool_qty BETWEEN 1 AND 20),
  allow_direct          INTEGER NOT NULL DEFAULT 1,
  allow_preorder        INTEGER NOT NULL DEFAULT 0,
  customer_picks_family INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- THE SECRET LIVES IN ITS OWN TABLE, and no read route joins it.
-- Keeping it on `mystery_offers` would make its safety depend on every future
-- reader remembering to enumerate columns instead of `SELECT *` — and the admin
-- offer read, the duplicate response and any export are all readers. One leaked
-- admin payload would let anyone precompute every future draw, because the seed
-- is a pure function of it. `worker/lib/mysteryDraw.ts` is the only module that
-- names this table, and a static test keeps it that way (§15.2).
CREATE TABLE IF NOT EXISTS mystery_offer_secrets (
  product_id TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  secret     TEXT NOT NULL,                              -- 64 hex from randomSeedHex()
  rotated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------------------------------------------------------- the allocation
-- THE FROZEN PICK. Never mutated: nothing ever updates product_id or color_id,
-- and a cancelled order keeps its allocation row for audit while its
-- reservation is released.
--
-- PRIMARY KEY (order_item_id, spool_index) is THE REPLAY FENCE: a replay that
-- somehow re-entered the write path collides and aborts the whole batch.
CREATE TABLE IF NOT EXISTS mystery_allocations (
  order_item_id    TEXT NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  spool_index      INTEGER NOT NULL CHECK (spool_index >= 0),
  order_id         TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  offer_product_id TEXT NOT NULL REFERENCES products(id),
  pool_id          TEXT NOT NULL REFERENCES mystery_pools(id),
  pool_entry_id    TEXT NOT NULL REFERENCES mystery_pool_entries(id),
  product_id       TEXT NOT NULL REFERENCES products(id),
  option_value_ids TEXT NOT NULL DEFAULT '[]',
  color_id         TEXT NOT NULL DEFAULT '',
  -- Frozen display, so a later rename cannot rewrite what the customer received.
  name_snapshot    TEXT NOT NULL,
  image_snapshot   TEXT NOT NULL DEFAULT '',
  variant_snapshot TEXT NOT NULL DEFAULT '',
  sale_mode        TEXT NOT NULL,                        -- 'direct' | 'preorder'
  seed             TEXT NOT NULL,                        -- 64 hex, server-held, never returned
  -- THE MILESTONE THIS ORDER WAS SOLD UNDER, frozen (§8.1).
  -- `bundle_config.reveal_stage` is one mutable row shared by every past and
  -- in-flight order; editing it must not retroactively hide a pick a customer
  -- has already seen, nor reveal every in-flight order at once.
  reveal_stage_snapshot TEXT NOT NULL,
  -- sha256 over the canonical candidate list this draw ran against, so
  -- (seed, candidates, weightedIndex) reproduces the winner years later.
  candidates_sha256 TEXT NOT NULL,
  revealed_at      TEXT,                                 -- NULL until the milestone is crossed
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (order_item_id, spool_index)
);

-- WHY THIS TABLE: the outcome is a function of (seed, candidate list, weights),
-- and both the list and the weights change continuously with stock and admin
-- edits. Without the inputs, nobody — including the owner — can ever verify
-- that a past draw of an expensive filament was fair, which is the only thing
-- an audit trail for a randomised money mechanism exists to provide. One row
-- per LINE rather than per spool.
CREATE TABLE IF NOT EXISTS mystery_draw_audits (
  order_id         TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  offer_product_id TEXT NOT NULL,
  cart_item_id     TEXT NOT NULL,
  pool_id          TEXT NOT NULL,
  -- [{entry_id, product_id, weight, available}], sorted by entry_id — the
  -- canonical form whose sha256 is on every allocation this line produced.
  candidates       TEXT NOT NULL,
  candidates_sha256 TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (order_id, offer_product_id, cart_item_id)
);
CREATE INDEX IF NOT EXISTS idx_mystery_alloc_order   ON mystery_allocations(order_id);
CREATE INDEX IF NOT EXISTS idx_mystery_alloc_product ON mystery_allocations(product_id, color_id);
CREATE INDEX IF NOT EXISTS idx_mystery_alloc_entry   ON mystery_allocations(pool_entry_id, created_at);
