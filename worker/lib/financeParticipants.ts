import { investorAccountProgress } from './financeInvestorAccount';
import { hasUnknownRefund, isConfirmedOrderCost } from './financeLedger';
import { accountMovements } from './financeAccountHistory';
import { reconcileEffectiveWages } from './financeWageCalculation';
import { investorProjectionStaleSql } from './investorFinance';
import { getOrderProfitBase } from './orderProfit';
import { newId } from './crypto';
import { badRequest, conflict, notFound } from './http';
import { baghdadDay, fence, journalPlan, periodOpen } from './operations';
import { auditStatements } from './audit';
import { notifyStatement } from './notifications';
import { canViewFinancials, isOwner } from './adminScope';
import type { Env, SessionUser } from './types';
import { employmentInstalled, investorEmploymentPendingSql, nextEmploymentDay, staffDateEligible } from './financeEmployment';

export type BalanceType = 'earnings' | 'capital' | 'all';
export type EarningKind = 'staff' | 'investor_profit' | 'investor_capital';
export interface ParticipantSource {
  id: string; kind: EarningKind; title: string; order_id: string | null; day: string;
  amount_iqd: number; accrued_iqd: number; paid_iqd: number; held_iqd: number; available_iqd: number;
  state: string; eligible: boolean; version: number; staff_id?: string; blocked?: number; pending_cost?:number; pending_payment_cover_iqd?:number;
}
export interface WithdrawalRow {
  id: string; user_id: string; amount_iqd: number; paid_iqd: number;
  state: 'requested' | 'approved' | 'part_paid' | 'paid' | 'rejected' | 'cancelled';
  balance_type: BalanceType; version: number; created_at: string; updated_at: string; note: string; reference: string; receipt_url: string;
}
export const effectiveStaffCostSql = (alias = 'c') => `(${alias}.amount_iqd+COALESCE((SELECT SUM(ca.delta_iqd) FROM finance_cost_adjustments ca WHERE ca.cost_id=${alias}.id),0))`;
export const staffPaidSql = (id = 'c.id') => `(SELECT COALESCE(SUM(pa.amount_iqd),0) FROM finance_payment_allocations pa WHERE pa.cost_id=${id})`;
export const heldSourceSql = (kind: string, id: string) => `(SELECT COALESCE(SUM(wa.amount_iqd-wa.paid_iqd),0) FROM finance_withdrawal_allocations wa JOIN finance_withdrawals w ON w.id=wa.withdrawal_id WHERE wa.source_kind=${kind} AND wa.source_id=${id} AND w.state IN ('requested','approved','part_paid'))`;
const paidSourceSql = (kind: string, id: string) => `(SELECT COALESCE(SUM(wp.paid_iqd),0) FROM finance_withdrawal_allocations wp WHERE wp.source_kind=${kind} AND wp.source_id=${id})`;
// A COGS warning concerns inventory valuation, not a fixed wage or a share of
// sales. Keep that warning for the owner and investors, but do not freeze an
// independently determined wage. Unknown/legacy bases remain conservative;
// all other posting failures and percentage-basis freshness guards still apply.
// Delivery reconciles its own wage synchronously. An older bulk job may still
// be walking historical orders: its cursor is not evidence that this new
// order's current-version target is stale. Release only that proven target;
// older costs and their paid-overpayment reserves remain blocked below.
const currentWageTargetSql=(cost='ec',job='j',order='jo')=>`EXISTS(SELECT 1 FROM finance_wage_targets ready WHERE ready.cost_id=${cost}.id AND ready.employment_version=${job}.revision AND ready.amount_iqd=${effectiveStaffCostSql(cost)} AND ready.earning_day=date(${order}.delivered_at,'+3 hours'))`;
// Match the refund evidence used by getOrderProfitBase, including pre-ledger
// returns. A refreshed basis fingerprint alone never proves a missing amount.
const unknownWageRefundSql=(orderSql:string,itemSql:string)=>`EXISTS(SELECT 1 FROM return_cases ur WHERE ur.order_id=${orderSql} AND (${itemSql} IS NULL OR ur.order_item_id=${itemSql}) AND ur.state='resolved' AND ur.resolution='refund' AND
  CASE WHEN EXISTS(SELECT 1 FROM finance_refund_facts uf WHERE uf.case_id=ur.id) THEN (SELECT uf.refund_iqd FROM finance_refund_facts uf WHERE uf.case_id=ur.id)
  ELSE COALESCE((SELECT json_extract(ua.detail,'$.refund.amount_iqd') FROM audit_log ua WHERE ua.action='return.transition' AND ua.target=ur.id AND json_valid(ua.detail) AND json_extract(ua.detail,'$.refund.amount_iqd') IS NOT NULL ORDER BY ua.id DESC LIMIT 1),(SELECT uw.amount_iqd FROM wallet_transactions uw WHERE uw.id='wtx_ret_'||ur.id AND uw.status='approved')) END IS NULL)`;
