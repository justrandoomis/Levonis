/**
 * The public face of a merchant store — /api/storefront/*.
 *
 * Everything here is readable without signing in (§59): a visitor browses the
 * shop, its products, its reviews and its policies as a guest. Signing in is
 * required to ACT — add to cart, follow, message, review — and those live on
 * their own routes with their own auth.
 *
 * `GET /resolve` is what makes `ali3d.levonis-iq.com` work. The SPA is one
 * deployment serving every store; on boot it asks the Worker which store this
 * hostname is, and renders the storefront or the main site from the answer.
 * The hostname is classified by the middleware in worker/index.ts, so this
 * route never parses a Host header itself (§55).
 *
 * WHAT IS NEVER RETURNED: a merchant's phone unless they published it, their
 * email, their revenue, a product's exact sales count (a rounded-down tier
 * only — worker/lib/salesBadge.ts), or any customer's identity (a reviewer is
 * «Ahmed K.»). A store page is a shopfront, not a database export. The one
 * volume figure that IS public is `completed_orders` — the count of finished
 * orders the badge ladder is earned from, shown as a trust signal the way the
 * request board shows it.
 *
 * A STORE UNDER AN ADMIN SANCTION RETURNS NOTHING OF ITSELF (owner decision,
 * 2026-09-24): every read below answers `STORE_UNAVAILABLE` for a suspended
 * store or a suspended merchant, and the page renders only «المتجر غير متاح
 * حاليًا».
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { safeParse } from '../lib/types';
import { HttpError, notFound, int, str, oneOf } from '../lib/http';
import { likePattern, sqlLikeClause } from '../lib/sqlLike';
import { rootDomainFrom, storeUrl } from '../lib/hosts';
import { storeBySlug, storeById, storeIsSuspended, type StoreContext } from '../lib/merchantAuth';
import { storeTakesOrders } from '../lib/storeOrderOps';
import { benefits, getTierStatus } from '../lib/entitlements';
import { salesBadgeTier } from '../lib/salesBadge';
import { maskName } from './reviews';
import { HAS_VIDEO_NONE, hasVideoSql, storefrontLayoutPayload, storefrontTheme } from '../lib/storeLayout';
import { collectionMemberSql, collectionOrder, sinceNewArrivals, type CollectionKind } from '../lib/catalog/sql';
import { publicProductExtras } from '../lib/catalog/public';
import { productFileCount } from '../lib/fileOwnership';
import { isSchemaMissing } from '../lib/membershipBenefits';
import {
  deliveryToGovernorate,
  loadDeliveryConfig,
  publicDeliverySummary,
  viewerGovernorate,
} from '../lib/merchantDelivery';
import { normalizeGovernorate } from '../lib/iraqGovernorates';
import { anonymousCached } from '../lib/edgePolicy';
import { storefrontWorkshopFacts } from '../lib/printMatchingStore';
import { openNow } from '../lib/storeHours';

/**
 * ONE BODY FOR EVERY VISITOR (P2a, plan §B.1 #2 and #4).
 *
 * Every read below except `/:slug/delivery` now answers the same bytes to a
 * guest and to a signed-in customer: «التوصيل إلى محافظتك» — the one field
 * that was the VIEWER's — moved to GET /:slug/delivery, which the storefront
 * asks for separately once it knows who is looking (src/lib/storefrontApi.ts
 * `deliveryToYou`). That is what lets the colo cache a shopfront for guests
 * (`anonymousCached`: never for a request that carries a session), lets the
 * request pipeline skip the session lookup for the whole router
 * (worker/lib/session.ts `sessionFreePublicGet`), and is pinned by
 * tests/storefrontIsolation.test.ts: a cached storefront never carries
 * viewer data because the routes that are cached never read a viewer.
 */

export const storefrontRoutes = new Hono<AppContext>();

/**
 * The shopfront view. Deliberately smaller than the merchant's own view.
 * Also read by the public API (worker/lib/publicApi/resources/stores.ts),
 * which rebuilds its own answer field by field from this one.
 */
