import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { badRequest, conflict, forbidden, notFound, requireAdmin, str } from '../lib/http';
import { canViewFinancials } from '../lib/adminScope';
import { auditStatements } from '../lib/audit';
import { newId } from '../lib/crypto';
import { baghdadDay, dateValue, fence, journalPlan, periodOpen, requireCapability, whole } from '../lib/operations';
import { changeWithdrawalState, effectiveStaffCostSql, heldSourceSql, participantOverview, payWithdrawal, staffPaidSql } from '../lib/financeParticipants';
import { reconcileFinanceOrder } from '../lib/financeReconcile';
import { readRuleScope, type ScopedCostRule } from '../lib/financeRuleScopes';

export const adminFinancePeopleRoutes = new Hono<AppContext>();
adminFinancePeopleRoutes.use('*',requireAdmin);
adminFinancePeopleRoutes.use('*',async(c,next)=>{if(!canViewFinancials(c.env,c.get('user')!))throw forbidden('هذه الشاشة تتطلب صلاحية مالية');await next();});
const text=(v:unknown,max=200)=>str(v,'النص',{max,required:false})??'';
adminFinancePeopleRoutes.get('/accounts',async(c)=>{
  await requireCapability(c.env,c.get('user')!,'rules');
  const q=text(c.req.query('q'),120).trim();
  const accounts=await c.env.DB.prepare(`SELECT id,name,email,role,admin_scope FROM users WHERE (?='' AND role='admin') OR (?<>'' AND (instr(lower(name||' '||email||' '||COALESCE(username,'')),lower(?))>0)) ORDER BY CASE WHEN role='admin' THEN 0 ELSE 1 END,name LIMIT 30`).bind(q,q,q).all();
  return c.json({success:true,accounts:accounts.results??[]});
});
adminFinancePeopleRoutes.get('/staff',async(c)=>{
  await requireCapability(c.env,c.get('user')!,'rules');
  const db=c.env.DB;
  const [staff,catalogs,rules]=await Promise.all([
    db.prepare('SELECT s.*,u.name AS account_name,u.email AS account_email,u.role AS account_role FROM finance_staff s LEFT JOIN users u ON u.id=s.user_id ORDER BY s.active DESC,s.name').all(),
    db.prepare('SELECT id,parent_id,name_ar,name_en FROM catalogs WHERE active=1 ORDER BY sort').all(),
    db.prepare('SELECT r.*,s.name AS staff_name FROM finance_cost_rules r LEFT JOIN finance_staff s ON s.id=r.staff_id ORDER BY r.active DESC,r.name').all<ScopedCostRule&Record<string,unknown>>()]);
  const rr=(rules.results??[]).map((r)=>({...r,scope:readRuleScope(r)??{catalog_ids:r.target_type==='catalog'?[r.target_id]:[],product_ids:r.target_type==='product'?[r.target_id]:[],excluded_product_ids:[]}}));
  const ids=[...new Set(rr.flatMap((r)=>[...r.scope.product_ids,...r.scope.excluded_product_ids]))];
  const products=ids.length?await db.prepare('SELECT id,name,name_ar,name_en,sku FROM products WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(ids)).all():{results:[]};
  return c.json({success:true,staff:staff.results??[],catalogs:catalogs.results??[],rules:rr,scope_products:products.results??[]});
});
adminFinancePeopleRoutes.post('/staff',async(c)=>{
  const actor=c.get('user')!;await requireCapability(c.env,actor,'rules');
  const b=await c.req.json<Record<string,unknown>>(),userId=text(b.user_id,100),db=c.env.DB;
  const account=await db.prepare('SELECT id,name,email FROM users WHERE id=?').bind(userId).first<{id:string;name:string;email:string}>();
  if(!account)throw badRequest('اختر حساب الموظف من القائمة');
  const existing=await db.prepare('SELECT id FROM finance_staff WHERE user_id=?').bind(userId).first<{id:string}>();
  if(existing)return c.json({success:true,id:existing.id,staff:await db.prepare('SELECT * FROM finance_staff WHERE id=?').bind(existing.id).first(),already:true});
  const id=newId('staff'),name=text(b.name,120)||account.name||account.email;
  await db.batch([db.prepare('INSERT INTO finance_staff(id,name,role,user_id) VALUES (?,?,?,?)').bind(id,name,text(b.role,120),userId),
    ...(await auditStatements(db,actor.id,'finance.staff_linked',id,{user_id:userId})).statements]);
  return c.json({success:true,id,staff:{id,user_id:userId,name,role:text(b.role,120),active:1}});
});
adminFinancePeopleRoutes.patch('/staff/:id',async(c)=>{
  const actor=c.get('user')!;await requireCapability(c.env,actor,'rules');
  const b=await c.req.json<Record<string,unknown>>(),db=c.env.DB,id=c.req.param('id');
  const old=await db.prepare('SELECT * FROM finance_staff WHERE id=?').bind(id).first<{name:string;role:string;active:number;user_id:string|null}>();
  if(!old)throw notFound('الموظف غير موجود');
  const userId=b.user_id===undefined?old.user_id:text(b.user_id,100);
  if(userId && !(await db.prepare('SELECT id FROM users WHERE id=?').bind(userId).first()))throw badRequest('اختر حسابًا موجودًا');
  if(old.user_id&&old.user_id!==userId && await db.prepare('SELECT 1 FROM finance_order_costs WHERE staff_id=? UNION ALL SELECT 1 FROM finance_staff_payments WHERE staff_id=? LIMIT 1').bind(id,id).first())throw conflict('هذا الحساب مرتبط باستحقاقات سابقة؛ أضف موظفًا جديدًا للحساب الآخر');
  try {await db.batch([...fence(db,'EXISTS(SELECT 1 FROM finance_staff WHERE id=? AND user_id IS ?)',[id,old.user_id]),
    db.prepare('UPDATE finance_staff SET user_id=?,name=?,role=?,active=? WHERE id=?').bind(userId||null,b.name===undefined?old.name:str(b.name,'الاسم',{min:1,max:120}),b.role===undefined?old.role:text(b.role,120),b.active===undefined?old.active:b.active?1:0,id),
    ...(await auditStatements(db,actor.id,'finance.staff_updated',id,{before:old,changes:b})).statements]);}
  catch(e){if(/UNIQUE constraint|cannot be reassigned|CHECK constraint/.test(String(e)))throw conflict('الحساب مرتبط بموظف آخر أو تغير أثناء الحفظ');throw e;}
  return c.json({success:true,id});
});
adminFinancePeopleRoutes.get('/accounts/:id/earnings',async(c)=>{
  await requireCapability(c.env,c.get('user')!,'pay');
  return c.json({success:true,...await participantOverview(c.env.DB,c.req.param('id'))});
});
adminFinancePeopleRoutes.get('/withdrawals',async(c)=>{
  await requireCapability(c.env,c.get('user')!,'pay');
  const offset=whole(c.req.query('offset')??0,'الصفحة',0,100000),state=text(c.req.query('state'),20);
  const rows=await c.env.DB.prepare(`SELECT w.*,u.name AS user_name,u.email AS email FROM finance_withdrawals w JOIN users u ON u.id=w.user_id WHERE (?='' OR w.state=?) ORDER BY CASE WHEN w.state IN ('requested','approved','part_paid') THEN 0 ELSE 1 END,w.created_at DESC LIMIT 100 OFFSET ?`).bind(state,state,offset).all();
  return c.json({success:true,withdrawals:rows.results??[],offset});
});
for(const action of ['approve','reject'] as const)adminFinancePeopleRoutes.post(`/withdrawals/:id/${action}`,async(c)=>{
  const actor=c.get('user')!;await requireCapability(c.env,actor,'pay');
  const b=await c.req.json<Record<string,unknown>>();
  return c.json({success:true,...await changeWithdrawalState(c.env.DB,c.req.param('id'),actor.id,action,undefined,text(b.note,500))});
});
adminFinancePeopleRoutes.post('/withdrawals/:id/pay',async(c)=>{
  const actor=c.get('user')!;await requireCapability(c.env,actor,'pay');
  const b=await c.req.json<Record<string,unknown>>();
  return c.json({success:true,...await payWithdrawal(c.env.DB,actor.id,c.req.param('id'),{
    id:str(b.operation_id,'رقم العملية',{min:8,max:80}),amount:b.amount_iqd===undefined?undefined:whole(b.amount_iqd,'المبلغ',1),reference:text(b.reference,300),receipt_url:text(b.receipt_url,2000),day:dateValue(b.day,baghdadDay()),
  })});
});
adminFinancePeopleRoutes.patch('/costs/:id',async(c)=>{
  const actor=c.get('user')!;await requireCapability(c.env,actor,'pay');
  const b=await c.req.json<Record<string,unknown>>(),amount=whole(b.amount_iqd,'المبلغ'),db=c.env.DB,id=c.req.param('id');
  const old=await db.prepare(`SELECT c.*,${effectiveStaffCostSql()} AS effective_iqd,${staffPaidSql()} AS paid_iqd,${heldSourceSql("'staff'",'c.id')} AS held_iqd FROM finance_order_costs c WHERE c.id=?`).bind(id).first<{state:string;effective_iqd:number|null;paid_iqd:number;held_iqd:number;staff_id:string|null;order_id:string}>();
  if(!old)throw notFound('الاستحقاق غير موجود');
  if(!['due','approved'].includes(old.state)||old.effective_iqd===null)throw conflict('الاستحقاق ينتظر تثبيت التكلفة أو تم عكسه');
  if(old.held_iqd>0 && amount<old.paid_iqd+old.held_iqd)throw conflict('المبلغ أقل من المسدد أو المحجوز للسحب؛ سوِّ طلب السحب أولًا');
  if(amount===old.effective_iqd){const reconciled=await reconcileFinanceOrder(db,old.order_id,{actor:actor.id});return c.json({success:true,already:true,reconciliation_pending:!reconciled.complete});}
  const adjustmentId=newId('wagefix'),day=baghdadDay(),delta=amount-old.effective_iqd;await periodOpen(db,day);
  const liability=old.staff_id?'2100':'2000';
  const lines=delta>0?[{account:'5100',debit:delta},{account:liability,credit:delta}]:[{account:liability,debit:-delta},{account:'5100',credit:-delta}];
  try{await db.batch([...fence(db,`EXISTS(SELECT 1 FROM finance_order_costs c WHERE c.id=? AND c.state=? AND ${effectiveStaffCostSql()}=? AND (${heldSourceSql("'staff'",'c.id')}=0 OR ${staffPaidSql()}+${heldSourceSql("'staff'",'c.id')}<=?))`,[id,old.state,old.effective_iqd,amount]),
    db.prepare('INSERT INTO finance_cost_adjustments(id,cost_id,delta_iqd,before_iqd,after_iqd,actor_id,adjustment_day,created_at) VALUES (?,?,?,?,?,?,?,?)').bind(adjustmentId,id,delta,old.effective_iqd,amount,actor.id,day,new Date().toISOString()),
    ...journalPlan(db,{key:`staff-adjustment:${adjustmentId}`,day,title:old.staff_id?'تصحيح أجر هذا الطلب':'تصحيح تكلفة هذا الطلب',source:'finance_cost_adjustment',sourceId:adjustmentId,actor:actor.id},lines).statements,
    ...(await auditStatements(db,actor.id,'finance.staff_cost_adjusted',id,{before_iqd:old.effective_iqd,after_iqd:amount,order_id:old.order_id})).statements]);}
  catch(e){if(/CHECK constraint/.test(String(e)))throw conflict('تغير الاستحقاق أثناء الحفظ؛ حدّث الصفحة');throw e;}
  const reconciled=await reconcileFinanceOrder(db,old.order_id,{actor:actor.id,day});
  return c.json({success:true,reconciliation_pending:!reconciled.complete,amount_iqd:amount,carryforward_iqd:Math.max(0,old.paid_iqd-amount)});
});
