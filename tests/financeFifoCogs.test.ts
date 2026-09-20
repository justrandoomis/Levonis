/**
 * THE OWNER'S NUMBER, ALL THE WAY TO THE PROFIT SCREEN.
 *
 * The FIFO core proves a sale of 12 against layers of 10×450,000 and
 * 10×560,000 costs exactly 5,620,000. This suite proves the FINANCE REPORT
 * says so too — because a COGS that is exact in `inventory_lots` and averaged
 * on the dashboard is a COGS the owner cannot act on.
 *
 * WHAT IS BEING DEFENDED
 *
 *  - FIFO beats the snapshot, because it measures the same thing better: the
 *    snapshot is what the resolver BELIEVED a unit cost, the allocations are
 *    which layers the sale ATE.
 *  - The total is carried whole. There is no unit cost that yields 5,620,000
 *    over twelve units, so any design that divides is already wrong.
 *  - A line FIFO cannot answer for falls back to the snapshot ladder, silently
 *    and completely — every order placed before 0098 depends on it.
 *  - A bundle PARENT is never costed from lots. Its goods are its components.
 *  - The report says which basis it used rather than leaving the reader to
 *    assume the more flattering one.
 *
 * Run: npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, get, json } from './fixtures/app';
import { adminFinanceReportRoutes, resetFinanceSchemaMemo } from '../worker/routes/adminFinanceReport';

const DELIVERED = '2026-03-05T10:00:00.000Z'; // 13:00 Baghdad, 5 March
const DAY = '2026-03-05';

function seed(): DatabaseSync {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('boss','Owner','boss@x.co','h','admin'),
      ('buyer','Sara','sara@x.co','h','customer');
    INSERT INTO products (id,slug,name,name_ar,price_iqd,product_cost_iqd) VALUES
      ('p1','printer-x','Printer X','طابعة إكس',900000,505000),
      ('p2','filament-y','Filament Y','فيلامنت واي',10000,4000);
  `);
  return raw;
}

function order(raw: DatabaseSync, id: string, subtotal: number, deliveredAt = DELIVERED) {
  raw.prepare(
    `INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,
        payment_method_id,subtotal_iqd,shipping_iqd,points_discount_iqd,cod_tax_iqd,exchange_rate,
        total_iqd,due_on_delivery_iqd,delivered_at,seller_type,created_at)
     VALUES (?,'buyer','delivered','{}','standard','{}','cash',?,0,0,0,1400,?,0,?,'levonis','2026-03-01T09:00:00.000Z')`
  ).run(id, subtotal, subtotal, deliveredAt);
}

function item(
  raw: DatabaseSync,
  id: string,
  orderId: string,
  productId: string | null,
  qty: number,
  line: number,
  cost: number | null,
  basis: string,
  extra: { parent?: string; alloc?: number } = {}
) {
  raw.prepare(
    `INSERT INTO order_items (id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,
        cost_iqd,cost_basis,membership_discount_iqd,coupon_discount_iqd,bundle_parent_item_id,component_alloc_iqd)
     VALUES (?,?,?,'x',?,?,?,?,?,0,0,?,?)`
  ).run(id, orderId, productId, qty, Math.trunc(line / qty), line, cost, basis, extra.parent ?? null, extra.alloc ?? null);
}

/** One lot, and the allocation saying this line ate `qty` of it. */
function ate(
  raw: DatabaseSync,
  opts: { lot: string; product: string; unitCost: number | null; received: string; orderId: string; lineId: string; qty: number }
) {
  raw.prepare(
    `INSERT OR IGNORE INTO inventory_lots
       (id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,cost_basis,received_at)
     VALUES (?,?,'base','',?,0,?, 'received', ?)`
  ).run(opts.lot, opts.product, opts.qty, opts.unitCost, opts.received);
  raw.prepare(
    `INSERT INTO order_item_inventory_allocations
       (id,order_id,order_item_id,lot_id,scope,scope_id,qty,unit_cost_iqd,cogs_iqd,idempotency_key)
     VALUES (?,?,?,?,'base','',?,?,?,?)`
  ).run(
    `a_${opts.lineId}_${opts.lot}`,
    opts.orderId,
    opts.lineId,
    opts.lot,
    opts.qty,
    opts.unitCost,
    opts.unitCost === null ? null : opts.unitCost * opts.qty,
    `alloc:${opts.orderId}:${opts.lineId}:${opts.lot}`
  );
}

