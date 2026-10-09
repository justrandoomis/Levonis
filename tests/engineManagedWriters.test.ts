/**
 * ENGINE_MANAGED: ON AN ENGINE-PRICED PRODUCT THE OLD DINAR PRICE WRITERS
 * REFUSE (owner decision 8; MVP plan §5 "The database is the enforcement").
 *
 * The quick-price grid (cell edit, bulk, copy, undo) and the selection price
 * refuse up front with ENGINE_MANAGED in the viewer's language; the product
 * form's save is refused by the database's value-compared lock when it
 * changes a price, and passes untouched when it does not (stock, names and
 * cost stay editable); a manual product is untouched by all of this. The
 * product detail tells the form the product is engine-managed, so its price
 * cells render read only.
 *
 * Run: node --import tsx --test tests/engineManagedWriters.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get, json, row, stubApp } from './fixtures/app';
import { pricingWorld, AMS, AMS_MODEL, OWNER_USER } from './fixtures/procurementPricing';
import { adminPriceGridRoutes } from '../worker/routes/adminPriceGrid';
import { adminProductsRoutes } from '../worker/routes/adminProducts';
import { COST_REFUSALS } from '../packages/contracts/src/costRefusals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';

const COMPLETE = {
  inputs: [{ scope: 'base', supplier_cost_amount: '450', supplier_cost_currency: 'EUR', shipping_profile: 'GERMANY_LAND', shipping_weight_g: 2500 }],
  rules: [
    { kind: 'target_profit', scope: 'product', amount_usd: '120' },
    { kind: 'direct_sale_extra', scope: 'product', amount_iqd: 50_000 },
  ],
};

async function engineWorld() {
  const w = pricingWorld();
  const first = await w.putInputs(AMS, { inputs_seq: 0, ...COMPLETE });
  const r = await w.putInputs(AMS, { inputs_seq: 0, ...COMPLETE, preview_hash: first.body.details.preview.preview_hash, confirm_large_change: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const admin = stubApp(w.db, { ...OWNER_USER, email_verified_at: '2026-01-01T00:00:00.000Z' } as never, (a) => {
    a.route('/api/admin/products', adminPriceGridRoutes);
    a.route('/api/admin/products-v2', adminProductsRoutes);
  }, { env: { INITIAL_ADMIN_EMAIL: OWNER_USER.email } });
  return { w, admin };
}

const send = async (app: ReturnType<typeof stubApp>, method: string, path: string, body: unknown) => {
  const res = await app.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await json(res) };
};

test('the quick-price grid and the selection price refuse an engine product with ENGINE_MANAGED; a manual product is untouched', async () => {
  const { w, admin } = await engineWorld();
  const before = row<{ p: number }>(w.raw, 'SELECT regular_price_iqd AS p FROM product_option_values WHERE id = ?', AMS_MODEL)!.p;
  const cell = await send(admin, 'PATCH', `/api/admin/products/${AMS}/price-grid`, { cells: [{ level: 'option', id: AMS_MODEL, field: 'regular', mode: 'fixed', value: '5000' }] });
  assert.equal(cell.status, 409, JSON.stringify(cell.body));
  assert.equal(cell.body.code, 'ENGINE_MANAGED');
  assert.equal(cell.body.error, `${COST_REFUSALS.ENGINE_MANAGED.ar} / ${COST_REFUSALS.ENGINE_MANAGED.en}`);
  const bulk = await send(admin, 'POST', `/api/admin/products/${AMS}/price-grid/bulk`, { op: 'add_percent', fields: ['regular'], value: '10', confirm: true });
  assert.equal(bulk.body.code, 'ENGINE_MANAGED');
  const undo = await send(admin, 'POST', `/api/admin/products/${AMS}/price-grid/undo`, { batch_id: 'pe_anything' });
  assert.equal(undo.body.code, 'ENGINE_MANAGED');
  const selection = await send(admin, 'POST', `/api/admin/products-v2/${AMS}/selection-price`, { selection_key: `o:${AMS_MODEL}`, price_iqd: 5000 });
  assert.equal(selection.body.code, 'ENGINE_MANAGED');
  assert.equal(row<{ p: number }>(w.raw, 'SELECT regular_price_iqd AS p FROM product_option_values WHERE id = ?', AMS_MODEL)!.p, before);

  // A manual product's grid still writes.
  const manual = await send(admin, 'PATCH', '/api/admin/products/lp_04/price-grid', { cells: [{ level: 'product', id: '', field: 'regular', mode: 'fixed', value: '310000' }] });
  assert.notEqual(manual.body.code, 'ENGINE_MANAGED', JSON.stringify(manual.body));
});

test('the product form: a changed price is refused by the database (ENGINE_MANAGED); the same document unchanged saves; the detail says engine_managed', async () => {
  const { w, admin } = await engineWorld();
  const detail = await json(await get(admin, `/api/admin/products-v2/${AMS}`));
  assert.equal(detail.engine_managed, true);
  assert.equal((await json(await get(admin, '/api/admin/products-v2/lp_04'))).engine_managed, false);
  const doc = detail.product as Record<string, unknown>;
  const changed = await send(admin, 'POST', '/api/admin/products-v2', { ...doc, price_iqd: 5000, expected_updated_at: doc.updated_at });
  assert.equal(changed.status, 409, JSON.stringify(changed.body));
  assert.equal(changed.body.code, 'ENGINE_MANAGED');
  assert.equal(row<{ p: number }>(w.raw, 'SELECT price_iqd AS p FROM products WHERE id = ?', AMS)!.p, 992_000);
  const same = await send(admin, 'POST', '/api/admin/products-v2', { ...doc, name_en: 'AMS HT (renamed)', expected_updated_at: doc.updated_at });
  assert.equal(same.status, 200, JSON.stringify(same.body).slice(0, 400));
  assert.equal(row<{ n: string }>(w.raw, 'SELECT name AS n FROM products WHERE id = ?', AMS)!.n, 'AMS HT (renamed)');
});

test('the CSV import names an engine product’s refused row in words, never the driver’s text; the form locks the price cells', () => {
  const src = readFileSync(join(ROOT, 'worker/routes/adminImport.ts'), 'utf8');
  assert.match(src, /reason: engineDbRefusal\(error\)\?\.message \?\?/);
  const form = readFileSync(join(ROOT, 'src/components/adminProducts/ProductForm.tsx'), 'utf8');
  assert.match(form, /pricesLocked=\{engineManaged \|\| \(canSeeCost && pricing\.engine\)\}/);
  const options = readFileSync(join(ROOT, 'src/components/adminProducts/form/OptionsSection.tsx'), 'utf8');
  assert.match(options, /locked: locked && field !== 'cost'/, 'cost stays editable');
  assert.match(options, /disabled=\{locked\}/);
});
