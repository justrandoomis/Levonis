import { test } from 'node:test';
import assert from 'node:assert/strict';
import { count, failingD1, freshDb, get, json, patch, post, row, stubApp } from './fixtures/app';
import { financeEarningsRoutes } from '../worker/routes/financeEarnings';
import { adminFinancePeopleRoutes } from '../worker/routes/adminFinancePeople';
import { adminFinanceOperationsRoutes } from '../worker/routes/adminFinanceOperations';
import { ruleScopeRank, validateRuleScope } from '../worker/lib/financeRuleScopes';
import { reconcileStaffOrderCosts } from '../worker/lib/financeParticipants';
import { baghdadDay } from '../worker/lib/operations';
import { planOrderFinanceSnapshot, runOrderFinancialEffects } from '../worker/lib/orderFinance';
import { reconcileFinanceOrder } from '../worker/lib/financeReconcile';
import type { Env } from '../worker/lib/types';

function setup() {
  const raw=freshDb();
  raw.exec(`INSERT INTO users(id,email,name,role,admin_scope) VALUES
    ('boss','boss@x.co','Owner','admin','full'),('staff','staff@x.co','Sajjad','admin','assistant'),('other','other@x.co','Other','customer',NULL);
    UPDATE finance_staff SET user_id='staff' WHERE id='staff_sajjad';
    INSERT INTO expense_categories(id,slug,name_ar) VALUES ('wages','test-wages','أجور');
    INSERT INTO products(id,name,slug,price_iqd,stock) VALUES ('p','Printer','participant-printer',50000,3);
    INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd)
    VALUES ('o','other','delivered','{}','standard','{}','cash',50000,1500,55000,55000);`);
  const {db,failing}=failingD1(raw);
  const make=(id:string|null,scope='assistant')=>stubApp(db,id?{id,email:id==='boss'?'boss@x.co':`${id}@x.co`,role:id==='other'?'customer':'admin',admin_scope:scope}:null,(a)=>{a.route('/e',financeEarningsRoutes);a.route('/a',adminFinancePeopleRoutes);a.route('/f',adminFinanceOperationsRoutes);});
  const cost=(id='cost',amount=10000,staff='staff_sajjad')=>raw.prepare(`INSERT INTO finance_order_costs(id,order_id,rule_id,rule_version,rule_name,group_key,staff_id,category_id,milestone,base_iqd,qty,amount_iqd,cost_day,state,snapshot)
    VALUES (?,'o',?,1,'تجهيز','prep',?,'wages','delivered',40000,1,?,?,'approved','{}')`).run(id,`rule:${id}`,staff,amount,baghdadDay());
  return {raw,db,failing,make,cost,self:make('staff'),boss:make('boss','full')};
}
const request=(app:ReturnType<typeof stubApp>,id='withdrawal-1',amount=7000)=>post(app,'/e/withdrawals',{operation_id:id,amount_iqd:amount});

