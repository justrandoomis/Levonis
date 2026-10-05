import { badRequest, conflict, notFound } from './http';
import { baghdadDay, dateValue, fence, journalPlan, periodOpen } from './operations';
import { auditStatements } from './audit';
import { newId } from './crypto';

export interface EmploymentStaff {
  id:string; name:string; role:string; user_id:string|null; active:number;
  start_work_date:string|null; archived_at:string|null; employment_version:number; inactive_periods_json:string;
}
export interface StaffReconciliation {
  staff_id:string; revision:number; state:'pending'|'running'|'complete'|'failed';cursor:string;
  processed_orders:number;adjusted_orders:number;error:string;updated_at:string;
  rules_json:string;actor_id:string|null;affected_from?:string|null;affected_until?:string|null;reason?:string;operation_id?:string|null;
}
export const publicReconciliation=(job:StaffReconciliation|null)=>job?{staff_id:job.staff_id,revision:job.revision,state:job.state,cursor:job.cursor,processed_orders:job.processed_orders,adjusted_orders:job.adjusted_orders,error:job.error,updated_at:job.updated_at}:null;
export const employmentInstalled=(db:D1Database)=>db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='finance_staff_reconciliations'").first();
/** A queued retrospective wage can alter both investor profit and, for
 * loss-sharing contracts, recovered principal. Read and payout fences share
 * this predicate so a job created after the balance read also invalidates it. */
export const investorEmploymentPendingSql=(contractSql='e.contract_id',kindSql='e.kind')=>`EXISTS(
  SELECT 1 FROM investment_contracts ec JOIN inventory_lots el ON el.incoming_id=ec.incoming_id
  JOIN order_item_inventory_allocations ea ON ea.lot_id=el.id JOIN orders eo ON eo.id=ea.order_id
  JOIN finance_staff_reconciliations ej JOIN finance_staff es ON es.id=ej.staff_id
  WHERE ec.id=${contractSql} AND ej.state<>'complete' AND eo.id>ej.cursor AND (ej.affected_from IS NULL OR date(eo.delivered_at,'+3 hours')>=ej.affected_from) AND (ej.affected_until IS NULL OR date(eo.delivered_at,'+3 hours')<ej.affected_until)
  AND (${kindSql}='investor_profit' OR ec.loss_share_bps>0 OR EXISTS(SELECT 1 FROM finance_withdrawal_allocations pa WHERE pa.source_id='invprofit:'||ec.id AND pa.source_kind='investor_profit' AND pa.paid_iqd>0))
  AND (EXISTS(SELECT 1 FROM finance_order_costs cost WHERE cost.order_id=eo.id AND cost.staff_id=es.id AND cost.state<>'reversed')
    OR (es.active=1 AND es.archived_at IS NULL AND es.start_work_date IS NOT NULL AND eo.status='delivered' AND date(eo.delivered_at,'+3 hours')>es.start_work_date
      AND json_array_length(ej.rules_json)>0 AND NOT EXISTS(SELECT 1 FROM json_each(es.inactive_periods_json) ip WHERE julianday(eo.delivered_at)>=julianday(json_extract(ip.value,'$.from')) AND (json_extract(ip.value,'$.to') IS NULL OR julianday(eo.delivered_at)<julianday(json_extract(ip.value,'$.to')))))))`;
