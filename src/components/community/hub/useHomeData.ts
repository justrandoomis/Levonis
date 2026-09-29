/**
 * THE ISSUE'S FIRST PAGES — every section of «لك» but the feed, read together.
 *
 * Each section is its own request and its own failure: a rail whose read
 * failed is null and hides itself (WorksRail's rule), the others still show.
 * The composite is remembered in the page cache (`community:home`,
 * src/lib/pageCache.ts) so Back paints the issue at once and corrects it
 * from the network; and memoised for two minutes in this module so «لك» and
 * «أتابعهم» — which share the rails — never ask twice.
 *
 * THE TRENDING PICTURE IS PART OF THE COMPOSITE (Phase 3): the one edge-cached
 * /trending read (search/api.ts, memoised five minutes) gives the «وسوم
 * رائجة» row, the makers and stores rails (ranked by the last 30 days' likes,
 * orders and follows) and the directory's count for the colophon. The
 * featured reads are asked only when trending has nothing to say, so the
 * issue is laid out once, with the cover — no row arrives later and pushes
 * the first section down, no section renumbers itself after first paint.
 */
import { useEffect, useState } from 'react';
import { readPageCache, writePageCache } from '../../../lib/pageCache';
import { projectsApi, type PostCard } from '../projects/api';
import { socialApi, type CreatorCard } from '../social/api';
import { searchApi, type Trending, type TrendingTag } from '../search/api';
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
  /** «وسوم رائجة» — the last 30 days' tags; null when the read failed, [] when there are none. */
  tags: TrendingTag[] | null;
  /** The whole community's counts, for the colophon; null when unknown. */
  totals: { projects: number | null; merchants: number | null };
}

const KEY = 'community:home';

const orNull = <T,>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

/** Shops that take custom requests first — that is why many come here — then the server's order. */
const requestsFirst = (rows: CommunityStore[]) => [...rows].sort((a, b) => Number(!!b.accepts_custom_requests) - Number(!!a.accepts_custom_requests));

/** The makers rail: trending's when it has rows, else the featured read. */
async function creatorsFrom(hot: Trending | null): Promise<CreatorCard[] | null> {
  if (hot && hot.creators.length > 0) return hot.creators;
  const featured = await orNull(socialApi.creators({ featured: true }, null, 6));
  return featured?.creators ?? null;
}

/** The stores rail and the directory's count: trending's when it has rows, else the featured read (which carries the count). */
async function merchantsFrom(hot: Trending | null): Promise<{ rows: CommunityStore[] | null; total: number | null }> {
  if (hot && hot.stores.length > 0) {
    if (hot.totals.merchants !== null) return { rows: hot.stores, total: hot.totals.merchants };
    // An older server's trending said nothing about the count: one small read for the colophon.
    const counted = await orNull(communityHubApi.few.merchants(1));
    return { rows: hot.stores, total: counted?.total ?? null };
  }
  const featured = await orNull(communityHubApi.few.merchants(6));
  return { rows: featured ? requestsFirst(featured.rows) : null, total: featured?.total ?? null };
}

async function fetchHome(): Promise<HomeData> {
  const hot = orNull(searchApi.trending());
  const [trending, requests, creators, merchants, works, products, posts, tags] = await Promise.all([
    orNull(projectsApi.trending(8)),
    orNull(communityHubApi.few.requests(3)),
    hot.then(creatorsFrom),
    hot.then(merchantsFrom),
    orNull(loadCommunityWorks()),
    orNull(communityHubApi.few.products(6)),
    orNull(projectsApi.list({}, null, 1)),
    hot.then((t) => t?.tags ?? null),
  ]);
  return {
    trending,
    requests: requests?.rows ?? null,
    creators,
    merchants: merchants.rows,
    works,
    products: products?.rows ?? null,
    tags,
    totals: { projects: posts?.total ?? null, merchants: merchants.total },
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
    // A composite cached before the tags joined it still paints: they are simply not yet known.
    return hit && hit.viewer === viewer ? { viewer, data: { ...hit.data, tags: hit.data.tags ?? null }, stale: true } : { viewer, data: null, stale: false };
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
