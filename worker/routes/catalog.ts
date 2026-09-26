/**
 * THE CATEGORY MAP — `/api/catalog/tree` and `/api/catalog/:slug`
 * (docs/ux/CATALOG_DISCOVERY.md §5, §6, §11; IMPLEMENTATION_PLAN.md S1).
 *
 *   GET /api/catalog/tree     every active section that holds products, nested,
 *                             with roll-up counts and «متوفرة الآن» counts.
 *                             Viewer-independent: cached for everyone.
 *   GET /api/catalog/:slug    one section as a page: its path, its non-empty
 *                             children, shelves grouped in memory from ONE
 *                             product read, its brands and the sibling roots.
 *                             Cards are tier-priced, so only a signed-out
 *                             response is cached.
 *
 * ONE MEMBERSHIP RELATION, NO SECOND DEFINITION. Which products a section holds
 * comes from worker/lib/catalogMembership.ts (classification + placements, with
 * ancestors), exactly as the home strip and the listing count them, and every
 * card goes through `resolveProductCards` — the listing's own pricing path — so
 * a shelf can never quote a price the product page does not.
 *
 * NO COMPOUND-SELECT LADDERS, ≤ 100 PARAMETERS. Every list of ids is ONE
 * `json_each(?)` parameter; the membership CTE is three terms.
 */
import { Hono, type Context } from 'hono';
import type { AppContext } from '../lib/types';
import { HttpError, str } from '../lib/http';
import {
  buildTree,
  catalogIdForRetiredSlug,
  indexCatalogs,
  loadCatalogRecords,
  loadMemberships,
  membershipByProduct,
  planShelves,
  rollUpCounts,
  treeNode,
  visibleChildren,
  type CatalogIndex,
  type ShelfCandidate,
} from '../lib/catalogPresentation';
import { pricingCtx, resolveProductCards } from './products';
import { safeParse } from '../lib/types';
import type { CatalogTreeNode, CategoryPayload } from '@levonis/catalog/discoveryTypes';

export const catalogRoutes = new Hono<AppContext>();

/**
 * How many products the tree resolves to count «متوفرة الآن». Availability is
 * proved over each product's option graph (the card's `direct_stock_available`),
 * which is not a column; past this many the count is reported as `null` —
 * unknown — rather than estimated. The shop has 14.
 */
export const TREE_AVAILABILITY_CAP = 1000;
/** The products one category page reads (§11: "cap 200"). Counts stay exact. */
export const CATEGORY_PAGE_CAP = 200;

const TREE_CACHE = 'public, max-age=60, s-maxage=300';
const PAGE_CACHE_SIGNED_OUT = 'public, max-age=60';

/** The Workers Cache API, or null (node tests, a runtime without it). */
function edgeCache(): Cache | null {
  return typeof caches !== 'undefined' ? ((caches as unknown as { default?: Cache }).default ?? null) : null;
}

const treeCacheKey = (url: string) => new Request(new URL('/api/catalog/tree', url).toString(), { method: 'GET' });

/**
 * Drop the cached tree after a taxonomy write — called by the admin taxonomy
 * routes. Per-colo, like every Cache API delete (worker/lib/productDeletion.ts
 * says the same of `/files/*`): other colos age out within `s-maxage`.
 */
export async function purgeCatalogTreeCache(requestUrl: string): Promise<void> {
  const cache = edgeCache();
  if (!cache) return;
  try {
    await cache.delete(treeCacheKey(requestUrl));
  } catch (e) {
    console.error('catalog tree cache purge failed (it expires within 300 s):', e instanceof Error ? e.message : e);
  }
}

async function cached(c: Context<AppContext>, key: Request, cacheControl: string, build: () => Promise<Response>) {
  const cache = edgeCache();
  if (cache) {
    const hit = await cache.match(key).catch(() => undefined);
    if (hit) return hit;
  }
  const res = await build();
  if (res.status === 200) {
    res.headers.set('Cache-Control', cacheControl);
    if (cache) {
      const put = cache.put(key, res.clone()).catch(() => undefined);
      try {
        c.executionCtx.waitUntil(put);
      } catch {
        await put;
      }
    }
  }
  return res;
}

