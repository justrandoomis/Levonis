/**
 * «خصص طابعتك», PHASE 2 (owner rulings 2026-11-17; DECISIONS row 339; 0235):
 * a membership bought WITH a printer (an order line at the live plan price,
 * activated only when the order is delivered AND fully paid, final once
 * active) and the owner's filament kits (real products at their live prices,
 * one kit per printer unit, reserved like any line).
 *
 * Fixture: tests/printerServicesFlow.test.ts (a real SQLite with every
 * migration, the real routes).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { ROOT, SqliteD1 } from './fixtures/d1';
import type { AppContext, Env } from '../worker/lib/types';
import { HttpError } from '../worker/lib/http';
import { cartRoutes } from '../worker/routes/cart';
import { orderRoutes } from '../worker/routes/orders';
import { productRoutes } from '../worker/routes/products';
import { policiesRoutes } from '../worker/routes/policies';
import { adminRoutes } from '../worker/routes/admin';
import { membershipsRoutes, quotePurchase } from '../worker/routes/memberships';
import { returnRoutes } from '../worker/routes/returns';
import { adminPrinterServiceRoutes } from '../worker/routes/adminPrinterServices';
import { classifyHost } from '../worker/lib/hosts';
import { moveOrderStage } from '../worker/lib/orderStageOps';
import { runOrderDeliveredEffects } from '../worker/lib/orderDeliveredEffects';
import { activateOrderMembership, sweepOrderMemberships } from '../worker/lib/orderMembershipSale';
import { addMonths } from '../worker/lib/membershipOps';
import { loadPrinterServices, publishedFromSetting } from '../worker/lib/printerServices';
import { calculateGoods, type GoodsLine } from '../worker/lib/orderProfit';
import { snapshotFor, type CostRule } from '../worker/lib/orderFinance';
import { deleteCancelledOrder } from '../worker/lib/orderDeletion';
import { acceptedPolicies } from './lib/policies';
import { PRINTER_STANDARD_DELIVERY_POLICY } from '../packages/shipping/src/printerDeliveryPolicy';
import { resetPolicyCorpusMemo } from '../worker/lib/policySync';
import { autoPublishFromEnv } from './fixtures/autoPublish';
import {
  DEFAULT_PRINTER_SERVICES, PHASE2_CODES, canonicalConfig, configIssues, kitsForPrinter, presetSelection, publishIssues, servicesOffer,
  type FilamentKit, type PrinterServicesConfig, type ServiceSelection,
} from '../packages/pricing/src/printerServices';

const OPS = JSON.stringify({ serialized: true, warranty_base_months: 12 });
const KIT: FilamentKit = {
  id: 'a1-starter', active: true, sort: 1,
  title: { ar: 'باقة البداية', en: 'Starter kit', ckb: 'پاکێجی دەستپێک' },
  items: [{ product_id: 'p_pla', option_value_ids: [], color_id: null, qty: 2 }],
  printers: [{ product_id: 'p_a1', option_value_id: null }],
};

function liveConfig(over: Partial<PrinterServicesConfig> = {}): PrinterServicesConfig {
  return { ...DEFAULT_PRINTER_SERVICES, revision: 1, products: { p_a1: { warranty_family: 'a1', delivery_class: 'd1' } }, kits: [KIT], ...over };
}

function setup(opts: { config?: unknown; plaStock?: number } = {}) {
  resetPolicyCorpusMemo();
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) raw.exec(readFileSync(join(dir, f), 'utf8'));
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','s@x.co','h','customer'),
      ('buyer2','Huda','h@x.co','h','customer'),
      ('owner','Owner','owner@x.co','h','admin'),
      ('staff','Staff','staff@x.co','h','admin');
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,is_default) VALUES
      ('addr_b','buyer','Home','Sara','+9647701234567','Baghdad, Karrada 12','',1),
      ('addr_b2','buyer2','Home','Huda','+9647701234568','Baghdad, Mansour 3','',1);
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status) VALUES
      ('dep_b','buyer','deposit','USD',200000,'approved'),
      ('dep_b2','buyer2','deposit','USD',200000,'approved');
  `);
  raw
    .prepare(
      `INSERT INTO products (id,slug,name,name_ar,price_iqd,prime_price_iqd,pro_price_iqd,status,stock,options,colors,selling_type,sale_types,warranty_plans,ops_policy,images)
       VALUES ('p_a1','a1-printer','Printer A1','طابعة A1',840000,NULL,NULL,'active',5,'[]','[]','direct_sale','["direct_sale"]','[]',?,'[]'),
              ('p_pla','pla-basic','PLA Basic','PLA أساسي',25000,NULL,NULL,'active',?,'[]','[]','direct_sale','["direct_sale"]','[]','{}','[]')`
    )
    .run(OPS, opts.plaStock ?? 50);
  raw.exec(`
    INSERT INTO catalogs (id, slug, name_ar, is_printer_catalog) VALUES
      ('cat_p','test-ps2-printers','طابعات',1), ('cat_f','test-ps2-filaments','خيوط',0);
    INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES ('p_a1','cat_p',0), ('p_pla','cat_f',0);
  `);
  const live = opts.config ?? liveConfig();
  raw.prepare('INSERT INTO admin_settings (key, value) VALUES (?, ?)').run(
    'printerServices',
    JSON.stringify({ draft: live, published: live, published_at: '2026-11-17T00:00:00.000Z', published_by: 'owner' })
  );
  return { raw, db: new SqliteD1(raw) as unknown as D1Database, env: { DB: new SqliteD1(raw) } as unknown as Env };
}

function appAs(db: D1Database, userId: string | null, role: 'customer' | 'admin' = 'customer') {
  const a = new Hono<AppContext>();
  a.use('*', async (c, next) => {
    if (userId) c.set('user', { id: userId, role, email: `${userId}@x.co`, username: userId, email_verified_at: '2026-01-01T00:00:00.000Z' } as never);
    c.set('host', classifyHost('levonis-iq.com', 'levonis-iq.com'));
    c.env = { DB: db, APP_ORIGIN: 'https://levonis-iq.com', STORE_ROOT_DOMAIN: 'levonis-iq.com', INITIAL_ADMIN_EMAIL: 'owner@x.co' } as never;
    await next();
  });
  a.use('*', autoPublishFromEnv);
  a.route('/api/cart', cartRoutes);
  a.route('/api/orders', orderRoutes);
  a.route('/api/products', productRoutes);
  a.route('/api/policies', policiesRoutes);
  a.route('/api/memberships', membershipsRoutes);
  a.route('/api/returns', returnRoutes);
  a.route('/api/admin/printer-services', adminPrinterServiceRoutes);
  a.route('/api/admin', adminRoutes);
  a.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ success: false, error: err.message, code: err.code, details: err.details ?? null }, err.status as 400);
    throw err;
  });
  return a;
}

const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p.catch(() => undefined)); }, passThroughOnException() {} } as unknown as ExecutionContext;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Opt = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const json = async (res: Response) => (await res.json()) as Record<string, any>;
const send = (a: ReturnType<typeof appAs>, method: string, path: string, body?: unknown) =>
  a.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, undefined, ctx);
const post = (a: ReturnType<typeof appAs>, path: string, body: unknown) => send(a, 'POST', path, body);
const put = (a: ReturnType<typeof appAs>, path: string, body: unknown) => send(a, 'PUT', path, body);
const patch = (a: ReturnType<typeof appAs>, path: string, body: unknown) => send(a, 'PATCH', path, body);
const del = (a: ReturnType<typeof appAs>, path: string) => send(a, 'DELETE', path);
const get = (a: ReturnType<typeof appAs>, path: string) => send(a, 'GET', path);

let seq = 0;
const orderBody = (over: Record<string, unknown> = {}) => ({
  addressId: 'addr_b',
  deliveryMethodId: 'standard',
  printerStandardDeliveryAcceptance: { version: PRINTER_STANDARD_DELIVERY_POLICY.version, accepted: true },
  paymentMethodId: 'cash',
  useWallet: false,
  usePoints: false,
  itemIds: [],
  idempotencyKey: `ps2-${Date.now()}-${++seq}`,
  policyAcceptance: acceptedPolicies(),
  ...over,
});
const smart = (delivery: ServiceSelection['delivery'] = 'economy'): ServiceSelection => ({ ...presetSelection(DEFAULT_PRINTER_SERVICES, 'smart', delivery), confirmed: true });
const printerId = (raw: DatabaseSync) => (raw.prepare("SELECT id FROM cart_items WHERE user_id = 'buyer' AND product_id = 'p_a1'").get() as { id: string }).id;
const purchase = (raw: DatabaseSync, orderId: string) => raw.prepare('SELECT * FROM order_membership_purchases WHERE order_id = ?').get(orderId) as Record<string, unknown>;
const deliver = (raw: DatabaseSync, orderId: string, at = '2026-12-01T10:00:00.000Z') =>
  raw.prepare("UPDATE orders SET status = 'delivered', stage = 'delivered', delivered_at = ? WHERE id = ?").run(at, orderId);
const collectible = (raw: DatabaseSync, orderId: string) => {
  const r = raw.prepare(`SELECT o.total_iqd - COALESCE(o.gini_paid_iqd, 0) AS due,
      (SELECT COALESCE(SUM(amount_iqd), 0) FROM order_payment_settlements s WHERE s.order_id = o.id) AS got FROM orders o WHERE o.id = ?`).get(orderId) as { due: number; got: number };
  return Number(r.due) - Number(r.got);
};
const liveMemberships = (raw: DatabaseSync) =>
  raw.prepare("SELECT id, tier, state, starts_at, expires_at, price_paid_iqd, credit_applied_iqd, source_ref FROM memberships WHERE user_id = 'buyer' ORDER BY created_at, id").all() as Array<Record<string, unknown>>;

/** A printer (+ membership) in the cart, quoted, ordered with the quoted membership figure. */
async function orderWithMembership(a: ReturnType<typeof appAs>, planId: string, over: Record<string, unknown> = {}) {
  const added = await post(a, '/api/cart/items', { productId: 'p_a1', qty: 1, services: smart(), membershipPlanId: planId });
  assert.equal(added.status, 200, JSON.stringify(await json(added.clone())));
  const quote = (await json(await post(a, '/api/orders/quote', orderBody(over)))).quote;
  assert.ok(quote.membership, JSON.stringify(quote));
  const placed = await post(a, '/api/orders', orderBody({ ...over, membershipChargeIqd: quote.membership.charge_iqd }));
  const body = await json(placed);
  assert.equal(placed.status, 200, JSON.stringify(body));
  return { order: body.order, quote };
}

