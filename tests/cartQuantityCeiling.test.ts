/**
 * THE SERVER ENFORCES THE QUANTITY RULE — the client is never trusted for it.
 *
 * «إذا كان المخزون ألف قطعة وكتب المستخدم ألف وواحد يرفض ويرجعه إلى ألف …
 *  أما في البيع المسبق فيكون متاحا.» The page sets the figure to the most there
 * is; these tests prove that a figure typed past the page (a stale tab, a
 * hand-written request) meets the SAME ceiling at every door, with a stable
 * code and the number to set — never a 500 from the storage CHECK, never a
 * VALIDATION error for a real quantity, and never a merged line above what the
 * selection sells.
 *
 * Run: node --import tsx --test tests/cartQuantityCeiling.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, post, patch, json, row } from './fixtures/app';
import { cartRoutes } from '../worker/routes/cart';
import { productRoutes } from '../worker/routes/products';
import { LINE_QTY_MAX } from '../packages/pricing/src/quantity';

function seed(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('u1','Sara','s@x.co','h','customer'),
      ('ali','Ali','ali@x.co','h','merchant');
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images) VALUES
      ('p_medal','medal','Medal','ميدالية',2000,'active',40,'[]','[]','direct_sale','["direct_sale"]','[]','[]'),
      ('p_bulk','bulk','Bulk PLA','بي إل إيه',2000,'active',20000,'[]','[]','direct_sale','["direct_sale"]','[]','[]'),
      ('p_pre','pre','Imported printer','طابعة',500000,'active',0,'[]','[]','pre_order','["pre_order"]',
        '[{"method":"air","commission_iqd":25000,"active":true}]','[]');
    INSERT INTO community_merchants (id,user_id,name,status) VALUES ('m_ali','ali','Ali 3D','active');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,status,delivery_settings) VALUES
      ('s_ali','m_ali','ali','ali3d','Ali 3D','active','{}');
    INSERT INTO community_products (id,merchant_id,store_id,slug,name,status,lifecycle,price_iqd,stock,track_stock,options,colors) VALUES
      ('cp_ltd','m_ali','s_ali','ali-ltd','Ali limited','active','active',14000,5,1,'[]','[]'),
      ('cp_big','m_ali','s_ali','ali-big','Ali big','active','active',14000,50000,1,'[]','[]');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at)
      VALUES ('mem_ali','ali','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z');
  `);
}

function setup() {
  const raw = freshDb();
  seed(raw);
  const app = stubApp(asD1(raw), { id: 'u1', role: 'customer', email: 's@x.co' }, (a) => {
    a.route('/api/cart', cartRoutes);
    a.route('/api/products', productRoutes);
  });
  return { raw, app };
}

const lineQty = (raw: DatabaseSync, productId: string) =>
  row<{ qty: number }>(raw, 'SELECT qty FROM cart_items WHERE user_id = ? AND product_id = ?', 'u1', productId)?.qty ?? null;

// ─────────────────────────────────────────── direct sale: the shelf decides

test('direct sale: more than the shelf is refused with the number to set, not written', async () => {
  const { raw, app } = setup();
  const res = await post(app, '/api/cart/items', { productId: 'p_medal', qty: 1001, fulfillmentType: 'direct_sale' });
  assert.equal(res.status, 400);
  const body = await json(res);
  assert.equal(body.code, 'QTY_UNAVAILABLE');
  assert.equal(body.details.available, 40, 'the shelf, as data the page sets the field to');
  assert.equal(body.details.preorder, false);
  assert.equal(lineQty(raw, 'p_medal'), null, 'nothing was added');
});

test('direct sale: exactly the shelf is taken', async () => {
  const { raw, app } = setup();
  const res = await post(app, '/api/cart/items', { productId: 'p_medal', qty: 40, fulfillmentType: 'direct_sale' });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  assert.equal(lineQty(raw, 'p_medal'), 40);
});

test('a big shelf still stops at the per-line ceiling — as QTY_UNAVAILABLE naming it, never a 500 or VALIDATION', async () => {
  const { raw, app } = setup();
  const res = await post(app, '/api/cart/items', { productId: 'p_bulk', qty: LINE_QTY_MAX + 1, fulfillmentType: 'direct_sale' });
  assert.equal(res.status, 400);
  const body = await json(res);
  assert.equal(body.code, 'QTY_UNAVAILABLE');
  assert.equal(body.details.available, 20000);
  assert.equal(lineQty(raw, 'p_bulk'), null);
  // …and the quote the page reads says the same thing without refusing.
  const q = await json(await post(app, '/api/products/bulk/quote', { qty: LINE_QTY_MAX + 1, fulfillmentType: 'direct_sale' }));
  assert.equal(q.availability.qty_ok, false);
  assert.equal(q.availability.stock.max_qty, LINE_QTY_MAX);
});

test('the owner case: 1000 pieces on a shelf of 20000 are taken as typed', async () => {
  const { raw, app } = setup();
  const res = await post(app, '/api/cart/items', { productId: 'p_bulk', qty: 1000, fulfillmentType: 'direct_sale' });
  assert.equal(res.status, 200, JSON.stringify(await json(res.clone())));
  assert.equal(lineQty(raw, 'p_bulk'), 1000);
});

test('a figure no quantity field can hold is a plain input refusal, not a quantity answer', async () => {
  const { app } = setup();
  const res = await post(app, '/api/cart/items', { productId: 'p_medal', qty: 10_000_000 });
  assert.equal(res.status, 400);
  const body = await json(res);
  assert.notEqual(body.code, 'QTY_UNAVAILABLE');
  assert.match(String(body.error), /qty must be between 1 and 999999/);
});

test('a second add of the same line is held to the shelf, not only to the storage limit', async () => {
  const { raw, app } = setup();
  assert.equal((await post(app, '/api/cart/items', { productId: 'p_medal', qty: 30, fulfillmentType: 'direct_sale' })).status, 200);
  assert.equal((await post(app, '/api/cart/items', { productId: 'p_medal', qty: 30, fulfillmentType: 'direct_sale' })).status, 200);
  assert.equal(lineQty(raw, 'p_medal'), 40, '30 + 30 on a shelf of 40 becomes 40 — the most there is');
});

test('editing a cart line above the shelf is refused with the shelf, and the line keeps its quantity', async () => {
  const { raw, app } = setup();
  await post(app, '/api/cart/items', { productId: 'p_medal', qty: 2, fulfillmentType: 'direct_sale' });
  const id = row<{ id: string }>(raw, "SELECT id FROM cart_items WHERE product_id = 'p_medal'")!.id;
  const res = await patch(app, `/api/cart/items/${id}`, { qty: 1001 });
  assert.equal(res.status, 400);
  const body = await json(res);
  assert.equal(body.code, 'QTY_UNAVAILABLE');
  assert.equal(body.details.available, 40);
  assert.equal(lineQty(raw, 'p_medal'), 2);
  // The figure the page clamps to is accepted.
  assert.equal((await patch(app, `/api/cart/items/${id}`, { qty: 40 })).status, 200);
  assert.equal(lineQty(raw, 'p_medal'), 40);
});

// ─────────────────────────────────────────── pre-order: open, up to the line

test('pre-order is open: an empty shelf does not limit it, only the per-line ceiling does', async () => {
  const { raw, app } = setup();
  const ok = await post(app, '/api/cart/items', {
    productId: 'p_pre', qty: LINE_QTY_MAX, fulfillmentType: 'pre_order', transportMethod: 'air',
  });
  assert.equal(ok.status, 200, JSON.stringify(await ok.clone().json()));
  assert.equal(lineQty(raw, 'p_pre'), LINE_QTY_MAX);

  const { app: app2 } = setup();
  const over = await post(app2, '/api/cart/items', {
    productId: 'p_pre', qty: LINE_QTY_MAX + 1, fulfillmentType: 'pre_order', transportMethod: 'air',
  });
  assert.equal(over.status, 400);
  const body = await json(over);
  assert.equal(body.code, 'QTY_UNAVAILABLE');
  assert.equal(body.details.max_qty, LINE_QTY_MAX, 'no quota: the ceiling is named, not a shelf');
  assert.equal(body.details.preorder, true);
});

// ─────────────────────────────────────────── a store's cart: the same rule

test('store cart: over the stock is OUT_OF_STOCK with the remainder; over the ceiling is QTY_UNAVAILABLE', async () => {
  const { raw, app } = setup();
  const short = await post(app, '/api/cart/merchant-items', { productId: 'cp_ltd', qty: 1001 });
  assert.equal(short.status, 400);
  const s = await json(short);
  assert.equal(s.code, 'OUT_OF_STOCK');
  assert.equal(s.details.available, 5);

  const big = await post(app, '/api/cart/merchant-items', { productId: 'cp_big', qty: LINE_QTY_MAX + 1 });
  assert.equal(big.status, 400, 'not a CHECK failure (500)');
  const b = await json(big);
  assert.equal(b.code, 'QTY_UNAVAILABLE');
  assert.equal(b.details.max_qty, LINE_QTY_MAX);

  assert.equal((await post(app, '/api/cart/merchant-items', { productId: 'cp_big', qty: 20 })).status, 201);
  const id = row<{ id: string }>(raw, "SELECT id FROM cart_items WHERE community_product_id = 'cp_big'")!.id;
  const edit = await patch(app, `/api/cart/merchant-items/${id}`, { qty: LINE_QTY_MAX + 1 });
  assert.equal(edit.status, 400);
  assert.equal((await json(edit)).code, 'QTY_UNAVAILABLE');
  assert.equal(row<{ qty: number }>(raw, 'SELECT qty FROM cart_items WHERE id = ?', id)!.qty, 20);
});
