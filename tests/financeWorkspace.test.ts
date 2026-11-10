import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, failingD1, stubApp, get, post, patch, json, count, row } from './fixtures/app';
import { adminFinanceWorkspaceRoutes } from '../worker/routes/adminFinanceWorkspace';
import { calculateGoods, getOrderProfitBase, monthlyPromotionShares, planProfitAdjustment, syncOrderWorkspaceAccounting, type GoodsLine } from '../worker/lib/orderProfit';
import { recordReturnFinancials, runOrderFinancialEffects } from '../worker/lib/orderFinance';
import { operationsReport } from '../worker/lib/operationsReport';
import { baghdadDay } from '../worker/lib/operations';
import { reconcileFinanceOrder } from '../worker/lib/financeReconcile';
import type { Env } from '../worker/lib/types';
import { financePreset, financeRangeFromSearch, validFinanceRange } from '../src/components/financeWorkspace/types';

function setup(cost:number|null=10000){
  const raw=freshDb(),at=new Date().toISOString();
  raw.exec(`INSERT INTO users(id,email,name,role,admin_scope) VALUES ('admin','boss@x.co','Owner','admin','full'),('assistant','helper@x.co','Helper','admin','assistant'),('buyer','buyer@x.co','Buyer','customer',NULL);
    INSERT INTO products(id,name,slug,price_iqd,stock,product_cost_iqd) VALUES ('product','Printer','workspace-printer',25000,0,999);
    INSERT INTO expense_categories(id,slug,name_ar) VALUES ('rent','workspace-rent','إيجار');
    INSERT INTO admin_settings(key,value) VALUES ('exchangeRate','1400') ON CONFLICT(key) DO UPDATE SET value='1400';`);
  const {db,failing}=failingD1(raw);
  const add=(id='order',qty=2,date=at,unitCost=cost)=>{
    raw.prepare(`INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_iqd,created_at,delivered_at)
      VALUES (?,'buyer','delivered','{}','standard','{}','cash',?,1400,?,?,5000,?,?)`).run(id,qty*25000,qty*25000+5000,qty*25000+5000,date,date);
    raw.prepare(`INSERT INTO order_items(id,order_id,product_id,name_snapshot,sku_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis) VALUES (?,?,'product','طابعة','SKU',?,25000,?,?,'snapshot')`).run(`${id}:item`,id,qty,qty*25000,unitCost);
    raw.prepare(`INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,cost_basis,received_at) VALUES (?,'product','base','',?,0,?,'opening',?)`).run(`${id}:lot`,qty,unitCost,date);
    raw.prepare(`INSERT INTO order_item_inventory_allocations(id,order_id,order_item_id,lot_id,scope,scope_id,qty,unit_cost_iqd,cogs_iqd,idempotency_key) VALUES (?,?,?,?,'base','',?,?,?,?)`).run(`${id}:allocation`,id,`${id}:item`,`${id}:lot`,qty,unitCost,unitCost===null?null:unitCost*qty,`${id}:allocation`);
  };
  add();
  const make=(scope='full')=>stubApp(db,{id:scope==='full'?'admin':'assistant',email:scope==='full'?'boss@x.co':'helper@x.co',role:'admin',admin_scope:scope},(a)=>a.route('/f',adminFinanceWorkspaceRoutes));
  return {raw,db,failing,add,app:make(),assistant:make('assistant'),env:{DB:db} as Env};
}
const month=()=>baghdadDay().slice(0,7),period=()=>`from=${month()}-01&to=${new Date(Date.UTC(Number(month().slice(0,4)),Number(month().slice(5)),0)).toISOString().slice(0,10)}`;
const balance=(raw:ReturnType<typeof freshDb>,account:string)=>count(raw,'SELECT COALESCE(SUM(debit_iqd-credit_iqd),0) n FROM accounting_lines WHERE account_code=?',account);
const edit=(app:ReturnType<typeof stubApp>,field:string,value:number,operation_id=crypto.randomUUID(),version?:number)=>post(app,'/f/orders/order/adjustments',{field,value_iqd:value,operation_id,...(version===undefined?{}:{version})});

