import { auditStatements } from './audit';
import { newId } from './crypto';
import { conflict } from './http';
import { baghdadDay, fence, journalPlan, periodOpen } from './operations';
import { getOrderProfitBase, profitSourceFingerprint, type OrderProfitBase } from './orderProfit';
import { snapshotFor, costAmount } from './orderFinance';
import { nextEmploymentDay, staffCanAccrue, type EmploymentStaff } from './financeEmployment';
import { effectiveWageRules, wageVersions, type EffectiveWageRule, type WageVersion } from './financeWageTimeline';

export interface WageCost {
  id:string;order_item_id:string|null;rule_id:string;staff_id:string;state:string;snapshot:string;
  amount_iqd:number|null;effective_iqd:number|null;paid_iqd:number;held_iqd:number;
  manual_iqd:number|null;category_id:string;rule_name:string;group_key:string;milestone:string;
}
export interface WageTarget {
  cost:WageCost|null;rule:EffectiveWageRule;line_id:string|null;amount:number|null;
  qty:number;base_iqd:number|null;manual:boolean;line_ids:string[];
}
export const wageCostQuery=`SELECT c.*,
 c.amount_iqd+COALESCE((SELECT SUM(delta_iqd) FROM finance_cost_adjustments WHERE cost_id=c.id),0) AS effective_iqd,
 (SELECT COALESCE(SUM(amount_iqd),0) FROM finance_payment_allocations WHERE cost_id=c.id) AS paid_iqd,
 (SELECT COALESCE(SUM(a.amount_iqd-a.paid_iqd),0) FROM finance_withdrawal_allocations a JOIN finance_withdrawals w ON w.id=a.withdrawal_id WHERE a.source_kind='staff' AND a.source_id=c.id AND w.state IN('requested','approved','part_paid')) AS held_iqd,
 (SELECT after_iqd FROM finance_cost_adjustments WHERE cost_id=c.id AND kind='manual' ORDER BY created_at DESC,id DESC LIMIT 1) AS manual_iqd
 FROM finance_order_costs c WHERE c.order_id=? AND c.staff_id=? AND c.state<>'reversed' ORDER BY c.order_item_id,c.id`;
const key=(rule:string,line:string|null)=>JSON.stringify([rule,line]);
export function deliveryDay(order:Record<string,unknown>):string|null {
  if(order.status!=='delivered'||!order.delivered_at)return null;
  const value=String(order.delivered_at),at=new Date(value.includes('T')?value:`${value.replace(' ','T')}Z`);
  return Number.isNaN(at.getTime())?null:baghdadDay(at);
}
/** This plan is shared by the read-only preview and the posting job. Original
 * order snapshots are evidence, never the authority for a later wage change. */
