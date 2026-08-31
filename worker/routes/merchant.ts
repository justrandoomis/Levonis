/**
 * Merchant store administration — /api/merchant/*.
 *
 * This is NOT the platform admin API. It is deliberately a different mount
 * with a different name, because the two must never be confused: every route
 * here resolves the caller's OWN store from their session
 * (`requireStoreOwner`) and constrains every query by that store's id. There
 * is no store id in a path or a body for a caller to swap (§54, §72).
 *
 * Reading and selling are separated throughout. When PLUS lapses or an admin
 * suspends a store, the merchant keeps every read — orders, money, disputes,
 * chats — and keeps finishing work already accepted. Only NEW commitments
 * stop (§47, §48). That is why the read routes take `requireStoreOwner` and
 * the write routes that create obligations take `requireSellingPrivileges`.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { safeParse } from '../lib/types';
import { requireAuth, badRequest, forbidden, notFound, conflict, str, int, oneOf } from '../lib/http';
import { newId } from '../lib/crypto';
import { rateLimit } from '../lib/ratelimit';
import { audit } from '../lib/audit';
import { getTierStatus, benefits } from '../lib/entitlements';
import { rootDomainFrom, storeUrl } from '../lib/hosts';
import {
  requireStoreOwner,
  requireSellingPrivileges,
  sellingStatus,
  merchantForUser,
  storeForUser,
  type StoreContext,
} from '../lib/merchantAuth';
import { checkSlug, suggestSlug, SLUG_RESERVATION_DAYS } from '../lib/merchantOps';

export const merchantRoutes = new Hono<AppContext>();

merchantRoutes.use('*', requireAuth);

const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------- shapes

function storePublicShape(ctx: StoreContext, rootDomain: string | null) {
  const { store: s, merchant: m } = ctx;
  return {
    id: s.id,
    merchant_id: s.merchant_id,
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
    contact_phone: s.contact_phone,
    contact_phone_public: !!s.contact_phone_public,
    business_hours: safeParse(s.business_hours, []),
    policies: safeParse(s.policies, {}),
    delivery_settings: safeParse(s.delivery_settings, {}),
    social_links: safeParse(s.social_links, {}),
    accepts_custom_requests: !!s.accepts_custom_requests,
    sells_direct_products: !!s.sells_direct_products,
    status: s.status,
    status_reason: s.status_reason,
    created_at: s.created_at,
    merchant: {
      id: m.id,
      name: m.name,
      verified: !!m.verified,
      status: m.status,
      badge: m.badge_override || m.badge,
      rating: m.rating_count ? m.rating_avg_x100 / 100 : null,
      rating_count: m.rating_count,
      completed_orders: m.completed_orders,
    },
  };
}

function productShape(p: Record<string, unknown>) {
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
    sku: p.sku,
    stock: p.stock,
    track_stock: !!p.track_stock,
    category: p.category,
    condition: p.condition,
    options: safeParse(p.options, []),
    colors: safeParse(p.colors, []),
    delivery_methods: safeParse(p.delivery_methods, []),
    prep_days: p.prep_days,
    status: p.status,
    lifecycle: p.lifecycle,
    sold_count: p.sold_count,
    view_count: p.view_count,
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}

// ------------------------------------------------------------- onboarding

/**
 * Is this slug free? Called as the merchant types, so it is rate-limited and
 * returns a REASON rather than a bare boolean — "taken" and "reserved" need
 * different words in the UI, and "recently_released" needs an explanation.
 */
merchantRoutes.get('/slug-check', async (c) => {
  await rateLimit(c, 'merchant-slug-check', 60, 60);
  const raw = str(c.req.query('slug'), 'slug', { min: 1, max: 64 });
  const store = await storeForUser(c.env.DB, c.get('user')!.id);
  const result = await checkSlug(c.env.DB, raw, store?.store.id ?? null);
  return c.json({ success: true, ...result });
});

