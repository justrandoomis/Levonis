import { allocateExact, baghdadDay, fence, journalPlan, periodOpen } from './operations';
import { badRequest, conflict, notFound } from './http';
import { newId } from './crypto';

type Row = Record<string, unknown>;
const n = (v: unknown) => Number(v ?? 0);
const s = (v: unknown) => String(v ?? '');
export type ProfitField = 'net_goods_iqd' | 'cogs_iqd' | 'shipping_iqd' | 'cod_tax_iqd' | 'courier_fee_iqd' | 'payment_fee_iqd' | 'manual_direct_iqd';
export const profitFields: ProfitField[] = ['net_goods_iqd', 'cogs_iqd', 'shipping_iqd', 'cod_tax_iqd', 'courier_fee_iqd', 'payment_fee_iqd', 'manual_direct_iqd'];
export interface GoodsLine extends Row {
  id: string; product_id: string | null; qty: number; bundle_parent_item_id: string | null;
  component_alloc_iqd: number | null; line_total_iqd: number; coupon_discount_iqd: number;
  membership_discount_iqd: number; cost_iqd: number | null;
}
export interface Allocation extends Row {
  id: string; order_id: string; order_item_id: string; lot_id: string; qty: number;
  cogs_iqd: number | null; unit_cost_iqd: number | null; released_at: string | null;
}
export type PricedGoodsLine = GoodsLine & { original_net_goods_iqd: number; price_adjustment_iqd: number;
  net_goods_iqd: number; cogs_iqd: number | null; fifo_cogs_iqd: number | null; cost_confidence: string };
export function spread(total: number, weights: number[]): number[] {
  if (!weights.length) return [];
  const safe = weights.map((v) => Math.max(0, v));
  const values = allocateExact(Math.abs(total), safe.some((v) => v > 0) ? safe : weights.map(() => 1));
  return values.map((v) => total < 0 && v !== 0 ? -v : v);
}
/** Checkout snapshots stay untouched; accepted final-price deltas are part of
 * recognised goods revenue, once. Bundle parents never count as another unit. */
