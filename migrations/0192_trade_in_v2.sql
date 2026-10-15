-- 0192 — SERVICES V2, S-P2: TRADE-IN V2 (Services plan §2.3 S-P2, §0 corrections 4
-- and 5, §1.2, §1.3, §2.4; docs/DECISIONS.md row 238, following rows 223, 227,
-- 228 and 237).
--
-- Additive only: nullable (or defaulted) ADD COLUMNs on trade_in_rule_sets,
-- trade_in_requests, trade_in_components and trade_in_photos; four NEW tables
-- (trade_in_valuations and trade_in_component_refs are the owner's private
-- record; trade_in_stock and trade_in_credit_reissues are append-only); new
-- triggers. No row is updated or deleted by this file; no CHECK is widened; no
-- table is rebuilt; the only UNIQUE rules are on the new, empty tables.
--
-- THE TRIGGERS REFUSE NEW WRITES ONLY. A credit minted before this file (on
-- photos, before the device reached the shop) stays exactly as it is; it just
-- cannot be SPENT (or reclaimed by a reopen) until the device's intake is
-- recorded (8). A delivered order that completed a trade-in is returned, never
-- cancelled (9). Cancelling an undelivered order that spent a COMPLETED
-- request's credit gives the same coupon back — 30 days the first time, the
-- time it had left after that (10, row 237); 0191's
-- trg_orders_coupon_released releases the use in the same statement — neither
-- trigger reads what the other writes.
--
-- PRIVATE: trade_in_valuations (resale, costs, margin, the store's cap) and
-- trade_in_component_refs (the owner's reference prices) are read only by the
-- owner's cost-read doors, by named columns (worker/lib/tradeInOffer.ts).
--
-- Every CREATE carries IF NOT EXISTS: those are the statements
-- scripts/migrate-check.mjs re-runs to prove the file is idempotent.

-- 1. Owner-tunable offer parameters per family (NULL = packages/pricing/src/tradeInOffer.ts default)
ALTER TABLE trade_in_rule_sets ADD COLUMN resale_bp INTEGER CHECK (resale_bp IS NULL OR resale_bp BETWEEN 0 AND 10000);
ALTER TABLE trade_in_rule_sets ADD COLUMN handling_iqd INTEGER CHECK (handling_iqd IS NULL OR handling_iqd BETWEEN 0 AND 10000000);
ALTER TABLE trade_in_rule_sets ADD COLUMN warranty_reserve_bp INTEGER CHECK (warranty_reserve_bp IS NULL OR warranty_reserve_bp BETWEEN 0 AND 1000);
ALTER TABLE trade_in_rule_sets ADD COLUMN margin_bp INTEGER CHECK (margin_bp IS NULL OR margin_bp BETWEEN 0 AND 10000);
ALTER TABLE trade_in_rule_sets ADD COLUMN margin_min_iqd INTEGER CHECK (margin_min_iqd IS NULL OR margin_min_iqd BETWEEN 0 AND 100000000);
ALTER TABLE trade_in_rule_sets ADD COLUMN max_offer_bp INTEGER CHECK (max_offer_bp IS NULL OR max_offer_bp BETWEEN 0 AND 9500);
ALTER TABLE trade_in_rule_sets ADD COLUMN offer_rounding_iqd INTEGER CHECK (offer_rounding_iqd IS NULL OR offer_rounding_iqd BETWEEN 1 AND 1000000);
ALTER TABLE trade_in_rule_sets ADD COLUMN min_offer_iqd INTEGER CHECK (min_offer_iqd IS NULL OR min_offer_iqd BETWEEN 0 AND 100000000);

-- 2. Request facts: what the customer and the desk read (never a private figure)
ALTER TABLE trade_in_requests ADD COLUMN valuation_version INTEGER NOT NULL DEFAULT 1 CHECK (valuation_version IN (1, 2));
ALTER TABLE trade_in_requests ADD COLUMN paid_net_iqd INTEGER CHECK (paid_net_iqd IS NULL OR paid_net_iqd >= 0);
ALTER TABLE trade_in_requests ADD COLUMN now_price_iqd INTEGER CHECK (now_price_iqd IS NULL OR now_price_iqd >= 0);
ALTER TABLE trade_in_requests ADD COLUMN now_price_channel TEXT CHECK (now_price_channel IS NULL OR now_price_channel IN ('direct_sale','pre_order_air','pre_order_sea','pre_order_land'));
ALTER TABLE trade_in_requests ADD COLUMN offer_iqd INTEGER CHECK (offer_iqd IS NULL OR offer_iqd >= 0);
ALTER TABLE trade_in_requests ADD COLUMN offer_at TEXT;
ALTER TABLE trade_in_requests ADD COLUMN offer_expires_at TEXT;
ALTER TABLE trade_in_requests ADD COLUMN ceiling_iqd INTEGER CHECK (ceiling_iqd IS NULL OR ceiling_iqd >= 0);
ALTER TABLE trade_in_requests ADD COLUMN ceiling_at TEXT;
ALTER TABLE trade_in_requests ADD COLUMN above_ceiling INTEGER NOT NULL DEFAULT 0 CHECK (above_ceiling IN (0, 1));
ALTER TABLE trade_in_requests ADD COLUMN intake_at TEXT;
ALTER TABLE trade_in_requests ADD COLUMN intake_by TEXT;
ALTER TABLE trade_in_requests ADD COLUMN intake_serial_norm TEXT;
ALTER TABLE trade_in_requests ADD COLUMN intake_serial_match TEXT CHECK (intake_serial_match IS NULL OR intake_serial_match IN ('match','mismatch','unrecorded','not_applicable'));
ALTER TABLE trade_in_requests ADD COLUMN intake_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE trade_in_requests ADD COLUMN handover TEXT CHECK (handover IS NULL OR handover IN ('store','pickup'));
ALTER TABLE trade_in_requests ADD COLUMN pickup_fee_iqd INTEGER NOT NULL DEFAULT 0 CHECK (pickup_fee_iqd >= 0);
ALTER TABLE trade_in_requests ADD COLUMN device_returned_at TEXT;
ALTER TABLE trade_in_requests ADD COLUMN device_returned_by TEXT;
CREATE INDEX IF NOT EXISTS idx_trade_in_requests_offer_expiry ON trade_in_requests(status, offer_expires_at);
CREATE INDEX IF NOT EXISTS idx_trade_in_requests_intake ON trade_in_requests(intake_at, status);

ALTER TABLE trade_in_components ADD COLUMN intake_inputs_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE trade_in_photos ADD COLUMN phase TEXT NOT NULL DEFAULT 'customer' CHECK (phase IN ('customer','intake'));
ALTER TABLE trade_in_photos ADD COLUMN proves TEXT NOT NULL DEFAULT '' CHECK (length(proves) <= 40);

-- 3. The owner's valuation record: one row per computation (submit, intake, override, cutover), never edited.
--    PRIVATE: never joined by a customer or staff read; no SELECT * (worker/lib/tradeInOffer.ts names columns).
CREATE TABLE IF NOT EXISTS trade_in_valuations (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES trade_in_requests(id),
  phase TEXT NOT NULL CHECK (phase IN ('submit','intake','override','cutover')),
  offer_iqd INTEGER CHECK (offer_iqd IS NULL OR offer_iqd >= 0),
  ceiling_iqd INTEGER CHECK (ceiling_iqd IS NULL OR ceiling_iqd >= 0),
  store_cap_iqd INTEGER,
  expected_margin_iqd INTEGER,
  params_json TEXT NOT NULL DEFAULT '{}',
  components_json TEXT NOT NULL DEFAULT '[]',
  actor_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trade_in_valuations_request ON trade_in_valuations(request_id, created_at);
CREATE TRIGGER IF NOT EXISTS trade_in_valuations_no_update BEFORE UPDATE ON trade_in_valuations
BEGIN SELECT RAISE(ABORT, 'TRADE_IN_VALUATION_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS trade_in_valuations_no_delete BEFORE DELETE ON trade_in_valuations
BEGIN SELECT RAISE(ABORT, 'TRADE_IN_VALUATION_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS trade_in_valuations_no_reinsert BEFORE INSERT ON trade_in_valuations
WHEN EXISTS (SELECT 1 FROM trade_in_valuations v WHERE v.id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'TRADE_IN_VALUATION_IMMUTABLE'); END;

-- 4. The owner's component references (B.4 rules 2–4), private.
CREATE TABLE IF NOT EXISTS trade_in_component_refs (
  product_id TEXT NOT NULL,
  option_value_id TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK (role IN ('device','ams')),
  ref_product_id TEXT,
  ref_price_usd TEXT CHECK (ref_price_usd IS NULL OR (ref_price_usd GLOB '[0-9]*' AND ref_price_usd NOT GLOB '*[^0-9.]*'
                   AND ref_price_usd NOT GLOB '*.*.*' AND ref_price_usd NOT GLOB '*.' AND ref_price_usd NOT GLOB '*.???*'
                   AND length(ref_price_usd) <= 12 AND CAST(ref_price_usd AS REAL) > 0)),
  updated_by TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (product_id, option_value_id, role),
  CHECK (ref_product_id IS NOT NULL OR ref_price_usd IS NOT NULL)
);

-- 5. Provenance: which lot a trade-in became (one row per request, never updated, never deleted).
CREATE TABLE IF NOT EXISTS trade_in_stock (
  request_id TEXT PRIMARY KEY REFERENCES trade_in_requests(id),
  lot_id TEXT NOT NULL UNIQUE REFERENCES inventory_lots(id),
  product_id TEXT NOT NULL,
  source_product_id TEXT,
  serial_norm TEXT,
  cost_basis_iqd INTEGER NOT NULL CHECK (cost_basis_iqd >= 0),
  order_id TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS trade_in_stock_no_update BEFORE UPDATE ON trade_in_stock
BEGIN SELECT RAISE(ABORT, 'TRADE_IN_STOCK_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS trade_in_stock_no_delete BEFORE DELETE ON trade_in_stock
BEGIN SELECT RAISE(ABORT, 'TRADE_IN_STOCK_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS trade_in_stock_no_reinsert BEFORE INSERT ON trade_in_stock
WHEN EXISTS (SELECT 1 FROM trade_in_stock s WHERE s.request_id = NEW.request_id OR s.lot_id = NEW.lot_id)
BEGIN SELECT RAISE(ABORT, 'TRADE_IN_STOCK_IMMUTABLE'); END;

-- 6. A credit given back (row 237; plan §1.2): one row per (request, order that gave it back), append-only.
CREATE TABLE IF NOT EXISTS trade_in_credit_reissues (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES trade_in_requests(id),
  coupon_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('order_cancelled','returned')),
  return_case_id TEXT,
  amount_iqd INTEGER NOT NULL CHECK (amount_iqd >= 0),
  ends_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (request_id, order_id)
);
CREATE TRIGGER IF NOT EXISTS trade_in_credit_reissues_no_update BEFORE UPDATE ON trade_in_credit_reissues
BEGIN SELECT RAISE(ABORT, 'TRADE_IN_REISSUE_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS trade_in_credit_reissues_no_delete BEFORE DELETE ON trade_in_credit_reissues
BEGIN SELECT RAISE(ABORT, 'TRADE_IN_REISSUE_IMMUTABLE'); END;

-- 7. Intake happens once (B.9).
CREATE TRIGGER IF NOT EXISTS trg_trade_in_intake_once
BEFORE UPDATE OF intake_at ON trade_in_requests
WHEN OLD.intake_at IS NOT NULL AND NEW.intake_at IS NOT OLD.intake_at
BEGIN SELECT RAISE(ABORT, 'TRADE_IN_ALREADY_RECEIVED'); END;

-- 8. Decision 2 in the database: no trade-in credit is spent (or reclaimed by a reopen) before the device is received.
CREATE TRIGGER IF NOT EXISTS trg_trade_in_credit_needs_intake
BEFORE INSERT ON coupon_redemptions
WHEN EXISTS (SELECT 1 FROM coupons c JOIN trade_in_requests t ON t.id = c.trade_in_id
              WHERE c.id = NEW.coupon_id AND t.intake_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'TRADE_IN_DEVICE_NOT_RECEIVED'); END;
CREATE TRIGGER IF NOT EXISTS trg_trade_in_credit_needs_intake_reclaim
BEFORE UPDATE OF state ON coupon_redemptions
WHEN NEW.state = 'active' AND OLD.state <> 'active'
 AND EXISTS (SELECT 1 FROM coupons c JOIN trade_in_requests t ON t.id = c.trade_in_id
              WHERE c.id = NEW.coupon_id AND t.intake_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'TRADE_IN_DEVICE_NOT_RECEIVED'); END;

-- 9. A delivered order that completed a trade-in is returned, never cancelled (the device is already stock).
--    «Delivered» is the stamp, not the stage: a stage moved one step back to undo a mis-tap keeps
--    `delivered_at`, so delivered → out_for_delivery → cancelled is refused too (review F-3).
CREATE TRIGGER IF NOT EXISTS trg_orders_tradein_delivered_cancel
BEFORE UPDATE OF status ON orders
WHEN NEW.status = 'cancelled' AND OLD.status <> 'cancelled'
 AND (OLD.status = 'delivered' OR NULLIF(OLD.delivered_at, '') IS NOT NULL)
 AND EXISTS (SELECT 1 FROM coupon_redemptions r JOIN coupons c ON c.id = r.coupon_id
              JOIN trade_in_requests t ON t.id = c.trade_in_id
             WHERE r.order_id = NEW.id AND t.status = 'completed')
BEGIN SELECT RAISE(ABORT, 'TRADE_IN_ORDER_DELIVERED'); END;

-- 10. Row 237: cancelling (any door) an undelivered order that spent a COMPLETED request's credit gives the
--     same coupon back. 0191's trg_orders_coupon_released releases the use (both fire; neither reads the
--     other's write: this one selects the redemption by order, whatever its state).
--     THE END IS GIVEN ONCE (review F-2): the first credit given back for a request lives 30 days; a
--     credit given back again (the re-issued credit spent on an order that was then cancelled) keeps
--     the time it had left — the previous re-issue's end plus the time this order held it, never more
--     than 30 days from now — so cancelling an order cannot renew it.
CREATE TRIGGER IF NOT EXISTS trg_orders_tradein_reissue_on_cancel
AFTER UPDATE OF status ON orders
WHEN NEW.status = 'cancelled' AND OLD.status NOT IN ('cancelled', 'delivered') AND NULLIF(OLD.delivered_at, '') IS NULL
BEGIN
  INSERT INTO trade_in_credit_reissues (id, request_id, coupon_id, order_id, reason, return_case_id, amount_iqd, ends_at, created_at)
  SELECT 'tcr_' || lower(hex(randomblob(10))), t.id, c.id, NEW.id, 'order_cancelled', NULL, COALESCE(t.credit_iqd, 0),
         -- No earlier re-issue: julianday(NULL) makes the carried end NULL, MIN() NULL, and COALESCE
         -- falls back to 30 days (kept free of conditional blocks: Wrangler's statement splitter, sqlSplit test).
         COALESCE(
           MIN(strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+30 days'),
               strftime('%Y-%m-%dT%H:%M:%fZ',
                        julianday((SELECT MAX(p.ends_at) FROM trade_in_credit_reissues p WHERE p.request_id = t.id AND p.order_id <> NEW.id))
                        + MAX(0, COALESCE(julianday('now') - julianday(NEW.created_at), 0)))),
           strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+30 days')),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM coupon_redemptions r JOIN coupons c ON c.id = r.coupon_id JOIN trade_in_requests t ON t.id = c.trade_in_id
   WHERE r.order_id = NEW.id AND t.status = 'completed'
     AND NOT EXISTS (SELECT 1 FROM trade_in_credit_reissues x WHERE x.request_id = t.id AND x.order_id = NEW.id);
  UPDATE coupons
     SET ends_at = (SELECT x.ends_at FROM trade_in_credit_reissues x WHERE x.request_id = coupons.trade_in_id AND x.order_id = NEW.id)
   WHERE trade_in_id IS NOT NULL
     AND id IN (SELECT r.coupon_id FROM coupon_redemptions r WHERE r.order_id = NEW.id)
     AND EXISTS (SELECT 1 FROM trade_in_credit_reissues x WHERE x.request_id = coupons.trade_in_id AND x.order_id = NEW.id);
  INSERT INTO trade_in_events (id, request_id, actor_id, actor_role, action, from_status, to_status, detail_json, created_at)
  SELECT 'tie_' || lower(hex(randomblob(10))), x.request_id, NULL, 'system', 'credit_reissued', 'completed', 'completed',
         json_object('order_id', NEW.id, 'coupon_id', x.coupon_id, 'ends_at', x.ends_at, 'reason', x.reason),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM trade_in_credit_reissues x
   WHERE x.order_id = NEW.id AND x.reason = 'order_cancelled'
     AND NOT EXISTS (SELECT 1 FROM trade_in_events e WHERE e.request_id = x.request_id AND e.action = 'credit_reissued'
                       AND json_valid(e.detail_json) AND json_extract(e.detail_json, '$.order_id') = NEW.id);
END;
