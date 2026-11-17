/**
 * Owner report 2026-11-17: «السعر النهائي للزبون قد لا يُحسب أو يختفي». A half-typed amount («12.») or an emptied
 * cost / customer price made the whole product card invalid, so the customer price fell to «يحتاج تسعيرًا» while
 * the owner was still typing. `cleanInlinePrice` is what the card now sends.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cleanInlinePrice } from '../src/components/adminOperations/InlineProcurementPricing';

test('a trailing or leading dot is read as the number it means', () => {
  assert.deepEqual(cleanInlinePrice({ customer_price_usd: '12.' }), { customer_price_usd: '12' });
  assert.deepEqual(cleanInlinePrice({ final_cost_usd: '.5' }), { final_cost_usd: '0.5' });
  assert.deepEqual(cleanInlinePrice({ minimum_profit_usd: ' 3.25 ' }), { minimum_profit_usd: '3.25' });
});

test('an emptied cost or customer price means «use the calculated one»; an emptied profit still clears it', () => {
  assert.deepEqual(cleanInlinePrice({ customer_price_usd: '' }), {});
  assert.deepEqual(cleanInlinePrice({ final_cost_usd: '', customer_price_usd: '40' }), { customer_price_usd: '40' });
  assert.deepEqual(cleanInlinePrice({ minimum_profit_usd: '' }), { minimum_profit_usd: '' });
});

test('the card previews and saves the cleaned amounts, and keeps the last price on screen while re-pricing', () => {
  const card = readFileSync('src/components/adminOperations/InlineProcurementPricing.tsx', 'utf8');
  assert.match(card, /const requestKey = inlinePricingRequestKey\(line, purchaseDraft, sent, revision, keepCost\);/);
  assert.match(card, /const shownPrice = result \? result\.customer_price_iqd : pending && latest \? latest\.customer_price_iqd : null;/);
  assert.match(card, /price: shownPrice \?\? null,/);
});

test('one «حفظ أسعار كل المنتجات» replaces the per-product save inside a purchase', () => {
  const card = readFileSync('src/components/adminOperations/InlineProcurementPricing.tsx', 'utf8');
  const panel = readFileSync('src/components/adminOperations/ProcurementPanel.tsx', 'utf8');
  assert.match(card, /\{!onRegister && canSave && <button/);
  assert.match(panel, /onRegister=\{onRegisterSaver\}/);
  assert.match(panel, /<PurchasePriceGrid/);
  // A bulk save bumps the pricing revision once, at the end, not once per product mid-loop.
  assert.match(panel, /if \(bulkSaving\.current\) \{ bulkSavedAny\.current = true; return; \}/);
});
