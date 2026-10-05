import type { EarningKind } from './financeParticipants';

type Movement={id:string;account:EarningKind;kind:string;day:string;earning_day:string|null;recorded_at:string;amount_iqd:number;reason:string};
/** Derived from the immutable source events, not another independently editable
 * balance. Covering debt is a description of an earning, never a second debit. */
export async function accountMovements(db:D1Database,userId:string){
  const [wages,investor,payments]=await Promise.all([
    db.prepare(`SELECT c.id,'staff' AS account,'earning' AS kind,c.cost_day AS day,date(o.delivered_at,'+3 hours') AS earning_day,c.cost_day||'T00:00:00Z' AS recorded_at,c.amount_iqd,c.rule_name AS reason
      FROM finance_order_costs c JOIN finance_staff s ON s.id=c.staff_id JOIN orders o ON o.id=c.order_id WHERE s.user_id=?1 AND c.state IN('due','approved') AND c.amount_iqd>0
      UNION ALL SELECT a.id,'staff','adjustment',a.adjustment_day,a.earning_day,a.created_at,a.delta_iqd,CASE WHEN a.reason='' THEN c.rule_name ELSE a.reason END
      FROM finance_cost_adjustments a JOIN finance_order_costs c ON c.id=a.cost_id JOIN finance_staff s ON s.id=c.staff_id WHERE s.user_id=?1 AND c.state<>'reversed'
      UNION ALL SELECT p.id,'staff',CASE WHEN p.kind='advance' THEN 'advance' ELSE 'payment' END,p.payment_day,NULL,p.created_at,-p.amount_iqd,p.note
      FROM finance_staff_payments p JOIN finance_staff s ON s.id=p.staff_id WHERE s.user_id=?1`).bind(userId).all<Movement>(),
    db.prepare(`SELECT e.id,'investor_profit' AS account,CASE WHEN e.kind='profit_correction' THEN 'adjustment' ELSE 'earning' END AS kind,e.event_day AS day,date(o.delivered_at,'+3 hours') AS earning_day,e.created_at AS recorded_at,e.amount_iqd,c.name AS reason
      FROM investor_finance_events e JOIN investment_contracts c ON c.id=e.contract_id LEFT JOIN orders o ON o.id=e.order_id WHERE c.user_id=? AND e.kind IN('profit','profit_correction')`).bind(userId).all<Movement>(),
    db.prepare(`SELECT p.id||':'||l.source_id AS id,l.source_kind AS account,'payment' AS kind,p.payment_day AS day,NULL AS earning_day,p.created_at AS recorded_at,-l.amount_iqd AS amount_iqd,p.reference AS reason
      FROM finance_withdrawal_payment_lines l JOIN finance_withdrawal_payments p ON p.id=l.payment_id JOIN finance_withdrawals w ON w.id=p.withdrawal_id WHERE w.user_id=? AND l.source_kind='investor_profit'`).bind(userId).all<Movement>()]);
  const balances={staff:0,investor_profit:0,investor_capital:0};
  const records=[...(wages.results??[]),...(investor.results??[]),...(payments.results??[])].sort((a,b)=>a.recorded_at.localeCompare(b.recorded_at)||a.id.localeCompare(b.id));
  const movements=records.map(m=>{const before=balances[m.account];balances[m.account]+=m.amount_iqd;return {...m,balance_iqd:balances[m.account],debt_covered_iqd:m.amount_iqd>0?Math.min(Math.max(0,-before),m.amount_iqd):0};});
  const missing=await db.prepare(`SELECT COUNT(*) AS n FROM finance_withdrawal_payments p JOIN finance_withdrawals w ON w.id=p.withdrawal_id WHERE w.user_id=? AND p.amount_iqd<>(SELECT COALESCE(SUM(amount_iqd),0) FROM finance_withdrawal_payment_lines WHERE payment_id=p.id)`).bind(userId).first<{n:number}>();
  return {movements:movements.slice(-100).reverse(),movement_count:movements.length,history_review_count:missing?.n??0};
}
