/**
 * THE STORE PAGE ON THE SERVER: what the public storefront serves, and the
 * checks a layout passes before it is kept.
 *
 * READ (public). `storefrontLayoutPayload` answers the ONE layout a visitor
 * may see — the revision `merchant_stores.published_revision_id` names, and
 * nothing else: never the draft, never "the newest revision". It is normalised
 * AGAIN on the way out with the store owner's id (a stored layout is data, and
 * data is checked where it is used), and a store that never published — or a
 * database a migration behind — gets `defaultLayoutFromStore`, the classic
 * page. With it go the rows the layout's blocks show, read in a fixed handful
 * of statements whatever the layout holds: every product list in one UNION ALL,
 * picked products and coupons through `json_each` (one bound parameter however
 * many ids), and one statement each for collections, services, showcase,
 * reviews and printers — only those some visible block asked for. A failure
 * there costs the blocks their preloaded rows, never the page.
 *
 * WRITE (merchant). `verifyLayoutRefs` runs after `normalizeLayout` on every
 * save, publish and restore: media keys must be THIS owner's live uploads of
 * the right kind (image vs video) and no heavier than their slot allows
 * (storefront L5), product / collection / coupon ids must be THIS store's
 * rows. What fails is removed with an issue.
 *
 * LIBRARY (merchant). `mediaUsedIn` answers where a library file is still
 * shown — the draft and the published page, the showcase, collections,
 * products, the store's own logo, banner and avatar — so the builder can say
 * «used in …» and the delete door can refuse (MEDIA_IN_USE) instead of
 * breaking a page.
 */
import { normalizeLayout, renderableBlocks, type LayoutIssue } from '@levonis/storeLayout/normalize';
import { defaultLayoutFromStore } from '@levonis/storeLayout/defaults';
import {
  collectDataNeeds,
  emptyBlockData,
  type BlockData,
  type CouponData,
  type PrinterData,
  type ProductCardData,
  type ProductPage,
  type ReviewsData,
} from '@levonis/storeLayout/data';
import { collectLayoutRefs, dropLayoutRefs, heavyMedia, mediaSlots, type HeavyMedia } from '@levonis/storeLayout/verify';
import { defaultHeader, type StoreLayout } from '@levonis/storeLayout/schema';
import { ANONYMOUS_LIFETIME } from './edgePolicy';
import { safeLink } from './homeContent';
import { ownedMediaKey } from './mediaRefs';
import { isSchemaMissing } from './membershipBenefits';
import { salesBadgeTier } from './salesBadge';
import { getSetting } from './settings';
import { safeParse } from './types';
import type { StoreContext } from './merchantAuth';
import { maskName } from '../routes/reviews';
import { collectionMemberSql, collectionOrder, sinceNewArrivals, type CollectionKind } from './catalog/sql';

// --------------------------------------------------------------------- read

export interface PublishedLayout {
  layout: StoreLayout;
  source: 'published' | 'default';
  revision: number | null;
}

/**
 * The layout the public may see. Degrades to the classic page — never to an
 * error — when the store never published, when the pointer names no row, when
 * the stored layout normalises to nothing a visitor could see, or when the
 * database predates migration 0122 (no table / no pointer column).
 */
export async function publishedLayout(db: D1Database, ctx: StoreContext): Promise<PublishedLayout> {
  try {
    const row = await db
      .prepare(
        `SELECT r.revision, r.layout_json
           FROM merchant_stores s
           JOIN store_layout_revisions r ON r.id = s.published_revision_id AND r.store_id = s.id
          WHERE s.id = ?`
      )
      .bind(ctx.store.id)
      .first<{ revision: number; layout_json: string }>();
    if (row) {
      const { layout } = normalizeLayout(safeParse<unknown>(row.layout_json, null), { ownerUserId: ctx.store.user_id });
      if (renderableBlocks(layout).length) return { layout, source: 'published', revision: Number(row.revision) };
    }
  } catch (e) {
    if (!isSchemaMissing(e)) throw e;
  }
  return { layout: defaultLayoutFromStore(ctx.store), source: 'default', revision: null };
}

/** What `/resolve`, `/:slug` and `/by-id` add to the store they answer. */
export interface StorefrontLayoutPayload {
  layout: StoreLayout;
  layout_source: 'published' | 'default';
  layout_revision: number | null;
  blocks_data: BlockData;
}

/**
 * NOT BEFORE ITS TIME (review 2026-09-30). The live page filters a scheduled
 * block and a dated notice in the browser (`renderableBlocks(…, 'live')`,
 * `noticeLive`), but the page JSON is the same bytes for every visitor and
 * edge-cached: a merchant's planned launch — the block, its data, the notice
 * — was readable in it days before its window opened. The PUBLIC payload
 * therefore leaves out a block or a notice whose window opens later than
 * `SCHEDULE_LEAD_MS` from now, and one whose window has closed. The lead is
 * longer than the longest an edge copy of the page lives (s-maxage plus
 * stale-while-revalidate, worker/lib/edgePolicy.ts), so a block is always in
 * the payload by the time it opens, and the browser still shows it at the
 * exact instant. What leaves the payload is never planned for either, so its
 * rows are not read. The builder's preview reads the layout itself.
 */
export const SCHEDULE_LEAD_MS = (ANONYMOUS_LIFETIME.sMaxAge + ANONYMOUS_LIFETIME.staleWhileRevalidate) * 1000 + 8 * 60_000;

