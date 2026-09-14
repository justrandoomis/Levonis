/**
 * THE OWNER'S FOUR CONCEPTS, PRICED — with their own numbers.
 *
 *   PRODUCT OPTION != ORDER TYPE != PREORDER TRANSPORT != LOCAL DELIVERY
 *
 * Every case below is one of the rules stated in the mandate, written as the
 * arithmetic it has to produce:
 *
 *   * a model carries its OWN direct difference (A1 mini +50,000 while the
 *     Combo is +20,000 — one `products.direct_surcharge_iqd` cannot say both);
 *   * an override REPLACES its fallback (model Air 80,000 over product Air
 *     50,000 is 80,000, not 130,000);
 *   * the PRO transport exemption waives the SHIPPING FEE and never the
 *     model's price delta (900,000 + 200,000 + Air waived = 1,100,000);
 *   * the order type is an independent CHOICE, not something inferred from
 *     whether a transport was sent.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveUnitPrice } from '../worker/lib/pricing';
import type { PricingProduct, OptionV2, OptionFulfillment } from '../worker/lib/pricing';

const model = (id: string, name: string, fulfillments: OptionFulfillment[], over: Partial<OptionV2> = {}): OptionV2 => ({
  id,
  name_ar: name,
  name_en: name,
  name_ckb: '',
  image: '',
  order: 0,
  active: true,
  regular_price_iqd: null,
  prime_price_iqd: null,
  pro_price_iqd: null,
  cost_iqd: null,
  fulfillments,
  ...over,
});

const product = (over: Partial<PricingProduct> = {}): PricingProduct => ({
  price_iqd: 499_000,
  pro_price_iqd: null,
  prime_price_iqd: null,
  product_cost_iqd: null,
  options: [],
  colors: [],
  preorder_transports: [],
  warranty_plans: [],
  selling_type: 'pre_order',
  sale_types: ['pre_order', 'direct_sale'],
  ...over,
});

const free = { tier: 'free' as const, tierActive: false };
const pro = { tier: 'pro' as const, tierActive: true };

/** The A1 mini exactly as the owner described it. */
function a1(): PricingProduct {
  return product({
    direct_surcharge_iqd: 30_000, // the product-level FALLBACK — neither model uses it
    preorder_transports: [
      { method: 'air', commission_iqd: 50_000, active: true },
      { method: 'sea', commission_iqd: 20_000, active: true },
    ],
    options: [
      model('m-mini', 'A1 mini', [
        { fulfillment_type: 'pre_order', regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null },
        { fulfillment_type: 'direct_sale', regular_price_iqd: 549_000, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null },
      ]),
      model('m-combo', 'A1 mini Combo', [
        { fulfillment_type: 'pre_order', regular_price_iqd: 679_000, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null },
        { fulfillment_type: 'direct_sale', regular_price_iqd: 699_000, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null },
      ]),
    ],
  });
}

// ---------------------------------------------------------------------------

test('one product carries two DIFFERENT direct differences at the same time', () => {
  const p = a1();

  const miniPre = resolveUnitPrice({ product: p, optionId: 'm-mini', fulfillmentType: 'pre_order', transportMethod: 'sea', ...free });
  const miniDir = resolveUnitPrice({ product: p, optionId: 'm-mini', fulfillmentType: 'direct_sale', ...free });
  assert.equal(miniPre.applied_iqd, 499_000, 'the mini pre-order inherits the product base');
  assert.equal(miniDir.applied_iqd, 549_000);
  assert.equal(miniDir.applied_iqd - miniPre.applied_iqd, 50_000);

  const comboPre = resolveUnitPrice({ product: p, optionId: 'm-combo', fulfillmentType: 'pre_order', transportMethod: 'sea', ...free });
  const comboDir = resolveUnitPrice({ product: p, optionId: 'm-combo', fulfillmentType: 'direct_sale', ...free });
  assert.equal(comboPre.applied_iqd, 679_000);
  assert.equal(comboDir.applied_iqd, 699_000);
  assert.equal(comboDir.applied_iqd - comboPre.applied_iqd, 20_000);

  // And the product's single fallback premium is NOT charged on top of either —
  // the model already said what its direct sale costs.
  assert.equal(miniDir.direct, null);
  assert.equal(comboDir.direct, null);
  assert.equal(miniDir.unit_subtotal_iqd, 549_000);
  assert.equal(comboDir.unit_subtotal_iqd, 699_000);
});

