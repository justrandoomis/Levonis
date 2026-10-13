/**
 * REVIEW (provenance, 2c48bf1b): two confirmations of the SAME tracked product
 * racing each other. Before unit provenance, the slower confirmation's FIFO
 * plan stayed valid as long as its lot still held enough units, so both
 * deductions committed. With provenance, `planUnitOriginConsumption` pins the
 * exact origin ids read at plan time and fences on them; the competing order
 * takes the same first origin, the fence fails and the WHOLE deduction batch
 * (stock counters, lot consumption, COGS allocation) rolls back.
 *
 * Callers do not retry: `worker/routes/admin.ts` (confirm transition) catches
 * the throw and only writes a stock note after the status flip already
 * committed, and `worker/lib/orderStageOps.ts` lets it escape after the flip;
 * both skip deduction on the next call because the order is already in a
 * deducted state (`wasDeducted`). The order stays confirmed with its units
 * reserved, never deducted, and no COGS.
 *
 * This test expects the pre-provenance behaviour (both commit, because the lot
 * has 10 units) and FAILS on 10c6541a.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1 } from './fixtures/app';
import { planInventory, type StockMove } from '../worker/lib/inventory';
import { deductOrderStock, planOrderDeduction } from '../worker/lib/orderInventory';
import { normalizeUnitOrigins, planCreateUnitOrigins, planReceiveUnitOrigins } from '../worker/lib/inventoryUnitOrigins';

function setup(tracked: boolean) {
  const raw: DatabaseSync = freshDb();
  const db = asD1(raw);
  raw.exec(`INSERT INTO users(id,name,email,password_hash,role) VALUES ('buyer','Buyer','buyer@x.t','h','customer'),('admin','Admin','admin@x.t','h','admin');
    INSERT INTO products(id,name,slug,price_iqd,inventory_mode,stock) VALUES ('prd','Printer','printer',2000,'BASE',10);
    INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd)
      VALUES ('ORD-A','buyer','pending','{}','std','{}','cod',2000,1400,2000,2000),('ORD-B','buyer','pending','{}','std','{}','cod',2000,1400,2000,2000);
    INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd)
      VALUES ('oi-a','ORD-A','prd','Printer',1,2000,2000),('oi-b','ORD-B','prd','Printer',1,2000,2000);
    INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,cost_basis,received_at)
      VALUES ('lot1','prd','base','',10,10,1000,'received','2026-10-01T09:00:00.000Z');`);
  return { raw, db, tracked };
}

async function receiveTracked(ctx: ReturnType<typeof setup>) {
  if (!ctx.tracked) return;
  const units = normalizeUnitOrigins(Array.from({ length: 10 }, (_, i) => ({ unit_index: i + 1, supplier_order_no: `SUP-${i + 1}`, tracking_no: '' })), 10);
  await ctx.db.batch(planCreateUnitOrigins(ctx.db, { incomingId: 'inc1', purchaseLineId: 'pl1', purchaseId: 'po1', units, actorId: 'admin' }));
  await ctx.db.batch(await planReceiveUnitOrigins(ctx.db, { incomingId: 'inc1', lotId: 'lot1', qty: 10 }));
}

const move = (line: string): StockMove => ({
  product_id: 'prd', qty: 1, line_id: line,
  targets: [{ scope: 'base', scope_id: '', stock: 0, reserved: 0, low_stock_threshold: null, label: 'base' }],
});

async function checkout(db: D1Database, orderId: string, line: string) {
  const plan = await planInventory(db, [move(line)], { kind: 'reserve', operationId: orderId, orderId, actorUserId: null, reason: 'checkout' });
  if (plan.statements.length) await db.batch(plan.statements);
}

async function raceTwoConfirmations(tracked: boolean) {
  const ctx = setup(tracked);
  try {
    await receiveTracked(ctx);
    await checkout(ctx.db, 'ORD-A', 'oi-a');
    await checkout(ctx.db, 'ORD-B', 'oi-b');
    // B's confirmation plans first (reads the FIFO queue and its origins) ...
    const planB = await planOrderDeduction(ctx.db, 'ORD-B', 'admin');
    assert.ok(planB);
    // ... A's confirmation commits in between ...
    await deductOrderStock(ctx.db, 'ORD-A', 'admin');
    // ... then B commits. The lot still holds 9 units.
    let error: unknown = null;
    try { await ctx.db.batch(planB!.statements); } catch (e) { error = e; }
    const stock = { ...(ctx.raw.prepare('SELECT stock, stock_reserved FROM products WHERE id=?').get('prd') as { stock: number; stock_reserved: number }) };
    const lot = ctx.raw.prepare('SELECT qty_remaining FROM inventory_lots WHERE id=?').get('lot1') as { qty_remaining: number };
    const allocB = ctx.raw.prepare("SELECT COUNT(*) AS n FROM order_item_inventory_allocations WHERE order_id='ORD-B'").get() as { n: number };
    return { error, stock, lot: lot.qty_remaining, allocB: allocB.n };
  } finally {
    ctx.raw.close();
  }
}

test('control: untracked lot — racing confirmations both deduct (pre-provenance behaviour)', async () => {
  const r = await raceTwoConfirmations(false);
  assert.equal(r.error, null);
  assert.deepEqual(r.stock, { stock: 8, stock_reserved: 0 });
  assert.equal(r.lot, 8);
  assert.equal(r.allocB, 1);
});

test('tracked lot — the slower confirmation must still deduct while the lot holds stock', async () => {
  const r = await raceTwoConfirmations(true);
  // FAILS on 10c6541a: the origin fence aborts B's batch even though 9 units remain.
  assert.equal(r.error, null, `B's deduction batch was rolled back: ${String(r.error)}`);
  assert.deepEqual(r.stock, { stock: 8, stock_reserved: 0 }, 'B must leave reserve and decrement stock');
  assert.equal(r.lot, 8, 'B must consume its FIFO unit');
  assert.equal(r.allocB, 1, 'B must record its COGS allocation');
});

/**
 * End to end through PATCH /api/admin/orders/:id. A's confirmation commits while
 * B's confirmation is between planning and committing its deduction. The admin
 * sees a 200; B is confirmed with its unit still only RESERVED, and moving it
 * on to processing never deducts it (`wasDeducted`).
 */
