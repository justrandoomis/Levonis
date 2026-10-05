import type { OrderProfitBase } from './orderProfit';
import { hasUnknownRefund, isConfirmedOrderCost } from './financeLedger';

export interface ProfitReviewReason {
  code: 'fifo_missing' | 'fifo_quantity_incomplete' | 'fifo_cost_missing' | 'historical_cost_unverified' | 'return_cost_missing' | 'refund_amount_missing' | 'verified_goods_cost_required' | 'wage_reconciliation_pending';
  field: string;
  source_id: string | null;
  line_ids: string[];
}
export interface ProfitCostReview {
  source: string;
  source_field: string;
  snapshot_unit_iqd: number | null;
  allocated_qty: number;
  required_qty: number;
  sources: Array<{ allocation_id: string; lot_id: string; incoming_id: string | null; purchase_id: string | null; qty: number; cogs_iqd: number | null; unit_cost_iqd: number | null; returned_qty: number; returned_cogs_iqd: number | null; late_cost_iqd: number; retained_cogs_iqd: number | null }>;
  issues: ProfitReviewReason[];
  suggestion: null | { source: 'order_snapshot' | 'current_catalogue' | 'confirmed_lot'; unit_cost_iqd: number; total_cost_iqd: number; as_of: string | null; requires_confirmation: true };
  can_verify: boolean;
}
const amount = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Explain the same financial basis used by wages and investors. This only
 * describes evidence; neither catalogue prices nor suggestions post money. */