test('self earnings exposes only the signed-in participant; assistants cannot query privileged account lists',async()=>{
  const {raw,cost,self,make,boss}=setup();cost();cost('someone-else',90000,'staff_hussein');
  const data=await json(await get(self,'/e?user_id=other'));assert.equal(data.summary.earned_iqd,10000);assert.equal(data.entries.length,1);
  assert.equal('base_iqd' in data.entries[0],false);assert.equal('staff_id' in data.entries[0],false);
  assert.equal((await get(make(null),'/e')).status,401);assert.equal((await get(self,'/a/accounts?q=staff')).status,403);
  const empty=await json(await get(make('other'),'/e'));assert.equal(empty.summary.available_iqd,0);
  assert.equal((await get(boss,'/a/accounts?q=staff')).status,200);assert.equal(count(raw,'SELECT COUNT(*) n FROM finance_withdrawals'),0);
});
test('withdrawal reserves earnings once and notifies financial administrators only',async()=>{
  const {raw,cost,self}=setup();cost();assert.equal((await request(self)).status,200);assert.equal((await request(self)).status,200);
  const data=await json(await get(self,'/e'));assert.equal(data.summary.available_iqd,3000);assert.equal(data.summary.held_iqd,7000);assert.equal(data.summary.paid_iqd,0);
  assert.equal(count(raw,'SELECT COUNT(*) n FROM finance_withdrawals'),1);assert.equal(count(raw,"SELECT COUNT(*) n FROM user_notifications WHERE user_id='boss'"),1);
  assert.equal(count(raw,"SELECT COUNT(*) n FROM user_notifications WHERE user_id='staff'"),0);
  assert.equal((await request(self,'withdrawal-2',4000)).status,400);
});
test('stale concurrent withdrawal cannot reserve the same balance twice',async()=>{
  const {raw,cost,self,failing}=setup();cost();
  failing.beforeBatch=(stmts)=>{if(!stmts.some((s)=>s.sql.includes('INSERT INTO finance_withdrawals')))return;failing.beforeBatch=null;raw.exec(`INSERT INTO finance_withdrawals(id,user_id,amount_iqd,created_at,updated_at) VALUES ('race','staff',7000,'now','now');INSERT INTO finance_withdrawal_allocations(withdrawal_id,source_kind,source_id,amount_iqd) VALUES ('race','staff','cost',7000)`);};
  assert.equal((await request(self)).status,409);assert.equal(count(raw,'SELECT COUNT(*) n FROM finance_withdrawals'),1);
});
test('own cancellation releases held amount and cannot cancel somebody else request',async()=>{
  const {cost,self,make}=setup();cost();await request(self);
  assert.equal((await post(make('other'),'/e/withdrawals/withdrawal-1/cancel')).status,404);
  assert.equal((await post(self,'/e/withdrawals/withdrawal-1/cancel')).status,200);
  assert.equal((await json(await get(self,'/e'))).summary.available_iqd,10000);
});
test('approval then partial payout records one liability settlement and proof, replay pays nothing twice',async()=>{
  const {raw,cost,self,boss}=setup();cost();await request(self);
  assert.equal((await post(boss,'/a/withdrawals/withdrawal-1/pay',{operation_id:'payment-1',reference:'cash-receipt'})).status,409);
  assert.equal((await post(boss,'/a/withdrawals/withdrawal-1/approve')).status,200);
  const payload={operation_id:'payment-1',amount_iqd:3000,reference:'cash-receipt'};
  const paid=await post(boss,'/a/withdrawals/withdrawal-1/pay',payload);assert.equal(paid.status,200,JSON.stringify(await json(paid)));
  assert.equal((await post(boss,'/a/withdrawals/withdrawal-1/pay',payload)).status,200);
  assert.equal(count(raw,'SELECT COUNT(*) n FROM finance_withdrawal_payments'),1);
  assert.equal(count(raw,'SELECT COUNT(*) n FROM finance_staff_payments'),1);
  let data=await json(await get(self,'/e'));assert.equal(data.summary.paid_iqd,3000);assert.equal(data.summary.held_iqd,4000);assert.equal(data.summary.available_iqd,3000);
  assert.equal((await post(boss,'/a/withdrawals/withdrawal-1/reject')).status,200);
  data=await json(await get(self,'/e'));assert.equal(data.summary.paid_iqd,3000);assert.equal(data.summary.held_iqd,0);assert.equal(data.summary.available_iqd,7000);
  assert.equal(row<{n:number}>(raw,"SELECT SUM(debit_iqd-credit_iqd) n FROM accounting_lines")?.n,0);
});
test('legacy payroll cannot spend reserved self-service wages',async()=>{
  const {cost,self,boss}=setup();cost();await request(self);
  const payment=await post(boss,'/f/staff/staff_sajjad/payments',{operation_id:'legacy-pay-1',amount_iqd:5000,kind:'payment'});assert.equal(payment.status,400);
  assert.equal((await post(boss,'/f/staff/staff_sajjad/payments',{operation_id:'legacy-pay-2',amount_iqd:3000,kind:'payment'})).status,200);
  assert.equal((await json(await get(self,'/e'))).summary.available_iqd,0);
});
test('numeric corrections need only the new amount and carry already-paid reductions forward',async()=>{
  const {raw,cost,self,boss}=setup();cost();
  const pay=await post(boss,'/f/staff/staff_sajjad/payments',{operation_id:'legacy-pay-1',amount_iqd:10000,kind:'payment'});assert.equal(pay.status,200);
  const changed=await patch(boss,'/a/costs/cost',{amount_iqd:6000});assert.equal(changed.status,200,JSON.stringify(await json(changed)));
  let data=await json(await get(self,'/e'));assert.equal(data.summary.available_iqd,0);assert.equal(data.summary.debt_iqd,4000);
  assert.equal(row<{before_iqd:number;after_iqd:number}>(raw,'SELECT before_iqd,after_iqd FROM finance_cost_adjustments')?.before_iqd,10000);
  cost('next',10000);data=await json(await get(self,'/e'));assert.equal(data.summary.available_iqd,6000);
  assert.equal((await request(self,'carryforward',6001)).status,400);assert.equal((await request(self,'carryforward',6000)).status,200);
  assert.equal((await post(boss,'/a/withdrawals/carryforward/approve')).status,200);
  const paid=await post(boss,'/a/withdrawals/carryforward/pay',{operation_id:'carryforward-pay',reference:'receipt'});assert.equal(paid.status,200,JSON.stringify(await json(paid)));
  assert.equal((await json(await get(self,'/e'))).summary.available_iqd,0);
});
test('numeric wage correction cannot silently consume pending withdrawal funds',async()=>{
  const {cost,self,boss}=setup();cost();await request(self);
  assert.equal((await patch(boss,'/a/costs/cost',{amount_iqd:1000})).status,409);
});
test('multi-target scope excludes products before category matching and is validated from actual catalogue',async()=>{
  const {db}=setup();const r={target_type:'all' as const,target_id:'',scope_json:JSON.stringify({catalog_ids:['parent','child'],product_ids:['single'],excluded_product_ids:['excluded']})};
  assert.equal(ruleScopeRank(r,'excluded',new Map([['parent',1]])),-1);assert.equal(ruleScopeRank(r,'p',new Map([['parent',1],['child',2]])),2);assert.equal(ruleScopeRank(r,'single',new Map()),10000);assert.equal(ruleScopeRank(r,'none',new Map()),-1);
  await assert.rejects(()=>validateRuleScope(db,{catalog_ids:['missing']}));
});
test('assistant cannot alter cost or withdraw on behalf of another participant',async()=>{
  const {cost,self,make}=setup();cost();assert.equal((await patch(self,'/a/costs/cost',{amount_iqd:1})).status,403);
  assert.equal((await request(make('other'),'forged-owner',5000)).status,400);
});

