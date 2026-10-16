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
import { withCacheEpoch } from '../lib/publicApi/cache';
import { completenessAbsentLately, listing, optimisticSellableFlag, runListed } from '../lib/listing';
import { membershipCte } from '../lib/catalogMembership';
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
import { pricingCtx, pricingCtxForUser, resolveProductCards, type PricingCtx } from './products';
import { safeParse } from '../lib/types';
import { cardLeadPhoto } from '../lib/cardPhoto';
import type { CatalogTreeNode, CategoryPayload } from '@levonis/catalog/discoveryTypes';

export const catalogRoutes = new Hono<AppContext>();

/** src/lib/bootFetch.ts CATALOG_LISTING_HEADER (a test holds them equal). */
export const CATALOG_LISTING_HEADER = 'X-Catalog-Listing';

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

const treeCacheKey = (url: string) => new Request(withCacheEpoch(new URL('/api/catalog/tree', url).toString()), { method: 'GET' });

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
    /**
     * A HIT LEAVES WITH THIS ROUTE'S LIFETIME, NOT THE ZONE'S. Cloudflare hands
     * a cached answer back with its `max-age` raised to the zone's Browser
     * Cache TTL — four hours on levonis-iq.com (seen live 2026-09-28:
     * `max-age=14400, s-maxage=300` on /api/catalog/tree). A visitor's browser
     * then kept the section map for hours after an admin changed it, and
     * `purgeCatalogTreeCache` clears the edge, never a browser.
     */
    if (hit) {
      const res = new Response(hit.body, hit);
      res.headers.set('Cache-Control', cacheControl);
      return res;
    }
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

/**
 * Ids of active, non-composition products with direct units available now —
 * and, while it read them, every one of those products in the order a banner
 * borrows a photograph in (available now, then priced, then the shop's own
 * order) with its card (for `assignTreePhotos`). Both null past the cap.
 */
async function availableProductIds(
  db: D1Database,
  ctxPromise: Promise<PricingCtx>,
  ids: string[],
  idx: CatalogIndex
): Promise<{ available: Set<string> | null; ordered: Array<{ id: string; card: Record<string, unknown> }> | null }> {
  if (ids.length === 0) return { available: new Set(), ordered: [] };
  if (ids.length > TREE_AVAILABILITY_CAP) return { available: null, ordered: null };
  // VISIBLE with each row's SELLABLE flag (DECISIONS row 240): a catalog-only card claims no stock.
  const L = await listing(db);
  const { results } = await db.prepare(
    `SELECT *, ${L.sellableFlag('products')} AS sellable_now FROM products WHERE ${L.visible('products')} AND composition = '' AND id IN (SELECT value FROM json_each(?))
      ORDER BY sellable_now DESC, display_order ASC, created_at DESC`
  )
    .bind(JSON.stringify(ids))
    .all<Record<string, unknown>>();
  const cards = await resolveProductCards(db, results ?? [], await ctxPromise, idx, 'flag');
  const out = new Set<string>();
  for (const [id, card] of cards) if (Number(card.direct_stock_available ?? 0) > 0) out.add(id);
  // A stable partition: available now first, each group in the SQL order.
  const ordered = [...cards].map(([id, card]) => ({ id, card }));
  ordered.sort((a, b) => Number(out.has(b.id)) - Number(out.has(a.id)));
  return { available: out, ordered };
}

// ----------------------------------------------------------- one photograph per section

/** A section's borrowed photograph on the map: a product's lead picture, and its light-theme twin. */
export interface TreePhoto {
  src: string;
  light_src?: string;
  product_id: string;
}

/**
 * ONE PHOTOGRAPH PER SECTION, ON THE MAP ITSELF (speed audit 2026-10-16: the
 * explorer's banners — the page's largest paint — waited for a 50-product
 * pool, 27 KB on the wire and 160 KB of JSON, after the 3 KB map).
 *
 * The explorer's rule (src/lib/catalog/explorerModel.ts `bannerRows`), per
 * group of sibling sections in the admin's order: the first product of the
 * section's subtree in `ordered` that has a photograph and that an earlier
 * sibling did not take; a product a sibling took only when the section has no
 * other. The client still prefers the admin's own banner, and a section with
 * no `photo` still borrows one the old way.
 */
