import { test } from 'node:test';
import { saleAvailability } from '../../worker/routes/products';

type Doc = Parameters<typeof saleAvailability>[0];

// A product configured EXACTLY as the owner describes it:
//  - two models (A1 Combo, A1) as product_option_values
//  - each model has a direct_sale cell AND a pre_order cell with a LAND transport
//    (product_option_fulfillment / product_option_transports, via applyRelations)
//  - products.sale_types = ['direct_sale','pre_order']  (derived by the admin save)
//  - products.preorder_transports = []  (the FulfillmentPanel never writes it)
const doc = {
  selling_type: 'direct_sale',
  sale_types: ['direct_sale', 'pre_order'],
  stock: 4,
  preorder_transports: [],
  colors: [],
  options: [
    {
      id: 'ov_combo', name_ar: 'A1 Combo', name_en: 'A1 Combo', name_ckb: '', image: '', order: 0, active: true,
      regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null,
      stock: 4,
      fulfillments: [
        { fulfillment_type: 'direct_sale', enabled: true, transports: [] },
        {
          fulfillment_type: 'pre_order', enabled: true, capacity: null,
          transports: [{ method: 'land', enabled: true, surcharge_iqd: 50000, capacity: null }],
        },
      ],
    },
  ],
} as unknown as Doc;

test('repro', () => {
  const a = saleAvailability(doc, { transportDefaults: [{ method: 'land', commission_iqd: 40000 }] });
  console.log(JSON.stringify({ mode: a.mode, reason: a.reason, modes: a.modes, preorder: a.preorder }, null, 2));
});
