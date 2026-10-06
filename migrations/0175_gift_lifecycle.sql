-- 0175 — THE GIFT LIFECYCLE (owner brief 2026-10-06 §1, docs/GIFTS_QUICK_BUY.md
-- §1.1, decisions D1–D6).
--
-- A gift is a REAL store product, variant, colour, quantity and sale type, granted
-- to one customer and ordered through the ordinary cart and checkout at 0 IQD —
-- never a separate gift product and never a separate gift inventory. Stock moves
-- only through the order it ends up in (D6).
--
-- Additive except for ONE table rebuild: `gift_entitlements`, because SQLite can
-- neither widen a CHECK nor drop a NOT NULL, and a manual grant has no review
-- reward (`reward_id` becomes nullable). The rebuild follows the 0141 precedent:
-- the only child table (`gift_redemptions`, a NO ACTION foreign key) is stashed
-- first — a parent row deleted under a live child leaves a deferred violation
-- that the RENAME never clears — then restored in full. Every existing row keeps
-- every byte of its eleven original columns and reads as grant_mode 'legacy'
-- with its legacy state.
--
-- The four triggers at the end name only columns no test drops, and are created
-- AFTER the rebuild because an ALTER … RENAME re-validates every trigger body.
-- A future rebuild of `orders`, `order_items` or `gift_entitlements` must
-- re-create them.
PRAGMA defer_foreign_keys = true;

-- ============================================================================
-- 1. gift_pools — THE FIVE LEVELS. One canonical row per level carries its
--    name and description in the three languages and whether it is offered.
--    The legacy `items` JSON column stays and is never read.
-- ============================================================================
ALTER TABLE gift_pools ADD COLUMN name_ckb TEXT NOT NULL DEFAULT '';
ALTER TABLE gift_pools ADD COLUMN description_ar TEXT NOT NULL DEFAULT '';
ALTER TABLE gift_pools ADD COLUMN description_en TEXT NOT NULL DEFAULT '';
ALTER TABLE gift_pools ADD COLUMN description_ckb TEXT NOT NULL DEFAULT '';
ALTER TABLE gift_pools ADD COLUMN updated_at TEXT;
ALTER TABLE gift_pools ADD COLUMN updated_by TEXT;
INSERT OR IGNORE INTO gift_pools (id, level, name_ar, name_en, name_ckb, active) VALUES
  ('gift_level_1', 1, 'المستوى الأول', 'Level 1', 'ئاستی یەکەم', 1),
  ('gift_level_2', 2, 'المستوى الثاني', 'Level 2', 'ئاستی دووەم', 1),
  ('gift_level_3', 3, 'المستوى الثالث', 'Level 3', 'ئاستی سێیەم', 1),
  ('gift_level_4', 4, 'المستوى الرابع', 'Level 4', 'ئاستی چوارەم', 1),
  ('gift_level_5', 5, 'المستوى الخامس', 'Level 5', 'ئاستی پێنجەم', 1);

-- ============================================================================
-- 2. gift_pool_items — A LEVEL'S ITEMS ARE REAL STORE PRODUCTS (D2, D3).
--    A product row is FULLY PINNED: product + option values (canonical JSON) +
--    colour + quantity + sale type (+ the pre-order route). To offer two colours
--    the admin adds two items. Items of one level are alternatives; the customer
--    picks ONE. `stock` is never read for a product row — the store's own
--    inventory decides. Legacy label-only rows keep product_id NULL: readable,
--    never offered by the new flow, and the only rows the legacy box reads.
--    No foreign key on product_id: a permanent product delete is refused while
--    an ACTIVE item names it and takes the disabled ones with it
--    (worker/lib/productDeletion.ts).
-- ============================================================================
ALTER TABLE gift_pool_items ADD COLUMN product_id TEXT;
ALTER TABLE gift_pool_items ADD COLUMN option_value_ids TEXT NOT NULL DEFAULT '[]';
ALTER TABLE gift_pool_items ADD COLUMN color_id TEXT NOT NULL DEFAULT '';
ALTER TABLE gift_pool_items ADD COLUMN qty INTEGER NOT NULL DEFAULT 1 CHECK (qty BETWEEN 1 AND 99);
ALTER TABLE gift_pool_items ADD COLUMN sale_type TEXT NOT NULL DEFAULT '' CHECK (sale_type IN ('', 'direct_sale', 'pre_order'));
ALTER TABLE gift_pool_items ADD COLUMN transport_method TEXT NOT NULL DEFAULT '' CHECK (transport_method IN ('', 'air', 'sea', 'land'));
ALTER TABLE gift_pool_items ADD COLUMN sort INTEGER NOT NULL DEFAULT 0;
ALTER TABLE gift_pool_items ADD COLUMN updated_at TEXT;
CREATE INDEX IF NOT EXISTS idx_gift_pool_items_level_sort ON gift_pool_items(level, active, sort);
CREATE INDEX IF NOT EXISTS idx_gift_pool_items_product ON gift_pool_items(product_id) WHERE product_id IS NOT NULL;

