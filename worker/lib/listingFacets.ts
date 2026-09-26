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
 * counts are asked for — brand and sale type), resolves a CAPPED candidate set
 * through the one pricing path, and hands it here. At 14 products or 1,400 the
 * cap (300) keeps one request bounded, and `truncated` says when it bit.
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
  SIZE_BUCKETS,
  readRangeToken,
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
  /** The viewer's resolved «from» price (`display_price_iqd`). */
  price: number;
  /** The regular price the same card compares against. */
  regular: number;
  prime: number | null;
  pro: number | null;
  /** Direct-sale units available now (0 when none or not offered). */
  available: number;
  saleTypes: string[];
  brandId: string | null;
  brandSlug: string | null;
  createdAt: string;
  /** Position in the SQL / search order — the stable tie-break for every sort. */
  rank: number;
  /** A live or upcoming scheduled offer is attached. */
  scheduledOffer: boolean;
  specs: Record<string, unknown>;
}

export interface BrandInfo {
  id: string;
  slug: string;
  name_ar: string;
  name_en: string;
  name_ckb: string;
}

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
    default: {
      const v = specText(specs, field).toLowerCase().replace(/\s+/g, ' ');
      return v ? [v] : [];
    }
  }
}

/** Does this product satisfy ONE facet's selection (OR within the facet)? */
function matchesFacet(field: FacetField, specs: Record<string, unknown>, selected: string[]): boolean {
  if (field === 'max_colors') {
    const n = readNumber(specText(specs, 'max_colors'));
    if (n === null) return false;
    return selected.some((t) => {
      const r = readRangeToken(t);
      return r !== null && n >= r.min && n <= r.max;
    });
  }
  const mine = facetTokensOf(field, specs);
  return mine.some((t) => selected.includes(t));
}

// -------------------------------------------------------------------- filters

type FilterKey = 'avail' | 'sale' | 'price' | 'brands' | 'offer' | 'member' | FacetField;

export const hasSaleType = (item: ListingItem, t: 'direct_sale' | 'pre_order'): boolean => item.saleTypes.includes(t);

/** «عليها عرض»: a SALE price (the card's badge) or a live/upcoming offer window. */
export const onOffer = (item: ListingItem): boolean => item.price < item.regular || item.scheduledOffer;

/** «سعر أقل للأعضاء»: a member rung strictly below what this viewer pays. */
export const memberCheaper = (item: ListingItem): boolean =>
  (item.prime !== null && item.prime < item.price) || (item.pro !== null && item.pro < item.price);

function passes(item: ListingItem, f: ListingFilters, except: FilterKey | null): boolean {
  if (except !== 'avail' && f.avail && !(item.available > 0)) return false;
  if (except !== 'sale' && f.sale === 'direct' && !hasSaleType(item, 'direct_sale')) return false;
  if (except !== 'sale' && f.sale === 'preorder' && !hasSaleType(item, 'pre_order')) return false;
  if (except !== 'price' && f.price) {
    if (f.price.min !== null && item.price < f.price.min) return false;
    if (f.price.max !== null && item.price > f.price.max) return false;
  }
  if (except !== 'brands' && f.brands.length && !(item.brandSlug && f.brands.includes(item.brandSlug))) return false;
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
  switch (sort) {
    case 'newest':
      return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : byRank(a, b)));
    case 'price_asc':
      return out.sort((a, b) => a.price - b.price || byRank(a, b));
    case 'price_desc':
      return out.sort((a, b) => b.price - a.price || byRank(a, b));
    case 'name':
      return out.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base', numeric: true }) || byRank(a, b));
    case 'available':
      return out.sort(
        (a, b) => Number(b.available > 0) - Number(a.available > 0) || b.available - a.available || byRank(a, b)
      );
    case 'direct':
      return out.sort(
        (a, b) =>
          Number(hasSaleType(b, 'direct_sale')) - Number(hasSaleType(a, 'direct_sale')) ||
          Number(b.available > 0) - Number(a.available > 0) ||
          byRank(a, b)
      );
    default:
      if (hasSearch) return out.sort(byRank);
      return out.sort((a, b) => Number(b.available > 0) - Number(a.available > 0) || byRank(a, b));
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
        const n = readNumber(specText(i.specs, 'max_colors'));
        return n !== null && n >= r.min && n <= r.max;
      })) seen.set(bucket, bucket);
    }
    return [...seen].map(([value, label]) => ({ value, label }));
  }
  for (const item of all) {
    for (const t of facetTokensOf(field, item.specs)) {
      if (!seen.has(t)) seen.set(t, field === 'material_type' || field === 'color_name' ? specText(item.specs, field) : t);
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
export function facetCounts(all: ListingItem[], f: ListingFilters, brands: Map<string, BrandInfo>): FacetSet {
  const total = applyFilters(all, f).length;

  const forAvail = applyFilters(all, f, 'avail');
  const forSale = applyFilters(all, f, 'sale');
  const forPrice = applyFilters(all, f, 'price');
  const forBrands = applyFilters(all, f, 'brands');
  const forOffer = applyFilters(all, f, 'offer');
  const forMember = applyFilters(all, f, 'member');

  const prices = forPrice.map((i) => i.price).filter((p) => Number.isFinite(p) && p > 0);
  const pmin = prices.length ? Math.min(...prices) : null;
  const pmax = prices.length ? Math.max(...prices) : null;

  const brandIds = new Set(all.map((i) => i.brandId).filter((b): b is string => !!b));
  const brandRows = [...brandIds]
    .map((id) => brands.get(id))
    .filter((b): b is BrandInfo => !!b)
    .map((b) => ({ ...b, count: forBrands.filter((i) => i.brandId === b.id).length }))
    .sort((a, b) => b.count - a.count || (a.name_en || a.name_ar).localeCompare(b.name_en || b.name_ar));

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
    offer: forOffer.filter(onOffer).length,
    member: forMember.filter(memberCheaper).length,
    specs,
  };
}

/** The whole listing step: filter, sort, count. Paging is the caller's. */
export function runListing(
  all: ListingItem[],
  state: ListingState,
  opts: { facets: boolean; brands: Map<string, BrandInfo> }
): { items: ListingItem[]; facets?: FacetSet } {
  const filtered = applyFilters(all, state);
  const items = sortItems(filtered, state.sort, state.q.trim() !== '');
  return opts.facets ? { items, facets: facetCounts(all, state, opts.brands) } : { items };
}