export function publicLayoutAt(layout: StoreLayout, nowMs: number): StoreLayout {
  const later = (iso: string | undefined) => !!iso && Date.parse(iso) > nowMs + SCHEDULE_LEAD_MS;
  const over = (iso: string | undefined) => !!iso && Date.parse(iso) <= nowMs;
  const blocks = layout.blocks.filter((b) => !b.schedule || (!later(b.schedule.from) && !over(b.schedule.until)));
  const h = layout.header;
  const header = h && (later(h.notice_from) || over(h.notice_until)) ? defaultHeader(h.variant) : h;
  return blocks.length === layout.blocks.length && header === h ? layout : { ...layout, blocks, header };
}

export async function storefrontLayoutPayload(db: D1Database, ctx: StoreContext, nowMs: number = Date.now()): Promise<StorefrontLayoutPayload> {
  const published = await publishedLayout(db, ctx);
  const layout = publicLayoutAt(published.layout, nowMs);
  return {
    layout,
    layout_source: published.source,
    layout_revision: published.revision,
    blocks_data: await blockDataFor(db, ctx, layout),
  };
}

/** Only the theme, for pages that render no blocks (the product page). */
export async function storefrontTheme(db: D1Database, ctx: StoreContext): Promise<{ theme: string; tokens: StoreLayout['tokens'] }> {
  const { layout } = await publishedLayout(db, ctx);
  return { theme: layout.theme, tokens: layout.tokens };
}

const PRODUCT_CARD_COLUMNS =
  'id, slug, name, name_ar, images, price_iqd, original_price_iqd, track_stock, stock, featured, section_id, sold_count, created_at';

/** The public card shape — availability, never the stock count; a sales tier, never the sales. */
export function productCard(p: Record<string, unknown>): ProductCardData {
  const images = safeParse<unknown[]>(p.images as string, []).filter((x): x is string => typeof x === 'string');
  return {
    id: String(p.id),
    slug: String(p.slug),
    name: String(p.name ?? ''),
    name_ar: String(p.name_ar ?? ''),
    images: images.slice(0, 1),
    // The second frame (storefront L10): shown on hover / focus, never a third
    // request for the whole gallery. `has_video` is stamped on the row by
    // `withVideoFlags` before this runs; a row read without it says false.
    image_2: images[1] ?? null,
    has_video: !!p.has_video,
    price_iqd: Number(p.price_iqd ?? 0),
    original_price_iqd: p.original_price_iqd === null || p.original_price_iqd === undefined ? null : Number(p.original_price_iqd),
    in_stock: !p.track_stock || Number(p.stock) > 0,
    featured: !!p.featured,
    section_id: (p.section_id as string | null) ?? null,
    sales_tier: salesBadgeTier(p.sold_count),
  };
}

/** The same cursor `/api/storefront/:slug/products` pages with: `<created_at>|<id>`. */
function cursorOf(rows: Array<Record<string, unknown>>, limit: number): string | null {
  if (rows.length !== limit) return null;
  const last = rows[rows.length - 1];
  return `${String(last.created_at)}|${String(last.id)}`;
}

/**
 * WHICH OF THESE PRODUCTS CARRY A VIDEO (storefront L10) — one statement for a
 * whole page of cards, through `json_each` (one bound parameter however many
 * ids). The card draws a ▶ mark from it; the video itself stays on the
 * product page. A database before 0126 (no media table) says nobody does.
 */
export async function videoProductIds(db: D1Database, ids: readonly string[]): Promise<Set<string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Set();
  try {
    const { results } = await db
      .prepare(
        `SELECT DISTINCT product_id FROM community_product_media
          WHERE kind = 'video' AND product_id IN (SELECT value FROM json_each(?1))`
      )
      .bind(JSON.stringify(unique))
      .all<{ product_id: string }>();
    return new Set((results ?? []).map((r) => String(r.product_id)));
  } catch (e) {
    if (isSchemaMissing(e)) return new Set();
    throw e;
  }
}

/** The same rows with `has_video` stamped on each — what `productCard` and the storefront's `publicProduct` read. */
export async function withVideoFlags<T extends Record<string, unknown>>(db: D1Database, rows: T[]): Promise<T[]> {
  if (!rows.length) return rows;
  const videos = await videoProductIds(db, rows.map((r) => String(r.id)));
  return rows.map((r) => ({ ...r, has_video: videos.has(String(r.id)) }));
}

/**
 * The same fact as a column of the product statement itself, so the layout's
 * wave stays the fixed handful of statements it is pinned to
 * (tests/storeLayoutRoutes.test.ts). `p` is the products table or its alias.
 * A database before 0126 has no media table: the caller runs the statement
 * again with `'0 AS has_video'` (`HAS_VIDEO_NONE`) when this one is refused.
 */
export const hasVideoSql = (p: string) => `EXISTS (SELECT 1 FROM community_product_media m WHERE m.product_id = ${p}.id AND m.kind = 'video') AS has_video`;
export const HAS_VIDEO_NONE = '0 AS has_video';

/**
 * The rows a layout's visible blocks show. A fixed number of statements, run
 * together; see the file header. Never throws: a failed read leaves those
 * blocks to load their own rows (their empty `null`), and the page stands.
 */
/** The live D1's cap on terms in one compound SELECT (workflow 58 measured it: 5 pass, 6 fail). */
export const D1_MAX_UNION_TERMS = 5;

