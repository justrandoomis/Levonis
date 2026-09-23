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
import { acceptedPolicies } from './lib/policies';
import { resetPolicyCorpusMemo } from '../worker/lib/policySync';

// ------------------------------------------------------------------ fixture

/**
 * A three-level section tree on purpose. `mb_printers -> fdm -> bambu`
 * exists because nothing in the taxonomy admin stops an owner creating it,
 * and a rule written on "Printers" has to reach a product filed at the
 * bottom of it.
 */
function setup() {
  // A NEW DATABASE IS A NEW ARCHIVE. `ensurePolicyCorpus` memoises a COMPLETED
  // mirror per isolate, and one test process is one isolate holding many
  // databases: without this, the first database in the run gets the policy
  // rows and every later one is skipped as already-synced, so checkout refuses
  // consent it cannot bind to a row. tests/fixtures/app.ts#dbThrough does the
  // same for the fixtures it builds; this file builds its own.
  resetPolicyCorpusMemo();
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
  policyAcceptance: acceptedPolicies(),
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

/**
 * ONE PER-ORDER CEILING FOR THE WHOLE ORDER. The admin's `per_order` and the
 * cart's «الخصم بحد أقصى لكل طلب» mean the order; the engine used to apply
 * the ceiling to each line, so two printers under one rule got it twice.
 */
test('a per-order ceiling over two different printers is spent once, and the snapshot adds up to it', async () => {
  const { raw, db } = setup();
  raw.exec(`INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images,category_id,sub_category_id)
    VALUES ('p_x1','mb-x1','Bambu X1','بامبو X1',1000000,'active',20,'[]','[]','direct_sale','["direct_sale"]','[]','[]','mb_printers','mb_bambu')`);
  const admin = appAs(db, 'boss', 'admin');
  const created = await json(
    await send(admin, 'POST', '/api/admin/membership-benefits', { ...PRINTER_RULE, max_discount_iqd: 150_000, cap_scope: 'per_order' })
  );
  assert.equal(created.success, true, JSON.stringify(created));

  cartLine(raw, 'ci_big', 'promem', 'p_a1', 1);
  cartLine(raw, 'ci_small', 'promem', 'p_x1', 1);
  const pro = appAs(db, 'promem', 'customer');

  const cart = await json(await send(pro, 'GET', '/api/cart'));
  // Line by line this was min(185,000, 150,000) + min(100,000, 150,000) = 250,000.
  assert.equal(cart.membership.discount_total_iqd, 150_000, 'one ceiling, not one per printer');
  assert.equal(cart.membership.order_discount_iqd, 150_000);

  const quote = await json(await send(pro, 'POST', '/api/orders/quote', checkoutBody('a_pro')));
  const q = quote.quote;
  assert.equal(q.membership_benefits.order_discount_iqd, 150_000);
  assert.equal(q.total_iqd, q.subtotal_iqd - 150_000 + q.shipping.total_iqd + q.cod_tax_iqd);

  const placed = await json(await send(pro, 'POST', '/api/orders', orderBody('a_pro')));
  assert.equal(placed.success, true, JSON.stringify(placed));
  await Promise.all(pending.splice(0));
  const order = raw.prepare('SELECT * FROM orders WHERE id = ?').get(placed.order.id) as Record<string, unknown>;
  assert.equal(order.membership_discount_iqd, 150_000);
  const snap = JSON.parse(String(order.benefit_snapshot));
  const lineSum = (snap.lines as Array<{ total_iqd: number }>).reduce((n, l) => n + l.total_iqd, 0);
  assert.equal(lineSum, 150_000, 'the per-line figures the order froze reconcile with its total');
  const items = raw.prepare('SELECT membership_discount_iqd AS d FROM order_items WHERE order_id = ?').all(placed.order.id) as Array<{ d: number }>;
  assert.equal(items.reduce((n, r) => n + Number(r.d ?? 0), 0), 150_000, 'and so do the order items');
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

/* ------------------------------------------- recommended starting values */

test('the recommended starting values are a starting point, not a decision', async () => {
  const { raw, db } = setup();
  // The store's own seeded root sections — this action works against the
  // owner's real taxonomy, which is why it cannot live in a migration.
  const admin = appAs(db, 'boss', 'admin');

  // Opening the list writes nothing: the dialog is a preview.
  const preview = await json(await send(admin, 'GET', '/api/admin/membership-benefits/recommended'));
  assert.equal(preview.success, true, JSON.stringify(preview));
  assert.ok(preview.entries.length > 0);
  const countRules = () =>
    (raw.prepare("SELECT COUNT(*) AS n FROM membership_benefit_rules WHERE benefit_type = 'product_discount'").get() as { n: number }).n;
  assert.equal(countRules(), 0, 'the preview created nothing');
  // A bare POST — the old one-click path — is refused and writes nothing.
  const bare = await send(admin, 'POST', '/api/admin/membership-benefits/recommended');
  assert.equal(bare.status, 400);
  assert.equal(countRules(), 0);

  const keys = preview.entries.map((e: { key: string }) => e.key);
  const first = await json(await send(admin, 'POST', '/api/admin/membership-benefits/recommended', { keys }));
  assert.equal(first.success, true, JSON.stringify(first));
  assert.ok(first.created.length > 0, 'the seeded taxonomy has printers and materials');
  const printers = first.created.find((r: { label: string }) => r.label.includes('PRO'));
  assert.equal(printers.scope, 'category');
  assert.equal(printers.benefit_type, 'product_discount');

  // Run it twice: it offers, it does not overwrite.
  const again = await json(await send(admin, 'POST', '/api/admin/membership-benefits/recommended', { keys }));
  assert.equal(again.created.length, 0);
  assert.ok(again.skipped.every((s: { reason: string }) => s.reason !== 'UNKNOWN'));
  const rows = raw.prepare("SELECT COUNT(*) AS n FROM membership_benefit_rules WHERE benefit_type = 'product_discount'").get() as { n: number };
  assert.equal(rows.n, first.created.length, 'nothing duplicated');

  // And an owner's own edit survives it.
  const edited = await json(
    await send(admin, 'PUT', `/api/admin/membership-benefits/${printers.id}`, {
      tier: printers.tier, benefit_type: 'product_discount', scope: 'category',
      category_id: printers.category_id, discount_mode: 'percent', percent: 3,
    })
  );
  assert.equal(edited.success, true);
  await send(admin, 'POST', '/api/admin/membership-benefits/recommended', { keys });
  const after = raw.prepare('SELECT percent FROM membership_benefit_rules WHERE id = ?').get(printers.id) as { percent: number };
  assert.equal(after.percent, 3, 'the action never overwrites a decision');
});

/* --------------------------------- the rule is credited only where it paid */

/**
 * A TYPED MEMBER PRICE BEATS A RULE — AND THE RULE MUST NOT TAKE THE CREDIT.
 *
 * `resolveUnitPrice` applies an explicit `pro_price_iqd` and ignores the rule
 * entirely, which is the documented precedence. The resolver used to recompute
 * the rule's arithmetic anyway, so a product with a typed PRO price of 950,000
 * and a store-wide 10% rule reported a 100,000 saving beside a 50,000 gap: the
 * cart said one thing, the subtotal said another, and the order snapshot froze
 * the wrong one.
 */
test('a typed member price is the saving, and a rule that did not set it is credited with nothing', async () => {
  const { raw, db } = setup();
  const admin = appAs(db, 'boss', 'admin');
  await send(admin, 'POST', '/api/admin/membership-benefits', {
    tier: 'pro', benefit_type: 'product_discount', scope: 'global', discount_mode: 'percent', percent: 10,
  });
  // 1,850,000 with a typed PRO price of 1,800,000. The rule would have given
  // 185,000; the owner's own number gives 50,000, and the owner's wins.
  raw.exec("UPDATE products SET pro_price_iqd = 1800000 WHERE id = 'p_a1';");

  cartLine(raw, 'ci_typed', 'promem', 'p_a1', 1);
  const cart = await json(await send(appAs(db, 'promem', 'customer'), 'GET', '/api/cart'));
  assert.equal(cart.items[0].unit_price_iqd, 1_800_000, 'the typed price is what is charged');
  assert.equal(cart.membership.discount_total_iqd, 50_000, 'and 50,000 is what the customer actually saved');
  assert.equal(cart.membership.lines[0].rule_id, null, 'no rule set this price, so none is credited');

  const quote = await json(await send(appAs(db, 'promem', 'customer'), 'POST', '/api/orders/quote', checkoutBody('a_pro')));
  assert.equal(quote.quote.membership_benefits.discount_total_iqd, 50_000);
  // The whole point: the reported saving and the gap on screen are the same
  // number, whichever of the two set the price.
  assert.equal(
    quote.quote.membership_benefits.discount_total_iqd,
    1_850_000 - quote.quote.lines[0].unit_price_iqd,
    'the reported saving IS the gap'
  );
});

test('a scheduled offer is not credited to the membership either', async () => {
  const { raw, db } = setup();
  const admin = appAs(db, 'boss', 'admin');
  await send(admin, 'POST', '/api/admin/membership-benefits', {
    tier: 'pro', benefit_type: 'product_discount', scope: 'global', discount_mode: 'percent', percent: 10,
  });
  // A live window at a flat price. The member ladder is re-clamped against it
  // (`resolveOfferPrice`), so the PRO member pays the offer price and the
  // membership added nothing on top of it.
  raw.exec(`
    INSERT INTO offer_windows (id, subject_type, subject_id, active, starts_at, ends_at, offer_price_mode, offer_price_iqd, required_tiers)
      VALUES ('ow1','product','p_a1',1,'2020-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z','fixed',1000000,'[]');
  `);
  cartLine(raw, 'ci_offer', 'promem', 'p_a1', 1);
  const cart = await json(await send(appAs(db, 'promem', 'customer'), 'GET', '/api/cart'));
  assert.equal(cart.items[0].unit_price_iqd, 1_000_000, 'the offer price');
  assert.equal(
    cart.membership.discount_total_iqd,
    0,
    'the offer is the offer’s saving; the membership took nothing further off'
  );
});

/* ------------------------------------ the owner's figures, and one section rule */

test('the recommended PREMIUM printers rule is the owner’s 25,000 per unit', async () => {
  const { db } = setup();
  const admin = appAs(db, 'boss', 'admin');
  const keys = (await json(await send(admin, 'GET', '/api/admin/membership-benefits/recommended'))).entries.map(
    (e: { key: string }) => e.key
  );
  const out = await json(await send(admin, 'POST', '/api/admin/membership-benefits/recommended', { keys }));
  const premium = out.created.find((r: { tier: string; label: string }) => r.tier === 'prime' && r.label.includes('طابعات'));
  assert.ok(premium, JSON.stringify(out));
  assert.equal(premium.discount_mode, 'fixed');
  assert.equal(premium.fixed_iqd, 25_000);
  assert.equal(premium.max_discount_iqd, 25_000);
  assert.equal(premium.cap_scope, 'per_unit');
});

test('only the owner’s printer figures go live; every other suggestion lands switched off', async () => {
  const { raw, db } = setup();
  const admin = appAs(db, 'boss', 'admin');
  const preview = await json(await send(admin, 'GET', '/api/admin/membership-benefits/recommended'));
  const byKey = new Map(preview.entries.map((e: { key: string; rule: { enabled: boolean } }) => [e.key, e]));
  assert.ok(byKey.has('pro-printers') && byKey.has('pro-accessories'), JSON.stringify(preview));
  // The dialog names the section in words, from the store's own taxonomy.
  assert.ok((byKey.get('pro-printers') as { category_name_ar: string }).category_name_ar);

  // Confirm ONLY the accessories suggestion: nothing else is written.
  const out = await json(await send(admin, 'POST', '/api/admin/membership-benefits/recommended', { keys: ['pro-accessories'] }));
  assert.deepEqual(out.created.map((r: { label: string }) => r.label), ['PRO — إكسسوارات']);
  const rows = raw
    .prepare("SELECT label, enabled FROM membership_benefit_rules WHERE benefit_type = 'product_discount'")
    .all() as Array<{ label: string; enabled: number }>;
  assert.deepEqual(rows.map((r) => [r.label, r.enabled]), [['PRO — إكسسوارات', 0]], 'a guess is created switched off, and alone');

  const rest = await json(
    await send(admin, 'POST', '/api/admin/membership-benefits/recommended', { keys: ['pro-printers', 'premium-printers'] })
  );
  assert.ok(rest.created.every((r: { enabled: boolean }) => r.enabled === true), 'the owner’s two figures are live');
});

/** A PRO product rule with the owner's printer terms, as the product editor writes it. */
const productRule = (productId: string, over: Record<string, unknown> = {}) => ({
  ...PRINTER_RULE,
  scope: 'product',
  category_id: null,
  product_id: productId,
  label: null,
  ...over,
});

function withSecondPrinter(raw: DatabaseSync) {
  raw.exec(`INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images,category_id,sub_category_id)
    VALUES ('p_x1','mb-x1','Bambu X1','بامبو X1',1000000,'active',20,'[]','[]','direct_sale','["direct_sale"]','[]','[]','mb_printers','mb_fdm')`);
}

test('identical per-product rules in one section become ONE section rule, in one audited batch', async () => {
  const { raw, db } = setup();
  withSecondPrinter(raw);
  const admin = appAs(db, 'boss', 'admin');
  const a = await json(await send(admin, 'POST', '/api/admin/membership-benefits', productRule('p_a1')));
  const b = await json(await send(admin, 'POST', '/api/admin/membership-benefits', productRule('p_x1')));
  // A different offer on another section is a different group.
  await send(admin, 'POST', '/api/admin/membership-benefits', productRule('p_pla', { percent: 20, max_discount_iqd: null, cap_scope: null }));

  cartLine(raw, 'ci_a', 'promem', 'p_a1', 1);
  const pro = appAs(db, 'promem', 'customer');
  const priceBefore = (await json(await send(pro, 'GET', '/api/cart'))).items[0].unit_price_iqd;
  assert.equal(priceBefore, 1_750_000);

  const plan = await json(await send(admin, 'GET', '/api/admin/membership-benefits/consolidation'));
  assert.equal(plan.success, true, JSON.stringify(plan));
  assert.equal(plan.product_rule_count, 3);
  const printers = plan.groups.find((g: { category_id: string }) => g.category_id === 'mb_printers');
  assert.deepEqual(printers.rule_ids, [a.rule.id, b.rule.id].sort());
  assert.equal(printers.mode, 'create');
  assert.equal(printers.category_name_ar, 'طابعات');
  assert.deepEqual(
    [printers.terms.percent, printers.terms.max_discount_iqd, printers.terms.cap_scope],
    [10, 100_000, 'per_unit']
  );

  const versionsBefore = (raw.prepare('SELECT COUNT(*) AS n FROM membership_benefit_versions').get() as { n: number }).n;
  const done = await json(
    await send(admin, 'POST', '/api/admin/membership-benefits/consolidation', { key: printers.key, rule_ids: printers.rule_ids })
  );
  assert.equal(done.success, true, JSON.stringify(done));

  const left = raw
    .prepare("SELECT id, scope, category_id, percent, max_discount_iqd, cap_scope FROM membership_benefit_rules WHERE benefit_type = 'product_discount' ORDER BY scope")
    .all() as Array<Record<string, unknown>>;
  assert.deepEqual(
    left.map((r) => [r.scope, r.category_id]),
    [['category', 'mb_printers'], ['product', null]],
    'one section rule for the printers; the filament rule is untouched'
  );
  assert.equal(left[0]!.id, done.created_rule_id);
  const versionsAfter = (raw.prepare('SELECT COUNT(*) AS n FROM membership_benefit_versions').get() as { n: number }).n;
  assert.equal(versionsAfter - versionsBefore, 1, 'ONE configuration version for the whole conversion');
  const version = raw.prepare('SELECT * FROM membership_benefit_versions ORDER BY id DESC LIMIT 1').get() as Record<string, string>;
  assert.equal(version.action, 'consolidate');
  assert.equal(version.rule_id, done.created_rule_id);
  assert.equal(JSON.parse(version.before_json).length, 2, 'the product rules it deleted');
  // The snapshot IS the rule set now in force — not an intermediate one, and
  // the new rule is the row actually inserted, not a copy of a product rule.
  const snap = JSON.parse(version.rules_json) as Array<Record<string, unknown>>;
  const live = raw.prepare('SELECT id FROM membership_benefit_rules').all() as Array<{ id: string }>;
  assert.deepEqual(snap.map((r) => r.id).sort(), live.map((r) => r.id).sort());
  const snapRule = snap.find((r) => r.id === done.created_rule_id)!;
  assert.equal(snapRule.scope, 'category');
  assert.equal('notes' in snapRule, false, 'no product rule’s note carried over');
  assert.deepEqual(
    [snapRule.percent, snapRule.max_discount_iqd, snapRule.cap_scope, snapRule.enabled],
    [10, 100_000, 'per_unit', true]
  );
  const summary = raw.prepare("SELECT * FROM audit_log WHERE action = 'membership_benefit.consolidate'").all();
  assert.equal(summary.length, 1);
  const perRule = raw.prepare("SELECT action FROM audit_log WHERE action IN ('membership_benefit.create','membership_benefit.delete') AND detail LIKE '%consolidation%'").all();
  assert.equal(perRule.length, 3, 'an audit row per rule changed');

  // The price a PRO member pays did not move.
  const priceAfter = (await json(await send(pro, 'GET', '/api/cart'))).items[0].unit_price_iqd;
  assert.equal(priceAfter, priceBefore);

  // A second press, with the list it was shown, is refused and writes nothing.
  const again = await send(admin, 'POST', '/api/admin/membership-benefits/consolidation', { key: printers.key, rule_ids: printers.rule_ids });
  assert.equal(again.status, 409);
  assert.equal((await json(again)).code, 'CONSOLIDATION_STALE');
});

test('a product a sub-section rule would reprice keeps its own rule, and order-wide limits are not folded', async () => {
  const { raw, db } = setup();
  withSecondPrinter(raw);
  const admin = appAs(db, 'boss', 'admin');
  const a = await json(await send(admin, 'POST', '/api/admin/membership-benefits', productRule('p_a1')));
  const b = await json(await send(admin, 'POST', '/api/admin/membership-benefits', productRule('p_x1')));
  // p_a1 is filed under mb_bambu: without its product rule this 5% would win.
  await send(admin, 'POST', '/api/admin/membership-benefits', {
    ...PRINTER_RULE, scope: 'sub_category', category_id: 'mb_printers', sub_category_id: 'mb_bambu', percent: 5,
  });
  const plan = await json(await send(admin, 'GET', '/api/admin/membership-benefits/consolidation'));
  const printers = plan.groups.find((g: { category_id: string }) => g.category_id === 'mb_printers');
  assert.deepEqual(printers.rule_ids, [b.rule.id]);
  assert.deepEqual(printers.kept_rule_ids, [a.rule.id]);

  // A per-order ceiling is one budget per rule: folding two into one would halve it.
  const { raw: raw2, db: db2 } = setup();
  withSecondPrinter(raw2);
  const admin2 = appAs(db2, 'boss', 'admin');
  const perOrder = { max_discount_iqd: 150_000, cap_scope: 'per_order' };
  await send(admin2, 'POST', '/api/admin/membership-benefits', productRule('p_a1', perOrder));
  await send(admin2, 'POST', '/api/admin/membership-benefits', productRule('p_x1', perOrder));
  const plan2 = await json(await send(admin2, 'GET', '/api/admin/membership-benefits/consolidation'));
  const blocked = plan2.groups.find((g: { category_id: string }) => g.category_id === 'mb_printers');
  assert.equal(blocked.mode, 'blocked');
  assert.equal(blocked.reason, 'ORDER_WIDE_LIMIT');
  const refused = await send(admin2, 'POST', '/api/admin/membership-benefits/consolidation', { key: blocked.key, rule_ids: blocked.rule_ids });
  assert.equal(refused.status, 409);
  const count = (raw2.prepare("SELECT COUNT(*) AS n FROM membership_benefit_rules WHERE scope = 'product'").get() as { n: number }).n;
  assert.equal(count, 2, 'nothing was written');
});

test('a switched-off section rule neither blocks the conversion nor hides an identical live one', async () => {
  const { raw, db } = setup();
  withSecondPrinter(raw);
  const admin = appAs(db, 'boss', 'admin');
  await send(admin, 'POST', '/api/admin/membership-benefits', productRule('p_a1'));
  await send(admin, 'POST', '/api/admin/membership-benefits', productRule('p_x1'));
  // An old, disabled section rule with other figures: it prices nothing.
  const off = await json(await send(admin, 'POST', '/api/admin/membership-benefits', { ...PRINTER_RULE, percent: 3, enabled: false }));
  assert.equal(off.success, true, JSON.stringify(off));
  const plan = await json(await send(admin, 'GET', '/api/admin/membership-benefits/consolidation'));
  const printers = plan.groups.find((g: { category_id: string }) => g.category_id === 'mb_printers');
  assert.equal(printers.mode, 'create', JSON.stringify(printers));
  assert.equal(printers.reason, null);
  const done = await send(admin, 'POST', '/api/admin/membership-benefits/consolidation', { key: printers.key, rule_ids: printers.rule_ids });
  assert.equal(done.status, 200);

  // A live DIFFERENT rule listed before a live IDENTICAL one: the identical
  // one makes the product rules redundant; the conversion only deletes them.
  const { raw: raw2, db: db2 } = setup();
  withSecondPrinter(raw2);
  const admin2 = appAs(db2, 'boss', 'admin');
  await send(admin2, 'POST', '/api/admin/membership-benefits', productRule('p_a1'));
  await send(admin2, 'POST', '/api/admin/membership-benefits', productRule('p_x1'));
  // (An offer whose window has closed: enabled, different, and pricing nothing.)
  raw2.exec(`INSERT INTO membership_benefit_rules (id,tier,benefit_type,scope,category_id,discount_mode,percent,valid_until,enabled,priority)
    VALUES ('mbr_a_other','pro','product_discount','category','mb_printers','percent',20,'2000-01-01T00:00:00.000Z',1,0)`);
  raw2.exec(`INSERT INTO membership_benefit_rules (id,tier,benefit_type,scope,category_id,discount_mode,percent,max_discount_iqd,cap_scope,enabled,priority)
    VALUES ('mbr_z_same','pro','product_discount','category','mb_printers','percent',10,100000,'per_unit',1,0)`);
  const plan2 = await json(await send(admin2, 'GET', '/api/admin/membership-benefits/consolidation'));
  const g2 = plan2.groups.find((g: { category_id: string }) => g.category_id === 'mb_printers');
  assert.equal(g2.mode, 'delete_only', JSON.stringify(g2));
  assert.equal(g2.existing_rule_id, 'mbr_z_same');
});

test('two admins converting the same group at once leave ONE section rule', async () => {
  const { raw, db } = setup();
  withSecondPrinter(raw);
  const admin = appAs(db, 'boss', 'admin');
  const a = await json(await send(admin, 'POST', '/api/admin/membership-benefits', productRule('p_a1')));
  await send(admin, 'POST', '/api/admin/membership-benefits', productRule('p_x1'));
  const plan = await json(await send(admin, 'GET', '/api/admin/membership-benefits/consolidation'));
  const printers = plan.groups.find((g: { category_id: string }) => g.category_id === 'mb_printers');
  const versionsBefore = (raw.prepare('SELECT COUNT(*) AS n FROM membership_benefit_versions').get() as { n: number }).n;

  // The other admin's conversion lands between this request's plan and its
  // batch: a live section rule appears, and the product rules are gone.
  const d1 = db as unknown as { batch: (s: unknown[]) => Promise<unknown> };
  const realBatch = d1.batch.bind(d1);
  d1.batch = async (statements) => {
    d1.batch = realBatch;
    raw.exec(`INSERT INTO membership_benefit_rules (id,tier,benefit_type,scope,category_id,discount_mode,percent,max_discount_iqd,cap_scope,enabled,priority)
      VALUES ('mbr_other_admin','pro','product_discount','category','mb_printers','percent',10,100000,'per_unit',1,0)`);
    raw.exec("DELETE FROM membership_benefit_rules WHERE scope = 'product'");
    return realBatch(statements);
  };
  const res = await send(admin, 'POST', '/api/admin/membership-benefits/consolidation', { key: printers.key, rule_ids: printers.rule_ids });
  assert.equal(res.status, 409, await res.clone().text());
  assert.equal((await json(res)).code, 'CONSOLIDATION_STALE');
  const sections = raw.prepare("SELECT id FROM membership_benefit_rules WHERE scope = 'category' AND category_id = 'mb_printers'").all();
  assert.deepEqual(sections.map((r) => r.id), ['mbr_other_admin'], 'no second section rule');
  const versionsAfter = (raw.prepare('SELECT COUNT(*) AS n FROM membership_benefit_versions').get() as { n: number }).n;
  assert.equal(versionsAfter, versionsBefore, 'the whole batch rolled back');

  // A product rule EDITED in the meantime is not deleted under its new terms.
  const { raw: raw2, db: db2 } = setup();
  withSecondPrinter(raw2);
  const admin2 = appAs(db2, 'boss', 'admin');
  const b1 = await json(await send(admin2, 'POST', '/api/admin/membership-benefits', productRule('p_a1')));
  await send(admin2, 'POST', '/api/admin/membership-benefits', productRule('p_x1'));
  const plan2 = await json(await send(admin2, 'GET', '/api/admin/membership-benefits/consolidation'));
  const g2 = plan2.groups.find((g: { category_id: string }) => g.category_id === 'mb_printers');
  const d2 = db2 as unknown as { batch: (s: unknown[]) => Promise<unknown> };
  const realBatch2 = d2.batch.bind(d2);
  d2.batch = async (statements) => {
    d2.batch = realBatch2;
    raw2.prepare('UPDATE membership_benefit_rules SET percent = 12 WHERE id = ?').run(b1.rule.id);
    return realBatch2(statements);
  };
  const res2 = await send(admin2, 'POST', '/api/admin/membership-benefits/consolidation', { key: g2.key, rule_ids: g2.rule_ids });
  assert.equal(res2.status, 409);
  const kept = raw2.prepare('SELECT percent FROM membership_benefit_rules WHERE id = ?').get(b1.rule.id) as { percent: number };
  assert.equal(kept.percent, 12, 'the edited rule survives');
  const sections2 = raw2.prepare("SELECT COUNT(*) AS n FROM membership_benefit_rules WHERE scope = 'category'").get() as { n: number };
  assert.equal(sections2.n, 0, 'and no section rule was left behind');
  void a;
});