export const staffReconciliationBlockedSql=(orderSql='c.order_id',costSql='c.id',includeLate=true)=>`(EXISTS(SELECT 1 FROM finance_wage_targets wt WHERE wt.cost_id=${costSql} AND wt.amount_iqd IS NULL) OR EXISTS(SELECT 1 FROM finance_order_costs ec JOIN finance_staff es ON es.id=ec.staff_id JOIN orders eo ON eo.id=ec.order_id WHERE ec.id=${costSql} AND COALESCE(ec.amount_iqd,0)+COALESCE((SELECT SUM(delta_iqd) FROM finance_cost_adjustments ca WHERE ca.cost_id=ec.id),0)>0 AND es.start_work_date IS NOT NULL AND (eo.status<>'delivered' OR COALESCE(date(eo.delivered_at,'+3 hours')>es.start_work_date,0)=0)) OR EXISTS(SELECT 1 FROM finance_staff_reconciliations j JOIN finance_order_costs ec ON ec.staff_id=j.staff_id JOIN orders jo ON jo.id=ec.order_id WHERE ec.id=${costSql} AND j.state<>'complete' AND ec.order_id>j.cursor AND (j.affected_from IS NULL OR date(jo.delivered_at,'+3 hours')>=j.affected_from) AND (j.affected_until IS NULL OR date(jo.delivered_at,'+3 hours')<j.affected_until) AND NOT ${currentWageTargetSql()}) OR EXISTS(SELECT 1 FROM finance_posting_errors pe WHERE pe.order_id=${orderSql}
  AND (pe.event_key<>'cogs:'||${orderSql} OR NOT EXISTS(SELECT 1 FROM finance_order_costs wage WHERE wage.id=${costSql} AND COALESCE((SELECT basis FROM finance_wage_targets WHERE cost_id=wage.id),json_extract(wage.snapshot,'$.rule.basis')) IN ('unit','order','revenue_percent')))) OR EXISTS(
  SELECT 1 FROM finance_order_costs sc WHERE sc.id=${costSql} AND COALESCE((SELECT basis FROM finance_wage_targets WHERE cost_id=sc.id),json_extract(sc.snapshot,'$.rule.basis')) IN ('profit_percent','revenue_percent')
  AND NOT EXISTS(SELECT 1 FROM finance_cost_adjustments ca WHERE ca.cost_id=sc.id AND ca.kind='manual')
  AND (${unknownWageRefundSql(orderSql,'sc.order_item_id')} OR NOT EXISTS(SELECT 1 FROM finance_staff_basis sb WHERE sb.order_id=${orderSql} AND sb.basis_fingerprint=(${staffBasisFingerprintSql(orderSql,includeLate)})))))`;

const pendingPaymentCoverSql=(cost='c.id')=>`COALESCE((SELECT MIN(${staffPaidSql(cost)},COALESCE(t.amount_iqd,0)) FROM finance_wage_pending_targets t JOIN finance_wage_changes wc ON wc.id=t.change_id JOIN finance_order_costs ec ON ec.id=t.cost_id JOIN finance_staff_reconciliations j ON j.staff_id=ec.staff_id AND j.operation_id=t.change_id WHERE t.cost_id=${cost} AND j.state<>'complete' AND ec.order_id>j.cursor ORDER BY wc.created_at DESC LIMIT 1),0)`;

const investorReconciliationBlockedSql=(contractSql='e.contract_id')=>`(${investorEmploymentPendingSql(contractSql)} OR ${investorProjectionStaleSql(contractSql)} OR EXISTS(SELECT 1 FROM finance_posting_errors pe JOIN order_item_inventory_allocations ia ON ia.order_id=pe.order_id JOIN inventory_lots il ON il.id=ia.lot_id JOIN investment_contracts ic ON ic.incoming_id=il.incoming_id WHERE ic.id=${contractSql}))`;
const active = (state: string) => ['requested', 'approved', 'part_paid'].includes(state);

/** Only the participant's payable amounts. No customer, margin, cost base or other people's accounts. */
export async function participantSources(db: D1Database, userId: string, scope: 'account' | 'staff' = 'account'): Promise<ParticipantSource[]> {
  const installed = await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='finance_investor_earnings'").first();
  const staff = await db.prepare(`SELECT c.id,'staff' AS kind,c.rule_name AS title,c.order_id,c.cost_day AS day,
    COALESCE(${effectiveStaffCostSql()},0) AS amount_iqd,COALESCE(${effectiveStaffCostSql()},0) AS accrued_iqd,
    ${pendingPaymentCoverSql()} AS pending_payment_cover_iqd,${staffPaidSql()} AS paid_iqd,${heldSourceSql("'staff'", 'c.id')} AS held_iqd,c.state,c.staff_id,EXISTS(SELECT 1 FROM finance_wage_targets wt WHERE wt.cost_id=c.id AND wt.amount_iqd IS NULL) AS pending_cost,${staffReconciliationBlockedSql('c.order_id','c.id',!!installed)} AS blocked,
    CASE WHEN c.state IN ('due','approved') THEN 1 ELSE 0 END AS eligible,
    (SELECT COUNT(*) FROM finance_cost_adjustments ca WHERE ca.cost_id=c.id) AS version
    FROM finance_order_costs c JOIN finance_staff s ON s.id=c.staff_id WHERE ${scope==='staff'?'s.id':'s.user_id'}=? AND c.state<>'reversed'
    ORDER BY c.cost_day,c.id`).bind(userId).all<ParticipantSource>();
  let sources = staff.results ?? [];
  if (installed && scope === 'account') {
    const investor = await db.prepare(`SELECT e.id,e.kind,e.title,e.order_id,e.day,e.amount_iqd,e.accrued_iqd,
      ${paidSourceSql('e.kind', 'e.id')} AS paid_iqd,${heldSourceSql('e.kind', 'e.id')} AS held_iqd,e.state,e.version,${investorReconciliationBlockedSql()} AS blocked,
      CASE WHEN e.state='available' THEN 1 ELSE 0 END AS eligible
      FROM finance_investor_earnings e WHERE e.user_id=? ORDER BY e.day,e.id`).bind(userId).all<ParticipantSource>();
    sources = [...sources, ...(investor.results ?? [])];
  }
  return sources.map((s) => ({ ...s, eligible: !!s.eligible&&!s.blocked, available_iqd: s.eligible&&!s.blocked ? Math.max(0, s.amount_iqd-s.paid_iqd-s.held_iqd) : 0 }));
}
const participantAdvanceSql=(scope: 'account' | 'staff' = 'account')=>`SELECT p.id,p.amount_iqd,COALESCE((SELECT SUM(a.amount_iqd) FROM finance_payment_allocations a WHERE a.payment_id=p.id),0) AS allocated
  FROM finance_staff_payments p JOIN finance_staff s ON s.id=p.staff_id WHERE ${scope==='staff'?'s.id':'s.user_id'}=? AND p.kind='advance' ORDER BY p.id`;
