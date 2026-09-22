/**
 * «الدفع عند الاستلام والذي سعره نفس سعر البيع المباشر … وعن طريق محفظة ليفو
 *  الذي يكون سعره أرخص … السلوك الخاطئ المتبع حاليا هو حساب الدفع عند الاستلام
 *  و محفظة ليفو نفس السعر.»
 *
 * The rule has been in the codebase since #96 and has been dead since #10.
 *
 * It was implemented once, through `products.direct_surcharge_iqd` — a single
 * scalar on the PRODUCT. #10 then removed the product-level surcharge control
 * and moved availability onto per-option CELLS, so on every product configured
 * since, that scalar is null, the COD branch never fires, and the door costs
 * exactly what the wallet costs. Measured on the owner's own shape: wallet
 * 505,000, COD 505,000, direct 550,000 — the shop absorbing 45,000 IQD on
 * every unit it hands over for cash.
 *
 * So the resolver's question had to change from "is there a direct PREMIUM?"
 * to "is there a direct CELL to price from?", and that change splits one
 * variable into two that had been the same thing for the whole life of this
 * function:
 *
 *   lineType    — WHAT THE CUSTOMER ORDERED. A COD pre-order is a pre-order in
 *                 every sense that is not money: FULFILLMENT_NOT_OFFERED, the
 *                 import quota, the lead time, the route, `shipping_type` and
 *                 all fourteen pre-order stages read this and must not move.
 *   pricingType — WHICH LADDER THE MONEY COMES OFF. Only this moves.
 *
 * Every test below is one half of that split. The first four are the money;
 * the rest exist because conflating the two is how a COD pre-order ends up
 * either free of its premium or charged twice for it — and because a validity
 * check that read the PRICING cell would clear a pre-order the shop had
 * switched off, on the grounds that the DIRECT cell beside it is open.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveUnitPrice } from '../worker/lib/pricing';
import type { PricingProduct, OptionFulfillment, OptionTransport, OptionV2 } from '../worker/lib/pricing';

const cell = (over: Partial<OptionFulfillment> & { fulfillment_type: 'direct_sale' | 'pre_order' }): OptionFulfillment => ({
  regular_price_iqd: null,
  prime_price_iqd: null,
  pro_price_iqd: null,
  cost_iqd: null,
  ...over,
});

const route = (over: Partial<OptionTransport> & { method: 'air' | 'sea' | 'land' }): OptionTransport => ({
  regular_price_iqd: null,
  prime_price_iqd: null,
  pro_price_iqd: null,
  cost_iqd: null,
  ...over,
});

/**
 * The owner's shape, to the dinar: a base of 500,000, a pre-order cell at
 * 480,000 reached by Air for 25,000 (= the 505,000 on the wallet screen), and
 * a direct cell at 550,000.
 */
function shop(fulfillments: OptionFulfillment[]): PricingProduct {
  const option: OptionV2 = {
    id: 'm1',
    name_ar: 'A1',
    name_en: 'A1',
    name_ckb: '',
    image: '',
    order: 0,
    active: true,
    regular_price_iqd: null,
    prime_price_iqd: null,
    pro_price_iqd: null,
    cost_iqd: null,
    fulfillments,
  };
  return {
    price_iqd: 500_000,
    pro_price_iqd: null,
    prime_price_iqd: null,
    product_cost_iqd: null,
    options: [option],
    colors: [],
    preorder_transports: [{ method: 'air', commission_iqd: 25_000, active: true }],
    warranty_plans: [],
    selling_type: 'pre_order',
    sale_types: ['pre_order', 'direct_sale'],
  };
}

const bothCells = (): PricingProduct => shop([
  cell({ fulfillment_type: 'pre_order', regular_price_iqd: 480_000, transports: [route({ method: 'air', enabled: true, surcharge_iqd: 25_000 })] }),
  cell({ fulfillment_type: 'direct_sale', regular_price_iqd: 550_000, transports: [] }),
]);

const buy = (product: PricingProduct, preorderPricing: 'prepaid' | 'cod') =>
  resolveUnitPrice({
    product,
    optionId: 'm1',
    transportMethod: 'air',
    fulfillmentType: 'pre_order',
    preorderPricing,
    tier: 'free',
    tierActive: false,
  });

// --- the money -------------------------------------------------------------

test('the wallet keeps the pre-order price and the door pays the direct one', () => {
  const p = bothCells();
  assert.equal(buy(p, 'prepaid').unit_subtotal_iqd, 505_000, 'pre-order 480,000 + Air 25,000');
  assert.equal(buy(p, 'cod').unit_subtotal_iqd, 550_000, 'the direct cell, whole');
  assert.equal(
    buy(p, 'cod').unit_subtotal_iqd - buy(p, 'prepaid').unit_subtotal_iqd,
    45_000,
    'the 45,000 the shop was absorbing on every unit handed over for cash'
  );
});