/** What the current user may do in the community, and what they have. */
merchantRoutes.get('/me', async (c) => {
  const user = c.get('user')!;
  const tier = await getTierStatus(c.env.DB, user.id);
  const root = rootDomainFrom(c.env);
  const ctx = await storeForUser(c.env.DB, user.id);

  return c.json({
    success: true,
    eligible: benefits.merchantStore(tier),
    tier: tier.tier,
    tier_active: tier.active,
    expires_at: tier.expires_at,
    gated_benefits: tier.gated_benefits,
    // Every merchant benefit, resolved server-side. The UI renders from this
    // and never from a tier string it decided for itself.
    can: {
      store: benefits.merchantStore(tier),
      products: benefits.merchantProducts(tier),
      orders: benefits.merchantOrders(tier),
      offers: benefits.communityOffers(tier),
      analytics: benefits.merchantAnalytics(tier),
      subdomain: benefits.merchantSubdomain(tier),
    },
    store: ctx ? storePublicShape(ctx, root) : null,
    selling: ctx ? await sellingStatus(c, ctx) : { canSell: false, reason: 'no_store' },
    suggested_slug: ctx ? null : suggestSlug(String(user.name ?? '')),
  });
});

/**
 * Create the merchant and the store, once.
 *
 * The eligibility check is server-side and reads the memberships ledger — a
 * client claiming to be PLUS gets nothing. The slug is re-validated here even
 * though /slug-check exists, because /slug-check is advice and this is the
 * decision.
 */
merchantRoutes.post('/onboard', async (c) => {
  await rateLimit(c, 'merchant-onboard', 5, 3600);
  const user = c.get('user')!;
  const tier = await getTierStatus(c.env.DB, user.id);
  if (!benefits.merchantStore(tier)) {
    throw forbidden('An active LEVO PLUS subscription is required to open a store');
  }

  const existing = await storeForUser(c.env.DB, user.id);
  if (existing) throw conflict('You already have a store');

  const body = await c.req.json().catch(() => ({}));
  const name = str(body.name, 'name', { min: 2, max: 60 });
  const slugCheck = await checkSlug(c.env.DB, String(body.slug ?? ''));
  if (!slugCheck.ok) {
    throw badRequest('That store address is not available', 'SLUG_UNAVAILABLE', { reason: slugCheck.reason });
  }
  const slug = slugCheck.slug;

  const tagline = str(body.tagline, 'tagline', { min: 0, max: 140, required: false });
  const description = str(body.description, 'description', { min: 0, max: 4000, required: false });
  const governorate = str(body.governorate, 'governorate', { min: 0, max: 60, required: false });

  const merchantId = (await merchantForUser(c.env.DB, user.id))?.id ?? newId('mch');
  const storeId = newId('str');
  const ts = nowIso();

  // One batch: a store without its merchant, or a slug reservation without
  // its store, is a broken half-state a retry would then trip over.
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO community_merchants (id, user_id, name, bio, governorate, status)
       VALUES (?, ?, ?, ?, ?, 'active')
       ON CONFLICT(user_id) DO UPDATE SET name = excluded.name`
    ).bind(merchantId, user.id, name, tagline, governorate),
    c.env.DB.prepare(
      `INSERT INTO merchant_stores
         (id, merchant_id, user_id, slug, name, tagline, description, governorate, created_at, updated_at)
       VALUES (?, (SELECT id FROM community_merchants WHERE user_id = ?), ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(storeId, user.id, user.id, slug, name, tagline, description, governorate, ts, ts),
    c.env.DB.prepare(
      `INSERT INTO merchant_store_slugs (slug, store_id, active) VALUES (?, ?, 1)`
    ).bind(slug, storeId),
    c.env.DB.prepare(
      `INSERT OR IGNORE INTO merchant_notification_preferences (merchant_id)
       VALUES ((SELECT id FROM community_merchants WHERE user_id = ?))`
    ).bind(user.id),
  ]);

  await audit(c.env.DB, user.id, 'merchant.store_created', storeId, { slug, name });
  const ctx = await storeForUser(c.env.DB, user.id);
  return c.json({ success: true, store: storePublicShape(ctx!, rootDomainFrom(c.env)) }, 201);
});

// ---------------------------------------------------------- store settings