// ------------------------------------------------------------- the config

test('config: a list stored before phase 2 reads as memberships off, no kits; kits are validated; publishing checks them', async () => {
  const old: Record<string, unknown> = { ...liveConfig() };
  delete old.membership; delete old.kits;
  const pk = JSON.parse(JSON.stringify(old.packages));
  delete pk.smart.membership_tier; delete pk.complete.membership_tier;
  old.packages = pk;
  assert.deepEqual(configIssues(old), [], 'a phase 1 list stays valid');
  const read = publishedFromSetting({ published: old })!;
  assert.deepEqual(read.membership, { active: false, tiers: [] });
  assert.deepEqual(read.kits, []);
  assert.equal(servicesOffer(read, { warranty_family: 'a1', delivery_class: 'd1' }).membership, null);

  const bad = liveConfig({
    kits: [
      { ...KIT, items: [{ ...KIT.items[0] }, { ...KIT.items[0], qty: 3 }] },
      { ...KIT, id: 'a1-starter' },
      { ...KIT, id: 'Bad Id', items: [{ ...KIT.items[0], qty: 0 }] },
      { ...KIT, id: 'disc', discount_iqd: 5000 } as unknown as FilamentKit,
    ],
    membership: { active: true, tiers: ['plus', 'gold' as never] },
  });
  const issues = configIssues(bad);
  for (const needle of ['the same product and selection twice', 'kits[1].id: used twice', 'kits[2].id', 'kits[2].items[0].qty', 'kits carry no discount', 'membership.tiers']) {
    assert.ok(issues.some((i) => i.includes(needle)), `${needle}: ${issues.join(' | ')}`);
  }
  const unpublishable = liveConfig({
    kits: [{ ...KIT, title: { ar: 'x', en: '', ckb: 'y' }, items: [{ product_id: 'p_a1', option_value_ids: [], color_id: null, qty: 1 }], printers: [{ product_id: 'p_zz', option_value_id: null }] }],
    packages: { ...DEFAULT_PRINTER_SERVICES.packages, complete: { ...DEFAULT_PRINTER_SERVICES.packages.complete, membership_tier: 'pro' } },
    membership: { active: true, tiers: ['plus'] },
  });
  const p = publishIssues(unpublishable);
  for (const needle of ['needs a title', 'a printer cannot be a kit item', 'p_zz is not mapped', 'preselects a membership tier that is not offered']) {
    assert.ok(p.some((i) => i.includes(needle)), `${needle}: ${p.join(' | ')}`);
  }
  // Complete includes NO membership by default (owner ruling); the field exists.
  assert.equal(DEFAULT_PRINTER_SERVICES.packages.complete.membership_tier, null);
  assert.deepEqual(canonicalConfig(liveConfig()).kits, [KIT]);
  assert.deepEqual(kitsForPrinter(liveConfig(), 'p_a1', []).map((k) => k.id), ['a1-starter']);
  assert.deepEqual(kitsForPrinter(liveConfig(), 'p_other', []), []);
  // Every phase 2 code has words in ar / en / ckb (the sheet's copy, where it carries one, the same).
  const { REFUSAL_STRINGS } = await import('../src/lib/refusalStrings');
  const { SERVICES_ERRORS } = await import('../src/components/product/printerServicesStrings');
  for (const code of PHASE2_CODES) {
    const w = REFUSAL_STRINGS[code];
    assert.ok(w && w.ar && w.en && w.ckb && w.ckb !== w.ar, code);
    if (SERVICES_ERRORS[code]) assert.deepEqual(SERVICES_ERRORS[code], { ar: w.ar, en: w.en, ckb: w.ckb }, code);
  }
  // KIT_QTY_LIMIT (S14): its own sentence with the most printers, in both copies, the same words.
  const rs = await import('../src/lib/refusalStrings');
  const ps = await import('../src/components/product/printerServicesStrings');
  assert.deepEqual(ps.KIT_QTY_LIMIT_WORDS, rs.KIT_QTY_LIMIT_WORDS);
  assert.notEqual(rs.KIT_QTY_LIMIT_WORDS.ckb, rs.KIT_QTY_LIMIT_WORDS.ar);
  const limit = { code: 'KIT_UNAVAILABLE', message: 'x', details: { kit_id: 'k', product_id: null, reason: 'KIT_QTY_LIMIT', max_printer_qty: 499 } };
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const said = rs.apiRefusal(limit, lang);
    assert.ok(said.includes('499') && !said.includes('{n}'), `${lang}: ${said}`);
    assert.equal(ps.servicesRefusalText(limit, lang), said);
    assert.equal(rs.stockRefusal(limit, lang), said);
  }
  assert.equal(ps.servicesRefusalText({ code: 'KIT_UNAVAILABLE', details: { reason: 'OUT_OF_STOCK' } }, 'en'), SERVICES_ERRORS.KIT_UNAVAILABLE.en);
  assert.ok(REFUSAL_STRINGS.NO_STARTED_MEMBERSHIP && REFUSAL_STRINGS.NO_STARTED_MEMBERSHIP.ckb !== REFUSAL_STRINGS.NO_STARTED_MEMBERSHIP.ar);
});

test('config: a draft saved by a page that does not know the phase 2 fields keeps the stored kits and membership', async () => {
  const { db, raw } = setup();
  const owner = appAs(db, 'owner', 'admin');
  const before = (await loadPrinterServices(db)).state.draft;
  const posted: Record<string, unknown> = JSON.parse(JSON.stringify(before));
  delete posted.kits; delete posted.membership;
  const saved = await put(owner, '/api/admin/printer-services/draft', { draft: posted, base_revision: before.revision });
  assert.equal(saved.status, 200, JSON.stringify(await json(saved.clone())));
  const after = JSON.parse(String((raw.prepare("SELECT value FROM admin_settings WHERE key = 'printerServices'").get() as { value: string }).value)).draft;
  assert.deepEqual(after.kits, [KIT]);
  assert.deepEqual(after.membership, before.membership);
  // A kit naming a product that does not exist blocks publishing.
  const broken = { ...after, kits: [{ ...KIT, items: [{ ...KIT.items[0], product_id: 'p_none' }] }] };
  assert.equal((await put(owner, '/api/admin/printer-services/draft', { draft: broken, base_revision: after.revision })).status, 200);
  const pub = await post(owner, '/api/admin/printer-services/publish', { base_revision: after.revision + 1 });
  assert.equal((await json(pub)).code, 'PRINTER_SERVICES_NOT_READY');
});

// ------------------------------------------------------- the order quote

