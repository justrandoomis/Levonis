-- 0165 — REVIEWS AND PRINTER GIFTS (plan of record: docs/REVIEWS_GIFTS.md).
--
-- Additive except for ONE table rebuild: `gift_entitlements`, because SQLite
-- cannot widen a CHECK and the gift lifecycle needs new states
-- (code_issued → redeemed_ready_to_order → ordered → fulfilled). The rebuild
-- follows the 0141 precedent: the only child table (gift_redemptions, a
-- NO ACTION foreign key) is stashed first — D1 fires foreign-key checks on
-- DROP TABLE, and a deferred violation left by the DROP is never cleared by
-- the RENAME — then restored in full. Every row, the index and the UNIQUE of
-- gift_entitlements survive; legacy rows keep their states and read as
-- grant_mode 'legacy'.
--
-- The number 0165 is free on BOTH the live line (…0152) and the development
-- line (…0161, parked …0164). Nothing here touches a table those lines alter:
-- in particular it does NOT add file_objects.sha256/purpose (0156 on the
-- development line does); review media keeps its digest in the R2 object's
-- customMetadata and in reviews.media JSON instead.
--
-- Triggers below name ONLY columns no test drops (see
-- tests/checkoutSchemaResilience.test.ts, tests/cartServerError.test.ts,
-- tests/financeLedger.test.ts), and are created AFTER the rebuild because an
-- ALTER … RENAME re-validates every trigger body. A future rebuild of
-- cart_items, order_items (never — it is the sales history) or orders must
-- re-create the triggers of this file.
PRAGMA defer_foreign_keys = true;

-- ============================================================================
-- 1. review_rewards — the reward names its unit, order, line and product.
--    Plain TEXT snapshot pointers (the warranty_receipts precedent), NULL on
--    legacy rows. ONE printer-gift reward per physical unit, in every state:
--    a rejected gift still spends the unit.
-- ============================================================================
ALTER TABLE review_rewards ADD COLUMN unit_id TEXT;
ALTER TABLE review_rewards ADD COLUMN order_id TEXT;
ALTER TABLE review_rewards ADD COLUMN order_item_id TEXT;
ALTER TABLE review_rewards ADD COLUMN product_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_review_rewards_printer_unit
  ON review_rewards(unit_id) WHERE kind = 'printer_gift' AND unit_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_review_rewards_queue ON review_rewards(kind, state, created_at);

-- ============================================================================
-- 2. gift_pool_items — the level items become REAL store products. Legacy
--    label-only rows keep product_id NULL and are shown read-only.
--    `option_value_ids` / `color_id` / `transport_method` are the ADMIN'S PINS;
--    `allowed_*` is the subset the customer may pick from for the groups (or
--    the colour) left unpinned. `stock` is never read for product rows: real
--    inventory decides.
-- ============================================================================
ALTER TABLE gift_pool_items ADD COLUMN product_id TEXT REFERENCES products(id);
ALTER TABLE gift_pool_items ADD COLUMN sale_type TEXT NOT NULL DEFAULT '' CHECK (sale_type IN ('', 'direct_sale', 'pre_order'));
ALTER TABLE gift_pool_items ADD COLUMN option_value_ids TEXT NOT NULL DEFAULT '[]';
ALTER TABLE gift_pool_items ADD COLUMN color_id TEXT NOT NULL DEFAULT '';
ALTER TABLE gift_pool_items ADD COLUMN transport_method TEXT NOT NULL DEFAULT '';
ALTER TABLE gift_pool_items ADD COLUMN allowed_option_value_ids TEXT NOT NULL DEFAULT '[]';
ALTER TABLE gift_pool_items ADD COLUMN allowed_color_ids TEXT NOT NULL DEFAULT '[]';
ALTER TABLE gift_pool_items ADD COLUMN sort INTEGER NOT NULL DEFAULT 0;
ALTER TABLE gift_pool_items ADD COLUMN updated_at TEXT;
CREATE INDEX IF NOT EXISTS idx_gift_pool_items_level_sort ON gift_pool_items(level, active, sort);
CREATE INDEX IF NOT EXISTS idx_gift_pool_items_product ON gift_pool_items(product_id) WHERE product_id IS NOT NULL;

-- ============================================================================
-- 3. gift_entitlements — REBUILT: one state machine, the code verifier, the
--    frozen gift, and the order link.
--
--    state          legacy: available | selected | fulfilled | cancelled
--                   new:    code_issued → redeemed_ready_to_order → ordered
--                           → fulfilled; cancelled. `in_cart` is DERIVED from
--                           cart_items.gift_entitlement_id, never stored.
--    code_*         the 6-digit code is NEVER stored: code_verifier is a
--                   PBKDF2 verifier (worker/lib/gifts/codes.ts). code_state
--                   none | issued | redeemed | revoked; code_attempts counts
--                   tries (≥ 5 = locked until the admin re-issues).
--    gift_*         the chosen item frozen for the cart and the checkout;
--                   gift_snapshot is the display + rules frozen at issue.
--    order_*        the ONE live order; order_seq counts order attempts so a
--                   cancelled order's line never blocks the next one.
-- ============================================================================
CREATE TABLE _mig0165_gift_redemptions AS SELECT * FROM gift_redemptions;
DELETE FROM gift_redemptions;