test('bundle leaves share parent discounts, points and accepted final price exactly once',()=>{
  const line=(id:string,total:number,parent:string|null=null):GoodsLine=>({id,product_id:'p',qty:1,bundle_parent_item_id:parent,component_alloc_iqd:parent?total:null,line_total_iqd:total,coupon_discount_iqd:0,membership_discount_iqd:0,cost_iqd:1000});
  const parent={...line('parent',10000),coupon_discount_iqd:1000,membership_discount_iqd:500};
  const result=calculateGoods({points_discount_iqd:1000,price_adjustment_iqd:-1000,shipping_iqd:5000,cod_tax_iqd:0},[parent,line('a',4500,'parent'),line('b',5500,'parent')],[]);
  assert.equal(result.lines.length,2);assert.equal(result.lines.reduce((v,l)=>v+l.original_net_goods_iqd,0),7500);assert.equal(result.lines.reduce((v,l)=>v+l.net_goods_iqd,0),6500);
  const cut=calculateGoods({price_adjustment_iqd:-12000,shipping_iqd:5000,cod_tax_iqd:1000},[line('a',10000)],[]);
  assert.equal(cut.lines[0].net_goods_iqd,0);assert.equal(cut.order.shipping_iqd,3000);assert.equal(cut.order.cod_tax_iqd,1000);
});
test('accepted final price matches central report and balanced delivered sale',async()=>{
  const {raw,db,env}=setup();raw.exec('UPDATE orders SET price_adjustment_iqd=-10000,total_iqd=45000,due_on_delivery_iqd=45000');
  await runOrderFinancialEffects(env,'order','delivered');
  assert.equal(balance(raw,'4000'),-40000);assert.equal(balance(raw,'1100'),45000);assert.equal(balance(raw,'4100'),-5000);
  assert.equal((await getOrderProfitBase(db,'order')).totals.net_goods_iqd,40000);
  assert.equal((await operationsReport(db,`${month()}-01`,baghdadDay())).orders[0].net_goods_iqd,40000);
  assert.equal(balance(raw,'4000')+balance(raw,'4100')+balance(raw,'1100'),0);
});
test('numeric correction audits only this order, posts a delta once, retains FIFO and customer invoice',async()=>{
  const {raw,env,app}=setup();await runOrderFinancialEffects(env,'order','delivered');
  const op=crypto.randomUUID(),response=await edit(app,'cogs_iqd',30000,op,0),data=await json(response);assert.equal(response.status,200,JSON.stringify(data));
  assert.equal(data.version,1);assert.equal(data.lines[0].cogs_iqd,30000);assert.equal(data.lines[0].cost_confidence,'manual_verified');
  assert.equal(row(raw,'SELECT product_cost_iqd FROM products')?.product_cost_iqd,999);assert.equal(row(raw,'SELECT cost_iqd FROM order_items')?.cost_iqd,10000);
  assert.equal(row(raw,'SELECT cogs_iqd FROM order_item_inventory_allocations')?.cogs_iqd,20000);assert.equal(balance(raw,'5000'),30000);assert.equal(balance(raw,'2990'),-10000);
  assert.equal(row(raw,'SELECT total_iqd,due_on_delivery_iqd FROM orders')?.total_iqd,55000);
  const history=row(raw,'SELECT old_value_iqd,new_value_iqd,actor_id,reason FROM finance_order_adjustments')!;assert.equal(history.old_value_iqd,20000);assert.equal(history.new_value_iqd,30000);assert.equal(history.actor_id,'admin');assert.ok(history.reason);
  assert.equal((await edit(app,'cogs_iqd',30000,op,0)).status,200);assert.equal(count(raw,'SELECT COUNT(*) n FROM finance_order_adjustments'),1);assert.equal(balance(raw,'5000'),30000);
  assert.equal((await edit(app,'cogs_iqd',31000,op)).status,409);assert.equal((await edit(app,'net_goods_iqd',60000,crypto.randomUUID(),0)).status,409);
  assert.equal((await edit(app,'net_goods_iqd',60000,crypto.randomUUID(),1)).status,200);assert.equal(balance(raw,'4000'),-60000);assert.equal(balance(raw,'1100'),55000);
  assert.equal(count(raw,'SELECT SUM(debit_iqd-credit_iqd) n FROM accounting_lines'),0);
  assert.throws(()=>raw.exec("UPDATE finance_order_adjustments SET new_value_iqd=1"),/immutable/);
});
test('unknown actual cost remains null until explicit verification, then reconciles when original FIFO resolves',async()=>{
  const {raw,db,env,app}=setup(null);await runOrderFinancialEffects(env,'order','delivered');
  const before=await json(await get(app,'/f/orders/order'));assert.equal(before.totals.owner_net_iqd,null);assert.equal(before.totals.cogs_iqd,null);
  assert.equal((await edit(app,'cogs_iqd',30000)).status,200);assert.equal(balance(raw,'5000'),30000);assert.equal((await getOrderProfitBase(db,'order')).totals.cogs_iqd,30000);
  raw.exec('UPDATE order_item_inventory_allocations SET unit_cost_iqd=10000,cogs_iqd=20000');await runOrderFinancialEffects(env,'order','delivered');await syncOrderWorkspaceAccounting(db,'order');
  assert.equal(balance(raw,'5000'),30000);assert.equal(balance(raw,'2990'),-10000);assert.equal((await getOrderProfitBase(db,'order')).totals.cogs_iqd,30000);
  await syncOrderWorkspaceAccounting(db,'order');assert.equal(balance(raw,'5000'),30000);
});
test('a verified cost posts its whole amount when only an unrecorded historical estimate existed',async()=>{
  const {raw,env,app}=setup();raw.exec("DELETE FROM order_item_inventory_allocations;UPDATE order_items SET cost_basis='unrecorded'");await runOrderFinancialEffects(env,'order','delivered');
  assert.equal(balance(raw,'5000'),0);assert.equal((await json(await get(app,'/f/orders/order'))).lines[0].cost_confidence,'snapshot');
  const response=await edit(app,'cogs_iqd',15000);assert.equal(response.status,200,JSON.stringify(await json(response)));
  assert.equal(balance(raw,'5000'),15000);assert.equal(balance(raw,'2990'),-15000);assert.equal(count(raw,"SELECT COUNT(*) n FROM accounting_entries WHERE event_key='cogs:order'"),0);
});
test('unknown FIFO allocation cannot be replaced by a numeric checkout estimate in profit math',async()=>{
  const {raw,db}=setup();raw.exec('UPDATE order_item_inventory_allocations SET cogs_iqd=NULL,unit_cost_iqd=NULL');
  const b=await getOrderProfitBase(db,'order');assert.equal(b.lines[0].cost_confidence,'unknown');assert.equal(b.totals.cogs_iqd,null);assert.equal(b.totals.owner_net_iqd,undefined);
});
test('later partial and full restocks reverse only the remaining share of each frozen COGS correction',async()=>{
  const {raw,db,env,app}=setup();await runOrderFinancialEffects(env,'order','delivered');await edit(app,'cogs_iqd',30000);
  const restock=async(id:string)=>{
    const at=new Date().toISOString();raw.prepare("INSERT INTO return_cases(id,order_id,order_item_id,user_id,qty,reason,state,resolution,decided_at) VALUES (?,'order','order:item','buyer',1,'defective','resolved','refund',?)").run(id,at);
    raw.prepare("INSERT INTO order_item_inventory_allocations(id,order_id,order_item_id,lot_id,scope,scope_id,qty,unit_cost_iqd,cogs_iqd,idempotency_key,released_at) VALUES (?,'order','order:item','order:lot','base','',1,10000,10000,?,?)").run(`${id}:release`,`${id}:release`,at);
    await recordReturnFinancials(env,{caseId:id,orderId:'order',itemId:'order:item',refundIqd:25000,qty:1,restocked:true,cogsIqd:10000,actor:'admin',day:baghdadDay()});
  };
  await restock('first');assert.equal((await getOrderProfitBase(db,'order')).totals.cogs_iqd,15000);assert.equal(balance(raw,'5000'),15000);
  assert.equal((await edit(app,'cogs_iqd',18000)).status,200);assert.equal(balance(raw,'5000'),18000);
  await restock('second');assert.equal((await getOrderProfitBase(db,'order')).totals.cogs_iqd,0);assert.equal(balance(raw,'5000'),0);assert.equal(balance(raw,'2990'),0);
  await syncOrderWorkspaceAccounting(db,'order');assert.equal(balance(raw,'5000'),0);
});
test('damaged returns preserve the original FIFO and order-only cost correction',async()=>{
  const {raw,db,env,app}=setup();await runOrderFinancialEffects(env,'order','delivered');await edit(app,'cogs_iqd',30000);
  raw.prepare("INSERT INTO return_cases(id,order_id,order_item_id,user_id,qty,reason,state,resolution,decided_at) VALUES ('damage','order','order:item','buyer',2,'defective','resolved','refund',?)").run(new Date().toISOString());
  await recordReturnFinancials(env,{caseId:'damage',orderId:'order',itemId:'order:item',refundIqd:50000,qty:2,restocked:false,cogsIqd:0,actor:'admin',day:baghdadDay()});
  const b=await getOrderProfitBase(db,'order');assert.equal(b.totals.cogs_iqd,30000);assert.equal(b.totals.profit_basis_iqd,-25000);assert.equal(balance(raw,'5000'),30000);assert.equal(balance(raw,'2990'),-10000);
});
test('financial correction waits for native sale and retries coherently after delivery',async()=>{
  const {raw,db,env,app}=setup();raw.exec("UPDATE orders SET status='confirmed',delivered_at=NULL");
  const response=await edit(app,'net_goods_iqd',60000);assert.equal(response.status,200,JSON.stringify(await json(response)));assert.equal(balance(raw,'4000'),0);
  raw.prepare("UPDATE orders SET status='delivered',delivered_at=?").run(new Date().toISOString());await runOrderFinancialEffects(env,'order','delivered');await syncOrderWorkspaceAccounting(db,'order');
  assert.equal(balance(raw,'4000'),-60000);assert.equal(balance(raw,'1100'),55000);assert.equal(balance(raw,'2990'),10000);
});
test('stale source and version races roll back financial edit and every planned journal',async()=>{
  const {raw,env,app,failing}=setup();await runOrderFinancialEffects(env,'order','delivered');
  failing.beforeBatch=(ss)=>{if(!ss.some((v)=>v.sql.includes('INSERT INTO finance_order_adjustments')))return;failing.beforeBatch=null;raw.exec('UPDATE orders SET price_adjustment_iqd=1000');};
  assert.equal((await edit(app,'cogs_iqd',30000)).status,409);assert.equal(count(raw,'SELECT COUNT(*) n FROM finance_order_adjustments'),0);assert.equal(balance(raw,'5000'),20000);assert.equal(balance(raw,'2990'),0);
  failing.beforeBatch=(ss)=>{if(!ss.some((v)=>v.sql.includes('INSERT INTO finance_order_adjustments')))return;failing.beforeBatch=null;raw.exec("INSERT INTO finance_order_versions(order_id,version) VALUES ('order',1)");};
  assert.equal((await edit(app,'cogs_iqd',30000)).status,409);assert.equal(count(raw,'SELECT COUNT(*) n FROM finance_order_adjustments'),0);
});
test('order-wide reduction never creates negative costs on a zero-cost line',async()=>{
  const {db,add}=setup();add('other',1);
  const b=await getOrderProfitBase(db,'order'),extra={...b.lines[0],id:'extra',manual_direct_iqd:0};b.lines[0].manual_direct_iqd=100;b.lines.push(extra);
  const p=planProfitAdjustment(b,null,'manual_direct_iqd',0);assert.deepEqual(p.allocations.map((a)=>a.delta_iqd),[-100,0]);
});
test('100 USD monthly promotion uses every sold unit, preserves the invoice basis and excludes duplicate overhead',async()=>{
  const {raw,db,add,app}=setup();add('other',1);
  const operation=crypto.randomUUID(),created=await post(app,'/f/promotions',{month:month(),amount:100,currency:'USD',exchange_rate:1400,operation_id:operation});assert.equal(created.status,200,JSON.stringify(await json(created)));
  assert.equal((await post(app,'/f/promotions',{month:month(),amount:100,currency:'USD',exchange_rate:1400,operation_id:operation})).status,200);
  assert.equal(count(raw,'SELECT COUNT(*) n FROM finance_monthly_promotions'),1);assert.equal(balance(raw,'1000'),-140000);
  const all=await monthlyPromotionShares(db,month());assert.equal(all.total_iqd,140000);assert.equal([...all.shares.values()].reduce((a,b)=>a+b,0),140000);
  const filtered=await json(await get(app,`/f/orders?${period()}&q=order`));assert.equal(filtered.orders.length,1);assert.equal(filtered.orders[0].promotion_iqd,all.shares.get('order:item'));
  const profit=await json(await get(app,'/f/orders/order'));assert.equal(profit.totals.profit_basis_iqd,35000);assert.equal(profit.totals.owner_net_iqd,35000-n(all.shares.get('order:item')));
  const summary=await json(await get(app,`/f/summary?${period()}`));assert.equal(summary.totals.promotion_iqd,140000);assert.equal(summary.totals.general_expenses_iqd,0);
  assert.equal((await post(app,'/f/promotions',{month:month(),amount:100,currency:'USD',exchange_rate:1400})).status,409);
});
const n=(v:unknown)=>Number(v??0);
test('monthly revision reverses its source once, blocks ordinary expense tampering and closed-period edits',async()=>{
  const {raw,app}=setup();const create=await json(await post(app,'/f/promotions',{month:month(),currency:'USD',amount:100,exchange_rate:1400})),id=create.id;
  const changed=await patch(app,`/f/promotions/${id}`,{amount:120});assert.equal(changed.status,200,JSON.stringify(await json(changed)));assert.equal(balance(raw,'1000'),-168000);
  assert.equal(count(raw,'SELECT COUNT(*) n FROM finance_promotion_history'),2);
  assert.throws(()=>raw.exec('UPDATE operating_expenses SET amount_iqd=1'),/promotion source/);
  const disabled=await patch(app,`/f/promotions/${id}`,{enabled:false});assert.equal(disabled.status,200,JSON.stringify(await json(disabled)));assert.equal(balance(raw,'1000'),0);
  raw.prepare('INSERT INTO accounting_periods(month,closed_by,closed_at) VALUES (?,?,?)').run(month(),'admin',new Date().toISOString());
  assert.equal((await patch(app,`/f/promotions/${id}`,{enabled:true})).status,409);assert.equal(balance(raw,'1000'),0);
});
test('a month with no sales still deducts unallocated promotion and rent exactly once from period owner result',async()=>{
  const {raw,app}=setup();raw.exec("UPDATE orders SET status='confirmed',delivered_at=NULL");
  await post(app,'/f/promotions',{month:month(),currency:'USD',amount:100,exchange_rate:1400});raw.prepare("INSERT INTO operating_expenses(id,category_id,amount_iqd,expense_day,title,created_by) VALUES ('rent-1','rent',20000,?,'Rent','admin')").run(`${month()}-01`);
  const result=await json(await get(app,`/f/summary?${period()}`));assert.equal(result.totals.orders_count,0);assert.equal(result.totals.unallocated_promotion_iqd,140000);assert.equal(result.totals.general_expenses_iqd,20000);assert.equal(result.totals.owner_period_net_iqd,-160000);
});
test('late FIFO cost shares enter central goods cost once, including allocation-level source evidence',async()=>{
  const {raw,db}=setup();
  raw.exec(`INSERT INTO incoming_inventory(id,product_id,scope,scope_id,qty_ordered,qty_received,purchase_unit_iqd) VALUES ('incoming','product','base','',2,2,10000);
    INSERT INTO lot_cost_adjustments(id,incoming_id,amount_iqd,adjustment_day,title,actor_id,request_json,created_at) VALUES ('late','incoming',2000,'2026-10-01','Freight','admin','{}','now');
    INSERT INTO lot_cost_adjustment_shares(adjustment_id,lot_id,allocation_id,qty,amount_iqd,unit_delta_iqd) VALUES ('late','order:lot','order:allocation',2,2000,1000);`);
  const b=await getOrderProfitBase(db,'order');assert.equal(b.lines[0].allocations[0].late_cost_iqd,2000);assert.equal(b.totals.cogs_iqd,22000);assert.equal(b.totals.profit_basis_iqd,33000);
});
test('summary withholds a persisted investor split after a linked expense changes without a workspace revision',async()=>{
  const {raw,db,env,app}=setup();
  raw.exec(`INSERT INTO incoming_inventory(id,product_id,scope,scope_id,qty_ordered,qty_received,purchase_unit_iqd) VALUES ('funded','product','base','',2,2,10000);
    UPDATE inventory_lots SET incoming_id='funded' WHERE id='order:lot';
    INSERT INTO investment_contracts(id,incoming_id,user_id,name,principal_iqd,capital_share_bps,profit_share_bps,loss_share_bps,created_by,created_at,request_json)
    VALUES ('contract','funded','buyer','Funding',20000,10000,1000,1000,'admin','now','{}');
    INSERT INTO operating_expenses(id,category_id,amount_iqd,expense_day,title,created_by) VALUES ('direct','rent',1000,'2026-10-01','Special handling','admin');
    INSERT INTO finance_expense_links(expense_id,order_id) VALUES ('direct','order');`);
  await runOrderFinancialEffects(env,'order','delivered');
  let summary=await json(await get(app,`/f/summary?${period()}`));assert.equal(summary.totals.investor_iqd,3400);assert.equal(summary.totals.owner_net_iqd,30600);
  raw.exec("UPDATE operating_expenses SET amount_iqd=3000 WHERE id='direct'");
  summary=await json(await get(app,`/f/summary?${period()}`));assert.equal(summary.orders[0].version,0);assert.equal(summary.totals.investor_iqd,null);assert.equal(summary.totals.owner_net_iqd,null);
  assert.equal(summary.chart_data.owner_net_iqd,null);assert.equal(summary.chart_data.investor_iqd,null);assert.equal(summary.chart_data.cost_iqd,23000);
  assert.ok(summary.exceptions.some((e:{type:string})=>e.type==='investor'));
  await reconcileFinanceOrder(db,'order');summary=await json(await get(app,`/f/summary?${period()}`));assert.equal(summary.totals.investor_iqd,3200);assert.equal(summary.totals.owner_net_iqd,28800);
  const detail=await json(await get(app,'/f/orders/order'));assert.equal(detail.totals.owner_net_iqd,summary.totals.owner_net_iqd);
});
test('financial exports and numeric mutations enforce financial scope and emit safe source CSV',async()=>{
  const {app,assistant,raw}=setup();assert.equal((await get(assistant,`/f/summary?${period()}`)).status,403);assert.equal((await get(assistant,`/f/export.csv?${period()}`)).status,403);assert.equal((await edit(assistant,'cogs_iqd',1)).status,403);
  raw.exec("UPDATE order_items SET name_snapshot='=HYPERLINK(\"https://x\")'");const response=await get(app,`/f/export.csv?${period()}`);assert.equal(response.status,200);assert.match(await response.text(),/'=HYPERLINK/);
});
test('chart days reconcile revenue, costs and owner result without reallocating month promotion on a date filter',async()=>{
  const {raw,db,add,app}=setup();
  raw.prepare('UPDATE orders SET delivered_at=?,created_at=?').run(`${month()}-01T21:30:00Z`,`${month()}-01T21:30:00Z`);
  add('other',1,`${month()}-03T00:00:00Z`);
  raw.prepare("INSERT INTO operating_expenses(id,category_id,amount_iqd,expense_day,title,created_by) VALUES ('chart-rent','rent',2000,?,'Rent','admin')").run(`${month()}-02`);
  assert.equal((await post(app,'/f/promotions',{month:month(),currency:'IQD',amount:1000})).status,200);
  const result=await json(await get(app,`/f/summary?from=${month()}-01&to=${month()}-03`)),chart=result.chart_data;
  assert.equal(chart.daily.length,3);assert.equal(chart.basis,'delivered_baghdad_day');
  assert.equal(chart.revenue_iqd,85000);assert.equal(chart.cost_iqd,33000);assert.equal(chart.owner_net_iqd,52000);
  for(const field of ['revenue_iqd','cost_iqd','owner_net_iqd'])assert.equal(chart.daily.reduce((sum:number,day:Record<string,number>)=>sum+day[field],0),chart[field]);
  assert.equal(chart.owner_net_iqd,result.totals.owner_period_net_iqd);
  assert.equal(chart.expense_composition.reduce((sum:number,item:{amount_iqd:number})=>sum+item.amount_iqd,0),chart.cost_iqd);
  assert.equal(chart.daily[0].orders_count,0);assert.equal(chart.daily[1].orders_count,1);
  const promotion=await monthlyPromotionShares(db,month()),filtered=await json(await get(app,`/f/summary?from=${month()}-02&to=${month()}-02`));
  assert.equal(filtered.totals.promotion_iqd,promotion.shares.get('order:item'));
  assert.equal(filtered.chart_data.revenue_iqd,55000);assert.equal(filtered.chart_data.cost_iqd,22000+n(promotion.shares.get('order:item')));
});
test('unknown daily profit and costs stay null, genuine quiet days stay zero and finance scope still applies',async()=>{
  const {raw,app,assistant}=setup(null);
  raw.prepare('UPDATE orders SET delivered_at=?,created_at=?').run(`${month()}-02T00:00:00Z`,`${month()}-02T00:00:00Z`);
  const url=`/f/summary?from=${month()}-01&to=${month()}-02`,result=await json(await get(app,url));
  assert.equal(result.chart_data.owner_net_iqd,null);assert.equal(result.chart_data.cost_iqd,null);
  assert.equal(result.chart_data.daily[0].owner_net_iqd,0);assert.equal(result.chart_data.daily[1].owner_net_iqd,null);assert.equal(result.chart_data.daily[1].cost_iqd,null);
  assert.equal(result.chart_data.expense_composition.find((v:{key:string})=>v.key==='goods').amount_iqd,null);
  assert.equal((await get(assistant,url)).status,403);
});
test('no-sales promotion and general expenses appear on their own days and reconcile to a loss',async()=>{
  const {raw,app}=setup();raw.exec("UPDATE orders SET status='confirmed',delivered_at=NULL");
  await post(app,'/f/promotions',{month:month(),currency:'IQD',amount:1000});
  raw.prepare("INSERT INTO operating_expenses(id,category_id,amount_iqd,expense_day,title,created_by) VALUES ('chart-general','rent',2000,?,'Rent','admin')").run(`${month()}-02`);
  const result=await json(await get(app,`/f/summary?from=${month()}-01&to=${month()}-03`));
  assert.equal(result.chart_data.revenue_iqd,0);assert.equal(result.chart_data.cost_iqd,3000);assert.equal(result.chart_data.owner_net_iqd,-3000);
  assert.deepEqual(result.chart_data.daily.map((v:{owner_net_iqd:number})=>v.owner_net_iqd),[-1000,-2000,0]);
});
test('finance date ranges validate real calendar dates and presets preserve Baghdad date boundaries',()=>{
  assert.equal(validFinanceRange({from:'2026-02-30',to:'2026-03-01'}),false);
  assert.equal(validFinanceRange({from:'2026-10-04',to:'2026-10-03'}),false);
  assert.equal(validFinanceRange({from:'2025-01-01',to:'2026-01-02'}),false);
  assert.equal(validFinanceRange({from:'2025-01-01',to:'2026-01-01'}),true);
  assert.deepEqual(financePreset('7days','2026-01-04'),{from:'2025-12-29',to:'2026-01-04'});
  assert.deepEqual(financePreset('previous','2026-01-04'),{from:'2025-12-01',to:'2025-12-31'});
  assert.deepEqual(financePreset('previous','2024-03-04'),{from:'2024-02-01',to:'2024-02-29'});
  assert.deepEqual(financeRangeFromSearch('?from=2026-02-01&to=2026-02-28'),{range:{from:'2026-02-01',to:'2026-02-28'},invalid:false});
  assert.equal(financeRangeFromSearch('?from=2026-01-01').invalid,true);
});

test('participant charts use actual Baghdad period filters, separate capital and require finance scope',async()=>{
 const x=setup();await runOrderFinancialEffects(x.env,'order','delivered');
 const response=await get(x.app,`/f/participant-report?${period()}`),data=await json(response);assert.equal(response.status,200,JSON.stringify(data));assert.equal(data.capital.received_iqd,0);assert.equal(data.participants[0].earned_iqd,0);assert.deepEqual(data.batches,[]);
 assert.equal((await get(x.assistant,`/f/participant-report?${period()}`)).status,403);
 assert.equal((await get(x.app,'/f/participant-report?from=2026-10-06&to=2026-10-01')).status,400);
});

test('«الحساب يحتاج مراجعة»: the summary shows what complete orders say and names what is missing; the missing-costs list closes once a price is confirmed (owner 2026-11-10)', async () => {
  const {raw,db,app}=setup();
  const at=new Date().toISOString();
  raw.exec(`INSERT INTO products(id,name,slug,price_iqd,stock) VALUES ('magnet','Round Magnet','workspace-magnet',500,0)`);
  raw.prepare(`INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_iqd,created_at,delivered_at)
    VALUES ('magnets','buyer','delivered','{}','standard','{}','cash',15000,1400,20000,20000,5000,?,?)`).run(at,at);
  raw.prepare(`INSERT INTO order_items(id,order_id,product_id,name_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis) VALUES ('magnets:line','magnets','magnet','Round Magnet','D8x3 mm',30,500,15000,NULL,'unpriced')`).run();
  let summary=await json(await get(app,`/f/summary?${period()}`));
  assert.equal(summary.totals.owner_net_iqd,null,'one line without a price still blanks the full total');
  assert.equal(summary.known.orders_count,1);assert.equal(summary.known.incomplete_orders,1);
  assert.notEqual(summary.known.owner_net_iqd,null);assert.notEqual(summary.known.cost_iqd,null);
  assert.equal(summary.missing_costs.unknown_lines,1);assert.equal(summary.missing_costs.orders,1);
  assert.deepEqual(summary.missing_costs.unknown_products,[{product_id:'magnet',name:'Round Magnet',qty:30,lines:1}]);
  let missing=await json(await get(app,`/f/missing-costs?${period()}`));
  assert.equal(missing.lines.length,1);
  assert.deepEqual({order:missing.lines[0].order_id,line:missing.lines[0].line_id,qty:missing.lines[0].qty,cost_qty:missing.lines[0].cost_qty,stock_qty:missing.lines[0].stock_qty,option:missing.lines[0].option,cogs:missing.lines[0].cogs_iqd},{order:'magnets',line:'magnets:line',qty:30,cost_qty:30,stock_qty:0,option:'D8x3 mm',cogs:null});
  assert.deepEqual(missing.stocked,[],'no stock batch: the list says so');
  // The owner confirms 150 per piece: the server prices the 30 kept pieces through the order's own correction.
  const fixed=await post(app,'/f/missing-costs/lines',{operation_id:'missingcost:magnets:line:150:30',order_id:'magnets',line_id:'magnets:line',unit_iqd:150,cost_qty:30});
  assert.equal(fixed.status,200,JSON.stringify(await json(fixed)));
  const line=(await getOrderProfitBase(db,'magnets')).lines[0];
  assert.deepEqual({cogs:line.cogs_iqd,confidence:line.cost_confidence},{cogs:4500,confidence:'manual_verified'});
  missing=await json(await get(app,`/f/missing-costs?${period()}`));
  assert.equal(missing.lines.length,0);
  summary=await json(await get(app,`/f/summary?${period()}`));
  assert.equal(summary.missing_costs.lines,0);assert.equal(summary.known.incomplete_orders,0);
  assert.notEqual(summary.totals.owner_net_iqd,null);
});

/**
 * «التكاليف الناقصة», review of 2026-11-11: what one typed price per piece may and may
 * not write. Lines as the owner's November products: delivered, never received into stock.
 */
function missingSetup(){
  const s=setup();
  s.raw.exec(`INSERT INTO products(id,name,slug,price_iqd,stock) VALUES ('magnet','Round Magnet','missing-magnet',500,0),('esun','eSUN PLA+','missing-esun',20000,0)`);
  const sell=async(id:string,lines:Array<{id:string;product:string;qty:number;unit:number;estimate?:number}>)=>{
    const at=new Date().toISOString(),sub=lines.reduce((v,l)=>v+l.qty*l.unit,0);
    s.raw.prepare(`INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_iqd,created_at,delivered_at)
      VALUES (?,'buyer','delivered','{}','standard','{}','cash',?,1400,?,?,0,?,?)`).run(id,sub,sub,sub,at,at);
    for(const l of lines){
      s.raw.prepare(`INSERT INTO order_items(id,order_id,product_id,name_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis) VALUES (?,?,?,?,'',?,?,?,NULL,'unpriced')`).run(l.id,id,l.product,l.product,l.qty,l.unit,l.qty*l.unit);
      if(l.estimate!==undefined)s.raw.prepare('UPDATE order_items SET estimated_cost_iqd=? WHERE id=?').run(l.estimate,l.id);
    }
    await runOrderFinancialEffects(s.env,id,'delivered');
  };
  const restock=async(order:string,item:string,qty:number,caseId:string)=>{
    s.raw.prepare("INSERT INTO return_cases(id,order_id,order_item_id,user_id,qty,reason,state,resolution,decided_at) VALUES (?,?,?,'buyer',?,'defective','resolved','refund',?)").run(caseId,order,item,qty,new Date().toISOString());
    await recordReturnFinancials(s.env,{caseId,orderId:order,itemId:item,refundIqd:500*qty,qty,restocked:true,actor:'admin',day:baghdadDay()});
  };
  type MissingLine={line_id:string;qty:number;restocked_qty:number;cost_qty:number;stock_qty:number;preorder:boolean;confidence:string;cogs_iqd:number|null;estimate_unit_iqd:number|null};
  const list=async()=>(await json(await get(s.app,`/f/missing-costs?${period()}`))) as {lines:MissingLine[];stocked:string[]};
  const line=async(id:string)=>(await list()).lines.find((l)=>l.line_id===id)!;
  const price=(order:string,lineId:string,unit:number,costQty:number)=>post(s.app,'/f/missing-costs/lines',{operation_id:`missingcost:${lineId}:${unit}:${costQty}`,order_id:order,line_id:lineId,unit_iqd:unit,cost_qty:costQty});
  return {...s,sell,restock,list,line,price};
}

test('a price per piece covers only the pieces the customer kept: a return put back in stock is not a cost of the sale; a list read before a return is refused (review 2026-11-11)',async()=>{
  const {db,sell,restock,line,price}=missingSetup();
  await sell('m',[{id:'m:line',product:'magnet',qty:2,unit:500}]);
  await sell('f',[{id:'f:line',product:'magnet',qty:3,unit:500}]);
  const before=await line('m:line');assert.equal(before.cost_qty,2);
  await restock('m','m:line',1,'r1');await restock('f','f:line',3,'r2');
  const m=await line('m:line'),f=await line('f:line');
  assert.deepEqual([m.qty,m.restocked_qty,m.cost_qty],[2,1,1]);assert.deepEqual([f.qty,f.restocked_qty,f.cost_qty],[3,3,0]);
  const stale=await price('m','m:line',150,before.cost_qty);
  assert.equal(stale.status,409);assert.equal((await json(stale)).code,'MISSING_COST_LINE_CHANGED');
  assert.equal((await getOrderProfitBase(db,'m')).lines[0].cogs_iqd,null,'nothing written from the stale list');
  for(const [order,id,kept] of [['m','m:line',1],['f','f:line',0]] as const){const r=await price(order,id,150,kept);assert.equal(r.status,200,JSON.stringify(await json(r)));}
  assert.equal((await getOrderProfitBase(db,'m')).lines[0].cogs_iqd,150,'one piece kept: 150, not 300');
  assert.equal((await getOrderProfitBase(db,'f')).lines[0].cogs_iqd,0,'nothing kept: no goods cost, not 450');
});

test('a line with pieces from a stock batch is not priced from the list: its batch cost is known, so it is set in its order (review 2026-11-11)',async()=>{
  const {raw,db,sell,list,line,price}=missingSetup();
  await sell('p',[{id:'p:line',product:'esun',qty:3,unit:20000}]);
  raw.prepare(`INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,cost_basis,received_at) VALUES ('p:lot','esun','base','',2,0,10000,'opening',?)`).run(new Date().toISOString());
  raw.prepare(`INSERT INTO order_item_inventory_allocations(id,order_id,order_item_id,lot_id,scope,scope_id,qty,unit_cost_iqd,cogs_iqd,idempotency_key) VALUES ('p:alloc','p','p:line','p:lot','base','',2,10000,20000,'p:alloc')`).run();
  assert.equal((await line('p:line')).stock_qty,2);
  assert.deepEqual((await list()).stocked,['esun'],'a priced batch exists');
  const refused=await price('p','p:line',7000,3);
  assert.equal(refused.status,409);assert.equal((await json(refused)).code,'MISSING_COST_HAS_STOCK');
  assert.equal((await getOrderProfitBase(db,'p')).lines[0].cogs_iqd,null,'the known 20,000 of the batch pieces is not overwritten by 7,000 × 3');
});

test('a price typed for an estimated line is the cost itself: a batch linked later never shifts it by the estimate\'s error (review 2026-11-11)',async()=>{
  const {raw,db,sell,line,price}=missingSetup();
  await sell('pre',[{id:'pre:line',product:'esun',qty:2,unit:20000,estimate:15271}]);
  const l=await line('pre:line');
  assert.deepEqual([l.confidence,l.cogs_iqd,l.estimate_unit_iqd],['estimated',30542,15271]);
  assert.equal((await price('pre','pre:line',14000,2)).status,200);
  const stored=JSON.parse(row<{allocations_json:string}>(raw,"SELECT allocations_json FROM finance_order_adjustments WHERE order_id='pre'")!.allocations_json);
  assert.deepEqual([stored[0].delta_iqd,stored[0].value_iqd],[null,28000],'a value, not a change of −2,542 to the estimate');
  assert.equal((await getOrderProfitBase(db,'pre')).lines[0].cogs_iqd,28000);
  // What «اربط بالدفعة الواصلة» writes when the batch arrives (allowed on a delivered order).
  raw.prepare(`INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,cost_basis,received_at) VALUES ('pre:lot','esun','base','',2,0,13500,'opening',?)`).run(new Date().toISOString());
  raw.prepare(`INSERT INTO order_item_inventory_allocations(id,order_id,order_item_id,lot_id,scope,scope_id,qty,unit_cost_iqd,cogs_iqd,idempotency_key,link_kind) VALUES ('pre:alloc','pre','pre:line','pre:lot','base','',2,13500,27000,'pre:alloc','preorder_batch')`).run();
  const after=(await getOrderProfitBase(db,'pre')).lines[0];
  assert.deepEqual([after.cogs_iqd,after.cost_confidence],[28000,'manual_verified'],'the owner\'s 28,000 — not 24,458 (27,000 − 2,542)');
});

test('two products of one order priced one after the other from the same list: no version refusal, and a half-priced order waits instead of failing (review 2026-11-11)',async()=>{
  const {raw,app,sell,line,price}=missingSetup();
  await sell('two',[{id:'two:a',product:'magnet',qty:1,unit:500},{id:'two:b',product:'esun',qty:1,unit:20000}]);
  const a=await line('two:a'),b=await line('two:b');
  const first=await price('two',a.line_id,150,a.cost_qty),firstBody=await json(first);
  assert.equal(first.status,200,JSON.stringify(firstBody));
  assert.equal(firstBody.reconciliation_pending,true,'the other product still has no cost');
  assert.equal(count(raw,"SELECT COUNT(*) n FROM finance_posting_errors WHERE event_key='investor:two'"),0,'waiting is not a posting failure');
  const summary=await json(await get(app,`/f/summary?${period()}`));
  assert.equal(summary.exceptions.some((e:{id:string})=>e.id==='investor:two'),false);
  const second=await price('two',b.line_id,9000,b.cost_qty),secondBody=await json(second);
  assert.equal(second.status,200,JSON.stringify(secondBody));assert.equal(secondBody.reconciliation_pending,false);
  assert.equal((await price('two',b.line_id,9000,b.cost_qty)).status,200,'a replay answers again');
  assert.equal(count(raw,"SELECT COUNT(*) n FROM finance_order_adjustments WHERE order_id='two'"),2,'written once each');
});

test('a pre-order line is not priced from the list: the batch linked in its order brings the actual cost (review 2026-11-11)',async()=>{
  const {raw,db,sell,line,price}=missingSetup();
  await sell('po',[{id:'po:line',product:'esun',qty:1,unit:20000,estimate:15271}]);
  raw.exec("UPDATE orders SET shipping_type='preorder_air' WHERE id='po'");
  const l=await line('po:line');assert.equal(l.preorder,true);
  const refused=await price('po','po:line',14000,1);
  assert.equal(refused.status,409);assert.equal((await json(refused)).code,'MISSING_COST_PREORDER');
  assert.deepEqual([(await getOrderProfitBase(db,'po')).lines[0].cost_confidence,count(raw,"SELECT COUNT(*) n FROM finance_order_adjustments WHERE order_id='po'")],['estimated',0]);
});

test('a line priced in its order meanwhile is left as it is by the list (review 2026-11-11)',async()=>{
  const {db,app,sell,line,price}=missingSetup();
  await sell('done',[{id:'done:line',product:'magnet',qty:4,unit:500}]);
  const l=await line('done:line');
  assert.equal((await post(app,'/f/orders/done/adjustments',{field:'cogs_iqd',value_iqd:1000,line_id:'done:line'})).status,200);
  const r=await price('done','done:line',150,l.cost_qty);
  assert.equal(r.status,200);assert.equal((await json(r)).skipped,true);
  assert.equal((await getOrderProfitBase(db,'done')).lines[0].cogs_iqd,1000);
});

test('the complete orders carry only their revenue\'s share of the period\'s general expenses — never all of it, and not a units share that many cheap pieces would shrink; with no complete order there is nothing to show (review 2026-11-11)',async()=>{
  const {raw,app,sell}=missingSetup();
  // 60 cheap magnets without a price beside setup()'s 2 printers with a FIFO cost: by units the printers would carry 2/62 of the rent.
  await sell('miss',[{id:'miss:a',product:'magnet',qty:60,unit:500}]);
  raw.prepare(`INSERT INTO operating_expenses(id,category_id,amount_iqd,expense_day,title,created_by) VALUES ('rent1','rent',30000,?,'Rent','admin')`).run(baghdadDay());
  const summary=await json(await get(app,`/f/summary?${period()}`));
  type Row={id:string;owner_net_iqd:number;retained_revenue_iqd:number;shipping_income_iqd:number;cod_tax_iqd:number};
  const of=(id:string)=>summary.orders.find((o:Row)=>o.id===id) as Row,revenue=(o:Row)=>o.retained_revenue_iqd+o.shipping_income_iqd+o.cod_tax_iqd;
  const share=Math.round(30000*revenue(of('order'))/(revenue(of('order'))+revenue(of('miss'))));
  assert.equal(summary.known.orders_count,1);assert.equal(summary.known.incomplete_orders,1);
  assert.equal(summary.known.overhead_share_iqd,share);
  assert.ok(share>Math.round(30000*2/62)*10,`the printers' revenue share (${share}), far above a units share`);
  assert.equal(summary.known.owner_net_iqd,of('order').owner_net_iqd-share,'not the whole 30,000 against one order');
  raw.exec("UPDATE order_item_inventory_allocations SET cogs_iqd=NULL,unit_cost_iqd=NULL WHERE order_id='order'");
  const none=await json(await get(app,`/f/summary?${period()}`));
  assert.equal(none.known,null,'no complete order: the tiles keep their dash, never a zero');
});

test('pricing a long list spends its own budget, never the owner\'s shared finance write budget (review 2026-11-11)',async()=>{
  const {raw,sell,line,price}=missingSetup();
  await sell('budget',[{id:'budget:line',product:'magnet',qty:1,unit:500}]);
  assert.equal((await price('budget','budget:line',150,(await line('budget:line')).cost_qty)).status,200);
  const spent=(key:string)=>row<{count:number}>(raw,'SELECT count FROM rate_limits WHERE key=?',key)?.count??0;
  assert.equal(spent('finance-missing-costs:u:admin'),1);
  assert.equal(spent('finance-write:u:admin'),0);
});