export const readStaff=(db:D1Database,id:string)=>db.prepare('SELECT * FROM finance_staff WHERE id=?').bind(id).first<EmploymentStaff>();
export const readStaffReconciliation=(db:D1Database,id:string)=>db.prepare('SELECT * FROM finance_staff_reconciliations WHERE staff_id=?').bind(id).first<StaffReconciliation>();
export const employmentDate=(value:unknown)=>value===null||value===''?null:dateValue(value);
export const nextEmploymentDay=(day:string)=>new Date(Date.parse(`${day}T00:00:00Z`)+86400000).toISOString().slice(0,10);
const deliveryTime=(value:unknown)=>typeof value==='string'&&value?Date.parse(value.includes('T')?value:`${value.replace(' ','T')}Z`):NaN;
export function staffDateEligible(staff:Pick<EmploymentStaff,'start_work_date'>,order:Record<string,unknown>) {
  if(!staff.start_work_date)return true;
  const at=deliveryTime(order.delivered_at);
  return order.status==='delivered'&&Number.isFinite(at)&&baghdadDay(new Date(at))>staff.start_work_date;
}
export function staffCanAccrue(staff:EmploymentStaff,order:Record<string,unknown>) {
  if(!staffDateEligible(staff,order))return false;
  // Archiving stops its own interval, not the employee's past deliveries.
  if((!staff.active||staff.archived_at)&&!order.delivered_at)return false;
  const at=deliveryTime(order.delivered_at);
  const periods=JSON.parse(staff.inactive_periods_json) as Array<{from:string;to:string|null}>;
  return !Number.isFinite(at)||!periods.some((p)=>at>=Date.parse(p.from)&&(!p.to||at<Date.parse(p.to)));
}
export async function queueStaffReconciliation(db:D1Database,staffId:string,actor:string|null,statements:D1PreparedStatement[]=[],bump=true,replacementRule?:{id:string;[key:string]:unknown},range?:{from:string;until:string|null;reason:string;operationId:string}) {
  const staff=await readStaff(db,staffId);if(!staff)throw notFound('الموظف غير موجود');
  const revision=staff.employment_version+(bump?1:0),now=new Date().toISOString();
  let rules=(await db.prepare('SELECT * FROM finance_cost_rules WHERE staff_id=? AND active=1 ORDER BY id').bind(staffId).all()).results??[];
  if(replacementRule){rules=rules.filter((r)=>r.id!==replacementRule.id);if(replacementRule.active===1&&replacementRule.staff_id===staffId)rules.push(replacementRule);}
  const previous=await readStaffReconciliation(db,staffId);
  const from=previous&&previous.state!=='complete'?(!previous.affected_from||!range?null:[previous.affected_from,range.from].sort()[0]):range?.from??null;
  const until=previous&&previous.state!=='complete'?(!previous.affected_until||!range?.until?null:[previous.affected_until,range.until].sort().at(-1)!):range?.until??null;
  await db.batch([...fence(db,'EXISTS(SELECT 1 FROM finance_staff WHERE id=? AND employment_version=?)',[staffId,staff.employment_version]),...statements,
    db.prepare('UPDATE finance_staff SET employment_version=? WHERE id=?').bind(revision,staffId),
    db.prepare(`INSERT INTO finance_staff_reconciliations(staff_id,revision,rules_json,actor_id,updated_at,affected_from,affected_until,reason,operation_id) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(staff_id) DO UPDATE SET revision=excluded.revision,state='pending',cursor='',processed_orders=0,adjusted_orders=0,rules_json=excluded.rules_json,error='',actor_id=excluded.actor_id,updated_at=excluded.updated_at,affected_from=excluded.affected_from,affected_until=excluded.affected_until,reason=excluded.reason,operation_id=excluded.operation_id`).bind(staffId,revision,JSON.stringify(rules),actor,now,from,until,range?.reason??'',range?.operationId??null)]);
  return publicReconciliation(await readStaffReconciliation(db,staffId));
}
export async function updateStaffEmployment(db:D1Database,id:string,b:Record<string,unknown>,actor:string,archive=false) {
  const old=await readStaff(db,id);if(!old)throw notFound('الموظف غير موجود');
  const start=b.start_work_date===undefined?old.start_work_date:employmentDate(b.start_work_date);
  const userId=b.user_id===undefined?old.user_id:(typeof b.user_id==='string'?b.user_id.trim():null);
  if(userId&&!(await db.prepare('SELECT id FROM users WHERE id=?').bind(userId).first()))throw badRequest('اختر حسابًا موجودًا');
  if(old.user_id&&old.user_id!==userId&&await db.prepare('SELECT 1 FROM finance_order_costs WHERE staff_id=? UNION ALL SELECT 1 FROM finance_staff_payments WHERE staff_id=? LIMIT 1').bind(id,id).first())throw conflict('هذا الحساب مرتبط باستحقاقات سابقة؛ أضف موظفًا جديدًا للحساب الآخر');
  const now=new Date().toISOString(),archived=archive?old.archived_at??now:b.restore===true?null:old.archived_at;
  const active=archived?0:b.active===undefined?old.active:b.active===true||b.active===1?1:0;
  const periods=JSON.parse(old.inactive_periods_json) as Array<{from:string;to:string|null}>;
  if(old.active&&!active)periods.push({from:now,to:null});
  if(!old.active&&active){const open=[...periods].reverse().find((p)=>!p.to);if(open)open.to=now;}
  const name=b.name===undefined?old.name:typeof b.name==='string'?b.name.trim():'';
  const role=b.role===undefined?old.role:typeof b.role==='string'?b.role.trim():'';
  if(!name||name.length>120||role.length>120)throw badRequest('الاسم أو الدور غير صحيح');
  const changingDate=start!==old.start_work_date;
  const changesAccrual=changingDate||active!==old.active||archived!==old.archived_at;
  // A date edit cannot invalidate money currently reserved for withdrawal.
  const heldSql=`SELECT 1 FROM finance_order_costs c JOIN orders o ON o.id=c.order_id JOIN finance_withdrawal_allocations a ON a.source_kind='staff' AND a.source_id=c.id JOIN finance_withdrawals w ON w.id=a.withdrawal_id WHERE c.staff_id=? AND w.state IN ('requested','approved','part_paid') AND a.amount_iqd>a.paid_iqd AND (? IS NOT NULL AND (o.status<>'delivered' OR o.delivered_at IS NULL OR date(o.delivered_at,'+3 hours')<=?))`;
  if(changingDate&&await db.prepare(heldSql).bind(id,start,start).first())throw conflict('حرر طلب السحب المحجوز قبل تغيير تاريخ استحقاق هذه الطلبات');
  const statements=[...fence(db,'EXISTS(SELECT 1 FROM finance_staff WHERE id=? AND employment_version=? AND user_id IS ? AND name=? AND role=? AND active=? AND start_work_date IS ? AND archived_at IS ? AND inactive_periods_json=?)',[id,old.employment_version,old.user_id,old.name,old.role,old.active,old.start_work_date,old.archived_at,old.inactive_periods_json]),...(changingDate?fence(db,`NOT EXISTS(${heldSql})`,[id,start,start]):[]),
    db.prepare('UPDATE finance_staff SET name=?,role=?,user_id=?,active=?,start_work_date=?,archived_at=?,inactive_periods_json=? WHERE id=?').bind(name,role,userId||null,active,start,archived,JSON.stringify(periods),id),
    ...(await auditStatements(db,actor,archive?'finance.staff_archived':'finance.staff_updated',id,{before:old,after:{name,role,user_id:userId,active,start_work_date:start,archived_at:archived}})).statements];
  try {
    if(!changesAccrual){
      await db.batch([...fence(db,'EXISTS(SELECT 1 FROM finance_staff WHERE id=? AND employment_version=? AND user_id IS ? AND name=? AND role=?)',[id,old.employment_version,old.user_id,old.name,old.role]),...statements]);
      return {staff:await readStaff(db,id),reconciliation:publicReconciliation(await readStaffReconciliation(db,id))};
    }
    if(!old.start_work_date&&start){
      // Undated legacy employees used the creation day in the simple form.
      // Only promote dates with no differing date in the immutable versions.
      const legacy=(await db.prepare(`SELECT id FROM finance_cost_rules r WHERE staff_id=? AND employment_effective_default=0 AND effective_from=date(created_at,'+3 hours') AND effective_to IS NULL AND NOT EXISTS(SELECT 1 FROM finance_rule_versions v WHERE v.rule_id=r.id AND (json_extract(v.snapshot,'$.effective_from')<>r.effective_from OR json_extract(v.snapshot,'$.effective_to') IS NOT NULL))`).bind(id).all<{id:string}>()).results??[];
      for(const rule of legacy)statements.push(db.prepare('UPDATE finance_cost_rules SET employment_effective_default=1 WHERE id=?').bind(rule.id));
      // The queue snapshots below use the same inferred default provenance.
      return await updateWithLegacyRules(db,id,actor,statements,legacy.map((r)=>r.id));
    }
    const reconciliation=await queueStaffReconciliation(db,id,actor,statements);
    return {staff:await readStaff(db,id),reconciliation};
  }catch(e){if(/UNIQUE constraint|cannot be reassigned|CHECK constraint/.test(String(e)))throw conflict('تغير الموظف أثناء الحفظ أو الحساب مرتبط بموظف آخر؛ حدّث الصفحة');throw e;}
}