test('the commission steps aside for the direct premium — they never stack', () => {
  const cod = buy(bothCells(), 'cod');
  assert.equal(cod.pricing_basis, 'direct');
  assert.equal(cod.transport?.waived, true);
  assert.equal(cod.transport?.waived_by, 'cod_direct_pricing');
  assert.equal(cod.components.transport_fee_iqd, 0, 'charged twice is the other way this goes wrong');
});

test('a model with NO direct cell keeps its commission, so the door is never CHEAPER', () => {
  const p = shop([cell({ fulfillment_type: 'pre_order', regular_price_iqd: 480_000, transports: [route({ method: 'air', enabled: true, surcharge_iqd: 25_000 })] })]);
  assert.equal(buy(p, 'cod').unit_subtotal_iqd, 505_000);
  assert.equal(buy(p, 'cod').unit_subtotal_iqd, buy(p, 'prepaid').unit_subtotal_iqd);
  assert.equal(buy(p, 'cod').pricing_basis, 'preorder', 'nothing to price as a direct sale');
});

test('a direct cell the shop switched OFF is not a direct price either', () => {
  const p = shop([
    cell({ fulfillment_type: 'pre_order', regular_price_iqd: 480_000, transports: [route({ method: 'air', enabled: true, surcharge_iqd: 25_000 })] }),
    cell({ fulfillment_type: 'direct_sale', enabled: false, regular_price_iqd: 550_000 }),
  ]);
  assert.equal(buy(p, 'cod').unit_subtotal_iqd, 505_000);
  assert.equal(buy(p, 'cod').pricing_basis, 'preorder');
});

test('the ROUTE cannot drag the COD price back down to the wallet price', () => {
  /**
   * The ladder walks base → option → fulfilment → TRANSPORT → colour, so the
   * route sits BELOW the cell and wins. A route stating its own price is the
   * pre-order price on that route — reading it on a COD line would hand the
   * wallet price straight back, on every model whose Air row carries a figure.
   * A direct sale has no routes; the direct ladder has no rung here.
   */
  const p = shop([
    cell({ fulfillment_type: 'pre_order', regular_price_iqd: 480_000, transports: [route({ method: 'air', enabled: true, regular_price_iqd: 490_000 })] }),
    cell({ fulfillment_type: 'direct_sale', regular_price_iqd: 550_000, transports: [] }),
  ]);
  assert.equal(buy(p, 'prepaid').unit_subtotal_iqd, 490_000, 'prepaid still reads its route');
  assert.equal(buy(p, 'cod').unit_subtotal_iqd, 550_000);
});

// --- everything that is NOT money stays on the ordered cell -----------------

test('a COD line is still a PRE-ORDER, and still knows its route', () => {
  const cod = buy(bothCells(), 'cod');
  assert.equal(cod.fulfillment.type, 'pre_order', 'the fourteen stages, the quota and the lead time read this');
  assert.equal(cod.transport?.method, 'air', 'shipping_type and tracking read this');
  assert.deepEqual(cod.errors, []);
});

test('a switched-off PRE-ORDER cell is still refused when the direct cell beside it is open', () => {
  const p = shop([
    cell({ fulfillment_type: 'pre_order', enabled: false, regular_price_iqd: 480_000, transports: [route({ method: 'air', enabled: true, surcharge_iqd: 25_000 })] }),
    cell({ fulfillment_type: 'direct_sale', regular_price_iqd: 550_000, transports: [] }),
  ]);
  assert.ok(buy(p, 'prepaid').errors.includes('FULFILLMENT_DISABLED'));
  assert.ok(buy(p, 'cod').errors.includes('FULFILLMENT_DISABLED'), 'the pricing cell is the enabled one — ask the ORDERED cell');
});

test('a switched-off ROUTE is still refused under COD', () => {
  const p = shop([
    cell({ fulfillment_type: 'pre_order', regular_price_iqd: 480_000, transports: [route({ method: 'air', enabled: false, surcharge_iqd: 25_000 })] }),
    cell({ fulfillment_type: 'direct_sale', regular_price_iqd: 550_000, transports: [] }),
  ]);
  assert.ok(buy(p, 'prepaid').errors.includes('TRANSPORT_DISABLED'));
  assert.ok(
    buy(p, 'cod').errors.includes('TRANSPORT_DISABLED'),
    'routes live on the pre-order cell by type — looked up on the direct cell every route is absent, and absent reads as fine'
  );
});

test('prepaid is untouched: same numbers, same basis, same errors as before the split', () => {
  const pre = buy(bothCells(), 'prepaid');
  assert.equal(pre.pricing_basis, 'preorder');
  assert.equal(pre.transport?.waived, false);
  assert.equal(pre.components.transport_fee_iqd, 25_000);
  assert.equal(pre.direct, null);
});
