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
import { HttpError, notFound, int, str } from '../lib/http';
import { rootDomainFrom, storeUrl } from '../lib/hosts';
import { storeBySlug, storeById, storeIsSuspended, type StoreContext } from '../lib/merchantAuth';
import { storeTakesOrders } from '../lib/storeOrderOps';
import { benefits, getTierStatus } from '../lib/entitlements';
import { salesBadgeTier } from '../lib/salesBadge';
import { maskName } from './reviews';
import { storefrontLayoutPayload, storefrontTheme } from '../lib/storeLayout';

export const storefrontRoutes = new Hono<AppContext>();

/** The shopfront view. Deliberately smaller than the merchant's own view. */
async function publicStore(db: D1Database, ctx: StoreContext, rootDomain: string | null) {
  const { store: s, merchant: m } = ctx;
  const tier = await getTierStatus(db, m.user_id);
  /**
   * «OPEN» MEANS THE CART WILL TAKE AN ORDER (review S1). It used to be
   * `storeIsOpen` — the store's own switch and the merchant suspension — while
   * the cart and the checkout ask `storeTakesOrders`, which also refuses a
   * RESTRICTED merchant, an owner whose plan lapsed and a store that stopped
   * selling direct products. The shop then read «open», the product page
   * showed a live «أضف إلى السلة», and every tap came back STORE_CLOSED. One
   * rule for both now: what this says is what the cart does.
   */
  const takingOrders = (await storeTakesOrders(db, ctx)).ok;
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
    policies: safeParse(s.policies, {}),
    social_links: safeParse(s.social_links, {}),
    // The merchant-arranged header rows. Hidden items are the merchant's
    // drafts — a visitor never receives them at all. `configured` lets the
    // frontend tell "never arranged" (show the honest fallback) apart from
    // "deliberately emptied" (show nothing) without leaking the drafts.
    profile_links: safeParse<Array<{ visible?: boolean }>>(s.profile_links, []).filter((w) => w?.visible !== false),
    profile_facts: safeParse<Array<{ visible?: boolean }>>(s.profile_facts, []).filter((w) => w?.visible !== false),
    profile_facts_configured: safeParse<unknown[]>(s.profile_facts, []).length > 0,
    // Only the customer-facing half of the delivery settings; the fee numbers
    // are checkout's business and are priced there from the database.
    delivery_settings: (() => {
      const note = safeParse<Record<string, unknown>>(s.delivery_settings, {}).note;
      return typeof note === 'string' && note ? { note } : {};
    })(),
    accepts_custom_requests: !!s.accepts_custom_requests,
    sells_direct_products: !!s.sells_direct_products,
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
      badge: m.badge_override || m.badge,
      rating: m.rating_count ? m.rating_avg_x100 / 100 : null,
      rating_count: m.rating_count,
      completed_orders: m.completed_orders,
    },
    created_at: s.created_at,
  };
}

function publicProduct(p: Record<string, unknown>) {
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
    options: safeParse(p.options, []),
    colors: safeParse(p.colors, []),
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
  };
}

/** How many people follow this shop — public, same as the community page. */
async function followerCount(db: D1Database, merchantId: string): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM follows WHERE merchant_id = ?')
    .bind(merchantId).first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * The profile's stats row, computed from real rows: followers, published
 * products, and the share of visible reviews at 4★+. `positive_pct` is null
 * with no reviews — a store with none says "new", never a fabricated 100%.
 */