test('a newly inserted source or reversal between balance read and commit invalidates the full account snapshot',async()=>{
  const {cost,self,failing,raw}=setup();cost();
  failing.beforeBatch=(stmts)=>{if(!stmts.some((s)=>s.sql.includes('INSERT INTO finance_withdrawals')))return;failing.beforeBatch=null;cost('concurrent-source',1);};
  assert.equal((await request(self)).status,409);assert.equal(count(raw,'SELECT COUNT(*) n FROM finance_withdrawals'),0);
});
test('a payout racing another partial payment cannot duplicate the cash or allocation',async()=>{
  const {cost,self,boss,failing,raw}=setup();cost();await request(self);await post(boss,'/a/withdrawals/withdrawal-1/approve');
  failing.beforeBatch=(stmts)=>{if(!stmts.some((s)=>s.sql.includes('INSERT INTO finance_withdrawal_payments')))return;failing.beforeBatch=null;raw.exec("UPDATE finance_withdrawals SET version=version+1,state='part_paid',paid_iqd=1000 WHERE id='withdrawal-1'");};
  const paid=await post(boss,'/a/withdrawals/withdrawal-1/pay',{operation_id:'concurrent-pay',amount_iqd:3000,reference:'receipt'});
  assert.equal(paid.status,409);assert.equal(count(raw,'SELECT COUNT(*) n FROM finance_staff_payments'),0);assert.equal(count(raw,'SELECT COUNT(*) n FROM finance_withdrawal_payments'),0);
});


