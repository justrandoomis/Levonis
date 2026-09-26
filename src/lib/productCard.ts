/**
 * WHAT THE COMPACT PRODUCT CARD SAYS — the pure half of
 * `src/components/home/ProductCard.tsx` (docs/ux/CATALOG_DISCOVERY.md §4).
 *
 * The owner: «بطاقتان في الصف في الجوال … السعر بارزًا، حالة التوفر واضحة، اسم
 * المنتج line-clamp ومنسقًا بشكل أنيق … الأولوية بصريًا لمنتجات البيع المباشر
 * والمتوفرة». Every decision the card makes about WORDS lives here, with no
 * React and no I/O, so a test can pin it without rendering anything:
 *
 *  - the NAME it prints (the part before the first « / », owner default Q2);
 *  - the AVAILABILITY it states (three states, in words, never colour alone);
 *  - the ONE member line it may add under the price;
 *  - whether it may offer the compare toggle at all.
 *
 * Everything here reads fields the server already resolved. It never prices,
 * never guesses a tier, and never turns an absent field into a fact: a card
 * that was not told a product's sale types does not claim «طلب مسبق».
 */
import type { ApiProduct } from './api';

/**
 * Card fields the catalogue stream (S1) adds to `CARD_FIELDS`. They are
 * declared here as OPTIONAL so this card works — honestly — before and after
 * the server sends them; when S0 publishes them on `ApiProduct` the
 * intersection below is simply redundant.
 */
export interface CardExtras {
  /** The spec family the compare engine files this product under. */
  compare_type?: string | null;
  /** An admin-set short card title (owner question Q2; optional column). */
  card_name?: string | null;
  /** The shop's own low-stock threshold, when the card carries it. */
  low_stock_threshold?: number | null;
  /** Open box / used / refurbished — `CARD_FIELDS` carries it (see api.ts). */
  condition?: import('./condition').ConditionEntry | null;
}

export type CardProduct = ApiProduct & CardExtras;

// ------------------------------------------------------------------- name

/**
 * THE CARD NAME. Product names carry every option: «Bambu Lab H2D / H2D Combo
 * / Laser Full Combo 10W / Laser Full Combo 40W». On a 174 px card that is
 * four lines clipped to two mid-word. The owner's default (Q2): show the part
 * before the first « / » — on the CARD only; the product page, the cart, the
 * compare table and the link's `title` keep the full name.
 *
 * Only a SPACED slash splits: «PLA/PETG» or «0.4/0.6 mm» are one name.
 * An admin-set `card_name` wins when the server sends one.
 */
export function cardName(p: Pick<CardProduct, 'name'> & { card_name?: string | null }): string {
  const custom = typeof p.card_name === 'string' ? p.card_name.trim() : '';
  if (custom) return custom;
  const full = (p.name ?? '').trim();
  const cut = full.indexOf(' / ');
  if (cut > 0) {
    const head = full.slice(0, cut).trim();
    if (head) return head;
  }
  return full;
}

// ----------------------------------------------------------- availability

export type AvailabilityState = 'available' | 'preorder' | 'unavailable' | 'unknown';

export interface Availability {
  state: AvailabilityState;
  /** Direct-sale units the buyer can still take today; null when not stated. */
  qty: number | null;
  /** True when `qty` is at or under the low-stock threshold («بقي 2»). */
  low: boolean;
}

/** «بقي N» from here down when the shop has not set its own threshold. */
export const DEFAULT_LOW_STOCK = 2;

/**
 * THREE STATES, AND A FOURTH THAT DRAWS NOTHING.
 *
 *  available   — `direct_stock_available > 0`: units in the Iraq stock now.
 *  preorder    — no direct unit, and the product's sale types include
 *                pre-order.
 *  unavailable — no direct unit, and the sale types say pre-order is not
 *                offered either.
 *  unknown     — no direct unit and the card was not told the sale types
 *                (a card projection that predates `sale_types`). The card
 *                says nothing rather than guess «طلب مسبق».
 */
