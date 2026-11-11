/**
 * THE IMPORT'S RECOMPUTE AND PURGE (Bambu import spec §A.3 `/publish-finish`,
 * `event BLOCKED`; §I.1.9).
 *
 * After a write — and after an unpublish or a republish — the products whose
 * answers changed are:
 *
 *   - the product itself;
 *   - every product whose relations this write changed: the products whose
 *     pending relation named this product's handle and now resolves to it
 *     (their pages list it, their printer fits may have grown, §B.6).
 *
 * For them, `recomputeMany` (catalog-only's completeness, a read-then-write that
 * cannot sit in the write's batch) and then a purge, per colo, on the request's
 * origin and the root domain:
 *
 *   - `cataloguePaths(slugs)`: the home, the listing, each product page, the
 *     public API's list and records, the sitemap (worker/lib/edgePolicy.ts);
 *   - `/api/products/<slug>/knowledge` for each slug, named here explicitly;
 *   - the catalogue tree (`purgeCatalogTreeCache`);
 *   - `/api/catalog/<section>` for each section the products sit in, and each
 *     ancestor of it (a middle section lists the product too), and beside it
 *     `/api/catalog/<section>/counts` — the counts a listing page lays over its
 *     rows (DECISIONS row 311), named as the storefront asks for them: by slug,
 *     or by id for a slug too long to ask by (`listingCategoryKey`). Both are
 *     `sectionCachePath`, the very path the routes key their copy under;
 *   - the public v1 keys of `/products/<slug>` and `/sections/<section>` (the
 *     same sections, ancestors included), built
 *     by `publicV1PurgeKeys` exactly as `serve` stores them.
 *
 * Best effort, like every purge of the codebase: a failed delete is logged and
 * the entry ages out within its s-maxage; the runner's cache rule (§I.1.9)
 * calls `/publish-finish` again before it waits.
 */
import type { Env } from '../types';
import { cataloguePaths, purgeAnonymousCache } from '../edgePolicy';
import { edgeCache } from '../publicApi/cache';
import { rootDomainFrom } from '../hosts';
import { completenessInstalled } from '../listing';
import { recomputeMany } from '../productCompleteness';
import { listingCategoryKey, purgeCatalogTreeCache, sectionCachePath } from '../../routes/catalog';
import { publicV1PurgeKeys } from '../../routes/publicApi';

/** At most this many related products are recomputed and purged in one call (the invocation budget). */
export const RELATED_MAX = 40;

export interface PurgePlan {
  productIds: string[];
  slugs: string[];
  sections: string[];
  paths: string[];
}

