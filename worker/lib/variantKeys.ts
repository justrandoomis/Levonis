/**
 * WHERE THE SMALL COPIES OF A PICTURE LIVE IN R2 — the key layout alone, with
 * no imports, so the one delete door (worker/lib/mediaStorage.ts
 * `deleteMediaObject`) can cascade to a picture's copies without importing
 * the code that makes them (worker/lib/imageVariants.ts).
 *
 *   variants/v1/<original key>/w640.avif
 *   variants/v1/<original key>/w640.webp
 *   variants/v1/<original key>/done          (the sweep made every AVIF rung)
 *   variants/_state/sweep-v1.json            (the sweep's cursor)
 *
 * All copies of one picture share one prefix, so deleting them is one list
 * and one delete. `v1` is `VARIANT_STORE_VERSION`: raising it (after a quality
 * change) makes new copies lazily, and the sweep deletes the old prefix.
 *
 * NOT A PUBLIC ADDRESS. `variants/` is deliberately absent from
 * `isAnonymousPublicMediaKey`, and `GET /files/variants/…` answers 404 before
 * anything else (worker/routes/uploads.ts): a copy has exactly one public
 * address, `/files/<original>?w=`, which is only answered after the ORIGINAL
 * passed the public check. So a copy can only ever be derived from a public
 * picture, and nobody can list or address copies directly.
 */
export const VARIANT_STORE_VERSION = 1;
export const VARIANT_ROOT = 'variants/';
export const VARIANT_SWEEP_STATE_KEY = 'variants/_state/sweep-v1.json';

export const isVariantStoreKey = (key: string): boolean => key.startsWith(VARIANT_ROOT);

export function variantPrefix(key: string, version: number = VARIANT_STORE_VERSION): string {
  return `${VARIANT_ROOT}v${version}/${key}/`;
}

export function variantObjectKey(key: string, width: number, extension: string, version: number = VARIANT_STORE_VERSION): string {
  return `${variantPrefix(key, version)}w${width}.${extension}`;
}

export function variantDoneKey(key: string, version: number = VARIANT_STORE_VERSION): string {
  return `${variantPrefix(key, version)}done`;
}

/** The formats a copy can be answered in, as the edge-cache key spells them (`f=`). */
export const VARIANT_EDGE_FORMATS = ['avif', 'webp', 'jpeg', 'png'] as const;

/**
 * THE URL THE EDGE CACHE FILES ONE COPY UNDER (worker/routes/uploads.ts
 * `imageVariantCacheKey` builds its key with this): `/files/<key>?w=&f=&v=`,
 * plus `__edge=<generation>` for a key rewritten in place. `legacy` is the
 * shape the route used before copies were kept in R2 — no `v` — which the
 * data centres still hold for a year: the route answers from it while the
 * new copy is being made, and a delete drops it too.
 */
export function variantEdgeUrl(
  origin: string,
  key: string,
  width: number,
  format: string,
  options: { legacy?: boolean; generation?: string | null } = {}
): string {
  const url = new URL(`${origin.replace(/\/+$/, '')}/files/${key}`);
  url.searchParams.set('w', String(width));
  url.searchParams.set('f', format);
  if (!options.legacy) url.searchParams.set('v', String(VARIANT_STORE_VERSION));
  if (options.generation) url.searchParams.set('__edge', options.generation);
  return url.toString();
}

/**
 * Delete every stored copy of `key` — every store version up to the current
 * one — from `bucket`. Returns how many objects went. A bucket double without
 * `list` (some route tests) has no copies to delete. Errors propagate: a
 * caller told a picture is gone must not keep serving its copies.
 */
export async function deleteVariantsIn(bucket: R2Bucket | null | undefined, key: string): Promise<number> {
  if (!bucket || typeof (bucket as Partial<R2Bucket>).list !== 'function') return 0;
  let removed = 0;
  for (let version = 1; version <= VARIANT_STORE_VERSION; version++) {
    const prefix = variantPrefix(key, version);
    let cursor: string | undefined;
    do {
      const page = await bucket.list({ prefix, cursor, limit: 1000 });
      const keys = (page.objects ?? []).map((object) => object.key).filter((k) => k.startsWith(prefix));
      if (keys.length) {
        await bucket.delete(keys);
        removed += keys.length;
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  return removed;
}