export async function planStaffWages(db:D1Database,staff:EmploymentStaff,base:OrderProfitBase,versions:WageVersion[]):Promise<WageTarget[]> {
  const old=(await db.prepare(wageCostQuery).bind(base.order_id,staff.id).all<WageCost>()).results??[];
  const managed=new Set(versions.map(v=>v.rule_id));
  const day=deliveryDay(base.order);
  if(!day)return [];
  const eligible=staffCanAccrue(staff,base.order);
  const rules=eligible?effectiveWageRules(versions,staff,day):[];
  // Pre-timeline revisions do not prove when an old value was agreed to start.
  // Keep their already-earned rule as evidence until an explicit new boundary
  // covers this delivery. Migration itself must never silently reprice history.
  if(eligible)for(const cost of old){
    const history=versions.filter(v=>v.rule_id===cost.rule_id&&!versions.some(other=>other.supersedes_id===v.id));
    const baseline=history.find(v=>v.id.startsWith('wage:baseline:')||v.supersedes_id?.startsWith('wage:baseline:'));
    const explicit=history.some(v=>!v.id.startsWith('wage:baseline:')&&!v.supersedes_id&&(v.follows_employment&&staff.start_work_date?nextEmploymentDay(staff.start_work_date):v.effective_from)<=day);
    if(!baseline||explicit)continue;
    const recorded=(JSON.parse(cost.snapshot) as {rule:EffectiveWageRule}).rule;
    const preserved={...recorded,active:1,effective_from:day,effective_to:null,wage_version_id:baseline.id,change_reason:'قيمة تاريخية مثبتة بلقطة الاستحقاق قبل سجل السريان'};
    const index=rules.findIndex(r=>r.id===cost.rule_id);
    if(index<0)rules.push(preserved);else rules[index]=preserved;
  }
  const snapshots=await snapshotFor(db,base.lines,new Date().toISOString(),rules,day);
  const assignments=(await db.prepare('SELECT group_key,staff_id,completed_at FROM finance_task_assignments WHERE order_id=?').bind(base.order_id).all<{group_key:string;staff_id:string;completed_at:string|null}>()).results??[];
  const groups=new Map<string,{rule:EffectiveWageRule;ids:string[]}>();
  for(const line of snapshots)for(const raw of line.rules){
    const rule=raw as EffectiveWageRule;
    const assigned=assignments.find(a=>a.group_key===rule.group_key);
    if(rule.requires_assignment&&(!assigned||assigned.staff_id!==staff.id||(rule.milestone==='prepared'&&!assigned.completed_at)))continue;
    if(assigned&&assigned.staff_id!==staff.id)continue;
    const group=rule.basis==='order'?`${rule.group_key}:${rule.milestone}:order`:key(rule.id,line.line_id);
    const existing=groups.get(group);
    if(existing){existing.ids.push(line.line_id);if((rule.scope_rank??0)>(existing.rule.scope_rank??0)||((rule.scope_rank??0)===(existing.rule.scope_rank??0)&&rule.priority>existing.rule.priority))existing.rule=rule;}
    else groups.set(group,{rule,ids:[line.line_id]});
  }
  const result:WageTarget[]=[],used=new Map<string,number>();
  // Per-order manual overrides take priority and keep their original amount.
  // Do not also create a competing new per-unit/order rule in that work group.
  const manual=old.filter(c=>c.manual_iqd!==null&&managed.has(c.rule_id));
  for(const cost of manual){
    const rule=(JSON.parse(cost.snapshot) as {rule:EffectiveWageRule}).rule;
    const amount=eligible?cost.manual_iqd!:0;
    result.push({cost,rule,line_id:cost.order_item_id,amount,qty:0,base_iqd:null,manual:true,line_ids:cost.order_item_id?[cost.order_item_id]:base.lines.map(l=>l.id)});
    used.set(rule.id,(used.get(rule.id)??0)+amount);
  }
  for(const {rule,ids} of groups.values()){
    const lineId=rule.basis==='order'?null:ids[0];
    if(manual.some(c=>c.group_key===rule.group_key&&c.milestone===rule.milestone&&(c.order_item_id===null||lineId===null||c.order_item_id===lineId)))continue;
    const lines=base.lines.filter(l=>ids.includes(l.id));
    const qty=lines.reduce((n,l)=>n+Math.max(0,l.qty-l.returned_qty),0);
    const revenue=lines.reduce((n,l)=>n+l.retained_revenue_iqd,0);
    const cogs=lines.some(l=>l.cogs_iqd===null||!['fifo','manual_verified'].includes(l.cost_confidence))?null:lines.reduce((n,l)=>n+l.cogs_iqd!,0);
    let amount=qty===0?0:costAmount({...rule,cap_iqd:null},qty,Math.max(0,revenue),cogs);
    if(amount!==null){if(rule.cap_iqd!==null)amount=Math.min(amount,Math.max(0,rule.cap_iqd-(used.get(rule.id)??0)));used.set(rule.id,(used.get(rule.id)??0)+amount);}
    result.push({cost:old.find(c=>key(c.rule_id,c.order_item_id)===key(rule.id,lineId))??null,rule,line_id:lineId,amount,qty,base_iqd:rule.basis==='profit_percent'?(cogs===null?null:Math.max(0,revenue-cogs)):revenue,manual:false,line_ids:ids});
  }
  // Scope exclusions, priority changes and an employment cutoff remove the
  // entitlement with an offset, preserving any payment that already happened.
  for(const cost of old)if(managed.has(cost.rule_id)&&!result.some(t=>t.cost?.id===cost.id)){
    const rule=(JSON.parse(cost.snapshot) as {rule:EffectiveWageRule}).rule;
    result.push({cost,rule,line_id:cost.order_item_id,amount:0,qty:0,base_iqd:0,manual:false,line_ids:cost.order_item_id?[cost.order_item_id]:[]});
  }
  return result;
}

