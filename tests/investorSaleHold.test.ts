/**
 * ONE UNRESOLVED SALE HOLDS ONLY ITSELF (owner 2026-11-09, «Hold only that
 * sale»; DECISIONS row 305).
 *
 * Before: one sale of an agreement waiting for a cost (an X2D with two eSUN
 * rolls that had none) held every other sale of the agreement — 912,930 of
 * profit and 7,596,072 of recovered capital on the live shop. Now:
 *   - a pending sale keeps only its own profit and principal out of reach;
 *   - a sale being redone (stale projection, posting error, wage job) holds
 *     only its own eligible amount, read and fenced the same way at payout;
 *   - a loss-sharing contract still holds all its capital while a sale is
 *     unresolved (that sale may end as a loss the capital absorbs); its
 *     settled profit is released like any other.
 * The payout path (request → approve → pay) runs against the new amounts.
 *
 * Run: node --import tsx --test tests/investorSaleHold.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, asD1, stubApp, post, json } from './fixtures/app';
import { adminInvestmentFinanceRoutes } from '../worker/routes/adminInvestmentFinance';
import { syncInvestorOrder } from '../worker/lib/investorFinance';
import { changeWithdrawalState, participantOverview, payWithdrawal, requestWithdrawal } from '../worker/lib/financeParticipants';
import { baghdadDay, journalPlan } from '../worker/lib/operations';
import type { Env } from '../worker/lib/types';

const OWNER = { id: 'admin', email: 'boss@x.co', role: 'admin' as const, admin_scope: 'full' };
function setup() {
  const raw = freshDb();
  raw.exec(`INSERT INTO users(id,email,role,admin_scope,name,email_verified_at) VALUES ('admin','boss@x.co','admin','full','Owner','2026-01-01T00:00:00.000Z'),('inv','inv@x.co','admin','assistant','Investor',NULL),('buyer','buyer@x.co','customer',NULL,'Buyer',NULL);
    INSERT INTO inventory_suppliers(id,name) VALUES ('supplier','Supplier');
    INSERT INTO products(id,name,name_ar,slug,sku,price_iqd,product_cost_iqd,stock,inventory_mode) VALUES ('x2d','X2D','طابعة','sh-x2d','X2D',500,200,5,'BASE'),('esun','eSUN','فلمنت','sh-esun','ESUN',50,NULL,0,'BASE');
    INSERT INTO incoming_inventory(id,product_id,scope,scope_id,qty_ordered,qty_received,purchase_unit_iqd,shipping_total_iqd,internal_delivery_total_iqd,supplier_id,status,created_by) VALUES ('inc','x2d','base','',5,5,200,0,0,'supplier','received','admin');
    INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,total_cost_iqd,cost_basis,received_at,incoming_id,supplier_id) VALUES ('lot','x2d','base','',5,5,200,1000,'received','2026-10-11','inc','supplier');`);
  const db = asD1(raw);
  return { raw, db, owner: stubApp(db, OWNER, (a) => { a.route('/i', adminInvestmentFinanceRoutes); }) };
}
type Setup = ReturnType<typeof setup>;
async function agreement(s: Setup, lossShare = 0) {
  const body = { operation_id: crypto.randomUUID(), incoming_id: 'inc', user_id: 'inv', name: 'X2D', principal_iqd: 1000, capital_share_bps: 10000, profit_share_bps: 4500, loss_share_bps: lossShare };
  assert.equal((await post(s.owner, '/i/contracts', body)).status, 200);
  const funding = await post(s.owner, `/i/contracts/${body.operation_id}/funding`, { operation_id: crypto.randomUUID(), amount_iqd: 1000, payment_day: baghdadDay(), reference: 'cash' });
  assert.equal(funding.status, 200, JSON.stringify(await json(funding.clone())));
  return body.operation_id;
}
/** One X2D at 500 (cost 200), collected; `extra` adds a line with no recorded cost. */
async function sale(s: Setup, id: string, extra = false) {
  const total = 500 + (extra ? 50 : 0), now = new Date().toISOString();
  s.raw.prepare(`INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_iqd,created_at,delivered_at) VALUES (?,'buyer','delivered','{}','standard','{}','cash',?,1500,?,?,0,?,?)`).run(id, total, total, total, now, now);
  s.raw.prepare(`INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis) VALUES (?,?,'x2d','X2D',1,500,500,200,'snapshot')`).run(`${id}-item`, id);
  s.raw.prepare(`INSERT INTO order_item_inventory_allocations(id,order_id,order_item_id,lot_id,scope,scope_id,qty,unit_cost_iqd,cogs_iqd,idempotency_key) VALUES (?,?,?,'lot','base','',1,200,200,?)`).run(`${id}-a0`, id, `${id}-item`, `${id}:lot`);
  s.raw.prepare("UPDATE inventory_lots SET qty_remaining=qty_remaining-1 WHERE id='lot'").run();
  if (extra) s.raw.prepare(`INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_basis) VALUES (?,?,'esun','eSUN PLA+',1,50,50,'unrecorded')`).run(`${id}-esun`, id);
  s.raw.prepare("INSERT INTO finance_collections(id,order_id,payer,amount_iqd,collection_day,actor_id,created_at) VALUES (?,?,'customer',?,?,'admin',?)").run(`${id}-cash`, id, total, baghdadDay(), now);
  await s.db.batch([...journalPlan(s.db, { key: `sale:${id}`, day: baghdadDay(), title: 'Sale', source: 'order', sourceId: id, actor: 'admin' }, [{ account: '1100', debit: total }, { account: '4000', credit: total }]).statements,
    ...journalPlan(s.db, { key: `cogs:${id}`, day: baghdadDay(), title: 'COGS', source: 'order', sourceId: id, actor: 'admin' }, [{ account: '5000', debit: 200 }, { account: '1200', credit: 200 }]).statements]);
  if (extra) await assert.rejects(syncInvestorOrder(s.db, id), /معلقة/); else await syncInvestorOrder(s.db, id);
}
const balance = async (s: Setup) => (await participantOverview(s.db, 'inv')).summary;

