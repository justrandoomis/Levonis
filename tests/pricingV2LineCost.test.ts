/**
 * V2-6 LINE COST (spec addendum A.9, A.12.4; DECISIONS row 222).
 *
 *   - `calculateGoods`: FIFO (a linked pre-order batch included) → the
 *     line's frozen V2 estimate (never confirmed) → a pre-cut-over recorded
 *     snapshot → unknown;
 *   - Track B's SQL reads the estimate before `unpriced`, and never
 *     `products.product_cost_iqd` for a line that has one;
 *   - «اربط بالدفعة الواصلة»: the owner links a received lot to a pre-order
 *     line once its batch is in the Levo warehouse — one batch with the lot
 *     decrement, `link_kind = 'preorder_batch'`, replay-safe, owner-only, and
 *     the actual cost replaces the estimate.
 *
 * LOCAL ONLY: in-memory SQLite, no network.
 *
 * Run: node --import tsx --test tests/pricingV2LineCost.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, freshDb, json, OWNER, post, row, stubApp, type StubUser } from './fixtures/app';
import { calculateGoods, type Allocation, type GoodsLine } from '../worker/lib/orderProfit';
import { costConfidenceSql, costValueSql } from '../worker/lib/financeLedger';
import { adminPreorderOriginRoutes } from '../worker/routes/adminPreorderOrigins';

/** `row` for a row the test itself just wrote (never absent). */
const one = <T = Record<string, unknown>>(...a: Parameters<typeof row>): T => row<T>(...a)!;

const EDITOR: StubUser = { id: 'usr_editor', role: 'admin', email: 'editor@x.co' };
const ORDER = { id: 'o1', points_discount_iqd: 0, price_adjustment_iqd: 0, shipping_iqd: 0, cod_tax_iqd: 0 };

const line = (over: Partial<GoodsLine> & Record<string, unknown> = {}): GoodsLine =>
  ({ id: 'l1', product_id: 'p1', qty: 2, bundle_parent_item_id: null, component_alloc_iqd: null, line_total_iqd: 20000, coupon_discount_iqd: 0, membership_discount_iqd: 0, cost_iqd: null, cost_basis: 'unpriced', ...over }) as GoodsLine;
const alloc = (over: Partial<Allocation> = {}): Allocation =>
  ({ id: 'a1', order_id: 'o1', order_item_id: 'l1', lot_id: 'lot1', qty: 2, cogs_iqd: 9000, unit_cost_iqd: 4500, released_at: null, ...over }) as Allocation;

test('calculateGoods: FIFO → the frozen estimate → a recorded snapshot → unknown', () => {
  const of = (l: GoodsLine, a: Allocation[] = []) => calculateGoods(ORDER, [l], a).lines[0]!;
  // FIFO covers the quantity: actual, whatever the estimate says.
  assert.deepEqual([of(line({ estimated_cost_iqd: 4101 }), [alloc()]).cost_confidence, of(line({ estimated_cost_iqd: 4101 }), [alloc()]).cogs_iqd], ['fifo', 9000]);
  // No allocation: the estimate, never confirmed.
  const est = of(line({ estimated_cost_iqd: 4101 }));
  assert.equal(est.cost_confidence, 'estimated');
  assert.equal(est.cogs_iqd, 8202);
  // A partial allocation is not FIFO: the estimate stands for the whole line.
  assert.equal(of(line({ estimated_cost_iqd: 4101 }), [alloc({ qty: 1, cogs_iqd: 4500 })]).cost_confidence, 'estimated');
  // A pre-cut-over line keeps its recorded snapshot; a V2 line without a cost is unknown.
  assert.equal(of(line({ cost_iqd: 3000, cost_basis: 'snapshot' })).cost_confidence, 'recorded_snapshot');
  assert.equal(of(line()).cost_confidence, 'unknown');
  assert.equal(of(line()).cogs_iqd, null);
});

