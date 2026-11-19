/**
 * «خصص طابعتك» phase 7 (owner, 2026-11-20; DECISIONS row 363) — the two delivery switches:
 *
 *  - `delivery.personal_active: false` — Personal is DISABLED, not deleted: offered nowhere, a choice
 *    that says Personal is priced and recorded as Economy (never refused), its prices stay stored,
 *    and the PRO services discount no longer names it.
 *  - `delivery.choose_at: 'checkout'` — the printer's delivery is decided by the checkout's method:
 *    no door before the order asks for it, home delivery charges the class's ECONOMY fee as the
 *    `printer_service` shipping component, the store's pickup method is free, and the snapshot
 *    records it exactly as if the customer had chosen it.
 *  - A list WITHOUT the two fields answers byte-identically at every door (product quote, cart
 *    line, order quote) to one that says the defaults aloud.
 *
 * Run: node --import tsx --test tests/printerServicesPhase7.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { ROOT, SqliteD1 } from './fixtures/d1';
import type { AppContext } from '../worker/lib/types';
import { HttpError } from '../worker/lib/http';
import { cartRoutes } from '../worker/routes/cart';
import { orderRoutes } from '../worker/routes/orders';
import { productRoutes } from '../worker/routes/products';
import { policiesRoutes } from '../worker/routes/policies';
import { adminPrinterServiceRoutes } from '../worker/routes/adminPrinterServices';
import { classifyHost } from '../worker/lib/hosts';
import { acceptedPolicies } from './lib/policies';
import { PRINTER_STANDARD_DELIVERY_POLICY } from '../packages/shipping/src/printerDeliveryPolicy';
import { resetPolicyCorpusMemo } from '../worker/lib/policySync';
import { autoPublishFromEnv } from './fixtures/autoPublish';
import { forgetPricingInputs } from '../worker/lib/membershipBenefits';
import { keepPhase6Fields, servicesForMethod } from '../worker/lib/printerServices';
import {
  DEFAULT_PRINTER_SERVICES, EMPTY_SELECTION,
  canonicalConfig, configIssues, deliveryChooseAtOf, effectiveDelivery, encodeSelection, personalActiveOf,
  presetSelection, priceServices, publishIssues, servicesAtCheckout, servicesOffer, settledSelectionText,
  type PrinterServicesConfig, type ServiceSelection,
} from '../packages/pricing/src/printerServices';

const A1 = { warranty_family: 'a1', delivery_class: 'd1' } as const;
const clone = (): PrinterServicesConfig => JSON.parse(JSON.stringify(DEFAULT_PRINTER_SERVICES));
/** p_a1 = class d1 (Economy 5,000 / Personal 15,000); p_big = class d2 (Economy 10,000 / Personal 35,000). */
function liveConfig(over: (c: PrinterServicesConfig) => void = () => undefined): PrinterServicesConfig {
  const c = clone();
  c.revision = 1;
  c.products = { p_a1: { warranty_family: 'a1', delivery_class: 'd1' }, p_big: { warranty_family: 'xpa2', delivery_class: 'd2' } };
  over(c);
  return c;
}
const atCheckout = (c: PrinterServicesConfig) => { c.delivery.choose_at = 'checkout'; c.delivery.personal_active = false; };
const pkg = (c: PrinterServicesConfig, id: 'just' | 'smart' | 'complete', delivery: ServiceSelection['delivery']): ServiceSelection =>
  ({ ...presetSelection(c, id, delivery), confirmed: true, ack_no_warranty: id === 'just' });

// ================================================================== the pure half

