/**
 * PRICING V2-3 — ORDER LINES AND PRICE PROTECTION OF A V2 PRODUCT (spec §3.6,
 * §3.4 orderBasis / protectionBasis, C-10).
 *
 * A line bought at a V2 price gets the 0181 §12 snapshot exactly as a V1
 * engine line does: `price_basis = 'engine'`, the canonical combo key ('' for
 * the option-less product itself), the channel, the regular price, the U its
 * V2 result was computed at, and base USD by TODAY's definition (price ÷ U,
 * rounded up at 6 places — policy `price_protection` v5). A line whose regular
 * price is not its SKU's V2 price gets none. Price protection reads today's V2
 * price. On a database without the V2 results, both reads are V1's alone.
 *
 * Run: REQUIRE_DIST=1 node --import tsx --test tests/pricingV2OrderBasis.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pricingWorld, AMS } from './fixtures/procurementPricing';
import { seedOptionless, writeV2 } from './fixtures/pricingV2';
import { baseUsdOf, engineBasisOf } from '../worker/lib/pricingEngine/orderBasis';
import { engineCombosOf, engineObservations } from '../worker/lib/pricingEngine/protectionBasis';

const OL = 'p_v2_ol';
const MODEL = `${AMS}_o0`;
const fixed = (usd: string) => ({ scope: 'product' as const, scope_id: '', kind: 'fixed' as const, usd });
const off = (usd: string) => ({ scope: 'product' as const, scope_id: '', usd });
const WINDOW = { from: '2000-01-01', to: '2999-01-01' };

test('a V2 line gets the 0181 §12 snapshot (U of its result, base USD by today’s definition); a non-V2 price gets none; protection reads today’s V2 price', async () => {
  const w = pricingWorld();
  seedOptionless(w.raw, OL, { routes: ['land'] });
  await writeV2(w.db, AMS, { method: 'usd', points: [fixed('1000')], discounts: [off('50')] });
  await writeV2(w.db, OL, { method: 'usd', points: [fixed('500')], discounts: [off('25')] });
  const basis = await engineBasisOf(w.db, [
    { key: 'direct', product_id: AMS, option_id: MODEL, option_value_ids: [MODEL], color_id: null, pricing_basis: 'direct', route: null, regular_iqd: 1_600_000 },
    { key: 'land', product_id: AMS, option_id: MODEL, option_value_ids: [MODEL], color_id: null, pricing_basis: 'preorder', route: 'land', regular_iqd: 1_520_000 },
    { key: 'cod', product_id: AMS, option_id: MODEL, option_value_ids: [MODEL], color_id: null, pricing_basis: 'direct', route: 'land', regular_iqd: 1_600_000 },
    { key: 'ol', product_id: OL, option_id: '', option_value_ids: [], color_id: null, pricing_basis: 'preorder', route: 'land', regular_iqd: 760_000 },
    { key: 'ol_cod', product_id: OL, option_id: '', option_value_ids: [], color_id: null, pricing_basis: 'direct', route: 'land', regular_iqd: 800_000 },
    { key: 'stale', product_id: AMS, option_id: MODEL, option_value_ids: [MODEL], color_id: null, pricing_basis: 'direct', route: null, regular_iqd: 1_599_000 },
  ]);
  assert.deepEqual(basis.get('direct'), {
    price_basis: 'engine',
    engine_combo_key: `o:${MODEL}`,
    engine_channel: 'direct_sale',
    engine_regular_iqd: 1_600_000,
    usd_iqd_at_purchase: '1600',
    base_usd_at_purchase: '1000',
  });
  assert.equal(basis.get('land')?.engine_channel, 'pre_order_land');
  assert.equal(basis.get('land')?.base_usd_at_purchase, baseUsdOf(1_520_000, '1600'));
  assert.equal(basis.get('cod')?.engine_channel, 'direct_sale', 'a pre-order paid at the door is priced from the direct row');
  assert.deepEqual([basis.get('ol')?.engine_combo_key, basis.get('ol')?.engine_channel], ['', 'pre_order_land'], 'the option-less product itself, canonical key');
  assert.equal(basis.get('ol_cod')?.engine_regular_iqd, 800_000);
  assert.equal(basis.has('stale'), false, 'a price that is not the SKU’s V2 price gets no snapshot');

  // Price protection reads today's V2 price and its history (sku:<combo>@<channel>, with U).
  const obs = await engineObservations(w.db, AMS, engineCombosOf({ optionId: MODEL, optionValueIds: [MODEL] }), 'pre_order_land', WINDOW);
  assert.deepEqual(obs.today, { price_iqd: 1_520_000, usd_iqd_rate: '1600' });
  assert.deepEqual(obs.history.map((h) => [h.price_iqd, h.usd_iqd_rate, h.source]), [[1_520_000, '1600', 'engine_owner']]);
  const olObs = await engineObservations(w.db, OL, engineCombosOf({ optionId: '' }), 'direct_sale', WINDOW);
  assert.deepEqual(olObs.today, { price_iqd: 800_000, usd_iqd_rate: '1600' });

  // Without the V2 results (a deploy ahead of 0189): V1's reads alone — no snapshot, no V2 today, no error.
  w.raw.exec('DROP TABLE pricing_v2_sku_results');
  const old = await engineBasisOf(w.db, [{ key: 'direct', product_id: AMS, option_id: MODEL, option_value_ids: [MODEL], color_id: null, pricing_basis: 'direct', route: null, regular_iqd: 1_600_000 }]);
  assert.equal(old.size, 0);
  const oldObs = await engineObservations(w.db, AMS, engineCombosOf({ optionId: MODEL, optionValueIds: [MODEL] }), 'pre_order_land', WINDOW);
  assert.equal(oldObs.today, null);
  assert.equal(oldObs.history.length, 1, 'the history rows stay readable');
});
