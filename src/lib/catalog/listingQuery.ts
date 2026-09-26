/**
 * THE LISTING'S URL STATE (docs/ux/CATALOG_DISCOVERY.md §7 «URL»).
 *
 *   /categories/printers/fdm-printers?sort=price_asc&avail=1&sale=direct
 *     &price=500000-2500000&brand=bambu-lab,snapmaker&colors=24-&size=large
 *     &enclosed=1&level=beginner&q=h2
 *
 * A thin wrapper over the ONE grammar in packages/catalog/src/discovery.ts, which
 * the Worker parses `/api/products` with — so a filter the page shows as applied
 * is a filter the server applies. Unknown values are dropped, never thrown; the
 * default state serialises to ''; keys come out in one stable order.
 */
import {
  DEFAULT_LISTING,
  encodePairs,
  listingParamPairs,
  parseListingParams,
  type ListingState,
} from '../../../packages/catalog/src/discovery';

export {
  DEFAULT_LISTING,
  FACET_FIELDS,
  FACET_FIELD_IDS,
  LISTING_SORTS,
  SIZE_BUCKETS,
  activeFilterCount,
  facetToken,
  hasListingFilters,
  parsePriceRange,
  readRangeToken,
} from '../../../packages/catalog/src/discovery';

const toParams = (search: string | URLSearchParams): URLSearchParams =>
  typeof search === 'string' ? new URLSearchParams(search.startsWith('?') ? search.slice(1) : search) : search;

/** A page query string (with or without `?`) → state. */
export function parseListing(search: string | URLSearchParams): ListingState {
  const p = toParams(search);
  return parseListingParams((k) => p.get(k), 'page');
}

/** State → a page query string WITHOUT `?`; '' for the default state. */
export function serializeListing(state: ListingState): string {
  return encodePairs(listingParamPairs(state, 'page'));
}

/**
 * State → the `/api/products` query for it (the API's `search` and `f.<field>`
 * keys), plus the scope and paging the page adds. `facets` asks for the counts.
 */
export function listingApiQuery(
  state: ListingState,
  extra: { category?: string; limit?: number; offset?: number; facets?: boolean } = {}
): string {
  const pairs: Array<[string, string]> = [];
  if (extra.category) pairs.push(['category', extra.category]);
  pairs.push(...listingParamPairs(state, 'api'));
  if (extra.facets) pairs.push(['facets', '1']);
  if (extra.limit !== undefined) pairs.push(['limit', String(extra.limit)]);
  if (extra.offset) pairs.push(['offset', String(extra.offset)]);
  return encodePairs(pairs);
}

/** A fresh default state (the frozen constant must not be mutated). */
export const emptyListing = (): ListingState => ({ ...DEFAULT_LISTING, brands: [], specs: {} });
