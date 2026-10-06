import { newId, sha256Hex } from './crypto';
import { auditStatements } from './audit';
import { badRequest, conflict, notFound, str } from './http';
import { baghdadDay, dateValue, fence, periodOpen, whole } from './operations';
import { nextEmploymentDay, queueStaffReconciliation, readStaff } from './financeEmployment';
import { effectiveWageRules, wageBoundaries, wageVersionStatement, wageVersions, type EffectiveWageRule, type WageVersion } from './financeWageTimeline';
import { planStaffWages, type WageTarget } from './financeWageCalculation';
import { getOrderProfitBase, getOrderProfitBases } from './orderProfit';
import { participantAdvanceState, participantSources, participantSummary, type ParticipantSource } from './financeParticipants';
import { investorOrderSplit } from './investorFinance';
import { validateRuleScope } from './financeRuleScopes';

export interface WageChangeInput {
  amount:unknown;basis?:unknown;effective_from:unknown;effective_to?:unknown;reason:unknown;
  version:unknown;scope?:unknown;active?:unknown;cap_iqd?:unknown;requires_assignment?:unknown;
  operation_id?:unknown;preview_token?:unknown;release_withdrawals?:unknown;preview_job_id?:unknown;
}
const clock=async(db:D1Database)=>(await db.prepare('SELECT version FROM finance_mutation_clock WHERE id=1').first<{version:number}>())!.version;
async function changeContext(db:D1Database,ruleId:string,input:WageChangeInput,actor:string){
  const old=await db.prepare('SELECT * FROM finance_cost_rules WHERE id=?').bind(ruleId).first<EffectiveWageRule>();
  if(!old?.staff_id)throw notFound('قاعدة الموظف غير موجودة');
  if(whole(input.version,'إصدار القاعدة',1)!==old.version)throw conflict('تغيرت قاعدة الأجر؛ حدّث بيانات الموظف','WAGE_VERSION_CHANGED');
  const staff=(await readStaff(db,old.staff_id))!;
  const from=dateValue(input.effective_from),to=input.effective_to?dateValue(input.effective_to):null;
  if(to&&to<from)throw badRequest('نهاية السريان تسبق بدايته');
  const basis=input.basis===undefined?old.basis:String(input.basis) as EffectiveWageRule['basis'];
  if(!['unit','order','revenue_percent','profit_percent'].includes(basis))throw badRequest('طريقة حساب غير صحيحة');
  const reason=str(input.reason,'سبب التعديل',{min:3,max:500});
  const amount=whole(input.amount,'الأجر أو النسبة',0,basis.endsWith('percent')?10000:1e9);
  const versions=await wageVersions(db,staff.id),now=new Date().toISOString();
  const rule:EffectiveWageRule={...old,version:old.version+1,amount,basis,effective_from:from,effective_to:to,employment_effective_default:0,
    active:input.active===undefined?old.active:input.active===false||input.active===0?0:1,
    scope_json:input.scope===undefined?old.scope_json:JSON.stringify(await validateRuleScope(db,input.scope)),
    cap_iqd:input.cap_iqd===undefined?old.cap_iqd:input.cap_iqd===null||input.cap_iqd===''?null:whole(input.cap_iqd,'سقف الأجر'),
    requires_assignment:input.requires_assignment===undefined?old.requires_assignment:input.requires_assignment?1:0};
  const added:WageVersion={id:`wage:${rule.id}:${rule.version}`,rule_id:rule.id,revision:rule.version,staff_id:staff.id,effective_from:from,effective_until:to?nextEmploymentDay(to):null,follows_employment:0,snapshot:JSON.stringify(rule),reason,actor_id:actor,recorded_at:now};
  const next=wageBoundaries([...versions,added],staff).filter(({v})=>v.rule_id===old.id).map(({from})=>from).filter(day=>day>from).sort()[0];
  const until=[next,to?nextEmploymentDay(to):undefined].filter((v):v is string=>!!v).sort()[0]??null;
  return {old,staff,rule,versions,added,from,until,reason,now};
}

