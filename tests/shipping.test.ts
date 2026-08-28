/**
 * Unit tests pinning the CONFIRMED shipping rules (final-phase brief §6.3):
 * strict >75,000 threshold, PRO-only, approved-default-address-only,
 * alternate-address ordinary treatment, unconfigured fees honest.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quoteShipping } from '../worker/lib/shipping';
import type { ShippingConfig, ShippingItem } from '../worker/lib/shipping';

const cfg = (over: Partial<ShippingConfig> = {}): ShippingConfig => ({
  ordinary_iqd: 5000,
  printer_small_iqd: 25000,
  printer_large_iqd: 50000,
  pro_threshold_iqd: 75000,
  threshold_basis: 'merchandise_after_coupon',
  pro_waiver_covers: 'all',
  carton_threshold_spools: 10,
  carton_fee_iqd: 3000,
  printer_advance_required: true,
  ...over,
});

const ordinary = (qty = 1): ShippingItem => ({ product_id: 'p1', qty, size_class: 'ordinary' });
const spool = (qty: number): ShippingItem => ({ product_id: 'sp', qty, size_class: 'ordinary', is_spool: true });
const printerS = (qty = 1): ShippingItem => ({ product_id: 'pr', qty, size_class: 'printer_small' });

const asFree = { tier: 'free' as const, tierActive: false };
const asPro = { tier: 'pro' as const, tierActive: true };

test('ordinary product ships at 5,000 IQD everywhere', () => {
  const q = quoteShipping({ items: [ordinary()], merchandiseIqd: 30000, ...asFree, atApprovedDefaultAddress: false, config: cfg() });
  assert.equal(q.total_iqd, 5000);
});

test('CONFIRMED: exactly 75,000 does NOT qualify; 75,001 does', () => {
  const at75k = quoteShipping({ items: [ordinary()], merchandiseIqd: 75000, ...asPro, atApprovedDefaultAddress: true, config: cfg() });
  assert.equal(at75k.pro_waiver_applied, false);
  assert.equal(at75k.total_iqd, 5000);
  const above = quoteShipping({ items: [ordinary()], merchandiseIqd: 75001, ...asPro, atApprovedDefaultAddress: true, config: cfg() });
  assert.equal(above.pro_waiver_applied, true);
  assert.equal(above.total_iqd, 0);
});

test('CONFIRMED: waiver is PRO-only — free and PLUS tiers never qualify', () => {
  for (const tier of [{ tier: 'free' as const, tierActive: false }, { tier: 'plus' as const, tierActive: true }]) {
    const q = quoteShipping({ items: [ordinary()], merchandiseIqd: 200000, ...tier, atApprovedDefaultAddress: true, config: cfg() });
    assert.equal(q.pro_waiver_applied, false);
    assert.equal(q.total_iqd, 5000);
  }
});

test('CONFIRMED: PRO at an ALTERNATE address is priced as ordinary', () => {
  const q = quoteShipping({ items: [ordinary()], merchandiseIqd: 200000, ...asPro, atApprovedDefaultAddress: false, config: cfg() });
  assert.equal(q.pro_waiver_applied, false);
  assert.equal(q.total_iqd, 5000);
});

test('printer fees per unit by size class; advance due', () => {
  const q = quoteShipping({
    items: [printerS(2), { product_id: 'pl', qty: 1, size_class: 'printer_large' }],
    merchandiseIqd: 50000, ...asFree, atApprovedDefaultAddress: false, config: cfg(),
  });
  assert.equal(q.total_iqd, 2 * 25000 + 50000);
  assert.equal(q.advance_due_iqd, 100000);
});

test('unconfigured printer fee → needs_config, no invented fee', () => {
  const q = quoteShipping({
    items: [printerS()], merchandiseIqd: 50000, ...asFree, atApprovedDefaultAddress: false,
    config: cfg({ printer_small_iqd: null }),
  });
  assert.ok(q.needs_config.includes('printer_small_fee_unconfigured'));
  assert.equal(q.total_iqd, 0); // blocked at checkout, never silently charged
});

test('carton fee only above threshold and only when configured', () => {
  const under = quoteShipping({ items: [spool(10)], merchandiseIqd: 40000, ...asFree, atApprovedDefaultAddress: false, config: cfg() });
  assert.ok(!under.components.some((c) => c.kind === 'carton'));
  const over = quoteShipping({ items: [spool(11)], merchandiseIqd: 44000, ...asFree, atApprovedDefaultAddress: false, config: cfg() });
  assert.ok(over.components.some((c) => c.kind === 'carton' && c.fee_iqd === 3000));
  const unconfigured = quoteShipping({ items: [spool(50)], merchandiseIqd: 200000, ...asFree, atApprovedDefaultAddress: false, config: cfg({ carton_fee_iqd: null }) });
  assert.ok(!unconfigured.components.some((c) => c.kind === 'carton'));
});

test('eligible PRO waiver covers printers under the default assumption (flagged)', () => {
  const q = quoteShipping({ items: [printerS(), ordinary()], merchandiseIqd: 300000, ...asPro, atApprovedDefaultAddress: true, config: cfg() });
  assert.equal(q.total_iqd, 0);
  assert.equal(q.advance_due_iqd, 0);
  assert.ok(q.assumptions.some((a) => a.includes('pro_waiver_covers=all')));
});

test('independent promo free delivery is distinct from the PRO rule', () => {
  const q = quoteShipping({
    items: [ordinary()], merchandiseIqd: 10000, ...asFree, atApprovedDefaultAddress: false,
    independentFreeDelivery: true, config: cfg(),
  });
  assert.equal(q.total_iqd, 0);
  assert.equal(q.pro_waiver_applied, false);
});