merchantRoutes.patch('/store', async (c) => {
  await rateLimit(c, 'merchant-store-update', 30, 300);
  const ctx = await requireStoreOwner(c);
  const body = await c.req.json().catch(() => ({}));

  // An allowlist, field by field. A merchant may describe their shop; they
  // may not set `status` (that is the platform's and their own pause switch,
  // handled separately), `slug` (a controlled change, below), or anything
  // that carries authority.
  const sets: string[] = [];
  const vals: unknown[] = [];
  const put = (col: string, v: unknown) => { sets.push(`${col} = ?`); vals.push(v); };

  if (body.name !== undefined) put('name', str(body.name, 'name', { min: 2, max: 60 }));
  if (body.tagline !== undefined) put('tagline', str(body.tagline, 'tagline', { min: 0, max: 140, required: false }));
  if (body.description !== undefined)
    put('description', str(body.description, 'description', { min: 0, max: 4000, required: false }));
  if (body.governorate !== undefined)
    put('governorate', str(body.governorate, 'governorate', { min: 0, max: 60, required: false }));
  if (body.contact_phone !== undefined)
    put('contact_phone', str(body.contact_phone, 'contact_phone', { min: 0, max: 32, required: false }));
  if (body.contact_phone_public !== undefined) put('contact_phone_public', body.contact_phone_public ? 1 : 0);
  if (body.accepts_custom_requests !== undefined)
    put('accepts_custom_requests', body.accepts_custom_requests ? 1 : 0);
  if (body.sells_direct_products !== undefined)
    put('sells_direct_products', body.sells_direct_products ? 1 : 0);
  if (body.logo_key !== undefined) put('logo_key', str(body.logo_key, 'logo_key', { min: 0, max: 200, required: false }) || null);
  if (body.banner_key !== undefined) put('banner_key', str(body.banner_key, 'banner_key', { min: 0, max: 200, required: false }) || null);

  // A PRESET NAME, never a colour value and never CSS. §12: nothing a
  // merchant types may become a style rule on the page.
  if (body.accent !== undefined) put('accent', oneOf(body.accent, 'accent', ACCENTS));

  for (const [key, col] of [
    ['categories', 'categories'],
    ['service_areas', 'service_areas'],
    ['business_hours', 'business_hours'],
  ] as const) {
    if (body[key] !== undefined) put(col, JSON.stringify(sanitizeList(body[key], 40, 60)));
  }
  if (body.policies !== undefined) put('policies', JSON.stringify(sanitizeMap(body.policies, 12, 2000)));
  if (body.social_links !== undefined) put('social_links', JSON.stringify(sanitizeLinks(body.social_links)));

  // The merchant's own pause switch. It can never lift an admin suspension:
  // that state is not reachable from here at all.
  if (body.open !== undefined) {
    if (ctx.store.status === 'suspended') {
      throw forbidden('This store is suspended by Levonis and cannot be re-opened from here');
    }
    put('status', body.open ? 'active' : 'paused');
  }

  if (!sets.length) return c.json({ success: true, store: storePublicShape(ctx, rootDomainFrom(c.env)) });

  put('updated_at', nowIso());
  vals.push(ctx.store.id, ctx.store.user_id);
  await c.env.DB.prepare(
    `UPDATE merchant_stores SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`
  ).bind(...vals).run();

  await audit(c.env.DB, ctx.store.user_id, 'merchant.store_updated', ctx.store.id, {
    fields: sets.map((s) => s.split(' = ')[0]),
  });
  const fresh = await storeForUser(c.env.DB, ctx.store.user_id);
  return c.json({ success: true, store: storePublicShape(fresh!, rootDomainFrom(c.env)) });
});

const ACCENTS = ['default', 'olive', 'gold', 'slate', 'plum', 'teal'] as const;

function sanitizeList(v: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim().slice(0, maxLen))
    .filter(Boolean)
    .slice(0, maxItems);
}

function sanitizeMap(v: unknown, maxKeys: number, maxLen: number): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  let n = 0;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (n++ >= maxKeys) break;
    if (typeof val === 'string') out[k.slice(0, 40)] = val.slice(0, maxLen);
  }
  return out;
}

/**
 * Social links, reduced to http(s) URLs only.
 * A `javascript:` or `data:` href in a store profile is a stored XSS against
 * every visitor of that storefront, so the scheme is checked on the way IN —
 * not left to the renderer to remember.
 */
function sanitizeLinks(v: unknown): Record<string, string> {
  const raw = sanitizeMap(v, 10, 300);
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(raw)) {
    try {
      const u = new URL(val);
      if (u.protocol === 'http:' || u.protocol === 'https:') out[k] = u.toString();
    } catch {
      /* not a URL — dropped */
    }
  }
  return out;
}

