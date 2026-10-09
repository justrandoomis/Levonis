import { hasUnknownRefund, isConfirmedOrderCost } from './financeLedger';
import { matchOrderCostSelection } from './inventorySelection';
import { refreshProfit, type OrderProfitBase, type ProfitLine } from './orderProfit';

type Row = Record<string, unknown>;
export interface OrderCostProjection {
  unit_cost_iqd: number | null;
  total_cost_iqd: number | null;
  source: 'confirmed_lot' | 'current_catalogue';
  source_id: string | null;
  as_of: string | null;
}
export interface ProjectedOrderFinance {
  is_estimate: true;
  cogs_iqd: number | null;
  gross_profit_iqd: number | null;
  // Future wages, direct costs and the eventual investor allocation are not
  // posted yet. Goods margin must never masquerade as final owner earnings.
  owner_net_iqd: null;
}
const terminal = new Set(['delivered', 'cancelled', 'returned', 'refunded']);
const money = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
export const hasOrderFinancialActivity = (base: OrderProfitBase) => !!base.order.delivered_at || base.costs.length > 0 || Number(base.totals.collected_iqd ?? 0) > 0 || base.lines.some(line => line.allocations.length > 0 || line.returned_qty > 0);

/** Batched read-only catalogue/lot evidence for report previews. None of these
 * fields feeds getOrderProfitBase, posting, staff wages or investor accrual.
 *
 * A SALE THAT HAPPENED IS NEVER RE-COSTED FROM TODAY (owner brief 2026-10-09,
 * «التكلفة الفعلية»; P-A fix F2). A delivered, returned, refunded or cancelled
 * order gets no current-catalogue cost and no current-stock cost, not even as
 * a "suggestion to confirm": both re-derive a past sale's cost from values
 * that did not exist when it was sold. Its only suggestion is the cost
 * RECORDED on the order line at the time of sale (orderProfitReview,
 * `order_snapshot`); with none, the order sheet offers manual entry of the
 * actual cost only («لا توجد تكلفة مسجلة وقت البيع…»). An order still in
 * flight keeps its forecast, labelled a forecast, as before. */
