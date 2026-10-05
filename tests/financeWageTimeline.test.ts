import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, failingD1, stubApp, post, get, json, row, all, patch } from './fixtures/app';
import { adminFinancePeopleRoutes } from '../worker/routes/adminFinancePeople';
import { adminFinanceOperationsRoutes } from '../worker/routes/adminFinanceOperations';
import { financeEarningsRoutes } from '../worker/routes/financeEarnings';
import { participantSummary, type ParticipantSource } from '../worker/lib/financeParticipants';

async function setup(){
  const raw=freshDb();raw.exec(`INSERT INTO users(id,email,name,role,admin_scope) VALUES
   ('boss','boss@x.co','Owner','admin','full'),('employee','employee@x.co','Sajjad','admin','assistant'),
   ('finance','finance@x.co','Finance','admin','full'),('buyer','buyer@x.co','Buyer','customer',NULL);
   INSERT INTO products(id,name,slug,price_iqd,stock,inventory_mode) VALUES('printer','Printer','timeline-printer',50000,0,'BASE');`);
  const {db}=failingD1(raw);
  const app=(id:string,scope='assistant')=>stubApp(db,{id,email:`${id}@x.co`,role:'admin',admin_scope:scope},a=>{a.route('/people',adminFinancePeopleRoutes);a.route('/operations',adminFinanceOperationsRoutes);a.route('/earnings',financeEarningsRoutes);});
  const boss=app('boss','full'),self=app('employee');
  const staff=await json(await post(boss,'/people/staff',{user_id:'employee',start_work_date:'2026-08-31'}));
  const rule=await json(await post(boss,'/operations/rules',{staff_id:staff.id,basis:'unit',amount:10000}));
  async function order(id:string,qty:number,delivered:string,created='2026-08-01T12:00:00Z'){
    raw.prepare(`INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_iqd,created_at,delivered_at) VALUES (?,'buyer','delivered','{}','standard','{}','cash',?,1500,?,?,0,?,?)`).run(id,qty*50000,qty*50000,qty*50000,created,delivered);
    raw.prepare(`INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis) VALUES (?,?,'printer','Printer',?,50000,?,20000,'snapshot')`).run(`line:${id}`,id,qty,qty*50000);
    raw.prepare(`INSERT INTO inventory_lots(id,product_id,scope,qty_received,qty_remaining,unit_cost_iqd,cost_basis,received_at) VALUES (?,'printer','base',?,0,20000,'opening',?)`).run(`lot:${id}`,qty,created);
    raw.prepare(`INSERT INTO order_item_inventory_allocations(id,order_id,order_item_id,lot_id,scope,qty,unit_cost_iqd,cogs_iqd,idempotency_key) VALUES (?,?,?,?,'base',?,20000,?,?)`).run(`alloc:${id}`,id,`line:${id}`,`lot:${id}`,qty,qty*20000,`consumed:${id}`);
  }
  async function drain(){for(let i=0;i<30;i++){const res=await post(boss,`/people/staff/${staff.id}/reconcile`,{}),j=await json(res);assert.equal(res.status,200,JSON.stringify(j));assert.notEqual(j.reconciliation.state,'failed',JSON.stringify(j));if(j.reconciliation.state==='complete')return;}assert.fail('Job did not finish');}
  const earnings=async()=>await json(await get(self,'/earnings'));
  async function preview(amount:number,from:string,extra:Record<string,unknown>={}){
    const version=row(raw,'SELECT version FROM finance_cost_rules WHERE id=?',rule.id)!.version;
    const body={amount,basis:'unit',effective_from:from,reason:'تعديل أجر التجهيز باتفاق جديد',version,...extra};
    let res=await post(boss,`/people/rules/${rule.id}/preview`,body),value=await json(res);assert.equal(res.status,200,JSON.stringify(value));while(value.complete===false){res=await post(boss,`/people/rules/${rule.id}/preview`,{...body,preview_job_id:value.preview_job_id});value=await json(res);assert.equal(res.status,200,JSON.stringify(value));}return {body,value};
  }
  async function apply(amount:number,from:string,extra:Record<string,unknown>={}){
    const p=await preview(amount,from,extra),body={...p.body,operation_id:crypto.randomUUID(),preview_token:p.value.preview_token};
    const response=await post(boss,`/people/rules/${rule.id}/apply`,body),data=await json(response);assert.equal(response.status,200,JSON.stringify(data));await drain();return {body,data,preview:p.value};
  }
  async function pay(amount:number,partial?:number){
    const request=await json(await post(self,'/earnings/withdrawals',{operation_id:crypto.randomUUID(),amount_iqd:amount}));assert.ok(request.id,JSON.stringify(request));
    assert.equal((await post(boss,`/people/withdrawals/${request.id}/approve`,{})).status,200);
    const result=await post(boss,`/people/withdrawals/${request.id}/pay`,{operation_id:crypto.randomUUID(),amount_iqd:partial??amount,reference:'cash-proof'});assert.equal(result.status,200,JSON.stringify(await json(result)));return request.id as string;
  }
  return {raw,db,boss,self,app,staffId:staff.id as string,ruleId:rule.id as string,order,drain,earnings,preview,apply,pay};
}

