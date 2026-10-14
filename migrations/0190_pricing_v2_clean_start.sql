-- 0190 — PRICING V2: THE CLEAN START (the owner's answer Q6, DECISIONS row 222: «احذف النموذج القديم
-- والتسعير القديم وانقل كل المنتجات إلى مخفي حتى تُدخَل الأسعار الناقصة؛ التغييرات الجديدة تبدأ الآن؛
-- لا يبقى شيء قديم»; implementation spec addendum A.3, A.9, A.10).
--
-- ADDITIVE ONLY: one setting written once, one guarded archive insert, one new table, new nullable
-- columns. It updates or deletes NO existing row: no product, order, order line, invoice, wallet row,
-- lot, gift, price-protection claim or payout is touched. HIDING NEEDS NO ROW CHANGE AT ALL: from the
-- deploy on, the listing predicate (worker/lib/listing.ts `V2_LISTED_CLAUSE`) lists a platform product
-- only while it is V2-PUBLISHED (a V2 method and the results of a complete V2 write), and no product
-- that exists at deploy has a method. The merchants' own products (`community_products`) are another
-- table and are untouched.
--
-- Between this migration and the deploy (workflow 7 applies it first) the old Worker still serves the
-- old store unchanged: nothing it reads moves here.
--
-- PRIVATE (owner only; never joined by a public read; never SELECT *): the archive, the purchase
-- reviews and the order lines' estimate columns. A space always separates a CASE's END from a closing
-- parenthesis (tests/sqlSplit.test.ts).

