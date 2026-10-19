/**
 * THE SPECIALISED LISTING — FILTER, SORT AND DISJUNCTIVE FACET COUNTS, IN MEMORY
 * (docs/ux/CATALOG_DISCOVERY.md §7, §11; IMPLEMENTATION_PLAN.md S1).
 *
 * WHY IN MEMORY AND NOT IN SQL. Every filter a shopper cares about most is on a
 * number the database does not hold: the price is the VIEWER'S resolved price
 * (a PRO sees a different order under «السعر: من الأقل» than a guest), the
 * availability is the direct-sale count proved over the option graph, and the
 * spec facets are free text read by the compare engine's own parsers. So the
 * route narrows in SQL by what SQL can answer (section, search, and — when no
 * counts are asked for — brand and «يناسب طابعة»), reads every candidate's KEYS,
 * resolves through the one pricing path only what an order, a filter or a count
 * must see priced (the sellable candidates, up to a cap; a catalog-only one is
 * exact from its keys), and hands the whole set here — so a listing pages to
 * its last product (worker/routes/products.ts `pagedListing`), and `truncated`
 * says when the cap left sellable candidates unpriced.
 *
 * DISJUNCTIVE COUNTS. A facet's counts are computed with every OTHER active
 * filter applied and its own ignored, so a shopper who ticked «Bambu Lab» still
 * sees how many «Snapmaker» would add. An option whose count is 0 is returned,
 * not dropped, so the sheet does not reshuffle under a thumb.
 *
 * SAY ONLY WHAT THE DATA SAYS. A product whose spec value is missing or
 * unreadable matches NO option of that facet — it is never counted as «No»
 * enclosure or «Beginner» because a field was blank.
 *
 * Pure: no D1, no clock.
 */
import {
  FACET_FIELD_IDS,
  FACET_MULTI_SEPARATOR,
  SIZE_BUCKETS,
  familyToken,
  readRangeToken,
  spoolToken,
  type FacetField,
  type ListingFilters,
  type ListingSort,
  type ListingState,
} from '@levonis/catalog/discovery';
import type { FacetOption, FacetSet } from '@levonis/catalog/discoveryTypes';
import { readBoolean, readDimensions, readNumber } from './compareSpecs';

/** One resolved candidate — the card plus what the filters read. */
export interface ListingItem {
  id: string;
  /** The serialised card, returned as is. */
  card: Record<string, unknown>;
  name: string;
  /**
   * The viewer's resolved «from» price (`display_price_iqd`); NULL for a
   * catalog-only product (DECISIONS row 240: shown, not sold yet) — a price
   * range and the offer and member filters exclude it, and both price sorts
   * put it last.
   */
  price: number | null;
  /** The regular price the same card compares against (null when `price` is). */
  regular: number | null;
  prime: number | null;
  pro: number | null;
  /** Direct-sale units available now (0 when none or not offered). */
  available: number;
  saleTypes: string[];
  brandId: string | null;
  brandSlug: string | null;
  /** 0148 — the slugs of the ACTIVE printers this product is linked to. */
  fits: string[];
  createdAt: string;
  /** Position in the SQL / search order — the stable tie-break for every sort. */
  rank: number;
  /** A live or upcoming scheduled offer is attached. */
  scheduledOffer: boolean;
  /** SELLABLE now (`price_status: 'priced'`): browse lists put these first (rule R1). Absent reads as priced. */
  priced?: boolean;
  specs: Record<string, unknown>;
}

export interface BrandInfo {
  id: string;
  slug: string;
  name_ar: string;
  name_en: string;
  name_ckb: string;
}

/** A printer the «يناسب طابعة» facet can offer (0148) — the same shape as a brand's. */
export type PrinterInfo = BrandInfo;

// --------------------------------------------------------------- spec reading

const specText = (specs: Record<string, unknown>, id: string): string => {
  const v = specs[id];
  if (v === null || v === undefined || typeof v === 'object') return '';
  return String(v).trim();
};

/** `fdm` | `resin` | null — the same reading compareSpecs gives `technology`. */
export function techOf(specs: Record<string, unknown>): 'fdm' | 'resin' | null {
  const t = specText(specs, 'technology').toLowerCase();
  if (t === '') return null;
  if (t.includes('fdm') || t.includes('fff')) return 'fdm';
  if (/resin|msla|sla|dlp|lcd/.test(t)) return 'resin';
  return null;
}