test('Track B: the estimate is read before `unpriced`, and the legacy product cost never stands in for it', () => {
  const raw = freshDb();
  raw.exec(`INSERT INTO users (id, name, email, password_hash, role) VALUES ('u1', 'Buyer', 'b@x.co', 'h', 'customer');
            INSERT INTO products (id, slug, name, price_iqd, product_cost_iqd, status) VALUES ('p1', 'p1', 'P', 20000, 3333, 'active');
            INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_type)
              VALUES ('o1','u1','confirmed','{}','standard','{}','cash',20000,0,1500,20000,0,'direct');
            INSERT INTO order_items (id,order_id,product_id,name_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis,estimated_cost_iqd)
              VALUES ('l_est','o1','p1','P','',1,20000,20000,NULL,'unpriced',4101),
                     ('l_unknown','o1','p1','P','',1,20000,20000,NULL,'unpriced',NULL);`);
  const read = (id: string) => one<{ v: number | null; c: string }>(raw, `SELECT ${costValueSql('oi', 'p', true)} AS v, ${costConfidenceSql('oi', 'p', true)} AS c FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.id = ?`, id);
  assert.deepEqual({ ...read('l_est') }, { v: 4101, c: 'estimated' });
  assert.deepEqual({ ...read('l_unknown') }, { v: null, c: 'unknown' });
  // Without the 0190 probe the SQL is the old one (a deploy ahead keeps working).
  assert.doesNotMatch(costValueSql('oi', 'p'), /estimated_cost_iqd/);
});

function preorderWorld(stage: string) {
  const raw = freshDb();
  raw.exec(`INSERT INTO users (id, name, email, password_hash, role) VALUES ('u1', 'Buyer', 'b@x.co', 'h', 'customer');
            INSERT INTO products (id, slug, name, price_iqd, status, selling_type, sale_types) VALUES ('p1', 'p1', 'P', 20000, 'active', 'pre_order', '["pre_order"]');
            INSERT INTO orders (id,user_id,status,stage,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_type)
              VALUES ('o1','u1','processing','${stage}','{}','standard','{}','cash',40000,0,1500,40000,0,'preorder_air');
            INSERT INTO order_items (id,order_id,product_id,name_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis,estimated_cost_iqd)
              VALUES ('l1','o1','p1','P','',2,20000,40000,NULL,'unpriced',4101);
            INSERT INTO inventory_lots (id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,purchase_unit_iqd,shipping_share_iqd,internal_share_iqd,total_cost_iqd,cost_basis,received_at)
              VALUES ('lot1','p1','base','',5,5,4500,4500,0,0,22500,'received','2026-10-14T09:00:00Z');`);
  const appAs = (user: StubUser) => stubApp(asD1(raw), user, (a) => a.route('/api/admin/orders', adminPreorderOriginRoutes), { publishV2: false });
  return { raw, appAs };
}

test('«اربط بالدفعة الواصلة»: one batch with the lot decrement, link_kind preorder_batch, replay-safe; the actual replaces the estimate', async () => {
  const { raw, appAs } = preorderWorld('at_levo_warehouse');
  const owner = appAs(OWNER);
  const body = { lot_ids: ['lot1'], operation_id: 'op_link_000001' };
  const first = await json(await post(owner, '/api/admin/orders/o1/items/l1/link-batch', body));
  assert.equal(first.success, true, JSON.stringify(first));
  assert.equal(first.already, false);
  assert.deepEqual(first.linked, [{ lot_id: 'lot1', qty: 2 }]);
  const a = one<Record<string, unknown>>(raw, 'SELECT * FROM order_item_inventory_allocations WHERE order_item_id = ?', 'l1');
  assert.equal(a.link_kind, 'preorder_batch');
  assert.equal(a.cogs_iqd, 9000);
  assert.equal(one<{ q: number }>(raw, 'SELECT qty_remaining AS q FROM inventory_lots WHERE id = ?', 'lot1').q, 3);
  const again = await json(await post(owner, '/api/admin/orders/o1/items/l1/link-batch', body));
  assert.equal(again.already, true);
  assert.equal(one<{ q: number }>(raw, 'SELECT qty_remaining AS q FROM inventory_lots WHERE id = ?', 'lot1').q, 3, 'a replay moves nothing');
  const goods = calculateGoods(
    one<Record<string, unknown>>(raw, 'SELECT * FROM orders WHERE id = ?', 'o1'),
    raw.prepare('SELECT * FROM order_items WHERE order_id = ?').all('o1') as unknown as GoodsLine[],
    raw.prepare('SELECT * FROM order_item_inventory_allocations WHERE order_id = ?').all('o1') as unknown as Allocation[]
  );
  assert.equal(goods.lines[0]!.cost_confidence, 'fifo');
  assert.equal(goods.lines[0]!.cogs_iqd, 9000);
});