test('order-options: a guest sees new; a member sees only HIGHER tiers (upgrade with credit) — same and lower hidden, no renew kind; a waiting order refuses a second one', async () => {
  const { db, raw } = setup();
  const guest = await json(await get(appAs(db, null), '/api/memberships/order-options'));
  assert.equal(guest.offered, true);
  const plus1 = guest.options.find((o: { plan: { id: string } }) => o.plan.id === 'plus_1mo');
  assert.deepEqual([plus1.ok, plus1.kind, plus1.charge_iqd], [true, 'new', 1000]);

  const now = new Date();
  const start = new Date(now.getTime() - 15 * 86_400_000).toISOString();
  const end = new Date(now.getTime() + 15 * 86_400_000).toISOString();
  raw.prepare(`INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,price_paid_iqd,credit_basis_iqd,starts_at,expires_at,source)
               VALUES ('m_plus','buyer','plus_1mo','plus','active',1,1000,1000,?,?,'purchase')`).run(start, end);
  const a = appAs(db, 'buyer');
  const opts = (await json(await get(a, '/api/memberships/order-options'))).options as Opt[];
  const by = (id: string) => opts.find((o) => o.plan.id === id);
  // NO RENEWAL through an order (owner ruling ~10:20): the member's own tier is not listed at all.
  assert.equal(opts.some((o) => o.plan.tier === 'plus'), false, JSON.stringify(opts.map((o) => o.plan.id)));
  assert.equal(opts.some((o) => o.kind === 'renew'), false);
  const up = by('prime_1mo')!;
  assert.deepEqual([up.kind, up.starts], ['upgrade', 'at_activation']);
  assert.ok(up.credit_iqd > 0 && up.credit_iqd <= 1000, JSON.stringify(up));
  assert.equal(up.charge_iqd, 12_000 - up.credit_iqd);
  // The cart door refuses the same tier (the sheet never shows it).
  assert.equal((await json(await post(a, '/api/cart/items', { productId: 'p_a1', qty: 1, services: smart(), membershipPlanId: 'plus_1mo' }))).code, 'ALREADY_SUBSCRIBED');
  // The purchase table has no renew kind either.
  assert.throws(() => raw.prepare(`INSERT INTO order_membership_purchases (id, order_id, order_item_id, user_id, plan_id, tier, duration_months, kind, price_iqd, charge_iqd, created_at, updated_at)
    VALUES ('x','o','oi','buyer','plus_1mo','plus',1,'renew',1000,1000,'t','t')`).run(), /CHECK/);

  raw.prepare("UPDATE memberships SET tier = 'prime', plan_id = 'prime_1mo' WHERE id = 'm_plus'").run();
  const lower = (await json(await get(a, '/api/memberships/order-options'))).options as Opt[];
  assert.equal(lower.some((o) => o.plan.tier === 'plus' || o.plan.tier === 'prime'), false, 'same and lower tiers are hidden');

  // A purchase waiting on another order: no second membership, by the wallet either.
  raw.prepare("UPDATE memberships SET state = 'expired' WHERE id = 'm_plus'").run();
  const { order } = await orderWithMembership(a, 'plus_1mo');
  const again = ((await json(await get(a, '/api/memberships/order-options'))).options as Opt[]).find((o) => o.plan.id === 'plus_3mo')!;
  assert.deepEqual([again.ok, again.code], [false, 'MEMBERSHIP_ORDER_PENDING']);
  const plan = raw.prepare("SELECT * FROM membership_plans WHERE id = 'plus_3mo'").get() as never;
  await assert.rejects(quotePurchase(db, { id: 'buyer' } as never, plan, new Date().toISOString()), (e: HttpError) => e.code === 'MEMBERSHIP_ORDER_PENDING');
  assert.equal(purchase(raw, order.id).state, 'pending');
  await Promise.allSettled(pending);
});

// ------------------------------------------------------------- the cart

test('cart: the membership rides on one enrolled printer line; another line, a non-printer or an unoffered tier is refused; it leaves with its printer', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'buyer');
  const added = await json(await post(a, '/api/cart/items', { productId: 'p_a1', qty: 1, services: smart(), membershipPlanId: 'plus_1mo' }));
  assert.equal(added.success, true, JSON.stringify(added));
  const cart = await json(await get(a, '/api/cart'));
  assert.deepEqual([cart.printer_extras.membership.plan_id, cart.printer_extras.membership.quote.ok, cart.printer_extras.membership.quote.charge_iqd], ['plus_1mo', true, 1000]);
  assert.equal(cart.printer_extras.membership.printer_cart_item_id, printerId(raw));

  const pla = await json(await post(a, '/api/cart/items', { productId: 'p_pla', qty: 1, membershipPlanId: 'plus_1mo' }));
  assert.equal(pla.code, 'EXTRAS_NOT_PRINTER');
  // Only the tiers the owner offers with a printer.
  raw.prepare("UPDATE admin_settings SET value = json_set(value, '$.published.membership.tiers', json('[\"prime\"]')) WHERE key = 'printerServices'").run();
  const notOffered = await json(await put(a, `/api/cart/items/${printerId(raw)}/extras`, { membershipPlanId: 'plus_3mo' }));
  assert.equal(notOffered.code, 'MEMBERSHIP_NOT_OFFERED');
  const changed = await json(await put(a, `/api/cart/items/${printerId(raw)}/extras`, { membershipPlanId: 'prime_1mo' }));
  assert.equal(changed.printer_extras.membership.plan_id, 'prime_1mo', JSON.stringify(changed));
  // One membership per cart: a second printer line cannot take it.
  raw.prepare(`INSERT INTO cart_items (id, user_id, product_id, option_id, option_value_ids, color_id, shipping_method_id, qty, services)
               VALUES ('ci_second', 'buyer', 'p_a1', 'ov_other', '["ov_other"]', '', '', 1, ?)`).run(JSON.stringify(smart()));
  assert.equal((await json(await put(a, '/api/cart/items/ci_second/extras', { membershipPlanId: 'prime_1mo' }))).code, 'CART_MEMBERSHIP_CONFLICT');
  raw.prepare("DELETE FROM cart_items WHERE id = 'ci_second'").run();
  // Removed with its printer line (trigger), whatever door removes it.
  assert.equal((await del(a, `/api/cart/items/${printerId(raw)}`)).status, 200);
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM cart_membership_choice WHERE user_id = 'buyer'").get() as { n: number }).n, 0);
});

// --------------------------------------------------------- the checkout

test('checkout: the membership joins the total only — no coupon, points, benefit or free-delivery basis sees it; the order line and the pending purchase are written', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'buyer');
  assert.equal((await post(a, '/api/cart/items', { productId: 'p_a1', qty: 1, services: smart() })).status, 200);
  const without = (await json(await post(a, '/api/orders/quote', orderBody()))).quote;
  assert.equal(without.membership, null);
  assert.equal((await put(a, `/api/cart/items/${printerId(raw)}/extras`, { membershipPlanId: 'prime_1mo' })).status, 200);
  const withM = (await json(await post(a, '/api/orders/quote', orderBody()))).quote;
  assert.deepEqual([withM.membership.kind, withM.membership.charge_iqd, withM.membership.refundable_after_activation], ['new', 12_000, false]);
  assert.equal(withM.total_iqd - without.total_iqd, 12_000, 'only the total moves');
  assert.equal(withM.subtotal_iqd - without.subtotal_iqd, 12_000);
  assert.equal(withM.merchandise_iqd, without.merchandise_iqd);
  assert.equal(withM.shipping.total_iqd, without.shipping.total_iqd);
  assert.equal(withM.points.eligible_merchandise_iqd, without.points.eligible_merchandise_iqd);
  assert.equal(withM.points.earn_eligible_iqd, without.points.earn_eligible_iqd);
  assert.equal(withM.membership_benefits?.discount_total_iqd ?? 0, without.membership_benefits?.discount_total_iqd ?? 0);

  // The door refuses a figure the customer did not see.
  const unseen = await post(a, '/api/orders', orderBody());
  assert.equal(unseen.status, 409);
  const refusal = await json(unseen);
  assert.equal(refusal.code, 'MEMBERSHIP_PRICE_CHANGED');
  assert.equal(refusal.details.membership.charge_iqd, 12_000);
  assert.equal((await json(await post(a, '/api/orders', orderBody({ membershipChargeIqd: 11_000 })))).code, 'MEMBERSHIP_PRICE_CHANGED');

  const placed = await json(await post(a, '/api/orders', orderBody({ membershipChargeIqd: 12_000 })));
  assert.equal(placed.success, true, JSON.stringify(placed));
  const line = raw.prepare("SELECT * FROM order_items WHERE order_id = ? AND line_kind = 'membership'").get(placed.order.id) as Record<string, unknown>;
  assert.deepEqual([line.product_id, line.qty, line.unit_price_iqd, line.line_total_iqd, line.cost_iqd, line.coupon_discount_iqd, line.membership_discount_iqd], [null, 1, 12_000, 12_000, 0, 0, 0]);
  const p = purchase(raw, placed.order.id);
  assert.deepEqual([p.state, p.kind, p.tier, p.charge_iqd, p.order_item_id, p.membership_id], ['pending', 'new', 'prime', 12_000, line.id, null]);
  assert.equal(liveMemberships(raw).length, 0, 'no benefit before delivery and payment — not even on this order');
  const order = placed.order;
  assert.equal(order.items.find((i: { kind?: string }) => i.kind === 'membership').returnable, false);
  assert.equal(Number((raw.prepare('SELECT subtotal_iqd FROM orders WHERE id = ?').get(order.id) as { subtotal_iqd: number }).subtotal_iqd), withM.subtotal_iqd);
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM cart_membership_choice WHERE user_id = 'buyer'").get() as { n: number }).n, 0, 'the cart choice left with its printer');
  await Promise.allSettled(pending);
});

// -------------------------------------------------------- the activation