test('paid 100,000 becomes corrected 70,000; 30,000 debt is covered by future wages once, then 5,000 becomes withdrawable',async()=>{
  const x=await setup();await x.order('before',4,'2026-09-14T12:00:00Z');await x.order('after',6,'2026-09-15T12:00:00Z');await x.drain();
  assert.equal((await x.earnings()).summary.available_iqd,100000);await x.pay(100000);
  const change=await x.apply(5000,'2026-09-15');assert.equal(change.preview.delta_iqd,-30000);assert.equal(change.preview.orders_count,1);
  let s=(await x.earnings()).summary;assert.equal(s.earned_iqd,70000);assert.equal(s.paid_iqd,100000);assert.equal(s.net_balance_iqd,-30000);assert.equal(s.debt_iqd,30000);assert.equal(s.available_iqd,0);
  await x.order('new-10k',2,'2026-10-06T12:00:00Z');await post(x.boss,'/operations/orders/new-10k/reconcile',{});
  s=(await x.earnings()).summary;assert.equal(s.debt_iqd,20000);assert.equal(s.available_iqd,0);
  await x.order('new-25k',5,'2026-10-07T12:00:00Z');await post(x.boss,'/operations/orders/new-25k/reconcile',{});
  s=(await x.earnings()).summary;assert.equal(s.debt_iqd,0);assert.equal(s.available_iqd,5000);assert.equal(s.net_balance_iqd,5000);assert.equal(s.historical_overpayment_iqd,30000);
  const replay=await post(x.boss,`/people/rules/${x.ruleId}/apply`,change.body);assert.equal(replay.status,200);assert.equal((await json(replay)).already,true);
  assert.equal(all(x.raw,'SELECT * FROM finance_cost_adjustments WHERE delta_iqd=-30000').length,1);
});

test('15 September starts at 21:00 UTC on the 14th; delivery, not checkout, selects the rule',async()=>{
  const x=await setup();await x.order('old',1,'2026-09-14T20:59:59.999Z');await x.order('new',1,'2026-09-14T21:00:00.000Z');await x.drain();await x.apply(5000,'2026-09-15');
  const rows=all<{order_id:string;amount:number}>(x.raw,'SELECT c.order_id,c.amount_iqd+COALESCE((SELECT SUM(delta_iqd) FROM finance_cost_adjustments WHERE cost_id=c.id),0) amount FROM finance_order_costs c ORDER BY c.order_id');
  assert.deepEqual(rows,[{order_id:'new',amount:5000},{order_id:'old',amount:10000}]);
});

test('a historical insertion stops at the later effective change and a retrospective increase adds only the difference',async()=>{
  const x=await setup();await x.order('sep10',1,'2026-09-10T12:00:00Z');await x.order('sep20',1,'2026-09-20T12:00:00Z');await x.order('oct02',1,'2026-10-02T12:00:00Z');await x.drain();
  await x.apply(7000,'2026-10-01');const change=await x.apply(15000,'2026-09-15');assert.equal(change.preview.until,'2026-10-01');assert.equal(change.preview.orders_count,1);assert.equal(change.preview.delta_iqd,5000);
  assert.equal((await x.earnings()).summary.earned_iqd,32000);
  const periods=all<{starts_on:string;ends_before:string|null}>(x.raw,'SELECT starts_on,ends_before FROM finance_wage_periods WHERE rule_id=? ORDER BY starts_on',x.ruleId);
  assert.deepEqual(periods,[{starts_on:'2026-09-01',ends_before:'2026-09-15'},{starts_on:'2026-09-15',ends_before:'2026-10-01'},{starts_on:'2026-10-01',ends_before:null}]);
});

test('a changed financial source invalidates preview; only the owner can alter wage history',async()=>{
  const x=await setup();await x.order('a',1,'2026-09-20T12:00:00Z');await x.drain();const p=await x.preview(5000,'2026-09-15');
  x.raw.prepare('UPDATE orders SET price_adjustment_iqd=1000 WHERE id=?').run('a');
  const res=await post(x.boss,`/people/rules/${x.ruleId}/apply`,{...p.body,operation_id:'stale-preview-operation',preview_token:p.value.preview_token});assert.equal(res.status,409);
  assert.equal((await post(x.app('finance','full'),`/people/rules/${x.ruleId}/preview`,p.body)).status,403);
  assert.equal((await patch(x.app('finance','full'),`/people/staff/${x.staffId}`,{start_work_date:'2026-09-01'})).status,403);
});