test('a list without the two switches reads as «Personal on, chosen on the product page» and prices byte-identically to one that says so', () => {
  const old = liveConfig();
  assert.equal('personal_active' in old.delivery, false);
  assert.equal('choose_at' in old.delivery, false);
  assert.deepEqual([personalActiveOf(old), deliveryChooseAtOf(old)], [true, 'product']);
  assert.deepEqual(configIssues(old), []);
  const canon = canonicalConfig(old);
  assert.equal('personal_active' in canon.delivery, false, 'nothing is written into a list that never had the switch');
  assert.equal('choose_at' in canon.delivery, false);
  const aloud = liveConfig((c) => { c.delivery.personal_active = true; c.delivery.choose_at = 'product'; });
  assert.deepEqual(configIssues(aloud), []);
  assert.deepEqual([canonicalConfig(aloud).delivery.personal_active, canonicalConfig(aloud).delivery.choose_at], [true, 'product']);
  assert.equal(JSON.stringify(servicesOffer(aloud, A1)), JSON.stringify(servicesOffer(old, A1)));
  for (const d of ['economy', 'personal', 'pickup', null] as const) {
    assert.equal(effectiveDelivery(old, d), d);
    const sel = pkg(old, 'complete', d);
    const p = priceServices(old, A1, sel);
    assert.equal(p.selection, sel, 'the very same selection object: nothing was rewritten');
    assert.equal(JSON.stringify(priceServices(aloud, A1, sel)), JSON.stringify(p));
    assert.equal(JSON.stringify(priceServices(aloud, A1, sel, { pro: true })), JSON.stringify(priceServices(old, A1, sel, { pro: true })));
    assert.equal(servicesAtCheckout(old, p), p, 'the order derives nothing');
    assert.equal(settledSelectionText(old, encodeSelection(sel)), encodeSelection(sel));
  }
  assert.deepEqual(servicesOffer(old, A1).delivery, { economy: 5_000, personal: 15_000 });
});