test('activation: a prepaid order starts it at delivery; replays and the sweep make no second row; the sale journal books it under 4000', async () => {
  const { db, raw, env } = setup();
  const a = appAs(db, 'buyer');
  const { order, quote } = await orderWithMembership(a, 'plus_1mo', { useWallet: true });
  assert.equal(collectible(raw, order.id), 0, 'paid in full at purchase');
  assert.equal((await activateOrderMembership(env, order.id, { trigger: 'test' })).waiting, 'not_delivered');
  deliver(raw, order.id);
  await runOrderDeliveredEffects(env, order.id);
  const p = purchase(raw, order.id);
  assert.equal(p.state, 'active');
  assert.equal(p.membership_id, `mem_ord_${p.order_item_id}`);
  const rows = liveMemberships(raw);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].id, rows[0].tier, rows[0].state, rows[0].price_paid_iqd, rows[0].source_ref], [p.membership_id, 'plus', 'active', 1000, `order:${order.id}`]);
  assert.equal(rows[0].expires_at, addMonths(String(rows[0].starts_at), 1));
  // Replays: the delivered effects again, the activation again, the sweep.
  await runOrderDeliveredEffects(env, order.id);
  assert.deepEqual((await activateOrderMembership(env, order.id, { trigger: 'replay' })).activated, []);
  assert.deepEqual(await sweepOrderMemberships(env), { scanned: 0, activated: 0, blocked: 0 });
  assert.equal(liveMemberships(raw).length, 1);
  // Revenue: the membership line is in the sale journal's 4000 credit, nothing else changes.
  const revenue = raw.prepare(`SELECT COALESCE(SUM(l.credit_iqd - l.debit_iqd), 0) AS n FROM accounting_lines l JOIN accounting_entries e ON e.id = l.entry_id
                                WHERE e.event_key = ? AND l.account_code = '4000'`).get(`sale:${order.id}`) as { n: number };
  const goods = (quote.lines as Array<{ line_total_iqd: number }>).reduce((s, l) => s + l.line_total_iqd, 0);
  assert.equal(Number(revenue.n), goods + 1000, 'printer goods + membership');
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM accounting_entries WHERE event_key = ?").get(`membership-sale:${order.id}`)!.n, 0, 'no membership-sale correction');
  await Promise.allSettled(pending);
});

test('activation: a cash order waits for its collection — partial is not enough, the settlement that completes it starts it', async () => {
  const { db, raw, env } = setup();
  const a = appAs(db, 'buyer');
  const { order } = await orderWithMembership(a, 'plus_1mo');
  deliver(raw, order.id);
  await runOrderDeliveredEffects(env, order.id);
  assert.equal(purchase(raw, order.id).state, 'pending', 'delivered but not paid');
  const owner = appAs(db, 'owner', 'admin');
  const due = collectible(raw, order.id);
  assert.ok(due > 1000);
  const half = await json(await post(owner, `/api/orders/${order.id}/settlement`, { amountIqd: due - 500, eventKey: 'cod:part1' }));
  assert.equal(half.settlement.fully_settled, false);
  assert.equal(purchase(raw, order.id).state, 'pending');
  const rest = await json(await post(owner, `/api/orders/${order.id}/settlement`, { amountIqd: 500, eventKey: 'cod:part2' }));
  assert.equal(rest.settlement.fully_settled, true, JSON.stringify(rest));
  assert.equal(purchase(raw, order.id).state, 'active');
  assert.equal(liveMemberships(raw).filter((m) => m.state === 'active').length, 1);
  await Promise.allSettled(pending);
});

test('activation: the sweep starts one the doors missed; a live membership that appeared meanwhile blocks it for a person, the retry starts it after', async () => {
  const { db, raw, env } = setup();
  const a = appAs(db, 'buyer');
  const { order } = await orderWithMembership(a, 'plus_1mo', { useWallet: true });
  deliver(raw, order.id); // delivered through a door that ran no effects
  // An admin grant landed between the checkout and the activation.
  raw.prepare(`INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at,source)
               VALUES ('m_grant','buyer','prime_1mo','prime','active',1,'2026-11-01T00:00:00.000Z','2027-01-01T00:00:00.000Z','admin')`).run();
  const report = await sweepOrderMemberships(env);
  assert.deepEqual(report, { scanned: 1, activated: 0, blocked: 1 });
  const p = purchase(raw, order.id);
  assert.deepEqual([p.state, p.needs_review, p.review_reason], ['blocked', 1, 'live_membership_at_activation']);
  const owner = appAs(db, 'owner', 'admin');
  const list = await json(await get(owner, '/api/memberships/admin/order-purchases'));
  assert.equal(list.purchases.length, 1);
  raw.prepare("UPDATE memberships SET state = 'cancelled' WHERE id = 'm_grant'").run();
  const retried = await json(await post(owner, `/api/memberships/admin/order-purchases/${p.id}/retry`, {}));
  assert.deepEqual([retried.state, retried.activated], ['active', true], JSON.stringify(retried));
  await Promise.allSettled(pending);
});

test('activation: an upgrade ends the lower row with the credit frozen at checkout (no renewal through an order)', async () => {
  const { db, raw, env } = setup();
  const a = appAs(db, 'buyer');
  const now = Date.now();
  const end = new Date(now + 10 * 86_400_000).toISOString();
  raw.prepare(`INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,price_paid_iqd,credit_basis_iqd,starts_at,expires_at,source)
               VALUES ('m_plus','buyer','plus_1mo','plus','active',1,1000,1000,?,?,'purchase')`).run(new Date(now - 20 * 86_400_000).toISOString(), end);
  const up = await orderWithMembership(a, 'prime_1mo', { useWallet: true });
  assert.equal(up.quote.membership.kind, 'upgrade');
  const credit = up.quote.membership.credit_iqd;
  assert.ok(credit > 0);
  deliver(raw, up.order.id);
  await runOrderDeliveredEffects(env, up.order.id);
  const after = liveMemberships(raw);
  assert.deepEqual(after.map((m) => [m.id, m.tier, m.state]), [['m_plus', 'plus', 'cancelled'], [`mem_ord_${purchase(raw, up.order.id).order_item_id}`, 'prime', 'active']]);
  assert.deepEqual([after[1].price_paid_iqd, after[1].credit_applied_iqd], [12_000 - credit, credit]);
  await Promise.allSettled(pending);
});

// ------------------------------------------- cancellation and refunds

test('cancelled before activation it never starts; once active it is final: no cancel, no return, no wallet refund', async () => {
  const { db, raw, env } = setup();
  const a = appAs(db, 'buyer');
  const first = await orderWithMembership(a, 'plus_1mo');
  const cancelled = await post(a, `/api/orders/${first.order.id}/cancel`, {});
  assert.equal(cancelled.status, 200, JSON.stringify(await json(cancelled.clone())));
  assert.deepEqual([purchase(raw, first.order.id).state, purchase(raw, first.order.id).cancel_reason], ['cancelled', 'order_cancelled']);
  assert.equal((await activateOrderMembership(env, first.order.id, { trigger: 'test' })).waiting, 'none');
  assert.equal(liveMemberships(raw).length, 0, 'a cancelled purchase never starts');

  const { order } = await orderWithMembership(a, 'plus_1mo', { useWallet: true });
  deliver(raw, order.id);
  await runOrderDeliveredEffects(env, order.id);
  const p = purchase(raw, order.id);
  assert.equal(p.state, 'active');
  // No door cancels the order now — the stage door, a raw write.
  const moved = await moveOrderStage(env, { orderId: order.id, to: 'cancelled', source: 'manual', changedBy: 'owner', force: true } as never);
  assert.equal(moved.reason, 'ORDER_MEMBERSHIP_ACTIVE');
  assert.throws(() => raw.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(order.id), /ORDER_MEMBERSHIP_ACTIVE/);
  assert.throws(() => raw.prepare("UPDATE order_membership_purchases SET state = 'cancelled' WHERE id = ?").run(String(p.id)), /ORDER_MEMBERSHIP_ACTIVE_FINAL/);
  // The returns desk refuses the membership line (the printer line stays returnable).
  const ret = await post(a, '/api/returns', { orderItemId: p.order_item_id, qty: 1, reason: 'defective' });
  assert.equal((await json(ret)).code, 'MEMBERSHIP_NOT_RETURNABLE');
  // The admin cancel gives no wallet refund for it.
  const owner = appAs(db, 'owner', 'admin');
  const refund = await post(owner, `/api/memberships/admin/${p.membership_id}/cancel`, { refund: true });
  assert.equal((await json(refund)).code, 'MEMBERSHIP_NOT_RETURNABLE');
  assert.equal(liveMemberships(raw).find((m) => m.id === p.membership_id)!.state, 'active');
  await Promise.allSettled(pending);
});

// -------------------------------------------------------------- the kits

