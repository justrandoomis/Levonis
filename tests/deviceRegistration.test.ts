/**
 * ONE ACCOUNT PER DEVICE, and ONE ANSWER for a serial that is not yours.
 *
 * The owner's rules for /warranty: a printer is linked to exactly one account;
 * to move it, the account that holds it unlinks it first (or an admin does,
 * when that account is lost); and a wrong, used or unknown serial gets the
 * same words — «غير موجود أو مستخدم مسبقًا / Not found or already in use.» —
 * so nobody can learn which serials exist or whose they are by typing.
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
import { deviceRoutes, SERIAL_NOT_FOUND_OR_IN_USE, receiptNoFrom } from '../worker/routes/devices';
import { warrantyPublicRoutes } from '../worker/routes/warranty';

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) raw.exec(readFileSync(join(dir, f), 'utf8'));
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','s@x.co','h','customer'), ('stranger','Omar','o@x.co','h','customer'), ('boss','Admin','a@x.co','h','admin');
    INSERT INTO products (id,slug,name,price_iqd) VALUES ('p1','a1','Bambu A1',899000);
    INSERT INTO orders (id, user_id, status, address_snapshot, delivery_method_id, delivery_method_snapshot,
       payment_method_id, subtotal_iqd, shipping_iqd, exchange_rate, total_iqd, due_on_delivery_iqd, delivered_at, created_at, updated_at)
     VALUES ('ORD-1','buyer','delivered','{}','standard','{}','cash',899000,0,1400,899000,0,${NOW},${NOW},${NOW});
    INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_iqd, line_total_iqd)
     VALUES ('oi1','ORD-1','p1','Bambu A1',2,899000,1798000);
    INSERT INTO order_item_units (id, order_id, order_item_id, product_id, owner_user_id, unit_index, delivered_at, warranty_base_months, warranty_start_at, warranty_end_at)
     VALUES ('u1','ORD-1','oi1','p1','buyer',1,${NOW},12,${NOW},'2027-09-05T00:00:00.000Z'),
            ('u2','ORD-1','oi1','p1','buyer',2,NULL,12,NULL,NULL);
    INSERT INTO device_serials (serial_norm, serial_raw, unit_id, assigned_by) VALUES ('SN1234ABCD','SN-1234-ABCD','u1','boss'), ('SN9999ZZZZ','SN-9999-ZZZZ','u2','boss');
    INSERT INTO warranty_receipts (id, receipt_no, unit_id, order_id, order_item_id, product_id, user_id, serial_norm, serial_raw, status)
     VALUES ('wr1','WR-2026-0905-001','u1','ORD-1','oi1','p1','buyer','SN1234ABCD','SN-1234-ABCD','active');
  `);
  return { raw, db: new SqliteD1(raw) as unknown as D1Database };
}

function appAs(db: D1Database, user: { id: string; role: string }) {
  const a = new Hono<AppContext>();
  a.use('*', async (c, next) => {
    c.set('user', { id: user.id, role: user.role, email: `${user.id}@x.co` } as never);
    c.env = { DB: db, APP_ORIGIN: 'https://levonis-iq.com', STORE_ROOT_DOMAIN: 'levonis-iq.com' } as never;
    await next();
  });
  a.route('/api/devices', deviceRoutes);
  a.route('/api/warranty', warrantyPublicRoutes);
  a.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ success: false, error: err.message, code: err.code }, err.status as 400);
    throw err;
  });
  return a;
}
const buyer = { id: 'buyer', role: 'customer' };
const stranger = { id: 'stranger', role: 'customer' };
const boss = { id: 'boss', role: 'admin' };
const json = async (res: Response) => (await res.json()) as Record<string, any>;
const post = (a: ReturnType<typeof appAs>, path: string, body: unknown = {}) =>
  a.request(path, { method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' }, body: JSON.stringify(body) });
const del = (a: ReturnType<typeof appAs>, path: string) => a.request(path, { method: 'DELETE' });

// ------------------------------------------------------------- the one answer

test('unknown, undelivered, and someone else\'s serial all get the same words and the same status', async () => {
  const { db } = setup();
  const s = appAs(db, stranger);
  const b = appAs(db, buyer);
  assert.equal((await post(b, '/api/devices/register', { serial: 'SN-1234-ABCD' })).status, 200, 'the buyer links it first');
  const answers = await Promise.all([
    post(s, '/api/devices/register', { serial: 'NOPE-0000' }), // unknown
    post(s, '/api/devices/register', { serial: 'SN-9999-ZZZZ' }), // exists, not delivered
    post(s, '/api/devices/register', { serial: 'SN-1234-ABCD' }), // exists, linked to the buyer
    post(s, '/api/devices/register', { serial: 'WR-2026-0905-001' }), // its receipt number, same device
  ]);
  const bodies = await Promise.all(answers.map(json));
  for (const [i, res] of answers.entries()) {
    assert.equal(res.status, 404, `case ${i}`);
    assert.equal(bodies[i].error, SERIAL_NOT_FOUND_OR_IN_USE, `case ${i}`);
    assert.equal(bodies[i].code, 'SERIAL_NOT_FOUND_OR_IN_USE', `case ${i}`);
  }
  assert.match(SERIAL_NOT_FOUND_OR_IN_USE, /Not found or already in use\./);
});

// ----------------------------------------------------------- one account only

test('the buyer links by serial, by receipt number, or by the receipt\'s QR link — idempotently', async () => {
  const { db } = setup();
  const b = appAs(db, buyer);
  const first = await json(await post(b, '/api/devices/register', { serial: 'sn 1234 abcd' }));
  assert.equal(first.success, true);
  assert.equal(first.device.unit_id, 'u1');
  assert.equal(first.device.serial, '****ABCD', 'masked for the customer');
  assert.equal(first.device.receipt.receipt_no, 'WR-2026-0905-001', 'the live receipt travels with the device');
  assert.equal(first.already_registered, false);
  const again = await json(await post(b, '/api/devices/register', { serial: 'WR-2026-0905-001' }));
  assert.equal(again.already_registered, true);
  const viaQr = await json(await post(b, '/api/devices/register', { serial: 'https://levonis-iq.com/warranty/WR-2026-0905-001' }));
  assert.equal(viaQr.already_registered, true);
  assert.equal(receiptNoFrom('https://levonis-iq.com/warranty/WR-2026-0905-001'), 'WR-2026-0905-001');
  assert.equal(receiptNoFrom('SN-1234-ABCD'), null);
  const mine = await json(await b.request('/api/devices/mine'));
  assert.equal(mine.devices.length, 1);
  assert.equal(mine.devices[0].transferred, false);
});

test('a device held by one account cannot be linked by another until the holder unlinks it', async () => {
  const { db } = setup();
  const b = appAs(db, buyer);
  const s = appAs(db, stranger);
  assert.equal((await post(b, '/api/devices/register', { serial: 'SN-1234-ABCD' })).status, 200);
  // The stranger holds the physical device now and types its serial: refused
  // with the one answer, nothing about the buyer revealed.
  assert.equal((await post(s, '/api/devices/register', { serial: 'SN-1234-ABCD' })).status, 404);
  // The buyer unlinks…
  assert.equal((await del(b, '/api/devices/units/u1/registration')).status, 200);
  assert.equal((await json(await b.request('/api/devices/mine'))).devices.length, 0);
  // …and the stranger can link it: a transfer.
  const moved = await json(await post(s, '/api/devices/register', { serial: 'SN-1234-ABCD' }));
  assert.equal(moved.success, true);
  assert.equal(moved.device.transferred, true, 'held by someone other than the buyer');
  // Now the BUYER is the one refused — same words.
  const back = await post(b, '/api/devices/register', { serial: 'SN-1234-ABCD' });
  assert.equal(back.status, 404);
  assert.equal((await json(back)).error, SERIAL_NOT_FOUND_OR_IN_USE);
  // The buyer's "from my orders" list shows the device as linked elsewhere,
  // and the by-unit path says why instead of pretending it does not exist.
  const eligible = await json(await b.request('/api/devices/eligible'));
  const u1 = eligible.units.find((u: { unit_id: string }) => u.unit_id === 'u1');
  assert.equal(u1.linked_elsewhere, true);
  const byUnit = await post(b, '/api/devices/units/u1/register', {});
  assert.equal(byUnit.status, 409);
  assert.equal((await json(byUnit)).code, 'LINKED_ELSEWHERE');
});

test('"from my previous orders": only delivered, unlinked, unreplaced units of the buyer — linked by unit id', async () => {
  const { db } = setup();
  const b = appAs(db, buyer);
  const s = appAs(db, stranger);
  const before = await json(await b.request('/api/devices/eligible'));
  assert.deepEqual(before.units.map((u: { unit_id: string }) => u.unit_id), ['u1'], 'u2 is not delivered');
  assert.equal((await json(await s.request('/api/devices/eligible'))).units.length, 0, 'the stranger bought nothing');
  const linked = await json(await post(b, '/api/devices/units/u1/register', {}));
  assert.equal(linked.success, true);
  assert.equal((await json(await b.request('/api/devices/eligible'))).units.length, 0, 'linked → no longer eligible');
  // A unit id that is not the caller's is indistinguishable from a missing one.
  assert.equal((await post(s, '/api/devices/units/u1/register', {})).status, 404);
  assert.equal((await post(b, '/api/devices/units/u2/register', {})).status, 400, 'not delivered yet');
});

test('an open claim keeps the device with its holder; a closed one frees it', async () => {
  const { db, raw } = setup();
  const b = appAs(db, buyer);
  assert.equal((await post(b, '/api/devices/register', { serial: 'SN-1234-ABCD' })).status, 200);
  const claim = await json(await post(b, '/api/devices/units/u1/claims', { subject: 'Nozzle clog', description: 'It stopped extruding after two prints.' }));
  assert.equal(claim.success, true);
  assert.equal(claim.priority, false, 'no PRO membership → no priority');
  const blocked = await del(b, '/api/devices/units/u1/registration');
  assert.equal(blocked.status, 409);
  assert.equal((await json(blocked)).code, 'CLAIM_OPEN');
  raw.prepare("UPDATE warranty_claims SET stage = 'resolved', status = 'approved' WHERE id = ?").run(claim.id);
  assert.equal((await del(b, '/api/devices/units/u1/registration')).status, 200);
});

test('a claim is opened by the account that HOLDS the device, not only by the buyer', async () => {
  const { db } = setup();
  const b = appAs(db, buyer);
  const s = appAs(db, stranger);
  // Not linked yet: the buyer is told to link first; the stranger sees nothing.
  assert.equal((await json(await post(b, '/api/devices/units/u1/claims', { subject: 'Nozzle clog', description: 'It stopped extruding after two prints.' }))).code, 'NOT_REGISTERED');
  assert.equal((await post(s, '/api/devices/units/u1/claims', { subject: 'Nozzle clog', description: 'It stopped extruding after two prints.' })).status, 404);
  // Transferred to the stranger: they may claim; the buyer may not.
  assert.equal((await post(s, '/api/devices/register', { serial: 'SN-1234-ABCD' })).status, 200);
  assert.equal((await post(s, '/api/devices/units/u1/claims', { subject: 'Nozzle clog', description: 'It stopped extruding after two prints.' })).status, 200);
  assert.equal((await post(b, '/api/devices/units/u1/claims', { subject: 'Nozzle clog', description: 'It stopped extruding after two prints.' })).status, 400);
});

// -------------------------------------------------------------------- admin

test('an admin finds a device by serial or receipt, sees buyer and holder, and can unlink it with a reason', async () => {
  const { db } = setup();
  const b = appAs(db, buyer);
  const a = appAs(db, boss);
  assert.equal((await post(b, '/api/devices/register', { serial: 'SN-1234-ABCD' })).status, 200);
  const bySerial = await json(await a.request('/api/devices/admin/units?serial=sn-1234-abcd'));
  assert.equal(bySerial.units.length, 1);
  assert.equal(bySerial.units[0].serial, 'SN-1234-ABCD', 'unmasked for the admin');
  assert.equal(bySerial.units[0].buyer.email, 's@x.co');
  assert.equal(bySerial.units[0].holder.email, 's@x.co');
  const byReceipt = await json(await a.request('/api/devices/admin/units?serial=WR-2026-0905-001'));
  assert.equal(byReceipt.units[0].unit_id, 'u1');
  // No reason → refused; with a reason → unlinked and audited.
  assert.equal((await post(a, '/api/devices/admin/units/u1/unregister', { reason: 'x' })).status, 400);
  const done = await json(await post(a, '/api/devices/admin/units/u1/unregister', { reason: 'Customer lost access to the old account' }));
  assert.equal(done.unlinked_from_user_id, 'buyer');
  assert.equal((await json(await a.request('/api/devices/admin/units?serial=SN-1234-ABCD'))).units[0].holder, null);
  assert.equal((await post(a, '/api/devices/admin/units/u1/unregister', { reason: 'again, please' })).status, 409, 'nothing to unlink');
  // …and the customer path is closed to a customer.
  assert.equal((await post(b, '/api/devices/admin/units/u1/unregister', { reason: 'me too, please' })).status, 403);
});

// ----------------------------------------------------- the holder's own paper

test('the buyer or the holder can open their warranty receipt; nobody else can tell it exists', async () => {
  const { db } = setup();
  const b = appAs(db, buyer);
  const s = appAs(db, stranger);
  const mine = await b.request('/api/warranty/receipts/WR-2026-0905-001/document?lang=en');
  assert.equal(mine.status, 200);
  assert.match(await mine.text(), /WR-2026-0905-001/);
  const theirs = await s.request('/api/warranty/receipts/WR-2026-0905-001/document');
  assert.equal(theirs.status, 404);
  const nothing = await s.request('/api/warranty/receipts/WR-2026-0905-999/document');
  assert.equal(nothing.status, 404);
  assert.equal((await json(theirs)).error, (await json(nothing)).error, 'same words for "not yours" and "does not exist"');
  // Transfer the device: the holder may open it too.
  assert.equal((await post(b, '/api/devices/register', { serial: 'SN-1234-ABCD' })).status, 200);
  assert.equal((await del(b, '/api/devices/units/u1/registration')).status, 200);
  assert.equal((await post(s, '/api/devices/register', { serial: 'SN-1234-ABCD' })).status, 200);
  assert.equal((await s.request('/api/warranty/receipts/WR-2026-0905-001/document')).status, 200);
});
