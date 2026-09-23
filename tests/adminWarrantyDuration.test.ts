/**
 * «الادارة لا تستطيع رؤية الطابعة المرتبطة ولا التأثير على مدة الضمان».
 *
 * TWO HALVES OF ONE COMPLAINT, pinned here because each half failed for its
 * own reason and a fix to one is not a fix to the other.
 *
 * SEEING IT. `device_registrations` says which account holds a machine, and
 * the admin device lookup carried the id all along — but only the SERIAL
 * branch ever resolved it to a person, and the per-order warranty screen did
 * not join the table at all. So an admin holding an order number or a
 * customer's email, which is exactly the admin who does not know the serial
 * yet, saw «مُفعَّل» and a date and nothing else. These tests search the way
 * that admin searches.
 *
 * MOVING IT. Nothing in this codebase rewrote a unit's warranty MONTHS after
 * creation; the only lever was the delivery date. The new route is the lever,
 * and it is fenced: the months live in two places and both move together, a
 * replacement that carries the original's end date is refused rather than
 * saved as a silent no-op, shortening a live window needs a second explicit
 * consent, and every change is audited with who, when and why. The paper and
 * the placement-time snapshot are never touched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, get, patch, json, row, count } from './fixtures/app';
import { readFileSync } from 'node:fs';
import { deviceRoutes } from '../worker/routes/devices';
import { warrantyAdminRoutes } from '../worker/routes/warranty';

const ADMIN = { id: 'boss', role: 'admin' as const, email: 'boss@x.co' };

/** A row the test asserts on must exist; a missing one is the failure. */
function must<T>(v: T | undefined, what: string): T {
  assert.ok(v, `expected ${what} to exist`);
  return v as T;
}

/**
 * One delivered order, two printers. `u1` is held by a SECOND account — the
 * transferred device that the order screen used to render as an anonymous
 * «مُفعَّل». `u2` is linked by nobody.
 */