async function updateWithLegacyRules(db:D1Database,id:string,actor:string,statements:D1PreparedStatement[],legacy:string[]) {
  const staff=(await readStaff(db,id))!,revision=staff.employment_version+1;
  const rules=(await db.prepare('SELECT * FROM finance_cost_rules WHERE staff_id=? AND active=1 ORDER BY id').bind(id).all()).results??[];
  const adjusted=rules.map((r)=>legacy.includes(String(r.id))?{...r,employment_effective_default:1}:r);
  const timeline=await db.prepare("SELECT 1 FROM sqlite_master WHERE name='finance_wage_versions'").first();
  if(timeline)for(const rule of adjusted.filter(r=>legacy.includes(String(r.id)))){
    const old=await db.prepare('SELECT * FROM finance_wage_versions WHERE rule_id=? ORDER BY revision DESC LIMIT 1').bind(rule.id).first<{id:string;revision:number;effective_from:string;effective_until:string|null}>();
    if(!old)continue;
    const version=Number(rule.version)+1,now=new Date().toISOString(),snapshot=JSON.stringify({...rule,version});
    statements.push(db.prepare('INSERT INTO finance_wage_versions(id,rule_id,revision,staff_id,effective_from,effective_until,follows_employment,snapshot,reason,actor_id,recorded_at,supersedes_id) VALUES (?,?,?,?,?,?,1,?,?,?,?,?)').bind(`wage:${rule.id}:${version}`,rule.id,version,id,old.effective_from,old.effective_until,snapshot,'ربط القاعدة الافتراضية بأول تاريخ بدء عمل',actor,now,old.id),
      db.prepare('UPDATE finance_cost_rules SET version=? WHERE id=?').bind(version,rule.id),
      db.prepare('INSERT INTO finance_rule_versions(rule_id,version,snapshot,created_at,actor_id) VALUES (?,?,?,?,?)').bind(rule.id,version,snapshot,now,actor));
  }
  await db.batch([...fence(db,'EXISTS(SELECT 1 FROM finance_staff WHERE id=? AND employment_version=?)',[id,staff.employment_version]),...statements,
    db.prepare('UPDATE finance_staff SET employment_version=? WHERE id=?').bind(revision,id),
    db.prepare(`INSERT INTO finance_staff_reconciliations(staff_id,revision,rules_json,actor_id,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(staff_id) DO UPDATE SET revision=excluded.revision,state='pending',cursor='',processed_orders=0,adjusted_orders=0,rules_json=excluded.rules_json,error='',actor_id=excluded.actor_id,updated_at=excluded.updated_at`).bind(id,revision,JSON.stringify(adjusted),actor,new Date().toISOString())]);
  return {staff:await readStaff(db,id),reconciliation:publicReconciliation(await readStaffReconciliation(db,id))};
}