test('percentage wages recalculate from order revenue corrections once and preserve explicit manual overrides',async()=>{
  const {raw,cost,db,boss}=setup();cost('percent',4000);
  raw.exec(`INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis) VALUES ('line','o','p','Printer',1,50000,50000,10000,'snapshot');
    INSERT INTO inventory_lots(id,product_id,scope,qty_received,qty_remaining,unit_cost_iqd,cost_basis,received_at) VALUES ('percent-lot','p','base',1,0,10000,'opening','2026-10-01');
    INSERT INTO order_item_inventory_allocations(id,order_id,order_item_id,lot_id,scope,qty,unit_cost_iqd,cogs_iqd,idempotency_key) VALUES ('percent-allocation','o','line','percent-lot','base',1,10000,10000,'percent-consumption');
    UPDATE finance_order_costs SET order_item_id='line',snapshot='{"rule":{"basis":"profit_percent","amount":1000,"cap_iqd":null}}' WHERE id='percent';
    UPDATE orders SET price_adjustment_iqd=-10000 WHERE id='o';`);
  const first=await reconcileStaffOrderCosts(db,'o',{actor:'boss'});assert.equal(first.adjusted,1);
  assert.equal(row<{v:number}>(raw,"SELECT amount_iqd+(SELECT SUM(delta_iqd) FROM finance_cost_adjustments WHERE cost_id='percent') v FROM finance_order_costs WHERE id='percent'")?.v,3000);
  assert.equal((await reconcileStaffOrderCosts(db,'o',{actor:'boss'})).adjusted,0);
  assert.equal((await patch(boss,'/a/costs/percent',{amount_iqd:3500})).status,200);
  raw.exec("UPDATE orders SET price_adjustment_iqd=-20000 WHERE id='o'");
  assert.equal((await reconcileStaffOrderCosts(db,'o',{actor:'boss'})).adjusted,0);
  assert.equal(count(raw,'SELECT COUNT(*) n FROM finance_cost_adjustments'),2);
});

