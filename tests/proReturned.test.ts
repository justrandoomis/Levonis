/**
 * PRO, RETURNED (owner, 2026-11-19) — the two benefits that are code:
 *
 *  1. THE SERVICES DISCOUNT. An active PRO pays every paid printer service
 *     (warranty, Levo Care, extra packaging, inspection, academy), Personal
 *     delivery and a legacy warranty plan at the price list's
 *     `pro_discount_pct` off (50 unless the owner changes it). Each line keeps
 *     its list fee beside what was charged, so the saving can be shown.
 *  2. THE RETURN. An order bought under PRO has 14 days to request a return
 *     and pays no return fee; every other order keeps 7 — judged by the tier
 *     frozen on the order, through the real returns router.
 *
 * Run: node --import tsx --test tests/proReturned.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PRINTER_SERVICES,
  PRO_SERVICES_DISCOUNT_DEFAULT_PCT,
  canonicalConfig,
  configIssues,
  priceServices,
  proDiscountedFee,
  proServicesDiscountPct,
  servicesOffer,
  type PrinterServicesConfig,
  type ServiceSelection,
} from '../packages/pricing/src/printerServices';
import { resolveUnitPrice, type PricingProduct } from '../worker/lib/pricing';
import { quoteShipping, couponDeliveryBase, type ShippingConfig, type ShippingItem } from '../worker/lib/shipping';
import { ENTITLEMENT_MINIMUM_TIER, entitlementSnapshot, type TierStatus } from '../worker/lib/entitlements';
import { PRO_RETURN_WINDOW_DAYS, RETURN_WINDOW_DAYS, returnTermsFor } from '../worker/lib/returnWindow';
import { asD1, stubApp, post, get, json, type StubUser } from './fixtures/app';
import { cartRoutes } from '../worker/routes/cart';
import { orderRoutes } from '../worker/routes/orders';
import { returnRoutes } from '../worker/routes/returns';
import { seedCatalogue, orderBody } from './lib/bundles';

const clone = (): PrinterServicesConfig => JSON.parse(JSON.stringify(DEFAULT_PRINTER_SERVICES));
const A1 = { warranty_family: 'a1', delivery_class: 'd1' } as const;
/** The «complete» package: w24 100,000 + Care 19,000 + extra packaging 7,000 + inspection 5,000, live academy 50,000, Personal. */
const everything: ServiceSelection = {
  v: 1, package: 'custom', warranty: 'w24', care: 'c12', packaging: 'extra', inspection: 'full', academy: 'live_whatsapp',
  delivery: 'personal', confirmed: true, ack_no_warranty: false,
};

// ------------------------------------------------------------ 1. services

test('services: an active PRO pays every paid service at 50%, each line showing its list fee and the saving', () => {
  const c = clone();
  const guest = priceServices(c, A1, everything);
  const pro = priceServices(c, A1, everything, { pro: true });
  assert.deepEqual(guest.blockers, []);
  assert.deepEqual(pro.blockers, []);
  assert.equal(guest.fee_iqd, 100_000 + 19_000 + 7_000 + 5_000 + 50_000);
  assert.equal(pro.fee_iqd, 50_000 + 9_500 + 3_500 + 2_500 + 25_000);
  assert.equal(guest.pro_discount, undefined, 'a guest carries no discount block');
  for (const line of pro.lines) {
    const list = guest.lines.find((l) => l.service === line.service)!;
    if (list.fee_iqd === 0) {
      assert.equal(line.fee_before_discount_iqd, undefined, `${line.service}: a free line shows no saving`);
      continue;
    }
    assert.equal(line.fee_before_discount_iqd, list.fee_iqd, `${line.service}: the list fee rides along`);
    assert.equal(line.fee_iqd + (line.pro_discount_iqd ?? 0), list.fee_iqd, `${line.service}: before = after + saving`);
  }
  // Personal delivery (d1: 15,000) is a paid service too; Economy is not discounted.
  assert.equal(guest.delivery_fee_iqd, 15_000);
  assert.equal(pro.delivery_fee_iqd, 7_500);
  assert.deepEqual(pro.delivery_options, { economy_iqd: 5_000, personal_iqd: 7_500 });
  assert.deepEqual(pro.pro_discount, { pct: 50, services_iqd: 90_500, personal_before_iqd: 15_000, personal_iqd: 7_500 });
  const economy = priceServices(c, A1, { ...everything, delivery: 'economy' }, { pro: true });
  assert.equal(economy.delivery_fee_iqd, 5_000, 'Economy belongs to the free-delivery rules, not to this discount');
});

