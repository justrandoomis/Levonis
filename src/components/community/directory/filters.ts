/**
 * THE DIRECTORY FILTERS IN THE ADDRESS (community UI plan C5). Back, a reload
 * and a shared link keep what the visitor chose, so the filters live in the
 * query string and nowhere else:
 *
 *   /community/stores?q=&gov=<governorate id>&tech=fdm|resin&design=1
 *   /community/makers?q=&sort=recent|featured|followers&has_store=1&approved=1
 *
 * A value outside the closed lists of packages/contracts/src/communityFilters.ts
 * (or an unknown governorate) reads as no filter, so a hand-edited address can
 * never send the server something it refuses. The readers return the shape
 * useCommunityFeed keys its memory by (the server parameter names), with empty
 * values for no filter.
 */
import { CREATOR_SORTS, DIRECTORY_TECHS, type CreatorSort, type DirectoryTech } from '../../../../packages/contracts/src/communityFilters';
import { GOVERNORATE_LABELS } from '../../../lib/governorates';

/** The search term a link hands over, as the home reads it. */
export function readQuery(params: URLSearchParams): string {
  return (params.get('q') ?? '').trim().slice(0, 60);
}

/** A type, not an interface, so it reads as the plain record useCommunityFeed keys by. */
export type StoreFilterState = {
  governorate: string;
  tech: DirectoryTech | '';
  service: 'design' | '';
};

export function readStoreFilters(params: URLSearchParams): StoreFilterState {
  const gov = params.get('gov') ?? '';
  const tech = params.get('tech') ?? '';
  return {
    governorate: Object.prototype.hasOwnProperty.call(GOVERNORATE_LABELS, gov) ? gov : '',
    tech: (DIRECTORY_TECHS as readonly string[]).includes(tech) ? (tech as DirectoryTech) : '',
    service: params.get('design') === '1' ? 'design' : '',
  };
}

export type MakerFilterState = {
  sort: CreatorSort | '';
  has_store: '1' | '';
  approved: '1' | '';
};

export function readMakerFilters(params: URLSearchParams): MakerFilterState {
  const sort = params.get('sort') ?? '';
  return {
    sort: (CREATOR_SORTS as readonly string[]).includes(sort) ? (sort as CreatorSort) : '',
    has_store: params.get('has_store') === '1' ? '1' : '',
    approved: params.get('approved') === '1' ? '1' : '',
  };
}

/** How many filters are on (the search term is not a filter). */
export function activeCount(filters: object): number {
  return Object.values(filters).filter(Boolean).length;
}

/** The query string with these keys set, or removed when empty; everything else kept. */
export function withParams(prev: URLSearchParams, patch: Record<string, string | null>): URLSearchParams {
  const next = new URLSearchParams(prev);
  for (const [k, v] of Object.entries(patch)) {
    if (v) next.set(k, v);
    else next.delete(k);
  }
  return next;
}

/** The address keys of each directory, for «مسح الفلاتر». */
export const STORE_FILTER_KEYS = ['gov', 'tech', 'design'] as const;
export const MAKER_FILTER_KEYS = ['sort', 'has_store', 'approved'] as const;

/**
 * The order the makers list reads with no sort chosen: the featured order (the
 * most projects first) without a search, the newest activity with one. The
 * same rule as hub/useCommunityFeed.ts, so the sheet shows the order on screen.
 */
export function effectiveSort(q: string, sort: CreatorSort | ''): CreatorSort {
  return sort || (q ? 'recent' : 'featured');
}
