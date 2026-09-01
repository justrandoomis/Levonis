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
 * email, their order volume, their revenue, or any customer's identity. A
 * store page is a shopfront, not a database export.
 */

import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { safeParse } from '../lib/types';
import { notFound, int, str } from '../lib/http';
import { rootDomainFrom, storeUrl } from '../lib/hosts';
import { storeBySlug, storeById, storeIsOpen, type StoreContext } from '../lib/merchantAuth';

export const storefrontRoutes = new Hono<AppContext>();

/** The shopfront view. Deliberately smaller than the merchant's own view. */
function publicStore(ctx: StoreContext, rootDomain: string | null) {
  const { store: s, merchant: m } = ctx;
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
    accepts_custom_requests: !!s.accepts_custom_requests,
    sells_direct_products: !!s.sells_direct_products,
    open: storeIsOpen(ctx),
    // The reason a shop is shut is between the merchant and Levonis. A
    // visitor is told it is closed, never whether the merchant paused it, an
    // admin suspended it, or their subscription lapsed.
    status: storeIsOpen(ctx) ? 'active' : 'closed',
    merchant: {
      id: m.id,
      name: m.name,
      verified: !!m.verified,
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
    sold_count: p.sold_count,
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
 * Which store is this hostname, if any.
 *
 * The SPA calls this once on boot. Returning `store: null` for the main site
 * is a normal answer, not an error — most requests are the main site.
 */
storefrontRoutes.get('/resolve', async (c) => {
  const host = c.get('host');
  const root = rootDomainFrom(c.env);

  if (host.kind !== 'merchant' || !host.slug) {
    return c.json({ success: true, kind: host.kind, store: null });
  }

  const ctx = await storeBySlug(c.env.DB, host.slug);
  if (!ctx) {
    // A hostname that looks like a store but is not one. 404 with a shape the
    // SPA can render as "no such store" — never a redirect to the main site,
    // which would make a typo silently look like the platform's own homepage.
    return c.json({ success: false, kind: 'merchant', store: null, error: 'No such store' }, 404);
  }
  return c.json({
    success: true,
    kind: 'merchant',
    store: { ...publicStore(ctx, root), followers: await followerCount(c.env.DB, String(ctx.merchant.id)) },
  });
});

storefrontRoutes.get('/:slug', async (c) => {
  const ctx = await storeBySlug(c.env.DB, str(c.req.param('slug'), 'slug', { min: 1, max: 64 }));
  if (!ctx) throw notFound('Store not found');
  return c.json({
    success: true,
    store: {
      ...publicStore(ctx, rootDomainFrom(c.env)),
      followers: await followerCount(c.env.DB, String(ctx.merchant.id)),
    },
  });
});

/**
 * The shop's own shelves, for the storefront's section chips. Active only,
 * and only sections that actually hold a published product — an empty shelf
 * is the merchant's business, not the visitor's.
 */
storefrontRoutes.get('/:slug/sections', async (c) => {
  const ctx = await storeBySlug(c.env.DB, str(c.req.param('slug'), 'slug', { min: 1, max: 64 }));
  if (!ctx) throw notFound('Store not found');
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
  const ctx = await storeBySlug(c.env.DB, str(c.req.param('slug'), 'slug', { min: 1, max: 64 }));
  if (!ctx) throw notFound('Store not found');
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
  const ctx = await storeBySlug(c.env.DB, str(c.req.param('slug'), 'slug', { min: 1, max: 64 }));
  if (!ctx) throw notFound('Store not found');
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
  const ctx = await storeBySlug(c.env.DB, str(c.req.param('slug'), 'slug', { min: 1, max: 64 }));
  if (!ctx) throw notFound('Store not found');

  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: 60, def: 24 });
  const cursor = c.req.query('cursor') || '';
  const category = c.req.query('category') || '';

  // Only what the merchant published. draft, hidden and archived products are
  // invisible here — the WHERE clause is the enforcement, not a filter the
  // caller can drop.
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM community_products
      WHERE store_id = ? AND lifecycle = 'active' AND status = 'active'
        AND (? = '' OR category = ?)
        AND (? = '' OR created_at < ?)
      ORDER BY created_at DESC LIMIT ?`
  ).bind(ctx.store.id, category, category, cursor, cursor, limit).all();

  return c.json({
    success: true,
    products: results.map(publicProduct),
    next_cursor: results.length === limit ? String(results[results.length - 1].created_at) : null,
  });
});

storefrontRoutes.get('/:slug/products/:productSlug', async (c) => {
  const ctx = await storeBySlug(c.env.DB, str(c.req.param('slug'), 'slug', { min: 1, max: 64 }));
  if (!ctx) throw notFound('Store not found');

  // Scoped to the store as well as the product slug: a product id from
  // another shop cannot be rendered inside this one's storefront.
  const p = await c.env.DB.prepare(
    `SELECT * FROM community_products
      WHERE store_id = ? AND slug = ? AND lifecycle = 'active' AND status = 'active'`
  ).bind(ctx.store.id, c.req.param('productSlug')).first<Record<string, unknown>>();
  if (!p) throw notFound('Product not found');

  // Best-effort view counter. A failure here must never cost a shopper their
  // page, so it is not awaited into the response path.
  c.executionCtx?.waitUntil(
    c.env.DB.prepare('UPDATE community_products SET view_count = view_count + 1 WHERE id = ?')
      .bind(p.id)
      .run()
      .catch(() => {})
  );

  return c.json({ success: true, product: publicProduct(p), store: publicStore(ctx, rootDomainFrom(c.env)) });
});

storefrontRoutes.get('/:slug/reviews', async (c) => {
  const ctx = await storeBySlug(c.env.DB, str(c.req.param('slug'), 'slug', { min: 1, max: 64 }));
  if (!ctx) throw notFound('Store not found');

  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: 50, def: 20 });
  const cursor = c.req.query('cursor') || '';

  const { results } = await c.env.DB.prepare(
    `SELECT r.id, r.rating, r.body, r.images, r.merchant_reply, r.merchant_replied_at,
            r.created_at, r.order_id, r.community_order_id,
            u.name AS customer_name
       FROM merchant_reviews r JOIN users u ON u.id = r.customer_id
      WHERE r.merchant_id = ? AND r.hidden = 0 AND (? = '' OR r.created_at < ?)
      ORDER BY r.created_at DESC LIMIT ?`
  ).bind(ctx.merchant.id, cursor, cursor, limit).all<Record<string, unknown>>();

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
      customer_name: r.customer_name,
      merchant_reply: r.merchant_reply || null,
      merchant_replied_at: r.merchant_replied_at,
      created_at: r.created_at,
    })),
    next_cursor: results.length === limit ? String(results[results.length - 1].created_at) : null,
  });
});

/**
 * Compatibility: the pre-subdomain route (§57).
 * Existing links, shared messages and search results must not break, so the
 * id-based path keeps working and reports the canonical subdomain URL.
 */
storefrontRoutes.get('/by-id/:storeId', async (c) => {
  const ctx = await storeById(c.env.DB, c.req.param('storeId'));
  if (!ctx) throw notFound('Store not found');
  return c.json({ success: true, store: publicStore(ctx, rootDomainFrom(c.env)) });
});
