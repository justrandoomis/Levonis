import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, dbThrough, asD1, stubApp, post, patch, get, json, count } from './fixtures/app';
import { adminInventoryRoutes } from '../worker/routes/adminInventory';
import { adminProcurementRoutes } from '../worker/routes/adminProcurement';
import { planLotConsumption, planLotRestore } from '../worker/lib/inventoryLots';
import { operationsReport } from '../worker/lib/operationsReport';
import type { StockMove } from '../worker/lib/inventory';

function world(through: string | null = null) {
  const raw = through === null ? freshDb() : dbThrough(through);
  raw.exec(`INSERT INTO users(id,email,role,admin_scope) VALUES ('owner','boss@x.co','admin','full');
    INSERT INTO products(id,name,name_ar,slug,price_iqd,stock,inventory_mode)
    VALUES ('fi_stock','Stock','مخزون','fi-stock',900000,0,'BASE');`);
  const real = asD1(raw);
  let beforeReceive: (() => Promise<void>) | null = null;
  let beforeEdit: (() => Promise<void>) | null = null;
  const db = {
    prepare: (sql: string) => {
      const intercept = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
        get(target, property) {
          if (property === 'bind') return (...args: unknown[]) => intercept(target.bind(...args));
          if (property === 'run') return async () => {
            if (beforeEdit) { const hook = beforeEdit; beforeEdit = null; await hook(); }
            return target.run();
          };
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const statement = real.prepare(sql);
      return sql.startsWith('UPDATE incoming_inventory SET shipping_total_iqd') ? intercept(statement) : statement;
    },
    async batch(statements: D1PreparedStatement[]) {
      if (beforeReceive && statements.some(s => (s as unknown as { sql: string }).sql.includes('INSERT INTO incoming_inventory_receipts'))) {
        const hook = beforeReceive; beforeReceive = null; await hook();
      }
      return real.batch(statements);
    },
  } as D1Database;
  const app = stubApp(db, { id: 'owner', email: 'boss@x.co', role: 'admin', admin_scope: 'full' }, (a) => {
    a.route('/inventory', adminInventoryRoutes);
    a.route('/procurement', adminProcurementRoutes);
  });
  return { raw, db, app, beforeReceive: (hook: () => Promise<void>) => { beforeReceive = hook; }, beforeEdit: (hook: () => Promise<void>) => { beforeEdit = hook; } };
}

async function allocateAll(w: ReturnType<typeof world>, qty: number) {
  w.raw.exec(`INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd)
    VALUES ('fi_order','owner','pending','{}','std','{}','cod',0,1,0,0);
    INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd)
    VALUES ('fi_line','fi_order','fi_stock','Stock',${qty},0,0);`);
  const move: StockMove = { product_id: 'fi_stock', line_id: 'fi_line', qty, targets: [{ scope: 'base', scope_id: '', stock: qty, reserved: qty, low_stock_threshold: null, label: 'Stock' }] };
  const plan = await planLotConsumption(w.db, 'fi_order', [move]);
  assert.deepEqual(plan.shortfall, []);
  await w.db.batch(plan.statements);
  return count(w.raw, "SELECT SUM(cogs_iqd) n FROM order_item_inventory_allocations WHERE order_id='fi_order'");
}

test('a purchase decimal total propagates through partial receipts, inventory value and complete FIFO consumption', async () => {
  const w = world();
  const created = await post(w.app, '/procurement/documents', {
    operation_id: 'fi_fractional_invoice', currency: 'EUR', exchange_rate: 1626.25,
    cost_profile_id: 'germany_land', cost_profile_version: 1, shipping_rate_iqd: 0,
    status: 'ordered', cost_state: 'final', charges: [],
    lines: [{ product_id: 'fi_stock', scope: 'base', scope_id: '', qty_ordered: 5, source_unit_amount: 855, weight_g: 1000 }],
  });
  const purchase = await json(created);
  assert.equal(created.status, 200, JSON.stringify(purchase));
  const exact = count(w.raw, 'SELECT purchase_total_iqd n FROM incoming_inventory');
  assert.equal(exact, 6_952_219);
  const detail = await json(await get(w.app, `/procurement/documents/${purchase.id}`));
  for (const qty of [2, 3]) {
    const response = await post(w.app, `/procurement/documents/${purchase.id}/receive`, {
      operation_id: `fi_partial_${qty}`, lines: [{ line_id: detail.lines[0].line_id, qty }],
    });
    assert.equal(response.status, 200, JSON.stringify(await json(response)));
  }
  assert.equal(count(w.raw, 'SELECT SUM(total_cost_iqd) n FROM inventory_lots'), exact);
  assert.equal(count(w.raw, 'SELECT SUM(unit_cost_iqd*qty_remaining) n FROM inventory_lots'), exact);
  assert.equal(await allocateAll(w, 5), exact);
  await w.db.batch((await planLotRestore(w.db, 'fi_order')).statements);
  assert.equal(count(w.raw, 'SELECT SUM(unit_cost_iqd*qty_remaining) n FROM inventory_lots'), exact, 'returns restore the original exact cost layers');
});

test('a bare incoming receipt conserves its exact freight total through FIFO consumption', async () => {
  const w = world();
  const created = await post(w.app, '/inventory/incoming', {
    product_id: 'fi_stock', scope: 'base', scope_id: '', qty_ordered: 7, purchase_unit_iqd: 300000,
    shipping_total_iqd: 100, internal_delivery_total_iqd: 0, status: 'incoming',
  });
  const incoming = await json(created);
  assert.equal(created.status, 200, JSON.stringify(incoming));
  const received = await post(w.app, `/inventory/incoming/${incoming.id}/receive`, { receipt_id: 'fi_odd_receipt', qty: 7 });
  assert.equal(received.status, 200, JSON.stringify(await json(received)));
  const exact = count(w.raw, 'SELECT SUM(total_cost_iqd) n FROM inventory_lots');
  assert.equal(exact, 2_100_100);
  assert.equal(await allocateAll(w, 7), exact, 'selling every received unit must consume the acquisition total exactly');
});


test('a bare receipt cannot commit an old cost after a concurrent permitted cost edit', async () => {
  const w = world();
  const created = await json(await post(w.app, '/inventory/incoming', {
    product_id: 'fi_stock', scope: 'base', scope_id: '', qty_ordered: 2, purchase_unit_iqd: 300000,
    shipping_total_iqd: 100, internal_delivery_total_iqd: 0, status: 'incoming',
  }));
  w.beforeReceive(async () => {
    const edited = await patch(w.app, `/inventory/incoming/${created.id}`, { shipping_total_iqd: 200 });
    assert.equal(edited.status, 200, JSON.stringify(await json(edited)));
  });
  const received = await post(w.app, `/inventory/incoming/${created.id}/receive`, { receipt_id: 'fi_stale_cost', qty: 2 });
  assert.equal(received.status, 409, 'a stale cost plan must abort before any stock or historical cost is recorded');
  assert.equal((await json(received)).code, 'INCOMING_CHANGED');
  assert.equal(count(w.raw, 'SELECT COUNT(*) n FROM inventory_lots'), 0);
  assert.equal(count(w.raw, "SELECT stock n FROM products WHERE id='fi_stock'"), 0);
});

test('legacy partial receipts preserve all component remainders, maximum-length retries and returned cost layers', async () => {
  const w = world();
  const created = await json(await post(w.app, '/inventory/incoming', {
    product_id: 'fi_stock', scope: 'base', scope_id: '', qty_ordered: 7, purchase_unit_iqd: 300000,
    shipping_total_iqd: 100, internal_delivery_total_iqd: 10, status: 'incoming',
  }));
  let received = 0;
  for (const [index, qty] of [1, 3, 3].entries()) {
    const body = { receipt_id: String(index).repeat(60), qty };
    const response = await post(w.app, `/inventory/incoming/${created.id}/receive`, body);
    const payload = await json(response);
    assert.equal(response.status, 200, JSON.stringify(payload));
    received += qty;
    const replay = await post(w.app, `/inventory/incoming/${created.id}/receive`, body);
    assert.equal(replay.status, 200);
    assert.equal((await json(replay)).already, true);
    assert.equal(count(w.raw, "SELECT stock n FROM products WHERE id='fi_stock'"), received);
    assert.equal(count(w.raw, 'SELECT qty_received n FROM incoming_inventory'), received);
  }
  const exact = 2_100_110;
  assert.equal(count(w.raw, 'SELECT SUM(shipping_share_iqd) n FROM inventory_lots'), 100);
  assert.equal(count(w.raw, 'SELECT SUM(internal_share_iqd) n FROM inventory_lots'), 10);
  assert.equal(count(w.raw, 'SELECT SUM(total_cost_iqd) n FROM inventory_lots'), exact);
  assert.equal(count(w.raw, 'SELECT SUM(unit_cost_iqd*qty_remaining) n FROM inventory_lots'), exact);
  assert.equal(count(w.raw, 'SELECT COUNT(*) n FROM inventory_lots WHERE unit_cost_iqd<300015 OR unit_cost_iqd>300017 OR total_cost_iqd<>unit_cost_iqd*qty_received'), 0);
  assert.equal(await allocateAll(w, 7), exact);
  assert.equal(count(w.raw, 'SELECT SUM(qty_remaining) n FROM inventory_lots'), 0);
  await w.db.batch((await planLotRestore(w.db, 'fi_order')).statements);
  assert.equal(count(w.raw, 'SELECT SUM(unit_cost_iqd*qty_remaining) n FROM inventory_lots'), exact);
  assert.deepEqual((await planLotRestore(w.db, 'fi_order')).statements, []);
});


test('a bare cost edit cannot unfreeze a concurrent completed receipt, while paperwork remains editable', async () => {
  const w = world();
  const created = await json(await post(w.app, '/inventory/incoming', {
    product_id: 'fi_stock', scope: 'base', scope_id: '', qty_ordered: 2, purchase_unit_iqd: 300000,
    shipping_total_iqd: 100, internal_delivery_total_iqd: 0, status: 'incoming',
  }));
  w.beforeEdit(async () => {
    const received = await post(w.app, `/inventory/incoming/${created.id}/receive`, { receipt_id: 'fi_first_receive', qty: 2 });
    assert.equal(received.status, 200, JSON.stringify(await json(received)));
  });
  const edited = await patch(w.app, `/inventory/incoming/${created.id}`, { shipping_total_iqd: 200 });
  assert.equal(edited.status, 409);
  assert.equal((await json(edited)).code, 'INCOMING_CHANGED');
  assert.equal(count(w.raw, 'SELECT shipping_total_iqd n FROM incoming_inventory'), 100);
  assert.equal(count(w.raw, 'SELECT SUM(total_cost_iqd) n FROM inventory_lots'), 600100);
  const paperwork = await patch(w.app, `/inventory/incoming/${created.id}`, { notes: 'Filed after receipt' });
  assert.equal(paperwork.status, 200);
  assert.equal(await allocateAll(w, 2), 600100);
});

test('concurrent partial bare receipts cannot reuse a cost remainder position; the retry consumes only the next unit', async () => {
  const w = world();
  const created = await json(await post(w.app, '/inventory/incoming', {
    product_id: 'fi_stock', scope: 'base', scope_id: '', qty_ordered: 2, purchase_unit_iqd: 300000,
    shipping_total_iqd: 1, internal_delivery_total_iqd: 0, status: 'incoming',
  }));
  w.beforeReceive(async () => {
    const received = await post(w.app, `/inventory/incoming/${created.id}/receive`, { receipt_id: 'fi_cursor_winner', qty: 1 });
    assert.equal(received.status, 200, JSON.stringify(await json(received)));
  });
  const path = `/inventory/incoming/${created.id}/receive`, body = { receipt_id: 'fi_cursor_retry', qty: 1 };
  const stale = await post(w.app, path, body);
  assert.equal(stale.status, 409);
  assert.equal((await json(stale)).code, 'INCOMING_CHANGED');
  assert.equal(count(w.raw, 'SELECT qty_received n FROM incoming_inventory'), 1);
  assert.equal(count(w.raw, 'SELECT COUNT(*) n FROM inventory_lots'), 1);
  const retry = await post(w.app, path, body);
  assert.equal(retry.status, 200, JSON.stringify(await json(retry)));
  assert.equal((await json(await post(w.app, path, body))).already, true);
  assert.equal(count(w.raw, 'SELECT SUM(qty_remaining) n FROM inventory_lots'), 2);
  assert.equal(count(w.raw, 'SELECT SUM(total_cost_iqd) n FROM inventory_lots'), 600001);
  assert.equal(await allocateAll(w, 2), 600001);
});


test('exact legacy receipt and stale-cost refusal work before operations or batch-snapshot tables exist', async () => {
  const w = world('0161');
  // An old deployment already has incoming records. Exercise the receipt
  // path without involving newer catalogue selection/default readers.
  w.raw.exec(`INSERT INTO incoming_inventory(id,product_id,scope,scope_id,qty_ordered,purchase_unit_iqd,
    shipping_total_iqd,internal_delivery_total_iqd,status)
    VALUES ('fi_old_incoming','fi_stock','base','',7,300000,100,0,'incoming')`);
  const created = { id: 'fi_old_incoming' };
  w.beforeReceive(async () => {
    const edited = await patch(w.app, `/inventory/incoming/${created.id}`, { shipping_total_iqd: 101 });
    assert.equal(edited.status, 200);
  });
  const path = `/inventory/incoming/${created.id}/receive`, body = { receipt_id: 'fi_old_schema', qty: 7 };
  const stale = await post(w.app, path, body);
  assert.equal(stale.status, 409);
  assert.equal((await json(stale)).code, 'INCOMING_CHANGED');
  assert.equal(count(w.raw, 'SELECT COUNT(*) n FROM inventory_lots'), 0);
  const received = await post(w.app, path, body);
  assert.equal(received.status, 200, JSON.stringify(await json(received)));
  assert.equal(count(w.raw, 'SELECT SUM(total_cost_iqd) n FROM inventory_lots'), 2100101);
  assert.equal(count(w.raw, 'SELECT SUM(unit_cost_iqd*qty_remaining) n FROM inventory_lots'), 2100101);
  assert.equal(await allocateAll(w, 7), 2100101);
});


test('supplier reporting preserves the exact decimal invoice total including inbound charges', async () => {
  const w = world();
  w.raw.exec("INSERT INTO inventory_suppliers(id,name) VALUES ('fi_supplier','Supplier'),('fi_empty_supplier','Empty supplier')");
  const response = await post(w.app, '/procurement/documents', {
    operation_id: 'fi_supplier_invoice', supplier_id: 'fi_supplier', currency: 'EUR', exchange_rate: 1626.25,
    cost_profile_id: 'germany_land', cost_profile_version: 1, shipping_rate_iqd: 5950,
    status: 'ordered', cost_state: 'final', charges: [],
    lines: [{ product_id: 'fi_stock', scope: 'base', scope_id: '', qty_ordered: 7, source_unit_amount: 855, weight_g: 1000 }],
  });
  const created = await json(response);
  assert.equal(response.status, 200, JSON.stringify(created));
  const detail = await json(await get(w.app, `/procurement/documents/${created.id}`));
  assert.equal(detail.ordered_total_iqd, 9_774_756);
  let reads = 0;
  const reportDb = { prepare(sql: string) { reads++; return w.db.prepare(sql); } } as D1Database;
  const report = await operationsReport(reportDb, '2026-10-10', '2026-10-10');
  assert.equal(reads, 8, 'exact invoice totals reuse the existing schema probe');
  assert.equal(Number((report.suppliers as Array<{ id: string; ordered_total_iqd: number | null }>).find(row => row.id === 'fi_empty_supplier')!.ordered_total_iqd), 0);
  const supplier = (report.suppliers as Array<{ id: string; ordered_total_iqd: number }>).find(row => row.id === 'fi_supplier');
  assert.equal(supplier!.ordered_total_iqd, detail.ordered_total_iqd, 'the supplier report must reconcile to the purchase invoice, not rounded unit cost multiplied back');
});


test('supplier reporting falls back to unit times quantity before exact invoice totals were installed', async () => {
  const w = world('0167');
  w.raw.exec(`INSERT INTO inventory_suppliers(id,name) VALUES ('fi_old_supplier','Old supplier');
    INSERT INTO purchase_orders(id,supplier_id,currency,exchange_rate,purchase_day,status,cost_state,created_by,created_at,updated_at)
    VALUES ('fi_old_po','fi_old_supplier','IQD',1,'2026-10-10','ordered','final','owner','2026-10-10','2026-10-10');
    INSERT INTO incoming_inventory(id,product_id,scope,scope_id,qty_ordered,purchase_unit_iqd,shipping_total_iqd,internal_delivery_total_iqd,status)
    VALUES ('fi_old_report_incoming','fi_stock','base','',7,300000,101,0,'incoming');
    INSERT INTO purchase_lines(id,purchase_id,incoming_id,label,source_unit_amount,charges_iqd)
    VALUES ('fi_old_po_line','fi_old_po','fi_old_report_incoming','Stock',300000,101)`);
  let reads = 0;
  const reportDb = { prepare(sql: string) { reads++; return w.db.prepare(sql); } } as D1Database;
  const report = await operationsReport(reportDb, '2026-10-10', '2026-10-10');
  assert.equal(reads, 8);
  const supplier = (report.suppliers as Array<{ id: string; ordered_total_iqd: number }>).find(row => row.id === 'fi_old_supplier');
  assert.equal(supplier!.ordered_total_iqd, 2100101, 'the existing raw cost and charges still appear once');
});