test('investment account eligibility precedes sales; profit withdrawals do not silently return principal',async()=>{
  const {raw,self,boss}=setup();
  raw.exec(`INSERT INTO incoming_inventory(id,product_id,scope,qty_ordered,purchase_unit_iqd) VALUES ('incoming','p','base',1,20000);
    INSERT INTO investment_contracts(id,incoming_id,user_id,name,principal_iqd,capital_share_bps,profit_share_bps,loss_share_bps,created_by,created_at,request_json)
    VALUES ('investment','incoming','staff','Investment',20000,10000,3500,0,'boss','now','{}');`);
  const eligible=await json(await get(self,'/e/eligibility'));assert.equal(eligible.investor,true);
  raw.exec(`INSERT INTO finance_investor_earnings(id,user_id,contract_id,kind,title,amount_iqd,accrued_iqd,state,day,updated_at)
    VALUES ('capital','staff','investment','investor_capital','رأس مال',20000,20000,'available','2026-10-04','now'),
    ('profit','staff','investment','investor_profit','ربح',7000,7000,'available','2026-10-04','now');`);
  let data=await json(await get(self,'/e'));assert.equal(data.summary.earned_iqd,7000);assert.equal(data.summary.available_iqd,27000);assert.equal(data.summary.available_earnings_iqd,7000);assert.equal(data.summary.available_capital_iqd,20000);
  assert.equal((await request(self,'profit-request',8000)).status,400);
  assert.equal((await request(self,'profit-request',7000)).status,200);
  assert.equal(row<{source_kind:string}>(raw,"SELECT source_kind FROM finance_withdrawal_allocations WHERE withdrawal_id='profit-request'")?.source_kind,'investor_profit');
  assert.equal((await post(self,'/e/withdrawals',{operation_id:'profit-request',amount_iqd:7000,balance_type:'capital'})).status,409);
  assert.equal((await post(boss,'/a/withdrawals/profit-request/approve')).status,200);
  const paid=await post(boss,'/a/withdrawals/profit-request/pay',{operation_id:'profit-settlement',reference:'bank slip'});assert.equal(paid.status,200,JSON.stringify(await json(paid)));
  assert.equal(count(raw,'SELECT COUNT(*) n FROM finance_staff_payments'),0);
  data=await json(await get(self,'/e'));assert.equal(data.summary.available_earnings_iqd,0);assert.equal(data.summary.available_capital_iqd,20000);
  assert.equal((await post(self,'/e/withdrawals',{operation_id:'capital-request',amount_iqd:12000,balance_type:'capital'})).status,200);
  assert.equal((await post(boss,'/a/withdrawals/capital-request/approve')).status,200);
  assert.equal((await post(boss,'/a/withdrawals/capital-request/pay',{operation_id:'capital-settlement',reference:'bank slip capital'})).status,200);
  data=await json(await get(self,'/e'));assert.equal(data.summary.capital_paid_iqd,12000);assert.equal(data.summary.earnings_paid_iqd,7000);
  assert.equal(row<{n:number}>(raw,"SELECT SUM(debit_iqd-credit_iqd) n FROM accounting_lines")?.n,0);
});

test('verified per-order COGS materializes pending percentage pay once; reference cost alone stays pending',async()=>{
  const {raw,cost,db,self}=setup();cost('pending',0);
  raw.exec(`INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis) VALUES ('line','o','p','Printer',1,50000,50000,10000,'unrecorded');
    UPDATE finance_order_costs SET order_item_id='line',amount_iqd=NULL,state='pending_cost',snapshot='{"rule":{"basis":"profit_percent","amount":1000,"cap_iqd":null}}' WHERE id='pending';`);
  await runOrderFinancialEffects({DB:db} as Env,'o','delivered');
  assert.equal(count(raw,"SELECT COUNT(*) n FROM finance_posting_errors WHERE event_key='cogs:o'"),1);
  assert.equal((await reconcileStaffOrderCosts(db,'o',{actor:'boss'})).adjusted,0);
  raw.exec(`INSERT INTO finance_order_adjustments(id,operation_id,order_id,order_item_id,field,old_value_iqd,new_value_iqd,delta_iqd,version,actor_id,created_at,allocations_json,before_json,after_json)
    VALUES ('manual-cost','verified-cost','o','line','cogs_iqd',10000,15000,5000,1,'boss','now','[{"line_id":"line","delta_iqd":5000}]','{}','{}');
    INSERT INTO finance_order_versions(order_id,version) VALUES ('o',1);`);
  assert.equal((await reconcileStaffOrderCosts(db,'o',{actor:'boss'})).adjusted,1);
  assert.equal(row<{amount_iqd:number;state:string}>(raw,"SELECT amount_iqd,state FROM finance_order_costs WHERE id='pending'")?.amount_iqd,3500);
  assert.equal((await reconcileStaffOrderCosts(db,'o',{actor:'boss'})).adjusted,0);
  assert.equal(count(raw,"SELECT COUNT(*) n FROM operating_expenses"),1);assert.equal(count(raw,"SELECT COUNT(*) n FROM accounting_entries WHERE event_key='order-cost:pending'"),1);
  assert.equal((await reconcileFinanceOrder(db,'o',{actor:'boss'})).complete,true,JSON.stringify(row(raw,"SELECT * FROM finance_posting_errors WHERE event_key='investor:o'")));
  assert.equal(count(raw,"SELECT COUNT(*) n FROM finance_posting_errors WHERE event_key='cogs:o'"),0);
  assert.equal(count(raw,"SELECT COALESCE(SUM(debit_iqd-credit_iqd),0) n FROM accounting_lines WHERE account_code='5000'"),15000);
  assert.equal((await json(await get(self,'/e'))).summary.available_earnings_iqd,3500);
});