export async function participantAdvanceState(db:D1Database,userId:string,scope: 'account' | 'staff' = 'account') {
  return (await db.prepare(`SELECT COALESCE(SUM(amount_iqd-allocated),0) AS balance,json_group_array(json_array(id,amount_iqd,allocated)) AS snapshot FROM (${participantAdvanceSql(scope)})`).bind(userId).first<{balance:number;snapshot:string}>())!;
}
export const staffAdvanceSql=(staffIdSql='s.id')=>`(SELECT COALESCE(SUM(p.amount_iqd-COALESCE((SELECT SUM(a.amount_iqd) FROM finance_payment_allocations a WHERE a.payment_id=p.id),0)),0) FROM finance_staff_payments p WHERE p.staff_id=${staffIdSql} AND p.kind='advance')`;
/** Cash debt and reservations are different. Each ledger offsets its own future
 * earnings; wage corrections never consume investment principal or profit. */
export function participantSummary(entries: ParticipantSource[],advanceBalance=0) {
  const sum = (f: (s: ParticipantSource) => number) => entries.reduce((v, s) => v + f(s), 0);
  const ledger=(kind:EarningKind)=>{
    const rows=entries.filter(s=>s.kind===kind),advance=kind==='staff'?advanceBalance:0;
    const total=(f:(s:ParticipantSource)=>number)=>rows.reduce((v,s)=>v+f(s),0);
    const net=total(s=>s.accrued_iqd-s.paid_iqd)-advance;
    const held=total(s=>s.held_iqd);
    const spendable=total(s=>(s.eligible?s.amount_iqd:Math.min(s.paid_iqd,s.pending_payment_cover_iqd??0))-s.paid_iqd)-advance;
    return {net_iqd:net,available_iqd:Math.max(0,spendable-held),held_iqd:held,
      paid_iqd:total(s=>s.paid_iqd),debt_iqd:Math.max(0,-net),
      historical_overpayment_iqd:total(s=>Math.max(0,s.paid_iqd-s.accrued_iqd)),
      pending_settlement_reserve_iqd:Math.max(0,net-spendable),
      reservation_conflict_iqd:Math.max(0,held-Math.max(0,spendable))};
  };
  const pending=(s:ParticipantSource)=>Math.max(0,s.accrued_iqd-s.amount_iqd)+(s.eligible?0:Math.max(0,s.amount_iqd-s.paid_iqd));
  const staff=ledger('staff'),profit=ledger('investor_profit'),capital=ledger('investor_capital');
  const earningsAvailable=staff.available_iqd+profit.available_iqd;
  return {
    ledgers:{staff,investor_profit:profit,investor_capital:capital},
    net_balance_iqd:staff.net_iqd+profit.net_iqd,staff_net_iqd:staff.net_iqd,
    staff_available_iqd:staff.available_iqd,investor_profit_available_iqd:profit.available_iqd,
    reconciliation_pending:entries.some((s)=>!!s.blocked),
    pending_settlement_reserve_iqd:staff.pending_settlement_reserve_iqd+profit.pending_settlement_reserve_iqd+capital.pending_settlement_reserve_iqd,
    reservation_conflict_iqd:staff.reservation_conflict_iqd+profit.reservation_conflict_iqd+capital.reservation_conflict_iqd,
    historical_overpayment_iqd:staff.historical_overpayment_iqd+profit.historical_overpayment_iqd,
    advance_balance_iqd:advanceBalance,
    available_earnings_iqd:earningsAvailable,earnings_available_iqd:earningsAvailable,
    available_capital_iqd:capital.available_iqd,capital_available_iqd:capital.available_iqd,
    earnings_paid_iqd:staff.paid_iqd+profit.paid_iqd,capital_paid_iqd:capital.paid_iqd,
    earnings_held_iqd:staff.held_iqd+profit.held_iqd,capital_held_iqd:capital.held_iqd,
    earned_iqd:sum(s=>s.kind==='investor_capital'?0:s.accrued_iqd),
    available_iqd:earningsAvailable+capital.available_iqd,held_iqd:sum(s=>s.held_iqd),paid_iqd:sum(s=>s.paid_iqd),
    pending_iqd:sum(pending),earnings_pending_iqd:sum(s=>s.kind==='investor_capital'?0:pending(s)),
    investor_profit_pending_iqd:sum(s=>s.kind==='investor_profit'?pending(s):0),
    pending_costs:entries.filter(s=>s.state==='pending_cost'||s.pending_cost).length,
    debt_iqd:staff.debt_iqd+profit.debt_iqd,staff_debt_iqd:staff.debt_iqd,investor_profit_debt_iqd:profit.debt_iqd,
    capital_debt_iqd:capital.debt_iqd,
    staff_iqd:sum(s=>s.kind==='staff'?s.accrued_iqd:0),investor_profit_iqd:sum(s=>s.kind==='investor_profit'?s.accrued_iqd:0),capital_iqd:sum(s=>s.kind==='investor_capital'?s.accrued_iqd:0),
  };
}
export async function participantOverview(db: D1Database, userId: string) {
  const advance=await participantAdvanceState(db,userId);
  const entries = await participantSources(db, userId);
  const withdrawals = await db.prepare('SELECT * FROM finance_withdrawals WHERE user_id=? ORDER BY created_at DESC LIMIT 200').bind(userId).all<WithdrawalRow>();
  // Own setup/progress is useful even before the first cost exists. Never
  // expose rule snapshots, raw failures, account identifiers or other staff.
  const employmentRows = (await db.prepare(`SELECT s.start_work_date,s.active,
    s.archived_at IS NOT NULL AS archived,
    EXISTS(SELECT 1 FROM finance_cost_rules r WHERE r.staff_id=s.id AND r.active=1) AS has_rules,
    j.state AS reconciliation_state,COALESCE(j.processed_orders,0) AS processed_orders
    FROM finance_staff s LEFT JOIN finance_staff_reconciliations j ON j.staff_id=s.id
    WHERE s.user_id=? ORDER BY s.id`).bind(userId).all<{
      start_work_date:string|null;active:number;archived:number;has_rules:number;
      reconciliation_state:string|null;processed_orders:number;
    }>()).results??[];
  const employment=employmentRows.map((s)=>({...s,first_earning_day:s.start_work_date?nextEmploymentDay(s.start_work_date):null}));
  const summary=participantSummary(entries,advance.balance);
  summary.reconciliation_pending ||= employment.some((s)=>s.reconciliation_state!==null&&s.reconciliation_state!=='complete');
  const history=await accountMovements(db,userId);
  const investment=await investorAccountProgress(db,userId,entries,participantWithdrawableSources(entries,advance.balance));
  return { summary, employment, investment, ...history, entries: entries.map(({ eligible: _e, version: _v, staff_id: _s, blocked, ...e }) => ({...e,state:blocked?'pending_reconciliation':e.state})), withdrawals: (withdrawals.results ?? []).map((w)=>({id:w.id,amount_iqd:w.amount_iqd,paid_iqd:w.paid_iqd,state:w.state,balance_type:w.balance_type,created_at:w.created_at,reference:w.reference,receipt_url:w.receipt_url,note:w.note})) };
}
/** Allocate the shared ledger budget once, in the same order used by a withdrawal.
 * A contract with earnings cannot hide another contract's already-paid correction. */
