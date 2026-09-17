/**
 * OPEN BOX, USED AND REFURBISHED — what "not new" means, in one place.
 *
 * The owner sells repaired and lightly-used devices beside new ones: an X2D
 * Combo whose AMS motherboard was replaced under a factory fault is, in every
 * practical sense, a new printer — but it is not a NEW printer, and the shop
 * must never let those two sentences blur. Everything that follows from that
 * distinction lives here, so a screen, a return case and a warranty
 * certificate cannot each decide it differently.
 *
 * THREE RULES, AND THEY ARE THE WHOLE FEATURE.
 *
 * 1. THE PRICE IS TYPED, AND THE COMPARISON IS LIVE. The owner types what the
 *    used unit costs; the listing NAMES the new product it is a copy of, and
 *    the storefront reads that product's current price for the struck-through
 *    figure. The alternative — a stored discount percentage — was considered
 *    and rejected: repricing a new printer would then silently reprice every
 *    used copy of it, including ones already in somebody's cart.
 *
 * 2. THE WARRANTY IS ONE MONTH OR TWELVE, AND NOTHING IS SOLD ON TOP. A new
 *    printer carries twelve months and may be extended by twelve or
 *    twenty-four more; on a repaired unit those extensions are a promise that
 *    is hard to keep, so `warrantyExtendable` is false for every condition
 *    listing and the product page offers none.
 *
 * 3. IT CANNOT BE RETURNED BECAUSE SOMEBODY CHANGED THEIR MIND — and it CAN
 *    be claimed when it arrives broken. Refusing a dead-on-arrival unit is not
 *    what "غير قابل للإرجاع" means to a buyer, and a shop that refused it
 *    would lose more than the unit is worth. `RETURN_BLOCKED_REASONS` is the
 *    exact line between the two.
 *
 * A product with no condition document is NEW. That is the default for every
 * row that existed before this feature and for every row the owner does not
 * mark, and nothing here changes how a new product behaves.
 */

/** What kind of not-new this is. The three the owner named. */
export const CONDITION_KINDS = ['open_box', 'used', 'refurbished'] as const;
export type ConditionKind = (typeof CONDITION_KINDS)[number];

/**
 * How worn it is. Deliberately a short, ordered ladder rather than free text:
 * a grade a customer can compare across listings is worth more than a
 * sentence, and the sentence still exists in `notes`.
 */
export const CONDITION_GRADES = ['like_new', 'excellent', 'good', 'fair'] as const;
export type ConditionGrade = (typeof CONDITION_GRADES)[number];

/** The only two warranty lengths the owner offers on a condition listing. */
export const CONDITION_WARRANTY_MONTHS = [1, 12] as const;
export type ConditionWarrantyMonths = (typeof CONDITION_WARRANTY_MONTHS)[number];

/**
 * Return reasons a condition listing refuses.
 *
 * `not_as_described` is here and `defective` is not, which is the whole of
 * decision 3 above. A used unit is SOLD as imperfect — its grade, its hours
 * and its repair history are on the page — so "it was not as I pictured it" is
 * the change-of-mind case wearing a different hat. A unit that arrives dead,
 * damaged by the courier, or is simply the wrong box, is none of those things.
 */
export const RETURN_BLOCKED_REASONS = ['not_as_described'] as const;

export interface ConditionDoc {
  kind: ConditionKind;
  grade: ConditionGrade;
  /** Hours the device has actually run, when the owner knows it. */
  usage_hours: number | null;
  warranty_months: ConditionWarrantyMonths;
  /**
   * The NEW product this is a used copy of. Optional: a trade-in with no new
   * counterpart in the catalogue is still sellable, it simply shows no
   * comparison. Never used to inherit price, stock or specs — only to look up
   * the figure shown struck through.
   */
  new_product_id: string | null;
  /** What was wrong with it, per language. Empty when nothing was. */
  fault_ar: string;
  fault_en: string;
  fault_ckb: string;
  /** What was done about it. */
  repair_ar: string;
  repair_en: string;
  repair_ckb: string;
  /** Anything else the buyer should know before paying. */
  notes_ar: string;
  notes_en: string;
  notes_ckb: string;
  /**
   * Photographs of THIS unit, not of the model. A stock photo cannot show a
   * scuff, and the scuff is what the buyer is accepting in exchange for the
   * discount, so these are kept apart from `products.images`.
   */
  unit_images: string[];
}

const MAX_TEXT = 2_000;
const MAX_IMAGES = 12;
const MAX_HOURS = 200_000;

export function isConditionKind(v: unknown): v is ConditionKind {
  return typeof v === 'string' && (CONDITION_KINDS as readonly string[]).includes(v);
}

