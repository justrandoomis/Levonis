/**
 * AN INVESTOR'S SALE THAT LOST ITS DELIVERY (owner 2026-11-10; DECISIONS row 308).
 *
 * A funded sale cancelled or moved back after delivery kept its investor
 * profit and recovered capital for ever, held: `syncInvestorOrder` stopped at
 * any order that was not delivered. The owner chose «treat it like a return»:
 *   - the sale's profit is taken back, its capital is back in stock (or on the
 *     undelivered order), a loss share is undone — correction events and
 *     journals, posted today;
 *   - a payout already made stays paid; the investor's next profit covers it;
 *   - the recovery scan finds the sale even with no wage on it, and leaves it
 *     once settled; a re-delivery projects the sale again;
 *   - the people picture neither holds nor counts the taken-back sale.
 * Only the investor's side: the shop's own sale and cost entries are not
 * reversed here (the owner's second answer).
 *
 * Run: node --import tsx --test tests/investorLostDelivery.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, asD1, count, freshDb, json, post, row, stubApp } from './fixtures/app';
import { adminInvestmentFinanceRoutes } from '../worker/routes/adminInvestmentFinance';
import { drainOrderFinanceRecovery } from '../worker/lib/financeOrderRecovery';
import { investorOrderSplit, syncInvestorOrder } from '../worker/lib/investorFinance';
import { participantOverview } from '../worker/lib/financeParticipants';
import { personFinance } from '../worker/lib/personFinance';
import { runOrderDeliveredEffects } from '../worker/lib/orderDeliveredEffects';
import { baghdadDay, journalPlan } from '../worker/lib/operations';
import type { Env } from '../worker/lib/types';

const ADMIN = { id: 'admin', email: 'boss@x.co', role: 'admin' as const, admin_scope: 'full' };

function setup() {
  const raw = freshDb();
  raw.exec(`INSERT INTO users(id,email,role,admin_scope,name) VALUES ('admin','boss@x.co','admin','full','Owner'),('investor','investor@x.co','admin','assistant','Investor'),('buyer','buyer@x.co','customer',NULL,'Buyer');
    INSERT INTO inventory_suppliers(id,name) VALUES ('supplier','Supplier');
    INSERT INTO products(id,name,name_ar,slug,sku,price_iqd,product_cost_iqd,stock,inventory_mode) VALUES ('part','Part','قطعة','lost-inv-part','LOSTINV',500,100,3,'BASE');
    INSERT INTO incoming_inventory(id,product_id,scope,scope_id,qty_ordered,qty_received,purchase_unit_iqd,shipping_total_iqd,internal_delivery_total_iqd,supplier_id,status,created_by) VALUES ('inc-a','part','base','',3,3,100,0,0,'supplier','received','admin');
    INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,total_cost_iqd,cost_basis,received_at,incoming_id,supplier_id) VALUES ('lot-a','part','base','',3,3,100,300,'received','2026-01-01','inc-a','supplier');`);
  const db = asD1(raw), env = { DB: db } as Env;
  const app = stubApp(db, ADMIN, (a) => a.route('/i', adminInvestmentFinanceRoutes));
  async function contract(loss_share_bps = 0) {
    const body = { operation_id: crypto.randomUUID(), incoming_id: 'inc-a', user_id: 'investor', name: 'تمويل قطع', principal_iqd: 300, capital_share_bps: 10000, profit_share_bps: 3500, loss_share_bps };
    const res = await post(app, '/i/contracts', body); assert.equal(res.status, 200, JSON.stringify(await json(res.clone())));
    const funding = await post(app, `/i/contracts/${body.operation_id}/funding`, { operation_id: crypto.randomUUID(), amount_iqd: 300, payment_day: baghdadDay(), reference: 'cash receipt' });
    assert.equal(funding.status, 200, JSON.stringify(await json(funding.clone())));
    return body.operation_id;
  }
  /** One funded unit sold, collected and projected, as a delivery leaves it (delivered on 2026-10-16). */
  async function sale(id: string, unit = 500) {
    const at = '2026-10-16T10:00:00.000Z';
    raw.prepare(`INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_iqd,created_at,delivered_at)
      VALUES (?,'buyer','delivered','{}','standard','{}','cash',?,1500,?,?,0,?,?)`).run(id, unit, unit, unit, at, at);
    raw.prepare(`INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis) VALUES (?,?,'part','قطعة',1,?,?,100,'snapshot')`).run(`${id}-item`, id, unit, unit);
    raw.prepare(`INSERT INTO order_item_inventory_allocations(id,order_id,order_item_id,lot_id,scope,scope_id,qty,unit_cost_iqd,cogs_iqd,idempotency_key) VALUES (?,?,?,'lot-a','base','',1,100,100,?)`).run(`${id}-a`, id, `${id}-item`, `alloc:${id}`);
    raw.prepare("UPDATE inventory_lots SET qty_remaining=qty_remaining-1 WHERE id='lot-a'").run();
    raw.prepare("INSERT INTO finance_collections(id,order_id,payer,amount_iqd,collection_day,actor_id,created_at) VALUES (?,?,'customer',?,?,'admin',?)").run(`${id}-cash`, id, unit, '2026-10-16', at);
    await db.batch([...journalPlan(db, { key: `sale:${id}`, day: '2026-10-16', title: 'Sale', source: 'order', sourceId: id, actor: 'admin' }, [{ account: '1100', debit: unit }, { account: '4000', credit: unit }]).statements,
      ...journalPlan(db, { key: `cogs:${id}`, day: '2026-10-16', title: 'COGS', source: 'order', sourceId: id, actor: 'admin' }, [{ account: '5000', debit: 100 }, { account: '1200', credit: 100 }]).statements]);
    await syncInvestorOrder(db, id, { day: '2026-10-16' });
  }
  /** Both cancel doors: the status flips, `delivered_at` stays, the unit goes back to its lot through a release row. */
  function cancel(id: string) {
    raw.prepare("UPDATE orders SET status='cancelled' WHERE id=?").run(id);
    raw.prepare(`INSERT INTO order_item_inventory_allocations(id,order_id,order_item_id,lot_id,scope,scope_id,qty,unit_cost_iqd,cogs_iqd,released_at,idempotency_key) VALUES (?,?,?,'lot-a','base','',1,100,100,?,?)`)
      .run(`${id}-release`, id, `${id}-item`, new Date().toISOString(), `restore:${id}:${id}-a:1`);
    raw.prepare("UPDATE inventory_lots SET qty_remaining=qty_remaining+1 WHERE id='lot-a'").run();
  }
  const results = (id: string) => all<{ profit_iqd: number; capital_iqd: number; loss_iqd: number; eligible: number; pending: number }>(raw,
    'SELECT r.profit_iqd,r.capital_iqd,r.loss_iqd,r.eligible,r.pending FROM investor_allocation_results r JOIN order_item_inventory_allocations a ON a.id=r.allocation_id WHERE a.order_id=?', id).map((r) => ({ ...r }));
  const events = (id: string) => all<{ kind: string; amount_iqd: number; event_day: string }>(raw,
    'SELECT kind,amount_iqd,event_day FROM investor_finance_events WHERE order_id=? ORDER BY kind,amount_iqd', id).map((e) => ({ ...e }));
  const investor = async () => (await participantOverview(db, 'investor')).summary;
  const payable = () => count(raw, "SELECT COALESCE(SUM(credit_iqd-debit_iqd),0) n FROM accounting_lines WHERE account_code='2450'");
  const balanced = () => count(raw, 'SELECT COALESCE(SUM(debit_iqd-credit_iqd),0) n FROM accounting_lines');
  return { raw, db, env, app, contract, sale, cancel, results, events, investor, payable, balanced };
}

