/**
 * AFTER A CATALOGUE WRITE: RE-EVALUATE THE PRODUCT, PURGE IT WHEN IT FLIPPED
 * (owner brief 2026-10-10; worker/lib/productCompleteness.ts).
 *
 * Every admin door that writes a product — the product save, its relations,
 * the price grid, the TXT and CSV imports, the data file, the USD pricing
 * inputs — re-evaluates the products it touched once the write has answered,
 * so the red flags in «تعديل منتج» and the «ناقص N» badge describe the saved
 * product at once, and a product that just became complete (or incomplete
 * while the owner's switch is on) appears for (or disappears from) customers
 * without waiting for the quarter-hour sweep. A product whose visibility
 * flipped has its cached page, the listing and the home dropped
 * (`afterCatalogueWrite`).
 *
 * BEST EFFORT. A failure here never fails the write that triggered it (the
 * write has already committed and answered): it is logged and the sweep
 * re-evaluates the product within the quarter hour.
 */
import type { Context, MiddlewareHandler } from 'hono';
import type { AppContext } from './types';
import { afterCatalogueWrite, originOf, purgeAnonymousCache } from './edgePolicy';
import { rootDomainFrom } from './hosts';
import { recomputeMany } from './productCompleteness';
import { completenessInstalled } from './listing';

/** At most this many products re-evaluated after one request (two recompute chunks). */
export const AFTER_WRITE_MAX = 50;

/** Path segments under /api/admin/products(-v2)/ that are not a product id. */
const NOT_A_PRODUCT = new Set(['brands', 'catalogs', 'maintenance', 'recommended', 'consolidation', 'simulate', 'versions', 'completeness', 'printer-options', 'stats', 'save-bulk']);

/** Writes that store nothing (a preview, a what-if, a quote): nothing to re-evaluate. */
const READ_ONLY_POST = /\/(?:preview|what-if|quote)$/;

/** `/api/admin/products(-v2)/<id>/…` and `/api/admin/pricing/products/<id>/…` name a product. */
function productIdFromPath(c: Context<AppContext>): string | null {
  const path = new URL(c.req.url).pathname;
  const m = /\/api\/admin\/(?:products(?:-v2)?|pricing\/products)\/([^/?#]+)/.exec(path);
  const id = m?.[1] ? decodeURIComponent(m[1]) : null;
  return id && !NOT_A_PRODUCT.has(id) ? id : null;
}

/** The products one request touched: those the handler named, else the path's, else the slug's. */
async function touchedIds(c: Context<AppContext>): Promise<string[]> {
  const named = c.get('completenessIds');
  if (named && named.length) return [...new Set(named)];
  const fromPath = productIdFromPath(c);
  if (fromPath) return [fromPath];
  const slug = c.get('catalogueSlug');
  if (!slug) return [];
  const row = await c.env.DB.prepare('SELECT id FROM products WHERE slug = ?').bind(slug).first<{ id: string }>();
  return row?.id ? [String(row.id)] : [];
}

/**
 * Products whose customer visibility just changed: the listing, the home and
 * each product page (`afterCatalogueWrite`), and the public API's product list
 * and pages and the sitemap, on the request's host and the root domain. Best
 * effort per colo, like every seam: elsewhere they age out within `s-maxage`.
 */
export async function purgeVisibility(c: Context<AppContext>, slugs: readonly string[]): Promise<void> {
  const named = [...new Set(slugs.filter(Boolean))];
  await afterCatalogueWrite(c, named);
  const origins = new Set<string>([originOf(c)]);
  const root = rootDomainFrom(c.env);
  if (root) origins.add(`https://${root}`);
  const paths = ['/sitemap.xml', '/api/public/v1/products', ...named.map((s) => `/api/public/v1/products/${encodeURIComponent(s)}`)];
  await Promise.all([...origins].map((o) => purgeAnonymousCache(o, paths)));
}

/**
 * Re-evaluate `ids` and purge the pages (with the listing and the home) of
 * those whose customer visibility flipped. Never throws.
 */
export async function afterProductsChanged(c: Context<AppContext>, ids: readonly string[]): Promise<void> {
  try {
    if (!ids.length || !(await completenessInstalled(c.env.DB))) return;
    // Bounded (D1's statements per invocation): a large import re-evaluates its first
    // products here and leaves the rest to the quarter-hour sweep.
    const r = await recomputeMany(c.env.DB, [...new Set(ids)].slice(0, AFTER_WRITE_MAX));
    if (r.flipped.length) await purgeVisibility(c, r.flipped);
  } catch (error) {
    console.error('completeness recompute failed:', error instanceof Error ? error.name : 'unknown');
  }
}

/**
 * The router middleware: after a successful non-GET, re-evaluate what the
 * request touched. Registered AFTER `purgeCatalogueAfterWrite` where both are
 * mounted, so it runs first on the way out and a flip is in place before the
 * listing is purged.
 */
export const completenessAfterWrite: MiddlewareHandler<AppContext> = async (c, next) => {
  await next();
  if (c.req.method === 'GET' || c.req.method === 'HEAD' || c.req.method === 'OPTIONS') return;
  if (c.res.status >= 300) return;
  if (READ_ONLY_POST.test(new URL(c.req.url).pathname)) return;
  try {
    const ids = await touchedIds(c);
    if (ids.length) await afterProductsChanged(c, ids);
  } catch (error) {
    console.error('completeness hook failed:', error instanceof Error ? error.name : 'unknown');
  }
};
