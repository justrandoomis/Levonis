/**
 * The local-courier sync, against a real database and a fake courier.
 *
 * WHY A FAKE COURIER AND NOT THE REAL ONE. Al-Waseet's documentation sits
 * behind a WAF that refuses every client we can reach it from, and even with
 * the docs a test must not depend on a live merchant account, a network, or
 * a parcel actually moving. What matters here is not their JSON — it is the
 * five rules the owner set for what we do with it, and each of those is a
 * behaviour of THIS code:
 *
 *   1. "لا تغيّر حالة الطلب خطأً" when the API cannot be reached. An error is
 *      not "not delivered yet", it is "we do not know", and the difference
 *      decides whether a customer is told their parcel arrived.
 *   2. "سجل الخطأ" — the failure is stored on the order, not only logged.
 *   3. "أعد المحاولة لاحقًا" — a failed order is still picked up next sweep.
 *   4. An unmapped courier status changes nothing. No guessing from the text.
 *   5. A mapped one moves the order through the same path every other caller
 *      uses, recorded with source `delivery_api`.
 *
 * The database is real: migrations, CHECK constraints and all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, SqliteD1, newSqlite } from './fixtures/d1';
import { setStatusMapping, upsertRemoteStatuses, listStatusMap, stageForRemoteStatus } from '../worker/lib/delivery/statusMap';
import { syncOrderDelivery, sweepDeliveryStatuses } from '../worker/lib/delivery/sync';
import { parseStatusList, resolveWire, missingCredentials, alwaseetDriver } from '../worker/lib/delivery/alwaseet';
import type { DeliveryDriver, DriverResult, RemoteShipmentStatus, RemoteStatus, CreatedShipment } from '../worker/lib/delivery/types';
import type { Env } from '../worker/lib/types';

const NOW = '2026-03-01T10:00:00.000Z';

function freshEnv(): { env: Env; raw: DatabaseSync } {
  const raw = newSqlite();
  for (const f of readdirSync(join(ROOT, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  }
  raw.prepare('INSERT INTO users (id, email) VALUES (?,?)').run('u1', 'buyer@example.com');
  return { env: { DB: new SqliteD1(raw) } as unknown as Env, raw };
}

function seedOrder(raw: DatabaseSync, id: string, stage: string, remoteId: string) {
  raw
    .prepare(
      `INSERT INTO orders (id, user_id, status, stage, stage_changed_at, shipping_type,
         subtotal_iqd, exchange_rate, total_iqd, due_on_delivery_iqd,
         address_snapshot, delivery_method_id, delivery_method_snapshot,
         payment_method_id, delivery_provider, delivery_remote_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      id, 'u1', 'shipped', stage, NOW, 'direct',
      100000, 1400, 100000, 100000,
      '{}', 'standard', '{}',
      'cash', remoteId ? 'alwaseet' : '', remoteId, NOW, NOW
    );
}

/** A courier we can make say anything, including "I am broken". */
class FakeCourier implements DeliveryDriver {
  readonly provider = 'alwaseet';
  calls = 0;
  constructor(private answer: () => DriverResult<RemoteShipmentStatus>) {}
  async listStatuses(): Promise<DriverResult<RemoteStatus[]>> {
    return { ok: true, value: [{ id: '1', text: 'قيد التوصيل' }, { id: '4', text: 'تم التسليم' }] };
  }
  async createShipment(): Promise<DriverResult<CreatedShipment>> {
    return { ok: false, retryable: false, error: 'not used in this test' };
  }
  async getShipment(): Promise<DriverResult<RemoteShipmentStatus>> {
    this.calls++;
    return this.answer();
  }
}

const ok = (statusId: string, text = ''): DriverResult<RemoteShipmentStatus> => ({
  ok: true,
  value: { remoteId: 'AW-1', statusId, statusText: text },
});

// ------------------------------------------------------------- the mapping

test('the courier\'s official list is stored, and every row starts UNMAPPED', async () => {
  const { env, raw } = freshEnv();
  const out = await upsertRemoteStatuses(env.DB, 'alwaseet', [
    { id: '1', text: 'قيد التوصيل' },
    { id: '4', text: 'تم التسليم' },
  ], NOW);
  assert.equal(out.added, 2);
  const rows = await listStatusMap(env.DB, 'alwaseet');
  assert.equal(rows.length, 2);
  // Nothing is mapped by guessing at the Arabic. The owner maps it.
  assert.ok(rows.every((r) => r.internal_stage === ''));
  raw.close();
});