export function participantWithdrawableSources(entries: ParticipantSource[], advanceBalance=0) {
  const summary=participantSummary(entries,advanceBalance);
  const budgets={staff:summary.ledgers.staff.available_iqd,investor_profit:summary.ledgers.investor_profit.available_iqd,investor_capital:summary.ledgers.investor_capital.available_iqd};
  return new Map(entries.map(s=>{
    const take=Math.min(s.available_iqd,budgets[s.kind]);
    budgets[s.kind]-=take;
    return [s.id,take];
  }));
}
async function sourceSetFence(db: D1Database, userId: string, sources: ParticipantSource[],advanceSnapshot:string,scope: 'account' | 'staff' = 'account') {
  const investorInstalled=await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='finance_investor_earnings'").first();
  const includeInvestors=!!investorInstalled&&scope==='account';
  const staffSql=`SELECT c.id AS id,'staff' AS kind,COALESCE(${effectiveStaffCostSql()},0) AS amount,${pendingPaymentCoverSql()} AS cover,${staffPaidSql()} AS paid,${heldSourceSql("'staff'",'c.id')} AS held,c.state,${staffReconciliationBlockedSql('c.order_id','c.id',!!investorInstalled)} AS blocked,
    (SELECT COUNT(*) FROM finance_cost_adjustments ca WHERE ca.cost_id=c.id) AS version
    FROM finance_order_costs c JOIN finance_staff s ON s.id=c.staff_id WHERE ${scope==='staff'?'s.id':'s.user_id'}=? AND c.state<>'reversed'`;
  const investorSql=`SELECT e.id,e.kind,e.amount_iqd AS amount,0 AS cover,${paidSourceSql('e.kind','e.id')} AS paid,${heldSourceSql('e.kind','e.id')} AS held,e.state,${investorReconciliationBlockedSql()} AS blocked,e.version FROM finance_investor_earnings e WHERE e.user_id=?`;
  const expected=JSON.stringify([...sources].sort((a,b)=>a.kind===b.kind?(a.id<b.id?-1:a.id>b.id?1:0):(a.kind<b.kind?-1:1)).map((s)=>[s.id,s.kind,s.amount_iqd,s.paid_iqd,s.held_iqd,s.state,s.version,s.blocked?1:0,s.pending_payment_cover_iqd??0]));
  // One snapshot fence covers both changed rows and newly added sources. A
  // large staff history does not turn one payout into thousands of queries.
  return [...fence(db,`(SELECT json_group_array(json_array(id,kind,amount,paid,held,state,version,blocked,cover)) FROM (${staffSql}${includeInvestors?' UNION ALL '+investorSql:''} ORDER BY kind,id))=?`,includeInvestors?[userId,userId,expected]:[userId,expected]),
    ...fence(db,`(SELECT json_group_array(json_array(id,amount_iqd,allocated)) FROM (${participantAdvanceSql(scope)}))=?`,[userId,advanceSnapshot])];
}

/** Direct payroll has the same wage-only debt/reservation budget as a self
 * withdrawal, including historical blocked payments and unlinked legacy staff.
 * The caller still limits allocation to approved costs. Fence every source,
 * not only those positive approved rows, so a concurrent correction cannot
 * create debt between calculating this budget and committing cash payment. */
