import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, asD1, count, dbThrough, freshDb, get, json, patch, row, stubApp, type StubUser } from './fixtures/app';
import { adminPreorderOriginRoutes } from '../worker/routes/adminPreorderOrigins';
import { deleteCancelledOrder } from '../worker/lib/orderDeletion';
import type { SqliteStatement } from './fixtures/d1';

const OWNER: StubUser = { id: 'owner', role: 'admin', email: 'boss@x.co', admin_scope: 'full' };
const ASSISTANT: StubUser = { id: 'assistant', role: 'admin', email: 'asst@x.co', admin_scope: 'assistant' };
const CUSTOMER: StubUser = { id: 'customer', role: 'customer', email: 'customer@x.co' };

function setup(raw = freshDb()) {
  raw.exec(`INSERT INTO users(id,email,role) VALUES ('owner','boss@x.co','admin'),('assistant','asst@x.co','admin'),('customer','customer@x.co','customer');
    INSERT INTO products(id,name,slug,price_iqd,product_cost_iqd,stock,stock_reserved) VALUES ('printer','A1','pre-origin-a1',900000,600000,10,2);
    INSERT INTO orders(id,user_id,status,stage,shipping_type,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd)
    VALUES ('pre_order','customer','processing','supplier_preparing','preorder_land','{}','std','{}','cod',4500000,1600,4500000,4500000),
           ('other_order','customer','confirmed','confirmed','preorder_air','{}','std','{}','cod',900000,1600,900000,900000);
    INSERT INTO order_items(id,order_id,product_id,name_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis)
    VALUES ('pre_line','pre_order','printer','Bambu A1','A1 Combo',5,900000,4500000,600000,'snapshot'),
           ('other_line','other_order','printer','Bambu A1','A1 Combo',1,900000,900000,600000,'snapshot');`);
  const real = asD1(raw);
  const batchSizes: number[] = [];
  let beforeCommit: (() => Promise<void>) | undefined;
  const db = {
    prepare: (sql: string) => real.prepare(sql),
    async batch(statements: SqliteStatement[]) {
      batchSizes.push(statements.length);
      if (beforeCommit && statements.some((s) => /(?:INSERT INTO|UPDATE) order_preorder_unit_origins/.test(s.sql))) {
        const hook = beforeCommit; beforeCommit = undefined; await hook();
      }
      return real.batch(statements as unknown as D1PreparedStatement[]);
    },
  } as unknown as D1Database;
  const app = (user: StubUser | null) => stubApp(db, user, (a) => a.route('/p', adminPreorderOriginRoutes));
  return { raw, db, batchSizes, owner: app(OWNER), assistant: app(ASSISTANT), customer: app(CUSTOMER), anonymous: app(null), beforeCommit: (hook: () => Promise<void>) => { beforeCommit = hook; } };
}
const path = '/p/pre_order/preorder-origins';
const source = (unit_index = 1, overrides: Record<string, unknown> = {}) => ({
  order_item_id: 'pre_line', unit_index, version: 0, batch_name: 'دفعة الطلبات المسبقة', batch_ref: 'BATCH-07',
  purchase_ref: 'BUY-100', supplier_order_no: 'BAMBU-SHARED-5', tracking_no: '', note: '', ...overrides,
});
const physicalAndFinancial = (raw: ReturnType<typeof freshDb>) => JSON.stringify({
  products: all(raw, 'SELECT * FROM products ORDER BY id'),
  orders: all(raw, 'SELECT * FROM orders ORDER BY id'),
  items: all(raw, 'SELECT * FROM order_items ORDER BY id'),
  lots: all(raw, 'SELECT * FROM inventory_lots ORDER BY id'),
  allocations: all(raw, 'SELECT * FROM order_item_inventory_allocations ORDER BY id'),
  stock: all(raw, 'SELECT * FROM inventory_ledger ORDER BY id'),
  journal: all(raw, 'SELECT * FROM accounting_entries ORDER BY id'),
  costs: all(raw, 'SELECT * FROM finance_order_costs ORDER BY id'),
});

