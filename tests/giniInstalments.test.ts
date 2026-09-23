/**
 * «خدمه اقساطي على تطبيق جني ( مصرف الرافدين )» — the instalments service, run
 * through the REAL quote and checkout routes against real migrations.
 *
 * Every assertion here is a money bug that was specifically possible:
 *
 *   - the delivery fee is ALREADY inside the payable, so a door amount added
 *     on top of the goods charges it twice;
 *   - a coupon or points can push the payable BELOW the delivery fee, and the
 *     naive `payable - shipping` is then a negative "paid by Gini";
 *   - `useWallet` takes the WHOLE payable, not an advance, so a Levo balance
 *     would silently part-pay a price Qi Card already financed;
 *   - the 50,000 printer advance is ENFORCED through `requiredAdvance`, so a
 *     Gini printer order would grey out its own confirm button;
 *   - and a pending order HOLDS ITS STOCK, so the 24-hour hold has to end in
 *     a real release and not a status flip.
 *
 * The fixture is the same shape as tests/checkoutPayment.test.ts: one printer,
 * one ordinary product, a real buyer with a funded wallet. Only the session is
 * stubbed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ROOT, SqliteD1 } from './fixtures/d1';
import type { AppContext, Env } from '../worker/lib/types';
import { HttpError } from '../worker/lib/http';
import { orderRoutes } from '../worker/routes/orders';
import { cartRoutes } from '../worker/routes/cart';
import { adminRoutes } from '../worker/routes/admin';
import { returnRoutes } from '../worker/routes/returns';
import { classifyHost } from '../worker/lib/hosts';
import { requireMainHost } from '../worker/lib/http';
import { recordOrderSettlement } from '../worker/lib/pointsOps';
import {
  allowedPaymentMethods,
  isGini,
  isPaymentMethodAllowed,
  isGiniOrderNo,
} from '../worker/lib/paymentPolicy';
import { giniSplit, giniHoldUntil, giniBlocksConfirmation, giniStateOf } from '../worker/lib/gini';
import { sweepGiniHolds } from '../worker/lib/giniSweep';
import { SETTING_DEFAULTS, PUBLIC_SETTING_KEYS, getSetting } from '../worker/lib/settings';
import { acceptedPolicies } from './lib/policies';
import { resetPolicyCorpusMemo } from '../worker/lib/policySync';

const PRINTER_IQD = 899_000;
const DELIVERY_IQD = 5_000;

function setup() {
  resetPolicyCorpusMemo();
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) raw.exec(readFileSync(join(dir, f), 'utf8'));
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','s@x.co','h','customer'),
      -- The admin who scans the barcode and presses confirm. A real row,
      -- because the audit trail carries a foreign key to it.
      ('boss','Boss','b@x.co','h','admin');
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,is_default) VALUES
      ('addr_b','buyer','Home','Sara','+9647701234567','Baghdad, Karrada 12','',1);
    -- A funded wallet, on purpose: the Gini path must refuse to spend it.
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status) VALUES
      ('dep_b','buyer','deposit','USD',100000,'approved');
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,direct_surcharge_iqd,images)
      VALUES ('p_x1','x1-printer','Printer X1','طابعة X1',${PRINTER_IQD},'active',5,'[]','[]','direct_sale','["direct_sale"]','[]',NULL,'[]'),
             ('p_pla','pla-basic','PLA Basic','PLA أساسي',25000,'active',50,'[]','[]','direct_sale','["direct_sale"]','[]',NULL,'[]');
    INSERT INTO catalogs (id, slug, name_ar, is_printer_catalog) VALUES ('cat_p','test-printers','طابعات',1);
    INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES ('p_x1','cat_p',0);
  `);
  return { raw, db: new SqliteD1(raw) as unknown as D1Database };
}

function cartLine(raw: DatabaseSync, id: string, productId: string, qty = 1) {
  raw
    .prepare(
      `INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,shipping_method_id,transport_method,warranty_plan_id,qty)
       VALUES (?, 'buyer', ?, '', '[]', '', '', '', '', ?)`
    )
    .run(id, productId, qty);
}

const pending: Promise<unknown>[] = [];
const ctx = {
  waitUntil: (p: Promise<unknown>) => {
    pending.push(p.catch(() => undefined));
  },
  passThroughOnException() {},
} as unknown as ExecutionContext;

function appAs(db: D1Database) {
  const a = new Hono<AppContext>();
  a.use('*', async (c, next) => {
    c.set('user', { id: 'buyer', role: 'customer', email: 'buyer@x.co', username: 'buyer' } as never);
    c.env = { DB: db } as never;
    await next();
  });
  a.route('/api/orders', orderRoutes);
  a.route('/api/cart', cartRoutes);
  // The customer's own return request — mounted here because the refund it
  // ends in is where the Gini money rule has to hold.
  a.route('/api/returns', returnRoutes);
  a.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ success: false, error: err.message, code: err.code, details: err.details ?? null }, err.status as 400);
    }
    throw err;
  });
  return a;
}

/**
 * The ADMIN side of the same database, mounted the way worker/index.ts mounts
 * it — the apex guard included, because the gate this exercises lives behind
 * it. The session is the only stub.
 */
function adminAppAs(db: D1Database) {
  const a = new Hono<AppContext>();
  a.use('*', async (c, next) => {
    c.set('host', classifyHost('levonis-iq.com', 'levonis-iq.com'));
    c.set('user', {
      id: 'boss', role: 'admin', email: 'b@x.co', username: 'boss', admin_scope: null, is_investor: 0,
    } as never);
    c.env = { DB: db } as never;
    await next();
  });
  a.use('/api/admin/*', requireMainHost);
  a.route('/api/admin', adminRoutes);
  a.route('/api/returns', returnRoutes);
  a.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ success: false, error: err.message, code: err.code, details: err.details ?? null }, err.status as 400);
    }
    throw err;
  });
  return a;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response) => (await res.json()) as Record<string, any>;
const post = (a: ReturnType<typeof appAs>, path: string, body: unknown) =>
  a.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, undefined, ctx);