export async function blockDataFor(db: D1Database, ctx: StoreContext, layout: StoreLayout): Promise<BlockData> {
  const needs = collectDataNeeds(layout);
  const data = emptyBlockData();
  const storeId = ctx.store.id;
  const live = `lifecycle = 'active' AND status = 'active'`;
  const tasks: Array<Promise<void>> = [];

  if (needs.products.length) {
    // One statement for every product list: each list is its own ordered,
    // limited subquery, tagged with its key. ?1 is the store; each list binds
    // its key and limit, and a collection list its collection id too — every
    // bound parameter is referenced, at most 2 + 12 × 3 = 38 of them.
    //
    // A COLLECTION IS MEMBERSHIP OR A RULE (W2-F, migration 0126): a manual
    // collection lists its members in the merchant's order, a computed one
    // (featured / new arrivals / best sellers) its rule's products in the
    // rule's order. The kinds are read first — one small statement — so each
    // list's subquery is built for its own kind; `sv` is the order's value,
    // which is also what «load more» pages by.
    const collectionIds = needs.products.filter((q) => q.source === 'collection').map((q) => q.collection_id);
    const kinds = new Map<string, CollectionKind>();
    if (collectionIds.length) {
      const { results } = await db
        .prepare(
          `SELECT id, kind FROM merchant_store_sections WHERE store_id = ?1 AND active = 1 AND id IN (SELECT value FROM json_each(?2))`
        )
        .bind(storeId, JSON.stringify(collectionIds))
        .all<{ id: string; kind: CollectionKind }>()
        .catch(() => ({ results: [] as Array<{ id: string; kind: CollectionKind }> }));
      for (const r of results ?? []) kinds.set(r.id, r.kind ?? 'manual');
    }
    // THE LIVE D1 CAPS A UNION ALL CHAIN AT 5 TERMS (measured by workflow 58:
    // 6 terms fail with «too many terms in compound SELECT»), and a layout may
    // ask for up to 12 lists. So the lists go in chunks of D1_MAX_UNION_TERMS,
    // one statement each, every chunk numbering its own parameters from ?3.
    const since = sinceNewArrivals();
    // `has_video` (L10) rides inside the statement — no extra round trip; a
    // database before 0126 refuses the media table and the same statements
    // run once more saying «no video».
    const buildStatements = (videoSql: string): Array<{ sql: string; binds: unknown[] }> => {
      const statements: Array<{ sql: string; binds: unknown[] }> = [];
      for (let i = 0; i < needs.products.length; i += D1_MAX_UNION_TERMS) {
        const parts: string[] = [];
        const binds: unknown[] = [storeId, since];
        const param = (v: unknown) => {
          binds.push(v);
          return `?${binds.length}`;
        };
        for (const q of needs.products.slice(i, i + D1_MAX_UNION_TERMS)) {
          const key = param(q.key);
          let filter = '';
          let sv = 'created_at';
          let order = 'created_at DESC, id DESC';
          if (q.source === 'featured') filter = 'AND featured = 1';
          else if (q.source === 'deals') filter = 'AND original_price_iqd IS NOT NULL AND original_price_iqd > price_iqd';
          else if (q.source === 'collection') {
            const kind = kinds.get(q.collection_id);
            const idp = param(q.collection_id);
            if (!kind) filter = 'AND 0';
            else {
              filter = `AND ${collectionMemberSql(kind, 'community_products', idp, '?2')}`;
              const o = collectionOrder(kind, 'community_products', idp);
              sv = o.sortExpr;
              order = `${o.sortExpr} ${o.dir}, id DESC`;
            }
          }
          const limit = param(q.limit);
          parts.push(
            `SELECT * FROM (SELECT ${key} AS qk, ${PRODUCT_CARD_COLUMNS}, ${sv} AS sv, ${videoSql} FROM community_products
               WHERE store_id = ?1 AND ${live} ${filter}
               ORDER BY ${order} LIMIT ${limit})`
          );
        }
        statements.push({ sql: parts.join(' UNION ALL '), binds });
      }
      return statements;
    };
    const runLists = (videoSql: string) =>
      Promise.all(buildStatements(videoSql).map((st) => db.prepare(st.sql).bind(...st.binds).all<Record<string, unknown>>()));
    tasks.push(
      runLists(hasVideoSql('community_products'))
        .catch((e) => {
          if (!isSchemaMissing(e)) throw e;
          return runLists(HAS_VIDEO_NONE);
        })
        .then((answers) => {
          const byKey = new Map<string, Array<Record<string, unknown>>>();
          for (const { results } of answers) {
            for (const r of results ?? []) {
              const list = byKey.get(String(r.qk)) ?? [];
              list.push(r);
              byKey.set(String(r.qk), list);
            }
          }
          for (const q of needs.products) {
            const rows = byKey.get(q.key) ?? [];
            const page: ProductPage = {
              items: rows.map(productCard),
              // «Load more» follows the storefront's own listing, which filters
              // by collection and deals but not by «featured».
              next_cursor:
                q.source === 'featured'
                  ? null
                  : rows.length === q.limit
                    ? `${String(rows[rows.length - 1].sv)}|${String(rows[rows.length - 1].id)}`
                    : null,
            };
            data.products[q.key] = page;
          }
        })
    );
  }

  if (needs.productIds.length) {
    const picked = (videoSql: string) =>
      db
        .prepare(
          `SELECT ${PRODUCT_CARD_COLUMNS}, ${videoSql} FROM community_products
            WHERE store_id = ?1 AND ${live} AND id IN (SELECT value FROM json_each(?2))`
        )
        .bind(storeId, JSON.stringify(needs.productIds))
        .all<Record<string, unknown>>();
    tasks.push(
      picked(hasVideoSql('community_products'))
        .catch((e) => {
          if (!isSchemaMissing(e)) throw e;
          return picked(HAS_VIDEO_NONE);
        })
        .then(({ results }) => {
          const byId = new Map((results ?? []).map((r) => [String(r.id), productCard(r)]));
          data.picked = needs.productIds.map((id) => byId.get(id)).filter((p): p is ProductCardData => !!p);
        })
    );
  }

  if (needs.collections) {
    tasks.push(
      db
        .prepare(
          `SELECT * FROM (
             SELECT s.id, s.name, s.name_ar, s.sort_order, s.created_at, s.image_key,
                    CASE s.kind
                      WHEN 'manual' THEN (SELECT COUNT(*) FROM merchant_collection_products m JOIN community_products p ON p.id = m.product_id
                                           WHERE m.collection_id = s.id AND p.lifecycle = 'active' AND p.status = 'active')
                      WHEN 'featured' THEN (SELECT COUNT(*) FROM community_products p WHERE p.store_id = s.store_id AND p.featured = 1
                                             AND p.lifecycle = 'active' AND p.status = 'active')
                      WHEN 'new_arrivals' THEN (SELECT COUNT(*) FROM community_products p WHERE p.store_id = s.store_id AND p.created_at >= ?2
                                             AND p.lifecycle = 'active' AND p.status = 'active')
                      ELSE (SELECT COUNT(*) FROM community_products p WHERE p.store_id = s.store_id AND p.sold_count > 0
                              AND p.lifecycle = 'active' AND p.status = 'active')
                    END AS product_count
               FROM merchant_store_sections s
              WHERE s.store_id = ?1 AND s.active = 1)
            WHERE product_count > 0
            ORDER BY sort_order, created_at`
        )
        .bind(storeId, sinceNewArrivals())
        .all<Record<string, unknown>>()
        .then(({ results }) => {
          data.collections = (results ?? []).map((s) => ({
            id: String(s.id),
            name: String(s.name ?? ''),
            name_ar: String(s.name_ar ?? ''),
            product_count: Number(s.product_count ?? 0),
            // The cover the merchant chose (L9): the key was PATCHable and
            // swept (worker/lib/mediaRefs.ts) long before the page showed it.
            image_url: s.image_key ? `/files/${String(s.image_key)}` : null,
          }));
        })
    );
  }

  if (needs.services) {
    tasks.push(
      db
        .prepare(
          `SELECT id, title, description, kind, price_from_iqd, price_unit, materials, image_key
             FROM merchant_services WHERE store_id = ? AND active = 1
            ORDER BY sort_order, created_at LIMIT 40`
        )
        .bind(storeId)
        .all<Record<string, unknown>>()
        .then(({ results }) => {
          data.services = (results ?? []).map((s) => ({
            id: String(s.id),
            title: String(s.title ?? ''),
            description: String(s.description ?? ''),
            kind: String(s.kind ?? 'other'),
            price_from_iqd: s.price_from_iqd === null || s.price_from_iqd === undefined ? null : Number(s.price_from_iqd),
            price_unit: String(s.price_unit ?? ''),
            materials: safeParse<unknown[]>(s.materials as string, []).filter((m): m is string => typeof m === 'string'),
            imageUrl: s.image_key ? `/files/${String(s.image_key)}` : null,
          }));
        })
    );
  }

  if (needs.showcase) {
    tasks.push(
      db
        .prepare(
          `SELECT id, kind, title, details, image_key
             FROM merchant_showcase WHERE store_id = ? AND active = 1
            ORDER BY kind, sort_order, created_at LIMIT 60`
        )
        .bind(storeId)
        .all<Record<string, unknown>>()
        .then(({ results }) => {
          data.showcase = (results ?? []).map((s) => ({
            id: String(s.id),
            kind: (['printer', 'material', 'work'].includes(String(s.kind)) ? s.kind : 'work') as 'printer' | 'material' | 'work',
            title: String(s.title ?? ''),
            details: String(s.details ?? ''),
            imageUrl: s.image_key ? `/files/${String(s.image_key)}` : null,
          }));
        })
    );
  }

  if (needs.reviews > 0) {
    tasks.push(reviewsFor(db, ctx, needs.reviews).then((r) => void (data.reviews = r)));
  }

  if (needs.printers) {
    tasks.push(printersFor(db, ctx).then((p) => void (data.printers = p)));
  }

  if (needs.couponIds.length) {
    const now = new Date().toISOString();
    tasks.push(
      db
        .prepare(
          `SELECT id, code, kind, value, min_total_iqd, ends_at FROM merchant_coupons
            WHERE store_id = ?1 AND active = 1 AND id IN (SELECT value FROM json_each(?2))
              AND (starts_at IS NULL OR starts_at <= ?3) AND (ends_at IS NULL OR ends_at > ?3)
              AND (max_uses IS NULL OR used_count < max_uses)`
        )
        .bind(storeId, JSON.stringify(needs.couponIds), now)
        .all<Record<string, unknown>>()
        .then(({ results }) => {
          data.coupons = (results ?? []).map(
            (c): CouponData => ({
              id: String(c.id),
              code: String(c.code),
              kind: c.kind === 'percent' ? 'percent' : 'fixed_iqd',
              value: Number(c.value),
              min_total_iqd: Number(c.min_total_iqd ?? 0),
              ends_at: (c.ends_at as string | null) ?? null,
            })
          );
        })
    );
  }

  const settled = await Promise.allSettled(tasks);
  for (const s of settled) {
    if (s.status === 'rejected') console.error('store layout: a block read failed', s.reason instanceof Error ? s.reason.message : String(s.reason));
  }
  return data;
}