test('partly paid withdrawal requires explicit release; the paid portion and its evidence survive',async()=>{
  const x=await setup();await x.order('a',10,'2026-09-20T12:00:00Z');await x.drain();const withdrawal=await x.pay(100000,40000);
  const p=await x.preview(5000,'2026-09-15');assert.equal(p.value.withdrawals[0].paid_iqd,40000);
  assert.equal((await post(x.boss,`/people/rules/${x.ruleId}/apply`,{...p.body,operation_id:'withdrawal-review-operation',preview_token:p.value.preview_token})).status,409);
  await x.apply(5000,'2026-09-15',{release_withdrawals:true});const s=(await x.earnings()).summary;
  assert.equal(s.paid_iqd,40000);assert.equal(s.held_iqd,0);assert.equal(s.debt_iqd,0);assert.equal(s.available_iqd,10000);
  assert.equal(row(x.raw,'SELECT state FROM finance_withdrawals WHERE id=?',withdrawal)!.state,'cancelled');
  assert.equal(row(x.raw,'SELECT unpaid_released_iqd FROM finance_withdrawal_reviews WHERE withdrawal_id=?',withdrawal)!.unpaid_released_iqd,60000);
});

test('holds are not cash debt and staff debt never consumes investor principal or investment profits',()=>{
  const source=(kind:ParticipantSource['kind'],amount:number,paid=0,held=0):ParticipantSource=>({id:kind,kind,title:kind,order_id:null,day:'2026-09-15',amount_iqd:amount,accrued_iqd:amount,paid_iqd:paid,held_iqd:held,available_iqd:Math.max(0,amount-paid-held),state:'available',eligible:true,version:1});
  let s=participantSummary([source('staff',70000,100000),source('investor_capital',600000),source('investor_profit',127750)]);
  assert.equal(s.debt_iqd,30000);assert.equal(s.available_capital_iqd,600000);assert.equal(s.available_earnings_iqd,127750);
  s=participantSummary([source('staff',50000,0,100000)]);assert.equal(s.debt_iqd,0);assert.equal(s.reservation_conflict_iqd,50000);assert.equal(s.net_balance_iqd,50000);
});

test('manual per-order wage is visible and preserved during a rule change',async()=>{
  const x=await setup();await x.order('a',1,'2026-09-20T12:00:00Z');await x.drain();const cost=row(x.raw,'SELECT id FROM finance_order_costs WHERE order_id=?','a')!;
  assert.equal((await patch(x.boss,`/people/costs/${cost.id}`,{amount_iqd:12000})).status,200);
  const changed=await x.apply(5000,'2026-09-15');assert.equal(changed.preview.manual_overrides,1);assert.equal(changed.preview.delta_iqd,0);assert.equal((await x.earnings()).summary.earned_iqd,12000);
});


test('preview advances in resumable pages, applies once, and source changes invalidate a partial preview',async()=>{
 const x=await setup();for(let i=0;i<14;i++)await x.order(`page-${String(i).padStart(2,'0')}`,1,'2026-09-20T12:00:00Z');await x.drain();
 const body={version:1,amount:5000,basis:'unit',effective_from:'2026-09-15',reason:'Paged retrospective review'};
 let res=await post(x.boss,`/people/rules/${x.ruleId}/preview`,body),p=await json(res);assert.equal(res.status,200,JSON.stringify(p));assert.equal(p.complete,false);assert.equal(p.processed_orders,6);
 const job=p.preview_job_id;res=await post(x.boss,`/people/rules/${x.ruleId}/preview`,{...body,preview_job_id:job});p=await json(res);assert.equal(p.processed_orders,12);assert.equal(p.complete,false);
 res=await post(x.boss,`/people/rules/${x.ruleId}/preview`,{...body,preview_job_id:job});p=await json(res);assert.equal(p.complete,true);assert.equal(p.orders_count,14);assert.equal(p.delta_iqd,-70000);
 assert.equal((await x.earnings()).summary.earned_iqd,140000);
 const repeat=await json(await post(x.boss,`/people/rules/${x.ruleId}/preview`,{...body,preview_job_id:job}));assert.equal(repeat.processed_orders,14);
 x.raw.exec("UPDATE orders SET shipping_iqd=1000 WHERE id='page-00'");assert.equal((await post(x.boss,`/people/rules/${x.ruleId}/apply`,{...body,preview_token:p.preview_token,operation_id:crypto.randomUUID()})).status,409);
 await x.apply(5000,'2026-09-15');assert.equal((await x.earnings()).summary.earned_iqd,70000);
});