test('kits: priced from the live items with no discount, one kit per printer unit, following the printer; locked lines; stock and conflicts refused', async () => {
  const { db, raw } = setup({ plaStock: 5 });
  const guest = await json(await get(appAs(db, null), '/api/products/a1-printer/kits?qty=2&fulfillmentType=direct_sale'));
  assert.equal(guest.kits.length, 1, JSON.stringify(guest));
  const k = guest.kits[0];
  assert.deepEqual([k.id, k.available, k.price_per_printer_iqd, k.total_iqd, k.discount_iqd, k.items[0].qty], ['a1-starter', true, 50_000, 100_000, 0, 4]);
  const tooMany = await json(await get(appAs(db, null), '/api/products/a1-printer/kits?qty=3&fulfillmentType=direct_sale'));
  assert.equal(tooMany.kits[0].available, false, 'six spools on a shelf of five');
  assert.equal((await json(await get(appAs(db, null), '/api/products/pla-basic/kits'))).kits.length, 0);

  const a = appAs(db, 'buyer');
  assert.equal((await json(await post(a, '/api/cart/items', { productId: 'p_a1', qty: 3, services: smart(), kitId: 'a1-starter' }))).code, 'KIT_UNAVAILABLE');
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM cart_items WHERE user_id = 'buyer'").get()!.n, 0, 'nothing written');
  assert.equal((await json(await post(a, '/api/cart/items', { productId: 'p_a1', qty: 1, services: smart(), kitId: 'nope' }))).code, 'KIT_NOT_OFFERED');
  const added = await json(await post(a, '/api/cart/items', { productId: 'p_a1', qty: 1, services: smart(), kitId: 'a1-starter' }));
  assert.equal(added.success, true, JSON.stringify(added));
  const kitLine = () => raw.prepare("SELECT * FROM cart_items WHERE user_id = 'buyer' AND kit_parent_id IS NOT NULL").get() as Record<string, unknown>;
  assert.deepEqual([kitLine().product_id, kitLine().qty, kitLine().kit_unit_qty, kitLine().shipping_method_id], ['p_pla', 2, 2, `kit:${printerId(raw)}`]);
  // The same filament bought alone is its own line, never merged into the kit.
  assert.equal((await post(a, '/api/cart/items', { productId: 'p_pla', qty: 1 })).status, 200);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM cart_items WHERE user_id = 'buyer' AND product_id = 'p_pla'").get()!.n, 2);
  // The kit follows the printer's quantity, from any door.
  assert.equal((await patch(a, `/api/cart/items/${printerId(raw)}`, { qty: 2 })).status, 200);
  assert.equal(kitLine().qty, 4);
  const cart = await json(await get(a, '/api/cart'));
  const printer = cart.items.find((i: { productId: string }) => i.productId === 'p_a1');
  assert.deepEqual([printer.kit.kit_id, printer.kit.current, printer.kit.total_iqd], ['a1-starter', true, 100_000]);
  assert.deepEqual(printer.printer_services.offer.kits.map((x: { id: string }) => x.id), ['a1-starter']);
  // A kit line is locked: change it on the printer.
  assert.equal((await json(await patch(a, `/api/cart/items/${kitLine().id}`, { qty: 1 }))).code, 'KIT_LINE_LOCKED');
  assert.equal((await json(await del(a, `/api/cart/items/${kitLine().id}`))).code, 'KIT_LINE_LOCKED');
  // Removed from the printer, or with it.
  assert.equal((await put(a, `/api/cart/items/${printerId(raw)}/extras`, { kitId: null })).status, 200);
  assert.equal(kitLine(), undefined);
  assert.equal((await put(a, `/api/cart/items/${printerId(raw)}/extras`, { kitId: 'a1-starter' })).status, 200);
  assert.equal(kitLine().qty, 4);
  assert.equal((await del(a, `/api/cart/items/${printerId(raw)}`)).status, 200);
  assert.equal(kitLine(), undefined, 'the kit left with its printer');
});

test('kits at checkout: linked to the printer line, reserved, named on the packing note; a changed kit or a kit without its printer is refused', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'buyer');
  assert.equal((await post(a, '/api/cart/items', { productId: 'p_a1', qty: 2, services: smart(), kitId: 'a1-starter' })).status, 200);
  const kitId = (raw.prepare("SELECT id FROM cart_items WHERE kit_parent_id IS NOT NULL").get() as { id: string }).id;
  // Ticking only the kit line: it is bought with its printer.
  assert.equal((await json(await post(a, '/api/orders/quote', orderBody({ itemIds: [kitId] })))).code, 'KIT_WITHOUT_PRINTER');
  // Ticking the printer ticks its kit.
  const q = (await json(await post(a, '/api/orders/quote', orderBody({ itemIds: [printerId(raw)] })))).quote;
  const kitQ = q.lines.find((l: { product_id: string }) => l.product_id === 'p_pla');
  assert.deepEqual([kitQ.qty, kitQ.unit_price_iqd, kitQ.kit_line.kit_id], [4, 25_000, 'a1-starter']);
  // The owner changes the kit: the cart's lines no longer match it.
  const changed = { ...KIT, items: [{ ...KIT.items[0], qty: 3 }] };
  raw.prepare("UPDATE admin_settings SET value = json_set(value, '$.published.kits', json(?)) WHERE key = 'printerServices'").run(JSON.stringify([changed]));
  assert.equal((await json(await post(a, '/api/orders/quote', orderBody()))).code, 'KIT_CHANGED');
  raw.prepare("UPDATE admin_settings SET value = json_set(value, '$.published.kits', json(?)) WHERE key = 'printerServices'").run(JSON.stringify([KIT]));

  const stockBefore = Number((raw.prepare("SELECT stock_reserved FROM products WHERE id = 'p_pla'").get() as { stock_reserved: number }).stock_reserved ?? 0);
  const placed = await json(await post(a, '/api/orders', orderBody()));
  assert.equal(placed.success, true, JSON.stringify(placed));
  const items = raw.prepare('SELECT id, product_id, qty, kit_parent_item_id, kit_id, shipping_method_id FROM order_items WHERE order_id = ? ORDER BY product_id').all(placed.order.id) as Array<Record<string, unknown>>;
  const printerItem = items.find((i) => i.product_id === 'p_a1')!;
  const kitItem = items.find((i) => i.product_id === 'p_pla')!;
  assert.deepEqual([kitItem.qty, kitItem.kit_parent_item_id, kitItem.kit_id], [4, printerItem.id, 'a1-starter']);
  // S13: the cart's 'kit:<line>' discriminator is not written to the order; the link is kit_parent_item_id.
  assert.equal(kitItem.shipping_method_id, '');
  assert.equal(printerItem.kit_parent_item_id, null);
  const stockAfter = Number((raw.prepare("SELECT stock_reserved FROM products WHERE id = 'p_pla'").get() as { stock_reserved: number }).stock_reserved ?? 0);
  const ledger = raw.prepare("SELECT COUNT(*) AS n FROM inventory_ledger WHERE product_id = 'p_pla'").get() as { n: number };
  assert.ok(stockAfter - stockBefore === 4 || Number(ledger.n) > 0, `the kit's spools are reserved (${stockBefore} → ${stockAfter}, ledger ${ledger.n})`);
  const note = (raw.prepare("SELECT note FROM order_service_tasks WHERE order_id = ? AND kind = 'packaging'").get(placed.order.id) as { note: string }).note;
  assert.match(note, /باقة الفيلامنت/);
  assert.match(note, /×4/);
  const view = placed.order.items.find((i: { product_id: string }) => i.product_id === 'p_pla');
  assert.equal(view.kit.printer_item_id, printerItem.id);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM cart_items WHERE user_id = 'buyer'").get()!.n, 0);
  await Promise.allSettled(pending);
});

// ------------------------------------------------- review fixes (S1–S17)

test('S1 Gini: the membership is outside the Gini part — the courier collects it with the delivery fee; it starts only once that is settled', async () => {
  const { db, raw, env } = setup();
  const a = appAs(db, 'buyer');
  assert.equal((await post(a, '/api/cart/items', { productId: 'p_a1', qty: 1, services: smart(), membershipPlanId: 'plus_1mo' })).status, 200);
  const q = (await json(await post(a, '/api/orders/quote', orderBody({ paymentMethodId: 'gini' })))).quote;
  assert.equal(q.membership.charge_iqd, 1000, JSON.stringify(q.membership));
  assert.equal(q.gini.delivery_due_iqd, q.shipping.total_iqd + 1000, 'delivery fee + membership at the door');
  assert.equal(q.gini.paid_iqd + q.gini.delivery_due_iqd, q.total_iqd);
  // The door amount in its two named parts, so the screen never says «the delivery fee only» over a membership.
  assert.deepEqual([q.gini.delivery_fee_due_iqd, q.gini.membership_due_iqd], [q.shipping.total_iqd, 1000]);
  // Store pickup: no fee, the membership is still cash on collection.
  const pick = (await json(await post(a, '/api/orders/quote', orderBody({ paymentMethodId: 'gini', deliveryMethodId: 'pickup' })))).quote;
  assert.ok(pick?.is_pickup, 'the pickup quote answers'); assert.deepEqual([pick.gini.delivery_due_iqd, pick.gini.delivery_fee_due_iqd, pick.gini.membership_due_iqd], [1000, 0, 1000]);
  const placed = await json(await post(a, '/api/orders', orderBody({ paymentMethodId: 'gini', giniOrderNo: '246810', membershipChargeIqd: 1000 })));
  assert.equal(placed.success, true, JSON.stringify(placed));
  const id = placed.order.id;
  const row = raw.prepare('SELECT total_iqd, gini_paid_iqd, due_on_delivery_iqd FROM orders WHERE id = ?').get(id) as Record<string, number>;
  assert.equal(Number(row.due_on_delivery_iqd), q.shipping.total_iqd + 1000);
  assert.equal(Number(row.gini_paid_iqd) + Number(row.due_on_delivery_iqd), Number(row.total_iqd));
  // Delivered: the Gini part is the bank's; the door cash is not collected yet → it waits.
  deliver(raw, id);
  await runOrderDeliveredEffects(env, id);
  assert.equal(purchase(raw, id).state, 'pending');
  assert.equal((await activateOrderMembership(env, id, { trigger: 'test' })).waiting, 'not_paid');
  assert.equal(collectible(raw, id), q.shipping.total_iqd + 1000);
  const owner = appAs(db, 'owner', 'admin');
  const settled = await json(await post(owner, `/api/orders/${id}/settlement`, { amountIqd: collectible(raw, id), eventKey: 'cod:gini-door' }));
  assert.equal(settled.settlement.fully_settled, true, JSON.stringify(settled));
  assert.equal(purchase(raw, id).state, 'active');
  await Promise.allSettled(pending);
});

