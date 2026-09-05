/**
 * Extended warranty for PRINTERS — the one place the rules live.
 *
 * The owner's mandate: a printer ships with 12 months of coverage from
 * delivery; the customer may add 12 more (24 total) or 24 more (36 total),
 * either on the product page before adding to the cart or inside the cart —
 * and only BEFORE the order is placed, never after. Each option is priced as a
 * PERCENTAGE of the printer's price (the owner's example: 7.5% to 10%), with a
 * fixed IQD fee as the fallback for a plan that states no percentage. The
 * system applies to printers only.
 *
 * What is decided here and nowhere else:
 *  - the constants (12 base months; +12 and +24 are the only extensions);
 *  - the percent rules (0.01..100, at most two decimals; 7.5–10 is a HINT the
 *    admin form shows, not a cap the server enforces);
 *  - `planFee`, the ONE fee computation: `round(basis × percent / 100)` in
 *    integer IQD, else the fixed fee. The basis is the line's REGULAR price,
 *    never the member price — the warranty fee is never waived or reduced by
 *    membership (pinned by tests/pricing.test.ts), so a PRO and a guest pay
 *    the same dinar for the same extension;
 *  - `planTotalMonths`, so "+12 → 24 total" is computed once and shown the
 *    same way on the product page, in the cart, on the order and on the unit;
 *  - the write-path guard: a non-printer carrying plans is refused
 *    (WARRANTY_NOT_PRINTER), a printer's plans must be +12/+24 extensions
 *    (one per duration), and a printer offering them is serialized with a
 *    configured base so the delivered units can actually record 24/36 months.
 *
 * "Is this a printer" is the owner's catalog flag, answered by
 * worker/lib/printerIdentity.ts for a product that exists; for a document
 * still being written the same flag is read off the catalogs it is filed
 * under (`catalogsArePrinter`). Nothing here infers printer-ness from a name.
 *
 * Legacy data keeps RESOLVING: a stored 'total'-kind plan or a plan on a
 * non-printer product is still priced and snapshotted when an existing order
 * is read, and computeCoverage still understands it. The rules below bite on
 * WRITE (admin save, template, CSV import) and at runtime on cart add/update
 * and checkout — never on a row that already exists.
 *
 * A printer row stored BEFORE the rules (ops_policy '{}', or only a base) is
 * read with the same defaults the write path fills in — `effectiveDevicePolicy`
 * below — so a plan it sells is a plan its delivered units record.
 */

import type { WarrantyPlanV2 } from './pricing';
import { badRequest } from './http';
import { isPrinterProduct } from './printerIdentity';

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

/**
 * ONE writer for the device keys of ops_policy — used by the product
 * serializer and by the explicit admin route (worker/routes/devices.ts), so
 * the two can never disagree about the key names. Other keys (size_class,
 * is_spool, …) are preserved untouched. `null` for serialized = leave the
 * stored answer alone; `null` for base months = explicitly not configured
 * (both spellings removed).
 */
export function mergeOpsPolicy(
  existing: Record<string, unknown>,
  changes: { serialized?: boolean | null; warranty_base_months?: number | null }
): Record<string, unknown> {
  const policy: Record<string, unknown> = { ...existing };
  if (changes.serialized === true || changes.serialized === false) policy.serialized = changes.serialized;
  if (changes.warranty_base_months !== undefined) {
    if (changes.warranty_base_months === null) {
      delete policy.warranty_base_months;
      delete policy.warranty_months;
    } else {
      policy.warranty_base_months = changes.warranty_base_months;
      delete policy.warranty_months; // single canonical key going forward
    }
  }
  return policy;
}

// ------------------------------------------------------------ the guard

/** The document fields the printer rules read and (for defaults) write. */
export interface WarrantyGuardDoc {
  warranty_plans: Array<PlanLike & { id: string; active: boolean }>;
  serialized: boolean | null;
  warranty_base_months: number | null;
}

/**
 * The printer rules, synchronously, once printer-ness is known. Returns the
 * issues as messages (empty = fine) and, for a printer, fills the two
 * defaults the mandate implies: serialized (a printer is a device we track
 * per unit) and the 12-month base. Shared by the async guard below and by the
 * CSV resolver, which knows the catalog flag without a query.
 */
