/**
 * THE SHELVES BELOW THE FOLD — best sellers, flash deals, filament, and the
 * two rotating tiles.
 *
 * WHY A SEPARATE MODULE AND A SEPARATE ENDPOINT. `/api/home` is the request the
 * first screen waits on: hero, services, the category board, the new-arrivals
 * grid. Every query added to it delays the paint every visitor sees. These
 * shelves are further down the page, so they are fetched after it, and a slow
 * or failed second request costs the shopper nothing they were looking at.
 *
 * EVERY QUERY HERE RETURNS IDS AND NOTHING ELSE. Prices, membership rungs,
 * offer windows and stock are resolved once, together, by the caller through
 * the same `publicWithDisplayPrice` the product page and the cart use. A shelf
 * that computed its own discount would eventually quote a number the checkout
 * refuses — which is the defect the price-change round was about.
 */

import { SOLD_STATES_SQL } from './soldStates';

/** How many cards a shelf carries. A rail, not a catalogue. */
export const SHELF_LIMIT = 12;

/**
 * The ids of the best-selling products, most units first.
 *
 * WHAT "BEST SELLING" MEANS HERE is `soldStates.ts`'s demand reading — an
 * order whose stock has moved — not the stricter `delivered` the sales badge
 * prints. A ranking that waited for delivery would be a fortnight behind the
 * shop, and a product that sold out this week would be missing from the shelf
 * that exists to say so.
 *
 * COST. `order_items` carries `idx_order_items_product (product_id, order_id,
 * qty)` from migration 0040 — a COVERING index for this exact shape, so the
 * sum is answered from the index without touching the table. The join to
 * `orders` is on its primary key.
 */
export async function bestSellerIds(
  db: D1Database,
  opts: { limit?: number; catalogId?: string | null } = {}
): Promise<string[]> {
  const limit = opts.limit ?? SHELF_LIMIT;
  const params: unknown[] = [];
  let scope = '';
  if (opts.catalogId) {
    // Within one department, descendants included — the same subtree the
    // category board counts, so "best in Printers" and "Printers · 12" cannot
    // disagree about which products are in Printers.
    scope = `
      AND p.id IN (
        WITH RECURSIVE subtree(id) AS (
          SELECT ?
          UNION
          SELECT c.id FROM catalogs c JOIN subtree s ON c.parent_id = s.id
        )
        SELECT pc.product_id FROM product_catalogs pc JOIN subtree s ON s.id = pc.catalog_id
        UNION
        SELECT p2.id FROM products p2 JOIN subtree s ON s.id = p2.category_id
        UNION
        SELECT p3.id FROM products p3 JOIN subtree s ON s.id = p3.sub_category_id
      )`;
    params.push(opts.catalogId);
  }
  params.push(limit);
  const { results } = await db
    .prepare(
      `SELECT oi.product_id AS id, SUM(oi.qty) AS units
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id AND o.status IN ${SOLD_STATES_SQL}
         JOIN products p ON p.id = oi.product_id
        WHERE p.status = 'active' AND p.composition = ''${scope}
        GROUP BY oi.product_id
        ORDER BY units DESC, oi.product_id
        LIMIT ?`
    )
    .bind(...params)
    .all<{ id: string; units: number }>();
  return (results ?? []).map((r) => String(r.id));
}

/**
 * Products with a LIVE scheduled offer, the ones ending soonest first.
 *
 * "Flash deals" is not a new concept to build: it is `offer_windows`
 * (migration 0060), which the owner already edits at /api/admin/offers and
 * which the product page and the listing already honour. This only finds them.
 *
 * `offer_price_mode <> ''` is what separates a DEAL from a bare schedule: a
 * window with an empty price mode changes no price at all — it is a gate or a
 * limit — and putting one on a deals shelf would advertise a discount that
 * does not exist.
 *
 * ELIGIBILITY IS NOT FILTERED IN SQL, deliberately. A members-only offer must
 * still reach the member it was built for, and must not quote a guest a price
 * they cannot pay. The caller resolves both through `offerEligible`, exactly
 * as /api/bundles does.
 */