test('S2 BNPL: a membership is refused with Buy Now Pay Later — the quote shows it unavailable, the order door refuses it', async () => {
  const { db, raw } = setup();
  raw.exec(`UPDATE admin_settings SET value = '{"paused":false,"since":null}' WHERE key = 'proPause'`);
  raw.exec(`
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at,source)
      VALUES ('m_pro','buyer','pro_12mo','pro','active',12,'2026-01-01T00:00:00.000Z','2030-01-01T00:00:00.000Z','admin');
    INSERT INTO approved_addresses (id,user_id,version,name,phone_e164,address,state,source_address_id,approved_by,approved_at)
      VALUES ('ap_b','buyer',1,'Sara','+9647701234567','Baghdad, Karrada 12','approved','addr_b','owner','2026-01-01T00:00:00.000Z');
    INSERT INTO kyc_cases (id,user_id,state,decided_at) VALUES ('kyc_b','buyer','verified','2026-01-01T00:00:00.000Z');
    INSERT INTO bnpl_accounts (user_id,state,credit_limit_iqd,approved_by) VALUES ('buyer','approved',50000000,'owner');
  `);
  const a = appAs(db, 'buyer');
  assert.equal((await post(a, '/api/cart/items', { productId: 'p_a1', qty: 1, services: smart() })).status, 200);
  const plainRes = await json(await post(a, '/api/orders/quote', orderBody({ paymentMethodId: 'bnpl' })));
  assert.ok(plainRes.quote, `BNPL is offered to this customer: ${JSON.stringify(plainRes)}`);
  raw.prepare('INSERT INTO cart_membership_choice (user_id, plan_id, printer_cart_item_id) VALUES (?, ?, ?)').run('buyer', 'pro_12mo', printerId(raw));
  const res = await post(a, '/api/orders/quote', orderBody({ paymentMethodId: 'bnpl' }));
  assert.equal(res.status, 200, 'the quote does not throw');
  const q = (await json(res)).quote;
  assert.deepEqual([q.membership.ok, q.membership.code, q.membership.plan_id], [false, 'MEMBERSHIP_NOT_WITH_BNPL', 'pro_12mo']);
  assert.equal(q.total_iqd, plainRes.quote.total_iqd, 'the total leaves it out');
  const refused = await post(a, '/api/orders', orderBody({ paymentMethodId: 'bnpl' }));
  assert.equal(refused.status, 409);
  assert.equal((await json(refused)).code, 'MEMBERSHIP_NOT_WITH_BNPL');
  await Promise.allSettled(pending);
});

test('S3 the owner-only correction cancels an order whose membership started (membership ended, order refunded, audited); staff cannot', async () => {
  const { db, raw, env } = setup();
  const a = appAs(db, 'buyer');
  const { order } = await orderWithMembership(a, 'plus_1mo', { useWallet: true });
  const owner = appAs(db, 'owner', 'admin');
  // Nothing started yet: the correction door is not the way.
  assert.equal((await json(await post(owner, `/api/admin/orders/${order.id}/membership-correction`, { reason: 'test' }))).code, 'NO_STARTED_MEMBERSHIP');
  deliver(raw, order.id);
  await runOrderDeliveredEffects(env, order.id);
  const p = purchase(raw, order.id);
  assert.equal(p.state, 'active');
  // Staff: refused at the correction door, and no forced stage move cancels it.
  const staff = appAs(db, 'staff', 'admin');
  const staffTry = await post(staff, `/api/admin/orders/${order.id}/membership-correction`, { reason: 'mistake' });
  assert.equal(staffTry.status, 403);
  assert.equal((await json(staffTry)).code, 'OWNER_ONLY');
  const forced = await moveOrderStage(env, { orderId: order.id, to: 'cancelled', source: 'manual', changedBy: 'staff', force: true } as never);
  assert.equal(forced.reason, 'ORDER_MEMBERSHIP_ACTIVE');
  assert.equal(purchase(raw, order.id).state, 'active');
  // The owner.
  const fixed = await post(owner, `/api/admin/orders/${order.id}/membership-correction`, { reason: 'wrong customer account' });
  const body = await json(fixed);
  assert.equal(fixed.status, 200, JSON.stringify(body));
  const after = purchase(raw, order.id);
  assert.deepEqual([after.state, after.cancel_reason, after.membership_id], ['cancelled', 'owner_correction', p.membership_id]);
  assert.equal(liveMemberships(raw).find((m) => m.id === p.membership_id)!.state, 'cancelled');
  assert.equal((raw.prepare('SELECT status FROM orders WHERE id = ?').get(order.id) as { status: string }).status, 'cancelled');
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM wallet_transactions WHERE id = ?').get(`wtx_refund_${order.id}_usd`)!.n, 1, 'the ordinary cancel refund');
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'membership.order_owner_correction' AND actor_id = 'owner' AND target = ?").get(order.id)!.n, 1);
  await Promise.allSettled(pending);
});

test('S4 a base membership is not refunded to the wallet while an upgrade order that credited it is waiting', async () => {
  const { db, raw } = setup();
  const now = Date.now();
  raw.prepare(`INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,price_paid_iqd,credit_basis_iqd,starts_at,expires_at,source)
               VALUES ('m_plus','buyer','plus_1mo','plus','active',1,1000,1000,?,?,'purchase')`)
    .run(new Date(now - 10 * 86_400_000).toISOString(), new Date(now + 20 * 86_400_000).toISOString());
  const a = appAs(db, 'buyer');
  const { order, quote } = await orderWithMembership(a, 'prime_1mo');
  assert.equal(quote.membership.kind, 'upgrade');
  assert.equal(purchase(raw, order.id).base_membership_id, 'm_plus');
  const owner = appAs(db, 'owner', 'admin');
  const refund = await post(owner, '/api/memberships/admin/m_plus/cancel', { refund: true });
  const body = await json(refund);
  assert.equal(refund.status, 409, JSON.stringify(body));
  assert.equal(body.code, 'MEMBERSHIP_ORDER_PENDING');
  assert.equal(body.details.order_id, order.id);
  assert.equal(liveMemberships(raw).find((m) => m.id === 'm_plus')!.state, 'active');
  await Promise.allSettled(pending);
});

test('S4 the refund cancel own write refuses when a waiting upgrade order appears after its check (no refund)', async () => {
  const { db, raw } = setup();
  const now = Date.now();
  raw.prepare(`INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,price_paid_iqd,credit_basis_iqd,starts_at,expires_at,source)
               VALUES ('m_plus','buyer','plus_1mo','plus','active',1,1000,1000,?,?,'purchase')`)
    .run(new Date(now - 10 * 86_400_000).toISOString(), new Date(now + 20 * 86_400_000).toISOString());
  const { order } = await orderWithMembership(appAs(db, 'buyer'), 'prime_1mo');
  assert.equal(purchase(raw, order.id).base_membership_id, 'm_plus');
  // The door's first read sees no waiting order (as if the checkout committed right after it).
  let first = true;
  const racy = Object.create(db) as D1Database;
  racy.prepare = (sql: string) => {
    if (first && sql.includes('FROM order_membership_purchases WHERE base_membership_id = ?')) { first = false; return db.prepare(`${sql.replace(' LIMIT 1', '')} AND 0`); }
    return db.prepare(sql);
  };
  const res = await post(appAs(racy, 'owner', 'admin'), '/api/memberships/admin/m_plus/cancel', { refund: true });
  const body = await json(res);
  assert.equal(first, false, 'the race was staged');
  assert.equal(res.status, 409, JSON.stringify(body));
  assert.equal(body.code, 'MEMBERSHIP_ORDER_PENDING');
  assert.equal(liveMemberships(raw).find((m) => m.id === 'm_plus')!.state, 'active', 'the flip changed nothing');
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM wallet_transactions WHERE id = 'wtx_refund_m_plus'").get()!.n, 0, 'no refund');
  await Promise.allSettled(pending);
});