test('re-fetching the list never unmaps a status the owner already mapped', async () => {
  const { env, raw } = freshEnv();
  await upsertRemoteStatuses(env.DB, 'alwaseet', [{ id: '4', text: 'تم التسليم' }], NOW);
  await setStatusMapping(env.DB, 'alwaseet', '4', 'delivered', NOW);
  // The courier rewords the status in a later release.
  const again = await upsertRemoteStatuses(env.DB, 'alwaseet', [{ id: '4', text: 'تم التسليم للزبون' }], NOW);
  assert.equal(again.added, 0);
  assert.equal(await stageForRemoteStatus(env.DB, 'alwaseet', '4'), 'delivered');
  const rows = await listStatusMap(env.DB, 'alwaseet');
  assert.equal(rows[0].remote_text, 'تم التسليم للزبون');
  raw.close();
});

test('an unknown status id maps to nothing, not to a default', async () => {
  const { env, raw } = freshEnv();
  assert.equal(await stageForRemoteStatus(env.DB, 'alwaseet', '999'), null);
  raw.close();
});

// ---------------------------------------------------------- rules 1, 2, 3

test('an unreachable courier does NOT change the order', async () => {
  const { env, raw } = freshEnv();
  seedOrder(raw, 'ORD-1', 'local_delivery_prep', 'AW-1');
  const courier = new FakeCourier(() => ({ ok: false, retryable: true, error: 'Could not reach Al-Waseet (timeout)' }));

  const res = await syncOrderDelivery(env, courier, 'ORD-1', NOW);
  assert.equal(res.outcome, 'error');
  const row = raw.prepare('SELECT stage, status, delivery_error FROM orders WHERE id = ?').get('ORD-1') as Record<string, string>;
  // The stage is exactly where it was. This is the whole point.
  assert.equal(row.stage, 'local_delivery_prep');
  assert.equal(row.status, 'shipped');
  // And the failure is ON THE ORDER, where an admin will see it.
  assert.match(row.delivery_error, /Could not reach Al-Waseet/);
  raw.close();
});

test('a failed order is still picked up by the next sweep', async () => {
  const { env, raw } = freshEnv();
  seedOrder(raw, 'ORD-1', 'local_delivery_prep', 'AW-1');
  let fail = true;
  const courier = new FakeCourier(() => (fail ? { ok: false, retryable: true, error: 'boom' } : ok('4', 'تم التسليم')));
  await setStatusMapping(env.DB, 'alwaseet', '4', 'delivered', NOW);

  let report = await sweepDeliveryStatuses(env, courier, 10, NOW);
  assert.equal(report.errors, 1);
  assert.equal(report.moved, 0);

  // Nothing about the failure took the order out of the queue.
  fail = false;
  report = await sweepDeliveryStatuses(env, courier, 10, NOW);
  assert.equal(report.scanned, 1);
  assert.equal(report.moved, 1);
  const row = raw.prepare('SELECT stage, delivery_error FROM orders WHERE id = ?').get('ORD-1') as Record<string, string>;
  assert.equal(row.stage, 'delivered');
  // The old error is cleared once the courier answers again.
  assert.equal(row.delivery_error, '');
  raw.close();
});

// ----------------------------------------------------------------- rule 4

test('an UNMAPPED courier status records the status and moves nothing', async () => {
  const { env, raw } = freshEnv();
  seedOrder(raw, 'ORD-1', 'local_delivery_prep', 'AW-1');
  // Deliberately a status whose Arabic text says "delivered". Nothing here
  // reads that text, and nothing may act on it until the owner maps the id.
  const courier = new FakeCourier(() => ok('77', 'تم التسليم'));

  const res = await syncOrderDelivery(env, courier, 'ORD-1', NOW);
  assert.equal(res.outcome, 'unmapped');
  const row = raw.prepare('SELECT stage, delivery_status_id, delivery_status_text FROM orders WHERE id = ?').get('ORD-1') as Record<string, string>;
  assert.equal(row.stage, 'local_delivery_prep');
  // But the admin can see exactly what the courier said, so they can map it.
  assert.equal(row.delivery_status_id, '77');
  assert.equal(row.delivery_status_text, 'تم التسليم');
  raw.close();
});