const send = (a: ReturnType<typeof adminAppAs>, method: string, path: string, body: unknown = {}) =>
  a.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, undefined, ctx);

let seq = 0;
const body = (over: Record<string, unknown> = {}) => ({
  addressId: 'addr_b',
  deliveryMethodId: 'standard',
  paymentMethodId: 'gini',
  useWallet: false,
  usePoints: false,
  itemIds: [],
  ...over,
});
const orderBody = (over: Record<string, unknown> = {}) => ({
  ...body(over),
  idempotencyKey: `gini-${Date.now()}-${++seq}`,
  policyAcceptance: acceptedPolicies(),
});

// ------------------------------------------------------------- the policy

test('gini is its own id, offered only when the owner has it on, and it carries a 6-digit order number', () => {
  for (const t of ['direct', 'preorder_air', 'preorder_sea', 'preorder_land'] as const) {
    assert.ok(!allowedPaymentMethods(t).includes('gini'), 'absent unless the server says so');
    assert.equal(isPaymentMethodAllowed('gini', t), false);
    assert.deepEqual(allowedPaymentMethods(t, { giniEnabled: true }), ['wallet', 'cash', 'gini']);
    assert.equal(isPaymentMethodAllowed('gini', t, { giniEnabled: true }), true);
    // Never a flavour of BNPL: the two share a word in English and nothing else.
    assert.equal(isPaymentMethodAllowed('gini', t, { bnplEligible: true }), false);
  }
  assert.equal(isGini('gini'), true);
  assert.equal(isGini('bnpl'), false);
  assert.equal(isGiniOrderNo('123456'), true);
  assert.equal(isGiniOrderNo('12345'), false);
  assert.equal(isGiniOrderNo('1234567'), false);
  assert.equal(isGiniOrderNo('12a456'), false);
  assert.equal(isGiniOrderNo(123456), false);
});

test('the gini split always sums back to the payable and never goes negative', () => {
  // The ordinary case: the goods are Gini's, the fee is ours.
  const ordinary = giniSplit(904_000, 5_000);
  assert.deepEqual(ordinary, { paidIqd: 899_000, deliveryDueIqd: 5_000 });
  assert.equal(ordinary.paidIqd + ordinary.deliveryDueIqd, 904_000);

  // A pickup owes nothing at the door.
  assert.deepEqual(giniSplit(899_000, 0), { paidIqd: 899_000, deliveryDueIqd: 0 });

  // THE CLAMP. A coupon and points reduced the merchandise until the payable
  // is smaller than the delivery fee — `payable - shipping` would be -3,000.
  const clamped = giniSplit(2_000, 5_000);
  assert.deepEqual(clamped, { paidIqd: 0, deliveryDueIqd: 2_000 });
  assert.equal(clamped.paidIqd + clamped.deliveryDueIqd, 2_000, 'the invariant survives the clamp');

  // Nothing payable at all: everything discounted away.
  assert.deepEqual(giniSplit(0, 5_000), { paidIqd: 0, deliveryDueIqd: 0 });
});

test('the hold is frozen from the policy, and a policy with no hold gives none', () => {
  assert.equal(giniHoldUntil('2026-09-22T10:00:00.000Z', 24), '2026-09-23T10:00:00.000Z');
  assert.equal(giniHoldUntil('2026-09-22T10:00:00.000Z', 0), null);
  assert.equal(giniHoldUntil('2026-09-22T10:00:00.000Z', -1), null);
  assert.equal(giniHoldUntil('not a date', 24), null);
  assert.equal(SETTING_DEFAULTS.giniPolicy.hold_hours, 24, "«يبقى الطلب معلقا حتى ٢٤ ساعه»");
});

test('the conditions text exists in all three languages and is readable without an account', () => {
  const t = SETTING_DEFAULTS.giniPolicy.conditions;
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    assert.ok(t[lang].length > 20, `${lang} is hand-written, not a placeholder`);
  }
  assert.ok(t.ar.includes('الرافدين'), 'the Rafidain-employee condition, in the bank’s own word');
  assert.ok(PUBLIC_SETTING_KEYS.includes('giniPolicy'), 'the product page draws the note signed out');
});

test('a shop configured before gini existed still gets the row — the setting is a whole answer, not a patch', async () => {
  const { raw, db } = setup();
  // Exactly what an owner's saved array looked like before today.
  raw
    .prepare("INSERT INTO admin_settings (key, value) VALUES ('checkoutPaymentMethods', ?)")
    .run(JSON.stringify([{ id: 'wallet', titleAr: 'محفظة', titleEn: 'Wallet', icon: 'Wallet' }]));
  const methods = await getSetting(db, 'checkoutPaymentMethods');
  assert.ok(methods.some((m) => m.id === 'gini'), 'rescued, or checkout intersects it away with no error');
  assert.ok(methods.some((m) => m.id === 'bnpl'), 'and the rescue that came before it still works');
});

// ----------------------------------------------------------- the money path

