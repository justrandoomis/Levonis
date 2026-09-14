import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveUnitPrice, type PricingProduct, type OptionV2 } from '../packages/pricing/src/pricing';
import { freshDb, asD1, stubApp, post, json, row } from './fixtures/app';
import { templateRoutes } from '../worker/routes/template';
import { adminProductsRoutes } from '../worker/routes/adminProducts';
import { parseProductRow } from '../worker/lib/productModel';
import { applyRelations, loadRelationsView } from '../worker/lib/productOverlay';

const option = (over: Partial<OptionV2> = {}): OptionV2 => ({ id: 'mini', name_en: 'A1 mini', name_ar: '', name_ckb: '', image: '', order: 0, active: true, regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null, ...over });
const product = (options: OptionV2[]): PricingProduct => ({ price_iqd: 1000000, prime_price_iqd: 950000, pro_price_iqd: 900000, product_cost_iqd: null, selling_type: 'pre_order', sale_types: ['direct_sale','pre_order'], direct_surcharge_iqd: 50000, options, colors: [], preorder_transports: [{ method: 'air', commission_iqd: 50000, active: true }], warranty_plans: [] });
const quote = (p: PricingProduct, optionId: string, transportMethod: string | null, tier: 'free'|'prime'|'pro' = 'free') => resolveUnitPrice({ product: p, optionId, transportMethod, tier, tierActive: true });

test('model Air override replaces product Air and PRO keeps Combo delta', () => {
  const p = product([option({ id: 'combo', regular_adjust_iqd: 200000, preorder: { enabled: true, transports: [{ method: 'air', enabled: true, surcharge_iqd: 80000 }] } })]);
  assert.equal(quote(p, 'combo', 'air').unit_subtotal_iqd, 1280000);
  assert.equal(quote(p, 'combo', 'air', 'prime').unit_subtotal_iqd, 1230000);
  assert.equal(quote(p, 'combo', 'air', 'pro').unit_subtotal_iqd, 1100000);
  assert.deepEqual(quote(p, 'combo', 'air').errors, []);
});

test('each model has its own direct total and explicit zero overrides fallback', () => {
  const p = product([
    option({ id: 'mini', regular_price_iqd: 499000, direct: { enabled: true, regular_price_iqd: 549000 }, preorder: { enabled: true } }),
    option({ id: 'combo', regular_price_iqd: 679000, direct: { enabled: true, regular_price_iqd: 699000 }, preorder: { enabled: true } }),
    option({ id: 'zero', direct: { enabled: true, regular_adjust_iqd: 0 } }),
  ]);
  assert.equal(quote(p, 'mini', null).unit_subtotal_iqd, 549000);
  assert.equal(quote(p, 'combo', null).unit_subtotal_iqd, 699000);
  assert.equal(quote(p, 'zero', null).unit_subtotal_iqd, 1000000);
});

test('Sea/Land/Air, fixed transport, lead time, and disabled selections', () => {
  const p = product([option({ preorder: { enabled: true, transports: [
    { method: 'sea', enabled: true, surcharge_iqd: 0, lead_time_min_days: 21, lead_time_max_days: 28 },
    { method: 'land', enabled: true, surcharge_iqd: 30000 },
    { method: 'air', enabled: true, surcharge_iqd: 80000 },
  ] }, direct: { enabled: false } })]);
  assert.equal(quote(p, 'mini', 'sea').unit_subtotal_iqd, 1000000);
  assert.equal(quote(p, 'mini', 'land').unit_subtotal_iqd, 1030000);
  assert.equal(quote(p, 'mini', 'air').unit_subtotal_iqd, 1080000);
  assert.equal(quote(p, 'mini', 'sea').selection_snapshot?.lead_time.max_days, 28);
  const denied = resolveUnitPrice({ product: p, optionId: 'mini', fulfillmentType: 'direct_sale', tier: 'free', tierActive: false });
  assert.ok(denied.errors.includes('FULFILLMENT_NOT_OFFERED'));
  p.options[0].preorder!.transports![2].regular_price_iqd = 1230000;
  assert.equal(quote(p, 'mini', 'air').unit_subtotal_iqd, 1230000);
});

export const FULFILLMENT_TXT = `template_version=2
name_en=A1 mini
name_ar=A1 mini
slug=a1-mini-model-test
price_iqd=499000
product_cost_iqd=300000
selling_type=mixed
standard_delivery_enabled=true
standard_delivery_quantity_step=2
standard_delivery_fee_iqd=10000
personal_delivery_enabled=true
personal_delivery_quantity_step=1
personal_delivery_fee_iqd=25000
options.1.id=mini
options.1.name_en=A1 mini
options.1.direct.enabled=true
options.1.direct.regular_price_iqd=549000
options.1.direct.stock=5
options.1.preorder.enabled=true
options.1.preorder.regular_price_iqd=499000
options.1.preorder.transports.1.method=sea
options.1.preorder.transports.1.enabled=true
options.1.preorder.transports.1.surcharge_iqd=0
options.1.preorder.transports.1.lead_time_min_days=21
options.1.preorder.transports.1.lead_time_max_days=28
options.1.preorder.transports.2.method=air
options.1.preorder.transports.2.enabled=true
options.1.preorder.transports.2.surcharge_iqd=80000
options.2.id=combo
options.2.name_en=A1 mini Combo
options.2.regular_price_iqd=679000
options.2.direct.enabled=true
options.2.direct.regular_price_iqd=699000
options.2.direct.stock=3
options.2.preorder.enabled=true
options.2.preorder.regular_price_iqd=679000
`;

test('TXT writes two real model rows and separate fulfillment/transports; reads back prices and delivery', async () => {
  const raw = freshDb(); const db = asD1(raw);
  const app = stubApp(db, { id: 'owner', role: 'admin', email: 'owner@test.com' }, (a) => { a.route('/api/admin/template', templateRoutes); a.route('/api/admin/products-v2', adminProductsRoutes); });
  const result = await post(app, '/api/admin/template/apply', { text: FULFILLMENT_TXT, mode: 'draft', confirm: true });
  const body = await json(result);
  assert.equal(result.status, 200, JSON.stringify(body));
  const id = body.product_id as string;
  assert.equal(row(raw, 'SELECT COUNT(*) n FROM product_option_values WHERE product_id=?', id)?.n, 2);
  assert.equal(row(raw, 'SELECT COUNT(*) n FROM product_option_fulfillment WHERE product_id=?', id)?.n, 4);
  assert.equal(row(raw, 'SELECT COUNT(*) n FROM product_option_transports WHERE product_id=?', id)?.n, 2);
  assert.equal(row(raw, "SELECT COUNT(*) n FROM product_option_values WHERE product_id=? AND availability_type<>''", id)?.n, 0);
  const doc = applyRelations(parseProductRow(row(raw, 'SELECT * FROM products WHERE id=?', id)!), await loadRelationsView(db, id, 'BASE'));
  assert.equal(quote(doc, 'mini', null).unit_subtotal_iqd, 549000);
  assert.equal(quote(doc, 'mini', 'air').unit_subtotal_iqd, 579000);
  assert.equal(doc.delivery_options?.personal.fee_iqd, 25000);
  assert.equal(doc.options[0].direct?.stock, 5);
});
