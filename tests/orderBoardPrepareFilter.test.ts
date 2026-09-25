/**
 * «يجب تجهيزها» — THE ORDER BOARD'S PREPARATION FILTER (scope=prepare).
 *
 * Owner, 2026-09-25: «فلترة جديدة يجمع في الطلبات التي تكون في قيد التجهيز سواء
 * كان البيع المباشر عند الضغط على تم تأكيد الطلب يذهب إلى فلترة يجب تجهيزها …
 * سواء كان بيع مباشر أو طلب مسبق في جار التوصيل المحلي».
 *
 * Membership is pinned for EVERY stage of both paths against the real route
 * over real SQLite, the TypeScript twin is pinned against the SQL, the count
 * beside the option equals the board total, the plan still reads through the
 * board's partial index, and pressing «تم تأكيد الطلب» on a received direct
 * order moves it in.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, get, json, send, pending } from './fixtures/app';
import { adminRoutes, needsPreparation, PREPARE_WHERE_SQL } from '../worker/routes/admin';
import { DIRECT_STAGES, PREORDER_STAGES, STAGE_LEGACY_STATUS, type OrderStage } from '../worker/lib/orderStages';

interface Seed { id: string; type: string; stage: string; status: string }

function seed(orders: Seed[]) {
  const raw = freshDb();
  raw.prepare("INSERT INTO users (id,name,email,password_hash,role) VALUES ('u1','زبون','u1@x.co','h','customer')").run();
  raw.prepare("INSERT INTO users (id,name,email,password_hash,role,admin_scope) VALUES ('boss','Owner','boss@x.co','h','admin',NULL)").run();
  const ins = raw.prepare(
    `INSERT INTO orders
       (id,user_id,status,stage,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
        subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,created_at,priority,shipping_type,seller_type)
     VALUES (?,?,?,?,'{"name":"x"}','standard','{}','cash',1000,1500,1000,1000,'2026-09-15T08:00:00.000Z',0,?,'levonis')`
  );
  for (const o of orders) ins.run(o.id, 'u1', o.status, o.stage, o.type);
  const app = stubApp(
    asD1(raw),
    { id: 'boss', role: 'admin', email: 'boss@x.co', admin_scope: null },
    (a) => a.route('/api/admin', adminRoutes),
    { env: { INITIAL_ADMIN_EMAIL: 'boss@x.co' } }
  );
  return { raw, app };
}

const board = async (app: ReturnType<typeof seed>['app'], qs: string) => {
  const res = await json(await get(app, `/api/admin/orders?${qs}&limit=100`));
  assert.equal(res.success, true, JSON.stringify(res));
  return res;
};
const ids = (res: Record<string, unknown>) => (res.orders as Array<{ id: string }>).map((o) => o.id).sort();

/** One order per stage of each path (the off-path `cancelled` too). */
function everyStage(): Seed[] {
  const out: Seed[] = [];
  const add = (type: string, stage: OrderStage) =>
    out.push({ id: `ORD-${type}-${stage}`, type, stage, status: STAGE_LEGACY_STATUS[stage] });
  for (const s of DIRECT_STAGES) add('direct', s);
  add('direct', 'cancelled');
  for (const t of ['preorder_air', 'preorder_sea', 'preorder_land']) {
    for (const s of PREORDER_STAGES) add(t, s);
    add(t, 'cancelled');
  }
  // A stage and a legacy status that disagree (a hand correction): the
  // STAGE decides, as it does for the row's quick button.
  out.push({ id: 'ORD-mixed-direct-received-processing', type: 'direct', stage: 'received', status: 'processing' });
  out.push({ id: 'ORD-mixed-sea-at-levo', type: 'preorder_sea', stage: 'at_levo_warehouse', status: 'processing' });
  return out;
}

const EXPECTED = [
  'ORD-direct-confirmed',
  'ORD-direct-preparing',
  'ORD-preorder_air-local_delivery_prep',
  'ORD-preorder_land-local_delivery_prep',
  'ORD-preorder_sea-local_delivery_prep',
].sort();

test('membership for EVERY stage: direct confirmed/preparing + pre-orders in local delivery prep, nothing else', async () => {
  const orders = everyStage();
  const { app } = seed(orders);
  const res = await board(app, 'scope=prepare');
  assert.deepEqual(ids(res), EXPECTED);
  assert.equal(res.total, EXPECTED.length);
  // The TypeScript twin agrees with the SQL, row by row.
  assert.deepEqual(
    orders.filter((o) => needsPreparation(o.type, o.stage, o.status)).map((o) => o.id).sort(),
    EXPECTED
  );
});

test('the count beside «يجب تجهيزها» is the same on every live board and equals its own total', async () => {
  const { app } = seed(everyStage());
  for (const scope of ['open', 'all', 'preorder', 'prepare']) {
    const res = await board(app, `scope=${scope}`);
    assert.equal(res.options.type.prepare, EXPECTED.length, `scope=${scope}`);
  }
  const prep = await board(app, 'scope=prepare');
  assert.equal(prep.options.status.any, prep.total, 'the status select counts the prepare rows under scope=prepare');
  assert.equal(prep.options.status.confirmed, 1);
  assert.equal(prep.options.status.processing, 4);
  // The status select narrows it like every other scope.
  assert.deepEqual(ids(await board(app, 'scope=prepare&status=confirmed')), ['ORD-direct-confirmed']);
  // The archive has nothing to prepare.
  assert.equal((await board(app, 'scope=delivered')).options.type.prepare, 0);
});

test('the prepare scope still reads through the board’s partial index', () => {
  const raw: DatabaseSync = freshDb();
  const src = String((raw.prepare("SELECT sql FROM sqlite_master WHERE name='idx_orders_board_open'").get() as { sql: string }).sql);
  assert.ok(src.includes("status NOT IN ('delivered','cancelled')"));
  const plan = (
    raw
      .prepare(
        `EXPLAIN QUERY PLAN SELECT o.* FROM orders o LEFT JOIN users u ON u.id = o.user_id
          WHERE (o.status NOT IN ('delivered','cancelled'))
            AND (${PREPARE_WHERE_SQL})
          ORDER BY o.delivery_due_day IS NULL, o.delivery_due_day ASC, o.priority DESC,
                   (o.priority_due_at IS NULL), o.priority_due_at ASC, o.created_at ASC, o.id ASC LIMIT 30`
      )
      .all() as { detail: string }[]
  )
    .map((r) => r.detail)
    .join(' | ');
  assert.match(plan, /idx_orders_board_open/);
  raw.close();
});

test('pressing «تم تأكيد الطلب» moves a received direct order into «يجب تجهيزها»', async () => {
  const { app } = seed([{ id: 'ORD-NEW0000001', type: 'direct', stage: 'received', status: 'pending' }]);
  assert.deepEqual(ids(await board(app, 'scope=prepare')), []);
  const open = await board(app, 'scope=open');
  assert.equal(open.orders[0].quick_next.stage, 'confirmed', 'the row button is «تم تأكيد الطلب»');
  const moved = await send(app, 'PATCH', '/api/admin/orders/ORD-NEW0000001/stage', { stage: 'confirmed' });
  assert.equal(moved.status, 200, JSON.stringify(await moved.clone().json()));
  const after = await board(app, 'scope=prepare');
  assert.deepEqual(ids(after), ['ORD-NEW0000001']);
  assert.equal(after.options.type.prepare, 1);
  await Promise.allSettled(pending);
});

test('an unknown scope is still refused', async () => {
  const { app } = seed([]);
  const res = await get(app, '/api/admin/orders?scope=prepared');
  assert.equal(res.status, 400);
});
