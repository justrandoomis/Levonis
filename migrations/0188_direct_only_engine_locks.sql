-- 0188 — A STOCK PURCHASE PRICES DIRECT SALE ONLY; THE PRE-ORDER SIDE STAYS THE OWNER'S
-- (review 2026-10-13, DI-2; docs/DECISIONS.md rows 215 and 219).
--
-- Applying a stock purchase to a manual product adopts it into the engine for
-- direct sale only (pricing_direct_purchase.direct_only = true). The engine then
-- writes the direct-sale fulfillment cells (and SKU / variant prices), and
-- deliberately leaves every common option, colour and route field and every
-- pre-order rung untouched (worker/lib/pricingEngine/writer.ts). The 0181 locks,
-- keyed on mode = 'engine' alone, still froze those unmanaged prices for the
-- owner too, so they were managed by nobody.
--
-- Each lock below is replaced by the same trigger with one more condition: on a
-- direct-only product it does not cover the rows the direct-only engine never
-- writes (model and colour prices, pre-order fulfillment cells, routes). The
-- direct-sale fulfillment cells, the product row, variants and SKU prices stay
-- locked exactly as before, and a full adoption clears direct_only
-- (engineWrite.ts), which restores every lock. DROP/CREATE pairs only, so the
-- file replays (scripts/migrate-check.mjs, isTriggerReplacement).

DROP TRIGGER IF EXISTS engine_lock_option_values_update;
CREATE TRIGGER IF NOT EXISTS engine_lock_option_values_update
BEFORE UPDATE OF regular_price_iqd, prime_price_iqd, pro_price_iqd, regular_adjust_iqd, prime_adjust_iqd, pro_adjust_iqd, active, product_id
ON product_option_values
WHEN ((NEW.regular_price_iqd IS NOT OLD.regular_price_iqd OR NEW.prime_price_iqd IS NOT OLD.prime_price_iqd
      OR NEW.pro_price_iqd IS NOT OLD.pro_price_iqd OR NEW.regular_adjust_iqd IS NOT OLD.regular_adjust_iqd
      OR NEW.prime_adjust_iqd IS NOT OLD.prime_adjust_iqd OR NEW.pro_adjust_iqd IS NOT OLD.pro_adjust_iqd)
      OR NEW.product_id IS NOT OLD.product_id
      OR (OLD.active = 0 AND NEW.active <> 0)
      OR (OLD.active <> 0 AND NEW.active = 0
          AND NOT EXISTS (SELECT 1 FROM product_option_values v WHERE v.product_id = OLD.product_id AND v.id <> OLD.id AND v.active <> 0)))
 AND EXISTS (SELECT 1 FROM product_pricing_state s WHERE s.product_id IN (OLD.product_id, NEW.product_id) AND s.mode = 'engine') AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id IN ('engine-price:' || OLD.product_id, 'engine-price:' || NEW.product_id, 'pricing-rates-apply'))
 AND NOT (NEW.product_id IS OLD.product_id AND EXISTS (SELECT 1 FROM pricing_direct_purchase d WHERE d.product_id = NEW.product_id AND json_valid(d.payload_json) AND json_extract(d.payload_json, '$.direct_only') = 1))
BEGIN SELECT RAISE(ABORT, 'ENGINE_MANAGED'); END;

DROP TRIGGER IF EXISTS engine_lock_option_values_insert;
CREATE TRIGGER IF NOT EXISTS engine_lock_option_values_insert BEFORE INSERT ON product_option_values
WHEN NOT EXISTS (SELECT 1 FROM product_option_values v WHERE v.id = NEW.id) AND EXISTS (SELECT 1 FROM product_pricing_state s WHERE s.product_id = NEW.product_id AND s.mode = 'engine') AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id IN ('engine-price:' || NEW.product_id, 'pricing-rates-apply'))
 AND NOT EXISTS (SELECT 1 FROM pricing_direct_purchase d WHERE d.product_id = NEW.product_id AND json_valid(d.payload_json) AND json_extract(d.payload_json, '$.direct_only') = 1)
BEGIN SELECT RAISE(ABORT, 'ENGINE_MANAGED'); END;

DROP TRIGGER IF EXISTS engine_lock_option_values_delete;
CREATE TRIGGER IF NOT EXISTS engine_lock_option_values_delete BEFORE DELETE ON product_option_values
WHEN EXISTS (SELECT 1 FROM products p WHERE p.id = OLD.product_id) AND EXISTS (SELECT 1 FROM product_pricing_state s WHERE s.product_id = OLD.product_id AND s.mode = 'engine') AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id IN ('engine-price:' || OLD.product_id, 'pricing-rates-apply'))
 AND NOT EXISTS (SELECT 1 FROM pricing_direct_purchase d WHERE d.product_id = OLD.product_id AND json_valid(d.payload_json) AND json_extract(d.payload_json, '$.direct_only') = 1)
BEGIN SELECT RAISE(ABORT, 'ENGINE_MANAGED'); END;