export async function publicStore(db: D1Database, ctx: StoreContext, rootDomain: string | null) {
  const { store: s, merchant: m } = ctx;
  // The owner's tier (badges, and below, whether the cart will take an order)
  // and the store's delivery (W2-A), read together. The tier is read ONCE and
  // handed to `storeTakesOrders`: it used to be read a second time inside the
  // verdict — four more dependent D1 round trips on every shopfront (P2a).
  const [tier, deliveryCfg, workshop] = await Promise.all([
    getTierStatus(db, m.user_id),
    loadDeliveryConfig(db, s),
    // THE WORKSHOP'S FACTS (0159, §9.5) — one statement in this same wave; a
    // shop behind 0159 or without a workshop row simply says nothing.
    storefrontWorkshopFacts(db, m.id, !!s.accepts_custom_requests).catch(() => null),
  ]);
  /**
   * «OPEN» MEANS THE CART WILL TAKE AN ORDER (review S1). It used to be
   * `storeIsOpen` — the store's own switch and the merchant suspension — while
   * the cart and the checkout ask `storeTakesOrders`, which also refuses a
   * RESTRICTED merchant, an owner whose plan lapsed and a store that stopped
   * selling direct products. The shop then read «open», the product page
   * showed a live «أضف إلى السلة», and every tap came back STORE_CLOSED. One
   * rule for both now: what this says is what the cart does.
   */
  const takingOrders = (await storeTakesOrders(db, ctx, tier)).ok;
  return {
    id: s.id,
    slug: s.slug,
    url: storeUrl(s.slug, rootDomain, s.id),
    name: s.name,
    tagline: s.tagline,
    description: s.description,
    logoUrl: s.logo_key ? `/files/${s.logo_key}` : null,
    bannerUrl: s.banner_key ? `/files/${s.banner_key}` : null,
    accent: s.accent,
    categories: safeParse(s.categories, []),
    governorate: s.governorate,
    service_areas: safeParse(s.service_areas, []),
    // Published only if the merchant chose to publish it. A contact number is
    // a person's phone, not a store attribute.
    contact_phone: s.contact_phone_public ? s.contact_phone : null,
    business_hours: safeParse(s.business_hours, []),
    // «مفتوح الآن» from the hours, in Baghdad time, with the instant the word
    // next changes (worker/lib/storeHours.ts). A guest reads this body from
    // the edge cache for up to 120 s (worker/lib/edgePolicy.ts), so the
    // client re-derives the word from `business_hours` with the same pure
    // function once `next_change_at` has passed. Vacation columns are P7: null.
    ...openNow(safeParse(s.business_hours, []), null, Date.now()),
    policies: safeParse(s.policies, {}),
    social_links: safeParse(s.social_links, {}),
    // The merchant-arranged header rows. Hidden items are the merchant's
    // drafts — a visitor never receives them at all. `configured` lets the
    // frontend tell "never arranged" (show the honest fallback) apart from
    // "deliberately emptied" (show nothing) without leaking the drafts.
    profile_links: safeParse<Array<{ visible?: boolean }>>(s.profile_links, []).filter((w) => w?.visible !== false),
    profile_facts: safeParse<Array<{ visible?: boolean }>>(s.profile_facts, []).filter((w) => w?.visible !== false),
    profile_facts_configured: safeParse<unknown[]>(s.profile_facts, []).length > 0,
    // The store's delivery note, from its delivery profile (W2-A) — the key
    // the storefront has always read it under.
    delivery_settings: deliveryCfg.profile.note ? { note: deliveryCfg.profile.note } : {},
    // WHERE THE STORE DELIVERS AND FOR HOW MUCH (W2-A): the governorates it
    // serves with their fees, pickup, preparation days. Display only — the
    // checkout prices again from the customer's saved address.
    delivery: publicDeliverySummary(deliveryCfg),
    // «التوصيل إلى <محافظتك>» is NOT here any more: it is the viewer's own
    // data and this body is cached for guests. GET /:slug/delivery answers it
    // for the signed-in visitor (see the file header).
    accepts_custom_requests: !!s.accepts_custom_requests,
    sells_direct_products: !!s.sells_direct_products,
    // What the workshop can make, as public facts (technologies, materials,
    // the largest bed, the usual turnaround, the intro) — never a printer's
    // economics. Guest-cacheable like the rest of this body: no viewer in it.
    workshop,
    open: takingOrders,
    // The reason a shop is shut is between the merchant and Levonis. A
    // visitor is told it is closed, never whether the merchant paused it, an
    // admin restricted it, or their subscription lapsed.
    status: takingOrders ? 'active' : 'closed',
    merchant: {
      id: m.id,
      name: m.name,
      verified: !!m.verified,
      pro_badge: benefits.proMerchantBadge(tier),
      // PREMIUM's own mark (0145); a PRO merchant shows the PRO badge alone.
      premium_badge: !benefits.proMerchantBadge(tier) && benefits.premiumBadge(tier),
      badge: m.badge_override || m.badge,
      rating: m.rating_count ? m.rating_avg_x100 / 100 : null,
      rating_count: m.rating_count,
      completed_orders: m.completed_orders,
    },
    created_at: s.created_at,
  };
}

export function publicProduct(p: Record<string, unknown>) {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    name_ar: p.name_ar,
    description: p.description,
    description_ar: p.description_ar,
    images: safeParse(p.images, []),
    price_iqd: p.price_iqd,
    original_price_iqd: p.original_price_iqd,
    category: p.category,
    condition: p.condition,
    // How it is sold (W2-F): `variants` products carry their option groups and
    // variants on the product page; the pre-0126 JSON lists are served only
    // while a product is still sold by them (`legacy`) — the merchant's raw
    // JSON is otherwise nobody's business.
    variant_mode: p.variant_mode ?? 'simple',
    options: p.variant_mode === 'legacy' ? safeParse(p.options, []) : [],
    colors: p.variant_mode === 'legacy' ? safeParse(p.colors, []) : [],
    delivery_methods: safeParse(p.delivery_methods, []),
    prep_days: p.prep_days,
    // In stock or not — never the exact count. A competitor should not be
    // able to read a shop's inventory levels off its public pages.
    in_stock: !p.track_stock || Number(p.stock) > 0,
    // «+50 مبيعات», never «237». The exact count is the shop's sales volume
    // per product — competitive information the platform's own badge rule
    // keeps on the server (worker/lib/salesBadge.ts: rounded DOWN to a tier
    // the product has genuinely passed, nothing below the first tier). The
    // raw `sold_count` stays in the merchant's own dashboard.
    sales_tier: salesBadgeTier(p.sold_count),
    section_id: p.section_id ?? null,
    featured: !!p.featured,
    // A ▶ mark on the card (storefront L10): stamped by `withVideoFlags` on
    // the list reads; a row read without it says false, never undefined.
    has_video: !!p.has_video,
  };
}

