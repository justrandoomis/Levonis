import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, asD1, stubApp, post, get, json, all, count } from './fixtures/app';
import { adminProcurementRoutes } from '../worker/routes/adminProcurement';
import { adminInvestmentFinanceRoutes } from '../worker/routes/adminInvestmentFinance';
import { planLotConsumption } from '../worker/lib/inventoryLots';
import { runOrderFinancialEffects } from '../worker/lib/orderFinance';
import { investorOrderSplit, investmentContractSummary } from '../worker/lib/investorFinance';
import { productSelections } from '../worker/lib/inventorySelection';
import { baghdadDay } from '../worker/lib/operations';
import { adminFinancePeopleRoutes } from '../worker/routes/adminFinancePeople';
import { adminFinanceOperationsRoutes } from '../worker/routes/adminFinanceOperations';
import { participantOverview, requestWithdrawal, changeWithdrawalState, payWithdrawal } from '../worker/lib/financeParticipants';
import type { Env } from '../worker/lib/types';

async function setup(){
  const raw=freshDb();raw.exec(`INSERT INTO users(id,email,name,role,admin_scope) VALUES ('owner','boss@x.co','Owner','admin','full'),('investor','investor@x.co','Investor','admin','assistant'),('customer','customer@x.co','Customer','customer',NULL);
    INSERT INTO products(id,name,slug,price_iqd,product_cost_iqd,stock,inventory_mode) VALUES ('a1','Bambu Lab A1','funded-a1',965000,500000,0,'OPTION'),('part','Part','funded-part',50000,NULL,0,'BASE');
    INSERT INTO product_option_groups(id,product_id,name_en) VALUES('model','a1','Model');
    INSERT INTO product_option_values(id,product_id,group_id,name_en,stock) VALUES('combo','a1','model','Combo',0);`);
  const db=asD1(raw),app=stubApp(db,{id:'owner',email:'boss@x.co',role:'admin',admin_scope:'full'},a=>{a.route('/p',adminProcurementRoutes);a.route('/i',adminInvestmentFinanceRoutes);a.route('/people',adminFinancePeopleRoutes);a.route('/ops',adminFinanceOperationsRoutes);});
  const profile=await post(app,'/i/profiles',{user_id:'investor',default_profit_share_bps:3500,default_loss_share_bps:0});assert.equal(profile.status,200,JSON.stringify(await json(profile)));
  const payload=(extra:Record<string,unknown>={})=>({operation_id:crypto.randomUUID(),currency:'IQD',purchase_day:baghdadDay(),status:'ordered',cost_state:'final',lines:[{product_id:'a1',scope:'option',scope_id:'combo',qty_ordered:5,purchase_cost_mode:'total',source_total_amount:2500000,selling_price_iqd:965000}],charges:[{title:'شحن إلى المخزن',amount_iqd:500000,basis:'quantity'}],funding:{mode:'investor',user_id:'investor',agreed_iqd:3000000,received_iqd:3000000,reference:'INVESTOR-CASH',profit_share_bps:3500,loss_share_bps:0},...extra});
  async function create(body=payload()){const res=await post(app,'/p/documents',body),data=await json(res);assert.equal(res.status,200,JSON.stringify(data));return {id:data.id as string,body,detail:await json(await get(app,`/p/documents/${data.id}`))};}
  async function receive(id:string,detail:Awaited<ReturnType<typeof json>>,qty?:number){const body={operation_id:crypto.randomUUID(),lines:detail.lines.map((l:{line_id:string;qty_ordered:number;qty_received:number})=>({line_id:l.line_id,qty:qty??l.qty_ordered-l.qty_received}))};const res=await post(app,`/p/documents/${id}/receive`,body);assert.equal(res.status,200,JSON.stringify(await json(res)));return body;}
  async function sale(id:string,qty=1,delivered=true){
    const total=qty*965000,now=new Date().toISOString();raw.prepare(`INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_iqd,created_at,delivered_at) VALUES (?,'customer',?,'{}','standard','{}','cash',?,1500,?,?,0,?,?)`).run(id,delivered?'delivered':'confirmed',total,total,total,now,delivered?now:null);
    raw.prepare(`INSERT INTO order_items(id,order_id,product_id,option_id,name_snapshot,qty,unit_price_iqd,line_total_iqd) VALUES (?,?,'a1','combo','A1 Combo',?,965000,?)`).run(`item:${id}`,id,qty,total);
    const plan=await planLotConsumption(db,id,[{product_id:'a1',line_id:`item:${id}`,qty,targets:[{scope:'option',scope_id:'combo',stock:5,reserved:0,low_stock_threshold:0,label:'Combo'}]}]);await db.batch(plan.statements);
    raw.prepare("INSERT INTO finance_collections(id,order_id,payer,amount_iqd,collection_day,actor_id,created_at) VALUES (?,?,'customer',?,?,'owner',?)").run(`cash:${id}`,id,total,baghdadDay(),now);
    if(delivered)try{await runOrderFinancialEffects({DB:db} as Env,id,'delivered');}catch(e){throw new Error(`${String(e)}: ${JSON.stringify(all(raw,'SELECT event_key,message FROM finance_posting_errors'))}`);}return await investorOrderSplit(db,id);
  }
  return {raw,db,app,payload,create,receive,sale};
}