DROP TRIGGER IF EXISTS engine_lock_fulfillment_update;
CREATE TRIGGER IF NOT EXISTS engine_lock_fulfillment_update
BEFORE UPDATE OF regular_price_iqd, prime_price_iqd, pro_price_iqd, regular_adjust_iqd, prime_adjust_iqd, pro_adjust_iqd,
  enabled, option_id, fulfillment_type, product_id ON product_option_fulfillment
WHEN ((NEW.regular_price_iqd IS NOT OLD.regular_price_iqd OR NEW.prime_price_iqd IS NOT OLD.prime_price_iqd
      OR NEW.pro_price_iqd IS NOT OLD.pro_price_iqd OR NEW.regular_adjust_iqd IS NOT OLD.regular_adjust_iqd
      OR NEW.prime_adjust_iqd IS NOT OLD.prime_adjust_iqd OR NEW.pro_adjust_iqd IS NOT OLD.pro_adjust_iqd)
      OR NEW.product_id IS NOT OLD.product_id OR NEW.option_id IS NOT OLD.option_id OR NEW.fulfillment_type IS NOT OLD.fulfillment_type
      OR (OLD.enabled = 0 AND NEW.enabled <> 0))
 AND EXISTS (SELECT 1 FROM product_pricing_state s WHERE s.product_id IN (OLD.product_id, NEW.product_id) AND s.mode = 'engine') AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id IN ('engine-price:' || OLD.product_id, 'engine-price:' || NEW.product_id, 'pricing-rates-apply'))
 AND NOT (NEW.product_id IS OLD.product_id AND OLD.fulfillment_type <> 'direct_sale' AND NEW.fulfillment_type <> 'direct_sale' AND EXISTS (SELECT 1 FROM pricing_direct_purchase d WHERE d.product_id = NEW.product_id AND json_valid(d.payload_json) AND json_extract(d.payload_json, '$.direct_only') = 1))
BEGIN SELECT RAISE(ABORT, 'ENGINE_MANAGED'); END;

DROP TRIGGER IF EXISTS engine_lock_fulfillment_insert;
CREATE TRIGGER IF NOT EXISTS engine_lock_fulfillment_insert BEFORE INSERT ON product_option_fulfillment
WHEN NOT EXISTS (SELECT 1 FROM product_option_fulfillment f WHERE f.id = NEW.id) AND EXISTS (SELECT 1 FROM product_pricing_state s WHERE s.product_id = NEW.product_id AND s.mode = 'engine') AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id IN ('engine-price:' || NEW.product_id, 'pricing-rates-apply'))
 AND NOT (NEW.fulfillment_type <> 'direct_sale' AND EXISTS (SELECT 1 FROM pricing_direct_purchase d WHERE d.product_id = NEW.product_id AND json_valid(d.payload_json) AND json_extract(d.payload_json, '$.direct_only') = 1))
BEGIN SELECT RAISE(ABORT, 'ENGINE_MANAGED'); END;

DROP TRIGGER IF EXISTS engine_lock_fulfillment_delete;
CREATE TRIGGER IF NOT EXISTS engine_lock_fulfillment_delete BEFORE DELETE ON product_option_fulfillment
WHEN EXISTS (SELECT 1 FROM products p WHERE p.id = OLD.product_id) AND EXISTS (SELECT 1 FROM product_pricing_state s WHERE s.product_id = OLD.product_id AND s.mode = 'engine') AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id IN ('engine-price:' || OLD.product_id, 'pricing-rates-apply'))
 AND NOT (OLD.fulfillment_type <> 'direct_sale' AND EXISTS (SELECT 1 FROM pricing_direct_purchase d WHERE d.product_id = OLD.product_id AND json_valid(d.payload_json) AND json_extract(d.payload_json, '$.direct_only') = 1))
BEGIN SELECT RAISE(ABORT, 'ENGINE_MANAGED'); END;

DROP TRIGGER IF EXISTS engine_lock_transports_update;
CREATE TRIGGER IF NOT EXISTS engine_lock_transports_update
BEFORE UPDATE OF regular_price_iqd, prime_price_iqd, pro_price_iqd, regular_adjust_iqd, prime_adjust_iqd, pro_adjust_iqd,
  surcharge_iqd, enabled, fulfillment_id, method, product_id ON product_option_transports
WHEN ((NEW.regular_price_iqd IS NOT OLD.regular_price_iqd OR NEW.prime_price_iqd IS NOT OLD.prime_price_iqd
      OR NEW.pro_price_iqd IS NOT OLD.pro_price_iqd OR NEW.regular_adjust_iqd IS NOT OLD.regular_adjust_iqd
      OR NEW.prime_adjust_iqd IS NOT OLD.prime_adjust_iqd OR NEW.pro_adjust_iqd IS NOT OLD.pro_adjust_iqd) OR NEW.surcharge_iqd IS NOT OLD.surcharge_iqd
      OR NEW.product_id IS NOT OLD.product_id OR NEW.fulfillment_id IS NOT OLD.fulfillment_id OR NEW.method IS NOT OLD.method
      OR (OLD.enabled = 0 AND NEW.enabled <> 0))
 AND EXISTS (SELECT 1 FROM product_pricing_state s WHERE s.product_id IN (OLD.product_id, NEW.product_id) AND s.mode = 'engine') AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id IN ('engine-price:' || OLD.product_id, 'engine-price:' || NEW.product_id, 'pricing-rates-apply'))
 AND NOT (NEW.product_id IS OLD.product_id AND EXISTS (SELECT 1 FROM pricing_direct_purchase d WHERE d.product_id = NEW.product_id AND json_valid(d.payload_json) AND json_extract(d.payload_json, '$.direct_only') = 1))
