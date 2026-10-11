import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { all, asD1, count, dbThrough, freshDb, get, json, patch, post, row, stubApp, type StubUser } from './fixtures/app';
import type { SqliteStatement } from './fixtures/d1';
import { adminProcurementRoutes } from '../worker/routes/adminProcurement';
import { baghdadDay } from '../worker/lib/operations';
import { planLotConsumption } from '../worker/lib/inventoryLots';
import type { StockMove } from '../worker/lib/inventory';

const OWNER: StubUser = { id: 'owner', email: 'boss@x.co', role: 'admin', admin_scope: 'full' };
const ASSISTANT: StubUser = { id: 'assistant', email: 'assistant@x.co', role: 'admin', admin_scope: 'assistant' };
const CUSTOMER: StubUser = { id: 'customer', email: 'customer@x.co', role: 'customer' };

function setup(raw: DatabaseSync = freshDb()) {
  raw.exec(`INSERT INTO users(id,email,role,admin_scope) VALUES
    ('owner','boss@x.co','admin','full'),('assistant','assistant@x.co','admin','assistant'),('customer','customer@x.co','customer',NULL);
    INSERT INTO products(id,name,name_ar,slug,sku,price_iqd,product_cost_iqd,stock,inventory_mode)
    VALUES ('origin_printer','A1 Combo','A1 كومبو','origin-printer','ORIGIN-A1',900000,600000,0,'BASE');`);
  const real = asD1(raw);
  let gate: { fragment: string; entered: () => void; resumed: Promise<void> } | undefined;
  const db = {
    prepare: (sql: string) => real.prepare(sql),
    async batch(statements: SqliteStatement[]) {
      const pending = gate;
      if (pending && statements.some((s) => s.sql.includes(pending.fragment))) {
        gate = undefined;
        pending.entered();
        await pending.resumed;
      }
      return real.batch(statements as unknown as D1PreparedStatement[]);
    },
  } as unknown as D1Database;
  const forUser = (user: StubUser) => stubApp(db, user, (app) => app.route('/p', adminProcurementRoutes));
  const pauseOn = (fragment: string) => {
    let entered!: () => void, resume!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const resumed = new Promise<void>((resolve) => { resume = resolve; });
    gate = { fragment, entered, resumed };
    return { waiting, resume };
  };
  return { raw, app: forUser(OWNER), assistant: forUser(ASSISTANT), customer: forUser(CUSTOMER), pauseOn };
}

function draft(qty = 5, tracked = true) {
  return {
    operation_id: crypto.randomUUID(), currency: 'IQD', purchase_day: baghdadDay(),
    invoice_no: 'دفعة A1 — أصل المورد', status: 'ordered', cost_state: 'final',
    charges: [],
    lines: [{ product_id: 'origin_printer', scope: 'base', scope_id: '', qty_ordered: qty,
      purchase_cost_mode: 'total', source_total_amount: qty * 600000 + 2,
      ...(tracked ? { unit_origins: Array.from({ length: qty }, (_, i) => ({
        unit_index: i + 1, supplier_order_no: `BAMBU-${i + 1}`, tracking_no: i === 0 ? '' : `TRACK-${i + 1}`,
      })) } : {}),
    }],
  };
}

async function create(w: ReturnType<typeof setup>, body = draft()) {
  const response = await post(w.app, '/p/documents', body);
  const payload = await json(response);
  assert.equal(response.status, 200, JSON.stringify(payload));
  const detail = await json(await get(w.app, `/p/documents/${payload.id}`));
  return { id: String(payload.id), body, detail, line: detail.lines[0] };
}

function moneyAndStock(raw: DatabaseSync) {
  return JSON.stringify({
    product: all(raw, 'SELECT id,price_iqd,product_cost_iqd,stock FROM products ORDER BY id'),
    incoming: all(raw, 'SELECT id,qty_ordered,qty_received,purchase_unit_iqd,purchase_total_iqd,shipping_total_iqd,internal_delivery_total_iqd FROM incoming_inventory ORDER BY id'),
    lots: all(raw, 'SELECT * FROM inventory_lots ORDER BY id'),
    ledger: all(raw, 'SELECT * FROM inventory_ledger ORDER BY id'),
    journals: all(raw, 'SELECT * FROM accounting_entries ORDER BY id'),
    journalLines: all(raw, 'SELECT * FROM accounting_lines ORDER BY id'),
  });
}

