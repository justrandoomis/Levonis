/**
 * Services S-P2 (DECISIONS row 238; spec §6.2, §6.14, §13.3) — the device service: one answer to
 * «where is this device, and what is open on it?».
 *
 *   listMyDevices / publicDevice  the customer's delivered devices with what is open on each, never
 *                                 the internal ids, a serial beyond its last four or a figure;
 *   X5                            a device the shop received is not with the customer: no warranty
 *                                 claim (DEVICE_NOT_WITH_CUSTOMER), no return (TRADE_IN_ACTIVE) —
 *                                 until it is handed back;
 *   X10                           the printer perk drops at intake, and the new printer counts from
 *                                 its seventh day;
 *   GET /api/me/services          the «خدماتي» card: counts and the one next thing to do.
 *
 * LOCAL ONLY. Run: node --import tsx --test tests/sv2_p2_devices_service.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, get, json, post, row, stubApp, type StubUser } from './fixtures/app';
import { LimitD1 } from './fixtures/d1Limits';
import { deviceRoutes } from '../worker/routes/devices';
import { returnRoutes } from '../worker/routes/returns';
import { myServicesRoutes } from '../worker/routes/myServices';
import { listMyDevices, printerPerkEligibleSql, publicDevice } from '../worker/lib/services/myDevices';
import { CUSTOMER, STAFF, adminApp, approvedAndOrdered, customerApp, delivered, received, restoreFetch, seed, submitted } from './sv2_tradein_fixture';

test.after(restoreFetch);

const DAY = 86_400_000;
const code = async (res: Response) => [res.status, (await json(res)).code] as const;
const doors = (raw: DatabaseSync, who: StubUser = CUSTOMER) =>
  stubApp(new LimitD1(raw) as unknown as D1Database, who, (a) => {
    a.route('/api/devices', deviceRoutes);
    a.route('/api/returns', returnRoutes);
    a.route('/api/me/services', myServicesRoutes);
  });
const fileClaim = (raw: DatabaseSync, key: string) =>
  post(doors(raw), '/api/devices/units/unit_a1/claims', { subject: 'Extruder clicks', description: 'The extruder clicks and under-extrudes on every print.', idempotencyKey: key });
const openReturn = (raw: DatabaseSync) =>
  post(doors(raw), '/api/returns', { orderItemId: 'oi_a1', unitId: 'unit_a1', qty: 1, reason: 'defective', description: 'It stopped heating.' });

/** Sara's A1 (and the P1S she may buy) filed under a printer section; the A1 registered to her. */
function world(opts: Parameters<typeof seed>[0] = {}) {
  const raw = seed(opts);
  raw.exec(`INSERT OR IGNORE INTO catalogs (id, slug, name_ar, name_en, is_printer_catalog) VALUES ('cat_pr_test', 'printers-test', 'طابعات', 'Printers', 1);
            INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES ('p_a1', 'cat_pr_test', 0);
            INSERT INTO device_registrations (unit_id, user_id) VALUES ('unit_a1', 'cust');
            INSERT INTO device_serials (serial_norm, serial_raw, unit_id, assigned_by) VALUES ('01P00A123456789', '01P00A123456789', 'unit_a1', 'staff');`);
  return raw;
}
const perkUnits = (raw: DatabaseSync, nowIso: string) =>
  (raw.prepare(`SELECT u.id FROM order_item_units u WHERE u.owner_user_id = 'cust' AND ${printerPerkEligibleSql('u', '?1')} ORDER BY u.id`).all(nowIso) as Array<{ id: string }>).map((u) => u.id);

