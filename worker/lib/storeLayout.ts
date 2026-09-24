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
 * the right kind (image vs video), product / collection / coupon ids must be
 * THIS store's rows. What fails is removed with an issue.
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
import { collectLayoutRefs, dropLayoutRefs } from '@levonis/storeLayout/verify';
import type { StoreLayout } from '@levonis/storeLayout/schema';
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

export async function storefrontLayoutPayload(db: D1Database, ctx: StoreContext): Promise<StorefrontLayoutPayload> {
  const published = await publishedLayout(db, ctx);
  return {
    layout: published.layout,
    layout_source: published.source,
    layout_revision: published.revision,
    blocks_data: await blockDataFor(db, ctx, published.layout),
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
 * The rows a layout's visible blocks show. A fixed number of statements, run
 * together; see the file header. Never throws: a failed read leaves those
 * blocks to load their own rows (their empty `null`), and the page stands.
 */
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
    const parts: string[] = [];
    const binds: unknown[] = [storeId, sinceNewArrivals()];
    const param = (v: unknown) => {
      binds.push(v);
      return `?${binds.length}`;
    };
    for (const q of needs.products) {
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
        `SELECT * FROM (SELECT ${key} AS qk, ${PRODUCT_CARD_COLUMNS}, ${sv} AS sv FROM community_products
           WHERE store_id = ?1 AND ${live} ${filter}
           ORDER BY ${order} LIMIT ${limit})`
      );
    }
    tasks.push(
      db
        .prepare(parts.join(' UNION ALL '))
        .bind(...binds)
        .all<Record<string, unknown>>()
        .then(({ results }) => {
          const byKey = new Map<string, Array<Record<string, unknown>>>();
          for (const r of results ?? []) {
            const list = byKey.get(String(r.qk)) ?? [];
            list.push(r);
            byKey.set(String(r.qk), list);
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
    tasks.push(
      db
        .prepare(
          `SELECT ${PRODUCT_CARD_COLUMNS} FROM community_products
            WHERE store_id = ?1 AND ${live} AND id IN (SELECT value FROM json_each(?2))`
        )
        .bind(storeId, JSON.stringify(needs.productIds))
        .all<Record<string, unknown>>()
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
             SELECT s.id, s.name, s.name_ar, s.sort_order, s.created_at,
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
      .bind(ctx.merchant.id, limit)
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
  const results = rows.results ?? [];
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
    next_cursor: cursorOf(results, limit),
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
export async function verifyLayoutRefs(
  db: D1Database,
  ctx: StoreContext,
  layout: StoreLayout
): Promise<{ layout: StoreLayout; issues: LayoutIssue[] }> {
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
            `SELECT object_key, mime_type FROM file_objects
              WHERE owner_id = ?1 AND deleted_at IS NULL AND object_key IN (SELECT value FROM json_each(?2))`
          )
          .bind(owner, JSON.stringify(canonical.map((m) => m.key)))
          .all<{ object_key: string; mime_type: string }>()
          .then(({ results }) => new Map((results ?? []).map((r) => [String(r.object_key), String(r.mime_type)])))
      : Promise.resolve(new Map<string, string>()),
    idsIn('community_products', refs.product),
    idsIn('merchant_store_sections', refs.collection),
    idsIn('merchant_coupons', refs.coupon),
  ]);
  for (const m of canonical) {
    const mime = live.get(m.key);
    if (!mime || !mime.startsWith(m.kind === 'video' ? 'video/' : 'image/')) rejectMedia.add(m.key);
  }
  const missing = (ids: string[], found: Set<string>) => new Set(ids.filter((id) => !found.has(id)));
  const dropped = dropLayoutRefs(
    layout,
    {
      media: rejectMedia,
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
  return dropped;
}

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
  layout.blocks.forEach((b) => visit(b.settings));
  return out;
}