export function assignTreePhotos(
  roots: CatalogTreeNode[],
  ordered: readonly string[],
  memberOf: (productId: string) => ReadonlySet<string> | undefined,
  photoOf: (productId: string) => { src: string; light?: string } | null
): void {
  const group = (nodes: CatalogTreeNode[]) => {
    const used = new Set<string>();
    for (const n of nodes) {
      let fresh: string | null = null;
      let taken: string | null = null;
      for (const id of ordered) {
        if (!memberOf(id)?.has(n.id) || !photoOf(id)) continue;
        if (!used.has(id)) {
          fresh = id;
          break;
        }
        taken ??= id;
      }
      const pick = fresh ?? taken;
      if (pick) {
        used.add(pick);
        const p = photoOf(pick)!;
        n.photo = { src: p.src, product_id: pick, ...(p.light ? { light_src: p.light } : {}) };
      }
      group(n.children ?? []);
    }
  };
  group(roots);
}

/** Past TREE_AVAILABILITY_CAP: how many products per section are read for their photograph. */
export const TREE_PHOTO_SHORTLIST = 3;

/**
 * THE PHOTOGRAPHS' SHORT LIST, IN THE MAP'S FIRST WAVE (speed review
 * 2026-10-16). Past TREE_AVAILABILITY_CAP no card is read for the counts, so
 * the photographs need cards of their own. They were found AFTER the
 * memberships — a short list, then its rows, then their cards: three
 * dependent round trips more than the bare map, paid by the first visitor of
 * each colo every five minutes once the Bambu import passed the cap.
 *
 * Now ONE statement leaves beside the catalogs and the memberships and
 * answers the rows themselves: the first TREE_PHOTO_SHORTLIST products of
 * every section a product is placed or classified in DIRECTLY, in the shop's
 * order (priced first, then `display_order`, then the newest), VISIBLE, each
 * with its SELLABLE flag. That covers every section's own first few, its
 * ancestors' included: a product among a section's first three is among the
 * first three of the direct section it sits in, which lies inside it. Only
 * the cards are left for the second wave.
 *
 * Gated in SQL: at or under the cap — where every card is read for the counts
 * anyway — it answers no row (SQLite evaluates the constant term once,
 * before its loop). Optimistic and through `runListed` like the memberships
 * (CLAUDE.md rule 2: a database without 0184 or 0189 runs it without the held
 * clause, or with nothing sellable).
 */
function photoShortlistRows(db: D1Database): Promise<Record<string, unknown>[]> {
  const flag = optimisticSellableFlag(db, 'p');
  const sql = `WITH ${membershipCte(!completenessAbsentLately(db))},
    member(product_id, catalog_id) AS (
      SELECT m.product_id, m.catalog_id FROM membership m JOIN products p ON p.id = m.product_id AND p.composition = ''
    ),
    ranked(product_id, rn) AS (
      SELECT m.product_id, ROW_NUMBER() OVER (PARTITION BY m.catalog_id ORDER BY ${flag} DESC, p.display_order ASC, p.created_at DESC, p.id ASC)
        FROM member m JOIN products p ON p.id = m.product_id
    )
    SELECT p.*, ${flag} AS sellable_now FROM products p
     WHERE (SELECT COUNT(DISTINCT product_id) FROM member) > ?2
       AND p.id IN (SELECT product_id FROM ranked WHERE rn <= ?1)
     ORDER BY sellable_now DESC, p.display_order ASC, p.created_at DESC, p.id ASC`;
  return runListed(db, sql, (q) =>
    db.prepare(q).bind(TREE_PHOTO_SHORTLIST, TREE_AVAILABILITY_CAP).all<Record<string, unknown>>()
  ).then((r) => r.results ?? []);
}

/**
 * The map's photographs past TREE_AVAILABILITY_CAP, from the short list's rows
 * (`photoShortlistRows`, already in the shop's order): their cards, then the
 * explorer's rule over them.
 */
async function treePhotosFromShortlist(
  db: D1Database,
  ctxPromise: Promise<PricingCtx>,
  roots: CatalogTreeNode[],
  byProduct: Map<string, Set<string>>,
  idx: CatalogIndex,
  rows: Record<string, unknown>[]
): Promise<void> {
  if (rows.length === 0) return;
  const cards = await resolveProductCards(db, rows, await ctxPromise, idx, 'flag');
  const photos = new Map<string, { src: string; light?: string } | null>();
  for (const [id, card] of cards) photos.set(id, cardLeadPhoto(card));
  assignTreePhotos(roots, rows.map((r) => String(r.id)), (id) => byProduct.get(id), (id) => photos.get(id) ?? null);
}

/**
 * The whole explorer tree with its counts — what `GET /api/catalog/tree`
 * answers, as a function, so the public API (worker/routes/publicApi.ts)
 * describes the sections from the same roll-up the storefront draws.
 */
