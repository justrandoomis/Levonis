/**
 * CATALOG DISCOVERY — THE ONE GRAMMAR FOR LISTING FILTERS AND FINDER ANSWERS
 * (docs/ux/CATALOG_DISCOVERY.md §7, §8, §11; docs/ux/IMPLEMENTATION_PLAN.md S0).
 *
 * WHY THIS LIVES IN A PACKAGE. The storefront writes these values into a URL
 * (`/categories/printers/fdm-printers?sort=price_asc&avail=1…`,
 * `/printer-finder?use=business&tech=fdm…`) and the Worker reads the same values
 * back out of `/api/products` and `/api/printer-finder`. Two parsers would start
 * agreeing and end disagreeing — a filter the page shows as applied and the
 * server silently ignores. So both sides import this file: the SPA through
 * `src/lib/catalog/listingQuery.ts` and `src/lib/finder/answers.ts`, the Worker
 * through `@levonis/catalog/discovery`.
 *
 * THE RULES, stated once:
 *   - An unknown value is DROPPED, never thrown and never coerced. A hand-edited
 *     link with `sort=cheapest` lists in the default order; it does not 400 and
 *     it does not guess «price_asc».
 *   - Every list is bounded (brands, facet values, priorities) and every token is
 *     shape-checked, so a URL cannot smuggle a thousand values into one query.
 *   - The default state serialises to NOTHING. Keys come out in one fixed order
 *     and values in a canonical order, so two equal states are the same string
 *     (a cache key, a shared link, a `replaceState` that does not churn).
 *
 * Pure: no I/O, no DOM, no Cloudflare bindings.
 */

// ------------------------------------------------------------------ listing

/** «الترتيب». `relevance` is the default: search rank with `q`, otherwise
 *  available-now first, then the merchandiser's shelf order. */
export const LISTING_SORTS = ['relevance', 'newest', 'price_asc', 'price_desc', 'name', 'available', 'direct'] as const;
export type ListingSort = (typeof LISTING_SORTS)[number];

export const SALE_FILTERS = ['direct', 'preorder'] as const;
export type SaleFilter = (typeof SALE_FILTERS)[number];

/**
 * The spec fields a listing may filter on, and the short key each one uses in a
 * PAGE url. The API uses `f.<field_id>` so the server never has to know the page
 * vocabulary; the page uses the short key because it is the link people share.
 * A field that is not in this list cannot be filtered on at all (whitelist).
 */
export const FACET_FIELDS = {
  technology: 'tech',
  max_colors: 'colors',
  build_volume: 'size',
  enclosed: 'enclosed',
  skill_level: 'level',
  material_type: 'material',
  diameter: 'diameter',
  color_name: 'color',
} as const;
export type FacetField = keyof typeof FACET_FIELDS;
export const FACET_FIELD_IDS = Object.keys(FACET_FIELDS) as FacetField[];

/** «حجم الطباعة» on the LONGEST axis, in mm. Contiguous on purpose: the design's
 *  «≤ 180 · 256–270 · ≥ 300» left gaps a real machine can fall into, and a
 *  machine that matches no bucket would silently vanish from every size filter. */
export const SIZE_BUCKETS = {
  compact: { min: 0, max: 200 },
  standard: { min: 200.0001, max: 299.9999 },
  large: { min: 300, max: Number.POSITIVE_INFINITY },
} as const;
export type SizeBucket = keyof typeof SIZE_BUCKETS;

export const SKILL_LEVELS = ['beginner', 'intermediate', 'advanced', 'professional'] as const;
export const TECH_FACETS = ['fdm', 'resin'] as const;

export const MAX_BRANDS = 10;
export const MAX_FACET_VALUES = 8;
export const MAX_QUERY_LENGTH = 100;
/** The price range a filter may state, in IQD. */
export const MAX_PRICE_IQD = 1_000_000_000;

export interface PriceRange {
  /** Inclusive lower bound, or null for "no lower bound". */
  min: number | null;
  /** Inclusive upper bound, or null for "no upper bound". */
  max: number | null;
}

