/**
 * CATALOG DISCOVERY — THE THREE READS AND THEIR SNAPSHOTS.
 *
 *   GET /api/catalog/tree        the map (explorer, listing headers)
 *   GET /api/catalog/:slug       one category page
 *   GET /api/products?sort=available&limit=50
 *                                a pool of cards to borrow photographs from,
 *                                for banners and tiles that have none of
 *                                their own
 *
 * Every successful answer is kept in src/lib/pageCache.ts, keyed by what was
 * asked, so «back» paints the last answer at once while the request refreshes
 * it (the pattern of Home.tsx and Products.tsx). The prefetch helpers
 * (./prefetch.ts) warm the same keys, so a tap that was preceded by a
 * `pointerdown` finds its data already there.
 *
 * The tree is viewer-independent and cached by the Worker for everyone; a
 * category page is tier-priced, so its snapshot is only ever this tab's own.
 *
 * STARTED EARLY, TAKEN HERE. The tree and a department are often already in
 * flight when the page asks — started by src/lib/bootFetch.ts with the entry
 * script on a cold load, or on the press of the link that led here — so a
 * loader first takes that request (once), and every caller asking while it
 * settles shares it: the page and a door's prefetch never make two.
 */
import { api, ApiError, fetchGradedStock, type ApiProduct, type RequestOptions } from '../api';
import { photoOf, type PhotoCandidate } from './explorerModel';
import { CATALOG_TREE_PATH, takePrimedJson } from '../bootFetch';
import { readPageCache, writePageCache } from '../pageCache';
import type { CatalogTreeResponse, CategoryPayload } from './types';

const opening = new Map<string, Promise<unknown>>();

/** The request already started for `path` when there is one (taken once, shared while it settles), else a GET. */
function openingGet<T>(path: string, opts?: RequestOptions): Promise<T> {
  const shared = opening.get(path);
  if (shared) return shared as Promise<T>;
  const primed = takePrimedJson<T>(path, opts?.mascot);
  if (!primed) return api.get<T>(path, opts);
  const settled: Promise<T> = primed.finally(() => {
    if (opening.get(path) === settled) opening.delete(path);
  });
  opening.set(path, settled);
  return settled;
}

export const TREE_KEY = 'catalog:tree';
/** The tree is the shop's taxonomy — it moves when the admin edits it, not per visit. */
export const TREE_TTL_MS = 5 * 60_000;
export const categoryKey = (slug: string) => `catalog:page:${slug}`;
export const PHOTO_POOL_KEY = 'catalog:photo-pool';

export function cachedTree(): CatalogTreeResponse | null {
  return readPageCache<CatalogTreeResponse>(TREE_KEY, TREE_TTL_MS);
}

export async function loadTree(opts?: RequestOptions): Promise<CatalogTreeResponse> {
  const data = await openingGet<CatalogTreeResponse>(CATALOG_TREE_PATH, opts);
  writePageCache(TREE_KEY, data);
  return data;
}

export function cachedCategory(slug: string): CategoryPayload | null {
  return readPageCache<CategoryPayload>(categoryKey(slug));
}

export async function loadCategory(slug: string, opts?: RequestOptions): Promise<CategoryPayload> {
  const data = await openingGet<CategoryPayload>(`/api/catalog/${encodeURIComponent(slug)}`, opts);
  writePageCache(categoryKey(slug), data);
  return data;
}

export function cachedPhotoPool(): ApiProduct[] | null {
  return readPageCache<ApiProduct[]>(PHOTO_POOL_KEY, TREE_TTL_MS);
}

/**
 * Cards to borrow photographs from, available-now first. Silent: it decorates
 * a page that is already drawn, so the character does not act it out.
 */
export async function loadPhotoPool(): Promise<ApiProduct[]> {
  const hit = cachedPhotoPool();
  if (hit) return hit;
  const data = await api.get<{ products?: ApiProduct[] }>('/api/products?sort=available&limit=50', { mascot: 'silent' });
  const pool = Array.isArray(data.products) ? data.products : [];
  writePageCache(PHOTO_POOL_KEY, pool);
  return pool;
}

/** The home's graded shelf, counted: how many (≤ 12) and one photograph. */
export interface GradedSummary {
  count: number;
  photo: { src: string; product_id: string } | null;
}

/**
 * «المستعمل» on the explorer: `GET /api/home/graded` — the two facts the
 * banner draws, instead of the whole /api/home (10 KB on the wire, 47 KB of
 * JSON) it used to read them from. A Worker older than that answer (a 404)
 * is asked the old way.
 */
export async function loadGradedSummary(): Promise<GradedSummary> {
  try {
    const d = await api.get<Partial<GradedSummary>>('/api/home/graded', { mascot: 'silent' });
    const photo = d.photo && typeof d.photo.src === 'string' && d.photo.src ? { src: d.photo.src, product_id: String(d.photo.product_id ?? '') } : null;
    return { count: Number(d.count) > 0 ? Number(d.count) : 0, photo };
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 404) throw e;
    const used = await fetchGradedStock({ mascot: 'silent' });
    const first = used.find((p) => photoOf(p as PhotoCandidate));
    return { count: used.length, photo: first ? { src: photoOf(first as PhotoCandidate), product_id: first.id } : null };
  }
}

/** One section's own cards, for a banner the shared pool did not cover. */
export async function loadSectionPhotos(categoryId: string): Promise<ApiProduct[]> {
  const key = `${PHOTO_POOL_KEY}:${categoryId}`;
  const hit = readPageCache<ApiProduct[]>(key, TREE_TTL_MS);
  if (hit) return hit;
  const data = await api.get<{ products?: ApiProduct[] }>(
    `/api/products?category=${encodeURIComponent(categoryId)}&sort=available&limit=4`,
    { mascot: 'silent' }
  );
  const list = Array.isArray(data.products) ? data.products : [];
  writePageCache(key, list);
  return list;
}
