/**
 * ONE PERSON, ONE PICTURE (owner request 2026-11-09; DECISIONS row 304).
 *
 * worker/lib/personFinance.ts groups what the ledgers already pay into the
 * figures the owner asked to see for a person who invests and works:
 * capital put in / still at work / returned, the share of each agreement,
 * profit earned / held (with the reason a sale is held), return on
 * investment, wages, and one combined total. The case mirrors Sajjad's on the
 * live shop: a fully sold printer agreement whose courier cash is not recorded,
 * one sale with an uncosted extra line, an agreement still in stock, and
 * wages with a payment. The owner's list and the person's own «أرباحي» must
 * show the same numbers; only the owner sees order ids.
 *
 * Run: node --import tsx --test tests/personFinance.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, asD1, stubApp, post, get, json, count } from './fixtures/app';
import { adminInvestmentFinanceRoutes } from '../worker/routes/adminInvestmentFinance';
import { adminFinancePeopleRoutes } from '../worker/routes/adminFinancePeople';
import { financeEarningsRoutes } from '../worker/routes/financeEarnings';
import { syncInvestorOrder } from '../worker/lib/investorFinance';
import { participantOverview } from '../worker/lib/financeParticipants';
import { personFinance, workStatus, type PersonFinance } from '../worker/lib/personFinance';
import { baghdadDay, journalPlan } from '../worker/lib/operations';

const OWNER = { id: 'admin', email: 'boss@x.co', role: 'admin' as const, admin_scope: 'full' };

function setup() {
  const raw = freshDb();
  raw.exec(`INSERT INTO users(id,email,role,admin_scope,name) VALUES ('admin','boss@x.co','admin','full','Owner'),('sajjad','sajjad@x.co','admin','assistant','Sajjad Amer'),('buyer','buyer@x.co','customer',NULL,'Buyer');
    INSERT INTO inventory_suppliers(id,name) VALUES ('supplier','Supplier');
    INSERT INTO expense_categories(id,slug,name_ar) VALUES ('wages','test-wages','أجور');
    INSERT INTO products(id,name,name_ar,slug,sku,price_iqd,product_cost_iqd,stock,inventory_mode) VALUES
      ('x2d','X2D','طابعة X2D','pf-x2d','X2D',500,200,5,'BASE'),('a1','A1','طابعة A1','pf-a1','A1',300,100,3,'BASE'),('esun','eSUN','فلمنت','pf-esun','ESUN',50,NULL,0,'BASE');
    INSERT INTO incoming_inventory(id,product_id,scope,scope_id,qty_ordered,qty_received,purchase_unit_iqd,shipping_total_iqd,internal_delivery_total_iqd,supplier_id,status,created_by) VALUES
      ('inc-x2d','x2d','base','',5,5,200,0,0,'supplier','received','admin'),('inc-a1','a1','base','',3,3,100,0,0,'supplier','received','admin');
    INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,total_cost_iqd,cost_basis,received_at,incoming_id,supplier_id) VALUES
      ('lot-x2d','x2d','base','',5,5,200,1000,'received','2026-10-11','inc-x2d','supplier'),('lot-a1','a1','base','',3,3,100,300,'received','2026-10-11','inc-a1','supplier');
    UPDATE finance_staff SET user_id='sajjad',role='تجهيز الطلبات',start_work_date='2026-09-27',inactive_periods_json='[{"from":"2026-10-10T18:51:39.042Z","to":null}]',active=0 WHERE id='staff_sajjad';`);
  const db = asD1(raw);
  const owner = stubApp(db, OWNER, (a) => { a.route('/i', adminInvestmentFinanceRoutes); a.route('/a', adminFinancePeopleRoutes); });
  const self = stubApp(db, { id: 'sajjad', email: 'sajjad@x.co', role: 'admin', admin_scope: 'assistant' }, (a) => { a.route('/e', financeEarningsRoutes); a.route('/a', adminFinancePeopleRoutes); });
  return { raw, db, owner, self };
}
type Setup = ReturnType<typeof setup>;

async function agreement(s: Setup, incoming: string, principal: number) {
  const body = { operation_id: crypto.randomUUID(), incoming_id: incoming, user_id: 'sajjad', name: `تمويل ${incoming}`, principal_iqd: principal, capital_share_bps: 10000, profit_share_bps: 4500, loss_share_bps: 0 };
  const res = await post(s.owner, '/i/contracts', body); assert.equal(res.status, 200, JSON.stringify(await json(res.clone())));
  const funding = await post(s.owner, `/i/contracts/${body.operation_id}/funding`, { operation_id: crypto.randomUUID(), amount_iqd: principal, payment_day: baghdadDay(), reference: 'cash' });
  assert.equal(funding.status, 200, JSON.stringify(await json(funding.clone())));
  return body.operation_id;
}

/** One X2D unit from the funded lot; `extra` adds a filament line with no recorded cost. */
async function sale(s: Setup, id: string, extra = false) {
  const total = 500 + (extra ? 50 : 0), now = new Date().toISOString();
  s.raw.prepare(`INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_iqd,created_at,delivered_at) VALUES (?,'buyer','delivered','{}','standard','{}','cash',?,1500,?,?,0,?,?)`).run(id, total, total, total, now, now);
  s.raw.prepare(`INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis) VALUES (?,?,'x2d','X2D',1,500,500,200,'snapshot')`).run(`${id}-item`, id);
  s.raw.prepare(`INSERT INTO order_item_inventory_allocations(id,order_id,order_item_id,lot_id,scope,scope_id,qty,unit_cost_iqd,cogs_iqd,idempotency_key) VALUES (?,?,?,'lot-x2d','base','',1,200,200,?)`).run(`${id}-a0`, id, `${id}-item`, `${id}:lot-x2d`);
  s.raw.prepare("UPDATE inventory_lots SET qty_remaining=qty_remaining-1 WHERE id='lot-x2d'").run();
  if (extra) s.raw.prepare(`INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_basis) VALUES (?,?,'esun','eSUN PLA+',1,50,50,'unrecorded')`).run(`${id}-esun`, id);
  await s.db.batch([...journalPlan(s.db, { key: `sale:${id}`, day: baghdadDay(), title: 'Sale', source: 'order', sourceId: id, actor: 'admin' }, [{ account: '1100', debit: total }, { account: '4000', credit: total }]).statements,
    ...journalPlan(s.db, { key: `cogs:${id}`, day: baghdadDay(), title: 'COGS', source: 'order', sourceId: id, actor: 'admin' }, [{ account: '5000', debit: 200 }, { account: '1200', credit: 200 }]).statements]);
}
const collect = (s: Setup, id: string, amount = 500) => s.raw.prepare("INSERT INTO finance_collections(id,order_id,payer,amount_iqd,collection_day,actor_id,created_at) VALUES (?,?,'customer',?,?,'admin',?)").run(`${id}-cash`, id, amount, baghdadDay(), new Date().toISOString());

