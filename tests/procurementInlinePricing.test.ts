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
  assert.equal(initial.customer_price_iqd, null);
  const preview = await json(await post(w.app, path, { ...body, minimum_profit_usd: '50.051' }));
  assert.equal(preview.preview.complete, true, JSON.stringify(preview));
  assert.equal(preview.minimum_profit_usd, '50.051');
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

test('both fields are editable with decimal keyboards even before any price exists', () => {
  const html = renderToStaticMarkup(createElement(LanguageProvider, { children: createElement(InlineProcurementPricing, {
    line: { ...selection, scope: 'option', label: 'New cable' }, purchaseDraft: null, value: {}, onChange: () => {}, onSaved: () => {}, revision: 0, summary: null, onAdvanced: () => {},
  }) }));
  for (const field of ['final_cost_usd', 'minimum_profit_usd']) {
    assert.match(html, new RegExp(`<input[^>]+inputMode="decimal"[^>]+placeholder="—"[^>]+data-procurement-field="${field}"`));
  }
  assert.doesNotMatch(html, /<input[^>]+disabled/);
});