const MAX_COLOR_BUCKETS = ['1-4', '5-15', '16-20', '21-23', '24-'] as const;

/**
 * The pieces of a multi-valued mirror: the importer writes the base colours of
 * a colour group as "white | black" (the Bambu import spec §G.5). A value with
 * no separator — every colour an admin typed — is one piece, read as before.
 */
function pieces(text: string): string[] {
  return text
    .split(FACET_MULTI_SEPARATOR)
    .map((p) => p.trim())
    .filter(Boolean);
}

const uniq = (list: string[]): string[] => [...new Set(list)];

/** The canonical tokens this product answers for one facet ([] = unknown). */
export function facetTokensOf(field: FacetField, specs: Record<string, unknown>): string[] {
  switch (field) {
    case 'technology': {
      const t = techOf(specs);
      return t ? [t] : [];
    }
    case 'skill_level': {
      const v = specText(specs, 'skill_level').toLowerCase();
      return ['beginner', 'intermediate', 'advanced', 'professional'].includes(v) ? [v] : [];
    }
    case 'enclosed': {
      const b = readBoolean(specText(specs, 'enclosed'));
      return b === 1 ? ['1'] : b === 0 ? ['0'] : [];
    }
    case 'build_volume': {
      const d = readDimensions(specText(specs, 'build_volume'), 'mm');
      if (!d || d.axes.length !== 3) return [];
      const longest = Math.max(...d.axes);
      const hit = (Object.keys(SIZE_BUCKETS) as Array<keyof typeof SIZE_BUCKETS>).find(
        (k) => longest >= SIZE_BUCKETS[k].min && longest <= SIZE_BUCKETS[k].max
      );
      return hit ? [hit] : [];
    }
    case 'max_colors': {
      const n = readNumber(specText(specs, 'max_colors'));
      if (n === null || n < 1) return [];
      return [String(n)];
    }
    case 'diameter': {
      const n = readNumber(specText(specs, 'diameter'), 'mm');
      return n === null ? [] : [String(n)];
    }
    // The Bambu import spec §G.5: multi-valued mirrors, one token per piece.
    case 'color_name':
      return uniq(pieces(specText(specs, 'color_name')).map((p) => p.toLowerCase().replace(/\s+/g, ' ')));
    case 'spool_type':
      // A product sold both ways says so in one value: "Refill | With spool" (or the form's "Refill, With spool").
      return uniq(
        pieces(specText(specs, 'spool_type'))
          .flatMap((p) => p.split(','))
          .map((p): string | null => spoolToken(p))
          .filter((t): t is string => t !== null)
      ).sort();
    case 'product_family': {
      const t = familyToken(specText(specs, 'product_family'));
      return t ? [t] : [];
    }
    default: {
      const v = specText(specs, field).toLowerCase().replace(/\s+/g, ' ');
      return v ? [v] : [];
    }
  }
}

/**
 * READ ONCE PER PRODUCT AND FACET. The counts ask every candidate about every
 * facet once per option and once per other filter, and the spec parsers
 * (compareSpecs) were the listing's hottest code at a thousand candidates. A
 * candidate's `specs` object is parsed once per request and never written, so
 * its readings are kept beside it (weakly) and handed out read-only.
 */
const TOKENS = new WeakMap<Record<string, unknown>, Map<FacetField, readonly string[]>>();
function tokensOf(field: FacetField, specs: Record<string, unknown>): readonly string[] {
  let byField = TOKENS.get(specs);
  if (!byField) {
    byField = new Map();
    TOKENS.set(specs, byField);
  }
  let tokens = byField.get(field);
  if (!tokens) {
    tokens = facetTokensOf(field, specs);
    byField.set(field, tokens);
  }
  return tokens;
}
const MAX_COLORS = new WeakMap<Record<string, unknown>, number | null>();
function maxColorsOf(specs: Record<string, unknown>): number | null {
  if (MAX_COLORS.has(specs)) return MAX_COLORS.get(specs) ?? null;
  const n = readNumber(specText(specs, 'max_colors'));
  MAX_COLORS.set(specs, n);
  return n;
}

/** Does this product satisfy ONE facet's selection (OR within the facet)? */
function matchesFacet(field: FacetField, specs: Record<string, unknown>, selected: string[]): boolean {
  if (field === 'max_colors') {
    const n = maxColorsOf(specs);
    if (n === null) return false;
    return selected.some((t) => {
      const r = readRangeToken(t);
      return r !== null && n >= r.min && n <= r.max;
    });
  }
  const mine = tokensOf(field, specs);
  return mine.some((t) => selected.includes(t));
}

