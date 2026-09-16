import { test } from 'node:test';
import { resolveUnitPrice } from '../../worker/lib/pricing';
import type { PricingProduct } from '../../worker/lib/pricing';

const p: PricingProduct = {
  price_iqd: 499_000, pro_price_iqd: null, prime_price_iqd: null, product_cost_iqd: null,
  colors: [], warranty_plans: [], selling_type: 'direct_sale',
  sale_types: ['direct_sale', 'pre_order'],
  // THE PRODUCT DECLARES NO ROUTE — the FulfillmentPanel never writes this list
  preorder_transports: [],
  options: [{
    id: 'm', name_ar: 'A1 Combo', name_en: 'A1 Combo', name_ckb: '', image: '', order: 0, active: true,
    regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null,
    stock: 4,
    fulfillments: [
      { fulfillment_type: 'direct_sale', regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null },
      { fulfillment_type: 'pre_order', regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null,
        transports: [{ method: 'land', enabled: true, surcharge_iqd: 60_000, regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null }] },
    ],
  }],
} as unknown as PricingProduct;

test('quote a stated pre-order on the LAND route the model itself declares', () => {
  const r = resolveUnitPrice({
    product: p, optionId: 'm', fulfillmentType: 'pre_order', transportMethod: 'land',
    tier: 'free', tierActive: false,
    transportDefaults: [{ method: 'land', commission_iqd: 40_000 }],
  } as never);
  console.log(JSON.stringify({ errors: r.errors, transport: r.transport, unit: r.unit_subtotal_iqd }, null, 2));
});
