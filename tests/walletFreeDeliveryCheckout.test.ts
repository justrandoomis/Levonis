/**
 * «توصيل عادي مجاني — للدفع الكامل من محفظة Levo» THROUGH THE REAL CHECKOUT
 * (owner brief 2026-10-06 §2, docs/GIFTS_QUICK_BUY.md D7–D8).
 *
 * The rule is pure (tests/walletFreeDelivery.test.ts); these tests are about
 * the money around it: the quote and the order door price the same waiver,
 * the order row keeps the original fee and the rule that waived it, the
 * customer is charged 0 for delivery — never a fee computed and then taken
 * back — and the admin switch and minimums are the only way to change who
 * qualifies.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, post, put, get, json, row } from './fixtures/app';
import { orderRoutes } from '../worker/routes/orders';
import { adminRoutes } from '../worker/routes/admin';
import { miscRoutes } from '../worker/routes/misc';
import { acceptedPolicies } from './lib/policies';
import { quoteShipping } from '../worker/lib/shipping';
import type { ShippingConfig } from '../worker/lib/shipping';

const RATE = 1400;

function world(): DatabaseSync {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','s@x.co','h','customer'),
      ('boss','Boss','boss@x.co','h','admin');
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,is_default)
      VALUES ('addr','buyer','Home','Sara','+9647701234567','Baghdad, Karrada 12','',1);
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images,category_id,sub_category_id) VALUES
      ('p_printer','a1-combo','A1 Combo','A1 كومبو',600000,'active',5,'[]','[]','direct_sale','["direct_sale"]','[]','[]','cat_printers','cat_printers_fdm'),
      ('p_cheap','mini','Mini printer','طابعة صغيرة',300000,'active',5,'[]','[]','direct_sale','["direct_sale"]','[]','[]','cat_printers','cat_printers_fdm'),
      ('p_pla','pla-basic','PLA Basic','PLA أساسي',25000,'active',50,'[]','[]','direct_sale','["direct_sale"]','[]','[]','cat_materials','cat_materials_fdm'),
      ('p_nozzle','nozzle','Hardened nozzle','فوهة مقساة',8000,'active',50,'[]','[]','direct_sale','["direct_sale"]','[]','[]',NULL,NULL);
    INSERT INTO product_catalogs (product_id,catalog_id,position) VALUES
      ('p_printer','cat_printers_fdm',0), ('p_cheap','cat_printers_fdm',1), ('p_pla','cat_materials_fdm',0);
  `);
  // 2,000,000 IQD of approved wallet credit.
  raw.exec(`INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note)
            VALUES ('wt_fund','buyer','deposit','USD',${Math.ceil((2_000_000 * 100) / RATE)},'approved','test funding')`);
  return raw;
}

let line = 0;
const cart = (raw: DatabaseSync, productId: string, qty = 1) =>
  raw
    .prepare(
      `INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,shipping_method_id,transport_method,warranty_plan_id,qty)
       VALUES (?,?,?,'','[]','','','','',?)`
    )
    .run(`ci_${++line}`, 'buyer', productId, qty);

const buyerApp = (raw: DatabaseSync) =>
  stubApp(asD1(raw), { id: 'buyer', role: 'customer', email: 's@x.co' }, (a) => a.route('/api/orders', orderRoutes));
const adminApp = (raw: DatabaseSync) =>
  stubApp(asD1(raw), { id: 'boss', role: 'admin', email: 'boss@x.co' }, (a) => {
    a.route('/api/admin', adminRoutes);
    a.route('/api', miscRoutes);
  });

let key = 0;
const body = (over: Record<string, unknown> = {}) => ({
  addressId: 'addr',
  deliveryMethodId: 'standard',
  paymentMethodId: 'wallet',
  useWallet: false,
  usePoints: false,
  itemIds: [],
  idempotencyKey: `wallet-free-delivery-${++key}`,
  policyAcceptance: acceptedPolicies(),
  printerStandardDeliveryAcceptance: { accepted: true, version: 1 },
  ...over,
});

const quote = async (raw: DatabaseSync, over: Record<string, unknown> = {}) => {
  const res = await json(await post(buyerApp(raw), '/api/orders/quote', body(over)));
  assert.equal(res.success, true, JSON.stringify(res));
  return res.quote;
};

const place = async (raw: DatabaseSync, over: Record<string, unknown> = {}) => {
  const res = await json(await post(buyerApp(raw), '/api/orders', body(over)));
  assert.equal(res.success, true, JSON.stringify(res));
  const id = String(res.order?.id ?? res.orderId ?? res.id);
  return row<Record<string, unknown>>(raw, 'SELECT * FROM orders WHERE id = ?', id)!;
};

test('a printer order of 600,000 IQD paid fully from the wallet: standard delivery quoted, waived and charged 0', async () => {
  const raw = world();
  cart(raw, 'p_printer');
  const q = await quote(raw);
  assert.equal(q.shipping.total_before_waiver_iqd, 10_000, 'the standard printer tariff is still priced');
  assert.equal(q.shipping.total_iqd, 0);
  assert.equal(q.shipping.waiver_source, 'wallet');
  assert.equal(q.shipping.wallet_waiver_iqd, 10_000);
  assert.deepEqual(q.wallet_free_delivery, {
    applied: true,
    waived_iqd: 10_000,
    rule: { catalog_id: 'cat_printers', min_products_iqd: 500_000 },
    available_with_wallet: false,
  });

  const order = await place(raw);
  assert.equal(order.shipping_iqd, 0, 'the customer is charged 0 for delivery');
  assert.equal(order.shipping_before_benefit_iqd, 10_000, 'the original fee is recorded');
  assert.equal(order.shipping_benefit_iqd, 10_000, 'and what was waived');
  assert.equal(order.delivery_waived, 1);
  assert.equal(order.referral_delivery_waived, 0, 'not a promotion');
  assert.equal(order.total_iqd, 600_000);
  assert.equal(order.wallet_applied_iqd, 600_000);
  assert.equal(order.due_on_delivery_iqd, 0);
  const snapshot = JSON.parse(String(order.benefit_snapshot));
  assert.equal(snapshot.shipping.waiver_source, 'wallet');
  assert.deepEqual(snapshot.wallet_free_delivery, {
    applied: true,
    waived_iqd: 10_000,
    reason: 'eligible',
    rule: { catalog_id: 'cat_printers', min_products_iqd: 500_000, enabled: true },
    products_subtotal_iqd: 600_000,
  });
  assert.equal(JSON.parse(String(order.delivery_method_snapshot)).quote.waiver_source, 'wallet');
  const spent = row<{ iqd: number }>(
    raw,
    "SELECT COALESCE(SUM(amount_iqd),0) AS iqd FROM wallet_transactions WHERE user_id = 'buyer' AND type <> 'deposit' AND status = 'approved'"
  )!;
  assert.equal(spent.iqd, 600_000, 'the wallet paid the products only — no delivery fee left the wallet');
});

test('the same printer paid cash on delivery pays the fee, and the quote says the wallet would waive it', async () => {
  const raw = world();
  cart(raw, 'p_printer');
  const q = await quote(raw, { paymentMethodId: 'cash' });
  assert.equal(q.shipping.total_iqd, 10_000);
  assert.equal(q.shipping.waiver_source, 'none');
  assert.equal(q.wallet_free_delivery.applied, false);
  assert.equal(q.wallet_free_delivery.available_with_wallet, true, 'the hint that paying from the wallet would earn it');
  const order = await place(raw, { paymentMethodId: 'cash' });
  assert.equal(order.shipping_iqd, 10_000);
  assert.equal(order.delivery_waived, 0);
  assert.equal(JSON.parse(String(order.benefit_snapshot)).wallet_free_delivery.reason, 'not_full_wallet');
});

test('a printer order under 500,000 IQD pays the fee even from the wallet', async () => {
  const raw = world();
  cart(raw, 'p_cheap');
  const q = await quote(raw);
  assert.equal(q.shipping.total_iqd, 10_000);
  assert.equal(q.wallet_free_delivery.applied, false);
  assert.equal(q.wallet_free_delivery.available_with_wallet, false, 'no hint: the wallet would not earn it either');
  const order = await place(raw);
  assert.equal(order.shipping_iqd, 10_000);
  assert.equal(order.total_iqd, 310_000);
  assert.equal(JSON.parse(String(order.benefit_snapshot)).wallet_free_delivery.reason, 'no_rule_met');
});

test('a filament order paid from the wallet is free from the first dinar; an accessory alone is not', async () => {
  const raw = world();
  cart(raw, 'p_pla', 2);
  const q = await quote(raw);
  assert.equal(q.shipping.total_before_waiver_iqd, 5_000);
  assert.equal(q.shipping.total_iqd, 0);
  assert.equal(q.wallet_free_delivery.rule.catalog_id, 'cat_materials_fdm');
  const order = await place(raw);
  assert.equal(order.shipping_iqd, 0);
  assert.equal(order.total_iqd, 50_000);

  const other = world();
  cart(other, 'p_nozzle');
  const n = await quote(other);
  assert.equal(n.shipping.total_iqd, 5_000);
  assert.equal(n.wallet_free_delivery.applied, false);
});

test('personal delivery and store pickup are never covered by default', async () => {
  const raw = world();
  cart(raw, 'p_pla');
  const personal = await quote(raw, { deliveryMethodId: 'personal' });
  assert.ok(personal.shipping.total_iqd > 0, 'personal delivery keeps its fee');
  assert.equal(personal.shipping.waiver_source, 'none');
  assert.equal(personal.wallet_free_delivery.applied, false);
  const pickup = await quote(raw, { deliveryMethodId: 'pickup' });
  assert.equal(pickup.shipping.total_iqd, 0);
  assert.equal(pickup.wallet_free_delivery.applied, false, 'nothing to waive at a pickup');
});

test('the admin switch, methods and minimums decide — validated strictly and audited with the rule as saved', async () => {
  const raw = world();
  cart(raw, 'p_pla');
  const admin = adminApp(raw);
  const bad = async (value: unknown, code: string) => {
    const res = await put(admin, '/api/admin/settings/walletFreeDelivery', { value });
    assert.equal(res.status, 400, JSON.stringify(value));
    assert.equal((await json(res)).code, code);
  };
  const base = { enabled: true, require_full_wallet: true, methods: ['standard'], rules: [{ catalog_id: 'cat_materials_fdm', min_products_iqd: 0, enabled: true }] };
  await bad({ ...base, enabled: 'yes' }, 'WALLET_FREE_DELIVERY_INVALID');
  await bad({ ...base, methods: ['pickup'] }, 'WALLET_FREE_DELIVERY_INVALID');
  await bad({ ...base, rules: [{ catalog_id: 'cat_materials_fdm', min_products_iqd: -1 }] }, 'WALLET_FREE_DELIVERY_INVALID');
  await bad({ ...base, rules: [{ catalog_id: 'cat_does_not_exist', min_products_iqd: 0 }] }, 'WALLET_FREE_DELIVERY_SECTION');

  // Personal delivery switched on: the same filament order is now free by personal delivery too.
  const withPersonal = { ...base, methods: ['standard', 'personal'] };
  const ok = await put(admin, '/api/admin/settings/walletFreeDelivery', { value: withPersonal });
  assert.equal(ok.status, 200, JSON.stringify(await json(ok.clone())));
  const audit = row<{ detail: string }>(raw, "SELECT detail FROM audit_log WHERE action = 'settings.update' AND target = 'walletFreeDelivery' ORDER BY rowid DESC LIMIT 1");
  assert.ok(audit && JSON.parse(audit.detail).value.methods.includes('personal'), 'the audit keeps the whole rule');
  const personal = await quote(raw, { deliveryMethodId: 'personal' });
  assert.equal(personal.shipping.total_iqd, 0);
  assert.equal(personal.shipping.waiver_source, 'wallet');

  // Switched off: nothing is waived anywhere.
  await put(admin, '/api/admin/settings/walletFreeDelivery', { value: { ...withPersonal, enabled: false } });
  const off = await quote(raw);
  assert.equal(off.shipping.total_iqd, 5_000);
  assert.equal(off.wallet_free_delivery.applied, false);

  // The published offer is readable before any quote exists.
  const pub = await json(await get(admin, '/api/settings/public'));
  assert.equal(pub.settings.walletFreeDelivery.enabled, false);
  assert.deepEqual(pub.settings.walletFreeDelivery.methods, ['standard', 'personal']);
});

/* ------------------------------------------------ the engine's own invariants */

