/**
 * THE CLIENT HALF OF DELIVERY BY GOVERNORATE (merchant platform W2-A):
 *   · the merchant editor's model — server config → draft → the exact payload
 *     PUT /api/merchant/delivery validates, and the live checks it shows;
 *   · the store checkout — what it sends (the agreed quote's address and
 *     fulfilment, never a fee), what it re-quotes on, and that an undeliverable
 *     choice leaves no live Place button;
 *   · the mounts — the editor in the settings tab (lazy), the storefront line.
 *
 * Run: node --import tsx --test tests/deliveryClient.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import {
  draftCoverage,
  draftFromConfig,
  draftIssues,
  draftKey,
  payloadFromDraft,
  rowAnswer,
} from '../src/components/merchant/delivery/deliveryEditorModel';
import { DEFAULT_DELIVERY_PROFILE, validateDeliveryConfig } from '../packages/shipping/src/merchantDelivery';

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const CONFIG = {
  profile: { ...DEFAULT_DELIVERY_PROFILE, default_mode: 'fee' as const, default_fee_iqd: 5000, free_over_iqd: 50_000, version: 4 },
  rules: [
    { governorate_id: 'erbil', mode: 'free' as const, fee_iqd: null, free_over_iqd: null, prep_days: null, eta_note: '', note: '' },
    { governorate_id: 'baghdad', mode: 'fee' as const, fee_iqd: 3000, free_over_iqd: null, prep_days: 1, eta_note: 'Same day', note: '' },
  ],
};

test('the editor round-trips a stored configuration into exactly the payload the server validates', () => {
  const d = draftFromConfig(CONFIG, 'basra');
  assert.equal(d.pickup_governorate, 'basra', 'the store governorate seeds the pickup place');
  const payload = payloadFromDraft(d);
  assert.deepEqual(payload.rules.map((r) => r.governorate_id), ['baghdad', 'erbil'], 'only departures, in the government order');
  const v = validateDeliveryConfig(payload);
  assert.ok(v.ok, JSON.stringify(v));
  assert.deepEqual(draftIssues(d), []);
  assert.equal(draftKey(draftFromConfig(CONFIG, 'basra')), draftKey(d), 'unchanged is not dirty');
});

test('a row follows the default until it has its own; switching a row back drops its rule', () => {
  const d = draftFromConfig(CONFIG);
  assert.deepEqual(rowAnswer(d, 'basra'), { mode: 'fee', fee: 5000, custom: false });
  assert.deepEqual(rowAnswer(d, 'baghdad'), { mode: 'fee', fee: 3000, custom: true });
  d.rules.baghdad = { ...d.rules.baghdad, mode: 'default' };
  assert.equal(payloadFromDraft(d).rules.some((r) => r.governorate_id === 'baghdad'), false);
});

test('the live checks: an empty fee, an empty threshold, pickup with no place, nothing served', () => {
  const d = draftFromConfig(CONFIG);
  d.default_fee_iqd = null;
  assert.deepEqual(draftIssues(d).map((i) => i.path), ['profile.default_fee_iqd']);
  const t = draftFromConfig(CONFIG);
  t.free_over_iqd = null;
  assert.deepEqual(draftIssues(t).map((i) => i.path), ['profile.free_over_iqd']);
  const p = draftFromConfig(CONFIG);
  p.pickup_enabled = true;
  p.pickup_governorate = '';
  assert.deepEqual(draftIssues(p).map((i) => `${i.path}:${i.code}`), ['profile.pickup_governorate:pickup_governorate_required']);
  const off = draftFromConfig({ profile: { ...CONFIG.profile, default_mode: 'disabled' }, rules: [] });
  assert.equal(draftCoverage(off).serviceable, false);
  off.pickup_enabled = true;
  off.pickup_governorate = 'baghdad';
  assert.equal(draftCoverage(off).serviceable, true);
});

test('the checkout places THE AGREED quote’s address and fulfilment and never sends a fee', () => {
  const src = code('src/pages/StoreCheckout.tsx');
  assert.match(src, /addressId: agreed\.delivery\?\.address_id \|\| addressId,/);
  assert.match(src, /fulfilment: agreed\.delivery\?\.fulfilment \?\? fulfilment,/);
  assert.ok(!/delivery_iqd:|fee_iqd:|shipping_iqd:/.test(src.replace(/quote\.delivery_iqd|delivery\.fee_iqd/g, '')), 'no fee in any request body');
  // Every quote names the chosen address and fulfilment.
  assert.match(src, /addressId: addressRef\.current \|\| undefined,\s*fulfilment: fulfilmentRef\.current,/);
});

test('changing the address or delivery/pickup re-quotes as the customer’s own request', () => {
  const src = code('src/pages/StoreCheckout.tsx');
  const choose = /function chooseAddress\(id: string\) \{[\s\S]*?\n {2}\}/.exec(src)?.[0] ?? '';
  assert.match(choose, /void loadQuote\(couponRef\.current, true\);/);
  const fulfil = /function chooseFulfilment\(next: Fulfilment\) \{[\s\S]*?\n {2}\}/.exec(src)?.[0] ?? '';
  assert.match(fulfil, /void loadQuote\(couponRef\.current, true\);/);
  assert.match(src, /onClick=\{\(\) => chooseAddress\(a\.id\)\}/);
});

test('an undeliverable choice keeps the goods on screen and has no live Place button', () => {
  const src = code('src/pages/StoreCheckout.tsx');
  // The refusal's summary stands in for the quote…
  assert.match(src, /const summary: StorePreview \| null = quote \?\? preview;/);
  assert.match(src, /setQuote\(null\);\s*setPreview\(refused\.preview\);\s*setBlocked\(refused\);/);
  // …the live button renders only with a placeable quote, and the blocked footer's is disabled.
  assert.match(src, /\{quote && \(\s*<div className="shrink-0 border-t/);
  assert.match(src, /\{!quote && blocked && \([\s\S]*?<button type="button" disabled/);
  assert.match(src, /<CheckoutDeliveryPanel/);
});

test('the editor is mounted in the settings tab, lazily, and the flat fee field is gone', () => {
  const tab = code('src/components/merchant/dashboard/StoreSettingsTab.tsx');
  assert.match(tab, /const DeliverySettingsEditor = lazy\(\(\) => import\('\.\.\/delivery\/DeliverySettingsEditor'\)\);/);
  assert.match(tab, /<DeliverySettingsEditor storeGovernorate=/);
  assert.ok(!/delivery_settings:/.test(tab), 'the settings save no longer sends the flat fee');
  assert.ok(!/delivery_fee/.test(tab));
  const editor = code('src/components/merchant/delivery/DeliverySettingsEditor.tsx');
  assert.ok(!/\bconfirm\(|\balert\(/.test(editor), 'no native dialogs');
  assert.match(editor, /merchantApi\.saveDelivery\(\{ version: loaded\.profile\.version, \.\.\.payloadFromDraft\(draft\) \}\)/);
  assert.match(editor, /DELIVERY_VERSION_CONFLICT/);
});

test('the storefront says «التوصيل إلى …» from the server’s answer only', () => {
  const parts = code('src/components/storefront/parts.tsx');
  assert.match(parts, /const d = store\.delivery_to_you;/);
  assert.match(parts, /const toYou = deliveryToYou\(store, loc, lang\);/);
  const block = code('src/components/storefront/blocks/DeliveryInfo.tsx');
  assert.match(block, /data-delivery-to-you/);
});
