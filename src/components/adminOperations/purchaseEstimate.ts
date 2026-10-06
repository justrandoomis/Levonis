import { allocateProcurementCharges, procurementSelectionKey, roundProcurementProduct, type ProcurementChargeBasis } from '../../../packages/contracts/src/procurementCost';

export type EstimateLine = { product_id?: string; scope?: string; scope_id?: string | null; qty_ordered: number; source_unit_amount: number | string; source_total_amount?: number | string; purchase_cost_mode?: string; selling_price_iqd: number; weight_g: number; volume_mm3: number };
export type EstimateCharge = { amount_iqd: number; basis: string; scope?: 'shipment' | 'unit'; unit_amount_iqd?: number | null; applies_to?: readonly string[] | null; review?: boolean };
export type EstimateShipping = { basis: 'weight' | 'volume'; rate: number };
/** The key a charge's `applies_to` names; a line without a selection is its own. */
export const estimateLineKey = (l: EstimateLine, i: number) =>
  l.product_id ? procurementSelectionKey({ product_id: l.product_id, scope: l.scope ?? '', scope_id: l.scope_id }) : `line:${i}`;
function rounded(values: (number | string)[], divisor = 1) {
  try { return roundProcurementProduct(values, divisor); } catch { return NaN; }
}
// The server validates selections, rounds IQD and allocates every dinar again
// at save time — with the same allocator, so the preview is what is saved.
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
  const chargeLines = lines.map((l, i) => ({ key: estimateLineKey(l, i), qty: l.qty_ordered, value: costs[i], weight_g: l.weight_g, volume_mm3: l.volume_mm3 }));
  // shares[charge][line]: the dinars a charge puts on a line. A charge waiting
  // for review counts nothing; one that cannot be allocated yet is NaN.
  const shares = charges.map((c) => {
    if (c.review) return lines.map(() => 0);
    try {
      return allocateProcurementCharges([{ scope: c.scope ?? 'shipment', amount_iqd: c.amount_iqd, unit_amount_iqd: c.unit_amount_iqd ?? null, basis: c.basis as ProcurementChargeBasis, applies_to: c.applies_to ?? null }], chargeLines)[0];
    } catch { return lines.map(() => NaN); }
  });
  return lines.map((l, i) => {
    const extras = shares.reduce((n, row) => n + row[i], 0);
    const freight = autoFreight[i] + extras;
    const total = costs[i] + freight, profit = l.selling_price_iqd * l.qty_ordered - total;
    const investor = !included || included.includes(i) ? Math.floor(Math.max(0, profit) * profitBps / 10000) : 0;
    return { purchase_iqd: costs[i], auto_shipping_iqd: autoFreight[i], extras_iqd: extras, charge_shares: shares.map((row) => row[i]), freight_iqd: freight, total_iqd: total, unit_iqd: total / l.qty_ordered, profit_iqd: profit, investor_iqd: investor, owner_iqd: profit - investor };
  });
}
