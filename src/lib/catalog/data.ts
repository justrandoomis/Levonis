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
 */
import { api, type ApiProduct, type RequestOptions } from '../api';
import { readPageCache, writePageCache } from '../pageCache';
import type { CatalogTreeResponse, CategoryPayload } from './types';

export const TREE_KEY = 'catalog:tree';
/** The tree is the shop's taxonomy — it moves when the admin edits it, not per visit. */
export const TREE_TTL_MS = 5 * 60_000;
export const categoryKey = (slug: string) => `catalog:page:${slug}`;
export const PHOTO_POOL_KEY = 'catalog:photo-pool';

export function cachedTree(): CatalogTreeResponse | null {
  return readPageCache<CatalogTreeResponse>(TREE_KEY, TREE_TTL_MS);
}

export async function loadTree(opts?: RequestOptions): Promise<CatalogTreeResponse> {
  const data = await api.get<CatalogTreeResponse>('/api/catalog/tree', opts);
  writePageCache(TREE_KEY, data);
  return data;
}

export function cachedCategory(slug: string): CategoryPayload | null {
  return readPageCache<CategoryPayload>(categoryKey(slug));
}

export async function loadCategory(slug: string, opts?: RequestOptions): Promise<CategoryPayload> {
  const data = await api.get<CategoryPayload>(`/api/catalog/${encodeURIComponent(slug)}`, opts);
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