test('listMyDevices: the delivered A1 with what is open on it; the customer copy carries no internal id, no full serial, no figure', async () => {
  const raw = world();
  const env = { DB: asD1(raw) } as never;
  const [before] = await listMyDevices(env, 'cust');
  assert.deepEqual(
    [before.key, before.unit_id, before.family, before.serial_last4, before.gift, before.in_shop, before.open.trade_in, before.warranty_months_left >= 10],
    ['oi_a1:1', 'unit_a1', 'fdm', '6789', false, false, null, true]
  );
  const id = await submitted(raw);
  const [sent] = await listMyDevices(env, 'cust');
  assert.deepEqual(sent.open.trade_in, { request_id: id, stage: 'awaiting_device' });
  await received(raw, id);
  const [inShop] = await listMyDevices(env, 'cust');
  assert.deepEqual([inShop.in_shop, inShop.open.trade_in?.stage], [true, 'inspecting']);
  const pub = publicDevice(inShop) as unknown as Record<string, unknown>;
  assert.equal('unit_id' in pub, false);
  assert.equal('product_id' in pub, false);
  const text = JSON.stringify(pub);
  assert.ok(!text.includes('01P00A123456789'), 'never the whole serial');
  assert.ok(!/_iqd|cost|paid|margin/.test(text), text);
  // Another customer reads nothing of Sara's.
  assert.deepEqual(await listMyDevices(env, 'staff'), []);
});

test('GET /eligible says where each device is and the stage of its trade-in', async () => {
  const raw = world();
  const id = await submitted(raw);
  await received(raw, id);
  const units = (await json(await get(customerApp(raw), '/api/trade-in/eligible'))).units as Array<Record<string, unknown>>;
  const a1 = units.find((u) => u.order_item_id === 'oi_a1')!;
  assert.deepEqual([a1.in_shop, a1.stage, a1.open_request_id], [true, 'inspecting', id]);
});

test('X5 a device the shop received is not with the customer: no warranty claim, no return — until it is handed back', async () => {
  const raw = world({ deliveredDaysAgo: 2 });
  const id = await submitted(raw);
  await received(raw, id);
  assert.deepEqual(await code(await fileClaim(raw, 'sv2-p2-x5-claim-01')), [409, 'DEVICE_NOT_WITH_CUSTOMER']);
  assert.deepEqual(await code(await openReturn(raw)), [409, 'TRADE_IN_ACTIVE']);
  // The customer cancels after intake: no money moves, the device waits at the shop to be collected.
  const cancelled = await post(customerApp(raw), `/api/trade-in/requests/${id}/cancel`);
  assert.equal(cancelled.status, 200, await cancelled.clone().text());
  const [waiting] = await listMyDevices({ DB: asD1(raw) } as never, 'cust');
  assert.deepEqual([waiting.in_shop, waiting.open.trade_in?.stage], [true, 'device_to_collect']);
  assert.deepEqual(await code(await fileClaim(raw, 'sv2-p2-x5-claim-02')), [409, 'DEVICE_NOT_WITH_CUSTOMER']);
  assert.deepEqual(await code(await openReturn(raw)), [409, 'TRADE_IN_ACTIVE']);
  assert.equal(row<{ n: number }>(raw, 'SELECT COUNT(*) AS n FROM warranty_claims')!.n, 0);
  // Handed back: the device is the customer's again.
  const back = await post(adminApp(raw, STAFF), `/api/admin/trade-in/requests/${id}/device-returned`);
  assert.equal(back.status, 200, await back.clone().text());
  assert.equal((await json(await fileClaim(raw, 'sv2-p2-x5-claim-03'))).success, true);
});

test('review F-5: a device the shop received is not taken by serial — unlinked by its customer, no other account links it while it is in the shop', async () => {
  const raw = world({ deliveredDaysAgo: 2 });
  raw.exec(`INSERT INTO users (id,name,email,password_hash,role,email_verified_at,locale) VALUES ('cust2','Omar','omar@x.co','h','customer','2026-01-01T00:00:00.000Z','ar')`);
  const id = await submitted(raw);
  await received(raw, id);
  // The customer unlinks it (the transfer's first step) …
  const unlink = await doors(raw).request('/api/devices/units/unit_a1/registration', { method: 'DELETE', headers: { 'CF-Connecting-IP': '1.2.3.4' } });
  assert.equal(unlink.status, 200, await unlink.clone().text());
  // … and another account types the serial while the device sits in the shop: the same «no match» as a serial that matches nothing.
  const other: StubUser = { id: 'cust2', role: 'customer', email: 'omar@x.co' };
  const taken = await post(doors(raw, other), '/api/devices/register', { serial: '01P00A123456789' });
  assert.equal(taken.status, 404, await taken.clone().text());
  assert.equal(row<{ n: number }>(raw, "SELECT COUNT(*) AS n FROM device_registrations WHERE unit_id = 'unit_a1' AND user_id = 'cust2'")!.n, 0);
});