test('the product premium is still the fallback for a model that says nothing', () => {
  const p = product({
    direct_surcharge_iqd: 30_000,
    options: [model('m-plain', 'Plain', [])],
  });
  const r = resolveUnitPrice({ product: p, optionId: 'm-plain', fulfillmentType: 'direct_sale', ...free });
  assert.equal(r.applied_iqd, 499_000);
  assert.deepEqual(r.direct, { surcharge_iqd: 30_000, waived: false });
  assert.equal(r.unit_subtotal_iqd, 529_000);
  assert.equal(r.fulfillment.from_option_cell, false);
});

// --------------------------------------------------------- OVERRIDE ≠ SUM

test('a model Air surcharge REPLACES the product Air commission — 80,000, not 130,000', () => {
  const p = product({
    preorder_transports: [{ method: 'air', commission_iqd: 50_000, active: true }],
    options: [
      model('m', 'M', [
        {
          fulfillment_type: 'pre_order',
          regular_price_iqd: null,
          prime_price_iqd: null,
          pro_price_iqd: null,
          cost_iqd: null,
          transports: [{ method: 'air', surcharge_iqd: 80_000, regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null }],
        },
      ]),
    ],
  });
  const r = resolveUnitPrice({ product: p, optionId: 'm', fulfillmentType: 'pre_order', transportMethod: 'air', ...free });
  assert.equal(r.transport?.commission_iqd, 80_000);
  assert.equal(r.unit_subtotal_iqd, 499_000 + 80_000);
  assert.notEqual(r.unit_subtotal_iqd, 499_000 + 130_000);
});

test('a model that prices the ROUTE in the item price is not also charged the product commission', () => {
  const p = product({
    preorder_transports: [{ method: 'air', commission_iqd: 50_000, active: true }],
    options: [
      model('m', 'M', [
        {
          fulfillment_type: 'pre_order',
          regular_price_iqd: null,
          prime_price_iqd: null,
          pro_price_iqd: null,
          cost_iqd: null,
          // The route's cost expressed as part of the ITEM's price.
          transports: [{ method: 'air', regular_adjust_iqd: 90_000, regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null }],
        },
      ]),
    ],
  });
  const r = resolveUnitPrice({ product: p, optionId: 'm', fulfillmentType: 'pre_order', transportMethod: 'air', ...free });
  assert.equal(r.applied_iqd, 589_000, 'the adjustment moved the item price');
  assert.equal(r.transport?.commission_iqd, 0, 'and the fee stands aside rather than billing it twice');
  assert.equal(r.unit_subtotal_iqd, 589_000);
});

test('with no model row for the route, the product commission is still the fallback', () => {
  const p = product({
    preorder_transports: [{ method: 'sea', commission_iqd: 20_000, active: true }],
    options: [model('m', 'M', [{ fulfillment_type: 'pre_order', regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null }])],
  });
  const r = resolveUnitPrice({ product: p, optionId: 'm', fulfillmentType: 'pre_order', transportMethod: 'sea', ...free });
  assert.equal(r.transport?.commission_iqd, 20_000);
  assert.equal(r.unit_subtotal_iqd, 519_000);
});

// ------------------------------------------------------- THE PRO EXEMPTION