test('services: the percent is the owner’s — absent = 50, 0 = none, a whole 0..90 only, kept through the canonical form', () => {
  const c = clone();
  assert.equal(c.pro_discount_pct, undefined);
  assert.equal(proServicesDiscountPct(c), PRO_SERVICES_DISCOUNT_DEFAULT_PCT);
  assert.equal(proServicesDiscountPct(null), 50);
  c.pro_discount_pct = 30;
  assert.deepEqual(configIssues(c), []);
  assert.equal(canonicalConfig(c).pro_discount_pct, 30);
  assert.equal(priceServices(c, A1, everything, { pro: true }).fee_iqd, 70_000 + 13_300 + 4_900 + 3_500 + 35_000);
  assert.equal(servicesOffer(c, A1).pro_discount_pct, 30);
  c.pro_discount_pct = 0;
  const none = priceServices(c, A1, everything, { pro: true });
  assert.equal(none.pro_discount, undefined);
  assert.equal(none.fee_iqd, 181_000);
  for (const bad of [95, -1, 12.5, '50']) {
    assert.ok(configIssues({ ...clone(), pro_discount_pct: bad }).some((i) => i.startsWith('pro_discount_pct')), `${String(bad)} refused`);
  }
  // A config without the field stays without it (the stored lists published before today).
  assert.equal('pro_discount_pct' in canonicalConfig(clone()), false);
  // The discount is floored to a whole dinar: the member never pays a fraction.
  assert.equal(proDiscountedFee(67_425, 50), 33_713);
  assert.equal(proDiscountedFee(0, 50), 0);
});

const printer = (over: Partial<PricingProduct> = {}): PricingProduct => ({
  price_iqd: 840_000, pro_price_iqd: null, prime_price_iqd: null, product_cost_iqd: 600_000,
  options: [], colors: [], preorder_transports: [], warranty_plans: [],
  selling_type: 'direct_sale', sale_types: ['direct_sale'],
  ...over,
});

test('resolver: the discount follows the PRO pricing context — PRO in it pays half, PRO outside it and PREMIUM pay the list', () => {
  const ps = { config: clone(), classes: A1, selection: everything };
  const inContext = resolveUnitPrice({ product: printer(), printerServices: ps, tier: 'pro', tierActive: true });
  const outside = resolveUnitPrice({ product: printer(), printerServices: ps, tier: 'pro', tierActive: false });
  const premium = resolveUnitPrice({ product: printer(), printerServices: ps, tier: 'prime', tierActive: true });
  assert.deepEqual(inContext.errors, []);
  assert.equal(inContext.services?.fee_iqd, 90_500);
  assert.equal(inContext.unit_subtotal_iqd, 840_000 + 90_500);
  // `tierActive` false is a frozen (paused) PRO, an unapproved address or a restricted account.
  assert.equal(outside.services?.fee_iqd, 181_000);
  assert.equal(premium.services?.fee_iqd, 181_000);
  assert.equal(premium.services?.pro_discount, undefined);
});

// ------------------------------------------------------------ 2. shipping

const cfg = (): ShippingConfig => ({
  ordinary_iqd: 5000, printer_small_iqd: 25000, printer_large_iqd: 50000, pro_threshold_iqd: 75000,
  threshold_basis: 'merchandise_after_coupon', pro_waiver_covers: 'all', prime_threshold_iqd: 150000,
  prime_waiver_covers: 'ordinary_only', carton_threshold_spools: 10, carton_fee_iqd: 3000,
  printer_advance_required: true, protected_iqd: 4000,
});
const servicedPrinter = (delivery: 'economy' | 'personal', pro: boolean, qty = 2): ShippingItem => {
  const priced = priceServices(clone(), A1, { ...everything, delivery }, { pro });
  return {
    product_id: 'p_a1', qty, is_printer: true, size_class: 'printer_small',
    printer_service: {
      delivery, delivery_class: 'd1',
      economy_iqd: priced.delivery_options.economy_iqd, personal_iqd: priced.delivery_options.personal_iqd,
      ...(priced.pro_discount ? { personal_before_discount_iqd: priced.pro_discount.personal_before_iqd } : {}),
    },
  };
};

test('shipping: PRO Personal delivery is charged at the discount and the component shows the list fee and the saving', () => {
  const base = { deliveryMethod: 'standard' as const, merchandiseIqd: 10_000, atApprovedDefaultAddress: true, config: cfg() };
  const guest = quoteShipping({ ...base, items: [servicedPrinter('personal', false)], tier: 'free', tierActive: false });
  const pro = quoteShipping({ ...base, items: [servicedPrinter('personal', true)], tier: 'pro', tierActive: true, proShippingEntitled: true });
  const g = guest.components.find((c) => c.kind === 'printer_service')!;
  const p = pro.components.find((c) => c.kind === 'printer_service')!;
  assert.equal(g.fee_iqd, 30_000);
  assert.equal(g.fee_before_discount_iqd, undefined);
  assert.equal(p.fee_iqd, 15_000, 'two units at 7,500');
  assert.equal(p.fee_before_discount_iqd, 30_000);
  assert.equal(p.pro_discount_iqd, 15_000);
  assert.equal(p.waived, false, 'Personal is still never waived — it is discounted');
  assert.equal(pro.total_iqd, 15_000);
  // A delivery coupon still never takes Personal: the discounted fee stays out of its base.
  assert.equal(couponDeliveryBase(pro), 0);
  // Economy carries no discount fields.
  const econ = quoteShipping({ ...base, items: [servicedPrinter('economy', true)], tier: 'pro', tierActive: true, proShippingEntitled: true });
  assert.equal(econ.components.find((c) => c.kind === 'printer_service')!.fee_before_discount_iqd, undefined);
});

