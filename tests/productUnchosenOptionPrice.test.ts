/**
 * DECISIONS row 275 — THE PRICE BEFORE AN OPTION IS CHOSEN IS THE PRICE THAT WILL APPLY.
 *
 * The owner's product: base row 2,100,000, one option «X2D Combo» at 2,184,000 with a live 8% sale
 * (live 2,016,000 from its dollar price; this fixture is in dinars). A product with an active option
 * cannot be bought without one, so the page's unchosen figure (`price_levels.base`, which the quote
 * and the ways to buy follow through `unchosenStandIn`) is that option's sale price with the struck
 * 2,184,000 and «−8٪» — never the base 2,100,000. Several options: «يبدأ من» the cheapest. No
 * option: the base row, as before.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PRO_POLICY } from '../worker/lib/pricing';
import { parseProductRow } from '../worker/lib/productModel';
import type { OfferView } from '../worker/lib/offers';
import { priceLevels, standInOptionIds, type PricingCtx } from '../worker/routes/products';

const ctx: PricingCtx = {
  tier: 'free',
  tierActive: false,
  membershipActive: false,
  proContext: false,
  proPolicy: DEFAULT_PRO_POLICY,
  transportDefaults: [],
  tierStatus: null,
  benefitRules: [],
  catalogAncestry: null,
  benefitNowIso: '2026-10-28T12:00:00Z',
};

const option = (id: string, price: number, order = 0) => ({
  id, name_en: id, name_ar: id, name_ckb: id, regular_price_iqd: price, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null, active: true, order, image: '',
});

const row = (options: unknown[]): Record<string, unknown> => ({
  id: 'p_x2d', slug: 'bambu-lab-x2d', status: 'active', name: 'Bambu Lab X2D', price_iqd: 2_100_000,
  selling_type: 'direct_sale', sale_types: JSON.stringify(['direct_sale']),
  options: JSON.stringify(options), colors: '[]',
  images: '[]', specifications: '[]', labels: '[]', hashtags: '[]', warranty_plans: '[]',
  preorder_transports: '[]', content_blocks: '[]', payment_options: '[]',
});

const sale: OfferView = {
  window: {
    id: 'ofw_x2d', starts_at: null, ends_at: null, required_tiers: [], offer_price_mode: 'discount_percent',
    offer_price_iqd: null, discount_percent: 8, discount_iqd: null, plus_price_iqd: null, locked_preview: false, active: true,
  },
  limits: null,
};

test('one option on sale: the unchosen price is that option, sale included — never the base row', () => {
  const r = row([option('x2d-combo', 2_184_000)]);
  const levels = priceLevels(parseProductRow(r), ctx, sale, Date.now());
  assert.deepEqual(levels.base, levels.option['x2d-combo'], 'price_levels.base is the option level');
  assert.equal(levels.base.applied_iqd, 2_009_500, '2,184,000 − 8%, on the shop rounding step');
  assert.equal(levels.base.offer_before_iqd, 2_184_000);
  assert.equal(levels.base.offer_saving_percent, 8);
  assert.equal(levels.base_from, false, 'one option: no «يبدأ من»');

});

test('several options: «يبدأ من» the cheapest effective option; no options: the base row', () => {
  const r = row([option('combo', 2_184_000, 0), option('bundle', 2_500_000, 1)]);
  const levels = priceLevels(parseProductRow(r), ctx, null, Date.now());
  assert.equal(levels.base.applied_iqd, 2_184_000);
  assert.equal(levels.base_from, true);

  const flat = row([]);
  assert.deepEqual(standInOptionIds(parseProductRow(flat)), []);
  const flatLevels = priceLevels(parseProductRow(flat), ctx, null, Date.now());
  assert.equal(flatLevels.base.applied_iqd, 2_100_000);
  assert.equal('base_from' in flatLevels, false);
});

test('a switched-off option never stands in', () => {
  const r = row([{ ...option('off', 1_000_000, 0), active: false }, option('on', 2_184_000, 1)]);
  assert.deepEqual(standInOptionIds(parseProductRow(r)), ['on']);
  assert.equal(priceLevels(parseProductRow(r), ctx, null, Date.now()).base.applied_iqd, 2_184_000);
});