test('tracked creation requires a complete one-per-unit set and rolls back all purchase and money writes on invalid metadata', async () => {
  const w = setup();
  const good = draft(2);
  const cases: unknown[] = [
    [{ unit_index: 1, supplier_order_no: 'ONE' }],
    [{ unit_index: 1, supplier_order_no: 'ONE' }, { unit_index: 1, supplier_order_no: 'TWO' }],
    [{ unit_index: 0, supplier_order_no: 'ONE' }, { unit_index: 2, supplier_order_no: 'TWO' }],
    [{ unit_index: 1, supplier_order_no: '' }, { unit_index: 2, supplier_order_no: 'TWO' }],
    [{ unit_index: 1, supplier_order_no: 'x'.repeat(121) }, { unit_index: 2, supplier_order_no: 'TWO' }],
    [{ unit_index: 1, supplier_order_no: 'ONE', tracking_no: 'x'.repeat(121) }, { unit_index: 2, supplier_order_no: 'TWO' }],
  ];
  for (const unit_origins of cases) {
    const response = await post(w.app, '/p/documents', { ...good, operation_id: crypto.randomUUID(), lines: [{ ...good.lines[0], unit_origins }] });
    assert.equal(response.status, 400, JSON.stringify(await json(response)));
    for (const table of ['purchase_orders', 'purchase_lines', 'incoming_inventory', 'inventory_unit_origins', 'accounting_entries'])
      assert.equal(count(w.raw, `SELECT COUNT(*) n FROM ${table}`), 0, table);
  }
  const oversizedLine = await post(w.app, '/p/documents', draft(1001));
  assert.equal(oversizedLine.status, 400);
  const oversizedDocument = draft(1000);
  const oversized = await post(w.app, '/p/documents', { ...oversizedDocument, lines: Array.from({ length: 6 }, () => oversizedDocument.lines[0]) });
  assert.equal(oversized.status, 400);
  assert.equal((await json(oversized)).code, 'UNIT_ORIGINS_LIMIT');
  assert.equal(count(w.raw, 'SELECT COUNT(*) n FROM inventory_unit_origins'), 0);
  assert.equal(count(w.raw, 'SELECT COUNT(*) n FROM purchase_orders'), 0);
  const p = await create(w, good);
  assert.deepEqual(p.line.unit_origins.map((u: { unit_index: number; supplier_order_no: string }) => [u.unit_index, u.supplier_order_no]), [[1, 'BAMBU-1'], [2, 'BAMBU-2']]);
  assert.equal(p.line.unit_origins[0].received_lot_id, null);
});

test('chosen per-unit references follow partial receipts across exact-dinar cost segments and repeated receipt never doubles them', async () => {
  const w = setup(), p = await create(w);
  const origins = p.line.unit_origins as Array<{ id: string; unit_index: number }>;
  const ids = [origins[4].id, origins[1].id, origins[3].id];
  const body = { operation_id: crypto.randomUUID(), lines: [{ line_id: p.line.line_id, qty: 3, unit_origin_ids: ids }] };
  const response = await post(w.assistant, `/p/documents/${p.id}/receive`, body);
  assert.equal(response.status, 200, JSON.stringify(await json(response)));
  assert.equal(count(w.raw, 'SELECT COUNT(*) n FROM inventory_unit_origins WHERE received_lot_id IS NOT NULL'), 3);
  const received = all<{ id: string; unit_cost_iqd: number }>(w.raw, `SELECT u.id,l.unit_cost_iqd FROM inventory_unit_origins u
    JOIN inventory_lots l ON l.id=u.received_lot_id ORDER BY u.id`);
  const costById = new Map(received.map((u) => [u.id, u.unit_cost_iqd]));
  assert.equal(costById.get(ids[0]), 600001);
  assert.equal(costById.get(ids[1]), 600001);
  assert.equal(costById.get(ids[2]), 600000);
  assert.equal(count(w.raw, 'SELECT SUM(total_cost_iqd) n FROM inventory_lots'), 1800002);
  const before = moneyAndStock(w.raw);
  const repeat = await post(w.assistant, `/p/documents/${p.id}/receive`, body);
  assert.equal(repeat.status, 200);
  assert.equal((await json(repeat)).already, true);
  assert.equal(moneyAndStock(w.raw), before);
  const rest = await post(w.assistant, `/p/documents/${p.id}/receive`, {
    operation_id: crypto.randomUUID(), lines: [{ line_id: p.line.line_id, qty: 2 }],
  });
  assert.equal(rest.status, 200, JSON.stringify(await json(rest)));
  assert.equal(count(w.raw, 'SELECT COUNT(*) n FROM inventory_unit_origins WHERE received_lot_id IS NOT NULL'), 5);
  assert.equal(count(w.raw, 'SELECT SUM(total_cost_iqd) n FROM inventory_lots'), 3000002);
  assert.equal(count(w.raw, 'SELECT SUM(unit_cost_iqd*qty_remaining) n FROM inventory_lots'), 3000002);
  assert.equal(count(w.raw, "SELECT stock n FROM products WHERE id='origin_printer'"), 5);
});