/** The storefront's reviews answer (`/:slug/reviews`), first page of `limit`. */
async function reviewsFor(db: D1Database, ctx: StoreContext, limit: number): Promise<ReviewsData> {
  const [rows, dist] = await Promise.all([
    db
      .prepare(
        `SELECT r.id, r.rating, r.body, r.images, r.merchant_reply, r.merchant_replied_at, r.created_at,
                u.name AS customer_name, u.username AS customer_username
           FROM merchant_reviews r JOIN users u ON u.id = r.customer_id
          WHERE r.merchant_id = ? AND r.hidden = 0
          ORDER BY r.created_at DESC, r.id DESC LIMIT ?`
      )
      // One row past the page (D8): «المزيد» is offered only when a next page exists.
      .bind(ctx.merchant.id, limit + 1)
      .all<Record<string, unknown>>(),
    db
      .prepare('SELECT rating, COUNT(*) AS n FROM merchant_reviews WHERE merchant_id = ? AND hidden = 0 GROUP BY rating')
      .bind(ctx.merchant.id)
      .all<{ rating: number; n: number }>(),
  ]);
  const distribution: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
  let total = 0;
  let sum = 0;
  for (const row of dist.results ?? []) {
    distribution[String(row.rating)] = row.n;
    total += row.n;
    sum += row.rating * row.n;
  }
  const fetched = rows.results ?? [];
  const results = fetched.slice(0, limit);
  return {
    average: total ? Math.round((sum / total) * 100) / 100 : null,
    count: total,
    distribution,
    reviews: results.map((r) => ({
      id: String(r.id),
      rating: Number(r.rating),
      body: String(r.body ?? ''),
      images: safeParse<unknown[]>(r.images as string, []).filter((x): x is string => typeof x === 'string'),
      verified: true,
      customer_name: maskName(r.customer_name as string | null, r.customer_username as string | null),
      merchant_reply: (r.merchant_reply as string) || null,
      merchant_replied_at: (r.merchant_replied_at as string | null) ?? null,
      created_at: String(r.created_at),
    })),
    next_cursor: fetched.length > limit ? cursorOf(results, limit) : null,
  };
}

