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
test('a verified cost posts its whole amount when only an untrusted checkout snapshot existed',async()=>{
  const {raw,env,app}=setup();raw.exec('DELETE FROM order_item_inventory_allocations');await runOrderFinancialEffects(env,'order','delivered');
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
test('100 USD monthly owner promotion uses every sold unit, preserves entitlement basis and excludes duplicate overhead',async()=>{
  const {raw,db,add,app}=setup();add('other',1);
  const operation=crypto.randomUUID(),created=await post(app,'/f/promotions',{month:month(),amount:100,currency:'USD',operation_id:operation});assert.equal(created.status,200,JSON.stringify(await json(created)));
  assert.equal((await post(app,'/f/promotions',{month:month(),amount:100,currency:'USD',operation_id:operation})).status,200);
  assert.equal(count(raw,'SELECT COUNT(*) n FROM finance_monthly_promotions'),1);assert.equal(balance(raw,'1000'),-140000);
  const all=await monthlyPromotionShares(db,month());assert.equal(all.total_iqd,140000);assert.equal([...all.shares.values()].reduce((a,b)=>a+b,0),140000);
  const filtered=await json(await get(app,`/f/orders?${period()}&q=order`));assert.equal(filtered.orders.length,1);assert.equal(filtered.orders[0].promotion_iqd,all.shares.get('order:item'));
  const profit=await json(await get(app,'/f/orders/order'));assert.equal(profit.totals.profit_basis_iqd,35000);assert.equal(profit.totals.owner_net_iqd,35000-n(all.shares.get('order:item')));
  const summary=await json(await get(app,`/f/summary?${period()}`));assert.equal(summary.totals.promotion_iqd,140000);assert.equal(summary.totals.general_expenses_iqd,0);
  assert.equal((await post(app,'/f/promotions',{month:month(),amount:100,currency:'USD'})).status,409);
});
const n=(v:unknown)=>Number(v??0);
test('monthly revision reverses its source once, blocks ordinary expense tampering and closed-period edits',async()=>{
  const {raw,app}=setup();const create=await json(await post(app,'/f/promotions',{month:month(),currency:'USD',amount:100})),id=create.id;
  const changed=await patch(app,`/f/promotions/${id}`,{amount:120});assert.equal(changed.status,200,JSON.stringify(await json(changed)));assert.equal(balance(raw,'1000'),-168000);
  assert.equal(count(raw,'SELECT COUNT(*) n FROM finance_promotion_history'),2);
  assert.throws(()=>raw.exec('UPDATE operating_expenses SET amount_iqd=1'),/promotion source/);
  const disabled=await patch(app,`/f/promotions/${id}`,{enabled:false});assert.equal(disabled.status,200,JSON.stringify(await json(disabled)));assert.equal(balance(raw,'1000'),0);
  raw.prepare('INSERT INTO accounting_periods(month,closed_by,closed_at) VALUES (?,?,?)').run(month(),'admin',new Date().toISOString());
  assert.equal((await patch(app,`/f/promotions/${id}`,{enabled:true})).status,409);assert.equal(balance(raw,'1000'),0);
});
test('a month with no sales still deducts unallocated promotion and rent exactly once from period owner result',async()=>{
  const {raw,app}=setup();raw.exec("UPDATE orders SET status='confirmed',delivered_at=NULL");
  await post(app,'/f/promotions',{month:month(),currency:'USD',amount:100});raw.prepare("INSERT INTO operating_expenses(id,category_id,amount_iqd,expense_day,title,created_by) VALUES ('rent-1','rent',20000,?,'Rent','admin')").run(`${month()}-01`);
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
  assert.ok(summary.exceptions.some((e:{type:string})=>e.type==='investor'));
  await reconcileFinanceOrder(db,'order');summary=await json(await get(app,`/f/summary?${period()}`));assert.equal(summary.totals.investor_iqd,3200);assert.equal(summary.totals.owner_net_iqd,28800);
  const detail=await json(await get(app,'/f/orders/order'));assert.equal(detail.totals.owner_net_iqd,summary.totals.owner_net_iqd);
});
test('financial exports and numeric mutations enforce financial scope and emit safe source CSV',async()=>{
  const {app,assistant,raw}=setup();assert.equal((await get(assistant,`/f/summary?${period()}`)).status,403);assert.equal((await get(assistant,`/f/export.csv?${period()}`)).status,403);assert.equal((await edit(assistant,'cogs_iqd',1)).status,403);
  raw.exec("UPDATE order_items SET name_snapshot='=HYPERLINK(\"https://x\")'");const response=await get(app,`/f/export.csv?${period()}`);assert.equal(response.status,200);assert.match(await response.text(),/'=HYPERLINK/);
});
