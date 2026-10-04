import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { badRequest, conflict, forbidden, notFound, requireAdmin, str, unavailable } from '../lib/http';
import { canViewFinancials } from '../lib/adminScope';
import { newId } from '../lib/crypto';
import { auditStatements } from '../lib/audit';
import { baghdadDay, dateValue, decimal, fence, periodOpen, requireCapability, whole } from '../lib/operations';
import { exchangeRate } from '../lib/escrowOps';
import { planExpenseAccounting } from '../lib/expenseAccounting';
import { addOwnerPromotions, applyProfitAdjustment, getOrderProfitBase, getOrderProfitBases, monthlyPromotionShares, planProfitAdjustment, planWorkspaceAccounting, profitFields, profitSourceFingerprint, workspaceInstalled, type OrderProfitBase, type ProfitAdjustment, type ProfitField, type ProfitLine } from '../lib/orderProfit';
import { investorFinanceInstalled, investorOrderSplit, investorProjectionStaleSql } from '../lib/investorFinance';
import { reconcileFinanceOrder } from '../lib/financeReconcile';

type Row=Record<string,unknown>;
const n=(v:unknown)=>Number(v??0),s=(v:unknown)=>String(v??'');
const text=(v:unknown,max=200)=>str(v,'النص',{max,required:false})??'';
export const adminFinanceWorkspaceRoutes=new Hono<AppContext>();
adminFinanceWorkspaceRoutes.use('*',requireAdmin);
adminFinanceWorkspaceRoutes.use('*',async(c,next)=>{
  if(!canViewFinancials(c.env,c.get('user')!))throw forbidden('هذه الشاشة تتطلب صلاحية مالية');
  if(!await workspaceInstalled(c.env.DB))throw unavailable('تحديث مساحة العمل المالية لم يطبق بعد');
  await next();
});
function range(fromValue?:string,toValue?:string){
  const today=baghdadDay(),from=dateValue(fromValue,`${today.slice(0,7)}-01`),to=dateValue(toValue,today);
  const days=(Date.parse(to)-Date.parse(from))/86400000;
  if(days<0||days>365)throw badRequest('اختر فترة لا تتجاوز سنة');
  return {from,to};
}
const sumFields=['net_goods_iqd','retained_revenue_iqd','cogs_iqd','gross_profit_iqd','shipping_income_iqd','cod_tax_iqd','direct_cost_iqd','wages_iqd','materials_iqd','manual_direct_iqd','courier_fee_iqd','payment_fee_iqd','contribution_profit_iqd','profit_basis_iqd','promotion_iqd','investor_iqd','owner_net_iqd','refunded_iqd','refund_iqd','collected_iqd','collection_difference_iqd','pending_costs','unknown_lines','units'];
function sumRows(rows:Row[]):Row {
  const totals:Row={};
  for(const key of sumFields)totals[key]=rows.some((r)=>r[key]===null)?null:rows.reduce((v,r)=>v+n(r[key]),0);
  return totals;
}
function orderRow(base:OrderProfitBase){return {...base.order,...base.totals,id:base.order_id,order_id:base.order_id,version:base.version,
  cost_confidence:base.lines.every((l)=>['fifo','manual_verified'].includes(l.cost_confidence))?'verified':base.lines.some((l)=>l.cogs_iqd===null)?'unknown':'snapshot'};}