/**
 * The workshop's machines — what they can make, never what they cost: no
 * machine rate, no purchase price, no hours or maintenance figures.
 */
async function printersFor(db: D1Database, ctx: StoreContext): Promise<PrinterData[]> {
  const [{ results }, vocabulary] = await Promise.all([
    db
      .prepare(
        `SELECT id, name, technology, brand, model, build_x_mm, build_y_mm, build_z_mm, materials, multicolor, enclosed, quality_max
           FROM merchant_printers WHERE merchant_id = ? AND active = 1
          ORDER BY sort_order, created_at LIMIT 20`
      )
      .bind(ctx.merchant.id)
      .all<Record<string, unknown>>(),
    getSetting(db, 'printMaterials'),
  ]);
  const names = new Map(
    (vocabulary as Array<{ id: string; name_ar: string; name_en: string }>).map((m) => [m.id, { name_ar: m.name_ar, name_en: m.name_en }])
  );
  return (results ?? []).map((p) => ({
    id: String(p.id),
    name: String(p.name ?? ''),
    technology: p.technology === 'resin' ? 'resin' : 'fdm',
    brand: String(p.brand ?? ''),
    model: String(p.model ?? ''),
    build_mm: [Number(p.build_x_mm ?? 0), Number(p.build_y_mm ?? 0), Number(p.build_z_mm ?? 0)],
    materials: safeParse<unknown[]>(p.materials as string, [])
      .filter((m): m is string => typeof m === 'string')
      .slice(0, 12)
      .map((id) => ({ id, name_ar: names.get(id)?.name_ar ?? id, name_en: names.get(id)?.name_en ?? id })),
    multicolor: !!p.multicolor,
    enclosed: !!p.enclosed,
    quality_max: String(p.quality_max ?? ''),
  }));
}

// -------------------------------------------------------------------- write

/**
 * The references a normalised layout makes, checked against THIS store:
 *
 *   media        canonical keys (`merchants/<owner>/public/…`) must be a live
 *                `file_objects` row of that owner whose MIME matches the slot
 *                (image/* for pictures, video/* for video); legacy keys
 *                (`community/<owner>/…`, uploaded before the ledger) must pass
 *                `ownedMediaKey` — the rule every other merchant media field
 *                uses — and are pictures only.
 *   ids          products, collections and coupons of this store, whatever
 *                their state (a draft product may be featured the day it is
 *                published; the public read shows only live ones).
 *   links        every external address the schema kept also passes the
 *                storefront's `safeLink` — belt and braces, never a widening.
 *
 * Returns the layout without what failed, and an issue for each removal.
 */
export interface VerifiedLayout {
  layout: StoreLayout;
  issues: LayoutIssue[];
  /**
   * The slots emptied as `media_too_heavy`, with the figures a refusal names
   * (storefront L5). The draft door refuses on any (LAYOUT_MEDIA_TOO_HEAVY —
   * the merchant just picked the file and can pick another); publish and
   * restore keep the drop as an issue, like a picture deleted since the save.
   */
  heavy: HeavyMedia[];
}

