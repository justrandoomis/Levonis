import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { json, post, put } from './fixtures/app';
import { AMS, AMS_MODEL, pricingWorld } from './fixtures/procurementPricing';
import { seedOptionless, v2App, writeV2 } from './fixtures/pricingV2';
import { LanguageProvider } from '../src/LanguageContext';
import InlineProcurementPricing from '../src/components/adminOperations/InlineProcurementPricing';

const path = '/api/admin/pricing/procurement/line-pricing';
const selection = { product_id: AMS, scope: 'option', scope_id: AMS_MODEL };

test('unpriced inventory shows its cost without a profit, then saves a fractional profit through V2 and reloads it', async () => {
  const w = pricingWorld();
  const body = { ...selection, draft: w.draft() };
  const initial = await json(await post(w.app, path, body));
  assert.equal(initial.final_cost_usd, '500', JSON.stringify(initial));
  assert.equal(initial.minimum_profit_usd, null);
  assert.equal(initial.customer_price_usd, null);
  assert.equal(initial.customer_price_iqd, null);
  const preview = await json(await post(w.app, path, { ...body, minimum_profit_usd: '50.051' }));
  assert.equal(preview.preview.complete, true, JSON.stringify(preview));
  assert.equal(preview.minimum_profit_usd, '50.051');
  assert.equal(preview.customer_price_usd, '550.051');
  assert.equal(preview.customer_price_iqd, 880250);
  const app = v2App(w.raw);
  const save = await put(app, `/api/admin/products-v2/${AMS}/pricing`, { pricing: preview.pricing, seq: preview.preview.seq, preview_hash: preview.preview.review_hash, confirm_large_change: true });
  assert.equal(save.status, 200, JSON.stringify(await json(save)));
  const reloaded = await json(await post(w.app, path, { ...selection, draft: w.draft({ lines: [{ ...body.draft.lines[0], source_unit_amount: 900 }] }) }));
  assert.equal(reloaded.final_cost_usd, '500', 'existing cost is prefilled, not overwritten by a new purchase');
  assert.equal(reloaded.minimum_profit_usd, '50.051');
  assert.equal(reloaded.customer_price_iqd, 880250);
  assert.equal(w.raw.prepare('SELECT COUNT(*) AS n FROM purchase_orders').get()?.n, 0, 'pricing never invents a purchase or inventory');
});

test('editing final cost preserves freight once, saves the exact selection, and does not mutate purchase economics', async () => {
  const w = pricingWorld();
  const draft = w.draft();
  const request = { ...selection, draft, final_cost_usd: '525.123456', minimum_profit_usd: '60.051' };
  const res = await post(w.app, path, request);
  const p = await json(res);
  assert.equal(res.status, 200, JSON.stringify(p));
  assert.equal(p.final_cost_usd, '525.123456');
  assert.equal(p.customer_price_iqd, 936500);
  assert.deepEqual(p.pricing.cost.inputs.find((i: { scope_id: string }) => i.scope_id === AMS_MODEL), {
    scope: 'option', scope_id: AMS_MODEL, supplier_cost_amount: '520.123456', supplier_cost_currency: 'USD', shipping_weight_g: 2500, shipping_profile: 'GERMANY_LAND',
  });
  const save = await put(v2App(w.raw), `/api/admin/products-v2/${AMS}/pricing`, { pricing: p.pricing, seq: p.preview.seq, preview_hash: p.preview.review_hash, confirm_large_change: true });
  assert.equal(save.status, 200, JSON.stringify(await json(save)));
  const again = await json(await post(w.app, path, selection));
  assert.equal(again.final_cost_usd, '525.123456');
  assert.equal(again.minimum_profit_usd, '60.051');
  assert.equal(again.customer_price_iqd, p.customer_price_iqd);
  assert.equal(draft.lines[0].source_unit_amount, 450);
  assert.equal(w.raw.prepare('SELECT COUNT(*) AS n FROM inventory_lots').get()?.n, 0);
});