const appFor = (raw: DatabaseSync) => {
  resetFinanceSchemaMemo();
  return stubApp(asD1(raw), { id: 'boss', email: 'boss@x.co', role: 'admin' }, (a) =>
    a.route('/api/admin/finance/report', adminFinanceReportRoutes)
  );
};

const report = async (raw: DatabaseSync) =>
  json(await get(appFor(raw), `/api/admin/finance/report/summary?from=${DAY}&to=${DAY}&granularity=range`));

const byProduct = async (raw: DatabaseSync) =>
  json(await get(appFor(raw), `/api/admin/finance/report/products?from=${DAY}&to=${DAY}`));

// ===========================================================================

test('§81: twelve units across two cost layers reach the report as 5,620,000', async () => {
  const raw = seed();
  order(raw, 'o1', 10_800_000);
  // The snapshot says 505,000 a unit — the average of the two layers, which is
  // what the resolver could see at the till. FIFO knows better.
  item(raw, 'i1', 'o1', 'p1', 12, 10_800_000, 505_000, 'snapshot');
  ate(raw, { lot: 'lot_a', product: 'p1', unitCost: 450_000, received: '2026-01-01T00:00:00.000Z', orderId: 'o1', lineId: 'i1', qty: 10 });
  ate(raw, { lot: 'lot_b', product: 'p1', unitCost: 560_000, received: '2026-02-01T00:00:00.000Z', orderId: 'o1', lineId: 'i1', qty: 2 });

  const body = await report(raw);
  const t = body.totals;

  assert.equal(t.cogs_iqd, 5_620_000, 'the owner\'s exact number');
  assert.notEqual(t.cogs_iqd, 12 * 505_000, 'it used the snapshot average');
  assert.notEqual(t.cogs_iqd, 12 * 560_000, 'it priced everything at the newest layer');
  assert.equal(t.gross_profit_iqd, 10_800_000 - 5_620_000);

  // And it says WHICH basis, rather than leaving the reader to assume.
  assert.equal(body.meta.fifo_available, true);
  assert.equal(t.fifo_lines, 1);
  assert.equal(t.fifo_cogs_iqd, 5_620_000);
  assert.equal(t.estimated_lines, 0);
  assert.equal(t.uncosted_lines, 0);
});

test('no unit cost could produce that total — which is why it is never divided', async () => {
  // 5,620,000 / 12 = 468,333.33…  Twelve of any whole dinar figure is
  // 5,619,996 or 5,620,008, and neither is the number. A design that stores a
  // unit cost and multiplies cannot be right here, however it rounds.
  assert.notEqual(Math.floor(5_620_000 / 12) * 12, 5_620_000);
  assert.notEqual(Math.ceil(5_620_000 / 12) * 12, 5_620_000);
  assert.notEqual(Math.round(5_620_000 / 12) * 12, 5_620_000);
});

test('a line with no allocations still reads its snapshot, exactly as before', async () => {
  const raw = seed();
  order(raw, 'o1', 900_000);
  item(raw, 'i1', 'o1', 'p1', 1, 900_000, 300_000, 'snapshot');

  const t = (await report(raw)).totals;
  assert.equal(t.cogs_iqd, 300_000);
  assert.equal(t.fifo_lines, 0);
  assert.equal(t.fifo_cogs_iqd, 0);
  assert.equal(t.uncosted_lines, 0);
});

