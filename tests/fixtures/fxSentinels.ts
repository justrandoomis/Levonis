/**
 * FX SENTINELS (FX programme plan §14.2 S1): every private field of the 0179
 * tables seeded with a value no public number can equal — the owner's
 * adjustment 37.2501 (and the 29.8642 it replaced, in a settings_change row's
 * old → new), held and rejected candidates, the drift anchor, the ECB figures, the derived
 * EUR/CNY dinar rates, a shipping rate and the history. Since DECISIONS row
 * 219 the ONE public figure is the market sell the applied rate was built
 * from, 1666.6666 — IQWealth's own number, exactly: the top bar's
 * `displayUsdRate` — so it is not a sentinel. The effective (applied) rate
 * 1703.9167 = 1666.6666 + 37.2501 is `FX_PUBLIC_RATE` by its old name.
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export const FX_PUBLIC_RATE = '1703.9167';
/**
 * What GET /api/settings/public and /api/home publish for these rows since
 * DECISIONS row 220: the market sell the applied rate was built from (the
 * `apply` row's effective_after less the adjustment it carried), exactly —
 * the effective rate minus the published market sell gave the adjustment
 * away. The effective rate stays the one every IQD price is built on, and is
 * itself private now.
 */
export const FX_DISPLAY_RATE = '1666.6666';

export const FX_SENTINELS = [
  // Not '1666.6666', the USD/IQD market sell: it IS the public display rate (above).
  '1650.165', // market buy
  '1310.1313', // CBI official
  '37.2501', // the owner's adjustment (market_adjustment_iqd)
  '29.8642', // the adjustment before the owner's last change (a settings_change row's settings_diff)
  '1696.5308', // the effective rate under that older adjustment (the settings_change row's effective_before)
  '1680.4321', // the drift anchor (last owner-confirmed)
  '1777.7777', // a held market figure
  '1815.0278', // a held effective candidate
  '1999.9999', // a rejected candidate
  '1.0987', // EUR/USD
  '1.0911', // EUR/USD anchor
  '7.7777', // CNY per EUR
  '0.1412698', // CNY/USD
  '1872.09327829', // EUR in IQD
  '240.71197142566', // CNY in IQD
  '12345.678', // a central shipping rate
] as const;

export function seedFxSentinels(raw: DatabaseSync): void {
  const at = '2026-10-08T12:00:00.000Z';
  // The rejection memory lasts 24 hours from the ROUTE's wall clock, so the rejected candidate is
  // stamped an hour ago: a fixed date dropped it from GET /rates once the day had passed (from
  // 2026-10-09 12:00 UTC the sweep no longer reached it).
  const rejectedAt = new Date(Date.now() - 3_600_000).toISOString();
  raw.exec(`
    UPDATE fx_rate_pairs SET market_rate='1666.6666', market_buy='1650.165', official_rate='1310.1313', market_adjustment_iqd='37.2501',
           effective_rate='${FX_PUBLIC_RATE}', effective_version=1, effective_source='provider', effective_applied_at='${at}',
           last_known_good_rate='${FX_PUBLIC_RATE}', last_known_good_at='${at}', drift_anchor_rate='1680.4321', drift_anchor_at='${at}',
           published_at='${at}', fetch_status='OK', pending_market_rate='1777.7777', pending_effective_rate='1815.0278',
           pending_reason='ANOMALY', pending_observed_at='${at}', pending_published_at='${at}', rejected_rate='1999.9999', rejected_at='${rejectedAt}',
           status='REVIEW_REQUIRED'
     WHERE pair='USD_IQD';
    UPDATE fx_rate_pairs SET market_rate='1.0987', source_usd_per_eur='1.0987', source_cny_per_eur='7.7777', effective_rate='1.0987',
           effective_version=1, effective_source='provider', last_known_good_rate='1.0987', drift_anchor_rate='1.0911', drift_anchor_at='${at}',
           published_at='2026-10-08T00:00:00.000Z', fetch_status='OK', status='OK'
     WHERE pair='EUR_USD';
    UPDATE fx_rate_pairs SET market_rate='0.1412698', source_usd_per_eur='1.0987', source_cny_per_eur='7.7777', effective_rate='0.1412698',
           effective_version=1, effective_source='provider', last_known_good_rate='0.1412698', drift_anchor_rate='0.1412698', drift_anchor_at='${at}',
           published_at='2026-10-08T00:00:00.000Z', fetch_status='OK', status='OK'
     WHERE pair='CNY_USD';
    UPDATE pricing_fx_rates SET rate_iqd='${FX_PUBLIC_RATE}', usd_iqd_rate='${FX_PUBLIC_RATE}', usd_version=1, version=2, updated_at='${at}' WHERE currency='USD';
    UPDATE pricing_fx_rates SET rate_iqd='1872.09327829', usd_iqd_rate='${FX_PUBLIC_RATE}', cross_rate='1.0987', usd_version=1, cross_version=1, version=2, updated_at='${at}' WHERE currency='EUR';
    UPDATE pricing_fx_rates SET rate_iqd='240.71197142566', usd_iqd_rate='${FX_PUBLIC_RATE}', cross_rate='0.1412698', usd_version=1, cross_version=1, version=2, updated_at='${at}' WHERE currency='CNY';
    UPDATE pricing_shipping_rates SET rate_iqd='12345.678', version=2, updated_at='${at}' WHERE profile='GERMANY_LAND';
    INSERT INTO fx_rate_log (id, pair, event, trigger_kind, provider, market_rate, effective_before, effective_after, pending_rate, change_ppm, published_at, result, created_at, market_adjustment_iqd)
      VALUES ('fxl_s1', 'USD_IQD', 'review_held', 'cron', 'iqwealth', '1777.7777', '${FX_PUBLIC_RATE}', '${FX_PUBLIC_RATE}', '1815.0278', 65432, '${at}', 'REVIEW_HELD', '${at}', '37.2501'),
             ('fxl_s2', 'USD_IQD', 'apply', 'cron', 'iqwealth', '1666.6666', '1680.4321', '${FX_PUBLIC_RATE}', NULL, 13955, '${at}', 'APPLIED', '2026-10-08T06:00:00.000Z', '37.2501'),
             ('fxl_s3', 'EUR_USD', 'apply', 'cron', 'ecb', '1.0987', '1.0911', '1.0987', NULL, 6965, '2026-10-08T00:00:00.000Z', 'APPLIED', '2026-10-08T06:00:00.000Z', NULL);
    INSERT INTO fx_rate_log (id, pair, event, trigger_kind, provider, effective_before, effective_after, result, actor_id, created_at, market_adjustment_iqd, settings_diff)
      VALUES ('fxl_sdiff', 'USD_IQD', 'settings_change', 'owner', 'owner', '1696.5308', '${FX_PUBLIC_RATE}', 'APPLIED', 'usr_owner', '2026-10-08T05:00:00.000Z', '37.2501',
              '[{"field":"market_adjustment_iqd","before":"29.8642","after":"37.2501"}]');
  `);
}