test('configIssues: personal_active is a boolean, choose_at is product or checkout; a page that omits them keeps the stored ones', () => {
  const bad = liveConfig() as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  bad.delivery.personal_active = 'no';
  bad.delivery.choose_at = 'cart';
  assert.deepEqual(configIssues(bad), ['delivery.personal_active: boolean', 'delivery.choose_at: product or checkout']);
  const ok = liveConfig(atCheckout);
  assert.deepEqual([configIssues(ok), publishIssues(ok)], [[], []]);
  assert.deepEqual(canonicalConfig(canonicalConfig(ok)), canonicalConfig(ok));
  // The Personal prices stay stored while it is disabled.
  assert.deepEqual(canonicalConfig(ok).delivery.classes.d1, { economy_iqd: 5_000, personal_iqd: 15_000 });
  const older = JSON.parse(JSON.stringify(ok)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  delete older.delivery.personal_active; delete older.delivery.choose_at;
  keepPhase6Fields(older, ok);
  assert.deepEqual([older.delivery.personal_active, older.delivery.choose_at], [false, 'checkout']);
  const never = JSON.parse(JSON.stringify(liveConfig())) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  keepPhase6Fields(never, liveConfig());
  assert.equal('personal_active' in never.delivery || 'choose_at' in never.delivery, false, 'a draft that never had them stays without them');
});

test('Personal disabled: not offered, a Personal choice is priced and recorded as Economy, and PRO\'s discount does not bring it back', () => {
  const c = liveConfig((x) => { x.delivery.personal_active = false; });
  assert.deepEqual(servicesOffer(c, A1).delivery, { economy: 5_000, personal: null, personal_active: false });
  const p = priceServices(c, A1, pkg(c, 'smart', 'personal'));
  assert.deepEqual([p.blockers, p.selection.delivery, p.delivery_fee_iqd, p.delivery_options], [[], 'economy', 5_000, { economy_iqd: 5_000, personal_iqd: null }]);
  assert.equal(JSON.stringify(p), JSON.stringify(priceServices(c, A1, pkg(c, 'smart', 'economy'))), 'exactly the Economy choice');
  // An active PRO: the services are still discounted, Personal is named nowhere and nothing is taken off Economy.
  const pro = priceServices(c, A1, pkg(c, 'smart', 'personal'), { pro: true });
  assert.deepEqual([pro.selection.delivery, pro.delivery_fee_iqd, pro.delivery_options.personal_iqd], ['economy', 5_000, null]);
  assert.deepEqual(pro.pro_discount, { pct: 50, services_iqd: 22_000, personal_before_iqd: null, personal_iqd: 0 });
  // Economy and the pickup are untouched.
  assert.equal(priceServices(c, A1, pkg(c, 'smart', null)).delivery_fee_iqd, null);
  assert.equal(effectiveDelivery(c, 'pickup'), 'pickup');
  assert.equal(settledSelectionText(c, encodeSelection(pkg(c, 'just', 'personal'))), encodeSelection(pkg(c, 'just', 'economy')));
});

test('decided at checkout: no door before the order reads a delivery; the order derives Economy exactly as a customer\'s own choice', () => {
  const c = liveConfig(atCheckout);
  const product = liveConfig((x) => { x.delivery.personal_active = false; });
  assert.deepEqual(servicesOffer(c, A1).delivery, { economy: 5_000, personal: null, personal_active: false, choose_at: 'checkout' });
  for (const d of ['economy', 'personal', 'pickup', null] as const) {
    const p = priceServices(c, A1, pkg(c, 'complete', d));
    assert.deepEqual([p.blockers, p.selection.delivery, p.delivery_fee_iqd], [[], null, null], String(d));
    assert.equal(settledSelectionText(c, encodeSelection(pkg(c, 'complete', d))), encodeSelection(pkg(c, 'complete', null)));
    // Home delivery: byte for byte what the same list, with the choice on the product page, records for Economy.
    const home = servicesAtCheckout(c, p);
    assert.equal(JSON.stringify(home), JSON.stringify(priceServices(product, A1, pkg(product, 'complete', 'economy'))), String(d));
    assert.equal(JSON.stringify(servicesForMethod(home, 'standard')), JSON.stringify(servicesForMethod(priceServices(product, A1, pkg(product, 'complete', 'economy')), 'standard')));
    // The store's pickup method: the phase 1 record — «pickup», no fee.
    const picked = servicesForMethod(home, 'pickup') as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.deepEqual([picked.selection.delivery, 'delivery_fee_iqd' in picked], ['pickup', false]);
  }
  // An unpriced class is never given an invented fee.
  const unpriced = liveConfig((x) => { atCheckout(x); x.delivery.classes.d1.economy_iqd = null; });
  assert.equal(servicesAtCheckout(unpriced, priceServices(unpriced, A1, pkg(unpriced, 'smart', null))).delivery_fee_iqd, null);
  // With Personal still on, the checkout decides all the same: home delivery is Economy.
  const both = liveConfig((x) => { x.delivery.choose_at = 'checkout'; });
  assert.deepEqual([effectiveDelivery(both, 'personal'), servicesAtCheckout(both, priceServices(both, A1, pkg(both, 'smart', 'personal'))).delivery_fee_iqd], [null, 5_000]);
});

// ================================================================== the doors

const OPS = JSON.stringify({ serialized: true, warranty_base_months: 12 });

function setup(config: PrinterServicesConfig) {
  resetPolicyCorpusMemo();
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) raw.exec(readFileSync(join(dir, f), 'utf8'));
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','s@x.co','h','customer'), ('owner','Owner','owner@x.co','h','admin');
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,is_default) VALUES
      ('addr_b','buyer','Home','Sara','+9647701234567','Baghdad, Karrada 12','',1);
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status) VALUES
      ('dep_b','buyer','deposit','USD',900000,'approved');
  `);
  raw.prepare(
    `INSERT INTO products (id,slug,name,name_ar,price_iqd,prime_price_iqd,pro_price_iqd,status,stock,options,colors,selling_type,sale_types,warranty_plans,ops_policy,images)
     VALUES ('p_a1','a1-printer','Printer A1','طابعة A1',840000,NULL,NULL,'active',50,'[]','[]','direct_sale','["direct_sale"]','[]',?,'[]'),
            ('p_big','big-printer','Printer X2','طابعة X2',1500000,NULL,NULL,'active',50,'[]','[]','direct_sale','["direct_sale"]','[]',?,'[]')`
  ).run(OPS, OPS);
  raw.exec(`
    INSERT INTO catalogs (id, slug, name_ar, is_printer_catalog) VALUES ('cat_p','test-p7-printers','طابعات',1);
    INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES ('p_a1','cat_p',0), ('p_big','cat_p',1);
  `);
  const db = new SqliteD1(raw) as unknown as D1Database;
  setList(raw, db, config);
  return { raw, db };
}
function setList(raw: DatabaseSync, db: D1Database, config: PrinterServicesConfig) {
  raw.prepare('INSERT INTO admin_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    'printerServices', JSON.stringify({ draft: config, published: config, published_at: '2026-11-20T00:00:00.000Z', published_by: 'owner' }));
  forgetPricingInputs(db);
}

function appAs(db: D1Database, userId: string, role: 'customer' | 'admin' = 'customer') {
  const a = new Hono<AppContext>();
  a.use('*', async (c, next) => {
    c.set('user', { id: userId, role, email: `${userId}@x.co`, username: userId, email_verified_at: '2026-01-01T00:00:00.000Z' } as never);
    c.set('host', classifyHost('levonis-iq.com', 'levonis-iq.com'));
    c.env = { DB: db, APP_ORIGIN: 'https://levonis-iq.com', STORE_ROOT_DOMAIN: 'levonis-iq.com', INITIAL_ADMIN_EMAIL: 'owner@x.co' } as never;
    await next();
  });
  a.use('*', autoPublishFromEnv);
  a.route('/api/cart', cartRoutes);
  a.route('/api/orders', orderRoutes);
  a.route('/api/products', productRoutes);
  a.route('/api/policies', policiesRoutes);
  a.route('/api/admin/printer-services', adminPrinterServiceRoutes);
  a.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ success: false, error: err.message, code: err.code, details: err.details ?? null }, err.status as 400);
    throw err;
  });
  return a;
}

const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p.catch(() => undefined)); }, passThroughOnException() {} } as unknown as ExecutionContext;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response) => (await res.json()) as Record<string, any>;
const send = (a: ReturnType<typeof appAs>, method: string, path: string, body?: unknown) =>
  a.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, undefined, ctx);
const post = (a: ReturnType<typeof appAs>, path: string, body: unknown) => send(a, 'POST', path, body);
const put = (a: ReturnType<typeof appAs>, path: string, body: unknown) => send(a, 'PUT', path, body);
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
  idempotencyKey: `p7-${Date.now()}-${++seq}`,
  policyAcceptance: acceptedPolicies(),
  ...over,
});
const strip = (v: unknown) => JSON.stringify(v)
  .replace(/"(id|cart_item_id|product_image|added_at|created_at|updated_at|quote_id|expires_at)":"[^"]*"/g, '"$1":"·"')
  .replace(/ci_[0-9a-f]+/g, 'ci_·').replace(/oi_[0-9a-f]+/g, 'oi_·');

test('back-compat pin: without the switches the product quote, the cart line and the order quote are byte-identical to a list saying the defaults', async () => {
  const answers: string[][] = [];
  for (const config of [liveConfig(), liveConfig((c) => { c.delivery.personal_active = true; c.delivery.choose_at = 'product'; })]) {
    const { db, raw } = setup(config);
    const a = appAs(db, 'buyer');
    const services = pkg(config, 'complete', 'personal');
    const q = await json(await post(a, '/api/products/a1-printer/quote', { qty: 2, services }));
    assert.equal((await post(a, '/api/cart/items', { productId: 'p_a1', qty: 2, services })).status, 200);
    const cart = await json(await get(a, '/api/cart'));
    const oq = await json(await post(a, '/api/orders/quote', orderBody({ idempotencyKey: 'p7-pin' })));
    assert.equal(oq.success, true, JSON.stringify(oq));
    assert.equal('printer_delivery' in oq.quote, false);
    answers.push([strip(q), strip(cart.items[0]), strip(oq.quote)]);
    raw.close();
  }
  assert.equal(answers[0][0], answers[1][0], 'product quote');
  assert.equal(answers[0][1], answers[1][1], 'cart line');
  assert.equal(answers[0][2], answers[1][2], 'order quote');
  // The recorded figures (phase 5/6): Personal 15,000 per printer, chosen on the product page, still charged.
  const line = JSON.parse(answers[0][1]);
  assert.deepEqual([line.printer_services.selection.delivery, line.printer_services.priced.delivery_fee_iqd, line.printer_services.offer.delivery], ['personal', 15_000, { economy: 5_000, personal: 15_000 }]);
  const quote = JSON.parse(answers[0][2]);
  const comp = quote.shipping.components.find((x: { kind: string }) => x.kind === 'printer_service');
  assert.deepEqual([comp.printer_delivery, comp.fee_iqd], ['personal', 30_000]);
});

test('without the switches a printer with no delivery chosen is still refused at the order, as before', async () => {
  const c = liveConfig();
  const { db, raw } = setup(c);
  const a = appAs(db, 'buyer');
  assert.equal((await post(a, '/api/cart/items', { productId: 'p_a1', qty: 1, services: pkg(c, 'smart', null) })).status, 200);
  assert.equal((await json(await post(a, '/api/orders', orderBody()))).code, 'SERVICES_DELIVERY_REQUIRED');
  raw.close();
});

test('decided at checkout — cart = order quote = order, home delivery and pickup, anchored and not, qty 2 and two printers of different classes', async () => {
  for (const anchor of ['none', 'smart'] as const) {
    // The reference: the same list with the choice on the product page and Economy chosen by the customer.
    const figures: Record<string, unknown[]> = {};
    for (const mode of ['product', 'checkout'] as const) {
      const c = liveConfig((x) => { x.price_anchor = anchor; x.delivery.personal_active = false; if (mode === 'checkout') x.delivery.choose_at = 'checkout'; });
      const d = mode === 'product' ? 'economy' : null;
      const { db, raw } = setup(c);
      const a = appAs(db, 'buyer');
      // The product quote asks for no delivery and carries no blocker.
      const q = await json(await post(a, '/api/products/a1-printer/quote', { qty: 2, services: pkg(c, 'just', d) }));
      assert.deepEqual(q.printer_services.selection.blockers, [], `${anchor}/${mode}`);
      if (mode === 'checkout') {
        assert.deepEqual([q.printer_services.selection.delivery_fee_iqd, q.printer_services.offer.delivery.choose_at, q.printer_services.offer.delivery.personal], [null, 'checkout', null]);
      }
      for (const [productId, qty, id] of [['p_a1', 2, 'just'], ['p_big', 1, 'complete']] as const) {
        const added = await post(a, '/api/cart/items', { productId, qty, services: pkg(c, id, d) });
        assert.equal(added.status, 200, `${anchor}/${mode}: ${JSON.stringify(await json(added.clone()))}`);
      }
      const cart = await json(await get(a, '/api/cart'));
      const lines = [...cart.items].sort((x, y) => String(x.productId).localeCompare(String(y.productId)));
      assert.deepEqual(lines.map((l) => l.printer_services.needs_choice), [false, false]);
      if (mode === 'checkout') {
        assert.deepEqual(lines.map((l) => [l.printer_services.selection.delivery, l.printer_services.priced.delivery_fee_iqd, l.printer_services.priced.blockers]), [[null, null, []], [null, null, []]], 'the cart line shows no delivery before checkout');
      }
      const cartSubtotal = lines.reduce((n, l) => n + l.unit_price_iqd * l.qty, 0);

      const oq = await json(await post(a, '/api/orders/quote', orderBody()));
      assert.equal(oq.success, true, `${anchor}/${mode}: ${JSON.stringify(oq)}`);
      assert.equal(oq.quote.subtotal_iqd, cartSubtotal, `${anchor}/${mode}: order quote = cart`);
      const comps = oq.quote.shipping.components.filter((x: { kind: string }) => x.kind === 'printer_service')
        .map((x: Record<string, unknown>) => [x.product_id, x.delivery_class, x.printer_delivery, x.units, x.fee_iqd]).sort();
      assert.deepEqual(comps, [['p_a1', 'd1', 'economy', 2, 10_000], ['p_big', 'd2', 'economy', 1, 10_000]], `${anchor}/${mode}: the class's Economy fee per printer`);
      assert.deepEqual(oq.quote.shipping.needs_config, []);
      assert.equal('printer_pickup' in oq.quote, false);
      if (mode === 'checkout') {
        assert.deepEqual([oq.quote.printer_delivery.choose_at, oq.quote.printer_delivery.delivery, oq.quote.printer_delivery.cart_item_ids.length], ['checkout', 'economy', 2]);
        const std = oq.quote.delivery_method_fees.find((f: { id: string }) => f.id === 'standard');
        assert.equal(std.fee_iqd, oq.quote.shipping.total_iqd, 'the home method\'s card shows the fee the quote computed');
      } else assert.equal('printer_delivery' in oq.quote, false);

      // The pickup method quotes no delivery at all.
      const pq = await json(await post(a, '/api/orders/quote', orderBody({ deliveryMethodId: 'pickup' })));
      assert.deepEqual([pq.success, pq.quote.subtotal_iqd, pq.quote.shipping.total_iqd], [true, cartSubtotal, 0], `${anchor}/${mode}: pickup`);
      if (mode === 'checkout') assert.equal(pq.quote.printer_delivery.delivery, 'pickup');

      const placed = await post(a, '/api/orders', orderBody());
      const body = await json(placed);
      assert.equal(placed.status, 200, `${anchor}/${mode}: ${JSON.stringify(body)}`);
      const order = raw.prepare('SELECT subtotal_iqd, shipping_iqd, total_iqd, merchandise_iqd FROM orders WHERE id = ?').get(body.order.id) as Record<string, unknown>;
      assert.deepEqual([Number(order.subtotal_iqd), Number(order.shipping_iqd), Number(order.total_iqd)], [oq.quote.subtotal_iqd, oq.quote.shipping.total_iqd, oq.quote.total_iqd], `${anchor}/${mode}: order = order quote`);
      assert.equal(Number(order.shipping_iqd), 20_000, `${anchor}/${mode}`);
      const rows = raw.prepare('SELECT product_id, qty, unit_price_iqd, services_snapshot FROM order_items WHERE order_id = ? ORDER BY product_id').all(body.order.id) as Array<Record<string, unknown>>;
      const snaps = rows.map((r) => JSON.parse(String(r.services_snapshot)));
      assert.deepEqual(snaps.map((s) => [s.selection.delivery, s.delivery_fee_iqd]), [['economy', 5_000], ['economy', 10_000]], `${anchor}/${mode}: recorded as chosen`);
      const views = [...body.order.items].sort((x, y) => String(x.product_id).localeCompare(String(y.product_id)));
      assert.deepEqual(views.map((v) => [v.services.delivery, v.services.delivery_fee_iqd]), [['economy', 5_000], ['economy', 10_000]]);
      figures[mode] = [order, rows.map((r) => [r.product_id, r.qty, r.unit_price_iqd, r.services_snapshot]), strip(oq.quote.shipping), oq.quote.total_iqd, strip(pq.quote.shipping)];
      raw.close();
    }
    assert.deepEqual(figures.checkout, figures.product, `${anchor}: every figure and every snapshot equals the customer's own Economy choice`);
  }
});

