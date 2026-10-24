import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, asD1, row } from './fixtures/app';
import { applyInventory, type StockMove } from '../worker/lib/inventory';
import { planProductSave, saveProductAtomic } from '../worker/lib/productPersistence';
import { parseProductRow } from '../worker/lib/productModel';
import { preserveUneditedStock, type StockWriteScope } from '../worker/lib/productStockWrite';

function setup() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users(id,name,email,password_hash,role) VALUES ('stock_admin','Admin','stock@example.test','h','admin');
    INSERT INTO products(id,slug,name,price_iqd,status,inventory_mode,stock,sale_types,updated_at)
      VALUES ('ring','ring','Key rings',94,'active','OPTION',NULL,'["direct_sale"]','2026-01-01T00:00:00.000Z');
    INSERT INTO product_option_groups(id,product_id,name_en,sort,active) VALUES ('size','ring','Size',0,1);
    INSERT INTO product_option_values(id,product_id,group_id,name_en,sort,active,stock,reserved) VALUES
      ('25mm','ring','size','25 mm',0,1,1200,0), ('30mm','ring','size','30 mm',1,1,540,0);
  `);
  const db = asD1(raw);
  const body = (stock = 540) => ({
    inventory_mode: 'OPTION',
    stock_baseline: { option: [{ id: '25mm', stock: 1200 }, { id: '30mm', stock: 540 }], color: [], variant: [] },
    groups: [{ id: 'size', name_en: 'Renamed size', sort: 0, active: true, values: [
      { id: '25mm', name_en: '25 mm', sort: 0, active: true, stock: 1200 },
      { id: '30mm', name_en: '30 mm', sort: 1, active: true, stock },
    ] }], colors: [], variants: [], images: [],
  });
  const plan = (input: Record<string, unknown> = body()) => planProductSave(db, {
    mode: 'update', doc: null,
    prev: parseProductRow(row(raw, 'SELECT * FROM products WHERE id = ?', 'ring')!),
    relations: input, actor: { adminId: 'stock_admin', money: true },
  });
  const move: StockMove = {
    product_id: 'ring', line_id: 'line30', qty: 540,
    targets: [{ scope: 'option', scope_id: '30mm', stock: 540, reserved: 0, low_stock_threshold: null, label: '30 mm' }],
  };
  const stock = () => row<{ stock: number; reserved: number }>(raw, 'SELECT stock,reserved FROM product_option_values WHERE id=?', '30mm');
  const stamp = () => row<{ updated_at: string }>(raw, 'SELECT updated_at FROM products WHERE id=?', 'ring')!.updated_at;
  const sell = async () => {
    await applyInventory(db, [move], { kind: 'reserve', operationId: 'first' });
    await applyInventory(db, [move], { kind: 'deduct', operationId: 'first' });
  };
  return { raw, db, body, plan, move, stock, stamp, sell };
}

test('selling all 540 units then saving an open editor cannot resurrect the 30mm option', async () => {
  const s = setup();
  const openedAt = s.stamp();
  await s.sell();
  assert.notEqual(s.stamp(), openedAt, 'legacy editor/template stale checks must notice a sale');
  assert.deepEqual(s.stock(), { stock: 0, reserved: 0 });
  // The admin keeps a price/content edit, with the old stock still in its form.
  await saveProductAtomic(s.db, await s.plan());
  assert.deepEqual(s.stock(), { stock: 0, reserved: 0 });
  assert.equal(row(s.raw, 'SELECT name_en FROM product_option_groups WHERE id=?', 'size')!.name_en, 'Renamed size');
  assert.equal(row(s.raw, 'SELECT stock FROM product_option_values WHERE id=?', '25mm')!.stock, 1200);
  const second = await applyInventory(s.db, [s.move], { kind: 'reserve', operationId: 'second' });
  assert.equal(second.applied, 0);
  assert.equal(second.rejected[0]?.reason, 'INSUFFICIENT_STOCK');
  s.raw.close();
});

test('an edited count based on the pre-sale quantity refuses instead of overwriting the sale', async () => {
  const s = setup();
  await s.sell();
  await assert.rejects(s.plan(s.body(550)), { code: 'STOCK_CHANGED', status: 409 });
  assert.deepEqual(s.stock(), { stock: 0, reserved: 0 });
  s.raw.close();
});

test('a fresh intentional stock correction remains editable', async () => {
  const s = setup();
  await saveProductAtomic(s.db, await s.plan(s.body(520)));
  assert.deepEqual(s.stock(), { stock: 520, reserved: 0 });
  s.raw.close();
});

test('a sale between planning and committing rolls back the entire product save', async () => {
  const s = setup();
  const planned = await s.plan();
  await s.sell();
  await assert.rejects(saveProductAtomic(s.db, planned), { code: 'STOCK_CHANGED', status: 409 });
  assert.deepEqual(s.stock(), { stock: 0, reserved: 0 });
  assert.equal(row(s.raw, 'SELECT name_en FROM product_option_groups WHERE id=?', 'size')!.name_en, 'Size');
  assert.equal(row(s.raw, 'SELECT COUNT(*) n FROM ops_guards')!.n, 0);
  s.raw.close();
});

test('a reservation between planning and committing cannot be overwritten by a stock correction', async () => {
  const s = setup();
  const planned = await s.plan(s.body(0));
  await applyInventory(s.db, [s.move], { kind: 'reserve', operationId: 'first' });
  await assert.rejects(saveProductAtomic(s.db, planned), { code: 'STOCK_CHANGED', status: 409 });
  assert.deepEqual(s.stock(), { stock: 540, reserved: 540 });
  s.raw.close();
});

test('inventory revisions advance monotonically and unchanged/rejected retries do not invalidate editors', async () => {
  const s = setup();
  s.raw.prepare('UPDATE products SET updated_at=? WHERE id=?').run('2099-01-01T00:00:00.000Z', 'ring');
  const before = s.stamp();
  await applyInventory(s.db, [s.move], { kind: 'reserve', operationId: 'first' });
  const heldAt = s.stamp();
  assert.ok(heldAt > before);
  await applyInventory(s.db, [s.move], { kind: 'reserve', operationId: 'first' });
  await applyInventory(s.db, [s.move], { kind: 'reserve', operationId: 'second' });
  assert.equal(s.stamp(), heldAt);
  await applyInventory(s.db, [s.move], { kind: 'deduct', operationId: 'first' });
  assert.ok(s.stamp() > heldAt);
  s.raw.close();
});

test('untouched stock preserves zero and null at every relation scope', () => {
  for (const [scope, table] of [
    ['option', 'product_option_values'], ['color', 'product_colors'], ['variant', 'product_variants'],
  ] as const) {
    for (const current of [0, null]) {
      const group: StockWriteScope = { scope, table, existing: [{ id: 'v', stock: current }], incoming: [{ id: 'v', stock: 540 }] };
      preserveUneditedStock({ [scope]: [{ id: 'v', stock: 540 }] }, [group]);
      assert.equal(group.incoming[0].stock, current);
    }
  }
});
