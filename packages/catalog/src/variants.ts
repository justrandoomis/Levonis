/**
 * THE VARIANT MODEL OF A COMMUNITY PRODUCT — option groups, their values, and
 * the variants (one per combination the merchant sells).
 *
 *   group    «المقاس», «اللون» — at most 3 per product; a `color` group draws
 *            swatches from the platform palette (./palette.ts).
 *   value    «صغير», «أحمر» — at most 30 per group (the old `colors` list held
 *            up to 30), unique by name inside its group.
 *   variant  ONE value from EACH group — its own stock, SKU, active switch,
 *            optional price override and compare-at price, optional picture
 *            and low-stock threshold. At most 100 per product; two variants
 *            may never name the same combination.
 *
 * `normalizeVariantModel` is the gate. The Worker runs it on every write and is
 * the only authority on what is stored (docs/MERCHANT_PLATFORM.md §2 decision
 * 8: pricing and stock are the server's); the editor runs the same function to
 * say what is wrong before a request is made. Nothing here reads a database:
 * whether an existing id really belongs to the product is the Worker's check.
 *
 * REFERENCES. The editor names a value by `ref`: its stored id when it has one,
 * or any temporary string for a value it just created. A variant lists the
 * refs of its values in GROUP ORDER. The Worker maps refs to ids.
 *
 * MONEY IS WHOLE DINARS. A price override of `null` means "the product's own
 * price"; 0 is a real (free) price and is kept. The compare-at price is shown
 * struck through only when it is above the price the customer pays.
 */

export const MAX_GROUPS = 3;
export const MAX_VALUES_PER_GROUP = 30;
export const MAX_VARIANTS = 100;
export const MAX_NAME = 60;
export const MAX_SKU = 64;
export const MAX_PRICE_IQD = 1_000_000_000;
export const MAX_STOCK = 1_000_000;

export type GroupKind = 'choice' | 'color';

export interface ValueInput {
  ref: string;
  name: string;
  name_ar: string;
  swatch: string;
}

export interface GroupInput {
  ref: string;
  name: string;
  name_ar: string;
  kind: GroupKind;
  values: ValueInput[];
}

export interface VariantInput {
  /** Value refs, one per group, in group order. */
  values: string[];
  price_iqd: number | null;
  compare_at_iqd: number | null;
  stock: number;
  sku: string;
  active: boolean;
  image_key: string | null;
  low_stock_threshold: number | null;
}

export interface VariantModel {
  groups: GroupInput[];
  variants: VariantInput[];
}

export type VariantErrorCode =
  | 'VARIANT_MODEL_INVALID'
  | 'OPTION_GROUPS_TOO_MANY'
  | 'OPTION_NAME_INVALID'
  | 'OPTION_NAME_DUPLICATE'
  | 'OPTION_VALUES_EMPTY'
  | 'OPTION_VALUES_TOO_MANY'
  | 'OPTION_VALUE_INVALID'
  | 'OPTION_VALUE_DUPLICATE'
  | 'VARIANTS_EMPTY'
  | 'VARIANTS_TOO_MANY'
  | 'VARIANT_VALUES_INVALID'
  | 'VARIANT_DUPLICATE'
  | 'VARIANT_PRICE_INVALID'
  | 'VARIANT_STOCK_INVALID'
  | 'VARIANT_SKU_INVALID'
  | 'VARIANT_THRESHOLD_INVALID';

export interface VariantError {
  code: VariantErrorCode;
  /** Where: `groups.1.values.3`, `variants.7.price_iqd`. */
  path: string;
}

const REF = /^[A-Za-z0-9_:-]{1,64}$/;

/** Controls, bidi overrides and zero-width marks removed; whitespace collapsed. */
export function cleanName(raw: unknown, max = MAX_NAME): string {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
  return s.length > max ? '' : s;
}

const fold = (s: string) => s.toLocaleLowerCase('en-US');

/** A whole number in [min, max], or undefined when it is not one. */
function whole(v: unknown, min: number, max: number): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}

/** The variant's combination as one string: value refs (or ids) in group order. */
export function comboKey(valueRefs: readonly string[]): string {
  return valueRefs.join('|');
}

/**
 * The model as it may be stored, or every reason it may not.
 * An empty model (no groups, no variants) is valid: a simple product.
 */
