import { reportAdjustments } from './financeReportOverlay';
import { monthlyPromotionShares, spread, workspaceInstalled, type OrderProfitBase } from './orderProfit';
import { conflict } from './http';
import { serverMessage } from '../../packages/contracts/src/costRefusals';

type Row = Record<string, unknown>;
const n = (value: unknown) => Number(value ?? 0);
const monthSql = (order: string) => `(SELECT substr(date(delivered_at,'+3 hours'),1,7) FROM orders WHERE id=${order})`;
const generalExpense = `e.voided_at IS NULL
  AND NOT EXISTS(SELECT 1 FROM finance_expense_links l WHERE l.expense_id=e.id)
  AND NOT EXISTS(SELECT 1 FROM finance_order_costs c WHERE c.expense_id=e.id)
  AND NOT EXISTS(SELECT 1 FROM finance_collections c WHERE c.expense_id=e.id)
  AND NOT EXISTS(SELECT 1 FROM finance_monthly_promotions p WHERE p.expense_id=e.id)`;

function isProfitShare(cost: Row): boolean {
  if (!cost.staff_id) return false;
  try {
    const current = JSON.parse(String(cost.wage_rule_snapshot ?? 'null'));
    const original = JSON.parse(String(cost.snapshot ?? '{}'));
    return (current?.basis ?? original.rule?.basis) === 'profit_percent';
  } catch { return false; }
}

/** Net distributable profit. The accounting/invoice basis stays intact:
 * deductions already in line revenue are never subtracted a second time.
 * Staff profit percentages exclude all staff profit distributions themselves
 * to avoid a recursive wage calculation. Investors retain the established
 * ordering after staff costs. Fixed/revenue wages remain costs in both bases. */
export async function participantNetProfit(db: D1Database, base: OrderProfitBase, forStaff = false): Promise<Map<string, number | null>> {
  const adjustments = (await reportAdjustments(db, [base.order_id])).get(base.order_id)!;
  const values = new Map<string, number | null>();
  const costs = new Map(base.lines.map(line => [line.id, { amount: 0, pending: false }]));
  for (const cost of base.costs) {
    if (cost.state === 'reversed' || (forStaff && isProfitShare(cost))) continue;
    const targets = cost.order_item_id ? base.lines.filter(line => line.id === cost.order_item_id) : base.lines;
    const shares = spread(n(cost.effective_amount_iqd), targets.map(line => line.net_goods_iqd || line.qty));
    targets.forEach((line, index) => {
      const assigned = costs.get(line.id)!;
      assigned.amount += shares[index] ?? 0;
      assigned.pending ||= cost.state === 'pending_cost';
    });
  }
  const weights = base.lines.map(line => Math.max(0, line.net_goods_iqd));
  const coupons = spread(adjustments.coupon_iqd, weights.some(Boolean) ? weights : base.lines.map(line => line.qty));
  const month = (await db.prepare("SELECT substr(date(delivered_at,'+3 hours'),1,7) month FROM orders WHERE id=?").bind(base.order_id).first<{ month: string | null }>())?.month;
  let promotions = new Map<string, number>(), general = new Map<string, number>();
  if (month && await workspaceInstalled(db)) {
    promotions = (await monthlyPromotionShares(db, month)).shares;
    const expenses = await db.prepare(`SELECT COALESCE(SUM(e.amount_iqd),0) amount FROM operating_expenses e WHERE substr(e.expense_day,1,7)=? AND ${generalExpense}`).bind(month).first<{ amount: number }>();
    if (expenses?.amount) {
      const lines = await db.prepare(`SELECT i.id,i.qty FROM order_items i JOIN orders o ON o.id=i.order_id
        WHERE o.status='delivered' AND o.seller_type='levonis' AND substr(date(o.delivered_at,'+3 hours'),1,7)=?
        AND NOT EXISTS(SELECT 1 FROM order_items child WHERE child.bundle_parent_item_id=i.id) ORDER BY i.id LIMIT 10001`).bind(month).all<{ id: string; qty: number }>();
      if (lines.results.length > 10000) throw conflict(serverMessage('NET_PROFIT_ALLOCATION_LIMIT'),'NET_PROFIT_ALLOCATION_LIMIT');
      const shares = spread(expenses.amount, lines.results.map(line => line.qty));
      general = new Map(lines.results.map((line, index) => [line.id, shares[index] ?? 0]));
    }
  }
  base.lines.forEach((line, index) => {
    const direct = costs.get(line.id)!;
    const unknown = line.cogs_iqd === null || n(line.unknown_refund) > 0 || direct.pending;
    values.set(line.id, unknown ? null : line.retained_revenue_iqd - line.cogs_iqd!
      + line.shipping_income_iqd + line.cod_tax_iqd - direct.amount - line.manual_direct_iqd
      - line.courier_fee_iqd - line.payment_fee_iqd - (coupons[index] ?? 0)
      - (adjustments.price_protection_by_line.get(line.id) ?? 0)
      - (adjustments.trade_in_credit_returned_by_line.get(line.id) ?? 0)
      - (promotions.get(line.id) ?? 0) - (general.get(line.id) ?? 0));
  });
  return values;
}