export async function verifyLayoutRefs(db: D1Database, ctx: StoreContext, layout: StoreLayout): Promise<VerifiedLayout> {
  const refs = collectLayoutRefs(layout);
  const owner = ctx.store.user_id;
  const storeId = ctx.store.id;
  const rejectMedia = new Set<string>();
  const canonical = refs.media.filter((m) => m.key.startsWith('merchants/'));
  for (const m of refs.media) {
    if (m.key.startsWith('community/') && (m.kind !== 'image' || ownedMediaKey(m.key, owner) !== m.key)) rejectMedia.add(m.key);
  }

  const idsIn = async (table: string, ids: string[]): Promise<Set<string>> => {
    if (!ids.length) return new Set();
    const { results } = await db
      .prepare(`SELECT id FROM ${table} WHERE store_id = ?1 AND id IN (SELECT value FROM json_each(?2))`)
      .bind(storeId, JSON.stringify(ids))
      .all<{ id: string }>();
    return new Set((results ?? []).map((r) => String(r.id)));
  };

  const [live, products, collections, coupons] = await Promise.all([
    canonical.length
      ? db
          .prepare(
            `SELECT object_key, mime_type, byte_size FROM file_objects
              WHERE owner_id = ?1 AND deleted_at IS NULL AND object_key IN (SELECT value FROM json_each(?2))`
          )
          .bind(owner, JSON.stringify(canonical.map((m) => m.key)))
          .all<{ object_key: string; mime_type: string; byte_size: number | null }>()
          .then(
            ({ results }) =>
              new Map((results ?? []).map((r) => [String(r.object_key), { mime: String(r.mime_type), bytes: Number(r.byte_size ?? 0) }]))
          )
      : Promise.resolve(new Map<string, { mime: string; bytes: number }>()),
    idsIn('community_products', refs.product),
    idsIn('merchant_store_sections', refs.collection),
    idsIn('merchant_coupons', refs.coupon),
  ]);
  const bytes = new Map<string, number>();
  for (const m of canonical) {
    const row = live.get(m.key);
    if (!row || !row.mime.startsWith(m.kind === 'video' ? 'video/' : 'image/')) rejectMedia.add(m.key);
    else bytes.set(m.key, row.bytes);
  }
  // The weight rule (storefront L5) is judged per SLOT from the ledger's own
  // byte count: the same picture may sit inside a banner's cap and over a
  // gallery item's. A key already rejected is not also «too heavy».
  const heavy = heavyMedia(layout, bytes).filter((h) => !rejectMedia.has(h.key));
  const missing = (ids: string[], found: Set<string>) => new Set(ids.filter((id) => !found.has(id)));
  const dropped = dropLayoutRefs(
    layout,
    {
      media: rejectMedia,
      bytes,
      product: missing(refs.product, products),
      collection: missing(refs.collection, collections),
      coupon: missing(refs.coupon, coupons),
    },
    { ownerUserId: owner }
  );
  const external = externalLinks(dropped.layout).filter((href) => safeLink(href) !== href);
  if (external.length) {
    // Unreachable while the schema's https rule is the narrower one; kept so
    // that loosening it can never widen what reaches an href unnoticed.
    throw new Error('store layout: an external link passed the schema and failed safeLink');
  }
  return { ...dropped, heavy };
}

/** Every external address the page holds — the header's notice link and the footer links included (L6/L7). */
function externalLinks(layout: StoreLayout): string[] {
  const out: string[] = [];
  const visit = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (o.kind === 'external' && typeof o.url === 'string') out.push(o.url);
      else Object.values(o).forEach(visit);
    }
  };
  visit(layout.header);
  visit(layout.footer);
  layout.blocks.forEach((b) => visit(b.settings));
  return out;
}

// ------------------------------------------------------------------ library

/** Where a stored layout lives: the working draft, or the revision the public reads. */
export type LayoutHome = 'draft' | 'published';

/**
 * The two layouts a store keeps that can still SHOW a file: the draft and the
 * published revision (older revisions are restorable, and a restore is
 * re-verified — a picture deleted in between is dropped there with an issue,
 * never served). Each normalised with the owner's id; a database before 0122
 * has neither.
 */
export async function storedLayouts(db: D1Database, ctx: StoreContext): Promise<Array<{ home: LayoutHome; layout: StoreLayout }>> {
  const out: Array<{ home: LayoutHome; layout: StoreLayout }> = [];
  const parse = (json: string) => normalizeLayout(safeParse<unknown>(json, null), { ownerUserId: ctx.store.user_id }).layout;
  try {
    const [draft, published] = await Promise.all([
      db.prepare('SELECT layout_json FROM store_layout_drafts WHERE store_id = ?').bind(ctx.store.id).first<{ layout_json: string }>(),
      db
        .prepare(
          `SELECT r.layout_json
             FROM merchant_stores s
             JOIN store_layout_revisions r ON r.id = s.published_revision_id AND r.store_id = s.id
            WHERE s.id = ?`
        )
        .bind(ctx.store.id)
        .first<{ layout_json: string }>(),
    ]);
    if (draft) out.push({ home: 'draft', layout: parse(draft.layout_json) });
    if (published) out.push({ home: 'published', layout: parse(published.layout_json) });
  } catch (e) {
    if (!isSchemaMissing(e)) throw e;
  }
  return out;
}