test('unsettled advances reduce cash available and cannot be paid again through legacy or self-service screens',async()=>{
  const {cost,self,boss}=setup();cost();
  assert.equal((await post(boss,'/f/staff/staff_sajjad/payments',{operation_id:'salary-advance',amount_iqd:3000,kind:'advance'})).status,200);
  let data=await json(await get(self,'/e'));assert.equal(data.summary.advance_balance_iqd,3000);assert.equal(data.summary.available_earnings_iqd,7000);
  assert.equal((await request(self,'overspend-advance',8000)).status,400);
  assert.equal((await post(boss,'/f/staff/staff_sajjad/payments',{operation_id:'advance-double-pay',amount_iqd:8000,kind:'payment'})).status,400);
  assert.equal((await request(self,'net-advance',7000)).status,200);await post(boss,'/a/withdrawals/net-advance/approve');
  const paid=await post(boss,'/a/withdrawals/net-advance/pay',{operation_id:'net-wage-payment',reference:'cash receipt'});assert.equal(paid.status,200,JSON.stringify(await json(paid)));
  assert.equal((await post(boss,'/f/staff/staff_sajjad/advance-settlements',{operation_id:'advance-clearing',amount_iqd:3000})).status,200);
  data=await json(await get(self,'/e'));assert.equal(data.summary.advance_balance_iqd,0);assert.equal(data.summary.available_earnings_iqd,0);assert.equal(data.summary.paid_iqd,10000);
});
test('withdrawal submission rate limit is keyed by the participant and does not multiply notifications',async()=>{
  const {cost,self,raw}=setup();cost();for(let i=0;i<10;i++)assert.equal((await request(self,'replayed-withdrawal',1)).status,200);
  assert.equal((await request(self,'replayed-withdrawal',1)).status,429);assert.equal(count(raw,"SELECT COUNT(*) n FROM user_notifications WHERE user_id='boss'"),1);
});

test('durable financial posting failures suspend stale earnings and invalidate already requested payouts until reconciled',async()=>{
  const {raw,cost,self,boss}=setup();cost();await request(self,'pending-posting',7000);
  raw.exec("INSERT INTO finance_posting_errors(event_key,order_id,message,last_attempt_at) VALUES ('investor:o','o','retry required','now')");
  const blocked=await json(await get(self,'/e'));assert.equal(blocked.summary.reconciliation_pending,true);assert.equal(blocked.summary.available_earnings_iqd,0);assert.equal(blocked.entries[0].state,'pending_reconciliation');
  assert.equal((await post(boss,'/a/withdrawals/pending-posting/approve')).status,409);
  assert.equal((await post(boss,'/f/staff/staff_sajjad/payments',{operation_id:'blocked-old-payment',amount_iqd:1000,kind:'payment'})).status,400);
  raw.exec("DELETE FROM finance_posting_errors WHERE event_key='investor:o'");
  assert.equal((await post(boss,'/a/withdrawals/pending-posting/approve')).status,200);
  assert.equal((await post(boss,'/a/withdrawals/pending-posting/pay',{operation_id:'reconciled-payment',reference:'cash receipt'})).status,200);
});