BEGIN SELECT RAISE(ABORT, 'ENGINE_MANAGED'); END;

DROP TRIGGER IF EXISTS engine_lock_transports_insert;
CREATE TRIGGER IF NOT EXISTS engine_lock_transports_insert BEFORE INSERT ON product_option_transports
WHEN NOT EXISTS (SELECT 1 FROM product_option_transports t WHERE t.id = NEW.id) AND EXISTS (SELECT 1 FROM product_pricing_state s WHERE s.product_id = NEW.product_id AND s.mode = 'engine') AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id IN ('engine-price:' || NEW.product_id, 'pricing-rates-apply'))
 AND NOT EXISTS (SELECT 1 FROM pricing_direct_purchase d WHERE d.product_id = NEW.product_id AND json_valid(d.payload_json) AND json_extract(d.payload_json, '$.direct_only') = 1)
BEGIN SELECT RAISE(ABORT, 'ENGINE_MANAGED'); END;

DROP TRIGGER IF EXISTS engine_lock_transports_delete;
CREATE TRIGGER IF NOT EXISTS engine_lock_transports_delete BEFORE DELETE ON product_option_transports
WHEN EXISTS (SELECT 1 FROM products p WHERE p.id = OLD.product_id) AND EXISTS (SELECT 1 FROM product_pricing_state s WHERE s.product_id = OLD.product_id AND s.mode = 'engine') AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id IN ('engine-price:' || OLD.product_id, 'pricing-rates-apply'))
 AND NOT EXISTS (SELECT 1 FROM pricing_direct_purchase d WHERE d.product_id = OLD.product_id AND json_valid(d.payload_json) AND json_extract(d.payload_json, '$.direct_only') = 1)
BEGIN SELECT RAISE(ABORT, 'ENGINE_MANAGED'); END;

DROP TRIGGER IF EXISTS engine_lock_colors_update;
CREATE TRIGGER IF NOT EXISTS engine_lock_colors_update
BEFORE UPDATE OF regular_price_iqd, prime_price_iqd, pro_price_iqd, regular_adjust_iqd, prime_adjust_iqd, pro_adjust_iqd, product_id ON product_colors
WHEN ((NEW.regular_price_iqd IS NOT OLD.regular_price_iqd OR NEW.prime_price_iqd IS NOT OLD.prime_price_iqd
      OR NEW.pro_price_iqd IS NOT OLD.pro_price_iqd OR NEW.regular_adjust_iqd IS NOT OLD.regular_adjust_iqd
      OR NEW.prime_adjust_iqd IS NOT OLD.prime_adjust_iqd OR NEW.pro_adjust_iqd IS NOT OLD.pro_adjust_iqd) OR NEW.product_id IS NOT OLD.product_id) AND EXISTS (SELECT 1 FROM product_pricing_state s WHERE s.product_id IN (OLD.product_id, NEW.product_id) AND s.mode = 'engine') AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id IN ('engine-price:' || OLD.product_id, 'engine-price:' || NEW.product_id, 'pricing-rates-apply'))
 AND NOT (NEW.product_id IS OLD.product_id AND EXISTS (SELECT 1 FROM pricing_direct_purchase d WHERE d.product_id = NEW.product_id AND json_valid(d.payload_json) AND json_extract(d.payload_json, '$.direct_only') = 1))
BEGIN SELECT RAISE(ABORT, 'ENGINE_MANAGED'); END;

DROP TRIGGER IF EXISTS engine_lock_colors_insert;
CREATE TRIGGER IF NOT EXISTS engine_lock_colors_insert BEFORE INSERT ON product_colors
WHEN (NEW.regular_price_iqd IS NOT NULL OR NEW.prime_price_iqd IS NOT NULL OR NEW.pro_price_iqd IS NOT NULL
      OR NEW.regular_adjust_iqd IS NOT NULL OR NEW.prime_adjust_iqd IS NOT NULL OR NEW.pro_adjust_iqd IS NOT NULL)
 AND EXISTS (SELECT 1 FROM product_pricing_state s WHERE s.product_id = NEW.product_id AND s.mode = 'engine') AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id IN ('engine-price:' || NEW.product_id, 'pricing-rates-apply'))
 AND NOT EXISTS (SELECT 1 FROM pricing_direct_purchase d WHERE d.product_id = NEW.product_id AND json_valid(d.payload_json) AND json_extract(d.payload_json, '$.direct_only') = 1)
BEGIN SELECT RAISE(ABORT, 'ENGINE_MANAGED'); END;