test('decided at checkout — the store\'s pickup method: free, recorded «pickup», never the «choose pickup» demand', async () => {
  const c = liveConfig((x) => { atCheckout(x); x.price_anchor = 'smart'; x.delivery.pickup = { active: true, note: null }; });
  const { db, raw } = setup(c);
  const a = appAs(db, 'buyer');
  assert.equal((await post(a, '/api/cart/items', { productId: 'p_a1', qty: 2, services: pkg(c, 'smart', null) })).status, 200);
  const placed = await post(a, '/api/orders', orderBody({ deliveryMethodId: 'pickup' }));
  const body = await json(placed);
  assert.equal(placed.status, 200, JSON.stringify(body));
  const order = raw.prepare('SELECT shipping_iqd, subtotal_iqd FROM orders WHERE id = ?').get(body.order.id) as Record<string, unknown>;
  assert.deepEqual([Number(order.shipping_iqd ?? 0), Number(order.subtotal_iqd)], [0, 840_000 * 2]);
  assert.deepEqual([body.order.items[0].services.delivery, body.order.items[0].services.delivery_fee_iqd], ['pickup', null]);
  raw.close();
});

test('a line stored before the switch (Personal, or warehouse pickup) is not refused: the checkout method decides, and a re-add is the same line', async () => {
  for (const was of ['personal', 'pickup'] as const) {
    const before = liveConfig((x) => { x.delivery.pickup = { active: true, note: null }; });
    const { db, raw } = setup(before);
    const a = appAs(db, 'buyer');
    assert.equal((await post(a, '/api/cart/items', { productId: 'p_a1', qty: 1, services: pkg(before, 'smart', was) })).status, 200);
    const after = liveConfig((x) => { x.revision = 2; x.delivery.pickup = { active: true, note: null }; atCheckout(x); });
    setList(raw, db, after);
    const cart = await json(await get(a, '/api/cart'));
    assert.deepEqual([cart.items[0].printer_services.selection.delivery, cart.items[0].printer_services.priced.delivery_fee_iqd, cart.items[0].printer_services.priced.blockers], [null, null, []], was);
    // The new page sends no delivery: the same purchase, the same line (never «a different package»).
    const again = await post(a, '/api/cart/items', { productId: 'p_a1', qty: 1, services: pkg(after, 'smart', null) });
    assert.equal(again.status, 200, `${was}: ${JSON.stringify(await json(again.clone()))}`);
    assert.deepEqual((raw.prepare("SELECT qty FROM cart_items WHERE user_id = 'buyer'").all() as Array<{ qty: number }>).map((r) => r.qty), [2], was);
    const oq = await json(await post(a, '/api/orders/quote', orderBody()));
    assert.equal('printer_pickup' in oq.quote, false, was);
    const placed = await post(a, '/api/orders', orderBody());
    const body = await json(placed);
    assert.equal(placed.status, 200, `${was}: ${JSON.stringify(body)}`);
    assert.deepEqual([body.order.items[0].services.delivery, body.order.items[0].services.delivery_fee_iqd, Number(body.order.shipping_iqd)], ['economy', 5_000, 10_000], was);
    raw.close();
  }
});