test('a funded sale cancelled after delivery is taken back like a return: profit out, capital back in stock, posted today', async () => {
  const s = setup();
  const c = await s.contract();
  await s.sale('ORD-GONE');
  // (500 revenue - 100 cost) × 35%, and its 100 of capital back from the sale.
  assert.deepEqual(s.results('ORD-GONE'), [{ profit_iqd: 140, capital_iqd: 100, loss_iqd: 0, eligible: 1, pending: 0 }]);
  let me = await s.investor();
  assert.deepEqual([me.investor_profit_iqd, me.investor_profit_available_iqd, me.capital_iqd], [140, 140, 100]);
  assert.equal(s.payable(), 140);

  s.cancel('ORD-GONE');
  // What the live ledger showed until now: still counted, held for ever.
  me = await s.investor();
  assert.deepEqual([me.investor_profit_iqd, me.investor_profit_available_iqd], [140, 0]);

  const report = await drainOrderFinanceRecovery(s.env);
  assert.deepEqual([report.scanned, report.completed, report.failed], [1, 1, 0], JSON.stringify(report));
  assert.deepEqual(s.results('ORD-GONE'), [{ profit_iqd: 0, capital_iqd: 0, loss_iqd: 0, eligible: 0, pending: 0 }]);
  assert.deepEqual(s.events('ORD-GONE'), [
    { kind: 'capital_correction', amount_iqd: -100, event_day: baghdadDay() },
    { kind: 'capital_recovered', amount_iqd: 100, event_day: '2026-10-16' },
    { kind: 'profit', amount_iqd: 140, event_day: '2026-10-16' },
    { kind: 'profit_correction', amount_iqd: -140, event_day: baghdadDay() },
  ]);
  // The investor's payable is gone from the books, the journal balanced.
  assert.equal(s.payable(), 0);
  assert.equal(s.balanced(), 0);
  me = await s.investor();
  assert.deepEqual([me.investor_profit_iqd, me.investor_profit_available_iqd, me.investor_profit_debt_iqd, me.capital_iqd, me.capital_available_iqd], [0, 0, 0, 0, 0]);
  const split = JSON.parse(row<{ snapshot: string }>(s.raw, "SELECT snapshot FROM investor_allocation_results WHERE allocation_id='ORD-GONE-a'")!.snapshot);
  assert.deepEqual([split.lost_delivery, split.qty, split.profit, split.delivered], [true, 0, 0, false]);

  // The people picture: nothing held for it, not a sale, the unit back in stock.
  const a = (await personFinance(s.db, 'investor', { owner: true })).investor!.agreements.find((x) => x.id === c)!;
  assert.deepEqual([a.held_sales.length, a.held_rest, a.profit.sales, a.units.sold, a.units.in_stock, a.units.in_orders], [0, null, 0, 0, 3, 0]);

  // Settled: the scan does not come back, and a recheck writes nothing more.
  const journals = all(s.raw, 'SELECT * FROM accounting_entries ORDER BY id');
  assert.equal((await drainOrderFinanceRecovery(s.env)).scanned, 0);
  await syncInvestorOrder(s.db, 'ORD-GONE');
  assert.deepEqual(all(s.raw, 'SELECT * FROM accounting_entries ORDER BY id'), journals);
  assert.equal(s.events('ORD-GONE').length, 4);
});