// Completed and interrupted previews from an older calculation must be
// reviewed again after a deploy, even when their source rows did not change.
const PREVIEW_CALCULATION_VERSION=3;
type PreviewDetail={order_id:string;earning_day:string;affected:boolean;units:number;previous_iqd:number;corrected_iqd:number|null;delta_iqd:number;manual_overrides:number;pending_costs:number;investor_delta_iqd:number|null;owner_delta_iqd:number|null};
type PreviewWork={calculation_version:number;projected:ParticipantSource[];detail:PreviewDetail[];affectedCostIds:string[];affectedInvestorIds:string[];pendingTargets:Record<string,number|null>;previous:number;corrected:number;knownCorrected:number;delta:number;units:number;unknown:number;manual:number;investorDelta:number;ownerDelta:number;profitUnknown:number;investorUnknown:number;matched:number;reviewed:number};
type PreviewPage={cursor:string;work?:PreviewWork};
/** Include the old scope when it is removed, and competing rules displaced by
 * the edit. Unrelated rules reviewed by the same reconciliation are not units
 * affected by this wage change. Manual overrides remain visible for review. */
function affectedWageLines(ruleId:string,before:WageTarget[],after:WageTarget[]){
  const key=(t:WageTarget)=>JSON.stringify([t.rule.id,t.line_id]);
  const signature=(t:WageTarget)=>JSON.stringify([t.amount,t.manual,[...t.line_ids].sort()]);
  const beforeByKey=new Map(before.map(t=>[key(t),t]));
  const afterByKey=new Map(after.map(t=>[key(t),t]));
  const lines=new Set<string>();let affected=false;
  for(const [targets,other] of [[before,afterByKey],[after,beforeByKey]] as const)for(const t of targets){
    const counterpart=other.get(key(t));
    const selected=t.rule.id===ruleId&&(t.qty>0||t.manual||t.amount===null||t.amount!==0||!!t.cost?.effective_iqd);
    if(selected||(!counterpart||signature(t)!==signature(counterpart))){affected=true;for(const id of t.line_ids)lines.add(id);}
  }
  return {affected,lines};
}
export async function previewWageChange(db:D1Database,ruleId:string,input:WageChangeInput,actor:string,page?:PreviewPage){
  const beforeClock=await clock(db),context=await changeContext(db,ruleId,input,actor);
  const {staff,rule,versions,added,from,until}=context;
  const orders=(await db.prepare(`SELECT id FROM orders WHERE seller_type='levonis' AND status='delivered' AND date(delivered_at,'+3 hours')>=? AND (? IS NULL OR date(delivered_at,'+3 hours')<?) AND id>? ORDER BY id ${page?'LIMIT 7':''}`).bind(from,until,until,page?.cursor??'').all<{id:string}>()).results??[];
  const sources=staff.user_id?await participantSources(db,staff.user_id):[];
  const advance=staff.user_id?(await participantAdvanceState(db,staff.user_id)).balance:0;
  const projected=page?.work?.projected??sources.map(s=>({...s}));
  const detail:PreviewDetail[]=page?.work?.detail??[];
  const affectedCostIds=page?.work?.affectedCostIds??[];
  const affectedInvestorIds=page?.work?.affectedInvestorIds??[];
  const pendingTargets=page?.work?.pendingTargets??{};
  let {previous=0,corrected=0,knownCorrected=0,delta=0,units=0,unknown=0,manual=0,investorDelta=0,ownerDelta=0,profitUnknown=0,investorUnknown=0,matched=0,reviewed=0}=page?.work??{};
  const scanned=page?orders.slice(0,6):orders;
  reviewed+=scanned.length;
  for(const {id} of scanned){
    const base=await getOrderProfitBase(db,id),targets=await planStaffWages(db,staff,base,[...versions,added]);
    if(!targets.length)continue;
    const beforeTargets=await planStaffWages(db,staff,base,versions);
    const affected=affectedWageLines(ruleId,beforeTargets,targets);
    const oldAmount=targets.reduce((n,t)=>n+(t.cost?.effective_iqd??0),0),pending=targets.filter(t=>t.amount===null).length;
    const newAmount=targets.reduce((n,t)=>n+(t.amount??t.cost?.effective_iqd??0),0);
    const costIds=new Set(targets.map(t=>t.cost?.id).filter(Boolean));
    const simulatedCosts=[...base.costs.filter(c=>!costIds.has(String(c.id))),...targets.map((t,index)=>({
      ...(t.cost??{}),id:t.cost?.id??`preview:${index}`,order_id:id,order_item_id:t.line_id,staff_id:staff.id,
      effective_amount_iqd:t.amount,state:t.amount===null?'pending_cost':'due',
    }))];
    const newBase=(await getOrderProfitBases(db,[id],{costOverrides:{[id]:simulatedCosts}}))[0];
    const [beforeInvestor,afterInvestor]=await Promise.all([investorOrderSplit(db,id),investorOrderSplit(db,id,newBase as unknown as NonNullable<Parameters<typeof investorOrderSplit>[2]>)]);
    for(const a of [...beforeInvestor.allocations,...afterInvestor.allocations]){const id=`invprofit:${a.contract_id}`;if(!affectedInvestorIds.includes(id))affectedInvestorIds.push(id);}
    const investorPending=beforeInvestor.pending||afterInvestor.pending;
    const profitPending=beforeInvestor.owner_profit_iqd===null||afterInvestor.owner_profit_iqd===null;
    const invDelta=investorPending?null:afterInvestor.investor_profit_iqd-beforeInvestor.investor_profit_iqd;
    const ownDelta=profitPending?null:afterInvestor.owner_profit_iqd!-beforeInvestor.owner_profit_iqd!;
    const quantity=base.lines.filter(l=>affected.lines.has(l.id)).reduce((n,l)=>n+Math.max(0,l.qty-l.returned_qty),0);
    const overrides=targets.filter(t=>t.manual).length;
    previous+=oldAmount;corrected+=newAmount;knownCorrected+=targets.reduce((n,t)=>n+(t.amount??0),0);delta+=newAmount-oldAmount;units+=quantity;unknown+=pending;manual+=overrides;
    investorDelta+=invDelta??0;ownerDelta+=ownDelta??0;if(profitPending)profitUnknown++;if(investorPending)investorUnknown++;
    if(affected.affected)matched++;
    if(detail.length<200)detail.push({order_id:id,earning_day:String(base.order.delivered_at),affected:affected.affected,units:quantity,previous_iqd:oldAmount,corrected_iqd:pending?null:newAmount,delta_iqd:newAmount-oldAmount,manual_overrides:overrides,pending_costs:pending,investor_delta_iqd:invDelta,owner_delta_iqd:ownDelta});
    for(const t of targets){
      if(t.cost){affectedCostIds.push(t.cost.id);pendingTargets[t.cost.id]=t.amount;}
      const existing=projected.find(s=>s.id===t.cost?.id&&s.kind==='staff');
      if(existing&&t.amount!==null){existing.amount_iqd=t.amount;existing.accrued_iqd=t.amount;existing.blocked=0;existing.eligible=true;existing.available_iqd=Math.max(0,t.amount-existing.paid_iqd-existing.held_iqd);}
      else if(!existing&&t.amount!==null&&t.amount>0)projected.push({id:`preview:${id}:${t.rule.id}:${t.line_id}`,kind:'staff',title:t.rule.name,order_id:id,day:from,amount_iqd:t.amount,accrued_iqd:t.amount,paid_iqd:0,held_iqd:0,available_iqd:t.amount,state:'due',eligible:true,version:0} satisfies ParticipantSource);
    }
    // Include preserved overrides in the review even if the monetary delta is zero.
  }
  const withdrawals=(await db.prepare(`SELECT DISTINCT w.id,w.amount_iqd,w.paid_iqd,w.state,w.version FROM finance_withdrawals w JOIN finance_withdrawal_allocations a ON a.withdrawal_id=w.id WHERE w.state IN('requested','approved','part_paid') AND ((a.source_kind='staff' AND a.source_id IN (SELECT value FROM json_each(?))) OR (a.source_kind='investor_profit' AND a.source_id IN (SELECT value FROM json_each(?)))) AND a.amount_iqd>a.paid_iqd ORDER BY w.id`).bind(JSON.stringify(affectedCostIds),JSON.stringify(affectedInvestorIds)).all<{id:string;amount_iqd:number;paid_iqd:number;state:string;version:number}>()).results??[];
  const existingBalance=participantSummary(sources,advance),expectedBalance=participantSummary(projected,advance);
  const current=effectiveWageRules(versions,staff,baghdadDay()).find(r=>r.id===ruleId)??null;
  const preview={calculation_version:PREVIEW_CALCULATION_VERSION,rule_id:ruleId,staff_id:staff.id,staff_name:staff.name,current_rule:current,proposed_rule:rule,
    from,until,orders_count:matched,reviewed_orders_count:reviewed,units_count:units,previous_iqd:previous,corrected_iqd:unknown?null:corrected,known_corrected_iqd:knownCorrected,pending_carried_iqd:corrected-knownCorrected,delta_iqd:delta,
    paid_iqd:existingBalance.ledgers.staff.paid_iqd,held_iqd:existingBalance.ledgers.staff.held_iqd,
    before_balance:existingBalance,after_balance:expectedBalance,pending_costs:unknown,manual_overrides:manual,
    investor_delta_iqd:investorUnknown?null:investorDelta,owner_delta_iqd:profitUnknown?null:ownerDelta,
    profit_review_orders:profitUnknown,withdrawals,orders:detail,
    profit_basis:'retained_goods_less_verified_cogs',recorded_at:context.now};
  if(await clock(db)!==beforeClock)throw conflict('تغيرت بيانات الطلبات أثناء المعاينة؛ أعد المعاينة','WAGE_PREVIEW_STALE');
  const token=await sha256Hex(JSON.stringify({calculation_version:PREVIEW_CALCULATION_VERSION,clock:beforeClock,rule:context.rule,reason:context.reason,from,until,actor}));
  return {context,clock:beforeClock,preview:{...preview,preview_token:token},page:{cursor:scanned.at(-1)?.id??page?.cursor??'',complete:!page||orders.length<=6,scanned:scanned.length},work:{calculation_version:PREVIEW_CALCULATION_VERSION,projected,detail,affectedCostIds,affectedInvestorIds,pendingTargets,previous,corrected,knownCorrected,delta,units,unknown,manual,investorDelta,ownerDelta,profitUnknown,investorUnknown,matched,reviewed}};
}

