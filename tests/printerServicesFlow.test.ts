/**
 * «خصص طابعتك» end to end (owner brief 2026-11-17; DECISIONS row 339): the
 * owner publishes the price list, a mapped printer is quoted with its offer,
 * the cart refuses a printer with no confirmed choice, the checkout freezes
 * the priced choice, writes the warehouse's tasks and charges the printer's
 * own delivery, and the delivered units record the bought TOTAL months.
 *
 * Fixture pattern: tests/extendedWarranty.test.ts (a real SQLite with every
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
import { cartRoutes, CART_SERVICES_CONFLICT } from '../worker/routes/cart';
import { orderRoutes } from '../worker/routes/orders';
import { productRoutes } from '../worker/routes/products';
import { policiesRoutes } from '../worker/routes/policies';
import { adminRoutes } from '../worker/routes/admin';
import { adminOrderServiceTaskRoutes, adminPrinterServiceRoutes } from '../worker/routes/adminPrinterServices';
import { classifyHost } from '../worker/lib/hosts';
import { createUnitsOnDelivery, recomputeUnitWindow, type UnitRow } from '../worker/lib/deviceOps';
import { moveOrderStage } from '../worker/lib/orderStageOps';
import { addMonths } from '../worker/lib/membershipOps';
import { acceptedPolicies } from './lib/policies';
import { PRINTER_STANDARD_DELIVERY_POLICY } from '../packages/shipping/src/printerDeliveryPolicy';
import { resetPolicyCorpusMemo } from '../worker/lib/policySync';
import { autoPublishFromEnv } from './fixtures/autoPublish';
import { DEFAULT_PRINTER_SERVICES, presetSelection, EMPTY_SELECTION, type ServiceSelection } from '../packages/pricing/src/printerServices';
import { forgetPricingInputs } from '../worker/lib/membershipBenefits';

const OPS = JSON.stringify({ serialized: true, warranty_base_months: 12 });

function setup(opts: { publish?: boolean } = {}) {
  resetPolicyCorpusMemo();
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) raw.exec(readFileSync(join(dir, f), 'utf8'));
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','s@x.co','h','customer'),
      ('owner','Owner','owner@x.co','h','admin'),
      ('staff','Staff','staff@x.co','h','admin');
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,is_default) VALUES
      ('addr_b','buyer','Home','Sara','+9647701234567','Baghdad, Karrada 12','',1);
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status) VALUES
      ('dep_b','buyer','deposit','USD',200000,'approved');
  `);
  raw
    .prepare(
      `INSERT INTO products (id,slug,name,name_ar,price_iqd,prime_price_iqd,pro_price_iqd,status,stock,options,colors,selling_type,sale_types,warranty_plans,ops_policy,images)
       VALUES ('p_a1','a1-printer','Printer A1','طابعة A1',840000,NULL,NULL,'active',5,'[]','[]','direct_sale','["direct_sale"]','[]',?,'[]'),
              ('p_pla','pla-basic','PLA Basic','PLA أساسي',25000,NULL,NULL,'active',50,'[]','[]','direct_sale','["direct_sale"]','[]','{}','[]')`
    )
    .run(OPS);
  raw.exec(`
    INSERT INTO catalogs (id, slug, name_ar, is_printer_catalog) VALUES
      ('cat_p','test-ps-printers','طابعات',1), ('cat_f','test-ps-filaments','خيوط',0);
    INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES ('p_a1','cat_p',0), ('p_pla','cat_f',0);
  `);
  if (opts.publish !== false) {
    const live = { ...DEFAULT_PRINTER_SERVICES, revision: 1, products: { p_a1: { warranty_family: 'a1', delivery_class: 'd1' } } };
    raw.prepare('INSERT INTO admin_settings (key, value) VALUES (?, ?)').run(
      'printerServices',
      JSON.stringify({ draft: live, published: live, published_at: '2026-11-17T00:00:00.000Z', published_by: 'owner' })
    );
  }
  return { raw, db: new SqliteD1(raw) as unknown as D1Database };
}

function appAs(db: D1Database, userId: string, role: 'customer' | 'admin' = 'customer', extraEnv: Record<string, string> = {}) {
  const a = new Hono<AppContext>();
  a.use('*', async (c, next) => {
    c.set('user', { id: userId, role, email: `${userId}@x.co`, username: userId, email_verified_at: '2026-01-01T00:00:00.000Z' } as never);
    c.set('host', classifyHost('levonis-iq.com', 'levonis-iq.com'));
    c.env = { DB: db, APP_ORIGIN: 'https://levonis-iq.com', STORE_ROOT_DOMAIN: 'levonis-iq.com', INITIAL_ADMIN_EMAIL: 'owner@x.co', ...extraEnv } as never;
    await next();
  });
  a.use('*', autoPublishFromEnv);
  a.route('/api/cart', cartRoutes);
  a.route('/api/orders', orderRoutes);
  a.route('/api/products', productRoutes);
  a.route('/api/policies', policiesRoutes);
  a.route('/api/admin/printer-services', adminPrinterServiceRoutes);
  a.route('/api/admin/order-service-tasks', adminOrderServiceTaskRoutes);
  a.route('/api/admin', adminRoutes);
  a.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ success: false, error: err.message, code: err.code, details: err.details ?? null }, err.status as 400);
    }
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
const patch = (a: ReturnType<typeof appAs>, path: string, body: unknown) => send(a, 'PATCH', path, body);
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
  idempotencyKey: `ps-${Date.now()}-${++seq}`,
  policyAcceptance: acceptedPolicies(),
  ...over,
});

const smart = (delivery: ServiceSelection['delivery'] = 'personal'): ServiceSelection => ({ ...presetSelection(DEFAULT_PRINTER_SERVICES, 'smart', delivery), confirmed: true });
const complete = (delivery: ServiceSelection['delivery'] = 'economy'): ServiceSelection => ({ ...presetSelection(DEFAULT_PRINTER_SERVICES, 'complete', delivery), confirmed: true });

// ------------------------------------------------------------------ off

test('unpublished: a printer is quoted and sold exactly as before — no offer, no refusal', async () => {
  const { db } = setup({ publish: false });
  const a = appAs(db, 'buyer');
  const q = await json(await post(a, '/api/products/a1-printer/quote', { qty: 1 }));
  assert.equal('printer_services' in q, false);
  const added = await post(a, '/api/cart/items', { productId: 'p_a1', qty: 1 });
  assert.equal(added.status, 200, JSON.stringify(await json(added.clone())));
  assert.equal('printer_services' in (await json(added)).items[0], false);
});

// ------------------------------------------------------------- the quote

test('quote: a mapped printer carries its offer and no legacy plans; a non-printer carries neither', async () => {
  const { db } = setup();
  const a = appAs(db, 'buyer');
  const q = await json(await post(a, '/api/products/a1-printer/quote', { qty: 1 }));
  const offer = q.printer_services.offer;
  assert.deepEqual(offer.warranty, { w12: 25_000, w24: 100_000, policy_version: 1 });
  assert.equal(offer.care.c12, 19_000);
  assert.deepEqual(offer.delivery, { economy: 5_000, personal: 15_000 });
  assert.equal(offer.packages.smart.price_iqd, 44_000);
  assert.equal(offer.packages.smart.discount_iqd, 0, 'no saving until the owner sets one');
  assert.deepEqual(q.warranty_plans, []);
  assert.equal(q.printer_services.selection, null);
  // A preview with a choice prices it without demanding the confirmation yet.
  const p = await json(await post(a, '/api/products/a1-printer/quote', { qty: 1, services: { ...complete(), confirmed: false } }));
  assert.deepEqual(p.quote.errors ?? [], []);
  assert.equal(p.printer_services.selection.fee_iqd, 100_000 + 19_000 + 7_000 + 5_000);
  assert.equal(p.quote.line_total_iqd, 840_000 + 131_000);
  const pla = await json(await post(a, '/api/products/pla-basic/quote', { qty: 1 }));
  assert.equal('printer_services' in pla, false);
});

// -------------------------------------------------------------- the cart

test('cart: an enrolled printer needs a confirmed choice; no-warranty needs the acknowledgment; a legacy plan is refused', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'buyer');
  const code = async (body: Record<string, unknown>) => (await json(await post(a, '/api/cart/items', { productId: 'p_a1', qty: 1, ...body }))).code;
  assert.equal(await code({}), 'SERVICES_REQUIRED');
  assert.equal(await code({ services: { ...smart(), confirmed: false } }), 'SERVICES_NOT_CONFIRMED');
  assert.equal(await code({ services: { ...EMPTY_SELECTION, package: 'just', confirmed: true } }), 'SERVICES_NO_WARRANTY_ACK');
  assert.equal(await code({ services: { ...smart(), care: 'none' } }), 'SERVICES_PACKAGE_MISMATCH');
  assert.equal(await code({ services: smart(), warrantyPlanId: 'wp_x' }), 'SERVICES_WITH_LEGACY_WARRANTY');
  assert.equal(await code({ services: { v: 1, package: 'gold' } }), 'SERVICES_INVALID');
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM cart_items').get()!.n, 0, 'nothing was written');
  // A non-printer may not carry a choice.
  const pla = await json(await post(a, '/api/cart/items', { productId: 'p_pla', qty: 1, services: smart() }));
  assert.equal(pla.code, 'SERVICES_NOT_OFFERED');
});

test('cart: Smart Choice adds 44,000 per unit; a second add with another package is refused; the cart can change it', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'buyer');
  const added = await json(await post(a, '/api/cart/items', { productId: 'p_a1', qty: 2, services: smart() }));
  const line = added.items[0];
  assert.equal(line.unit_price_iqd, 840_000 + 44_000);
  assert.equal(line.printer_services.needs_choice, false);
  assert.equal(line.printer_services.selection.package, 'smart');
  assert.equal(line.printer_services.priced.warranty_months, 12);
  assert.equal(line.printer_services.priced.delivery_fee_iqd, 15_000);

  const again = await post(a, '/api/cart/items', { productId: 'p_a1', qty: 1, services: complete() });
  assert.equal(again.status, 409);
  assert.equal((await json(again)).code, CART_SERVICES_CONFLICT);
  // The same choice again merges.
  const same = await json(await post(a, '/api/cart/items', { productId: 'p_a1', qty: 1, services: smart() }));
  assert.equal(same.items[0].qty, 3);

  const id = (raw.prepare("SELECT id FROM cart_items WHERE user_id = 'buyer'").get() as { id: string }).id;
  const changed = await json(await patch(a, `/api/cart/items/${id}`, { services: complete() }));
  assert.equal(changed.items[0].unit_price_iqd, 840_000 + 131_000);
  assert.equal(changed.items[0].printer_services.selection.package, 'complete');
});

// ---------------------------------------------------------- the checkout

test('checkout freezes the choice, writes the packing instruction, charges Personal delivery per unit; delivery records 12 months TOTAL', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'buyer');
  assert.equal((await post(a, '/api/cart/items', { productId: 'p_a1', qty: 2, services: smart('personal') })).status, 200);
  const placed = await post(a, '/api/orders', orderBody());
  const body = await json(placed);
  assert.equal(placed.status, 200, JSON.stringify(body));
  const order = body.order;
  const item = order.items[0];
  assert.equal(item.unit_price_iqd, 884_000);
  assert.equal(item.services.selection.package, 'smart');
  assert.equal(item.services.warranty_months, 12);
  assert.deepEqual(item.services.lines.map((l: { service: string; fee_iqd: number }) => [l.service, l.fee_iqd]), [['warranty', 25_000], ['care', 19_000], ['packaging', 0], ['academy', 0]]);

  const ship = JSON.parse(String((raw.prepare('SELECT delivery_method_snapshot FROM orders WHERE id = ?').get(order.id) as { delivery_method_snapshot: string }).delivery_method_snapshot)).quote;
  const comp = ship?.components?.find((c: { kind: string }) => c.kind === 'printer_service');
  assert.ok(comp, `a printer_service component: ${JSON.stringify(ship)}`);
  assert.deepEqual([comp.fee_iqd, comp.units, comp.printer_delivery, comp.waived], [30_000, 2, 'personal', false]);

  const tasks = raw.prepare('SELECT kind, choice, note, status FROM order_service_tasks WHERE order_id = ?').all(order.id) as Array<Record<string, string>>;
  assert.deepEqual(tasks.map((t) => [t.kind, t.choice, t.status]), [['packaging', 'standard', 'open']]);
  assert.match(tasks[0].note, /التغليف/);

  const delivered = '2026-12-01T10:00:00.000Z';
  await createUnitsOnDelivery({ DB: db } as unknown as Env, order.id, delivered);
  const units = raw.prepare('SELECT warranty_base_months, warranty_ext_months, warranty_end_at FROM order_item_units WHERE order_id = ?').all(order.id) as Array<Record<string, unknown>>;
  assert.equal(units.length, 2);
  for (const u of units) {
    assert.deepEqual([u.warranty_base_months, u.warranty_ext_months, u.warranty_end_at], [12, 0, addMonths(delivered, 12)], 'no free base under the bought 12');
  }
  await Promise.allSettled(pending);
});

test('Just Printer with the acknowledgment: no services fee, units carry 0 months of Levonis warranty', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'buyer');
  const just = { ...EMPTY_SELECTION, package: 'just' as const, confirmed: true, ack_no_warranty: true, delivery: 'economy' as const };
  assert.equal((await post(a, '/api/cart/items', { productId: 'p_a1', qty: 1, services: just })).status, 200);
  const order = (await json(await post(a, '/api/orders', orderBody()))).order;
  assert.equal(order.items[0].unit_price_iqd, 840_000);
  const delivered = '2026-12-01T10:00:00.000Z';
  await createUnitsOnDelivery({ DB: db } as unknown as Env, order.id, delivered);
  const u = raw.prepare('SELECT warranty_base_months, warranty_end_at FROM order_item_units WHERE order_id = ?').get(order.id) as Record<string, unknown>;
  assert.deepEqual([u.warranty_base_months, u.warranty_end_at], [0, delivered]);
  // Correcting the delivered date moves the 0-month end with it, never erases it.
  const unit = raw.prepare('SELECT * FROM order_item_units WHERE order_id = ?').get(order.id) as unknown as UnitRow;
  assert.deepEqual(recomputeUnitWindow(unit, '2026-12-03T10:00:00.000Z'), { start_at: '2026-12-03T10:00:00.000Z', end_at: '2026-12-03T10:00:00.000Z' });
  await Promise.allSettled(pending);
});

test('a printer whose delivery was never chosen is refused at checkout with its own code', async () => {
  const { db } = setup();
  const a = appAs(db, 'buyer');
  assert.equal((await post(a, '/api/cart/items', { productId: 'p_a1', qty: 1, services: smart(null) })).status, 200);
  const res = await post(a, '/api/orders', orderBody());
  assert.equal(res.status, 400);
  assert.equal((await json(res)).code, 'SERVICES_DELIVERY_REQUIRED');
});

test('an inspection blocks the hand-over until a staff member completes it with a note', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'buyer');
  assert.equal((await post(a, '/api/cart/items', { productId: 'p_a1', qty: 1, services: complete('economy') })).status, 200);
  const order = (await json(await post(a, '/api/orders', orderBody()))).order;
  const tasks = raw.prepare('SELECT id, kind FROM order_service_tasks WHERE order_id = ? ORDER BY kind').all(order.id) as Array<{ id: string; kind: string }>;
  assert.deepEqual(tasks.map((t) => t.kind), ['inspection', 'packaging']);
  const env = { DB: db } as unknown as Env;
  raw.prepare("UPDATE orders SET stage = 'preparing', status = 'processing' WHERE id = ?").run(order.id);
  const held = await moveOrderStage(env, { orderId: order.id, to: 'out_for_delivery', source: 'manual', changedBy: 'staff' });
  assert.equal(held.reason, 'INSPECTION_NOT_DONE');

  const staff = appAs(db, 'staff', 'admin');
  const inspection = tasks.find((t) => t.kind === 'inspection')!;
  const empty = await post(staff, `/api/admin/order-service-tasks/${inspection.id}/done`, { result_note: '' });
  assert.equal((await json(empty)).code, 'ORDER_SERVICE_TASK_NOTE_REQUIRED');
  const done = await post(staff, `/api/admin/order-service-tasks/${inspection.id}/done`, { result_note: 'طباعة اختبار ناجحة، المعايرة سليمة' });
  assert.equal(done.status, 200);
  const twice = await post(staff, `/api/admin/order-service-tasks/${inspection.id}/done`, { result_note: 'again' });
  assert.equal((await json(twice)).code, 'ORDER_SERVICE_TASK_CLOSED');
  const moved = await moveOrderStage(env, { orderId: order.id, to: 'out_for_delivery', source: 'manual', changedBy: 'staff' });
  assert.notEqual(moved.reason, 'INSPECTION_NOT_DONE');
  await Promise.allSettled(pending);
});

test('a stored choice the list no longer offers falls back to the legacy flow: cart, PATCH, re-add and checkout work, the next write clears it', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'buyer');
  assert.equal((await post(a, '/api/cart/items', { productId: 'p_a1', qty: 1, services: smart() })).status, 200);
  raw.prepare("UPDATE admin_settings SET value = json_set(value, '$.published', json('null')) WHERE key = 'printerServices'").run();
  const cart = await get(a, '/api/cart');
  const view = await json(cart);
  assert.equal(cart.status, 200, JSON.stringify(view));
  assert.equal(view.items[0].unit_price_iqd, 840_000, 'priced as before, without the services fee');
  assert.equal('printer_services' in view.items[0], false);
  // Re-add (no choice: the page shows no offer now) merges and clears the stale choice.
  const again = await post(a, '/api/cart/items', { productId: 'p_a1', qty: 1 });
  assert.equal(again.status, 200, JSON.stringify(await json(again.clone())));
  assert.equal((raw.prepare("SELECT services FROM cart_items WHERE user_id = 'buyer'").get() as { services: string }).services, '');
  // A stale row again: a PATCH of the quantity works and clears it.
  raw.prepare("UPDATE cart_items SET services = ? WHERE user_id = 'buyer'").run(JSON.stringify(smart()));
  const id = (raw.prepare("SELECT id FROM cart_items WHERE user_id = 'buyer'").get() as { id: string }).id;
  const patched = await patch(a, `/api/cart/items/${id}`, { qty: 1 });
  assert.equal(patched.status, 200, JSON.stringify(await json(patched.clone())));
  assert.equal((raw.prepare('SELECT services FROM cart_items WHERE id = ?').get(id) as { services: string }).services, '');
  // And with the stale choice still stored, the checkout sells the legacy line.
  raw.prepare('UPDATE cart_items SET services = ? WHERE id = ?').run(JSON.stringify(smart()), id);
  const placed = await post(a, '/api/orders', orderBody());
  const body = await json(placed);
  assert.equal(placed.status, 200, JSON.stringify(body));
  assert.equal(body.order.items[0].unit_price_iqd, 840_000);
  assert.equal((raw.prepare('SELECT services_snapshot FROM order_items WHERE order_id = ?').get(body.order.id) as { services_snapshot: string | null }).services_snapshot, null);
  assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM order_service_tasks WHERE order_id = ?').get(body.order.id) as { n: number }).n, 0);
  await Promise.allSettled(pending);
});

test('an open inspection blocks EVERY path: forced courier sync, skipping to delivered, the legacy status dropdown, the courier booking, a raw write', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'buyer');
  assert.equal((await post(a, '/api/cart/items', { productId: 'p_a1', qty: 1, services: complete('economy') })).status, 200);
  const order = (await json(await post(a, '/api/orders', orderBody()))).order;
  const env = { DB: db } as unknown as Env;
  const before = { ...(raw.prepare('SELECT status, stage FROM orders WHERE id = ?').get(order.id) as Record<string, unknown>) };

  // The courier sync, forced, straight to «تم التوصيل»; the sweep, forced.
  const synced = await moveOrderStage(env, { orderId: order.id, to: 'delivered', source: 'delivery_api', force: true });
  assert.equal(synced.reason, 'INSPECTION_NOT_DONE');
  const sweep = await moveOrderStage(env, { orderId: order.id, to: 'out_for_delivery', source: 'automatic', force: true });
  assert.equal(sweep.reason, 'INSPECTION_NOT_DONE');

  // The legacy dropdown: refused before orders.status is written.
  const staff = appAs(db, 'staff', 'admin');
  for (const status of ['shipped', 'delivered']) {
    const res = await patch(staff, `/api/admin/orders/${order.id}`, { status });
    const out = await json(res);
    assert.equal(res.status, 409, `${status}: ${JSON.stringify(out)}`);
    assert.equal(out.code, 'INSPECTION_NOT_DONE');
  }
  assert.deepEqual({ ...(raw.prepare('SELECT status, stage FROM orders WHERE id = ?').get(order.id) as Record<string, unknown>) }, before, 'nothing was written');

  // The courier booking: refused before the courier is called.
  raw.prepare("INSERT INTO admin_settings (key, value) VALUES ('deliveryConfig', ?)").run(JSON.stringify({ createPath: '/create', createFields: { orderId: 'ref' } }));
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ status: true, data: { id: 'R1' } }), { status: 200 });
  }) as typeof fetch;
  try {
    const courier = appAs(db, 'staff', 'admin', { ALWASEET_BASE_URL: 'https://courier.invalid', ALWASEET_USERNAME: 'u', ALWASEET_PASSWORD: 'p' });
    const booked = await json(await post(courier, `/api/admin/orders/${order.id}/delivery`, {}));
    assert.equal(booked.code, 'INSPECTION_NOT_DONE', JSON.stringify(booked));
    assert.equal(calls, 0, 'the courier was never called');
  } finally {
    globalThis.fetch = realFetch;
  }

  // The trigger: any door that writes the order directly.
  assert.throws(() => raw.prepare("UPDATE orders SET stage = 'delivered', status = 'delivered' WHERE id = ?").run(order.id), /INSPECTION_NOT_DONE/);
  assert.throws(() => raw.prepare("UPDATE orders SET status = 'shipped' WHERE id = ?").run(order.id), /INSPECTION_NOT_DONE/);
  assert.throws(() => raw.prepare("UPDATE orders SET delivery_remote_id = 'R9' WHERE id = ?").run(order.id), /INSPECTION_NOT_DONE/);
  // A pre-order's 'shipped' is the freight leg, not the hand-over: it stays open.
  raw.prepare("UPDATE orders SET shipping_type = 'preorder_air' WHERE id = ?").run(order.id);
  raw.prepare("UPDATE orders SET status = 'shipped', stage = 'handed_to_carrier' WHERE id = ?").run(order.id);
  // Once the inspection is done, the order leaves.
  raw.prepare("UPDATE order_service_tasks SET status = 'done', done_by = 'staff', done_at = '2026-11-17T10:00:00.000Z', result_note = 'ok' WHERE order_id = ? AND kind = 'inspection'").run(order.id);
  raw.prepare("UPDATE orders SET stage = 'out_for_delivery' WHERE id = ?").run(order.id);
  await Promise.allSettled(pending);
});

test('store pickup: the printer delivery choice is dropped, nothing is charged for it and the snapshot says pickup; another method is refused', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'buyer');
  assert.equal((await post(a, '/api/cart/items', { productId: 'p_a1', qty: 1, services: smart('personal') })).status, 200);
  const personal = await post(a, '/api/orders', orderBody({ deliveryMethodId: 'personal' }));
  const refused = await json(personal);
  assert.equal(personal.status, 400, JSON.stringify(refused));
  assert.equal(refused.code, 'SERVICES_DELIVERY_METHOD');

  const placed = await post(a, '/api/orders', orderBody({ deliveryMethodId: 'pickup' }));
  const body = await json(placed);
  assert.equal(placed.status, 200, JSON.stringify(body));
  const row = raw.prepare('SELECT shipping_iqd, delivery_method_snapshot FROM orders WHERE id = ?').get(body.order.id) as { shipping_iqd: number; delivery_method_snapshot: string };
  assert.equal(Number(row.shipping_iqd ?? 0), 0, 'no delivery fee at pickup');
  const comps = JSON.parse(row.delivery_method_snapshot).quote?.components ?? [];
  assert.equal(comps.some((c: { kind: string }) => c.kind === 'printer_service'), false);
  const snap = JSON.parse((raw.prepare('SELECT services_snapshot FROM order_items WHERE order_id = ?').get(body.order.id) as { services_snapshot: string }).services_snapshot);
  assert.equal(snap.selection.delivery, 'pickup');
  assert.equal('delivery_fee_iqd' in snap, false);
  assert.equal(body.order.items[0].services.delivery, 'pickup');
  assert.equal(body.order.items[0].services.delivery_fee_iqd, null);
  await Promise.allSettled(pending);
});

test('a delivery coupon never discounts the printer Personal delivery', async () => {
  const { db, raw } = setup();
  raw.exec(`INSERT INTO coupons (id, code, kind, value, min_total_iqd, max_per_user, active, scope, applies_to) VALUES ('cship', 'SHIPALL', 'fixed_iqd', 100000, 0, 5, 1, 'global', 'delivery')`);
  const a = appAs(db, 'buyer');
  assert.equal((await post(a, '/api/cart/items', { productId: 'p_a1', qty: 1, services: smart('personal') })).status, 200);
  // Only the printer: everything charged is its Personal delivery, so the code has nothing to take.
  const alone = await json(await post(a, '/api/orders', orderBody({ couponCode: 'SHIPALL' })));
  assert.equal(alone.code, 'NO_DISCOUNT', JSON.stringify(alone));
  // With a filament line the code takes the rest of the delivery and never the 15,000.
  assert.equal((await post(a, '/api/cart/items', { productId: 'p_pla', qty: 1 })).status, 200);
  const placed = await post(a, '/api/orders', orderBody({ couponCode: 'SHIPALL' }));
  const body = await json(placed);
  assert.equal(placed.status, 200, JSON.stringify(body));
  const row = raw.prepare('SELECT shipping_iqd, coupon_snapshot FROM orders WHERE id = ?').get(body.order.id) as { shipping_iqd: number; coupon_snapshot: string };
  const coupon = JSON.parse(row.coupon_snapshot);
  const charged = Number(row.shipping_iqd);
  assert.ok(charged > 15_000, `the Personal fee and the filament delivery are charged: ${charged}`);
  assert.equal(coupon.delivery_iqd, charged - 15_000, JSON.stringify(coupon));
  await Promise.allSettled(pending);
});

test('qty 2: each warehouse task carries the count and its note says ×2', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'buyer');
  assert.equal((await post(a, '/api/cart/items', { productId: 'p_a1', qty: 2, services: complete('economy') })).status, 200);
  const order = (await json(await post(a, '/api/orders', orderBody()))).order;
  const tasks = raw.prepare('SELECT kind, qty, note FROM order_service_tasks WHERE order_id = ? ORDER BY kind').all(order.id) as Array<{ kind: string; qty: number; note: string }>;
  assert.deepEqual(tasks.map((t) => t.kind), ['inspection', 'packaging']);
  for (const t of tasks) {
    assert.equal(t.qty, 2, t.kind);
    assert.match(t.note, /×2/);
  }
  await Promise.allSettled(pending);
});

// ------------------------------------------------------------- the admin

test('admin: the draft saves with a revision fence, refuses a non-printer, and only the owner publishes', async () => {
  const { db } = setup({ publish: false });
  const owner = appAs(db, 'owner', 'admin');
  const first = await json(await get(owner, '/api/admin/printer-services'));
  assert.equal(first.published, null);
  assert.ok(first.publish_issues.length > 0, 'the seed alone is not publishable');
  assert.deepEqual(first.printers.map((p: { id: string }) => p.id), ['p_a1']);

  const draft = { ...first.draft, products: { p_pla: { warranty_family: 'a1', delivery_class: 'd1' } } };
  const notPrinter = await put(owner, '/api/admin/printer-services/draft', { draft, base_revision: first.draft.revision });
  assert.equal((await json(notPrinter)).code, 'PRINTER_SERVICES_NOT_PRINTER');

  const ok = await json(await put(owner, '/api/admin/printer-services/draft', { draft: { ...first.draft, products: { p_a1: { warranty_family: 'a1', delivery_class: 'd1' } } }, base_revision: first.draft.revision }));
  assert.equal(ok.success, true, JSON.stringify(ok));
  const stale = await put(owner, '/api/admin/printer-services/draft', { draft: ok.draft, base_revision: first.draft.revision });
  assert.equal((await json(stale)).code, 'PRINTER_SERVICES_STALE');

  const staff = appAs(db, 'staff', 'admin');
  const refused = await post(staff, '/api/admin/printer-services/publish', { base_revision: ok.draft.revision });
  assert.equal(refused.status, 403);
  const pub = await json(await post(owner, '/api/admin/printer-services/publish', { base_revision: ok.draft.revision }));
  assert.equal(pub.success, true, JSON.stringify(pub));
  assert.ok(pub.published.revision >= 1);
  // The generic settings door cannot bypass it.
  const raw = await put(owner, '/api/admin/settings/printerServices', { value: {} });
  assert.equal((await json(raw)).code, 'PRINTER_SERVICES_ROUTE');
});

// ------------------------------------------- review fixes (owner rulings 2026-11-17)

const LEGACY_PLAN = JSON.stringify([{
  id: 'wp_ext12', title_ar: 'ضمان ممدد', title_en: 'Extended +12', title_ckb: '', terms_ar: '', terms_en: '', terms_ckb: '',
  duration_months: 12, duration_kind: 'extension', fee_iqd: 0, fee_percent: 7.5, order: 0, active: true,
}]);

/** Re-publishes the live list with these product mappings. */
function publishMapping(raw: DatabaseSync, db: D1Database, products: Record<string, unknown>) {
  const live = { ...DEFAULT_PRINTER_SERVICES, revision: 2, products };
  raw.prepare("UPDATE admin_settings SET value = ? WHERE key = 'printerServices'").run(
    JSON.stringify({ draft: live, published: live, published_at: '2026-11-17T00:00:00.000Z', published_by: 'owner' })
  );
  forgetPricingInputs(db);
}