const cfg = (over: Partial<ShippingConfig> = {}): ShippingConfig => ({
  ordinary_iqd: 5_000,
  printer_small_iqd: null,
  printer_large_iqd: null,
  pro_threshold_iqd: 75_000,
  threshold_basis: 'merchandise_after_coupon',
  pro_waiver_covers: 'ordinary_only',
  prime_threshold_iqd: 150_000,
  prime_waiver_covers: 'ordinary_only',
  carton_threshold_spools: null,
  carton_fee_iqd: null,
  printer_advance_required: true,
  protected_iqd: 3_000,
  ...over,
});

test('the waiver never touches protected delivery, and legacy callers are unchanged', () => {
  const items = [{ product_id: 'p_pla', qty: 1, size_class: 'ordinary' as const }];
  const q = quoteShipping({
    items, deliveryMethod: 'standard', merchandiseIqd: 25_000, tier: 'free', tierActive: false,
    atApprovedDefaultAddress: true, protectedDelivery: true, walletFreeDelivery: true, config: cfg(),
  });
  assert.equal(q.total_before_waiver_iqd, 8_000);
  assert.equal(q.total_iqd, 3_000, 'the protected add-on stays charged');
  assert.equal(q.wallet_waiver_iqd, 5_000);
  assert.equal(q.components.find((c) => c.kind === 'protected')?.waived, false);
  const legacy = quoteShipping({
    items, merchandiseIqd: 25_000, tier: 'free', tierActive: false, atApprovedDefaultAddress: true,
    walletFreeDelivery: true, config: cfg({ protected_iqd: null }),
  });
  assert.equal(legacy.wallet_waiver_iqd, 0, 'without a delivery method the flag is ignored');
  assert.equal(legacy.total_iqd, 5_000);
});

