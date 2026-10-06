import { allocateProcurementCharge, roundProcurementProduct } from '../../../packages/contracts/src/procurementCost';

export type EstimateLine = { qty_ordered: number; source_unit_amount: number | string; source_total_amount?: number | string; purchase_cost_mode?: string; selling_price_iqd: number; weight_g: number; volume_mm3: number };
export type EstimateCharge = { amount_iqd: number; basis: string };
export type EstimateShipping = { basis: 'weight' | 'volume'; rate: number };
// Mirrors the server's declared allocation for the estimate only. The server
// validates selections, rounds IQD and allocates every dinar again at save time.
function split(total: number, weights: number[]) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!sum) return weights.map(() => 0);
  const raw = weights.map((w) => total * w / sum), out = raw.map(Math.floor);
  const order = raw.map((n, i) => ({ i, part: n - out[i] })).sort((a, b) => b.part - a.part || a.i - b.i);
  for (let i = 0, left = total - out.reduce((a, b) => a + b, 0); i < left; i++) out[order[i % order.length].i]++;
  return out;
}
function rounded(values: (number | string)[], divisor = 1) {
  try { return roundProcurementProduct(values, divisor); } catch { return NaN; }
}
export function purchaseEstimate(lines: EstimateLine[], charges: EstimateCharge[], rate: number, profitBps: number, included?: number[], shipping?: EstimateShipping) {
  const costs = lines.map((l) => {
    const source = l.purchase_cost_mode === 'total' ? l.source_total_amount : l.source_unit_amount;
    if (source == null || source === '' || !Number.isFinite(Number(source)) || Number(source) < 0 || !Number.isFinite(rate) || rate <= 0) return NaN;
    return l.purchase_cost_mode === 'total'
      ? (shipping ? rounded([source, rate]) : Math.round(Number(source) * rate))
      : (shipping ? rounded([source, rate, l.qty_ordered]) : Math.round(Number(source) * rate) * l.qty_ordered);
  });
  const autoFreight = lines.map((l) => {
    if (!shipping) return 0;
    const measure = shipping.basis === 'weight' ? l.weight_g : l.volume_mm3;
    if (!Number.isFinite(measure) || measure <= 0 || measure > 1e15) return NaN;
    return rounded([l.qty_ordered, measure, shipping.rate], shipping.basis === 'weight' ? 1_000 : 1_000_000_000);
  });
  const allocated = [...autoFreight];
  for (const c of charges) {
    const weights = lines.map((l, i) => c.basis === 'value' ? costs[i] : c.basis === 'weight' ? l.qty_ordered * l.weight_g : c.basis === 'volume' ? l.qty_ordered * l.volume_mm3 : l.qty_ordered);
    let parts: number[];
    try { parts = shipping ? allocateProcurementCharge(c.amount_iqd, weights) : split(c.amount_iqd, weights); }
    catch { parts = lines.map(() => NaN); }
    parts.forEach((v, i) => { allocated[i] += v; });
  }
  return lines.map((l, i) => {
    const total = costs[i] + allocated[i], profit = l.selling_price_iqd * l.qty_ordered - total;
    const investor = !included || included.includes(i) ? Math.floor(Math.max(0, profit) * profitBps / 10000) : 0;
    return { purchase_iqd: costs[i], auto_shipping_iqd: autoFreight[i], freight_iqd: allocated[i], total_iqd: total, unit_iqd: total / l.qty_ordered, profit_iqd: profit, investor_iqd: investor, owner_iqd: profit - investor };
  });
}