test('inline preparation refuses a final cost below freight and unknown options without writing prices', async () => {
  const w = pricingWorld();
  const count = () => w.raw.prepare('SELECT COUNT(*) AS n FROM pricing_inputs').get()?.n;
  const before = count();
  for (const extra of [{ final_cost_usd: '1' }, { final_cost_usd: '0' }, { final_cost_usd: '0.0000001' }, { scope_id: 'foreign-option' }]) {
    const res = await post(w.app, path, { ...selection, draft: w.draft(), ...extra });
    assert.equal(res.status, 400, JSON.stringify(await json(res)));
  }
  assert.equal(count(), before);
  const denied = pricingWorld({ user: { id: 'editor', role: 'admin', email: 'editor@x.co' } });
  assert.equal((await post(denied.app, path, selection)).status, 403);
});

test('colour cost and profit edits belong to that colour; other selections retain their prices', async () => {
  const w = pricingWorld();
  const pid = 'inline-colours';
  seedOptionless(w.raw, pid, { colours: 2, saleTypes: ['direct_sale'] });
  await writeV2(w.db, pid, { method: 'cost', minimumProfitUsd: '10', inputs: {
    supplier_cost_amount: '100', supplier_cost_currency: 'USD', shipping_profile: 'GERMANY_LAND', shipping_weight_g: 1000,
  } });
  const red = { product_id: pid, scope: 'color', scope_id: `${pid}_c0` };
  const blue = { ...red, scope_id: `${pid}_c1` };
  const before = await json(await post(w.app, path, blue));
  const p = await json(await post(w.app, path, { ...red, final_cost_usd: '120.051', minimum_profit_usd: '0.051' }));
  assert.equal(p.final_cost_usd, '120.051', JSON.stringify(p));
  assert.equal(p.minimum_profit_usd, '0.051');
  const res = await put(v2App(w.raw), `/api/admin/products-v2/${pid}/pricing`, { pricing: p.pricing, seq: p.preview.seq, preview_hash: p.preview.review_hash, confirm_large_change: true });
  assert.equal(res.status, 200, JSON.stringify(await json(res)));
  const after = await json(await post(w.app, path, blue));
  assert.equal(after.final_cost_usd, before.final_cost_usd);
  assert.equal(after.minimum_profit_usd, '10');
  assert.equal(after.customer_price_iqd, before.customer_price_iqd);
  const saved = await json(await post(w.app, path, red));
  assert.equal(saved.minimum_profit_usd, '0.051');
  assert.equal(saved.final_cost_usd, '120.051');
});

test('all three USD fields are editable beside IQD, even before any price exists', () => {
  const html = renderToStaticMarkup(createElement(LanguageProvider, { children: createElement(InlineProcurementPricing, {
    line: { ...selection, scope: 'option', label: 'New cable' }, purchaseDraft: null, value: {}, onChange: () => {}, onSaved: () => {}, revision: 0, summary: null, onAdvanced: () => {},
  }) }));
  for (const field of ['final_cost_usd', 'minimum_profit_usd', 'customer_price_usd']) {
    assert.match(html, new RegExp(`<input[^>]+inputMode="decimal"[^>]+placeholder="—"[^>]+data-v2-field="${field}"`));
  }
  assert.doesNotMatch(html, /<input[^>]+\sdisabled(?:=|[\s>])/);
  assert.match(html, /sm:grid-cols-4/);
});