test('profit already paid out stays paid, as debt the next sale covers', async () => {
  const s = setup();
  const c = await s.contract();
  await s.sale('ORD-PAID-OUT');
  const now = new Date().toISOString();
  s.raw.prepare("INSERT INTO finance_withdrawals(id,user_id,amount_iqd,paid_iqd,balance_type,state,created_at,updated_at) VALUES ('w-paid','investor',140,140,'earnings','paid',?,?)").run(now, now);
  s.raw.prepare("INSERT INTO finance_withdrawal_allocations(withdrawal_id,source_kind,source_id,amount_iqd,paid_iqd) VALUES ('w-paid','investor_profit',?,140,140)").run(`invprofit:${c}`);
  const paid = all(s.raw, 'SELECT * FROM finance_withdrawal_allocations ORDER BY withdrawal_id');
  s.cancel('ORD-PAID-OUT');
  assert.equal((await drainOrderFinanceRecovery(s.env)).completed, 1);
  let me = await s.investor();
  assert.deepEqual([me.investor_profit_iqd, me.investor_profit_debt_iqd, me.investor_profit_available_iqd], [0, 140, 0]);
  assert.deepEqual(all(s.raw, 'SELECT * FROM finance_withdrawal_allocations ORDER BY withdrawal_id'), paid, 'the payout is untouched');
  // The next sale's profit pays the debt back before anything is available again.
  await s.sale('ORD-NEXT');
  me = await s.investor();
  assert.deepEqual([me.investor_profit_iqd, me.investor_profit_debt_iqd, me.investor_profit_available_iqd], [140, 0, 0]);
});

