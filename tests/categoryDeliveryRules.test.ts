/**
 * CATEGORY-LEVEL QUANTITY DELIVERY RULES (migration 0135).
 *
 * Owner, 2026-09-25: «أي فلمنت من أي نوع بغض النظر عن نوع المنتج او الخيار او
 * اللون … عندما يتجاوز عدد البكرات مثلا خمسة عشر يكون التوصيل خمسة آلاف لكل
 * خمسة عشر بكرة … توصيل العادي قسم fdm filament على القسم الفرعي كاملا هو 5000
 * لكل 15 بكرة».
 *
 * The formula is the per-product rule's — ceil(units / step) × fee, first block
 * charged — applied to the POOL of every unit under the section. The pure
 * engine is pinned first, then the real quote and order routes (parity + the
 * snapshot), then the admin endpoints.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categoryRuleFor, quoteShipping } from '../worker/lib/shipping';
import type { CategoryDeliveryRule, ShippingConfig, ShippingItem } from '../worker/lib/shipping';
import { orderRoutes } from '../worker/routes/orders';
import { adminTaxonomyRoutes } from '../worker/routes/adminTaxonomy';
import { parseCategoryRuleInput } from '../worker/lib/categoryDelivery';
import { pooledFeeIqd } from '../src/components/adminTaxonomy/SectionDeliveryDialog';
import { asD1, freshDb, get, json, pending, post, put, send, stubApp } from './fixtures/app';
import { acceptedPolicies } from './lib/policies';

const cfg = (over: Partial<ShippingConfig> = {}): ShippingConfig => ({
  ordinary_iqd: 5000,
  printer_small_iqd: 25000,
  printer_large_iqd: 50000,
  pro_threshold_iqd: 75000,
  threshold_basis: 'merchandise_after_coupon',
  pro_waiver_covers: 'all',
  prime_threshold_iqd: 150000,
  prime_waiver_covers: 'ordinary_only',
  carton_threshold_spools: null,
  carton_fee_iqd: null,
  printer_advance_required: true,
  protected_iqd: 4000,
  ...over,
});
const asFree = { tier: 'free' as const, tierActive: false };

// FDM filament (main) → PLA, PETG (subs). Paths are nearest-first.
const PLA = ['cat_pla', 'cat_fil'];
const PETG = ['cat_petg', 'cat_fil'];
const spool = (id: string, qty: number, path = PLA, extra: Partial<ShippingItem> = {}): ShippingItem => ({
  product_id: id, qty, size_class: 'ordinary', is_spool: true, category_path: path, ...extra,
});
const keychain = (qty = 1): ShippingItem => ({ product_id: 'key', qty, size_class: 'ordinary', category_path: ['cat_acc'] });
const FIL_STD: CategoryDeliveryRule = { catalog_id: 'cat_fil', method: 'standard', enabled: true, quantity_step: 15, fee_iqd: 5000 };

// ------------------------------------------------------------- pure engine

test('20 spools across 3 filament products/colours are ONE pool: ceil(20/15) = 2 blocks = 10,000', () => {
  const q = quoteShipping({
    items: [spool('pla-black', 8), spool('pla-white', 7), spool('petg-red', 5, PETG)],
    deliveryMethod: 'standard', categoryRules: [FIL_STD], merchandiseIqd: 50000,
    ...asFree, atApprovedDefaultAddress: false, config: cfg(),
  });
  const cats = q.components.filter((c) => c.kind === 'category');
  assert.equal(cats.length, 1);
  assert.equal(cats[0].catalog_id, 'cat_fil');
  assert.equal(cats[0].units, 20);
  assert.equal(cats[0].fee_iqd, 10000);
  assert.equal(cats[0].quantity_step, 15);
  assert.equal(cats[0].fee_per_step_iqd, 5000);
  assert.deepEqual(cats[0].product_ids, ['pla-black', 'pla-white', 'petg-red']);
  assert.equal(q.components.some((c) => c.kind === 'ordinary'), false, 'the pool replaces the flat ordinary fee');
  assert.equal(q.total_iqd, 10000);
});

test('the pool keeps the per-product semantics: 1..15 = 5,000, 16..30 = 10,000, 31 = 15,000', () => {
  for (const [n, fee] of [[1, 5000], [15, 5000], [16, 10000], [30, 10000], [31, 15000]] as const) {
    const q = quoteShipping({
      items: [spool('a', n)], deliveryMethod: 'standard', categoryRules: [FIL_STD], merchandiseIqd: 1,
      ...asFree, atApprovedDefaultAddress: false, config: cfg(),
    });
    assert.equal(q.total_iqd, fee, `${n} spools`);
  }
  assert.equal(pooledFeeIqd(20, 15, 5000), 10000, 'the admin preview uses the same arithmetic');
});

test('mixed categories: the filament pool plus the flat ordinary fee for the rest', () => {
  const q = quoteShipping({
    items: [spool('pla', 20), keychain(3)], deliveryMethod: 'standard', categoryRules: [FIL_STD],
    merchandiseIqd: 50000, ...asFree, atApprovedDefaultAddress: false, config: cfg(),
  });
  assert.deepEqual(q.components.map((c) => [c.kind, c.fee_iqd, c.units]), [['category', 10000, 20], ['ordinary', 5000, 3]]);
  assert.equal(q.total_iqd, 15000);
});

test('the nearest section wins: a PETG rule prices PETG apart from the filament pool', () => {
  const petgRule: CategoryDeliveryRule = { catalog_id: 'cat_petg', method: 'standard', enabled: true, quantity_step: 10, fee_iqd: 3000 };
  assert.equal(categoryRuleFor({ category_path: PETG }, [FIL_STD, petgRule], 'standard'), petgRule);
  assert.equal(categoryRuleFor({ category_path: PLA }, [FIL_STD, petgRule], 'standard'), FIL_STD);
  assert.equal(categoryRuleFor({ category_path: PLA }, [{ ...FIL_STD, enabled: false }], 'standard'), null);
  assert.equal(categoryRuleFor({ category_path: PLA }, [FIL_STD], 'personal'), null, 'a rule is per method');
  const q = quoteShipping({
    items: [spool('pla', 16), spool('petg', 11, PETG)], deliveryMethod: 'standard', categoryRules: [FIL_STD, petgRule],
    merchandiseIqd: 1, ...asFree, atApprovedDefaultAddress: false, config: cfg(),
  });
  assert.deepEqual(q.components.map((c) => [c.catalog_id, c.fee_iqd]), [['cat_fil', 10000], ['cat_petg', 6000]]);
});

test('a product-level quantity rule on a pooled line is NOT also charged', () => {
  const own = { standard: { enabled: true, quantity_step: 1, fee_iqd: 2000 }, personal: { enabled: true, quantity_step: 1, fee_iqd: 9000 } };
  const q = quoteShipping({
    items: [spool('pla-a', 10, PLA, { delivery: own }), spool('pla-b', 10)],
    deliveryMethod: 'standard', categoryRules: [FIL_STD], merchandiseIqd: 1,
    ...asFree, atApprovedDefaultAddress: false, config: cfg(),
  });
  assert.equal(q.components.some((c) => c.kind === 'product'), false);
  assert.equal(q.total_iqd, 10000);
  // Without a category rule the product rule is exactly what it was.
  const legacy = quoteShipping({
    items: [spool('pla-a', 10, PLA, { delivery: own })], deliveryMethod: 'standard', merchandiseIqd: 1,
    ...asFree, atApprovedDefaultAddress: false, config: cfg(),
  });
  assert.equal(legacy.total_iqd, 20000);
});

test('a product that disables the method stays out of the pool and stays unavailable', () => {
  const standardOnly = { standard: { enabled: true, quantity_step: 1, fee_iqd: 2000 }, personal: { enabled: false, quantity_step: 1, fee_iqd: 0 } };
  const q = quoteShipping({
    items: [spool('pla-a', 5, PLA, { delivery: standardOnly }), spool('pla-b', 5)],
    deliveryMethod: 'personal',
    categoryRules: [{ ...FIL_STD, method: 'personal', fee_iqd: 12000 }],
    merchandiseIqd: 1, ...asFree, atApprovedDefaultAddress: false, config: cfg(),
  });
  assert.ok(q.needs_config.includes('product:pla-a:personal_unavailable'));
  assert.deepEqual(q.components.map((c) => [c.kind, c.units, c.fee_iqd]), [['category', 5, 12000]]);
});

test('no rule for the method, or no rules at all, prices exactly as before', () => {
  const items = [spool('pla', 20), keychain()];
  const before = quoteShipping({ items, deliveryMethod: 'standard', merchandiseIqd: 1, ...asFree, atApprovedDefaultAddress: false, config: cfg() });
  const personalOnly = quoteShipping({
    items, deliveryMethod: 'standard', categoryRules: [{ ...FIL_STD, method: 'personal' }],
    merchandiseIqd: 1, ...asFree, atApprovedDefaultAddress: false, config: cfg(),
  });
  assert.equal(before.total_iqd, 5000);
  assert.deepEqual(personalOnly, before);
});

test('pooled spools leave the carton count (no second charge for the same spools)', () => {
  const q = quoteShipping({
    items: [spool('pla', 20)], deliveryMethod: 'standard', categoryRules: [FIL_STD], merchandiseIqd: 1,
    ...asFree, atApprovedDefaultAddress: false, config: cfg({ carton_threshold_spools: 10, carton_fee_iqd: 3000 }),
  });
  assert.equal(q.components.some((c) => c.kind === 'carton'), false);
  assert.equal(q.total_iqd, 10000);
});

test('PRO free delivery waives the pool; a free-delivery threshold not met charges it', () => {
  const items = [spool('pla', 20)];
  const pro = quoteShipping({
    items, deliveryMethod: 'standard', categoryRules: [FIL_STD], merchandiseIqd: 80000,
    tier: 'pro', tierActive: true, atApprovedDefaultAddress: true, config: cfg(),
  });
  assert.equal(pro.total_before_waiver_iqd, 10000);
  assert.equal(pro.total_iqd, 0);
  assert.equal(pro.membership_subsidy_iqd, 10000);
  assert.equal(pro.components[0].waived, true);
  const below = quoteShipping({
    items, deliveryMethod: 'standard', categoryRules: [FIL_STD], merchandiseIqd: 75000,
    tier: 'pro', tierActive: true, atApprovedDefaultAddress: true, config: cfg(),
  });
  assert.equal(below.total_iqd, 10000, '75,000 is not strictly above the threshold');
  const promo = quoteShipping({
    items, deliveryMethod: 'standard', categoryRules: [FIL_STD], merchandiseIqd: 1, independentFreeDelivery: true,
    ...asFree, atApprovedDefaultAddress: false, config: cfg(),
  });
  assert.equal(promo.total_iqd, 0);
});

test('a configured membership rule with a subsidy ceiling caps the pooled fee like any delivery fee', () => {
  const q = quoteShipping({
    items: [spool('pla', 40)], deliveryMethod: 'standard', categoryRules: [FIL_STD], merchandiseIqd: 200000,
    tier: 'pro', tierActive: true, atApprovedDefaultAddress: true, config: cfg(),
    membershipShipping: { rule_id: 'r1', eligible: true, threshold_iqd: 0, basis_iqd: 200000, max_subsidy_iqd: 5000, reason: 'applied' },
  });
  assert.equal(q.total_before_waiver_iqd, 15000);
  assert.equal(q.total_iqd, 10000);
  assert.equal(q.membership_subsidy_capped, true);
});

test('PRIME covers the standard pool only; a personal pool is charged', () => {
  const base = { items: [spool('pla', 20)], merchandiseIqd: 200000, primeMerchandiseIqd: 200000, tier: 'prime' as const, tierActive: true, atApprovedDefaultAddress: false, config: cfg() };
  assert.equal(quoteShipping({ ...base, deliveryMethod: 'standard', categoryRules: [FIL_STD] }).total_iqd, 0);
  assert.equal(
    quoteShipping({ ...base, deliveryMethod: 'personal', categoryRules: [{ ...FIL_STD, method: 'personal', fee_iqd: 8000 }] }).total_iqd,
    16000
  );
});

test('admin input is validated to the migration CHECKs with stable codes', () => {
  assert.deepEqual(parseCategoryRuleInput({ method: 'standard', quantity_step: 15, fee_iqd: 5000 }), { ok: true, method: 'standard', enabled: true, quantity_step: 15, fee_iqd: 5000 });
  assert.equal(parseCategoryRuleInput({ method: 'pickup', quantity_step: 15, fee_iqd: 5000 }).ok, false);
  assert.deepEqual(parseCategoryRuleInput({ method: 'standard', quantity_step: 0, fee_iqd: 5000 }), { ok: false, code: 'CATEGORY_DELIVERY_STEP_INVALID' });
  assert.deepEqual(parseCategoryRuleInput({ method: 'standard', quantity_step: 1.5, fee_iqd: 5000 }), { ok: false, code: 'CATEGORY_DELIVERY_STEP_INVALID' });
  assert.deepEqual(parseCategoryRuleInput({ method: 'personal', quantity_step: 3, fee_iqd: -1 }), { ok: false, code: 'CATEGORY_DELIVERY_FEE_INVALID' });
});

// --------------------------------------------------------- real routes

function setup() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('buyer','Sara','s@x.co','h','customer');
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,is_default) VALUES
      ('addr_b','buyer','Home','Sara','+9647701234567','Baghdad, Karrada 12','',1);
    INSERT INTO catalogs (id, parent_id, slug, name_ar) VALUES
      ('cat_fil', NULL, 't-fdm-filament', 'فلمنت FDM'),
      ('cat_pla', 'cat_fil', 't-pla', 'PLA'),
      ('cat_petg', 'cat_fil', 't-petg', 'PETG'),
      ('cat_acc', NULL, 't-accessories', 'إكسسوارات');
  `);
  const ins = raw.prepare(
    `INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images,category_id,sub_category_id,ops_policy)
     VALUES (?,?,?,?,?,'active',100,'[]','[]','direct_sale','["direct_sale"]','[]','[]',?,?,?)`
  );
  ins.run('p_pla_blk', 't-pla-black', 'PLA Black', 'PLA أسود', 20000, 'cat_fil', 'cat_pla', '{"is_spool":true}');
  ins.run('p_pla_wht', 't-pla-white', 'PLA White', 'PLA أبيض', 20000, 'cat_fil', 'cat_pla', '{"is_spool":true}');
  ins.run('p_petg_red', 't-petg-red', 'PETG Red', 'PETG أحمر', 22000, 'cat_fil', 'cat_petg', '{"is_spool":true}');
  ins.run('p_key', 't-keychain', 'Keychain', 'ميدالية', 3000, 'cat_acc', null, '{}');
  const line = raw.prepare(
    `INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,shipping_method_id,transport_method,warranty_plan_id,qty)
     VALUES (?,?,?,'','[]','','','','',?)`
  );
  line.run('c1', 'buyer', 'p_pla_blk', 8);
  line.run('c2', 'buyer', 'p_pla_wht', 7);
  line.run('c3', 'buyer', 'p_petg_red', 5);
  return { raw, db: asD1(raw) };
}

const ADMIN = { id: 'usr_boss', role: 'admin' as const, email: 'boss@x.co', admin_scope: null };
const BUYER = { id: 'buyer', role: 'customer' as const, email: 's@x.co' };
const quoteBody = (over: Record<string, unknown> = {}) => ({
  addressId: 'addr_b', deliveryMethodId: 'standard', paymentMethodId: 'cash', useWallet: false, usePoints: false, itemIds: [], ...over,
});
let seq = 0;

async function shippingOf(db: D1Database) {
  const shop = stubApp(db, BUYER, (a) => a.route('/api/orders', orderRoutes));
  const res = await json(await post(shop, '/api/orders/quote', quoteBody()));
  assert.equal(res.success, true, JSON.stringify(res));
  return res.quote;
}

test('route: the quote pools the section and the placed order charges and snapshots the same figure', async () => {
  const { raw, db } = setup();
  const admin = stubApp(db, ADMIN, (a) => a.route('/api/admin/taxonomy', adminTaxonomyRoutes));

  // Before any rule: the legacy flat ordinary fee.
  assert.equal((await shippingOf(db)).shipping.total_iqd, 5000);

  const set = await json(await put(admin, '/api/admin/taxonomy/catalogs/cat_fil/delivery-rules/standard', { quantity_step: 15, fee_iqd: 5000 }));
  assert.equal(set.success, true, JSON.stringify(set));

  const quote = await shippingOf(db);
  assert.equal(quote.shipping.total_iqd, 10000, '20 spools over 3 products = 2 blocks');
  const cat = quote.shipping.components.find((c: { kind: string }) => c.kind === 'category');
  assert.equal(cat.catalog_id, 'cat_fil');
  assert.equal(cat.units, 20);
  // Each method card prices its own rules: standard pools, personal (no rule)
  // keeps the flat personal tariff.
  const card = (id: string) => quote.delivery_method_fees.find((m: { id: string }) => m.id === id).fee_iqd;
  assert.equal(card('standard'), 10000);
  assert.equal(card('personal'), 10000, 'the default personal flat fee, untouched');

  const shop = stubApp(db, BUYER, (a) => a.route('/api/orders', orderRoutes));
  const placed = await json(await post(shop, '/api/orders', {
    ...quoteBody(), idempotencyKey: `cat-${Date.now()}-${++seq}`, policyAcceptance: acceptedPolicies(),
  }));
  assert.equal(placed.success, true, JSON.stringify(placed));
  assert.equal(placed.order.shipping_iqd, quote.shipping.total_iqd, 'quote/place parity');
  assert.equal(placed.order.total_iqd, quote.total_iqd, 'quote/place parity on the total');
  const snap = raw.prepare('SELECT delivery_method_snapshot AS s FROM orders WHERE id = ?').get(placed.order.id) as { s: string };
  const frozen = JSON.parse(snap.s).quote.components.find((c: { kind: string }) => c.kind === 'category');
  assert.deepEqual(
    [frozen.catalog_id, frozen.method, frozen.quantity_step, frozen.fee_per_step_iqd, frozen.units, frozen.fee_iqd],
    ['cat_fil', 'standard', 15, 5000, 20, 10000],
    'the order snapshots the rule it was priced with'
  );
  await Promise.allSettled(pending);
});

test('route: a mixed cart adds the flat ordinary fee for the other section; an inactive section’s rule is ignored', async () => {
  const { raw, db } = setup();
  raw.prepare(
    `INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,shipping_method_id,transport_method,warranty_plan_id,qty)
     VALUES ('c4','buyer','p_key','','[]','','','','',2)`
  ).run();
  raw.exec(`INSERT INTO category_delivery_rules (catalog_id, method, quantity_step, fee_per_step_iqd) VALUES ('cat_fil','standard',15,5000)`);
  assert.equal((await shippingOf(db)).shipping.total_iqd, 15000);
  raw.exec(`UPDATE catalogs SET active = 0 WHERE id = 'cat_fil'`);
  assert.equal((await shippingOf(db)).shipping.total_iqd, 5000);
});

test('admin: GET lists the rule on its section, PUT refuses bad input with codes, DELETE removes it', async () => {
  const { db } = setup();
  const admin = stubApp(db, ADMIN, (a) => a.route('/api/admin/taxonomy', adminTaxonomyRoutes));
  const bad = await put(admin, '/api/admin/taxonomy/catalogs/cat_fil/delivery-rules/standard', { quantity_step: 0, fee_iqd: 5000 });
  assert.equal(bad.status, 400);
  assert.equal((await json(bad)).code, 'CATEGORY_DELIVERY_STEP_INVALID');
  const badMethod = await json(await put(admin, '/api/admin/taxonomy/catalogs/cat_fil/delivery-rules/pickup', { quantity_step: 1, fee_iqd: 1 }));
  assert.equal(badMethod.code, 'CATEGORY_DELIVERY_METHOD_INVALID');
  assert.equal((await put(admin, '/api/admin/taxonomy/catalogs/nope/delivery-rules/standard', { quantity_step: 15, fee_iqd: 5000 })).status, 404);

  await put(admin, '/api/admin/taxonomy/catalogs/cat_fil/delivery-rules/standard', { quantity_step: 15, fee_iqd: 5000 });
  await put(admin, '/api/admin/taxonomy/catalogs/cat_fil/delivery-rules/standard', { quantity_step: 10, fee_iqd: 4000 });
  const list = await json(await get(admin, '/api/admin/taxonomy/catalogs'));
  const fil = list.catalogs.find((c: { id: string }) => c.id === 'cat_fil');
  assert.deepEqual(fil.delivery_rules, [{ method: 'standard', enabled: true, quantity_step: 10, fee_iqd: 4000 }], 'upsert, one row per method');
  assert.deepEqual(list.catalogs.find((c: { id: string }) => c.id === 'cat_pla').delivery_rules, []);

  const del = await json(await send(admin, 'DELETE', '/api/admin/taxonomy/catalogs/cat_fil/delivery-rules/standard'));
  assert.equal(del.removed, true);
  const after = await json(await get(admin, '/api/admin/taxonomy/catalogs'));
  assert.deepEqual(after.catalogs.find((c: { id: string }) => c.id === 'cat_fil').delivery_rules, []);

  const customer = stubApp(db, BUYER, (a) => a.route('/api/admin/taxonomy', adminTaxonomyRoutes));
  assert.equal((await put(customer, '/api/admin/taxonomy/catalogs/cat_fil/delivery-rules/standard', { quantity_step: 15, fee_iqd: 5000 })).status, 403);
});