/** The same database, with `before` run just before every batch: a concurrent writer landing between a read and its write. */
function racing(db: D1Database, before: () => void): D1Database {
  return new Proxy(db, {
    get(target, key) {
      if (key === 'batch') return async (stmts: D1PreparedStatement[]) => { before(); return target.batch(stmts); };
      const v = (target as unknown as Record<string | symbol, unknown>)[key];
      return typeof v === 'function' ? (v as (...args: unknown[]) => unknown).bind(target) : v;
    },
  });
}

test('fix 1: saving the draft is the owner only; staff still read the list', async () => {
  const { db } = setup({ publish: false });
  const staff = appAs(db, 'staff', 'admin');
  const view = await get(staff, '/api/admin/printer-services');
  assert.equal(view.status, 200);
  const { draft } = await json(view);
  const refused = await put(staff, '/api/admin/printer-services/draft', { draft, base_revision: draft.revision });
  assert.equal(refused.status, 403);
  assert.equal((await json(refused)).code, 'OWNER_REQUIRED');
});

test('fix 2/3: the draft refuses a package discount and stores only known fields', async () => {
  const { db, raw } = setup({ publish: false });
  const owner = appAs(db, 'owner', 'admin');
  const { draft } = await json(await get(owner, '/api/admin/printer-services'));
  const discounted = { ...draft, packages: { ...draft.packages, smart: { ...draft.packages.smart, discount_iqd: 5_000 } } };
  const r1 = await put(owner, '/api/admin/printer-services/draft', { draft: discounted, base_revision: draft.revision });
  assert.equal((await json(r1)).code, 'PRINTER_SERVICES_INVALID');
  const junk = { ...draft, junk: 'x', products: { p_a1: { warranty_family: 'a1', delivery_class: 'd1', note: 'y' } } };
  const ok = await json(await put(owner, '/api/admin/printer-services/draft', { draft: junk, base_revision: draft.revision }));
  assert.equal(ok.success, true, JSON.stringify(ok));
  const stored = JSON.parse(String((raw.prepare("SELECT value FROM admin_settings WHERE key = 'printerServices'").get() as { value: string }).value));
  assert.equal('junk' in stored.draft, false);
  assert.deepEqual(stored.draft.products, { p_a1: { warranty_family: 'a1', delivery_class: 'd1', store_bundle_ids: [] } });
});