export function printerWarrantyRules(doc: WarrantyGuardDoc, isPrinter: boolean): string[] {
  const issues: string[] = [];
  const plans = doc.warranty_plans;
  if (!isPrinter) {
    if (plans.length > 0) {
      issues.push(
        'warranty_plans: extended warranty is offered for printers only — this product is not filed under a printer catalog (WARRANTY_NOT_PRINTER)'
      );
    }
    return issues;
  }
  // A printer: the two defaults, then the shape of every plan.
  if (doc.serialized === null) doc.serialized = true;
  if (doc.warranty_base_months === null) doc.warranty_base_months = PRINTER_BASE_MONTHS;
  const seen = new Set<number>();
  for (const w of plans) {
    if (w.duration_kind !== 'extension') {
      issues.push(`warranty_plans.${w.id}.duration_kind: a printer plan must be an "extension" over the base warranty`);
    }
    if (!(PRINTER_EXTENSION_MONTHS as readonly number[]).includes(w.duration_months)) {
      issues.push(
        `warranty_plans.${w.id}.duration_months: a printer extension is 12 or 24 months (24 or 36 total), got ${w.duration_months}`
      );
    } else if (seen.has(w.duration_months)) {
      issues.push(`warranty_plans.${w.id}.duration_months: only one plan per duration (+${w.duration_months} months is already offered)`);
    }
    seen.add(w.duration_months);
  }
  if (plans.some((w) => w.active) && doc.serialized === false) {
    issues.push('serialized: a printer offering extended warranty must be serialized, or its delivered units cannot record the coverage');
  }
  return issues;
}

/** Whether any of these catalog ids is a printer catalog (the owner's flag). */
export async function catalogsArePrinter(db: D1Database, catalogIds: Iterable<string>): Promise<boolean> {
  const ids = [...new Set([...catalogIds].filter((x) => typeof x === 'string' && x !== ''))];
  if (ids.length === 0) return false;
  const row = await db
    .prepare(`SELECT 1 AS x FROM catalogs WHERE is_printer_catalog = 1 AND id IN (${ids.map(() => '?').join(',')}) LIMIT 1`)
    .bind(...ids)
    .first();
  return !!row;
}

/**
 * The write-path guard every product writer calls after validateProductDoc:
 * decides printer-ness from the catalogs the document is (about to be) filed
 * under — the explicit list when the caller has one, else the stored
 * product_catalogs rows — applies the printer rules and defaults, and refuses
 * with 400 when they are broken. `catalogIds` may include the section pair
 * (category_id / sub_category_id), which are catalogs rows too.
 */
export async function applyPrinterWarrantyRules(
  db: D1Database,
  doc: WarrantyGuardDoc & { id: string; category_id: string | null; sub_category_id: string | null },
  catalogIds: string[] | undefined
): Promise<{ is_printer: boolean }> {
  const explicit = [...(catalogIds ?? []), doc.category_id ?? '', doc.sub_category_id ?? ''].filter(Boolean);
  let isPrinter = await catalogsArePrinter(db, explicit);
  if (!isPrinter && catalogIds === undefined && doc.id) isPrinter = await isPrinterProduct(db, doc.id);
  const issues = printerWarrantyRules(doc, isPrinter);
  if (issues.length) {
    const code = issues[0].includes(WARRANTY_NOT_PRINTER) ? WARRANTY_NOT_PRINTER : WARRANTY_PLAN_INVALID;
    throw badRequest(issues.join(' | '), code);
  }
  return { is_printer: isPrinter };
}

/**
 * The runtime gate for the cart and the checkout: a warranty plan may ride on
 * a line only when the product is a printer. The plan itself is validated by
 * the resolver (WARRANTY_PLAN_NOT_FOUND); this is the "printers only" half.
 */
export function refuseNonPrinterWarranty(isPrinter: boolean, warrantyPlanId: string | null | undefined, label?: string): void {
  if (!warrantyPlanId || isPrinter) return;
  throw badRequest(
    `${label ? `"${label}": ` : ''}Extended warranty is available for printers only`,
    WARRANTY_NOT_PRINTER
  );
}

/**
 * The plan list a storefront surface shows for ONE selection: every active
 * plan with its fee already resolved against that selection's regular price,
 * so the customer sees the exact dinar the cart will charge before choosing.
 * Non-printers get an empty list — the cart would refuse the plan anyway, and
 * offering it would be a promise the shop cannot keep.
 */
export function pricedPlans(
  plans: WarrantyPlanV2[],
  basisIqd: number,
  baseMonths: number | null,
  isPrinter: boolean
): Array<WarrantyPlanV2 & { basis_iqd: number; base_months: number | null; total_months: number | null }> {
  if (!isPrinter) return [];
  // A printer with no configured base still yields "+12 → 24": the read-time
  // default is the same 12 months the write path fills in.
  const base = effectiveBaseMonths(baseMonths, isPrinter);
  return plans
    .filter((w) => w.active !== false)
    .map((w) => ({
      ...w,
      fee_iqd: planFee(w, basisIqd),
      basis_iqd: basisIqd,
      base_months: base,
      total_months: planTotalMonths(w, base),
    }));
}