export function calculateGoods(order: Row, all: GoodsLine[], allocations: Allocation[]) {
  const parents = new Set(all.map((v) => v.bundle_parent_item_id).filter(Boolean));
  const items = all.filter((v) => !parents.has(v.id));
  const net = items.map((v) => Math.max(0, n(v.component_alloc_iqd ?? v.line_total_iqd) - n(v.coupon_discount_iqd) - n(v.membership_discount_iqd)));
  for (const parentId of parents) {
    const parent = all.find((v) => v.id === parentId);
    if (!parent) continue;
    const indices = items.map((v, i) => v.bundle_parent_item_id === parentId ? i : -1).filter((i) => i >= 0);
    const total = indices.reduce((sum, i) => sum + net[i], 0);
    const discount = Math.min(total, n(parent.coupon_discount_iqd) + n(parent.membership_discount_iqd));
    if (discount > 0 && indices.length) spread(discount, indices.map((i) => net[i])).forEach((v, j) => net[indices[j]] -= v);
  }
  const goods = net.reduce((a, b) => a + b, 0);
  const points = Math.min(goods, n(order.points_discount_iqd));
  if (points > 0) spread(points, net).forEach((v, i) => net[i] -= v);
  const original = [...net], beforePrice = net.reduce((a, b) => a + b, 0);
  const priceDelta = n(order.price_adjustment_iqd);
  const goodsDelta = Math.max(-beforePrice, priceDelta);
  const shares = spread(goodsDelta, net.some((v) => v > 0) ? net : items.map((v) => v.qty));
  shares.forEach((v, i) => net[i] += v);
  let excessCut = Math.max(0, -priceDelta - beforePrice);
  const shippingCut = Math.min(excessCut, n(order.shipping_iqd));
  excessCut -= shippingCut;
  const taxCut = Math.min(excessCut, n(order.cod_tax_iqd));
  const effectiveOrder: Row & { shipping_iqd: number; cod_tax_iqd: number } = { ...order, original_shipping_iqd: n(order.shipping_iqd), original_cod_tax_iqd: n(order.cod_tax_iqd),
    shipping_iqd: n(order.shipping_iqd) - shippingCut, cod_tax_iqd: n(order.cod_tax_iqd) - taxCut };
  return {
    order: effectiveOrder,
    lines: items.map((v, i) => {
      const consumed = allocations.filter((a) => a.order_item_id === v.id && !a.released_at);
      const exact = consumed.length > 0 && consumed.every((a) => a.cogs_iqd !== null) && consumed.reduce((sum, a) => sum + a.qty, 0) >= v.qty;
      const cost = exact ? consumed.reduce((sum, a) => sum + n(a.cogs_iqd), 0) : consumed.length > 0 || v.cost_iqd === null ? null : v.cost_iqd * v.qty;
      return { ...v, original_net_goods_iqd: original[i], price_adjustment_iqd: shares[i] ?? 0,
        net_goods_iqd: net[i], cogs_iqd: cost, fifo_cogs_iqd: exact ? cost : null,
        cost_confidence: exact ? 'fifo' : cost === null ? 'unknown' : 'snapshot' } as PricedGoodsLine;
    }),
  };
}
export async function getOrderGoods(db: D1Database, orderId: string) {
  const [order, items, allocs] = await Promise.all([
    db.prepare('SELECT * FROM orders WHERE id=?').bind(orderId).first<Row>(),
    db.prepare('SELECT * FROM order_items WHERE order_id=? ORDER BY id').bind(orderId).all<GoodsLine>(),
    db.prepare('SELECT * FROM order_item_inventory_allocations WHERE order_id=? ORDER BY id').bind(orderId).all<Allocation>(),
  ]);
  return order ? calculateGoods(order, items.results ?? [], allocs.results ?? []) : null;
}
export interface ProfitLine extends Row {
  id: string; order_item_id: string; product_id: string | null; name_snapshot: string; sku_snapshot: string;
  qty: number; returned_qty: number; original_net_goods_iqd: number; net_goods_iqd: number;
  price_adjustment_iqd: number; refund_iqd: number; retained_revenue_iqd: number;
  fifo_cogs_iqd: number | null; restored_cogs_iqd: number | null; cogs_iqd: number | null;
  cost_confidence: string; shipping_income_iqd: number; cod_tax_iqd: number;
  courier_fee_iqd: number; payment_fee_iqd: number; direct_cost_iqd: number;
  wages_iqd: number; materials_iqd: number; manual_direct_iqd: number;
  gross_profit_iqd: number | null; contribution_profit_iqd: number | null; profit_basis_iqd: number | null;
  main_catalog_id: string; sub_catalog_id: string; main_name: string; sub_name: string;
  allocations: Array<{ id: string; lot_id: string; incoming_id: string | null; qty: number; cogs_iqd: number | null; unit_cost_iqd: number | null; returned_qty: number; returned_cogs_iqd: number | null; late_cost_iqd: number }>;
}
export interface ProfitTotals extends Row {
  net_goods_iqd: number; retained_revenue_iqd: number; refund_iqd: number; refunded_iqd: number;
  cogs_iqd: number | null; gross_profit_iqd: number | null; contribution_profit_iqd: number | null;
  profit_basis_iqd: number | null; wages_iqd: number; materials_iqd: number; direct_cost_iqd: number;
  manual_direct_iqd: number; courier_fee_iqd: number; payment_fee_iqd: number;
  shipping_income_iqd: number; cod_tax_iqd: number; units: number; pending_costs: number; unknown_lines: number;
}
export interface OrderProfitBase {
  order_id: string; version: number; order: Row; lines: ProfitLine[]; totals: ProfitTotals; costs: Row[]; warnings: string[];
}
export interface AdjustmentAllocation { line_id: string; delta_iqd: number | null; value_iqd?: number;quantity_basis?:number;restocked_qty_basis?:number }
export interface ProfitAdjustment extends Row {
  order_id: string; order_item_id: string | null; field: ProfitField; version: number;
  allocations_json: string; old_value_iqd: number | null; new_value_iqd: number;
}
export async function workspaceInstalled(db: D1Database) {
  return !!await db.prepare("SELECT 1 yes FROM sqlite_master WHERE type='table' AND name='finance_order_adjustments'").first();
}
const fieldKey = (field: ProfitField) => field === 'shipping_iqd' ? 'shipping_income_iqd' : field;
export function refreshProfit(base: OrderProfitBase) {
  for (const l of base.lines) {
    l.retained_revenue_iqd = l.net_goods_iqd - l.refund_iqd;
    l.gross_profit_iqd = l.cogs_iqd === null || n(l.unknown_refund)>0 ? null : l.retained_revenue_iqd - l.cogs_iqd;
    l.contribution_profit_iqd = l.gross_profit_iqd === null || n(l.pending_costs) > 0 ? null : l.gross_profit_iqd + l.shipping_income_iqd + l.cod_tax_iqd - l.direct_cost_iqd - l.manual_direct_iqd - l.courier_fee_iqd - l.payment_fee_iqd;
    l.profit_basis_iqd = l.contribution_profit_iqd;
  }
  base.totals = { ...base.totals, ...totalProfit(base.lines) };
  return base;
}
export function totalProfit(lines: ProfitLine[]): ProfitTotals {
  const total: Row = {};
  const fields = ['net_goods_iqd','retained_revenue_iqd','refund_iqd','cogs_iqd','gross_profit_iqd','contribution_profit_iqd','profit_basis_iqd','wages_iqd','materials_iqd','direct_cost_iqd','manual_direct_iqd','courier_fee_iqd','payment_fee_iqd','shipping_income_iqd','cod_tax_iqd'];
  for (const key of fields) total[key] = lines.some((l) => l[key] === null) ? null : lines.reduce((sum, l) => sum + n(l[key]), 0);
  total.units = lines.reduce((sum, l) => sum + l.qty, 0);
  total.returned_units = lines.reduce((sum, l) => sum + l.returned_qty, 0);
  total.refunded_iqd = total.refund_iqd;
  total.unknown_lines = lines.filter((l) => l.cogs_iqd === null).length;
  total.pending_costs = lines.reduce((sum, l) => sum + n(l.pending_costs), 0);
  return total as ProfitTotals;
}
export function applyProfitAdjustment(base: OrderProfitBase, adjustment: ProfitAdjustment) {
  const key = fieldKey(adjustment.field);
  const values = JSON.parse(adjustment.allocations_json) as AdjustmentAllocation[];
  for (const a of values) {
    const line = base.lines.find((l) => l.id === a.line_id);
    if (!line) continue;
    const factor=adjustment.field==='cogs_iqd'&&n(a.quantity_basis)>0?Math.max(0,line.qty-n(line.restocked_qty))/n(a.quantity_basis):1;
    const delta=a.delta_iqd===null?null:Math.trunc(a.delta_iqd*factor),absolute=a.value_iqd===undefined?null:Math.trunc(a.value_iqd*factor);
    (line as Row)[key] = delta === null ? absolute : line[key] === null ? null : n(line[key]) + delta;
    if (adjustment.field === 'cogs_iqd' && line[key] !== null) line.cost_confidence = 'manual_verified';
  }
  base.version = Math.max(base.version, adjustment.version);
  return refreshProfit(base);
}
export function planProfitAdjustment(base: OrderProfitBase, lineId: string | null, field: ProfitField, value: number) {
  if (!profitFields.includes(field) || !Number.isSafeInteger(value) || value < 0 || value > 1e12) throw badRequest('القيمة المالية غير صحيحة');
  const lines = lineId ? base.lines.filter((l) => l.id === lineId) : base.lines;
  if (!lines.length) throw notFound('Order line not found');
  const key = fieldKey(field);
  const previous = lines.some((l) => l[key] === null) ? null : lines.reduce((sum, l) => sum + n(l[key]), 0);
  const delta = previous === null ? null : value - previous;
  const moneyWeights = lines.map((l) => Math.max(0, n(l[key])));
  // A reduction cannot take money from a zero-valued line. Positive and
  // unknown-value edits use quantities only when no monetary basis exists.
  const shares = spread(delta ?? value, moneyWeights.some((v) => v > 0) ? moneyWeights : lines.map((l) => l.qty));
  const allocations:AdjustmentAllocation[] = lines.map((l, i) => ({ line_id: l.id, delta_iqd: delta === null ? null : shares[i], ...(delta === null ? { value_iqd: shares[i] } : {}),...(field==='cogs_iqd'?{quantity_basis:Math.max(0,l.qty-n(l.restocked_qty)),restocked_qty_basis:n(l.restocked_qty)}:{}) }));
  return { previous, delta, allocations };
}

