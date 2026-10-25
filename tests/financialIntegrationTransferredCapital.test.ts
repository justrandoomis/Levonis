import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { all, asD1, count, dbThrough, freshDb, get, json, post, row, stubApp } from './fixtures/app';
import { adminProcurementRoutes } from '../worker/routes/adminProcurement';
import { adminInvestmentFinanceRoutes } from '../worker/routes/adminInvestmentFinance';
import { adminStockOperationsRoutes } from '../worker/routes/adminStockOperations';
import { investmentContractSummary, investorOrderSplit, syncInvestorOrder } from '../worker/lib/investorFinance';
import { getOrderProfitBase } from '../worker/lib/orderProfit';
import { planLotRestore } from '../worker/lib/inventoryLots';
import { baghdadDay, journalPlan } from '../worker/lib/operations';

function setup(raw: DatabaseSync = freshDb()) {
  raw.exec(`INSERT INTO users(id,email,name,role,admin_scope) VALUES
    ('owner','boss@x.co','Owner','admin','full'),('investor','investor@x.co','Investor','admin','assistant'),('buyer','buyer@x.co','Buyer','customer',NULL);
    INSERT INTO products(id,name,slug,price_iqd,product_cost_iqd,stock,inventory_mode) VALUES ('part','Part','transferred-capital',20000,10000,0,'BASE');
    INSERT INTO stock_locations(id,name,kind) VALUES ('shelf-a','Shelf A','shelf'),('shelf-b','Shelf B','shelf');`);
  const db = asD1(raw);
  const app = stubApp(db, { id: 'owner', email: 'boss@x.co', role: 'admin', admin_scope: 'full' }, a => {
    a.route('/p', adminProcurementRoutes);
    a.route('/i', adminInvestmentFinanceRoutes);
    a.route('/s', adminStockOperationsRoutes);
  });
  return { raw, db, app };
}

async function fundedReceipt() {
  const x = setup();
  assert.equal((await post(x.app, '/i/profiles', { user_id: 'investor', default_profit_share_bps: 3500, default_loss_share_bps: 0 })).status, 200);
  const response = await post(x.app, '/p/documents', {
    operation_id: crypto.randomUUID(), currency: 'IQD', status: 'ordered', cost_state: 'final',
    lines: [{ product_id: 'part', scope: 'base', scope_id: '', qty_ordered: 5, source_unit_amount: 10000 }], charges: [],
    funding: { mode: 'investor', user_id: 'investor', agreed_iqd: 33333, received_iqd: 33333, reference: 'cash', profit_share_bps: 3500, loss_share_bps: 0 },
  });
  const created = await json(response);
  assert.equal(response.status, 200, JSON.stringify(created));
  const doc = await json(await get(x.app, `/p/documents/${created.id}`));
  const received = await post(x.app, `/p/documents/${created.id}/receive`, {
    operation_id: crypto.randomUUID(), lines: [{ line_id: doc.lines[0].line_id, qty: 5 }],
  });
  assert.equal(received.status, 200, JSON.stringify(await json(received)));
  const contract = row<{ id: string }>(x.raw, 'SELECT id FROM investment_contracts')!.id;
  const lots = all<{ id: string; qty_remaining: number; unit_principal_iqd: number; incoming_id: string }>(x.raw,
    'SELECT l.id,l.qty_remaining,c.unit_principal_iqd,l.incoming_id FROM inventory_lots l JOIN purchase_investor_lot_capital c ON c.lot_id=l.id ORDER BY c.unit_principal_iqd DESC');
  assert.deepEqual(lots.map(l => [l.qty_remaining, l.unit_principal_iqd]), [[3, 6667], [2, 6666]]);
  return { ...x, contract, lots };
}

async function transfer(x: ReturnType<typeof setup>, lot: string, qty: number, location = 'shelf-a', id = crypto.randomUUID()) {
  const body = { operation_id: id, lot_id: lot, qty, location_id: location };
  const response = await post(x.app, '/s/transfers', body);
  assert.equal(response.status, 200, JSON.stringify(await json(response)));
  return { body, target: row<{ target_lot_id: string }>(x.raw, 'SELECT target_lot_id FROM stock_transfers WHERE id=?', id)!.target_lot_id };
}