test('assistant files five exact preorder slots sharing one supplier order without changing capacity, stock, costs or profit inputs', async () => {
  const w = setup(), before = physicalAndFinancial(w.raw);
  const empty = await get(w.assistant, path), view = await json(empty);
  assert.equal(empty.status, 200);
  assert.equal(empty.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(view.editable, true);
  assert.equal(view.rows.length, 5);
  assert.deepEqual(view.rows.map((r: { version: number }) => r.version), [0, 0, 0, 0, 0]);
  const body = { units: Array.from({ length: 5 }, (_, i) => source(i + 1)) };
  const result = await patch(w.assistant, path, body), saved = await json(result);
  assert.equal(result.status, 200, JSON.stringify(saved));
  assert.equal(saved.rows.length, 5);
  assert.ok(saved.rows.every((r: { supplier_order_no: string; version: number }) => r.supplier_order_no === 'BAMBU-SHARED-5' && r.version === 1));
  assert.equal(count(w.raw, 'SELECT COUNT(*) n FROM order_preorder_unit_origins'), 5);
  assert.equal(count(w.raw, "SELECT COUNT(*) n FROM audit_log WHERE action='order.preorder_origins_updated'"), 1);
  assert.equal(count(w.raw, 'SELECT COUNT(*) n FROM order_preorder_unit_origin_versions'), 5);
  assert.equal(physicalAndFinancial(w.raw), before);
  const repeat = await patch(w.assistant, path, body), replay = await json(repeat);
  assert.equal(repeat.status, 200);
  assert.equal(replay.already, true);
  assert.ok(replay.rows.every((r: { version: number }) => r.version === 1));
  assert.equal(count(w.raw, "SELECT COUNT(*) n FROM audit_log WHERE action='order.preorder_origins_updated'"), 1);
  assert.equal(count(w.raw, 'SELECT COUNT(*) n FROM order_preorder_unit_origin_versions'), 5);
  assert.equal(physicalAndFinancial(w.raw), before);
});

test('supplier tracking corrections require current per-unit versions and cannot move the order slot or inject financial fields', async () => {
  const w = setup();
  assert.equal((await patch(w.assistant, path, { units: [source()] })).status, 200);
  const before = physicalAndFinancial(w.raw);
  const changed = await patch(w.assistant, path, { units: [source(1, { version: 1, tracking_no: 'DHL-123' })] });
  assert.equal(changed.status, 200);
  assert.equal((await json(changed)).rows[0].version, 2);
  assert.deepEqual(all(w.raw, 'SELECT version,tracking_no FROM order_preorder_unit_origin_versions ORDER BY version'), [{ version: 1, tracking_no: '' }, { version: 2, tracking_no: 'DHL-123' }]);
  const stale = await patch(w.assistant, path, { units: [source(1, { version: 1, tracking_no: 'STALE' })] });
  assert.equal(stale.status, 409);
  assert.equal((await json(stale)).code, 'PREORDER_ORIGIN_VERSION_CHANGED');
  for (const body of [
    { units: [source(2), source(1, { order_item_id: 'other_line' })] },
    { units: [source(6)] },
    { units: [source(2), source(2)] },
    { units: [source(2, { supplier_order_no: '' })] },
    { units: [source(2, { note: 'x'.repeat(501) })] },
    { units: [source(2, { cost_iqd: 1 })] },
    { units: [source(2)], cost_iqd: 1 },
  ]) {
    const response = await patch(w.assistant, path, body);
    assert.equal(response.status, 400, JSON.stringify(await json(response)));
    assert.equal(count(w.raw, 'SELECT COUNT(*) n FROM order_preorder_unit_origins'), 1);
  }
  assert.equal(physicalAndFinancial(w.raw), before);
  const record = row<{ id: string }>(w.raw, 'SELECT id FROM order_preorder_unit_origins')!;
  assert.throws(() => w.raw.prepare("UPDATE order_preorder_unit_origins SET order_item_ref='other_line' WHERE id=?").run(record.id), /identity is immutable/);
  assert.throws(() => w.raw.prepare('DELETE FROM order_preorder_unit_origins WHERE id=?').run(record.id), /must be retained/);
});

test('preorder source routes deny customers and revoked receivers, and writes only follow the procurement/preparation lifecycle', async () => {
  const w = setup();
  assert.equal((await get(w.customer, path)).status, 403);
  assert.equal((await patch(w.customer, path, { units: [source()] })).status, 403);
  assert.equal((await get(w.anonymous, path)).status, 401);
  w.raw.prepare("INSERT INTO ops_permissions(user_id,capability,allowed) VALUES ('assistant','receive',0)").run();
  assert.equal((await patch(w.assistant, path, { units: [source()] })).status, 403);
  assert.equal((await get(w.assistant, path)).status, 200, 'revoking writes does not hide operational history from an admin');
  for (const [shipping, status, stage] of [
    ['direct', 'processing', 'preparing'], ['preorder_land', 'pending', 'received'],
    ['preorder_land', 'shipped', 'handed_to_carrier'], ['preorder_land', 'delivered', 'delivered'],
    ['preorder_land', 'cancelled', 'cancelled'], ['preorder_land', 'processing', 'out_for_delivery'],
  ]) {
    w.raw.prepare("UPDATE orders SET shipping_type=?,status=?,stage=? WHERE id='pre_order'").run(shipping, status, stage);
    const view = await json(await get(w.owner, path));
    assert.equal(view.editable, false, [shipping, status, stage].join('/'));
    const response = await patch(w.owner, path, { units: [source()] });
    assert.equal(response.status, 409);
    assert.equal((await json(response)).code, 'PREORDER_ORIGINS_LOCKED');
  }
  assert.equal(count(w.raw, 'SELECT COUNT(*) n FROM order_preorder_unit_origins'), 0);
  for (const stage of ['confirmed', 'supplier_preparing', 'at_origin_warehouse', 'preparing_freight', 'at_levo_warehouse', 'local_delivery_prep']) {
    w.raw.prepare("UPDATE orders SET shipping_type='preorder_sea',status='processing',stage=? WHERE id='pre_order'").run(stage);
    assert.equal((await json(await get(w.owner, path))).editable, true, stage);
  }
});

test('a concurrent correction or dispatch invalidates the whole stale source update', async () => {
  const w = setup();
  assert.equal((await patch(w.assistant, path, { units: [source()] })).status, 200);
  w.beforeCommit(async () => {
    const winner = await patch(w.owner, path, { units: [source(1, { version: 1, tracking_no: 'WINNER' })] });
    assert.equal(winner.status, 200, JSON.stringify(await json(winner)));
  });
  const stale = await patch(w.assistant, path, { units: [source(1, { version: 1, tracking_no: 'LOSER' }), source(2)] });
  assert.equal(stale.status, 409);
  assert.equal(count(w.raw, 'SELECT COUNT(*) n FROM order_preorder_unit_origins'), 1);
  assert.equal(row<{ tracking_no: string }>(w.raw, 'SELECT tracking_no FROM order_preorder_unit_origins')!.tracking_no, 'WINNER');
  w.beforeCommit(async () => { w.raw.exec("UPDATE orders SET status='shipped',stage='out_for_delivery' WHERE id='pre_order'"); });
  const dispatched = await patch(w.assistant, path, { units: [source(2)] });
  assert.equal(dispatched.status, 409);
  assert.equal(count(w.raw, 'SELECT COUNT(*) n FROM order_preorder_unit_origins'), 1);
});

test('exact returned slots and cancelled-order cleanup retain original supplier references without reassignment', async () => {
  const w = setup();
  assert.equal((await patch(w.assistant, path, { units: [source(1), source(2)] })).status, 200);
  const saved = all(w.raw, 'SELECT * FROM order_preorder_unit_origins ORDER BY unit_index');
  w.raw.exec(`UPDATE orders SET status='delivered',stage='delivered' WHERE id='pre_order';
    INSERT INTO order_item_units(id,order_id,order_item_id,owner_user_id,unit_index) VALUES ('returned_unit','pre_order','pre_line','customer',2);
    INSERT INTO return_cases(id,order_id,order_item_id,unit_id,user_id,qty,reason,state,resolution)
    VALUES ('returned_case','pre_order','pre_line','returned_unit','customer',1,'defective','resolved','refund');`);
  const delivered = await json(await get(w.assistant, path));
  assert.equal(delivered.historical, true);
  assert.equal(delivered.rows[0].state, 'delivered');
  assert.equal(delivered.rows[1].state, 'returned');
  assert.deepEqual(all(w.raw, 'SELECT * FROM order_preorder_unit_origins ORDER BY unit_index'), saved);
  // A different, never-delivered order follows the actual cleanup function.
  assert.equal((await patch(w.assistant, '/p/other_order/preorder-origins', { units: [source(1, { order_item_id: 'other_line' })] })).status, 200);
  w.raw.exec("UPDATE orders SET status='cancelled',stage='cancelled' WHERE id='other_order'");
  const historical = await json(await get(w.assistant, '/p/other_order/preorder-origins'));
  assert.equal(historical.rows[0].state, 'cancelled');
  assert.equal(historical.editable, false);
  const erased = await deleteCancelledOrder(w.db, 'other_order');
  assert.equal(erased.deleted, true);
  const retained = row(w.raw, "SELECT order_id,order_item_id,order_ref,order_item_ref,supplier_order_no FROM order_preorder_unit_origins WHERE order_ref='other_order'");
  assert.deepEqual(retained, { order_id: null, order_item_id: null, order_ref: 'other_order', order_item_ref: 'other_line', supplier_order_no: 'BAMBU-SHARED-5' });
  assert.equal(count(w.raw, "SELECT COUNT(*) n FROM order_preorder_unit_origin_versions WHERE order_ref='other_order'"), 1);
});

test('deploy ahead reads missing preorder evidence explicitly and refuses writes without touching orders', async () => {
  const w = setup(dbThrough('0186')), before = physicalAndFinancial(w.raw);
  const response = await get(w.assistant, path), view = await json(response);
  assert.equal(response.status, 200);
  assert.equal(view.installed, false);
  assert.equal(view.editable, false);
  assert.equal(view.rows.length, 5);
  assert.ok(view.rows.every((r: { version: number }) => r.version === 0));
  const refused = await patch(w.assistant, path, { units: [source()] });
  assert.equal(refused.status, 503);
  assert.equal((await json(refused)).code, 'PREORDER_ORIGINS_NOT_INSTALLED');
  assert.equal(physicalAndFinancial(w.raw), before);
});

test('500 preorder source entries use a bounded atomic batch while preserving every full source revision', async () => {
  const w = setup();
  w.raw.exec("UPDATE order_items SET qty=500 WHERE id='pre_line'");
  const units = Array.from({ length: 500 }, (_, i) => source(i + 1, { note: 'n'.repeat(500), tracking_no: `TRACK-${i + 1}` }));
  const response = await patch(w.assistant, path, { units });
  assert.equal(response.status, 200, JSON.stringify(await json(response.clone())));
  assert.equal(count(w.raw, 'SELECT COUNT(*) n FROM order_preorder_unit_origins'), 500);
  assert.equal(count(w.raw, 'SELECT COUNT(*) n FROM order_preorder_unit_origin_versions WHERE length(note)=500'), 500);
  assert.ok(Math.max(...w.batchSizes) <= 30, `batch sizes: ${w.batchSizes.join(',')}`);
  assert.equal(count(w.raw, "SELECT COUNT(*) n FROM audit_log WHERE action='order.preorder_origins_updated' AND json_valid(detail) AND length(detail)<4000"), 1);
  assert.throws(() => w.raw.exec("UPDATE order_preorder_unit_origin_versions SET tracking_no='erased'"), /versions are immutable/);
  assert.throws(() => w.raw.exec('DELETE FROM order_preorder_unit_origin_versions'), /versions must be retained/);
});