/**
 * Change the store address. Controlled, audited, and the old name is parked
 * rather than released (§68): every link and QR code already printed on a box
 * keeps meaning something, and a competitor cannot capture the traffic.
 */
merchantRoutes.post('/store/slug', async (c) => {
  await rateLimit(c, 'merchant-slug-change', 3, 86_400);
  const ctx = await requireSellingPrivileges(c);
  const body = await c.req.json().catch(() => ({}));

  const check = await checkSlug(c.env.DB, String(body.slug ?? ''), ctx.store.id);
  if (!check.ok) throw badRequest('That store address is not available', 'SLUG_UNAVAILABLE', { reason: check.reason });
  if (check.slug === ctx.store.slug) return c.json({ success: true, slug: ctx.store.slug, changed: false });

  const reservedUntil = new Date(Date.now() + SLUG_RESERVATION_DAYS * 86_400_000).toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE merchant_store_slugs SET active = 0, reserved_until = ? WHERE store_id = ? AND active = 1`
    ).bind(reservedUntil, ctx.store.id),
    c.env.DB.prepare(
      `INSERT INTO merchant_store_slugs (slug, store_id, active) VALUES (?, ?, 1)
       ON CONFLICT(slug) DO UPDATE SET active = 1, reserved_until = NULL, store_id = excluded.store_id`
    ).bind(check.slug, ctx.store.id),
    c.env.DB.prepare(`UPDATE merchant_stores SET slug = ?, updated_at = ? WHERE id = ? AND user_id = ?`)
      .bind(check.slug, nowIso(), ctx.store.id, ctx.store.user_id),
  ]);

  await audit(c.env.DB, ctx.store.user_id, 'merchant.slug_changed', ctx.store.id, {
    from: ctx.store.slug,
    to: check.slug,
  });
  return c.json({ success: true, slug: check.slug, changed: true, previous: ctx.store.slug });
});

// ----------------------------------------------------------------- products

merchantRoutes.get('/products', async (c) => {
  const ctx = await requireStoreOwner(c);
  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: 100, def: 50 });
  const cursor = c.req.query('cursor') || '';
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM community_products
      WHERE merchant_id = ? AND (? = '' OR created_at < ?)
      ORDER BY created_at DESC LIMIT ?`
  ).bind(ctx.merchant.id, cursor, cursor, limit).all();
  return c.json({
    success: true,
    products: results.map(productShape),
    next_cursor: results.length === limit ? String(results[results.length - 1].created_at) : null,
  });
});

/** Every field a merchant may set on a product, validated once, used by create and edit. */
async function readProductBody(c: Context<AppContext>, partial: boolean) {
  const body = await c.req.json().catch(() => ({}));
  const out: Record<string, unknown> = {};
  const has = (k: string) => body[k] !== undefined;
  const need = (k: string) => !partial || has(k);

  if (need('name')) out.name = str(body.name, 'name', { min: 2, max: 120 });
  if (has('name_ar')) out.name_ar = str(body.name_ar, 'name_ar', { min: 0, max: 120, required: false });
  if (has('description')) out.description = str(body.description, 'description', { min: 0, max: 6000, required: false });
  if (has('description_ar'))
    out.description_ar = str(body.description_ar, 'description_ar', { min: 0, max: 6000, required: false });
  if (need('price_iqd')) out.price_iqd = int(body.price_iqd, 'price_iqd', { min: 0, max: 1_000_000_000 });
  if (has('original_price_iqd'))
    out.original_price_iqd = body.original_price_iqd === null
      ? null
      : int(body.original_price_iqd, 'original_price_iqd', { min: 0, max: 1_000_000_000 });
  if (has('sku')) out.sku = str(body.sku, 'sku', { min: 0, max: 64, required: false });
  if (has('stock')) out.stock = int(body.stock, 'stock', { min: 0, max: 1_000_000 });
  if (has('track_stock')) out.track_stock = body.track_stock ? 1 : 0;
  if (has('category')) out.category = str(body.category, 'category', { min: 0, max: 60, required: false });
  if (has('condition')) out.condition = oneOf(body.condition, 'condition', ['new', 'used', 'refurbished'] as const);
  if (has('prep_days')) out.prep_days = int(body.prep_days, 'prep_days', { min: 0, max: 365 });
  if (has('images')) out.images = JSON.stringify(sanitizeList(body.images, 12, 300));
  if (has('options')) out.options = JSON.stringify(Array.isArray(body.options) ? body.options.slice(0, 20) : []);
  if (has('colors')) out.colors = JSON.stringify(Array.isArray(body.colors) ? body.colors.slice(0, 30) : []);
  if (has('delivery_methods')) out.delivery_methods = JSON.stringify(sanitizeList(body.delivery_methods, 10, 60));
  if (has('lifecycle'))
    out.lifecycle = oneOf(body.lifecycle, 'lifecycle', ['draft', 'active', 'hidden', 'sold_out', 'archived'] as const);
  return out;
}