test('a mapping to a stage this build does not know is treated as unmapped', async () => {
  const { env, raw } = freshEnv();
  seedOrder(raw, 'ORD-1', 'local_delivery_prep', 'AW-1');
  await setStatusMapping(env.DB, 'alwaseet', '9', 'teleported', NOW);
  const res = await syncOrderDelivery(env, new FakeCourier(() => ok('9')), 'ORD-1', NOW);
  assert.equal(res.outcome, 'unmapped');
  const row = raw.prepare('SELECT stage FROM orders WHERE id = ?').get('ORD-1') as Record<string, string>;
  assert.equal(row.stage, 'local_delivery_prep');
  raw.close();
});

// ----------------------------------------------------------------- rule 5

test('a mapped status moves the order, and the history says the courier did it', async () => {
  const { env, raw } = freshEnv();
  seedOrder(raw, 'ORD-1', 'local_delivery_prep', 'AW-1');
  await setStatusMapping(env.DB, 'alwaseet', '1', 'out_for_delivery', NOW);
  await setStatusMapping(env.DB, 'alwaseet', '4', 'delivered', NOW);

  let res = await syncOrderDelivery(env, new FakeCourier(() => ok('1', 'قيد التوصيل')), 'ORD-1', NOW);
  assert.equal(res.outcome, 'moved');
  assert.equal(res.stage, 'out_for_delivery');

  res = await syncOrderDelivery(env, new FakeCourier(() => ok('4', 'تم التسليم')), 'ORD-1', '2026-03-01T12:00:00.000Z');
  assert.equal(res.outcome, 'moved');

  const row = raw.prepare('SELECT stage, status, delivered_at FROM orders WHERE id = ?').get('ORD-1') as Record<string, string>;
  assert.equal(row.stage, 'delivered');
  // The legacy column follows, so the stock lifecycle and every filter agree.
  assert.equal(row.status, 'delivered');
  assert.ok(row.delivered_at);

  const history = raw
    .prepare('SELECT stage, source, changed_by FROM order_status_history WHERE order_id = ? ORDER BY changed_at')
    .all('ORD-1') as Array<Record<string, string>>;
  assert.deepEqual(history.map((h) => h.stage), ['out_for_delivery', 'delivered']);
  // Not 'automatic' and not 'manual' — the courier said so, and the record
  // has to be able to prove that later.
  assert.ok(history.every((h) => h.source === 'delivery_api'));
  assert.ok(history.every((h) => h.changed_by === ''));
  raw.close();
});

test('the same status twice is not a second move', async () => {
  const { env, raw } = freshEnv();
  seedOrder(raw, 'ORD-1', 'local_delivery_prep', 'AW-1');
  await setStatusMapping(env.DB, 'alwaseet', '1', 'out_for_delivery', NOW);
  const courier = new FakeCourier(() => ok('1'));
  assert.equal((await syncOrderDelivery(env, courier, 'ORD-1', NOW)).outcome, 'moved');
  assert.equal((await syncOrderDelivery(env, courier, 'ORD-1', NOW)).outcome, 'unchanged');
  const n = raw.prepare('SELECT COUNT(*) AS n FROM order_status_history WHERE order_id = ?').get('ORD-1') as { n: number };
  assert.equal(n.n, 1);
  raw.close();
});

test('an order with no shipment is left alone and never calls the courier', async () => {
  const { env, raw } = freshEnv();
  seedOrder(raw, 'ORD-1', 'confirmed', '');
  const courier = new FakeCourier(() => ok('4'));
  const res = await syncOrderDelivery(env, courier, 'ORD-1', NOW);
  assert.equal(res.outcome, 'no_shipment');
  assert.equal(courier.calls, 0);
  raw.close();
});

test('the sweep skips finished orders — a delivered parcel is not asked about again', async () => {
  const { env, raw } = freshEnv();
  seedOrder(raw, 'ORD-1', 'delivered', 'AW-1');
  seedOrder(raw, 'ORD-2', 'cancelled', 'AW-2');
  seedOrder(raw, 'ORD-3', 'local_delivery_prep', 'AW-3');
  const courier = new FakeCourier(() => ok('1'));
  const report = await sweepDeliveryStatuses(env, courier, 10, NOW);
  assert.equal(report.scanned, 1);
  assert.equal(courier.calls, 1);
  raw.close();
});

