/**
 * «توصيل عادي مجاني — للدفع الكامل من محفظة Levo» — the pure rule
 * (worker/lib/walletFreeDelivery.ts, docs/GIFTS_QUICK_BUY.md §2, D7–D8).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WALLET_FREE_DELIVERY_DEFAULT,
  normalizeWalletFreeDelivery,
  validateWalletFreeDelivery,
  walletFreeDeliveryVerdict,
  type WalletFreeDeliveryLine,
} from '../worker/lib/walletFreeDelivery';

const PRINTER: WalletFreeDeliveryLine = { ancestry: ['cat_printers', 'cat_printers_fdm'], paid_iqd: 600_000 };
const FILAMENT: WalletFreeDeliveryLine = { ancestry: ['cat_materials', 'cat_materials_fdm'], paid_iqd: 25_000 };
const NOZZLE: WalletFreeDeliveryLine = { ancestry: ['cat_pacc'], paid_iqd: 8_000 };
const verdict = (lines: WalletFreeDeliveryLine[], over: Partial<Parameters<typeof walletFreeDeliveryVerdict>[0]> = {}) =>
  walletFreeDeliveryVerdict({
    config: WALLET_FREE_DELIVERY_DEFAULT,
    deliveryMethodId: 'standard',
    paymentMethodId: 'wallet',
    pointsUsedIqd: 0,
    lines,
    productsSubtotalIqd: lines.reduce((n, l) => n + l.paid_iqd, 0),
    ...over,
  });

test('a printer order of 500,000 IQD or more paid fully from the wallet gets free standard delivery', () => {
  const v = verdict([PRINTER]);
  assert.equal(v.eligible, true);
  assert.equal(v.rule?.catalog_id, 'cat_printers');
  assert.equal(verdict([{ ...PRINTER, paid_iqd: 500_000 }]).eligible, true, 'the minimum itself qualifies');
  assert.equal(verdict([{ ...PRINTER, paid_iqd: 499_999 }]).reason, 'no_rule_met');
});

test('a filament order paid fully from the wallet qualifies from the first dinar', () => {
  assert.equal(verdict([FILAMENT]).eligible, true);
  assert.equal(verdict([FILAMENT, NOZZLE]).rule?.catalog_id, 'cat_materials_fdm');
  assert.equal(verdict([NOZZLE]).reason, 'no_rule_met', 'an accessory alone is not covered');
});

test('only normal delivery, only 100% wallet, never with points', () => {
  assert.equal(verdict([PRINTER], { deliveryMethodId: 'personal' }).reason, 'method_not_covered');
  assert.equal(verdict([PRINTER], { deliveryMethodId: 'pickup' }).reason, 'method_not_covered');
  assert.equal(verdict([PRINTER], { paymentMethodId: 'cash' }).reason, 'not_full_wallet');
  assert.equal(verdict([PRINTER], { paymentMethodId: 'bnpl' }).reason, 'not_full_wallet');
  assert.equal(verdict([PRINTER], { pointsUsedIqd: 1_000 }).reason, 'points_used');
  assert.equal(verdict([PRINTER], { config: { ...WALLET_FREE_DELIVERY_DEFAULT, enabled: false } }).reason, 'disabled');
  const open = { ...WALLET_FREE_DELIVERY_DEFAULT, require_full_wallet: false };
  assert.equal(verdict([PRINTER], { config: open, paymentMethodId: 'cash' }).eligible, true, 'the admin can drop the wallet condition');
});

test('a gift-only order pays nothing for products and never qualifies', () => {
  assert.equal(verdict([{ ...FILAMENT, paid_iqd: 0 }]).reason, 'no_paid_products');
  assert.equal(verdict([{ ...PRINTER, paid_iqd: 0 }, FILAMENT]).rule?.catalog_id, 'cat_materials_fdm', 'a free printer does not count as a printer order');
});

test('a disabled rule is skipped and the subtotal is the whole paid order', () => {
  const config = { ...WALLET_FREE_DELIVERY_DEFAULT, rules: [{ catalog_id: 'cat_printers', min_products_iqd: 500_000, enabled: false }] };
  assert.equal(verdict([PRINTER], { config }).reason, 'no_rule_met');
  const cheapPrinter = { ...PRINTER, paid_iqd: 300_000 };
  assert.equal(verdict([cheapPrinter, { ...NOZZLE, paid_iqd: 250_000 }]).eligible, true, '«مجموع المنتجات فيها»: the order subtotal reaches the minimum');
});

test('the stored setting is read tolerantly and written strictly', () => {
  assert.deepEqual(normalizeWalletFreeDelivery(null), WALLET_FREE_DELIVERY_DEFAULT);
  assert.deepEqual(normalizeWalletFreeDelivery({ methods: ['standard', 'pickup', 'personal'] }).methods, ['standard', 'personal']);
  assert.deepEqual(normalizeWalletFreeDelivery({ rules: [{ catalog_id: 'bad id!', min_products_iqd: 1 }, { catalog_id: 'cat_x', min_products_iqd: -5 }, { catalog_id: 'cat_y', min_products_iqd: 5 }] }).rules,
    [{ catalog_id: 'cat_y', min_products_iqd: 5, enabled: true }]);
  assert.equal(validateWalletFreeDelivery(WALLET_FREE_DELIVERY_DEFAULT).ok, true);
  for (const bad of [
    null, [], { ...WALLET_FREE_DELIVERY_DEFAULT, enabled: 'yes' },
    { ...WALLET_FREE_DELIVERY_DEFAULT, methods: [] },
    { ...WALLET_FREE_DELIVERY_DEFAULT, methods: ['pickup'] },
    { ...WALLET_FREE_DELIVERY_DEFAULT, rules: [{ catalog_id: 'cat_printers', min_products_iqd: 1.5 }] },
    { ...WALLET_FREE_DELIVERY_DEFAULT, rules: [{ catalog_id: 'cat_printers', min_products_iqd: 1 }, { catalog_id: 'cat_printers', min_products_iqd: 2 }] },
  ]) assert.equal(validateWalletFreeDelivery(bad).ok, false, JSON.stringify(bad));
});
