import type { CostProfile } from '../../../packages/contracts/src/procurementCost';
import { exactProcurementUnitDefault, procurementDiscountSet } from '../../../packages/contracts/src/procurementCost';
import type { Selection } from './shared';
import type { PurchaseUnitOrigin } from './procurementUnitOrigins';

export type ProcurementDraftLine = Selection & {
  qty_ordered: number;
  source_unit_amount: number | string;
  invoiced_qty: number;
  purchase_cost_mode?: 'unit' | 'total';
  source_total_amount?: number | string;
  /** A retired supplier discount an older draft carries (DECISIONS row 273): kept on the line, never sent. */
  discounted_unit_amount?: number | string;
  unit_conversion_inexact?: boolean;
  unit_origins?: PurchaseUnitOrigin[];
};

/** Only the new, explicitly raw supplier defaults are safe to prefill. Historical
 * catalogue and purchase references may already include freight. */
export function selectionCostDraft(selection: Selection, profileId: string | null, quantity = 1): ProcurementDraftLine {
  const saved = profileId ? selection.procurement_defaults?.find((d) => d.profile_id === profileId) : undefined;
  const raw = saved?.source_unit_amount;
  const hasRaw = raw != null && Number.isFinite(raw) && raw >= 0;
  return {
    ...selection,
    qty_ordered: quantity,
    invoiced_qty: quantity,
    purchase_cost_mode: 'unit',
    source_unit_amount: hasRaw ? raw : '',
    source_total_amount: hasRaw ? Number((raw * quantity).toFixed(6)) : '',
    unit_conversion_inexact: false,
    weight_g: saved?.weight_g ?? selection.packed_weight_g ?? 0,
    volume_mm3: saved?.volume_mm3 ?? selection.packed_volume_mm3 ?? 0,
    cost_source: hasRaw ? 'procurement_default' : 'unknown',
    cost_date: hasRaw ? saved?.updated_at ?? null : null,
  };
}

export function changeLineCostProfile(line: ProcurementDraftLine, profile: CostProfile | null): ProcurementDraftLine {
  const replacement = selectionCostDraft(line, profile?.id ?? null, line.qty_ordered);
  return {
    ...replacement,
    invoiced_qty: line.invoiced_qty,
    purchase_cost_mode: line.purchase_cost_mode,
    // A discount was typed against the supplier price of the old route.
    discounted_unit_amount: '',
    unit_origins: line.unit_origins,
  };
}

/** A new quantity keeps what was typed and recomputes the figure derived from
 * it: the line total of a unit price, or the unit average of an invoice total.
 * A default invoice quantity follows the ordered one, also after a blank. */
export function changeLineQuantity(line: ProcurementDraftLine, qty: number): ProcurementDraftLine {
  const follows = line.invoiced_qty === line.qty_ordered || !Number.isFinite(line.qty_ordered);
  const next = { ...line, qty_ordered: qty, invoiced_qty: follows ? qty : line.invoiced_qty };
  if (!Number.isSafeInteger(qty) || qty < 1) return next;
  if ((line.purchase_cost_mode || 'unit') === 'total') {
    const total = line.source_total_amount;
    return total == null || total === '' ? next : { ...next, source_unit_amount: Number(total) / qty };
  }
  return { ...next, source_total_amount: line.source_unit_amount === '' ? '' : Number((Number(line.source_unit_amount) * qty).toFixed(6)) };
}

/** A line saved by the older screen with a supplier discount stored the
 * discounted unit price; its raw before-discount input lives in the saved
 * request. Editing or copying it restores the raw price from there (row 273:
 * the line is costed from it again). */