test('S4 an upgrade whose base membership was ended meanwhile is not activated (blocked) — nor restored by a re-open', async () => {
  const { db, raw, env } = setup();
  const now = Date.now();
  const base = (id: string) => raw.prepare(`INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,price_paid_iqd,credit_basis_iqd,starts_at,expires_at,source)
               VALUES (?,'buyer','plus_1mo','plus','active',1,1000,1000,?,?,'purchase')`)
    .run(id, new Date(now - 10 * 86_400_000).toISOString(), new Date(now + 20 * 86_400_000).toISOString());
  const a = appAs(db, 'buyer');
  const owner = appAs(db, 'owner', 'admin');
  // (a) Activation: the base was cancelled (without a refund — the only cancel allowed while the order waits).
  base('m_plus');
  const { order } = await orderWithMembership(a, 'prime_1mo', { useWallet: true });
  assert.equal(purchase(raw, order.id).kind, 'upgrade');
  assert.equal((await post(owner, '/api/memberships/admin/m_plus/cancel', { refund: false })).status, 200);
  deliver(raw, order.id);
  await runOrderDeliveredEffects(env, order.id);
  const p = purchase(raw, order.id);
  assert.deepEqual([p.state, p.review_reason, p.needs_review], ['blocked', 'base_membership_ended', 1]);
  assert.equal(liveMemberships(raw).filter((m) => m.state === 'active').length, 0, 'no membership at the credited price');
  // The sweep / an admin retry keeps it blocked while the base stays ended.
  await activateOrderMembership(env, order.id, { trigger: 'test', retryBlocked: true });
  assert.equal(purchase(raw, order.id).state, 'blocked');

  // (b) Re-open: the order was cancelled, the base refunded to the wallet, then the order re-opened.
  raw.exec("DELETE FROM order_membership_purchases WHERE state = 'blocked'");
  base('m_plus2');
  const { order: o2 } = await orderWithMembership(a, 'prime_1mo');
  assert.equal(purchase(raw, o2.id).base_membership_id, 'm_plus2');
  assert.equal((await post(a, `/api/orders/${o2.id}/cancel`, {})).status, 200);
  assert.equal(purchase(raw, o2.id).state, 'cancelled');
  assert.equal((await post(owner, '/api/memberships/admin/m_plus2/cancel', { refund: true })).status, 200, 'nothing waits on it now');
  // This order's advance went back to the wallet, so the admin doors refuse its re-open (REFUNDED_ORDER);
  // the re-open trigger is proven on the flip itself (an order with nothing refunded re-opens this way).
  raw.prepare("UPDATE orders SET status = 'pending' WHERE id = ?").run(o2.id);
  const p2 = purchase(raw, o2.id);
  assert.deepEqual([p2.state, p2.review_reason, p2.needs_review], ['blocked', 'base_membership_ended', 1]);
  await Promise.allSettled(pending);
});

test('an owner-corrected order is never re-opened (ORDER_MEMBERSHIP_CORRECTED) — its membership is not charged again', async () => {
  const { db, raw, env } = setup();
  const a = appAs(db, 'buyer');
  const { order } = await orderWithMembership(a, 'plus_1mo', { useWallet: true });
  deliver(raw, order.id);
  await runOrderDeliveredEffects(env, order.id);
  assert.equal(purchase(raw, order.id).state, 'active');
  const owner = appAs(db, 'owner', 'admin');
  assert.equal((await post(owner, `/api/admin/orders/${order.id}/membership-correction`, { reason: 'wrong customer account' })).status, 200);
  for (const status of ['pending', 'confirmed']) {
    const res = await patch(owner, `/api/admin/orders/${order.id}`, { status });
    const out = await json(res);
    assert.equal(res.status, 409, `${status}: ${JSON.stringify(out)}`);
    assert.equal(out.code, 'ORDER_MEMBERSHIP_CORRECTED');
  }
  for (const stage of ['received', 'confirmed']) {
    const res = await patch(owner, `/api/admin/orders/${order.id}/stage`, { stage });
    const out = await json(res);
    assert.equal(res.status, 409, `${stage}: ${JSON.stringify(out)}`);
    assert.equal(out.code, 'ORDER_MEMBERSHIP_CORRECTED');
  }
  const forced = await moveOrderStage(env, { orderId: order.id, to: 'received', source: 'manual', changedBy: 'owner', force: true } as never);
  assert.equal(forced.reason, 'ORDER_MEMBERSHIP_CORRECTED');
  // Every other door meets the database.
  assert.throws(() => raw.prepare("UPDATE orders SET status = 'pending' WHERE id = ?").run(order.id), /ORDER_MEMBERSHIP_CORRECTED/);
  assert.equal((raw.prepare('SELECT status FROM orders WHERE id = ?').get(order.id) as { status: string }).status, 'cancelled');
  assert.equal(purchase(raw, order.id).cancel_reason, 'owner_correction');
  await Promise.allSettled(pending);
});

test('S5 finance: the membership line takes no share of the points discount or a price adjustment, and no staff rule or wage', async () => {
  const lines = [
    { id: 'l_printer', product_id: 'p_a1', qty: 1, bundle_parent_item_id: null, component_alloc_iqd: null, line_total_iqd: 10_000, coupon_discount_iqd: 0, membership_discount_iqd: 0, cost_iqd: 5000, cost_basis: 'snapshot', line_kind: 'product' },
    { id: 'l_member', product_id: null, qty: 1, bundle_parent_item_id: null, component_alloc_iqd: null, line_total_iqd: 1000, coupon_discount_iqd: 0, membership_discount_iqd: 0, cost_iqd: 0, cost_basis: 'snapshot', line_kind: 'membership' },
  ] as unknown as GoodsLine[];
  const goods = calculateGoods({ points_discount_iqd: 2000, price_adjustment_iqd: -500, shipping_iqd: 0, cod_tax_iqd: 0 }, lines, []);
  const by = (id: string) => goods.lines.find((l) => l.id === id)!;
  assert.equal(by('l_member').net_goods_iqd, 1000, 'the membership keeps exactly what it charged');
  assert.equal(by('l_member').price_adjustment_iqd, 0);
  assert.equal(by('l_printer').net_goods_iqd, 10_000 - 2000 - 500);
  // Even a cut larger than the goods never reaches it.
  const big = calculateGoods({ points_discount_iqd: 0, price_adjustment_iqd: -50_000, shipping_iqd: 0, cod_tax_iqd: 0 }, lines, []);
  assert.equal(big.lines.find((l) => l.id === 'l_member')!.net_goods_iqd, 1000);

  const { db } = setup();
  const rule = {
    id: 'r_all', version: 1, name: 'packing', group_key: 'pack', target_type: 'all', target_id: '', basis: 'unit', amount: 500,
    staff_id: 'staff', category_id: '', center_id: null, milestone: 'delivered', requires_assignment: 0, cap_iqd: null, priority: 0,
    effective_from: '2020-01-01', effective_to: null, created_at: '2020-01-01T00:00:00.000Z', active: 1,
  } as unknown as CostRule;
  const snap = await snapshotFor(db, [{ id: 'l_printer', product_id: 'p_a1' }, { id: 'l_member', product_id: null, line_kind: 'membership' } as never], '2026-11-17T00:00:00.000Z', [rule], '2026-11-17');
  assert.equal(snap.find((x) => x.line_id === 'l_printer')!.rules.length, 1, 'the printer earns the wage rule');
  assert.deepEqual(snap.find((x) => x.line_id === 'l_member')!.rules, [], 'the membership line earns none');
});

test('S6 a blocked purchase is retried by the sweep (no repeated audit while blocked) and starts once the conflict is gone', async () => {
  const { db, raw, env } = setup();
  const a = appAs(db, 'buyer');
  const { order } = await orderWithMembership(a, 'plus_1mo', { useWallet: true });
  deliver(raw, order.id);
  raw.prepare(`INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at,source)
               VALUES ('m_grant','buyer','prime_1mo','prime','active',1,'2026-11-01T00:00:00.000Z','2030-01-01T00:00:00.000Z','admin')`).run();
  assert.deepEqual(await sweepOrderMemberships(env), { scanned: 1, activated: 0, blocked: 1 });
  assert.equal(purchase(raw, order.id).state, 'blocked');
  // Still blocked: the sweep asks again and writes nothing.
  assert.deepEqual(await sweepOrderMemberships(env), { scanned: 1, activated: 0, blocked: 1 });
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'membership.order_blocked'").get()!.n, 1);
  // A person resolves the conflict; the next sweep starts it with no admin retry.
  raw.prepare("UPDATE memberships SET state = 'cancelled' WHERE id = 'm_grant'").run();
  assert.deepEqual(await sweepOrderMemberships(env), { scanned: 1, activated: 1, blocked: 0 });
  assert.equal(purchase(raw, order.id).state, 'active');
  await Promise.allSettled(pending);
});

test('S7 the sweep reads only delivered-and-paid orders: unpaid ones ahead cannot starve a paid one', async () => {
  const { db, raw, env } = setup();
  // An older cash order, delivered but not collected.
  const unpaid = await orderWithMembership(appAs(db, 'buyer2'), 'plus_1mo', { addressId: 'addr_b2' });
  deliver(raw, unpaid.order.id);
  // A newer prepaid order, delivered: ready.
  const paid = await orderWithMembership(appAs(db, 'buyer'), 'plus_1mo', { useWallet: true });
  deliver(raw, paid.order.id);
  raw.prepare("UPDATE order_membership_purchases SET updated_at = '2000-01-01T00:00:00.000Z' WHERE order_id = ?").run(unpaid.order.id);
  assert.deepEqual(await sweepOrderMemberships(env, 1), { scanned: 1, activated: 1, blocked: 0 });
  assert.equal(purchase(raw, paid.order.id).state, 'active');
  assert.equal(purchase(raw, unpaid.order.id).state, 'pending');
  await Promise.allSettled(pending);
});