/**
 * The profile's stats row, computed from real rows: followers, published
 * products, and the share of visible reviews at 4★+. `positive_pct` is null
 * with no reviews — a store with none says "new", never a fabricated 100%.
 */
export async function storeStats(db: D1Database, ctx: StoreContext) {
  // Four counts, ONE D1 call (P2a): a batch is one round trip for the whole
  // wave and one subrequest instead of four — the same four statements.
  const [followersRes, productsRes, positiveRes, dealsRes] = await db.batch([
    db.prepare('SELECT COUNT(*) AS n FROM follows WHERE merchant_id = ?').bind(String(ctx.merchant.id)),
    db.prepare(
      `SELECT COUNT(*) AS n FROM community_products
        WHERE store_id = ? AND lifecycle = 'active' AND status = 'active'`
    ).bind(ctx.store.id),
    db.prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN rating >= 4 THEN 1 ELSE 0 END) AS good
         FROM merchant_reviews WHERE merchant_id = ? AND hidden = 0`
    ).bind(ctx.merchant.id),
    db.prepare(
      `SELECT COUNT(*) AS n FROM community_products
        WHERE store_id = ? AND lifecycle = 'active' AND status = 'active'
          AND original_price_iqd IS NOT NULL AND original_price_iqd > price_iqd`
    ).bind(ctx.store.id),
  ]);
  const first = <T,>(r: D1Result<unknown>) => (r.results?.[0] ?? null) as T | null;
  const followers = first<{ n: number }>(followersRes);
  const products = first<{ n: number }>(productsRes);
  const positive = first<{ total: number; good: number }>(positiveRes);
  const deals = first<{ n: number }>(dealsRes);
  const total = Number(positive?.total ?? 0);
  return {
    followers: Number(followers?.n ?? 0),
    product_count: products?.n ?? 0,
    positive_pct: total ? Math.round((Number(positive?.good ?? 0) / total) * 100) : null,
    deal_count: deals?.n ?? 0,
  };
}

/**
 * THE STORE AS THE STOREFRONT RENDERS IT (merchant platform W2-C): the public
 * profile and its honest stats, plus the PUBLISHED layout — never the draft —
 * normalised on read, and the rows its blocks show, fetched in one fixed set of
 * statements (worker/lib/storeLayout.ts). A store that never published gets
 * the classic page generated from its settings. The three reads run together.
 */
async function storefrontStore(db: D1Database, ctx: StoreContext, rootDomain: string | null) {
  const [profile, stats, layout] = await Promise.all([
    publicStore(db, ctx, rootDomain),
    storeStats(db, ctx),
    storefrontLayoutPayload(db, ctx),
  ]);
  return { ...profile, ...stats, ...layout };
}

/**
 * THE REFUSAL A SANCTIONED STORE ANSWERS WITH.
 *
 * Owner decision (2026-09-24): a customer on an admin-suspended store sees only
 * «المتجر غير متاح حاليًا» — «Products, banner and bio are not served». So
 * every public read of such a store answers this one stable code, before a
 * single merchant-controlled field is read out of the row. A 404 rather than a
 * 403: to a visitor the shop is simply not there right now, and a build of the
 * app older than this code renders its own "no store here" screen for a 404 —
 * still nothing of the shop — instead of a broken page.
 */
const storeUnavailable = () =>
  new HttpError(404, 'This store is not available right now', 'STORE_UNAVAILABLE');

/**
 * The store a RETIRED slug was renamed away from, while nobody else holds it.
 *
 * A renamed store's old slug is parked in `merchant_store_slugs` (active = 0)
 * so a competitor cannot capture the traffic (§68). Parking it without
 * following it left every printed QR code, shared link and installed app on
 * «No such store» (audit 01 B14). A live store on the slug always wins — the
 * live lookup runs first, and a store that later claims a lapsed slug takes
 * the row over (`ON CONFLICT(slug) … active = 1`), so a redirect can never
 * point a new shop's visitors at the old one.
 */
async function storeForRetiredSlug(db: D1Database, slug: string): Promise<StoreContext | null> {
  const row = await db
    .prepare('SELECT store_id FROM merchant_store_slugs WHERE slug = ? AND active = 0')
    .bind(slug)
    .first<{ store_id: string }>();
  return row ? storeById(db, row.store_id) : null;
}

/**
 * The store a PUBLIC read may serve, by slug: the live slug first, then a
 * slug the store was renamed away from (so `/community/store/<old slug>` and
 * any cached call keep working), and never a sanctioned one.
 */
async function servableStore(c: Context<AppContext>, rawSlug: string | undefined): Promise<StoreContext> {
  return servableStoreBySlug(c.env.DB, str(rawSlug, 'slug', { min: 1, max: 64 }));
}

/** The same rule for a caller that already validated the slug (the public API). */
export async function servableStoreBySlug(db: D1Database, slug: string): Promise<StoreContext> {
  const ctx = (await storeBySlug(db, slug)) ?? (await storeForRetiredSlug(db, slug));
  if (!ctx) throw notFound('Store not found');
  if (storeIsSuspended(ctx)) throw storeUnavailable();
  return ctx;
}

/**
 * KEYSET PAGING THAT NEVER SKIPS A ROW.
 *
 * The cursor was the last row's `created_at` alone, read back as
 * `created_at < cursor`. Rows that share a timestamp — every product one CSV
 * import wrote, before the import stamped each row apart — were cut at the page
 * boundary and the rest of the tie was never served (audit 01 B5: 30 products
 * on one instant, 24 reachable). The cursor is now `<created_at>|<id>` and the
 * order is `(created_at DESC, id DESC)`, so a tie is broken by the id and the
 * next page starts exactly after the last row shown.
 *
 * A bare timestamp — a cursor an older build of the app is still holding —
 * reads as `(timestamp, '')`, which is precisely the old predicate.
 */
function parseCursor(raw: string | undefined): { at: string; id: string } {
  const v = (raw ?? '').slice(0, 200);
  const bar = v.lastIndexOf('|');
  return bar === -1 ? { at: v, id: '' } : { at: v.slice(0, bar), id: v.slice(bar + 1) };
}

function nextCursor(rows: Array<Record<string, unknown>>, limit: number): string | null {
  if (rows.length !== limit) return null;
  const last = rows[rows.length - 1];
  return `${String(last.created_at)}|${String(last.id)}`;
}

/**
 * Which store is this hostname, if any.
 *
 * The SPA calls this once on boot. Returning `store: null` for the main site
 * is a normal answer, not an error — most requests are the main site.
 */
// Keyed by the request's own origin, so each store host caches its own
// answer and the apex its `store: null` (worker/lib/edgePolicy.ts).
storefrontRoutes.get('/resolve', (c) => anonymousCached(c, {}, async () => {
  const host = c.get('host');
  const root = rootDomainFrom(c.env);
  // The platform's own address, from configuration — every answer carries
  // it, so the app never hard-codes a domain to link «LEVONIS», the request
  // board or the messenger from a store's host (audit 01 B19). Null when no
  // root domain is configured (a preview deployment): links stay relative.
  const root_domain = root;

  if (host.kind !== 'merchant' || !host.slug) {
    return c.json({ success: true, kind: host.kind, store: null, root_domain });
  }

  // Not one merchant-controlled field — not even the name, which may be the
  // very thing the store was suspended for.
  const unavailable = () =>
    c.json(
      {
        success: false,
        kind: 'merchant',
        store: null,
        error: 'This store is not available right now',
        code: 'STORE_UNAVAILABLE',
        root_domain,
      },
      404
    );

  const ctx = await storeBySlug(c.env.DB, host.slug);
  if (!ctx) {
    // A slug this store was RENAMED away from. The browser is told where the
    // shop lives now and replaces the address (src/StoreContext.tsx), so a
    // QR code printed on a box before the rename still lands on the shop.
    const moved = await storeForRetiredSlug(c.env.DB, host.slug);
    // …unless a sanction closed it (review S4). Its new address is a name
    // the merchant chose — possibly the very thing it was suspended for — and
    // a redirect would advertise it to everyone holding the old link.
    if (moved && storeIsSuspended(moved)) return unavailable();
    if (moved) {
      return c.json(
        {
          success: false,
          kind: 'merchant',
          store: null,
          error: 'This store has moved',
          code: 'STORE_MOVED',
          details: { redirect: storeUrl(moved.store.slug, root, moved.store.id) },
          root_domain,
        },
        404
      );
    }
    // A hostname that looks like a store but is not one. 404 with a shape the
    // SPA can render as "no such store" — never a redirect to the main site,
    // which would make a typo silently look like the platform's own homepage.
    return c.json({ success: false, kind: 'merchant', store: null, error: 'No such store', root_domain }, 404);
  }
  if (storeIsSuspended(ctx)) return unavailable();
  return c.json({
    success: true,
    kind: 'merchant',
    store: await storefrontStore(c.env.DB, ctx, root),
    root_domain,
  });
}));

storefrontRoutes.get('/:slug', (c) => anonymousCached(c, {}, async () => {
  const ctx = await servableStore(c, c.req.param('slug'));
  return c.json({ success: true, store: await storefrontStore(c.env.DB, ctx, rootDomainFrom(c.env)) });
}));

/**
 * GET /:slug/delivery?governorate=<id> — what this store charges to deliver to
 * one governorate, and where it delivers at all (W2-A). Public: fees and
 * availability only, never the merchant's editor state. Without `governorate`
 * a signed-in visitor gets their own default address's; a guest gets only the
 * list. The checkout prices again from the saved address — this is a preview.
 *
 * THE ONE STOREFRONT READ THAT LOOKS AT THE VIEWER, and therefore the one
 * that is never cached and never skips the session (worker/lib/session.ts).
 * Since P2a the store page asks this for «التوصيل إلى محافظتك» instead of
 * finding it in the store body.
 */
storefrontRoutes.get('/:slug/delivery', async (c) => {
  const ctx = await servableStore(c, c.req.param('slug'));
  const asked = (c.req.query('governorate') ?? '').trim();
  let governorate = '';
  let source: 'query' | 'address' | null = null;
  if (asked) {
    governorate = normalizeGovernorate(asked);
    if (!governorate) throw new HttpError(400, 'Choose a governorate from the list', 'GOVERNORATE_INVALID');
    source = 'query';
  } else {
    governorate = await viewerGovernorate(c.env.DB, c.get('user')?.id ?? null);
    source = governorate ? 'address' : null;
  }
  const cfg = await loadDeliveryConfig(c.env.DB, ctx.store);
  return c.json({
    success: true,
    delivery: {
      governorate: governorate || null,
      source,
      quote: governorate ? deliveryToGovernorate(cfg, governorate) : null,
      ...publicDeliverySummary(cfg),
    },
  });
});

/**
 * The shop's own shelves, for the storefront's section chips. Active only,
 * and only sections that actually hold a published product — an empty shelf
 * is the merchant's business, not the visitor's.
 */
export async function storeCollections(db: D1Database, storeId: string): Promise<Array<Record<string, unknown>>> {
  // COLLECTIONS (W2-F): the store's «sections» — manual ones count their
  // published members, computed ones the published products their rule picks.
  // (A database before 0126 answers with the pre-0126 shelf count.)
  const { results } = await db.prepare(
    `SELECT s.id, s.name, s.name_ar, s.kind, s.image_key, s.sort_order,
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
      WHERE s.store_id = ?1 AND s.active = 1
      ORDER BY s.sort_order, s.created_at`
  ).bind(storeId, sinceNewArrivals()).all<Record<string, unknown>>().catch(async (e: unknown) => {
    if (!isSchemaMissing(e)) throw e;
    return db.prepare(
      `SELECT s.id, s.name, s.name_ar, 'manual' AS kind, NULL AS image_key, s.sort_order,
              (SELECT COUNT(*) FROM community_products p
                WHERE p.section_id = s.id AND p.lifecycle = 'active' AND p.status = 'active') AS product_count
         FROM merchant_store_sections s WHERE s.store_id = ? AND s.active = 1 ORDER BY s.sort_order, s.created_at`
    ).bind(storeId).all<Record<string, unknown>>();
  });
  // An empty shelf is the merchant's business, not the visitor's.
  return results.filter((s) => Number(s.product_count) > 0);
}

async function publicCollections(c: Context<AppContext>) {
  const ctx = await servableStore(c, c.req.param('slug'));
  const list = (await storeCollections(c.env.DB, ctx.store.id))
    .map((s) => ({
      id: s.id,
      name: s.name,
      name_ar: s.name_ar,
      kind: s.kind ?? 'manual',
      image_url: s.image_key ? `/files/${String(s.image_key)}` : null,
      product_count: s.product_count,
    }));
  return c.json({ success: true, sections: list, collections: list });
}

// One path only: every literal segment of this router must be a reserved
// store slug (tests/storeSlugsPaging.test.ts B23), so «collections» is served
// under the path the storefront has always called.
storefrontRoutes.get('/:slug/sections', (c) => anonymousCached(c, {}, () => publicCollections(c)));

/** The services this shop advertises. Prices here are honest floors, not quotes. */
export async function storeServices(db: D1Database, storeId: string): Promise<Array<Record<string, unknown>>> {
  const { results } = await db.prepare(
    `SELECT id, title, description, kind, price_from_iqd, price_unit, materials, image_key
       FROM merchant_services WHERE store_id = ? AND active = 1
      ORDER BY sort_order, created_at LIMIT 40`
  ).bind(storeId).all<Record<string, unknown>>();
  return results;
}

storefrontRoutes.get('/:slug/services', (c) => anonymousCached(c, {}, async () => {
  const ctx = await servableStore(c, c.req.param('slug'));
  const results = await storeServices(c.env.DB, ctx.store.id);
  return c.json({
    success: true,
    services: results.map((s) => ({
      id: s.id,
      title: s.title,
      description: s.description,
      kind: s.kind,
      price_from_iqd: s.price_from_iqd,
      price_unit: s.price_unit,
      materials: safeParse(s.materials, []),
      imageUrl: s.image_key ? `/files/${s.image_key}` : null,
    })),
  });
}));

/** Printers, materials and finished works — the workshop on display. */
export async function storeShowcase(db: D1Database, storeId: string): Promise<Array<Record<string, unknown>>> {
  const { results } = await db.prepare(
    `SELECT id, kind, title, details, image_key
       FROM merchant_showcase WHERE store_id = ? AND active = 1
      ORDER BY kind, sort_order, created_at LIMIT 60`
  ).bind(storeId).all<Record<string, unknown>>();
  return results;
}

storefrontRoutes.get('/:slug/showcase', (c) => anonymousCached(c, {}, async () => {
  const ctx = await servableStore(c, c.req.param('slug'));
  const results = await storeShowcase(c.env.DB, ctx.store.id);
  return c.json({
    success: true,
    items: results.map((s) => ({
      id: s.id,
      kind: s.kind,
      title: s.title,
      details: s.details,
      imageUrl: s.image_key ? `/files/${s.image_key}` : null,
    })),
  });
}));

/**
 * The query parameters a store's product list answers to — the cache key's
 * whole vocabulary. `q` and `sort` (storefront L11) are declared here FIRST:
 * the anonymous edge key is built from this list only, so an undeclared
 * parameter would hand one search's answer to every other (worker/lib/edgePolicy.ts).
 */
export const STORE_PRODUCTS_PARAMS: readonly string[] = ['limit', 'cursor', 'category', 'collection', 'section', 'deals', 'q', 'sort'];

/** In-store search: a term this long is a sentence, not a product name. */
export const STORE_SEARCH_MAX = 60;
/** The orders a visitor may ask for. Nothing named keeps the list's own order. */
export const STORE_PRODUCT_SORTS = ['new', 'price_asc', 'price_desc'] as const;
export type StoreProductSort = (typeof STORE_PRODUCT_SORTS)[number];

storefrontRoutes.get('/:slug/products', (c) => anonymousCached(c, { params: STORE_PRODUCTS_PARAMS }, async () => {
  const ctx = await servableStore(c, c.req.param('slug'));

  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: 60, def: 24 });
  const cursor = parseCursor(c.req.query('cursor'));
  const category = c.req.query('category') || '';
  const section = c.req.query('collection') || c.req.query('section') || '';
  const dealsOnly = c.req.query('deals') === '1' ? 1 : 0;
  // IN-STORE SEARCH AND SORT (L11). The term is a bound LIKE pattern with its
  // wildcards escaped (worker/lib/sqlLike.ts): a «%» or «_» a visitor types is
  // a literal, never «everything». Too long is refused, not cut. The sort is
  // one of three names; anything else is a 400, and no sort at all keeps the
  // list's own order (newest, or a collection's arrangement).
  const like = likePattern(str(c.req.query('q'), 'q', { max: STORE_SEARCH_MAX, required: false }));
  const sortRaw = c.req.query('sort') || '';
  const sort: StoreProductSort | '' = sortRaw ? oneOf(sortRaw, 'sort', STORE_PRODUCT_SORTS) : '';
  const priceSort = sort === 'price_asc' || sort === 'price_desc';

  // ONE COLLECTION (W2-F): its members in the merchant's order, or its rule's
  // products in the rule's order, paged by (that order's value, id). A
  // collection that is not this store's (or is switched off) lists nothing.
  let legacySection = '';
  let col: { id: string; kind: CollectionKind } | null = null;
  if (section) {
    try {
      col = await c.env.DB.prepare(
        'SELECT id, kind FROM merchant_store_sections WHERE id = ? AND store_id = ? AND active = 1'
      ).bind(section, ctx.store.id).first<{ id: string; kind: CollectionKind }>();
    } catch (e) {
      // A database before 0126: the shelf is `section_id`, as it was.
      if (!isSchemaMissing(e)) throw e;
      legacySection = section;
    }
    if (!col && !legacySection) return c.json({ success: true, products: [], next_cursor: null });
  }
  if (col) {
    // A sort the visitor named replaces the collection's own arrangement for
    // this read; the keyset then follows the named value, the same way.
    const order = priceSort
      ? { sortExpr: 'p.price_iqd', dir: sort === 'price_asc' ? ('ASC' as const) : ('DESC' as const) }
      : sort === 'new'
        ? { sortExpr: 'p.created_at', dir: 'DESC' as const }
        : collectionOrder(col.kind, 'p', '?2');
    const cmp = order.dir === 'DESC' ? '<' : '>';
    const numeric = priceSort || (!sort && (col.kind === 'manual' || col.kind === 'best_sellers'));
    const cursorValue = cursor.at === '' ? '' : numeric ? Number(cursor.at) : cursor.at;
    // `has_video` (L10) is a column of this one statement — the page stays
    // its two waves (tests/d1Waves.test.ts); a collection exists only after 0126,
    // so the media table is always there beside it.
    // One row past the page (COMMUNITY_ECOSYSTEM §2 D8): `next_cursor` is exact,
    // never «maybe» — a page that ends on the last product offers no empty next page.
    const { results: fetched } = await c.env.DB.prepare(
      `SELECT p.*, ${order.sortExpr} AS sort_value, ${hasVideoSql('p')} FROM community_products p
        WHERE p.store_id = ?1 AND p.lifecycle = 'active' AND p.status = 'active'
          AND ${collectionMemberSql(col.kind, 'p', '?2', '?3')}
          AND (?4 = '' OR p.category = ?4)
          AND (?5 = 0 OR (p.original_price_iqd IS NOT NULL AND p.original_price_iqd > p.price_iqd))
          AND (?6 = '' OR ${order.sortExpr} ${cmp} ?6 OR (${order.sortExpr} = ?6 AND p.id < ?7))
          AND (?9 = '' OR ${sqlLikeClause(['p.name', 'p.name_ar'], '?9')})
        ORDER BY ${order.sortExpr} ${order.dir}, p.id DESC LIMIT ?8`
    ).bind(ctx.store.id, col.id, sinceNewArrivals(), category, dealsOnly, cursorValue, cursor.id, limit + 1, like).all<Record<string, unknown>>();
    const results = fetched.slice(0, limit);
    const last = results[results.length - 1];
    return c.json({
      success: true,
      products: results.map(publicProduct),
      next_cursor: fetched.length > limit && last ? `${String(last.sort_value)}|${String(last.id)}` : null,
    });
  }

  // Only what the merchant published. draft, hidden and archived products are
  // invisible here — the WHERE clause is the enforcement, not a filter the
  // caller can drop. The section filter is a server query so a shelf's whole
  // contents are reachable, not just whatever slice one page happened to hold.
  // The keyset is unchanged for the default order — `(created_at DESC, id
  // DESC)`, cursor `<created_at>|<id>` — and a price sort pages by
  // `(price_iqd, id)` with the same cursor shape, `<price>|<id>`.
  const sortExpr = priceSort ? 'price_iqd' : 'created_at';
  const dir = sort === 'price_asc' ? 'ASC' : 'DESC';
  const cmp = dir === 'DESC' ? '<' : '>';
  const cursorValue = cursor.at === '' ? '' : priceSort ? Number(cursor.at) : cursor.at;
  // `has_video` (L10) rides inside the one statement, so the page stays its
  // two waves (tests/d1Waves.test.ts). A database before 0126 has no media
  // table: the same statement runs again saying «no video».
  const list = (videoSql: string) =>
    c.env.DB.prepare(
      `SELECT *, ${videoSql} FROM community_products
        WHERE store_id = ?1 AND lifecycle = 'active' AND status = 'active'
          AND (?2 = '' OR category = ?2)
          AND (?3 = '' OR section_id = ?3)
          AND (?4 = 0 OR (original_price_iqd IS NOT NULL AND original_price_iqd > price_iqd))
          AND (?5 = '' OR ${sortExpr} ${cmp} ?5 OR (${sortExpr} = ?5 AND id < ?6))
          AND (?8 = '' OR ${sqlLikeClause(['name', 'name_ar'], '?8')})
        ORDER BY ${sortExpr} ${dir}, id DESC LIMIT ?7`
    ).bind(ctx.store.id, category, legacySection, dealsOnly, cursorValue, cursor.id, limit + 1, like).all<Record<string, unknown>>();
  // One row past the page (D8) — the price sort's cursor is exact; the default
  // order keeps its pre-existing `nextCursor` shape, out of this phase's scope.
  const { results: fetched } = await list(hasVideoSql('community_products')).catch((e) => {
    if (!isSchemaMissing(e)) throw e;
    return list(HAS_VIDEO_NONE);
  });
  const results = fetched.slice(0, limit);
  const last = results[results.length - 1];

  return c.json({
    success: true,
    products: results.map(publicProduct),
    next_cursor: priceSort
      ? fetched.length > limit && last
        ? `${String(last.price_iqd)}|${String(last.id)}`
        : null
      : nextCursor(results, limit),
  });
}));