test('Personal disabled with the choice still on the product page: a stored or posted Personal is Economy at every door', async () => {
  const before = liveConfig();
  const { db, raw } = setup(before);
  const a = appAs(db, 'buyer');
  assert.equal((await post(a, '/api/cart/items', { productId: 'p_a1', qty: 2, services: pkg(before, 'smart', 'personal') })).status, 200);
  const off = liveConfig((x) => { x.revision = 2; x.delivery.personal_active = false; });
  setList(raw, db, off);
  const cart = await json(await get(a, '/api/cart'));
  assert.deepEqual([cart.items[0].printer_services.selection.delivery, cart.items[0].printer_services.priced.delivery_fee_iqd, cart.items[0].printer_services.priced.blockers, cart.items[0].printer_services.offer.delivery],
    ['economy', 5_000, [], { economy: 5_000, personal: null, personal_active: false }]);
  const q = await json(await post(a, '/api/products/big-printer/quote', { qty: 1, services: pkg(off, 'smart', 'personal') }));
  assert.deepEqual([q.printer_services.selection.delivery_fee_iqd, q.printer_services.selection.blockers], [10_000, []]);
  assert.equal((await post(a, '/api/cart/items', { productId: 'p_big', qty: 1, services: pkg(off, 'smart', 'personal') })).status, 200);
  assert.equal(JSON.parse((raw.prepare("SELECT services FROM cart_items WHERE product_id = 'p_big'").get() as { services: string }).services).delivery, 'economy', 'stored as Economy');
  const placed = await post(a, '/api/orders', orderBody());
  const body = await json(placed);
  assert.equal(placed.status, 200, JSON.stringify(body));
  assert.equal(Number(body.order.shipping_iqd), 5_000 * 2 + 10_000);
  for (const it of body.order.items) assert.equal(it.services.delivery, 'economy');
  raw.close();
});