function seed(): { raw: DatabaseSync; db: D1Database } {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,username,password_hash,role) VALUES
      ('buyer','Sara','sara@x.co','sara','h','customer'),
      ('holder','Kawa','kawa@x.co','kawa','h','customer'),
      ('boss','Admin','boss@x.co','boss','h','admin');
    INSERT INTO products (id,slug,name,price_iqd) VALUES ('p1','a1','Bambu A1',899000);
    INSERT INTO orders (id, user_id, status, address_snapshot, delivery_method_id, delivery_method_snapshot,
       payment_method_id, subtotal_iqd, shipping_iqd, exchange_rate, total_iqd, due_on_delivery_iqd, delivered_at, created_at, updated_at)
     VALUES ('ORD-1','buyer','delivered','{}','standard','{}','cash',899000,0,1400,899000,0,
       '2026-01-10T00:00:00.000Z','2026-01-01T00:00:00.000Z','2026-01-10T00:00:00.000Z');
    INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_iqd, line_total_iqd, warranty_snapshot)
     VALUES ('oi1','ORD-1','p1','Bambu A1',2,899000,1798000,'{"plan_id":"std","duration_months":12,"duration_kind":"fixed"}');
    INSERT INTO order_item_units (id, order_id, order_item_id, product_id, owner_user_id, unit_index,
       delivered_at, warranty_base_months, warranty_ext_months, warranty_start_at, warranty_end_at, policy_version)
     VALUES
      ('u1','ORD-1','oi1','p1','buyer',1,'2026-01-10T00:00:00.000Z',12,0,'2026-01-10T00:00:00.000Z','2027-01-10T00:00:00.000Z','{"v":1,"base":12,"ext":0,"total":12,"plan_id":"std"}'),
      ('u2','ORD-1','oi1','p1','buyer',2,'2026-01-10T00:00:00.000Z',12,0,'2026-01-10T00:00:00.000Z','2027-01-10T00:00:00.000Z','{"v":1,"base":12,"ext":0,"total":12,"plan_id":"std"}');
    INSERT INTO device_serials (serial_norm, serial_raw, unit_id, assigned_by)
     VALUES ('SN1111AAAA','SN-1111-AAAA','u1','boss'), ('SN2222BBBB','SN-2222-BBBB','u2','boss');
    INSERT INTO device_registrations (unit_id, user_id, registered_at) VALUES ('u1','holder','2026-02-01T00:00:00.000Z');
    INSERT INTO warranty_receipts (id, receipt_no, unit_id, order_id, order_item_id, product_id, user_id,
       serial_norm, serial_raw, status, warranty_months, warranty_start_at, warranty_end_at)
     VALUES ('wr1','WR-2026-0110-001','u1','ORD-1','oi1','p1','buyer','SN1111AAAA','SN-1111-AAAA','active',12,
       '2026-01-10T00:00:00.000Z','2027-01-10T00:00:00.000Z');
  `);
  return { raw, db: asD1(raw) };
}

const devicesApp = (db: D1Database) => stubApp(db, ADMIN, (a) => a.route('/api/devices', deviceRoutes));
const warrantyApp = (db: D1Database) => stubApp(db, ADMIN, (a) => a.route('/api/admin/warranties', warrantyAdminRoutes));

// ----------------------------------------------------------- seeing it

test('the order-number lookup names the account that holds the printer', async () => {
  const { db } = seed();
  const res = await json(await get(devicesApp(db), '/api/devices/admin/orders/ORD-1/units'));
  assert.equal(res.success, true);
  const u1 = res.units.find((u: Record<string, unknown>) => u.unit_id === 'u1');
  const u2 = res.units.find((u: Record<string, unknown>) => u.unit_id === 'u2');
  // The whole complaint: an order number was enough to see «مُفعَّل» and a
  // date, and never enough to see WHO.
  assert.equal(u1.holder.email, 'kawa@x.co');
  assert.equal(u1.buyer.email, 'sara@x.co');
  assert.equal(u1.registration.user_id, 'holder');
  assert.equal(u2.holder, null);
  assert.equal(u2.buyer.email, 'sara@x.co');
});

test('the customer-email lookup names the holder too, even when it is not the buyer', async () => {
  const { db } = seed();
  const res = await json(await get(devicesApp(db), '/api/devices/admin/units?email=sara@x.co'));
  const u1 = res.units.find((u: Record<string, unknown>) => u.unit_id === 'u1');
  assert.equal(u1.holder.email, 'kawa@x.co');
  assert.equal(u1.buyer.email, 'sara@x.co');
});

test('the HOLDER\'s own email finds the device they hold — not only the buyer\'s', async () => {
  /**
   * The person on the phone about a transferred printer is its holder, and
   * the admin types THEIR email. The lookup read `owner_user_id = ?` alone,
   * so the holder's email answered with an empty table while the buyer's
   * found the device.
   */
  const { raw, db } = seed();
  const res = await json(await get(devicesApp(db), '/api/devices/admin/units?email=kawa@x.co'));
  assert.deepEqual(res.units.map((u: Record<string, unknown>) => u.unit_id), ['u1']);
  assert.equal(res.units[0].holder.email, 'kawa@x.co');
  assert.equal(res.units[0].buyer.email, 'sara@x.co');
  // A RELEASED link is not holding it.
  raw.exec(`UPDATE device_registrations SET revoked_at = '2026-03-01T00:00:00.000Z' WHERE unit_id = 'u1'`);
  assert.deepEqual((await json(await get(devicesApp(db), '/api/devices/admin/units?email=kawa@x.co'))).units, []);
});

test('a released link leaves a date but no holder', async () => {
  const { raw, db } = seed();
  raw.exec(`UPDATE device_registrations SET revoked_at = '2026-03-01T00:00:00.000Z' WHERE unit_id = 'u1'`);
  const res = await json(await get(devicesApp(db), '/api/devices/admin/units?serial=SN-1111-AAAA'));
  assert.equal(res.units[0].holder, null);
  assert.equal(res.units[0].registration.revoked_at, '2026-03-01T00:00:00.000Z');
});

test('the per-order warranty screen shows the holder, the months and the open claims', async () => {
  const { raw, db } = seed();
  raw.exec(`INSERT INTO warranty_claims (id, user_id, unit_id, order_item_id, product_name, description, status, stage)
            VALUES ('wc1','holder','u1','oi1','Bambu A1','لا يطبع','submitted','received')`);
  const res = await json(await get(warrantyApp(db), '/api/admin/warranties/orders/ORD-1'));
  const u1 = res.units.find((u: Record<string, unknown>) => u.id === 'u1');
  assert.equal(u1.registration.email, 'kawa@x.co');
  assert.equal(u1.registration.registered_at, '2026-02-01T00:00:00.000Z');
  assert.equal(u1.open_claims, 1);
  assert.equal(u1.months, 12);
  assert.equal(u1.base_months, 12);
  assert.equal(u1.carried_end, false);
  assert.equal(res.units.find((u: Record<string, unknown>) => u.id === 'u2').registration, null);
});

test('a closed claim is not an open one', async () => {
  const { raw, db } = seed();
  raw.exec(`INSERT INTO warranty_claims (id, user_id, unit_id, order_item_id, product_name, description, status, stage)
            VALUES ('wc1','holder','u1','oi1','Bambu A1','x','approved','resolved')`);
  const res = await json(await get(warrantyApp(db), '/api/admin/warranties/orders/ORD-1'));
  assert.equal(res.units.find((u: Record<string, unknown>) => u.id === 'u1').open_claims, 0);
});

// ------------------------------------------------------------ moving it

test('extending the duration moves the end date and records who did it and why', async () => {
  const { raw, db } = seed();
  const res = await json(
    await patch(devicesApp(db), '/api/devices/admin/units/u1/warranty', {
      base_months: 12,
      ext_months: 6,
      reason: 'منحة من المالك بعد تأخير التسليم',
    })
  );
  assert.equal(res.success, true);
  assert.equal(res.months, 18);
  assert.equal(res.warranty_end_at, '2027-07-10T00:00:00.000Z');

  const unit = must(row<Record<string, unknown>>(raw, `SELECT * FROM order_item_units WHERE id = 'u1'`), 'unit u1');
  assert.equal(unit.warranty_ext_months, 6);
  assert.equal(unit.warranty_end_at, '2027-07-10T00:00:00.000Z');
  // The months live in the columns AND in policy_version.total, which
  // unitTotalMonths reads FIRST. A write that moved only the columns would
  // leave the old total in charge and the next recompute would undo this.
  assert.equal(JSON.parse(String(unit.policy_version)).total, 18);
  assert.equal(JSON.parse(String(unit.policy_version)).plan_id, 'std');

  const log = must(row<Record<string, unknown>>(raw, `SELECT * FROM audit_log WHERE action = 'device.unit_warranty_months'`), 'audit row');
  assert.equal(log.actor_id, 'boss');
  assert.equal(log.target, 'u1');
  const meta = JSON.parse(String(log.detail ?? '{}'));
  assert.equal(meta.reason, 'منحة من المالك بعد تأخير التسليم');
  assert.equal(meta.old_end_at, '2027-01-10T00:00:00.000Z');
  assert.equal(meta.new_end_at, '2027-07-10T00:00:00.000Z');
  assert.equal(meta.shortened, false);
});

test('the paper and the placement-time snapshot are left exactly as they were', async () => {
  const { raw, db } = seed();
  await patch(devicesApp(db), '/api/devices/admin/units/u1/warranty', {
    base_months: 24,
    ext_months: 0,
    reason: 'تصحيح مدة أساسية مُدخلة بالخطأ',
  });
  const receipt = must(row<Record<string, unknown>>(raw, `SELECT * FROM warranty_receipts WHERE id = 'wr1'`), 'receipt wr1');
  assert.equal(receipt.warranty_end_at, '2027-01-10T00:00:00.000Z');
  assert.equal(receipt.warranty_months, 12);
  assert.equal(receipt.status, 'active');
  assert.equal(count(raw, `SELECT COUNT(*) AS n FROM warranty_receipts`), 1);
  // The snapshot is a record of what was SOLD. It is never recomputed.
  assert.equal(
    String(must(row<Record<string, unknown>>(raw, `SELECT warranty_snapshot FROM order_items WHERE id = 'oi1'`), 'order item oi1').warranty_snapshot),
    '{"plan_id":"std","duration_months":12,"duration_kind":"fixed"}'
  );
  // And the divergence is reported rather than hidden.
  const screen = await json(await get(warrantyApp(db), '/api/admin/warranties/orders/ORD-1'));
  assert.equal(screen.units.find((u: Record<string, unknown>) => u.id === 'u1').receipt.drift.end, true);
});

test('shortening a live warranty is refused until it is confirmed on purpose', async () => {
  const { raw, db } = seed();
  const refused = await patch(devicesApp(db), '/api/devices/admin/units/u1/warranty', {
    base_months: 6,
    ext_months: 0,
    reason: 'المدة الصحيحة ستة أشهر',
  });
  assert.equal(refused.status, 409);
  assert.equal((await json(refused)).code, 'CONFIRM_SHORTER_REQUIRED');
  // Nothing moved, and nothing was logged as if it had.
  assert.equal(must(row<Record<string, unknown>>(raw, `SELECT * FROM order_item_units WHERE id = 'u1'`), 'unit u1').warranty_end_at, '2027-01-10T00:00:00.000Z');
  assert.equal(count(raw, `SELECT COUNT(*) AS n FROM audit_log WHERE action = 'device.unit_warranty_months'`), 0);

  const ok = await json(
    await patch(devicesApp(db), '/api/devices/admin/units/u1/warranty', {
      base_months: 6,
      ext_months: 0,
      reason: 'المدة الصحيحة ستة أشهر',
      confirm_shorter: true,
    })
  );
  assert.equal(ok.warranty_end_at, '2026-07-10T00:00:00.000Z');
  assert.equal(ok.shortened, true);
  const meta = JSON.parse(
    String(must(row<Record<string, unknown>>(raw, `SELECT * FROM audit_log WHERE action = 'device.unit_warranty_months'`), 'audit row').detail ?? '{}')
  );
  assert.equal(meta.shortened, true);
});

test('a replacement carrying the original end date is refused, not saved as a no-op', async () => {
  const { raw, db } = seed();
  raw.exec(`UPDATE order_item_units
               SET policy_version = '{"v":1,"base":12,"ext":0,"total":12,"carried":"original_end"}',
                   replacement_of_unit_id = 'u1'
             WHERE id = 'u2'`);
  const res = await patch(devicesApp(db), '/api/devices/admin/units/u2/warranty', {
    base_months: 24,
    ext_months: 0,
    reason: 'تمديد الضمان للجهاز البديل',
  });
  assert.equal(res.status, 409);
  assert.equal((await json(res)).code, 'CARRIED_END');
  const unit = must(row<Record<string, unknown>>(raw, `SELECT * FROM order_item_units WHERE id = 'u2'`), 'unit u2');
  assert.equal(unit.warranty_base_months, 12);
  assert.equal(unit.warranty_end_at, '2027-01-10T00:00:00.000Z');
});

test('the route refuses nonsense and a unit that does not exist', async () => {
  const { db } = seed();
  const app = devicesApp(db);
  assert.equal((await patch(app, '/api/devices/admin/units/u1/warranty', { base_months: 12, reason: 'ok' })).status, 400);
  assert.equal((await patch(app, '/api/devices/admin/units/u1/warranty', { base_months: 0, reason: 'سبب كافٍ' })).status, 400);
  assert.equal((await patch(app, '/api/devices/admin/units/u1/warranty', { base_months: 241, reason: 'سبب كافٍ' })).status, 400);
  assert.equal((await patch(app, '/api/devices/admin/units/nope/warranty', { base_months: 12, reason: 'سبب كافٍ' })).status, 404);
});

/**
 * THE `min: 1` FLOOR HAS TO APPLY TO THE DEFAULT TOO.
 *
 * `int(v, name, { min, def })` returns `def` BEFORE it compares against `min`
 * — worker/lib/http.ts returns early on an absent value — so passing the
 * unit's stored base straight in let a unit whose `warranty_base_months` is 0
 * sail past a guard that reads as if it forbids 0. The column is a plain
 * nullable INTEGER with no CHECK (migrations/0003_final_phase.sql), so 0 is a
 * value a row can really hold: an imported unit, plus an admin who submits
 * only `ext_months`, wrote `policy_version.total = ext_months` and MOVED THE
 * CUSTOMER'S END DATE on the strength of a base the form never showed them.
 *
 * A stored base below the floor is therefore not offered as a default; the
 * admin is asked to state the base they mean, on a screen whose every write is
 * audited with a reason.
 */
test('a stored base of 0 is not handed back as a default past the min: 1 floor', async () => {
  const { raw, db } = seed();
  raw.exec("UPDATE order_item_units SET warranty_base_months = 0, policy_version = '{\"v\":1}' WHERE id = 'u2'");
  const app = devicesApp(db);

  const res = await patch(app, '/api/devices/admin/units/u2/warranty', { ext_months: 12, reason: 'منحة من المالك' });
  assert.equal(res.status, 400, 'base_months must be stated, not defaulted to a value the floor forbids');

  const unit = raw
    .prepare('SELECT warranty_base_months, warranty_ext_months, policy_version FROM order_item_units WHERE id = ?')
    .get('u2') as Record<string, unknown>;
  assert.equal(unit.warranty_base_months, 0, 'the refusal leaves the row exactly as it was');
  assert.equal(unit.warranty_ext_months, 0);
  assert.ok(!String(unit.policy_version).includes('"total"'), 'and writes no total');

  // A base that IS above the floor still defaults, which is the whole point of
  // letting an admin change only the extension.
  const ok = await patch(app, '/api/devices/admin/units/u1/warranty', { ext_months: 12, reason: 'منحة من المالك' });
  assert.equal(ok.status, 200);
  const u1 = raw
    .prepare('SELECT warranty_base_months, warranty_ext_months FROM order_item_units WHERE id = ?')
    .get('u1') as Record<string, unknown>;
  assert.equal(u1.warranty_base_months, 12, "the unit's own stored base is still the default");
  assert.equal(u1.warranty_ext_months, 12);
});

test('a customer never learns who holds a device from the customer surface', async () => {
  const { db } = seed();
  const app = stubApp(db, { id: 'holder', role: 'customer' as const, email: 'kawa@x.co' }, (a) => a.route('/api/devices', deviceRoutes));
  const res = await json(await get(app, '/api/devices/mine'));
  for (const d of res.devices ?? res.units ?? []) {
    assert.equal(d.registration, undefined, 'the customer payload must not carry the registration block');
    assert.equal(d.holder, undefined);
    assert.equal(d.buyer, undefined);
  }
});

// ------------------------------------------------------ who changed it, when

test('«مَن غيّر ومتى» — the unit\'s history names the admin, the time, the months and the reason', async () => {
  /**
   * The duration change was always audited; nothing ever read the audit back,
   * so no screen could show who changed a warranty or when. This is the read.
   */
  const { db } = seed();
  const app = devicesApp(db);
  const before = await json(await get(app, '/api/devices/admin/units/u1/history'));
  assert.deepEqual(before.history, []);

  await patch(app, '/api/devices/admin/units/u1/warranty', {
    base_months: 12,
    ext_months: 6,
    reason: 'منحة من المالك بعد تأخير التسليم',
  });
  await patch(app, '/api/devices/admin/units/u1/delivery', {
    delivered_at: '2026-01-12T00:00:00.000Z',
    reason: 'التسليم الفعلي كان بعد يومين',
  });

  const res = await json(await get(app, '/api/devices/admin/units/u1/history'));
  assert.equal(res.success, true);
  // Newest first.
  assert.deepEqual(
    res.history.map((h: { action: string }) => h.action),
    ['device.unit_delivery_correct', 'device.unit_warranty_months']
  );
  const months = res.history[1];
  assert.equal(months.actor.email, 'boss@x.co', 'WHO — a person, not an id');
  assert.ok(Date.parse(months.created_at), 'WHEN');
  assert.equal(months.detail.old_total_months, 12);
  assert.equal(months.detail.new_total_months, 18);
  assert.equal(months.detail.old_end_at, '2027-01-10T00:00:00.000Z');
  assert.equal(months.detail.new_end_at, '2027-07-10T00:00:00.000Z');
  assert.equal(months.detail.reason, 'منحة من المالك بعد تأخير التسليم');

  // Another unit's history is its own.
  assert.deepEqual((await json(await get(app, '/api/devices/admin/units/u2/history'))).history, []);
  assert.equal((await get(app, '/api/devices/admin/units/nope/history')).status, 404);
});

test('the unit history is an admin route — a customer is refused', async () => {
  const { db } = seed();
  const customerApp = stubApp(db, { id: 'buyer', role: 'customer', email: 'sara@x.co' }, (a) => a.route('/api/devices', deviceRoutes));
  const res = await get(customerApp, '/api/devices/admin/units/u1/history');
  assert.ok(res.status === 403 || res.status === 404, `got ${res.status}`);
});

test('the admin screens draw the history, and the whole window — delivery and start as well as the end', () => {
  const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const section = src('src/components/adminWarranty/WarrantySection.tsx');
  assert.match(section, /<UnitHistory unitId=\{u\.id\}/);
  assert.match(section, /\{t\.delivered\}: <span[^>]*>\{dateInput\(u\.delivered_at\)/);
  assert.match(section, /\{t\.start\}: <span[^>]*>\{dateInput\(u\.warranty_start_at\)/);
  const serials = src('src/components/AdminSerials.tsx');
  assert.match(serials, /<UnitHistory unitId=\{u\.unit_id\}/);
  assert.match(serials, /\{s\.warrantyStart\}: \{fmtDate\(u\.warranty\.start_at, lang\)\}/);
  const history = src('src/components/adminWarranty/UnitHistory.tsx');
  assert.match(history, /\/api\/devices\/admin\/units\/\$\{encodeURIComponent\(unitId\)\}\/history/);
});