export interface ListingFilters {
  /** «المتوفر الآن فقط»: direct-sale units available now. */
  avail: boolean;
  sale: SaleFilter | null;
  price: PriceRange | null;
  /** Brand SLUGS, canonical order (sorted). */
  brands: string[];
  /** «عليها عرض»: a SALE price or a live/upcoming scheduled offer. */
  offer: boolean;
  /** «سعر أقل للأعضاء»: a PRIME or PRO rung below what the viewer pays. */
  member: boolean;
  /** Spec facets, each a set of canonical tokens (sorted). */
  specs: Partial<Record<FacetField, string[]>>;
}

export interface ListingState extends ListingFilters {
  /** Scoped search text. */
  q: string;
  sort: ListingSort;
}

export const DEFAULT_LISTING: ListingState = Object.freeze({
  q: '',
  sort: 'relevance',
  avail: false,
  sale: null,
  price: null,
  brands: [],
  offer: false,
  member: false,
  specs: {},
}) as ListingState;

const oneOf = <T extends string>(list: readonly T[], v: string | null | undefined): T | null =>
  v != null && (list as readonly string[]).includes(v) ? (v as T) : null;

const flag = (v: string | null | undefined): boolean => v === '1';

/** `1500000-2500000`, `500000-`, `-750000`. Integers only; min ≤ max or dropped. */
export function parsePriceRange(raw: string | null | undefined): PriceRange | null {
  const m = /^(\d{0,10})-(\d{0,10})$/.exec(String(raw ?? '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  const min = m[1] === '' ? null : Number(m[1]);
  const max = m[2] === '' ? null : Number(m[2]);
  if (min !== null && (!Number.isSafeInteger(min) || min > MAX_PRICE_IQD)) return null;
  if (max !== null && (!Number.isSafeInteger(max) || max > MAX_PRICE_IQD)) return null;
  if (min !== null && max !== null && min > max) return null;
  return { min, max };
}

export const formatPriceRange = (r: PriceRange): string => `${r.min ?? ''}-${r.max ?? ''}`;

/** A numeric range token for a counted facet (`16-20`, `24-`, `-4`, `16`). */
function numericRangeToken(t: string): string | null {
  const m = /^(\d{1,4}(?:\.\d{1,3})?)?(-)?(\d{1,4}(?:\.\d{1,3})?)?$/.exec(t);
  if (!m || (!m[1] && !m[3])) return null;
  if (!m[2]) return m[3] ? null : String(Number(m[1]));
  const lo = m[1] ? Number(m[1]) : null;
  const hi = m[3] ? Number(m[3]) : null;
  if (lo !== null && hi !== null && lo > hi) return null;
  return `${lo ?? ''}-${hi ?? ''}`;
}

/** Reads a numeric range token back; `16` is the range 16–16. */
export function readRangeToken(t: string): { min: number; max: number } | null {
  const token = numericRangeToken(t);
  if (token === null) return null;
  if (!token.includes('-')) return { min: Number(token), max: Number(token) };
  const [lo, hi] = token.split('-');
  return { min: lo === '' ? Number.NEGATIVE_INFINITY : Number(lo), max: hi === '' ? Number.POSITIVE_INFINITY : Number(hi) };
}

const FREE_TOKEN = /^[\p{L}\p{N}][\p{L}\p{N} .+_-]{0,39}$/u;

/** One facet value, canonicalised, or null when this field cannot hold it. */
export function facetToken(field: FacetField, raw: string): string | null {
  const t = raw.trim().toLowerCase();
  if (t === '') return null;
  switch (field) {
    case 'technology':
      return oneOf(TECH_FACETS, t);
    case 'skill_level':
      return oneOf(SKILL_LEVELS, t);
    case 'build_volume':
      return t in SIZE_BUCKETS ? t : null;
    case 'enclosed':
      return t === '1' || t === '0' ? t : null;
    case 'max_colors':
      return numericRangeToken(t);
    case 'diameter':
      return /^\d{1,2}(?:\.\d{1,3})?$/.test(t) ? String(Number(t)) : null;
    default:
      return FREE_TOKEN.test(t) ? t.replace(/\s+/g, ' ') : null;
  }
}

function tokenList(raw: string | null | undefined, max: number, read: (t: string) => string | null): string[] {
  if (!raw) return [];
  const out = new Set<string>();
  for (const piece of String(raw).split(',')) {
    const t = read(piece);
    if (t !== null) out.add(t);
    if (out.size >= max) break;
  }
  return [...out].sort();
}

const BRAND_SLUG = /^[a-z0-9][a-z0-9-]{0,59}$/;

export type ListingUrlMode = 'page' | 'api';

/** The key a spec facet travels under in each kind of URL. */
export const facetKey = (field: FacetField, mode: ListingUrlMode): string =>
  mode === 'api' ? `f.${field}` : FACET_FIELDS[field];

/**
 * A listing URL → state. `get` is `URLSearchParams.get` or a Hono query lookup.
 * `mode` picks the vocabulary: the page's short keys and `q`, or the API's
 * `f.<field>` keys and `search`.
 */
export function parseListingParams(get: (key: string) => string | null | undefined, mode: ListingUrlMode): ListingState {
  const q = String(get(mode === 'api' ? 'search' : 'q') ?? '').trim().slice(0, MAX_QUERY_LENGTH);
  const specs: Partial<Record<FacetField, string[]>> = {};
  for (const field of FACET_FIELD_IDS) {
    const values = tokenList(get(facetKey(field, mode)), MAX_FACET_VALUES, (t) => facetToken(field, t));
    if (values.length) specs[field] = values;
  }
  return {
    q,
    sort: oneOf(LISTING_SORTS, get('sort')) ?? 'relevance',
    avail: flag(get('avail')),
    sale: oneOf(SALE_FILTERS, get('sale')),
    price: parsePriceRange(get('price')),
    brands: tokenList(get('brand'), MAX_BRANDS, (t) => {
      const s = t.trim().toLowerCase();
      return BRAND_SLUG.test(s) ? s : null;
    }),
    offer: flag(get('offer')),
    member: flag(get('member')),
    specs,
  };
}

/** State → ordered key/value pairs. Defaults are omitted. */
export function listingParamPairs(state: ListingState, mode: ListingUrlMode): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (state.q.trim()) out.push([mode === 'api' ? 'search' : 'q', state.q.trim().slice(0, MAX_QUERY_LENGTH)]);
  if (state.sort !== 'relevance' && (LISTING_SORTS as readonly string[]).includes(state.sort)) out.push(['sort', state.sort]);
  if (state.avail) out.push(['avail', '1']);
  if (state.sale) out.push(['sale', state.sale]);
  if (state.price && (state.price.min !== null || state.price.max !== null)) out.push(['price', formatPriceRange(state.price)]);
  if (state.brands.length) out.push(['brand', [...new Set(state.brands)].sort().join(',')]);
  if (state.offer) out.push(['offer', '1']);
  if (state.member) out.push(['member', '1']);
  for (const field of FACET_FIELD_IDS) {
    const values = state.specs[field];
    if (values && values.length) out.push([facetKey(field, mode), [...new Set(values)].sort().join(',')]);
  }
  return out;
}

/**
 * Pairs → a query string WITHOUT `?`. Values are percent-encoded except the
 * comma, which is the list separator and reads as one in a shared link
 * («brand=bambu-lab,snapmaker», not «%2C»). `URLSearchParams` decodes both.
 */
export const encodePairs = (pairs: Array<[string, string]>): string =>
  pairs.map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/%2C/gi, ',')}`).join('&');

/** True when any filter (not the search text or the sort) is active. */
export function hasListingFilters(f: ListingFilters): boolean {
  return (
    f.avail || f.sale !== null || f.price !== null || f.brands.length > 0 || f.offer || f.member ||
    FACET_FIELD_IDS.some((k) => (f.specs[k]?.length ?? 0) > 0)
  );
}

/** How many filters a badge should count: one per facet with a selection. */
export function activeFilterCount(f: ListingFilters): number {
  return (
    Number(f.avail) + Number(f.sale !== null) + Number(f.price !== null) + Number(f.brands.length > 0) +
    Number(f.offer) + Number(f.member) + FACET_FIELD_IDS.filter((k) => (f.specs[k]?.length ?? 0) > 0).length
  );
}

// ------------------------------------------------------------------- finder

export const FINDER_USES = ['hobby', 'business', 'figures', 'functional', 'sell', 'multicolor', 'unsure'] as const;
export type FinderUse = (typeof FINDER_USES)[number];

export const FINDER_TECHS = ['any', 'fdm', 'resin', 'laser'] as const;
export type FinderTech = (typeof FINDER_TECHS)[number];

/** Owner answer Q5 (2026-09-25): the four ranges, in IQD, inclusive. */
export const FINDER_BUDGETS = {
  '0-750000': { min: 0, max: 750_000 },
  '750000-1250000': { min: 750_000, max: 1_250_000 },
  '1250000-2500000': { min: 1_250_000, max: 2_500_000 },
  '2500000-': { min: 2_500_000, max: null },
} as const;
export type FinderBudget = keyof typeof FINDER_BUDGETS | 'any';
export const FINDER_BUDGET_IDS = [...(Object.keys(FINDER_BUDGETS) as Array<keyof typeof FINDER_BUDGETS>), 'any'] as const;

export const FINDER_SALES = ['any', 'direct'] as const;
export type FinderSale = (typeof FINDER_SALES)[number];

export const FINDER_PRIORITIES = ['quality', 'speed', 'quiet', 'colors', 'ease', 'size'] as const;
export type FinderPriority = (typeof FINDER_PRIORITIES)[number];
export const MAX_FINDER_PRIORITIES = 2;

export const FINDER_LEVELS = ['beginner', 'intermediate', 'pro'] as const;
export type FinderLevel = (typeof FINDER_LEVELS)[number];

/**
 * The six answers. `null` = not answered yet. A SKIPPED step is an answer:
 * `tech: 'any'`, `budget: 'any'`, and `prio: []` (serialised `prio=none`) — so
 * a refresh after a skip does not ask the same question again.
 */
export interface FinderAnswers {
  use: FinderUse | null;
  tech: FinderTech | null;
  budget: FinderBudget | null;
  sale: FinderSale | null;
  /** Ordered, at most two, distinct. The first counts more. */
  prio: FinderPriority[] | null;
  level: FinderLevel | null;
}

export const EMPTY_FINDER: FinderAnswers = Object.freeze({
  use: null,
  tech: null,
  budget: null,
  sale: null,
  prio: null,
  level: null,
}) as FinderAnswers;

export const FINDER_KEYS = ['use', 'tech', 'budget', 'sale', 'prio', 'level'] as const;

export function parseFinderParams(get: (key: string) => string | null | undefined): FinderAnswers {
  const rawPrio = get('prio');
  let prio: FinderPriority[] | null = null;
  if (rawPrio === 'none') prio = [];
  else if (rawPrio) {
    const picked: FinderPriority[] = [];
    for (const piece of String(rawPrio).split(',')) {
      const p = oneOf(FINDER_PRIORITIES, piece.trim().toLowerCase());
      // ORDER IS THE ANSWER («بالترتيب»): the first valid, distinct two survive.
      if (p && !picked.includes(p)) picked.push(p);
      if (picked.length >= MAX_FINDER_PRIORITIES) break;
    }
    prio = picked.length ? picked : null;
  }
  return {
    use: oneOf(FINDER_USES, get('use')),
    tech: oneOf(FINDER_TECHS, get('tech')),
    budget: oneOf(FINDER_BUDGET_IDS as readonly string[], get('budget')) as FinderBudget | null,
    sale: oneOf(FINDER_SALES, get('sale')),
    prio,
    level: oneOf(FINDER_LEVELS, get('level')),
  };
}

export function finderParamPairs(a: FinderAnswers): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (a.use) out.push(['use', a.use]);
  if (a.tech) out.push(['tech', a.tech]);
  if (a.budget) out.push(['budget', a.budget]);
  if (a.sale) out.push(['sale', a.sale]);
  if (a.prio) out.push(['prio', a.prio.length ? a.prio.slice(0, MAX_FINDER_PRIORITIES).join(',') : 'none']);
  if (a.level) out.push(['level', a.level]);
  return out;
}

/** All six answered (skips included): the finder opens on its results. */
export const finderComplete = (a: FinderAnswers): boolean => FINDER_KEYS.every((k) => a[k] !== null);

/** The budget as an inclusive range, or null for «لا يهم». */
export function finderBudgetRange(b: FinderBudget | null): { min: number; max: number | null } | null {
  if (!b || b === 'any') return null;
  return FINDER_BUDGETS[b];
}
