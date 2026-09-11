/**
 * Inventory semantics — mandate §7, acceptance rows:
 *   "عند inventory mode=COLOR، نفاد اللون يمنع الشراء حتى لو كان base stock
 *    أكبر من صفر"
 *   "لا يحدث خصم مخزون مزدوج عند retry أو webhook مكرر"
 *
 * The mutation tests run against a real SQLite database built from the REAL
 * migration files (0018 + 0020), through the shared node:sqlite → D1 adapter,
 * so the UNIQUE idempotency index, the CHECK constraints and the guards in the
 * WHERE clauses all execute rather than being asserted about.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, SqliteD1, newSqlite } from './fixtures/d1';
import {
  applyInventory,
  comboKey,
  isLowStock,
  resolveStock,
  type InventorySnapshot,
  type StockMove,
} from '../worker/lib/inventory';

// --------------------------------------------------------- pure resolution

const snap = (over: Partial<InventorySnapshot> = {}): InventorySnapshot => ({
  inventory_mode: 'BASE',
  base: { stock: 10, reserved: 0, low_stock_threshold: null },
  option_values: [],
  colors: [],
  variants: [],
  group_ids: [],
  ...over,
});

test('BASE mode uses the product row and nothing else', () => {
  const r = resolveStock(snap(), { option_value_ids: [], color_id: null });
  assert.equal(r.available, 10);
  assert.equal(r.targets.length, 1);
  assert.equal(r.targets[0].scope, 'base');
});

test('BASE mode with NULL stock is untracked, not zero', () => {
  const r = resolveStock(snap({ base: { stock: null, reserved: 0, low_stock_threshold: null } }), {
    option_value_ids: [],
    color_id: null,
  });
  assert.equal(r.tracked, false);
  assert.equal(r.available, null);
});

test('reserved units are not available', () => {
  const r = resolveStock(snap({ base: { stock: 10, reserved: 4, low_stock_threshold: null } }), {
    option_value_ids: [],
    color_id: null,
  });
  assert.equal(r.available, 6);
});

test('COLOR mode: an exhausted colour blocks the sale even when base stock is high', () => {
  const s = snap({
    inventory_mode: 'COLOR',
    base: { stock: 999, reserved: 0, low_stock_threshold: null },
    colors: [
      { id: 'c_black', name_en: 'Black', stock: 0, reserved: 0, low_stock_threshold: null },
      { id: 'c_white', name_en: 'White', stock: 3, reserved: 0, low_stock_threshold: null },
    ],
  });
  const black = resolveStock(s, { option_value_ids: [], color_id: 'c_black' });
  assert.equal(black.available, 0, 'base stock must never override an exhausted colour');
  assert.equal(black.targets[0].scope, 'color');
  const white = resolveStock(s, { option_value_ids: [], color_id: 'c_white' });
  assert.equal(white.available, 3);
});

test('COLOR mode with no colour chosen is undecided, never "in stock"', () => {
  const s = snap({
    inventory_mode: 'COLOR',
    colors: [{ id: 'c1', name_en: 'Black', stock: 5, reserved: 0, low_stock_threshold: null }],
  });
  const r = resolveStock(s, { option_value_ids: [], color_id: null });
  assert.equal(r.available, null);
  assert.equal(r.error, 'SELECTION_INCOMPLETE');
});

test('OPTION mode takes the MINIMUM over tracked selected values — never the sum', () => {
  const s = snap({
    inventory_mode: 'OPTION',
    option_values: [
      { id: 'v_a1', group_id: 'g_printer', name_en: 'A1', stock: 2, reserved: 0, low_stock_threshold: null },
      { id: 'v_eu', group_id: 'g_plug', name_en: 'EU', stock: 7, reserved: 0, low_stock_threshold: null },
    ],
  });
  const r = resolveStock(s, { option_value_ids: ['v_a1', 'v_eu'], color_id: null });
  assert.equal(r.available, 2, 'min(2,7) — 9 would be double counting');
  assert.equal(r.targets.length, 2, 'both consumed rows are recorded');
});

test('OPTION mode ignores values that do not track stock', () => {
  const s = snap({
    inventory_mode: 'OPTION',
    option_values: [
      { id: 'v_a1', group_id: 'g1', name_en: 'A1', stock: 4, reserved: 0, low_stock_threshold: null },
      { id: 'v_eu', group_id: 'g2', name_en: 'EU', stock: null, reserved: 0, low_stock_threshold: null },
    ],
  });
  const r = resolveStock(s, { option_value_ids: ['v_a1', 'v_eu'], color_id: null });
  assert.equal(r.available, 4);
  assert.equal(r.targets.length, 1);
});

test('VARIANT_COMBINATION: an unmodelled combination is NOT sellable and never falls back to base', () => {
  const s = snap({
    inventory_mode: 'VARIANT_COMBINATION',
    base: { stock: 500, reserved: 0, low_stock_threshold: null },
    variants: [
      { id: 'var1', combo_key: 'o:v_a1|c:c_black', stock: 3, reserved: 0, low_stock_threshold: null, active: true },
    ],
  });
  const known = resolveStock(s, { option_value_ids: ['v_a1'], color_id: 'c_black' });
  assert.equal(known.available, 3);
  const unknown = resolveStock(s, { option_value_ids: ['v_a1'], color_id: 'c_white' });
  assert.equal(unknown.available, 0);
  assert.equal(unknown.error, 'VARIANT_NOT_MODELLED');
});

test('the combination key is order-independent so a reordered request hits the same row', () => {
  assert.equal(
    comboKey({ option_value_ids: ['b', 'a'], color_id: 'c' }),
    comboKey({ option_value_ids: ['a', 'b'], color_id: 'c' })
  );
});

test('low stock is only reported when a threshold is configured', () => {
  const withT = resolveStock(snap({ base: { stock: 2, reserved: 0, low_stock_threshold: 3 } }), {
    option_value_ids: [],
    color_id: null,
  });
  assert.equal(isLowStock(withT), true);
  const withoutT = resolveStock(snap({ base: { stock: 1, reserved: 0, low_stock_threshold: null } }), {
    option_value_ids: [],
    color_id: null,
  });
  assert.equal(isLowStock(withoutT), false);
});

// ---------------------------------------------------- real-database mutation

function freshDb(): { db: D1Database; raw: DatabaseSync } {
  const raw = newSqlite();
  for (const f of [
    '0001_init.sql',
    '0002_products_memberships.sql',
    '0003_final_phase.sql',
    '0006_devices_extra.sql',
    '0007_reviews_extra.sql',
    '0008_commerce_extra.sql',
    '0009_kyc_extra.sql',
    '0010_support_extra.sql',
    '0011_tg_auth_extra.sql',
    '0012_studio_handoff.sql',
    '0013_auth_username_phone.sql',
    '0014_points_rule.sql',
    '0015_wallet_holds.sql',
    '0016_support_code.sql',
    '0017_tg_actions.sql',
    '0018_prime_taxonomy_inventory.sql',
    '0019_price_history_prime.sql',
    '0020_inventory_adjust_direction.sql',
  ]) {
    raw.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  }
  raw
    .prepare("INSERT INTO products (id, slug, name, price_iqd, stock) VALUES (?,?,?,?,?)")
    .run('prd_1', 'p-1', 'Test Printer', 100000, 5);
  return { db: new SqliteD1(raw) as unknown as D1Database, raw };
}

const baseMove = (qty: number, lineId = 'oi_1'): StockMove => ({
  product_id: 'prd_1',
  qty,
  line_id: lineId,
  targets: [{ scope: 'base', scope_id: '', stock: 5, reserved: 0, low_stock_threshold: null, label: 'base' }],
});

const stockOf = (raw: DatabaseSync) => {
  // node:sqlite returns null-prototype rows; strict deepEqual compares
  // prototypes, so copy into a plain object.
  const r = raw.prepare('SELECT stock, stock_reserved FROM products WHERE id = ?').get('prd_1') as {
    stock: number;
    stock_reserved: number;
  };
  return { stock: r.stock, stock_reserved: r.stock_reserved };
};

test('reserve holds units without moving stock', async () => {
  const { db, raw } = freshDb();
  const r = await applyInventory(db, [baseMove(2)], { kind: 'reserve', operationId: 'ord_1' });
  assert.equal(r.applied, 1);
  assert.deepEqual(stockOf(raw), { stock: 5, stock_reserved: 2 });
});

test('a retried reserve is a NO-OP, not a second hold', async () => {
  const { db, raw } = freshDb();
  await applyInventory(db, [baseMove(2)], { kind: 'reserve', operationId: 'ord_1' });
  const again = await applyInventory(db, [baseMove(2)], { kind: 'reserve', operationId: 'ord_1' });
  assert.equal(again.applied, 0);
  assert.equal(again.skipped, 1);
  assert.deepEqual(stockOf(raw), { stock: 5, stock_reserved: 2 });
});

test('a duplicated confirmation webhook cannot deduct twice', async () => {
  const { db, raw } = freshDb();
  await applyInventory(db, [baseMove(2)], { kind: 'reserve', operationId: 'ord_1' });
  await applyInventory(db, [baseMove(2)], { kind: 'deduct', operationId: 'ord_1' });
  assert.deepEqual(stockOf(raw), { stock: 3, stock_reserved: 0 });

  const replay = await applyInventory(db, [baseMove(2)], { kind: 'deduct', operationId: 'ord_1' });
  assert.equal(replay.applied, 0);
  assert.deepEqual(stockOf(raw), { stock: 3, stock_reserved: 0 }, 'no second deduction');
});

test('two DIFFERENT orders each deduct once', async () => {
  const { db, raw } = freshDb();
  for (const order of ['ord_1', 'ord_2']) {
    await applyInventory(db, [baseMove(1)], { kind: 'reserve', operationId: order });
    await applyInventory(db, [baseMove(1)], { kind: 'deduct', operationId: order });
  }
  assert.deepEqual(stockOf(raw), { stock: 3, stock_reserved: 0 });
});

test('reserving more than is on hand changes nothing', async () => {
  const { db, raw } = freshDb();
  await applyInventory(db, [baseMove(99)], { kind: 'reserve', operationId: 'ord_big' });
  assert.deepEqual(stockOf(raw), { stock: 5, stock_reserved: 0 }, 'the guard must reject the hold');
});

test('cancelling releases the hold, and a repeated cancel does not release twice', async () => {
  const { db, raw } = freshDb();
  await applyInventory(db, [baseMove(3)], { kind: 'reserve', operationId: 'ord_1' });
  await applyInventory(db, [baseMove(3)], { kind: 'release', operationId: 'ord_1' });
  assert.deepEqual(stockOf(raw), { stock: 5, stock_reserved: 0 });
  const again = await applyInventory(db, [baseMove(3)], { kind: 'release', operationId: 'ord_1' });
  assert.equal(again.applied, 0);
  assert.deepEqual(stockOf(raw), { stock: 5, stock_reserved: 0 });
});

test('restoring after a deduction puts the units back exactly once', async () => {
  const { db, raw } = freshDb();
  await applyInventory(db, [baseMove(2)], { kind: 'reserve', operationId: 'ord_1' });
  await applyInventory(db, [baseMove(2)], { kind: 'deduct', operationId: 'ord_1' });
  await applyInventory(db, [baseMove(2)], { kind: 'restore', operationId: 'ord_1' });
  assert.deepEqual(stockOf(raw), { stock: 5, stock_reserved: 0 });
  await applyInventory(db, [baseMove(2)], { kind: 'restore', operationId: 'ord_1' });
  assert.deepEqual(stockOf(raw), { stock: 5, stock_reserved: 0 });
});

test('an admin write-off cannot eat into units reserved for a customer', async () => {
  const { db, raw } = freshDb();
  await applyInventory(db, [baseMove(4)], { kind: 'reserve', operationId: 'ord_1' });
  // 5 on hand, 4 reserved → only 1 is genuinely free.
  await applyInventory(db, [baseMove(3, 'adj_1')], {
    kind: 'adjust_out',
    operationId: 'adj_1',
    reason: 'damaged',
  });
  assert.deepEqual(stockOf(raw), { stock: 5, stock_reserved: 4 }, 'the write-off must be rejected');

  await applyInventory(db, [baseMove(1, 'adj_2')], { kind: 'adjust_out', operationId: 'adj_2' });
  assert.deepEqual(stockOf(raw), { stock: 4, stock_reserved: 4 });
});

test('every movement is recorded in the ledger with its idempotency key', async () => {
  const { db, raw } = freshDb();
  await applyInventory(db, [baseMove(2)], { kind: 'reserve', operationId: 'ord_1', orderId: 'ord_1' });
  await applyInventory(db, [baseMove(2)], { kind: 'deduct', operationId: 'ord_1', orderId: 'ord_1' });
  const rows = raw
    .prepare('SELECT kind, qty, order_id, idempotency_key FROM inventory_ledger ORDER BY id')
    .all() as Array<{ kind: string; qty: number; order_id: string; idempotency_key: string }>;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.kind).sort(), ['deduct', 'reserve']);
  assert.equal(new Set(rows.map((r) => r.idempotency_key)).size, 2);
});

test('a rejected move writes NOTHING — no counter change and no ledger row', async () => {
  const { db, raw } = freshDb();
  const r = await applyInventory(db, [baseMove(99)], { kind: 'reserve', operationId: 'ord_big' });
  assert.equal(r.applied, 0);
  assert.equal(r.rejected.length, 1);
  assert.equal(r.rejected[0].reason, 'INSUFFICIENT_STOCK');
  const ledger = raw.prepare('SELECT COUNT(*) AS n FROM inventory_ledger').get() as { n: number };
  assert.equal(ledger.n, 0, 'a rejected move must not leave a ledger row claiming it happened');
  assert.deepEqual(stockOf(raw), { stock: 5, stock_reserved: 0 });
});

test('a rejected move can be retried, corrected, under the SAME operation id', async () => {
  const { db, raw } = freshDb();
  await applyInventory(db, [baseMove(99)], { kind: 'reserve', operationId: 'ord_1' });
  const retry = await applyInventory(db, [baseMove(2)], { kind: 'reserve', operationId: 'ord_1' });
  assert.equal(retry.applied, 1, 'the earlier rejection must not have burned the idempotency key');
  assert.deepEqual(stockOf(raw), { stock: 5, stock_reserved: 2 });
});

test('an untracked row reports NOT_TRACKED instead of pretending to move stock', async () => {
  const { db, raw } = freshDb();
  raw.prepare('UPDATE products SET stock = NULL WHERE id = ?').run('prd_1');
  const r = await applyInventory(db, [baseMove(1)], { kind: 'reserve', operationId: 'ord_1' });
  assert.equal(r.applied, 0);
  assert.equal(r.rejected[0].reason, 'NOT_TRACKED');
});