test('five A1 Combo units cost exactly 3,000,000; actual delivered profit is 127,750 investor / 237,250 owner',async()=>{
  const x=await setup(),p=await x.create();assert.equal(p.detail.ordered_total_iqd,3000000);assert.equal(count(x.raw,"SELECT stock n FROM product_option_values WHERE id='combo'"),0);
  await x.receive(p.id,p.detail);assert.equal(count(x.raw,'SELECT SUM(total_cost_iqd) n FROM inventory_lots'),3000000);assert.equal(count(x.raw,'SELECT unit_cost_iqd n FROM inventory_lots LIMIT 1'),600000);
  const split=await x.sale('delivered');assert.equal(split.investor_profit_iqd,127750);assert.equal(split.owner_profit_iqd,237250);assert.equal(split.allocations[0].capital_iqd,600000);
  x.raw.exec("INSERT INTO expense_categories(id,slug,name_ar) VALUES('direct','funding-direct','مصاريف مباشرة');INSERT INTO operating_expenses(id,category_id,amount_iqd,expense_day,title) VALUES('cost','direct',10000,'2026-10-05','Direct');INSERT INTO finance_expense_links(expense_id,order_id) VALUES('cost','delivered');");
  const actual=await investorOrderSplit(x.db,'delivered');assert.equal(actual.investor_profit_iqd,124250);assert.equal(actual.owner_profit_iqd,230750);
});

test('purchase totals and freight remainders survive partial receiving and every FIFO dinar',async()=>{
  const x=await setup(),p=await x.create(x.payload({lines:[{product_id:'a1',scope:'option',scope_id:'combo',qty_ordered:5,purchase_cost_mode:'total',source_total_amount:2500002}],charges:[{title:'Freight',amount_iqd:500001,basis:'quantity'}],funding:{mode:'store'}}));
  await x.receive(p.id,p.detail,2);await x.receive(p.id,await json(await get(x.app,`/p/documents/${p.id}`)));
  assert.equal(count(x.raw,'SELECT SUM(total_cost_iqd) n FROM inventory_lots'),3000003);assert.equal(count(x.raw,'SELECT SUM(qty_received*unit_cost_iqd) n FROM inventory_lots'),3000003);
  await x.sale('all-pieces',5);assert.equal(count(x.raw,'SELECT SUM(cogs_iqd) n FROM order_item_inventory_allocations'),3000003);
});

