import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {freshDb,dbThrough,asD1,stubApp,post,get,json,count,row} from './fixtures/app';
import type {SqliteStatement} from './fixtures/d1';
import {adminInvestmentFinanceRoutes} from '../worker/routes/adminInvestmentFinance';
import {adminStockOperationsRoutes} from '../worker/routes/adminStockOperations';
import {investorOrderSplit,syncInvestorOrder,investorParticipantSources,investmentContractSummary,validateInvestorReturnEvidence,recognizeLateCosts} from '../worker/lib/investorFinance';
import {getOrderProfitBase} from '../worker/lib/orderProfit';
import {fifoQueues,planLotConsumption,planLotRestore} from '../worker/lib/inventoryLots';
import {baghdadDay,journalPlan} from '../worker/lib/operations';
import {recordReturnFinancials,runOrderFinancialEffects} from '../worker/lib/orderFinance';
import {requestWithdrawal,changeWithdrawalState,payWithdrawal,participantOverview} from '../worker/lib/financeParticipants';
import {adminFinancePeopleRoutes} from '../worker/routes/adminFinancePeople';
import {adminFinanceOperationsRoutes} from '../worker/routes/adminFinanceOperations';
import {continueStaffReconciliation} from '../worker/lib/financeStaffAccrual';
import {adminInventoryRoutes} from '../worker/routes/adminInventory';
import type {Env} from '../worker/lib/types';
import { drainOrderFinanceRecovery } from '../worker/lib/financeOrderRecovery';
import { adminFinanceWorkspaceRoutes } from '../worker/routes/adminFinanceWorkspace';
const ADMIN={id:'admin',email:'boss@x.co',role:'admin' as const};
function setup(){
  const raw=freshDb();raw.exec(`INSERT INTO users(id,email,role,admin_scope,name) VALUES ('admin','boss@x.co','admin','full','Owner'),('investor','investor@x.co','admin','assistant','Investor'),('other','other@x.co','admin','assistant','Other'),('buyer','buyer@x.co','customer',NULL,'Buyer');
    INSERT INTO inventory_suppliers(id,name) VALUES ('supplier','Supplier');
    INSERT INTO products(id,name,name_ar,slug,sku,price_iqd,product_cost_iqd,stock,inventory_mode) VALUES ('part','Part','قطعة','inv-part','INV',500,100,6,'BASE'),('foreign','Foreign','آخر','inv-foreign','OTHER',500,100,0,'BASE');
    INSERT INTO stock_locations(id,name,kind) VALUES ('loc','Shelf','shelf');
    INSERT INTO incoming_inventory(id,product_id,scope,scope_id,qty_ordered,qty_received,purchase_unit_iqd,shipping_total_iqd,internal_delivery_total_iqd,supplier_id,status,created_by) VALUES ('inc-a','part','base','',3,3,100,0,0,'supplier','received','admin'),('inc-b','part','base','',3,3,200,0,0,'supplier','received','admin');
    INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,total_cost_iqd,cost_basis,received_at,incoming_id,supplier_id) VALUES ('lot-a','part','base','',3,3,100,300,'received','2026-01-01','inc-a','supplier'),('lot-b','part','base','',3,3,200,600,'received','2026-02-01','inc-b','supplier');`);
  const real=asD1(raw);let gate:{fragment:string;entered:()=>void;resumed:Promise<void>}|undefined;
  const db={prepare:(sql:string)=>real.prepare(sql),async batch(statements:SqliteStatement[]){const pending=gate;if(pending&&statements.some(s=>s.sql.includes(pending.fragment))){gate=undefined;pending.entered();await pending.resumed;}return real.batch(statements as unknown as D1PreparedStatement[]);}} as unknown as D1Database;
  const app=stubApp(db,ADMIN,a=>{a.route('/i',adminInvestmentFinanceRoutes);a.route('/s',adminStockOperationsRoutes);a.route('/stock',adminInventoryRoutes);});
  const pauseOn=(fragment:string)=>{let entered!:()=>void,resume!:()=>void;const waiting=new Promise<void>(r=>entered=r),resumed=new Promise<void>(r=>resume=r);gate={fragment,entered,resumed};return{waiting,resume};};
  return{raw,db,app,pauseOn};
}
async function contract(s:ReturnType<typeof setup>,incoming='inc-a',user='investor',over:Record<string,unknown>={}){
  const body={operation_id:crypto.randomUUID(),incoming_id:incoming,user_id:user,name:'تمويل قطع',principal_iqd:incoming==='inc-a'?300:600,capital_share_bps:10000,profit_share_bps:3500,loss_share_bps:10000,...over};
  const res=await post(s.app,'/i/contracts',body);assert.equal(res.status,200,JSON.stringify(await json(res.clone())));
  return body;
}
async function fund(s:ReturnType<typeof setup>,id:string,amount:number){const body={operation_id:crypto.randomUUID(),amount_iqd:amount,payment_day:baghdadDay(),reference:'cash receipt'};const res=await post(s.app,`/i/contracts/${id}/funding`,body);assert.equal(res.status,200,JSON.stringify(await json(res.clone())));return body;}
async function sale(s:ReturnType<typeof setup>,id='order',lots=['lot-a','lot-b'],paid=true,unit=500,ownerLine=false){
  const qty=lots.length,total=qty*unit+(ownerLine?unit:0);
  s.raw.prepare(`INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_iqd,created_at,delivered_at) VALUES (?,'buyer','delivered','{}','standard','{}','cash',?,1500,?,?,0,?,?)`).run(id,total,total,total,new Date().toISOString(),new Date().toISOString());
  s.raw.prepare(`INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis) VALUES (?,?,'part','قطعة',?,?,?,100,'snapshot')`).run(`${id}-item`,id,qty,unit,qty*unit);
  let cogs=0;
  for(const [i,lot] of lots.entries()){const cost=count(s.raw,'SELECT unit_cost_iqd n FROM inventory_lots WHERE id=?',lot);cogs+=cost;s.raw.prepare('INSERT INTO order_item_inventory_allocations(id,order_id,order_item_id,lot_id,scope,scope_id,qty,unit_cost_iqd,cogs_iqd,idempotency_key) VALUES (?,?,?,?,\'base\',\'\',1,?,?,?)').run(`${id}-a${i}`,id,`${id}-item`,lot,cost,cost,`${id}:${lot}`);s.raw.prepare('UPDATE inventory_lots SET qty_remaining=qty_remaining-1 WHERE id=?').run(lot);}
  if(ownerLine){
    s.raw.prepare("INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis) VALUES(?,?,'foreign','Owner product',1,?,?,100,'snapshot')").run(`${id}-owner-line`,id,unit,unit);
    cogs+=100;
  }
  s.raw.prepare("UPDATE products SET stock=stock-? WHERE id='part'").run(qty);
  if(paid)s.raw.prepare("INSERT INTO finance_collections(id,order_id,payer,amount_iqd,collection_day,actor_id,created_at) VALUES (?,?,'customer',?,?,'admin',?)").run(`${id}-collection`,id,total,baghdadDay(),new Date().toISOString());
  await s.db.batch([...journalPlan(s.db,{key:`sale:${id}`,day:baghdadDay(),title:'Sale',source:'order',sourceId:id,actor:'admin'},[{account:'1100',debit:total},{account:'4000',credit:total}]).statements,...journalPlan(s.db,{key:`cogs:${id}`,day:baghdadDay(),title:'COGS',source:'order',sourceId:id,actor:'admin'},[{account:'5000',debit:cogs},{account:'1200',credit:cogs}]).statements]);
}
test('mixed FIFO origins accrue 35 percent separately, capital is not profit, delivery+collection required and retries immutable',async()=>{
  const s=setup(),a=await contract(s),b=await contract(s,'inc-b','other');await fund(s,a.operation_id,300);await fund(s,b.operation_id,600);await sale(s,'order',undefined,false);
  await syncInvestorOrder(s.db,'order',{actor:'admin'});
  assert.equal((await investorParticipantSources(s.db,'investor')).find(x=>x.kind==='investor_profit')?.amount_iqd,0);
  s.raw.exec("INSERT INTO finance_collections(id,order_id,payer,amount_iqd,collection_day,actor_id,created_at) VALUES ('collect','order','customer',1000,'2026-10-04','admin','2026-10-04')");
  await syncInvestorOrder(s.db,'order',{actor:'admin'});const split=await investorOrderSplit(s.db,'order');
  assert.deepEqual(split.allocations.map(a=>[a.user_id,a.profit_iqd,a.capital_iqd]),[['investor',140,100],['other',105,200]]);
  const before=count(s.raw,'SELECT COUNT(*) n FROM investor_finance_events');await syncInvestorOrder(s.db,'order',{actor:'admin'});assert.equal(count(s.raw,'SELECT COUNT(*) n FROM investor_finance_events'),before);
  assert.equal((await investmentContractSummary(s.db,a.operation_id)).summary.available_profit_iqd,140);
  assert.equal(count(s.raw,'SELECT SUM(debit_iqd-credit_iqd) n FROM accounting_lines'),0);
});