export async function staffPaymentBudget(db:D1Database,staffId:string) {
  const sources=await participantSources(db,staffId,'staff');
  const advance=await participantAdvanceState(db,staffId,'staff');
  return {available_iqd:participantSummary(sources,advance.balance).ledgers.staff.available_iqd,
    statements:await sourceSetFence(db,staffId,sources,advance.snapshot,'staff')};
}
export async function commitParticipantStatements(db: D1Database, statements: D1PreparedStatement[]) {
  try { await db.batch(statements); } catch (e) {
    if (/CHECK constraint|UNIQUE constraint|already paid or reserved|Earnings are reserved|account cannot be reassigned/i.test(String(e)))
      throw conflict('تغير الرصيد أثناء الحفظ؛ حدّث الصفحة وحاول مجددًا');
    throw e;
  }
}
async function adminNotices(env: Env, id: string, amount: number) {
  const admins = await env.DB.prepare("SELECT id,email,role,admin_scope,(SELECT allowed FROM ops_permissions p WHERE p.user_id=users.id AND p.capability='pay') AS pay_allowed FROM users WHERE role='admin'").all<SessionUser&{pay_allowed:number|null}>();
  return (admins.results ?? []).filter((u) => canViewFinancials(env,u) && (isOwner(env,u) || u.pay_allowed!==0)).map((u) => notifyStatement(env.DB, {
    userId: u.id, kind: 'payout_available', title_ar: 'طلب سحب أرباح جديد', title_en: 'New earnings withdrawal request',
    body_ar: `طلب سحب بقيمة ${amount.toLocaleString('en-US')} د.ع جاهز للمراجعة`, link: '/admin?tab=finance&section=withdrawals',
    entity_type: 'payout', entity_id: id, eventKey: `finance-withdrawal:${id}`,
  }).stmt);
}
export async function requestWithdrawal(env: Env, userId: string, id: string, amount: number, balanceType:BalanceType='earnings') {
  const db = env.DB;
  const prior = await db.prepare('SELECT * FROM finance_withdrawals WHERE id=?').bind(id).first<WithdrawalRow>();
  if (prior) {
    if (prior.user_id!==userId || prior.amount_iqd!==amount || prior.balance_type!==balanceType) throw conflict('رقم العملية مستخدم لطلب آخر');
    return { id, already: true };
  }
  const advance=await participantAdvanceState(db,userId);
  const sources = await participantSources(db,userId), summary = participantSummary(sources,advance.balance);
  const available=balanceType==='earnings'?summary.available_earnings_iqd:balanceType==='capital'?summary.available_capital_iqd:summary.available_iqd;
  if (available<amount || amount<1) throw badRequest('المبلغ أكبر من الأرباح المتاحة للسحب');
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = await sourceSetFence(db,userId,sources,advance.snapshot);
  statements.push(db.prepare('INSERT INTO finance_withdrawals(id,user_id,amount_iqd,balance_type,created_at,updated_at) VALUES (?,?,?,?,?,?)').bind(id,userId,amount,balanceType,now,now));
  let left=amount;
  const sourceBudgets=participantWithdrawableSources(sources,advance.balance);
  for (const s of sources.filter((s)=>balanceType==='all'||(balanceType==='capital'?s.kind==='investor_capital':s.kind!=='investor_capital'))) {
    const take=Math.min(left,sourceBudgets.get(s.id)??0); if (take<=0) continue;
    statements.push(db.prepare('INSERT INTO finance_withdrawal_allocations(withdrawal_id,source_kind,source_id,amount_iqd) VALUES (?,?,?,?)').bind(id,s.kind,s.id,take));
    left-=take; if (!left) break;
  }
  statements.push(...await adminNotices(env,id,amount), ...(await auditStatements(db,userId,'finance.withdrawal_requested',id,{amount_iqd:amount,balance_type:balanceType})).statements);
  await commitParticipantStatements(db,statements);
  return { id, already:false };
}
export async function changeWithdrawalState(db: D1Database, id: string, actor: string, action: 'approve'|'reject'|'cancel', ownUserId?: string, note='') {
  const w=await db.prepare('SELECT * FROM finance_withdrawals WHERE id=?').bind(id).first<WithdrawalRow>();
  if (!w || (ownUserId && w.user_id!==ownUserId)) throw notFound('طلب السحب غير موجود');
  const state=action==='approve'?'approved':action==='reject'?'rejected':'cancelled';
  if (w.state===state) return {already:true};
  if (action==='cancel' ? w.state!=='requested' : action==='approve' ? w.state!=='requested' : !active(w.state)) throw conflict('حالة طلب السحب لا تسمح بهذه العملية');
  const statements=[...fence(db,'EXISTS(SELECT 1 FROM finance_withdrawals WHERE id=? AND version=? AND state=?)',[id,w.version,w.state]),
    db.prepare('UPDATE finance_withdrawals SET state=?,version=version+1,updated_at=?,note=?,approved_by=CASE WHEN ?=\'approved\' THEN ? ELSE approved_by END,closed_by=CASE WHEN ? IN (\'rejected\',\'cancelled\') THEN ? ELSE closed_by END WHERE id=?').bind(state,new Date().toISOString(),note,state,actor,state,actor,id)];
  if(action==='approve') {
    const advance=await participantAdvanceState(db,w.user_id);
    const sources=await participantSources(db,w.user_id);
    const allocations=(await db.prepare('SELECT source_kind,source_id FROM finance_withdrawal_allocations WHERE withdrawal_id=?').bind(id).all<{source_kind:string;source_id:string}>()).results??[];
    if(allocations.some(a=>participantSummary(sources,advance.balance).ledgers[a.source_kind as EarningKind].reservation_conflict_iqd>0) || allocations.some((a)=>{const s=sources.find((s)=>s.id===a.source_id&&s.kind===a.source_kind);return !s||!s.eligible||s.amount_iqd<s.paid_iqd+s.held_iqd;}))
      throw conflict('تغيرت الأرباح المحجوزة؛ حرر الطلب وأعد تقديم المبلغ المتاح');
    statements.unshift(...await sourceSetFence(db,w.user_id,sources,advance.snapshot));
    statements.push(db.prepare("UPDATE finance_order_costs SET state='approved' WHERE state='due' AND id IN (SELECT source_id FROM finance_withdrawal_allocations WHERE withdrawal_id=? AND source_kind='staff')").bind(id));
  }

  statements.push(notifyStatement(db,{userId:w.user_id,kind:action==='approve'?'payout_available':'payout_failed',title_ar:action==='approve'?'اعتماد طلب سحب الأرباح':'تحديث طلب سحب الأرباح',title_en:'Earnings withdrawal updated',body_ar:action==='approve'?'تم اعتماد الطلب وهو بانتظار التسديد':'أعيد المبلغ غير المسدد إلى الرصيد المتاح',link:'/earnings',entity_type:'payout',entity_id:id,eventKey:`finance-withdrawal:${id}:${state}`}).stmt,
    ...(await auditStatements(db,actor,`finance.withdrawal_${state}`,id,{note})).statements);
  await commitParticipantStatements(db,statements); return {already:false};
}
export async function payWithdrawal(db: D1Database, actor: string, withdrawalId: string, input: {id:string;amount?:number;reference:string;receipt_url:string;day?:string}) {
  const w=await db.prepare('SELECT * FROM finance_withdrawals WHERE id=?').bind(withdrawalId).first<WithdrawalRow>();
  if(!w) throw notFound('طلب السحب غير موجود');
  const previous=await db.prepare('SELECT * FROM finance_withdrawal_payments WHERE id=?').bind(input.id).first<{withdrawal_id:string;amount_iqd:number;reference:string;receipt_url:string}>();
  if(previous) {
    if(previous.withdrawal_id!==withdrawalId || (input.amount!==undefined && previous.amount_iqd!==input.amount) || previous.reference!==input.reference || previous.receipt_url!==input.receipt_url) throw conflict('رقم عملية التسديد مستخدم بمحتوى آخر');
    return {already:true};
  }
  if(!['approved','part_paid'].includes(w.state)) throw conflict('اعتمد طلب السحب أولًا');
  const amount=input.amount??(w.amount_iqd-w.paid_iqd);
  if(amount<1 || amount>w.amount_iqd-w.paid_iqd) throw badRequest('المبلغ يتجاوز المتبقي من طلب السحب');
  if(!input.reference && !input.receipt_url) throw badRequest('أدخل مرجع التسديد أو رابط الوصل');
  if(input.receipt_url && !/^https:\/\/[^\s]+$/i.test(input.receipt_url)) throw badRequest('رابط الوصل يجب أن يبدأ بـ https');
  const day=input.day??baghdadDay(); await periodOpen(db,day);
  const advance=await participantAdvanceState(db,w.user_id);
  const sources=await participantSources(db,w.user_id);
  const allocations=(await db.prepare('SELECT * FROM finance_withdrawal_allocations WHERE withdrawal_id=? ORDER BY source_kind,source_id').bind(withdrawalId).all<{source_kind:EarningKind;source_id:string;amount_iqd:number;paid_iqd:number}>()).results??[];
  const balance=participantSummary(sources,advance.balance);
  if(allocations.some(a=>balance.ledgers[a.source_kind].reservation_conflict_iqd>0))throw conflict('تغيرت المستحقات؛ حرّر طلب السحب وراجع التسوية');
  const statements=[...fence(db,'EXISTS(SELECT 1 FROM finance_withdrawals WHERE id=? AND version=? AND state=? AND paid_iqd=?)',[withdrawalId,w.version,w.state,w.paid_iqd])];
  statements.push(...await sourceSetFence(db,w.user_id,sources,advance.snapshot));
  const staffPays=new Map<string,{amount:number;allocs:{source:string;amount:number}[]}>();
  const paymentLines:Array<{kind:EarningKind;source:string;amount:number}>=[];
  const journalTotals=new Map<string,number>();
  let left=amount;
  for(const a of allocations) {
    const take=Math.min(left,a.amount_iqd-a.paid_iqd); if(take<=0) continue;
    const source=sources.find((s)=>s.id===a.source_id&&s.kind===a.source_kind);
    if(!source || !source.eligible || source.amount_iqd<source.paid_iqd+source.held_iqd) throw conflict('تغير مصدر الأرباح؛ راجع الطلب');
    // Release this exact part of the hold before booking the corresponding staff payment.
    statements.push(db.prepare('UPDATE finance_withdrawal_allocations SET paid_iqd=paid_iqd+? WHERE withdrawal_id=? AND source_kind=? AND source_id=?').bind(take,withdrawalId,a.source_kind,a.source_id));
    if(a.source_kind==='staff') {
      const p=staffPays.get(source.staff_id!)??{amount:0,allocs:[]}; p.amount+=take;p.allocs.push({source:a.source_id,amount:take});staffPays.set(source.staff_id!,p);
    }
    paymentLines.push({kind:a.source_kind,source:a.source_id,amount:take});
    const account=a.source_kind==='staff'?'2100':a.source_kind==='investor_profit'?'2450':'3100';
    journalTotals.set(account,(journalTotals.get(account)??0)+take);left-=take;if(!left)break;
  }
  if(left) throw conflict('مخصصات طلب السحب غير مكتملة');
  const now=new Date().toISOString();
  for(const [staff,p] of staffPays) {
    const paymentId=`wd:${input.id}:${staff}`;
    statements.push(db.prepare("INSERT INTO finance_staff_payments(id,staff_id,amount_iqd,kind,payment_day,note,actor_id,created_at) VALUES (?,?,?,'payment',?,?,?,?)").bind(paymentId,staff,p.amount,day,`طلب سحب ${withdrawalId}`,actor,now));
    for(const a of p.allocs) statements.push(db.prepare('INSERT INTO finance_payment_allocations(payment_id,cost_id,amount_iqd) VALUES (?,?,?)').bind(paymentId,a.source,a.amount));
  }
  statements.push(db.prepare('INSERT INTO finance_withdrawal_payments(id,withdrawal_id,amount_iqd,payment_day,reference,receipt_url,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?)').bind(input.id,withdrawalId,amount,day,input.reference,input.receipt_url,actor,now),
    db.prepare("UPDATE finance_withdrawals SET paid_iqd=paid_iqd+?,state=CASE WHEN paid_iqd+?=amount_iqd THEN 'paid' ELSE 'part_paid' END,version=version+1,updated_at=?,reference=?,receipt_url=? WHERE id=?").bind(amount,amount,now,input.reference,input.receipt_url,withdrawalId),
    ...paymentLines.map(line=>db.prepare('INSERT INTO finance_withdrawal_payment_lines(payment_id,source_kind,source_id,amount_iqd) VALUES (?,?,?,?)').bind(input.id,line.kind,line.source,line.amount)),
    ...journalPlan(db,{key:`earnings-withdrawal:${input.id}`,day,title:'تسديد أرباح مستحقة',source:'finance_withdrawal',sourceId:withdrawalId,actor},[...Array.from(journalTotals,([account,debit])=>({account,debit})),{account:'1000',credit:amount}]).statements,
    notifyStatement(db,{userId:w.user_id,kind:'payout_paid',title_ar:'تم تسديد أرباحك',title_en:'Earnings paid',body_ar:`تم تسديد ${amount.toLocaleString('en-US')} د.ع`,link:'/earnings',entity_type:'payout',entity_id:withdrawalId,eventKey:`finance-withdrawal-paid:${input.id}`}).stmt,
    ...(await auditStatements(db,actor,'finance.withdrawal_paid',withdrawalId,{amount_iqd:amount,reference:input.reference,receipt_url:input.receipt_url})).statements);
  await commitParticipantStatements(db,statements);return {already:false};
}