test('a gini printer order: gini pays the goods, only the delivery fee is due at the door, no 50,000 advance', async () => {
  const { raw, db } = setup();
  cartLine(raw, 'ci1', 'p_x1');
  const a = appAs(db);

  const q = (await json(await post(a, '/api/orders/quote', body()))).quote;
  assert.ok(q.allowed_payment_methods.includes('gini'));
  assert.equal(q.total_iqd, PRINTER_IQD + DELIVERY_IQD, 'the order still costs what it costs');
  assert.equal(q.gini.paid_iqd, PRINTER_IQD, 'settled inside the app');
  assert.equal(q.gini.delivery_due_iqd, DELIVERY_IQD);
  assert.equal(q.due_on_delivery_iqd, DELIVERY_IQD, '«فقط سعر التوصيل»');
  assert.equal(
    q.gini.paid_iqd + q.gini.delivery_due_iqd,
    q.total_iqd,
    'the fee is carved OUT of the payable, never added on top of it',
  );
  assert.equal(q.cod_tax_iqd, 0, 'a door charge below one 500,000 block is 0, and this is not cash on delivery');
  // THE PRINTER ADVANCE. Left enforced it would grey out the confirm button.
  assert.equal(q.wallet.required_advance_iqd, 0, '«بدون طلب ٥٠ الف للطابعه»');
  assert.equal(q.wallet.applied_iqd, 0);
  assert.equal(
    q.notes.printer_home_delivery_iqd,
    null,
    'and the note is not printed either — its sentence promises a payment nothing will collect',
  );

  // The six digits are required at the ORDER door and nowhere else.
  const noNumber = await json(await post(a, '/api/orders', orderBody()));
  assert.equal(noNumber.code, 'GINI_ORDER_NO_REQUIRED');
  const short = await json(await post(a, '/api/orders', orderBody({ giniOrderNo: '12345' })));
  assert.equal(short.code, 'GINI_ORDER_NO_REQUIRED');
  const letters = await json(await post(a, '/api/orders', orderBody({ giniOrderNo: '12a456' })));
  assert.equal(letters.code, 'GINI_ORDER_NO_REQUIRED');

  const placed = await json(await post(a, '/api/orders', orderBody({ giniOrderNo: '904221' })));
  assert.equal(placed.success, true, JSON.stringify(placed));
  await Promise.all(pending.splice(0));

  const row = raw.prepare('SELECT * FROM orders WHERE id = ?').get(placed.order.id) as Record<string, unknown>;
  assert.equal(row.payment_method_id, 'gini');
  assert.equal(row.status, 'pending', 'there is no gini_pending status and there must not be one');
  assert.equal(row.stage, 'received');
  assert.equal(row.gini_state, 'awaiting_receipt');
  assert.equal(row.gini_order_no, '904221');
  assert.equal(Number(row.gini_paid_iqd), PRINTER_IQD);
  assert.equal(Number(row.due_on_delivery_iqd), DELIVERY_IQD);
  assert.equal(Number(row.total_iqd), PRINTER_IQD + DELIVERY_IQD);
  assert.equal(Number(row.wallet_applied_iqd), 0, 'the wallet never part-pays a gini order');
  assert.equal(Number(row.bnpl_due_iqd), 0, 'no Levonis financing, no ledger, no limit');
  assert.ok(String(row.gini_hold_until) > String(row.created_at), 'the deadline is frozen ahead of the order');
  assert.equal(
    Number(row.gini_paid_iqd) + Number(row.due_on_delivery_iqd),
    Number(row.total_iqd),
    'the stored invariant',
  );

  // The customer's own view says where the order stands with the bank.
  assert.equal(placed.order.gini.state, 'awaiting_receipt');
  assert.equal(placed.order.gini.order_no, '904221');
  assert.equal(placed.order.financial.gini_paid_iqd, PRINTER_IQD);
  assert.equal(
    placed.order.financial.outstanding_iqd,
    DELIVERY_IQD,
    'never the full price — gini already paid the goods',
  );
});

test('a funded wallet cannot part-pay a gini order even when the customer left the toggle on', async () => {
  const { raw, db } = setup();
  cartLine(raw, 'ci1', 'p_pla');
  const a = appAs(db);

  const q = (await json(await post(a, '/api/orders/quote', body({ useWallet: true })))).quote;
  assert.equal(q.wallet.applied_iqd, 0, 'a balance that would have covered the whole order');
  assert.equal(q.gini.paid_iqd, 25_000);
  assert.equal(q.due_on_delivery_iqd, DELIVERY_IQD);

  const placed = await json(await post(a, '/api/orders', orderBody({ useWallet: true, giniOrderNo: '111222' })));
  assert.equal(placed.success, true, JSON.stringify(placed));
  await Promise.all(pending.splice(0));
  const row = raw.prepare('SELECT * FROM orders WHERE id = ?').get(placed.order.id) as Record<string, unknown>;
  assert.equal(Number(row.wallet_applied_iqd), 0);
  assert.equal(Number(row.wallet_applied_usd_cents), 0);
  assert.equal(Number(row.gini_paid_iqd), 25_000);
});

test('a gini pickup owes nothing at the door', async () => {
  const { raw, db } = setup();
  cartLine(raw, 'ci1', 'p_pla');
  const a = appAs(db);
  const q = (await json(await post(a, '/api/orders/quote', body({ deliveryMethodId: 'pickup' })))).quote;
  assert.equal(q.gini.delivery_due_iqd, 0);
  assert.equal(q.due_on_delivery_iqd, 0);
  assert.equal(q.gini.paid_iqd, q.total_iqd, 'gini settled all of it');
});

// -------------------------------------------------------------- the 24h hold

test('the hold ends in a real release: the order is cancelled, gini_state is expired, the units come back', async () => {
  const { raw, db } = setup();
  cartLine(raw, 'ci1', 'p_pla', 3);
  const a = appAs(db);
  const placed = await json(await post(a, '/api/orders', orderBody({ giniOrderNo: '555666' })));
  assert.equal(placed.success, true, JSON.stringify(placed));
  await Promise.all(pending.splice(0));
  const id = placed.order.id as string;

  // A PENDING ORDER HOLDS ITS STOCK — that is what the sweep has to give back.
  const reserved = raw.prepare("SELECT COUNT(*) AS n FROM inventory_ledger WHERE order_id = ? AND kind = 'reserve'").get(id) as { n: number };
  assert.ok(reserved.n > 0, 'the checkout reserved units');

  const env = { DB: db } as unknown as Env;

  const statusOf = () => {
    const r = raw.prepare('SELECT status FROM orders WHERE id = ?').get(id) as { status: string };
    return String(r.status);
  };

  // Before the deadline: untouched.
  const early = await sweepGiniHolds(env, '2000-01-01T00:00:00.000Z');
  assert.equal(early.scanned, 0, 'the frozen deadline is in the future');
  assert.equal(statusOf(), 'pending');

  // After it: cancelled, released, and recorded.
  const held = raw.prepare('SELECT gini_hold_until AS h FROM orders WHERE id = ?').get(id) as { h: string };
  const after = new Date(Date.parse(String(held.h)) + 1000).toISOString();
  const report = await sweepGiniHolds(env, after);
  assert.equal(report.scanned, 1);
  assert.equal(report.cancelled, 1);
  assert.equal(report.errors, 0);

  const row = raw.prepare('SELECT * FROM orders WHERE id = ?').get(id) as Record<string, unknown>;
  assert.equal(row.status, 'cancelled');
  assert.equal(row.gini_state, 'expired');
  const released = raw.prepare("SELECT COUNT(*) AS n FROM inventory_ledger WHERE order_id = ? AND kind = 'release'").get(id) as { n: number };
  assert.ok(released.n > 0, 'planOrderReturn ran — not a bare status flip');
  const history = raw.prepare("SELECT COUNT(*) AS n FROM order_status_history WHERE order_id = ? AND stage = 'cancelled'").get(id) as { n: number };
  assert.equal(history.n, 1, 'and it is explainable to the customer');

  // A second pass converges instead of cancelling it twice.
  const again = await sweepGiniHolds(env, after);
  assert.equal(again.scanned, 0);
});