test('uncollected delivered capital is visible as pending capital without becoming withdrawable',async()=>{
  const s=setup(),c=await contract(s);await fund(s,c.operation_id,300);
  await sale(s,'uncollected',['lot-a'],false);await syncInvestorOrder(s.db,'uncollected');
  const account=await participantOverview(s.db,'investor');
  assert.equal(account.summary.capital_iqd,100);
  assert.equal(account.summary.available_capital_iqd,0);
  assert.equal(account.summary.investor_profit_iqd,140);
  assert.equal(account.summary.available_earnings_iqd,0);
  assert.equal(account.summary.pending_iqd,240);
  assert.equal(account.summary.capital_pending_iqd,100);
  await assert.rejects(requestWithdrawal({DB:s.db} as Env,'investor','no-invented-cash',1,'capital'));
  s.raw.exec("INSERT INTO finance_collections(id,order_id,payer,amount_iqd,collection_day,actor_id,created_at) VALUES ('actual-collection','uncollected','customer',500,'2026-10-24','admin','2026-10-24')");
  await syncInvestorOrder(s.db,'uncollected');
  const collected=await participantOverview(s.db,'investor');
  assert.equal(collected.summary.capital_iqd,100);
  assert.equal(collected.summary.available_capital_iqd,100);
  assert.equal(collected.summary.available_earnings_iqd,140);
  assert.equal(collected.summary.pending_iqd,0);
});