// ------------------------------------------------------------ 3. returns

test('entitlements: the services discount and the 14-day return are PRO’s and nobody else’s', () => {
  assert.equal(ENTITLEMENT_MINIMUM_TIER.proServicesDiscount, 'pro');
  assert.equal(ENTITLEMENT_MINIMUM_TIER.proFreeReturn14, 'pro');
  const status = (tier: TierStatus['tier'], active = true): TierStatus =>
    ({ tier, active, expires_at: null, pending_launch: null, gated_benefits: [] });
  assert.equal(entitlementSnapshot(status('pro')).proFreeReturn14, true);
  assert.equal(entitlementSnapshot(status('prime')).proFreeReturn14, false);
  assert.equal(entitlementSnapshot(status('pro', false)).proServicesDiscount, false);
});

test('return terms: 14 days and fee-free for an order bought under PRO, 7 for every other', () => {
  assert.deepEqual(returnTermsFor('pro'), { window_days: PRO_RETURN_WINDOW_DAYS, free_return: true });
  for (const t of ['prime', 'plus', 'free', null, undefined, 'garbage']) {
    assert.deepEqual(returnTermsFor(t), { window_days: RETURN_WINDOW_DAYS, free_return: false }, String(t));
  }
  assert.equal(PRO_RETURN_WINDOW_DAYS, 14);
  assert.equal(RETURN_WINDOW_DAYS, 7);
});

const buyer: StubUser = { id: 'buyer', role: 'customer', email: 's@x.co' };
const appFor = (db: unknown) =>
  stubApp(db, buyer, (a) => {
    a.route('/api/cart', cartRoutes);
    a.route('/api/orders', orderRoutes);
    a.route('/api/returns', returnRoutes);
  });

test('returns route: day 10 after delivery is closed for an ordinary order and open for one bought under PRO; the list says which', async () => {
  const raw = seedCatalogue();
  const db = asD1(raw);
  const added = await json(await post(appFor(db), '/api/cart/items', { productId: 'p_pla', qty: 1 }));
  assert.equal(added.success, true, JSON.stringify(added));
  const placed = await json(await post(appFor(db), '/api/orders', orderBody()));
  assert.equal(placed.success, true, JSON.stringify(placed));
  const orderId = placed.order.id as string;
  const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
  raw.prepare("UPDATE orders SET status='delivered', stage='delivered', delivered_at=? WHERE id=?").run(tenDaysAgo, orderId);
  const itemId = (raw.prepare('SELECT id FROM order_items WHERE order_id = ? ORDER BY rowid LIMIT 1').get(orderId) as { id: string }).id;

  const listed = await json(await get(appFor(db), `/api/returns?orderId=${orderId}`));
  assert.deepEqual(listed.terms, { window_days: 7, free_return: false });
  const closed = await post(appFor(db), '/api/returns', { orderItemId: itemId, qty: 1, reason: 'defective' });
  const closedBody = await json(closed);
  assert.equal(closedBody.code, 'RETURN_WINDOW_CLOSED', JSON.stringify(closedBody));

  // The same order, bought under PRO (the snapshot the checkout writes for an active, unpaused PRO).
  raw.prepare("UPDATE orders SET membership_tier_snapshot = 'pro' WHERE id = ?").run(orderId);
  const proListed = await json(await get(appFor(db), `/api/returns?orderId=${orderId}`));
  assert.deepEqual(proListed.terms, { window_days: 14, free_return: true });
  const opened = await json(await post(appFor(db), '/api/returns', { orderItemId: itemId, qty: 1, reason: 'defective' }));
  assert.equal(opened.success, true, JSON.stringify(opened));

  // Day 15 is past even PRO's window.
  raw.prepare('DELETE FROM return_cases WHERE order_id = ?').run(orderId);
  raw.prepare('UPDATE orders SET delivered_at = ? WHERE id = ?').run(new Date(Date.now() - 15 * 86_400_000).toISOString(), orderId);
  const late = await json(await post(appFor(db), '/api/returns', { orderItemId: itemId, qty: 1, reason: 'defective' }));
  assert.equal(late.code, 'RETURN_WINDOW_CLOSED');
});
