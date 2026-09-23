/**
 * «لا توجد وحدات قابلة للضمان» — A PRINTER THE COURIER DELIVERED HAD NO WARRANTY.
 *
 * `delivered` is a courier stage: Al-Waseet's sync is its normal door, and it
 * reaches the order through `moveOrderStage(source: 'delivery_api')`. The
 * grants that delivery earns — one device unit per physical printer, each
 * with its warranty clock, and the purchase points — lived only in the ADMIN
 * route's `deliveredEffects`. So a printer the courier delivered read «تم
 * التسليم» and had no unit: nothing under «من طلباتي» to link, nothing to
 * open a warranty claim on, and «لا توجد وحدات قابلة للضمان» on the admin's
 * warranty section until someone pressed backfill by hand.
 *
 * These tests go through the courier's own door (`syncOrderDelivery` with a
 * fake courier), and through `moveOrderStage` for the cron's, with laser,
 * FDM and resin printers side by side — the owner named all three.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, get, post, json, count, all, row } from './fixtures/app';
import { sweepDeliveredOrdersWithoutUnits } from '../worker/lib/deviceOps';
import { setStatusMapping } from '../worker/lib/delivery/statusMap';
import { syncOrderDelivery } from '../worker/lib/delivery/sync';
import { moveOrderStage } from '../worker/lib/orderStageOps';
import { runOrderDeliveredEffects } from '../worker/lib/orderDeliveredEffects';
import { deviceRoutes } from '../worker/routes/devices';
import type { DeliveryDriver, DriverResult, RemoteShipmentStatus, RemoteStatus, CreatedShipment } from '../worker/lib/delivery/types';
import type { Env } from '../worker/lib/types';

const PLACED = '2026-03-01T08:00:00.000Z';
const DELIVERED = '2026-03-02T15:30:00.000Z';

/**
 * One order, four lines: an FDM printer, two resin printers, a laser
 * machine, and three spools of filament that are not a device at all. Each
 * printer's product sits in the catalog the migrations flag
 * `is_printer_catalog = 1`, which is the owner's own definition of a printer.
 */
function seed(opts: { remoteId?: string } = {}): { raw: DatabaseSync; env: Env } {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,username,password_hash,role) VALUES ('buyer','Sara','sara@x.co','sara','h','customer');
    INSERT INTO products (id,slug,name,price_iqd) VALUES
      ('p_fdm','a1','Bambu A1',899000),
      ('p_resin','m5','Anycubic M5',650000),
      ('p_laser','f1','xTool F1',1200000),
      ('p_spool','pla','PLA spool',25000);
    INSERT INTO product_catalogs (product_id,catalog_id,position) VALUES
      ('p_fdm','cat_printers_fdm',0),
      ('p_resin','cat_printers_resin',0),
      ('p_laser','cat_laser_machines',0);
  `);
  raw
    .prepare(
      `INSERT INTO orders (id, user_id, status, stage, stage_changed_at, shipping_type,
         subtotal_iqd, exchange_rate, total_iqd, due_on_delivery_iqd,
         address_snapshot, delivery_method_id, delivery_method_snapshot,
         payment_method_id, delivery_provider, delivery_remote_id, created_at, updated_at)
       VALUES ('ORD-1','buyer','shipped','out_for_delivery',?, 'direct', 3499000, 1400, 3499000, 3499000,
         '{}','standard','{}','cash', ?, ?, ?, ?)`
    )
    .run(PLACED, opts.remoteId ? 'alwaseet' : '', opts.remoteId ?? '', PLACED, PLACED);
  raw.exec(`
    INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_iqd, line_total_iqd) VALUES
      ('oi_fdm','ORD-1','p_fdm','Bambu A1',1,899000,899000),
      ('oi_resin','ORD-1','p_resin','Anycubic M5',2,650000,1300000),
      ('oi_laser','ORD-1','p_laser','xTool F1',1,1200000,1200000),
      ('oi_spool','ORD-1','p_spool','PLA spool',3,25000,75000);
  `);
  return { raw, env: { DB: asD1(raw) } as unknown as Env };
}

/** A courier that says «تم التسليم» and nothing else. */
class DeliveredCourier implements DeliveryDriver {
  readonly provider = 'alwaseet';
  async listStatuses(): Promise<DriverResult<RemoteStatus[]>> {
    return { ok: true, value: [{ id: '4', text: 'تم التسليم' }] };
  }
  async createShipment(): Promise<DriverResult<CreatedShipment>> {
    return { ok: false, retryable: false, error: 'not used in this test' };
  }
  async getShipment(): Promise<DriverResult<RemoteShipmentStatus>> {
    return { ok: true, value: { remoteId: 'AW-1', statusId: '4', statusText: 'تم التسليم' } };
  }
}

interface UnitRowLite {
  order_item_id: string;
  unit_index: number;
  owner_user_id: string;
  delivered_at: string;
  warranty_start_at: string;
  warranty_end_at: string | null;
  warranty_base_months: number | null;
}

const units = (raw: DatabaseSync) =>
  all<UnitRowLite>(
    raw,
    `SELECT order_item_id, unit_index, owner_user_id, delivered_at, warranty_start_at, warranty_end_at, warranty_base_months
       FROM order_item_units WHERE order_id = 'ORD-1' ORDER BY order_item_id, unit_index`
  );

test('the courier marks a printer order delivered — every printer gets a unit, clocked to that delivery', async () => {
  const { raw, env } = seed({ remoteId: 'AW-1' });
  try {
    await setStatusMapping(env.DB, 'alwaseet', '4', 'delivered', PLACED);
    const res = await syncOrderDelivery(env, new DeliveredCourier(), 'ORD-1', DELIVERED);
    assert.equal(res.outcome, 'moved', JSON.stringify(res));

    const order = row<{ status: string; delivered_at: string }>(raw, "SELECT status, delivered_at FROM orders WHERE id = 'ORD-1'");
    assert.equal(order?.status, 'delivered');
    assert.equal(order?.delivered_at, DELIVERED);

    const got = units(raw);
    // 1 FDM + 2 resin + 1 laser = 4 physical printers; the spools are not devices.
    assert.deepEqual(
      got.map((u) => `${u.order_item_id}#${u.unit_index}`),
      ['oi_fdm#1', 'oi_laser#1', 'oi_resin#1', 'oi_resin#2']
    );
    for (const u of got) {
      assert.equal(u.owner_user_id, 'buyer');
      // The warranty starts the moment the courier delivered it — not "now",
      // not the order date.
      assert.equal(u.delivered_at, DELIVERED);
      assert.equal(u.warranty_start_at, DELIVERED);
      // A printer is 12 months unless the owner configured otherwise.
      assert.equal(u.warranty_base_months, 12);
      assert.equal(u.warranty_end_at, '2027-03-02T15:30:00.000Z');
    }
  } finally {
    raw.close();
  }
});