// -------------------------------------------------------------------- filters

type FilterKey = 'avail' | 'sale' | 'price' | 'brands' | 'fits' | 'offer' | 'member' | FacetField;

export const hasSaleType = (item: ListingItem, t: 'direct_sale' | 'pre_order'): boolean => item.saleTypes.includes(t);

/** «عليها عرض»: a SALE price (the card's badge) or a live/upcoming offer window. Never an unpriced product. */
export const onOffer = (item: ListingItem): boolean =>
  item.price !== null && ((item.regular !== null && item.price < item.regular) || item.scheduledOffer);

/** «سعر أقل للأعضاء»: a member rung strictly below what this viewer pays. Never an unpriced product. */
export const memberCheaper = (item: ListingItem): boolean =>
  item.price !== null && ((item.prime !== null && item.prime < item.price) || (item.pro !== null && item.pro < item.price));

/** Priced (sellable) — the default when a caller did not say (every item before DECISIONS row 240 was). */
const isPriced = (item: ListingItem): boolean => item.priced !== false && item.price !== null;

function passes(item: ListingItem, f: ListingFilters, except: FilterKey | null): boolean {
  if (except !== 'avail' && f.avail && !(item.available > 0)) return false;
  if (except !== 'sale' && f.sale === 'direct' && !hasSaleType(item, 'direct_sale')) return false;
  if (except !== 'sale' && f.sale === 'preorder' && !hasSaleType(item, 'pre_order')) return false;
  if (except !== 'price' && f.price) {
    // R3: a price range excludes a product that has no price yet.
    if (item.price === null) return false;
    if (f.price.min !== null && item.price < f.price.min) return false;
    if (f.price.max !== null && item.price > f.price.max) return false;
  }
  if (except !== 'brands' && f.brands.length && !(item.brandSlug && f.brands.includes(item.brandSlug))) return false;
  // «يناسب طابعة»: linked to ANY of the chosen printers. A part linked to none
  // matches none — «fits every printer» is not something a missing link says.
  const fits = f.fits ?? [];
  if (except !== 'fits' && fits.length && !(item.fits ?? []).some((slug) => fits.includes(slug))) return false;
  if (except !== 'offer' && f.offer && !onOffer(item)) return false;
  if (except !== 'member' && f.member && !memberCheaper(item)) return false;
  for (const field of FACET_FIELD_IDS) {
    if (except === field) continue;
    const selected = f.specs[field];
    if (selected && selected.length && !matchesFacet(field, item.specs, selected)) return false;
  }
  return true;
}

export function applyFilters(items: ListingItem[], f: ListingFilters, except: FilterKey | null = null): ListingItem[] {
  return items.filter((item) => passes(item, f, except));
}

// ---------------------------------------------------------------------- sorts

const byRank = (a: ListingItem, b: ListingItem) => a.rank - b.rank;

/**
 * THE NAME ORDER'S ONE COLLATOR. `localeCompare(b, 'en', options)` builds an ICU
 * collator on EVERY comparison (V8 caches one only when no options are passed):
 * the name sort of a listing's every candidate (`pagedListing`, up to 10,000)
 * cost ~200 ms of CPU at 1,200 products and ~1 s at 5,000. One shared collator
 * gives the same order (`localeCompare` with these arguments is specified as
 * `new Intl.Collator('en', options).compare`) at a thirtieth of the cost.
 */
export const NAME_COLLATOR = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

/**
 * The seven orders. Every one is STABLE on `rank` (the SQL / search order), so
 * two equal prices keep the merchandiser's order and a page boundary never
 * reshuffles between two requests.
 *
 * `relevance` is the default and it is two different things: WITH a search it
 * is the search engine's ranking, untouched (the listing that already ranks
 * «h2» must keep ranking it); WITHOUT one it is available-now first, then the
 * shelf order — the owner's direct-sale priority (§4.2), as a stable partition.
 */