test('a pending sale holds only itself, and the released money pays out through the normal fence', async () => {
  const s = setup();
  await agreement(s);
  await sale(s, 'a'); await sale(s, 'b'); await sale(s, 'pending', true); await sale(s, 'c');
  const b = await balance(s);
  // Three settled sales: 3 × 45% of 300, and 3 × 200 principal. The pending one: its 200 principal waits.
  assert.deepEqual({ profit: b.investor_profit_iqd, profitAvailable: b.investor_profit_available_iqd, capital: b.capital_iqd, capitalAvailable: b.capital_available_iqd, capitalPending: b.capital_pending_iqd },
    { profit: 405, profitAvailable: 405, capital: 800, capitalAvailable: 600, capitalPending: 200 });
  const env = { DB: s.db } as Env;
  await requestWithdrawal(env, 'inv', 'wd-profit-0001', 405, 'earnings');
  await requestWithdrawal(env, 'inv', 'wd-capital-001', 600, 'capital');
  for (const id of ['wd-profit-0001', 'wd-capital-001']) {
    await changeWithdrawalState(s.db, id, 'admin', 'approve');
    await payWithdrawal(s.db, 'admin', id, { id: `pay-${id}`, reference: 'cash', receipt_url: '', day: baghdadDay() });
  }
  const after = await balance(s);
  assert.deepEqual([after.investor_profit_available_iqd, after.capital_available_iqd, after.capital_pending_iqd, after.earnings_paid_iqd, after.capital_paid_iqd], [0, 0, 200, 405, 600]);
  await assert.rejects(requestWithdrawal(env, 'inv', 'wd-too-much-01', 1, 'capital'), 'the pending sale\'s principal is still not withdrawable');
});

test('a loss-sharing agreement still holds all its capital while a sale is unresolved; its settled profit is released', async () => {
  const s = setup();
  await agreement(s, 10000);
  await sale(s, 'a'); await sale(s, 'pending', true); await sale(s, 'b');
  const b = await balance(s);
  assert.deepEqual({ profitAvailable: b.investor_profit_available_iqd, capitalAvailable: b.capital_available_iqd, capitalPending: b.capital_pending_iqd }, { profitAvailable: 270, capitalAvailable: 0, capitalPending: 600 });
  await assert.rejects(requestWithdrawal({ DB: s.db } as Env, 'inv', 'wd-loss-capital', 1, 'capital'));
});

test('a posting error or a stale projection on one order holds only that order\'s amounts', async () => {
  const s = setup();
  await agreement(s);
  await sale(s, 'a'); await sale(s, 'b'); await sale(s, 'c');
  assert.deepEqual([(await balance(s)).investor_profit_available_iqd, (await balance(s)).capital_available_iqd], [405, 600]);
  s.raw.exec("INSERT INTO finance_posting_errors(event_key,order_id,message,last_attempt_at) VALUES ('delivered:b','b','retry','2026-11-09')");
  let b = await balance(s);
  assert.deepEqual([b.investor_profit_available_iqd, b.capital_available_iqd], [270, 400], 'order b waits; a and c do not');
  s.raw.exec("DELETE FROM finance_posting_errors WHERE event_key='delivered:b'");
  // A change to order c's financial inputs makes its projection stale until it is recalculated.
  s.raw.exec("UPDATE orders SET cod_tax_iqd=cod_tax_iqd+1 WHERE id='c'");
  b = await balance(s);
  assert.deepEqual([b.investor_profit_available_iqd, b.capital_available_iqd], [270, 400], 'order c waits for its recalculation');
  await syncInvestorOrder(s.db, 'c');
  b = await balance(s);
  assert.equal(b.capital_available_iqd, 600);
  assert.ok(b.investor_profit_available_iqd >= 404 && b.investor_profit_available_iqd <= 405, `recalculated: ${b.investor_profit_available_iqd}`);
});