test('one failing order does not stop the sweep reaching the others', async () => {
  const { env, raw } = freshEnv();
  seedOrder(raw, 'ORD-1', 'local_delivery_prep', 'AW-1');
  seedOrder(raw, 'ORD-2', 'local_delivery_prep', 'AW-2');
  await setStatusMapping(env.DB, 'alwaseet', '1', 'out_for_delivery', NOW);
  let n = 0;
  const courier = new FakeCourier(() => {
    n++;
    return n === 1 ? { ok: false, retryable: true, error: 'boom' } : ok('1');
  });
  const report = await sweepDeliveryStatuses(env, courier, 10, NOW);
  assert.equal(report.scanned, 2);
  assert.equal(report.errors, 1);
  assert.equal(report.moved, 1);
  raw.close();
});

// ------------------------------------------------------ the driver itself

test('the driver refuses to exist without credentials, and names only the KEYS', () => {
  const bare = alwaseetDriver({} as Env, {});
  assert.ok('configured' in bare && bare.configured === false);
  if ('configured' in bare) {
    assert.deepEqual(bare.missing, ['ALWASEET_BASE_URL', 'ALWASEET_USERNAME', 'ALWASEET_PASSWORD']);
    // The names are safe to render. A value must never appear in this list —
    // and none can, because the list is built from literals.
    assert.ok(bare.missing.every((m) => m.startsWith('ALWASEET_')));
  }
  assert.deepEqual(
    missingCredentials({ ALWASEET_BASE_URL: 'https://x', ALWASEET_USERNAME: 'u', ALWASEET_PASSWORD: 'p' } as Env),
    []
  );
});

test('an unconfigured endpoint fails non-retryably instead of sending a guess', async () => {
  const env = { ALWASEET_BASE_URL: 'https://example.invalid', ALWASEET_USERNAME: 'u', ALWASEET_PASSWORD: 'p' } as Env;
  const driver = alwaseetDriver(env, {});
  assert.ok(!('configured' in driver));
  if ('configured' in driver) return;
  // No createPath and no field map is configured, so nothing is sent at all.
  const created = await driver.createShipment({
    orderId: 'ORD-1', customerName: 'x', phone: '07', governorate: 'baghdad', area: 'a',
    address: 'b', landmark: '', notes: '', amountIqd: 1000, itemCount: 1, itemsSummary: 'x',
  });
  assert.equal(created.ok, false);
  if (!created.ok) {
    assert.equal(created.retryable, false);
    assert.match(created.error, /not configured/i);
  }
  const shipment = await driver.getShipment('AW-1');
  assert.equal(shipment.ok, false);
});

test('the wire config accepts paths and field maps, and drops anything else', () => {
  const w = resolveWire({
    createPath: '/v1/merchant/create-order',
    shipmentPath: '/v1/merchant/order/{id}',
    createFields: { customerName: 'client_name', phone: 'client_mobile', bad: 42 },
    governorateMap: { baghdad: '1' },
    // A credential pasted in here by mistake must not be stored — this object
    // is readable by every admin screen.
    ALWASEET_PASSWORD: 'hunter2',
    token: 'abc',
  });
  assert.equal(w.createPath, '/v1/merchant/create-order');
  assert.deepEqual(w.createFields, { customerName: 'client_name', phone: 'client_mobile' });
  assert.deepEqual(w.governorateMap, { baghdad: '1' });
  assert.ok(!('ALWASEET_PASSWORD' in w));
  assert.ok(!('token' in w));
  // The one path the owner's brief documented is the default.
  assert.equal(resolveWire({}).statusesPath, '/v1/merchant/statuses');
});

test('the status list is read out of whatever envelope the API uses, and never invented', () => {
  assert.deepEqual(parseStatusList([{ id: 1, status: 'A' }]), [{ id: '1', text: 'A' }]);
  assert.deepEqual(parseStatusList({ data: [{ status_id: 4, name: 'B' }] }), [{ id: '4', text: 'B' }]);
  assert.deepEqual(parseStatusList({ statuses: [{ id: '7', title: 'C' }] }), [{ id: '7', text: 'C' }]);
  // A row with no id is not a status; inventing one would produce a mapping
  // key that matches nothing the courier will ever send.
  assert.deepEqual(parseStatusList([{ name: 'no id' }]), []);
  assert.deepEqual(parseStatusList(null), []);
  assert.deepEqual(parseStatusList('nonsense'), []);
});