test('funding is allocated once across items; agreement is not cash and overfunding stays unallocated',async()=>{
  const x=await setup(),p=await x.create(x.payload({lines:[{product_id:'a1',scope:'option',scope_id:'combo',qty_ordered:5,purchase_cost_mode:'total',source_total_amount:2500000},{product_id:'part',scope:'base',scope_id:'',qty_ordered:5,purchase_cost_mode:'total',source_total_amount:500000}],charges:[],funding:{mode:'investor',user_id:'investor',agreed_iqd:2000000,received_iqd:0}}));
  assert.equal(count(x.raw,'SELECT SUM(principal_iqd) n FROM investment_contracts'),2000000);assert.equal(count(x.raw,"SELECT COALESCE(SUM(amount_iqd),0) n FROM investor_finance_events WHERE kind='funding'"),0);
  assert.equal(p.detail.funding.store_contribution_iqd,1000000);assert.equal(p.detail.funding.funding_shortfall_iqd,2000000);
  const receipt={operation_id:crypto.randomUUID(),amount_iqd:2200000,reference:'BANK-RECEIPT'};assert.equal((await post(x.app,`/p/documents/${p.id}/investor-receipts`,receipt)).status,200);
  assert.equal((await post(x.app,`/p/documents/${p.id}/investor-receipts`,receipt)).status,200);
  const detail=await json(await get(x.app,`/p/documents/${p.id}`));assert.equal(detail.funding.received_iqd,2200000);assert.equal(detail.funding.unallocated_iqd,200000);
  assert.equal(count(x.raw,"SELECT SUM(amount_iqd) n FROM investor_finance_events WHERE kind='funding'"),2000000);assert.equal(count(x.raw,"SELECT SUM(debit_iqd-credit_iqd) n FROM accounting_lines WHERE account_code='1000'"),2200000);
  assert.equal((await post(x.app,'/p/documents',p.body)).status,200);assert.equal(count(x.raw,'SELECT COUNT(*) n FROM investment_contracts'),2);
});

test('changing investor defaults leaves previous agreements untouched and uses the new default for later batches',async()=>{
  const x=await setup(),first=await x.create();assert.equal((await post(x.app,'/i/profiles',{user_id:'investor',version:1,default_profit_share_bps:4000})).status,200);
  const next=await x.create(x.payload({funding:{mode:'investor',user_id:'investor',agreed_iqd:3000000,received_iqd:0}}));
  assert.equal(first.detail.funding.profit_share_bps,3500);assert.equal(next.detail.funding.profit_share_bps,4000);
  assert.deepEqual(all<{profit_share_bps:number}>(x.raw,'SELECT DISTINCT profit_share_bps FROM investment_contracts ORDER BY profit_share_bps'),[{profit_share_bps:3500},{profit_share_bps:4000}]);
  assert.equal((await post(x.app,'/i/profiles',{user_id:'customer',default_profit_share_bps:3500})).status,400);
});

test('a prepaid undelivered funded item creates no withdrawable investor profit',async()=>{
  const x=await setup(),p=await x.create();await x.receive(p.id,p.detail);const split=await x.sale('prepaid',1,false);assert.equal(split.investor_profit_iqd,0);assert.equal(split.allocations[0].eligible,false);
  assert.equal(count(x.raw,"SELECT COALESCE(SUM(amount_iqd),0) n FROM finance_investor_earnings WHERE kind='investor_profit'"),0);
});

test('cost suggestions ignore unconfirmed incoming drafts and preserve unknown costs',async()=>{
  const x=await setup();let selections=await productSelections(x.db,'part');assert.equal(selections[0].purchase_unit_iqd,null);assert.equal(selections[0].cost_source,'unknown');
  const p=await x.create();selections=await productSelections(x.db,'a1');assert.equal(selections[0].cost_source,'catalogue');
  await x.receive(p.id,p.detail);selections=await productSelections(x.db,'a1');assert.equal(selections[0].cost_source,'confirmed_purchase');assert.equal(selections[0].purchase_unit_iqd,500000);assert.equal(selections[0].option_id,'combo');assert.ok(selections[0].cost_date);
  assert.equal(count(x.raw,'SELECT COUNT(*) n FROM investments'),0);
});

test('partial funding keeps every principal dinar through physical lots and is never included in profit',async()=>{
 const x=await setup(),p=await x.create(x.payload({funding:{mode:'investor',user_id:'investor',agreed_iqd:1000003,received_iqd:1000003,reference:'PARTIAL'}}));
 await x.receive(p.id,p.detail,2);await x.receive(p.id,await json(await get(x.app,`/p/documents/${p.id}`)));
 assert.equal(count(x.raw,'SELECT SUM(unit_principal_iqd*qty) n FROM purchase_investor_lot_capital'),1000003);
 const split=await x.sale('funded-all',5);assert.equal(split.allocations.reduce((n,a)=>n+a.capital_iqd,0),1000003);assert.equal(split.investor_profit_iqd,638750);assert.equal(split.owner_profit_iqd,1186250);
 assert.equal(count(x.raw,"SELECT accrued_iqd n FROM finance_investor_earnings WHERE kind='investor_profit'"),638750);
});