test('FIFO costs a line the resolver could not — and that is not the forbidden estimate', async () => {
  /**
   * `unpriced` means the sale-time resolver walked every rung and found no
   * cost. 0095 forbids filling that in from today's catalogue, and rightly:
   * the owner typed that number after the sale.
   *
   * A LOT IS A DIFFERENT KIND OF FACT. It records what was paid, before the
   * sale, for the very units that shipped. So FIFO may answer here where the
   * catalogue may not.
   */
  const raw = seed();
  order(raw, 'o1', 900_000);
  item(raw, 'i1', 'o1', 'p1', 2, 900_000, null, 'unpriced');
  ate(raw, { lot: 'lot_a', product: 'p1', unitCost: 400_000, received: '2026-01-01T00:00:00.000Z', orderId: 'o1', lineId: 'i1', qty: 2 });

  const t = (await report(raw)).totals;
  assert.equal(t.cogs_iqd, 800_000);
  assert.equal(t.uncosted_lines, 0, 'the line is costed now, and it is a measurement');
  assert.equal(t.uncosted_revenue_iqd, 0);
  assert.equal(t.costed_revenue_iqd, 900_000);
  assert.equal(t.fifo_lines, 1);
});

test('an allocation against a lot of unknown cost does NOT silently price it at zero', async () => {
  // A lot backfilled from a product that never carried a cost. FIFO has
  // nothing to say, so it says nothing and the snapshot ladder answers.
  const raw = seed();
  order(raw, 'o1', 900_000);
  item(raw, 'i1', 'o1', 'p1', 2, 900_000, 300_000, 'snapshot');
  ate(raw, { lot: 'lot_a', product: 'p1', unitCost: null, received: '2026-01-01T00:00:00.000Z', orderId: 'o1', lineId: 'i1', qty: 2 });

  const t = (await report(raw)).totals;
  assert.equal(t.cogs_iqd, 600_000, 'the snapshot answered');
  assert.notEqual(t.cogs_iqd, 0, 'a NULL lot cost was read as free');
  assert.equal(t.fifo_lines, 0);
});

test('a PARTIAL allocation is not a cost — half an answer is worse than the snapshot', async () => {
  // Two units sold, one allocated. FIFO's 450,000 would understate the line by
  // half, and it is not FIFO's job to guess the other unit.
  const raw = seed();
  order(raw, 'o1', 900_000);
  item(raw, 'i1', 'o1', 'p1', 2, 900_000, 300_000, 'snapshot');
  ate(raw, { lot: 'lot_a', product: 'p1', unitCost: 450_000, received: '2026-01-01T00:00:00.000Z', orderId: 'o1', lineId: 'i1', qty: 1 });

  const t = (await report(raw)).totals;
  assert.equal(t.cogs_iqd, 600_000);
  assert.equal(t.fifo_lines, 0);
});

test('a bundle PARENT is never costed from lots: its goods are its components', async () => {
  const raw = seed();
  order(raw, 'o1', 200_000);
  item(raw, 'i_parent', 'o1', 'p2', 1, 200_000, null, 'composed');
  item(raw, 'i_kid', 'o1', 'p1', 1, 0, 300_000, 'snapshot', { parent: 'i_parent', alloc: 200_000 });
  // An allocation wrongly attached to the parent must change nothing: counting
  // it would charge the same goods twice.
  ate(raw, { lot: 'lot_a', product: 'p2', unitCost: 999_000, received: '2026-01-01T00:00:00.000Z', orderId: 'o1', lineId: 'i_parent', qty: 1 });

  const t = (await report(raw)).totals;
  assert.equal(t.cogs_iqd, 300_000, 'the parent contributed a cost');
  assert.equal(t.units, 1, 'the parent was counted as a unit as well as its component');
});

test('a released allocation is not subtracted from the sale — the refund does that', async () => {
  /**
   * A return writes a SEPARATE row carrying `released_at`; the consumption row
   * it reverses is never touched. If the sale's COGS quietly dropped the
   * released units as well, the return would be subtracted twice — once by
   * shrinking the sale, once by the refund that is already subtracted from it.
   */
  const raw = seed();
  order(raw, 'o1', 900_000);
  item(raw, 'i1', 'o1', 'p1', 2, 900_000, 300_000, 'snapshot');
  ate(raw, { lot: 'lot_a', product: 'p1', unitCost: 450_000, received: '2026-01-01T00:00:00.000Z', orderId: 'o1', lineId: 'i1', qty: 2 });
  raw.prepare(
    `INSERT INTO order_item_inventory_allocations
       (id,order_id,order_item_id,lot_id,scope,scope_id,qty,unit_cost_iqd,cogs_iqd,idempotency_key,released_at)
     VALUES ('a_rel','o1','i1','lot_a','base','',2,450000,900000,'return:o1:x:2','2026-03-06T00:00:00.000Z')`
  ).run();

  const t = (await report(raw)).totals;
  assert.equal(t.cogs_iqd, 900_000, 'the sale ate two units and it still did');
  assert.equal(t.fifo_cogs_iqd, 900_000);
});