test('S9 a cancelled order is deleted with its membership purchase row', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'buyer');
  const { order } = await orderWithMembership(a, 'plus_1mo');
  assert.equal((await post(a, `/api/orders/${order.id}/cancel`, {})).status, 200);
  assert.equal(purchase(raw, order.id).state, 'cancelled');
  await Promise.allSettled(pending);
  // The printer's wallet advance is a recorded settlement, retained by its own rule; cleared here so the
  // membership purchase row is what this test puts in the deletion's way (it once failed the FK to order_items).
  raw.prepare('DELETE FROM order_payment_settlements WHERE order_id = ?').run(order.id);
  const res = await deleteCancelledOrder(db as never, order.id);
  assert.equal(res.deleted, true, JSON.stringify(res));
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM order_membership_purchases WHERE order_id = ?').get(order.id)!.n, 0);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM orders WHERE id = ?').get(order.id)!.n, 0);
});

test('S11 kit lines follow the printer line order type and route; the checkout compares the RESOLVED type', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'buyer');
  assert.equal((await post(a, '/api/cart/items', { productId: 'p_a1', qty: 1, services: smart(), kitId: 'a1-starter' })).status, 200);
  const kit = () => raw.prepare('SELECT fulfillment_type, transport_method FROM cart_items WHERE kit_parent_id IS NOT NULL').get() as Record<string, string>;
  // Stored with the printer's RESOLVED type (the printer row itself states none).
  assert.equal((raw.prepare('SELECT fulfillment_type FROM cart_items WHERE id = ?').get(printerId(raw)) as { fulfillment_type: string }).fulfillment_type, '');
  assert.deepEqual([kit().fulfillment_type, kit().transport_method], ['direct_sale', '']);
  // Any door that changes the printer's type or route moves its kit with it (trigger).
  raw.prepare("UPDATE cart_items SET fulfillment_type = 'pre_order', transport_method = 'sea' WHERE id = ?").run(printerId(raw));
  assert.deepEqual([kit().fulfillment_type, kit().transport_method], ['pre_order', 'sea']);
  raw.prepare("UPDATE cart_items SET fulfillment_type = '', transport_method = '' WHERE id = ?").run(printerId(raw));
  assert.deepEqual([kit().fulfillment_type, kit().transport_method], ['direct_sale', '']);
  // '' on the printer and 'direct_sale' on the kit resolve alike: no false KIT_CHANGED.
  const q = await json(await post(a, '/api/orders/quote', orderBody()));
  assert.equal(q.success, true, JSON.stringify(q));
  assert.ok(q.quote.lines.some((l: { kit_line?: unknown }) => l.kit_line));
  // The cart states each row's order type (the page stops guessing it from the route) …
  const cart = await json(await get(a, '/api/cart'));
  const kitItem = cart.items.find((i: { kit_line?: unknown }) => i.kit_line);
  assert.equal(kitItem.fulfillment_type, 'direct_sale');
  // … and an unavailable kit line names its printer and kit.
  raw.prepare("UPDATE products SET status = 'hidden' WHERE id = 'p_pla'").run();
  const gone = await json(await get(a, '/api/cart'));
  const line = gone.unavailable_lines.find((l: { product_id: string }) => l.product_id === 'p_pla');
  assert.ok(line, JSON.stringify(gone.unavailable_lines));
  assert.deepEqual(line.kit_line, { printer_cart_item_id: printerId(raw), kit_id: 'a1-starter', qty_per_printer: 2 });
});

test('S12 the printer and its extras are written in one batch: a failed kit write leaves no printer line behind', async () => {
  const { db, raw } = setup();
  raw.exec(`CREATE TRIGGER test_kit_abort BEFORE INSERT ON cart_items WHEN NEW.kit_parent_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'test_kit_abort'); END;`);
  const a = appAs(db, 'buyer');
  const res: unknown = await Promise.resolve(post(a, '/api/cart/items', { productId: 'p_a1', qty: 1, services: smart(), kitId: 'a1-starter', membershipPlanId: 'plus_1mo' }))
    .catch((e: unknown) => e);
  assert.ok(!(res instanceof Response) || res.status >= 500, 'the add failed');
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM cart_items WHERE user_id = 'buyer'").get()!.n, 0, 'no printer without its kit');
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM cart_membership_choice WHERE user_id = 'buyer'").get()!.n, 0);
  raw.exec('DROP TRIGGER test_kit_abort');
  const ok = await json(await post(a, '/api/cart/items', { productId: 'p_a1', qty: 1, services: smart(), kitId: 'a1-starter', membershipPlanId: 'plus_1mo' }));
  assert.equal(ok.success, true, JSON.stringify(ok));
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM cart_items WHERE user_id = 'buyer' AND kit_parent_id IS NOT NULL").get()!.n, 1);
  assert.equal(raw.prepare("SELECT printer_cart_item_id AS id FROM cart_membership_choice WHERE user_id = 'buyer'").get()!.id, printerId(raw));
});

test('S14 a printer quantity its kit could not follow (× per-unit > 9,999) is refused up front, never clamped', async () => {
  const big: FilamentKit = { ...KIT, items: [{ ...KIT.items[0], qty: 20 }] };
  const { db, raw } = setup({ config: liveConfig({ kits: [big] }), plaStock: 100 });
  const a = appAs(db, 'buyer');
  const added = await json(await post(a, '/api/cart/items', { productId: 'p_a1', qty: 1, services: smart(), kitId: 'a1-starter' }));
  assert.equal(added.success, true, JSON.stringify(added));
  const tooMany = await json(await patch(a, `/api/cart/items/${printerId(raw)}`, { qty: 500 }));
  assert.deepEqual([tooMany.code, tooMany.details?.reason, tooMany.details?.max_printer_qty], ['KIT_UNAVAILABLE', 'KIT_QTY_LIMIT', 499], JSON.stringify(tooMany));
  assert.equal((raw.prepare('SELECT qty FROM cart_items WHERE id = ?').get(printerId(raw)) as { qty: number }).qty, 1, 'nothing written');
  assert.equal((raw.prepare('SELECT qty FROM cart_items WHERE kit_parent_id IS NOT NULL').get() as { qty: number }).qty, 20);
});

test('S16 replaceCart: the membership choice is judged after the cart is emptied', async () => {
  const { db, raw } = setup();
  // A pre-order line of another shipping type holds the cart's membership choice.
  raw.prepare(`INSERT INTO cart_items (id, user_id, product_id, option_id, option_value_ids, color_id, shipping_method_id, transport_method, fulfillment_type, qty)
               VALUES ('ci_old', 'buyer', 'p_pla', '', '[]', '', '', 'sea', 'pre_order', 1)`).run();
  raw.prepare("INSERT INTO cart_membership_choice (user_id, plan_id, printer_cart_item_id) VALUES ('buyer', 'plus_1mo', 'ci_old')").run();
  const a = appAs(db, 'buyer');
  const without = await json(await post(a, '/api/cart/items', { productId: 'p_a1', qty: 1, services: smart(), membershipPlanId: 'plus_1mo' }));
  assert.ok(without.code === 'CART_SHIPPING_CONFLICT' || without.code === 'CART_MEMBERSHIP_CONFLICT', JSON.stringify(without));
  const replaced = await json(await post(a, '/api/cart/items', { productId: 'p_a1', qty: 1, services: smart(), membershipPlanId: 'plus_1mo', replaceCart: true }));
  assert.equal(replaced.success, true, JSON.stringify(replaced));
  assert.equal(raw.prepare("SELECT printer_cart_item_id AS id FROM cart_membership_choice WHERE user_id = 'buyer'").get()!.id, printerId(raw));
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM cart_items WHERE id = 'ci_old'").get()!.n, 0);
});

test('S17 a membership that became unavailable: GET /api/cart and the quote answer {ok:false, code, plan_id} (total without it); the order door refuses; removing it clears the way', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'buyer');
  assert.equal((await post(a, '/api/cart/items', { productId: 'p_a1', qty: 1, services: smart() })).status, 200);
  const plain = (await json(await post(a, '/api/orders/quote', orderBody()))).quote;
  assert.equal((await put(a, `/api/cart/items/${printerId(raw)}/extras`, { membershipPlanId: 'plus_1mo' })).status, 200);
  raw.prepare("UPDATE membership_plans SET price_iqd = NULL WHERE id = 'plus_1mo'").run();
  const cartRes = await get(a, '/api/cart');
  assert.equal(cartRes.status, 200);
  const cart = await json(cartRes);
  const mq = cart.printer_extras.membership.quote;
  assert.deepEqual([mq.ok, mq.code, mq.plan_id, mq.printer_cart_item_id], [false, 'PLAN_UNPRICED', 'plus_1mo', printerId(raw)]);
  const quoteRes = await post(a, '/api/orders/quote', orderBody());
  assert.equal(quoteRes.status, 200, 'the quote does not throw');
  const q = (await json(quoteRes)).quote;
  assert.deepEqual([q.membership.ok, q.membership.code, q.membership.plan_id, q.membership.printer_cart_item_id], [false, 'PLAN_UNPRICED', 'plus_1mo', printerId(raw)]);
  assert.equal(q.total_iqd, plain.total_iqd);
  const refused = await json(await post(a, '/api/orders', orderBody()));
  assert.equal(refused.code, 'PLAN_UNPRICED');
  assert.equal((await put(a, `/api/cart/items/${printerId(raw)}/extras`, { membershipPlanId: null })).status, 200);
  const placed = await json(await post(a, '/api/orders', orderBody()));
  assert.equal(placed.success, true, JSON.stringify(placed));
  await Promise.allSettled(pending);
});