type PreviewJob={id:string;rule_id:string;actor_id:string;input_json:string;source_version:number;cursor:string;processed_orders:number;state:string;work_json:string;result_json:string|null;preview_token:string|null;version:number};
function currentPreviewCalculation(job:PreviewJob){
  return JSON.parse(job.work_json).calculation_version===PREVIEW_CALCULATION_VERSION&&
    (job.state!=='complete'||JSON.parse(job.result_json!).calculation_version===PREVIEW_CALCULATION_VERSION);
}
const previewInput=(input:WageChangeInput)=>JSON.stringify({...input,operation_id:undefined,preview_token:undefined,release_withdrawals:undefined,preview_job_id:undefined});
/** At most six orders per call; refresh/retry resumes at the last committed
 * cursor. Concurrent continuations cannot append a page twice. */
export async function previewWageChangePage(db:D1Database,ruleId:string,input:WageChangeInput,actor:string){
  const request=previewInput(input);
  let job:PreviewJob|null=null;
  if(input.preview_job_id){job=await db.prepare('SELECT * FROM finance_wage_preview_jobs WHERE id=? AND actor_id=? AND rule_id=?').bind(String(input.preview_job_id),actor,ruleId).first<PreviewJob>();if(!job||job.input_json!==request)throw conflict('تغير طلب المعاينة؛ ابدأ معاينة جديدة','WAGE_PREVIEW_STALE');}
  if(job&&(!currentPreviewCalculation(job)||job.source_version!==await clock(db)))throw conflict('تغيرت بيانات الحساب أو طريقة المعاينة؛ حدّث المعاينة قبل التطبيق','WAGE_PREVIEW_STALE');
  if(job?.state==='complete')return {...JSON.parse(job.result_json!),preview_job_id:job.id,complete:true,processed_orders:job.processed_orders};
  const calculated=await previewWageChange(db,ruleId,input,actor,{cursor:job?.cursor??'',work:job?JSON.parse(job.work_json) as PreviewWork:undefined});
  const id=job?.id??newId('wpreview'),processed=(job?.processed_orders??0)+calculated.page.scanned;
  const result={...calculated.preview,preview_job_id:id,complete:calculated.page.complete,processed_orders:processed};
  const statements=[...fence(db,'(SELECT version FROM finance_mutation_clock WHERE id=1)=?',[calculated.clock]),...(job?fence(db,'EXISTS(SELECT 1 FROM finance_wage_preview_jobs WHERE id=? AND version=?)',[id,job.version]):[])];
  if(job)statements.push(db.prepare('UPDATE finance_wage_preview_jobs SET cursor=?,processed_orders=?,state=?,work_json=?,result_json=?,preview_token=?,version=version+1,updated_at=? WHERE id=?').bind(calculated.page.cursor,processed,result.complete?'complete':'running',JSON.stringify(calculated.work),result.complete?JSON.stringify(calculated.preview):null,result.complete?result.preview_token:null,new Date().toISOString(),id));
  else statements.push(db.prepare('INSERT INTO finance_wage_preview_jobs(id,rule_id,actor_id,input_json,source_version,cursor,processed_orders,state,work_json,result_json,preview_token,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').bind(id,ruleId,actor,request,calculated.clock,calculated.page.cursor,processed,result.complete?'complete':'running',JSON.stringify(calculated.work),result.complete?JSON.stringify(calculated.preview):null,result.complete?result.preview_token:null,new Date().toISOString()));
  try{await db.batch(statements);}catch(e){if(/CHECK constraint|UNIQUE/.test(String(e)))throw conflict('تقدمت المعاينة أو تغير المصدر؛ أعد المحاولة','WAGE_PREVIEW_STALE');throw e;}
  return result;
}