test('a scanned order is never swept, however long it waits', async () => {
  const { raw, db } = setup();
  cartLine(raw, 'ci1', 'p_pla');
  const a = appAs(db);
  const placed = await json(await post(a, '/api/orders', orderBody({ giniOrderNo: '777888' })));
  await Promise.all(pending.splice(0));
  const id = placed.order.id as string;

  // Staff scanned the barcode: the hold's question has been answered.
  raw.prepare("UPDATE orders SET gini_state = 'received', gini_receipt_barcode = 'GN-1', gini_received_at = ? WHERE id = ?")
    .run('2026-09-22T12:00:00.000Z', id);

  const report = await sweepGiniHolds({ DB: db } as unknown as Env, '2099-01-01T00:00:00.000Z');
  assert.equal(report.scanned, 0, 'the selection is keyed on awaiting_receipt, not on the clock alone');
  const still = raw.prepare('SELECT status FROM orders WHERE id = ?').get(id) as { status: string };
  assert.equal(String(still.status), 'pending');
});

// ----------------------------------------------------------- the confirm gate

test('confirmation is blocked until the receipt is scanned, and only for a gini order still waiting', () => {
  assert.equal(giniBlocksConfirmation({ payment_method_id: 'gini', gini_state: 'awaiting_receipt' }), true);
  assert.equal(giniBlocksConfirmation({ payment_method_id: 'gini', gini_state: 'received' }), false);
  assert.equal(giniBlocksConfirmation({ payment_method_id: 'gini', gini_state: 'expired' }), false);
  assert.equal(giniBlocksConfirmation({ payment_method_id: 'cash', gini_state: '' }), false);
  assert.equal(giniBlocksConfirmation({ payment_method_id: 'wallet' }), false);
  assert.equal(giniStateOf('nonsense'), '');
  assert.equal(giniStateOf(null), '');
  assert.equal(giniStateOf('received'), 'received');
});

// ------------------------------------------ the split against real discounts

/**
 * THE CASE THE CLAMP EXISTS FOR, PRICED BY THE REAL ROUTE.
 *
 * `giniSplit(2_000, 5_000)` is asserted as a unit above, but a unit test of a
 * pure function cannot prove that the ROUTE ever hands it a payable smaller
 * than its own delivery fee — and a clamp nothing reaches is a clamp nobody
 * can trust. So this drives the whole checkout there: a coupon validated
 * against merchandise PLUS the delivery it is being spent on, which is what
 * lets `couponDiscount` exceed the goods and leave a payable of 2,000 against
 * a 5,000 fee.
 *
 * `payable - shipping` is −3,000 there. The three things that must hold
 * instead — neither half negative, the door never above the payable, and the
 * two summing back to it — are asserted on the QUOTE and again on the STORED
 * ROW, because those are two different code paths reading one `settle()`.
 */
test('a coupon spent past the merchandise drives the payable under the delivery fee — the split still sums to it', async () => {
  const { raw, db } = setup();
  // 25,000 of goods, a 5,000 delivery, and 28,000 of coupon: the fee is inside
  // the basis the coupon is measured against, so it can eat into it.
  raw.exec("INSERT INTO coupons (id,code,kind,value,min_total_iqd,max_per_user,active) VALUES ('cp_big','GINIBIG','fixed_iqd',28000,0,5,1)");
  // Points funded and asked for in the same breath — both discount levers
  // pulled at once is the shape the report described.
  raw.exec("INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status) VALUES ('pts_b','buyer','deposit','POINT',20000,'approved')");
  cartLine(raw, 'ci1', 'p_pla');
  const a = appAs(db);

  const q = (await json(await post(a, '/api/orders/quote', body({ couponCode: 'GINIBIG', usePoints: true })))).quote;
  assert.equal(q.total_iqd, 2_000, '25,000 + 5,000 − 28,000');
  assert.ok(q.gini.paid_iqd >= 0, `paid_iqd went negative: ${q.gini.paid_iqd}`);
  assert.ok(q.gini.delivery_due_iqd >= 0);
  assert.ok(
    q.gini.delivery_due_iqd <= q.total_iqd,
    'the door amount is clamped to the payable, never the 5,000 tariff',
  );
  assert.equal(q.gini.paid_iqd, 0, 'gini settled nothing — the coupon already had');
  assert.equal(q.gini.delivery_due_iqd, 2_000);
  assert.equal(q.gini.paid_iqd + q.gini.delivery_due_iqd, q.total_iqd, 'the invariant, under the clamp');
  assert.equal(q.due_on_delivery_iqd, 2_000);

  const placed = await json(await post(a, '/api/orders', orderBody({ couponCode: 'GINIBIG', usePoints: true, giniOrderNo: '200200' })));
  assert.equal(placed.success, true, JSON.stringify(placed));
  await Promise.all(pending.splice(0));
  const row = raw.prepare('SELECT * FROM orders WHERE id = ?').get(placed.order.id) as Record<string, unknown>;
  assert.equal(Number(row.gini_paid_iqd), 0);
  assert.equal(Number(row.due_on_delivery_iqd), 2_000);
  assert.equal(Number(row.total_iqd), 2_000);
  assert.equal(
    Number(row.gini_paid_iqd) + Number(row.due_on_delivery_iqd),
    Number(row.total_iqd),
    'the stored invariant survives a coupon bigger than the goods',
  );
});

