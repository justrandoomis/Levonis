import type { OrderProfit, ProfitCost } from './types';

/** Pending amounts are unknown; a reversed row remains visible as zero. */
export function displayedCostAmount(cost: ProfitCost): number | null {
  if (cost.state === 'reversed') return 0;
  if (cost.state === 'pending_cost') return null;
  return cost.effective_amount_iqd === undefined ? cost.amount_iqd : cost.effective_amount_iqd;
}

export function groupOrderCosts(costs: readonly ProfitCost[]) {
  const groups = new Map<string, { id: string; staffName?: string; isStaff: boolean; ruleName: string; costs: ProfitCost[]; knownAmount: number; knownCount: number; pendingCount: number }>();
  for (const cost of costs) {
    // Names are labels, never identity: two employees may share a name.
    const id = cost.staff_user_id ? `account:${cost.staff_user_id}` : cost.staff_id ? `staff:${cost.staff_id}` : `cost:${cost.id}`;
    const group = groups.get(id) ?? { id, staffName: cost.staff_name, isStaff: !!(cost.staff_user_id || cost.staff_id), ruleName: cost.rule_name, costs: [], knownAmount: 0, knownCount: 0, pendingCount: 0 };
    group.costs.push(cost);
    const amount = displayedCostAmount(cost);
    if (amount === null) group.pendingCount++;
    else { group.knownAmount += amount; group.knownCount++; }
    groups.set(id, group);
  }
  return [...groups.values()];
}

/** Explain server recovery only where the wage's recorded product costs are
 * confirmed. This is not permission to post, nor proof other blockers cleared. */
export function hasPendingWagesWithConfirmedCosts(data: Pick<OrderProfit, 'order' | 'lines' | 'costs'>): boolean {
  if (data.order.status !== 'delivered') return false;
  return data.costs.some(cost => {
    if (!cost.staff_id || cost.state !== 'pending_cost' || cost.scope_confidence === 'historical_unknown') return false;
    if (cost.review_reasons?.some(issue => issue.code !== 'wage_reconciliation_pending')) return false;
    const ids = cost.line_ids ?? (cost.order_item_id ? [cost.order_item_id] : []);
    const targets = data.lines.filter(line => ids.includes(line.id));
    return targets.length > 0 && targets.length === ids.length && targets.every(line => line.cogs_iqd != null && ['fifo', 'manual_verified', 'recorded_snapshot'].includes(line.cost_confidence) && !line.cost_review?.issues.length);
  });
}