async function sale(x: ReturnType<typeof setup>, lot: string, qty = 1) {
  const day = baghdadDay();
  const revenue = 20000 * qty, cogs = 10000 * qty;
  x.raw.prepare(`INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_iqd,created_at,delivered_at)
    VALUES ('sale','buyer','delivered','{}','standard','{}','cash',?,1500,?,?,0,?,?)`).run(revenue, revenue, revenue, `${day}T09:00:00Z`, `${day}T09:00:00Z`);
  x.raw.prepare(`INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis)
    VALUES ('sale-line','sale','part','Part',?,20000,?,10000,'snapshot')`).run(qty, revenue);
  x.raw.prepare(`INSERT INTO order_item_inventory_allocations(id,order_id,order_item_id,lot_id,scope,qty,unit_cost_iqd,cogs_iqd,idempotency_key)
    VALUES ('allocation','sale','sale-line',?,'base',?,10000,?,'sale-consume')`).run(lot, qty, cogs);
  x.raw.prepare('UPDATE inventory_lots SET qty_remaining=qty_remaining-? WHERE id=?').run(qty, lot);
  x.raw.prepare("UPDATE products SET stock=stock-? WHERE id='part'").run(qty);
  x.raw.prepare(`INSERT INTO finance_collections(id,order_id,payer,amount_iqd,collection_day,actor_id,created_at)
    VALUES ('collected','sale','customer',?,?,'owner',?)`).run(revenue, day, `${day}T09:00:00Z`);
  await x.db.batch([
    ...journalPlan(x.db, { key: 'sale:sale', day, title: 'Sale', source: 'order', sourceId: 'sale', actor: 'owner' }, [{ account: '1100', debit: revenue }, { account: '4000', credit: revenue }]).statements,
    ...journalPlan(x.db, { key: 'cogs:sale', day, title: 'COGS', source: 'order', sourceId: 'sale', actor: 'owner' }, [{ account: '5000', debit: cogs }, { account: '1200', credit: cogs }]).statements,
  ]);
}

test('partial, repeated, whole and nested transfers preserve every dinar of receipt principal', async () => {
  const x = await fundedReceipt();
  const original = all(x.raw, 'SELECT * FROM purchase_investor_lot_capital ORDER BY lot_id,contract_id');
  const first = await transfer(x, x.lots[0].id, 2);
  assert.equal((await investmentContractSummary(x.db, x.contract)).summary.inventory_capital_iqd, 33333);
  const profile=(await json(await get(x.app,'/i/profiles'))).profiles[0];
  assert.equal(profile.capital.used_iqd,33333,'a transfer does not receive the principal again');
  assert.equal(profile.capital.inventory_iqd,33333);
  assert.deepEqual(row(x.raw, 'SELECT unit_principal_iqd,qty FROM purchase_investor_lot_capital WHERE lot_id=?', first.target), { unit_principal_iqd: 6667, qty: 2 });
  assert.equal((await post(x.app, '/s/transfers', first.body)).status, 200);
  const nested = await transfer(x, first.target, 1, 'shelf-b');
  assert.notEqual(nested.target, first.target);
  const whole = await transfer(x, x.lots[1].id, 2);
  assert.equal(whole.target, x.lots[1].id, 'a whole-lot transfer changes its location without creating capital');
  assert.equal(count(x.raw, 'SELECT COUNT(*) n FROM purchase_investor_lot_capital'), 4);
  assert.equal((await investmentContractSummary(x.db, x.contract)).summary.inventory_capital_iqd, 33333);
  assert.equal(count(x.raw, 'SELECT SUM(l.qty_remaining*c.unit_principal_iqd) n FROM inventory_lots l JOIN purchase_investor_lot_capital c ON c.lot_id=l.id'), 33333);
  for (const before of original) assert.deepEqual(row(x.raw, 'SELECT * FROM purchase_investor_lot_capital WHERE lot_id=? AND contract_id=?', before.lot_id, before.contract_id), before);
  assert.throws(() => x.raw.prepare('UPDATE purchase_investor_lot_capital SET unit_principal_iqd=1 WHERE lot_id=?').run(nested.target), /immutable/);
});