test('the customer can then find each printer under «من طلباتي» and link it', async () => {
  const { raw, env } = seed({ remoteId: 'AW-1' });
  try {
    await setStatusMapping(env.DB, 'alwaseet', '4', 'delivered', PLACED);
    await syncOrderDelivery(env, new DeliveredCourier(), 'ORD-1', DELIVERED);
    const app = stubApp(env.DB, { id: 'buyer', role: 'customer', email: 'sara@x.co' }, (a) => a.route('/api/devices', deviceRoutes));
    const eligible = await json(await get(app, '/api/devices/eligible'));
    assert.equal(eligible.units.length, 4, 'the owner-visible symptom: nothing to link after a courier delivery');
  } finally {
    raw.close();
  }
});

test('the cron and every other stage door get the same units — the grant lives in moveOrderStage', async () => {
  const { raw, env } = seed();
  try {
    const res = await moveOrderStage(env, { orderId: 'ORD-1', to: 'delivered', source: 'automatic', force: true, now: DELIVERED });
    assert.equal(res.moved, true);
    assert.equal(units(raw).length, 4);
  } finally {
    raw.close();
  }
});

test('a second run — the admin door after the courier, or a replayed sync — grants nothing twice', async () => {
  const { raw, env } = seed({ remoteId: 'AW-1' });
  try {
    await setStatusMapping(env.DB, 'alwaseet', '4', 'delivered', PLACED);
    await syncOrderDelivery(env, new DeliveredCourier(), 'ORD-1', DELIVERED);
    const before = units(raw);
    const points = count(raw, "SELECT COUNT(*) n FROM wallet_transactions WHERE user_id = 'buyer'");
    // What the admin door does after its own move: the same function again.
    const again = await runOrderDeliveredEffects(env, 'ORD-1');
    assert.equal(again.deviceUnits?.created, 0);
    assert.equal(again.deviceUnitsWarning, null);
    assert.deepEqual(units(raw), before, 'no unit duplicated and no clock restarted');
    assert.equal(count(raw, "SELECT COUNT(*) n FROM wallet_transactions WHERE user_id = 'buyer'"), points, 'no second points grant');
  } finally {
    raw.close();
  }
});

test('an order that is not moved into delivered creates no units', async () => {
  const { raw, env } = seed();
  try {
    await moveOrderStage(env, { orderId: 'ORD-1', to: 'cancelled', source: 'manual', force: true, now: DELIVERED });
    assert.equal(units(raw).length, 0);
  } finally {
    raw.close();
  }
});

/*
 * THE ORDERS ALREADY DELIVERED BEFORE THE FIX. The courier sync never revisits
 * an order at `delivered` (it is `unchanged` to it), so a printer Al-Waseet
 * delivered last month still has no unit unless something goes looking for it.
 */
