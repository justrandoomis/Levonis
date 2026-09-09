/**
 * Order → stock lifecycle (mandate §7: "الحجز عند إنشاء الطلب والخصم عند
 * تأكيده والإرجاع عند الإلغاء ... transactional وidempotent لمنع overselling
 * والخصم المكرر").
 *
 * Runs against a real SQLite database built from every real migration, through
 * the shared node:sqlite → D1 adapter, so the UNIQUE idempotency index and the
 * WHERE-clause guards actually execute.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, SqliteD1, newSqlite } from './fixtures/d1';
import { applyInventory, planInventory, type StockMove } from '../worker/lib/inventory';
import { deductOrderStock, hasLedgerKind, returnOrderStock } from '../worker/lib/orderInventory';

function freshDb(): { db: D1Database; raw: DatabaseSync } {
  const raw = newSqlite();
  for (const f of readdirSync(join(ROOT, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  }
  // inventory_ledger.actor_user_id is a real foreign key, so the actor has to
  // exist — exactly as it does in the routes. `order_reservation_fence.order_id`
  // (migration 0058) is one too, so the orders these moves are keyed to have to
  // exist for the same reason: the fence row rides in the same batch as the
  // movement it proves.
  raw.prepare('INSERT INTO users (id, email) VALUES (?,?)').run('admin', 'admin@example.com');
  for (const id of ['ORD-1', 'ORD-2']) {
    raw
      .prepare(
        `INSERT INTO orders (id, user_id, address_snapshot, delivery_method_id, delivery_method_snapshot,
                             payment_method_id, subtotal_iqd, exchange_rate, total_iqd, due_on_delivery_iqd)
         VALUES (?, 'admin', '{}', 'dm', '{}', 'cod', 0, 1400, 0, 0)`
      )
      .run(id);
  }
  raw
    .prepare('INSERT INTO products (id, slug, name, price_iqd, stock) VALUES (?,?,?,?,?)')
    .run('prd_1', 'p-1', 'Printer', 100000, 10);
  raw
    .prepare("INSERT INTO products (id, slug, name, price_iqd, stock, inventory_mode) VALUES (?,?,?,?,?,'COLOR')")
    .run('prd_2', 'p-2', 'Filament', 20000, 99);
  raw
    .prepare(
      `INSERT INTO product_colors (id, product_id, name_en, hex, stock, reserved)
       VALUES (?,?,?,?,?,?)`
    )
    .run('pc_black', 'prd_2', 'Black', '#000000', 2, 0);
  return { db: new SqliteD1(raw) as unknown as D1Database, raw };
}

const move = (productId: string, qty: number, lineId: string, scope: 'base' | 'color', scopeId = ''): StockMove => ({
  product_id: productId,
  qty,
  line_id: lineId,
  targets: [{ scope, scope_id: scopeId, stock: 0, reserved: 0, low_stock_threshold: null, label: scopeId || 'base' }],
});

const base = (raw: DatabaseSync, id = 'prd_1') => {
  const r = raw.prepare('SELECT stock, stock_reserved FROM products WHERE id = ?').get(id) as {
    stock: number;
    stock_reserved: number;
  };
  return { stock: r.stock, reserved: r.stock_reserved };
};

const colour = (raw: DatabaseSync, id = 'pc_black') => {
  const r = raw.prepare('SELECT stock, reserved FROM product_colors WHERE id = ?').get(id) as {
    stock: number;
    reserved: number;
  };
  return { stock: r.stock, reserved: r.reserved };
};

/** What checkout does: plan the reserve and run it in the caller's batch. */
async function checkout(db: D1Database, orderId: string, moves: StockMove[]) {
  const plan = await planInventory(db, moves, {
    kind: 'reserve',
    operationId: orderId,
    orderId,
    actorUserId: null,
    reason: 'checkout',
  });
  if (plan.statements.length) await db.batch(plan.statements);
  return plan;
}

test('checkout HOLDS units without decrementing stock', async () => {
  const { db, raw } = freshDb();
  await checkout(db, 'ORD-1', [move('prd_1', 3, 'oi_1', 'base')]);
  assert.deepEqual(base(raw), { stock: 10, reserved: 3 });
});

test('confirmation turns the hold into a real decrement, exactly once', async () => {
  const { db, raw } = freshDb();
  await checkout(db, 'ORD-1', [move('prd_1', 3, 'oi_1', 'base')]);
  const first = await deductOrderStock(db, 'ORD-1', 'admin');
  assert.equal(first.applied, 1);
  assert.deepEqual(base(raw), { stock: 7, reserved: 0 });

  // A double-clicked confirmation, or a replayed webhook.
  const second = await deductOrderStock(db, 'ORD-1', 'admin');
  assert.equal(second.applied, 0);
  assert.deepEqual(base(raw), { stock: 7, reserved: 0 }, 'no second deduction');
});

test('cancelling BEFORE confirmation releases the hold and adds nothing back', async () => {
  const { db, raw } = freshDb();
  await checkout(db, 'ORD-1', [move('prd_1', 4, 'oi_1', 'base')]);
  const res = await returnOrderStock(db, 'ORD-1', 'admin');
  assert.equal(res.kind, 'release');
  assert.deepEqual(base(raw), { stock: 10, reserved: 0 }, 'stock was never taken, so nothing is given back');
});