export function cardAvailability(
  p: Pick<CardProduct, 'direct_stock_available' | 'sale_types' | 'low_stock_threshold'> & { selling_type?: string }
): Availability {
  const n = p.direct_stock_available;
  if (typeof n === 'number' && Number.isInteger(n) && n > 0) {
    const t = p.low_stock_threshold;
    const threshold = typeof t === 'number' && Number.isInteger(t) && t >= 0 ? t : DEFAULT_LOW_STOCK;
    return { state: 'available', qty: n, low: n <= threshold };
  }
  const types = Array.isArray(p.sale_types) ? p.sale_types : null;
  if (types) {
    return { state: types.includes('pre_order') ? 'preorder' : 'unavailable', qty: null, low: false };
  }
  // `selling_type` is the legacy single-mode field; the detail payload carries
  // it and a few older call sites pass a full product to the card.
  if (p.selling_type === 'pre_order') return { state: 'preorder', qty: null, low: false };
  return { state: 'unknown', qty: null, low: false };
}

// ------------------------------------------------------------ member line

export type MemberTier = 'PRIME' | 'PRO';

/**
 * THE ONE MEMBER LINE (§4.1). The regular card printed PRIME and PRO both;
 * the compact card prints at most one: the CHEAPEST member rung that is below
 * what this viewer pays now. A PRO viewer sees none (nothing is cheaper than
 * their own rung), a PRIME viewer sees PRO only when PRO is genuinely cheaper.
 * Which rung the viewer is on is the server's `display_applied_tier`.
 */
export function memberLine(
  p: Pick<ApiProduct, 'display_price_iqd' | 'price_iqd' | 'display_applied_tier' | 'display_prime_iqd' | 'display_pro_iqd'>
): { tier: MemberTier; price: number } | null {
  const main = p.display_price_iqd ?? p.price_iqd;
  const applied = p.display_applied_tier ?? 'regular';
  if (applied === 'pro') return null;
  const rungs: Array<{ tier: MemberTier; price: number }> = [];
  if (applied !== 'prime' && typeof p.display_prime_iqd === 'number') rungs.push({ tier: 'PRIME', price: p.display_prime_iqd });
  if (typeof p.display_pro_iqd === 'number') rungs.push({ tier: 'PRO', price: p.display_pro_iqd });
  let best: { tier: MemberTier; price: number } | null = null;
  for (const r of rungs) {
    if (!(r.price < main)) continue;
    // A tie goes to the lower rung: PRIME is the cheaper membership to reach.
    if (!best || r.price < best.price) best = r;
  }
  return best;
}

// ---------------------------------------------------------------- compare

/** The types the compare page can line up side by side (§4.1). */
export const COMPARABLE_TYPES = ['printer', 'laser', 'filament'] as const;

/** The card's compare type, or null when it is not one the page compares. */
export function compareTypeOf(p: CardExtras & { product_slug?: string }): string | null {
  // A composition (bundle, mystery) is never a column on the compare page.
  if (p.product_slug) return null;
  const t = typeof p.compare_type === 'string' ? p.compare_type : '';
  return (COMPARABLE_TYPES as readonly string[]).includes(t) ? t : null;
}

// ------------------------------------------------------------------ money

/**
 * «1,575,000 د.ع» → ['1,575,000', 'د.ع'], so the card can draw the amount at
 * 15 px and the unit at 10.5 px. Anything else (a USD reading, «$1,050.00»)
 * comes back whole with no unit.
 */
export function splitMoney(text: string): [string, string] {
  const m = /^(.*[\d\u0660-\u0669\u06F0-\u06F9])\s+(د\.ع|IQD)$/.exec(text);
  return m ? [m[1], m[2]] : [text, ''];
}

/**
 * THE CARD'S DESTINATION. A composition row links to where it can be bought
 * (§10, `/bundles/<slug>`); everything else to its product page.
 */
export function cardHref(p: Pick<ApiProduct, 'slug' | 'id' | 'product_slug'>): string {
  return p.product_slug ? `/bundles/${p.product_slug}` : `/product/${p.slug || p.id}`;
}

/**
 * «الأولوية بصريًا لمنتجات البيع المباشر والمتوفرة» — a STABLE partition:
 * products with direct units now first, in their incoming order, then the
 * rest in theirs. Returns the index where the second group starts (the
 * «بطلب مسبق» divider), or -1 when either group is empty.
 */
export function availableFirst<T extends Pick<ApiProduct, 'direct_stock_available'>>(list: T[]): { items: T[]; splitAt: number } {
  const now: T[] = [];
  const later: T[] = [];
  for (const p of list) {
    const n = p.direct_stock_available;
    (typeof n === 'number' && n > 0 ? now : later).push(p);
  }
  return { items: [...now, ...later], splitAt: now.length && later.length ? now.length : -1 };
}