test('typing customer USD reverses the exact cost into profit, saves and reloads before IQD rounding', async () => {
  const w = pricingWorld();
  const res = await post(w.app, path, { ...selection, draft: w.draft(), final_cost_usd: '7.180121', customer_price_usd: '13.500000' });
  const p = await json(res);
  assert.equal(res.status, 200, JSON.stringify(p));
  assert.equal(p.final_cost_usd, '7.180121');
  assert.equal(p.customer_price_usd, '13.5');
  assert.equal(p.minimum_profit_usd, '6.319879');
  assert.equal(p.customer_price_iqd, 21750);
  assert.equal(p.pricing.method, 'cost');
  assert.equal(p.pricing.points, undefined);
  const saved = await put(v2App(w.raw), `/api/admin/products-v2/${AMS}/pricing`, { pricing: p.pricing, seq: p.preview.seq, preview_hash: p.preview.review_hash, confirm_large_change: true });
  assert.equal(saved.status, 200, JSON.stringify(await json(saved)));
  const again = await json(await post(w.app, path, selection));
  assert.equal(again.customer_price_usd, '13.5');
  assert.equal(again.minimum_profit_usd, '6.319879');
  assert.equal(again.customer_price_iqd, 21750);
  assert.equal(w.raw.prepare('SELECT COUNT(*) AS n FROM inventory_lots').get()?.n, 0);
  for (const extra of [{ customer_price_usd: '7.180121' }, { customer_price_usd: '0' }, { customer_price_usd: '-1' }, { customer_price_usd: '1.0000001' }, { customer_price_usd: '100001' }, { customer_price_usd: '20', minimum_profit_usd: '5' }]) {
    const invalid = await post(w.app, path, { ...selection, ...extra });
    assert.equal(invalid.status, 400, JSON.stringify(await json(invalid)));
  }
  const unchanged = await json(await post(w.app, path, selection));
  assert.equal(unchanged.customer_price_usd, '13.5');
});

test('a small customer price changes only the selected colour and retains six decimal precision', async () => {
  const w = pricingWorld();
  const pid = 'inline-small';
  seedOptionless(w.raw, pid, { colours: 2, saleTypes: ['direct_sale'] });
  await writeV2(w.db, pid, { method: 'cost', minimumProfitUsd: '0.01', inputs: {
    supplier_cost_amount: '0.01', supplier_cost_currency: 'USD', shipping_profile: 'GERMANY_LAND', shipping_weight_g: 10,
  } });
  const red = { product_id: pid, scope: 'color', scope_id: `${pid}_c0` };
  const blue = { ...red, scope_id: `${pid}_c1` };
  const p = await json(await post(w.app, path, { ...red, customer_price_usd: '٠٫٠٥١٠٠١' }));
  assert.equal(p.customer_price_usd, '0.051001', JSON.stringify(p));
  assert.equal(p.minimum_profit_usd, '0.021001');
  assert.equal(p.customer_price_iqd, 82);
  const saved = await put(v2App(w.raw), `/api/admin/products-v2/${pid}/pricing`, { pricing: p.pricing, seq: p.preview.seq, preview_hash: p.preview.review_hash, confirm_large_change: true });
  assert.equal(saved.status, 200, JSON.stringify(await json(saved)));
  const untouched = await json(await post(w.app, path, blue));
  assert.equal(untouched.customer_price_usd, '0.04');
  assert.equal(untouched.minimum_profit_usd, '0.01');
  const again = await json(await post(w.app, path, red));
  assert.equal(again.customer_price_usd, '0.051001');
});

test('fixed USD editing works without cost and preserves other prices and pre-order discounts', async () => {
  const w = pricingWorld();
  const pid = 'inline-fixed';
  seedOptionless(w.raw, pid, { colours: 2 });
  const points = [
    { scope: 'product' as const, scope_id: '', kind: 'fixed' as const, usd: '100' },
    { scope: 'color' as const, scope_id: `${pid}_c0`, kind: 'delta' as const, usd: '2' },
    { scope: 'sku' as const, scope_id: `c:${pid}_c1`, kind: 'fixed' as const, usd: '30' },
  ];
  await writeV2(w.db, pid, { method: 'usd', points, discounts: [{ scope: 'product', scope_id: '', usd: '2' }] });
  const p = await json(await post(w.app, path, { product_id: pid, scope: 'color', scope_id: `${pid}_c0`, customer_price_usd: '10.051' }));
  assert.equal(p.customer_price_usd, '10.051', JSON.stringify(p));
  assert.equal(p.pricing.method, 'usd');
  assert.equal(p.minimum_profit_usd, null);
  for (const point of points) assert.ok(p.pricing.points.some((x: unknown) => JSON.stringify(x) === JSON.stringify(point)), JSON.stringify(p.pricing.points));
  const saved = await put(v2App(w.raw), `/api/admin/products-v2/${pid}/pricing`, { pricing: p.pricing, seq: p.preview.seq, preview_hash: p.preview.review_hash, confirm_large_change: true });
  assert.equal(saved.status, 200, JSON.stringify(await json(saved)));
  const again = await json(await post(w.app, path, { product_id: pid, scope: 'color', scope_id: `${pid}_c0` }));
  assert.equal(again.customer_price_usd, '10.051');
  const land = again.preview.table.find((r: { color_id: string; channel: string }) => r.color_id === `${pid}_c0` && r.channel === 'pre_order_land');
  assert.equal(land?.editor_usd_price, '8.051');
  const blue = await json(await post(w.app, path, { product_id: pid, scope: 'color', scope_id: `${pid}_c1` }));
  assert.equal(blue.customer_price_usd, '30');
  const conflict = await post(w.app, path, { product_id: pid, scope: 'base', scope_id: '', customer_price_usd: '200' });
  assert.equal(conflict.status, 400, 'a narrower fixed price must not silently win over the typed amount');
});

