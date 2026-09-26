import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, isAborted, type ApiProduct, type ProductsListResponse } from '../../lib/api';
import { readPageCache, writePageCache } from '../../lib/pageCache';
import { listingApiQuery, parseListing, serializeListing } from '../../lib/catalog/listingQuery';
import type { FacetSet, ListingState } from '../../lib/catalog/types';

/** «عرض المزيد» pages (§7 item 9): 24 per page, a button, never an endless scroll. */
export const PAGE_SIZE = 24;

export interface ListingSnapshot {
  products: ApiProduct[];
  total: number;
  truncated: boolean;
  facets: FacetSet | null;
}

/**
 * THE LISTING'S STATE IS THE URL; THIS HOOK IS THE ONLY WRITER.
 *
 *   state   parsed from `location.search` through the one grammar the Worker
 *           reads too (packages/catalog/src/discovery.ts). Nothing is kept in
 *           React state that the URL could not rebuild, so a refresh, a
 *           shared link and «back» from a product all land on the same list.
 *   commit  writes a new state with `replace` (§7 «URL»): refining a list is
 *           not a new page, and «back» should leave the section, not step
 *           through every chip that was tapped.
 *
 * THE DATA. One request per state: the first 24 cards, the total after
 * filters, and the disjunctive facet counts (`facets=1`) that drive the quick
 * chips, the sheet and the zero-results undo. An in-flight request is aborted
 * when the state moves on. Every answer is kept as a page snapshot (with every
 * page «عرض المزيد» loaded), so coming back paints the same list at the same
 * length at once — which is what lets the app restore the scroll offset — and
 * the refresh behind it keeps the extra pages.
 */
export function useListing(category: string | null) {
  const location = useLocation();
  const navigate = useNavigate();
  const state = useMemo(() => parseListing(location.search), [location.search]);

  const commit = useCallback(
    (next: ListingState) => {
      const qs = serializeListing(next);
      navigate({ search: qs ? `?${qs}` : '' }, { replace: true });
    },
    [navigate]
  );

  const query = useMemo(
    () => listingApiQuery(state, { category: category ?? undefined, limit: PAGE_SIZE, facets: true }),
    [state, category]
  );
  const cacheKey = `listing:${query}`;

  const [data, setData] = useState<ListingSnapshot | null>(() => readPageCache<ListingSnapshot>(cacheKey));
  const [loading, setLoading] = useState(!data);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const [more, setMore] = useState<'idle' | 'loading' | 'error'>('idle');
  const current = useRef(cacheKey);
  current.current = cacheKey;

  useEffect(() => {
    const snap = readPageCache<ListingSnapshot>(cacheKey);
    if (snap) setData(snap);
    setLoading(true);
    setError(null);
    setMore('idle');
    const ctrl = new AbortController();
    api
      .get<ProductsListResponse>(`/api/products?${query}`, { signal: ctrl.signal })
      .then((res) => {
        const fresh = res.products ?? [];
        // Keep the pages «عرض المزيد» had loaded, so the list keeps its length.
        const seen = new Set(fresh.map((p) => p.id));
        const extra = snap && snap.products.length > fresh.length ? snap.products.slice(fresh.length).filter((p) => !seen.has(p.id)) : [];
        const next: ListingSnapshot = {
          products: [...fresh, ...extra],
          total: typeof res.total === 'number' ? res.total : fresh.length,
          truncated: !!res.truncated,
          facets: res.facets ?? null,
        };
        setData(next);
        writePageCache(cacheKey, next);
      })
      .catch((e) => {
        if (isAborted(e) || ctrl.signal.aborted) return;
        // A snapshot on screen is a real answer for this exact list.
        if (!snap) setError(e);
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [cacheKey, query, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const loadMore = useCallback(async () => {
    if (!data) return;
    const key = cacheKey;
    setMore('loading');
    try {
      // `sort` is sent explicitly: it keeps the request on the listing path
      // (and its order) even when every filter is off.
      const q = listingApiQuery(state, { category: category ?? undefined, limit: PAGE_SIZE, offset: data.products.length });
      const res = await api.get<ProductsListResponse>(`/api/products?${q}${/(^|&)sort=/.test(q) ? '' : `&sort=${state.sort}`}`);
      if (current.current !== key) return;
      setData((have) => {
        if (!have) return have;
        const seen = new Set(have.products.map((p) => p.id));
        const next = { ...have, products: [...have.products, ...(res.products ?? []).filter((p) => !seen.has(p.id))] };
        writePageCache(key, next);
        return next;
      });
      setMore('idle');
    } catch {
      if (current.current === key) setMore('error');
    }
  }, [data, cacheKey, state, category]);

  return { state, commit, data, loading, error, retry, loadMore, more };
}
