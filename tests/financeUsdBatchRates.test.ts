/**
 * «الأرباح والتكاليف» IN DOLLARS: A LINE'S COST OF GOODS AT ITS BATCHES' OWN
 * PURCHASE-TIME RATE (FX programme plan §9 §17, §19; push FX-6; design P-A §8).
 *
 * The USD view converted every figure of an order at the shop's USD/IQD when
 * the order was placed. From 0182 a batch records the USD/IQD it was bought
 * at, so a line whose every FIFO allocation came from such a batch shows its
 * cost of goods at THOSE rates — what the stock actually cost in dollars —
 * while revenue stays at the order's rate and every derived figure is
 * recomputed from the cents (revenue − cost = profit, to the cent). Anything
 * else — an old batch with no recorded rate, a cost corrected by hand, a
 * database without 0182 — converts exactly as before (the historyRate
 * fallback). The dinars are untouched: the IQD answer is byte-identical.
 *
 * Run: node --import tsx --test tests/financeUsdBatchRates.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, dbThrough, freshDb, get, json, stubApp } from './fixtures/app';
import { adminFinanceWorkspaceRoutes } from '../worker/routes/adminFinanceWorkspace';
import { batchCogsCents, iqdToCents } from '../worker/lib/financeUsdDisplay';
import { loadLotUsdRates } from '../worker/lib/batchSnapshot';

const OWNER = { id: 'boss', email: 'boss@x.co', role: 'admin' as const, admin_scope: 'full' };
const PERIOD = 'from=2026-03-01&to=2026-03-31';

function world(raw: DatabaseSync = freshDb(), snapshots = true) {
  raw.exec(`INSERT INTO users(id,email,name,role,admin_scope) VALUES ('boss','boss@x.co','Owner','admin','full'),('buyer','buyer@x.co','Buyer','customer',NULL);
    INSERT INTO products(id,name,slug,price_iqd,product_cost_iqd,stock,inventory_mode) VALUES ('p','Printer','usd-batch-printer',320000,1,0,'BASE'),('q','Filament','usd-batch-filament',33000,1,0,'BASE');
    INSERT OR REPLACE INTO admin_settings(key,value) VALUES ('exchangeRate','1400');
    UPDATE fx_rate_pairs SET effective_rate='1650', effective_version=1, drift_anchor_rate='1650', effective_source='provider' WHERE pair='USD_IQD';
    INSERT INTO fx_rate_log(id,pair,event,trigger_kind,effective_before,effective_after,result,created_at) VALUES
      ('l1','USD_IQD','review_approved','owner',NULL,'1600','APPLIED','2026-02-01T00:00:00.000Z');`);
  const lot = (id: string, product: string, unit: number, rate: string | null) =>
    raw.exec(snapshots && rate
      ? `INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,purchase_unit_iqd,shipping_share_iqd,internal_share_iqd,total_cost_iqd,cost_basis,received_at,
           snapshot_version,snapshot_source,usd_iqd_rate_at_purchase,fx_snapshot_source,historical_usd_equivalent,calculated_at)
         VALUES ('${id}','${product}','base','',5,4,${unit},${unit},0,0,${unit * 5},'received','2026-01-15T00:00:00.000Z',1,'legacy_incoming','${rate}','document','1','2026-01-15T00:00:00.000Z')`
      : `INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,purchase_unit_iqd,shipping_share_iqd,internal_share_iqd,total_cost_iqd,cost_basis,received_at)
         VALUES ('${id}','${product}','base','',5,4,${unit},${unit},0,0,${unit * 5},'received','2026-01-15T00:00:00.000Z')`);
  lot('lotUsd', 'p', 150000, '1500'); // bought at 1,500
  lot('lotOld', 'q', 16500, null); // an old batch: no recorded rate
  const order = (id: string, lines: Array<{ item: string; product: string; goods: number; lot: string; cost: number }>) => {
    const goods = lines.reduce((s, l) => s + l.goods, 0);
    raw.prepare(`INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_iqd,created_at,delivered_at)
      VALUES (?,'buyer','delivered','{}','standard','{}','cash',?,1400,?,?,0,'2026-02-28T10:00:00.000Z','2026-03-05T10:00:00.000Z')`).run(id, goods, goods, goods);
    for (const l of lines) {
      raw.prepare(`INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis) VALUES (?,?,?,?,1,?,?,?,'snapshot')`).run(l.item, id, l.product, l.product, l.goods, l.goods, l.cost);
      raw.prepare(`INSERT INTO order_item_inventory_allocations(id,order_id,order_item_id,lot_id,scope,scope_id,qty,unit_cost_iqd,cogs_iqd,idempotency_key) VALUES (?,?,?,?,'base','',1,?,?,?)`)
        .run(`a_${l.item}`, id, l.item, l.lot, l.cost, l.cost, `k_${l.item}`);
    }
  };
  order('o1', [
    { item: 'o1:1', product: 'p', goods: 320000, lot: 'lotUsd', cost: 150000 },
    { item: 'o1:2', product: 'q', goods: 33000, lot: 'lotOld', cost: 16500 },
  ]);
  const app = stubApp(asD1(raw), OWNER, (a) => a.route('/f', adminFinanceWorkspaceRoutes));
  return { raw, app };
}

const read = async (app: ReturnType<typeof world>['app'], path: string) => {
  const res = await get(app, path);
  const body = await json(res);
  assert.equal(res.status, 200, `${path}: ${JSON.stringify(body)}`);
  return body;
};

test('a line from a batch that recorded its rate costs at THAT rate; a line from an old batch at the order\'s; revenue at the order\'s; the sums hold to the cent', async () => {
  const { app } = world();
  const one = await read(app, '/f/orders/o1?display=USD');
  const u = one.display_usd;
  assert.equal(u.fx_rate_snapshot, '1600', 'the order\'s own rate (created 28 Feb)');
  assert.equal(u.batch_cost_lines, 1);
  const printer = u.lines['o1:1'], filament = u.lines['o1:2'];
  assert.equal(printer.cogs_cents, 10000, '150,000 bought at 1,500 → $100.00 (not $93.75 at 1,600)');
  assert.equal(printer.net_goods_cents, 20000, 'revenue at the order\'s rate: 320,000 / 1,600');
  assert.equal(printer.gross_profit_cents, printer.retained_revenue_cents - printer.cogs_cents);
  assert.equal(filament.cogs_cents, iqdToCents(16500, '1600'), 'an old batch: the order\'s rate, as before');
  assert.equal(u.cents.cogs_cents, printer.cogs_cents + filament.cogs_cents, 'the order\'s goods cost is its lines\'');
  assert.equal(u.cents.gross_profit_cents, u.cents.retained_revenue_cents - u.cents.cogs_cents);
  // The dinars are untouched.
  const iqd = await read(app, '/f/orders/o1');
  const { display_usd: _, ...rest } = one;
  assert.deepEqual(rest, iqd);
  assert.equal(iqd.totals.cogs_iqd, 166500);
});

test('the list and the summary count the lines costed at their batches\' rates and carry the same cents', async () => {
  const { app } = world();
  const list = await read(app, `/f/orders?${PERIOD}&display=USD`);
  assert.equal(list.display_usd.batch_cost_lines, 1);
  const summary = await read(app, `/f/summary?${PERIOD}&display=USD`);
  assert.equal(summary.display_usd.batch_cost_lines, 1);
  assert.equal(summary.display_usd.orders.o1.cents.cogs_cents, 10000 + iqdToCents(16500, '1600')!);
  assert.equal(summary.display_usd.totals.cogs_cents, 10000 + iqdToCents(16500, '1600')!);
});

test('without 0182 nothing is recorded, and every line converts at the order\'s rate exactly as before', async () => {
  const { app } = world(dbThrough('0181'), false);
  const u = (await read(app, '/f/orders/o1?display=USD')).display_usd;
  assert.equal(u.batch_cost_lines, 0);
  assert.equal(u.lines['o1:1'].cogs_cents, iqdToCents(150000, '1600'));
  assert.equal(u.cents.cogs_cents, iqdToCents(166500, '1600'));
});

test('batchCogsCents: every allocation needs its batch\'s rate and the allocations must add up to the line\'s cost', async () => {
  const rates = new Map([['a', '1500'], ['b', '1250']]);
  const alloc = (lot_id: string, cogs: number | null, returned: number | null = 0, late = 0, returned_qty = 0) => ({ lot_id, cogs_iqd: cogs, returned_cogs_iqd: returned, late_cost_iqd: late, returned_qty });
  assert.equal(batchCogsCents({ cogs_iqd: 275000, allocations: [alloc('a', 150000), alloc('b', 125000)] }, rates), 20000);
  assert.equal(batchCogsCents({ cogs_iqd: 150000, allocations: [alloc('a', 150000), alloc('c', 0)] }, rates), null, 'a batch with no recorded rate');
  assert.equal(batchCogsCents({ cogs_iqd: 140000, allocations: [alloc('a', 150000)] }, rates), null, 'a hand-corrected cost no longer adds up');
  assert.equal(batchCogsCents({ cogs_iqd: 0, allocations: [alloc('a', 150000, 150000, 0, 1)] }, rates), 0, 'a returned unit');
  assert.equal(batchCogsCents({ cogs_iqd: 0, allocations: [alloc('a', 150000, null, 0, 1)] }, rates), null, 'an unknown return');
  assert.equal(batchCogsCents({ cogs_iqd: 151500, allocations: [alloc('a', 150000, 0, 1500)] }, rates), 10100, 'a later reconciliation of the batch at its own rate');
  assert.equal(batchCogsCents({ cogs_iqd: null, allocations: [alloc('a', 150000)] }, rates), null);
  assert.equal(batchCogsCents({ cogs_iqd: 0, allocations: [] }, rates), null);
  // The reader answers only what a batch recorded, and nothing without 0182.
  const { raw } = world();
  assert.deepEqual([...(await loadLotUsdRates(asD1(raw), ['lotUsd', 'lotOld', 'nope']))], [['lotUsd', '1500']]);
  assert.equal((await loadLotUsdRates(asD1(dbThrough('0181')), ['lotUsd'])).size, 0);
});