test('a pending wage change reserves only its overpayment and keeps independent earnings available',async()=>{
 const x=await setup();await x.order('older',4,'2026-09-10T12:00:00Z');await x.order('revised',6,'2026-09-20T12:00:00Z');await x.drain();await x.pay(100000);
 await x.order('independent',5,'2026-09-12T12:00:00Z');await post(x.boss,'/operations/orders/independent/reconcile',{});
 const p=await x.preview(5000,'2026-09-15');assert.equal((await post(x.boss,`/people/rules/${x.ruleId}/apply`,{...p.body,preview_token:p.value.preview_token,operation_id:crypto.randomUUID()})).status,200);
 // Revised paid earnings reserve 30k of the independent 50k, not their full 60k.
 assert.equal((await x.earnings()).summary.available_earnings_iqd,20000);
 await x.drain();assert.equal((await x.earnings()).summary.available_earnings_iqd,20000);
});

test('employment-following baseline moves with start date while an explicit wage version keeps its own date',async()=>{
 const x=await setup();await x.order('old',1,'2026-09-05T12:00:00Z');await x.order('later',1,'2026-09-20T12:00:00Z');await x.drain();await x.apply(5000,'2026-09-15');
 assert.equal((await patch(x.boss,`/people/staff/${x.staffId}`,{start_work_date:'2026-09-10'})).status,200);await x.drain();assert.equal((await x.earnings()).summary.earned_iqd,5000);
 assert.equal((await patch(x.boss,`/people/staff/${x.staffId}`,{start_work_date:'2026-08-31'})).status,200);await x.drain();assert.equal((await x.earnings()).summary.earned_iqd,15000);
 assert.ok(all(x.raw,"SELECT * FROM finance_wage_versions WHERE rule_id=? AND effective_from='2026-09-15' AND follows_employment=0",x.ruleId).length);
});

test('staff and withdrawal filters apply on the server; cumulative balance stays distinct',async()=>{
 const x=await setup();await x.order('sep',2,'2026-09-20T12:00:00Z');await x.order('oct',3,'2026-10-02T12:00:00Z');await x.drain();
 const sep=await json(await get(x.boss,'/people/staff?month=2026-09')),oct=await json(await get(x.boss,'/people/staff?from=2026-10-01&to=2026-10-31'));
 assert.equal(sep.staff[0].period.earned_iqd,20000);assert.equal(oct.staff[0].period.earned_iqd,30000);assert.equal(sep.staff[0].balance.staff_net_iqd,50000);assert.equal(oct.staff[0].balance.staff_net_iqd,50000);
 await x.pay(10000);x.raw.exec("UPDATE finance_withdrawals SET created_at='2026-09-14T21:00:00Z'");
 const before=await json(await get(x.boss,'/people/withdrawals?from=2026-09-14&to=2026-09-14')),inside=await json(await get(x.boss,'/people/withdrawals?from=2026-09-15&to=2026-09-15'));
 assert.equal(before.totals.count,0);assert.equal(inside.totals.count,1);assert.equal(inside.totals.paid_iqd,10000);assert.equal((await json(await get(x.boss,'/people/withdrawals?state=open'))).totals.count,0);
});

test('a migrated baseline cannot silently replace a different historical wage; an explicit effective change can',async()=>{
 const x=await setup();await x.order('legacy',1,'2026-09-20T12:00:00Z');await x.drain();
 const prior=row<{id:string;snapshot:string}>(x.raw,'SELECT id,snapshot FROM finance_wage_versions WHERE rule_id=?',x.ruleId)!;
 const snapshot={...JSON.parse(prior.snapshot),amount:5000,version:2};
 x.raw.prepare("INSERT INTO finance_wage_versions(id,rule_id,revision,staff_id,effective_from,follows_employment,snapshot,reason,actor_id,recorded_at,supersedes_id) VALUES(?,?,2,?,'2026-09-01',1,?,'Legacy baseline','boss',?,?)").run(`wage:baseline:${x.ruleId}`,x.ruleId,x.staffId,JSON.stringify(snapshot),new Date().toISOString(),prior.id);
 x.raw.prepare('UPDATE finance_cost_rules SET amount=5000,version=2 WHERE id=?').run(x.ruleId);
 await post(x.boss,'/operations/orders/legacy/reconcile',{});assert.equal((await x.earnings()).summary.earned_iqd,10000);
 await x.apply(5000,'2026-09-15');assert.equal((await x.earnings()).summary.earned_iqd,5000);
});
