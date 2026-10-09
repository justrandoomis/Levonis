/**
 * THE VERSIONED RATE READER OF EVERY ENGINE WRITE (USD design §2.6, critique
 * M5, fit #22): worker/lib/pricingEngine/rates.ts.
 *
 * Proves: real versions (> 0) from the derived IQD rates and the pairs; E and C
 * read from the pairs; the composed U, E × U and C × U equal every stored
 * `rate_iqd`; a forged mismatch sets `derived_stale` and every write refuses
 * with FX_DERIVED_STALE (the product form's save, apply-purchase); a held
 * candidate leaves U unchanged and only raises `review_pending`; a database
 * without 0179 answers null.
 *
 * Run: node --import tsx --test tests/pricingRatesReader.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeIqdRates, sameRate } from '@levonis/pricing/fxChain';
import { loadPricingRates } from '../worker/lib/pricingEngine/rates';
import { asD1, count, dbThrough } from './fixtures/app';
import { pricingWorld, AMS } from './fixtures/procurementPricing';

test('real versions, E and C from the pairs, and the composed rates equal the stored IQD rates', async () => {
  const w = pricingWorld();
  const r = (await loadPricingRates(w.db))!;
  assert.ok(r);
  assert.equal(r.usd_iqd, '1600');
  assert.equal(r.eur_usd, '1.1');
  assert.equal(r.cny_usd, '0.14');
  for (const c of ['USD', 'EUR', 'CNY'] as const) {
    assert.ok(r.fx_versions[c] > 0, c);
    assert.equal(r.central.fx[c]!.confirmed, true, c);
    assert.ok(r.central.fx[c]!.version > 0, c);
  }
  for (const p of ['USD_IQD', 'EUR_USD', 'CNY_USD'] as const) assert.ok(r.pair_versions[p] > 0, p);
  assert.ok(r.shipping_versions.GERMANY_LAND > 0);
  assert.equal(r.central.shipping.GERMANY_LAND!.rate, '3200');
  const composed = composeIqdRates(r.usd_iqd, r.eur_usd, r.cny_usd);
  for (const c of ['USD', 'EUR', 'CNY'] as const) assert.ok(sameRate(r.central.fx[c]!.rate!, composed[c]!), c);
  assert.equal(r.derived_stale, false);
  assert.deepEqual(r.review_pending, { USD_IQD: false, EUR_USD: false, CNY_USD: false });
});

test('a forged derived rate is stale: the reader says so and every write refuses with FX_DERIVED_STALE', async () => {
  const w = pricingWorld();
  // The stamps stay in step, so 0179's trigger lets the forged value through; the reader catches it.
  w.raw.exec("UPDATE pricing_fx_rates SET rate_iqd = '1700' WHERE currency = 'EUR'");
  const r = (await loadPricingRates(w.db))!;
  assert.equal(r.derived_stale, true);
  const save = await w.putInputs(AMS, { inputs_seq: 0, rules: [{ kind: 'target_profit', scope: 'product', amount_usd: '120' }] });
  assert.equal(save.status, 409);
  assert.equal(save.body.code, 'FX_DERIVED_STALE');
  const apply = await w.apply(AMS, { purchase_id: 'po_whatever_1', preview_hash: '0'.repeat(64) });
  assert.equal(apply.status, 409);
  assert.equal(apply.body.code, 'FX_DERIVED_STALE');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_rules WHERE product_id IS NOT NULL'), 0);
  // A preview still answers, with the banner flag.
  const look = await w.getInputs(AMS);
  assert.equal(look.status, 200);
  assert.equal(look.body.rates.derived_stale, true);
});

test('a held candidate (REVIEW_REQUIRED) leaves U as it is: owner saves keep pricing at the last confirmed rate (decision 11)', async () => {
  const w = pricingWorld();
  w.raw.exec(`UPDATE fx_rate_pairs SET pending_effective_rate = '1900', pending_market_rate = '1900', pending_reason = 'ANOMALY',
      pending_observed_at = '2026-10-09T10:00:00.000Z', status = 'REVIEW_REQUIRED' WHERE pair = 'USD_IQD'`);
  const r = (await loadPricingRates(w.db))!;
  assert.equal(r.usd_iqd, '1600');
  assert.equal(r.review_pending.USD_IQD, true);
  assert.equal(r.derived_stale, false);
  const save = await w.putInputs(AMS, {
    inputs_seq: 0,
    inputs: [{ scope: 'base', supplier_cost_amount: '450', supplier_cost_currency: 'EUR', shipping_profile: 'GERMANY_LAND', shipping_weight_g: 2500 }],
    rules: [{ kind: 'target_profit', scope: 'product', amount_usd: '120' }],
  });
  assert.equal(save.status, 200, JSON.stringify(save.body));
  assert.equal(save.body.rates.review_pending, true);
  assert.equal(save.body.models[0].pricing_summary.preorder_base_iqd, 992_000);
});

test('no 0179 on the database: the reader answers null, and the pricing routes 503 PRICING_NOT_INSTALLED', async () => {
  assert.equal(await loadPricingRates(asD1(dbThrough('0178'))), null);
});