export async function buildCatalogTree(
  db: D1Database,
  ctxPromise: Promise<PricingCtx>,
  /** `photos`: one borrowed photograph per section (`assignTreePhotos`) — the storefront's map; the public API describes sections without them. */
  opts: { photos?: boolean } = {}
): Promise<{ roots: CatalogTreeNode[]; totals: { products: number; available: number | null } }> {
  const [records, memberships, shortlist] = await Promise.all([
    loadCatalogRecords(db),
    loadMemberships(db),
    opts.photos ? photoShortlistRows(db) : Promise.resolve([]),
  ]);
  const idx = indexCatalogs(records);
  const byProduct = membershipByProduct(memberships, idx);
  const { available, ordered } = await availableProductIds(db, ctxPromise, [...byProduct.keys()], idx);
  const counts = rollUpCounts(byProduct, available);
  const roots = buildTree(idx, counts, available !== null);
  if (opts.photos) {
    if (ordered) {
      const photos = new Map(ordered.map((o) => [o.id, cardLeadPhoto(o.card)]));
      assignTreePhotos(roots, ordered.map((o) => o.id), (id) => byProduct.get(id), (id) => photos.get(id) ?? null);
    } else {
      await treePhotosFromShortlist(db, ctxPromise, roots, byProduct, idx, shortlist);
    }
  }
  // Totals over what the explorer SHOWS: products under an active root.
  const shownRoots = new Set(roots.map((r) => r.id));
  let products = 0;
  let avail = 0;
  for (const [pid, catalogs] of byProduct) {
    if (![...catalogs].some((id) => shownRoots.has(id))) continue;
    products += 1;
    if (available?.has(pid)) avail += 1;
  }
  return { roots, totals: { products, available: available ? avail : null } };
}

/**
 * ONE MAP FOR EVERY VIEWER, BUILT WITHOUT THE VIEWER (speed review
 * 2026-10-16). The answer is cached for everyone, so nothing in it may depend
 * on who asked — and nothing does: its counts, «متوفرة الآن» and photographs
 * read the cards' stock and pictures, never a price. Built with the GUEST's
 * pricing inputs, a signed-in visitor's miss no longer waits for their tier
 * (three dependent reads) before the cards.
 */
catalogRoutes.get('/tree', (c) =>
  cached(c, treeCacheKey(c.req.url), TREE_CACHE, async () =>
    c.json({ success: true, ...(await buildCatalogTree(c.env.DB, pricingCtxForUser(c.env.DB, null), { photos: true })) })
  )
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

    // VISIBLE, priced first so the page cap keeps priced items (DECISIONS row 240, rule R1).
    const L = await listing(c.env.DB);
    const { results } = await c.env.DB.prepare(
      `SELECT *, ${L.sellableFlag('products')} AS sellable_now FROM products
        WHERE ${L.visible('products')} AND composition = '' AND id IN (SELECT value FROM json_each(?))
        ORDER BY sellable_now DESC, display_order ASC, created_at DESC
        LIMIT ?`
    )
      .bind(JSON.stringify(memberIds), CATEGORY_PAGE_CAP)
      .all<Record<string, unknown>>();
    const rows = results ?? [];
    const ctx = await pricingCtx(c);
    const cards = await resolveProductCards(c.env.DB, rows, ctx, idx, 'flag');
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
    const res = c.json(payload);
    /**
     * A DEPARTMENT THAT IS ITS OWN LISTING SAYS SO BEFORE ITS BODY: the
     * storefront starts the list (`/api/products?category=<slug>&facets=1
     * &limit=24`, src/lib/bootFetch.ts `primeCategoryOpening`) the moment these
     * headers arrive, instead of after the page has parsed this answer and
     * rendered (speed audit 2026-10-16). The canonical slug, URI-encoded (a
     * slug may be Arabic). Cached with the answer, so a hit says it too.
     */
    if (plan.layout === 'listing') res.headers.set(CATALOG_LISTING_HEADER, encodeURIComponent(node.slug));
    return res;
  };

  if (user) {
    const res = await build();
    res.headers.set('Cache-Control', 'private, no-store');
    return res;
  }
  // The key is the PATH alone: a query string changes nothing here, so letting
  // it into the key would only let anyone mint unbounded cache entries.
  const u = new URL(c.req.url);
  return cached(c, new Request(withCacheEpoch(`${u.origin}${u.pathname}`), { method: 'GET' }), PAGE_CACHE_SIGNED_OUT, build);
});