CREATE TABLE gift_entitlements_new (
  id TEXT PRIMARY KEY,
  reward_id TEXT NOT NULL UNIQUE REFERENCES review_rewards(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  max_level INTEGER NOT NULL CHECK (max_level BETWEEN 1 AND 5),
  chosen_level INTEGER CHECK (chosen_level IS NULL OR chosen_level BETWEEN 1 AND 5),
  chosen_options TEXT NOT NULL DEFAULT '{}',
  contents TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL DEFAULT 'available' CHECK (state IN
    ('available', 'selected', 'code_issued', 'redeemed_ready_to_order', 'ordered', 'fulfilled', 'cancelled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  selected_at TEXT,
  fulfilled_at TEXT,
  grant_mode TEXT NOT NULL DEFAULT 'legacy' CHECK (grant_mode IN ('legacy', 'level', 'manual')),
  gift_snapshot TEXT NOT NULL DEFAULT '{}',
  gift_item_ref TEXT NOT NULL DEFAULT '',
  gift_product_id TEXT,
  gift_option_value_ids TEXT NOT NULL DEFAULT '[]',
  gift_color_id TEXT NOT NULL DEFAULT '',
  gift_sale_type TEXT NOT NULL DEFAULT '' CHECK (gift_sale_type IN ('', 'direct_sale', 'pre_order')),
  gift_transport_method TEXT NOT NULL DEFAULT '',
  code_verifier TEXT,
  code_state TEXT NOT NULL DEFAULT 'none' CHECK (code_state IN ('none', 'issued', 'redeemed', 'revoked')),
  code_attempts INTEGER NOT NULL DEFAULT 0 CHECK (code_attempts >= 0),
  code_version INTEGER NOT NULL DEFAULT 0 CHECK (code_version >= 0),
  code_request_id TEXT,
  code_issued_at TEXT,
  code_issued_by TEXT,
  code_redeemed_at TEXT,
  code_revoked_at TEXT,
  order_id TEXT,
  order_item_id TEXT,
  ordered_at TEXT,
  order_seq INTEGER NOT NULL DEFAULT 0 CHECK (order_seq >= 0),
  cancelled_at TEXT,
  cancelled_by TEXT,
  cancel_reason TEXT NOT NULL DEFAULT '',
  updated_at TEXT,
  -- Legacy states belong to legacy rows only, and a legacy row never enters
  -- the new lifecycle except by being converted in one UPDATE.
  CHECK (grant_mode = 'legacy' OR state NOT IN ('available', 'selected')),
  CHECK (grant_mode <> 'legacy' OR state IN ('available', 'selected', 'fulfilled', 'cancelled')),
  -- A live code always has its verifier; a code_issued gift always has a code
  -- (issued, or revoked awaiting the re-issue).
  CHECK (code_state <> 'issued' OR code_verifier IS NOT NULL),
  CHECK (state <> 'code_issued' OR code_state IN ('issued', 'revoked')),
  -- Nothing past the code without the code having been redeemed.
  CHECK (grant_mode = 'legacy' OR state NOT IN ('redeemed_ready_to_order', 'ordered', 'fulfilled') OR code_state = 'redeemed'),
  -- An ordered gift names its order, its line and its product.
  CHECK (state <> 'ordered' OR (order_id IS NOT NULL AND order_item_id IS NOT NULL AND ordered_at IS NOT NULL AND gift_product_id IS NOT NULL)),
  CHECK (grant_mode = 'legacy' OR state <> 'cancelled' OR cancelled_at IS NOT NULL)
);
INSERT INTO gift_entitlements_new
  (id, reward_id, user_id, max_level, chosen_level, chosen_options, contents, state, created_at, selected_at, fulfilled_at)
SELECT id, reward_id, user_id, max_level, chosen_level, chosen_options, contents, state, created_at, selected_at, fulfilled_at
  FROM gift_entitlements;
DROP TABLE gift_entitlements;
ALTER TABLE gift_entitlements_new RENAME TO gift_entitlements;

CREATE INDEX IF NOT EXISTS idx_gift_entitlements_user ON gift_entitlements(user_id, state);
CREATE INDEX IF NOT EXISTS idx_gift_entitlements_order ON gift_entitlements(order_id) WHERE order_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_gift_entitlements_order_item
  ON gift_entitlements(order_item_id) WHERE order_item_id IS NOT NULL;

INSERT INTO gift_redemptions SELECT * FROM _mig0165_gift_redemptions;
DROP TABLE _mig0165_gift_redemptions;

-- ============================================================================
-- 4. cart_items — the GIFT CART LINE. A gift line carries its entitlement and
--    the discriminator shipping_method_id = 'gift:<entitlement id>', so it can
--    never merge with or collide into a paid line in idx_cart_levonis_line
--    (which is NOT rebuilt — tests/cartUpsert.test.ts runs the Release-A
--    shape), and every ordinary lookup (`shipping_method_id = ''`) skips it.
--    One line per entitlement, whatever the retries. The guard refuses any
--    gift line nobody verified: qty 1, the discriminator, and an entitlement
--    of THIS user that is ready to order with THIS product.
-- ============================================================================
ALTER TABLE cart_items ADD COLUMN gift_entitlement_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_cart_items_gift_line
  ON cart_items(gift_entitlement_id) WHERE gift_entitlement_id IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS trg_cart_items_gift_line_guard
BEFORE INSERT ON cart_items FOR EACH ROW
WHEN NEW.gift_entitlement_id IS NOT NULL AND (NEW.qty <> 1
  OR NEW.shipping_method_id IS NOT ('gift:' || NEW.gift_entitlement_id)
  OR NOT EXISTS (SELECT 1 FROM gift_entitlements g
                  WHERE g.id = NEW.gift_entitlement_id AND g.user_id = NEW.user_id
                    AND g.state = 'redeemed_ready_to_order' AND g.gift_product_id = NEW.product_id))
BEGIN SELECT RAISE(ABORT, 'GIFT_NOT_ORDERABLE'); END;

-- ============================================================================
-- 5. order_items — which gift produced this sold line, on which attempt.
--    UNIQUE per (entitlement, attempt): two checkouts can never both consume
--    one gift, and a new order after a cancelled one is attempt n+1. The guard
--    proves inside the order batch that the entitlement is the buyer's, ready,
--    the same product, the next attempt, and the line is 1 × 0 IQD.
-- ============================================================================
ALTER TABLE order_items ADD COLUMN gift_entitlement_id TEXT;
ALTER TABLE order_items ADD COLUMN gift_order_seq INTEGER CHECK (gift_order_seq IS NULL OR gift_order_seq >= 1);
CREATE UNIQUE INDEX IF NOT EXISTS idx_order_items_gift_line
  ON order_items(gift_entitlement_id, gift_order_seq) WHERE gift_entitlement_id IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS trg_order_items_gift_line_guard
BEFORE INSERT ON order_items FOR EACH ROW
WHEN NEW.gift_entitlement_id IS NOT NULL AND (NEW.qty <> 1 OR NEW.unit_price_iqd <> 0 OR NEW.line_total_iqd <> 0
  OR NEW.gift_order_seq IS NULL
  OR NOT EXISTS (SELECT 1 FROM gift_entitlements g JOIN orders o ON o.id = NEW.order_id
                  WHERE g.id = NEW.gift_entitlement_id AND g.user_id = o.user_id
                    AND g.state = 'redeemed_ready_to_order' AND g.gift_product_id = NEW.product_id
                    AND g.order_seq + 1 = NEW.gift_order_seq))
BEGIN SELECT RAISE(ABORT, 'GIFT_NOT_ORDERABLE'); END;

-- ============================================================================
-- 6. orders — ONE mechanism for every door that cancels or delivers an order
--    (customer cancel, admin legacy status, stage move, expiry sweep, Gini
--    sweep, courier). A cancelled order gives its gift back as ready to order;
--    a delivered one fulfils it. An order holding a gift line cannot be
--    re-opened after cancellation (the gift may already be in a new order);
--    the customer orders it again from /gifts.
-- ============================================================================
CREATE TRIGGER IF NOT EXISTS trg_orders_cancel_returns_gift
AFTER UPDATE OF status ON orders FOR EACH ROW
WHEN NEW.status = 'cancelled' AND OLD.status <> 'cancelled'
BEGIN
  UPDATE gift_entitlements
     SET state = 'redeemed_ready_to_order', order_id = NULL, order_item_id = NULL, ordered_at = NULL,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE order_id = NEW.id AND state = 'ordered';
END;
CREATE TRIGGER IF NOT EXISTS trg_orders_reopen_gift_guard
BEFORE UPDATE OF status ON orders FOR EACH ROW
WHEN OLD.status = 'cancelled' AND NEW.status <> 'cancelled'
  AND EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = NEW.id AND oi.gift_entitlement_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'GIFT_ORDER_REOPEN_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_orders_delivered_fulfils_gift
AFTER UPDATE OF status ON orders FOR EACH ROW
WHEN NEW.status = 'delivered' AND OLD.status <> 'delivered'
BEGIN
  UPDATE gift_entitlements
     SET state = 'fulfilled', fulfilled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE order_id = NEW.id AND state = 'ordered';
END;
