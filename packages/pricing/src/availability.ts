/**
 * HOW ONE OPTION IS FULFILLED — the vocabulary, in one place.
 *
 * A product used to answer "pre-order or direct sale?" once, for all of
 * itself, in `products.sale_types`. That is right for most of the catalogue
 * and wrong for the case this exists for: a Bambu Lab A1 is one product whose
 * A1 and A1 Combo each sell BOTH ways, at four different prices, with four
 * different stocks and two different lead times.
 *
 * So an option may now answer for itself. The rules that follow from that are
 * small, and all of them are here rather than spread across the resolver, the
 * importer and two user interfaces:
 *
 *   INHERIT IS THE DEFAULT, AND IT IS SPELLED ''. Every option written before
 *   this feature has '' and therefore behaves exactly as it did — it is the
 *   product's sale types that decide. Nothing was backfilled, so there is no
 *   migration to be wrong about.
 *
 *   AN OPTION NEVER WIDENS ITS PRODUCT. `pre_order` on an option of a
 *   direct-only product is a contradiction the admin has to resolve, not
 *   something to be silently honoured — the product's stages, its cart
 *   shipping type and its transports all follow from sale_types. So the
 *   product's list is derived FROM the options (deriveSaleTypes) rather than
 *   checked against them, and the two cannot drift.
 *
 *   THE PRODUCT-LEVEL ANSWER IS STILL AN ARRAY. `sale_types` has been the
 *   authority since 0018 and already expresses "both". `mixed` is a word this
 *   module translates, not a value anything stores.
 */

/** What a single option says about itself. '' = inherit from the product. */
export type AvailabilityType = '' | 'direct_sale' | 'pre_order';

export const AVAILABILITY_TYPES: Array<'direct_sale' | 'pre_order'> = ['direct_sale', 'pre_order'];

/** Accepts what a human or an old file might write; '' when it means nothing. */
export function normalizeAvailability(raw: unknown): AvailabilityType {
  const v = String(raw ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (v === 'direct_sale' || v === 'direct' || v === 'in_stock') return 'direct_sale';
  if (v === 'pre_order' || v === 'preorder') return 'pre_order';
  return '';
}

/**
 * The availability an option EFFECTIVELY has, once inheritance is applied.
 *
 * A product selling one way makes every silent option that way. A product
 * selling both ways leaves a silent option genuinely undecided, and the
 * caller must keep treating it the way it treated options before this
 * existed — by the line's transport selection — because guessing here would
 * change the behaviour of a product nobody edited.
 */
export function effectiveAvailability(
  option: { availability_type?: AvailabilityType } | null | undefined,
  saleTypes: readonly string[]
): AvailabilityType {
  const own = normalizeAvailability(option?.availability_type);
  if (own) return own;
  const pre = saleTypes.includes('pre_order');
  const direct = saleTypes.includes('direct_sale') || saleTypes.includes('bundle');
  if (pre && !direct) return 'pre_order';
  if (direct && !pre) return 'direct_sale';
  return '';
}

/**
 * The product's sale types, READ OFF ITS OPTIONS.
 *
 * `fallback` is what the product itself declares, and it is what survives when
 * no option has an opinion — which is every product that existed before this
 * feature. An option list that does have opinions overrides it, so an admin
 * cannot ship a product whose options say pre-order while the product says
 * direct sale and whose customers therefore get direct-sale stages.
 *
 * 'bundle' is carried through untouched: it is a catalogue classification, not
 * a fulfilment route, and no option ever claims it.
 */
export function deriveSaleTypes(
  options: ReadonlyArray<{ availability_type?: AvailabilityType; active?: boolean }>,
  fallback: readonly string[]
): string[] {
  const declared = new Set<string>();
  for (const o of options) {
    if (o.active === false) continue;
    const a = normalizeAvailability(o.availability_type);
    if (a) declared.add(a);
  }
  if (declared.size === 0) return [...fallback];
  const out = [...declared];
  // A bundle stays a bundle whatever its options say.
  if (fallback.includes('bundle') && !out.includes('bundle')) out.push('bundle');
  return out;
}

/** True when the options disagree with each other — the "mixed" state. */
export function isMixed(saleTypes: readonly string[]): boolean {
  return saleTypes.includes('pre_order') && (saleTypes.includes('direct_sale') || saleTypes.includes('bundle'));
}

/**
 * The template's `selling_type` accepts `mixed` as an INPUT WORD. Nothing
 * stores it: it expands here into the pair of sale types it means, because the
 * column it would otherwise live in is pinned by a CHECK constraint written in
 * 0001 and widening that means rebuilding the products table for a synonym.
 */
export function expandSellingType(raw: unknown): string[] | null {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'mixed') return ['direct_sale', 'pre_order'];
  return null;
}

/** A stable key from a label, for grouping A1 against A1 Combo. */
export function variantKeyFrom(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9؀-ۿ]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * LAST RESORT ONLY: read a model out of a name like "A1 - Pre-order".
 *
 * The owner asked for this explicitly as a fallback and explicitly NOT as the
 * mechanism. It exists so that options written before `variant_key` existed
 * still group into a sensible two-step chooser instead of showing four flat
 * cards; anything written since carries its key as data and never reaches
 * this function.
 */
const SUFFIXES = [
  /\s*[-–—]\s*(pre[\s-]?order|طلب\s*مسبق)\s*$/i,
  /\s*[-–—]\s*(direct(\s*sale)?|بيع\s*مباشر)\s*$/i,
  /\s*\((pre[\s-]?order|direct(\s*sale)?|طلب\s*مسبق|بيع\s*مباشر)\)\s*$/i,
];

export function variantLabelFallback(name: string): string {
  let out = name.trim();
  for (const re of SUFFIXES) out = out.replace(re, '').trim();
  return out || name.trim();
}

/** The availability a legacy name implies, when it names one at all. */
export function availabilityFromName(name: string): AvailabilityType {
  if (/pre[\s-]?order|طلب\s*مسبق/i.test(name)) return 'pre_order';
  if (/direct(\s*sale)?|بيع\s*مباشر/i.test(name)) return 'direct_sale';
  return '';
}

export interface LeadTime {
  text: string;
  min_days: number | null;
  max_days: number | null;
}

export const EMPTY_LEAD_TIME: LeadTime = { text: '', min_days: null, max_days: null };

/**
 * A lead time the customer can read, whatever the admin gave.
 *
 * The text wins when there is one: an owner who wrote "بعد العيد" means that,
 * and turning it into "14–21 days" because two numbers happened to be filled
 * in would be the software overruling the person. The numbers are for
 * sorting, filtering and an estimated date — never for overwriting prose.
 */
export function leadTimeLabel(lt: LeadTime, lang: 'ar' | 'en' | 'ckb'): string {
  if (lt.text.trim()) return lt.text.trim();
  const { min_days: min, max_days: max } = lt;
  if (min === null && max === null) return '';
  const unit = lang === 'en' ? 'days' : lang === 'ckb' ? 'ڕۆژ' : 'يوم';
  if (min !== null && max !== null) return min === max ? `${min} ${unit}` : `${min}–${max} ${unit}`;
  const n = (min ?? max) as number;
  return lang === 'en' ? `about ${n} ${unit}` : lang === 'ckb' ? `نزیکەی ${n} ${unit}` : `حوالي ${n} ${unit}`;
}
