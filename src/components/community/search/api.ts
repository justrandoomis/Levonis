/**
 * THE COMMUNITY'S SEARCH DOORS — /api/community/{search,search/suggest,
 * trending,recommend} (worker/routes/communitySearch.ts, docs/COMMUNITY_ECOSYSTEM.md
 * §9.3).
 *
 * Every card here is a shape the community already draws: `postCard`,
 * `directoryCard`, the creator card, the community product, the request card
 * — so the overlay reuses the cards of the home instead of inventing rows.
 * Nothing here decides what a visitor may see: the server's SELECT lists do,
 * and a signed-in viewer's block/mute exclusions ride in the response itself
 * (which is why a signed-in answer is never cached at the edge).
 *
 * `/trending` is viewer-independent and cached five minutes at the edge; it
 * is remembered for the same five minutes in this module so the overlay's
 * empty state and the home's composite (hub/useHomeData.ts — the «وسوم
 * رائجة» row, the makers and stores rails and the colophon's count) ask once.
 */
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import type { PostCard } from '../projects/api';
import type { CreatorCard } from '../social/api';
import type { CommunityProduct, CommunityRequest, CommunityStore } from '../hub/api';

/** The sections, in the owner's order. */
export const SEARCH_TYPES = ['projects', 'stores', 'creators', 'products', 'requests', 'materials', 'brands'] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

/** The longest term the server reads (SEARCH_QUERY_TOO_LONG above it). */
export const SEARCH_MAX = 60;
/** Below this many characters the server suggests nothing. */
export const SUGGEST_MIN = 2;

export interface SearchSection<T> {
  rows: T[];
  /** A bounded COUNT (≤ 200); null when the section did not run or failed. */
  total: number | null;
  /** The in-app address listing the rest with the term. */
  more: string;
  /** The section's own query threw; the others still answered. */
  error?: boolean;
}

/** A catalogue material or brand: an id, a name in two scripts, a picture, a page. */
export interface CatalogueRow {
  id: string;
  slug: string;
  name: string;
  name_ar: string;
  imageUrl: string | null;
  href: string;
}

export interface SearchSections {
  projects: SearchSection<PostCard>;
  stores: SearchSection<CommunityStore>;
  creators: SearchSection<CreatorCard>;
  products: SearchSection<CommunityProduct>;
  requests: SearchSection<CommunityRequest>;
  materials: SearchSection<CatalogueRow>;
  brands: SearchSection<CatalogueRow>;
}

export interface SearchAnswer {
  q: string;
  sections: SearchSections;
  took_ms: number;
}

export type SuggestionType = 'project' | 'store' | 'creator' | 'product' | 'tag';

export interface Suggestion {
  text: string;
  type: SuggestionType;
  href: string;
}

export interface TrendingTag {
  tag: string;
  count: number;
}

export interface Trending {
  projects: PostCard[];
  tags: TrendingTag[];
  stores: CommunityStore[];
  creators: CreatorCard[];
  /** The directory's count for the colophon; null when the server did not say. */
  totals: { merchants: number | null };
}

export type RecommendKind = 'projects' | 'stores' | 'products';

export interface Recommendation {
  for: string;
  kind: RecommendKind;
  rows: PostCard[] | CommunityStore[] | CommunityProduct[];
}

/** A section the server left out or malformed still renders: empty, not a crash. */
function section<T>(raw: unknown, more: string): SearchSection<T> {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Partial<SearchSection<T>>;
  return {
    rows: Array.isArray(s.rows) ? s.rows : [],
    total: typeof s.total === 'number' ? s.total : null,
    more: typeof s.more === 'string' && s.more ? s.more : more,
    error: !!s.error,
  };
}

/** Where «الكل» goes when the server did not say: the tab or page that lists the entity with `?q=`. */
export function fallbackMore(type: SearchType, q: string): string {
  const term = encodeURIComponent(q);
  switch (type) {
    case 'projects':
      return `/community/projects?q=${term}`;
    case 'stores':
      return `/community?tab=stores&q=${term}`;
    case 'creators':
      return `/community?tab=creators&q=${term}`;
    case 'products':
      return `/community?tab=foryou&list=products&q=${term}`;
    case 'requests':
      // The tab that reads `?q=` (src/pages/Community.tsx); the board page keeps its term in local state.
      return `/community?tab=requests&q=${term}`;
    case 'materials':
      return `/products?search=${term}&category=cat_materials`;
    case 'brands':
      return `/products?search=${term}`;
  }
}

