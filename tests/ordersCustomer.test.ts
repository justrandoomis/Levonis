/**
 * The customer's "My Orders" API, tested as the promises the screens rely on.
 *
 *   * ownership — another customer asking for my order, or for the devices
 *     inside it, gets the same 404 the order's absence would give;
 *   * pagination — `limit`/`before` walk the list newest-first, one page at a
 *     time, and `next_before` is null exactly on the last page;
 *   * the units endpoint masks every serial to its last four characters and
 *     reports `linked` as mine / other / none without naming the other party;
 *   * cancellation is a pending-only verb.
 *
 * The real routes run against real migrations through the SQLite adapter;
 * only the session is stubbed.
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
import { orderRoutes } from '../worker/routes/orders';

const ORDER_COLS = `id, user_id, status, stage, shipping_type, address_snapshot, delivery_method_id, delivery_method_snapshot,
  payment_method_id, subtotal_iqd, shipping_iqd, exchange_rate, total_iqd, due_on_delivery_iqd, delivered_at, created_at, updated_at`;

function order(id: string, user: string, status: string, stage: string, createdAt: string, delivered: string | null = null) {
  const d = delivered ? `'${delivered}'` : 'NULL';
  return `INSERT INTO orders (${ORDER_COLS}) VALUES
    ('${id}','${user}','${status}','${stage}','direct','{}','standard','{}','cash',100000,5000,1400,105000,${status === 'delivered' ? 0 : 105000},${d},'${createdAt}','${createdAt}');`;
}

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) raw.exec(readFileSync(join(dir, f), 'utf8'));
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','s@x.co','h','customer'), ('stranger','Omar','o@x.co','h','customer'), ('boss','Admin','a@x.co','h','admin');
    INSERT INTO products (id,slug,name,name_ar,price_iqd,images) VALUES
      ('p1','bambu-a1','Bambu A1','بامبو A1',899000,'["https://img/a1.jpg"]'),
      ('p2','pla-white','PLA White','PLA أبيض',25000,'[]');
    ${order('ORD-1', 'buyer', 'delivered', 'delivered', '2026-01-01T10:00:00.000Z', '2026-01-04T10:00:00.000Z')}
    ${order('ORD-2', 'buyer', 'pending', 'received', '2026-01-02T10:00:00.000Z')}
    ${order('ORD-3', 'buyer', 'confirmed', 'confirmed', '2026-01-03T10:00:00.000Z')}
    ${order('ORD-4', 'buyer', 'processing', 'preparing', '2026-01-04T10:00:00.000Z')}
    ${order('ORD-5', 'buyer', 'shipped', 'out_for_delivery', '2026-01-05T10:00:00.000Z')}
    ${order('ORD-X', 'stranger', 'pending', 'received', '2026-01-06T10:00:00.000Z')}
    INSERT INTO order_items (id, order_id, product_id, name_snapshot, option_snapshot, qty, unit_price_iqd, line_total_iqd, option_id, option_value_ids, color_id, transport_snapshot, warranty_snapshot)
     VALUES ('oi1','ORD-1','p1','Bambu A1','Combo',2,899000,1798000,'o_combo','["o_combo"]','c_black','{"method":"sea","commission_iqd":0}','{"plan_id":"w24","duration_months":24}'),
            ('oi2','ORD-1','p2','PLA White','',6,25000,150000,'','[]','',NULL,NULL),
            ('oi3','ORD-2','p2','PLA White','',1,25000,25000,'','[]','',NULL,NULL),
            ('oi4','ORD-3','p2','PLA White','',1,25000,25000,'','[]','',NULL,NULL),
            ('oi5','ORD-4','p2','PLA White','',1,25000,25000,'','[]','',NULL,NULL),
            ('oi6','ORD-5','p2','PLA White','',1,25000,25000,'','[]','',NULL,NULL),
            ('oiX','ORD-X','p2','PLA White','',1,25000,25000,'','[]','',NULL,NULL);
    INSERT INTO order_item_units (id, order_id, order_item_id, product_id, owner_user_id, unit_index, delivered_at, warranty_base_months, warranty_start_at, warranty_end_at)
     VALUES ('u1','ORD-1','oi1','p1','buyer',1,'2026-01-04T10:00:00.000Z',12,'2026-01-04T10:00:00.000Z','2099-01-04T10:00:00.000Z'),
            ('u2','ORD-1','oi1','p1','buyer',2,'2026-01-04T10:00:00.000Z',12,'2026-01-04T10:00:00.000Z','2099-01-04T10:00:00.000Z');
    INSERT INTO device_serials (serial_norm, serial_raw, unit_id, assigned_by) VALUES
      ('SN1234ABCD','SN-1234-ABCD','u1','boss'), ('SN9999ZZZZ','SN-9999-ZZZZ','u2','boss');
    -- u1 is held by the buyer; u2 was handed on and is held by another account.
    INSERT INTO device_registrations (unit_id, user_id) VALUES ('u1','buyer'), ('u2','stranger');
    INSERT INTO warranty_receipts (id, receipt_no, unit_id, order_id, order_item_id, product_id, user_id, serial_norm, serial_raw, status)
     VALUES ('wr1','WR-2026-0104-001','u1','ORD-1','oi1','p1','buyer','SN1234ABCD','SN-1234-ABCD','active');
    INSERT INTO invoices (id, invoice_no, order_id, revision, snapshot, payment_status) VALUES
      ('inv1','INV-2026-000001','ORD-1',1,'{}','paid'),
      ('inv2','INV-2026-000002','ORD-1',2,'{}','paid');
  `);
  return { raw, db: new SqliteD1(raw) as unknown as D1Database };
}

function appAs(db: D1Database, user: { id: string; role: string }) {
  const a = new Hono<AppContext>();
  a.use('*', async (c, next) => {
    c.set('user', { id: user.id, role: user.role, email: `${user.id}@x.co` } as never);
    c.env = { DB: db } as never;
    await next();
  });
  a.route('/api/orders', orderRoutes);
  a.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ success: false, error: err.message, code: err.code }, err.status as 400);
    throw err;
  });
  return a;
}
const buyer = { id: 'buyer', role: 'customer' };
const stranger = { id: 'stranger', role: 'customer' };
const boss = { id: 'boss', role: 'admin' };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response) => (await res.json()) as Record<string, any>;
const post = (a: ReturnType<typeof appAs>, path: string, body: unknown = {}) =>
  a.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// ------------------------------------------------------------------ ownership

test('another customer gets 404 on my order and on its units; the owner and an admin get it', async () => {
  const { db } = setup();
  assert.equal((await appAs(db, stranger).request('/api/orders/ORD-1')).status, 404);
  assert.equal((await appAs(db, stranger).request('/api/orders/ORD-1/units')).status, 404);
  assert.equal((await appAs(db, buyer).request('/api/orders/ORD-1')).status, 200);
  assert.equal((await appAs(db, buyer).request('/api/orders/ORD-1/units')).status, 200);
  assert.equal((await appAs(db, boss).request('/api/orders/ORD-1')).status, 200);
  assert.equal((await appAs(db, boss).request('/api/orders/ORD-1/units')).status, 200);
  // …and the list never crosses accounts.
  const mine = await json(await appAs(db, buyer).request('/api/orders?limit=50'));
  assert.deepEqual(
    mine.orders.map((o: { id: string }) => o.id).sort(),
    ['ORD-1', 'ORD-2', 'ORD-3', 'ORD-4', 'ORD-5']
  );
});

// ----------------------------------------------------------------- pagination

test('limit/before walk the list newest-first and next_before is null on the last page', async () => {
  const { db } = setup();
  const a = appAs(db, buyer);
  const p1 = await json(await a.request('/api/orders?limit=2'));
  assert.deepEqual(p1.orders.map((o: { id: string }) => o.id), ['ORD-5', 'ORD-4']);
  assert.equal(p1.next_before, '2026-01-04T10:00:00.000Z');

  const p2 = await json(await a.request(`/api/orders?limit=2&before=${encodeURIComponent(p1.next_before)}`));
  assert.deepEqual(p2.orders.map((o: { id: string }) => o.id), ['ORD-3', 'ORD-2']);
  assert.equal(p2.next_before, '2026-01-02T10:00:00.000Z');

  const p3 = await json(await a.request(`/api/orders?limit=2&before=${encodeURIComponent(p2.next_before)}`));
  assert.deepEqual(p3.orders.map((o: { id: string }) => o.id), ['ORD-1']);
  assert.equal(p3.next_before, null, 'the last page carries no cursor');

  // The default page is 20 and the ceiling is 50; a bad cursor is refused.
  const all = await json(await a.request('/api/orders'));
  assert.equal(all.orders.length, 5);
  assert.equal(all.next_before, null);
  assert.equal((await a.request('/api/orders?limit=51')).status, 400);
  assert.equal((await a.request('/api/orders?before=yesterday')).status, 400);
});

test('the status filter takes one status or several, and an unknown one matches nothing', async () => {
  const { db } = setup();
  const a = appAs(db, buyer);
  const pending = await json(await a.request('/api/orders?status=pending'));
  assert.deepEqual(pending.orders.map((o: { id: string }) => o.id), ['ORD-2']);
  const toShip = await json(await a.request('/api/orders?status=confirmed,processing'));
  assert.deepEqual(toShip.orders.map((o: { id: string }) => o.id), ['ORD-4', 'ORD-3']);
  const bogus = await json(await a.request('/api/orders?status=bogus'));
  assert.deepEqual(bogus.orders, []);
  assert.equal(bogus.next_before, null);
});

test('every order on the page carries its items from one query, an item_count and a progress fraction', async () => {
  const { db } = setup();
  const list = await json(await appAs(db, buyer).request('/api/orders?limit=50'));
  const byId = new Map<string, Record<string, unknown>>(list.orders.map((o: { id: string }) => [o.id, o]));
  const delivered = byId.get('ORD-1') as { items: unknown[]; item_count: number; progress: { index: number; total: number } };
  assert.equal(delivered.items.length, 2);
  assert.equal(delivered.item_count, 8, '2 printers + 6 spools');
  assert.deepEqual(delivered.progress, { index: 5, total: 5 });
  const pending = byId.get('ORD-2') as { item_count: number; progress: { index: number; total: number } };
  assert.equal(pending.item_count, 1);
  assert.deepEqual(pending.progress, { index: 1, total: 5 });
  const shipped = byId.get('ORD-5') as { progress: { index: number; total: number } };
  assert.deepEqual(shipped.progress, { index: 4, total: 5 });
});

// --------------------------------------------------------------------- detail

test('GET /:id adds product slugs, the stored selection, the latest invoice and the two verbs', async () => {
  const { db } = setup();
  const a = appAs(db, buyer);
  const delivered = (await json(await a.request('/api/orders/ORD-1'))).order;
  assert.equal(delivered.can_cancel, false);
  assert.equal(delivered.can_review, true);
  assert.equal(delivered.item_count, 8);
  assert.deepEqual(delivered.invoice, { id: 'inv2', invoice_no: 'INV-2026-000002', revision: 2, payment_status: 'paid' });
  const printer = delivered.items.find((it: { id: string }) => it.id === 'oi1');
  assert.equal(printer.product_slug, 'bambu-a1');
  assert.deepEqual(printer.selection, {
    option_id: 'o_combo',
    option_value_ids: ['o_combo'],
    color_id: 'c_black',
    transport_method: 'sea',
    warranty_plan_id: 'w24',
  });
  const spool = delivered.items.find((it: { id: string }) => it.id === 'oi2');
  assert.deepEqual(spool.selection, { option_id: '', option_value_ids: [], color_id: '', transport_method: '', warranty_plan_id: '' });

  const pending = (await json(await a.request('/api/orders/ORD-2'))).order;
  assert.equal(pending.can_cancel, true);
  assert.equal(pending.can_review, false);
  assert.equal(pending.invoice, null);
});

// ---------------------------------------------------------------------- units

test('units mask the serial, report linked as mine/other/none and never name the other account', async () => {
  const { db, raw } = setup();
  const res = await json(await appAs(db, buyer).request('/api/orders/ORD-1/units'));
  assert.equal(res.order_id, 'ORD-1');
  assert.equal(res.units.length, 2);
  const [u1, u2] = res.units;

  assert.equal(u1.unit_id, 'u1');
  assert.equal(u1.serial, '****ABCD');
  assert.equal(u1.linked, 'mine');
  assert.equal(u1.receipt_no, 'WR-2026-0104-001');
  assert.equal(u1.warranty.state, 'active');
  assert.ok(u1.warranty.remaining_days > 0);
  assert.equal(u1.product.slug, 'bambu-a1');
  assert.equal(u1.product.image, 'https://img/a1.jpg');
  assert.equal(u1.replaced, false);

  assert.equal(u2.serial, '****ZZZZ');
  assert.equal(u2.linked, 'other');
  assert.equal(u2.receipt_no, null);
  // Nothing in the payload names who holds u2.
  assert.ok(!JSON.stringify(res).includes('stranger'));
  assert.ok(!JSON.stringify(res).includes('SN-9999-ZZZZ'), 'the raw serial never leaves the server');

  // A revoked registration is no link at all; an unlinked unit says 'none'.
  raw.exec("UPDATE device_registrations SET revoked_at = '2026-02-01T00:00:00.000Z' WHERE unit_id = 'u2'");
  const after = await json(await appAs(db, buyer).request('/api/orders/ORD-1/units'));
  assert.equal(after.units[1].linked, 'none');

  // An order with no serialized items answers with an empty list, not a 404.
  const none = await json(await appAs(db, buyer).request('/api/orders/ORD-2/units'));
  assert.deepEqual(none.units, []);
});

// --------------------------------------------------------------------- cancel

test('only a pending order can be cancelled; every other status is refused with 400', async () => {
  const { db, raw } = setup();
  const a = appAs(db, buyer);
  for (const id of ['ORD-1', 'ORD-3', 'ORD-4', 'ORD-5']) {
    const res = await post(a, `/api/orders/${id}/cancel`);
    assert.equal(res.status, 400, `${id} must not be cancellable`);
    assert.match((await json(res)).error, /pending/i);
  }
  // Nothing moved.
  const statuses = raw.prepare("SELECT id, status FROM orders WHERE user_id = 'buyer' ORDER BY id").all() as Array<{ id: string; status: string }>;
  assert.deepEqual(statuses.map((r) => r.status), ['delivered', 'pending', 'confirmed', 'processing', 'shipped']);

  // A stranger cannot cancel my pending order either — same 404 as reading it.
  assert.equal((await post(appAs(db, stranger), '/api/orders/ORD-2/cancel')).status, 404);
});
