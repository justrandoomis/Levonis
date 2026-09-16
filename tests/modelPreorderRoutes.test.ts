/**
 * A MODEL'S OWN PRE-ORDER ROUTE IS A REAL OFFER.
 *
 * THE BUG. Migration 0073 moved pre-order transports onto the MODEL: the
 * admin's «نوع الطلب لكل موديل» door writes `product_option_fulfillment` and
 * `product_option_transports`, and mirrors only `sale_types` back to the
 * product row — it never writes `products.preorder_transports`. Two readers
 * still gated on that product column alone:
 *
 *   `saleAvailability` built its route list from `doc.preorder_transports`, so
 *   a model with a configured LAND route and an empty product list reported
 *   `NO_TRANSPORT_OFFERED`, `pre_order` came back unusable, and the product
 *   page rendered no order-type selector at all — direct sale was the only
 *   thing on the screen and pre-order was unreachable.
 *
 *   `resolveUnitPrice` refused the same route with `TRANSPORT_NOT_OFFERED`, so
 *   even a UI-only fix would have painted a choice the cart then rejected.
 *
 * That is the owner's report exactly: both order types enabled in the admin,
 * LAND configured, and a product page offering only «بيع مباشر».
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saleAvailability } from '../worker/routes/products';
import { resolveUnitPrice } from '../packages/pricing/src/pricing';

type Doc = Parameters<typeof saleAvailability>[0];

/** The A1 Combo as the admin actually configured it: direct sale WITH stock,
 *  plus a pre-order cell carrying one LAND route priced at 60,000. */
const option = (over: Record<string, unknown> = {}) => ({
  id: 'o1',
  name_ar: 'A1 Combo',
  name_en: 'A1 Combo',
  name_ckb: '',
  image: '',
  order: 0,
  active: true,
  regular_price_iqd: 950_000,
  prime_price_iqd: null,
  pro_price_iqd: null,
  cost_iqd: null,
  availability_type: '',
  stock: 4,
  fulfillments: [
    {
      fulfillment_type: 'direct_sale',
      enabled: true,
      regular_price_iqd: 950_000,
      prime_price_iqd: null,
      pro_price_iqd: null,
      cost_iqd: null,
      transports: [],
    },
    {
      fulfillment_type: 'pre_order',
      enabled: true,
      regular_price_iqd: null,
      prime_price_iqd: null,
      pro_price_iqd: null,
      cost_iqd: null,
      transports: [{ method: 'land', enabled: true, surcharge_iqd: 60_000 }],
    },
  ],
  ...over,
});

/** THE PRODUCT ROW CARRIES NO ROUTES — which is what the admin's per-model
 *  door leaves behind, and what used to make the whole thing unreachable. */
const doc = (over: Record<string, unknown> = {}): Doc =>
  ({
    selling_type: 'direct_sale',
    sale_types: ['direct_sale', 'pre_order'],
    stock: 4,
    options: [option()],
    colors: [],
    preorder_transports: [],
    ...over,
  }) as unknown as Doc;

const defaults = [{ method: 'land', commission_iqd: 40_000 }];

test('a model that declares its own LAND route makes pre-order usable', () => {
  const a = saleAvailability(doc(), { optionValueIds: ['o1'], qty: 1, transportDefaults: defaults });

  const pre = a.modes.find((m) => m.type === 'pre_order');
  assert.ok(pre, 'pre_order must be among the modes');
  assert.equal(pre!.usable, true, `pre_order refused: ${pre!.reason}`);
  assert.equal(pre!.reason, null);

  // The route itself is offered, priced from the MODEL's own figure — the
  // first rung of the ladder, not the product's and not the admin default.
  assert.deepEqual(
    a.preorder.transports.map((t) => [t.method, t.commission_iqd]),
    [['land', 60_000]]
  );

  // And direct sale is still there, so the customer gets a real CHOICE — which
  // is the only condition under which the selector renders at all.
  const direct = a.modes.find((m) => m.type === 'direct_sale');
  assert.equal(direct?.usable, true);
});

test('the quote accepts the route the page just offered', () => {
  // The second half of the defect: a pill the cart refuses is worse than no
  // pill. Same model, same empty product list, priced for real.
  const r = resolveUnitPrice({
    product: { ...(doc() as unknown as Record<string, unknown>), price_iqd: 950_000, preorder_transports: [] },
    optionId: 'o1',
    fulfillmentType: 'pre_order',
    transportMethod: 'land',
    transportDefaults: defaults,
  } as unknown as Parameters<typeof resolveUnitPrice>[0]);

  assert.ok(!r.errors.includes('TRANSPORT_NOT_OFFERED'), `refused: ${r.errors.join(', ')}`);
  assert.ok(!r.errors.includes('TRANSPORT_COMMISSION_UNCONFIGURED'), r.errors.join(', '));
  assert.equal(r.transport?.method, 'land');
  // The model's 60,000 REPLACES the 40,000 default; it never adds to it.
  assert.equal(r.transport?.commission_iqd, 60_000);
});

test('the product list still works, and is still the fallback it always was', () => {
  // A model with no routes of its own falls through to the product row —
  // the pre-0073 behaviour, unchanged.
  const legacy = doc({
    options: [option({ fulfillments: [] })],
    preorder_transports: [{ method: 'sea', commission_iqd: 30_000, active: true }],
  });
  const a = saleAvailability(legacy, { optionValueIds: ['o1'], qty: 1, transportDefaults: defaults });
  assert.deepEqual(
    a.preorder.transports.map((t) => [t.method, t.commission_iqd]),
    [['sea', 30_000]]
  );
});

test('a model route with no price of its own falls to the product, then the default', () => {
  const noPrice = doc({
    options: [
      option({
        fulfillments: [
          {
            fulfillment_type: 'pre_order',
            enabled: true,
            regular_price_iqd: null,
            prime_price_iqd: null,
            pro_price_iqd: null,
            cost_iqd: null,
            transports: [{ method: 'land', enabled: true, surcharge_iqd: null }],
          },
        ],
      }),
    ],
  });
  const a = saleAvailability(noPrice, { optionValueIds: ['o1'], qty: 1, transportDefaults: defaults });
  assert.deepEqual(
    a.preorder.transports.map((t) => [t.method, t.commission_iqd]),
    [['land', 40_000]],
    'the admin default is the last rung, and it is reached'
  );
});

test('a disabled model route is not offered', () => {
  const off = doc({
    options: [
      option({
        fulfillments: [
          {
            fulfillment_type: 'pre_order',
            enabled: true,
            regular_price_iqd: null,
            prime_price_iqd: null,
            pro_price_iqd: null,
            cost_iqd: null,
            transports: [{ method: 'land', enabled: false, surcharge_iqd: 60_000 }],
          },
        ],
      }),
    ],
  });
  const a = saleAvailability(off, { optionValueIds: ['o1'], qty: 1, transportDefaults: defaults });
  assert.deepEqual(a.preorder.transports, []);
  assert.equal(a.modes.find((m) => m.type === 'pre_order')?.usable, false);
});