export function normalizeVariantModel(input: unknown): { ok: true; model: VariantModel } | { ok: false; errors: VariantError[] } {
  const errors: VariantError[] = [];
  const src = input && typeof input === 'object' ? (input as Record<string, unknown>) : null;
  if (!src || !Array.isArray(src.groups ?? []) || !Array.isArray(src.variants ?? [])) {
    return { ok: false, errors: [{ code: 'VARIANT_MODEL_INVALID', path: '' }] };
  }
  const rawGroups = (src.groups ?? []) as unknown[];
  const rawVariants = (src.variants ?? []) as unknown[];
  if (rawGroups.length > MAX_GROUPS) errors.push({ code: 'OPTION_GROUPS_TOO_MANY', path: 'groups' });

  const groups: GroupInput[] = [];
  const groupNames = new Set<string>();
  const valueGroup = new Map<string, number>();
  rawGroups.slice(0, MAX_GROUPS).forEach((g, gi) => {
    const o = g && typeof g === 'object' ? (g as Record<string, unknown>) : {};
    const path = `groups.${gi}`;
    const ref = typeof o.ref === 'string' && REF.test(o.ref) ? o.ref : '';
    const name = cleanName(o.name);
    const nameAr = cleanName(o.name_ar ?? '');
    if (!ref || !name || (typeof o.name_ar === 'string' && o.name_ar.trim() && !nameAr)) {
      errors.push({ code: 'OPTION_NAME_INVALID', path });
    } else if (groupNames.has(fold(name))) {
      errors.push({ code: 'OPTION_NAME_DUPLICATE', path });
    }
    groupNames.add(fold(name));
    const kind: GroupKind = o.kind === 'color' ? 'color' : 'choice';
    const rawValues = Array.isArray(o.values) ? o.values : [];
    if (!rawValues.length) errors.push({ code: 'OPTION_VALUES_EMPTY', path: `${path}.values` });
    if (rawValues.length > MAX_VALUES_PER_GROUP) errors.push({ code: 'OPTION_VALUES_TOO_MANY', path: `${path}.values` });
    const seen = new Set<string>();
    const values: ValueInput[] = [];
    rawValues.slice(0, MAX_VALUES_PER_GROUP).forEach((v, vi) => {
      const vo = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
      const vpath = `${path}.values.${vi}`;
      const vref = typeof vo.ref === 'string' && REF.test(vo.ref) ? vo.ref : '';
      const vname = cleanName(vo.name);
      const vnameAr = cleanName(vo.name_ar ?? '');
      const swatch = typeof vo.swatch === 'string' ? vo.swatch : '';
      if (!vref || !vname || valueGroup.has(vref) || (typeof vo.name_ar === 'string' && vo.name_ar.trim() && !vnameAr)) {
        errors.push({ code: 'OPTION_VALUE_INVALID', path: vpath });
        return;
      }
      if (seen.has(fold(vname))) {
        errors.push({ code: 'OPTION_VALUE_DUPLICATE', path: vpath });
        return;
      }
      seen.add(fold(vname));
      valueGroup.set(vref, gi);
      values.push({ ref: vref, name: vname, name_ar: vnameAr, swatch });
    });
    groups.push({ ref, name, name_ar: nameAr, kind, values });
  });

  if (groups.length && !rawVariants.length) errors.push({ code: 'VARIANTS_EMPTY', path: 'variants' });
  if (!groups.length && rawVariants.length) errors.push({ code: 'VARIANT_VALUES_INVALID', path: 'variants' });
  if (rawVariants.length > MAX_VARIANTS) errors.push({ code: 'VARIANTS_TOO_MANY', path: 'variants' });

  const variants: VariantInput[] = [];
  const combos = new Set<string>();
  rawVariants.slice(0, MAX_VARIANTS).forEach((v, i) => {
    const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
    const path = `variants.${i}`;
    const refs = Array.isArray(o.values) ? o.values.map((x) => (typeof x === 'string' ? x : '')) : [];
    // Exactly one value of each group, in group order.
    const shapeOk = refs.length === groups.length && refs.every((r, gi) => valueGroup.get(r) === gi);
    if (!shapeOk) {
      errors.push({ code: 'VARIANT_VALUES_INVALID', path: `${path}.values` });
      return;
    }
    const key = comboKey(refs);
    if (combos.has(key)) {
      errors.push({ code: 'VARIANT_DUPLICATE', path });
      return;
    }
    combos.add(key);
    const price = o.price_iqd === null || o.price_iqd === undefined || o.price_iqd === '' ? null : whole(o.price_iqd, 0, MAX_PRICE_IQD);
    const compare = o.compare_at_iqd === null || o.compare_at_iqd === undefined || o.compare_at_iqd === '' ? null : whole(o.compare_at_iqd, 0, MAX_PRICE_IQD);
    const stock = o.stock === undefined || o.stock === null || o.stock === '' ? 0 : whole(o.stock, 0, MAX_STOCK);
    const threshold = o.low_stock_threshold === null || o.low_stock_threshold === undefined || o.low_stock_threshold === ''
      ? null
      : whole(o.low_stock_threshold, 0, MAX_STOCK);
    const skuRaw = o.sku === undefined || o.sku === null ? '' : o.sku;
    const sku = typeof skuRaw === 'string' && skuRaw.trim().length <= MAX_SKU ? cleanName(skuRaw, MAX_SKU) : null;
    if (price === undefined) errors.push({ code: 'VARIANT_PRICE_INVALID', path: `${path}.price_iqd` });
    if (compare === undefined) errors.push({ code: 'VARIANT_PRICE_INVALID', path: `${path}.compare_at_iqd` });
    if (stock === undefined) errors.push({ code: 'VARIANT_STOCK_INVALID', path: `${path}.stock` });
    if (threshold === undefined) errors.push({ code: 'VARIANT_THRESHOLD_INVALID', path: `${path}.low_stock_threshold` });
    if (sku === null) errors.push({ code: 'VARIANT_SKU_INVALID', path: `${path}.sku` });
    variants.push({
      values: refs,
      price_iqd: price ?? null,
      compare_at_iqd: compare ?? null,
      stock: stock ?? 0,
      sku: sku ?? '',
      active: o.active !== false,
      image_key: typeof o.image_key === 'string' && o.image_key ? o.image_key : null,
      low_stock_threshold: threshold ?? null,
    });
  });

  return errors.length ? { ok: false, errors } : { ok: true, model: { groups, variants } };
}

