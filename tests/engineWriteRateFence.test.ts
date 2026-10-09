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
import { pricingWorld, AMS, AMS_MODEL } from './fixtures/procurementPricing';
import { loadPreviewContext, loadProducts } from '../worker/lib/pricingEngine/load';
import { loadPricingRates } from '../worker/lib/pricingEngine/rates';
import { loadProductPricing } from '../worker/lib/pricingEngine/store';
import { effectiveWrites, loadEngineReads, parseProductInputs, productEngineEvaluation } from '../worker/lib/pricingEngine/productInputs';
import { engineWriteStatements, rateFenceBinds, RATES_FENCE_SQL } from '../worker/lib/pricingEngine/engineWrite';
import { isFenceMiss } from '../worker/lib/fx/commit';

const COMPLETE = {
  inputs: [{ scope: 'base', supplier_cost_amount: '450', supplier_cost_currency: 'EUR', shipping_profile: 'GERMANY_LAND', shipping_weight_g: 2500 }],
  rules: [
    { kind: 'target_profit', scope: 'product', amount_usd: '120' },
    { kind: 'direct_sale_extra', scope: 'product', amount_iqd: 50_000 },
  ],
};

type World = ReturnType<typeof pricingWorld>;

async function adopt(w: World) {
  const first = await w.putInputs(AMS, { inputs_seq: 0, ...COMPLETE });
  assert.equal(first.status, 409, JSON.stringify(first.body));
  const hash = first.body.details.preview.preview_hash as string;
  const saved = await w.putInputs(AMS, { inputs_seq: 0, ...COMPLETE, preview_hash: hash, confirm_large_change: true });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
}

const landPrice = (w: World) =>
  row<{ regular_price_iqd: number }>(
    w.raw,
    `SELECT t.regular_price_iqd FROM product_option_transports t JOIN product_option_fulfillment f ON f.id = t.fulfillment_id
      WHERE t.product_id = ? AND f.option_id = ? AND t.method = 'land'`,
    AMS,
    AMS_MODEL
  )!.regular_price_iqd;

/** The owner's next save (minimum profit $120 → $130), evaluated at `rates`, against the store as it is NOW. */
async function nextSave(w: World, rates: NonNullable<Awaited<ReturnType<typeof loadPricingRates>>>) {
  const loaded = (await loadProducts(w.db, [AMS])).get(AMS)!;
  const [stored, ctx, reads] = await Promise.all([loadProductPricing(w.db, AMS), loadPreviewContext(w.db), loadEngineReads(w.db, AMS)]);
  const draft = parseProductInputs({ inputs: [], rules: [{ kind: 'target_profit', scope: 'product', amount_usd: '130' }] }, loaded, stored, { rates, now: new Date().toISOString() });
  const writes = effectiveWrites(draft);
  const ev = await productEngineEvaluation(loaded, stored, ctx, rates, draft, reads, { writes });
  assert.equal(ev.kind, 'reprice');
  assert.equal(ev.complete, true, ev.codes.join(','));
  const statements = await engineWriteStatements(w.db, ev, writes.inputWrites, writes.ruleWrites, {
    actor: 'usr_owner',
    now: new Date().toISOString(),
    source: 'product_form',
    idempotencyKey: `price:${AMS}:${ev.hash}`,
  });
  return { ev, statements };
}

test('a rate committed after the evaluation read its rates refuses the price write; nothing is written; at the current rate it writes', async () => {
  const w = pricingWorld();
  await adopt(w);
  assert.equal(landPrice(w), 992_000, 'adopted at $620 × 1,600');

  // The race: the save read its rates at U = 1,600 …
  const before = await loadPricingRates(w.db);
  assert.equal(before!.usd_iqd, '1600');
  // … then the USD/IQD rate moved (config_version moves with it) …
  applyRate(w.raw, 'USD_IQD', '1700');
  // … and the store (with the NEW config_version) is read after it.
  const stale = await nextSave(w, before!);
  assert.equal(stale.ev.rows.find((r) => r.channel === 'pre_order_land')!.new_iqd, 1_008_000, '$630 × 1,600: the superseded rate');
  await assert.rejects(w.db.batch(stale.statements), (e) => isFenceMiss(e), 'the rate fence refuses the batch');
  assert.equal(landPrice(w), 992_000, 'no price was written');
  assert.equal(
    row<{ amount_usd: string }>(w.raw, "SELECT amount_usd FROM pricing_rules WHERE product_id = ? AND kind = 'target_profit' AND scope = 'product'", AMS)!.amount_usd,
    '120',
    'nor the rule'
  );

  // The same save at the rates in force now writes the current price: (EUR 450 × 1.1 + 8,000 IQD ÷ 1,700 + $130) × 1,700.
  const now = await loadPricingRates(w.db);
  const fresh = await nextSave(w, now!);
  await w.db.batch(fresh.statements);
  assert.equal(landPrice(w), 1_071_000);
  assert.equal(row<{ usd_iqd_rate: string }>(w.raw, "SELECT usd_iqd_rate FROM pricing_sku_costs WHERE product_id = ? AND channel = 'pre_order_land'", AMS)!.usd_iqd_rate, '1700');
});

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
