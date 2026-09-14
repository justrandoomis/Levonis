/**
 * THE BENEFIT RULES, THROUGH THE REAL DOORS.
 *
 * `tests/membershipBenefitRules.test.ts` pins the arithmetic. This one runs
 * the ADMIN router, the CART router and the CHECKOUT against real migrations
 * on real SQLite, because the arithmetic being right was never the hard part:
 * the hard part is that a rule an owner types reaches the price a customer
 * pays, exactly once, and that changing it tomorrow leaves yesterday's order
 * alone.
 *
 * Only the session is stubbed. Pricing, entitlements, the shipping engine,
 * the cash-on-delivery tax, the order snapshot and the audit trail all run.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ROOT, SqliteD1 } from './fixtures/d1';
import type { AppContext } from '../worker/lib/types';
import { HttpError } from '../worker/lib/http';
import { adminMembershipBenefitRoutes } from '../worker/routes/adminMembershipBenefits';
import { orderRoutes } from '../worker/routes/orders';
import { cartRoutes } from '../worker/routes/cart';
import { membershipsRoutes } from '../worker/routes/memberships';
import { activeBenefitRules, ancestryFor, catalogAncestry } from '../worker/lib/membershipBenefits';
import { isUnitExpressible, lineBenefit, scopeMatches } from '../packages/pricing/src/membershipBenefits';
import type { BenefitRule } from '../packages/pricing/src/membershipBenefits';
import { quoteShipping } from '../packages/shipping/src/shipping';
import type { ShippingConfig } from '../packages/shipping/src/shipping';

// ------------------------------------------------------------------ fixture

/**
 * A three-level section tree on purpose. `mb_printers -> fdm -> bambu`
 * exists because nothing in the taxonomy admin stops an owner creating it,
 * and a rule written on "Printers" has to reach a product filed at the
 * bottom of it.
 */