export async function flashDealIds(
  db: D1Database,
  nowIso: string,
  limit = SHELF_LIMIT
): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT w.subject_id AS id
         FROM offer_windows w
         JOIN products p ON p.id = w.subject_id
        WHERE w.subject_type = 'product'
          AND w.active = 1
          AND w.offer_price_mode <> ''
          AND p.status = 'active' AND p.composition = ''
          AND (w.starts_at IS NULL OR w.starts_at <= ?)
          AND (w.ends_at IS NULL OR w.ends_at > ?)
        ORDER BY (w.ends_at IS NULL), w.ends_at ASC, w.subject_id
        LIMIT ?`
    )
    .bind(nowIso, nowIso, limit)
    .all<{ id: string }>();
  return (results ?? []).map((r) => String(r.id));
}

/**
 * Candidate ids for the randomised filament shelf, as a plain id list.
 *
 * IDENTIFIED BY THE TAXONOMY, never by the template family and never by a name
 * match. `template_family = 'materials'` also resolves for accessory and
 * maker branches, so it would put RC kits in a filament shelf; and matching
 * "PLA" in a name finds "PLA-compatible nozzle".
 *
 * THE SHUFFLE IS NOT IN SQL. `ORDER BY RANDOM()` re-rolls on every request,
 * including the client's own refetch, so scrolling away and back would show a
 * different shelf — which reads as a bug, not as variety. The caller shuffles
 * with a seed that is stable inside a time bucket. Ids only, so the shuffle is
 * over a few hundred strings at most.
 */
export async function filamentCandidateIds(db: D1Database, rootCatalogId: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      `WITH RECURSIVE subtree(id) AS (
         SELECT ?
         UNION
         SELECT c.id FROM catalogs c JOIN subtree s ON c.parent_id = s.id
       )
       SELECT DISTINCT p.id
         FROM products p
        WHERE p.status = 'active' AND p.composition = ''
          AND (
            p.category_id IN (SELECT id FROM subtree)
            OR p.sub_category_id IN (SELECT id FROM subtree)
            OR p.id IN (SELECT pc.product_id FROM product_catalogs pc WHERE pc.catalog_id IN (SELECT id FROM subtree))
          )
        ORDER BY p.id
        LIMIT 300`
    )
    .bind(rootCatalogId)
    .all<{ id: string }>();
  return (results ?? []).map((r) => String(r.id));
}

/**
 * A deterministic shuffle: the same `seed` always produces the same order.
 *
 * Fisher–Yates driven by a mulberry32 PRNG, so the shelf is stable for every
 * visitor inside one time bucket and changes when the bucket does. Stability
 * matters more than unpredictability here — nobody is betting on this — and a
 * shelf that re-orders under the shopper's thumb is the thing to avoid.
 */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = (seed >>> 0) || 0x9e3779b9;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** The bucket a shuffle seed is derived from. Ten minutes: long enough that a
 *  shopper browsing the page sees one stable shelf, short enough that coming
 *  back later shows a different set. */
export const SHUFFLE_BUCKET_MS = 10 * 60 * 1000;

export const shuffleSeed = (nowMs: number): number => Math.floor(nowMs / SHUFFLE_BUCKET_MS);

/**
 * The ids the owner has marked to push — the "Super Deals" tile.
 *
 * `products.is_featured` already exists and is already the flag the admin form
 * writes; `/api/products?type=featured` already lists it. This shelf is that
 * flag on the home page, which is where the owner asked for it: «السوبر ديلز
 * يظهر المنتجات المميزة او يختارها الأدمن لكي تعرض وتباع بسرعة».
 *
 * Newest first, so re-marking a product moves it to the front without needing
 * a second ordering column nobody would maintain.
 */
export async function featuredIds(db: D1Database, limit = SHELF_LIMIT): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT id FROM products
        WHERE status = 'active' AND composition = '' AND is_featured = 1
        ORDER BY created_at DESC, id
        LIMIT ?`
    )
    .bind(limit)
    .all<{ id: string }>();
  return (results ?? []).map((r) => String(r.id));
}
