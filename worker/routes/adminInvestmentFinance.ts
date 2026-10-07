import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAdmin, badRequest, conflict, forbidden, notFound, str } from '../lib/http';
import { canViewCost, isOwner, projectForAdmin } from '../lib/adminScope';
import { newId } from '../lib/crypto';
import { audit } from '../lib/audit';
import { baghdadDay, dateValue, fence, journalPlan, periodOpen, requireCapability, whole } from '../lib/operations';
import { investmentContractSummary, investorOrderSplit, refreshInvestorContract, type InvestmentContract } from '../lib/investorFinance';
import { adminInvestmentProfilesRoutes } from './adminInvestmentProfiles';
import { reconcileFinanceOrder } from '../lib/financeReconcile';

export const adminInvestmentFinanceRoutes = new Hono<AppContext>();
adminInvestmentFinanceRoutes.use('*', requireAdmin);
adminInvestmentFinanceRoutes.route('/',adminInvestmentProfilesRoutes);
const text = (v: unknown, max=200) => str(v,'text',{max,required:false}) ?? '';
async function commit(db:D1Database, statements:D1PreparedStatement[]) {
  try { await db.batch(statements); } catch(e) {
    if (/ops_guards|CHECK constraint|UNIQUE|shares exceed/i.test(String(e))) throw conflict('تغيرت بيانات العملية؛ حدّث الصفحة وأعد المحاولة','INVESTMENT_CHANGED');
    throw e;
  }
}
adminInvestmentFinanceRoutes.get('/config',async c=>{
  await requireCapability(c.env,c.get('user')!,'accounting');
  const [users,incoming,contracts]=await Promise.all([
    c.env.DB.prepare("SELECT id,name,email,admin_scope FROM users WHERE role='admin' AND admin_scope='assistant' ORDER BY name,email").all(),
    c.env.DB.prepare(`SELECT i.id,i.product_id,i.qty_ordered,i.qty_received,i.purchase_unit_iqd,p.name_ar,p.name,
      pl.purchase_id,pl.purchase_id AS purchase_document_id,po.invoice_no,
      CASE WHEN i.shipping_total_iqd IS NULL OR i.internal_delivery_total_iqd IS NULL THEN NULL ELSE COALESCE(i.purchase_total_iqd,i.qty_ordered*i.purchase_unit_iqd)+i.shipping_total_iqd+i.internal_delivery_total_iqd+COALESCE((SELECT SUM(a.amount_iqd) FROM lot_cost_adjustments a WHERE a.incoming_id=i.id),0) END AS total_cost_iqd
      FROM incoming_inventory i LEFT JOIN products p ON p.id=i.product_id LEFT JOIN purchase_lines pl ON pl.incoming_id=i.id
      LEFT JOIN purchase_orders po ON po.id=pl.purchase_id WHERE i.status<>'cancelled' ORDER BY i.created_at DESC LIMIT 300`).all<Record<string,unknown>>(),
    c.env.DB.prepare('SELECT c.*,u.name AS user_name FROM investment_contracts c JOIN users u ON u.id=c.user_id ORDER BY c.created_at DESC LIMIT 300').all(),
  ]);
  return c.json({success:true,users:users.results??[],incoming:(incoming.results??[]).map(i=>({...i,label:`${i.name_ar||i.name||i.product_id} · ${i.invoice_no||i.id}`})),contracts:contracts.results??[]});
});
adminInvestmentFinanceRoutes.get('/contracts',async c=>{
  await requireCapability(c.env,c.get('user')!,'accounting');
  const rows=(await c.env.DB.prepare('SELECT c.*,u.name AS user_name FROM investment_contracts c JOIN users u ON u.id=c.user_id ORDER BY c.created_at DESC LIMIT 300').all()).results??[];
  return c.json({success:true,contracts:rows});
});
adminInvestmentFinanceRoutes.post('/contracts',async c=>{
  const user=c.get('user')!; await requireCapability(c.env,user,'accounting');if(!isOwner(c.env,user))throw forbidden('اتفاقات المستثمرين للأدمن الرئيسي فقط');
  const b=await c.req.json<Record<string,unknown>>(),db=c.env.DB;
  const id=str(b.operation_id,'operation_id',{min:8,max:60});
  const input={incoming_id:str(b.incoming_id,'الشراء',{min:1,max:60}),user_id:str(b.user_id,'المستثمر',{min:1,max:60}),
    name:str(b.name,'اسم العقد',{min:1,max:120}),principal_iqd:whole(b.principal_iqd,'رأس المال',1),
    capital_share_bps:whole(b.capital_share_bps,'نسبة رأس المال',1,10000),profit_share_bps:whole(b.profit_share_bps,'نسبة الربح',0,10000),loss_share_bps:whole(b.loss_share_bps,'نسبة الخسارة',0,10000)};
  const request=JSON.stringify(input),prior=await db.prepare('SELECT request_json FROM investment_contracts WHERE id=?').bind(id).first<{request_json:string}>();
  if(prior){if(prior.request_json!==request)throw conflict('المعرف مستخدم لعقد مختلف');return c.json({success:true,id,already:true});}
  if(!await db.prepare("SELECT id FROM users WHERE id=? AND role='admin' AND admin_scope='assistant'").bind(input.user_id).first())throw badRequest('اختر حساب مساعد أو مسؤول');
  if(!await db.prepare("SELECT id FROM incoming_inventory WHERE id=? AND status<>'cancelled'").bind(input.incoming_id).first())throw badRequest('اختر بند شراء فعالًا');
  const profileStatement=db.prepare("INSERT INTO investment_profiles(user_id,default_profit_share_bps,default_capital_share_bps,default_loss_share_bps,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(user_id) DO NOTHING").bind(input.user_id,input.profit_share_bps,input.capital_share_bps,input.loss_share_bps,user.id,new Date().toISOString(),new Date().toISOString());
  await commit(db,[profileStatement,...fence(db,`NOT EXISTS(SELECT 1 FROM order_item_inventory_allocations a JOIN inventory_lots l ON l.id=a.lot_id WHERE l.incoming_id=? AND a.released_at IS NULL)`,[input.incoming_id]),
    db.prepare('INSERT INTO investment_contracts(id,incoming_id,user_id,name,principal_iqd,capital_share_bps,profit_share_bps,loss_share_bps,created_by,created_at,request_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .bind(id,input.incoming_id,input.user_id,input.name,input.principal_iqd,input.capital_share_bps,input.profit_share_bps,input.loss_share_bps,user.id,new Date().toISOString(),request)]);
  await refreshInvestorContract(db,id); await audit(db,user.id,'investment.contract_created',id,input);
  return c.json({success:true,id});
});
adminInvestmentFinanceRoutes.post('/contracts/:id/funding',async c=>{
  const user=c.get('user')!;await requireCapability(c.env,user,'accounting');
  const b=await c.req.json<Record<string,unknown>>(),db=c.env.DB,id=c.req.param('id');
  if(!isOwner(c.env,user))throw forbidden('تسجيل التمويل للأدمن الرئيسي فقط');
  if(await db.prepare('SELECT 1 FROM purchase_investor_allocations WHERE contract_id=?').bind(id).first())throw conflict('سجّل استلام التمويل من دفعة الشراء لتوزيعه دون تكرار');
  const input={operation_id:str(b.operation_id,'operation_id',{min:8,max:60}),amount_iqd:whole(b.amount_iqd,'المبلغ',1),payment_day:dateValue(b.payment_day,baghdadDay()),reference:text(b.reference,200)};
  const request=JSON.stringify(input),key=`funding:${input.operation_id}`;
  const prior=await db.prepare('SELECT contract_id,snapshot FROM investor_finance_events WHERE event_key=?').bind(key).first<{contract_id:string;snapshot:string}>();
  if(prior){if(prior.contract_id!==id||prior.snapshot!==request)throw conflict('المعرف مستخدم لتمويل مختلف');await refreshInvestorContract(db,id);return c.json({success:true,already:true});}
  const contract=await db.prepare("SELECT * FROM investment_contracts WHERE id=? AND state='active'").bind(id).first<InvestmentContract>();if(!contract)throw notFound('Contract not found');
  await periodOpen(db,input.payment_day);
  await commit(db,[...fence(db,"(SELECT COALESCE(SUM(amount_iqd),0) FROM investor_finance_events WHERE contract_id=? AND kind='funding')+?<=?",[id,input.amount_iqd,contract.principal_iqd]),
    db.prepare('INSERT INTO investor_finance_events(id,event_key,contract_id,kind,amount_iqd,event_day,actor_id,snapshot,created_at) VALUES (?,?,?,\'funding\',?,?,?,?,?)').bind(newId('ive'),key,id,input.amount_iqd,input.payment_day,user.id,request,new Date().toISOString()),
    ...journalPlan(db,{key,day:input.payment_day,title:'تمويل رأس مال دفعة',source:'investor',sourceId:id,actor:user.id},[{account:'1000',debit:input.amount_iqd},{account:'3100',credit:input.amount_iqd}]).statements]);
  await refreshInvestorContract(db,id,input.payment_day);return c.json({success:true});
});
adminInvestmentFinanceRoutes.post('/contracts/:id/void',async c=>{
  if(!isOwner(c.env,c.get('user')!))throw forbidden('إبطال اتفاقات المستثمرين للأدمن الرئيسي فقط');
  const user=c.get('user')!;await requireCapability(c.env,user,'accounting');const db=c.env.DB,b=await c.req.json<Record<string,unknown>>(),id=c.req.param('id'),operation=str(b.operation_id,'operation_id',{min:8,max:60});
  const prior=await db.prepare('SELECT contract_id FROM investment_contract_voids WHERE id=?').bind(operation).first<{contract_id:string}>();if(prior){if(prior.contract_id!==id)throw conflict('المعرف مستخدم لعقد آخر');return c.json({success:true,already:true});}
  const contract=await db.prepare('SELECT * FROM investment_contracts WHERE id=?').bind(id).first<InvestmentContract>();if(!contract)throw notFound('Contract not found');
  await commit(db,[...fence(db,"EXISTS(SELECT 1 FROM investment_contracts WHERE id=? AND state='active') AND NOT EXISTS(SELECT 1 FROM investor_finance_events WHERE contract_id=?) AND NOT EXISTS(SELECT 1 FROM order_item_inventory_allocations a JOIN inventory_lots l ON l.id=a.lot_id WHERE l.incoming_id=? AND a.released_at IS NULL)",[id,id,contract.incoming_id]),db.prepare("UPDATE investment_contracts SET state='void',version=version+1 WHERE id=?").bind(id),db.prepare('INSERT INTO investment_contract_voids(id,contract_id,actor_id,created_at) VALUES (?,?,?,?)').bind(operation,id,user.id,new Date().toISOString())]);
  await audit(db,user.id,'investment.contract_voided',id,{});return c.json({success:true});
});
adminInvestmentFinanceRoutes.get('/contracts/:id',async c=>{
  await requireCapability(c.env,c.get('user')!,'accounting');const db=c.env.DB,id=c.req.param('id');
  const summary=await investmentContractSummary(db,id);
  const linked=await db.prepare('SELECT purchase_id FROM purchase_investor_allocations WHERE contract_id=?').bind(id).first<{purchase_id:string}>();
  if(linked)Object.assign(summary.contract,{purchase_id:linked.purchase_id});
  const [events,lots]=await Promise.all([db.prepare('SELECT * FROM investor_finance_events WHERE contract_id=? ORDER BY created_at,id').bind(id).all(),db.prepare('SELECT * FROM inventory_lots WHERE incoming_id=? ORDER BY received_at,id').bind(summary.contract.incoming_id).all()]);
  const canVoid=!!await db.prepare(`SELECT 1 FROM investment_contracts c WHERE c.id=? AND c.state='active' AND NOT EXISTS(SELECT 1 FROM investor_finance_events e WHERE e.contract_id=c.id) AND NOT EXISTS(SELECT 1 FROM order_item_inventory_allocations a JOIN inventory_lots l ON l.id=a.lot_id WHERE l.incoming_id=c.incoming_id AND a.released_at IS NULL)`).bind(id).first();
  return c.json({success:true,...summary,can_void:canVoid,events:events.results??[],lots:lots.results??[]});
});
adminInvestmentFinanceRoutes.get('/orders/:id',async c=>{
  await requireCapability(c.env,c.get('user')!,'accounting');return c.json({success:true,...await investorOrderSplit(c.env.DB,c.req.param('id'))});
});
adminInvestmentFinanceRoutes.get('/lots',async c=>{
  const user=c.get('user')!;await requireCapability(c.env,user,'receive');const db=c.env.DB,q=text(c.req.query('q'),120),offset=whole(c.req.query('offset')??0,'offset',0,100000);
  const lots=(await db.prepare(`SELECT l.*,p.name,p.name_ar,p.sku,loc.location_id,w.name AS location_name,
    COALESCE((SELECT v.unit_cost_iqd FROM inventory_lot_cost_versions v WHERE v.lot_id=l.id ORDER BY version DESC LIMIT 1),l.unit_cost_iqd) AS effective_unit_cost_iqd,
    pl.purchase_id FROM inventory_lots l LEFT JOIN products p ON p.id=l.product_id LEFT JOIN inventory_lot_locations loc ON loc.lot_id=l.id LEFT JOIN stock_locations w ON w.id=loc.location_id LEFT JOIN purchase_lines pl ON pl.incoming_id=l.incoming_id
    WHERE (?='' OR instr(lower(COALESCE(p.name,'')||' '||COALESCE(p.name_ar,'')||' '||COALESCE(p.sku,'')||' '||l.id),lower(?))>0) ORDER BY l.received_at,l.id LIMIT 200 OFFSET ?`).bind(q,q,offset).all<Record<string,unknown>>()).results??[];
  if(!canViewCost(c.env,user))return c.json({success:true,lots:lots.map(l=>({id:l.id,product_id:l.product_id,scope:l.scope,scope_id:l.scope_id,qty_received:l.qty_received,qty_remaining:l.qty_remaining,incoming_id:l.incoming_id,received_at:l.received_at,name:l.name,name_ar:l.name_ar,sku:l.sku,location_id:l.location_id,location_name:l.location_name})),limit:200,offset});
  const contracts=(await db.prepare('SELECT c.*,u.name AS user_name FROM investment_contracts c JOIN users u ON u.id=c.user_id').all<InvestmentContract>()).results??[];
  return c.json({success:true,lots:lots.map(l=>({...l,contracts:contracts.filter(k=>k.incoming_id===l.incoming_id)})),limit:200,offset});
});
adminInvestmentFinanceRoutes.get('/lots/:id',async c=>{
  const user=c.get('user')!;await requireCapability(c.env,user,'receive');const db=c.env.DB,id=c.req.param('id');
  const lot=await db.prepare(`SELECT l.*,p.name,p.name_ar,COALESCE((SELECT v.unit_cost_iqd FROM inventory_lot_cost_versions v WHERE v.lot_id=l.id ORDER BY version DESC LIMIT 1),l.unit_cost_iqd) AS effective_unit_cost_iqd FROM inventory_lots l LEFT JOIN products p ON p.id=l.product_id WHERE l.id=?`).bind(id).first<Record<string,unknown>>();if(!lot)throw notFound('Lot not found');
  const allocations=(await db.prepare('SELECT a.id,a.order_id,a.order_item_id,a.qty,a.cogs_iqd,a.unit_cost_iqd,a.released_at,o.status FROM order_item_inventory_allocations a JOIN orders o ON o.id=a.order_id WHERE a.lot_id=? ORDER BY a.id').bind(id).all()).results??[];
  if(!canViewCost(c.env,user))return c.json(projectForAdmin(c.env,user,{success:true,lot:{id:lot.id,product_id:lot.product_id,scope:lot.scope,scope_id:lot.scope_id,qty_remaining:lot.qty_remaining,incoming_id:lot.incoming_id,received_at:lot.received_at,name:lot.name,name_ar:lot.name_ar},allocations}));
  const [contracts,adjustments]=await Promise.all([db.prepare("SELECT c.*,u.name AS user_name FROM investment_contracts c JOIN users u ON u.id=c.user_id WHERE incoming_id=? AND c.state='active'").bind(lot.incoming_id).all(),db.prepare(`SELECT v.adjustment_id,v.lot_id,v.version,a.adjustment_day,a.title,v.unit_cost_iqd AS new_unit_cost_iqd,
    v.unit_cost_iqd-COALESCE((SELECT p.unit_cost_iqd FROM inventory_lot_cost_versions p WHERE p.lot_id=v.lot_id AND p.version<v.version ORDER BY p.version DESC LIMIT 1),l.unit_cost_iqd) AS unit_delta_iqd,
    (SELECT SUM(s.amount_iqd) FROM lot_cost_adjustment_shares s WHERE s.adjustment_id=v.adjustment_id AND s.lot_id=v.lot_id) AS amount_iqd,
    (SELECT SUM(s.qty) FROM lot_cost_adjustment_shares s WHERE s.adjustment_id=v.adjustment_id AND s.lot_id=v.lot_id) AS qty
    FROM inventory_lot_cost_versions v JOIN lot_cost_adjustments a ON a.id=v.adjustment_id JOIN inventory_lots l ON l.id=v.lot_id WHERE v.lot_id=? ORDER BY v.version`).bind(id).all()]);
  return c.json({success:true,lot,allocations,contracts:contracts.results??[],adjustments:adjustments.results??[]});
});

adminInvestmentFinanceRoutes.post('/lot-cost-adjustments',async c=>{
  const user=c.get('user')!;await requireCapability(c.env,user,'accounting');const db=c.env.DB,b=await c.req.json<Record<string,unknown>>();
  const id=str(b.operation_id,'operation_id',{min:8,max:60}),incoming=str(b.incoming_id,'الدفعة',{min:1,max:60}),unit=whole(b.new_unit_cost_iqd,'التكلفة الجديدة'),day=dateValue(b.adjustment_day,baghdadDay());
  const request=JSON.stringify({incoming_id:incoming,new_unit_cost_iqd:unit,adjustment_day:day,title:text(b.title,200)});
  const prior=await db.prepare('SELECT request_json FROM lot_cost_adjustments WHERE id=?').bind(id).first<{request_json:string}>();
  if(prior){if(prior.request_json!==request)throw conflict('المعرف مستخدم لتكلفة مختلفة');return c.json({success:true,id,already:true});}
  await periodOpen(db,day);
  const source=await db.prepare('SELECT qty_received,qty_ordered,status FROM incoming_inventory WHERE id=?').bind(incoming).first<{qty_received:number;qty_ordered:number;status:string}>();if(!source||!source.qty_received)throw badRequest('استلم الدفعة قبل تعديل تكلفتها');
  if(source.qty_received!==source.qty_ordered)throw conflict('أكمل استلام بند الشراء قبل تصحيح تكلفته؛ تبقى تكلفة الأجزاء اللاحقة مثبتة بأصل الشراء','PURCHASE_RECEIPT_INCOMPLETE');
  const lots=(await db.prepare(`SELECT l.*,COALESCE((SELECT v.unit_cost_iqd FROM inventory_lot_cost_versions v WHERE v.lot_id=l.id ORDER BY version DESC LIMIT 1),l.unit_cost_iqd) AS effective,
    COALESCE((SELECT MAX(version) FROM inventory_lot_cost_versions WHERE lot_id=l.id),0) AS cost_version FROM inventory_lots l WHERE incoming_id=? ORDER BY id`).bind(incoming).all<{id:string;qty_remaining:number;unit_cost_iqd:number|null;effective:number|null;cost_version:number}>()).results??[];
  if(lots.some(l=>l.effective===null))throw badRequest('أكمل تكلفة الاستلام الأصلية أولًا؛ لا يمكن تصحيح أصل مجهول','UNKNOWN_LOT_COST');
  const sold=(await db.prepare(`SELECT a.*,a.qty-(SELECT COALESCE(SUM(r.qty),0) FROM order_item_inventory_allocations r WHERE r.order_item_id=a.order_item_id AND r.lot_id=a.lot_id AND r.released_at IS NOT NULL) AS net_qty,
    COALESCE((SELECT SUM(s.unit_delta_iqd) FROM lot_cost_adjustment_shares s WHERE s.allocation_id=a.id),0) AS late_delta FROM order_item_inventory_allocations a JOIN inventory_lots l ON l.id=a.lot_id WHERE l.incoming_id=? AND a.released_at IS NULL ORDER BY a.id`).bind(incoming).all<{id:string;lot_id:string;order_id:string;qty:number;net_qty:number;unit_cost_iqd:number|null;late_delta:number}>()).results??[];
  if(sold.some(a=>a.unit_cost_iqd===null))throw badRequest('توجد مبيعات بتكلفة أصل مجهولة','UNKNOWN_LOT_COST');
  const physical=lots.reduce((s,l)=>s+l.qty_remaining,0),consumed=sold.reduce((s,a)=>s+Math.max(0,a.net_qty),0);
  if(physical+consumed!==source.qty_received)throw conflict('توجد خسارة أو فرق جرد في الدفعة؛ سوّه قبل تغيير التكلفة','LOT_QUANTITY_MISMATCH');
  const remaining=lots.map(l=>({lot:l,delta:unit-Number(l.effective),qty:l.qty_remaining}));
  const allocated=sold.filter(a=>a.net_qty>0).map(a=>({a,delta:unit-Number(a.unit_cost_iqd)-a.late_delta,qty:a.net_qty}));
  const amount=remaining.reduce((s,v)=>s+v.delta*v.qty,0)+allocated.reduce((s,v)=>s+v.delta*v.qty,0);if(!amount)throw badRequest('التكلفة لم تتغير','NO_COST_CHANGE');
  const statements=[...fence(db,'EXISTS(SELECT 1 FROM incoming_inventory WHERE id=? AND qty_received=? AND qty_ordered=qty_received)',[incoming,source.qty_received]),
    db.prepare('INSERT INTO lot_cost_adjustments(id,incoming_id,amount_iqd,adjustment_day,title,actor_id,request_json,created_at) VALUES (?,?,?,?,?,?,?,?)').bind(id,incoming,amount,day,text(b.title,200)||'تصحيح تكلفة دفعة',user.id,request,new Date().toISOString())];
  for(const v of remaining){
    statements.push(...fence(db,'EXISTS(SELECT 1 FROM inventory_lots WHERE id=? AND qty_remaining=?) AND COALESCE((SELECT MAX(version) FROM inventory_lot_cost_versions WHERE lot_id=?),0)=?',[v.lot.id,v.qty,v.lot.id,v.lot.cost_version]),
      db.prepare('INSERT INTO inventory_lot_cost_versions(lot_id,version,unit_cost_iqd,adjustment_id) VALUES (?,?,?,?)').bind(v.lot.id,v.lot.cost_version+1,unit,id));
    if(v.qty>0&&v.delta)statements.push(db.prepare('INSERT INTO lot_cost_adjustment_shares(adjustment_id,lot_id,qty,amount_iqd,unit_delta_iqd) VALUES (?,?,?,?,?)').bind(id,v.lot.id,v.qty,v.delta*v.qty,v.delta));
  }
  for(const v of allocated){
    statements.push(...fence(db,`(SELECT qty-(SELECT COALESCE(SUM(r.qty),0) FROM order_item_inventory_allocations r WHERE r.order_item_id=a.order_item_id AND r.lot_id=a.lot_id AND r.released_at IS NOT NULL) FROM order_item_inventory_allocations a WHERE a.id=?)=? AND (SELECT COALESCE(SUM(unit_delta_iqd),0) FROM lot_cost_adjustment_shares WHERE allocation_id=?)=?`,[v.a.id,v.qty,v.a.id,v.a.late_delta]));
    if(v.delta)statements.push(db.prepare('INSERT INTO lot_cost_adjustment_shares(adjustment_id,lot_id,allocation_id,qty,amount_iqd,unit_delta_iqd) VALUES (?,?,?,?,?,?)').bind(id,v.a.lot_id,v.a.id,v.qty,v.delta*v.qty,v.delta));
  }
  statements.push(...journalPlan(db,{key:`lot-cost:${id}`,day,title:'تصحيح فاتورة تكلفة المخزون',source:'lot-cost',sourceId:id,actor:user.id},amount>0?[{account:'1200',debit:amount},{account:'2000',credit:amount}]:[{account:'2000',debit:-amount},{account:'1200',credit:-amount}]).statements);
  await commit(db,statements);
  const pending:string[]=[];for(const order of new Set(sold.map(a=>a.order_id)))if(!(await reconcileFinanceOrder(db,order,{actor:user.id,day})).complete)pending.push(order);
  await audit(db,user.id,'stock.lot_cost_adjusted',id,{incoming_id:incoming,new_unit_cost_iqd:unit,amount_iqd:amount});return c.json({success:true,id,amount_iqd:amount,pending_orders:pending});
});
