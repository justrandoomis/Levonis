/**
 * «PRO + طلب مسبق مدفوع مقدمًا = فلمنت هدية».
 *
 * The rule the owner stated has four conditions and every one of them is load
 * bearing, so each has a test that removes exactly that condition. The fifth
 * test is the one that matters most commercially: while the owner has not
 * chosen WHICH filament the promise means, nothing is granted at all. A store
 * that starts giving away stock because a switch defaulted to on is a worse
 * failure than a benefit that arrives a week late.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preorderGiftFor } from '../worker/lib/entitlements';
import type { PreorderGiftConfig } from '../worker/lib/entitlements';

const NOW = '2026-09-04T00:00:00.000Z';
const CONFIGURED: PreorderGiftConfig = {
  enabled: true,
  product_id: 'prd_pla_basic',
  label_ar: 'بكرة PLA بلون من اختيارك',
  qty: 1,
};

const ask = (over: Partial<Parameters<typeof preorderGiftFor>[0]> = {}) =>
  preorderGiftFor({
    config: CONFIGURED,
    proContext: true,
    isPreorder: true,
    dueOnDeliveryIqd: 0,
    now: NOW,
    ...over,
  });

test('an eligible PRO prepaying a pre-order earns the filament', () => {
  const gift = ask();
  assert.ok(gift);
  assert.equal(gift.kind, 'preorder_filament');
  assert.equal(gift.reason, 'pro_prepaid_preorder');
  assert.equal(gift.product_id, 'prd_pla_basic');
  assert.equal(gift.label_ar, 'بكرة PLA بلون من اختيارك');
  assert.equal(gift.qty, 1);
  assert.equal(gift.granted_at, NOW);
});

test('it is worth 0 IQD — a gift is stock, not a discount', () => {
  // If this ever became non-zero it would have to move a total somewhere, and
  // every screen that shows a price would have to learn about it.
  assert.equal(ask()!.value_iqd, 0);
});

test('a customer outside the PRO context earns nothing', () => {
  // proContext already means active PRO at the approved default address. An
  // order priced as ordinary must not carry a PRO benefit.
  assert.equal(ask({ proContext: false }), null);
});

test('a direct sale earns nothing — the promise is about waiting', () => {
  assert.equal(ask({ isPreorder: false }), null);
});

test('a pre-order with money still due at the door earns nothing', () => {
  assert.equal(ask({ dueOnDeliveryIqd: 1 }), null);
});

test('nothing is granted while the owner has not chosen the filament', () => {
  assert.equal(ask({ config: { enabled: true, product_id: '' } }), null);
  assert.equal(ask({ config: { enabled: false, product_id: 'prd_pla_basic' } }), null);
  assert.equal(ask({ config: null }), null);
  assert.equal(ask({ config: undefined }), null);
});

test('a nonsense quantity falls back to one spool, never to zero or a fraction', () => {
  assert.equal(ask({ config: { ...CONFIGURED, qty: 0 } })!.qty, 1);
  assert.equal(ask({ config: { ...CONFIGURED, qty: -3 } })!.qty, 1);
  assert.equal(ask({ config: { ...CONFIGURED, qty: 2.5 } })!.qty, 1);
  assert.equal(ask({ config: { ...CONFIGURED, qty: 3 } })!.qty, 3);
});
