/**
 * The owner's product twin and the two rate worlds of the «التسعير بالدولار والشحن» save
 * (owner report 2026-10-10), shared by tests/usdPricingSaveTrace.test.ts,
 * tests/usdPricingDataFirst.test.ts and tests/usdPricingCommit.test.ts.
 *
 * The product is the census twin of the owner's: `snapmaker-u1` — a manual store
 * price, a legacy product cost («التكلفة القديمة»), ONE option group with ONE
 * value, no colours, sold direct and by sea pre-order.
 *
 *   LIVE-LIKE  no effective FX rate (each pair holds a FIRST_VALUE candidate the
 *              owner has not approved) and no central shipping rate;
 *   NORMAL     `pricingWorld()` — 1 USD = 1,600 IQD, EUR/USD 1.1, CNY/USD 0.14
 *              approved and the three central shipping rates set.
 */
import type { DatabaseSync } from 'node:sqlite';
import { all, json, row } from './app';
import { pricingWorld } from './procurementPricing';
import { legacyOptionId, legacyProductId } from './legacyCatalogue';

export const SNAP = legacyProductId('snapmaker-u1');
export const SNAP_MODEL = legacyOptionId('snapmaker-u1', 0);

export type World = ReturnType<typeof pricingWorld>;
/** A route's JSON answer, as the fixtures read it. */
export type Answer = Awaited<ReturnType<typeof json>>;

/** The live site: every pair holds its first fetched value for the owner's approval; nothing is effective. */
export function holdFirstValues(raw: DatabaseSync) {
  const at = '2026-10-10T08:00:00.000Z';
  for (const [pair, rate] of [
    ['USD_IQD', '1660'],
    ['EUR_USD', '1.1186'],
    ['CNY_USD', '0.1492'],
  ] as const) {
    raw
      .prepare(
        `UPDATE fx_rate_pairs SET market_rate = ?, pending_market_rate = ?, pending_effective_rate = ?, pending_reason = 'FIRST_VALUE',
                pending_observed_at = ?, fetch_status = 'OK', status = 'REVIEW_REQUIRED', last_check_result = 'REVIEW_HELD',
                last_checked_at = ?, last_successful_at = ?
          WHERE pair = ?`
      )
      .run(rate, rate, rate, at, at, at, pair);
  }
}

export function liveLikeWorld(opts: { sessionAgeSeconds?: number } = {}): World {
  const w = pricingWorld({ rates: false, ...opts });
  holdFirstValues(w.raw);
  return w;
}

/** What the store holds for the product (owner rows only — the form's). */
export function persisted(raw: DatabaseSync, pid = SNAP) {
  const inputs = all<Record<string, unknown>>(
    raw,
    `SELECT scope, scope_id, supplier_cost_amount, supplier_cost_currency, supplier_input_mode, original_input_amount,
            conversion_rate_snapshot, shipping_profile, shipping_weight_g, shipping_length_mm, shipping_width_mm, shipping_height_mm,
            manual_cbm, additional_cost_iqd
       FROM pricing_inputs WHERE product_id = ? AND origin = 'MANUAL_OVERRIDE' ORDER BY scope, scope_id`,
    pid
  ).map((r) => ({ ...r }));
  const rules = all<Record<string, unknown>>(raw, 'SELECT kind, scope, scope_id, state, amount_usd, amount_iqd FROM pricing_rules WHERE product_id = ? ORDER BY kind, scope', pid).map((r) => ({
    ...r,
  }));
  const state = row<{ mode: string; inputs_seq: number }>(raw, 'SELECT mode, inputs_seq FROM product_pricing_state WHERE product_id = ?', pid);
  return { inputs, rules, state: state ? { ...state } : null };
}

/** The store price and the legacy cost the form shows beside the panel (never moved by a data-only save). */
export function storePrice(raw: DatabaseSync, pid = SNAP) {
  return JSON.stringify([
    all(raw, 'SELECT price_iqd, product_cost_iqd, direct_surcharge_iqd FROM products WHERE id = ?', pid),
    all(raw, 'SELECT id, regular_price_iqd, cost_iqd FROM product_option_values WHERE product_id = ? ORDER BY id', pid),
    all(raw, 'SELECT id, regular_price_iqd, cost_iqd FROM product_option_fulfillment WHERE product_id = ? ORDER BY id', pid),
  ]);
}

/** «التكلفة القديمة» — the products row's own cost, which the engine never writes. */
export const legacyCost = (raw: DatabaseSync, pid = SNAP) => row<{ product_cost_iqd: number | null }>(raw, 'SELECT product_cost_iqd FROM products WHERE id = ?', pid)?.product_cost_iqd ?? null;

/** The fields the form reads back from GET …/inputs for one scope. */
export function readBack(body: Answer, scope: 'base' | 'option', scopeId = '') {
  const s = (body.scopes as Array<{ scope: string; scope_id: string } & Record<string, unknown>>).find((x) => x.scope === scope && (scope === 'base' || x.scope_id === scopeId));
  if (!s) return null;
  const p = s.pricing_inputs as Record<string, unknown> | null;
  return {
    supplier_cost_amount: p?.supplier_cost_amount ?? null,
    supplier_cost_currency: p?.supplier_cost_currency ?? null,
    supplier_input_mode: p?.supplier_input_mode ?? null,
    original_input_amount: p?.original_input_amount ?? null,
    shipping_profile: p?.shipping_profile ?? null,
    shipping_weight_g: p?.shipping_weight_g ?? null,
    box: p ? [p.shipping_length_mm ?? null, p.shipping_width_mm ?? null, p.shipping_height_mm ?? null] : [null, null, null],
    manual_cbm: p?.manual_cbm ?? null,
    additional_cost_iqd: p?.additional_cost_iqd ?? null,
    minimum_target_profit_usd: s.minimum_target_profit_usd ?? null,
    direct_sale_extra_iqd: s.direct_sale_extra_iqd ?? null,
  };
}

/** The owner's full entry in section 3 (the product scope): what «نشر» sends after the product is saved. */
export const OWNER_BASE = {
  scope: 'base',
  supplier_cost_amount: '899',
  supplier_cost_currency: 'USD',
  shipping_profile: 'CHINA_SEA',
  shipping_length_mm: 600,
  shipping_width_mm: 520,
  shipping_height_mm: 480,
  additional_cost_iqd: 15000,
};
export const OWNER_RULES = [
  { kind: 'target_profit', scope: 'product', amount_usd: '120' },
  { kind: 'direct_sale_extra', scope: 'product', amount_iqd: 25000 },
];