test('cancelling AFTER confirmation restores the units', async () => {
  const { db, raw } = freshDb();
  await checkout(db, 'ORD-1', [move('prd_1', 4, 'oi_1', 'base')]);
  await deductOrderStock(db, 'ORD-1', 'admin');
  assert.deepEqual(base(raw), { stock: 6, reserved: 0 });
  const res = await returnOrderStock(db, 'ORD-1', 'admin');
  assert.equal(res.kind, 'restore');
  assert.deepEqual(base(raw), { stock: 10, reserved: 0 });
});

test('a repeated cancellation does not return the units twice', async () => {
  const { db, raw } = freshDb();
  await checkout(db, 'ORD-1', [move('prd_1', 4, 'oi_1', 'base')]);
  await deductOrderStock(db, 'ORD-1', 'admin');
  await returnOrderStock(db, 'ORD-1', 'admin');
  await returnOrderStock(db, 'ORD-1', 'admin');
  assert.deepEqual(base(raw), { stock: 10, reserved: 0 });
});

test('two lines of the SAME product in one order each move separately', async () => {
  const { db, raw } = freshDb();
  await checkout(db, 'ORD-1', [move('prd_1', 2, 'oi_1', 'base'), move('prd_1', 3, 'oi_2', 'base')]);
  assert.deepEqual(base(raw), { stock: 10, reserved: 5 });
  await deductOrderStock(db, 'ORD-1', 'admin');
  assert.deepEqual(base(raw), { stock: 5, reserved: 0 });
});

test('two different orders hold, then deduct, independently', async () => {
  const { db, raw } = freshDb();
  await checkout(db, 'ORD-1', [move('prd_1', 4, 'oi_1', 'base')]);
  await checkout(db, 'ORD-2', [move('prd_1', 5, 'oi_1', 'base')]);
  assert.deepEqual(base(raw), { stock: 10, reserved: 9 });
  await deductOrderStock(db, 'ORD-1', 'admin');
  assert.deepEqual(base(raw), { stock: 6, reserved: 5 });
  await returnOrderStock(db, 'ORD-2', 'admin');
  assert.deepEqual(base(raw), { stock: 6, reserved: 0 });
});

test('a hold cannot exceed what is free after other holds', async () => {
  const { db, raw } = freshDb();
  await checkout(db, 'ORD-1', [move('prd_1', 8, 'oi_1', 'base')]);
  const plan = await checkout(db, 'ORD-2', [move('prd_1', 5, 'oi_1', 'base')]);
  assert.equal(plan.applied, 0);
  assert.equal(plan.rejected[0].reason, 'INSUFFICIENT_STOCK');
  assert.deepEqual(base(raw), { stock: 10, reserved: 8 }, 'the second order takes nothing');
});

test('COLOR mode holds the COLOUR row, never the base row', async () => {
  const { db, raw } = freshDb();
  await checkout(db, 'ORD-1', [move('prd_2', 2, 'oi_1', 'color', 'pc_black')]);
  assert.deepEqual(colour(raw), { stock: 2, reserved: 2 });
  assert.deepEqual(base(raw, 'prd_2'), { stock: 99, reserved: 0 }, 'base stock is untouched and irrelevant');

  // The colour is now fully held, so a second order cannot take any.
  const plan = await checkout(db, 'ORD-2', [move('prd_2', 1, 'oi_1', 'color', 'pc_black')]);
  assert.equal(plan.applied, 0, 'exhausted colour blocks the sale despite 99 in base stock');
});

test('the ledger records what happened, keyed by order', async () => {
  const { db, raw } = freshDb();
  await checkout(db, 'ORD-1', [move('prd_1', 2, 'oi_1', 'base')]);
  assert.equal(await hasLedgerKind(db, 'ORD-1', 'reserve'), true);
  assert.equal(await hasLedgerKind(db, 'ORD-1', 'deduct'), false);
  await deductOrderStock(db, 'ORD-1', 'admin');
  assert.equal(await hasLedgerKind(db, 'ORD-1', 'deduct'), true);

  const rows = raw
    .prepare('SELECT kind, qty, order_id FROM inventory_ledger WHERE order_id = ? ORDER BY kind')
    .all('ORD-1') as Array<{ kind: string; qty: number; order_id: string }>;
  assert.deepEqual(rows.map((r) => r.kind), ['deduct', 'reserve']);
});

test('an order that reserved nothing is a clean no-op at every later step', async () => {
  const { db } = freshDb();
  assert.deepEqual(await deductOrderStock(db, 'ORD-NONE', 'admin'), { applied: 0, rejected: 0 });
  assert.deepEqual(await returnOrderStock(db, 'ORD-NONE', 'admin'), { kind: 'none', applied: 0 });
});

test('an admin write-off cannot take units an order is holding', async () => {
  const { db, raw } = freshDb();
  await checkout(db, 'ORD-1', [move('prd_1', 9, 'oi_1', 'base')]);
  const bad = await applyInventory(db, [move('prd_1', 5, 'adj_1', 'base')], {
    kind: 'adjust_out',
    operationId: 'adj_1',
    reason: 'damaged',
  });
  assert.equal(bad.applied, 0);
  assert.deepEqual(base(raw), { stock: 10, reserved: 9 });

  const ok = await applyInventory(db, [move('prd_1', 1, 'adj_2', 'base')], {
    kind: 'adjust_out',
    operationId: 'adj_2',
    reason: 'damaged',
  });
  assert.equal(ok.applied, 1);
  assert.deepEqual(base(raw), { stock: 9, reserved: 9 });
});