/**
 * AND WITH POINTS DOING THE WORK. A coupon inside the merchandise leaves the
 * points cap non-zero, so this is the path where BOTH discounts actually
 * apply — 20,000 of coupon and the remaining 5,000 in points — and the payable
 * lands exactly ON the delivery fee. The boundary is worth its own assertion:
 * it is where `Math.min` and a bare subtraction agree, which is precisely why
 * a bug here would not show in the case above.
 */
test('coupon and points together: the door amount is the fee, and gini is left with nothing to have paid', async () => {
  const { raw, db } = setup();
  raw.exec("INSERT INTO coupons (id,code,kind,value,min_total_iqd,max_per_user,active) VALUES ('cp_mid','GINIMID','fixed_iqd',20000,0,5,1)");
  raw.exec("INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status) VALUES ('pts_b','buyer','deposit','POINT',5000,'approved')");
  cartLine(raw, 'ci1', 'p_pla');
  const a = appAs(db);

  const q = (await json(await post(a, '/api/orders/quote', body({ couponCode: 'GINIMID', usePoints: true })))).quote;
  assert.equal(q.coupon.discount_iqd, 20_000);
  assert.equal(q.points.applied_iqd, 5_000, 'the points cap is the merchandise left after the coupon');
  assert.equal(q.total_iqd, 5_000);
  assert.equal(q.gini.delivery_due_iqd, 5_000);
  assert.equal(q.gini.paid_iqd, 0);
  assert.equal(q.gini.paid_iqd + q.gini.delivery_due_iqd, q.total_iqd);
});

// ------------------------------------------------ the confirm gate, for real

/**
 * THE GATE THROUGH BOTH ADMIN DOORS, AGAINST A REAL ORDER.
 *
 * `giniBlocksConfirmation` is asserted as a unit above; this proves the two
 * routes actually consult it, and — the part that matters — that the refusal
 * happens BEFORE the stock moves. `confirmed` maps to a legacy status inside
 * STOCK_DEDUCTED_STATES, so confirming is what turns the checkout's hold into
 * a real decrement: a gate that refused after the move would be decoration.
 */
test('an unscanned gini order cannot be confirmed through either admin door, and its stock does not move', async () => {
  const { raw, db } = setup();
  cartLine(raw, 'ci1', 'p_pla', 2);
  const a = appAs(db);
  const placed = await json(await post(a, '/api/orders', orderBody({ giniOrderNo: '330330' })));
  assert.equal(placed.success, true, JSON.stringify(placed));
  await Promise.all(pending.splice(0));
  const id = placed.order.id as string;
  const admin = adminAppAs(db);

  const deducts = () =>
    (raw.prepare("SELECT COUNT(*) AS n FROM inventory_ledger WHERE order_id = ? AND kind = 'deduct'").get(id) as { n: number }).n;
  const statusOf = () => String((raw.prepare('SELECT status FROM orders WHERE id = ?').get(id) as { status: string }).status);

  // Door 1: the stage panel.
  const byStage = await send(admin, 'PATCH', `/api/admin/orders/${id}/stage`, { stage: 'confirmed' });
  assert.equal(byStage.status, 400);
  assert.equal((await json(byStage)).code, 'GINI_RECEIPT_REQUIRED');

  // Door 2: the legacy status dropdown, which is still the fastest way to
  // move an order and must not be the way round the rule.
  const byStatus = await send(admin, 'PATCH', `/api/admin/orders/${id}`, { status: 'confirmed' });
  assert.equal(byStatus.status, 400);
  assert.equal((await json(byStatus)).code, 'GINI_RECEIPT_REQUIRED');

  // And a jump straight past confirm to a warehouse stage — the gate is keyed
  // on crossing the stock boundary, not on landing on one particular stage.
  const jumped = await send(admin, 'PATCH', `/api/admin/orders/${id}`, { status: 'processing' });
  assert.equal(jumped.status, 400);
  assert.equal((await json(jumped)).code, 'GINI_RECEIPT_REQUIRED');

  assert.equal(deducts(), 0, 'nothing was deducted while the order was refused');
  assert.equal(statusOf(), 'pending');

  // Cancelling is deliberately NOT gated — an unscanned order is exactly the
  // one staff may need to let go of.
  const cancellable = await send(admin, 'PATCH', `/api/admin/orders/${id}/stage`, { stage: 'cancelled' });
  assert.equal(cancellable.status, 200, await cancellable.clone().text());
});

/**
 * A CANCELLED ORDER WAS NEVER HANDED OVER, SO THE BANK MUST NOT BE TOLD IT WAS.
 *
 * Only the expiry sweep ever writes gini_state='expired', and its candidates
 * are `status='pending' AND stage='received'`. Every MANUAL cancellation — the
 * customer's own, the admin's dropdown, the stage door that is deliberately
 * ungated — leaves the state at 'awaiting_receipt', so without a status test
 * the scan form on a dead order is live and the server accepts it: the one
 * record kept to answer a dispute with Rafidain would assert the customer took
 * goods that never shipped, and the GINI_RECEIPT_REQUIRED gate would be
 * cleared for whoever re-opens the order later.
 */
