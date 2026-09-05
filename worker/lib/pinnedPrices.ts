/**
 * PINNED PRICES — the rows that do not follow the product's base price.
 *
 * THE PROBLEM THIS EXISTS FOR. An option, a colour or a variant may carry its
 * own regular_price_iqd, and worker/lib/pricing.ts treats that as a REPLACEMENT
 * for the product's base price at that rung (the per-field ladder is variant
 * -> colour -> option -> product; the difference the rung makes is a surcharge
 * every tier pays, see memberAtRung there). A fixed number is a pin: it does
 * not follow the base — which is right for a shop where "Large" is not always
 * "base plus a fixed amount", and the reason this module exists.
 *
 * What it is NOT is obvious to the owner. They open the product, change السعر
 * from 200,000 to 350,000, save, and the storefront headline changes while a
 * customer who picked "Small" is still charged 200,000 — because the option
 * row still says 200,000 and the option row wins. Nothing told them, and the
 * cart is not at fault: it re-prices on every read, and the number it reads
 * is simply the old one.
 *
 * So this module does one thing: it names those rows and computes what they
 * would become, so the admin can be ASKED. It never decides on its own. A
 * price the owner typed on purpose is not something to rewrite behind their
 * back, and "Large costs 60,000 more" and "Large costs 300,000" are different
 * intentions that only they can tell apart.
 */

/** One row that carries its own price, whatever level it sits at. */
export interface PinnedPriceRow {
  kind: 'option' | 'color' | 'variant';
  id: string;
  /** What the owner will recognise in the dialog: the option or colour name. */
  label: string;
  regular_price_iqd: number | null;
  prime_price_iqd: number | null;
  pro_price_iqd: number | null;
}

interface PriceBearing {
  id: string;
  name_en?: string | null;
  name_ar?: string | null;
  label?: string | null;
  active?: boolean;
  regular_price_iqd?: number | null;
  prime_price_iqd?: number | null;
  pro_price_iqd?: number | null;
}

const named = (x: PriceBearing): string =>
  String(x.label || x.name_en || x.name_ar || x.id || '').trim() || x.id;

const isPinned = (x: PriceBearing): boolean =>
  typeof x.regular_price_iqd === 'number' ||
  typeof x.prime_price_iqd === 'number' ||
  typeof x.pro_price_iqd === 'number';

/**
 * Every row that would ignore a change to the base price.
 *
 * INACTIVE ROWS COUNT. A deactivated option is one click from being sold
 * again, and reactivating it months later at a price from before two rounds
 * of increases is exactly the failure this whole module is about.
 */
export function pinnedRows(input: {
  options?: PriceBearing[] | null;
  colors?: PriceBearing[] | null;
  variants?: PriceBearing[] | null;
}): PinnedPriceRow[] {
  const out: PinnedPriceRow[] = [];
  const take = (rows: PriceBearing[] | null | undefined, kind: PinnedPriceRow['kind']) => {
    for (const r of rows ?? []) {
      if (!r || typeof r !== 'object' || !isPinned(r)) continue;
      out.push({
        kind,
        id: String(r.id),
        label: named(r),
        regular_price_iqd: typeof r.regular_price_iqd === 'number' ? r.regular_price_iqd : null,
        prime_price_iqd: typeof r.prime_price_iqd === 'number' ? r.prime_price_iqd : null,
        pro_price_iqd: typeof r.pro_price_iqd === 'number' ? r.pro_price_iqd : null,
      });
    }
  };
  take(input.options, 'option');
  take(input.colors, 'color');
  take(input.variants, 'variant');
  return out;
}

/**
 * `delta`   — every pinned price moves by the same number of dinars as the
 *             base did. "Large was 60,000 above the base and still is."
 * `percent` — every pinned price keeps its ratio to the base. "Everything
 *             went up by a fifth."
 * `inherit` — the pinned prices are cleared, so the rows follow the base from
 *             now on. The strongest option, and the one that makes the next
 *             price change work the way the owner expected this one to.
 */