test('the link is refused before the batch arrives, and to everyone but the owner', async () => {
  const early = preorderWorld('supplier_preparing');
  const res = await post(early.appAs(OWNER), '/api/admin/orders/o1/items/l1/link-batch', { lot_ids: ['lot1'], operation_id: 'op_link_000002' });
  assert.equal(res.status, 409);
  assert.equal((await json(res)).code, 'PREORDER_LINK_TOO_EARLY');
  const { raw, appAs } = preorderWorld('at_levo_warehouse');
  const denied = await post(appAs(EDITOR), '/api/admin/orders/o1/items/l1/link-batch', { lot_ids: ['lot1'], operation_id: 'op_link_000003' });
  assert.equal(denied.status, 403);
  assert.equal((await json(denied)).code, 'COST_ACCESS_DENIED');
  assert.equal(one<{ q: number }>(raw, 'SELECT qty_remaining AS q FROM inventory_lots WHERE id = ?', 'lot1').q, 5);
});

test('«اربط بالدفعة الواصلة» takes only the line\'s own model/colour lot, and the linked units leave the sellable stock (review 2026-10-14)', async () => {
  const raw = freshDb();
  raw.exec(`INSERT INTO users (id, name, email, password_hash, role) VALUES ('u1', 'Buyer', 'b@x.co', 'h', 'customer'), ('${OWNER.id}', 'Owner', 'boss@x.co', 'h', 'admin');
            INSERT INTO products (id, slug, name, price_iqd, status, selling_type, sale_types, inventory_mode) VALUES ('p1', 'p1', 'P', 20000, 'active', 'pre_order', '["direct_sale","pre_order"]', 'COLOR');
            INSERT INTO product_colors (id, product_id, name_en, hex, sort, active, stock) VALUES ('c_black', 'p1', 'Black', '#000000', 0, 1, 5), ('c_white', 'p1', 'White', '#ffffff', 1, 1, 4);
            INSERT INTO orders (id,user_id,status,stage,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_type)
              VALUES ('o1','u1','processing','at_levo_warehouse','{}','standard','{}','cash',40000,0,1500,40000,0,'preorder_air');
            INSERT INTO order_items (id,order_id,product_id,name_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis,estimated_cost_iqd,color_id)
              VALUES ('l1','o1','p1','P','',2,20000,40000,NULL,'unpriced',4101,'c_black');
            INSERT INTO inventory_lots (id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,purchase_unit_iqd,shipping_share_iqd,internal_share_iqd,total_cost_iqd,cost_basis,received_at)
              VALUES ('lot_white','p1','color','c_white',4,4,9900,9900,0,0,39600,'received','2026-10-14T09:00:00Z'),
                     ('lot_black','p1','color','c_black',5,5,4500,4500,0,0,22500,'received','2026-10-14T09:00:00Z');`);
  const owner = stubApp(asD1(raw), OWNER, (a) => a.route('/api/admin/orders', adminPreorderOriginRoutes), { publishV2: false });
  // The white lot is not this black line's batch: refused, nothing moves.
  const wrong = await post(owner, '/api/admin/orders/o1/items/l1/link-batch', { lot_ids: ['lot_white'], operation_id: 'op_link_white01' });
  assert.equal(wrong.status, 400);
  assert.equal((await json(wrong)).code, 'PREORDER_LINK_LOT');
  assert.equal(one<{ q: number }>(raw, 'SELECT qty_remaining AS q FROM inventory_lots WHERE id = ?', 'lot_white').q, 4);
  // The black lot: linked, and the two units leave black's sellable counter with a ledger row, in the same batch.
  const ok = await json(await post(owner, '/api/admin/orders/o1/items/l1/link-batch', { lot_ids: ['lot_black'], operation_id: 'op_link_black01' }));
  assert.equal(ok.success, true, JSON.stringify(ok));
  assert.equal(one<{ q: number }>(raw, 'SELECT qty_remaining AS q FROM inventory_lots WHERE id = ?', 'lot_black').q, 3);
  assert.equal(one<{ s: number }>(raw, "SELECT stock AS s FROM product_colors WHERE id = 'c_black'").s, 3, 'the promised units are no longer sellable as direct stock');
  assert.equal(one<{ s: number }>(raw, "SELECT stock AS s FROM product_colors WHERE id = 'c_white'").s, 4);
  const ledger = one<{ kind: string; qty: number; scope: string; scope_id: string }>(raw, "SELECT kind, qty, scope, scope_id FROM inventory_ledger WHERE order_id = 'o1'");
  assert.deepEqual({ ...ledger }, { kind: 'adjust_out', qty: 2, scope: 'color', scope_id: 'c_black' });
  // A replay moves neither the lot nor the counter.
  const again = await json(await post(owner, '/api/admin/orders/o1/items/l1/link-batch', { lot_ids: ['lot_black'], operation_id: 'op_link_black01' }));
  assert.equal(again.already, true);
  assert.equal(one<{ s: number }>(raw, "SELECT stock AS s FROM product_colors WHERE id = 'c_black'").s, 3);
});