export async function enrichOrderCostProjections(db: D1Database, bases: OrderProfitBase[], historicalSuggestions = false) {
  const candidates = bases.flatMap(base => !terminal.has(String(base.order.status)) ? base.lines.filter(line => !isConfirmedOrderCost(line.cost_confidence) && !line.allocations.length && line.product_id).map(line => ({ base, line })) : []);
  const productIds = [...new Set(candidates.map(({ line }) => line.product_id!))];
  const suggestions = new Map<string, OrderCostProjection>();
  if (productIds.length) {
    const ids = JSON.stringify(productIds);
    const [products, options, colors, variants, fulfillments, transports, groups, links, lots] = await Promise.all([
      db.prepare('SELECT * FROM products WHERE id IN (SELECT value FROM json_each(?))').bind(ids).all<Row>(),
      db.prepare('SELECT v.* FROM product_option_values v LEFT JOIN product_option_groups g ON g.id=v.group_id WHERE v.product_id IN (SELECT value FROM json_each(?)) ORDER BY COALESCE(g.sort,0),g.id,v.sort,v.id').bind(ids).all<Row>(),
      db.prepare('SELECT * FROM product_colors WHERE product_id IN (SELECT value FROM json_each(?))').bind(ids).all<Row>(),
      db.prepare('SELECT * FROM product_variants WHERE product_id IN (SELECT value FROM json_each(?))').bind(ids).all<Row>(),
      db.prepare('SELECT f.* FROM product_option_fulfillment f JOIN product_option_values v ON v.id=f.option_id WHERE v.product_id IN (SELECT value FROM json_each(?))').bind(ids).all<Row>(),
      db.prepare('SELECT t.* FROM product_option_transports t JOIN product_option_fulfillment f ON f.id=t.fulfillment_id WHERE f.product_id IN (SELECT value FROM json_each(?))').bind(ids).all<Row>(),
      db.prepare('SELECT * FROM product_option_groups WHERE product_id IN (SELECT value FROM json_each(?))').bind(ids).all<Row>(),
      db.prepare('SELECT l.* FROM product_color_option_links l JOIN product_colors c ON c.id=l.color_id WHERE c.product_id IN (SELECT value FROM json_each(?))').bind(ids).all<Row>(),
      db.prepare(`SELECT l.*,CASE WHEN po.id IS NOT NULL AND po.cost_state<>'final' THEN NULL ELSE COALESCE((SELECT v.unit_cost_iqd FROM inventory_lot_cost_versions v WHERE v.lot_id=l.id ORDER BY v.version DESC LIMIT 1),l.unit_cost_iqd) END final_unit_iqd
        FROM inventory_lots l LEFT JOIN purchase_lines pl ON pl.incoming_id=l.incoming_id LEFT JOIN purchase_orders po ON po.id=pl.purchase_id
        WHERE l.product_id IN (SELECT value FROM json_each(?)) AND l.qty_remaining>0 ORDER BY l.received_at,l.id`).bind(ids).all<Row>(),
    ]);
    for (const { base, line } of candidates) {
      const product = products.results?.find(row => row.id === line.product_id);
      if (!product || product.composition) continue;
      const forProduct = (rows: Row[] | undefined) => (rows ?? []).filter(row => row.product_id === line.product_id);
      const productColors = forProduct(colors.results);
      const selection = matchOrderCostSelection(product, { ...line, order_shipping_type: base.order.shipping_type }, {
        options: forProduct(options.results), colors: productColors, variants: forProduct(variants.results), fulfillments: (fulfillments.results ?? []).filter(row => forProduct(options.results).some(option => option.id === row.option_id)),
        groups: forProduct(groups.results), links: (links.results ?? []).filter(row => productColors.some(color => color.id === row.color_id)), transports: transports.results ?? [],
      });
      if (!selection) continue;
      const qty = Math.max(0, line.qty - Number(line.restocked_qty ?? 0));
      const queue = String(base.order.shipping_type ?? 'direct') === 'direct' ? (lots.results ?? []).filter(lot => lot.product_id === line.product_id && lot.scope === selection.scope && lot.scope_id === selection.scope_id) : [];
      let unit = selection.unit_cost_iqd, total = unit === null ? null : money(unit * qty), source: OrderCostProjection['source'] = 'current_catalogue', sourceId: string | null = selection.scope === 'base' ? line.product_id : selection.scope_id, asOf: string | null = null;
      if (queue.length) {
        let left = qty, sum = 0, unknown = false;
        for (const lot of queue) {
          const take = Math.min(left, Number(lot.qty_remaining)); if (!take) break;
          const lotCost = money(lot.final_unit_iqd); if (lotCost === null) unknown = true; else sum += lotCost * take;
          left -= take;
        }
        // This is unallocated future stock: only a fully priced queue can
        // supersede the exact catalogue estimate. Unknown stock never earns
        // a misleading confirmed-lot label or alters an actual allocation.
        if (!left && !unknown && money(sum) !== null) {
          total = sum; source = 'confirmed_lot'; sourceId = queue.length === 1 ? String(queue[0].id) : null;
          asOf = String(queue[0].received_at);
          unit = qty > 0 && total % qty === 0 ? total / qty : null;
        }
      }
      suggestions.set(line.id, { unit_cost_iqd: unit, total_cost_iqd: total, source, source_id: sourceId, as_of: asOf });
    }
  }
  for (const base of bases) {
    delete base.projected_finance;
    base.has_financial_activity = hasOrderFinancialActivity(base);
    const projecting = !terminal.has(String(base.order.status));
    for (const line of base.lines) {
      delete line.cost_projection;
      const suggestion = suggestions.get(line.id);
      if (projecting && suggestion) line.cost_projection = suggestion;
      // Historical suggestions always require an explicit per-order action;
      // an unknown/incomplete FIFO allocation is never replaced by a guess,
      // and a terminal order never reaches here (F2: no candidate above).
      if (historicalSuggestions && projecting && !line.cost_review?.suggestion && suggestion?.total_cost_iqd !== null && suggestion?.total_cost_iqd !== undefined && suggestion.unit_cost_iqd !== null && line.cost_review) {
        line.cost_review.suggestion = { source: suggestion.source, unit_cost_iqd: suggestion.unit_cost_iqd, total_cost_iqd: suggestion.total_cost_iqd, as_of: suggestion.as_of, requires_confirmation: true };
      }
    }
    if (!projecting) continue;
    const previewLines: ProfitLine[] = base.lines.map(line => ({ ...line, cogs_iqd: isConfirmedOrderCost(line.cost_confidence) ? line.cogs_iqd : line.cost_projection?.total_cost_iqd ?? null }));
    const projected = refreshProfit({ ...base, lines: previewLines, totals: { ...base.totals } });
    base.projected_finance = { is_estimate: true, cogs_iqd: projected.totals.cogs_iqd, gross_profit_iqd: previewLines.some(hasUnknownRefund) ? null : projected.totals.gross_profit_iqd, owner_net_iqd: null };
  }
}