test('a PRO exempt from the Air fee still pays the model delta — 1,100,000, not 900,000', () => {
  // The owner's numbers: PRO base 900,000, Combo +200,000, Air +100,000 waived.
  const p = product({
    price_iqd: 1_000_000,
    pro_price_iqd: 900_000,
    preorder_transports: [{ method: 'air', commission_iqd: 100_000, active: true }],
    options: [
      model('m-combo', 'Combo', [
        { fulfillment_type: 'pre_order', regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null },
      ], { regular_adjust_iqd: 200_000 }),
    ],
  });
  const r = resolveUnitPrice({ product: p, optionId: 'm-combo', fulfillmentType: 'pre_order', transportMethod: 'air', ...pro });
  assert.equal(r.applied_tier, 'pro');
  assert.equal(r.applied_iqd, 1_100_000, 'the PRO price carries the model surcharge');
  assert.equal(r.transport?.waived, true);
  assert.equal(r.transport?.waived_by, 'pro');
  assert.equal(r.unit_subtotal_iqd, 1_100_000, 'the fee is waived; the delta is not');
  assert.notEqual(r.unit_subtotal_iqd, 900_000);
});

test('the PRO exemption waives the FEE and never a per-route item price', () => {
  const p = product({
    price_iqd: 1_000_000,
    pro_price_iqd: 900_000,
    preorder_transports: [{ method: 'air', commission_iqd: 100_000, active: true }],
    options: [
      model('m', 'M', [
        {
          fulfillment_type: 'pre_order',
          regular_price_iqd: null,
          prime_price_iqd: null,
          pro_price_iqd: null,
          cost_iqd: null,
          transports: [{ method: 'air', regular_adjust_iqd: 60_000, regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null }],
        },
      ]),
    ],
  });
  const r = resolveUnitPrice({ product: p, optionId: 'm', fulfillmentType: 'pre_order', transportMethod: 'air', ...pro });
  // The route's +60,000 is part of the item, so the PRO ladder carries it.
  assert.equal(r.applied_iqd, 960_000);
  assert.equal(r.unit_subtotal_iqd, 960_000, 'and the commission it replaced is not charged');
});

// --------------------------------------------------- ORDER TYPE IS A CHOICE

test('the order type is stated, not inferred from the presence of a transport', () => {
  const p = a1();
  const stated = resolveUnitPrice({ product: p, optionId: 'm-mini', fulfillmentType: 'direct_sale', ...free });
  assert.equal(stated.fulfillment.type, 'direct_sale');
  assert.equal(stated.fulfillment.source, 'stated');

  // Omitting it keeps the pre-0073 inference exactly as it was.
  const inferred = resolveUnitPrice({ product: p, optionId: 'm-mini', transportMethod: 'sea', ...free });
  assert.equal(inferred.fulfillment.type, 'pre_order');
  assert.equal(inferred.fulfillment.source, 'inferred');
  assert.deepEqual(inferred.errors, []);
});

test('asking for an order type the model does not offer is refused, not silently repriced', () => {
  const p = product({
    options: [model('m', 'M', [{ fulfillment_type: 'pre_order', regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null }])],
  });
  const r = resolveUnitPrice({ product: p, optionId: 'm', fulfillmentType: 'direct_sale', ...free });
  assert.ok(r.errors.includes('FULFILLMENT_NOT_OFFERED'));
});

test('a switched-off cell does not price the line, and says so', () => {
  const p = product({
    direct_surcharge_iqd: 30_000,
    options: [
      model('m', 'M', [
        { fulfillment_type: 'direct_sale', enabled: false, regular_price_iqd: 700_000, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null },
      ]),
    ],
  });
  const r = resolveUnitPrice({ product: p, optionId: 'm', fulfillmentType: 'direct_sale', ...free });
  assert.ok(r.errors.includes('FULFILLMENT_DISABLED'));
  assert.equal(r.applied_iqd, 499_000, 'a disabled cell never prices anything');
});

// ------------------------------------------------------------- LEAD TIME