/**
 * One PUBLISHED product of this store, by slug. Scoped to the store as well
 * as the product slug: a product id from another shop cannot be rendered
 * inside this one's storefront.
 */
export async function publishedStoreProduct(db: D1Database, storeId: string, productSlug: string) {
  return db.prepare(
    `SELECT * FROM community_products
      WHERE store_id = ? AND slug = ? AND lifecycle = 'active' AND status = 'active'`
  ).bind(storeId, productSlug).first<Record<string, unknown>>();
}

storefrontRoutes.get('/:slug/products/:productSlug', (c) => anonymousCached(c, {}, async () => {
  const ctx = await servableStore(c, c.req.param('slug'));

  const p = await publishedStoreProduct(c.env.DB, ctx.store.id, c.req.param('productSlug') ?? '');
  if (!p) throw notFound('Product not found');

  // No view is counted here any more (audit 01 B22): a GET is a request, not a
  // visitor. The product page sends `product_view` to POST /api/storefront/events,
  // which counts each visitor once per product per Baghdad day, never the
  // owner or a crawler, and keeps `view_count` as the sum of those days
  // (worker/lib/storefrontAnalytics.ts, W2-E).

  // The product page renders no blocks, only the store's THEME (W2-C).
  // …and the variant picker, the ordered media and the printing attributes (W2-F).
  // …and how many files the product carries (§9.4), in the same wave, so the
  // page asks the files door only when there is something behind it — most
  // products carry none, and a member's ask is uncached (perf review 2026-09-30).
  const [store, layout_theme, extras, file_count] = await Promise.all([
    publicStore(c.env.DB, ctx, rootDomainFrom(c.env)),
    storefrontTheme(c.env.DB, ctx),
    publicProductExtras(c.env.DB, p),
    productFileCount(c.env.DB, String(p.id)),
  ]);
  return c.json({ success: true, product: { ...publicProduct(p), ...extras, file_count }, store: { ...store, layout_theme } });
}));