/**
 * FX-6 (FX plan §14.2 S1, migration 0182): a batch whose purchase snapshot is
 * seeded with sentinels — the purchase-time U, E and C, the document's own
 * rate, the supplier's amount and line total, the supplier cost in USD and
 * the historical USD equivalent. The owner reads them on GET
 * /api/admin/pricing/batches; no other caller may meet one anywhere.
 */
export const BATCH_SENTINELS = [
  '1633.3133', // USD/IQD at purchase
  '1.0777', // EUR/USD at purchase
  '0.1399999', // CNY/USD at purchase
  '1987.6543', // the document's own rate (IQD per EUR)
  '371.4159', // the supplier's amount per unit
  '2599.5017', // the line's original total
  '400.271', // the supplier cost in USD at purchase
  '432.104321', // the historical USD equivalent
] as const;

export const BATCH_SENTINEL_LOT = 'lot_fx6_sentinel';

export function seedBatchSentinels(raw: DatabaseSync, productId = 'p_a1'): void {
  raw
    .prepare(
      `INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,purchase_unit_iqd,shipping_share_iqd,internal_share_iqd,total_cost_iqd,cost_basis,received_at,
         snapshot_version,snapshot_source,purchase_id,supplier_original_currency,supplier_original_amount,supplier_cost_mode,supplier_line_total_original,exchange_rate_at_purchase,
         supplier_cost_usd_at_purchase,usd_iqd_rate_at_purchase,eur_usd_rate_at_purchase,cny_usd_rate_at_purchase,usd_iqd_fx_version,eur_usd_fx_version,cny_usd_fx_version,
         fx_snapshot_at,fx_snapshot_source,historical_usd_equivalent,calculated_at)
       VALUES (?, ?, 'base', '', 7, 7, 705800, 705800, 0, 0, 4940600, 'received', '2026-10-07T00:00:00.000Z',
         1, 'purchase', 'po_fx6_sentinel', 'EUR', '371.4159', 'total', '2599.5017', '1987.6543',
         '400.271', '1633.3133', '1.0777', '0.1399999', 3, 4, 5,
         '2026-10-06T00:00:00.000Z', 'central', '432.104321', '2026-10-07T00:00:00.000Z')`
    )
    .run(BATCH_SENTINEL_LOT, productId);
}

/**
 * PRICING V2 (migration 0189; spec §8): every private V2 store seeded with a
 * sentinel no public number can equal — the dollar price points (the
 * product's fixed price, a model's difference, a colour's difference, an
 * SKU's fixed price), the pre-order discount and a model's exception, the V2
 * results' exact IQD and rounded USD, the replacement cost and the minimum
 * profit, and a legacy cost inside the migration snapshot. Nothing serves
 * them yet (V2-3 and V2-3b add the readers); the role matrix seeds them on its
 * costly product so the first door that does is swept from day one.
 *
 * A model difference is stored signed ('-43.21'); the scanners read decimals
 * without their sign, so its magnitude is listed too.
 */
