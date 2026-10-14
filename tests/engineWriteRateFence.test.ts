/**
 * THE ENGINE WRITE IS FENCED ON THE RATES IT WAS PRICED AT (USD design §6.4;
 * owner decision 11: only the last confirmed rates feed a stored price).
 *
 * A pricing route reads the central rates FIRST and the product's store (with
 * its `config_version`) AFTER; a bulk save reads the rates once for its whole
 * loop. A rate committed in between moved `config_version` before the store was
 * read, so the store fence alone passed and the batch wrote a price computed at
 * the superseded rate. The batch now compares every central rate by value with
 * the ones the evaluation used: a moved rate refuses the write (fence miss →
 * 409 PRICING_CHANGED), nothing is written, and the same save evaluated at the
 * current rate writes the current price.
 *
 * Run: node --import tsx --test tests/engineWriteRateFence.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { row } from './fixtures/app';
import { applyRate } from './fixtures/fx';
import { pricingWorld } from './fixtures/procurementPricing';
import { loadPricingRates } from '../worker/lib/pricingEngine/rates';
import { rateFenceBinds, RATES_FENCE_SQL } from '../worker/lib/pricingEngine/engineWrite';

// The V1 price write this file once raced (PUT …/inputs, the engine writer) is closed by the clean start
// (DECISIONS row 222, addendum A.6); the rate fence the V2 writer reuses stays pinned as a pure SQL unit.
test('the rate fence compares every central rate by value, a missing one included', async () => {
  const w = pricingWorld();
  const rates = (await loadPricingRates(w.db))!;
  const holds = () => row<{ ok: number }>(w.raw, `SELECT CASE WHEN ${RATES_FENCE_SQL} THEN 1 ELSE 0 END AS ok`, ...rateFenceBinds(rates))!.ok;
  assert.equal(holds(), 1, 'the rates as read');
  w.raw.exec("UPDATE pricing_shipping_rates SET rate_iqd = '3300', version = version + 1 WHERE profile = 'GERMANY_LAND'");
  assert.equal(holds(), 0, 'a shipping rate that moved');
  w.raw.exec("UPDATE pricing_shipping_rates SET rate_iqd = '3200', version = version + 1 WHERE profile = 'GERMANY_LAND'");
  assert.equal(holds(), 1);
  applyRate(w.raw, 'CNY_USD', '0.15');
  assert.equal(holds(), 0, 'a cross rate that moved (CNY = C × U)');

  const empty = pricingWorld({ rates: false });
  const none = (await loadPricingRates(empty.db))!;
  assert.equal(
    row<{ ok: number }>(empty.raw, `SELECT CASE WHEN ${RATES_FENCE_SQL} THEN 1 ELSE 0 END AS ok`, ...rateFenceBinds(none))!.ok,
    1,
    'missing rates stay missing (IS NULL), never a NULL condition'
  );
});