test('a nested transferred sale earns investor profit and preserves principal through later landed-cost correction', async () => {
  const x = await fundedReceipt();
  const first = await transfer(x, x.lots[0].id, 2), nested = await transfer(x, first.target, 1, 'shelf-b');
  await sale(x, nested.target);
  const split = await investorOrderSplit(x.db, 'sale');
  assert.equal(split.pending, false);
  assert.deepEqual(split.allocations.map(a => [a.capital_iqd, a.profit_iqd]), [[6667, 3500]]);
  await syncInvestorOrder(x.db, 'sale');
  const before = (await investmentContractSummary(x.db, x.contract)).summary;
  assert.equal(before.inventory_capital_iqd, 26666);
  assert.equal(before.available_capital_iqd, 6667);
  assert.equal(before.available_profit_iqd, 3500);
  const correction = await post(x.app, '/i/lot-cost-adjustments', {
    operation_id: crypto.randomUUID(), incoming_id: x.lots[0].incoming_id, new_unit_cost_iqd: 12000, adjustment_day: baghdadDay(),
  });
  const corrected = await json(correction);
  assert.equal(correction.status, 200, JSON.stringify(corrected));
  assert.deepEqual(corrected.pending_orders, []);
  assert.equal((await getOrderProfitBase(x.db, 'sale')).totals.cogs_iqd, 12000);
  assert.equal(count(x.raw, 'SELECT COUNT(*) n FROM inventory_lot_cost_versions WHERE unit_cost_iqd=12000'), 4);
  const after = (await investmentContractSummary(x.db, x.contract)).summary;
  assert.ok(after.inventory_capital_iqd !== null);
  assert.equal(after.inventory_capital_iqd + after.available_capital_iqd, 33333);
  assert.equal(after.available_profit_iqd, 2800);
  const events = count(x.raw, 'SELECT COUNT(*) n FROM investor_finance_events');
  await syncInvestorOrder(x.db, 'sale');
  assert.equal(count(x.raw, 'SELECT COUNT(*) n FROM investor_finance_events'), events);
  assert.equal(count(x.raw, 'SELECT SUM(debit_iqd-credit_iqd) n FROM accounting_lines'), 0);
});

test('a split remains available before exact funded-lot capital was installed', async () => {
  const x = setup(dbThrough('0169'));
  x.raw.exec(`INSERT INTO inventory_lots(id,product_id,scope,qty_received,qty_remaining,unit_cost_iqd,total_cost_iqd,cost_basis,received_at)
    VALUES ('old-lot','part','base',3,3,10000,30000,'opening','2026-09-01'); UPDATE products SET stock=3 WHERE id='part';`);
  const moved = await transfer(x, 'old-lot', 1);
  assert.notEqual(moved.target, 'old-lot');
  assert.equal(count(x.raw, 'SELECT SUM(qty_remaining) n FROM inventory_lots'), 3);
  assert.equal(count(x.raw, "SELECT COUNT(*) n FROM sqlite_master WHERE name='purchase_investor_lot_capital'"), 0);
});

test('an old funded split without principal evidence reports unknown only while units remain, and never guesses sale capital', async () => {
  const x = await fundedReceipt(), source = x.lots[0];
  // Reproduce the old writer without deleting or changing immutable evidence.
  x.raw.prepare(`INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,total_cost_iqd,cost_basis,received_at,incoming_id,split_from_lot_id)
    SELECT 'historical-child',product_id,scope,scope_id,2,2,unit_cost_iqd,2*unit_cost_iqd,cost_basis,received_at,incoming_id,id FROM inventory_lots WHERE id=?`).run(source.id);
  x.raw.prepare('UPDATE inventory_lots SET qty_remaining=qty_remaining-2 WHERE id=?').run(source.id);
  x.raw.prepare(`INSERT INTO stock_transfers(id,source_lot_id,target_lot_id,to_location_id,qty,actor_id,created_at)
    VALUES ('historical-transfer',?,'historical-child','shelf-a',2,'owner','2026-10-01')`).run(source.id);
  const evidence = all(x.raw, 'SELECT * FROM purchase_investor_lot_capital ORDER BY lot_id');
  const events = count(x.raw, 'SELECT COUNT(*) n FROM investor_finance_events');
  assert.equal((await investmentContractSummary(x.db, x.contract)).summary.inventory_capital_iqd, null,
    'a partial sum of known lots is not the total remaining principal');
  assert.deepEqual(all(x.raw, 'SELECT * FROM purchase_investor_lot_capital ORDER BY lot_id'), evidence);
  assert.equal(count(x.raw, 'SELECT COUNT(*) n FROM investor_finance_events'), events, 'reading uncertainty creates no financial event');
  await sale(x, 'historical-child', 2);
  const split = await investorOrderSplit(x.db, 'sale');
  assert.equal(split.pending, true);
  assert.deepEqual(split.allocations, [], 'the purchase ratio or current cost must not invent exact principal');
  assert.equal((await investmentContractSummary(x.db, x.contract)).summary.inventory_capital_iqd, 19999,
    'an exhausted lot does not make the principal of the remaining evidenced units unknown');
  const restored = await planLotRestore(x.db, 'sale', { lineIds: ['sale-line'], qtyByLine: { 'sale-line': 1 }, operation: 'return:historical-capital' });
  await x.db.batch(restored.statements);
  assert.equal(count(x.raw, "SELECT qty_remaining n FROM inventory_lots WHERE id='historical-child'"), 1);
  assert.equal((await investmentContractSummary(x.db, x.contract)).summary.inventory_capital_iqd, null,
    'restoring an unevidenced unit makes remaining capital unknown again');
});