function grouped(lines:ProfitLine[],kind:'product'|'main'|'sub'){
  const groups=new Map<string,{name:string;lines:ProfitLine[]}>();
  for(const l of lines){const id=kind==='product'?l.product_id||l.id:kind==='main'?l.main_catalog_id:l.sub_catalog_id;
    if(kind==='sub'&&!id)continue;
    const key=id||'unclassified',name=kind==='product'?l.name_snapshot:kind==='main'?l.main_name:l.sub_name;
    const g=groups.get(key)??{name:name||'غير مصنف',lines:[]};g.lines.push(l);groups.set(key,g);}
  return [...groups].map(([id,g])=>({id,name:g.name,level:kind,qty:g.lines.reduce((v,l)=>v+l.qty,0),...sumRows(g.lines),orders_count:new Set(g.lines.map((l)=>l.order_id)).size}));
}
async function addInvestors(db:D1Database,bases:OrderProfitBase[],live=false){
  await addOwnerPromotions(db,bases);
  if(!await investorFinanceInstalled(db)){for(const b of bases){b.totals.investor_iqd=0;for(const l of b.lines)l.investor_iqd=0;}return bases;}
  if(live){for(const b of bases){const split=await investorOrderSplit(db,b.order_id);
    for(const l of b.lines){const a=split.allocations.filter((a)=>l.allocations.some((v)=>v.id===a.allocation_id));l.investor_iqd=b.order.status==='delivered'?a.reduce((v,a)=>v+a.profit_iqd-a.loss_iqd,0):0;
      l.owner_net_iqd=l.profit_basis_iqd===null||split.pending?null:l.profit_basis_iqd-n(l.promotion_iqd)-n(l.investor_iqd);}
    b.totals.investor_iqd=split.investor_profit_iqd-n(split.investor_loss_iqd);b.totals.owner_net_iqd=b.totals.profit_basis_iqd===null||split.owner_profit_iqd===null?null:split.owner_profit_iqd-n(b.totals.promotion_iqd);
    if(split.pending)b.warnings.push('investor:pending');}return bases;}
  const ids=JSON.stringify(bases.map((b)=>b.order_id));
  const [rows,funded,errors]=await Promise.all([
    db.prepare(`SELECT a.order_id,a.order_item_id,r.profit_iqd,r.loss_iqd,r.pending,r.snapshot,${investorProjectionStaleSql('r.contract_id')} projection_stale FROM investor_allocation_results r JOIN order_item_inventory_allocations a ON a.id=r.allocation_id WHERE a.order_id IN (SELECT value FROM json_each(?))`).bind(ids).all<Row>(),
    db.prepare('SELECT DISTINCT a.order_id,a.order_item_id FROM order_item_inventory_allocations a JOIN inventory_lots l ON l.id=a.lot_id JOIN investment_contracts c ON c.incoming_id=l.incoming_id WHERE a.order_id IN (SELECT value FROM json_each(?)) AND a.released_at IS NULL').bind(ids).all<Row>(),
    db.prepare('SELECT order_id FROM finance_posting_errors WHERE order_id IN (SELECT value FROM json_each(?))').bind(ids).all<Row>()]);
  for(const b of bases){let pending=false;
    for(const l of b.lines){const rr=(rows.results??[]).filter((r)=>r.order_id===b.order_id&&r.order_item_id===l.id),isFunded=(funded.results??[]).some((r)=>r.order_id===b.order_id&&r.order_item_id===l.id);
      const stale=isFunded&&(rr.length===0||rr.some((r)=>n(r.pending)>0||n(r.projection_stale)>0||n(JSON.parse(s(r.snapshot)).version)!==b.version)||(errors.results??[]).some((r)=>r.order_id===b.order_id)||!['fifo','manual_verified'].includes(l.cost_confidence)||l.profit_basis_iqd===null);
      l.investor_iqd=stale?null:rr.reduce((v,r)=>v+n(r.profit_iqd)-n(r.loss_iqd),0);
      l.owner_net_iqd=stale||l.profit_basis_iqd===null?null:l.profit_basis_iqd-n(l.promotion_iqd)-n(l.investor_iqd);pending ||= stale;}
    b.totals.investor_iqd=b.lines.some((l)=>l.investor_iqd===null)?null:b.lines.reduce((v,l)=>v+n(l.investor_iqd),0);
    b.totals.owner_net_iqd=pending||b.totals.profit_basis_iqd===null?null:b.totals.profit_basis_iqd-n(b.totals.promotion_iqd)-n(b.totals.investor_iqd);
    if(pending)b.warnings.push('investor:pending');}
  return bases;
}
async function selectOrders(db:D1Database,r:{from:string;to:string},opts:{q?:string;status?:string;offset?:number;summary?:boolean}={}){
  const q=opts.q??'',status=opts.summary?'delivered':opts.status??'';
  const condition="o.seller_type='levonis' AND date(CASE WHEN o.status='delivered' THEN o.delivered_at ELSE o.created_at END,'+3 hours') BETWEEN ? AND ? AND (?='' OR o.status=?) AND (?='' OR instr(lower(o.id||' '||COALESCE(u.name,'')),lower(?))>0)";
  const args=[r.from,r.to,status,status,q,q];
  const [rows,total]=await Promise.all([
    db.prepare(`SELECT o.id FROM orders o LEFT JOIN users u ON u.id=o.user_id WHERE ${condition} ORDER BY COALESCE(o.delivered_at,o.created_at) DESC,o.id LIMIT ? OFFSET ?`).bind(...args,opts.summary?5001:100,opts.offset??0).all<{id:string}>(),
    db.prepare(`SELECT COUNT(*) total FROM orders o LEFT JOIN users u ON u.id=o.user_id WHERE ${condition}`).bind(...args).first<{total:number}>()]);
  const orderIds=(rows.results??[]).slice(0,opts.summary?5000:100).map((r)=>r.id);
  const rawBases=await getOrderProfitBases(db,orderIds),byId=new Map(rawBases.map((b)=>[b.order_id,b]));
  const bases=orderIds.map((id)=>byId.get(id)!).filter(Boolean);
  await addInvestors(db,bases);return {bases,total:total?.total??0,truncated:(rows.results??[]).length>5000};
}
adminFinanceWorkspaceRoutes.get('/summary',async(c)=>{
  const db=c.env.DB,r=range(c.req.query('from'),c.req.query('to'));
  const {bases,truncated}=await selectOrders(db,r,{summary:true});
  const [expenses,failures,promotions]=await Promise.all([
    db.prepare(`SELECT COALESCE(SUM(e.amount_iqd),0) total FROM operating_expenses e WHERE e.voided_at IS NULL AND e.expense_day BETWEEN ? AND ?
      AND NOT EXISTS(SELECT 1 FROM finance_expense_links l WHERE l.expense_id=e.id AND l.order_id IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM finance_order_costs c WHERE c.expense_id=e.id)
      AND NOT EXISTS(SELECT 1 FROM finance_collections c WHERE c.expense_id=e.id)
      AND NOT EXISTS(SELECT 1 FROM finance_monthly_promotions p WHERE p.expense_id=e.id)`).bind(r.from,r.to).first<{total:number}>(),
    db.prepare('SELECT event_key id,order_id,message,last_attempt_at FROM finance_posting_errors WHERE order_id IN (SELECT value FROM json_each(?)) ORDER BY last_attempt_at DESC LIMIT 100').bind(JSON.stringify(bases.map((b)=>b.order_id))).all<Row>(),
    db.prepare("SELECT *,CASE WHEN currency='IQD' THEN amount_minor ELSE amount_minor/100.0 END amount FROM finance_monthly_promotions WHERE month BETWEEN ? AND ? ORDER BY month,id").bind(r.from.slice(0,7),r.to.slice(0,7)).all<Row>()]);
  const totals=sumRows(bases.map((b)=>b.totals));totals.orders_count=bases.length;totals.general_expenses_iqd=expenses?.total??0;
  let unallocated=0;
  for(const month of new Set((promotions.results??[]).map((p)=>s(p.month))))if(`${month}-01`>=r.from&&`${month}-01`<=r.to)unallocated+=(await monthlyPromotionShares(db,month)).unallocated_iqd;
  totals.unallocated_promotion_iqd=unallocated;
  totals.owner_period_net_iqd=totals.owner_net_iqd===null||truncated?null:n(totals.owner_net_iqd)-n(totals.general_expenses_iqd)-unallocated;
  if(truncated)totals.owner_net_iqd=null;
  const exceptions:Row[]=[...(failures.results??[]).map((e)=>({...e,type:'posting_failed'}))];
  for(const b of bases)for(const warning of b.warnings)exceptions.push({id:`${b.order_id}:${warning}`,order_id:b.order_id,type:warning.split(':')[0],message:warning.startsWith('cost:')?'تكلفة البضاعة تحتاج تثبيت FIFO أو تحققًا ماليًا خاصًا':warning==='investor:pending'?'توزيع المستثمر ينتظر التسوية':'يوجد بند مالي يحتاج مراجعة'});
  for(const b of bases)if(n(b.totals.pending_costs)>0)exceptions.push({id:`${b.order_id}:pending_cost`,order_id:b.order_id,type:'pending_cost',message:'الأجور أو المواد تنتظر تثبيت التكلفة'});
  const lines=bases.flatMap((b)=>b.lines);
  return c.json({success:true,range:r,totals,orders:bases.map(orderRow),products:grouped(lines,'product'),categories:[...grouped(lines,'main'),...grouped(lines,'sub')],exceptions:exceptions.slice(0,200),promotions:promotions.results??[],general_expenses_iqd:totals.general_expenses_iqd,truncated,allocation_basis:'sold_units'});
});
adminFinanceWorkspaceRoutes.get('/orders',async(c)=>{
  const r=range(c.req.query('from'),c.req.query('to')),offset=whole(c.req.query('offset')??0,'الصفحة',0,100000);
  const result=await selectOrders(c.env.DB,r,{offset,q:text(c.req.query('q'),100),status:text(c.req.query('status'),30)});
  return c.json({success:true,orders:result.bases.map(orderRow),total:result.total,offset,range:r});
});
async function detail(db:D1Database,id:string){
  const base=await getOrderProfitBase(db,id);if(base.order.seller_type!=='levonis')throw notFound('Order not found');
  await addInvestors(db,[base],true);
  const history=await db.prepare('SELECT a.id,a.order_item_id line_id,a.field,a.old_value_iqd,a.new_value_iqd,a.version,a.actor_id,u.name actor_name,a.created_at,a.reason,a.journal_id FROM finance_order_adjustments a LEFT JOIN users u ON u.id=a.actor_id WHERE a.order_id=? ORDER BY a.version DESC LIMIT 200').bind(id).all<Row>();
  const wages=await db.prepare("SELECT a.id,c.order_item_id line_id,'amount_iqd' field,a.before_iqd old_value_iqd,a.after_iqd new_value_iqd,a.actor_id,u.name actor_name,a.created_at,a.kind,0 version FROM finance_cost_adjustments a JOIN finance_order_costs c ON c.id=a.cost_id LEFT JOIN users u ON u.id=a.actor_id WHERE c.order_id=? ORDER BY a.created_at DESC LIMIT 200").bind(id).all<Row>();
  return {...base,history:[...(history.results??[]),...(wages.results??[])].sort((a,b)=>s(b.created_at).localeCompare(s(a.created_at))).slice(0,200)};
}
async function reconcileWorkspace(db:D1Database,id:string,actor:string,day:string){
  const result=await reconcileFinanceOrder(db,id,{actor,day});
  if(result.complete)await db.prepare('DELETE FROM finance_posting_errors WHERE event_key=?').bind(`workspace-reconciliation:${id}`).run();
  return !result.complete;
}
adminFinanceWorkspaceRoutes.get('/orders/:id',async(c)=>c.json({success:true,...await detail(c.env.DB,c.req.param('id'))}));
adminFinanceWorkspaceRoutes.post('/orders/:id/adjustments',async(c)=>{
  const db=c.env.DB,actor=c.get('user')!,id=c.req.param('id');await requireCapability(c.env,actor,'accounting');
  const body=await c.req.json<Row>(),field=text(body.field,40) as ProfitField,value=whole(body.value_iqd,'القيمة الجديدة'),lineId=text(body.line_id,100)||null;
  if(!profitFields.includes(field))throw badRequest('الحقل المالي غير صحيح');
  const operationId=body.operation_id===undefined?newId('profitop'):str(body.operation_id,'رقم العملية',{min:8,max:100});
  const old=await db.prepare('SELECT * FROM finance_order_adjustments WHERE operation_id=?').bind(operationId).first<ProfitAdjustment&{actor_id:string}>();
  if(old){if(old.order_id!==id||old.field!==field||old.order_item_id!==lineId||old.new_value_iqd!==value||old.actor_id!==actor.id)throw conflict('رقم العملية مستخدم لتعديل آخر');const pending=await reconcileWorkspace(db,id,actor.id,baghdadDay());return c.json({success:true,already:true,reconciliation_pending:pending,...await detail(db,id)});}
  const source=await profitSourceFingerprint(db,id);
  const [current,plain]=await Promise.all([getOrderProfitBase(db,id),getOrderProfitBases(db,[id],{skipAdjustments:true})]);
  if(current.order.seller_type!=='levonis')throw notFound('Order not found');
  if(['cancelled','returned'].includes(s(current.order.status)))throw conflict('لا يمكن تعديل طلب ملغى');
  const expected=body.version===undefined?current.version:whole(body.version,'نسخة الحساب');
  if(expected!==current.version)throw conflict('تغيرت نسخة الحساب؛ حدّث الطلب');
  const plan=planProfitAdjustment(current,lineId,field,value),next=current.version+1,now=new Date().toISOString(),day=baghdadDay();await periodOpen(db,day);
  const before=JSON.stringify(current),after=JSON.parse(before) as OrderProfitBase;
  const revision:ProfitAdjustment={order_id:id,order_item_id:lineId,field,version:next,old_value_iqd:plan.previous,new_value_iqd:value,allocations_json:JSON.stringify(plan.allocations)};
  applyProfitAdjustment(after,revision);
  const posting=await planWorkspaceAccounting(db,plain[0],after,{actor:actor.id,day});
  const adjustmentId=newId('profitfix');
  try{await db.batch([
    ...fence(db,`(${source.sql.replace(/\?1/g,'?2')})=? AND COALESCE((SELECT version FROM finance_order_versions WHERE order_id=?),0)=?`,[id,source.value,id,expected]),
    db.prepare('INSERT INTO finance_order_versions(order_id,version) VALUES (?,?) ON CONFLICT(order_id) DO UPDATE SET version=excluded.version').bind(id,next),
    ...posting.statements,
    db.prepare('INSERT INTO finance_order_adjustments(id,operation_id,order_id,order_item_id,field,old_value_iqd,new_value_iqd,delta_iqd,version,actor_id,created_at,journal_id,allocations_json,before_json,after_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(adjustmentId,operationId,id,lineId,field,plan.previous,value,plan.delta,next,actor.id,now,posting.journalIds[0]??null,revision.allocations_json,before,JSON.stringify(after)),
    db.prepare('INSERT INTO finance_order_calculations(order_id,version,snapshot,actor_id,created_at) VALUES (?,?,?,?,?)').bind(id,next,JSON.stringify(after),actor.id,now),
    ...(await auditStatements(db,actor.id,'finance.order_adjusted',id,{field,line_id:lineId,before:plan.previous,after:value,version:next,operation_id:operationId})).statements]);}
  catch(e){if(/CHECK constraint|UNIQUE constraint/.test(String(e)))throw conflict('تغير الطلب أثناء الحفظ؛ حدّث الحساب وأعد المحاولة');throw e;}
  const reconciliationPending=await reconcileWorkspace(db,id,actor.id,day);
  return c.json({success:true,reconciliation_pending:reconciliationPending,accounting_pending:posting.pending,...await detail(db,id)});
});
adminFinanceWorkspaceRoutes.get('/promotions',async(c)=>{
  const month=text(c.req.query('month'),7)||baghdadDay().slice(0,7),allocation=await monthlyPromotionShares(c.env.DB,month);
  return c.json({success:true,month,promotions:allocation.promotions,total_iqd:allocation.total_iqd,unallocated_iqd:allocation.unallocated_iqd,allocation_basis:'sold_units'});
});
async function promotionValues(db:D1Database,b:Row,old?:Row){
  const month=b.month===undefined?s(old?.month):text(b.month,7);if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))throw badRequest('الشهر غير صحيح');
  const currency=b.currency===undefined?s(old?.currency||'USD'):text(b.currency,3);if(!['IQD','USD','EUR','CNY'].includes(currency))throw badRequest('العملة غير صحيحة');
  const amount=b.amount===undefined&&old?n(old.amount_minor)/(old.currency==='IQD'?1:100):decimal(b.amount,'المبلغ',0.01),scale=currency==='IQD'?1:100;
  const minor=Math.round(amount*scale);if(!Number.isSafeInteger(minor)||minor<=0||Math.abs(amount*scale-minor)>0.000001)throw badRequest('عدد المنازل العشرية غير صحيح');
  const fx=currency==='IQD'?1:b.exchange_rate===undefined?(old&&currency===old.currency?n(old.exchange_rate):currency==='USD'?await exchangeRate(db):0):decimal(b.exchange_rate,'سعر التحويل',0.000001);
  if(!Number.isFinite(fx)||fx<=0)throw badRequest('أدخل سعر تحويل هذه العملة إلى الدينار');
  const iqd=Math.round(amount*fx);whole(iqd,'قيمة الدينار',1);
  return {month,title:b.title===undefined?s(old?.title||'ترويج شهري'):text(b.title,200)||'ترويج شهري',currency,amount_minor:minor,exchange_rate:fx,amount_iqd:iqd,enabled:b.enabled===undefined?n(old?.enabled??1):b.enabled?1:0};
}
async function promotionWrite(db:D1Database,actor:string,id:string|null,b:Row,disable=false){
  const operationId=b.operation_id===undefined?newId('promoop'):str(b.operation_id,'رقم العملية',{min:8,max:100});
  const prior=await db.prepare('SELECT * FROM finance_promotion_history WHERE operation_id=?').bind(operationId).first<{promotion_id:string;actor_id:string;after_json:string}>();
  const request=JSON.stringify({...b,operation_id:undefined,disable});
  if(prior){const after=JSON.parse(prior.after_json) as Row;if(prior.actor_id!==actor||(id&&id!==prior.promotion_id)||after.request!==request)throw conflict('رقم العملية مستخدم لتعديل آخر');return {id:prior.promotion_id,already:true};}
  const old=id?await db.prepare('SELECT * FROM finance_monthly_promotions WHERE id=?').bind(id).first<Row>():null;if(id&&!old)throw notFound('الترويج غير موجود');
  if(old&&b.version!==undefined&&whole(b.version,'النسخة')!==n(old.version))throw conflict('تغير الترويج؛ حدّث الصفحة');
  const value=await promotionValues(db,disable?{...b,enabled:false}:b,old??undefined),day=`${value.month}-01`,now=new Date().toISOString();
  await periodOpen(db,day);if(old)await periodOpen(db,`${s(old.month)}-01`);
  const promotionId=id??newId('promo'),expenseId=s(old?.expense_id)||newId('expense'),version=n(old?.version)+1;
  if(value.enabled&&await db.prepare('SELECT 1 FROM finance_monthly_promotions WHERE month=? AND enabled=1 AND id<>?').bind(value.month,promotionId).first())throw conflict('يوجد ترويج فعال لهذا الشهر؛ عدّل قيمته');
  const statements:D1PreparedStatement[]=[...fence(db,`NOT EXISTS(SELECT 1 FROM finance_monthly_promotions WHERE month=? AND enabled=1 AND id<>?) OR ?=0`,[value.month,promotionId,value.enabled])];
  if(old)statements.push(...fence(db,'EXISTS(SELECT 1 FROM finance_monthly_promotions WHERE id=? AND version=?)',[promotionId,n(old.version)]),db.prepare('INSERT INTO ops_guards(id,ok) VALUES (?,1)').bind(`promotion-write:${expenseId}`),
    db.prepare('UPDATE operating_expenses SET amount_iqd=?,expense_day=?,title=?,updated_at=?,voided_at=?,voided_by=?,void_reason=? WHERE id=?').bind(value.amount_iqd,day,value.title,now,value.enabled?null:now,value.enabled?null:actor,value.enabled?'':'إيقاف الترويج الشهري',expenseId));
  else statements.push(db.prepare('INSERT INTO operating_expenses(id,category_id,amount_iqd,expense_day,title,created_by,created_at,updated_at,voided_at,voided_by) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(expenseId,'exp_owner_marketing',value.amount_iqd,day,value.title,actor,now,now,value.enabled?null:now,value.enabled?null:actor));
  statements.push(...await planExpenseAccounting(db,{id:expenseId,actor,title:value.title,day,amount:value.amount_iqd,fresh:!old,void:!value.enabled}));
  if(old)statements.push(db.prepare('UPDATE finance_monthly_promotions SET month=?,title=?,currency=?,amount_minor=?,exchange_rate=?,amount_iqd=?,enabled=?,version=?,updated_at=? WHERE id=?').bind(value.month,value.title,value.currency,value.amount_minor,value.exchange_rate,value.amount_iqd,value.enabled,version,now,promotionId));
  else statements.push(db.prepare('INSERT INTO finance_monthly_promotions(id,month,title,currency,amount_minor,exchange_rate,amount_iqd,enabled,expense_id,version,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(promotionId,value.month,value.title,value.currency,value.amount_minor,value.exchange_rate,value.amount_iqd,value.enabled,expenseId,version,actor,now,now));
  const after={id:promotionId,...value,expense_id:expenseId,version,request};
  statements.push(db.prepare('INSERT INTO finance_promotion_history(id,promotion_id,operation_id,version,before_json,after_json,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?)').bind(newId('promohist'),promotionId,operationId,version,JSON.stringify(old??{}),JSON.stringify(after),actor,now));
  if(old)statements.push(db.prepare('DELETE FROM ops_guards WHERE id=?').bind(`promotion-write:${expenseId}`));
  statements.push(...(await auditStatements(db,actor,'finance.monthly_promotion',promotionId,{before:old,after})).statements);
  try{await db.batch(statements);}catch(e){if(/CHECK constraint|UNIQUE constraint/.test(String(e)))throw conflict('تغير الترويج أثناء الحفظ؛ حدّث الصفحة');throw e;}
  return {id:promotionId,promotion:{...after,amount:value.amount_minor/(value.currency==='IQD'?1:100)}};
}
adminFinanceWorkspaceRoutes.post('/promotions',async(c)=>{const actor=c.get('user')!;await requireCapability(c.env,actor,'accounting');return c.json({success:true,...await promotionWrite(c.env.DB,actor.id,null,await c.req.json<Row>())});});
adminFinanceWorkspaceRoutes.patch('/promotions/:id',async(c)=>{const actor=c.get('user')!;await requireCapability(c.env,actor,'accounting');return c.json({success:true,...await promotionWrite(c.env.DB,actor.id,c.req.param('id'),await c.req.json<Row>())});});
adminFinanceWorkspaceRoutes.delete('/promotions/:id',async(c)=>{const actor=c.get('user')!;await requireCapability(c.env,actor,'accounting');return c.json({success:true,...await promotionWrite(c.env.DB,actor.id,c.req.param('id'),{},true)});});
const csvCell=(v:unknown)=>`"${s(v).replace(/^[=+\-@\t\r]/,"'$&").replace(/"/g,'""')}"`;
adminFinanceWorkspaceRoutes.get('/export.csv',async(c)=>{
  const r=range(c.req.query('from'),c.req.query('to')),{bases,truncated}=await selectOrders(c.env.DB,r,{summary:true});if(truncated)throw badRequest('اختر فترة أضيق لتصدير جميع البنود');
  const fields=['order_id','id','product_id','name_snapshot','sku_snapshot','qty','returned_qty','main_name','sub_name','net_goods_iqd','refund_iqd','cogs_iqd','cost_confidence','gross_profit_iqd','wages_iqd','materials_iqd','manual_direct_iqd','shipping_income_iqd','cod_tax_iqd','courier_fee_iqd','payment_fee_iqd','promotion_iqd','investor_iqd','owner_net_iqd'];
  const rows=[fields.map(csvCell).join(','),...bases.flatMap((b)=>b.lines.map((l)=>fields.map((f)=>csvCell(f==='order_id'?b.order_id:l[f])).join(',')))];
  return new Response('\uFEFF'+rows.join('\r\n'),{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="finance-lines-${r.from}-${r.to}.csv"`}});
});
