/**
 * THE ISSUE'S FIRST PAGES — every section of «لك» but the feed, read together.
 *
 * Each section is its own request and its own failure: a rail whose read
 * failed is null and hides itself (WorksRail's rule), the others still show.
 * The composite is remembered in the page cache (`community:home`,
 * src/lib/pageCache.ts) so Back paints the issue at once and corrects it
 * from the network; and memoised for two minutes in this module so «لك» and
 * «أتابعهم» — which share the rails — never ask twice.
 */
import { useEffect, useState } from 'react';
import { readPageCache, writePageCache } from '../../../lib/pageCache';
import { projectsApi, type PostCard } from '../projects/api';
import { socialApi, type CreatorCard } from '../social/api';
import { communityHubApi, type CommunityProduct, type CommunityRequest, type CommunityStore, type CommunityWork } from './api';
import { FRESH_MS, homeGeneration } from './feedCache';
export { forgetHome } from './feedCache';
import { loadCommunityWorks } from './useCommunityFeed';

export interface HomeData {
  trending: PostCard[] | null;
  requests: CommunityRequest[] | null;
  creators: CreatorCard[] | null;
  merchants: CommunityStore[] | null;
  works: CommunityWork[] | null;
  products: CommunityProduct[] | null;
  /** The whole community's counts, for the colophon; null when unknown. */
  totals: { projects: number | null; merchants: number | null };
}

const KEY = 'community:home';

const orNull = <T,>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

/** Shops that take custom requests first — that is why many come here — then the server's order. */
const requestsFirst = (rows: CommunityStore[]) => [...rows].sort((a, b) => Number(!!b.accepts_custom_requests) - Number(!!a.accepts_custom_requests));

async function fetchHome(): Promise<HomeData> {
  const [trending, requests, creators, merchants, works, products, posts] = await Promise.all([
    orNull(projectsApi.trending(8)),
    orNull(communityHubApi.few.requests(3)),
    orNull(socialApi.creators({ featured: true }, null, 6)),
    orNull(communityHubApi.few.merchants(6)),
    orNull(loadCommunityWorks()),
    orNull(communityHubApi.few.products(6)),
    orNull(projectsApi.list({}, null, 1)),
  ]);
  return {
    trending,
    requests: requests?.rows ?? null,
    creators: creators?.creators ?? null,
    merchants: merchants ? requestsFirst(merchants.rows) : null,
    works,
    products: products?.rows ?? null,
    totals: { projects: posts?.total ?? null, merchants: merchants?.total ?? null },
  };
}

let memo: { viewer: string; gen: number; at: number; promise: Promise<HomeData> } | null = null;

function load(viewer: string): Promise<HomeData> {
  const gen = homeGeneration();
  if (memo && memo.viewer === viewer && memo.gen === gen && Date.now() - memo.at < FRESH_MS) return memo.promise;
  const promise = fetchHome().then((d) => {
    writePageCache(KEY, { viewer, data: d });
    return d;
  });
  memo = { viewer, gen, at: Date.now(), promise };
  return promise;
}

export function useHomeData(viewer: string): { data: HomeData | null; stale: boolean } {
  const [state, setState] = useState<{ viewer: string; data: HomeData | null; stale: boolean }>(() => {
    const hit = readPageCache<{ viewer: string; data: HomeData }>(KEY);
    return hit && hit.viewer === viewer ? { viewer, data: hit.data, stale: true } : { viewer, data: null, stale: false };
  });

  useEffect(() => {
    let alive = true;
    load(viewer).then((d) => {
      if (alive) setState({ viewer, data: d, stale: false });
    });
    return () => {
      alive = false;
    };
  }, [viewer]);

  const data = state.viewer === viewer ? state.data : null;
  return { data, stale: state.stale };
}
