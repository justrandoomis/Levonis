import type { Env } from './types';
import { conflict, notFound } from './http';
import { baghdadDay, fence } from './operations';
import { employmentInstalled, publicReconciliation, readStaff, readStaffReconciliation, staffCanAccrue } from './financeEmployment';
import { runOrderFinancialEffects, type CostRule } from './orderFinance';
import { reconcileFinanceOrder } from './financeReconcile';

/** Durable bounded pages. Replaying a page reuses source costs and appends only
 * real deltas; neither an interrupted browser nor a retried cron duplicates pay. */
export async function continueStaffReconciliation(env:Env,staffId:string,revision?:number,maxOrders=25) {
  const db=env.DB,job=await readStaffReconciliation(db,staffId);
  if(!job)throw notFound('لا توجد إعادة حساب معلقة لهذا الموظف');
  if(revision!==undefined&&revision!==job.revision)throw conflict('تغير إعداد الموظف؛ حدّث الصفحة');
  if(job.state==='complete')return publicReconciliation(job);
  const staff=await readStaff(db,staffId);if(!staff||staff.employment_version!==job.revision)throw conflict('تغير إعداد الموظف؛ حدّث الصفحة');
  const rules=JSON.parse(job.rules_json) as CostRule[],day=baghdadDay();
  const selection=`seller_type='levonis' AND ((? IS NOT NULL AND status='delivered' AND date(delivered_at,'+3 hours')>?) OR EXISTS(SELECT 1 FROM finance_order_costs c WHERE c.order_id=orders.id AND c.staff_id=?))`;
  const orders=(await db.prepare(`SELECT id,status,delivered_at FROM orders WHERE id>? AND ${selection} ORDER BY id LIMIT ?`).bind(job.cursor,staff.start_work_date,staff.start_work_date,staffId,Math.max(1,Math.min(10,maxOrders))).all<{id:string;status:string;delivered_at:string|null}>()).results??[];
  let cursor=job.cursor,processed=job.processed_orders,adjusted=job.adjusted_orders;
  try{
    for(const order of orders){
      const before=(await db.prepare(`SELECT (SELECT COUNT(*) FROM finance_order_costs WHERE order_id=? AND staff_id=?)+(SELECT COUNT(*) FROM finance_cost_adjustments a JOIN finance_order_costs c ON c.id=a.cost_id WHERE c.order_id=? AND c.staff_id=?) AS n`).bind(order.id,staffId,order.id,staffId).first<{n:number}>())!.n;
      if(staff.start_work_date&&staffCanAccrue(staff,order)){
        for(const milestone of ['prepared','delivered'] as const)if(rules.some((r)=>r.milestone===milestone))
          await runOrderFinancialEffects(env,order.id,milestone,day,{staffId,employmentVersion:job.revision,rules,skipReconcile:true});
      }
      const reconciled=await reconcileFinanceOrder(db,order.id,{actor:job.actor_id??undefined,day});
      if(!reconciled.complete)throw new Error((await db.prepare('SELECT message FROM finance_posting_errors WHERE event_key=?').bind(`investor:${order.id}`).first<{message:string}>())?.message??'تعذر تحديث التسوية المالية');
      const after=(await db.prepare(`SELECT (SELECT COUNT(*) FROM finance_order_costs WHERE order_id=? AND staff_id=?)+(SELECT COUNT(*) FROM finance_cost_adjustments a JOIN finance_order_costs c ON c.id=a.cost_id WHERE c.order_id=? AND c.staff_id=?) AS n`).bind(order.id,staffId,order.id,staffId).first<{n:number}>())!.n;
      processed++;if(after!==before)adjusted++;
      await db.batch([...fence(db,'EXISTS(SELECT 1 FROM finance_staff WHERE id=? AND employment_version=?) AND EXISTS(SELECT 1 FROM finance_staff_reconciliations WHERE staff_id=? AND revision=? AND cursor=?)',[staffId,job.revision,staffId,job.revision,cursor]),
        db.prepare("UPDATE finance_staff_reconciliations SET cursor=?,processed_orders=?,adjusted_orders=?,state='running',error='',updated_at=? WHERE staff_id=? AND revision=?").bind(order.id,processed,adjusted,new Date().toISOString(),staffId,job.revision)]);
      cursor=order.id;
    }
    const more=await db.prepare(`SELECT 1 FROM orders WHERE id>? AND ${selection} LIMIT 1`).bind(cursor,staff.start_work_date,staff.start_work_date,staffId).first();
    await db.prepare('UPDATE finance_staff_reconciliations SET state=?,error=?,updated_at=? WHERE staff_id=? AND revision=? AND cursor=?').bind(more?'pending':'complete','',new Date().toISOString(),staffId,job.revision,cursor).run();
  }catch(e){
    // The last committed cursor is retained: retry resumes the failing order.
    await db.prepare("UPDATE finance_staff_reconciliations SET state='failed',error=?,updated_at=? WHERE staff_id=? AND revision=? AND cursor=?").bind(String(e instanceof Error?e.message:e).slice(0,1000),new Date().toISOString(),staffId,job.revision,cursor).run();
  }
  return publicReconciliation(await readStaffReconciliation(db,staffId));
}
export async function drainStaffReconciliations(env:Env,opts:{maxJobs?:number;maxOrders?:number}={}) {
  if(!await employmentInstalled(env.DB))return;
  const jobs=(await env.DB.prepare("SELECT staff_id,revision FROM finance_staff_reconciliations WHERE state<>'complete' ORDER BY updated_at,staff_id LIMIT ?").bind(Math.max(1,Math.min(5,opts.maxJobs??2))).all<{staff_id:string;revision:number}>()).results??[];
  for(const job of jobs)await continueStaffReconciliation(env,job.staff_id,job.revision,opts.maxOrders??25);
}