export function isConditionGrade(v: unknown): v is ConditionGrade {
  return typeof v === 'string' && (CONDITION_GRADES as readonly string[]).includes(v);
}

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim().slice(0, MAX_TEXT) : '';
}

function imageList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string') continue;
    const s = item.trim();
    // Same shape the rest of the catalogue stores: a `/files/<key>` path or an
    // http(s) URL. Anything else is dropped rather than rendered as a broken
    // <img> on a page whose whole job is to be honest about the item.
    if (!s || !(s.startsWith('/') || /^https?:\/\//i.test(s))) continue;
    out.push(s);
    if (out.length >= MAX_IMAGES) break;
  }
  return out;
}

/**
 * The stored document, or null for a NEW product.
 *
 * Returns null rather than a "new" variant on purpose: every caller then has
 * to say what it does for an ordinary product, and none of them can
 * accidentally treat an unmarked row as a graded one.
 */
export function parseConditionDoc(raw: unknown): ConditionDoc | null {
  let value: unknown = raw;
  if (typeof value === 'string') {
    if (!value.trim()) return null;
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  if (!isConditionKind(o.kind)) return null;

  const hoursRaw = typeof o.usage_hours === 'string' ? Number(o.usage_hours) : o.usage_hours;
  const hours =
    typeof hoursRaw === 'number' && Number.isFinite(hoursRaw) && hoursRaw >= 0
      ? Math.min(MAX_HOURS, Math.floor(hoursRaw))
      : null;

  const months = Number(o.warranty_months);

  return {
    kind: o.kind,
    grade: isConditionGrade(o.grade) ? o.grade : 'good',
    usage_hours: hours,
    // Twelve is the default because it is what a new device carries: if the
    // owner has not said otherwise, the buyer is not quietly given less.
    warranty_months: months === 1 ? 1 : 12,
    new_product_id: typeof o.new_product_id === 'string' && o.new_product_id.trim() ? o.new_product_id.trim() : null,
    fault_ar: text(o.fault_ar),
    fault_en: text(o.fault_en),
    fault_ckb: text(o.fault_ckb),
    repair_ar: text(o.repair_ar),
    repair_en: text(o.repair_en),
    repair_ckb: text(o.repair_ckb),
    notes_ar: text(o.notes_ar),
    notes_en: text(o.notes_en),
    notes_ckb: text(o.notes_ckb),
    unit_images: imageList(o.unit_images),
  };
}

/** What goes back into the column. `null` stores an empty object: NEW. */
export function serializeConditionDoc(doc: ConditionDoc | null): string {
  return doc ? JSON.stringify(doc) : '{}';
}

/** True when this product is anything other than new. */
export function isConditionProduct(doc: ConditionDoc | null): doc is ConditionDoc {
  return doc !== null;
}

/**
 * Whether a return case may be opened, and why not.
 *
 * Returns null when the return is allowed, so a caller reads
 * `const refusal = returnRefusal(...)` and refuses only on a value.
 */
export function returnRefusal(doc: ConditionDoc | null, reason: string): 'CONDITION_NO_RETURN' | null {
  if (!doc) return null;
  return (RETURN_BLOCKED_REASONS as readonly string[]).includes(reason) ? 'CONDITION_NO_RETURN' : null;
}

/**
 * The warranty a condition listing carries, in months — the owner's choice
 * per listing, and the ONLY source for it. A used printer does not inherit
 * the twelve months `warrantyPlans.ts` gives a new one.
 */
export function conditionWarrantyMonths(doc: ConditionDoc | null): number | null {
  return doc ? doc.warranty_months : null;
}

/** Paid extensions are never offered on a unit that has already been used. */
export function warrantyExtendable(doc: ConditionDoc | null): boolean {
  return doc === null;
}

/**
 * What the customer saves, given the linked new product's CURRENT price.
 *
 * Null when there is nothing honest to show: no link, no known new price, or
 * a used price that is not actually lower. That last case is not a rounding
 * detail — printing «توفير 0 د.ع» or a negative saving beside a struck-through
 * number is worse than printing nothing.
 */
export function conditionSaving(
  usedPriceIqd: number,
  newPriceIqd: number | null | undefined
): { reference_iqd: number; saving_iqd: number } | null {
  if (typeof newPriceIqd !== 'number' || !Number.isFinite(newPriceIqd) || newPriceIqd <= 0) return null;
  if (!Number.isFinite(usedPriceIqd) || usedPriceIqd <= 0) return null;
  const saving = Math.round(newPriceIqd) - Math.round(usedPriceIqd);
  if (saving <= 0) return null;
  return { reference_iqd: Math.round(newPriceIqd), saving_iqd: saving };
}