export async function reconcileEffectiveWages(db:D1Database,orderId:string,opts:{actor?:string;day?:string}={}) {
  const allVersions=await wageVersions(db);if(!allVersions.length)return {adjusted:0,managed:new Set<string>()};
  const employees=(await db.prepare('SELECT * FROM finance_staff').all<EmploymentStaff>()).results??[];
  // Undated legacy task-assignment rules retain their established writer until
  // an employment date or an explicit wage revision opts them into the timeline.
  const datedStaff=new Set(employees.filter(s=>s.start_work_date).map(s=>s.id));
  const revisedRules=new Set(allVersions.filter(v=>v.revision>1&&!v.id.startsWith('wage:baseline:')).map(v=>v.rule_id));
  const versions=allVersions.filter(v=>datedStaff.has(v.staff_id)||revisedRules.has(v.rule_id));
  if(!versions.length)return {adjusted:0,managed:new Set<string>()};
  const base=await getOrderProfitBase(db,orderId),earningDay=deliveryDay(base.order);
  const managed=new Set(versions.map(v=>v.rule_id));if(!earningDay)return {adjusted:0,managed:new Set<string>()};
  const source=await profitSourceFingerprint(db,orderId);
  const statements:D1PreparedStatement[]=[],day=opts.day??baghdadDay(),now=new Date().toISOString();let adjusted=0;
  for(const staff of employees){
    const targets=await planStaffWages(db,staff,base,versions.filter(v=>v.staff_id===staff.id));
    if(!targets.length)continue;
    statements.push(...fence(db,'EXISTS(SELECT 1 FROM finance_staff WHERE id=? AND employment_version=?)',[staff.id,staff.employment_version]));
    for(const target of targets){
      const {cost,rule,amount}=target;
      const id=cost?.id??newId('oc'),liability='2100';
      if(cost&&cost.held_iqd>0&&amount!==null&&amount<cost.paid_iqd+cost.held_iqd)throw conflict('طلب سحب مفتوح يحتاج إعادة اعتماد قبل تخفيض الاستحقاق');
      const snapshot=JSON.stringify({rule,qty:target.qty,staff_id:staff.id,earning_day:earningDay,profit_basis:'retained_goods_less_verified_cogs'});
      if(!cost){
        const expense=amount!==null&&amount>0?newId('opex'):null;
        if(expense)statements.push(db.prepare('INSERT INTO operating_expenses(id,category_id,amount_iqd,expense_day,title,note) VALUES (?,?,?,?,?,?)').bind(expense,rule.category_id,amount,day,rule.name,`استحقاق تسليم ${earningDay} / طلب ${orderId}`));
        statements.push(db.prepare('INSERT INTO finance_order_costs(id,order_id,order_item_id,rule_id,rule_version,rule_name,group_key,staff_id,category_id,center_id,milestone,base_iqd,qty,amount_iqd,cost_day,state,expense_id,snapshot) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .bind(id,orderId,target.line_id,rule.id,rule.version,rule.name,rule.group_key,staff.id,rule.category_id,rule.center_id,rule.milestone,target.base_iqd,target.qty,amount,day,amount===null?'pending_cost':'due',expense,snapshot));
        if(amount)statements.push(...journalPlan(db,{key:`order-cost:${id}`,day,title:rule.name,source:'order_cost',sourceId:id,actor:opts.actor},[{account:'5100',debit:amount},{account:liability,credit:amount}]).statements);
        adjusted++;
      }else if(amount!==null&&cost.state==='pending_cost'){
        const expense=amount>0?newId('opex'):null;
        if(expense)statements.push(db.prepare('INSERT INTO operating_expenses(id,category_id,amount_iqd,expense_day,title,note) VALUES (?,?,?,?,?,?)').bind(expense,rule.category_id,amount,day,rule.name,`استحقاق تسليم ${earningDay} / طلب ${orderId}`));
        statements.push(db.prepare("UPDATE finance_order_costs SET amount_iqd=?,state='due',base_iqd=?,expense_id=?,cost_day=? WHERE id=? AND state='pending_cost'").bind(amount,target.base_iqd,expense,day,id));
        if(amount)statements.push(...journalPlan(db,{key:`order-cost:${id}`,day,title:rule.name,source:'order_cost',sourceId:id,actor:opts.actor},[{account:'5100',debit:amount},{account:liability,credit:amount}]).statements);
        adjusted++;
      }else if(cost&&amount!==null&&amount!==cost.effective_iqd){
        const delta=amount-(cost.effective_iqd??0),adjustment=newId('wagefix');
        const revision=(await db.prepare('SELECT COUNT(*) AS n FROM finance_cost_adjustments WHERE cost_id=?').bind(id).first<{n:number}>())!.n;
        const reason=rule.change_reason??'إعادة احتساب الأجر بحسب يوم التسليم وبداية العمل';
        statements.push(db.prepare("INSERT INTO finance_cost_adjustments(id,cost_id,kind,delta_iqd,before_iqd,after_iqd,actor_id,adjustment_day,created_at,employment_version,reason,wage_version_id,earning_day,recalculation_key) VALUES (?,?,'recalculation',?,?,?,?,?,?,?,?,?,?,?)")
          .bind(adjustment,id,delta,cost.effective_iqd??0,amount,opts.actor??null,day,now,staff.employment_version,reason,rule.wage_version_id??null,earningDay,`wage:${id}:${staff.employment_version}:${revision}:${amount}`),
          ...journalPlan(db,{key:`wage-adjustment:${adjustment}`,day,title:reason,source:'finance_cost_adjustment',sourceId:adjustment,actor:opts.actor},delta>0?[{account:'5100',debit:delta},{account:liability,credit:delta}]:[{account:liability,debit:-delta},{account:'5100',credit:-delta}]).statements,
          ...(await auditStatements(db,opts.actor??null,'finance.wage_reconciled',id,{order_id:orderId,staff_id:staff.id,before_iqd:cost.effective_iqd,after_iqd:amount,earning_day:earningDay,wage_version_id:rule.wage_version_id,reason})).statements);
        adjusted++;
      }
      statements.push(db.prepare(`INSERT INTO finance_wage_targets(cost_id,wage_version_id,amount_iqd,basis,employment_version,earning_day,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(cost_id) DO UPDATE SET wage_version_id=excluded.wage_version_id,amount_iqd=excluded.amount_iqd,basis=excluded.basis,employment_version=excluded.employment_version,earning_day=excluded.earning_day,updated_at=excluded.updated_at WHERE wage_version_id IS NOT excluded.wage_version_id OR amount_iqd IS NOT excluded.amount_iqd OR basis<>excluded.basis OR employment_version<>excluded.employment_version OR earning_day<>excluded.earning_day`)
        .bind(id,rule.wage_version_id??null,amount,rule.basis,staff.employment_version,earningDay,now));
    }
  }
  if(statements.length){
    if(adjusted)await periodOpen(db,day);
    // The fingerprint includes all financial inputs and previous adjustments.
    // A replay compares the already corrected amount and posts no second delta.
    try{await db.batch([...fence(db,`${source.sql.replace(/\?1/g,'?2')}=?3`,[orderId,source.value]),...statements]);}
    catch(e){if(/CHECK constraint|UNIQUE constraint/.test(String(e)))throw conflict('تغيرت بيانات الأجر أثناء التسوية؛ أعد المحاولة');throw e;}
  }
  return {adjusted,managed};
}