import { stubApp, patch, json, pending } from './fixtures/app';
import { adminRoutes } from '../worker/routes/admin';

test('route: a racing confirmation leaves the order confirmed with its stock never deducted', async () => {
  const ctx = setup(true);
  try {
    await receiveTracked(ctx);
    await checkout(ctx.db, 'ORD-A', 'oi-a');
    await checkout(ctx.db, 'ORD-B', 'oi-b');
    const inner = ctx.db as unknown as { prepare(sql: string): unknown; batch(s: unknown[]): Promise<unknown> };
    let planned = false, injected = false;
    // The interleaving a second admin (or the stage sweep) produces: A's
    // deduction commits after B planned its origins and before B commits.
    const racing = new Proxy(inner, {
      get(target, key) {
        if (key === 'prepare') return (sql: string) => {
          if (sql.includes('INSERT INTO order_item_inventory_unit_assignments')) planned = true;
          return target.prepare(sql);
        };
        if (key === 'batch') return async (stmts: unknown[]) => {
          if (planned && !injected) { injected = true; await deductOrderStock(ctx.db, 'ORD-A', 'admin'); }
          return target.batch(stmts);
        };
        const v = Reflect.get(target, key);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const admin = stubApp(racing, { id: 'admin', role: 'admin', email: 'boss@x.co' }, (a) => a.route('/api/admin', adminRoutes), { env: { INITIAL_ADMIN_EMAIL: 'boss@x.co' } });
    const res = await patch(admin, '/api/admin/orders/ORD-B', { status: 'confirmed' });
    const body = await json(res);
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.ok(injected, 'the interleaving happened');
    const again = await patch(admin, '/api/admin/orders/ORD-B', { status: 'processing' });
    assert.equal(again.status, 200, JSON.stringify(await json(again)));
    await Promise.allSettled(pending);
    const stock = { ...(ctx.raw.prepare('SELECT stock, stock_reserved FROM products WHERE id=?').get('prd') as object) };
    const deductB = (ctx.raw.prepare("SELECT COUNT(*) AS n FROM inventory_ledger WHERE order_id='ORD-B' AND kind='deduct'").get() as { n: number }).n;
    const allocB = (ctx.raw.prepare("SELECT COUNT(*) AS n FROM order_item_inventory_allocations WHERE order_id='ORD-B'").get() as { n: number }).n;
    // Correct behaviour: B is deducted (two units sold out of ten). FAILS on
    // 10c6541a: stock 9, reserved 1, no deduct row, no COGS allocation for B.
    assert.deepEqual({ stock, deductB, allocB, note: body.stockNote ?? body.stock_note ?? null },
      { stock: { stock: 8, stock_reserved: 0 }, deductB: 1, allocB: 1, note: null });
  } finally {
    ctx.raw.close();
  }
});