export function describeOrderProfit(base: OrderProfitBase) {
  for (const line of base.lines) {
    const sources = line.allocations.map(a => ({ allocation_id: a.id, lot_id: a.lot_id, incoming_id: a.incoming_id, purchase_id: null as string | null, qty: a.qty, cogs_iqd: a.cogs_iqd, unit_cost_iqd: a.unit_cost_iqd, returned_qty: a.returned_qty, returned_cogs_iqd: a.returned_cogs_iqd, late_cost_iqd: a.late_cost_iqd, retained_cogs_iqd: a.cogs_iqd === null || a.returned_cogs_iqd === null ? null : a.cogs_iqd - a.returned_cogs_iqd + a.late_cost_iqd }));
    const allocated = sources.reduce((sum, source) => sum + source.qty, 0);
    const issues: ProfitReviewReason[] = [];
    const issue = (code: ProfitReviewReason['code'], field: string, source: string | null) => issues.push({ code, field, source_id: source, line_ids: [line.id] });
    if (!isConfirmedOrderCost(line.cost_confidence)) {
      if (!sources.length) issue(line.cost_confidence === 'snapshot' ? 'historical_cost_unverified' : 'fifo_missing', line.cost_confidence === 'snapshot' ? 'order_items.cost_iqd' : 'order_item_inventory_allocations', line.id);
      else {
        if (allocated < line.qty) issue('fifo_quantity_incomplete', 'order_item_inventory_allocations.qty', line.id);
        for (const source of sources) if (source.cogs_iqd === null) issue('fifo_cost_missing', 'order_item_inventory_allocations.cogs_iqd', source.allocation_id);
      }
    }
    for (const refund of line.return_review_sources ?? []) {
      if (refund.cogs_unknown && line.cost_confidence !== 'manual_verified') issue('return_cost_missing', 'finance_refund_facts.cogs_iqd', refund.id);
      if (refund.refund_unknown) issue('refund_amount_missing', 'finance_refund_facts.refund_iqd', refund.id);
    }
    const snapshotUnit = amount(line.cost_iqd), remainingQty = Math.max(0, line.qty - Number(line.restocked_qty ?? 0));
    const snapshotTotal = snapshotUnit === null ? null : amount(snapshotUnit * remainingQty);
    line.cost_review = {
      source: line.cost_confidence,
      source_field: line.cost_confidence === 'manual_verified' ? 'finance_order_adjustments.new_value_iqd' : sources.length ? 'order_item_inventory_allocations.cogs_iqd' : 'order_items.cost_iqd',
      snapshot_unit_iqd: snapshotUnit, allocated_qty: allocated, required_qty: line.qty, sources, issues,
      suggestion: !isConfirmedOrderCost(line.cost_confidence) && snapshotUnit !== null && snapshotTotal !== null ? { source: 'order_snapshot', unit_cost_iqd: snapshotUnit, total_cost_iqd: snapshotTotal, as_of: String(base.order.created_at ?? '') || null, requires_confirmation: true } : null,
      can_verify: false,
    } satisfies ProfitCostReview;
  }
  for (const cost of base.costs) {
    let rule: Record<string, unknown> = {}, original: Record<string, unknown> = {};
    try {
      original = JSON.parse(String(cost.snapshot || '{}')) as Record<string, unknown>;
      const saved = JSON.parse(String(cost.wage_rule_snapshot || cost.snapshot || '{}')) as Record<string, unknown>;
      rule = (saved.rule && typeof saved.rule === 'object' ? saved.rule : saved) as Record<string, unknown>;
    } catch { /* Missing legacy evidence stays explicit instead of guessing. */ }
    const originalRule = original.rule as Record<string, unknown> | undefined;
    const savedLineIds = Array.isArray(original.line_ids) && originalRule?.id === rule.id && originalRule?.version === rule.version ? original.line_ids.filter((id): id is string => typeof id === 'string') : null;
    let allProducts = rule.target_type === 'all';
    if (rule.scope_json && rule.scope_json !== '{}') {
      try { const scope = JSON.parse(String(rule.scope_json)); allProducts = ['catalog_ids', 'product_ids', 'excluded_product_ids'].every(key => Array.isArray(scope[key]) && scope[key].length === 0); }
      catch { allProducts = false; }
    }
    // Old order-level rows did not persist the winning line scope. Never
    // attribute an unrelated product's missing cost to a scoped wage.
    const targets = cost.order_item_id ? base.lines.filter(line => line.id === cost.order_item_id) : savedLineIds ? base.lines.filter(line => savedLineIds.includes(line.id)) : allProducts ? base.lines : [];
    cost.scope_confidence = cost.order_item_id ? 'line' : savedLineIds ? 'recorded' : allProducts ? 'all_products' : 'historical_unknown';
    cost.line_ids = targets.map(line => line.id);
    cost.basis = typeof rule.basis === 'string' ? rule.basis : null;
    cost.rate = amount(rule.amount);
    cost.review_reasons = [] as ProfitReviewReason[];
    if (cost.state === 'pending_cost') {
      const refunds = ['profit_percent', 'revenue_percent'].includes(String(cost.basis)) ? targets.filter(hasUnknownRefund).flatMap(line => line.cost_review?.issues.filter(issue => issue.code === 'refund_amount_missing') ?? []) : [];
      const missing = targets.filter(line => line.cogs_iqd === null || !isConfirmedOrderCost(line.cost_confidence));
      cost.review_reasons = refunds.length ? refunds : [{
        code: cost.basis === 'profit_percent' && missing.length ? 'verified_goods_cost_required' : 'wage_reconciliation_pending',
        field: cost.basis === 'profit_percent' && missing.length ? 'cogs_iqd' : 'finance_wage_targets.amount_iqd',
        source_id: String(cost.id), line_ids: (missing.length ? missing : targets).map(line => line.id),
      }] satisfies ProfitReviewReason[];
    }
    delete cost.wage_rule_snapshot;
  }
  return base;
}

/** Only order detail needs purchase links/current catalogue suggestions. A
 * current selection is never silently substituted for a historical cost. */
export async function enrichOrderProfitReview(db: D1Database, base: OrderProfitBase, canVerify: boolean) {
  const incomingIds = [...new Set(base.lines.flatMap(line => line.allocations.flatMap(a => a.incoming_id ? [a.incoming_id] : [])))];
  const purchases = incomingIds.length ? (await db.prepare('SELECT incoming_id,purchase_id FROM purchase_lines WHERE incoming_id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(incomingIds)).all<{ incoming_id: string; purchase_id: string }>()).results ?? [] : [];
  for (const line of base.lines) {
    const review = line.cost_review as ProfitCostReview;
    for (const source of review.sources) source.purchase_id = purchases.find(p => p.incoming_id === source.incoming_id)?.purchase_id ?? null;
    review.can_verify = canVerify && !['cancelled', 'returned'].includes(String(base.order.status)) && !!review.suggestion;
  }
  return base;
}