/**
 * The distribution, computed from the rows rather than read from a cached
 * column (§40). A cached aggregate that drifts is worse than none: it makes a
 * store look better or worse than its actual reviews. Visible reviews only —
 * `hidden` is the admin's moderation.
 */
export async function storeReviewSummary(db: D1Database, merchantId: string) {
  const dist = await db.prepare(
    `SELECT rating, COUNT(*) AS n FROM merchant_reviews
      WHERE merchant_id = ? AND hidden = 0 GROUP BY rating`
  ).bind(merchantId).all<{ rating: number; n: number }>();

  const distribution: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
  let total = 0;
  let sum = 0;
  for (const row of dist.results) {
    distribution[String(row.rating)] = row.n;
    total += row.n;
    sum += row.rating * row.n;
  }
  return { average: total ? Math.round((sum / total) * 100) / 100 : null, count: total, distribution };
}

/**
 * The query parameters the review list answers to — declared so the edge key
 * tells «★5 only» and «with photos» apart (worker/lib/edgePolicy.ts; L12).
 */
export const STORE_REVIEWS_PARAMS: readonly string[] = ['limit', 'cursor', 'rating', 'photos'];

storefrontRoutes.get('/:slug/reviews', (c) => anonymousCached(c, { params: STORE_REVIEWS_PARAMS }, async () => {
  const ctx = await servableStore(c, c.req.param('slug'));

  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: 50, def: 20 });
  const cursor = parseCursor(c.req.query('cursor'));
  // THE FILTERS (L12): one star value, or «with photos» — a review whose
  // `images` is a non-empty JSON list. Both narrow the page only; the summary
  // and its distribution are always the whole store's.
  const ratingRaw = c.req.query('rating') || '';
  const rating = ratingRaw ? int(ratingRaw, 'rating', { min: 1, max: 5 }) : 0;
  const photos = c.req.query('photos') === '1' ? 1 : 0;

  // The page and its distribution together (P2a): the summary used to wait
  // for the page, a dependent round trip for a read that needs nothing from it.
  // One row past the page (D8): `next_cursor` is exact, never «maybe».
  const [{ results: fetched }, { average, count, distribution }] = await Promise.all([
    c.env.DB.prepare(
      `SELECT r.id, r.rating, r.body, r.images, r.merchant_reply, r.merchant_replied_at,
              r.created_at, r.order_id, r.community_order_id,
              u.name AS customer_name, u.username AS customer_username
         FROM merchant_reviews r JOIN users u ON u.id = r.customer_id
        WHERE r.merchant_id = ?1 AND r.hidden = 0
          AND (?2 = '' OR r.created_at < ?2 OR (r.created_at = ?2 AND r.id < ?3))
          AND (?5 = 0 OR r.rating = ?5)
          AND (?6 = 0 OR (json_valid(r.images) AND json_array_length(r.images) > 0))
        ORDER BY r.created_at DESC, r.id DESC LIMIT ?4`
    ).bind(ctx.merchant.id, cursor.at, cursor.id, limit + 1, rating, photos).all<Record<string, unknown>>(),
    storeReviewSummary(c.env.DB, String(ctx.merchant.id)),
  ]);
  const results = fetched.slice(0, limit);

  return c.json({
    success: true,
    average,
    count,
    distribution,
    reviews: results.map((r) => ({
      id: r.id,
      rating: r.rating,
      body: r.body,
      images: safeParse(r.images, []),
      // Every review here came from a completed transaction — the database
      // will not hold one that did not. Saying so is honest, not decoration.
      verified: true,
      // MASKED, exactly as a platform product review is (worker/routes/reviews.ts
      // `maskName`, pinned by tests/reviews.test.ts): «Ahmed K.», never the
      // buyer's full account name on a public page (audit 04 #15).
      customer_name: maskName(r.customer_name as string | null, r.customer_username as string | null),
      merchant_reply: r.merchant_reply || null,
      merchant_replied_at: r.merchant_replied_at,
      created_at: r.created_at,
    })),
    next_cursor: fetched.length > limit ? nextCursor(results, limit) : null,
  });
}));

/**
 * Compatibility: the pre-subdomain route (§57).
 * Existing links, shared messages and search results must not break, so the
 * id-based path keeps working and reports the canonical subdomain URL.
 *
 * The id here is ACCEPTED AS EITHER the store id or the merchant id, because
 * the legacy links in the wild carry both: the community directory and the
 * followed-stores list navigate by merchant id, while chat share-cards carry
 * a store id. One store per merchant makes the double meaning unambiguous.
 */
storefrontRoutes.get('/by-id/:storeId', (c) => anonymousCached(c, {}, async () => {
  const id = str(c.req.param('storeId'), 'storeId', { min: 1, max: 64 });
  let ctx = await storeById(c.env.DB, id);
  if (!ctx) {
    const row = await c.env.DB.prepare(
      'SELECT id FROM merchant_stores WHERE merchant_id = ?'
    ).bind(id).first<{ id: string }>();
    if (row) ctx = await storeById(c.env.DB, row.id);
  }
  if (!ctx) throw notFound('Store not found');
  if (storeIsSuspended(ctx)) throw storeUnavailable();
  return c.json({ success: true, store: await storefrontStore(c.env.DB, ctx, rootDomainFrom(c.env)) });
}));