/**
 * Where a library file is shown (docs/MERCHANT_PLATFORM_V2.md storefront B1).
 * `layout` names the home (`draft` / `published`) in `id` and the block — or
 * the page slot `header` / `footer` / `background` — in `block_id`; the rest
 * name the row: a showcase entry, a collection cover, a product (its gallery,
 * its media rows, a variant's picture or a legacy option / colour picture), a
 * service card, the store's own logo / banner (`id` is which), the merchant's
 * avatar and — since the 2026-09-30 review — a community post of the owner's
 * (`post`, which may carry the store's library pictures: communityPosts.ts
 * `checkMedia`).
 */
export type MediaUseKind = 'layout' | 'showcase' | 'collection' | 'product' | 'service' | 'store' | 'avatar' | 'post';

/**
 * EVERY COLUMN OF THE MEDIA MANIFEST, DECIDED (review 2026-09-30). The delete
 * door below must never call a file unused while a row still shows it, and
 * the one it missed — `community_post_media`, a post carrying the store's
 * library picture — let a published post lose its picture from the library
 * and then refuse its own author's edit (POST_MEDIA_NOT_OWNED). So every
 * source in `MEDIA_REFERENCE_SOURCES` (worker/lib/mediaRefs.ts) is either READ
 * by `mediaUsedIn` (`LIBRARY_HOLDERS`) or listed in `NOT_LIBRARY_HOLDERS` with
 * the reason a store-library key (`merchants/<uid>/public/…`) cannot be a live
 * use there; tests/mediaReferences.test.ts fails on a source in neither list,
 * so the next holder is decided on the day it is registered.
 */
export const LIBRARY_HOLDERS: readonly string[] = [
  'store_layout_drafts.layout_json',
  'store_layout_revisions.layout_json',
  'merchant_showcase.image_key',
  'merchant_store_sections.image_key',
  'merchant_services.image_key',
  'community_products.images',
  'community_products.options',
  'community_products.colors',
  'community_product_media.media_key',
  'community_product_variants.image_key',
  'merchant_stores.logo_key',
  'merchant_stores.banner_key',
  'community_merchants.avatar_key',
  'community_post_media.media_key',
];

const ADMIN_SHOP = "the admin catalogue, the site's own products and settings: admin uploads (products/, UiUx/), never a store's library";
const FROZEN = 'a frozen record of something already sent or sold: it keeps the bytes alive through the media sweep, and a library delete sets only `deleted_at`, so it never takes a served byte from it';
const PRIVATE = 'a private object under its own prefix, served by its own gated route: a public store-library key cannot be one';
const PERSON = "a person's own media under their own prefix (account avatar and profile, a review's photographs), not a store's library";

export const NOT_LIBRARY_HOLDERS: Readonly<Record<string, string>> = {
  'purchase_orders.attachment_url': FROZEN,
  ...Object.fromEntries(
    [
      'catalogs.image_key', 'catalogs.hero_image_key', 'catalogs.hero_light_image_key', 'catalogs.light_image_key',
      'catalogs.mobile_image_key', 'catalogs.light_mobile_image_key', 'catalogs.hero_mobile_image_key', 'catalogs.hero_light_mobile_image_key',
      'product_images.r2_key', 'product_images.url', 'product_option_values.image', 'product_colors.image',
      'products.images', 'products.light_image', 'products.description_images', 'products.description_videos', 'products.options',
      'products.colors', 'products.content_blocks', 'products.usage_guide', 'products.how_to_use', 'products.how_to_use_ar',
      'products.how_to_use_ckb', 'products.specifications', 'products.condition_doc', 'products.stores',
      'product_imports.payload', 'product_imports.report', 'bundles.image', 'investment_items.image', 'admin_settings.value',
    ].map((k) => [k, ADMIN_SHOP])
  ),
  ...Object.fromEntries(
    [
      'order_items.image_snapshot', 'mystery_allocations.image_snapshot', 'community_orders.offer_snapshot', 'invoices.snapshot',
      'finance_withdrawals.receipt_url', 'finance_withdrawal_payments.receipt_url',
      'finance_order_adjustments.before_json', 'finance_order_adjustments.after_json', 'finance_order_calculations.snapshot',
      'chat_messages.card_snapshot', 'user_notifications.meta', 'tg_admin_notifications.photo_key',
    ].map((k) => [k, FROZEN])
  ),
  ...Object.fromEntries(
    [
      'review_rewards.instagram_evidence', 'wallet_transactions.receipt_key', 'chat_messages.file_key', 'claim_messages.file_key',
      'community_complaint_messages.file_key', 'support_ticket_messages.file_key', 'warranty_claims.evidence', 'return_cases.evidence',
      'trade_in_photos.file_key', 'restriction_cases.evidence', 'kyc_cases.evidence_keys', 'kyc_cases.payload',
      'community_request_files.file_key', 'community_request_files.preview_key', 'community_offer_files.file_key',
      'community_offer_drafts.files_json', 'community_order_updates.file_key', 'product_files.file_key', 'product_files.preview_key',
      'community_post_files.file_key', 'community_post_files.preview_key', 'viewer_grants.file_key', 'print_analyses.file_key',
    ].map((k) => [k, PRIVATE])
  ),
  ...Object.fromEntries(['users.avatar_key', 'users.profile_json', 'reviews.media', 'merchant_reviews.images'].map((k) => [k, PERSON])),
  ...Object.fromEntries(
    ['merchant_store_icons.icon192_key', 'merchant_store_icons.icon512_key', 'merchant_store_icons.maskable512_key',
      'merchant_store_icons.apple180_key', 'merchant_store_icons.favicon32_key'].map((k) => [k, 'an icon rendition under its own store-icons/ prefix, cut from the logo'])
  ),
  'merchant_store_icons.source_key': 'the logo the renditions were cut from — the same key `merchant_stores.logo_key` holds, which is read',
  'link_cards.image_key': 'a re-hosted Open Graph picture under link-cards/, never a library file',
  'upload_sessions.object_key': 'an upload still being assembled: not in the library until it completes',
};