test('fix 4/5: a version-only mapping is quoted on the stand-in with no version chosen, never with the legacy plans', async () => {
  const { db, raw } = setup();
  raw.prepare(
    `INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,warranty_plans,ops_policy,images,inventory_mode)
     VALUES ('p_a1v','a1-versions','Printer A1 V','طابعة A1 V',900000,'active',5,'[]','[]','direct_sale','["direct_sale"]',?,?,'[]','BASE')`
  ).run(LEGACY_PLAN, OPS);
  raw.exec(`
    INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES ('p_a1v','cat_p',1);
    INSERT INTO product_option_groups (id,product_id,name_en,sort,active) VALUES ('g_v','p_a1v','Version',0,1);
    INSERT INTO product_option_values (id,product_id,group_id,name_en,name_ar,sort,active,stock,regular_price_iqd) VALUES
      ('ov_std','p_a1v','g_v','Standard','قياسي',0,1,3,900000), ('ov_combo','p_a1v','g_v','Combo','كومبو',1,1,3,1100000);
  `);
  publishMapping(raw, db, {
    p_a1: { warranty_family: 'a1', delivery_class: 'd1' },
    p_a1v: { warranty_family: 'a1', by_option_value: { ov_std: { delivery_class: 'd1' }, ov_combo: { delivery_class: 'd2' } } },
  });
  const a = appAs(db, 'buyer');
  const q = await json(await post(a, '/api/products/a1-versions/quote', { qty: 1 }));
  assert.ok(q.printer_services, `the stand-in resolves the services: ${JSON.stringify(q)}`);
  assert.deepEqual(q.printer_services.offer.delivery, { economy: 5_000, personal: 15_000 });
  assert.deepEqual(q.warranty_plans, []);
  const combo = await json(await post(a, '/api/products/a1-versions/quote', { qty: 1, optionValueIds: ['ov_combo'] }));
  assert.deepEqual(combo.printer_services.offer.delivery, { economy: 10_000, personal: 35_000 });
  const detail = await json(await get(a, '/api/products/a1-versions'));
  assert.equal(detail.printer_services_enrolled, true, JSON.stringify(Object.keys(detail)));
  assert.deepEqual(detail.product.warranty_plans, []);

  // A family on one version and a class on another resolves on no selection: no flag, and publish refuses it.
  publishMapping(raw, db, { p_a1: { warranty_family: 'a1', delivery_class: 'd1' }, p_a1v: { by_option_value: { ov_std: { warranty_family: 'a1' }, ov_combo: { delivery_class: 'd2' } } } });
  const owner = appAs(db, 'owner', 'admin');
  const st = await json(await get(owner, '/api/admin/printer-services'));
  assert.ok(st.publish_issues.some((i: string) => i.startsWith('products.p_a1v: no version has both')), JSON.stringify(st.publish_issues));
  const pub = await post(owner, '/api/admin/printer-services/publish', { base_revision: st.draft.revision });
  assert.equal((await json(pub)).code, 'PRINTER_SERVICES_NOT_READY');
  const split = await json(await post(a, '/api/products/a1-versions/quote', { qty: 1, optionValueIds: ['ov_std'] }));
  assert.equal('printer_services' in split, false);
  const splitDetail = await json(await get(a, '/api/products/a1-versions'));
  assert.equal('printer_services_enrolled' in splitDetail, false, 'no selection resolves: not enrolled');
});

