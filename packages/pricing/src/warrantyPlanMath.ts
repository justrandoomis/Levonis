/**
 * The pure half of warranty-plan pricing: constants, the fee arithmetic, the
 * total-months rule and the read-time device-policy defaults. Moved verbatim
 * from `worker/lib/warrantyPlans.ts` (Phase 1.1) because `pricing.ts` needs
 * them and the pure package may not import the core; the core file re-exports
 * every symbol here, so no caller changed. The guard that needs D1 and HTTP
 * errors (`applyPrinterWarrantyRules`, `catalogsArePrinter`) stays in the core.
 */

import type { WarrantyPlanV2 } from './pricing';

/** A printer's base coverage, months from the documented delivery. */
export const PRINTER_BASE_MONTHS = 12;
/** The only extensions a printer may offer: +12 → 24 total, +24 → 36 total. */
export const PRINTER_EXTENSION_MONTHS = [12, 24] as const;
export type PrinterExtensionMonths = (typeof PRINTER_EXTENSION_MONTHS)[number];

/** Percent rules — a plan fee is between 0.01% and 100% with ≤ 2 decimals. */
export const FEE_PERCENT_MIN = 0.01;
export const FEE_PERCENT_MAX = 100;
/** The owner's example range, shown as a hint in the admin form only. */
export const FEE_PERCENT_HINT = { min: 7.5, max: 10 } as const;

export const WARRANTY_NOT_PRINTER = 'WARRANTY_NOT_PRINTER';
export const WARRANTY_PLAN_INVALID = 'WARRANTY_PLAN_INVALID';

/** The plan fields the fee and the totals need — accepted from any surface
 *  (a stored plan, a template item, a snapshot) without the full V2 shape. */
export type PlanLike = Pick<WarrantyPlanV2, 'duration_months' | 'duration_kind'> & {
  fee_iqd: number;
  fee_percent?: number | null;
};

/** True for a well-formed percent: finite, within range, at most 2 decimals. */
export function isValidFeePercent(v: unknown): v is number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return false;
  if (v < FEE_PERCENT_MIN || v > FEE_PERCENT_MAX) return false;
  return Math.round(v * 100) / 100 === v;
}

/** Reads a percent off loose input: a number, or a decimal string with ≤ 2
 *  decimals ("7.5", "10", "+7.5"). Anything else → null. */
export function parseFeePercent(raw: unknown): number | null {
  if (typeof raw === 'number') return isValidFeePercent(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const text = raw.trim().replace(/^\+/, '');
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const n = Number(text);
  return isValidFeePercent(n) ? n : null;
}

/**
 * THE fee, in integer IQD. A percent plan charges `round(basis × pct / 100)`;
 * the arithmetic goes through basis points (an integer) so 7.5% of 899,000 is
 * exactly 67,425 and never a float artefact. A plan without a percent
 * charges its fixed fee verbatim.
 */
export function planFee(plan: PlanLike, basisIqd: number): number {
  const pct = plan.fee_percent;
  if (typeof pct === 'number' && Number.isFinite(pct) && pct > 0) {
    const bp = Math.round(pct * 100); // 7.5% → 750 basis points
    const basis = Number.isFinite(basisIqd) && basisIqd > 0 ? Math.round(basisIqd) : 0;
    return Math.round((basis * bp) / 10000);
  }
  return Number.isInteger(plan.fee_iqd) && plan.fee_iqd >= 0 ? plan.fee_iqd : 0;
}

/**
 * Total coverage a plan yields on top of a base. An extension adds its months
 * to the base (null base → null: an extension alone is not a total, and
 * nothing is invented); a legacy 'total' plan IS the total.
 */
export function planTotalMonths(plan: Pick<PlanLike, 'duration_months' | 'duration_kind'>, baseMonths: number | null): number | null {
  if (plan.duration_kind === 'total') return plan.duration_months;
  return baseMonths === null ? null : baseMonths + plan.duration_months;
}

// ------------------------------------------------------------ ops_policy

/** The two warranty-relevant keys of products.ops_policy, read defensively. */
export function readOpsWarranty(raw: unknown): { serialized: boolean | null; warranty_base_months: number | null; policy: Record<string, unknown> } {
  let obj: Record<string, unknown> = {};
  if (typeof raw === 'object' && raw !== null) obj = raw as Record<string, unknown>;
  else if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === 'object' && parsed !== null) obj = parsed as Record<string, unknown>;
    } catch {
      obj = {};
    }
  }
  const months = obj.warranty_base_months ?? obj.warranty_months;
  const base = typeof months === 'number' && Number.isInteger(months) && months >= 1 && months <= 240 ? months : null;
  const serialized = obj.serialized === true ? true : obj.serialized === false ? false : null;
  return { serialized, warranty_base_months: base, policy: obj };
}

/**
 * THE READ-TIME DEFAULTS — the one place a printer's missing device keys are
 * filled in when a row is READ, mirroring what `printerWarrantyRules` fills in
 * on write. A printer whose ops_policy was stored before this round ('{}',
 * or only a base) still sells +12/+24 plans, so the units its delivery
 * creates, the snapshot the checkout freezes and the totals the product page
 * and the cart show must all read the same answer: a printer is serialized
 * unless the owner explicitly said `false`, and its base is 12 months unless
 * the owner configured another. A non-printer gets exactly what is stored —
 * nothing is invented for it. No migration rewrites old rows; this helper is
 * the fix, used by deviceOps, the resolver (through `effectiveBaseMonths`),
 * `pricedPlans` and the cart.
 */
export interface EffectiveDevicePolicy {
  serialized: boolean;
  warranty_base_months: number | null;
}

export function effectiveDevicePolicy(policy: unknown, isPrinter: boolean): EffectiveDevicePolicy {
  // The stored JSON (string or object) and the document's own
  // `{ serialized, warranty_base_months }` pair read through the same parser.
  const read = readOpsWarranty(policy);
  if (!isPrinter) return { serialized: read.serialized === true, warranty_base_months: read.warranty_base_months };
  return {
    serialized: read.serialized === null ? true : read.serialized,
    warranty_base_months: read.warranty_base_months === null ? PRINTER_BASE_MONTHS : read.warranty_base_months,
  };
}

/** The base coverage a plan's total is built on: the configured months, or
 *  the 12-month printer default when the product is a printer with none. */
export function effectiveBaseMonths(baseMonths: number | null | undefined, isPrinter: boolean): number | null {
  return effectiveDevicePolicy({ serialized: null, warranty_base_months: baseMonths ?? null }, isPrinter).warranty_base_months;
}