export function sortItems(items: ListingItem[], sort: ListingSort, hasSearch: boolean): ListingItem[] {
  const out = items.slice();
  /** R1 (DECISIONS row 240): sellable first — a stable partition ahead of the surface's own order. */
  const pricedFirst = (a: ListingItem, b: ListingItem) => Number(isPriced(b)) - Number(isPriced(a));
  /** R3: a missing price sorts last in BOTH directions, then by rank. */
  const byPrice = (dir: 1 | -1) => (a: ListingItem, b: ListingItem) => {
    if (a.price === null || b.price === null) return Number(a.price === null) - Number(b.price === null) || byRank(a, b);
    return dir * (a.price - b.price) || byRank(a, b);
  };
  switch (sort) {
    case 'newest':
      return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : byRank(a, b)));
    case 'price_asc':
      return out.sort(byPrice(1));
    case 'price_desc':
      return out.sort(byPrice(-1));
    case 'name':
      return out.sort((a, b) => NAME_COLLATOR.compare(a.name, b.name) || byRank(a, b));
    case 'available':
      return out.sort(
        (a, b) =>
          pricedFirst(a, b) || Number(b.available > 0) - Number(a.available > 0) || b.available - a.available || byRank(a, b)
      );
    case 'direct':
      return out.sort(
        (a, b) =>
          pricedFirst(a, b) ||
          Number(hasSaleType(b, 'direct_sale')) - Number(hasSaleType(a, 'direct_sale')) ||
          Number(b.available > 0) - Number(a.available > 0) ||
          byRank(a, b)
      );
    default:
      // R2: a search keeps the engine's relevance — the shopper typed a name, and each card states its price.
      if (hasSearch) return out.sort(byRank);
      return out.sort((a, b) => pricedFirst(a, b) || Number(b.available > 0) - Number(a.available > 0) || byRank(a, b));
  }
}

// --------------------------------------------------------------------- facets

const HISTOGRAM_BINS = 12;

function histogram(prices: number[], min: number, max: number): number[] {
  const bins = new Array<number>(HISTOGRAM_BINS).fill(0);
  if (prices.length === 0) return bins;
  const span = max - min;
  for (const p of prices) {
    const i = span <= 0 ? 0 : Math.min(HISTOGRAM_BINS - 1, Math.floor(((p - min) / span) * HISTOGRAM_BINS));
    bins[i] += 1;
  }
  return bins;
}

/** The options a spec facet offers: every token the WHOLE candidate set answers. */
function specOptions(field: FacetField, all: ListingItem[]): Array<{ value: string; label: string }> {
  const seen = new Map<string, string>();
  if (field === 'max_colors') {
    for (const bucket of MAX_COLOR_BUCKETS) {
      const r = readRangeToken(bucket)!;
      if (all.some((i) => {
        const n = maxColorsOf(i.specs);
        return n !== null && n >= r.min && n <= r.max;
      })) seen.set(bucket, bucket);
    }
    return [...seen].map(([value, label]) => ({ value, label }));
  }
  for (const item of all) {
    const words = field === 'color_name' ? pieces(specText(item.specs, field)) : [];
    for (const t of tokensOf(field, item.specs)) {
      if (seen.has(t)) continue;
      // The admin's own words for a free-text value; a piece of a multi-valued colour is its own label.
      const label =
        field === 'material_type'
          ? specText(item.specs, field)
          : field === 'color_name'
            ? (words.find((w) => w.toLowerCase().replace(/\s+/g, ' ') === t) ?? t)
            : t;
      seen.set(t, label);
    }
  }
  return [...seen]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.value.localeCompare(b.value, 'en', { numeric: true }));
}

/**
 * Every facet's counts. `all` is the whole candidate set (the options come from
 * it, so they are stable); `f` is the active selection. Each count applies every
 * other filter and ignores its own — the disjunctive rule.
 */
