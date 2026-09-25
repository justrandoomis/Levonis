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
import type { ConditionDoc } from './condition';
import { isPrinterProduct } from './printerIdentity';

// The pure plan math lives in the shared pricing package since Phase 1.1
// (packages/pricing/src/warrantyPlanMath.ts); every symbol keeps its name here.
export {
  PRINTER_BASE_MONTHS,
  PRINTER_EXTENSION_MONTHS,
  FEE_PERCENT_MIN,
  FEE_PERCENT_MAX,
  FEE_PERCENT_HINT,
  WARRANTY_NOT_PRINTER,
  WARRANTY_PLAN_INVALID,
  isValidFeePercent,
  parseFeePercent,
  planFee,
  planTotalMonths,
  readOpsWarranty,
  effectiveDevicePolicy,
  effectiveBaseMonths,
  type PrinterExtensionMonths,
  type PlanLike,
  type EffectiveDevicePolicy,
} from '@levonis/pricing/warrantyPlanMath';
import {
  PRINTER_BASE_MONTHS,
  PRINTER_EXTENSION_MONTHS,
  WARRANTY_NOT_PRINTER,
  WARRANTY_PLAN_INVALID,
  planFee,
  planTotalMonths,
  effectiveBaseMonths,
  type PlanLike,
} from '@levonis/pricing/warrantyPlanMath';

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
/** Refused: a used or refurbished unit does not sell extended coverage. */
export const WARRANTY_NOT_EXTENDABLE = 'WARRANTY_NOT_EXTENDABLE';

export interface WarrantyGuardDoc {
  warranty_plans: Array<PlanLike & { id: string; active: boolean }>;
  serialized: boolean | null;
  warranty_base_months: number | null;
  /** Open box / used / refurbished, or null for a new product. */
  condition?: ConditionDoc | null;
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

  /**
   * A USED OR REFURBISHED DEVICE CARRIES THE OWNER'S CHOICE, AND NOTHING MORE.
   *
   * The rules below give every printer a 12-month base and let it sell +12 or
   * +24 on top. Neither is right for a repaired unit: the owner sets one month
   * or twelve per listing, and selling two further years of coverage on a
   * machine that has already failed once is a promise that is hard to keep —
   * so extensions are refused rather than silently priced.
   *
   * This runs BEFORE the printer branch on purpose. A used printer is still a
   * printer, so without it the 12-month default would overwrite the one month
   * the owner chose, and the +12/+24 shapes would be accepted.
   */
  if (doc.condition) {
    if (plans.some((w) => w.active)) {
      issues.push(
        `warranty_plans: extended warranty is not sold on a used or refurbished unit — it carries ${doc.condition.warranty_months} month(s) of LEVONIS warranty (${WARRANTY_NOT_EXTENDABLE})`
      );
    }
    // The owner's choice IS the base, and a used device is still tracked per
    // unit so its certificate can name the months it actually carries.
    doc.warranty_base_months = doc.condition.warranty_months;
    if (doc.serialized === null) doc.serialized = true;
    return issues;
  }

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
    .prepare(`SELECT 1 AS x FROM catalogs WHERE is_printer_catalog = 1 AND id IN (SELECT value FROM json_each(?)) LIMIT 1`)
    .bind(JSON.stringify(ids))
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
    const code = issues[0].includes(WARRANTY_NOT_EXTENDABLE)
      ? WARRANTY_NOT_EXTENDABLE
      : issues[0].includes(WARRANTY_NOT_PRINTER)
        ? WARRANTY_NOT_PRINTER
        : WARRANTY_PLAN_INVALID;
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