test('cost-based fixed model prices remain editable and keep their existing pricing method', async () => {
  const w = pricingWorld();
  await writeV2(w.db, AMS, { method: 'cost', minimumProfitUsd: '10', points: [
    { scope: 'option', scope_id: AMS_MODEL, kind: 'fixed', usd: '550' },
  ], inputs: { supplier_cost_amount: '495', supplier_cost_currency: 'USD', shipping_profile: 'GERMANY_LAND', shipping_weight_g: 2500 } });
  const p = await json(await post(w.app, path, { ...selection, customer_price_usd: '560.051' }));
  assert.equal(p.customer_price_usd, '560.051', JSON.stringify(p));
  assert.equal(p.minimum_profit_usd, '60.051');
  assert.equal(p.pricing.method, 'cost');
  assert.deepEqual(p.pricing.points, [{ scope: 'option', scope_id: AMS_MODEL, kind: 'fixed', usd: '560.051' }]);
  const saved = await put(v2App(w.raw), `/api/admin/products-v2/${AMS}/pricing`, { pricing: p.pricing, seq: p.preview.seq, preview_hash: p.preview.review_hash, confirm_large_change: true });
  assert.equal(saved.status, 200, JSON.stringify(await json(saved)));
  const again = await json(await post(w.app, path, selection));
  assert.equal(again.customer_price_usd, '560.051');
});

test('customer price uses the on-shelf cost and keeps inventory lot accounting unchanged', async () => {
  const w = pricingWorld();
  const pid = 'inline-shelf';
  seedOptionless(w.raw, pid, { saleTypes: ['direct_sale'] });
  w.raw.prepare(`INSERT INTO inventory_lots (id, product_id, scope, scope_id, qty_received, qty_remaining, unit_cost_iqd, cost_basis, received_at)
    VALUES ('inline-lot', ?, 'base', '', 5, 5, 11521, 'received', '2026-10-24T00:00:00Z')`).run(pid);
  await writeV2(w.db, pid, { method: 'cost', minimumProfitUsd: '6', inputs: {
    supplier_cost_amount: '5', supplier_cost_currency: 'USD', shipping_profile: 'GERMANY_LAND', shipping_weight_g: 1000,
  } });
  const base = { product_id: pid, scope: 'base', scope_id: '' };
  const p = await json(await post(w.app, path, { ...base, customer_price_usd: '13.5' }));
  assert.equal(p.customer_price_usd, '13.5', JSON.stringify(p));
  assert.equal(p.minimum_profit_usd, '6.299375');
  assert.equal(p.final_cost_usd, '7', 'the supplier replacement cost differs from the shelf');
  const saved = await put(v2App(w.raw), `/api/admin/products-v2/${pid}/pricing`, { pricing: p.pricing, seq: p.preview.seq, preview_hash: p.preview.review_hash, confirm_large_change: true });
  assert.equal(saved.status, 200, JSON.stringify(await json(saved)));
  const again = await json(await post(w.app, path, base));
  assert.equal(again.customer_price_usd, '13.5');
  const lot = w.raw.prepare('SELECT unit_cost_iqd, qty_remaining FROM inventory_lots WHERE id = ?').get('inline-lot');
  assert.equal(lot?.unit_cost_iqd, 11521);
  assert.equal(lot?.qty_remaining, 5);
});