function seedHistorical(): { raw: DatabaseSync; env: Env } {
  const { raw, env } = seed();
  // Delivered by the old courier door: status and delivered_at set, no units.
  raw.prepare("UPDATE orders SET status = 'delivered', stage = 'delivered', delivered_at = ? WHERE id = 'ORD-1'").run(DELIVERED);
  // A delivered filament-only order is not a device order — never a candidate.
  raw.exec(`
    INSERT INTO orders (id, user_id, status, stage, stage_changed_at, shipping_type, subtotal_iqd, exchange_rate, total_iqd,
       due_on_delivery_iqd, address_snapshot, delivery_method_id, delivery_method_snapshot, payment_method_id,
       delivered_at, created_at, updated_at)
     VALUES ('ORD-SPOOL','buyer','delivered','delivered','${DELIVERED}','direct',25000,1400,25000,25000,'{}','standard','{}','cash',
       '${DELIVERED}','${PLACED}','${PLACED}');
    INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_iqd, line_total_iqd)
     VALUES ('oi_s2','ORD-SPOOL','p_spool','PLA spool',1,25000,25000);
  `);
  return { raw, env };
}

test('a printer order delivered BEFORE the fix gets its units from the sweep, clocked to the recorded delivery', async () => {
  const { raw, env } = seedHistorical();
  try {
    assert.equal(units(raw).length, 0, 'precondition: the historical order has no units');
    const r = await sweepDeliveredOrdersWithoutUnits(env, 50);
    assert.deepEqual(r, { scanned: 1, orders: 1, created: 4, errors: 0 }, 'only the printer order is a candidate');
    const got = units(raw);
    assert.equal(got.length, 4);
    for (const u of got) assert.equal(u.warranty_start_at, DELIVERED);
    // Repaired history is not picked again: the pass is empty from now on.
    assert.deepEqual(await sweepDeliveredOrdersWithoutUnits(env, 50), { scanned: 0, orders: 0, created: 0, errors: 0 });
    // And the customer now finds the printers under «من طلباتي».
    const app = stubApp(env.DB, { id: 'buyer', role: 'customer', email: 'sara@x.co' }, (a) => a.route('/api/devices', deviceRoutes));
    assert.equal((await json(await get(app, '/api/devices/eligible'))).units.length, 4);
  } finally {
    raw.close();
  }
});

test('a printer the owner marked serialized:false is not a candidate (the sweep matches createUnitsOnDelivery exactly)', async () => {
  const { raw, env } = seedHistorical();
  try {
    raw.exec(`UPDATE products SET ops_policy = '{"serialized":false}' WHERE id IN ('p_fdm','p_resin','p_laser')`);
    assert.deepEqual(await sweepDeliveredOrdersWithoutUnits(env, 50), { scanned: 0, orders: 0, created: 0, errors: 0 });
    // A non-printer the owner explicitly serialized IS one.
    raw.exec(`UPDATE products SET ops_policy = '{"serialized":true}' WHERE id = 'p_spool'`);
    const r = await sweepDeliveredOrdersWithoutUnits(env, 50);
    assert.equal(r.scanned, 2);
    assert.equal(r.errors, 0);
    assert.equal(count(raw, "SELECT COUNT(*) n FROM order_item_units WHERE order_id = 'ORD-SPOOL'"), 1);
  } finally {
    raw.close();
  }
});

test('the admin «now» button runs the same repair and is audited', async () => {
  const { raw, env } = seedHistorical();
  try {
    const app = stubApp(env.DB, { id: 'boss', role: 'admin', email: 'boss@x.co' }, (a) => a.route('/api/devices', deviceRoutes));
    const res = await post(app, '/api/devices/admin/units/backfill-delivered');
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.created, 4);
    assert.equal(body.has_more, false);
    assert.equal(units(raw).length, 4);
    assert.equal(count(raw, "SELECT COUNT(*) n FROM audit_log WHERE action = 'device.units_backfill_delivered' AND actor_id = 'boss'"), 1);
    const customer = stubApp(env.DB, { id: 'buyer', role: 'customer', email: 'sara@x.co' }, (a) => a.route('/api/devices', deviceRoutes));
    assert.equal((await post(customer, '/api/devices/admin/units/backfill-delivered')).status, 403);
  } finally {
    raw.close();
  }
});

test('the repair is reachable: the cron runs the sweep, and the admin order modal offers «إنشاء الوحدات» on a delivered order with none', async () => {
  const { readFileSync } = await import('node:fs');
  const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  assert.match(read('worker/lib/jobs.ts'), /step\('delivered_units',[\s\S]{0,120}sweepDeliveredOrdersWithoutUnits\(env/);
  const section = read('src/components/adminWarranty/WarrantySection.tsx');
  assert.match(section, /\/api\/devices\/admin\/orders\/\$\{orderId\}\/units\/backfill/);
  assert.match(section, /data\.order\.status === 'delivered' && data\.order\.delivered_at \?/);
  assert.match(read('src/components/AdminSerials.tsx'), /\/api\/devices\/admin\/units\/backfill-delivered/);
});