test('an investor awaiting an unrelated cost cannot stop staff reconciliation or withhold an independently known fixed wage',async()=>{
  const s=setup(),c=await contract(s);await fund(s,c.operation_id,300);
  s.raw.exec("UPDATE finance_staff SET user_id='other',start_work_date='2026-01-01' WHERE id='staff_hussein'");
  const owner=stubApp(s.db,ADMIN,a=>a.route('/operations',adminFinanceOperationsRoutes));
  const added=await post(owner,'/operations/rules',{staff_id:'staff_hussein',basis:'order',amount:2500,milestone:'delivered'});
  assert.equal(added.status,200,JSON.stringify(await json(added)));
  await sale(s,'mixed-unknown',['lot-a'],false,5000);
  s.raw.exec("INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_basis) VALUES('unknown-line','mixed-unknown','foreign','Accessory without confirmed cost',1,100,100,'unrecorded')");
  await sale(s,'z-later-known',['lot-a'],true,5000);
  const job=await continueStaffReconciliation({DB:s.db} as Env,'staff_hussein');
  assert.equal(job?.state,'complete',JSON.stringify(job));
  const wage=await participantOverview(s.db,'other');
  assert.equal(job?.processed_orders,2,'the later known order is not starved by missing investor evidence');
  assert.equal(wage.summary.staff_iqd,5000);
  assert.equal(wage.summary.staff_available_iqd,5000);
  assert.equal((await participantOverview(s.db,'investor')).summary.available_earnings_iqd,0);
  assert.ok(count(s.raw,"SELECT COUNT(*) n FROM finance_posting_errors WHERE event_key='investor-pending:mixed-unknown'"),'the owner still sees the unresolved investor cost');
});
test('an investor bears only the wages assigned to the funded product, including per-order scoped pay',async()=>{
  const s=setup(),c=await contract(s);await fund(s,c.operation_id,300);
  s.raw.exec("UPDATE finance_staff SET user_id='other',start_work_date='2026-01-01' WHERE id='staff_hussein'");
  const owner=stubApp(s.db,ADMIN,a=>a.route('/operations',adminFinanceOperationsRoutes));
  const added=await post(owner,'/operations/rules',{staff_id:'staff_hussein',basis:'order',amount:2500,milestone:'delivered',scope:{catalog_ids:[],product_ids:['part'],excluded_product_ids:[]}});
  assert.equal(added.status,200,JSON.stringify(await json(added)));
  await sale(s,'scoped-investor',['lot-a'],true,5000,true);
  const job=await continueStaffReconciliation({DB:s.db} as Env,'staff_hussein');
  assert.equal(job?.state,'complete',JSON.stringify(job));
  const split=await investorOrderSplit(s.db,'scoped-investor');
  assert.equal(split.pending,false);
  assert.equal(split.investor_profit_iqd,840,'(5000 revenue - 100 actual cost - 2500 printer wage) × 35%');
  assert.equal((await participantOverview(s.db,'investor')).summary.investor_profit_available_iqd,840);
});
test('investor-only recovery deducts coupons, points, credited protection and monthly expenses from historical profit',async()=>{
  const s=setup(),c=await contract(s);await fund(s,c.operation_id,300);await sale(s,'order',['lot-a']);await syncInvestorOrder(s.db,'order');
  await requestWithdrawal({DB:s.db} as Env,'investor','net-paid',100,'earnings');
  await changeWithdrawalState(s.db,'net-paid','admin','approve');
  await payWithdrawal(s.db,'admin','net-paid',{id:'net-receipt',reference:'cash',receipt_url:''});
  const paid=row(s.raw,"SELECT * FROM finance_withdrawal_payments WHERE id='net-receipt'");
  s.raw.exec(`UPDATE orders SET points_discount_iqd=20,coupon_snapshot='{"discount_iqd":130}',coupon_discount_iqd=130 WHERE id='order';
    UPDATE order_items SET coupon_discount_iqd=30 WHERE id='order-item';
    INSERT INTO price_protection_claims(id,user_id,order_id,order_item_id,original_unit_iqd,observed_unit_iqd,qty,credited_iqd,state)
      VALUES ('net-credit','buyer','order','order-item',500,450,1,50,'credited');
    INSERT INTO expense_categories(id,slug,name_ar) VALUES ('net-expenses','net-expenses','Expenses');`);
  s.raw.prepare('INSERT INTO operating_expenses(id,category_id,amount_iqd,expense_day,title) VALUES (?,?,?,?,?)').run('net-rent','net-expenses',60,baghdadDay(),'Rent');
  assert.equal((await participantOverview(s.db,'investor')).summary.available_earnings_iqd,0);
  await assert.rejects(requestWithdrawal({DB:s.db} as Env,'investor','net-stale',1,'earnings'));
  const report=await drainOrderFinanceRecovery({DB:s.db} as Env);
  assert.equal(report.completed,1,JSON.stringify(report));
  const summary=(await participantOverview(s.db,'investor')).summary;
  assert.equal(summary.investor_profit_iqd,49,'(500 - 100 cost - 30 line coupon - 20 points - 100 residual coupon - 50 credit - 60 rent) × 35%');
  assert.equal(summary.earnings_paid_iqd,100);
  assert.deepEqual(row(s.raw,"SELECT * FROM finance_withdrawal_payments WHERE id='net-receipt'"),paid);
  assert.equal(count(s.raw,"SELECT SUM(amount_iqd) n FROM investor_finance_events WHERE kind='profit_correction'"),-91);
  const reportApp=stubApp(s.db,ADMIN,app=>app.route('/workspace',adminFinanceWorkspaceRoutes));
  const owner=await get(reportApp,`/workspace/summary?from=${baghdadDay().slice(0,7)}-01&to=${baghdadDay()}`);
  assert.equal(owner.status,200);
  assert.equal((await json(owner)).totals.owner_period_net_after_report_adjustments_iqd,91,'owner receives the same net 140 less investor 49; deductions are not doubled');
  const events=count(s.raw,'SELECT COUNT(*) n FROM investor_finance_events');
  assert.equal((await drainOrderFinanceRecovery({DB:s.db} as Env)).scanned,0);
  assert.equal(count(s.raw,'SELECT COUNT(*) n FROM investor_finance_events'),events);
});
test('store promotion repairs historical investor profit and capital losses without changing payments or later blocking withdrawals',async()=>{
  const s=setup(),c=await contract(s);await fund(s,c.operation_id,300);await sale(s,'order',['lot-a']);await syncInvestorOrder(s.db,'order');
  await requestWithdrawal({DB:s.db} as Env,'investor','promotion-paid',100,'earnings');
  await changeWithdrawalState(s.db,'promotion-paid','admin','approve');
  await payWithdrawal(s.db,'admin','promotion-paid',{id:'promotion-receipt',reference:'cash',receipt_url:''});
  const paid=row(s.raw,"SELECT * FROM finance_withdrawal_payments WHERE id='promotion-receipt'");
  s.raw.exec("INSERT INTO expense_categories(id,slug,name_ar) VALUES ('old-ad','old-ad','Promotion')");
  s.raw.prepare('INSERT INTO operating_expenses(id,category_id,amount_iqd,expense_day,title) VALUES (?,?,?,?,?)').run('old-ad-cost','old-ad',1000,baghdadDay(),'Promotion');
  await syncInvestorOrder(s.db,'order');
  assert.equal((await participantOverview(s.db,'investor')).summary.investor_profit_iqd,0);
  assert.ok(count(s.raw,'SELECT SUM(amount_iqd) n FROM investor_capital_losses')>0);
  s.raw.prepare(`INSERT INTO finance_monthly_promotions(id,month,currency,amount_minor,exchange_rate,amount_iqd,expense_id,created_by,created_at,updated_at)
    VALUES ('store-promotion',?,'IQD',1000,1,1000,'old-ad-cost','admin',?,?)`).run(baghdadDay().slice(0,7),baghdadDay(),baghdadDay());
  const old=row<{snapshot:string}>(s.raw,"SELECT snapshot FROM investor_allocation_results WHERE allocation_id='order-a0'")!;
  const currentSource=(await investorOrderSplit(s.db,'order')).source_fingerprint;assert.ok(currentSource);
  const snapshot=JSON.parse(old.snapshot),fingerprint=JSON.parse(currentSource);
  fingerprint[5]=[['store-promotion',1000,1]];fingerprint[7]=[['order-item',1]];snapshot.source_fingerprint=JSON.stringify(fingerprint);
  s.raw.prepare("UPDATE investor_allocation_results SET snapshot=? WHERE allocation_id='order-a0'").run(JSON.stringify(snapshot));
  const repair=await drainOrderFinanceRecovery({DB:s.db} as Env);
  assert.equal(repair.completed,1,JSON.stringify(repair));
  const restored=(await participantOverview(s.db,'investor')).summary;
  assert.deepEqual([restored.investor_profit_iqd,restored.earnings_paid_iqd,restored.available_earnings_iqd,restored.investor_profit_debt_iqd],[140,100,40,0]);
  assert.equal(count(s.raw,'SELECT SUM(amount_iqd) n FROM investor_capital_losses'),0,'promotion cannot consume funded capital');
  assert.deepEqual(row(s.raw,"SELECT * FROM finance_withdrawal_payments WHERE id='promotion-receipt'"),paid);
  const basis=(await investorOrderSplit(s.db,'order')).source_fingerprint;
  s.raw.exec("UPDATE finance_monthly_promotions SET amount_iqd=5000,amount_minor=5000 WHERE id='store-promotion'");
  assert.equal((await investorOrderSplit(s.db,'order')).source_fingerprint,basis);
  assert.equal((await participantOverview(s.db,'investor')).summary.available_earnings_iqd,40);
  const reportApp=stubApp(s.db,ADMIN,app=>app.route('/workspace',adminFinanceWorkspaceRoutes));
  const owner=await json(await get(reportApp,`/workspace/summary?from=${baghdadDay().slice(0,7)}-01&to=${baghdadDay()}`));
  assert.equal(owner.totals.promotion_iqd,5000);
  assert.equal(owner.totals.owner_period_net_after_report_adjustments_iqd,-4740,'only the owner bears promotion after the unchanged 140 investor share');
  const events=count(s.raw,'SELECT COUNT(*) n FROM investor_finance_events');
  assert.equal((await drainOrderFinanceRecovery({DB:s.db} as Env)).scanned,0);
  assert.equal(count(s.raw,'SELECT COUNT(*) n FROM investor_finance_events'),events);
  assert.equal(count(s.raw,'SELECT SUM(debit_iqd-credit_iqd) n FROM accounting_lines'),0);
});
test('contract shares enforce 100 percent, immutable funded terms, and unused contract can be voided and replaced',async()=>{
  const s=setup(),a=await contract(s,'inc-a','investor',{capital_share_bps:6000,profit_share_bps:2100,loss_share_bps:6000,principal_iqd:180});
  const bad=await post(s.app,'/i/contracts',{...a,operation_id:crypto.randomUUID(),user_id:'other',capital_share_bps:6000});assert.equal(bad.status,409);
  const op={operation_id:crypto.randomUUID()};assert.equal((await post(s.app,`/i/contracts/${a.operation_id}/void`,op)).status,200);assert.equal((await post(s.app,`/i/contracts/${a.operation_id}/void`,op)).status,200);
  const next=await contract(s);await fund(s,next.operation_id,300);assert.equal((await post(s.app,`/i/contracts/${next.operation_id}/void`,{operation_id:crypto.randomUUID()})).status,409);
  assert.throws(()=>s.raw.prepare('UPDATE investment_contracts SET profit_share_bps=1 WHERE id=?').run(next.operation_id),/immutable/);
});
test('one funded plus one unfunded lot requires exact return evidence and restoration follows chosen lot',async()=>{
  const s=setup();await contract(s);await sale(s);s.raw.exec("INSERT INTO return_cases(id,order_id,order_item_id,user_id,qty,reason,state) VALUES ('return','order','order-item','buyer',1,'defective','received')");
  await assert.rejects(validateInvestorReturnEvidence(s.db,'return'),/دفعة/);
  let res=await post(s.app,'/s/return-inspections',{operation_id:crypto.randomUUID(),return_case_id:'return',disposition:'restock'});assert.equal(res.status,400);
  res=await post(s.app,'/s/return-inspections',{operation_id:crypto.randomUUID(),return_case_id:'return',disposition:'restock',allocations:[{allocation_id:'order-a1',qty:1}]});assert.equal(res.status,200,JSON.stringify(await json(res.clone())));
  await validateInvestorReturnEvidence(s.db,'return');const plan=await planLotRestore(s.db,'order',{lineIds:['order-item'],qtyByLine:{'order-item':1},operation:'return:return'});assert.deepEqual(plan.allocations.map(a=>a.lot_id),['lot-b']);await s.db.batch(plan.statements);
  assert.equal(count(s.raw,"SELECT qty_remaining n FROM inventory_lots WHERE id='lot-a'"),2);assert.equal(count(s.raw,"SELECT qty_remaining n FROM inventory_lots WHERE id='lot-b'"),3);
  assert.equal((await planLotRestore(s.db,'order',{lineIds:['order-item'],qtyByLine:{'order-item':1},operation:'return:return'})).statements.length,0);
});
test('late landed-cost changes balance stock and sold COGS, stay immutable and FIFO snapshots new cost after transfers',async()=>{
  const s=setup(),c=await contract(s);await fund(s,c.operation_id,300);await sale(s,'order',['lot-a']);await syncInvestorOrder(s.db,'order');
  const body={operation_id:crypto.randomUUID(),incoming_id:'inc-a',new_unit_cost_iqd:150,adjustment_day:baghdadDay()};const res=await post(s.app,'/i/lot-cost-adjustments',body);assert.equal(res.status,200,JSON.stringify(await json(res.clone())));assert.deepEqual((await json(res.clone())).pending_orders,[]);
  assert.equal((await getOrderProfitBase(s.db,'order')).lines[0].cogs_iqd,150);assert.equal((await investorOrderSplit(s.db,'order')).allocations[0].profit_iqd,122);
  assert.equal(count(s.raw,"SELECT unit_cost_iqd n FROM inventory_lots WHERE id='lot-a'"),100);assert.equal(count(s.raw,"SELECT cogs_iqd n FROM order_item_inventory_allocations WHERE id='order-a0'"),100);
  const events=count(s.raw,'SELECT COUNT(*) n FROM investor_finance_events');assert.equal((await post(s.app,'/i/lot-cost-adjustments',body)).status,200);assert.equal(count(s.raw,'SELECT COUNT(*) n FROM investor_finance_events'),events);
  const transfer=await post(s.app,'/s/transfers',{operation_id:crypto.randomUUID(),lot_id:'lot-a',location_id:'loc',qty:1});assert.equal(transfer.status,200,JSON.stringify(await json(transfer.clone())));
  const child=row<{target_lot_id:string}>(s.raw,"SELECT target_lot_id FROM stock_transfers WHERE source_lot_id='lot-a'")!.target_lot_id;
  assert.equal((await fifoQueues(s.db,[{scope:'base',scope_id:'',product_id:'part'}])).get('base:part')?.find(l=>l.id===child)?.unit_cost_iqd,150);
  assert.equal((await json(await get(s.app,'/i/config'))).incoming.find((i:{id:string})=>i.id==='inc-a').total_cost_iqd,450);
  assert.equal((await json(await get(s.app,'/stock/overview'))).inventory_value_iqd,900);
  assert.equal((await json(await get(s.app,'/stock/lines'))).lines[0].inventory_value_iqd,900);
  assert.equal(count(s.raw,'SELECT SUM(debit_iqd-credit_iqd) n FROM accounting_lines'),0);
});
test('linked expense changes and voids immediately block stale investor withdrawals until reconciliation',async()=>{
  const s=setup(),c=await contract(s);await fund(s,c.operation_id,300);await sale(s,'order',['lot-a']);await syncInvestorOrder(s.db,'order');
  s.raw.exec("INSERT INTO expense_categories(id,slug,name_ar) VALUES ('cat','inv-cat','مصاريف');INSERT INTO operating_expenses(id,category_id,amount_iqd,expense_day,title) VALUES ('expense','cat',100,'2026-10-04','مباشر');INSERT INTO finance_expense_links(expense_id,order_id) VALUES ('expense','order')");
  await assert.rejects(requestWithdrawal({DB:s.db} as Env,'investor',crypto.randomUUID(),10),/مستحقات|رصيد|متاح|تسوية/);
  await syncInvestorOrder(s.db,'order');const withdrawal=crypto.randomUUID();await requestWithdrawal({DB:s.db} as Env,'investor',withdrawal,10);await changeWithdrawalState(s.db,withdrawal,'admin','approve');
  s.raw.exec("UPDATE operating_expenses SET voided_at='2026-10-04' WHERE id='expense'");
  await assert.rejects(payWithdrawal(s.db,'admin',withdrawal,{id:crypto.randomUUID(),amount:10,reference:'cash',receipt_url:''}),/مستحقات|مصدر|تسوية/);
  await syncInvestorOrder(s.db,'order');await payWithdrawal(s.db,'admin',withdrawal,{id:crypto.randomUUID(),amount:10,reference:'cash',receipt_url:''});
});
test('capital loss journal cannot consume more than actual funded principal across sales and physical counts',async()=>{
  const s=setup(),c=await contract(s,'inc-a','investor',{principal_iqd:50});await fund(s,c.operation_id,50);
  await sale(s,'loss',['lot-a'],true,1);await syncInvestorOrder(s.db,'loss');
  const split=await investorOrderSplit(s.db,'loss');assert.equal(split.investor_loss_iqd,50);assert.equal(split.owner_profit_iqd,-49);
  assert.equal((await investmentContractSummary(s.db,c.operation_id)).summary.loss_iqd,50);
  assert.equal(count(s.raw,"SELECT SUM(l.credit_iqd-l.debit_iqd) n FROM accounting_lines l WHERE l.account_code='3100'"),0);
  assert.equal((await post(s.app,'/s/lot-counts',{operation_id:crypto.randomUUID(),lot_id:'lot-a',counted_qty:1})).status,200);
  assert.equal((await investmentContractSummary(s.db,c.operation_id)).summary.loss_iqd,50);
  assert.equal(count(s.raw,"SELECT SUM(l.credit_iqd-l.debit_iqd) n FROM accounting_lines l WHERE l.account_code='3100'"),0);
});
test('lot count affects only its lot and capital loss; rejects invented origin units and reserved stock',async()=>{
  const s=setup(),a=await contract(s);await fund(s,a.operation_id,300);
  const body={operation_id:crypto.randomUUID(),lot_id:'lot-a',counted_qty:2};assert.equal((await post(s.app,'/s/lot-counts',body)).status,200);assert.equal((await post(s.app,'/s/lot-counts',body)).status,200);
  assert.equal(count(s.raw,"SELECT qty_remaining n FROM inventory_lots WHERE id='lot-b'"),3);assert.equal(count(s.raw,"SELECT stock n FROM products WHERE id='part'"),5);assert.equal((await investmentContractSummary(s.db,a.operation_id)).summary.loss_iqd,100);
  assert.equal((await post(s.app,'/s/lot-counts',{operation_id:crypto.randomUUID(),lot_id:'lot-a',counted_qty:4})).status,400);
  s.raw.exec("UPDATE products SET stock_reserved=1 WHERE id='part'");assert.equal((await post(s.app,'/s/lot-counts',{operation_id:crypto.randomUUID(),lot_id:'lot-a',counted_qty:1})).status,409);
});
test('raw assistant lot JSON excludes financial ownership, revised cost and adjustments; scanning validates expected selection',async()=>{
  const s=setup();await contract(s);const assistant=stubApp(s.db,{id:'investor',email:'investor@x.co',role:'admin',admin_scope:'assistant'},a=>{a.route('/i',adminInvestmentFinanceRoutes);a.route('/s',adminStockOperationsRoutes);});
  const list=await json(await get(assistant,'/i/lots')),detail=await json(await get(assistant,'/i/lots/lot-a'));for(const body of [list,detail]){const text=JSON.stringify(body);assert.doesNotMatch(text,/unit_cost|principal|profit_share|capital_share|contracts|adjustments/);}
  assert.equal((await get(assistant,'/i/config')).status,403);assert.equal((await post(assistant,'/s/scan',{code:'lot-a',product_id:'foreign'})).status,400);assert.equal((await post(assistant,'/s/scan',{code:'lot-a',product_id:'part',scope:'base',scope_id:''})).status,200);
});
test('concurrent order correction cannot publish stale investor profits and a pending source disables prior availability',async()=>{
  const s=setup(),c=await contract(s);await fund(s,c.operation_id,300);await sale(s,'order',['lot-a']);await syncInvestorOrder(s.db,'order');
  s.raw.exec("UPDATE orders SET price_adjustment_iqd=100 WHERE id='order'");const gate=s.pauseOn('INSERT INTO investor_allocation_results'),work=syncInvestorOrder(s.db,'order');await gate.waiting;
  s.raw.exec("UPDATE orders SET price_adjustment_iqd=200 WHERE id='order'");gate.resume();await assert.rejects(work,/CHECK/);assert.equal((await investorParticipantSources(s.db,'investor')).find(s=>s.kind==='investor_profit')?.amount_iqd,140);
  await syncInvestorOrder(s.db,'order');assert.equal((await investorParticipantSources(s.db,'investor')).find(s=>s.kind==='investor_profit')?.amount_iqd,210);
  // A real unposted refund is a financial source failure, even when numbers
  // remain knowable. Existing liabilities must become unspendable atomically.
  s.raw.exec("INSERT INTO return_cases(id,order_id,order_item_id,user_id,qty,reason,state,resolution) VALUES ('return','order','order-item','buyer',1,'defective','resolved','refund');INSERT INTO finance_refund_facts(case_id,order_id,refund_iqd,qty,disposition,cogs_iqd,refunded_day) VALUES ('return','order',500,1,'damage',100,'2026-10-04')");
  await assert.rejects(syncInvestorOrder(s.db,'order'),/معلقة/);assert.equal((await investorParticipantSources(s.db,'investor')).find(s=>s.kind==='investor_profit')?.amount_iqd,0);
});
test('available contract profit subtracts actual paid and held liabilities and capital remains capped by funded principal',async()=>{
  const s=setup(),a=await contract(s,'inc-a','investor',{principal_iqd:50});await fund(s,a.operation_id,50);await sale(s,'order',['lot-a']);await syncInvestorOrder(s.db,'order');
  s.raw.exec(`INSERT INTO finance_withdrawals(id,user_id,amount_iqd,paid_iqd,state,created_at,updated_at) VALUES ('withdraw','investor',70,20,'part_paid','2026-10-04','2026-10-04');`);
  s.raw.prepare('INSERT INTO finance_withdrawal_allocations(withdrawal_id,source_kind,source_id,amount_iqd,paid_iqd) VALUES (\'withdraw\',\'investor_profit\',?,70,20)').run(`invprofit:${a.operation_id}`);
  const summary=(await investmentContractSummary(s.db,a.operation_id)).summary;assert.equal(summary.available_profit_iqd,70);assert.equal(summary.recovered_capital_iqd,50);assert.equal(summary.paid_profit_iqd,20);
});
test('investor migration is replay-safe on populated tables and hooks degrade before installation',async()=>{
  const s=setup();await contract(s);const before=count(s.raw,'SELECT COUNT(*) n FROM investment_contracts');s.raw.exec(readFileSync(new URL('../migrations/0165_inventory_investors.sql',import.meta.url),'utf8'));assert.equal(count(s.raw,'SELECT COUNT(*) n FROM investment_contracts'),before);
  const old=asD1(dbThrough('0162'));await syncInvestorOrder(old,'missing');await recognizeLateCosts(old,'missing');assert.deepEqual(await investorParticipantSources(old,'missing'),[]);
});
test('FIFO cost-version fence aborts a sale planned before a concurrent landed-cost correction',async()=>{
  const s=setup();s.raw.exec("INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,created_at) VALUES ('order','buyer','confirmed','{}','standard','{}','cash',500,1500,500,500,'2026-10-04');INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd) VALUES ('order-item','order','part','Part',1,500,500)");
  const plan=await planLotConsumption(s.db,'order',[{product_id:'part',line_id:'order-item',qty:1,targets:[{scope:'base',scope_id:'',stock:6,reserved:0,low_stock_threshold:0,label:'Part'}]}]);
  assert.equal((await post(s.app,'/i/lot-cost-adjustments',{operation_id:crypto.randomUUID(),incoming_id:'inc-a',new_unit_cost_iqd:150,adjustment_day:baghdadDay()})).status,200);
  await assert.rejects(s.db.batch(plan.statements),/CHECK/);assert.equal(count(s.raw,"SELECT qty_remaining n FROM inventory_lots WHERE id='lot-a'"),3);assert.equal(count(s.raw,"SELECT COUNT(*) n FROM order_item_inventory_allocations"),0);
});
test('restocked returns reverse investor entitlement and late COGS without deleting paid history',async()=>{
  const s=setup(),c=await contract(s);await fund(s,c.operation_id,300);await sale(s,'order',['lot-a']);await syncInvestorOrder(s.db,'order');
  const adjustment={operation_id:crypto.randomUUID(),incoming_id:'inc-a',new_unit_cost_iqd:150,adjustment_day:baghdadDay()};assert.equal((await post(s.app,'/i/lot-cost-adjustments',adjustment)).status,200);
  s.raw.exec("INSERT INTO finance_withdrawals(id,user_id,amount_iqd,paid_iqd,state,created_at,updated_at) VALUES ('paid','investor',100,100,'paid','2026-10-04','2026-10-04')");s.raw.prepare("INSERT INTO finance_withdrawal_allocations(withdrawal_id,source_kind,source_id,amount_iqd,paid_iqd) VALUES ('paid','investor_profit',?,100,100)").run(`invprofit:${c.operation_id}`);
  s.raw.exec("INSERT INTO return_cases(id,order_id,order_item_id,user_id,qty,reason,state,resolution) VALUES ('return','order','order-item','buyer',1,'defective','resolved','refund')");
  const restore=await planLotRestore(s.db,'order',{lineIds:['order-item'],qtyByLine:{'order-item':1},operation:'return:return'});await s.db.batch(restore.statements);
  await recordReturnFinancials({DB:s.db} as Env,{caseId:'return',orderId:'order',itemId:'order-item',refundIqd:500,qty:1,restocked:true,actor:'admin',day:baghdadDay(),cogsIqd:100});
  const source=(await investorParticipantSources(s.db,'investor')).find(x=>x.kind==='investor_profit')!;assert.equal(source.amount_iqd,0);assert.equal(source.paid_iqd,100);
  assert.equal(count(s.raw,'SELECT recognized_iqd n FROM lot_cost_adjustment_shares WHERE allocation_id IS NOT NULL'),0);
  assert.equal((await getOrderProfitBase(s.db,'order')).lines[0].cogs_iqd,0);assert.equal(count(s.raw,'SELECT SUM(debit_iqd-credit_iqd) n FROM accounting_lines'),0);
  const events=count(s.raw,'SELECT COUNT(*) n FROM investor_finance_events');await syncInvestorOrder(s.db,'order');assert.equal(count(s.raw,'SELECT COUNT(*) n FROM investor_finance_events'),events);
});