export async function applyWageChange(db:D1Database,ruleId:string,input:WageChangeInput,actor:string,requireStoredPreview=false){
  const operation=str(input.operation_id,'رقم العملية',{min:8,max:80});
  const canonical=JSON.stringify({...input,preview_token:undefined,preview_job_id:undefined});
  const prior=await db.prepare('SELECT rule_id,request_json,wage_version_id FROM finance_wage_changes WHERE id=?').bind(operation).first<{rule_id:string;request_json:string;wage_version_id:string}>();
  if(prior){if(prior.rule_id!==ruleId||prior.request_json!==canonical)throw conflict('رقم العملية مستخدم لتغيير آخر');return {already:true,wage_version_id:prior.wage_version_id};}
  const stored=await db.prepare("SELECT * FROM finance_wage_preview_jobs WHERE preview_token=? AND actor_id=? AND rule_id=? AND state='complete' ORDER BY updated_at DESC LIMIT 1").bind(String(input.preview_token),actor,ruleId).first<PreviewJob>();
  if(requireStoredPreview&&!stored)throw conflict('أكمل المعاينة قبل تطبيق التسوية','WAGE_PREVIEW_STALE');
  if(stored&&(!currentPreviewCalculation(stored)||stored.source_version!==await clock(db)||stored.input_json!==previewInput(input)))throw conflict('تغيرت بيانات المعاينة؛ اعرض الأثر المحدّث قبل التطبيق','WAGE_PREVIEW_STALE');
  const calculated=stored?{context:await changeContext(db,ruleId,input,actor),clock:stored.source_version,preview:JSON.parse(stored.result_json!) as Awaited<ReturnType<typeof previewWageChange>>['preview']}:await previewWageChange(db,ruleId,input,actor);
  const {context,preview}=calculated;
  if(input.preview_token!==preview.preview_token)throw conflict('تغيرت بيانات المعاينة؛ اعرض الأثر المحدّث قبل التطبيق','WAGE_PREVIEW_STALE');
  if(preview.withdrawals.length&&input.release_withdrawals!==true)throw conflict('توجد سحوبات مفتوحة؛ اختر تحرير الأجزاء غير المسددة وإعادة اعتمادها','WAGE_WITHDRAWAL_REVIEW');
  const {old,staff,rule,added,reason,now,from,until}=context;
  await periodOpen(db,baghdadDay());
  const fields=['version','amount','basis','effective_from','effective_to','employment_effective_default','active','scope_json','cap_iqd','requires_assignment'] as const;
  const statements=[...fence(db,'(SELECT version FROM finance_mutation_clock WHERE id=1)=? AND EXISTS(SELECT 1 FROM finance_cost_rules WHERE id=? AND version=?)',[calculated.clock,old.id,old.version]),
    db.prepare(`UPDATE finance_cost_rules SET ${fields.map(k=>`${k}=?`).join(',')} WHERE id=?`).bind(...fields.map(k=>rule[k]??null),rule.id),
    db.prepare('INSERT INTO finance_rule_versions(rule_id,version,snapshot,created_at,actor_id) VALUES (?,?,?,?,?)').bind(rule.id,rule.version,JSON.stringify(rule),now,actor),
    wageVersionStatement(db,rule,actor,reason,now,added.id),
    db.prepare('INSERT INTO finance_wage_changes(id,rule_id,wage_version_id,request_json,preview_json,actor_id,created_at) VALUES (?,?,?,?,?,?,?)').bind(operation,rule.id,added.id,canonical,JSON.stringify(preview),actor,now)];
  const pendingTargets=stored?(JSON.parse(stored.work_json) as PreviewWork).pendingTargets:('work' in calculated?calculated.work.pendingTargets:{});
  // One set insert keeps applying even a long preview below D1's statement cap.
  statements.push(db.prepare('INSERT INTO finance_wage_pending_targets(change_id,cost_id,amount_iqd) SELECT ?,key,value FROM json_each(?)').bind(operation,JSON.stringify(pendingTargets)));
  for(const w of preview.withdrawals){
    statements.push(...fence(db,'EXISTS(SELECT 1 FROM finance_withdrawals WHERE id=? AND version=? AND paid_iqd=?)',[w.id,w.version,w.paid_iqd]),
      db.prepare("UPDATE finance_withdrawals SET state='cancelled',closed_by=?,version=version+1,updated_at=?,note=? WHERE id=?").bind(actor,now,`تحرير غير المسدد لإعادة اعتماد الرصيد: ${reason}`,w.id),
      db.prepare('INSERT INTO finance_withdrawal_reviews(id,withdrawal_id,change_id,unpaid_released_iqd,reason,actor_id,created_at) VALUES (?,?,?,?,?,?,?)').bind(newId('wdreview'),w.id,operation,w.amount_iqd-w.paid_iqd,reason,actor,now));
  }
  statements.push(...(await auditStatements(db,actor,'finance.wage_change_applied',rule.id,{operation_id:operation,wage_version_id:added.id,effective_from:from,effective_until:until,reason,delta_iqd:preview.delta_iqd})).statements);
  try{
    const reconciliation=await queueStaffReconciliation(db,staff.id,actor,statements,true,{...rule},{from,until,reason,operationId:operation});
    return {already:false,wage_version_id:added.id,reconciliation,preview};
  }catch(e){if(/CHECK constraint|UNIQUE/.test(String(e)))throw conflict('تغيرت البيانات قبل التطبيق؛ حدّث المعاينة','WAGE_PREVIEW_STALE');throw e;}
}