-- 1. The cut-over instant (offers created before it are suspended, the needs-pricing queue, reports). Written once;
--    a re-run changes nothing.
INSERT OR IGNORE INTO admin_settings (key, value)
VALUES ('pricingV2CleanStart', json_object('at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'migration', '0190'));

-- 2. The invisible archive of the old dinar pricing: one row per product that exists at deploy (every status,
--    every composition), the raw columns by EXPLICIT column lists (payload_version 2), for audit only — never
--    shown in any UI, never read for pricing. The rate is the applied USD/IQD (0178's derived row), NULL when
--    none was ever applied. Guarded by NOT EXISTS over its own table, so a re-run inserts nothing (and the
--    0189 no-reinsert trigger stays silent).
INSERT INTO pricing_legacy_snapshots
  (id, product_id, reason, captured_at, usd_iqd_rate, fx_version, actor, payload_version, payload_json, payload_sha256)
SELECT 'pls_cs_' || p.id, p.id, 'clean_start', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       (SELECT r.rate_iqd FROM pricing_fx_rates r WHERE r.currency = 'USD' AND r.rate_iqd IS NOT NULL),
       (SELECT NULLIF(r.version, 0) FROM pricing_fx_rates r WHERE r.currency = 'USD' AND r.rate_iqd IS NOT NULL),
       'migration:0190', 2,
       json_object(
         'product', json_object(
           'price_iqd', p.price_iqd, 'prime_price_iqd', p.prime_price_iqd, 'pro_price_iqd', p.pro_price_iqd,
           'original_price_iqd', p.original_price_iqd, 'product_cost_iqd', p.product_cost_iqd,
           'direct_surcharge_iqd', p.direct_surcharge_iqd, 'status', p.status, 'composition', p.composition,
           'selling_type', p.selling_type, 'sale_types', p.sale_types, 'inventory_mode', p.inventory_mode),
         'json', json_object(
           'options', p.options, 'colors', p.colors, 'membership_prices', p.membership_prices,
           'preorder_transports', p.preorder_transports),
         'values', (SELECT json_group_array(json_object(
             'id', v.id, 'group_id', v.group_id, 'active', v.active,
             'regular_price_iqd', v.regular_price_iqd, 'prime_price_iqd', v.prime_price_iqd, 'pro_price_iqd', v.pro_price_iqd,
             'cost_iqd', v.cost_iqd, 'regular_adjust_iqd', v.regular_adjust_iqd, 'prime_adjust_iqd', v.prime_adjust_iqd,
             'pro_adjust_iqd', v.pro_adjust_iqd, 'cost_adjust_iqd', v.cost_adjust_iqd))
           FROM product_option_values v WHERE v.product_id = p.id),
         'fulfillments', (SELECT json_group_array(json_object(
             'id', f.id, 'option_id', f.option_id, 'fulfillment_type', f.fulfillment_type, 'enabled', f.enabled,
             'regular_price_iqd', f.regular_price_iqd, 'prime_price_iqd', f.prime_price_iqd, 'pro_price_iqd', f.pro_price_iqd,
             'cost_iqd', f.cost_iqd, 'regular_adjust_iqd', f.regular_adjust_iqd, 'prime_adjust_iqd', f.prime_adjust_iqd,
             'pro_adjust_iqd', f.pro_adjust_iqd, 'cost_adjust_iqd', f.cost_adjust_iqd))
           FROM product_option_fulfillment f WHERE f.product_id = p.id),
         'transports', (SELECT json_group_array(json_object(
             'id', t.id, 'fulfillment_id', t.fulfillment_id, 'method', t.method, 'enabled', t.enabled,
             'surcharge_iqd', t.surcharge_iqd,
             'regular_price_iqd', t.regular_price_iqd, 'prime_price_iqd', t.prime_price_iqd, 'pro_price_iqd', t.pro_price_iqd,
             'cost_iqd', t.cost_iqd, 'regular_adjust_iqd', t.regular_adjust_iqd, 'prime_adjust_iqd', t.prime_adjust_iqd,
             'pro_adjust_iqd', t.pro_adjust_iqd, 'cost_adjust_iqd', t.cost_adjust_iqd))
           FROM product_option_transports t WHERE t.product_id = p.id),
         'colors', (SELECT json_group_array(json_object(
             'id', c.id, 'active', c.active,
             'regular_price_iqd', c.regular_price_iqd, 'prime_price_iqd', c.prime_price_iqd, 'pro_price_iqd', c.pro_price_iqd,
             'cost_iqd', c.cost_iqd, 'regular_adjust_iqd', c.regular_adjust_iqd, 'prime_adjust_iqd', c.prime_adjust_iqd,
             'pro_adjust_iqd', c.pro_adjust_iqd, 'cost_adjust_iqd', c.cost_adjust_iqd))
           FROM product_colors c WHERE c.product_id = p.id),
         'variants', (SELECT json_group_array(json_object(
             'id', x.id, 'combo_key', x.combo_key, 'active', x.active,
             'regular_price_iqd', x.regular_price_iqd, 'prime_price_iqd', x.prime_price_iqd, 'pro_price_iqd', x.pro_price_iqd,
             'cost_iqd', x.cost_iqd))
           FROM product_variants x WHERE x.product_id = p.id),
         'sku_prices', (SELECT json_group_array(json_object(
             'combo_key', k.combo_key, 'channel', k.channel, 'regular_price_iqd', k.regular_price_iqd,
             'source', k.source, 'write_seq', k.write_seq))
           FROM product_sku_prices k WHERE k.product_id = p.id),
         'state', (SELECT json_object(
             'mode', s.mode, 'pricing_method', s.pricing_method, 'inputs_seq', s.inputs_seq, 'write_seq', s.write_seq,
             'priced_at', s.priced_at, 'opted_in_at', s.opted_in_at, 'opted_out_at', s.opted_out_at)
           FROM product_pricing_state s WHERE s.product_id = p.id),
         'inputs', (SELECT json_group_array(json_object(
             'scope', i.scope, 'scope_id', i.scope_id, 'origin', i.origin,
             'supplier_cost_amount', i.supplier_cost_amount, 'supplier_cost_delta', i.supplier_cost_delta,
             'supplier_cost_currency', i.supplier_cost_currency, 'supplier_input_mode', i.supplier_input_mode,
             'original_input_amount', i.original_input_amount, 'original_input_currency', i.original_input_currency,
             'shipping_profile', i.shipping_profile, 'pricing_weight_g', i.pricing_weight_g, 'shipping_weight_g', i.shipping_weight_g,
             'shipping_length_mm', i.shipping_length_mm, 'shipping_width_mm', i.shipping_width_mm, 'shipping_height_mm', i.shipping_height_mm,
             'manual_cbm', i.manual_cbm, 'additional_cost_iqd', i.additional_cost_iqd, 'source_ref', i.source_ref, 'version', i.version))
           FROM pricing_inputs i WHERE i.product_id = p.id),
         'rules', (SELECT json_group_array(json_object(
             'id', u.id, 'kind', u.kind, 'scope', u.scope, 'scope_id', u.scope_id, 'state', u.state,
             'amount_usd', u.amount_usd, 'amount_iqd', u.amount_iqd, 'legacy_amount_iqd', u.legacy_amount_iqd,
             'legacy_usd_iqd_rate', u.legacy_usd_iqd_rate, 'source', u.source, 'version', u.version))
           FROM pricing_rules u WHERE u.product_id = p.id),
         'sku_costs', (SELECT json_group_array(json_object(
             'combo_key', q.combo_key, 'channel', q.channel, 'computed_price_iqd', q.computed_price_iqd,
             'replacement_cost_iqd', q.replacement_cost_iqd, 'target_profit_iqd', q.target_profit_iqd,
             'direct_sale_extra_iqd', q.direct_sale_extra_iqd, 'computed_at', q.computed_at))
           FROM pricing_sku_costs q WHERE q.product_id = p.id),
         'direct_purchase', (SELECT json_object('payload_json', d.payload_json, 'version', d.version)
           FROM pricing_direct_purchase d WHERE d.product_id = p.id),
         'bundle', (SELECT json_object(
             'price_mode', b.price_mode, 'discount_percent', b.discount_percent, 'discount_iqd', b.discount_iqd,
             'min_price_iqd', b.min_price_iqd, 'plus_price_iqd', b.plus_price_iqd)
           FROM bundle_config b WHERE b.product_id = p.id),
         'offers', (SELECT json_group_array(json_object(
             'id', w.id, 'subject_type', w.subject_type, 'starts_at', w.starts_at, 'ends_at', w.ends_at,
             'offer_price_mode', w.offer_price_mode, 'offer_price_iqd', w.offer_price_iqd,
             'discount_percent', w.discount_percent, 'discount_iqd', w.discount_iqd, 'plus_price_iqd', w.plus_price_iqd,
             'active', w.active, 'updated_at', w.updated_at))
           FROM offer_windows w WHERE w.subject_id = p.id)
       ),
       NULL
  FROM products p
 WHERE NOT EXISTS (SELECT 1 FROM pricing_legacy_snapshots s WHERE s.product_id = p.id AND s.reason = 'clean_start');

-- 3. D1 (spec addendum A.10): a confirmed stock purchase becomes a product's current cost inputs only after the
--    owner reviews the price change. The purchase's transition to `ordered` writes one pending review per
--    product (an older pending one is superseded); applying it is the owner's normal V2 apply. Owner-only (cost).
--    A decided review never changes again.
CREATE TABLE IF NOT EXISTS pricing_v2_purchase_reviews (
  id            TEXT PRIMARY KEY,
  product_id    TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  purchase_id   TEXT NOT NULL,
  inputs_json   TEXT NOT NULL CHECK (json_valid(inputs_json) AND json_type(inputs_json) = 'array' AND length(inputs_json) <= 200000),
  state         TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','applied','dismissed','superseded')),
  created_at    TEXT NOT NULL,
  created_by    TEXT,
  decided_at    TEXT,
  decided_by    TEXT,
  audit_id      TEXT,
  CHECK ((state = 'pending') = (decided_at IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pricing_v2_purchase_reviews_open
  ON pricing_v2_purchase_reviews(product_id, purchase_id) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS idx_pricing_v2_purchase_reviews_product ON pricing_v2_purchase_reviews(product_id, state);
CREATE TRIGGER IF NOT EXISTS pricing_v2_purchase_reviews_decided_immutable BEFORE UPDATE ON pricing_v2_purchase_reviews
WHEN OLD.state <> 'pending'
BEGIN SELECT RAISE(ABORT, 'PRICING_REVIEW_DECIDED'); END;

-- 4. V2-6 line cost (spec addendum A.9): the estimate frozen at order time — the replacement cost R of the line's
--    channel from the product's V2 results, in dinars and dollars, with the USD/IQD and its version. Owner-only;
--    NULL on every existing row (placed orders never change). A V2 line's `cost_iqd` stays NULL ('unpriced'):
--    its actual cost is the FIFO allocation or the batch linked on arrival, never a legacy number.
ALTER TABLE order_items ADD COLUMN estimated_cost_iqd INTEGER
  CHECK (estimated_cost_iqd IS NULL OR estimated_cost_iqd >= 0);
ALTER TABLE order_items ADD COLUMN estimated_cost_usd TEXT
  CHECK (estimated_cost_usd IS NULL OR (estimated_cost_usd GLOB '[0-9]*' AND estimated_cost_usd NOT GLOB '*[^0-9.]*'
    AND estimated_cost_usd NOT GLOB '*.*.*' AND estimated_cost_usd NOT GLOB '*.' AND estimated_cost_usd NOT GLOB '*.???????*'
    AND length(estimated_cost_usd) <= 32));
ALTER TABLE order_items ADD COLUMN estimated_usd_iqd_rate TEXT
  CHECK (estimated_usd_iqd_rate IS NULL OR (estimated_usd_iqd_rate GLOB '[0-9]*' AND estimated_usd_iqd_rate NOT GLOB '*[^0-9.]*'
    AND estimated_usd_iqd_rate NOT GLOB '*.*.*' AND estimated_usd_iqd_rate NOT GLOB '*.' AND length(estimated_usd_iqd_rate) <= 32
    AND CAST(estimated_usd_iqd_rate AS REAL) > 0));
ALTER TABLE order_items ADD COLUMN estimated_fx_version INTEGER
  CHECK (estimated_fx_version IS NULL OR estimated_fx_version > 0);

-- 5. V2-6 batch link (spec addendum A.9.4): which allocations are a pre-order line linked to its arriving batch
--    («اربط بالدفعة الواصلة») rather than the FIFO deduction. Every existing row is 'fifo'.
ALTER TABLE order_item_inventory_allocations ADD COLUMN link_kind TEXT NOT NULL DEFAULT 'fifo'
  CHECK (link_kind IN ('fifo','preorder_batch'));