/** Wages on an order with no funded stock, and one payment. */
function wages(s: Setup) {
  s.raw.exec(`INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,created_at,delivered_at)
      VALUES ('work','buyer','delivered','{}','standard','{}','cash',100,1500,100,100,'2026-10-05T10:00:00Z','2026-10-05T10:00:00Z');
    INSERT INTO finance_order_costs(id,order_id,rule_id,rule_version,rule_name,group_key,staff_id,category_id,milestone,base_iqd,qty,amount_iqd,cost_day,state,snapshot)
      VALUES ('wage-1','work','rule-unit',1,'أجر سجاد','prep','staff_sajjad','wages','delivered',100,1,10000,'2026-10-05','approved','{}');
    INSERT INTO finance_staff_payments(id,staff_id,amount_iqd,kind,payment_day,note,actor_id,created_at) VALUES ('pay-1','staff_sajjad',6000,'payment','2026-10-06','','admin','2026-10-06');
    INSERT INTO finance_payment_allocations(payment_id,cost_id,amount_iqd) VALUES ('pay-1','wage-1',6000);`);
}

async function sajjadCase() {
  const s = setup();
  const x2d = await agreement(s, 'inc-x2d', 1000), a1 = await agreement(s, 'inc-a1', 300);
  for (const id of ['x1', 'x2', 'x3', 'x4']) { await sale(s, id); await syncInvestorOrder(s.db, id); }
  await sale(s, 'x5', true);
  await assert.rejects(syncInvestorOrder(s.db, 'x5'), /معلقة/);
  wages(s);
  return { s, x2d, a1 };
}
const strip = (p: PersonFinance) => JSON.parse(JSON.stringify(p, (key, value) => key === 'order_id' || key === 'day' ? undefined : key === 'label' ? null : key === 'pauses' ? [] : value)) as PersonFinance;