/** Same source definition for calculation fences, payout guards and recovery.
 * Versioning queues old entitlements; deductions added later invalidate them
 * immediately. Full-month inputs keep overhead independent of report filters. */
export function participantNetFingerprintSql(baseSql: string, order: string, staffCosts = false): string {
  const month = monthSql(order);
  return `json_array('participant-net-v1',json((${baseSql})),
    (SELECT json_array(coupon_snapshot,coupon_discount_iqd,points_discount_iqd,
      CASE WHEN EXISTS(SELECT 1 FROM order_items mi WHERE mi.order_id=${order} AND mi.membership_discount_iqd>0) THEN benefit_snapshot END)
      FROM orders WHERE id=${order}),
    (SELECT json_group_array(json_array(id,product_id,membership_rule_id)) FROM
      (SELECT * FROM order_items WHERE order_id=${order} ORDER BY id)),
    (SELECT json_group_array(json_array(id,order_item_id,state,credited_iqd)) FROM
      (SELECT * FROM price_protection_claims WHERE order_id=${order} ORDER BY id)),
    (SELECT json_group_array(json_array(id,amount_iqd,enabled)) FROM
      (SELECT * FROM finance_monthly_promotions WHERE month=${month} ORDER BY id)),
    (SELECT json_group_array(json_array(e.id,e.amount_iqd,e.expense_day)) FROM
      (SELECT * FROM operating_expenses ORDER BY id) e WHERE substr(e.expense_day,1,7)=${month} AND ${generalExpense}),
    CASE WHEN EXISTS(SELECT 1 FROM finance_monthly_promotions WHERE month=${month} AND enabled=1 AND amount_iqd>0)
      OR EXISTS(SELECT 1 FROM operating_expenses e WHERE substr(e.expense_day,1,7)=${month} AND e.amount_iqd>0 AND ${generalExpense})
    THEN (SELECT json_group_array(json_array(i.id,i.qty)) FROM
      (SELECT * FROM order_items ORDER BY id) i JOIN orders pn_order ON pn_order.id=i.order_id
      WHERE pn_order.status='delivered' AND pn_order.seller_type='levonis' AND substr(date(pn_order.delivered_at,'+3 hours'),1,7)=${month}
      AND NOT EXISTS(SELECT 1 FROM order_items child WHERE child.bundle_parent_item_id=i.id)) END
    ${staffCosts ? `,
    (SELECT json_group_array(json_array(pn_cost.id,CASE WHEN pn_cost.state IN ('pending_cost','reversed') THEN pn_cost.state ELSE 'cost' END,pn_cost.amount_iqd,
      (SELECT SUM(delta_iqd) FROM finance_cost_adjustments a WHERE a.cost_id=pn_cost.id)))
      FROM (SELECT * FROM finance_order_costs WHERE order_id=${order} ORDER BY id) pn_cost
      WHERE pn_cost.staff_id IS NULL OR COALESCE((SELECT basis FROM finance_wage_targets WHERE cost_id=pn_cost.id),json_extract(pn_cost.snapshot,'$.rule.basis'),'')<>'profit_percent'),
    (SELECT json_group_array(json_array(e.id,e.amount_iqd,e.voided_at)) FROM finance_expense_links l
      JOIN operating_expenses e ON e.id=l.expense_id WHERE l.order_id=${order}),
    (SELECT json_group_array(json_array(id,amount_iqd,fee_iqd)) FROM
      (SELECT * FROM finance_collections WHERE order_id=${order} ORDER BY id))` : ''})`;
}