test('fix 6: a legacy plan on an enrolled printer is refused even with no services sent', async () => {
  const { db, raw } = setup();
  raw.prepare("UPDATE products SET warranty_plans = ? WHERE id = 'p_a1'").run(LEGACY_PLAN);
  const a = appAs(db, 'buyer');
  const q = await json(await post(a, '/api/products/a1-printer/quote', { qty: 1, warrantyPlanId: 'wp_ext12' }));
  assert.ok(q.quote.errors.includes('SERVICES_WITH_LEGACY_WARRANTY'), JSON.stringify(q.quote));
  assert.equal(q.quote.line_total_iqd, 840_000, 'the legacy fee is not priced');
  assert.deepEqual(q.warranty_plans, []);
});

test('fix 7: a task of a cancelled order cannot be completed; a lost race writes no audit row', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'buyer');
  assert.equal((await post(a, '/api/cart/items', { productId: 'p_a1', qty: 1, services: smart('economy') })).status, 200);
  const order = (await json(await post(a, '/api/orders', orderBody()))).order;
  const task = raw.prepare("SELECT id FROM order_service_tasks WHERE order_id = ? AND kind = 'packaging'").get(order.id) as { id: string };
  const audits = () => (raw.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'order_service_task.done'").get() as { n: number }).n;

  raw.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(order.id);
  const ended = await post(appAs(db, 'staff', 'admin'), `/api/admin/order-service-tasks/${task.id}/done`, { result_note: 'packed' });
  assert.equal(ended.status, 409);
  assert.equal((await json(ended)).code, 'ORDER_SERVICE_TASK_ORDER_ENDED');
  assert.equal(audits(), 0);

  // The order is cancelled between the read and the guarded write: refused, and no audit row.
  raw.prepare("UPDATE orders SET status = 'processing' WHERE id = ?").run(order.id);
  const raced = racing(db, () => { raw.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(order.id); });
  const lost = await post(appAs(raced, 'staff', 'admin'), `/api/admin/order-service-tasks/${task.id}/done`, { result_note: 'packed' });
  assert.equal(lost.status, 409);
  assert.equal(audits(), 0, 'a lost race writes no audit row');
  assert.equal((raw.prepare('SELECT status FROM order_service_tasks WHERE id = ?').get(task.id) as { status: string }).status, 'open');

  raw.prepare("UPDATE orders SET status = 'processing' WHERE id = ?").run(order.id);
  const done = await post(appAs(db, 'staff', 'admin'), `/api/admin/order-service-tasks/${task.id}/done`, { result_note: 'packed' });
  assert.equal(done.status, 200);
  assert.equal(audits(), 1);
  await Promise.allSettled(pending);
});

test('fix 7: a draft save that loses the compare-and-swap writes no audit row', async () => {
  const { db, raw } = setup({ publish: false });
  const owner = appAs(db, 'owner', 'admin');
  const { draft } = await json(await get(owner, '/api/admin/printer-services'));
  const first = await json(await put(owner, '/api/admin/printer-services/draft', { draft, base_revision: draft.revision }));
  assert.equal(first.success, true, JSON.stringify(first));
  const audits = () => (raw.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'printer_services.draft_saved'").get() as { n: number }).n;
  assert.equal(audits(), 1);
  // Another admin saves between this request's read and its swap.
  const raced = racing(db, () => {
    raw.prepare("UPDATE admin_settings SET value = json_set(value, '$.published_by', 'other') WHERE key = 'printerServices'").run();
  });
  const lost = await put(appAs(raced, 'owner', 'admin'), '/api/admin/printer-services/draft', { draft: first.draft, base_revision: first.draft.revision });
  assert.equal((await json(lost)).code, 'PRINTER_SERVICES_STALE');
  assert.equal(audits(), 1, 'the lost save left no audit row');
});