/** The product and the products whose relations now resolve to it. */
export async function affectedProducts(db: D1Database, productId: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT product_id FROM product_relations
        WHERE target_product_id = ? AND state = 'resolved' AND product_id <> ? ORDER BY product_id LIMIT ${RELATED_MAX}`
    )
    .bind(productId, productId)
    .all<{ product_id: string }>();
  return [productId, ...(results ?? []).map((r) => String(r.product_id))];
}

/** Slugs and section slugs of the products, and the paths a purge drops. */
export async function purgePlan(db: D1Database, productIds: readonly string[]): Promise<PurgePlan> {
  const ids = JSON.stringify([...new Set(productIds)]);
  const { results: products } = await db
    .prepare(
      `SELECT p.slug AS slug, c.slug AS root, s.slug AS leaf FROM products p
         LEFT JOIN catalogs c ON c.id = p.category_id LEFT JOIN catalogs s ON s.id = p.sub_category_id
        WHERE p.id IN (SELECT value FROM json_each(?))`
    )
    .bind(ids)
    .all<{ slug: string; root: string | null; leaf: string | null }>();
  // Every section the products sit in AND every ancestor of it: a three-level placement (refurbished printers
  // under fdm-printers under printers) is listed by the middle section's page too, through membership with
  // ancestors (catalogPresentation.ts), so its page and its v1 record are purged as well.
  const { results: members } = await db
    .prepare(
      `WITH RECURSIVE seed(id) AS (
         SELECT catalog_id FROM product_catalogs WHERE product_id IN (SELECT value FROM json_each(?1))
         UNION SELECT category_id FROM products WHERE id IN (SELECT value FROM json_each(?1)) AND category_id IS NOT NULL
         UNION SELECT sub_category_id FROM products WHERE id IN (SELECT value FROM json_each(?1)) AND sub_category_id IS NOT NULL
       ), up(id, depth) AS (
         SELECT id, 0 FROM seed
         UNION SELECT c.parent_id, up.depth + 1 FROM catalogs c JOIN up ON c.id = up.id WHERE c.parent_id IS NOT NULL AND up.depth < 12
       )
       SELECT DISTINCT c.id AS id, c.slug AS slug FROM up JOIN catalogs c ON c.id = up.id`
    )
    .bind(ids)
    .all<{ id: string; slug: string }>();
  const slugs = [...new Set((products ?? []).map((p) => String(p.slug ?? '')).filter(Boolean))];
  const sections = [
    ...new Set(
      [...(products ?? []).flatMap((p) => [p.root, p.leaf]), ...(members ?? []).map((m) => m.slug)].map((s) => String(s ?? '')).filter(Boolean)
    ),
  ];
  // Each section's page by its slug, as the storefront asks for it; its counts by its slug and, for a slug too
  // long to ask by, by its id — the listing page asks them by `listingCategory`, which `listingCategoryKey` mirrors.
  const countsAskedAs = (members ?? []).map((m) => listingCategoryKey({ id: String(m.id ?? ''), slug: String(m.slug ?? '') })).filter(Boolean);
  const paths = [
    ...cataloguePaths(slugs),
    ...slugs.map((s) => `/api/products/${s}/knowledge`),
    ...new Set([
      ...sections.flatMap((s) => [sectionCachePath(s, 'page'), sectionCachePath(s, 'counts')]),
      ...countsAskedAs.map((k) => sectionCachePath(k, 'counts')),
    ]),
  ];
  return { productIds: [...new Set(productIds)], slugs, sections, paths };
}

/** The origins a purge drops: the request's own and the root domain's. */
export function purgeOrigins(env: Pick<Env, 'STORE_ROOT_DOMAIN' | 'APP_ORIGIN'>, requestUrl: string): string[] {
  const out = new Set<string>();
  try {
    out.add(`https://${new URL(requestUrl).host.toLowerCase()}`);
  } catch {
    // no request origin: the root domain alone
  }
  const root = rootDomainFrom(env);
  if (root) out.add(`https://${root}`);
  return [...out];
}

/** Drops every cached answer of the plan on every origin. Never throws. */
export async function purgeImported(env: Pick<Env, 'STORE_ROOT_DOMAIN' | 'APP_ORIGIN'>, requestUrl: string, plan: PurgePlan): Promise<{ origins: number; paths: number; keys: number }> {
  const origins = purgeOrigins(env, requestUrl);
  let keys = 0;
  for (const origin of origins) {
    try {
      await purgeAnonymousCache(origin, plan.paths);
      await purgeCatalogTreeCache(`${origin}/`);
      const v1 = publicV1PurgeKeys(origin, { products: plan.slugs, sections: plan.sections });
      keys += v1.length;
      const cache = edgeCache();
      if (cache) await Promise.all(v1.map((k) => cache.delete(k).catch(() => false)));
    } catch (e) {
      console.error('catalog_import_purge_failed', JSON.stringify({ code: 'IMPORT_PURGE_FAILED', reason: e instanceof Error ? e.name : 'unknown' }));
    }
  }
  return { origins: origins.length, paths: plan.paths.length, keys };
}

/**
 * catalog-only's completeness for the products, then the purge. The recompute is skipped on a database
 * without the completeness table (the deploy-ahead rule); its failure is logged, never the call's.
 */
export async function recomputeAndPurge(
  env: Pick<Env, 'DB' | 'STORE_ROOT_DOMAIN' | 'APP_ORIGIN'>,
  requestUrl: string,
  productIds: readonly string[]
): Promise<{ recomputed: number; flipped: number; plan: PurgePlan }> {
  let recomputed = 0;
  let flipped = 0;
  try {
    if (await completenessInstalled(env.DB)) {
      const r = await recomputeMany(env.DB, productIds);
      recomputed = r.verdicts.length;
      flipped = r.flipped.length;
    }
  } catch (e) {
    console.error('catalog_import_recompute_failed', JSON.stringify({ code: 'IMPORT_RECOMPUTE_FAILED', reason: e instanceof Error ? e.name : 'unknown' }));
  }
  const plan = await purgePlan(env.DB, productIds);
  await purgeImported(env, requestUrl, plan);
  return { recomputed, flipped, plan };
}