test('a COGS-independent wage can be paid through payroll, while other posting failures still block it', async () => {
  const { raw, cost, self, boss } = setup(); cost();
  raw.exec(`UPDATE finance_order_costs SET snapshot='{"rule":{"basis":"unit","amount":10000,"cap_iqd":null}}' WHERE id='cost';
    INSERT INTO finance_posting_errors(event_key,order_id,message,last_attempt_at) VALUES ('cogs:o','o','FIFO pending','now');`);
  assert.equal((await json(await get(self, '/e'))).summary.available_earnings_iqd, 10000);
  const paid = await post(boss, '/f/staff/staff_sajjad/payments', { operation_id: 'fixed-without-cogs', amount_iqd: 3000, kind: 'payment' });
  assert.equal(paid.status, 200, JSON.stringify(await json(paid)));
  assert.equal((await json(await get(self, '/e'))).summary.available_earnings_iqd, 7000);
  await request(self, 'wage-awaits-posting', 7000);
  raw.exec("INSERT INTO finance_posting_errors(event_key,order_id,message,last_attempt_at) VALUES ('delivered:o','o','sale posting failed','now')");
  assert.equal((await json(await get(self, '/e'))).summary.available_earnings_iqd, 0);
  assert.equal((await post(boss, '/a/withdrawals/wage-awaits-posting/approve')).status, 409);
  raw.exec("DELETE FROM finance_posting_errors WHERE event_key='delivered:o'");
  assert.equal((await post(boss, '/a/withdrawals/wage-awaits-posting/approve')).status, 200);
  assert.equal((await post(boss, '/a/withdrawals/wage-awaits-posting/pay', { operation_id: 'wage-settlement-no-cogs', reference: 'cash receipt' })).status, 200);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM finance_posting_errors WHERE event_key='cogs:o'"), 1);
  assert.equal((await json(await get(self, '/e'))).summary.paid_iqd, 10000);
});

test('percentage wage projection is unspendable immediately after a price mutation, before background reconciliation',async()=>{
  const {raw,cost,db,self,boss,failing}=setup();cost('percent-fresh',4000);
  raw.exec(`INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis) VALUES ('line','o','p','Printer',1,50000,50000,10000,'snapshot');
    INSERT INTO inventory_lots(id,product_id,scope,qty_received,qty_remaining,unit_cost_iqd,cost_basis,received_at) VALUES ('fresh-lot','p','base',1,0,10000,'opening','2026-10-01');
    INSERT INTO order_item_inventory_allocations(id,order_id,order_item_id,lot_id,scope,qty,unit_cost_iqd,cogs_iqd,idempotency_key) VALUES ('fresh-allocation','o','line','fresh-lot','base',1,10000,10000,'fresh-consumption');
    UPDATE finance_order_costs SET order_item_id='line',snapshot='{"rule":{"basis":"profit_percent","amount":1000,"cap_iqd":null}}' WHERE id='percent-fresh';`);
  await reconcileStaffOrderCosts(db,'o',{actor:'boss'});
  assert.equal((await json(await get(self,'/e'))).summary.available_earnings_iqd,4000);
  failing.beforeBatch=(stmts)=>{if(!stmts.some((s)=>s.sql.includes('INSERT INTO finance_withdrawals')))return;failing.beforeBatch=null;raw.exec("UPDATE orders SET price_adjustment_iqd=-10000 WHERE id='o'");};
  assert.equal((await request(self,'stale-percentage',3000)).status,409);
  assert.equal((await json(await get(self,'/e'))).summary.available_earnings_iqd,0);
  assert.equal((await post(boss,'/f/staff/staff_sajjad/payments',{operation_id:'stale-direct-wage',amount_iqd:1000,kind:'payment'})).status,400);
  await reconcileStaffOrderCosts(db,'o',{actor:'boss'});
  assert.equal((await json(await get(self,'/e'))).summary.available_earnings_iqd,3000);
  assert.equal((await request(self,'stale-percentage',3000)).status,200);
});
test('nonstaff percentage materials materialize with the original supplier liability and numeric overrides remain distinct from wages',async()=>{
  const {raw,cost,db,boss}=setup();cost('materials',0);
  raw.exec(`INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis) VALUES ('line','o','p','Printer',1,50000,50000,10000,'snapshot');
    INSERT INTO inventory_lots(id,product_id,scope,qty_received,qty_remaining,unit_cost_iqd,cost_basis,received_at) VALUES ('material-lot','p','base',1,0,10000,'opening','2026-10-01');
    INSERT INTO order_item_inventory_allocations(id,order_id,order_item_id,lot_id,scope,qty,unit_cost_iqd,cogs_iqd,idempotency_key) VALUES ('material-allocation','o','line','material-lot','base',1,10000,10000,'material-consumption');
    UPDATE finance_order_costs SET order_item_id='line',staff_id=NULL,amount_iqd=NULL,state='pending_cost',snapshot='{"rule":{"basis":"profit_percent","amount":1000,"cap_iqd":null}}' WHERE id='materials';`);
  assert.equal((await reconcileStaffOrderCosts(db,'o',{actor:'boss'})).adjusted,1);
  assert.equal(row<{n:number}>(raw,"SELECT SUM(credit_iqd-debit_iqd) n FROM accounting_lines WHERE account_code='2000'")?.n,4000);
  assert.equal((await patch(boss,'/a/costs/materials',{amount_iqd:2500})).status,200);
  assert.equal(row<{n:number}>(raw,"SELECT SUM(credit_iqd-debit_iqd) n FROM accounting_lines WHERE account_code='2000'")?.n,2500);
  assert.equal(count(raw,'SELECT COUNT(*) n FROM finance_staff_payments'),0);
});