test('X10 intake on the only printer drops the printer perk at once; the new printer counts from its seventh day', async () => {
  const raw = world();
  const now = new Date().toISOString();
  assert.deepEqual(perkUnits(raw, now), ['unit_a1'], 'bought here, delivered 20 days ago, inside 12 months');
  const id = await submitted(raw);
  assert.deepEqual(perkUnits(raw, now), ['unit_a1'], 'sent, not received: still the customer’s');
  const { orderId } = await approvedAndOrdered(raw, id);
  assert.deepEqual(perkUnits(raw, now), [], 'received: the shop holds it');
  // Filed under the printer section after the sale (so the fixture's checkout asks no printer advance), before the delivery makes its unit.
  raw.exec(`INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES ('p_p1s', 'cat_pr_test', 1)`);
  await delivered(raw, orderId);
  const p1s = row<{ id: string }>(raw, "SELECT id FROM order_item_units WHERE order_id = ? AND product_id = 'p_p1s'", orderId)!.id;
  assert.deepEqual(perkUnits(raw, new Date(Date.now() + 6 * DAY).toISOString()), [], 'six days: not yet');
  assert.deepEqual(perkUnits(raw, new Date(Date.now() + 7 * DAY + 60_000).toISOString()), [p1s], 'from the seventh day');
  // The old A1 is traded in for good (completed): it never counts again.
  assert.ok(!perkUnits(raw, new Date(Date.now() + 8 * DAY).toISOString()).includes('unit_a1'));
});

test('GET /api/me/services: device count, open cases, and the one next thing the trade-in asks — signed in only, 503 before 0192', async () => {
  const raw = world();
  const card = async () => {
    const res = await get(doors(raw), '/api/me/services');
    assert.equal(res.status, 200, await res.clone().text());
    assert.match(res.headers.get('Cache-Control') ?? '', /no-store/);
    return json(res);
  };
  const empty = await card();
  assert.deepEqual([empty.devices, empty.trade_in, empty.protection, empty.perks], [{ count: 1, open_cases: 0 }, { open: 0, next_action: null, next_at: null }, null, null]);
  const id = await submitted(raw);
  const sent = await card();
  const expires = row<{ offer_expires_at: string }>(raw, 'SELECT offer_expires_at FROM trade_in_requests WHERE id = ?', id)!.offer_expires_at;
  assert.deepEqual(sent.trade_in, { open: 1, next_action: 'hand_in', next_at: expires });
  await received(raw, id);
  assert.deepEqual((await card()).trade_in, { open: 1, next_action: null, next_at: null }, 'inspecting: the shop’s move');
  await post(adminApp(raw), `/api/admin/trade-in/requests/${id}/approve`);
  const pay = (await card()).trade_in;
  const ends = row<{ ends_at: string }>(raw, 'SELECT ends_at FROM coupons WHERE trade_in_id = ?', id)!.ends_at;
  assert.deepEqual(pay, { open: 1, next_action: 'pay', next_at: ends });
  assert.ok(!/_iqd|cost|margin|serial/.test(JSON.stringify(await card())));
  // Signed out: refused.
  const guest = stubApp(new LimitD1(raw) as unknown as D1Database, null, (a) => a.route('/api/me/services', myServicesRoutes));
  assert.equal((await get(guest, '/api/me/services')).status, 401);
  // A database without 0192.
  const res = await get(doors(seed({ through: '0191' })), '/api/me/services');
  assert.deepEqual([res.status, (await json(res)).code], [503, 'TRADE_IN_V2_NOT_INSTALLED']);
});