merchantRoutes.post('/products', async (c) => {
  await rateLimit(c, 'merchant-product-create', 60, 3600);
  const ctx = await requireSellingPrivileges(c);
  const fields = await readProductBody(c, false);

  const id = newId('cp');
  const base = suggestSlug(String(fields.name)) || 'item';
  // The slug column is globally UNIQUE, so it is namespaced by store. Two
  // merchants may both sell a "bracket" without one of them failing to save.
  const slug = `${ctx.store.slug}-${base}-${id.slice(-6)}`.slice(0, 120);
  const ts = nowIso();

  const lifecycle = (fields.lifecycle as string) ?? 'active';
  await c.env.DB.prepare(
    `INSERT INTO community_products
       (id, merchant_id, store_id, slug, name, name_ar, description, description_ar, images,
        price_iqd, original_price_iqd, sku, stock, track_stock, category, condition,
        options, colors, delivery_methods, prep_days, status, lifecycle, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, ctx.merchant.id, ctx.store.id, slug,
    fields.name, fields.name_ar ?? '', fields.description ?? '', fields.description_ar ?? '',
    fields.images ?? '[]', fields.price_iqd, fields.original_price_iqd ?? null,
    fields.sku ?? '', fields.stock ?? 0, fields.track_stock ?? 1,
    fields.category ?? '', fields.condition ?? 'new',
    fields.options ?? '[]', fields.colors ?? '[]', fields.delivery_methods ?? '[]',
    fields.prep_days ?? 0,
    lifecycle === 'active' ? 'active' : 'hidden', lifecycle, ts, ts
  ).run();

  await audit(c.env.DB, ctx.store.user_id, 'merchant.product_created', id, { store: ctx.store.id });
  const row = await c.env.DB.prepare('SELECT * FROM community_products WHERE id = ?').bind(id).first();
  return c.json({ success: true, product: productShape(row as Record<string, unknown>) }, 201);
});

/**
 * Real editing. The previous dashboard could create and delete but not edit,
 * which meant a typo in a price could only be fixed by deleting the product
 * and losing its history.
 */
merchantRoutes.patch('/products/:id', async (c) => {
  await rateLimit(c, 'merchant-product-update', 120, 3600);
  const ctx = await requireSellingPrivileges(c);
  const id = c.req.param('id');
  const fields = await readProductBody(c, true);
  if (!Object.keys(fields).length) throw badRequest('Nothing to update');

  const sets = Object.keys(fields).map((k) => `${k} = ?`);
  const vals = Object.values(fields);
  // `status` mirrors `lifecycle` so the 0001 visibility column stays truthful
  // for every existing reader.
  if (fields.lifecycle !== undefined) {
    sets.push('status = ?');
    vals.push(fields.lifecycle === 'active' ? 'active' : 'hidden');
  }
  sets.push('updated_at = ?');
  vals.push(nowIso(), id, ctx.merchant.id);

  // The ownership clause is IN the statement. There is no path where a
  // product id from the URL reaches an update without it.
  const res = await c.env.DB.prepare(
    `UPDATE community_products SET ${sets.join(', ')} WHERE id = ? AND merchant_id = ?`
  ).bind(...vals).run();
  if (!res.meta.changes) throw notFound('Product not found');

  await audit(c.env.DB, ctx.store.user_id, 'merchant.product_updated', id, { fields: Object.keys(fields) });
  const row = await c.env.DB.prepare('SELECT * FROM community_products WHERE id = ?').bind(id).first();
  return c.json({ success: true, product: productShape(row as Record<string, unknown>) });
});

merchantRoutes.post('/products/:id/duplicate', async (c) => {
  await rateLimit(c, 'merchant-product-create', 60, 3600);
  const ctx = await requireSellingPrivileges(c);
  const src = await c.env.DB.prepare(
    'SELECT * FROM community_products WHERE id = ? AND merchant_id = ?'
  ).bind(c.req.param('id'), ctx.merchant.id).first<Record<string, unknown>>();
  if (!src) throw notFound('Product not found');

  const id = newId('cp');
  const ts = nowIso();
  // A duplicate starts as a DRAFT. Copying a live product straight to the
  // storefront would publish an unedited clone to real customers.
  await c.env.DB.prepare(
    `INSERT INTO community_products
       (id, merchant_id, store_id, slug, name, name_ar, description, description_ar, images,
        price_iqd, original_price_iqd, sku, stock, track_stock, category, condition,
        options, colors, delivery_methods, prep_days, status, lifecycle, created_at, updated_at)
     SELECT ?, merchant_id, store_id, ?, name || ' (copy)', name_ar, description, description_ar, images,
        price_iqd, original_price_iqd, '', stock, track_stock, category, condition,
        options, colors, delivery_methods, prep_days, 'hidden', 'draft', ?, ?
       FROM community_products WHERE id = ? AND merchant_id = ?`
  ).bind(id, `${ctx.store.slug}-copy-${id.slice(-6)}`, ts, ts, src.id, ctx.merchant.id).run();

  const row = await c.env.DB.prepare('SELECT * FROM community_products WHERE id = ?').bind(id).first();
  return c.json({ success: true, product: productShape(row as Record<string, unknown>) }, 201);
});

/**
 * Archive, not delete.
 *
 * A product that has ever been ordered is referenced by order lines, reviews
 * and a customer's own history. Removing the row would blank out what someone
 * actually bought. Archiving takes it off the storefront and leaves the
 * record intact — and `DELETE` is only honoured for a product nothing has
 * ever touched.
 */
merchantRoutes.delete('/products/:id', async (c) => {
  const ctx = await requireStoreOwner(c);
  const id = c.req.param('id');
  const sold = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM order_items WHERE community_product_id = ?'
  ).bind(id).first<{ n: number }>();

  if (sold && sold.n > 0) {
    const res = await c.env.DB.prepare(
      `UPDATE community_products SET lifecycle = 'archived', status = 'hidden', updated_at = ?
        WHERE id = ? AND merchant_id = ?`
    ).bind(nowIso(), id, ctx.merchant.id).run();
    if (!res.meta.changes) throw notFound('Product not found');
    await audit(c.env.DB, ctx.store.user_id, 'merchant.product_archived', id, { reason: 'has_orders' });
    return c.json({ success: true, archived: true });
  }

  const res = await c.env.DB.prepare(
    'DELETE FROM community_products WHERE id = ? AND merchant_id = ?'
  ).bind(id, ctx.merchant.id).run();
  if (!res.meta.changes) throw notFound('Product not found');
  await audit(c.env.DB, ctx.store.user_id, 'merchant.product_deleted', id, {});
  return c.json({ success: true, archived: false });
});

// ------------------------------------------------------------ notifications

merchantRoutes.get('/notifications', async (c) => {
  const ctx = await requireStoreOwner(c);
  const row = await c.env.DB.prepare(
    'SELECT * FROM merchant_notification_preferences WHERE merchant_id = ?'
  ).bind(ctx.merchant.id).first<Record<string, unknown>>();
  return c.json({ success: true, preferences: notificationShape(row), forced: FORCED_NOTIFICATIONS });
});

/**
 * Three of these cannot be switched off (§61). A merchant must not be able to
 * silence the notice that their subscription lapsed, that a dispute was
 * opened against them, or a platform security alert — those decide money and
 * standing. They are returned as `forced` so the UI can show them ON with a
 * reason rather than pretending the switch works.
 */
const FORCED_NOTIFICATIONS = ['complaints', 'subscription_expiry', 'system_alerts'] as const;
const NOTIFICATION_KEYS = [
  'new_orders', 'request_opportunities', 'new_messages', 'new_reviews',
  'new_followers', 'complaints', 'subscription_expiry', 'system_alerts', 'marketing',
] as const;

function notificationShape(row: Record<string, unknown> | null) {
  const out: Record<string, boolean> = {};
  for (const k of NOTIFICATION_KEYS) out[k] = row ? !!row[k] : true;
  for (const k of FORCED_NOTIFICATIONS) out[k] = true;
  return out;
}

merchantRoutes.patch('/notifications', async (c) => {
  await rateLimit(c, 'merchant-notifications', 30, 300);
  const ctx = await requireStoreOwner(c);
  const body = await c.req.json().catch(() => ({}));

  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const k of NOTIFICATION_KEYS) {
    if (body[k] === undefined) continue;
    // Accepted and stored, but forced back on: the merchant's preference is
    // remembered for the day policy changes, and today it does not apply.
    const on = (FORCED_NOTIFICATIONS as readonly string[]).includes(k) ? 1 : body[k] ? 1 : 0;
    sets.push(`${k} = ?`);
    vals.push(on);
  }
  if (!sets.length) throw badRequest('Nothing to update');

  await c.env.DB.prepare(
    `INSERT INTO merchant_notification_preferences (merchant_id) VALUES (?)
     ON CONFLICT(merchant_id) DO NOTHING`
  ).bind(ctx.merchant.id).run();

  sets.push('updated_at = ?');
  vals.push(nowIso(), ctx.merchant.id);
  await c.env.DB.prepare(
    `UPDATE merchant_notification_preferences SET ${sets.join(', ')} WHERE merchant_id = ?`
  ).bind(...vals).run();

  const row = await c.env.DB.prepare(
    'SELECT * FROM merchant_notification_preferences WHERE merchant_id = ?'
  ).bind(ctx.merchant.id).first<Record<string, unknown>>();
  return c.json({ success: true, preferences: notificationShape(row), forced: FORCED_NOTIFICATIONS });
});

// -------------------------------------------------------------- subscription

merchantRoutes.get('/subscription', async (c) => {
  const ctx = await requireStoreOwner(c);
  const user = c.get('user')!;
  const tier = await getTierStatus(c.env.DB, user.id);

  const { results: history } = await c.env.DB.prepare(
    `SELECT m.id, m.plan_id, m.tier, m.state, m.duration_months, m.starts_at, m.expires_at, m.source,
            p.price_iqd
       FROM memberships m LEFT JOIN membership_plans p ON p.id = m.plan_id
      WHERE m.user_id = ? ORDER BY m.created_at DESC LIMIT 20`
  ).bind(user.id).all();

  const daysLeft = tier.expires_at
    ? Math.max(0, Math.ceil((new Date(tier.expires_at).getTime() - Date.now()) / 86_400_000))
    : null;

  return c.json({
    success: true,
    tier: tier.tier,
    active: tier.active,
    expires_at: tier.expires_at,
    days_remaining: daysLeft,
    history,
    // Benefit by benefit, with the restricted ones named. §84: a merchant
    // whose capability was paused over a complaint should be able to see
    // WHICH one, not just find a button missing.
    benefits: {
      store: benefits.merchantStore(tier),
      products: benefits.merchantProducts(tier),
      orders: benefits.merchantOrders(tier),
      offers: benefits.communityOffers(tier),
      analytics: benefits.merchantAnalytics(tier),
      subdomain: benefits.merchantSubdomain(tier),
    },
    restricted: tier.gated_benefits,
    store_status: ctx.store.status,
    store_status_reason: ctx.store.status_reason,
    selling: await sellingStatus(c, ctx),
  });
});

// ---------------------------------------------------------------- followers

merchantRoutes.get('/followers', async (c) => {
  const ctx = await requireStoreOwner(c);
  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: 100, def: 50 });
  const cursor = c.req.query('cursor') || '';
  // Display name only. A follower list is not a customer directory, and a
  // merchant has no legitimate need for the email or phone of someone who
  // merely followed their shop (§51).
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.name, u.username, f.created_at
       FROM follows f JOIN users u ON u.id = f.user_id
      WHERE f.merchant_id = ? AND (? = '' OR f.created_at < ?)
      ORDER BY f.created_at DESC LIMIT ?`
  ).bind(ctx.merchant.id, cursor, cursor, limit).all();

  const total = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM follows WHERE merchant_id = ?'
  ).bind(ctx.merchant.id).first<{ n: number }>();

  return c.json({
    success: true,
    total: total?.n ?? 0,
    followers: results,
    next_cursor: results.length === limit ? String(results[results.length - 1].created_at) : null,
  });
});