/** Cutoff edits offset the payable in the current open period. Original costs,
 * cash settlements and manual corrections remain immutable. */
export async function reconcileEmploymentCutoff(db:D1Database,orderId:string,actor?:string,day=baghdadDay()) {
  if(!await employmentInstalled(db))return 0;
  const rows=(await db.prepare(`SELECT c.id,c.rule_id,c.staff_id,c.amount_iqd,c.state,s.start_work_date,s.employment_version,o.status AS order_status,o.delivered_at,
    COALESCE(c.amount_iqd,0)+COALESCE((SELECT SUM(delta_iqd) FROM finance_cost_adjustments a WHERE a.cost_id=c.id),0) AS effective,
    COALESCE(c.amount_iqd,0)+COALESCE((SELECT SUM(delta_iqd) FROM finance_cost_adjustments a WHERE a.cost_id=c.id AND a.employment_version IS NULL),0) AS intended,
    (SELECT COALESCE(SUM(a.amount_iqd-a.paid_iqd),0) FROM finance_withdrawal_allocations a JOIN finance_withdrawals w ON w.id=a.withdrawal_id WHERE a.source_kind='staff' AND a.source_id=c.id AND w.state IN ('requested','approved','part_paid')) AS held
    FROM finance_order_costs c JOIN finance_staff s ON s.id=c.staff_id JOIN orders o ON o.id=c.order_id WHERE c.order_id=? AND c.state IN ('due','approved')`).bind(orderId).all<{id:string;rule_id:string;staff_id:string;amount_iqd:number;state:string;start_work_date:string|null;employment_version:number;order_status:string;delivered_at:string|null;effective:number;intended:number;held:number}>()).results??[];
  const timeline=await db.prepare("SELECT 1 FROM sqlite_master WHERE name='finance_wage_versions'").first();
  const managed=timeline?new Set(((await db.prepare('SELECT DISTINCT rule_id FROM finance_wage_versions').all<{rule_id:string}>()).results??[]).map(r=>r.rule_id)):new Set<string>();
  const statements:D1PreparedStatement[]=[];let changed=0;
  for(const row of rows){
    if(managed.has(row.rule_id))continue;
    const target=staffDateEligible(row,{status:row.order_status,delivered_at:row.delivered_at})?Math.max(0,row.intended):0;
    if(target===row.effective)continue;
    if(row.held>0&&target<row.effective)throw conflict('حرر طلب السحب المحجوز قبل تطبيق تاريخ الاستحقاق');
    const id=newId('employmentfix'),delta=target-row.effective;
    statements.push(...fence(db,`EXISTS(SELECT 1 FROM finance_staff WHERE id=? AND employment_version=?) AND EXISTS(SELECT 1 FROM orders WHERE id=? AND status=? AND delivered_at IS ?) AND (SELECT COALESCE(amount_iqd,0)+COALESCE((SELECT SUM(delta_iqd) FROM finance_cost_adjustments WHERE cost_id=c.id),0) FROM finance_order_costs c WHERE id=?)=? AND NOT EXISTS(SELECT 1 FROM finance_withdrawal_allocations a JOIN finance_withdrawals w ON w.id=a.withdrawal_id WHERE a.source_kind='staff' AND a.source_id=? AND a.amount_iqd>a.paid_iqd AND w.state IN ('requested','approved','part_paid'))`,[row.staff_id,row.employment_version,orderId,row.order_status,row.delivered_at,row.id,row.effective,row.id]),
      db.prepare("INSERT INTO finance_cost_adjustments(id,cost_id,kind,delta_iqd,before_iqd,after_iqd,actor_id,adjustment_day,created_at,employment_version) VALUES (?,?,'recalculation',?,?,?,?,?,?,?)").bind(id,row.id,delta,row.effective,target,actor??null,day,new Date().toISOString(),row.employment_version),
      ...journalPlan(db,{key:`employment-adjustment:${id}`,day,title:'تسوية تاريخ بدء استحقاق الموظف',source:'finance_cost_adjustment',sourceId:id,actor},delta>0?[{account:'5100',debit:delta},{account:'2100',credit:delta}]:[{account:'2100',debit:-delta},{account:'5100',credit:-delta}]).statements,
      ...(await auditStatements(db,actor??null,'finance.staff_employment_adjusted',row.id,{before_iqd:row.effective,after_iqd:target,order_id:orderId,start_work_date:row.start_work_date})).statements);changed++;
  }
  if(statements.length){await periodOpen(db,day);await db.batch(statements);}return changed;
}
