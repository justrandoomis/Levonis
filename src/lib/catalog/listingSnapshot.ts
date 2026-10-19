/**
 * THE LISTING'S SNAPSHOT AND ITS «عرض المزيد» CURSOR — the pure half of
 * src/components/listing/useListing.ts, so tests/listingPaging.test.ts can
 * drive it against the real route.
 *
 * THE CURSOR IS THE SERVER'S POSITION, NOT THE NUMBER OF CARDS HELD. A page
 * may repeat cards the shopper already holds — products entered the order
 * ahead of them (a catalog-only import lands at display order 0 with the
 * newest date; a product priced by the owner joins the sellable head; two
 * edge-cached pages come from database states minutes apart) — and those
 * repeats are dropped. Asking from the number of cards KEPT would then start
 * every later page that many rows too early, for the rest of the session, and
 * a page that adds nothing would end the list with hundreds left. So the
 * snapshot keeps `nextOffset` = the asked offset + the rows the server
 * answered, and dropping a duplicate never moves it back. The list ends only
 * when the server says `has_more: false` (or answers an empty page).
 */
import type { ApiProduct, ProductsListResponse } from '../api';
import type { FacetSet, ListingState } from './types';

export interface ListingSnapshot {
  products: ApiProduct[];
  total: number;
  /** The server's aggregate flag (`partial_order || cut_off`); kept for an older snapshot. */
  truncated: boolean;
  /**
   * The price/stock order or filter covered only the first sellable candidates
   * (the server's cap): the rest follow in the shelf order, or a filter leaves
   * them out (`partial_order`).
   */
  partialOrder?: boolean;
  /** More candidates than the listing reads: the ones past it are not listed (`cut_off`). */
  cutOff?: boolean;
  /**
   * The server's cursor: where the next page starts. Absent from an older
   * snapshot — then the cards held stand in for it.
   */
  nextOffset?: number;
  /**
   * The server's word on whether another page follows (`has_more`) — the
   * listing pages to its last product. Absent from an older answer or snapshot:
   * then `total` alone says how many remain.
   */
  hasMore?: boolean;
  facets: FacetSet | null;
}

/** Where the next page starts on the server. */
export const cursorOf = (s: ListingSnapshot): number => (typeof s.nextOffset === 'number' ? s.nextOffset : s.products.length);

/**
 * Page 1's answer → the snapshot, keeping the pages «عرض المزيد» had loaded
 * (so the list keeps its length) and their cursor.
 */
export function firstPageSnapshot(res: ProductsListResponse, kept: ListingSnapshot | null): ListingSnapshot {
  const fresh = res.products ?? [];
  const seen = new Set(fresh.map((p) => p.id));
  const extra = kept && kept.products.length > fresh.length ? kept.products.slice(fresh.length).filter((p) => !seen.has(p.id)) : [];
  return {
    products: [...fresh, ...extra],
    total: typeof res.total === 'number' ? res.total : fresh.length,
    truncated: !!res.truncated,
    partialOrder: !!res.partial_order,
    cutOff: !!res.cut_off,
    nextOffset: kept && extra.length ? Math.max(fresh.length, cursorOf(kept)) : fresh.length,
    // With the kept pages the snapshot is longer than this answer: only `total` can speak for it.
    ...(extra.length === 0 && typeof res.has_more === 'boolean' ? { hasMore: res.has_more } : {}),
    facets: res.facets ?? null,
  };
}

/** One «عرض المزيد» answer, asked at `offset`, merged into the snapshot. */
export function withNextPage(have: ListingSnapshot, res: ProductsListResponse, offset: number): ListingSnapshot {
  const got = res.products ?? [];
  const seen = new Set(have.products.map((p) => p.id));
  const added = got.filter((p) => !seen.has(p.id));
  // The last page says so (`has_more: false`); an empty page ends the list whatever an older server said.
  const hasMore = got.length === 0 ? false : typeof res.has_more === 'boolean' ? res.has_more : have.hasMore;
  return {
    ...have,
    products: [...have.products, ...added],
    // Past every row the server answered — the repeats dropped above included.
    nextOffset: Math.max(cursorOf(have), offset + got.length),
    ...(typeof res.total === 'number' ? { total: res.total } : {}),
    ...(typeof res.truncated === 'boolean' ? { truncated: res.truncated } : {}),
    ...(typeof res.partial_order === 'boolean' ? { partialOrder: res.partial_order } : {}),
    ...(typeof res.cut_off === 'boolean' ? { cutOff: res.cut_off } : {}),
    ...(hasMore === undefined ? {} : { hasMore }),
  };
}

/** How many pages one press of «عرض المزيد» may ask for while each answers only cards already held. */
export const LOAD_MORE_ROUNDS = 3;

/**
 * One press of «عرض المزيد»: the next page from the cursor — and, while a page
 * brings only cards already held and the server says more follow, the page
 * after it (at most `rounds`). Returns every answer with the offset it was
 * asked at, for `withNextPage`.
 */
export async function fetchNextPages(
  have: ListingSnapshot,
  fetchPage: (offset: number) => Promise<ProductsListResponse>,
  rounds = LOAD_MORE_ROUNDS
): Promise<Array<{ offset: number; res: ProductsListResponse }>> {
  const pages: Array<{ offset: number; res: ProductsListResponse }> = [];
  const seen = new Set(have.products.map((p) => p.id));
  let offset = cursorOf(have);
  for (let round = 0; round < rounds; round++) {
    const res = await fetchPage(offset);
    pages.push({ offset, res });
    const got = res.products ?? [];
    if (got.length === 0 || res.has_more !== true || got.some((p) => !seen.has(p.id))) break;
    offset += got.length;
  }
  return pages;
}

/** The count «عرض المزيد» shows; 0 hides it. */
export function remainingOf(s: ListingSnapshot): number {
  if (s.hasMore === false) return 0;
  const left = Math.max(0, s.total - cursorOf(s));
  // The server said another page follows: the button stays, whatever the count says.
  return s.hasMore === true ? Math.max(1, left) : left;
}

/**
 * A filter that reads a price or a stock — «المتوفر الآن», the sale type, a
 * price range, «عليها عرض», «سعر أقل للأعضاء». The Worker's
 * `filtersReadResolved` (worker/lib/listingFacets.ts); tests/listingPaging.test.ts
 * holds the two equal.
 */
export const priceOrStockFilterOn = (s: Pick<ListingState, 'avail' | 'sale' | 'price' | 'offer' | 'member'>): boolean =>
  s.avail || s.sale !== null || s.price !== null || s.offer || s.member;

/**
 * Which notes the list carries: `partial` — the price/stock ORDER covered only
 * the first products (the rest follow in the shelf order), or a price/stock
 * FILTER checked only them (the rest are left out); `cutOff` — not every
 * product is listed.
 */
export function listingNotes(s: ListingSnapshot, state: ListingState): { partial: 'order' | 'filter' | null; cutOff: boolean } {
  return {
    partial: s.partialOrder ? (priceOrStockFilterOn(state) ? 'filter' : 'order') : null,
    cutOff: !!s.cutOff,
  };
}
