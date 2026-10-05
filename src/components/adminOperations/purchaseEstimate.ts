export type EstimateLine = { qty_ordered: number; source_unit_amount: number | string; source_total_amount?: number | string; purchase_cost_mode?: string; selling_price_iqd: number; weight_g: number; volume_mm3: number };
export type EstimateCharge = { amount_iqd: number; basis: string };
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
export function purchaseEstimate(lines: EstimateLine[], charges: EstimateCharge[], rate: number, profitBps: number, included?: number[]) {
  const costs = lines.map((l) => l.purchase_cost_mode === 'total' ? Math.round(Number(l.source_total_amount) * rate) : Math.round(Number(l.source_unit_amount) * rate) * l.qty_ordered);
  const allocated = lines.map(() => 0);
  for (const c of charges) {
    const weights = lines.map((l, i) => c.basis === 'value' ? costs[i] : c.basis === 'weight' ? l.qty_ordered * l.weight_g : c.basis === 'volume' ? l.qty_ordered * l.volume_mm3 : l.qty_ordered);
    const parts = split(c.amount_iqd, weights);
    parts.forEach((v, i) => { allocated[i] += v; });
  }
  return lines.map((l, i) => {
    const total = costs[i] + allocated[i], profit = l.selling_price_iqd * l.qty_ordered - total;
    const investor = !included || included.includes(i) ? Math.floor(Math.max(0, profit) * profitBps / 10000) : 0;
    return { purchase_iqd: costs[i], freight_iqd: allocated[i], total_iqd: total, unit_iqd: total / l.qty_ordered, profit_iqd: profit, investor_iqd: investor, owner_iqd: profit - investor };
  });
}