test('prepared percentage wages validate their source and become withdrawable before delivery',async()=>{
  const {raw,db,self,boss}=setup();
  raw.exec(`UPDATE orders SET status='confirmed',stage='preparing' WHERE id='o';
    INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis) VALUES ('line','o','p','Printer',1,50000,50000,10000,'snapshot');
    INSERT INTO inventory_lots(id,product_id,scope,qty_received,qty_remaining,unit_cost_iqd,cost_basis,received_at) VALUES ('prep-lot','p','base',1,0,10000,'opening','2026-10-01');
    INSERT INTO order_item_inventory_allocations(id,order_id,order_item_id,lot_id,scope,qty,unit_cost_iqd,cogs_iqd,idempotency_key) VALUES ('prep-allocation','o','line','prep-lot','base',1,10000,10000,'prep-consumption');`);
  const created=await post(boss,'/f/rules',{name:'Prepared commission',staff_id:'staff_sajjad',basis:'profit_percent',amount:1000,milestone:'prepared',category_id:'wages',scope:{product_ids:['p'],catalog_ids:[],excluded_product_ids:[]}});
  assert.equal(created.status,200,JSON.stringify(await json(created)));
  await db.batch(await planOrderFinanceSnapshot(db,'o',[{id:'line',product_id:'p'}],new Date().toISOString()));
  await runOrderFinancialEffects({DB:db} as Env,'o','prepared');
  await runOrderFinancialEffects({DB:db} as Env,'o','prepared');
  assert.equal(count(raw,'SELECT COUNT(*) n FROM finance_order_costs'),1);
  assert.equal(count(raw,"SELECT COUNT(*) n FROM finance_staff_basis WHERE order_id='o'"),1);
  assert.equal(count(raw,"SELECT COUNT(*) n FROM accounting_entries WHERE event_key='sale:o'"),0);
  const overview=await json(await get(self,'/e'));assert.equal(overview.summary.available_earnings_iqd,4000);
  assert.equal((await request(self,'prepared-wage',4000)).status,200);
});