test('capital, share, profit, return and wages of an investor who also works, from the paying ledgers', async () => {
  const { s, x2d, a1 } = await sajjadCase();
  const p = await personFinance(s.db, 'sajjad', { owner: true });
  const inv = p.investor!;
  // 1,300 put in: 300 still on the shelf (3 A1), 1,000 back from the five X2D sales but not released.
  assert.deepEqual({ put: inv.capital.put_in_iqd, agreements: inv.capital.in_agreements_iqd, stock: inv.capital.in_stock_iqd, transit: inv.capital.in_transit_iqd, sold: inv.capital.sold_held_iqd, work: inv.capital.at_work_iqd, returned: inv.capital.returned_iqd, available: inv.capital.available_iqd },
    { put: 1300, agreements: 1300, stock: 300, transit: 0, sold: 1000, work: 1300, returned: 0, available: 0 });
  assert.deepEqual(inv.units, { received: 8, sold: 5, in_stock: 3 });
  // 45% of 300 profit on each of the four costed sales; nothing is withdrawable yet.
  assert.deepEqual(inv.profit, { earned_iqd: 540, available_iqd: 0, reserved_iqd: 0, paid_iqd: 0, held_iqd: 540, debt_iqd: 0 });
  assert.deepEqual(inv.share, { agreements_bps: [4500], min_bps: 4500, max_bps: 4500, earned_bps: 4500 });
  assert.equal(inv.roi_bps, Math.floor(540 * 10000 / 1300));
  const sold = inv.agreements.find((a) => a.id === x2d)!, stock = inv.agreements.find((a) => a.id === a1)!;
  assert.deepEqual(sold.units, { received: 5, sold: 5, in_stock: 0 });
  assert.equal(sold.held_whole, true);
  assert.deepEqual(sold.profit, { earned_iqd: 540, available_iqd: 0, reserved_iqd: 0, paid_iqd: 0, held_iqd: 540, sales: 5, sales_unknown: 1 });
  assert.deepEqual(sold.held_sales.map((h) => [h.order_id, h.reasons, h.profit_iqd, h.capital_iqd, h.profit_unknown]), [
    ['x1', ['collection', 'agreement'], 135, 200, false], ['x2', ['collection', 'agreement'], 135, 200, false], ['x3', ['collection', 'agreement'], 135, 200, false],
    ['x4', ['collection', 'agreement'], 135, 200, false], ['x5', ['cost', 'collection'], 0, 200, true]]);
  assert.deepEqual(stock.capital.in_stock_iqd, 300);
  assert.deepEqual(stock.held_sales, []);
  assert.deepEqual(inv.holds, [{ reason: 'cost', sales: 1, profit_iqd: 0, capital_iqd: 200, profit_unknown: 1 }, { reason: 'collection', sales: 4, profit_iqd: 540, capital_iqd: 800, profit_unknown: 0 }]);
  // Work: paused since 10 Oct, 10,000 earned, 6,000 paid, 4,000 withdrawable.
  const work = p.work!;
  assert.equal(work.roles[0].status, 'paused');
  assert.equal(work.roles[0].paused_from, '2026-10-10T18:51:39.042Z');
  assert.deepEqual({ earned: work.earned_iqd, paid: work.paid_iqd, available: work.available_iqd, held: work.held_iqd, balance: work.balance_iqd }, { earned: 10000, paid: 6000, available: 4000, held: 0, balance: 4000 });
  // One combined «what he earned»: wages + investment profit (capital is his own money, not earnings).
  assert.deepEqual(p.combined, { earned_iqd: 10540, paid_iqd: 6000, available_iqd: 4000, held_iqd: 1540 });
});

test('recorded courier cash leaves the settled sales waiting only for the uncosted one; completing it releases everything', async () => {
  const { s, x2d } = await sajjadCase();
  for (const id of ['x1', 'x2', 'x3', 'x4']) { collect(s, id); await syncInvestorOrder(s.db, id); }
  let sold = (await personFinance(s.db, 'sajjad', { owner: true })).investor!.agreements.find((a) => a.id === x2d)!;
  assert.deepEqual(sold.held_sales.map((h) => [h.order_id, h.reasons]), [['x1', ['agreement']], ['x2', ['agreement']], ['x3', ['agreement']], ['x4', ['agreement']], ['x5', ['cost', 'collection']]]);
  assert.equal(sold.profit.available_iqd, 0, 'today\'s rule: the whole agreement waits for the one unresolved sale');
  // The filament line gets its cost and the cash is recorded: every sale settles.
  // As in tests/investorFinance.test.ts: a zero-cost lot proves the line's cost
  // without changing the posted COGS.
  s.raw.exec(`INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,total_cost_iqd,cost_basis,received_at) VALUES('esun-proof','esun','base','',1,0,0,0,'received','2026-10-25');
    INSERT INTO order_item_inventory_allocations(id,order_id,order_item_id,lot_id,scope,scope_id,qty,unit_cost_iqd,cogs_iqd,idempotency_key) VALUES('x5-esun-a','x5','x5-esun','esun-proof','base','',1,0,0,'x5:esun-proof');`);
  collect(s, 'x5', 550);
  await syncInvestorOrder(s.db, 'x5');
  const p = await personFinance(s.db, 'sajjad', { owner: true });
  sold = p.investor!.agreements.find((a) => a.id === x2d)!;
  assert.equal(sold.held_whole, false);
  assert.deepEqual(sold.held_sales, []);
  assert.equal(p.investor!.holds.length, 0);
  assert.equal(sold.profit.held_iqd, 0);
  assert.equal(sold.profit.available_iqd, sold.profit.earned_iqd);
  assert.ok(sold.profit.earned_iqd > 540, 'the fifth sale adds its share once its cost is known');
  assert.equal(p.investor!.capital.available_iqd, 1000);
  assert.equal(p.investor!.capital.sold_held_iqd, 0);
  assert.equal(p.investor!.capital.at_work_iqd, 300);
  assert.equal(p.combined.available_iqd, 4000 + sold.profit.earned_iqd + 1000);
});