test('retroactive wages correct the paid investor only, preserve principal, and expose open investor withdrawals in the preview',async()=>{
 const x=await setup(),p=await x.create();await x.receive(p.id,p.detail);await x.sale('sold');
 const contract=all<{id:string}>(x.raw,'SELECT id FROM investment_contracts')[0].id,env={DB:x.db} as Env;
 await requestWithdrawal(env,'investor','withdraw-investor-paid',127750);
 await changeWithdrawalState(x.db,'withdraw-investor-paid','owner','approve');
 await payWithdrawal(x.db,'owner','withdraw-investor-paid',{id:'cash-investor-paid',amount:127750,reference:'cash',receipt_url:''});
 x.raw.exec("INSERT INTO users(id,email,name,role,admin_scope) VALUES('staff','staff@x.co','Worker','admin','assistant')");
 const staff=await json(await post(x.app,'/people/staff',{user_id:'staff',start_work_date:'2026-09-01'}));
 const rule=await json(await post(x.app,'/ops/rules',{staff_id:staff.id,basis:'unit',amount:10000}));
 let job=await json(await post(x.app,`/people/staff/${staff.id}/reconcile`,{}));while(job.reconciliation.state!=='complete'){assert.notEqual(job.reconciliation.state,'failed',JSON.stringify(job));job=await json(await post(x.app,`/people/staff/${staff.id}/reconcile`,{}));}
 let own=await participantOverview(x.db,'investor');assert.equal(own.summary.investor_profit_debt_iqd,3500);assert.equal(own.summary.available_capital_iqd,600000);assert.equal(own.summary.earnings_paid_iqd,127750);
 await x.sale('another');own=await participantOverview(x.db,'investor');assert.equal(own.summary.investor_profit_debt_iqd,0);assert.equal(own.summary.available_earnings_iqd,120750);
 await requestWithdrawal(env,'investor','withdraw-investor-open',120750);
 const body={amount:20000,basis:'unit',version:1,effective_from:baghdadDay(),reason:'زيادة أجر التجهيز بأثر رجعي'};
 const response=await post(x.app,`/people/rules/${rule.id}/preview`,body),preview=await json(response);assert.equal(response.status,200,JSON.stringify(preview));assert.equal(preview.investor_delta_iqd,-7000);assert.ok(preview.withdrawals.some((w:{id:string})=>w.id==='withdraw-investor-open'));
 const apply=await post(x.app,`/people/rules/${rule.id}/apply`,{...body,preview_token:preview.preview_token,operation_id:crypto.randomUUID(),release_withdrawals:true});assert.equal(apply.status,200,JSON.stringify(await json(apply)));
 job=await json(await post(x.app,`/people/staff/${staff.id}/reconcile`,{}));while(job.reconciliation.state!=='complete'){assert.notEqual(job.reconciliation.state,'failed');job=await json(await post(x.app,`/people/staff/${staff.id}/reconcile`,{}));}
 own=await participantOverview(x.db,'investor');assert.equal(own.summary.available_earnings_iqd,113750);assert.equal(own.summary.available_capital_iqd,1200000);assert.equal((await investmentContractSummary(x.db,contract)).summary.available_profit_iqd,113750);
 const profile=await json(await get(x.app,`/i/profiles?from=${baghdadDay()}&to=${baghdadDay()}`));assert.equal(profile.profiles[0].period.earned_iqd,241500);assert.equal(profile.profiles[0].period.paid_iqd,127750);
 const empty=await json(await get(x.app,'/i/profiles?month=2026-01'));assert.equal(empty.profiles[0].period.earned_iqd,0);assert.equal(empty.profiles[0].balance.available_earnings_iqd,113750);
});
