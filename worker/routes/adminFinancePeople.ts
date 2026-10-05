import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { badRequest, conflict, forbidden, notFound, requireAdmin, str } from '../lib/http';
import { canViewFinancials, isOwner } from '../lib/adminScope';
import { auditStatements } from '../lib/audit';
import { staffPeriodReport } from '../lib/financeParticipantReports';
import { financeRange, financeRangeArgs, inFinanceRangeSql } from '../lib/financeRange';
import { newId } from '../lib/crypto';
import { baghdadDay, dateValue, fence, journalPlan, periodOpen, requireCapability, whole } from '../lib/operations';
import { changeWithdrawalState, effectiveStaffCostSql, heldSourceSql, participantOverview, payWithdrawal, staffPaidSql } from '../lib/financeParticipants';
import { reconcileFinanceOrder } from '../lib/financeReconcile';
import { readRuleScope, type ScopedCostRule } from '../lib/financeRuleScopes';
import { employmentDate, publicReconciliation, readStaff, readStaffReconciliation, staffDateEligible, updateStaffEmployment } from '../lib/financeEmployment';
import { effectiveWageRules, wageVersions } from '../lib/financeWageTimeline';
import { applyWageChange, previewWageChangePage, type WageChangeInput } from '../lib/financeWageChanges';
import { continueStaffReconciliation } from '../lib/financeStaffAccrual';