const wageBasisSql=`json_array(
 (SELECT json_array(status,delivered_at,price_adjustment_iqd,shipping_iqd,cod_tax_iqd,points_discount_iqd) FROM orders WHERE id=?),
 (SELECT json_group_array(json_array(id,qty,line_total_iqd,component_alloc_iqd,coupon_discount_iqd,membership_discount_iqd,cost_iqd,cost_basis)) FROM (SELECT * FROM order_items WHERE order_id=? ORDER BY id)),
 (SELECT COALESCE(MAX(version),0) FROM finance_order_adjustments WHERE order_id=?),
 (SELECT json_group_array(json_array(id,qty,cogs_iqd,released_at)) FROM (SELECT * FROM order_item_inventory_allocations WHERE order_id=? ORDER BY id)),
 (SELECT json_group_array(json_array(case_id,refund_iqd,qty,cogs_iqd,disposition)) FROM (SELECT * FROM finance_refund_facts WHERE order_id=? ORDER BY case_id)),
 (SELECT json_group_array(json_array(r.id,r.state,r.resolution,r.qty,w.amount_iqd,w.status,(SELECT json_extract(a.detail,'$.refund.amount_iqd') FROM audit_log a WHERE a.action='return.transition' AND a.target=r.id AND json_valid(a.detail) AND json_extract(a.detail,'$.refund.amount_iqd') IS NOT NULL ORDER BY a.id DESC LIMIT 1))) FROM (SELECT * FROM return_cases WHERE order_id=? ORDER BY id) r LEFT JOIN wallet_transactions w ON w.id='wtx_ret_'||r.id),
 (SELECT json_group_array(json_array(group_key,staff_id,completed_at)) FROM (SELECT * FROM finance_task_assignments WHERE order_id=? ORDER BY group_key)),
 (SELECT json_group_array(json_array(ca.id,ca.cost_id,ca.delta_iqd)) FROM finance_cost_adjustments ca JOIN finance_order_costs cc ON cc.id=ca.cost_id WHERE cc.order_id=? AND ca.kind='manual'),
 (SELECT json_group_array(json_array(id,employment_version,start_work_date)) FROM (SELECT DISTINCT s.id,s.employment_version,s.start_work_date FROM finance_staff s JOIN finance_order_costs ec ON ec.staff_id=s.id WHERE ec.order_id=? ORDER BY s.id)))`;
