import { test } from 'node:test';
import { saleAvailability } from '../worker/routes/products';
import { resolveUnitPrice } from '../packages/pricing/src/pricing';

type Doc = Parameters<typeof saleAvailability>[0];

const opt: any = {
  id: 'o1', name_ar: 'A1', name_en: 'A1 mini', name_ckb: '', image: '', order: 0, active: true,
  regular_price_iqd: 499000, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null,
  availability_type: '',
  fulfillments: [
    { fulfillment_type: 'direct_sale', enabled: true, regular_price_iqd: 499000, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null, transports: [] },
    { fulfillment_type: 'pre_order', enabled: true, regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null,
      transports: [{ method: 'land', enabled: true, surcharge_iqd: 60000 }] },
  ],
};

const doc: any = {
  selling_type: 'direct_sale',
  sale_types: ['direct_sale', 'pre_order'],
  stock: 4,
  options: [opt],
  colors: [],
  preorder_transports: [],
};

test('repro A: saleAvailability with model-level land route + empty product list', () => {
  const a = saleAvailability(doc as Doc, { optionValueIds: ['o1'], qty: 1, transportDefaults: [] });
  console.log('A =>', JSON.stringify({ mode: a.mode, reason: a.reason, modes: a.modes, preorder: a.preorder }, null, 1));
});

test('repro B: resolveUnitPrice pre_order + land', () => {
  const r = resolveUnitPrice({
    product: { ...doc, price_iqd: 499000, preorder_transports: [] } as any,
    optionId: 'o1',
    fulfillmentType: 'pre_order',
    transportMethod: 'land',
    transportDefaults: [],
  } as any);
  console.log('B =>', JSON.stringify({ errors: r.errors, transport: r.transport, unit: r.unit_subtotal_iqd }, null, 1));
});

test('repro C: what if product DOES list land (control)', () => {
  const d2: any = { ...doc, preorder_transports: [{ method: 'land', commission_iqd: null, active: true }] };
  const a = saleAvailability(d2 as Doc, { optionValueIds: ['o1'], qty: 1, transportDefaults: [] });
  console.log('C =>', JSON.stringify({ mode: a.mode, modes: a.modes, preorder: a.preorder }, null, 1));
});
