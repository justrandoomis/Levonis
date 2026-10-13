/**
 * REVIEW (direct-invest group, 735ea955 + 5e0593f2): the apply-purchase
 * idempotency key is `apply:<purchase>:<product>:<derived_hash>`, and the
 * derived hash covers the purchase and the owner's typed choices only — not
 * the store they are applied to. With the Direct Sale Extra typed in place on
 * the review (735ea955) and kept in the stock overlay (5e0593f2), changing the
 * extra 50,000 → 0 → 50,000 on the same purchase makes the third apply hit the
 * FIRST apply's key: it answers 200 `already: true` and writes nothing, while
 * the stored overlay — and the customer's direct price — keep the 0 from the
 * second apply. The owner was shown (and confirmed) the 50,000 preview.
 *
 * Run: node --import tsx --test tests/review_direct-invest_extra_aba.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { row } from './fixtures/app';
import { pricingWorld, AMS, AMS_MODEL } from './fixtures/procurementPricing';
import { directPurchaseStore } from '../worker/lib/pricingEngine/directPurchase';
import { loadProductPricing } from '../worker/lib/pricingEngine/store';

const MIN = { product_id: AMS, scope: 'product', amount_usd: '120' };
const extras = (amount_iqd: number) => [{ product_id: AMS, scope: 'product', scope_id: '', amount_iqd }];

test('re-applying an earlier Direct Sale Extra on the same purchase writes it again (A → B → A)', async () => {
  const w = pricingWorld();
  const id = await w.save(w.draft());
  const directPrice = () => row<{ p: number }>(w.raw, "SELECT regular_price_iqd AS p FROM product_option_fulfillment WHERE option_id = ? AND fulfillment_type = 'direct_sale'", AMS_MODEL)!.p;
  const storedExtra = async () => directPurchaseStore(await loadProductPricing(w.db, AMS)).rules.find((r) => r.kind === 'direct_sale_extra')?.amount_iqd;

  const applyWith = async (amount: number) => {
    const look = await w.preview({ purchase_id: id, pricing: { minimum_profits: [MIN], direct_sale_extras: extras(amount) } });
    assert.equal(look.status, 200, JSON.stringify(look.body));
    const product = look.body.products[0];
    const shown = (product.adoption.rows as Array<{ channel: string; computed_price_iqd: number }>).find((r) => r.channel === 'direct_sale')?.computed_price_iqd;
    const out = await w.apply(AMS, {
      purchase_id: id,
      minimum_profits: [{ scope: 'product', amount_usd: '120' }],
      direct_sale_extras: [{ scope: 'product', scope_id: '', amount_iqd: amount }],
      preview_hash: product.preview_hash,
      confirm_large_change: true,
    });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    return { shown, out: out.body, price: directPrice(), extra: await storedExtra() };
  };

  const a = await applyWith(50_000);
  assert.equal(a.price, 1_042_000);
  const b = await applyWith(0);
  assert.equal(b.price, 992_000);
  const again = await applyWith(50_000);
  const facts = { a, b, again };
  assert.equal(again.shown, 1_042_000, 'the preview the owner confirmed shows the 50,000 extra');
  assert.notEqual(again.out.already, true, `the confirm is not swallowed as a replay: ${JSON.stringify(facts)}`);
  assert.equal(again.extra, 50_000, JSON.stringify(facts));
  assert.equal(again.price, 1_042_000, JSON.stringify(facts));
});