export function staffBasisFingerprintSql(orderSql:string,includeLate=true) {
  const simple=wageBasisSql.replace(/\?/g,orderSql);
  return includeLate?`json_array(${simple},(SELECT json_group_array(json_array(s.adjustment_id,s.allocation_id,s.unit_delta_iqd)) FROM lot_cost_adjustment_shares s JOIN order_item_inventory_allocations a ON a.id=s.allocation_id WHERE a.order_id=${orderSql}))`:simple;
}
/** Percentage wages and material costs follow corrected recognised revenue/COGS. Explicit per-order
 * staff amounts remain the owner's override; fixed service fees stay fixed. */
export async function reconcileStaffOrderCosts(db: D1Database, orderId: string, opts: {actor?:string;day?:string}={}) {
  if(!await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='finance_cost_adjustments'").first())return {adjusted:0};
  const temporal=await reconcileEffectiveWages(db,orderId,opts);
  const hasLate=await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lot_cost_adjustment_shares'").first();
  const basisSql=staffBasisFingerprintSql('?1',!!hasLate);
  const beforeBasis=(await db.prepare(`SELECT ${basisSql} AS value`).bind(orderId).first<{value:string}>())!.value;

  const costs=(await db.prepare(`SELECT c.*,${effectiveStaffCostSql()} AS effective_iqd,${staffPaidSql()} AS paid_iqd,
    ${heldSourceSql("'staff'",'c.id')} AS held_iqd,
    EXISTS(SELECT 1 FROM finance_cost_adjustments ca WHERE ca.cost_id=c.id AND ca.kind='manual') AS manual_override
    FROM finance_order_costs c WHERE c.order_id=? AND c.state IN ('due','approved','pending_cost') ORDER BY c.order_item_id,c.id`)
    .bind(orderId).all<{id:string;order_item_id:string|null;rule_id:string;state:string;snapshot:string;effective_iqd:number|null;paid_iqd:number;held_iqd:number;manual_override:number;category_id:string;staff_id:string|null;rule_name:string;group_key:string;milestone:string}>()).results??[];
  if(!costs.length)return {adjusted:temporal.adjusted};
  const base=await getOrderProfitBase(db,orderId),day=opts.day??baghdadDay();
  const staffStarts=await employmentInstalled(db)?new Map(((await db.prepare('SELECT id,start_work_date FROM finance_staff').all<{id:string;start_work_date:string|null}>()).results??[]).map((s)=>[s.id,s])):new Map<string,{start_work_date:string|null}>();
  const frozen=await db.prepare('SELECT rules_json FROM finance_order_snapshots WHERE order_id=?').bind(orderId).first<{rules_json:string}>();
  const snapshot=frozen?JSON.parse(frozen.rules_json) as Array<{line_id:string;rules:Array<{id:string}>}>:[];
  const plans:Array<{cost:typeof costs[number];amount:number;base_iqd:number}>=[],caps=new Map<string,number>();
  for(const cost of costs.filter((c)=>c.manual_override))caps.set(cost.rule_id,(caps.get(cost.rule_id)??0)+(cost.effective_iqd??0));
  for(const cost of costs) {
    if(temporal.managed.has(cost.rule_id))continue;
    if(cost.staff_id&&staffStarts.has(cost.staff_id)&&!staffDateEligible(staffStarts.get(cost.staff_id)!,base.order))continue;
    let rule:{basis:string;amount:number;cap_iqd:number|null;requires_assignment?:number};
    try{rule=JSON.parse(cost.snapshot).rule;}catch{continue;}
    if(!rule || !['profit_percent','revenue_percent'].includes(rule.basis))continue;
    const used=caps.get(cost.rule_id)??0;
    if(cost.manual_override)continue;
    const targets=base.lines.filter((l)=>cost.order_item_id?l.id===cost.order_item_id:snapshot.some((f)=>f.line_id===l.id&&f.rules.some((r)=>r.id===cost.rule_id)));
    if(!targets.length || targets.some(hasUnknownRefund) || (rule.basis==='profit_percent' && targets.some((l)=>l.cogs_iqd===null || !isConfirmedOrderCost(l.cost_confidence))))continue;
    if(cost.state==='pending_cost' && rule.requires_assignment) {
      const task=await db.prepare('SELECT staff_id,completed_at FROM finance_task_assignments WHERE order_id=? AND group_key=?').bind(orderId,cost.group_key).first<{staff_id:string;completed_at:string|null}>();
      if(!task || task.staff_id!==cost.staff_id || (cost.milestone==='prepared'&&!task.completed_at))continue;
    }
    const revenue=targets.reduce((v,l)=>v+l.retained_revenue_iqd,0),cogs=targets.reduce((v,l)=>v+(l.cogs_iqd??0),0);
    let amount=Number(BigInt(Math.max(0,rule.basis==='profit_percent'?revenue-cogs:revenue))*BigInt(rule.amount)/10000n);
    if(rule.cap_iqd!==null)amount=Math.min(amount,Math.max(0,rule.cap_iqd-used));
    caps.set(cost.rule_id,used+amount);
    if(amount!==cost.effective_iqd)plans.push({cost,amount,base_iqd:Math.max(0,rule.basis==='profit_percent'?revenue-cogs:revenue)});
  }
  if(plans.length)await periodOpen(db,day);
  const actor=opts.actor??null;
  const statements=fence(db,`${basisSql.replace(/\?1/g,'?2')}=?3`,[orderId,beforeBasis]);
  for(const {cost,amount,base_iqd} of plans) {
    if(cost.held_iqd>0 && amount<cost.paid_iqd+cost.held_iqd)throw conflict('يوجد طلب سحب محجوز تأثر بالتصحيح؛ حرره ثم أعد احتساب الأرباح');
    const liability=cost.staff_id?'2100':'2000';
    if(cost.state==='pending_cost') {
      const expense=amount>0?newId('opex'):null;
      statements.push(...fence(db,"EXISTS(SELECT 1 FROM finance_order_costs WHERE id=? AND state='pending_cost' AND staff_id IS ? AND snapshot=?)",[cost.id,cost.staff_id,cost.snapshot]));
      if(expense)statements.push(db.prepare('INSERT INTO operating_expenses(id,category_id,amount_iqd,expense_day,title,note) VALUES (?,?,?,?,?,?)').bind(expense,cost.category_id,amount,day,cost.rule_name,`طلب ${orderId} / تكلفة متحققة`));
      statements.push(db.prepare("UPDATE finance_order_costs SET amount_iqd=?,base_iqd=?,state='due',expense_id=?,cost_day=? WHERE id=? AND state='pending_cost'").bind(amount,base_iqd,expense,day,cost.id));
      if(amount>0)statements.push(...journalPlan(db,{key:`order-cost:${cost.id}`,day,title:cost.rule_name,source:'order_cost',sourceId:cost.id,actor},[{account:'5100',debit:amount},{account:liability,credit:amount}]).statements);
      statements.push(...(await auditStatements(db,actor,'finance.staff_cost_materialized',cost.id,{amount_iqd:amount,order_id:orderId})).statements);
      continue;
    }
    const id=newId('wagerecalc'),delta=amount-(cost.effective_iqd??0);
    statements.push(...fence(db,`EXISTS(SELECT 1 FROM finance_order_costs c WHERE c.id=? AND c.state=? AND ${effectiveStaffCostSql()}=? AND (${heldSourceSql("'staff'",'c.id')}=0 OR ${staffPaidSql()}+${heldSourceSql("'staff'",'c.id')}<=?) AND NOT EXISTS(SELECT 1 FROM finance_cost_adjustments ca WHERE ca.cost_id=c.id AND ca.kind='manual'))`,[cost.id,cost.state,cost.effective_iqd,amount]),
      db.prepare("INSERT INTO finance_cost_adjustments(id,cost_id,kind,delta_iqd,before_iqd,after_iqd,actor_id,adjustment_day,created_at) VALUES (?,?,'recalculation',?,?,?,?,?,?)").bind(id,cost.id,delta,cost.effective_iqd,amount,actor,day,new Date().toISOString()),
      ...journalPlan(db,{key:`staff-adjustment:${id}`,day,title:'تحديث أجر نسبة بعد تصحيح الطلب',source:'finance_cost_adjustment',sourceId:id,actor},delta>0?[{account:'5100',debit:delta},{account:liability,credit:delta}]:[{account:liability,debit:-delta},{account:'5100',credit:-delta}]).statements,
      ...(await auditStatements(db,actor,'finance.staff_percentage_recalculated',cost.id,{before_iqd:cost.effective_iqd,after_iqd:amount,order_id:orderId})).statements);
  }
  statements.push(db.prepare('INSERT INTO finance_staff_basis(order_id,basis_fingerprint,updated_at) VALUES (?,?,?) ON CONFLICT(order_id) DO UPDATE SET basis_fingerprint=excluded.basis_fingerprint,updated_at=excluded.updated_at WHERE basis_fingerprint<>excluded.basis_fingerprint').bind(orderId,beforeBasis,new Date().toISOString()));
  await commitParticipantStatements(db,statements);return {adjusted:plans.length+temporal.adjusted};
}