test('a FULL refund reverses the exact FIFO total, to the dinar', async () => {
  const raw = seed();
  order(raw, 'o1', 10_800_000);
  item(raw, 'i1', 'o1', 'p1', 12, 10_800_000, 505_000, 'snapshot');
  ate(raw, { lot: 'lot_a', product: 'p1', unitCost: 450_000, received: '2026-01-01T00:00:00.000Z', orderId: 'o1', lineId: 'i1', qty: 10 });
  ate(raw, { lot: 'lot_b', product: 'p1', unitCost: 560_000, received: '2026-02-01T00:00:00.000Z', orderId: 'o1', lineId: 'i1', qty: 2 });
  raw.prepare(
    `INSERT INTO return_cases (id,order_id,order_item_id,user_id,qty,reason,state,resolution,decided_at)
     VALUES ('rc1','o1','i1','buyer',12,'shipping_damage','resolved','refund',?)`
  ).run(DELIVERED);

  const t = (await report(raw)).totals;
  assert.equal(t.refunded_cogs_iqd, 5_620_000, 'the reversal must match what the sale actually ate');
  assert.equal(t.cogs_iqd, 0, 'sale minus its own full reversal');
  assert.equal(t.revenue_iqd, 0);
});

test('a PARTIAL refund apportions, the same way the revenue beside it does', async () => {
  // Three of twelve units came back and NOBODY knows which three — a return
  // case names a quantity. So the cost is a stated share, not a pretend-precise
  // walk down the FIFO queue.
  const raw = seed();
  order(raw, 'o1', 10_800_000);
  item(raw, 'i1', 'o1', 'p1', 12, 10_800_000, 505_000, 'snapshot');
  ate(raw, { lot: 'lot_a', product: 'p1', unitCost: 450_000, received: '2026-01-01T00:00:00.000Z', orderId: 'o1', lineId: 'i1', qty: 10 });
  ate(raw, { lot: 'lot_b', product: 'p1', unitCost: 560_000, received: '2026-02-01T00:00:00.000Z', orderId: 'o1', lineId: 'i1', qty: 2 });
  raw.prepare(
    `INSERT INTO return_cases (id,order_id,order_item_id,user_id,qty,reason,state,resolution,decided_at)
     VALUES ('rc1','o1','i1','buyer',3,'shipping_damage','resolved','refund',?)`
  ).run(DELIVERED);

  const t = (await report(raw)).totals;
  // 5,620,000 × 3 / 12 = 1,405,000 exactly.
  assert.equal(t.refunded_cogs_iqd, 1_405_000);
  assert.equal(t.cogs_iqd, 5_620_000 - 1_405_000);
  // The line is still a sale line, so it is not counted as returned wholesale.
  assert.equal(t.refunded_units, 3);
});

test('the per-product breakdown uses the same basis as the day total', async () => {
  const raw = seed();
  order(raw, 'o1', 10_800_000);
  item(raw, 'i1', 'o1', 'p1', 12, 10_800_000, 505_000, 'snapshot');
  ate(raw, { lot: 'lot_a', product: 'p1', unitCost: 450_000, received: '2026-01-01T00:00:00.000Z', orderId: 'o1', lineId: 'i1', qty: 10 });
  ate(raw, { lot: 'lot_b', product: 'p1', unitCost: 560_000, received: '2026-02-01T00:00:00.000Z', orderId: 'o1', lineId: 'i1', qty: 2 });

  const products = await byProduct(raw);
  const rows = products.products as Array<{ id: string; totals: Record<string, number> }>;
  const p1 = rows.find((x) => x.id === 'p1');
  assert.ok(p1, 'the product breakdown returned nothing to compare');
  assert.equal(p1.totals.cogs_iqd, 5_620_000, 'the product column and the period total disagree');
  assert.equal((await report(raw)).totals.cogs_iqd, 5_620_000);
});