test('receipt refuses duplicate, foreign, previously received and incomplete unit selections without partial writes', async () => {
  const w = setup(), p = await create(w, draft(3)), other = await create(w, draft(1));
  const ids = p.line.unit_origins.map((u: { id: string }) => u.id) as string[];
  const receipt = async (qty: number, unit_origin_ids: unknown, rejected_qty = 0) => post(w.app, `/p/documents/${p.id}/receive`, {
    operation_id: crypto.randomUUID(), lines: [{ line_id: p.line.line_id, qty, unit_origin_ids, rejected_qty }],
  });
  const before = moneyAndStock(w.raw);
  for (const selected of [[ids[0], ids[0]], [ids[0]], [ids[0], other.line.unit_origins[0].id], 'invalid']) {
    const response = await receipt(2, selected);
    assert.equal(response.status, 400, JSON.stringify(await json(response)));
    assert.equal(moneyAndStock(w.raw), before);
  }
  const rejected = await receipt(1, [ids[0]], 1);
  assert.equal(rejected.status, 400);
  assert.equal((await json(rejected)).code, 'TRACKED_REJECTION_REQUIRES_SELECTION');
  assert.equal(moneyAndStock(w.raw), before);
  assert.equal((await receipt(1, [ids[0]])).status, 200);
  const after = moneyAndStock(w.raw);
  const reused = await receipt(1, [ids[0]]);
  assert.equal(reused.status, 400);
  assert.equal(moneyAndStock(w.raw), after);
});

test('assistant can correct supplier references after receipt while all costs, lots, quantities and journals remain unchanged', async () => {
  const w = setup(), p = await create(w, draft(2));
  const received = await post(w.assistant, `/p/documents/${p.id}/receive`, {
    operation_id: crypto.randomUUID(), lines: [{ line_id: p.line.line_id, qty: 2 }],
  });
  assert.equal(received.status, 200, JSON.stringify(await json(received)));
  const before = moneyAndStock(w.raw);
  const version = count(w.raw, 'SELECT version n FROM purchase_orders WHERE id=?', p.id);
  const id = p.line.unit_origins[0].id;
  const response = await patch(w.assistant, `/p/documents/${p.id}/unit-origins`, {
    version, units: [{ id, supplier_order_no: 'BAMBU-CORRECTED', tracking_no: 'DHL-NEW' }],
  });
  assert.equal(response.status, 200, JSON.stringify(await json(response)));
  assert.deepEqual(row(w.raw, 'SELECT supplier_order_no,tracking_no FROM inventory_unit_origins WHERE id=?', id), {
    supplier_order_no: 'BAMBU-CORRECTED', tracking_no: 'DHL-NEW',
  });
  assert.equal(moneyAndStock(w.raw), before);
  assert.equal(count(w.raw, "SELECT COUNT(*) n FROM audit_log WHERE actor_id='assistant' AND action='purchase.received' AND target=?", p.id), 1);
  assert.equal(count(w.raw, "SELECT COUNT(*) n FROM audit_log WHERE actor_id='assistant' AND action='purchase.unit_origins_updated' AND target=?", id), 1, 'the changed unit has its own audit entry');
  const stale = await patch(w.assistant, `/p/documents/${p.id}/unit-origins`, {
    version, units: [{ id, supplier_order_no: 'STALE', tracking_no: 'STALE' }],
  });
  assert.equal(stale.status, 409);
  assert.equal(row<{ supplier_order_no: string }>(w.raw, 'SELECT supplier_order_no FROM inventory_unit_origins WHERE id=?', id)!.supplier_order_no, 'BAMBU-CORRECTED');
  const operational = await get(w.assistant, `/p/documents/${p.id}/unit-origins`);
  assert.equal(operational.status, 200);
  const refs = await json(operational);
  assert.equal(refs.purchase.status, 'received');
  assert.equal(refs.lines[0].unit_origins[0].tracking_no, 'DHL-NEW');
  assert.equal((await get(w.customer, `/p/documents/${p.id}/unit-origins`)).status, 403);
});