export interface MediaUse {
  kind: MediaUseKind;
  id?: string;
  block_id?: string;
}

/**
 * THE USES OF THESE KEYS ON THIS STORE — narrow on purpose: only the rows this
 * store (or its owner) can show, only the keys asked, each source one
 * set-based statement through `json_each`. Keys may be stored bare or as
 * `/files/<key>`; both spellings are looked for and the bare key answers.
 * A source that cannot be read is an error, not a smaller answer: the delete
 * door must never call a file unused because a table was unreadable.
 */
export async function mediaUsedIn(db: D1Database, ctx: StoreContext, keys: readonly string[]): Promise<Map<string, MediaUse[]>> {
  const out = new Map<string, MediaUse[]>();
  const wanted = new Set(keys.filter((k) => typeof k === 'string' && k));
  if (!wanted.size) return out;
  const bare = (k: string) => (k.startsWith('/files/') ? k.slice('/files/'.length) : k);
  const add = (key: unknown, use: MediaUse) => {
    if (typeof key !== 'string') return;
    const k = bare(key);
    if (!wanted.has(k)) return;
    const list = out.get(k) ?? [];
    if (!list.some((u) => u.kind === use.kind && u.id === use.id && u.block_id === use.block_id)) list.push(use);
    out.set(k, list);
  };
  const forms = JSON.stringify([...wanted].flatMap((k) => [k, `/files/${k}`]));
  const storeId = ctx.store.id;
  const rows = async (sql: string, ...binds: unknown[]) =>
    (await db.prepare(sql).bind(...binds).all<Record<string, unknown>>()).results ?? [];
  const optional = async (sql: string, ...binds: unknown[]) => {
    try {
      return await rows(sql, ...binds);
    } catch (e) {
      if (isSchemaMissing(e)) return [];
      throw e;
    }
  };
  const IN = 'IN (SELECT value FROM json_each(?2))';

  const [layouts, showcase, sections, services, products, productMedia, variants, store, merchant, posts] = await Promise.all([
    storedLayouts(db, ctx),
    rows(`SELECT id, image_key AS k FROM merchant_showcase WHERE store_id = ?1 AND image_key ${IN}`, storeId, forms),
    rows(`SELECT id, image_key AS k FROM merchant_store_sections WHERE store_id = ?1 AND image_key ${IN}`, storeId, forms),
    rows(`SELECT id, image_key AS k FROM merchant_services WHERE store_id = ?1 AND image_key ${IN}`, storeId, forms),
    // The gallery, and the legacy embedded option / colour lists — their
    // pictures sit at any depth, so the whole document is walked.
    rows(
      `SELECT p.id, j.value AS k
         FROM community_products p, json_each(CASE WHEN json_valid(p.images) THEN p.images ELSE '[]' END) j
        WHERE p.store_id = ?1 AND j.value ${IN}
       UNION
       SELECT p.id, t.value AS k
         FROM community_products p, json_tree(CASE WHEN json_valid(p.options) THEN p.options ELSE '[]' END) t
        WHERE p.store_id = ?1 AND t.type = 'text' AND t.value ${IN}
       UNION
       SELECT p.id, t.value AS k
         FROM community_products p, json_tree(CASE WHEN json_valid(p.colors) THEN p.colors ELSE '[]' END) t
        WHERE p.store_id = ?1 AND t.type = 'text' AND t.value ${IN}`,
      storeId,
      forms
    ),
    optional(`SELECT product_id AS id, media_key AS k FROM community_product_media WHERE store_id = ?1 AND media_key ${IN}`, storeId, forms),
    optional(`SELECT product_id AS id, image_key AS k FROM community_product_variants WHERE store_id = ?1 AND image_key ${IN}`, storeId, forms),
    rows('SELECT logo_key, banner_key FROM merchant_stores WHERE id = ?1', storeId),
    rows('SELECT avatar_key FROM community_merchants WHERE id = ?1', ctx.merchant.id),
    // A community post of the store's owner, in any state: a draft re-saved,
    // an archived one restored, must still find its picture in the library.
    optional(
      `SELECT pm.post_id AS id, pm.media_key AS k
         FROM community_post_media pm JOIN community_posts p ON p.id = pm.post_id
        WHERE p.author_id = ?1 AND pm.media_key ${IN}`,
      ctx.store.user_id,
      forms
    ),
  ]);
  for (const { home, layout } of layouts) {
    for (const slot of mediaSlots(layout)) add(slot.key, { kind: 'layout', id: home, block_id: slot.block_id });
  }
  for (const r of showcase) add(r.k, { kind: 'showcase', id: String(r.id) });
  for (const r of sections) add(r.k, { kind: 'collection', id: String(r.id) });
  for (const r of services) add(r.k, { kind: 'service', id: String(r.id) });
  for (const r of [...products, ...productMedia, ...variants]) add(r.k, { kind: 'product', id: String(r.id) });
  for (const r of posts) add(r.k, { kind: 'post', id: String(r.id) });
  for (const r of store) {
    add(r.logo_key, { kind: 'store', id: 'logo' });
    add(r.banner_key, { kind: 'store', id: 'banner' });
  }
  for (const r of merchant) add(r.avatar_key, { kind: 'avatar' });
  return out;
}
