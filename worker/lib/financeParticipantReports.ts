import { effectiveStaffCostSql } from './financeParticipants';
import { financeRangeArgs, inFinanceRangeSql, type FinanceRange } from './financeRange';

export async function staffPeriodReport(db: D1Database, range: FinanceRange) {
  const args = financeRangeArgs(range);
  const [earned, paid, adjustments] = await Promise.all([
    db.prepare(`SELECT c.staff_id,COALESCE(SUM(${effectiveStaffCostSql()}),0) AS earned_iqd,SUM(CASE WHEN c.amount_iqd IS NULL THEN 1 ELSE 0 END) AS pending_costs FROM finance_order_costs c JOIN orders o ON o.id=c.order_id WHERE c.staff_id IS NOT NULL AND c.state<>'reversed' AND o.status='delivered' AND ${inFinanceRangeSql("date(o.delivered_at,'+3 hours')")} GROUP BY c.staff_id`).bind(...args).all<{ staff_id: string; earned_iqd: number; pending_costs: number }>(),
    db.prepare(`SELECT staff_id,SUM(amount_iqd) AS paid_iqd FROM finance_staff_payments WHERE ${inFinanceRangeSql('payment_day')} GROUP BY staff_id`).bind(...args).all<{ staff_id: string; paid_iqd: number }>(),
    db.prepare(`SELECT c.staff_id,SUM(a.delta_iqd) AS adjustments_iqd FROM finance_cost_adjustments a JOIN finance_order_costs c ON c.id=a.cost_id WHERE c.staff_id IS NOT NULL AND ${inFinanceRangeSql('a.adjustment_day')} GROUP BY c.staff_id`).bind(...args).all<{ staff_id: string; adjustments_iqd: number }>(),
  ]);
  const result = new Map<string, { earned_iqd: number; paid_iqd: number; adjustments_iqd: number; pending_costs: number }>();
  for (const rows of [earned.results, paid.results, adjustments.results]) for (const row of rows ?? []) result.set(row.staff_id, { earned_iqd: 0, paid_iqd: 0, adjustments_iqd: 0, pending_costs: 0, ...result.get(row.staff_id), ...row });
  return result;
}

/** Period accrual follows delivery, while cash and corrections follow their
 * posting day. All totals are computed before any chart ranking/pagination. */
export async function participantReport(db: D1Database, range: FinanceRange) {
  const args = financeRangeArgs(range);
  const [staff, investor, investorPaid, adjustments, capital, batches] = await Promise.all([
    staffPeriodReport(db, range),
    db.prepare(`SELECT COALESCE(SUM(r.profit_iqd),0) AS earned_iqd,COALESCE(SUM(r.capital_iqd),0) AS recovered_iqd FROM investor_allocation_results r JOIN order_item_inventory_allocations a ON a.id=r.allocation_id JOIN orders o ON o.id=a.order_id WHERE o.status='delivered' AND ${inFinanceRangeSql("date(o.delivered_at,'+3 hours')")}`).bind(...args).first<{ earned_iqd: number; recovered_iqd: number }>(),
    db.prepare(`SELECT COALESCE(SUM(CASE WHEN l.source_kind='investor_profit' THEN l.amount_iqd ELSE 0 END),0) AS profit_iqd,COALESCE(SUM(CASE WHEN l.source_kind='investor_capital' THEN l.amount_iqd ELSE 0 END),0) AS capital_iqd FROM finance_withdrawal_payment_lines l JOIN finance_withdrawal_payments p ON p.id=l.payment_id WHERE ${inFinanceRangeSql('p.payment_day')}`).bind(...args).first<{ profit_iqd: number; capital_iqd: number }>(),
    db.prepare(`SELECT day,SUM(CASE WHEN amount>0 THEN amount ELSE 0 END) AS positive_iqd,SUM(CASE WHEN amount<0 THEN amount ELSE 0 END) AS negative_iqd FROM (SELECT adjustment_day AS day,delta_iqd AS amount FROM finance_cost_adjustments UNION ALL SELECT event_day,amount_iqd FROM investor_finance_events WHERE kind='profit_correction') WHERE ${inFinanceRangeSql('day')} GROUP BY day ORDER BY day`).bind(...args).all<{ day: string; positive_iqd: number; negative_iqd: number }>(),
    db.prepare(`SELECT (SELECT COALESCE(SUM(amount_iqd),0) FROM investor_finance_events WHERE kind='funding')+(SELECT COALESCE(SUM(amount_iqd-allocated_iqd),0) FROM purchase_investor_receipts) AS received_iqd,(SELECT COALESCE(SUM(capital_iqd),0) FROM investor_allocation_results) AS recovered_iqd,(SELECT COALESCE(SUM(amount_iqd),0) FROM finance_withdrawal_payment_lines WHERE source_kind='investor_capital') AS paid_iqd,(SELECT COALESCE(SUM(amount_iqd),0) FROM investor_capital_losses) AS loss_iqd`).first<{ received_iqd: number; recovered_iqd: number; paid_iqd: number; loss_iqd: number }>(),
    db.prepare(`SELECT p.id,COALESCE(NULLIF(p.invoice_no,''),substr(p.id,-8)) AS name,
      (SELECT COALESCE(SUM(i.qty_received),0) FROM purchase_lines pl JOIN incoming_inventory i ON i.id=pl.incoming_id WHERE pl.purchase_id=p.id) AS received_qty,
      (SELECT COALESCE(SUM(l.qty_remaining),0) FROM inventory_lots l JOIN purchase_lines pl ON pl.incoming_id=l.incoming_id WHERE pl.purchase_id=p.id) AS remaining_qty,
      (SELECT COALESCE(SUM(MAX(0,a.qty-COALESCE((SELECT SUM(e.qty) FROM stock_return_lot_evidence e JOIN return_cases rc ON rc.id=e.return_case_id WHERE e.allocation_id=a.id AND rc.state='resolved' AND rc.resolution='refund'),0))),0) FROM order_item_inventory_allocations a JOIN inventory_lots l ON l.id=a.lot_id JOIN purchase_lines pl ON pl.incoming_id=l.incoming_id JOIN orders o ON o.id=a.order_id WHERE pl.purchase_id=p.id AND o.status='delivered' AND a.released_at IS NULL AND ${inFinanceRangeSql("date(o.delivered_at,'+3 hours')")}) AS sold_qty
      FROM purchase_orders p WHERE p.status<>'draft' ORDER BY p.purchase_day,p.id`).bind(...args).all<{ id: string; name: string; received_qty: number; remaining_qty: number; sold_qty: number }>(),
  ]);
  const staffRows = [...staff.values()];
  return { range, participants: [{ kind: 'staff', earned_iqd: staffRows.reduce((n, r) => n + r.earned_iqd, 0), paid_iqd: staffRows.reduce((n, r) => n + r.paid_iqd, 0), pending_costs: staffRows.reduce((n, r) => n + r.pending_costs, 0) }, { kind: 'investor', earned_iqd: investor?.earned_iqd ?? 0, paid_iqd: investorPaid?.profit_iqd ?? 0 }], adjustments: adjustments.results ?? [], capital: { ...capital, remaining_iqd: Math.max(0, (capital?.received_iqd ?? 0) - (capital?.recovered_iqd ?? 0) - (capital?.loss_iqd ?? 0)), period_recovered_iqd: investor?.recovered_iqd ?? 0, period_paid_iqd: investorPaid?.capital_iqd ?? 0 }, batches: batches.results ?? [] };
}