function normaliseAnswer(q: string, d: Partial<SearchAnswer> | null | undefined): SearchAnswer {
  const raw = (d?.sections ?? {}) as Record<string, unknown>;
  const sections = Object.fromEntries(SEARCH_TYPES.map((t) => [t, section(raw[t], fallbackMore(t, q))])) as unknown as SearchSections;
  return { q: typeof d?.q === 'string' ? d.q : q, sections, took_ms: Number(d?.took_ms ?? 0) };
}

/** The term as the server reads it: trimmed and cut at 60. */
export const cleanTerm = (raw: string) => raw.trim().replace(/\s+/g, ' ').slice(0, SEARCH_MAX);

/** How many rows of every section come back — the number the whole answer holds. */
export function hasAnyRow(a: SearchAnswer): boolean {
  return SEARCH_TYPES.some((t) => a.sections[t].rows.length > 0);
}

export const searchApi = {
  search: (q: string, opts: { types?: SearchType[]; limit?: number; signal?: AbortSignal } = {}) => {
    const term = cleanTerm(q);
    const p = new URLSearchParams({ q: term });
    if (opts.types?.length) p.set('types', opts.types.join(','));
    if (opts.limit) p.set('limit', String(Math.max(1, Math.min(12, Math.floor(opts.limit)))));
    return api.get<Partial<SearchAnswer>>(`/api/community/search?${p.toString()}`, { signal: opts.signal }).then((d) => normaliseAnswer(term, d));
  },
  suggest: (q: string, opts: { signal?: AbortSignal } = {}): Promise<Suggestion[]> => {
    const term = cleanTerm(q);
    if (term.length < SUGGEST_MIN) return Promise.resolve([]);
    return api
      .get<{ suggestions?: Suggestion[] }>(`/api/community/search/suggest?q=${encodeURIComponent(term)}`, { signal: opts.signal })
      .then((d) => (Array.isArray(d.suggestions) ? d.suggestions.filter((s) => s && typeof s.text === 'string' && typeof s.href === 'string').slice(0, 8) : []));
  },
  trending: (): Promise<Trending> => loadTrending(),
  recommend: (anchor: string, limit = 6, opts: { signal?: AbortSignal } = {}): Promise<Recommendation> =>
    api
      .get<Partial<Recommendation>>(`/api/community/recommend?for=${encodeURIComponent(anchor)}&limit=${Math.max(1, Math.min(12, Math.floor(limit)))}`, { signal: opts.signal })
      .then((d) => ({ for: String(d.for ?? anchor), kind: (d.kind ?? 'projects') as RecommendKind, rows: Array.isArray(d.rows) ? (d.rows as Recommendation['rows']) : [] })),
};

// ------------------------------------------------------------ trending memo

/** As long as the edge keeps it (five minutes): nobody asks the Worker twice in it. */
export const TRENDING_FRESH_MS = 5 * 60_000;

let trendingMemo: { at: number; promise: Promise<Trending> } | null = null;

function loadTrending(): Promise<Trending> {
  if (trendingMemo && Date.now() - trendingMemo.at < TRENDING_FRESH_MS) return trendingMemo.promise;
  const promise = api.get<Partial<Trending>>('/api/community/trending').then((d) => ({
    projects: Array.isArray(d.projects) ? d.projects : [],
    tags: Array.isArray(d.tags) ? d.tags.filter((t) => t && typeof t.tag === 'string') : [],
    stores: Array.isArray(d.stores) ? d.stores : [],
    creators: Array.isArray(d.creators) ? d.creators : [],
    totals: { merchants: typeof d.totals?.merchants === 'number' ? d.totals.merchants : null },
  }));
  trendingMemo = { at: Date.now(), promise };
  // A failed read is not remembered: the next asker tries again.
  promise.catch(() => {
    if (trendingMemo?.promise === promise) trendingMemo = null;
  });
  return promise;
}

/** For tests and for a write that changes the picture: forget the remembered answer. */
export function forgetTrending(): void {
  trendingMemo = null;
}

/**
 * The trending picture, once it answers; null before and after a failure.
 * Viewer-independent by design — a signed-in viewer's blocks are applied by
 * the rails themselves (hub/rails.tsx), as Phase 2 does everywhere.
 */
export function useTrending(): Trending | null {
  const [data, setData] = useState<Trending | null>(null);
  useEffect(() => {
    let alive = true;
    loadTrending()
      .then((t) => {
        if (alive) setData(t);
      })
      .catch(() => {
        if (alive) setData(null);
      });
    return () => {
      alive = false;
    };
  }, []);
  return data;
}