test('PRO/PREMIUM keep precedence; a binding membership ceiling never makes the customer pay back part of a waived fee', () => {
  const items = [{ product_id: 'p_printer', qty: 1, is_printer: true }];
  const decision = (max: number | null) => ({
    rule_id: 'r1', eligible: true, threshold_iqd: 75_000, basis_iqd: 600_000, max_subsidy_iqd: max, reason: 'applied' as const,
  });
  const common = {
    items, deliveryMethod: 'standard' as const, merchandiseIqd: 600_000, tier: 'pro' as const, tierActive: true,
    proShippingEntitled: true, atApprovedDefaultAddress: true, config: cfg({ protected_iqd: null }),
  };
  const pro = quoteShipping({ ...common, membershipShipping: decision(null), walletFreeDelivery: true });
  assert.equal(pro.total_iqd, 0);
  assert.equal(pro.waiver_source, 'pro', 'the membership keeps the credit');
  assert.equal(pro.wallet_waiver_iqd, 0);
  assert.equal(pro.membership_subsidy_iqd, 10_000);

  const cappedAlone = quoteShipping({ ...common, membershipShipping: decision(4_000) });
  assert.equal(cappedAlone.total_iqd, 6_000, 'the historical capped quote');
  assert.equal(cappedAlone.membership_subsidy_capped, true);

  const cappedWithWallet = quoteShipping({ ...common, membershipShipping: decision(4_000), walletFreeDelivery: true });
  assert.equal(cappedWithWallet.total_iqd, 0, 'free, never negative');
  assert.equal(cappedWithWallet.wallet_waiver_iqd, 10_000);
  assert.equal(cappedWithWallet.membership_subsidy_iqd, 0, 'nothing is counted twice');
  assert.equal(cappedWithWallet.total_before_waiver_iqd - cappedWithWallet.total_iqd, cappedWithWallet.wallet_waiver_iqd + cappedWithWallet.membership_subsidy_iqd);
});