export const adminFinancePeopleRoutes = new Hono<AppContext>();
adminFinancePeopleRoutes.use('*',requireAdmin);
adminFinancePeopleRoutes.use('*',async(c,next)=>{if(!canViewFinancials(c.env,c.get('user')!))throw forbidden('هذه الشاشة تتطلب صلاحية مالية');await next();});
const text=(v:unknown,max=200)=>str(v,'النص',{max,required:false})??'';
for(const action of ['preview','apply'] as const)adminFinancePeopleRoutes.post(`/rules/:id/${action}`,async c=>{
  const user=c.get('user')!;if(!isOwner(c.env,user))throw forbidden('تغيير الأجر والتسوية الرجعية للأدمن الرئيسي فقط');
  const body=await c.req.json<WageChangeInput>();
  if(action==='preview')return c.json({success:true,...await previewWageChangePage(c.env.DB,c.req.param('id'),body,user.id)});
  return c.json({success:true,...await applyWageChange(c.env.DB,c.req.param('id'),body,user.id,true)});
});
adminFinancePeopleRoutes.get('/staff/:id/history',async c=>{
  await requireCapability(c.env,c.get('user')!,'rules');
  const db=c.env.DB,id=c.req.param('id'),person=await readStaff(db,id);if(!person)throw notFound('الموظف غير موجود');
  const [periods,changes,adjustments,account]=await Promise.all([
    db.prepare('SELECT * FROM finance_wage_periods WHERE staff_id=? ORDER BY rule_id,starts_on DESC').bind(id).all(),
    db.prepare('SELECT v.*,u.name AS actor_name FROM finance_wage_versions v LEFT JOIN users u ON u.id=v.actor_id WHERE v.staff_id=? ORDER BY recorded_at DESC,revision DESC').bind(id).all(),
    db.prepare('SELECT a.*,c.order_id,c.rule_name FROM finance_cost_adjustments a JOIN finance_order_costs c ON c.id=a.cost_id WHERE c.staff_id=? ORDER BY a.created_at DESC LIMIT 200').bind(id).all(),
    person.user_id?participantOverview(db,person.user_id):Promise.resolve(null)]);
  return c.json({success:true,staff:person,periods:periods.results??[],versions:changes.results??[],adjustments:adjustments.results??[],account});
});
adminFinancePeopleRoutes.get('/accounts',async(c)=>{
  await requireCapability(c.env,c.get('user')!,'rules');
  const q=text(c.req.query('q'),120).trim();
  const accounts=await c.env.DB.prepare(`SELECT id,name,email,role,admin_scope FROM users WHERE (?='' AND role='admin') OR (?<>'' AND (instr(lower(name||' '||email||' '||COALESCE(username,'')),lower(?))>0)) ORDER BY CASE WHEN role='admin' THEN 0 ELSE 1 END,name LIMIT 30`).bind(q,q,q).all();
  return c.json({success:true,accounts:accounts.results??[]});
});
adminFinancePeopleRoutes.get('/staff',async(c)=>{
  await requireCapability(c.env,c.get('user')!,'rules');
  const db=c.env.DB;
  const [staff,catalogs,rules,jobs]=await Promise.all([
    db.prepare('SELECT s.*,u.name AS account_name,u.email AS account_email,u.role AS account_role FROM finance_staff s LEFT JOIN users u ON u.id=s.user_id ORDER BY s.active DESC,s.name').all(),
    db.prepare('SELECT id,parent_id,name_ar,name_en FROM catalogs WHERE active=1 ORDER BY sort').all(),
    db.prepare('SELECT r.*,s.name AS staff_name FROM finance_cost_rules r LEFT JOIN finance_staff s ON s.id=r.staff_id ORDER BY r.active DESC,r.name').all<ScopedCostRule&Record<string,unknown>>(),
    db.prepare('SELECT * FROM finance_staff_reconciliations').all<import('../lib/financeEmployment').StaffReconciliation>()]);
  const reportRange=financeRange(c.req.query()),periods=await staffPeriodReport(db,reportRange);
  const histories=await wageVersions(db);
  const currentRules=new Map<string,import('../lib/financeWageTimeline').EffectiveWageRule>();
  const balances=new Map<string,Awaited<ReturnType<typeof participantOverview>>['summary']>();
  for(const employee of staff.results??[]){
    const person=employee as unknown as import('../lib/financeEmployment').EmploymentStaff;
    for(const rule of effectiveWageRules(histories.filter(v=>v.staff_id===person.id),person,baghdadDay()))currentRules.set(rule.id,rule);
    if(person.user_id)balances.set(person.id,(await participantOverview(db,person.user_id)).summary);
  }
  const rr=(rules.results??[]).map(r=>{const current=currentRules.get(String(r.id));return current?{...r,...current,version:r.version}:r;}).map((r)=>({...r,scope:readRuleScope(r)??{catalog_ids:r.target_type==='catalog'?[r.target_id]:[],product_ids:r.target_type==='product'?[r.target_id]:[],excluded_product_ids:[]}}));
  const ids=[...new Set(rr.flatMap((r)=>[...r.scope.product_ids,...r.scope.excluded_product_ids]))];
  const products=ids.length?await db.prepare('SELECT id,name,name_ar,name_en,sku FROM products WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(ids)).all():{results:[]};
  return c.json({success:true,can_manage_staff:isOwner(c.env,c.get('user')!),staff:(staff.results??[]).map(s=>({...s,balance:balances.get(String(s.id))??null,period:periods.get(String(s.id))??{earned_iqd:0,paid_iqd:0,adjustments_iqd:0,pending_costs:0}})),catalogs:catalogs.results??[],rules:rr,scope_products:products.results??[],reconciliations:(jobs.results??[]).map(publicReconciliation)});
});
adminFinancePeopleRoutes.post('/staff',async(c)=>{
  const actor=c.get('user')!;await requireCapability(c.env,actor,'rules');if(!isOwner(c.env,actor))throw forbidden('تعديل الموظفين وتواريخهم للأدمن الرئيسي فقط');
  const b=await c.req.json<Record<string,unknown>>(),userId=text(b.user_id,100),db=c.env.DB;
  const account=await db.prepare('SELECT id,name,email FROM users WHERE id=?').bind(userId).first<{id:string;name:string;email:string}>();
  if(!account)throw badRequest('اختر حساب الموظف من القائمة');
  const existing=await db.prepare('SELECT id FROM finance_staff WHERE user_id=?').bind(userId).first<{id:string}>();
  if(existing)throw conflict(`الحساب مرتبط بموظف موجود؛ عدّل الموظف الحالي (${existing.id})`);
  const id=newId('staff'),name=text(b.name,120)||account.name||account.email,start=b.start_work_date===undefined?null:employmentDate(b.start_work_date),now=new Date().toISOString(),active=b.active===false?0:1;
  await db.batch([db.prepare('INSERT INTO finance_staff(id,name,role,user_id,start_work_date,active,inactive_periods_json) VALUES (?,?,?,?,?,?,?)').bind(id,name,text(b.role,120),userId,start,active,active?'[]':JSON.stringify([{from:now,to:null}])),
    db.prepare("INSERT INTO finance_staff_reconciliations(staff_id,revision,rules_json,actor_id,updated_at) VALUES (?,1,'[]',?,?)").bind(id,actor.id,now),
    ...(await auditStatements(db,actor.id,'finance.staff_linked',id,{user_id:userId})).statements]);
  return c.json({success:true,id,staff:await db.prepare('SELECT * FROM finance_staff WHERE id=?').bind(id).first(),reconciliation:publicReconciliation(await readStaffReconciliation(db,id))});
});
adminFinancePeopleRoutes.patch('/staff/:id',async(c)=>{
  const actor=c.get('user')!;await requireCapability(c.env,actor,'rules');if(!isOwner(c.env,actor))throw forbidden('تعديل الموظفين وتواريخهم للأدمن الرئيسي فقط');
  const b=await c.req.json<Record<string,unknown>>(),db=c.env.DB,id=c.req.param('id');
  return c.json({success:true,id,...await updateStaffEmployment(db,id,b,actor.id)});
});
adminFinancePeopleRoutes.delete('/staff/:id',async(c)=>{
  const actor=c.get('user')!;await requireCapability(c.env,actor,'rules');if(!isOwner(c.env,actor))throw forbidden('تعديل الموظفين وتواريخهم للأدمن الرئيسي فقط');
  return c.json({success:true,id:c.req.param('id'),...await updateStaffEmployment(c.env.DB,c.req.param('id'),{},actor.id,true)});
});
adminFinancePeopleRoutes.get('/staff/:id/reconcile',async(c)=>{
  const actor=c.get('user')!;await requireCapability(c.env,actor,'rules');if(!isOwner(c.env,actor))throw forbidden('تعديل الموظفين وتواريخهم للأدمن الرئيسي فقط');
  const job=await readStaffReconciliation(c.env.DB,c.req.param('id'));
  if(!job)throw notFound('لا توجد إعادة حساب لهذا الموظف');
  return c.json({success:true,reconciliation:publicReconciliation(job)});
});
adminFinancePeopleRoutes.post('/staff/:id/reconcile',async(c)=>{
  const actor=c.get('user')!;await requireCapability(c.env,actor,'rules');if(!isOwner(c.env,actor))throw forbidden('تعديل الموظفين وتواريخهم للأدمن الرئيسي فقط');
  const b=await c.req.json<Record<string,unknown>>();
  // Each order can reconcile several financial sources. Bound browser work
  // to one order; the durable cursor and cron own the remaining pages.
  return c.json({success:true,reconciliation:await continueStaffReconciliation(c.env,c.req.param('id'),b.revision===undefined?undefined:whole(b.revision,'الإصدار',1),1)});
});
adminFinancePeopleRoutes.get('/accounts/:id/earnings',async(c)=>{
  await requireCapability(c.env,c.get('user')!,'pay');
  return c.json({success:true,...await participantOverview(c.env.DB,c.req.param('id'))});
});
adminFinancePeopleRoutes.get('/withdrawals',async(c)=>{
  await requireCapability(c.env,c.get('user')!,'pay');
  const offset=whole(c.req.query('offset')??0,'الصفحة',0,100000),state=text(c.req.query('state'),20);
  const reportRange=financeRange(c.req.query()),args=[state,state,state,...financeRangeArgs(reportRange)];
  const filter=`(?='' OR (?='open' AND w.state IN('requested','approved','part_paid')) OR w.state=?) AND ${inFinanceRangeSql("date(w.created_at,'+3 hours')")}`;
  const [rows,totals]=await Promise.all([
    c.env.DB.prepare(`SELECT w.*,u.name AS user_name,u.email AS email FROM finance_withdrawals w JOIN users u ON u.id=w.user_id WHERE ${filter} ORDER BY CASE WHEN w.state IN ('requested','approved','part_paid') THEN 0 ELSE 1 END,w.created_at DESC,w.id LIMIT 100 OFFSET ?`).bind(...args,offset).all(),
    c.env.DB.prepare(`SELECT COUNT(*) AS count,COALESCE(SUM(w.amount_iqd),0) AS requested_iqd,COALESCE(SUM(w.paid_iqd),0) AS paid_iqd,COALESCE(SUM(CASE WHEN w.state IN('requested','approved','part_paid') THEN w.amount_iqd-w.paid_iqd ELSE 0 END),0) AS held_iqd FROM finance_withdrawals w WHERE ${filter}`).bind(...args).first()]);
  return c.json({success:true,withdrawals:rows.results??[],totals,offset,range:reportRange});
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
  const employee=old.staff_id?await readStaff(db,old.staff_id):null;
  const delivery=await db.prepare('SELECT status,delivered_at FROM orders WHERE id=?').bind(old.order_id).first<{status:string;delivered_at:string|null}>();
  if(employee&&delivery&&!staffDateEligible(employee,delivery))throw conflict('الطلب خارج تاريخ استحقاق الموظف؛ عدّل تاريخ البداية أولًا');
  if(old.held_iqd>0 && amount<old.paid_iqd+old.held_iqd)throw conflict('المبلغ أقل من المسدد أو المحجوز للسحب؛ سوِّ طلب السحب أولًا');
  if(amount===old.effective_iqd){const reconciled=await reconcileFinanceOrder(db,old.order_id,{actor:actor.id});return c.json({success:true,already:true,reconciliation_pending:!reconciled.complete});}
  const adjustmentId=newId('wagefix'),day=baghdadDay(),delta=amount-old.effective_iqd;await periodOpen(db,day);
  const liability=old.staff_id?'2100':'2000';
  const lines=delta>0?[{account:'5100',debit:delta},{account:liability,credit:delta}]:[{account:liability,debit:-delta},{account:'5100',credit:-delta}];
  try{await db.batch([...(employee&&delivery?fence(db,'EXISTS(SELECT 1 FROM finance_staff WHERE id=? AND employment_version=? AND start_work_date IS ?) AND EXISTS(SELECT 1 FROM orders WHERE id=? AND status=? AND delivered_at IS ?)',[employee.id,employee.employment_version,employee.start_work_date,old.order_id,delivery.status,delivery.delivered_at]):[]),...fence(db,`EXISTS(SELECT 1 FROM finance_order_costs c WHERE c.id=? AND c.state=? AND ${effectiveStaffCostSql()}=? AND (${heldSourceSql("'staff'",'c.id')}=0 OR ${staffPaidSql()}+${heldSourceSql("'staff'",'c.id')}<=?))`,[id,old.state,old.effective_iqd,amount]),
    db.prepare('INSERT INTO finance_cost_adjustments(id,cost_id,delta_iqd,before_iqd,after_iqd,actor_id,adjustment_day,created_at) VALUES (?,?,?,?,?,?,?,?)').bind(adjustmentId,id,delta,old.effective_iqd,amount,actor.id,day,new Date().toISOString()),
    ...journalPlan(db,{key:`staff-adjustment:${adjustmentId}`,day,title:old.staff_id?'تصحيح أجر هذا الطلب':'تصحيح تكلفة هذا الطلب',source:'finance_cost_adjustment',sourceId:adjustmentId,actor:actor.id},lines).statements,
    ...(await auditStatements(db,actor.id,'finance.staff_cost_adjusted',id,{before_iqd:old.effective_iqd,after_iqd:amount,order_id:old.order_id})).statements]);}
  catch(e){if(/CHECK constraint/.test(String(e)))throw conflict('تغير الاستحقاق أثناء الحفظ؛ حدّث الصفحة');throw e;}
  const reconciled=await reconcileFinanceOrder(db,old.order_id,{actor:actor.id,day});
  return c.json({success:true,reconciliation_pending:!reconciled.complete,amount_iqd:amount,carryforward_iqd:Math.max(0,old.paid_iqd-amount)});
});