test('admin: the draft saves the two switches, a page that omits them keeps them, and the published list is what customers are quoted', async () => {
  const { db, raw } = setup(liveConfig());
  const owner = appAs(db, 'owner', 'admin');
  const first = await json(await get(owner, '/api/admin/printer-services'));
  assert.equal('choose_at' in first.draft.delivery || 'personal_active' in first.draft.delivery, false);
  const draft = { ...first.draft, delivery: { ...first.draft.delivery, personal_active: false, choose_at: 'checkout' } };
  const saved = await json(await put(owner, '/api/admin/printer-services/draft', { draft, base_revision: first.draft.revision }));
  assert.equal(saved.success, true, JSON.stringify(saved));
  assert.deepEqual([saved.draft.delivery.personal_active, saved.draft.delivery.choose_at, saved.draft.delivery.classes.d1.personal_iqd, saved.publish_issues], [false, 'checkout', 15_000, []]);
  const older = JSON.parse(JSON.stringify(saved.draft));
  delete older.delivery.personal_active; delete older.delivery.choose_at;
  const again = await json(await put(owner, '/api/admin/printer-services/draft', { draft: older, base_revision: saved.draft.revision }));
  assert.deepEqual([again.draft.delivery.personal_active, again.draft.delivery.choose_at], [false, 'checkout']);
  const bad = await json(await put(owner, '/api/admin/printer-services/draft', { draft: { ...again.draft, delivery: { ...again.draft.delivery, choose_at: 'cart' } }, base_revision: again.draft.revision }));
  assert.equal(bad.code, 'PRINTER_SERVICES_INVALID');
  const live = await json(await post(owner, '/api/admin/printer-services/publish', { base_revision: again.draft.revision }));
  assert.equal(live.success, true, JSON.stringify(live));
  forgetPricingInputs(db);
  const q = await json(await post(appAs(db, 'buyer'), '/api/products/a1-printer/quote', { qty: 1, services: { ...EMPTY_SELECTION, package: 'just', confirmed: true, ack_no_warranty: true } }));
  assert.deepEqual([q.printer_services.offer.delivery, q.printer_services.selection.blockers], [{ economy: 5_000, personal: null, personal_active: false, choose_at: 'checkout' }, []]);
  raw.close();
});