test('receiving exposes supplier unit references to operations admins without cost access and denies customer access or cost writes', async () => {
  const w = setup(), p = await create(w, draft(2));
  const receiving = await get(w.assistant, `/p/receiving/${p.id}`);
  assert.equal(receiving.status, 200);
  const payload = await json(receiving);
  assert.equal(payload.lines[0].unit_origins[1].supplier_order_no, 'BAMBU-2');
  for (const forbidden of ['purchase_unit_iqd', 'source_unit_amount', 'unit_cost_iqd', 'purchase_total_iqd', 'exchange_rate', 'selling_price_iqd'])
    assert.equal(JSON.stringify(payload).includes(`"${forbidden}"`), false, forbidden);
  assert.equal((await get(w.customer, `/p/receiving/${p.id}`)).status, 403);
  assert.equal((await patch(w.customer, `/p/documents/${p.id}/unit-origins`, { version: 1, units: [] })).status, 403);
  const denied = await post(w.assistant, '/p/documents', draft(1));
  assert.ok(denied.status === 403 || denied.status === 404);
  const current = count(w.raw, 'SELECT version n FROM purchase_orders WHERE id=?', p.id);
  const before = moneyAndStock(w.raw);
  const injected = await patch(w.assistant, `/p/documents/${p.id}/unit-origins`, {
    version: current, purchase_unit_iqd: 0,
    units: [{ id: p.line.unit_origins[0].id, supplier_order_no: 'UNSAFE', tracking_no: '' }],
  });
  assert.equal(injected.status, 400, JSON.stringify(await json(injected)));
  assert.equal(moneyAndStock(w.raw), before);
  assert.equal(count(w.raw, 'SELECT version n FROM purchase_orders WHERE id=?', p.id), current);
  assert.equal(row<{ supplier_order_no: string }>(w.raw, 'SELECT supplier_order_no FROM inventory_unit_origins WHERE id=?', p.line.unit_origins[0].id)!.supplier_order_no, 'BAMBU-1');
  w.raw.prepare("INSERT INTO ops_permissions(user_id,capability,allowed) VALUES ('assistant','receive',0)").run();
  assert.equal((await patch(w.assistant, `/p/documents/${p.id}/unit-origins`, {
    version: current, units: [{ id: p.line.unit_origins[0].id, supplier_order_no: 'BLOCKED', tracking_no: '' }],
  })).status, 403);
});