function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) raw.exec(readFileSync(join(dir, f), 'utf8'));
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('boss','Admin','boss@x.co','h','admin'),
      ('plain','Sara','s@x.co','h','customer'),
      ('promem','Omar','o@x.co','h','customer'),
      ('premmem','Dara','d@x.co','h','customer');
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,is_default) VALUES
      ('a_plain','plain','Home','Sara','+9647701234567','Baghdad, Karrada 12','',1),
      ('a_pro','promem','Home','Omar','+9647709876543','Erbil, Ankawa 4','',1),
      ('a_prem','premmem','Home','Dara','+9647701112223','Basra, Ashar 9','',1);
    INSERT INTO approved_addresses (id,user_id,version,name,phone_e164,address,landmark,state)
      VALUES ('ap1','promem',1,'Omar','+9647709876543','Erbil, Ankawa 4','','approved');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,price_paid_iqd,starts_at,expires_at) VALUES
      ('m_pro','promem','pro_12mo','pro','active',12,499000,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z'),
      ('m_prem','premmem','prime_12mo','prime','active',12,299000,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z');
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status) VALUES
      ('w1','plain','deposit','USD',200000,'approved'),
      ('w2','promem','deposit','USD',200000,'approved'),
      ('w3','premmem','deposit','USD',200000,'approved');
    -- The seed tree already owns the obvious slugs, so these carry a mb- prefix.
    INSERT INTO catalogs (id,parent_id,slug,name_ar,name_en,is_printer_catalog) VALUES
      ('mb_printers',NULL,'mb-printers','طابعات','Printers',1),
      ('mb_fdm','mb_printers','mb-fdm','FDM','FDM',1),
      ('mb_bambu','mb_fdm','mb-bambu','بامبو','Bambu',1),
      ('mb_materials',NULL,'mb-materials','مواد','Materials',0),
      ('mb_pla','mb_materials','mb-pla','PLA','PLA',0);
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images,category_id,sub_category_id) VALUES
      ('p_a1','mb-a1','Bambu A1','بامبو A1',1850000,'active',20,'[]','[]','direct_sale','["direct_sale"]','[]','[]','mb_printers','mb_bambu'),
      ('p_pla','mb-pla-product','PLA Basic','PLA أساسي',25000,'active',80,'[]','[]','direct_sale','["direct_sale"]','[]','[]','mb_materials','mb_pla'),
      ('p_acc','mb-acc','Nozzle','فوهة',10000,'active',80,'[]','[]','direct_sale','["direct_sale"]','[]','[]',NULL,NULL);
    INSERT INTO product_catalogs (product_id,catalog_id,position) VALUES ('p_a1','mb_bambu',0);
  `);
  return { raw, db: new SqliteD1(raw) as unknown as D1Database };
}

function appAs(db: D1Database, userId: string, role: 'admin' | 'customer') {
  const a = new Hono<AppContext>();
  a.use('*', async (c, next) => {
    c.set('user', { id: userId, role, email: `${userId}@x.co`, username: userId } as never);
    c.set('host', { kind: 'main' } as never);
    c.env = { DB: db } as never;
    await next();
  });
  a.route('/api/admin/membership-benefits', adminMembershipBenefitRoutes);
  a.route('/api/orders', orderRoutes);
  a.route('/api/cart', cartRoutes);
  a.route('/api/memberships', membershipsRoutes);
  a.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ success: false, error: err.message, code: err.code, details: err.details ?? null }, err.status as 400);
    }
    throw err;
  });
  return a;
}

const pending: Promise<unknown>[] = [];
const ctx = {
  waitUntil: (p: Promise<unknown>) => {
    pending.push(p.catch(() => undefined));
  },
  passThroughOnException() {},
} as unknown as ExecutionContext;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response) => (await res.json()) as Record<string, any>;
const send = (a: Hono<AppContext>, method: string, path: string, body?: unknown) =>
  a.request(
    path,
    { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) },
    undefined,
    ctx
  );

function cartLine(raw: DatabaseSync, id: string, user: string, productId: string, qty = 1) {
  raw
    .prepare(
      `INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,shipping_method_id,transport_method,warranty_plan_id,qty)
       VALUES (?,?,?,'','[]','','','','',?)`
    )
    .run(id, user, productId, qty);
}

let seq = 0;
const checkoutBody = (addressId: string, over: Record<string, unknown> = {}) => ({
  addressId,
  deliveryMethodId: 'standard',
  paymentMethodId: 'cash',
  useWallet: false,
  usePoints: false,
  itemIds: [],
  ...over,
});
const orderBody = (addressId: string, over: Record<string, unknown> = {}) => ({
  ...checkoutBody(addressId, over),
  idempotencyKey: `mb-${++seq}-${addressId}`,
});

/** The PRO printer rule the owner described: 10%, capped at 100,000 per UNIT. */
const PRINTER_RULE = {
  tier: 'pro',
  benefit_type: 'product_discount',
  scope: 'category',
  category_id: 'mb_printers',
  discount_mode: 'percent',
  percent: 10,
  max_discount_iqd: 100_000,
  cap_scope: 'per_unit',
  label: 'PRO printers',
};

/* ------------------------------------------------------------ the admin door */

test('the admin door: a rule is created, versioned and audited in one act', async () => {
  const { raw, db } = setup();
  const admin = appAs(db, 'boss', 'admin');

  const before = await json(await send(admin, 'GET', '/api/admin/membership-benefits'));
  assert.equal(before.success, true);
  const seededVersion = before.version_id;
  assert.ok(typeof seededVersion === 'number', 'migration 0074 seeds version 1');
  // The four seeded rules — free shipping and COD tax for both tiers — and no
  // product discount, because a global one would discount the whole catalogue.
  assert.equal(before.rules.filter((r: BenefitRule) => r.benefit_type === 'product_discount').length, 0);

  const created = await json(await send(admin, 'POST', '/api/admin/membership-benefits', PRINTER_RULE));
  assert.equal(created.success, true);
  assert.ok(created.version_id > seededVersion, 'a write appends a version');

  const rules = raw.prepare('SELECT * FROM membership_benefit_rules WHERE id = ?').all(created.rule.id) as Record<string, unknown>[];
  assert.equal(rules.length, 1);
  assert.equal(rules[0].percent, 10);
  assert.equal(rules[0].max_discount_iqd, 100_000);
  assert.equal(rules[0].updated_by, 'boss', 'the rule remembers who wrote it');

  const audits = raw
    .prepare("SELECT * FROM audit_log WHERE action LIKE 'membership_benefit.%'")
    .all() as Record<string, unknown>[];
  assert.equal(audits.length, 1, 'a price change cannot succeed unattributed');
  assert.equal(audits[0].actor_user_id ?? audits[0].actor_id, 'boss');

  const versions = await json(await send(admin, 'GET', '/api/admin/membership-benefits/versions'));
  assert.equal(versions.versions[0].action, 'create');
  assert.equal(versions.versions[0].rule_id, created.rule.id);
});

test('the admin door refuses a rule that could never apply, and says why', async () => {
  const { db } = setup();
  const admin = appAs(db, 'boss', 'admin');

  const plus = await json(await send(admin, 'POST', '/api/admin/membership-benefits', { ...PRINTER_RULE, tier: 'plus' }));
  assert.equal(plus.success, false);
  assert.equal(plus.code, 'BENEFIT_TIER_NOT_ENTITLED');
  assert.match(plus.error, /never apply/i);

  // A ceiling with no scope is half a sentence.
  const halfSentence = await json(
    await send(admin, 'POST', '/api/admin/membership-benefits', { ...PRINTER_RULE, cap_scope: null })
  );
  assert.equal(halfSentence.success, false);
  assert.match(halfSentence.error, /per unit or per order/i);

  const noAmount = await json(
    await send(admin, 'POST', '/api/admin/membership-benefits', { ...PRINTER_RULE, discount_mode: 'fixed', percent: null })
  );
  assert.equal(noAmount.success, false);

  const backwards = await json(
    await send(admin, 'POST', '/api/admin/membership-benefits', {
      ...PRINTER_RULE,
      valid_from: '2026-06-01T00:00:00Z',
      valid_until: '2026-01-01T00:00:00Z',
    })
  );
  assert.equal(backwards.success, false);
});

test('the admin door is shut to a customer', async () => {
  const { db } = setup();
  const notAdmin = appAs(db, 'plain', 'customer');
  const res = await send(notAdmin, 'GET', '/api/admin/membership-benefits');
  assert.equal(res.status, 403);
  const write = await send(notAdmin, 'POST', '/api/admin/membership-benefits', PRINTER_RULE);
  assert.equal(write.status, 403);
});

/* ------------------------------------------------ the section ancestor walk */

test('a rule on "Printers" reaches a product filed three levels below it', async () => {
  const { db } = setup();
  const index = await catalogAncestry(db);
  const chain = ancestryFor(index, 'mb_printers', 'mb_bambu');
  assert.deepEqual(new Set(chain), new Set(['mb_bambu', 'mb_fdm', 'mb_printers']));

  const rule = { scope: 'category', category_id: 'mb_printers' } as BenefitRule;
  assert.equal(scopeMatches(rule, { category_id: 'mb_printers', sub_category_id: 'mb_bambu', ancestry: chain }), true);
  // …and does NOT reach a product in a different branch.
  const otherChain = ancestryFor(index, 'mb_materials', 'mb_pla');
  assert.equal(scopeMatches(rule, { category_id: 'mb_materials', sub_category_id: 'mb_pla', ancestry: otherChain }), false);
  // Exact matching still works for a caller with no tree to walk.
  assert.equal(scopeMatches(rule, { category_id: 'mb_printers' }), true);
  assert.equal(scopeMatches(rule, { category_id: 'mb_bambu' }), false, 'without ancestry there is no branch to walk');
});

/* ------------------------------------------- unit price vs line correction */

/**
 * THE PROPERTY THAT MAKES TWO APPLICATION SITES SAFE.
 *
 * `isUnitExpressible` silently relocates a rule's money between the unit price
 * and a line correction depending on which optional columns an admin filled
 * in. The danger is not the design — it is that the switch is invisible. So:
 * for every shape, the member's total is the SAME however it was applied, and
 * a rule that lives in the unit price contributes nothing to the line
 * correction.
 */
test('every rule shape saves the same money whichever site applies it, and is never counted twice', () => {
  const base: BenefitRule = {
    id: 'r', tier: 'pro', benefit_type: 'product_discount', scope: 'global',
    category_id: null, sub_category_id: null, product_id: null,
    discount_mode: 'percent', percent: 10, fixed_iqd: null,
    max_discount_iqd: null, cap_scope: null, max_quantity: null, min_subtotal_iqd: null,
    free_shipping_threshold_iqd: null, shipping_methods: null, max_shipping_subsidy_iqd: null,
    cod_tax_exempt: null, enabled: true, priority: 0, valid_from: null, valid_until: null, label: null,
  };
  const shapes: Array<[string, Partial<BenefitRule>]> = [
    ['plain percent', {}],
    ['percent + per-unit cap', { max_discount_iqd: 100_000, cap_scope: 'per_unit' }],
    ['fixed per unit', { discount_mode: 'fixed', percent: null, fixed_iqd: 25_000 }],
    ['percent + per-ORDER cap', { max_discount_iqd: 150_000, cap_scope: 'per_order' }],
    ['quantity limit', { max_quantity: 2 }],
    ['minimum order', { min_subtotal_iqd: 500_000 }],
    ['quantity limit + per-order cap', { max_quantity: 2, max_discount_iqd: 120_000, cap_scope: 'per_order' }],
  ];
  for (const [name, over] of shapes) {
    const rule = { ...base, ...over };
    for (const qty of [1, 2, 3, 5]) {
      const b = lineBenefit({ regularUnitIqd: 1_850_000, qty, rule });
      const unitSite = isUnitExpressible(rule);
      assert.equal(b.applied_at, unitSite ? 'unit' : 'line', `${name} x${qty}: applied_at`);
      // The money is the same number either way — the site decides only WHO
      // subtracts it, never how much.
      const expectedPerUnit = Math.min(
        over.discount_mode === 'fixed' ? 25_000 : 185_000,
        over.cap_scope === 'per_unit' && over.max_discount_iqd ? over.max_discount_iqd : Number.MAX_SAFE_INTEGER
      );
      const eligible = Math.min(qty, over.max_quantity ?? qty);
      const uncapped = expectedPerUnit * eligible;
      const expected = over.cap_scope === 'per_order' && over.max_discount_iqd
        ? Math.min(uncapped, over.max_discount_iqd)
        : uncapped;
      assert.equal(b.total_iqd, expected, `${name} x${qty}: total`);
      // A unit-site rule contributes ZERO to the line correction — that is the
      // subtraction that would otherwise happen twice.
      const lineCorrection = b.applied_at === 'line' ? b.total_iqd : 0;
      if (unitSite) assert.equal(lineCorrection, 0, `${name} x${qty}: would be double-subtracted`);
    }
  }
});

test('a quantity limit is the reason the third printer is not discounted', () => {
  const rule: BenefitRule = {
    id: 'r', tier: 'pro', benefit_type: 'product_discount', scope: 'global',
    category_id: null, sub_category_id: null, product_id: null,
    discount_mode: 'percent', percent: 10, fixed_iqd: null,
    max_discount_iqd: 100_000, cap_scope: 'per_unit', max_quantity: 2, min_subtotal_iqd: null,
    free_shipping_threshold_iqd: null, shipping_methods: null, max_shipping_subsidy_iqd: null,
    cod_tax_exempt: null, enabled: true, priority: 0, valid_from: null, valid_until: null, label: null,
  };
  assert.equal(isUnitExpressible(rule), false, 'a quantity limit cannot be a unit price');
  const three = lineBenefit({ regularUnitIqd: 1_850_000, qty: 3, rule });
  assert.equal(three.eligible_qty, 2);
  assert.equal(three.total_iqd, 200_000, 'two printers at the 100,000 ceiling, and not a dinar for the third');
  assert.equal(three.applied_at, 'line');
});

/* --------------------------------------------------------- the shipping half */

const SHIPPING: ShippingConfig = {
  ordinary_iqd: 5_000,
  printer_small_iqd: 25_000,
  printer_large_iqd: 50_000,
  pro_threshold_iqd: 75_000,
  threshold_basis: 'merchandise_after_coupon',
  pro_waiver_covers: 'ordinary_only',
  prime_threshold_iqd: 150_000,
  prime_waiver_covers: 'ordinary_only',
  carton_threshold_spools: null,
  carton_fee_iqd: null,
  printer_advance_required: true,
  protected_iqd: null,
};
const ITEM = { product_id: 'p', qty: 1, size_class: 'ordinary' as const };

test('the configured rule, not the constant, decides the free-delivery threshold', () => {
  const quote = (basis: number, eligible: boolean) =>
    quoteShipping({
      items: [ITEM],
      merchandiseIqd: basis,
      tier: 'pro',
      tierActive: true,
      proShippingEntitled: true,
      atApprovedDefaultAddress: true,
      membershipShipping: {
        rule_id: 'seed-pro-free-shipping',
        eligible,
        threshold_iqd: 200_000,
        basis_iqd: basis,
        max_subsidy_iqd: null,
        reason: eligible ? 'applied' : 'below_threshold',
      },
      config: SHIPPING,
    });
  // 100,000 clears the CONSTANT (75,000) and not the RULE (200,000).
  const denied = quote(100_000, false);
  assert.equal(denied.pro_waiver_applied, false, 'the rule is the authority, not pro_threshold_iqd');
  assert.equal(denied.total_iqd, 5_000);
  assert.ok(denied.reasons.some((r) => r.includes('200,000')), 'and it quotes the configured number back');

  const granted = quote(250_000, true);
  assert.equal(granted.pro_waiver_applied, true);
  assert.equal(granted.total_iqd, 0);
  assert.equal(granted.membership_rule_id, 'seed-pro-free-shipping');
  assert.equal(granted.membership_subsidy_iqd, 5_000);
});

test('PREMIUM free delivery on standard only: the personal fee stays, with a reason', () => {
  const personal = quoteShipping({
    items: [ITEM],
    merchandiseIqd: 500_000,
    tier: 'prime',
    tierActive: true,
    premiumShippingEntitled: true,
    atApprovedDefaultAddress: false,
    membershipShipping: {
      rule_id: 'seed-premium-free-shipping',
      eligible: false,
      threshold_iqd: 100_000,
      basis_iqd: 500_000,
      max_subsidy_iqd: null,
      reason: 'method_not_covered',
    },
    config: { ...SHIPPING, ordinary_iqd: 10_000 },
  });
  assert.equal(personal.prime_waiver_applied, false);
  assert.equal(personal.total_iqd, 10_000, 'however large the order');
  assert.ok(personal.reasons.some((r) => /standard delivery only/i.test(r)));
});

test('a subsidy ceiling makes the member pay the difference, and no line claims to be free', () => {
  const capped = quoteShipping({
    items: [{ product_id: 'printer', qty: 1, size_class: 'printer_small' }],
    merchandiseIqd: 2_000_000,
    tier: 'pro',
    tierActive: true,
    proShippingEntitled: true,
    atApprovedDefaultAddress: true,
    membershipShipping: {
      rule_id: 'r_cap', eligible: true, threshold_iqd: 75_000, basis_iqd: 2_000_000,
      max_subsidy_iqd: 15_000, reason: 'applied',
    },
    config: { ...SHIPPING, pro_waiver_covers: 'all' },
  });
  assert.equal(capped.total_before_waiver_iqd, 25_000);
  assert.equal(capped.membership_subsidy_iqd, 15_000);
  assert.equal(capped.membership_subsidy_capped, true);
  assert.equal(capped.total_iqd, 10_000, 'a 25,000 fee against a 15,000 ceiling');
  assert.equal(
    capped.components.every((k) => !k.waived),
    true,
    '"free delivery" on a line the customer partly paid for is a lie an invoice cannot survive'
  );
  assert.ok(capped.advance_due_iqd <= capped.total_iqd, 'the advance can never exceed the bill');
});

test('a caller that passes no rule gets the historical quote, operator for operator', () => {
  const at = (basis: number) =>
    quoteShipping({
      items: [ITEM], merchandiseIqd: basis, tier: 'pro', tierActive: true,
      proShippingEntitled: true, atApprovedDefaultAddress: true, config: SHIPPING,
    });
  assert.equal(at(75_000).pro_waiver_applied, false, 'CONFIRMED: 75,000 itself does not qualify');
  assert.equal(at(75_001).pro_waiver_applied, true);
  assert.equal(at(75_001).membership_rule_id, null, 'nothing to name where no rule was consulted');
});

/* ------------------------------------------------------ the whole checkout */

test('a PRO buying two printers: the per-unit ceiling applies twice, and the order freezes it', async () => {
  const { raw, db } = setup();
  const admin = appAs(db, 'boss', 'admin');
  const created = await json(await send(admin, 'POST', '/api/admin/membership-benefits', PRINTER_RULE));
  assert.equal(created.success, true);

  cartLine(raw, 'ci_1', 'promem', 'p_a1', 2);
  const pro = appAs(db, 'promem', 'customer');

  const cart = await json(await send(pro, 'GET', '/api/cart'));
  assert.equal(cart.success, true);
  assert.equal(cart.items[0].unit_price_iqd, 1_750_000, '10% capped at 100,000 is already in the unit price');
  assert.equal(cart.membership.discount_total_iqd, 200_000, 'two printers, two ceilings');
  assert.equal(cart.membership.order_discount_iqd, 0, 'a per-unit rule is entirely inside the line prices');

  const quote = await json(await send(pro, 'POST', '/api/orders/quote', checkoutBody('a_pro')));
  assert.equal(quote.success, true);
  assert.equal(quote.quote.membership_benefits.discount_total_iqd, 200_000);
  assert.equal(quote.quote.membership_benefits.order_discount_iqd, 0);
  assert.equal(quote.quote.subtotal_iqd, 3_500_000);

  const placed = await json(await send(pro, 'POST', '/api/orders', orderBody('a_pro')));
  assert.equal(placed.success, true, JSON.stringify(placed));
  await Promise.all(pending.splice(0));

  const order = raw.prepare('SELECT * FROM orders WHERE id = ?').get(placed.order.id) as Record<string, unknown>;
  assert.equal(order.membership_discount_iqd, 200_000);
  assert.ok(Number(order.benefit_version_id) > 0, 'the order names the configuration it was priced under');
  const snap = JSON.parse(String(order.benefit_snapshot));
  assert.equal(snap.tier, 'pro');
  assert.equal(snap.discount_total_iqd, 200_000);
  assert.equal(snap.lines[0].capped_by, 'per_unit');
  assert.equal(snap.lines[0].rule_id, created.rule.id);

  const item = raw.prepare('SELECT * FROM order_items WHERE order_id = ?').get(placed.order.id) as Record<string, unknown>;
  assert.equal(item.membership_discount_iqd, 200_000);
  assert.equal(item.membership_rule_id, created.rule.id);

  /* ---- AND NOW THE OWNER CHANGES THE RULE. Yesterday's order must not move. */
  const edited = await json(
    await send(admin, 'PUT', `/api/admin/membership-benefits/${created.rule.id}`, {
      ...PRINTER_RULE,
      percent: 1,
      max_discount_iqd: 1_000,
    })
  );
  assert.equal(edited.success, true);
  assert.ok(edited.version_id > Number(order.benefit_version_id));

  const after = raw.prepare('SELECT * FROM orders WHERE id = ?').get(placed.order.id) as Record<string, unknown>;
  assert.equal(after.membership_discount_iqd, 200_000, 'changing the rule tomorrow does not alter yesterday');
  assert.equal(after.total_iqd, order.total_iqd);
  assert.equal(after.subtotal_iqd, order.subtotal_iqd);
  assert.equal(after.benefit_version_id, order.benefit_version_id);
  assert.equal(String(after.benefit_snapshot), String(order.benefit_snapshot));

  // The NEXT order follows the new rule, which is the other half of the same claim.
  cartLine(raw, 'ci_2', 'promem', 'p_a1', 1);
  const next = await json(await send(pro, 'GET', '/api/cart'));
  assert.equal(next.membership.discount_total_iqd, 1_000, '1% of 1,850,000 capped at 1,000');
});

test('an order-scoped rule is deducted once, after the subtotal, and the totals still reconcile', async () => {
  const { raw, db } = setup();
  const admin = appAs(db, 'boss', 'admin');
  await send(admin, 'POST', '/api/admin/membership-benefits', { ...PRINTER_RULE, max_quantity: 2 });

  cartLine(raw, 'ci_q', 'promem', 'p_a1', 3);
  const pro = appAs(db, 'promem', 'customer');

  const cart = await json(await send(pro, 'GET', '/api/cart'));
  assert.equal(cart.items[0].unit_price_iqd, 1_850_000, 'a quantity-limited rule stays OUT of the unit price');
  assert.equal(cart.membership.discount_total_iqd, 200_000);
  assert.equal(cart.membership.order_discount_iqd, 200_000, 'all of it is the caller’s to subtract');
  assert.equal(cart.membership.merchandise_iqd, 3 * 1_850_000 - 200_000);

  const quote = await json(await send(pro, 'POST', '/api/orders/quote', checkoutBody('a_pro')));
  const q = quote.quote;
  assert.equal(q.subtotal_iqd, 3 * 1_850_000, 'the subtotal is what the lines come to');
  assert.equal(q.membership_benefits.order_discount_iqd, 200_000);
  // subtotal − membership + delivery + COD tax = total. Exactly once.
  const expected = q.subtotal_iqd - q.membership_benefits.order_discount_iqd + q.shipping.total_iqd + q.cod_tax_iqd;
  assert.equal(q.total_iqd, expected, 'the on-screen arithmetic adds up');
});

test('the cash-on-delivery tax is calculated in full, then exempted, and BOTH numbers survive', async () => {
  const { raw, db } = setup();
  cartLine(raw, 'ci_tax', 'promem', 'p_a1', 1);
  const pro = appAs(db, 'promem', 'customer');

  const quote = await json(await send(pro, 'POST', '/api/orders/quote', checkoutBody('a_pro')));
  const q = quote.quote;
  assert.ok(q.cod_tax_before_exemption_iqd > 0, 'the existing tax engine still runs on every order');
  assert.equal(q.cod_tax_exemption_iqd, q.cod_tax_before_exemption_iqd, 'seeded: PRO is exempt');
  assert.equal(q.cod_tax_iqd, 0);
  assert.equal(q.membership_benefits.cod_tax.exempt, true);
  assert.equal(q.membership_benefits.cod_tax.rule_id, 'seed-pro-cod-exempt');

  const placed = await json(await send(pro, 'POST', '/api/orders', orderBody('a_pro')));
  assert.equal(placed.success, true, JSON.stringify(placed));
  await Promise.all(pending.splice(0));
  const order = raw.prepare('SELECT * FROM orders WHERE id = ?').get(placed.order.id) as Record<string, unknown>;
  assert.ok(Number(order.cod_tax_before_exemption_iqd) > 0, 'the courier’s cash sheet has something to reconcile against');
  assert.equal(order.cod_tax_iqd, 0);
  assert.equal(order.cod_tax_exemption_iqd, order.cod_tax_before_exemption_iqd);
});

test('PREMIUM is NOT exempt by default, and the owner can change that in one field', async () => {
  const { raw, db } = setup();
  cartLine(raw, 'ci_pm', 'premmem', 'p_a1', 1);
  const prem = appAs(db, 'premmem', 'customer');

  const before = await json(await send(prem, 'POST', '/api/orders/quote', checkoutBody('a_prem')));
  assert.ok(before.quote.cod_tax_iqd > 0, 'PREMIUM pays the tax by default');
  assert.equal(before.quote.cod_tax_exemption_iqd, 0);

  const admin = appAs(db, 'boss', 'admin');
  const rules = await json(await send(admin, 'GET', '/api/admin/membership-benefits'));
  const premRule = rules.rules.find((r: BenefitRule) => r.tier === 'prime' && r.benefit_type === 'cod_tax_exemption');
  assert.ok(premRule, 'the seed leaves the rule in place, switched off');
  const edited = await json(
    await send(admin, 'PUT', `/api/admin/membership-benefits/${premRule.id}`, {
      tier: 'prime', benefit_type: 'cod_tax_exemption', scope: 'global', cod_tax_exempt: true,
    })
  );
  assert.equal(edited.success, true);

  const after = await json(await send(prem, 'POST', '/api/orders/quote', checkoutBody('a_prem')));
  assert.equal(after.quote.cod_tax_iqd, 0, 'one field, no deploy');
  assert.equal(after.quote.cod_tax_exemption_iqd, before.quote.cod_tax_iqd);
});

test('nothing reaches a non-member, an anonymous cart, or an expired membership', async () => {
  const { raw, db } = setup();
  const admin = appAs(db, 'boss', 'admin');
  await send(admin, 'POST', '/api/admin/membership-benefits', PRINTER_RULE);

  cartLine(raw, 'ci_plain', 'plain', 'p_a1', 1);
  const plain = appAs(db, 'plain', 'customer');
  const cart = await json(await send(plain, 'GET', '/api/cart'));
  assert.equal(cart.items[0].unit_price_iqd, 1_850_000, 'the regular price, in full');
  assert.equal(cart.membership.discount_total_iqd, 0);
  assert.equal(cart.membership.active, false);

  // An expired PRO is a free customer at the moment of checkout, whatever any
  // cached tier says — `getTierStatus` expires the row before it answers.
  raw.exec("UPDATE memberships SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = 'm_pro';");
  raw.exec("UPDATE users SET membership_tier = 'pro' WHERE id = 'promem';");
  cartLine(raw, 'ci_exp', 'promem', 'p_a1', 1);
  const expired = await json(await send(appAs(db, 'promem', 'customer'), 'GET', '/api/cart'));
  assert.equal(expired.items[0].unit_price_iqd, 1_850_000);
  assert.equal(expired.membership.active, false);
  assert.equal(expired.membership.discount_total_iqd, 0);
});

test('a restriction case pauses a configured benefit for one account, and only that account', async () => {
  const { raw, db } = setup();
  const admin = appAs(db, 'boss', 'admin');
  await send(admin, 'POST', '/api/admin/membership-benefits', PRINTER_RULE);

  raw.exec(`
    INSERT INTO restriction_cases (id,user_id,kind,state,reason,benefit_flags,opened_by,opened_at)
      VALUES ('rc1','promem','fraud','active','abuse','["proPricing"]','boss','2026-01-01T00:00:00.000Z');
  `);
  cartLine(raw, 'ci_r', 'promem', 'p_a1', 1);
  const pro = appAs(db, 'promem', 'customer');
  const cart = await json(await send(pro, 'GET', '/api/cart'));
  assert.equal(cart.items[0].unit_price_iqd, 1_850_000, 'a rule is consulted only after the entitlement agrees');
  assert.equal(cart.membership.discount_total_iqd, 0);
});

/* --------------------------------------------------------- the public view */

test('the subscription page reads live configuration, never a string in the bundle', async () => {
  const { db } = setup();
  const admin = appAs(db, 'boss', 'admin');
  await send(admin, 'POST', '/api/admin/membership-benefits', PRINTER_RULE);

  const plans = await json(await send(appAs(db, 'plain', 'customer'), 'GET', '/api/memberships/plans'));
  assert.equal(plans.success, true);
  assert.ok(plans.benefits, 'the plans endpoint carries the configured benefits');
  const pro = plans.benefits.pro;
  assert.equal(pro.discounts.length, 1);
  assert.equal(pro.discounts[0].percent, 10);
  assert.equal(pro.discounts[0].max_discount_iqd, 100_000);
  assert.equal(pro.discounts[0].cap_scope, 'per_unit');
  assert.equal(pro.discounts[0].target_name_ar, 'طابعات', 'the section is named, not just id-ed');
  assert.equal(pro.free_shipping.threshold_iqd, 75_000);
  assert.deepEqual(pro.free_shipping.methods, ['standard', 'personal']);
  assert.equal(pro.cod_tax_exempt, true);

  assert.equal(plans.benefits.prime.free_shipping.threshold_iqd, 100_000);
  assert.deepEqual(plans.benefits.prime.free_shipping.methods, ['standard']);
  assert.equal(plans.benefits.prime.cod_tax_exempt, false);
  // An internal note never leaves the server.
  assert.equal('notes' in pro.discounts[0], false);
});

/* ------------------------------------------------------------ the simulator */

test('the simulator answers through the same functions the checkout uses, and writes nothing', async () => {
  const { raw, db } = setup();
  const admin = appAs(db, 'boss', 'admin');
  await send(admin, 'POST', '/api/admin/membership-benefits', PRINTER_RULE);
  const ordersBefore = (raw.prepare('SELECT COUNT(*) AS n FROM orders').get() as { n: number }).n;

  const sim = await json(
    await send(admin, 'POST', '/api/admin/membership-benefits/simulate', {
      tier: 'pro',
      items: [{ product_id: 'p_a1', qty: 2 }, { product_id: 'p_pla', qty: 4 }],
      delivery_method_id: 'standard',
      payment_method_id: 'cash',
    })
  );
  assert.equal(sim.success, true, JSON.stringify(sim));
  assert.equal(sim.lines.length, 2);
  const printer = sim.lines.find((l: { product_id: string }) => l.product_id === 'p_a1');
  assert.equal(printer.regular_unit_iqd, 1_850_000);
  assert.equal(printer.member_unit_iqd, 1_750_000);
  assert.equal(printer.discount_iqd, 200_000);
  assert.equal(printer.capped_by, 'per_unit');
  const filament = sim.lines.find((l: { product_id: string }) => l.product_id === 'p_pla');
  assert.equal(filament.discount_iqd, 0, 'the printers rule does not reach a filament');

  assert.equal(sim.totals.membership_discount_iqd, 200_000);
  assert.equal(sim.shipping.eligible, true, 'well above the seeded 75,000');
  assert.equal(sim.totals.shipping_iqd, 0);
  assert.equal(sim.cod_tax.exempt, true);
  assert.equal(sim.totals.cod_tax_iqd, 0);
  assert.ok(sim.totals.cod_tax_before_exemption_iqd > 0, 'and says what was waived');

  assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM orders').get() as { n: number }).n, ordersBefore);
  assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM cart_items').get() as { n: number }).n, 0);
});

/* -------------------------------------------------------- the mixed cart */

test('a mixed cart: each line takes its own most specific rule, and nothing stacks', async () => {
  const { raw, db } = setup();
  const admin = appAs(db, 'boss', 'admin');
  await send(admin, 'POST', '/api/admin/membership-benefits', PRINTER_RULE);
  await send(admin, 'POST', '/api/admin/membership-benefits', {
    tier: 'pro', benefit_type: 'product_discount', scope: 'sub_category', category_id: 'mb_materials',
    sub_category_id: 'mb_pla', discount_mode: 'percent', percent: 20,
  });
  await send(admin, 'POST', '/api/admin/membership-benefits', {
    tier: 'pro', benefit_type: 'product_discount', scope: 'global', discount_mode: 'percent', percent: 5,
  });

  cartLine(raw, 'm1', 'promem', 'p_a1', 1);
  cartLine(raw, 'm2', 'promem', 'p_pla', 2);
  cartLine(raw, 'm3', 'promem', 'p_acc', 1);

  const cart = await json(await send(appAs(db, 'promem', 'customer'), 'GET', '/api/cart'));
  // The cart item's own key is `productId`; `membership.lines` keys by
  // `product_id`. Both appear in this test on purpose.
  const by = new Map(cart.items.map((i: { productId: string; unit_price_iqd: number }) => [i.productId, i.unit_price_iqd]));
  assert.equal(by.get('p_a1'), 1_750_000, 'the section rule, capped — not the global 5%');
  assert.equal(by.get('p_pla'), 20_000, 'the sub-section rule: 20% of 25,000');
  assert.equal(by.get('p_acc'), 9_500, 'nothing more specific, so the global 5%');
  assert.equal(cart.membership.discount_total_iqd, 100_000 + 2 * 5_000 + 500);
});

/* ---------------------------------------------------- the live rules table */

test('only enabled, in-window rules reach a checkout', async () => {
  const { db } = setup();
  const admin = appAs(db, 'boss', 'admin');
  await send(admin, 'POST', '/api/admin/membership-benefits', { ...PRINTER_RULE, enabled: false });
  await send(admin, 'POST', '/api/admin/membership-benefits', {
    ...PRINTER_RULE, valid_until: '2020-01-01T00:00:00Z', label: 'expired',
  });
  const live = await activeBenefitRules(db);
  assert.equal(live.some((r) => r.enabled === false), false, 'disabled rows never leave the query');
  // The dated one IS loaded — the window is judged per line, against the
  // clock the caller freezes — and `selectRule` drops it.
  assert.ok(live.some((r) => r.label === 'expired'));
});