test('a cancelled gini order cannot be stamped as received in the bank app', async () => {
  const { raw, db } = setup();
  cartLine(raw, 'ci1', 'p_pla', 2);
  const a = appAs(db);
  const placed = await json(await post(a, '/api/orders', orderBody({ giniOrderNo: '770770' })));
  assert.equal(placed.success, true, JSON.stringify(placed));
  await Promise.all(pending.splice(0));
  const id = placed.order.id as string;
  const admin = adminAppAs(db);

  // The ungated cancel door, exactly as the test above says it is meant to be.
  const cancelled = await send(admin, 'PATCH', `/api/admin/orders/${id}/stage`, { stage: 'cancelled' });
  assert.equal(cancelled.status, 200, await cancelled.clone().text());
  const afterCancel = raw.prepare('SELECT status, gini_state FROM orders WHERE id = ?').get(id) as Record<string, unknown>;
  assert.equal(afterCancel.status, 'cancelled');
  assert.equal(afterCancel.gini_state, 'awaiting_receipt', 'nothing repairs the state — that is why the guard is needed');

  const scan = await send(admin, 'POST', `/api/admin/orders/${id}/gini-receipt`, { barcode: 'GN-77-00001' });
  assert.equal(scan.status, 400, await scan.clone().text());
  assert.equal((await json(scan)).code, 'ORDER_CANCELLED');

  const row = raw.prepare('SELECT gini_state, gini_received_at, gini_receipt_barcode FROM orders WHERE id = ?').get(id) as Record<string, unknown>;
  assert.equal(row.gini_state, 'awaiting_receipt', 'the bank was not told');
  assert.ok(!row.gini_received_at);
  assert.ok(!row.gini_receipt_barcode);
  const audits = raw.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'order.gini_receipt' AND target = ?").get(id) as { n: number };
  assert.equal(Number(audits.n), 0, 'and no receipt row was written into the record staff answer disputes from');
});

test('the scan is what opens the gate: after the barcode, confirm succeeds and the stock is deducted', async () => {
  const { raw, db } = setup();
  cartLine(raw, 'ci1', 'p_pla', 2);
  const a = appAs(db);
  const placed = await json(await post(a, '/api/orders', orderBody({ giniOrderNo: '440440' })));
  assert.equal(placed.success, true, JSON.stringify(placed));
  await Promise.all(pending.splice(0));
  const id = placed.order.id as string;
  const admin = adminAppAs(db);

  const scanned = await json(await send(admin, 'POST', `/api/admin/orders/${id}/gini-receipt`, { barcode: 'GN-88-12345' }));
  assert.equal(scanned.success, true, JSON.stringify(scanned));
  assert.equal(scanned.gini_state, 'received');
  const row = raw.prepare('SELECT * FROM orders WHERE id = ?').get(id) as Record<string, unknown>;
  assert.equal(row.gini_state, 'received');
  assert.equal(row.gini_receipt_barcode, 'GN-88-12345');
  assert.ok(row.gini_received_at, 'when the shop told the bank, kept beside the order');

  // A second scanner is told it was already done rather than overwriting the
  // first scan's time.
  const again = await send(admin, 'POST', `/api/admin/orders/${id}/gini-receipt`, { barcode: 'GN-88-99999' });
  assert.equal(again.status, 400);
  assert.equal((await json(again)).code, 'GINI_ALREADY_RECEIVED');

  const confirmed = await send(admin, 'PATCH', `/api/admin/orders/${id}/stage`, { stage: 'confirmed' });
  assert.equal(confirmed.status, 200, await confirmed.clone().text());
  const deducts = (raw.prepare("SELECT COUNT(*) AS n FROM inventory_ledger WHERE order_id = ? AND kind = 'deduct'").get(id) as { n: number }).n;
  assert.ok(deducts > 0, 'confirming is what turns the hold into a decrement');

  // The barcode never reaches the customer's payload — they scan it, they do
  // not read it back off our API.
  const mine = await json(await a.request(`/api/orders/${id}`, {}, undefined, ctx));
  assert.equal(mine.order.gini.state, 'received');
  assert.equal(mine.order.gini.order_no, '440440');
  assert.equal('barcode' in mine.order.gini, false);
});

// --------------------------------------------- what LEVONIS is owed, and only that

/**
 * «PAID» MEANS THE MONEY WE WERE OWED ARRIVED — NOT THE WHOLE PRICE.
 *
 * Four queries decide whether an order is settled and all four compared the
 * collections against `orders.total_iqd`. A Gini order's total is the whole
 * price and the only money that can ever reach `order_payment_settlements` is
 * the courier's delivery fee, so all four answered NO for ever: the customer
 * accrued their purchase points, the fee was collected in full, and
 * `releaseDueAccruals` — which selects on `settled_at IS NOT NULL` — could
 * never see them. They were owed points that nothing would ever release.
 *
 * `levonisCollectibleSql` is the correction, and it is on the TOTAL side: the
 * collected figure still says only what Levonis actually took.
 */
test('collecting the delivery fee settles a gini order: the points it earned become releasable', async () => {
  const { raw, db } = setup();
  cartLine(raw, 'ci1', 'p_pla');
  const a = appAs(db);
  const placed = await json(await post(a, '/api/orders', orderBody({ giniOrderNo: '550550' })));
  assert.equal(placed.success, true, JSON.stringify(placed));
  await Promise.all(pending.splice(0));
  const id = placed.order.id as string;

  const accrual = () =>
    raw.prepare("SELECT points, state, settled_at FROM points_accruals WHERE order_id = ? AND kind = 'purchase'").get(id) as
      | { points: number; state: string; settled_at: string | null }
      | undefined;
  assert.ok((accrual()?.points ?? 0) > 0, 'the purchase earned points');
  assert.equal(accrual()?.settled_at, null, 'nothing is collected yet');

  const money = raw.prepare('SELECT due_on_delivery_iqd AS due, total_iqd AS total, gini_paid_iqd AS gini FROM orders WHERE id = ?').get(id) as
    { due: number; total: number; gini: number };
  assert.ok(money.due < money.total, 'the door amount can never reach the total — that is the whole bug');

  const result = await recordOrderSettlement({ DB: db } as unknown as Env, id, {
    kind: 'cod_collection',
    amountIqd: money.due,
    eventKey: 'cod:gini-door-fee',
  });
  assert.equal(result.fully_settled, true, 'everything Levonis was owed has arrived');
  assert.ok(accrual()?.settled_at, 'and the accrual may now be released');

  // The collected figure still tells the truth about what WE took: the fee,
  // never the instalments the bank financed.
  const collected = raw.prepare('SELECT COALESCE(SUM(amount_iqd),0) AS n FROM order_payment_settlements WHERE order_id = ?').get(id) as { n: number };
  assert.equal(Number(collected.n), money.due);
});