test('pending retrospective wages protect investor requests, approval, payment and the transaction fence',async()=>{
  const s=setup(),c=await contract(s);await fund(s,c.operation_id,300);await sale(s,'order',['lot-a']);await syncInvestorOrder(s.db,'order');
  const env={DB:s.db} as Env,approved=crypto.randomUUID(),requested=crypto.randomUUID();
  await requestWithdrawal(env,'investor',approved,70);await changeWithdrawalState(s.db,approved,'admin','approve');
  await requestWithdrawal(env,'investor',requested,70);
  const people=stubApp(s.db,ADMIN,a=>{a.route('/p',adminFinancePeopleRoutes);a.route('/o',adminFinanceOperationsRoutes);});
  const added=await json(await post(people,'/p/staff',{user_id:'other',start_work_date:'2026-09-20'}));
  const rule=await post(people,'/o/rules',{staff_id:added.id,basis:'unit',amount:100,milestone:'delivered'});assert.equal(rule.status,200,JSON.stringify(await json(rule)));
  assert.equal((await investmentContractSummary(s.db,c.operation_id)).summary.available_profit_iqd,0);
  assert.equal((await participantOverview(s.db,'investor')).summary.available_earnings_iqd,0);
  await assert.rejects(requestWithdrawal(env,'investor',crypto.randomUUID(),1),/متاح|تسوية/);
  await assert.rejects(changeWithdrawalState(s.db,requested,'admin','approve'),/مصدر|تسوية|مستحقات|محجوزة/);
  await assert.rejects(payWithdrawal(s.db,'admin',approved,{id:crypto.randomUUID(),amount:70,reference:'cash',receipt_url:''}),/مصدر|تسوية|مستحقات/);
  await changeWithdrawalState(s.db,approved,'admin','reject');await changeWithdrawalState(s.db,requested,'admin','reject');
  await continueStaffReconciliation(env,added.id);
  assert.equal((await participantOverview(s.db,'investor')).summary.available_earnings_iqd,105);
  const race=s.pauseOn('INSERT INTO finance_withdrawals'),withdrawal=crypto.randomUUID();
  const pending=requestWithdrawal(env,'investor',withdrawal,105);await race.waiting;
  const changed=await people.request(`/p/staff/${added.id}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({start_work_date:'2026-09-19'})});assert.equal(changed.status,200);
  race.resume();await assert.rejects(pending,/تغير الرصيد/);
  assert.equal(count(s.raw,'SELECT COUNT(*) n FROM finance_withdrawals WHERE id=?',withdrawal),0);
});

test('pending loss-bearing wages protect exposed capital while loss-free unpaid capital remains independent',async()=>{
  for(const lossShare of [10000,0]){
    const s=setup(),c=await contract(s,'inc-a','investor',{loss_share_bps:lossShare});await fund(s,c.operation_id,300);await sale(s,'order',['lot-a']);await syncInvestorOrder(s.db,'order');
    const people=stubApp(s.db,ADMIN,a=>{a.route('/p',adminFinancePeopleRoutes);a.route('/o',adminFinanceOperationsRoutes);});
    const added=await json(await post(people,'/p/staff',{user_id:'other',start_work_date:'2026-09-20'}));
    assert.equal((await post(people,'/o/rules',{staff_id:added.id,basis:'unit',amount:1000,milestone:'delivered'})).status,200);
    const env={DB:s.db} as Env;
    const capital=(await participantOverview(s.db,'investor')).summary.available_capital_iqd;
    assert.equal(capital,lossShare?0:100);
    if(lossShare)await assert.rejects(requestWithdrawal(env,'investor',crypto.randomUUID(),100,'capital'),/متاح|تسوية/);
    else await requestWithdrawal(env,'investor',crypto.randomUUID(),100,'capital');
  }
});

test('delivery recognizes deferred preparation wages before publishing the first investor profit',async()=>{
  const s=setup(),c=await contract(s);await fund(s,c.operation_id,300);
  const people=stubApp(s.db,ADMIN,a=>{a.route('/p',adminFinancePeopleRoutes);a.route('/o',adminFinanceOperationsRoutes);});
  const added=await json(await post(people,'/p/staff',{user_id:'other',start_work_date:'2026-09-20'}));
  assert.equal((await post(people,'/o/rules',{staff_id:added.id,basis:'unit',amount:100,milestone:'prepared'})).status,200);
  const env={DB:s.db} as Env;await continueStaffReconciliation(env,added.id);
  await sale(s,'order',['lot-a']);
  const gate=s.pauseOn('INSERT INTO investor_allocation_results');
  const delivered=runOrderFinancialEffects(env,'order','delivered');await gate.waiting;
  assert.equal(count(s.raw,"SELECT COALESCE(SUM(amount_iqd),0) n FROM finance_order_costs WHERE order_id='order'"),100);
  gate.resume();await delivered;
  assert.equal((await participantOverview(s.db,'investor')).summary.available_earnings_iqd,105);
});