test('a loss share the cancelled sale carried is undone', async () => {
  const s = setup();
  await s.contract(10000);
  // Sold for 60 against a cost of 100: a loss of 40 the loss-sharing capital bears.
  await s.sale('ORD-AT-LOSS', 60);
  assert.equal(s.results('ORD-AT-LOSS')[0].loss_iqd, 40);
  assert.equal(count(s.raw, 'SELECT COALESCE(SUM(amount_iqd),0) n FROM investor_capital_losses'), 40);
  s.cancel('ORD-AT-LOSS');
  assert.equal((await drainOrderFinanceRecovery(s.env)).completed, 1);
  assert.deepEqual(s.results('ORD-AT-LOSS'), [{ profit_iqd: 0, capital_iqd: 0, loss_iqd: 0, eligible: 0, pending: 0 }]);
  assert.equal(count(s.raw, 'SELECT COALESCE(SUM(amount_iqd),0) n FROM investor_capital_losses'), 0);
  assert.deepEqual(s.events('ORD-AT-LOSS').filter((e) => e.kind.startsWith('loss')).map((e) => [e.kind, e.amount_iqd]), [['loss', 40], ['loss_correction', -40]]);
  assert.equal(s.balanced(), 0);
});

test('walked back and delivered again: the same sale is projected again, today, and shows on its order meanwhile', async () => {
  const s = setup();
  const c = await s.contract();
  await s.sale('ORD-BACK');
  // «تم التسليم» corrected to «تم الشحن»: no stock moves, the unit is still on the order.
  s.raw.prepare("UPDATE orders SET status='shipped' WHERE id='ORD-BACK'").run();
  assert.equal((await drainOrderFinanceRecovery(s.env)).completed, 1);
  assert.deepEqual(s.results('ORD-BACK'), [{ profit_iqd: 0, capital_iqd: 0, loss_iqd: 0, eligible: 0, pending: 0 }]);
  let a = (await personFinance(s.db, 'investor', { owner: true })).investor!.agreements.find((x) => x.id === c)!;
  assert.deepEqual([a.units.sold, a.units.in_stock, a.units.in_orders, a.profit.sales], [0, 2, 1, 0]);

  s.raw.prepare("UPDATE orders SET status='delivered' WHERE id='ORD-BACK'").run();
  await runOrderDeliveredEffects(s.env, 'ORD-BACK');
  assert.deepEqual(s.results('ORD-BACK'), [{ profit_iqd: 140, capital_iqd: 100, loss_iqd: 0, eligible: 1, pending: 0 }]);
  const me = await s.investor();
  assert.deepEqual([me.investor_profit_iqd, me.investor_profit_available_iqd, me.capital_iqd], [140, 140, 100]);
  // Taken back today, recognized again today: the delivery's month keeps its first entry.
  assert.deepEqual(s.events('ORD-BACK').filter((e) => e.event_day === baghdadDay()).map((e) => [e.kind, e.amount_iqd]).sort(),
    [['capital_correction', -100], ['capital_correction', 100], ['profit_correction', -140], ['profit_correction', 140]]);
  a = (await personFinance(s.db, 'investor', { owner: true })).investor!.agreements.find((x) => x.id === c)!;
  assert.deepEqual([a.units.sold, a.units.in_orders, a.profit.sales], [1, 0, 1]);
  assert.equal(s.payable(), 140);
  assert.equal(s.balanced(), 0);
  assert.equal((await investorOrderSplit(s.db, 'ORD-BACK')).investor_profit_iqd, 140);
});

test('a cancelled order the investor never had a projection for is not a candidate', async () => {
  const s = setup();
  await s.contract();
  await s.sale('ORD-PROJECTED');
  // (The helper projects investors only; the scan writes this delivered sale's first staff checkpoint.)
  assert.equal((await drainOrderFinanceRecovery(s.env)).completed, 1);
  // Delivered and cancelled before its projection was ever written (no row to take back).
  s.raw.prepare(`INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_iqd,created_at,delivered_at)
    VALUES ('ORD-NEVER-PROJECTED','buyer','cancelled','{}','standard','{}','cash',500,1500,500,500,0,'2026-10-16T10:00:00.000Z','2026-10-16T10:00:00.000Z')`).run();
  assert.equal((await drainOrderFinanceRecovery(s.env)).scanned, 0);
  assert.equal(count(s.raw, 'SELECT COUNT(*) n FROM investor_finance_events WHERE order_id=?', 'ORD-NEVER-PROJECTED'), 0);
});