// ---------------------------------------- what the courier is told to collect

/**
 * «ويتم دفع التوصيل فقط» — AND THE DRIVER HAS TO BE TOLD THAT.
 *
 * The dispatch call used to send `payment_method_id === 'cash' ? total_iqd : 0`.
 * That held while "not cash" meant "already paid in full", and Gini ended it:
 * the goods are settled in the app and the delivery fee is still genuinely due
 * at the door. Sending 0 puts a driver on the doorstep with nothing to collect
 * and loses the fee on every Gini delivery — silently, because a shipment
 * created for 0 is not an error anywhere.
 *
 * The courier is stubbed at `fetch`, which is the only boundary that matters:
 * the assertion is on the NUMBER that leaves this building.
 */
test('the courier is asked for the delivery fee on a gini order — not 0, and not the whole price', async () => {
  const { raw, db } = setup();
  raw
    .prepare("INSERT INTO admin_settings (key, value) VALUES ('deliveryConfig', ?)")
    .run(JSON.stringify({ createPath: '/create', createFields: { amountIqd: 'price', orderId: 'ref' } }));
  cartLine(raw, 'ci1', 'p_x1');
  const a = appAs(db);
  const placed = await json(await post(a, '/api/orders', orderBody({ giniOrderNo: '660660' })));
  assert.equal(placed.success, true, JSON.stringify(placed));
  await Promise.all(pending.splice(0));
  const id = placed.order.id as string;

  const sent: Record<string, unknown>[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    return new Response(JSON.stringify({ id: 'AW-9', tracking_number: 'T-9' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    const admin = new Hono<AppContext>();
    admin.use('*', async (c, next) => {
      c.set('host', classifyHost('levonis-iq.com', 'levonis-iq.com'));
      c.set('user', { id: 'boss', role: 'admin', email: 'b@x.co', username: 'boss', admin_scope: null, is_investor: 0 } as never);
      c.env = {
        DB: db,
        ALWASEET_BASE_URL: 'https://courier.invalid',
        ALWASEET_USERNAME: 'u',
        ALWASEET_PASSWORD: 'p',
      } as never;
      await next();
    });
    admin.use('/api/admin/*', requireMainHost);
    admin.route('/api/admin', adminRoutes);
    admin.onError((err, c) => {
      if (err instanceof HttpError) return c.json({ success: false, error: err.message, code: err.code }, err.status as 400);
      throw err;
    });

    // AND THE PARCEL IS NOT HANDED OVER BEFORE THE BANK IS TOLD. Creating a
    // shipment is the point of no return: the 15-minute courier sweep then
    // force-moves the order to shipped/delivered through `moveOrderStage`,
    // which deducts the stock with no Gini gate of its own — the one crossing
    // «يجب اعلام منصه جني… قبل ان يتم تجهيز الطلب» exists to prevent, reached
    // without the scan both admin doors refuse. The precondition belongs here
    // and not in the sweep: the courier's report of a delivered parcel must
    // still be recorded, or inventory believes shipped units are on the shelf.
    const unscanned = await admin.request(`/api/admin/orders/${id}/delivery`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, undefined, ctx);
    assert.equal(unscanned.status, 400, await unscanned.clone().text());
    assert.equal((await json(unscanned)).code, 'GINI_RECEIPT_REQUIRED');
    assert.equal(sent.length, 0, 'nothing left the building');
    const noShipment = raw.prepare('SELECT delivery_remote_id FROM orders WHERE id = ?').get(id) as { delivery_remote_id: string | null };
    assert.ok(!noShipment.delivery_remote_id, 'and the order cannot acquire a remote id the sweep would pick up');

    const scanned = await admin.request(`/api/admin/orders/${id}/gini-receipt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ barcode: 'GN-66-00001' }) }, undefined, ctx);
    assert.equal(scanned.status, 200, await scanned.clone().text());

    const res = await admin.request(`/api/admin/orders/${id}/delivery`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, undefined, ctx);
    assert.equal(res.status, 200, await res.clone().text());
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(sent.length, 1, 'one shipment, one call');
  assert.equal(sent[0].price, DELIVERY_IQD, 'the door amount, which is the delivery fee');
  assert.notEqual(sent[0].price, 0, 'the old `not cash → 0` rule lost this fee on every gini delivery');
  assert.notEqual(sent[0].price, PRINTER_IQD + DELIVERY_IQD, 'and it is never the whole price gini already financed');
});

// ------------------------------------- what may be REFUNDED, and to whom

/**
 * A REFUND MAY ONLY GIVE BACK MONEY LEVONIS ACTUALLY TOOK.
 *
 * The return pipeline credits the Levo wallet with the returned line's stored
 * price, net of discounts, and it read nothing about how the order was paid.
 * On a Gini order that is ~894,000 IQD of real, immediately spendable balance
 * conjured out of nothing on one printer: the goods were settled inside the
 * bank's app before the order existed — `gini_paid_iqd` is the record of it —
 * and the only dinar that ever reached Levonis is the delivery fee at the
 * door, which is not refunded here anyway. The customer's instalments to
 * Rafidain are untouched either way.
 *
 * The customer is still owed the money, so the amount is not clamped away in
 * silence: it comes back as `gini_refund_due_iqd`, lands in the audit row, and
 * is written onto the case's own note — the queue is where the next member of
 * staff picks the case up — so somebody knows to arrange the reversal with the
 * bank. There is no Gini integration here and inventing one would be a lie.
 */
test('an approved return on a gini order credits no wallet balance — the goods money was never ours', async () => {
  const { raw, db } = setup();
  cartLine(raw, 'ci1', 'p_x1');
  const a = appAs(db);
  const placed = await json(await post(a, '/api/orders', orderBody({ giniOrderNo: '880880' })));
  assert.equal(placed.success, true, JSON.stringify(placed));
  await Promise.all(pending.splice(0));
  const id = placed.order.id as string;
  const admin = adminAppAs(db);

  // The real road to a refundable order: scanned, confirmed, delivered.
  assert.equal((await send(admin, 'POST', `/api/admin/orders/${id}/gini-receipt`, { barcode: 'GN-88-00001' })).status, 200);
  assert.equal((await send(admin, 'PATCH', `/api/admin/orders/${id}/stage`, { stage: 'confirmed' })).status, 200);
  raw
    .prepare("UPDATE orders SET status='delivered', stage='delivered', delivered_at=? WHERE id=?")
    .run(new Date().toISOString(), id);

  const money = raw.prepare('SELECT gini_paid_iqd AS gini, due_on_delivery_iqd AS due FROM orders WHERE id = ?').get(id) as
    { gini: number; due: number };
  assert.equal(Number(money.gini), PRINTER_IQD, 'the bank financed the goods');
  assert.equal(Number(money.due), DELIVERY_IQD, 'and the door collected the fee, nothing else');

  const itemId = String((raw.prepare('SELECT id FROM order_items WHERE order_id = ?').get(id) as { id: string }).id);
  const opened = await json(await post(a, '/api/returns', { orderItemId: itemId, qty: 1, reason: 'defective' }));
  assert.equal(opened.success, true, JSON.stringify(opened));
  // Named rather than `(opened.case ?? opened.cases?.[0]).id`: if the route
  // ever answers with neither shape, that expression throws a bare TypeError
  // and the failure says nothing about what the door actually returned.
  const openedCase = opened.case ?? (Array.isArray(opened.cases) ? opened.cases[0] : undefined);
  assert.ok(openedCase?.id, `POST /api/returns returned no case: ${JSON.stringify(opened)}`);
  const caseId = String(openedCase.id);

  const spendable = () =>
    Number(
      (raw
        .prepare("SELECT COALESCE(SUM(amount),0) AS n FROM wallet_transactions WHERE user_id='buyer' AND currency='USD' AND status='approved'")
        .get() as { n: number }).n
    );
  const before = spendable();

  for (const to of ['assessment', 'approved', 'received', 'inspected']) {
    const step = await send(admin, 'POST', `/api/returns/admin/${caseId}/transition`, { to });
    assert.equal(step.status, 200, `${to}: ${await step.clone().text()}`);
  }
  const resolved = await json(
    await send(admin, 'POST', `/api/returns/admin/${caseId}/transition`, { to: 'resolved', resolution: 'refund' })
  );
  assert.equal(resolved.success, true, JSON.stringify(resolved));

  // THE ASSERTION THE BUG FAILS: not one cent of Levo balance was minted.
  assert.equal(spendable(), before, 'a wallet credit here is money Levonis never received');
  assert.equal(resolved.refund.credited, false);
  assert.equal(resolved.refund.amount_usd_cents, 0);
  assert.equal(resolved.refund.channel, 'gini');
  const ledger = raw.prepare('SELECT COUNT(*) AS n FROM wallet_transactions WHERE id = ?').get(`wtx_ret_${caseId}`) as { n: number };
  assert.equal(Number(ledger.n), 0, 'no deposit row at all, so nothing can be released by a later approval either');

  // AND IT DID NOT VANISH: the admin resolving the case is told what the bank
  // still owes, and so is the case itself.
  assert.ok(Number(resolved.refund.gini_refund_due_iqd) > 800_000, JSON.stringify(resolved.refund));
  assert.equal(Number(resolved.refund.gini_refund_due_iqd), Number(resolved.refund.amount_iqd));
  assert.match(String(resolved.refund.channel_note), /Gini/);
  const note = String((raw.prepare('SELECT admin_note FROM return_cases WHERE id = ?').get(caseId) as { admin_note: string }).admin_note);
  assert.match(note, /\[GINI\]/, 'the queue is where the next member of staff picks this up');
  assert.match(note, new RegExp(String(resolved.refund.gini_refund_due_iqd)));

  // The goods still came back and the points still go back: only the money
  // side that was never ours is withheld.
  const restores = raw.prepare("SELECT COUNT(*) AS n FROM inventory_ledger WHERE order_id = ? AND kind = 'restore'").get(id) as { n: number };
  assert.ok(Number(restores.n) > 0, 'the returned unit is back on the shelf');
});

// --------------------------------------------- and what the CUSTOMER reads

/**
 * «ملاحظه مهمه للمستخدم» — BUT NOT ON AN ORDER THAT NO LONGER EXISTS.
 *
 * Nothing rewrites `gini_state` when an order is cancelled by hand (only the
 * sweep writes 'expired', and it selects pending orders), and `can_cancel` is
 * true for any pending order — so the ordinary customer cancel leaves the
 * amber «امسح الباركود وإلا يُلغى الطلب غدًا» box rendering directly under the
 * «ملغي» pill, telling the customer to go and act on a dead order.
 *
 * The guard is asserted on the SOURCE because it belongs on the client: a
 * server-side cancelled → 'expired' mapping would make the customer read
 * «انتهت مهلة هذا الطلب قبل مسح باركود الاستلام», which asserts the hold ran
 * out — false for an order somebody cancelled on purpose.
 */
test('the order page does not ask a cancelled gini order to scan a barcode', () => {
  const src = readFileSync(join(ROOT, 'src/pages/OrderDetail.tsx'), 'utf8');
  assert.match(
    src,
    /\{order\.status !== 'cancelled' && order\.gini && order\.gini\.state === 'awaiting_receipt' && \(/,
    'the awaiting notice must be gated on the order still being alive'
  );
  // The genuine sweep case is untouched: that copy IS true, and it is the
  // only thing a cancelled-by-hand order must not be shown instead.
  assert.match(src, /\{order\.gini && order\.gini\.state === 'expired' && \(/);
  assert.ok(
    !/giniStateOf\(/.test(src),
    'and the status is not laundered into a gini state on the way here'
  );
});