/** Batched read-only basis. No investor or monthly-marketing table is read
 * here, so employee/investor entitlement cannot inherit an owner-only cost. */
export async function getOrderProfitBases(db: D1Database, orderIds: string[], options: { skipAdjustments?: boolean } = {}): Promise<OrderProfitBase[]> {
  if (!orderIds.length) return [];
  const ids = JSON.stringify([...new Set(orderIds)]);
  const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('finance_order_adjustments','finance_cost_adjustments','finance_line_departments','lot_cost_adjustment_shares')").all<{ name: string }>()).results ?? [];
  const present = new Set(tables.map((t) => t.name));
  const adjustedCost = present.has('finance_cost_adjustments') ? 'c.amount_iqd+COALESCE((SELECT SUM(a.delta_iqd) FROM finance_cost_adjustments a WHERE a.cost_id=c.id),0)' : 'c.amount_iqd';
  const scopeJoin = present.has('finance_line_departments') ? 'LEFT JOIN finance_line_departments fd ON fd.order_item_id=i.id' : '';
  const scopes = present.has('finance_line_departments') ? "CASE WHEN fd.order_item_id IS NOT NULL THEN COALESCE(fd.main_catalog_id,'') ELSE COALESCE(p.category_id,'') END main_catalog_id,CASE WHEN fd.order_item_id IS NOT NULL THEN COALESCE(fd.sub_catalog_id,'') ELSE COALESCE(p.sub_category_id,'') END sub_catalog_id,CASE WHEN fd.order_item_id IS NOT NULL THEN fd.main_name ELSE COALESCE(mc.name_ar,'') END main_name,CASE WHEN fd.order_item_id IS NOT NULL THEN fd.sub_name ELSE COALESCE(sc.name_ar,'') END sub_name,fd.captured_at department_snapshot_at,fd.is_legacy department_snapshot_legacy" : "COALESCE(p.category_id,'') main_catalog_id,COALESCE(p.sub_category_id,'') sub_catalog_id,COALESCE(mc.name_ar,'') main_name,COALESCE(sc.name_ar,'') sub_name,NULL department_snapshot_at,1 department_snapshot_legacy";
  const [orders, items, allocs, costs, refunds, expenses, collections, revisions, lateCosts,legacyRefunds] = await Promise.all([
    db.prepare('SELECT o.*,u.name customer_name FROM orders o LEFT JOIN users u ON u.id=o.user_id WHERE o.id IN (SELECT value FROM json_each(?)) ORDER BY o.id').bind(ids).all<Row>(),
    db.prepare(`SELECT i.*,${scopes} FROM order_items i LEFT JOIN products p ON p.id=i.product_id LEFT JOIN catalogs mc ON mc.id=p.category_id LEFT JOIN catalogs sc ON sc.id=p.sub_category_id ${scopeJoin} WHERE i.order_id IN (SELECT value FROM json_each(?)) ORDER BY i.id`).bind(ids).all<GoodsLine>(),
    db.prepare('SELECT a.*,l.incoming_id FROM order_item_inventory_allocations a LEFT JOIN inventory_lots l ON l.id=a.lot_id WHERE a.order_id IN (SELECT value FROM json_each(?)) ORDER BY a.id').bind(ids).all<Allocation>(),
    db.prepare(`SELECT c.*,${adjustedCost} effective_amount_iqd,s.name staff_name FROM finance_order_costs c LEFT JOIN finance_staff s ON s.id=c.staff_id WHERE c.order_id IN (SELECT value FROM json_each(?)) ORDER BY c.id`).bind(ids).all<Row>(),
    db.prepare('SELECT f.*,r.order_item_id FROM finance_refund_facts f JOIN return_cases r ON r.id=f.case_id WHERE f.order_id IN (SELECT value FROM json_each(?))').bind(ids).all<Row>(),
    db.prepare('SELECT l.order_id,e.amount_iqd FROM finance_expense_links l JOIN operating_expenses e ON e.id=l.expense_id WHERE e.voided_at IS NULL AND l.order_id IN (SELECT value FROM json_each(?)) AND NOT EXISTS(SELECT 1 FROM finance_order_costs c WHERE c.expense_id=e.id) AND NOT EXISTS(SELECT 1 FROM finance_collections c WHERE c.expense_id=e.id)').bind(ids).all<Row>(),
    db.prepare('SELECT order_id,SUM(amount_iqd) collected_iqd,SUM(fee_iqd) courier_fee_iqd FROM finance_collections WHERE order_id IN (SELECT value FROM json_each(?)) GROUP BY order_id').bind(ids).all<Row>(),
    present.has('finance_order_adjustments') ? db.prepare('SELECT * FROM finance_order_adjustments WHERE order_id IN (SELECT value FROM json_each(?)) ORDER BY version').bind(ids).all<ProfitAdjustment>() : Promise.resolve({ results: [] as ProfitAdjustment[] }),
    present.has('lot_cost_adjustment_shares') ? db.prepare('SELECT s.allocation_id,SUM(s.unit_delta_iqd) unit_delta_iqd FROM lot_cost_adjustment_shares s JOIN order_item_inventory_allocations a ON a.id=s.allocation_id WHERE a.order_id IN (SELECT value FROM json_each(?)) GROUP BY s.allocation_id').bind(ids).all<{allocation_id:string;unit_delta_iqd:number}>() : Promise.resolve({results:[] as {allocation_id:string;unit_delta_iqd:number}[]}),
    db.prepare(`SELECT r.id case_id,r.order_id,r.order_item_id,r.qty,COALESCE(si.disposition,'restock') disposition,
      COALESCE((SELECT json_extract(a.detail,'$.refund.amount_iqd') FROM audit_log a WHERE a.action='return.transition' AND a.target=r.id AND json_valid(a.detail) AND json_extract(a.detail,'$.refund.amount_iqd') IS NOT NULL ORDER BY a.id DESC LIMIT 1),
        (SELECT w.amount_iqd FROM wallet_transactions w WHERE w.id='wtx_ret_'||r.id AND w.status='approved')) refund_iqd,
      CASE WHEN o.gini_paid_iqd>0 THEN 'gini' ELSE 'wallet' END channel
      FROM return_cases r JOIN orders o ON o.id=r.order_id LEFT JOIN stock_return_inspections si ON si.return_case_id=r.id
      WHERE r.order_id IN (SELECT value FROM json_each(?)) AND r.state='resolved' AND r.resolution='refund' AND NOT EXISTS(SELECT 1 FROM finance_refund_facts f WHERE f.case_id=r.id)`).bind(ids).all<Row>(),
  ]);
  return (orders.results ?? []).map((order) => {
    const orderId = s(order.id);
    const orderAllocs = (allocs.results ?? []).filter((a) => a.order_id === orderId);
    const goods = calculateGoods(order, (items.results ?? []).filter((i) => i.order_id === orderId), orderAllocs);
    const orderCosts = (costs.results ?? []).filter((c) => c.order_id === orderId);
    const originalRefunds=(refunds.results??[]).filter((r)=>r.order_id===orderId);
    const legacy:Row[]=(legacyRefunds.results??[]).filter((r)=>r.order_id===orderId).map((r):Row=>{
      if(r.disposition==='damage')return {...r,cogs_iqd:0,legacy:true};
      const releases=orderAllocs.filter((a)=>a.order_item_id===r.order_item_id&&!!a.released_at);
      const knownFacts=originalRefunds.filter((f)=>f.order_item_id===r.order_item_id&&f.disposition==='restock');
      const remainingQty=releases.reduce((sum,a)=>sum+a.qty,0)-knownFacts.reduce((sum,f)=>sum+n(f.qty),0);
      const legacyQty=(legacyRefunds.results??[]).filter((f)=>f.order_item_id===r.order_item_id&&f.disposition==='restock').reduce((sum,f)=>sum+n(f.qty),0);
      const remainingCost=releases.some((a)=>a.cogs_iqd===null)||knownFacts.some((f)=>f.cogs_iqd===null)?null:releases.reduce((sum,a)=>sum+n(a.cogs_iqd),0)-knownFacts.reduce((sum,f)=>sum+n(f.cogs_iqd),0);
      return {...r,cogs_iqd:remainingQty>=legacyQty&&remainingCost!==null?spread(remainingCost,(legacyRefunds.results??[]).filter((f)=>f.order_item_id===r.order_item_id&&f.disposition==='restock').map((f)=>n(f.qty)))[(legacyRefunds.results??[]).filter((f)=>f.order_item_id===r.order_item_id&&f.disposition==='restock').findIndex((f)=>f.case_id===r.case_id)]:null,legacy:true};
    });
    const orderRefunds=[...originalRefunds,...legacy];
    const incomeWeights = goods.lines.map((l) => l.net_goods_iqd || l.qty);
    const shipping = spread(n(goods.order.shipping_iqd), incomeWeights), tax = spread(n(goods.order.cod_tax_iqd), incomeWeights);
    const collected = (collections.results ?? []).find((c) => c.order_id === orderId);
    const courier = spread(n(collected?.courier_fee_iqd), incomeWeights);
    const manual = spread((expenses.results ?? []).filter((e) => e.order_id === orderId).reduce((sum, e) => sum + n(e.amount_iqd), 0), incomeWeights);
    const warnings: string[] = [];
    const lines: ProfitLine[] = goods.lines.map((l, i) => {
      const returns = orderRefunds.filter((r) => r.order_item_id === l.id);
      if(returns.some((r)=>r.legacy))warnings.push(`refund:${l.id}:legacy_source`);
      const unknownReturn = returns.some((r) => r.disposition === 'restock' && r.cogs_iqd === null);
      const restored = unknownReturn ? null : returns.filter((r) => r.disposition === 'restock').reduce((sum, r) => sum + n(r.cogs_iqd), 0);
      const lineCost = l.cogs_iqd === null || restored === null ? null : l.cogs_iqd - restored;
      const originalAllocations = orderAllocs.filter((a) => a.order_item_id === l.id && !a.released_at);
      return {
        ...l, id: l.id, order_item_id: l.id, name_snapshot: s(l.name_snapshot), sku_snapshot: s(l.sku_snapshot),
        returned_qty: returns.reduce((sum, r) => sum + n(r.qty), 0),restocked_qty:returns.filter((r)=>r.disposition==='restock').reduce((sum,r)=>sum+n(r.qty),0), refund_iqd: returns.reduce((sum, r) => sum + n(r.refund_iqd), 0),unknown_refund:returns.some((r)=>r.refund_iqd===null)?1:0,
        retained_revenue_iqd: 0, restored_cogs_iqd: restored, cogs_iqd: lineCost,
        shipping_income_iqd: shipping[i] ?? 0, cod_tax_iqd: tax[i] ?? 0, courier_fee_iqd: courier[i] ?? 0, payment_fee_iqd: 0,
        direct_cost_iqd: 0, wages_iqd: 0, materials_iqd: 0, manual_direct_iqd: manual[i] ?? 0, pending_costs: 0,
        gross_profit_iqd: null, contribution_profit_iqd: null, profit_basis_iqd: null,
        main_catalog_id: s(l.main_catalog_id), sub_catalog_id: s(l.sub_catalog_id), main_name: s(l.main_name), sub_name: s(l.sub_name),
        allocations: originalAllocations.map((a) => {
          const released = orderAllocs.filter((r) => r.order_item_id === l.id && r.lot_id === a.lot_id && !!r.released_at);
          // Releases are per lot, so consume their budget across allocations
          // below instead of attaching the same return to every split.
          return { id: a.id, lot_id: a.lot_id, incoming_id: a.incoming_id ? s(a.incoming_id) : null,
            qty: a.qty, cogs_iqd: a.cogs_iqd, unit_cost_iqd: a.unit_cost_iqd,
            returned_qty: released.reduce((sum, r) => sum + r.qty, 0), returned_cogs_iqd: released.some((r) => r.cogs_iqd === null) ? null : released.reduce((sum, r) => sum + n(r.cogs_iqd), 0),late_cost_iqd:0 };
        }),
      } as ProfitLine;
    });
    for (const l of lines) {
      const released = new Map<string, { qty: number; cost: number | null }>();
      for (const a of l.allocations) {
        if (!released.has(a.lot_id)) released.set(a.lot_id, { qty: a.returned_qty, cost: a.returned_cogs_iqd });
        const left = released.get(a.lot_id)!;
        a.returned_qty = Math.min(a.qty, left.qty);
        a.returned_cogs_iqd = left.cost === null ? null : a.unit_cost_iqd === null ? null : a.returned_qty * a.unit_cost_iqd;
        left.qty -= a.returned_qty;
        a.late_cost_iqd = n((lateCosts.results ?? []).find((c) => c.allocation_id === a.id)?.unit_delta_iqd) * Math.max(0,a.qty-a.returned_qty);
      }
      if(l.cogs_iqd!==null)l.cogs_iqd+=l.allocations.reduce((sum,a)=>sum+a.late_cost_iqd,0);
      if (l.cost_confidence !== 'fifo') warnings.push(`cost:${l.id}:${l.cost_confidence}`);
    }
    for (const c of orderCosts) {
      if (c.state === 'reversed') continue;
      const targets = c.order_item_id ? lines.filter((l) => l.id === c.order_item_id) : lines;
      const shares = spread(n(c.effective_amount_iqd), targets.map((l) => l.net_goods_iqd || l.qty));
      targets.forEach((l, i) => {
        if (c.state === 'pending_cost') { l.pending_costs = n(l.pending_costs) + 1; return; }
        l.direct_cost_iqd += shares[i] ?? 0;
        if (c.staff_id) l.wages_iqd += shares[i] ?? 0; else l.materials_iqd += shares[i] ?? 0;
      });
    }
    const base: OrderProfitBase = { order_id: orderId, version: 0, order: { ...order }, lines, costs: orderCosts,
      totals: {} as ProfitTotals, warnings: [...new Set(warnings)] };
    refreshProfit(base);
    if (!options.skipAdjustments) for (const a of revisions.results ?? []) if (a.order_id === orderId) applyProfitAdjustment(base, a);
    base.warnings=base.warnings.filter((w)=>!w.startsWith('cost:')||!base.lines.some((l)=>w.startsWith(`cost:${l.id}:`)&&l.cost_confidence==='manual_verified'));
    base.totals.collected_iqd = n(collected?.collected_iqd);
    base.totals.collection_difference_iqd = n(order.due_on_delivery_iqd) + n(order.gini_paid_iqd) - orderRefunds.filter((r) => r.channel === 'gini').reduce((sum, r) => sum + n(r.refund_iqd), 0) - n(collected?.collected_iqd);
    base.totals.orders_count = 1;
    return base;
  });
}
export async function getOrderProfitBase(db: D1Database, orderId: string): Promise<OrderProfitBase> {
  const result = (await getOrderProfitBases(db, [orderId]))[0];
  if (!result) throw notFound('Order not found');
  return result;
}