async function storeStats(db: D1Database, ctx: StoreContext) {
  const [followers, products, positive, deals] = await Promise.all([
    followerCount(db, String(ctx.merchant.id)),
    db.prepare(
      `SELECT COUNT(*) AS n FROM community_products
        WHERE store_id = ? AND lifecycle = 'active' AND status = 'active'`
    ).bind(ctx.store.id).first<{ n: number }>(),
    db.prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN rating >= 4 THEN 1 ELSE 0 END) AS good
         FROM merchant_reviews WHERE merchant_id = ? AND hidden = 0`
    ).bind(ctx.merchant.id).first<{ total: number; good: number }>(),
    db.prepare(
      `SELECT COUNT(*) AS n FROM community_products
        WHERE store_id = ? AND lifecycle = 'active' AND status = 'active'
          AND original_price_iqd IS NOT NULL AND original_price_iqd > price_iqd`
    ).bind(ctx.store.id).first<{ n: number }>(),
  ]);
  const total = Number(positive?.total ?? 0);
  return {
    followers,
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
  const slug = str(rawSlug, 'slug', { min: 1, max: 64 });
  const ctx = (await storeBySlug(c.env.DB, slug)) ?? (await storeForRetiredSlug(c.env.DB, slug));
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
storefrontRoutes.get('/resolve', async (c) => {
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
});

storefrontRoutes.get('/:slug', async (c) => {
  const ctx = await servableStore(c, c.req.param('slug'));
  return c.json({ success: true, store: await storefrontStore(c.env.DB, ctx, rootDomainFrom(c.env)) });
});

/**
 * The shop's own shelves, for the storefront's section chips. Active only,
 * and only sections that actually hold a published product — an empty shelf
 * is the merchant's business, not the visitor's.
 */
storefrontRoutes.get('/:slug/sections', async (c) => {
  const ctx = await servableStore(c, c.req.param('slug'));
  const { results } = await c.env.DB.prepare(
    `SELECT s.id, s.name, s.name_ar, s.sort_order,
            (SELECT COUNT(*) FROM community_products p
              WHERE p.section_id = s.id AND p.lifecycle = 'active' AND p.status = 'active') AS product_count
       FROM merchant_store_sections s
      WHERE s.store_id = ? AND s.active = 1
      ORDER BY s.sort_order, s.created_at`
  ).bind(ctx.store.id).all<Record<string, unknown>>();
  return c.json({
    success: true,
    sections: results
      .filter((s) => Number(s.product_count) > 0)
      .map((s) => ({ id: s.id, name: s.name, name_ar: s.name_ar, product_count: s.product_count })),
  });
});

/** The services this shop advertises. Prices here are honest floors, not quotes. */
storefrontRoutes.get('/:slug/services', async (c) => {
  const ctx = await servableStore(c, c.req.param('slug'));
  const { results } = await c.env.DB.prepare(
    `SELECT id, title, description, kind, price_from_iqd, price_unit, materials, image_key
       FROM merchant_services WHERE store_id = ? AND active = 1
      ORDER BY sort_order, created_at LIMIT 40`
  ).bind(ctx.store.id).all<Record<string, unknown>>();
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
});

/** Printers, materials and finished works — the workshop on display. */
storefrontRoutes.get('/:slug/showcase', async (c) => {
  const ctx = await servableStore(c, c.req.param('slug'));
  const { results } = await c.env.DB.prepare(
    `SELECT id, kind, title, details, image_key
       FROM merchant_showcase WHERE store_id = ? AND active = 1
      ORDER BY kind, sort_order, created_at LIMIT 60`
  ).bind(ctx.store.id).all<Record<string, unknown>>();
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
});

storefrontRoutes.get('/:slug/products', async (c) => {
  const ctx = await servableStore(c, c.req.param('slug'));

  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: 60, def: 24 });
  const cursor = parseCursor(c.req.query('cursor'));
  const category = c.req.query('category') || '';
  const section = c.req.query('section') || '';
  const dealsOnly = c.req.query('deals') === '1' ? 1 : 0;

  // Only what the merchant published. draft, hidden and archived products are
  // invisible here — the WHERE clause is the enforcement, not a filter the
  // caller can drop. The section filter is a server query so a shelf's whole
  // contents are reachable, not just whatever slice one page happened to hold.
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM community_products
      WHERE store_id = ?1 AND lifecycle = 'active' AND status = 'active'
        AND (?2 = '' OR category = ?2)
        AND (?3 = '' OR section_id = ?3)
        AND (?4 = 0 OR (original_price_iqd IS NOT NULL AND original_price_iqd > price_iqd))
        AND (?5 = '' OR created_at < ?5 OR (created_at = ?5 AND id < ?6))
      ORDER BY created_at DESC, id DESC LIMIT ?7`
  ).bind(ctx.store.id, category, section, dealsOnly, cursor.at, cursor.id, limit).all();

  return c.json({
    success: true,
    products: results.map(publicProduct),
    next_cursor: nextCursor(results, limit),
  });
});