export const V2_SENTINELS = [
  '987.65', // the product's fixed USD price (price-first anchor)
  '-43.21', // a model's USD difference, as stored
  '43.21', // …and as a scanner reads it out of text
  '7.77', // a colour's USD difference
  '1234.56', // an SKU's fixed USD price
  '61.73', // the product's pre-order discount
  '13.79', // a model's discount exception (not '0.97': the farm's public printer reliability is 0.97)
  '1543210.987654', // a V2 result's exact IQD
  '987.654321', // a V2 result's USD, ceil to 6 places
  '765432', // a V2 result's replacement cost
  '313.13', // a V2 result's minimum profit in USD
  '654321', // a legacy cost inside the migration snapshot's payload
] as const;

/**
 * The owner's answer Q2 (DECISIONS row 222, spec addendum A.12.3) splits them:
 * the DOLLAR PRICE figures a price editor may read and write on a PRICE-FIRST
 * V2 product's pricing answer (and nowhere else) …
 */
export const V2_PRICE_SENTINELS = ['987.65', '-43.21', '43.21', '7.77', '1234.56', '61.73', '13.79'] as const;
/** … and the cost-derived figures nobody but the owner ever reads, anywhere. */
export const V2_COST_SENTINELS = ['1543210.987654', '987.654321', '765432', '313.13', '654321'] as const;

/** The legacy snapshot's payload (its SHA-256 is stored beside it, as V2-5 will). */
export const V2_SENTINEL_SNAPSHOT_PAYLOAD = JSON.stringify({ product: { price_iqd: 900000, product_cost_iqd: 654321 } });

/**
 * Seeds the V2 stores of `productId` (default: the role matrix's costly product
 * `p_a1`, model `v_a1`, colour `c_blk`) with V2_SENTINELS, inside the engine's
 * own token as the V2 writer will. The product is NOT made V2: no code reads
 * these rows before V2-3, and a V2 state here would hand today's V1 doors a
 * product shape they never meet. A database without 0189 is left untouched.
 */
export function seedV2Sentinels(raw: DatabaseSync, productId = 'p_a1', model = 'v_a1', colour = 'c_blk'): void {
  const installed = raw.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'pricing_v2_sku_results'").get();
  if (!installed) return;
  const at = '2026-10-13T12:00:00.000Z';
  const sku = `o:${model}|c:${colour}`;
  const sha = createHash('sha256').update(V2_SENTINEL_SNAPSHOT_PAYLOAD).digest('hex');
  const token = `engine-price:${productId}`;
  raw.prepare('INSERT INTO ops_guards (id, ok) VALUES (?, 1)').run(token);
  const point = raw.prepare('INSERT INTO pricing_price_points (product_id, scope, scope_id, kind, amount_usd, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  point.run(productId, 'product', '', 'fixed', '987.65', 'usr_owner', at);
  point.run(productId, 'option', model, 'delta', '-43.21', 'usr_owner', at);
  point.run(productId, 'color', colour, 'delta', '7.77', 'usr_owner', at);
  point.run(productId, 'sku', sku, 'fixed', '1234.56', 'usr_owner', at);
  const discount = raw.prepare('INSERT INTO pricing_preorder_discounts (product_id, scope, scope_id, amount_usd, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
  discount.run(productId, 'product', '', '61.73', 'usr_owner', at);
  discount.run(productId, 'option', model, '13.79', 'usr_owner', at);
  const result = raw.prepare(
    `INSERT INTO pricing_v2_sku_results (product_id, combo_key, channel, method, anchor, final_price_iqd, exact_iqd, direct_price_iqd,
       direct_exact_iqd, usd_ceil6, deltas_usd, discount_usd, discount_scope, discount_scope_id, floor, shipping_profile, supplier_currency,
       fx_rate, fx_version, shipping_rate, shipping_version, replacement_exact, replacement_cost_iqd, target_profit_usd, target_rule_id,
       target_rule_version, usd_iqd_rate, usd_fx_version, inputs_seq, config_version, write_seq, computed_at)
     VALUES (?, ?, ?, 'cost', 'cost', ?, ?, 1544000, '1543210.987654', ?, '-35.44', ?, ?, ?, 'none', 'CHINA_SEA', 'USD',
       '1562.5', 1, '9.5', 1, '765432', 765432, '313.13', 'rule_v2_sentinel', 1, '1562.5', 1, 0, 0, 1, ?)`
  );
  result.run(productId, sku, 'direct_sale', 1544000, '1543210.987654', '987.654321', null, null, null, at);
  result.run(productId, sku, 'pre_order_sea', 1447000, '1446758.3', '925.925312', '61.73', 'product', '', at);
  raw.prepare('DELETE FROM ops_guards WHERE id = ?').run(token);
  raw
    .prepare(
      `INSERT INTO pricing_legacy_snapshots (id, product_id, reason, captured_at, usd_iqd_rate, fx_version, actor, payload_json, payload_sha256)
       VALUES (?, ?, 'v2_migration', ?, '1562.5', 1, 'usr_owner', ?, ?)`
    )
    .run(`v2snap_${productId}`, productId, at, V2_SENTINEL_SNAPSHOT_PAYLOAD, sha);
}
