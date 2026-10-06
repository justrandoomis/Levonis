import { PROCUREMENT_CHARGE_BASES, type ProcurementChargeBasis } from '../../../packages/contracts/src/procurementCost';

/** One extra cost the buyer actually paid for this shipment — local delivery,
 * customs, transfer fees, packaging. Never the raw supplier price and never
 * the freight a supplier route already calculates from packed weight.
 * `review`: typed under manual entry before a route was chosen; it may be the
 * freight the route now calculates, so it counts nothing until confirmed. */
export type ChargeDraft = {
  title: string;
  scope: 'shipment' | 'unit';
  /** The whole amount, for `shipment` (NaN while empty). */
  amount_iqd: number;
  /** Dinars per piece, for `unit` (NaN while empty). */
  unit_amount_iqd: number;
  basis: ProcurementChargeBasis;
  /** Selection keys this charge covers; null covers every line. */
  applies_to: string[] | null;
  review?: boolean;
};

export const newChargeDraft = (): ChargeDraft => ({ title: '', scope: 'shipment', amount_iqd: NaN, unit_amount_iqd: NaN, basis: 'quantity', applies_to: null });

const amount = (value: unknown) => (value == null || value === '' ? NaN : Number(value));

/** A saved document row or an older local draft, read as typed. Anything
 * unreadable becomes empty for the buyer to fill in, never a guessed amount. */
export function chargeDraft(raw: unknown): ChargeDraft {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const scope = r.scope === 'unit' ? 'unit' : 'shipment';
  const keys = Array.isArray(r.applies_to) ? r.applies_to.filter((k): k is string => typeof k === 'string') : [];
  return {
    title: typeof r.title === 'string' ? r.title : '',
    scope,
    amount_iqd: scope === 'shipment' ? amount(r.amount_iqd) : NaN,
    unit_amount_iqd: scope === 'unit' ? amount(r.unit_amount_iqd) : NaN,
    basis: PROCUREMENT_CHARGE_BASES.includes(r.basis as ProcurementChargeBasis) ? (r.basis as ProcurementChargeBasis) : 'quantity',
    applies_to: keys.length ? keys : null,
    ...(r.review === true ? { review: true } : {}),
  };
}

/** The request shape: only the amount that belongs to the chosen scope. */
export const chargeWire = (c: ChargeDraft) => ({
  title: c.title.trim(),
  scope: c.scope,
  basis: c.scope === 'unit' ? 'quantity' : c.basis,
  amount_iqd: c.scope === 'shipment' ? c.amount_iqd : null,
  unit_amount_iqd: c.scope === 'unit' ? c.unit_amount_iqd : null,
  applies_to: c.applies_to,
});

/** Choosing a supplier route after typing manual charges: a manual «شحن» would
 * now be counted on top of the calculated freight. Each carried charge waits
 * for the buyer to confirm it is something else, or to remove it. */
export function chargesAfterRouteChange(charges: ChargeDraft[], from: string | null, to: string | null): ChargeDraft[] {
  return from || !to ? charges : charges.map((c) => ({ ...c, review: true }));
}

export type ChargeProblem = 'review' | 'title' | 'amount' | 'lines' | 'basis';
/** Why a charge cannot be saved yet. `allocated` is false when its shares
 * could not be computed (for example by weight, with a line weighing nothing). */
export function chargeProblems(c: ChargeDraft, keys: readonly string[], allocated: boolean): ChargeProblem[] {
  const problems: ChargeProblem[] = [];
  if (c.review) problems.push('review');
  if (!c.title.trim()) problems.push('title');
  const typed = c.scope === 'unit' ? c.unit_amount_iqd : c.amount_iqd;
  if (!Number.isSafeInteger(typed) || typed < 1) problems.push('amount');
  if (c.applies_to && (!c.applies_to.length || c.applies_to.some((k) => !keys.includes(k)))) problems.push('lines');
  else if (!problems.length && !allocated) problems.push('basis');
  return problems;
}

/** International freight is calculated from the route; a charge named like it
 * is worth a second look (local delivery is a separate, legitimate cost). */
export const looksLikeFreight = (title: string) => /شحن(?!ة)|\b(?:freight|shipping)\b|بارکردن/i.test(title);