test('the most specific lead-time promise wins, and a direct sale makes none', () => {
  const p = product({
    preorder_transports: [
      { method: 'air', commission_iqd: 10_000, active: true },
      { method: 'sea', commission_iqd: 5_000, active: true },
    ],
    options: [
      model('m', 'M', [
        {
          fulfillment_type: 'pre_order',
          regular_price_iqd: null,
          prime_price_iqd: null,
          pro_price_iqd: null,
          cost_iqd: null,
          lead_time_text: '٢١ إلى ٣٠ يوم',
          lead_time_min_days: 21,
          lead_time_max_days: 30,
          transports: [
            { method: 'air', lead_time_text: '٧ إلى ١٠ أيام', lead_time_min_days: 7, lead_time_max_days: 10, regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null },
          ],
        },
        { fulfillment_type: 'direct_sale', regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null },
      ]),
    ],
  });

  const air = resolveUnitPrice({ product: p, optionId: 'm', fulfillmentType: 'pre_order', transportMethod: 'air', ...free });
  assert.equal(air.fulfillment.lead_time_text, '٧ إلى ١٠ أيام');
  assert.equal(air.fulfillment.lead_time_min_days, 7);

  const sea = resolveUnitPrice({ product: p, optionId: 'm', fulfillmentType: 'pre_order', transportMethod: 'sea', ...free });
  assert.equal(sea.fulfillment.lead_time_text, '٢١ إلى ٣٠ يوم', 'no row for this route, so the order type answers');

  const direct = resolveUnitPrice({ product: p, optionId: 'm', fulfillmentType: 'direct_sale', ...free });
  assert.equal(direct.fulfillment.lead_time_text, '');
});

// ------------------------------------------------- NOTHING OLD MOVES A DINAR

test('a product with no fulfilment cells resolves exactly as it did before 0073', () => {
  const p = product({
    price_iqd: 100_000,
    direct_surcharge_iqd: 15_000,
    selling_type: 'direct_sale',
    sale_types: ['direct_sale'],
    options: [model('m', 'M', [], { regular_adjust_iqd: 25_000 })],
    colors: [
      {
        id: 'c',
        name_ar: 'أسود',
        name_en: 'Black',
        name_ckb: '',
        hex: '#000',
        image: '',
        option_id: null,
        order: 0,
        active: true,
        regular_price_iqd: null,
        prime_price_iqd: null,
        pro_price_iqd: null,
        cost_iqd: null,
        regular_adjust_iqd: 5_000,
      },
    ],
  });
  const r = resolveUnitPrice({ product: p, optionId: 'm', colorId: 'c', ...free });
  assert.equal(r.applied_iqd, 130_000);
  assert.equal(r.price_source, 'color');
  assert.deepEqual(r.direct, { surcharge_iqd: 15_000, waived: false });
  assert.equal(r.unit_subtotal_iqd, 145_000);
  assert.equal(r.fulfillment.from_option_cell, false);
});

test('a colour surcharge is paid on every route, above the fulfilment rung', () => {
  const p = product({
    options: [
      model('m', 'M', [
        { fulfillment_type: 'direct_sale', regular_price_iqd: 549_000, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null },
      ]),
    ],
    colors: [
      {
        id: 'c',
        name_ar: 'أبيض',
        name_en: 'White',
        name_ckb: '',
        hex: '#fff',
        image: '',
        option_id: null,
        order: 0,
        active: true,
        regular_price_iqd: null,
        prime_price_iqd: null,
        pro_price_iqd: null,
        cost_iqd: null,
        regular_adjust_iqd: 10_000,
      },
    ],
  });
  const r = resolveUnitPrice({ product: p, optionId: 'm', colorId: 'c', fulfillmentType: 'direct_sale', ...free });
  assert.equal(r.applied_iqd, 559_000, 'the colour is a surcharge on whatever the route costs');
  assert.equal(r.price_source, 'color');
});