test('the person\'s own «أرباحي» carries the same picture without order ids, labels or pause history', async () => {
  const { s } = await sajjadCase();
  const own = await json(await get(s.self, '/e'));
  const ownerView = await personFinance(s.db, 'sajjad', { owner: true });
  assert.deepEqual(own.person, JSON.parse(JSON.stringify(strip(ownerView))));
  assert.equal(JSON.stringify(own.person).includes('x1'), false, 'no order id reaches the person');
  assert.deepEqual((await participantOverview(s.db, 'sajjad')).person.combined, ownerView.combined);
});

test('the owner\'s people list: every investor and employee once, owner-only, same numbers as the single read', async () => {
  const { s } = await sajjadCase();
  const res = await get(s.owner, '/a/people');
  assert.equal(res.status, 200);
  const body = await json(res);
  const sajjad = body.people.find((p: PersonFinance) => p.user_id === 'sajjad');
  assert.deepEqual(sajjad, JSON.parse(JSON.stringify(await personFinance(s.db, 'sajjad', { owner: true, name: 'Sajjad Amer' }))));
  const hussein = body.people.find((p: PersonFinance & { staff_id?: string }) => p.staff_id === 'staff_hussein');
  assert.equal(hussein.user_id, null);
  assert.equal(hussein.investor, null);
  assert.equal(body.people.filter((p: PersonFinance) => p.user_id === 'sajjad').length, 1);
  assert.equal(body.people[0].user_id, 'sajjad', 'investors first');
  // The period adds what was earned in it; the cumulative picture is unchanged.
  const period = await json(await get(s.owner, `/a/people?from=${baghdadDay()}&to=${baghdadDay()}`));
  const inPeriod = period.people.find((p: PersonFinance) => p.user_id === 'sajjad');
  assert.deepEqual(inPeriod.period, { wages_iqd: 0, profit_iqd: 540 });
  assert.deepEqual(inPeriod.combined, sajjad.combined);
  // Payroll and profit are the owner's alone (owner decision 2).
  assert.equal((await get(s.self, '/a/people')).status, 403);
  assert.equal(count(s.raw, 'SELECT COUNT(*) n FROM audit_log'), count(s.raw, 'SELECT COUNT(*) n FROM audit_log'), 'a read writes nothing');
});

test('work status follows the saved pause intervals, including a scheduled resumption', () => {
  const at = Date.parse('2026-11-09T12:00:00Z');
  const base = { archived_at: null, active: 1, start_work_date: '2026-09-27' };
  assert.deepEqual(workStatus({ ...base, inactive_periods_json: '[]' }, at), { status: 'active', paused_from: null, resumes_at: null, working_since: null, pauses: [] });
  const paused = workStatus({ ...base, inactive_periods_json: '[{"from":"2026-10-27T21:00:00.000Z","to":null}]' }, at);
  assert.deepEqual([paused.status, paused.paused_from, paused.resumes_at], ['paused', '2026-10-27T21:00:00.000Z', null]);
  const resumed = workStatus({ ...base, inactive_periods_json: '[{"from":"2026-10-10T18:51:39.042Z","to":"2026-11-08T21:00:00.000Z"}]' }, at);
  assert.deepEqual([resumed.status, resumed.working_since, resumed.paused_from], ['active', '2026-11-08T21:00:00.000Z', null]);
  const scheduled = workStatus({ ...base, inactive_periods_json: '[{"from":"2026-10-27T21:00:00.000Z","to":"2026-11-15T21:00:00.000Z"}]' }, at);
  assert.deepEqual([scheduled.status, scheduled.resumes_at], ['paused', '2026-11-15T21:00:00.000Z']);
  assert.equal(workStatus({ ...base, archived_at: '2026-10-04T21:33:29.005Z', inactive_periods_json: '[{"from":"2026-10-04T21:33:29.005Z","to":null}]' }, at).status, 'archived');
});