/** Ids of active, non-composition products with direct units available now. */
async function availableProductIds(
  c: Context<AppContext>,
  ids: string[],
  idx: CatalogIndex
): Promise<Set<string> | null> {
  if (ids.length === 0) return new Set();
  if (ids.length > TREE_AVAILABILITY_CAP) return null;
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM products WHERE status = 'active' AND composition = '' AND id IN (SELECT value FROM json_each(?))`
  )
    .bind(JSON.stringify(ids))
    .all<Record<string, unknown>>();
  const cards = await resolveProductCards(c.env.DB, results ?? [], await pricingCtx(c), idx);
  const out = new Set<string>();
  for (const [id, card] of cards) if (Number(card.direct_stock_available ?? 0) > 0) out.add(id);
  return out;
}

catalogRoutes.get('/tree', (c) =>
  cached(c, treeCacheKey(c.req.url), TREE_CACHE, async () => {
    const [records, memberships] = await Promise.all([loadCatalogRecords(c.env.DB), loadMemberships(c.env.DB)]);
    const idx = indexCatalogs(records);
    const byProduct = membershipByProduct(memberships, idx);
    const available = await availableProductIds(c, [...byProduct.keys()], idx);
    const counts = rollUpCounts(byProduct, available);
    const roots = buildTree(idx, counts, available !== null);
    // Totals over what the explorer SHOWS: products under an active root.
    const shownRoots = new Set(roots.map((r) => r.id));
    let products = 0;
    let avail = 0;
    for (const [pid, catalogs] of byProduct) {
      if (![...catalogs].some((id) => shownRoots.has(id))) continue;
      products += 1;
      if (available?.has(pid)) avail += 1;
    }
    return c.json({ success: true, roots, totals: { products, available: available ? avail : null } });
  })
);

const notFoundCategory = () =>
  new HttpError(404, 'هذه الفئة غير موجودة. / This category does not exist.', 'CATALOG_NOT_FOUND');

catalogRoutes.get('/:slug', async (c) => {
  const slug = str(c.req.param('slug'), 'slug', { max: 80 });
  const user = c.get('user');
  const build = async (): Promise<Response> => {
    const [records, memberships] = await Promise.all([loadCatalogRecords(c.env.DB), loadMemberships(c.env.DB)]);
    const idx = indexCatalogs(records);
    // SLUG FIRST (the URL's own word), then the id (an old `?category=<id>`
    // link), then a slug the admin renamed away from — which is answered with
    // `moved: true` so the page can `replace` to the canonical path.
    let record = idx.bySlug.get(slug) ?? idx.byId.get(slug) ?? null;
    let moved = false;
    if (!record) {
      const retired = await catalogIdForRetiredSlug(c.env.DB, slug);
      record = retired ? idx.byId.get(retired) ?? null : null;
      moved = record !== null;
    }
    if (!record) throw notFoundCategory();

    const byProduct = membershipByProduct(memberships, idx);
    const memberIds = [...byProduct].filter(([, cats]) => cats.has(record!.id)).map(([pid]) => pid);
    // A section with nothing in it is not a page (§1 principle 4). An INACTIVE
    // section that still holds products renders — `catalogSubtreeFilter` does
    // not check `active` either, and a dead link over a full shelf is worse.
    if (memberIds.length === 0) throw notFoundCategory();

    const { results } = await c.env.DB.prepare(
      `SELECT * FROM products
        WHERE status = 'active' AND composition = '' AND id IN (SELECT value FROM json_each(?))
        ORDER BY display_order ASC, created_at DESC
        LIMIT ?`
    )
      .bind(JSON.stringify(memberIds), CATEGORY_PAGE_CAP)
      .all<Record<string, unknown>>();
    const rows = results ?? [];
    const ctx = await pricingCtx(c);
    const cards = await resolveProductCards(c.env.DB, rows, ctx, idx);
    const truncated = memberIds.length > rows.length;

    const availableIds = new Set([...cards].filter(([, card]) => Number(card.direct_stock_available ?? 0) > 0).map(([id]) => id));
    // Availability is exact only when every product of the subtree was read.
    const counts = rollUpCounts(byProduct, availableIds);
    const node = treeNode(record, idx, counts, !truncated);
    const children: CatalogTreeNode[] = visibleChildren(record, idx, counts, !truncated);
    node.children = children;

    const brandIds = [...new Set(rows.map((r) => String(r.brand_id ?? '')).filter(Boolean))];
    const brandRows = brandIds.length
      ? ((
          await c.env.DB.prepare('SELECT id, slug, name_ar, name_en, name_ckb FROM brands WHERE id IN (SELECT value FROM json_each(?))')
            .bind(JSON.stringify(brandIds))
            .all<{ id: string; slug: string; name_ar: string; name_en: string; name_ckb: string }>()
        ).results ?? [])
      : [];

    const items: ShelfCandidate[] = rows.map((r, i) => {
      const id = String(r.id);
      const card = cards.get(id) ?? {};
      const specs = safeParse<Record<string, unknown>>(String(r.spec_fields ?? '{}'), {});
      return {
        id,
        card,
        available: Math.max(0, Number(card.direct_stock_available ?? 0) || 0),
        brandId: r.brand_id ? String(r.brand_id) : null,
        catalogs: byProduct.get(id) ?? new Set<string>(),
        specs: specs && typeof specs === 'object' && !Array.isArray(specs) ? specs : {},
        rank: i,
      };
    });
    const plan = planShelves({
      node,
      children,
      items,
      total: node.product_count,
      brands: new Map(brandRows.map((b) => [b.id, b])),
    });

    const branch = idx.branch(record.id).slice().reverse();
    const ownRoot = branch[0]?.id;
    const related = buildTree(idx, counts, !truncated)
      .filter((r) => r.id !== ownRoot)
      .map((r) => ({ ...r, children: [] }));

    const payload: CategoryPayload<Record<string, unknown>> = {
      success: true,
      node,
      path: branch.map((b) => ({ id: b.id, slug: b.slug, name_ar: b.name_ar, name_en: b.name_en, name_ckb: b.name_ckb, path: idx.path(b.id) })),
      moved,
      layout: plan.layout,
      children,
      shelves: plan.shelves,
      brands: plan.brands,
      related,
      truncated,
    };
    return c.json(payload);
  };

  if (user) {
    const res = await build();
    res.headers.set('Cache-Control', 'private, no-store');
    return res;
  }
  // The key is the PATH alone: a query string changes nothing here, so letting
  // it into the key would only let anyone mint unbounded cache entries.
  const u = new URL(c.req.url);
  return cached(c, new Request(`${u.origin}${u.pathname}`, { method: 'GET' }), PAGE_CACHE_SIGNED_OUT, build);
});