/** A source fence protects corrections from a refund, collection or FIFO
 * posting that arrives after the editor has read its current calculation. */
export async function profitSourceFingerprint(db:D1Database,orderId:string) {
  const present=(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('finance_cost_adjustments','lot_cost_adjustment_shares')").all<{name:string}>()).results??[];
  const has=new Set(present.map((r)=>r.name));
  const sql=`json_array(
    (SELECT json_array(status,updated_at,price_adjustment_iqd,shipping_iqd,cod_tax_iqd,due_on_delivery_iqd,gini_paid_iqd) FROM orders WHERE id=?1),
    (SELECT json_group_array(json_array(id,qty,cogs_iqd,released_at)) FROM (SELECT * FROM order_item_inventory_allocations WHERE order_id=?1 ORDER BY id)),
    (SELECT json_group_array(json_array(case_id,refund_iqd,qty,disposition,cogs_iqd)) FROM (SELECT * FROM finance_refund_facts WHERE order_id=?1 ORDER BY case_id)),
    (SELECT json_group_array(json_array(r.id,r.state,r.resolution,r.qty,w.amount_iqd,(SELECT detail FROM audit_log a WHERE a.action='return.transition' AND a.target=r.id ORDER BY a.id DESC LIMIT 1))) FROM return_cases r LEFT JOIN wallet_transactions w ON w.id='wtx_ret_'||r.id WHERE r.order_id=?1),
    (SELECT json_group_array(json_array(id,state,amount_iqd,staff_id)) FROM (SELECT * FROM finance_order_costs WHERE order_id=?1 ORDER BY id)),
    (SELECT json_group_array(json_array(id,amount_iqd,fee_iqd)) FROM (SELECT * FROM finance_collections WHERE order_id=?1 ORDER BY id)),
    (SELECT json_group_array(json_array(e.id,e.amount_iqd,e.voided_at)) FROM operating_expenses e JOIN finance_expense_links l ON l.expense_id=e.id WHERE l.order_id=?1),
    (SELECT json_group_array(json_array(e.id,e.state)) FROM accounting_entries e WHERE (e.source_type='order' AND e.source_id=?1) OR (e.source_type='return' AND e.source_id IN (SELECT id FROM return_cases WHERE order_id=?1))),
    ${has.has('finance_cost_adjustments')?"(SELECT json_group_array(json_array(a.id,a.delta_iqd)) FROM finance_cost_adjustments a JOIN finance_order_costs c ON c.id=a.cost_id WHERE c.order_id=?1)":'NULL'},
    ${has.has('lot_cost_adjustment_shares')?"(SELECT json_group_array(json_array(s.adjustment_id,s.allocation_id,s.unit_delta_iqd,s.recognized_iqd)) FROM lot_cost_adjustment_shares s JOIN order_item_inventory_allocations a ON a.id=s.allocation_id WHERE a.order_id=?1)":'NULL'})`;
  const value=(await db.prepare(`SELECT ${sql} value`).bind(orderId).first<{value:string}>())!.value;
  return {sql,value};
}
const postingStateSql="COALESCE((SELECT json_group_array(json_array(field,total)) FROM (SELECT field,SUM(delta_iqd) total FROM finance_workspace_postings WHERE order_id=? GROUP BY field ORDER BY field)),'[]')";
/** Accounting overlays do not alter the invoice, customer debt, bank cash or
 * physical FIFO. Their counterpart is the explicit order settlement account. */
export async function planWorkspaceAccounting(db:D1Database,plain:OrderProfitBase,corrected:OrderProfitBase,opts:{actor?:string;day?:string}={}) {
  const statements:D1PreparedStatement[]=[],journalIds:string[]=[];
  if(plain.order.status!=='delivered'||!await db.prepare("SELECT 1 FROM accounting_entries WHERE event_key=? AND state='posted'").bind(`sale:${plain.order_id}`).first())return {statements,journalIds,pending:true};
  const day=opts.day??baghdadDay();await periodOpen(db,day);
  const rows=(await db.prepare('SELECT field,SUM(delta_iqd) total FROM finance_workspace_postings WHERE order_id=? GROUP BY field ORDER BY field').bind(plain.order_id).all<{field:ProfitField;total:number}>()).results??[];
  const state=JSON.stringify(rows.map((r)=>[r.field,r.total]));
  statements.push(...fence(db,`${postingStateSql}=?`,[plain.order_id,state]));
  const nativeCogs=n((await db.prepare(`SELECT COALESCE(SUM(l.debit_iqd-l.credit_iqd),0) amount FROM accounting_lines l JOIN accounting_entries e ON e.id=l.entry_id
    WHERE l.account_code='5000' AND e.state='posted' AND ((e.source_type='order' AND e.source_id=?1) OR (e.source_type='return' AND e.source_id IN (SELECT id FROM return_cases WHERE order_id=?1)))`).bind(plain.order_id).first<{amount:number}>())?.amount);
  const lateInstalled=!!await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lot_cost_adjustment_shares'").first();
  const recognizedLate=lateInstalled?n((await db.prepare('SELECT COALESCE(SUM(s.recognized_iqd),0) amount FROM lot_cost_adjustment_shares s JOIN order_item_inventory_allocations a ON a.id=s.allocation_id WHERE a.order_id=?').bind(plain.order_id).first<{amount:number}>())?.amount):0;
  let pending=false;
  const accounts:Record<ProfitField,string>={net_goods_iqd:'4000',cogs_iqd:'5000',shipping_iqd:'4100',cod_tax_iqd:'4100',courier_fee_iqd:'5200',payment_fee_iqd:'5400',manual_direct_iqd:'5100'};
  for(const field of profitFields){
    const key=fieldKey(field),before=plain.lines.reduce((sum,l)=>sum+n(l[key]),0),after=corrected.lines.reduce((sum,l)=>sum+n(l[key]),0);
    if(corrected.lines.some((l)=>l[key]===null)){if(field==='cogs_iqd'&&corrected.lines.some((l)=>l.cost_confidence==='manual_verified'))pending=true;continue;}
    const manualCost=corrected.lines.some((l)=>l.cost_confidence==='manual_verified');
    if(field==='cogs_iqd'&&manualCost&&corrected.lines.some((l)=>!['fifo','manual_verified'].includes(l.cost_confidence))){pending=true;continue;}
    const desired=field==='cogs_iqd'?(manualCost?after-nativeCogs-recognizedLate:0):after-before,delta=desired-(rows.find((r)=>r.field===field)?.total??0);
    if(!delta)continue;
    const income=['net_goods_iqd','shipping_iqd','cod_tax_iqd'].includes(field),amount=Math.abs(delta),increase=delta>0;
    const debitAccount=income===increase?'2990':accounts[field],creditAccount=income===increase?accounts[field]:'2990';
    const id=newId('profitpost');
    const journal=journalPlan(db,{key:`order-workspace:${id}`,day,title:'تصحيح مالي خاص بالطلب',source:'order_workspace',sourceId:plain.order_id,actor:opts.actor},[{account:debitAccount,debit:amount},{account:creditAccount,credit:amount}]);
    statements.push(...journal.statements,db.prepare('INSERT INTO finance_workspace_postings(id,order_id,field,delta_iqd,journal_id,actor_id,created_at) VALUES (?,?,?,?,?,?,?)').bind(id,plain.order_id,field,delta,journal.id,opts.actor??null,new Date().toISOString()));
    journalIds.push(journal.id);
  }
  return {statements,journalIds,pending};
}
export async function syncOrderWorkspaceAccounting(db:D1Database,orderId:string,opts:{actor?:string;day?:string}={}) {
  if(!await workspaceInstalled(db))return;
  const source=await profitSourceFingerprint(db,orderId);
  const [plain,corrected]=await Promise.all([getOrderProfitBases(db,[orderId],{skipAdjustments:true}),getOrderProfitBases(db,[orderId])]);
  if(!plain[0]||!corrected[0])return;
  const plan=await planWorkspaceAccounting(db,plain[0],corrected[0],opts);
  if(plan.pending&&corrected[0].order.status==='delivered'&&corrected[0].lines.some((l)=>l.cost_confidence==='manual_verified'))throw conflict('بعض بنود تكلفة الطلب تنتظر FIFO أو التحقق المالي قبل تثبيت التسوية','WORKSPACE_COGS_PENDING');
  if(!plan.journalIds.length)return;
  try{await db.batch([...fence(db,`(${source.sql.replace(/\?1/g,'?2')})=? AND COALESCE((SELECT version FROM finance_order_versions WHERE order_id=?),0)=?`,[orderId,source.value,orderId,corrected[0].version]),...plan.statements]);}
  catch(e){if(/CHECK constraint|UNIQUE constraint/.test(String(e)))throw conflict('تغير مصدر ربح الطلب؛ أعد محاولة التسوية');throw e;}
}

export async function monthlyPromotionShares(db: D1Database, month: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw badRequest('الشهر غير صحيح');
  if (!await workspaceInstalled(db)) return { total_iqd: 0, shares: new Map<string, number>(), unallocated_iqd: 0, promotions: [] as Row[] };
  const [promotions, lines] = await Promise.all([
    db.prepare('SELECT *,CASE WHEN currency=\'IQD\' THEN amount_minor ELSE amount_minor/100.0 END amount FROM finance_monthly_promotions WHERE month=? ORDER BY id').bind(month).all<Row>(),
    db.prepare(`SELECT i.id,i.qty FROM order_items i JOIN orders o ON o.id=i.order_id
      WHERE o.status='delivered' AND o.seller_type='levonis' AND substr(date(o.delivered_at,'+3 hours'),1,7)=?
      AND NOT EXISTS(SELECT 1 FROM order_items child WHERE child.bundle_parent_item_id=i.id) ORDER BY i.id LIMIT 10001`).bind(month).all<{ id: string; qty: number }>(),
  ]);
  const total = (promotions.results ?? []).filter((p) => n(p.enabled) === 1).reduce((sum, p) => sum + n(p.amount_iqd), 0);
  const sold = lines.results ?? [];
  if (sold.length > 10000) throw badRequest('عدد بنود الشهر تجاوز حد التوزيع؛ لا يمكن توزيع جزئي للترويج');
  const values = spread(total, sold.map((l) => l.qty));
  return { total_iqd: total, shares: new Map(sold.map((l, i) => [l.id, values[i] ?? 0])),
    unallocated_iqd: sold.length ? 0 : total, promotions: promotions.results ?? [] };
}
export async function addOwnerPromotions(db: D1Database, bases: OrderProfitBase[]) {
  const months = new Map<string, Awaited<ReturnType<typeof monthlyPromotionShares>>>();
  for (const base of bases) {
    if (base.order.status !== 'delivered' || !base.order.delivered_at) continue;
    const month = new Date(Date.parse(s(base.order.delivered_at)) + 3 * 3600000).toISOString().slice(0, 7);
    if (!months.has(month)) months.set(month, await monthlyPromotionShares(db, month));
    const allocation = months.get(month)!;
    for (const line of base.lines) {
      line.promotion_iqd = allocation.shares.get(line.id) ?? 0;
      line.owner_net_iqd = line.profit_basis_iqd === null ? null : line.profit_basis_iqd - n(line.promotion_iqd);
    }
    base.totals.promotion_iqd = base.lines.reduce((sum, l) => sum + n(l.promotion_iqd), 0);
    base.totals.owner_net_iqd = base.totals.profit_basis_iqd === null ? null : base.totals.profit_basis_iqd - n(base.totals.promotion_iqd);
  }
  return bases;
}