/** Every combination of the groups' values, in group order — what «أنشئ كل التركيبات» makes. */
export function allCombinations(groups: ReadonlyArray<{ values: ReadonlyArray<{ ref: string }> }>): string[][] {
  if (!groups.length) return [];
  let out: string[][] = [[]];
  for (const g of groups) {
    const next: string[][] = [];
    for (const prefix of out) for (const v of g.values) next.push([...prefix, v.ref]);
    out = next;
  }
  return out;
}

// ------------------------------------------------------------- storefront

/** A variant as the public product page receives it: availability, never the count. */
export interface PublicVariant {
  id: string;
  /** Value ids, one per group, in group order. */
  value_ids: string[];
  /** What the customer pays: the override, or the product's price. */
  price_iqd: number;
  compare_at_iqd: number | null;
  in_stock: boolean;
  /** `/files/<key>` of the variant's own picture, or null. */
  image: string | null;
}

export interface PublicGroup {
  id: string;
  name: string;
  name_ar: string;
  kind: GroupKind;
  values: Array<{ id: string; name: string; name_ar: string; swatch: string }>;
}

/** The variant whose values are exactly the selection, if the merchant sells it. */
export function findVariant<V extends { value_ids: string[] }>(
  groups: ReadonlyArray<{ id: string }>,
  variants: readonly V[],
  selection: Readonly<Record<string, string>>
): V | null {
  if (!groups.length) return null;
  const want = groups.map((g) => selection[g.id] ?? '');
  if (want.some((x) => !x)) return null;
  return variants.find((v) => v.value_ids.length === want.length && v.value_ids.every((id, i) => id === want[i])) ?? null;
}

export type ValueState = 'available' | 'sold_out' | 'unavailable';

/**
 * Whether choosing `valueId` in group `groupIndex`, with the OTHER groups as
 * currently selected (unselected groups match anything), leads to a variant
 * that is sold at all ('unavailable' when none is) and one that is in stock.
 */
export function valueState<V extends { value_ids: string[]; in_stock: boolean }>(
  groups: ReadonlyArray<{ id: string }>,
  variants: readonly V[],
  selection: Readonly<Record<string, string>>,
  groupIndex: number,
  valueId: string
): ValueState {
  let exists = false;
  for (const v of variants) {
    if (v.value_ids[groupIndex] !== valueId) continue;
    const matches = groups.every((g, i) => i === groupIndex || !selection[g.id] || v.value_ids[i] === selection[g.id]);
    if (!matches) continue;
    exists = true;
    if (v.in_stock) return 'available';
  }
  return exists ? 'sold_out' : 'unavailable';
}

/** The lowest and highest price a customer can pay, across variants (or the product). */
export function priceRange(basePrice: number, variants: ReadonlyArray<{ price_iqd: number }>): { min: number; max: number } {
  if (!variants.length) return { min: basePrice, max: basePrice };
  let min = Infinity;
  let max = -Infinity;
  for (const v of variants) {
    if (v.price_iqd < min) min = v.price_iqd;
    if (v.price_iqd > max) max = v.price_iqd;
  }
  return { min, max };
}

/**
 * The first selection to show: the first in-stock variant's values, else the
 * first variant's — so the page never opens on a combination nobody sells.
 */
export function initialSelection<V extends { value_ids: string[]; in_stock: boolean }>(
  groups: ReadonlyArray<{ id: string }>,
  variants: readonly V[]
): Record<string, string> {
  const pick = variants.find((v) => v.in_stock) ?? variants[0];
  const out: Record<string, string> = {};
  if (!pick) return out;
  groups.forEach((g, i) => {
    if (pick.value_ids[i]) out[g.id] = pick.value_ids[i];
  });
  return out;
}