export type RepriceMode = 'delta' | 'percent' | 'inherit';

/** One price after the move, or null when the row is being set to inherit. */
export function repriceOne(
  current: number | null,
  mode: RepriceMode,
  oldBase: number,
  newBase: number
): number | null {
  if (mode === 'inherit') return null;
  if (current === null) return null;
  if (mode === 'delta') return Math.max(0, current + (newBase - oldBase));
  // A percentage move is meaningless against a base of zero — there is no
  // ratio to preserve — so the row is left exactly as the owner set it.
  if (oldBase <= 0) return current;
  return Math.max(0, Math.round((current * newBase) / oldBase));
}

/**
 * The whole row after the move, with the ladder kept intact.
 *
 * pro <= prime <= regular is a write-time rule elsewhere in the product
 * model, and rounding a percentage move can put a member price one dinar
 * above the regular one. Clamping here means the admin never has to see a
 * validation error for arithmetic they did not do by hand.
 */
export function repriceRow(row: PinnedPriceRow, mode: RepriceMode, oldBase: number, newBase: number): PinnedPriceRow {
  const regular = repriceOne(row.regular_price_iqd, mode, oldBase, newBase);
  let prime = repriceOne(row.prime_price_iqd, mode, oldBase, newBase);
  let pro = repriceOne(row.pro_price_iqd, mode, oldBase, newBase);
  const ceiling = regular ?? newBase;
  if (pro !== null) pro = Math.min(pro, ceiling);
  if (prime !== null) {
    prime = Math.min(prime, ceiling);
    if (pro !== null) prime = Math.max(prime, pro);
  }
  return { ...row, regular_price_iqd: regular, prime_price_iqd: prime, pro_price_iqd: pro };
}

/** What the owner is shown before choosing: the rows, and where each lands. */
export interface RepricePreview {
  mode: RepriceMode;
  rows: Array<{ id: string; kind: PinnedPriceRow['kind']; label: string; from: number | null; to: number | null }>;
}

export function repricePreview(
  rows: PinnedPriceRow[],
  mode: RepriceMode,
  oldBase: number,
  newBase: number
): RepricePreview {
  return {
    mode,
    rows: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      label: r.label,
      from: r.regular_price_iqd,
      to: repriceRow(r, mode, oldBase, newBase).regular_price_iqd,
    })),
  };
}

/**
 * The prices a customer can actually be charged, given the base and the rows
 * that replace it. Used to show the owner the real range beside the base
 * field, because the base alone stopped being the answer the moment one
 * option carried its own number.
 *
 * The base itself is included ONLY when it is reachable: with no options at
 * all, or when a customer may add the product without choosing one — which
 * is exactly what the cart allows today.
 */
export function payableRange(input: {
  base_price_iqd: number | null;
  options?: PriceBearing[] | null;
  colors?: PriceBearing[] | null;
  variants?: PriceBearing[] | null;
  /** false when the storefront forces a choice before adding to the cart */
  baseSelectable?: boolean;
}): { min: number; max: number; levels: number } | null {
  const base = typeof input.base_price_iqd === 'number' ? input.base_price_iqd : null;
  const prices: number[] = [];
  const live = (rows: PriceBearing[] | null | undefined) =>
    (rows ?? []).filter((r) => r && typeof r === 'object' && r.active !== false);
  for (const r of [...live(input.options), ...live(input.colors), ...live(input.variants)]) {
    prices.push(typeof r.regular_price_iqd === 'number' ? r.regular_price_iqd : base ?? 0);
  }
  if (input.baseSelectable !== false && base !== null) prices.push(base);
  if (!prices.length) return base === null ? null : { min: base, max: base, levels: 1 };
  return { min: Math.min(...prices), max: Math.max(...prices), levels: prices.length };
}