storefrontRoutes.get('/:slug/products/:productSlug', async (c) => {
  const ctx = await servableStore(c, c.req.param('slug'));

  // Scoped to the store as well as the product slug: a product id from
  // another shop cannot be rendered inside this one's storefront.
  const p = await c.env.DB.prepare(
    `SELECT * FROM community_products
      WHERE store_id = ? AND slug = ? AND lifecycle = 'active' AND status = 'active'`
  ).bind(ctx.store.id, c.req.param('productSlug')).first<Record<string, unknown>>();
  if (!p) throw notFound('Product not found');

  // Best-effort view counter. A failure here must never cost a shopper their
  // page, so it is not awaited into the response path.
  const viewer = c.get('user')?.id ?? '';
  if (viewer !== ctx.store.user_id && !BOT_UA.test(c.req.header('User-Agent') ?? '')) {
    const work = countProductView(c.env.DB, String(p.id), viewer || (c.req.header('CF-Connecting-IP') ?? '')).catch(() => {});
    try {
      c.executionCtx.waitUntil(work);
    } catch {
      // No ExecutionContext (a test harness): the count still runs, detached.
    }
  }

  // The product page renders no blocks, only the store's THEME (W2-C).
  const [store, layout_theme] = await Promise.all([
    publicStore(c.env.DB, ctx, rootDomainFrom(c.env)),
    storefrontTheme(c.env.DB, ctx),
  ]);
  return c.json({ success: true, product: publicProduct(p), store: { ...store, layout_theme } });
});

/**
 * «Views» COUNTS VISITORS, NOT REQUESTS (audit 04 #21, audit 01 B22).
 *
 * `view_count + 1` ran on every anonymous GET — a refresh loop, a scraper, the
 * owner checking their own page — and the number feeds the merchant's «views»
 * tile, the sort-by-views and each product's insights. One visitor now counts
 * once per product per day: the fixed-window row in `rate_limits` (the same
 * table and upsert the rate limiter uses) is the dedupe, and only the request
 * that OPENS a day's window increments. The store's owner and self-declared
 * crawlers are not counted at all (see the caller).
 */
const BOT_UA = /bot|crawl|spider|slurp|preview|facebookexternalhit|headless/i;

async function countProductView(db: D1Database, productId: string, viewer: string): Promise<void> {
  if (!viewer) return;
  const now = Math.floor(Date.now() / 1000);
  const day = now - (now % 86_400);
  const seen = await db
    .prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN window_start = ?2 THEN count + 1 ELSE 1 END,
         window_start = ?2
       RETURNING count`
    )
    .bind(`pview:${productId}:${viewer}`, day)
    .first<{ count: number }>();
  if (Number(seen?.count) !== 1) return;
  await db.prepare('UPDATE community_products SET view_count = view_count + 1 WHERE id = ?').bind(productId).run();
}

storefrontRoutes.get('/:slug/reviews', async (c) => {
  const ctx = await servableStore(c, c.req.param('slug'));

  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: 50, def: 20 });
  const cursor = parseCursor(c.req.query('cursor'));

  const { results } = await c.env.DB.prepare(
    `SELECT r.id, r.rating, r.body, r.images, r.merchant_reply, r.merchant_replied_at,
            r.created_at, r.order_id, r.community_order_id,
            u.name AS customer_name, u.username AS customer_username
       FROM merchant_reviews r JOIN users u ON u.id = r.customer_id
      WHERE r.merchant_id = ?1 AND r.hidden = 0
        AND (?2 = '' OR r.created_at < ?2 OR (r.created_at = ?2 AND r.id < ?3))
      ORDER BY r.created_at DESC, r.id DESC LIMIT ?4`
  ).bind(ctx.merchant.id, cursor.at, cursor.id, limit).all<Record<string, unknown>>();

  // The distribution, computed from the rows rather than read from a cached
  // column (§40). A cached aggregate that drifts is worse than none: it makes
  // a store look better or worse than its actual reviews.
  const dist = await c.env.DB.prepare(
    `SELECT rating, COUNT(*) AS n FROM merchant_reviews
      WHERE merchant_id = ? AND hidden = 0 GROUP BY rating`
  ).bind(ctx.merchant.id).all<{ rating: number; n: number }>();

  const distribution: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
  let total = 0;
  let sum = 0;
  for (const row of dist.results) {
    distribution[String(row.rating)] = row.n;
    total += row.n;
    sum += row.rating * row.n;
  }

  return c.json({
    success: true,
    average: total ? Math.round((sum / total) * 100) / 100 : null,
    count: total,
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
    next_cursor: nextCursor(results, limit),
  });
});

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
storefrontRoutes.get('/by-id/:storeId', async (c) => {
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
});