-- ============================================================================
-- 3. gift_entitlements — REBUILT (D1, D4): one table for the legacy review boxes,
--    the level grants and the product grants.
--
--    stored states   legacy: available | selected | fulfilled | cancelled
--                    new:    granted → ready_to_redeem → redeemed → ordered
--                            → fulfilled; cancelled.
--                    ADDED_TO_ORDER is DERIVED (redeemed + a cart line names
--                    the gift), never stored.
--    grant_mode      legacy | level (the customer chooses one of the level's
--                    items) | product (one product pinned by the admin).
--    gift_*          the ONE frozen selection the cart and the checkout use;
--                    `gift_snapshot` is display only (names, image, labels,
--                    the regular price when it was chosen).
--    order_*         the ONE live order; order_seq counts order attempts, so a
--                    cancelled order's line never blocks the next one.
--    version         every write moves it; every conditional UPDATE names it.
--    admin_note      internal, NEVER returned to the customer.
-- ============================================================================
CREATE TABLE _mig0175_gift_redemptions AS SELECT * FROM gift_redemptions;
DELETE FROM gift_redemptions;

CREATE TABLE gift_entitlements_new (
  id TEXT PRIMARY KEY,
  reward_id TEXT UNIQUE REFERENCES review_rewards(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  max_level INTEGER NOT NULL CHECK (max_level BETWEEN 1 AND 5),
  chosen_level INTEGER CHECK (chosen_level IS NULL OR chosen_level BETWEEN 1 AND 5),
  chosen_options TEXT NOT NULL DEFAULT '{}',
  contents TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL DEFAULT 'available' CHECK (state IN
    ('available', 'selected', 'granted', 'ready_to_redeem', 'redeemed', 'ordered', 'fulfilled', 'cancelled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  selected_at TEXT,
  fulfilled_at TEXT,
  grant_mode TEXT NOT NULL DEFAULT 'legacy' CHECK (grant_mode IN ('legacy', 'level', 'product')),
  reason TEXT NOT NULL DEFAULT 'legacy' CHECK (reason IN ('legacy', 'review', 'reward', 'compensation', 'admin_gift')),
  level INTEGER CHECK (level IS NULL OR level BETWEEN 1 AND 5),
  admin_note TEXT NOT NULL DEFAULT '',
  granted_by TEXT,
  granted_at TEXT,
  updated_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  grant_request_id TEXT,
  grant_request_hash TEXT,
  gift_item_id TEXT,
  gift_product_id TEXT,
  gift_option_value_ids TEXT NOT NULL DEFAULT '[]',
  gift_color_id TEXT NOT NULL DEFAULT '',
  gift_qty INTEGER NOT NULL DEFAULT 1 CHECK (gift_qty BETWEEN 1 AND 99),
  gift_sale_type TEXT NOT NULL DEFAULT '' CHECK (gift_sale_type IN ('', 'direct_sale', 'pre_order')),
  gift_transport_method TEXT NOT NULL DEFAULT '' CHECK (gift_transport_method IN ('', 'air', 'sea', 'land')),
  gift_snapshot TEXT NOT NULL DEFAULT '{}',
  chosen_at TEXT,
  redeemed_at TEXT,
  order_id TEXT,
  order_item_id TEXT,
  ordered_at TEXT,
  order_seq INTEGER NOT NULL DEFAULT 0 CHECK (order_seq >= 0),
  cancelled_at TEXT,
  cancelled_by TEXT,
  cancel_reason TEXT NOT NULL DEFAULT '',
  -- Legacy states belong to legacy rows and the new lifecycle to new rows; a
  -- legacy row leaves its states only by being converted in ONE update.
  CHECK (grant_mode <> 'legacy' OR state IN ('available', 'selected', 'fulfilled', 'cancelled')),
  CHECK (grant_mode = 'legacy' OR state IN ('granted', 'ready_to_redeem', 'redeemed', 'ordered', 'fulfilled', 'cancelled')),
  -- A legacy row always came from a review reward; a new row always names its level and reason.
  CHECK (grant_mode <> 'legacy' OR reward_id IS NOT NULL),
  CHECK (grant_mode = 'legacy' OR (level IS NOT NULL AND reason <> 'legacy')),
  -- Nothing past the choice without the one frozen product and sale type.
  CHECK (grant_mode = 'legacy' OR state NOT IN ('ready_to_redeem', 'redeemed', 'ordered', 'fulfilled')
         OR (gift_product_id IS NOT NULL AND gift_sale_type <> '')),
  CHECK (grant_mode <> 'product' OR gift_product_id IS NOT NULL),
  -- A pre-order travels on a route; a direct sale on none.
  CHECK (gift_sale_type <> 'pre_order' OR gift_transport_method <> ''),
  CHECK (gift_sale_type <> 'direct_sale' OR gift_transport_method = ''),
  -- An ordered gift names its order and its line.
  CHECK (state <> 'ordered' OR (order_id IS NOT NULL AND order_item_id IS NOT NULL)),
  CHECK (grant_mode = 'legacy' OR state <> 'cancelled' OR cancelled_at IS NOT NULL)
);
INSERT INTO gift_entitlements_new
  (id, reward_id, user_id, max_level, chosen_level, chosen_options, contents, state, created_at, selected_at, fulfilled_at)
SELECT id, reward_id, user_id, max_level, chosen_level, chosen_options, contents, state, created_at, selected_at, fulfilled_at
  FROM gift_entitlements;
DROP TABLE gift_entitlements;
ALTER TABLE gift_entitlements_new RENAME TO gift_entitlements;

CREATE INDEX IF NOT EXISTS idx_gift_entitlements_user ON gift_entitlements(user_id, state);
-- The order triggers below look gifts up by order on EVERY status change.
CREATE INDEX IF NOT EXISTS idx_gift_entitlements_order ON gift_entitlements(order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gift_entitlements_created ON gift_entitlements(created_at, id);
-- An admin's retried grant is the same grant (POST /api/gifts/admin/grants).
CREATE UNIQUE INDEX IF NOT EXISTS idx_gift_entitlements_grant_request
  ON gift_entitlements(grant_request_id) WHERE grant_request_id IS NOT NULL;

-- The stash is the truth for these rows: restored in full, then dropped. Plain
-- statements, not OR IGNORE: this file runs once and the stash lives only here.
INSERT INTO gift_redemptions SELECT * FROM _mig0175_gift_redemptions;
DROP TABLE _mig0175_gift_redemptions;

-- ============================================================================
-- 4. cart_items — THE GIFT CART LINE. It carries its gift and the discriminator
--    shipping_method_id = 'gift:' || gift id, so it never merges with nor
--    collides into a paid line of the same variant in idx_cart_levonis_line,
--    and every ordinary lookup (`shipping_method_id = ''`) skips it. One line
--    per gift, whatever the retries.
-- ============================================================================
ALTER TABLE cart_items ADD COLUMN gift_entitlement_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_cart_items_gift_line
  ON cart_items(gift_entitlement_id) WHERE gift_entitlement_id IS NOT NULL;

-- ============================================================================
-- 5. order_items — which gift produced this sold line, on which attempt.
--    UNIQUE per (gift, attempt): two checkouts can never both consume one gift,
--    and a new order after a cancelled one is attempt n + 1.
-- ============================================================================
ALTER TABLE order_items ADD COLUMN gift_entitlement_id TEXT;
ALTER TABLE order_items ADD COLUMN gift_order_seq INTEGER CHECK (gift_order_seq IS NULL OR gift_order_seq >= 1);
CREATE UNIQUE INDEX IF NOT EXISTS idx_order_items_gift_line
  ON order_items(gift_entitlement_id, gift_order_seq) WHERE gift_entitlement_id IS NOT NULL;

-- ============================================================================
-- 6. orders — ONE mechanism for every door that cancels or delivers an order
--    (customer cancel, admin status, stage move, expiry and Gini sweeps, the
--    courier sync), D5:
--      cancelled  → the gift was never received: back to `redeemed`, its order
--                   link cleared and order_seq kept, so it can be ordered again;
--      delivered  → `fulfilled`;
--      re-opening a cancelled order that held a gift line is refused — the gift
--                   may already sit in a new order.
--    Each transition leaves its line in the audit log, so the timeline of a gift
--    shows the order that returned it or delivered it.
-- ============================================================================
CREATE TRIGGER IF NOT EXISTS trg_orders_gift_cancelled
AFTER UPDATE OF status ON orders FOR EACH ROW
WHEN NEW.status = 'cancelled' AND OLD.status <> 'cancelled'
BEGIN
  INSERT INTO audit_log (actor_id, action, target, detail)
  SELECT NULL, 'gift.order_cancelled', g.id,
         json_object('order_id', NEW.id, 'order_item_id', g.order_item_id, 'user_id', g.user_id, 'level', g.level,
                     'product_id', g.gift_product_id, 'from', 'ordered', 'to', 'redeemed')
    FROM gift_entitlements g WHERE g.order_id = NEW.id AND g.state = 'ordered';
  UPDATE gift_entitlements
     SET state = 'redeemed', order_id = NULL, order_item_id = NULL, ordered_at = NULL,
         version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE order_id = NEW.id AND state = 'ordered';
END;

CREATE TRIGGER IF NOT EXISTS trg_orders_gift_delivered
AFTER UPDATE OF status ON orders FOR EACH ROW
WHEN NEW.status = 'delivered' AND OLD.status <> 'delivered'
BEGIN
  INSERT INTO audit_log (actor_id, action, target, detail)
  SELECT NULL, 'gift.delivered', g.id,
         json_object('order_id', NEW.id, 'order_item_id', g.order_item_id, 'user_id', g.user_id, 'level', g.level,
                     'product_id', g.gift_product_id, 'from', 'ordered', 'to', 'fulfilled')
    FROM gift_entitlements g WHERE g.order_id = NEW.id AND g.state = 'ordered';
  UPDATE gift_entitlements
     SET state = 'fulfilled', fulfilled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
         version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE order_id = NEW.id AND state = 'ordered';
END;

-- A delivery undone by the one-step-back correction (canMoveStage: a mis-tapped
-- «تم التسليم») undoes the gift's `fulfilled` with it, so a later cancellation
-- still returns the gift. A delivered order that is cancelled keeps its gift
-- `fulfilled`: it was received.
CREATE TRIGGER IF NOT EXISTS trg_orders_gift_undelivered
AFTER UPDATE OF status ON orders FOR EACH ROW
WHEN OLD.status = 'delivered' AND NEW.status NOT IN ('delivered', 'cancelled')
BEGIN
  INSERT INTO audit_log (actor_id, action, target, detail)
  SELECT NULL, 'gift.undelivered', g.id,
         json_object('order_id', NEW.id, 'order_item_id', g.order_item_id, 'user_id', g.user_id, 'level', g.level,
                     'product_id', g.gift_product_id, 'from', 'fulfilled', 'to', 'ordered')
    FROM gift_entitlements g
   WHERE g.order_id = NEW.id AND g.state = 'fulfilled' AND g.grant_mode <> 'legacy';
  UPDATE gift_entitlements
     SET state = 'ordered', fulfilled_at = NULL,
         version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE order_id = NEW.id AND state = 'fulfilled' AND grant_mode <> 'legacy';
END;

CREATE TRIGGER IF NOT EXISTS trg_orders_gift_reopen_guard
BEFORE UPDATE OF status ON orders FOR EACH ROW
WHEN OLD.status = 'cancelled' AND NEW.status <> 'cancelled'
  AND EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = NEW.id AND oi.gift_entitlement_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'GIFT_ORDER_REOPEN_REFUSED');
END;