test('a metadata correction racing with a planned receipt aborts that receipt atomically; retry receives the corrected unit once', { timeout: 15000 }, async () => {
  const w = setup(), p = await create(w, draft(1));
  const unitId = p.line.unit_origins[0].id;
  const body = { operation_id: crypto.randomUUID(), lines: [{ line_id: p.line.line_id, qty: 1, unit_origin_ids: [unitId] }] };
  const gate = w.pauseOn('INSERT INTO purchase_receiving_events');
  const stale = post(w.app, `/p/documents/${p.id}/receive`, body);
  await gate.waiting;
  const corrected = await patch(w.assistant, `/p/documents/${p.id}/unit-origins`, {
    version: p.detail.purchase.version, units: [{ id: unitId, supplier_order_no: 'CORRECTED-DURING-RECEIVE', tracking_no: 'DHL-CORRECTED' }],
  });
  gate.resume();
  assert.equal(corrected.status, 200, JSON.stringify(await json(corrected)));
  const refused = await stale;
  assert.equal(refused.status, 409, JSON.stringify(await json(refused)));
  assert.equal(count(w.raw, 'SELECT COUNT(*) n FROM inventory_lots'), 0);
  assert.equal(count(w.raw, 'SELECT COUNT(*) n FROM purchase_receiving_events'), 0);
  assert.equal(count(w.raw, "SELECT stock n FROM products WHERE id='origin_printer'"), 0);
  const retried = await post(w.app, `/p/documents/${p.id}/receive`, body);
  assert.equal(retried.status, 200, JSON.stringify(await json(retried)));
  assert.equal(count(w.raw, 'SELECT COUNT(*) n FROM inventory_unit_origins WHERE received_lot_id IS NOT NULL'), 1);
  assert.equal(row<{ supplier_order_no: string }>(w.raw, 'SELECT supplier_order_no FROM inventory_unit_origins WHERE id=?', unitId)!.supplier_order_no, 'CORRECTED-DURING-RECEIVE');
});

test('deploy ahead of the provenance migration preserves ordinary purchases and receipt but refuses tracked writes cleanly', async () => {
  const w = setup(dbThrough('0186'));
  const tracked = await post(w.app, '/p/documents', draft(1));
  assert.equal(tracked.status, 503, JSON.stringify(await json(tracked.clone())));
  assert.equal((await json(tracked)).code, 'UNIT_ORIGINS_NOT_INSTALLED');
  assert.equal(count(w.raw, 'SELECT COUNT(*) n FROM purchase_orders'), 0);
  const p = await create(w, draft(2, false));
  assert.deepEqual(p.line.unit_origins, []);
  const received = await post(w.app, `/p/documents/${p.id}/receive`, {
    operation_id: crypto.randomUUID(), lines: [{ line_id: p.line.line_id, qty: 2 }],
  });
  assert.equal(received.status, 200, JSON.stringify(await json(received)));
  assert.equal(count(w.raw, 'SELECT SUM(total_cost_iqd) n FROM inventory_lots'), 1200002);
  assert.equal(count(w.raw, "SELECT stock n FROM products WHERE id='origin_printer'"), 2);
});

test('same-day 2 + 3 + 5 receipts consume the earliest recorded batch even when random lot ids sort in the opposite order', async () => {
  const w = setup();
  // Procurement preserves the chosen receipt day at 09:00Z. These timestamps
  // reproduce separate receipts from that day; random ids deliberately oppose
  // their insertion order, exposing FIFO based on received_at,id alone.
  for (const [id, qty, cost, clock] of [
    ['z_earliest', 2, 400000, '10:00:00'],
    ['m_middle', 3, 500000, '11:00:00'],
    ['a_latest', 5, 600000, '12:00:00'],
  ] as const) w.raw.prepare(`INSERT INTO inventory_lots
    (id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,cost_basis,received_at,created_at)
    VALUES (?,'origin_printer','base','',?,?,?,'opening','2026-10-11T09:00:00.000Z',?)`)
    .run(id, qty, qty, cost, `2026-10-11T${clock}.000Z`);
  const move: StockMove = {
    product_id: 'origin_printer', line_id: 'fifo_same_day_line', qty: 6,
    targets: [{ scope: 'base', scope_id: '', stock: 10, reserved: 6, low_stock_threshold: null, label: 'A1 Combo' }],
  };
  const plan = await planLotConsumption(asD1(w.raw), 'fifo_same_day_order', [move]);
  assert.deepEqual(plan.shortfall, []);
  assert.deepEqual(plan.allocations.map((a) => [a.lot_id, a.qty]), [['z_earliest', 2], ['m_middle', 3], ['a_latest', 1]]);
  assert.equal(plan.allocations.reduce((sum, a) => sum + a.cogs_iqd!, 0), 2900000);
});
