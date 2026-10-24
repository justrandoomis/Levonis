import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LanguageProvider } from '../src/LanguageContext';
import InlineProcurementPricing, { currentInlinePrice, inlinePricingRequestKey } from '../src/components/adminOperations/InlineProcurementPricing';
import { purchaseEstimate, purchaseProfit } from '../src/components/adminOperations/purchaseEstimate';
import { money } from '../src/components/adminOperations/shared';
import PurchaseFundingFields, { newFunding } from '../src/components/adminOperations/PurchaseFundingFields';
import { productSelections } from '../worker/lib/inventorySelection';
import { json, post, put } from './fixtures/app';
import { AMS, AMS_MODEL, pricingWorld } from './fixtures/procurementPricing';
import { v2App } from './fixtures/pricingV2';

// Finance components import their styles; the SSR check renders their real
// markup while treating CSS as an empty module, as in ordersListUi.test.ts.
register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(specifier, context, next) {
    if (specifier.endsWith('.css')) return { url: 'data:text/javascript,', shortCircuit: true };
    return next(specifier, context);
  }
`));
const { EarningsAvailable } = await import('../src/components/financePeople/MyEarnings');

const selection = { product_id: AMS, scope: 'option' as const, scope_id: AMS_MODEL, label: 'Selected model' };

test('a saved selection keeps its canonical USD/IQD quote and profit when other models still prevent publication', async () => {
  const w = pricingWorld();
  const group = w.raw.prepare('SELECT group_id FROM product_option_values WHERE id=?').get(AMS_MODEL)!.group_id!;
  w.raw.prepare("INSERT INTO product_option_values(id,product_id,group_id,name_en,active,stock) VALUES ('unpriced-other',?,?,'Other',1,0)").run(AMS, group);
  w.raw.prepare("INSERT INTO product_option_fulfillment(id,product_id,option_id,fulfillment_type,enabled) VALUES ('other-direct',?,'unpriced-other','direct_sale',1)").run(AMS);
  const path = '/api/admin/pricing/procurement/line-pricing';
  const draft = w.draft();
  const { label: _label, ...identity } = selection;
  void _label;
  const p = await json(await post(w.app, path, { ...identity, draft, final_cost_usd: '7.180121', customer_price_usd: '11.99' }));
  assert.equal(p.preview.complete, false, JSON.stringify(p));
  assert.equal(p.customer_price_usd, '11.99');
  const saved = await put(v2App(w.raw), `/api/admin/products-v2/${AMS}/pricing`, { pricing: p.pricing, seq: p.preview.seq, preview_hash: p.preview.review_hash, confirm_large_change: true });
  assert.equal(saved.status, 200, JSON.stringify(await json(saved)));
  const selections = await productSelections(w.db, AMS);
  assert.equal(selections.find(s => s.scope_id === AMS_MODEL)?.selling_price_iqd, null, 'there is no published product price yet');
  const review = await json(await post(w.app, path, { ...identity, draft }));
  assert.equal(review.customer_price_usd, '11.99', 'step 4 reads the same saved selection quote as step 3');
  assert.equal(review.customer_price_iqd, p.customer_price_iqd);
  assert.equal(review.preview.complete, false, 'the review must still explain the incomplete product');
  const profit = purchaseProfit(review.customer_price_iqd, 2, 23838, 4500);
  assert.equal(profit.profit_iqd, review.customer_price_iqd * 2 - 23838);
  assert.equal(profit.owner_iqd! + profit.investor_iqd!, profit.profit_iqd);
});

test('a quote cannot survive changed selection, cost, revision or pending edits; zero is a real quote', () => {
  const draft = { currency: 'CNY', lines: [{ qty_ordered: 1, source_unit_amount: 46 }] };
  const key = inlinePricingRequestKey(selection, draft, {}, 0);
  const quote = { requestKey: key, price: 20000 };
  assert.equal(currentInlinePrice(quote, key), 20000);
  for (const changed of [
    inlinePricingRequestKey({ ...selection, scope_id: 'other' }, draft, {}, 0),
    inlinePricingRequestKey(selection, { ...draft, currency: 'USD' }, {}, 0),
    inlinePricingRequestKey(selection, draft, {}, 1),
    inlinePricingRequestKey(selection, draft, { customer_price_usd: '15' }, 0),
  ]) assert.equal(currentInlinePrice(quote, changed), null);
  assert.equal(currentInlinePrice({ ...quote, price: 0 }, key), 0);
  for (const price of [NaN, Infinity, -Infinity, null]) assert.equal(currentInlinePrice({ ...quote, price }, key), null);
});

test('missing/invalid prices never produce NaN money or invented profit; zero shares and losses remain exact', () => {
  for (const price of [null, NaN, Infinity]) {
    assert.deepEqual(purchaseProfit(price, 1, 11919, 4500), { profit_iqd: null, investor_iqd: null, owner_iqd: null });
    assert.deepEqual(purchaseProfit(price, 1, 11919, 0), { profit_iqd: null, investor_iqd: 0, owner_iqd: null });
  }
  assert.deepEqual(purchaseProfit(20000, 1, 11919, 4500), { profit_iqd: 8081, investor_iqd: 3636, owner_iqd: 4445 });
  assert.deepEqual(purchaseProfit(20000, 1, 11919, 4500, false), { profit_iqd: 8081, investor_iqd: 0, owner_iqd: 8081 });
  assert.deepEqual(purchaseProfit(10000, 1, 11919, 4500), { profit_iqd: -1919, investor_iqd: 0, owner_iqd: -1919 });
  assert.equal(purchaseProfit(20000, 1, NaN, 4500).owner_iqd, null);
  const [unknown] = purchaseEstimate([{ qty_ordered: 1, source_unit_amount: 11919, selling_price_iqd: null, weight_g: 1, volume_mm3: 0 }], [], 1, 4500);
  assert.equal(unknown.profit_iqd, null);
  for (const n of [null, undefined, NaN, Infinity, -Infinity]) assert.equal(money(n), '—');
  assert.equal(money(0), '0 د.ع');
});

test('review keeps all four price cells without editable inputs, and actual funding is no longer hidden', () => {
  const render = (children: React.ReactNode) => renderToStaticMarkup(createElement(LanguageProvider, { children }));
  const html = render(createElement(InlineProcurementPricing, { line: selection, purchaseDraft: null, value: {}, onChange() {}, onSaved() {}, revision: 0, summary: null, onAdvanced() {}, readOnly: true }));
  assert.match(html, /data-procurement-price-review/);
  assert.match(html, /السعر النهائي بالدولار/);
  assert.doesNotMatch(html, /<input|NaN|Infinity/);
  const funding = render(createElement(PurchaseFundingFields, { value: { ...newFunding(), mode: 'investor' }, onChange() {}, investors: [] }));
  assert.match(funding, /التمويل المستلم فعليًا/);
  assert.match(funding, /تركه فارغًا/);
  assert.doesNotMatch(funding, /<details><summary>هل استلمت التمويل/);
});

test('the investor sees returned capital in available balance even when sale earnings await collection', () => {
  const html = renderToStaticMarkup(createElement(LanguageProvider, { children: createElement(EarningsAvailable, { earnings: 0, capital: 146178 }) }));
  assert.match(html, /146,178/);
  assert.match(html, /رأس مال/);
  assert.match(html, /أرباح/);
  const combined = renderToStaticMarkup(createElement(LanguageProvider, { children: createElement(EarningsAvailable, { earnings: 444702, capital: 146178 }) }));
  assert.match(combined, /590,880/);
});