export function facetCounts(
  all: ListingItem[],
  f: ListingFilters,
  brands: Map<string, BrandInfo>,
  printers: Map<string, PrinterInfo> = new Map()
): FacetSet {
  const total = applyFilters(all, f).length;

  const forAvail = applyFilters(all, f, 'avail');
  const forSale = applyFilters(all, f, 'sale');
  const forPrice = applyFilters(all, f, 'price');
  const forBrands = applyFilters(all, f, 'brands');
  const forFits = applyFilters(all, f, 'fits');
  const forOffer = applyFilters(all, f, 'offer');
  const forMember = applyFilters(all, f, 'member');

  const prices = forPrice.map((i) => i.price).filter((p): p is number => p !== null && Number.isFinite(p) && p > 0);
  const pmin = prices.length ? Math.min(...prices) : null;
  const pmax = prices.length ? Math.max(...prices) : null;

  const brandIds = new Set(all.map((i) => i.brandId).filter((b): b is string => !!b));
  const brandRows = [...brandIds]
    .map((id) => brands.get(id))
    .filter((b): b is BrandInfo => !!b)
    .map((b) => ({ ...b, count: forBrands.filter((i) => i.brandId === b.id).length }))
    .sort((a, b) => b.count - a.count || (a.name_en || a.name_ar).localeCompare(b.name_en || b.name_ar));

  // The printers any candidate names — so the options are stable while the
  // counts follow every OTHER filter (the disjunctive rule).
  const printerSlugs = new Set(all.flatMap((i) => i.fits ?? []));
  const printerRows = [...printerSlugs]
    .map((slug) => printers.get(slug))
    .filter((p): p is PrinterInfo => !!p)
    .map((p) => ({ ...p, count: forFits.filter((i) => (i.fits ?? []).includes(p.slug)).length }))
    .sort((a, b) => b.count - a.count || (a.name_en || a.name_ar).localeCompare(b.name_en || b.name_ar, 'en', { numeric: true }));

  const specs: Partial<Record<FacetField, FacetOption[]>> = {};
  for (const field of FACET_FIELD_IDS) {
    const options = specOptions(field, all);
    if (options.length === 0) continue;
    const pool = applyFilters(all, f, field);
    specs[field] = options.map((o) => ({
      value: o.value,
      label: o.label,
      count: pool.filter((i) => matchesFacet(field, i.specs, [o.value])).length,
    }));
  }

  return {
    total,
    avail: { now: forAvail.filter((i) => i.available > 0).length },
    sale: {
      direct: forSale.filter((i) => hasSaleType(i, 'direct_sale')).length,
      preorder: forSale.filter((i) => hasSaleType(i, 'pre_order')).length,
    },
    price: {
      min: pmin,
      max: pmax,
      histogram: pmin === null || pmax === null ? new Array<number>(HISTOGRAM_BINS).fill(0) : histogram(prices, pmin, pmax),
    },
    brands: brandRows,
    printers: printerRows,
    offer: forOffer.filter(onOffer).length,
    member: forMember.filter(memberCheaper).length,
    specs,
  };
}

// ------------------------------------------------------------- what reads what

/**
 * WHETHER AN ORDER READS A RESOLVED FIELD — the viewer's price, the proved stock, the
 * sale types, the priced state — or only what the row stores (its name, its date,
 * its place in the SQL / search order). A stored-key order can be computed for EVERY
 * candidate from a narrow read, and only the page shown is priced
 * (worker/routes/products.ts `pagedListing`); a resolved one needs each candidate
 * through the pricing path first.
 */
export function sortReadsResolved(sort: ListingSort, hasSearch: boolean): boolean {
  if (sort === 'newest' || sort === 'name') return false;
  // Relevance WITH a search is the engine's ranking, untouched (byRank).
  if (sort === 'relevance') return !hasSearch;
  return true;
}

/**
 * Whether an active filter reads a resolved field. Every one of them — «المتوفر
 * الآن», the sale type, a price range, «عليها عرض», «سعر أقل للأعضاء» — EXCLUDES a
 * product with no price (R3, `passes`): a catalog-only product can never pass one.
 * Brand, «يناسب طابعة» and the spec facets read stored fields only.
 */
export function filtersReadResolved(f: ListingFilters): boolean {
  return f.avail || f.sale !== null || f.price !== null || f.offer || f.member;
}

/**
 * The filters with every RESOLVED one cleared — what a candidate's KEYS alone
 * answer: brand, «يناسب طابعة», the spec facets. The listing chooses the
 * candidates it prices to order with these (`pagedListing`), so that choice is
 * the same wherever the stored-key filters ran (in SQL without the counts, in
 * memory with them).
 */
export function storedKeyFilters<T extends ListingFilters>(f: T): T {
  return { ...f, avail: false, sale: null, price: null, offer: false, member: false };
}

/** The whole listing step: filter, sort, count. Paging is the caller's. */
export function runListing(
  all: ListingItem[],
  state: ListingState,
  opts: { facets: boolean; brands: Map<string, BrandInfo>; printers?: Map<string, PrinterInfo> }
): { items: ListingItem[]; facets?: FacetSet } {
  const filtered = applyFilters(all, state);
  const items = sortItems(filtered, state.sort, state.q.trim() !== '');
  return opts.facets ? { items, facets: facetCounts(all, state, opts.brands, opts.printers) } : { items };
}