export function restoreLineDiscounts<T extends ProcurementDraftLine>(lines: T[], requestJson: string | null | undefined): T[] {
  let sent: Array<Record<string, unknown>> = [];
  try { const body = JSON.parse(requestJson || '{}'); if (Array.isArray(body.lines)) sent = body.lines; } catch { return lines; }
  const used = new Set<number>();
  return lines.map((line) => {
    const at = sent.findIndex((r, i) => !used.has(i) && procurementDiscountSet(r.discounted_unit_amount)
      && r.product_id === line.product_id && r.scope === line.scope && (r.scope_id ?? '') === (line.scope_id ?? '')
      && Number(r.qty_ordered) === line.qty_ordered && Number(r.discounted_unit_amount) === Number(line.source_unit_amount));
    if (at < 0) return line;
    used.add(at);
    const r = sent[at];
    const mode = r.purchase_cost_mode === 'total' ? 'total' : 'unit';
    const amount = (v: unknown) => (v == null || v === '' || !Number.isFinite(Number(v)) ? '' : Number(v));
    return { ...line, purchase_cost_mode: mode, source_unit_amount: amount(r.source_unit_amount), source_total_amount: amount(r.source_total_amount), discounted_unit_amount: Number(r.discounted_unit_amount) };
  });
}

export function changePurchaseCostMode(line: ProcurementDraftLine, mode: 'unit' | 'total', unitDecimals: 0 | 6 = 6): ProcurementDraftLine {
  if ((line.purchase_cost_mode || 'unit') === mode) return line;
  if (mode === 'total') {
    const total = line.unit_conversion_inexact && line.source_unit_amount === ''
      ? line.source_total_amount ?? ''
      : line.source_unit_amount === '' ? '' : Number((Number(line.source_unit_amount) * line.qty_ordered).toFixed(6));
    return { ...line, purchase_cost_mode: mode, source_total_amount: total, unit_conversion_inexact: false };
  }
  let unit: number | null = null;
  const entered = line.source_total_amount;
  if (entered != null && entered !== '') {
    try { unit = exactProcurementUnitDefault(entered, line.qty_ordered); } catch { /* incomplete draft */ }
  }
  if (unit !== null && unitDecimals === 0 && !Number.isInteger(unit)) unit = null;
  return { ...line, purchase_cost_mode: mode, source_unit_amount: unit ?? '', unit_conversion_inexact: unit === null && entered != null && entered !== '' };
}

export function packedMeasureValid(line: Pick<Selection, 'weight_g' | 'volume_mm3'>, basis: 'weight' | 'volume') {
  const value = basis === 'weight' ? line.weight_g : line.volume_mm3;
  return Number.isFinite(value) && value > 0 && value <= 1e15;
}

/** Current concurrency token, original document economics. Older v2 drafts
 * deliberately remain manual instead of inheriting a currently selected route. */
export function restoreCostProfileSnapshot<T extends object>(snapshot: T, profiles: CostProfile[]) {
  const fields = snapshot as { cost_profile_id?: string | null; cost_profile_version?: number | null; shipping_basis?: 'weight' | 'volume' | null; shipping_rate_iqd?: number | null };
  return {
    ...snapshot,
    cost_profile_id: fields.cost_profile_id ?? null,
    cost_profile_version: profiles.find((p) => p.id === fields.cost_profile_id)?.version ?? fields.cost_profile_version ?? null,
    shipping_basis: fields.shipping_basis ?? null,
    shipping_rate_iqd: fields.shipping_rate_iqd ?? null,
  };
}

/** A new purchase copied from an old one is priced today: the route's current
 * exchange and freight rates, never the old document's — confirming the copy
 * would otherwise save those old rates back as the route's defaults. */
export function cloneCostProfileSnapshot<T extends object>(snapshot: T, profiles: CostProfile[]) {
  const restored = restoreCostProfileSnapshot(snapshot, profiles);
  const profile = profiles.find((p) => p.id === restored.cost_profile_id);
  return profile
    ? { ...restored, currency: profile.currency, exchange_rate: profile.exchange_rate ?? NaN, shipping_rate_iqd: profile.shipping_rate_iqd, shipping_basis: profile.shipping_basis, cost_profile_version: profile.version }
    : restored;
}

export function packedMeasureInput(value: string, basis: 'weight' | 'volume') {
  if (value === '' || !Number.isFinite(Number(value))) return NaN;
  // The UI exposes kg (up to a gram) and CBM (up to a cubic millimetre).
  return Math.round(Number(value) * (basis === 'weight' ? 1_000 : 1_000_000_000));
}
