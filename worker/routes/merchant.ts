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

import { likePattern, sqlLikeClause } from '../lib/sqlLike';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { safeParse } from '../lib/types';
import { requireAuth, badRequest, forbidden, notFound, conflict, str, int, oneOf , pickFrom } from '../lib/http';
import { communityClosedRefusal, communityMayEnter, readCommunityGate } from '../lib/communityGate';
import { newId } from '../lib/crypto';
import { rateLimit } from '../lib/ratelimit';
import { audit } from '../lib/audit';
import { ownedMediaKey, ownedMediaUrls } from '../lib/mediaRefs';
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
import { parseCsv, toCsv } from '../lib/importCsv';
import { merchantBalance } from '../lib/escrowOps';
import { announceAfterResponse } from '../lib/adminTopicRouting';
import { notifyOrderStatus } from '../lib/orderNotify';

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
    profile_links: safeParse(s.profile_links, []),
    profile_facts: safeParse(s.profile_facts, []),
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
    section_id: p.section_id ?? null,
    featured: !!p.featured,
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
  // A NEW store is a new community merchant — a way INTO Levo Community — so
  // it waits while the community is under maintenance, exactly like a new
  // merchant from /api/community/my-store (owner, 2026-09-23; DECISIONS 110).
  // A store that already exists is untouched: it runs on its own address.
  if (!communityMayEnter(await readCommunityGate(c.env.DB), user)) throw communityClosedRefusal();
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
  /**
   * A STORE OPENING IS THE OTHER HALF OF «⚡ Merchants verification».
   *
   * community.ts announces the bare merchant profile; this batch creates the
   * merchant AND a public storefront on its own address, which is the version
   * a customer will actually land on. Nobody was told either. The slug is
   * included because it is the public URL and because a slug is the one field
   * of a new store an admin ever has to refuse — an impersonating address is
   * caught by reading it, not by opening the record.
   */
  announceAfterResponse(
    c,
    'merchant_verification',
    `⚡ New store awaiting verification` +
      `\nStore: ${storeId}` +
      `\nName: ${name.slice(0, 80)}` +
      `\nAddress: /${slug}`
  );
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
  // Logo and banner must address an object THIS platform issued to THIS
  // merchant. An arbitrary string here would put a URL the merchant chose
  // into every visitor's browser — an off-platform tracking pixel wearing a
  // shop's logo. Clearing is `''`; anything else that is not theirs is a 400
  // rather than a silent drop, because a merchant who uploaded a logo and got
  // no logo deserves to be told why.
  for (const [field, col] of [['logo_key', 'logo_key'], ['banner_key', 'banner_key']] as const) {
    if (body[field] === undefined) continue;
    const raw = str(body[field], field, { min: 0, max: 200, required: false });
    if (!raw) { put(col, null); continue; }
    const key = ownedMediaKey(raw, ctx.store.user_id);
    if (!key) throw badRequest(`${field} must be a file you uploaded to this store`);
    put(col, key);
  }

  // A PRESET NAME, never a colour value and never CSS. §12: nothing a
  // merchant types may become a style rule on the page.
  if (body.accent !== undefined) put('accent', oneOf(body.accent, 'accent', ACCENTS));

  for (const [key, col] of [
    ['categories', 'categories'],
    ['service_areas', 'service_areas'],
  ] as const) {
    if (body[key] !== undefined) put(col, JSON.stringify(sanitizeList(body[key], 40, 60)));
  }
  // Hours are {day, open, close} rows, not bare strings — the old string
  // sanitizer silently dropped every structured row the editor sent, so a
  // merchant who filled their hours saved an empty list.
  if (body.business_hours !== undefined) put('business_hours', JSON.stringify(sanitizeHours(body.business_hours)));
  if (body.policies !== undefined) put('policies', JSON.stringify(sanitizeMap(body.policies, 12, 2000)));
  if (body.social_links !== undefined) put('social_links', JSON.stringify(sanitizeLinks(body.social_links)));
  // The two profile-header rows: three link pills, three info cards. Icon is
  // a NAME from a fixed set the frontend maps to its own components; the url
  // is http(s) or dropped. Order is the array order the merchant saved.
  if (body.profile_links !== undefined) put('profile_links', JSON.stringify(sanitizeWidgets(body.profile_links, 'link')));
  if (body.profile_facts !== undefined) put('profile_facts', JSON.stringify(sanitizeWidgets(body.profile_facts, 'fact')));
  // The store's own delivery pricing, reduced to the two numbers checkout
  // reads (storeOrders.ts) plus a free-text note. Anything else is dropped.
  if (body.delivery_settings !== undefined) put('delivery_settings', JSON.stringify(sanitizeDelivery(body.delivery_settings)));

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

const ACCENTS = ['default', 'olive', 'gold', 'slate', 'plum', 'teal', 'blue'] as const;

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
 * The icon vocabulary of the profile widgets. A closed list, because an icon
 * name reaches the DOM as a component choice — an open string would be a
 * component-injection vector waiting for a clever payload.
 */
export const WIDGET_ICONS = [
  'link', 'globe', 'instagram', 'facebook', 'youtube', 'tiktok', 'telegram', 'whatsapp',
  'phone', 'map-pin', 'clock', 'package', 'truck', 'shield', 'star', 'printer',
  'layers', 'hammer', 'zap', 'award',
] as const;

interface ProfileWidget {
  icon: string;
  title: string;
  subtitle?: string;
  url?: string;
  visible: boolean;
}

function sanitizeWidgets(v: unknown, kind: 'link' | 'fact'): ProfileWidget[] {
  if (!Array.isArray(v)) return [];
  const out: ProfileWidget[] = [];
  for (const raw of v) {
    if (out.length >= 3) break;
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const icon = typeof r.icon === 'string' && (WIDGET_ICONS as readonly string[]).includes(r.icon) ? r.icon : 'link';
    const title = typeof r.title === 'string' ? r.title.trim().slice(0, 30) : '';
    if (!title) continue;
    const item: ProfileWidget = { icon, title, visible: r.visible !== false };
    if (kind === 'fact') {
      item.subtitle = typeof r.subtitle === 'string' ? r.subtitle.trim().slice(0, 40) : '';
    } else {
      try {
        const u = new URL(String(r.url ?? ''));
        const href = u.toString();
        // Same 300-char ceiling as sanitizeLinks: an uncapped stored URL is
        // replayed to every visitor of a public, unauthenticated endpoint.
        if ((u.protocol === 'http:' || u.protocol === 'https:') && href.length <= 300) item.url = href;
      } catch {
        /* not a URL — the item is kept for the editor; the public page skips
           url-less pills entirely until the merchant fixes it */
      }
    }
    out.push(item);
  }
  return out;
}

function sanitizeHours(v: unknown): Array<{ day: string; open: string; close: string }> {
  if (!Array.isArray(v)) return [];
  const time = (x: unknown) => (typeof x === 'string' && /^\d{1,2}:\d{2}$/.test(x.trim()) ? x.trim() : '');
  return v
    .map((row) => {
      if (typeof row === 'string') return { day: row.trim().slice(0, 60), open: '', close: '' };
      if (!row || typeof row !== 'object') return null;
      const r = row as Record<string, unknown>;
      const day = typeof r.day === 'string' ? r.day.trim().slice(0, 60) : '';
      return day ? { day, open: time(r.open), close: time(r.close) } : null;
    })
    .filter((r): r is { day: string; open: string; close: string } => !!r && !!r.day)
    .slice(0, 14);
}

function sanitizeDelivery(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const raw = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const fee = Number(raw.fee_iqd);
  const freeOver = Number(raw.free_over_iqd);
  if (Number.isFinite(fee) && fee >= 0) out.fee_iqd = Math.floor(Math.min(fee, 1_000_000));
  if (Number.isFinite(freeOver) && freeOver > 0) out.free_over_iqd = Math.floor(Math.min(freeOver, 1_000_000_000));
  if (typeof raw.note === 'string' && raw.note.trim()) out.note = raw.note.trim().slice(0, 200);
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

/**
 * The management list. Two modes on one route so old callers keep working:
 * the bare call (and ?cursor=) is the original newest-first cursor page,
 * while ?page= switches to the manager's filtered mode — search, section,
 * lifecycle, stock, price band, recency window, featured/deal flags, seven
 * sort orders, and an exact total for «عرض X-Y من Z». Every WHERE clause is
 * built from a fixed whitelist and bound parameters; nothing a merchant
 * types reaches the SQL text.
 */
merchantRoutes.get('/products', async (c) => {
  const ctx = await requireStoreOwner(c);
  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: 100, def: 50 });

  if (c.req.query('page') === undefined) {
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
  }

  const page = int(c.req.query('page'), 'page', { min: 1, max: 10_000, def: 1 });
  const q = str(c.req.query('q') ?? '', 'q', { min: 0, max: 120, required: false });
  const section = str(c.req.query('section') ?? '', 'section', { min: 0, max: 60, required: false });
  const lifecycle = c.req.query('lifecycle') ?? '';
  const stockFilter = c.req.query('stock') ?? '';
  const category = str(c.req.query('category') ?? '', 'category', { min: 0, max: 60, required: false });
  const priceMin = c.req.query('price_min') !== undefined ? int(c.req.query('price_min'), 'price_min', { min: 0, max: 1_000_000_000 }) : null;
  const priceMax = c.req.query('price_max') !== undefined ? int(c.req.query('price_max'), 'price_max', { min: 0, max: 1_000_000_000 }) : null;
  const days = c.req.query('days') !== undefined ? int(c.req.query('days'), 'days', { min: 1, max: 3650 }) : null;
  const featuredOnly = c.req.query('featured') === '1';
  const dealsOnly = c.req.query('deals') === '1';
  const sort = c.req.query('sort') ?? 'newest';

  const where: string[] = ['merchant_id = ?'];
  const binds: unknown[] = [ctx.merchant.id];
  if (q) {
    // LIKE special characters are literal search text here, not wildcards —
    // and the pattern is bounded in BYTES, which D1 caps at 50.
    const like = likePattern(q);
    where.push(`(${sqlLikeClause(['name', 'name_ar', 'sku'])})`);
    binds.push(like, like, like);
  }
  if (section === 'none') where.push('section_id IS NULL');
  else if (section) {
    where.push('section_id = ?');
    binds.push(section);
  }
  if (['draft', 'active', 'hidden', 'sold_out', 'archived'].includes(lifecycle)) {
    where.push('lifecycle = ?');
    binds.push(lifecycle);
  }
  if (stockFilter === 'in') where.push('(track_stock = 0 OR stock > 0)');
  else if (stockFilter === 'low') where.push('(track_stock = 1 AND stock > 0 AND stock <= 5)');
  else if (stockFilter === 'out') where.push('(track_stock = 1 AND stock <= 0)');
  else if (stockFilter === 'untracked') where.push('track_stock = 0');
  if (category) {
    where.push('category = ?');
    binds.push(category);
  }
  if (priceMin !== null) {
    where.push('price_iqd >= ?');
    binds.push(priceMin);
  }
  if (priceMax !== null) {
    where.push('price_iqd <= ?');
    binds.push(priceMax);
  }
  if (days !== null) {
    where.push('created_at >= ?');
    binds.push(new Date(Date.now() - days * 86_400_000).toISOString());
  }
  if (featuredOnly) where.push('featured = 1');
  if (dealsOnly) where.push('(original_price_iqd IS NOT NULL AND original_price_iqd > price_iqd)');

  const ORDERS: Record<string, string> = {
    newest: 'created_at DESC',
    oldest: 'created_at ASC',
    price_asc: 'price_iqd ASC, created_at DESC',
    price_desc: 'price_iqd DESC, created_at DESC',
    sales: 'sold_count DESC, created_at DESC',
    views: 'view_count DESC, created_at DESC',
    stock: 'stock ASC, created_at DESC',
    updated: "COALESCE(NULLIF(updated_at, ''), created_at) DESC",
  };
  const orderBy = pickFrom(ORDERS, sort, ORDERS.newest);

  const whereSql = where.join(' AND ');
  const [{ results }, count] = await Promise.all([
    c.env.DB.prepare(
      `SELECT * FROM community_products WHERE ${whereSql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`
    ).bind(...binds, limit, (page - 1) * limit).all(),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM community_products WHERE ${whereSql}`)
      .bind(...binds)
      .first<{ n: number }>(),
  ]);

  return c.json({
    success: true,
    products: results.map(productShape),
    total: count?.n ?? 0,
    page,
    limit,
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
  // Same rule as the store logo: a product picture is a URL a visitor's
  // browser will fetch, so it may only address this merchant's own uploads.
  // Filtered rather than refused — a merchant fixing a price should not be
  // blocked because an old image reference no longer resolves.
  if (has('images')) out.images = JSON.stringify(ownedMediaUrls(body.images, c.get('user')!.id, 8));
  if (has('options')) out.options = JSON.stringify(Array.isArray(body.options) ? body.options.slice(0, 20) : []);
  if (has('colors')) out.colors = JSON.stringify(Array.isArray(body.colors) ? body.colors.slice(0, 30) : []);
  if (has('delivery_methods')) out.delivery_methods = JSON.stringify(sanitizeList(body.delivery_methods, 10, 60));
  if (has('lifecycle'))
    out.lifecycle = oneOf(body.lifecycle, 'lifecycle', ['draft', 'active', 'hidden', 'sold_out', 'archived'] as const);
  if (has('featured')) out.featured = body.featured ? 1 : 0;
  // The section is checked against THIS store's sections at write time (the
  // caller's ctx is not available here) — see assertOwnSection in the routes.
  if (has('section_id'))
    out.section_id = body.section_id ? str(body.section_id, 'section_id', { min: 1, max: 60 }) : null;
  return out;
}

/** A section id in a product body must name one of the caller's OWN sections. */
async function assertOwnSection(c: Context<AppContext>, storeId: string, sectionId: unknown) {
  if (typeof sectionId !== 'string' || !sectionId) return;
  const row = await c.env.DB.prepare(
    'SELECT id FROM merchant_store_sections WHERE id = ? AND store_id = ?'
  ).bind(sectionId, storeId).first();
  if (!row) throw badRequest('That section does not belong to your store', 'SECTION_NOT_FOUND');
}

merchantRoutes.post('/products', async (c) => {
  await rateLimit(c, 'merchant-product-create', 60, 3600);
  const ctx = await requireSellingPrivileges(c);
  const fields = await readProductBody(c, false);
  await assertOwnSection(c, ctx.store.id, fields.section_id);

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
        options, colors, delivery_methods, prep_days, status, lifecycle,
        section_id, featured, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, ctx.merchant.id, ctx.store.id, slug,
    fields.name, fields.name_ar ?? '', fields.description ?? '', fields.description_ar ?? '',
    fields.images ?? '[]', fields.price_iqd, fields.original_price_iqd ?? null,
    fields.sku ?? '', fields.stock ?? 0, fields.track_stock ?? 1,
    fields.category ?? '', fields.condition ?? 'new',
    fields.options ?? '[]', fields.colors ?? '[]', fields.delivery_methods ?? '[]',
    fields.prep_days ?? 0,
    lifecycle === 'active' ? 'active' : 'hidden', lifecycle,
    fields.section_id ?? null, fields.featured ?? 0, ts, ts
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
  await assertOwnSection(c, ctx.store.id, fields.section_id);

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
        options, colors, delivery_methods, prep_days, status, lifecycle, section_id, featured,
        created_at, updated_at)
     SELECT ?, merchant_id, store_id, ?, name || ' (copy)', name_ar, description, description_ar, images,
        price_iqd, original_price_iqd, '', stock, track_stock, category, condition,
        options, colors, delivery_methods, prep_days, 'hidden', 'draft', section_id, featured, ?, ?
       FROM community_products WHERE id = ? AND merchant_id = ?`
  ).bind(id, `${ctx.store.slug}-copy-${id.slice(-6)}`, ts, ts, src.id, ctx.merchant.id).run();

  const row = await c.env.DB.prepare('SELECT * FROM community_products WHERE id = ?').bind(id).first();
  return c.json({ success: true, product: productShape(row as Record<string, unknown>) }, 201);
});

/**
 * The manager's stat cards, from real rows only. The weekly series buckets
 * products by CREATION week (the only per-product timestamp history that
 * exists), so every sparkline is a true statement: how this catalogue — and
 * each slice of it — grew. No invented month-over-month deltas.
 */
merchantRoutes.get('/products/stats', async (c) => {
  const ctx = await requireStoreOwner(c);
  const db = c.env.DB;
  const since = new Date(Date.now() - 12 * 7 * 86_400_000).toISOString();

  const [totals, weekly, categories, salesDaily] = await Promise.all([
    db.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN lifecycle = 'active' THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN lifecycle = 'draft' THEN 1 ELSE 0 END) AS draft,
              SUM(CASE WHEN lifecycle IN ('hidden','archived','sold_out') THEN 1 ELSE 0 END) AS hidden,
              SUM(CASE WHEN track_stock = 1 AND stock <= 0 AND lifecycle = 'active' THEN 1 ELSE 0 END) AS out_of_stock,
              COALESCE(SUM(view_count), 0) AS views,
              COALESCE(SUM(sold_count), 0) AS sold
         FROM community_products WHERE merchant_id = ?`
    ).bind(ctx.merchant.id).first<Record<string, number>>(),
    db.prepare(
      `SELECT substr(created_at, 1, 10) AS day, strftime('%Y-%W', created_at) AS week,
              COUNT(*) AS added,
              SUM(CASE WHEN lifecycle = 'active' THEN 1 ELSE 0 END) AS active_added,
              SUM(CASE WHEN lifecycle = 'draft' THEN 1 ELSE 0 END) AS draft_added,
              SUM(CASE WHEN lifecycle IN ('hidden','archived','sold_out') THEN 1 ELSE 0 END) AS hidden_added,
              COALESCE(SUM(view_count), 0) AS views
         FROM community_products
        WHERE merchant_id = ? AND created_at >= ?
        GROUP BY week ORDER BY week`
    ).bind(ctx.merchant.id, since).all(),
    db.prepare(
      `SELECT DISTINCT category FROM community_products
        WHERE merchant_id = ? AND category != '' ORDER BY category LIMIT 40`
    ).bind(ctx.merchant.id).all(),
    db.prepare(
      `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS orders, COALESCE(SUM(total_iqd), 0) AS gross
         FROM orders
        WHERE merchant_id = ? AND status != 'cancelled' AND created_at >= ?
        GROUP BY day ORDER BY day`
    ).bind(ctx.merchant.id, new Date(Date.now() - 14 * 86_400_000).toISOString()).all(),
  ]);

  return c.json({
    success: true,
    totals: {
      total: totals?.total ?? 0,
      active: totals?.active ?? 0,
      draft: totals?.draft ?? 0,
      hidden: totals?.hidden ?? 0,
      out_of_stock: totals?.out_of_stock ?? 0,
      views: totals?.views ?? 0,
      sold: totals?.sold ?? 0,
    },
    weekly: (weekly.results ?? []).map((w) => ({
      week: w.week,
      added: Number(w.added ?? 0),
      active_added: Number(w.active_added ?? 0),
      draft_added: Number(w.draft_added ?? 0),
      hidden_added: Number(w.hidden_added ?? 0),
      views: Number(w.views ?? 0),
    })),
    categories: (categories.results ?? []).map((r) => String(r.category)),
    sales_daily: (salesDaily.results ?? []).map((r) => ({
      day: r.day,
      orders: Number(r.orders ?? 0),
      gross: Number(r.gross ?? 0),
    })),
  });
});

/** One product's real numbers: lifetime views/sales plus settled revenue. */
merchantRoutes.get('/products/:id/insights', async (c) => {
  const ctx = await requireStoreOwner(c);
  const id = c.req.param('id');
  const product = await c.env.DB.prepare(
    'SELECT * FROM community_products WHERE id = ? AND merchant_id = ?'
  ).bind(id, ctx.merchant.id).first<Record<string, unknown>>();
  if (!product) throw notFound('Product not found');

  const revenue = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(i.line_total_iqd), 0) AS revenue, COALESCE(SUM(i.qty), 0) AS units,
            COUNT(DISTINCT i.order_id) AS orders
       FROM order_items i JOIN orders o ON o.id = i.order_id
      WHERE i.community_product_id = ? AND o.merchant_id = ? AND o.status != 'cancelled'`
  ).bind(id, ctx.merchant.id).first<Record<string, number>>();

  return c.json({
    success: true,
    product: productShape(product),
    insights: {
      views: Number(product.view_count ?? 0),
      sold: Number(product.sold_count ?? 0),
      revenue_iqd: revenue?.revenue ?? 0,
      units_ordered: revenue?.units ?? 0,
      orders: revenue?.orders ?? 0,
      created_at: product.created_at,
      updated_at: product.updated_at || product.created_at,
    },
  });
});

const PRODUCT_CSV_HEADER = [
  'name', 'name_ar', 'price_iqd', 'original_price_iqd', 'sku', 'stock', 'track_stock',
  'category', 'condition', 'prep_days', 'lifecycle', 'featured', 'section', 'description',
];

/** The whole catalogue as a spreadsheet — BOM for Excel-friendly Arabic. */
merchantRoutes.get('/products/export.csv', async (c) => {
  const ctx = await requireStoreOwner(c);
  const [{ results }, count] = await Promise.all([
    c.env.DB.prepare(
      `SELECT p.*, s.name AS section_name FROM community_products p
         LEFT JOIN merchant_store_sections s ON s.id = p.section_id
        WHERE p.merchant_id = ? ORDER BY p.created_at DESC LIMIT 2000`
    ).bind(ctx.merchant.id).all<Record<string, unknown>>(),
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM community_products WHERE merchant_id = ?')
      .bind(ctx.merchant.id)
      .first<{ n: number }>(),
  ]);
  // A silent cut would read as "that's the whole catalogue" — say so instead.
  const truncated = (count?.n ?? 0) > (results ?? []).length;

  const rows: string[][] = [
    [...PRODUCT_CSV_HEADER, 'sold_count', 'view_count', 'id', 'slug', 'created_at', 'updated_at'],
    ...(results ?? []).map((p) => [
      String(p.name ?? ''), String(p.name_ar ?? ''), String(p.price_iqd ?? 0),
      p.original_price_iqd === null || p.original_price_iqd === undefined ? '' : String(p.original_price_iqd),
      String(p.sku ?? ''), String(p.stock ?? 0), p.track_stock ? '1' : '0',
      String(p.category ?? ''), String(p.condition ?? 'new'), String(p.prep_days ?? 0),
      String(p.lifecycle ?? 'active'), p.featured ? '1' : '0', String(p.section_name ?? ''),
      String(p.description ?? ''),
      String(p.sold_count ?? 0), String(p.view_count ?? 0),
      String(p.id), String(p.slug), String(p.created_at ?? ''), String(p.updated_at ?? ''),
    ]),
  ];
  const csv = '\uFEFF' + toCsv(rows);
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="products.csv"',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(truncated ? { 'X-Levonis-Truncated': String(count?.n ?? 0) } : {}),
    },
  });
});

/**
 * Spreadsheet import, previewed before it commits. The caller sends the CSV
 * text; confirm=false answers with the per-row report and writes NOTHING;
 * confirm=true creates the valid rows. Imported products always start as
 * DRAFTS — a spreadsheet must not publish straight to real customers —
 * and every row passes the same bounds the editor enforces.
 */
merchantRoutes.post('/products/import', async (c) => {
  await rateLimit(c, 'merchant-product-import', 10, 3600);
  const ctx = await requireSellingPrivileges(c);
  const body = await c.req.json().catch(() => ({}));
  const csvText = str(body.csv, 'csv', { min: 1, max: 400_000 });
  const confirm = body.confirm === true;

  const grid = parseCsv(csvText.replace(/^\uFEFF/, ''));
  if (grid.length < 2) throw badRequest('The file has no data rows', 'CSV_EMPTY');
  const header = grid[0].map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  if (col('name') === -1 || col('price_iqd') === -1) {
    throw badRequest('The file must carry name and price_iqd columns', 'CSV_HEADER');
  }
  // Keep each row's ORIGINAL file line number so an error report points at
  // the line the merchant actually sees in their spreadsheet.
  const dataRows = grid
    .slice(1)
    .map((r, i) => ({ r, line: i + 2 }))
    .filter(({ r }) => r.some((cell) => cell.trim() !== ''));
  if (dataRows.length > 200) throw badRequest('Up to 200 rows per import', 'CSV_TOO_BIG');

  const sections = await c.env.DB.prepare(
    'SELECT id, name, name_ar FROM merchant_store_sections WHERE store_id = ?'
  ).bind(ctx.store.id).all<Record<string, unknown>>();
  const sectionByName = new Map<string, string>();
  for (const s of sections.results ?? []) {
    sectionByName.set(String(s.name).trim().toLowerCase(), String(s.id));
    if (s.name_ar) sectionByName.set(String(s.name_ar).trim().toLowerCase(), String(s.id));
  }

  const cell = (r: string[], name: string) => {
    const i = col(name);
    return i === -1 ? '' : (r[i] ?? '').trim();
  };
  const report: Array<{ row: number; name: string; ok: boolean; error?: string }> = [];
  const valid: Array<Record<string, unknown>> = [];
  for (const { r, line: rowNo } of dataRows) {
    const name = cell(r, 'name');
    try {
      if (name.length < 2 || name.length > 120) throw new Error('name must be 2-120 characters');
      const price = Number(cell(r, 'price_iqd'));
      if (!Number.isFinite(price) || price < 0 || price > 1_000_000_000) throw new Error('price_iqd is not a valid amount');
      const origRaw = cell(r, 'original_price_iqd');
      const orig = origRaw === '' ? null : Number(origRaw);
      if (orig !== null && (!Number.isFinite(orig) || orig < 0 || orig > 1_000_000_000)) throw new Error('original_price_iqd is not a valid amount');
      const stockRaw = cell(r, 'stock');
      const stock = stockRaw === '' ? 0 : Number(stockRaw);
      if (!Number.isFinite(stock) || stock < 0 || stock > 1_000_000) throw new Error('stock is not a valid count');
      const prepRaw = cell(r, 'prep_days');
      const prep = prepRaw === '' ? 0 : Number(prepRaw);
      if (!Number.isFinite(prep) || prep < 0 || prep > 365) throw new Error('prep_days must be 0-365');
      const condition = cell(r, 'condition') || 'new';
      if (!['new', 'used', 'refurbished'].includes(condition)) throw new Error('condition must be new/used/refurbished');
      const sectionName = cell(r, 'section').toLowerCase();
      const sectionId = sectionName ? sectionByName.get(sectionName) ?? null : null;
      if (sectionName && !sectionId) throw new Error(`unknown section «${cell(r, 'section')}»`);
      valid.push({
        name,
        name_ar: cell(r, 'name_ar').slice(0, 120),
        description: cell(r, 'description').slice(0, 6000),
        price_iqd: Math.round(price),
        original_price_iqd: orig === null ? null : Math.round(orig),
        sku: cell(r, 'sku').slice(0, 64),
        stock: Math.round(stock),
        track_stock: cell(r, 'track_stock') === '0' ? 0 : 1,
        category: cell(r, 'category').slice(0, 60),
        condition,
        prep_days: Math.round(prep),
        featured: cell(r, 'featured') === '1' ? 1 : 0,
        section_id: sectionId,
      });
      report.push({ row: rowNo, name, ok: true });
    } catch (e) {
      report.push({ row: rowNo, name: name || '—', ok: false, error: e instanceof Error ? e.message : 'invalid row' });
    }
  }

  let created = 0;
  if (confirm && valid.length) {
    const ts = nowIso();
    const stmts = valid.map((v) => {
      const id = newId('cp');
      return c.env.DB.prepare(
        `INSERT INTO community_products
           (id, merchant_id, store_id, slug, name, name_ar, description, price_iqd, original_price_iqd,
            sku, stock, track_stock, category, condition, prep_days, featured, section_id,
            status, lifecycle, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'hidden', 'draft', ?, ?)`
      ).bind(
        id, ctx.merchant.id, ctx.store.id,
        `${ctx.store.slug}-${suggestSlug(String(v.name)) || 'item'}-${id.slice(-6)}`.slice(0, 120),
        v.name, v.name_ar, v.description, v.price_iqd, v.original_price_iqd,
        v.sku, v.stock, v.track_stock, v.category, v.condition, v.prep_days,
        v.featured, v.section_id, ts, ts
      );
    });
    await c.env.DB.batch(stmts);
    created = valid.length;
    await audit(c.env.DB, ctx.store.user_id, 'merchant.products_imported', ctx.store.id, { created });
  }

  return c.json({
    success: true,
    confirmed: confirm,
    created,
    valid: valid.length,
    invalid: report.filter((r) => !r.ok).length,
    report,
  });
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

// ---------------------------------------------------------------- orders
//
// The section the old dashboard left empty with "no merchant-order backend
// exists yet". Every query is scoped to the caller's own merchant id, so a
// merchant sees their orders and nobody else's — the isolation is the WHERE
// clause, not a filter the client could drop.

/** Both commerce paths in one list, with an origin filter (§74). */
merchantRoutes.get('/orders', async (c) => {
  const ctx = await requireStoreOwner(c);
  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: 100, def: 30 });
  const cursor = c.req.query('cursor') || '';
  const status = c.req.query('status') || '';

  const { results } = await c.env.DB.prepare(
    `SELECT o.id, o.status, o.stage, o.origin, o.total_iqd, o.subtotal_iqd, o.shipping_iqd,
            o.platform_fee_iqd, o.merchant_receivable_iqd, o.payment_method_id,
            o.created_at, o.updated_at,
            u.name AS customer_name,
            (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id) AS item_count
       FROM orders o JOIN users u ON u.id = o.user_id
      WHERE o.merchant_id = ?
        AND (? = '' OR o.status = ?)
        AND (? = '' OR o.created_at < ?)
      ORDER BY o.created_at DESC LIMIT ?`
  ).bind(ctx.merchant.id, status, status, cursor, cursor, limit).all();

  return c.json({
    success: true,
    orders: results,
    next_cursor: results.length === limit ? String(results[results.length - 1].created_at) : null,
  });
});

/**
 * One order, in full — including what the merchant needs to actually deliver
 * it.
 *
 * The customer's delivery address and phone ARE shown here, because a
 * merchant who cannot reach the buyer cannot fulfil the order. What is not
 * shown is anything unrelated to this transaction: no wallet balance, no
 * other purchases, no account metadata, no other store's history (§51, §60).
 */
merchantRoutes.get('/orders/:id', async (c) => {
  const ctx = await requireStoreOwner(c);
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });

  // u.phone_e164, not u.phone — 0013 renamed the account's own number, and
  // this endpoint had never been called by a UI until now, so the stale
  // column name sat here unnoticed and 500'd on first real use.
  const order = await c.env.DB.prepare(
    `SELECT o.*, u.name AS customer_name, u.phone_e164 AS customer_phone
       FROM orders o JOIN users u ON u.id = o.user_id
      WHERE o.id = ? AND o.merchant_id = ?`
  ).bind(id, ctx.merchant.id).first<Record<string, unknown>>();
  if (!order) throw notFound('Order not found');

  /**
   * NAMED COLUMNS, NOT `SELECT *` — because this table now carries COST.
   *
   * Migration 0095 added `order_items.cost_iqd` and `cost_basis`, and this was
   * the last serializer in the codebase that returned every column of the
   * table straight to a third party. It happens to be safe today: the order is
   * fenced by `o.merchant_id = ?`, LEVONIS's own checkout never writes
   * `merchant_id`, and worker/routes/storeOrders.ts never writes a cost — so a
   * merchant would see NULL / 'unrecorded' on their own goods.
   *
   * That is a chain of three facts in three other files, and the day the owner
   * asks for gross margin on marketplace sales (0095's own note says they
   * might), writing a cost in storeOrders.ts would publish this shop's cost
   * base to an outside merchant with no code change here and no review. §11 is
   * «لا يراها في API» — the field list is how that stays true by construction
   * rather than by the next author noticing.
   */
  const items = await c.env.DB.prepare(
    `SELECT id, product_id, community_product_id, name_snapshot, image_snapshot, option_snapshot,
            qty, unit_price_iqd, line_total_iqd
       FROM order_items WHERE order_id = ?`
  ).bind(id).all();

  return c.json({
    success: true,
    order: {
      id: order.id,
      status: order.status,
      stage: order.stage,
      origin: order.origin,
      created_at: order.created_at,
      subtotal_iqd: order.subtotal_iqd,
      shipping_iqd: order.shipping_iqd,
      total_iqd: order.total_iqd,
      platform_fee_iqd: order.platform_fee_iqd,
      merchant_receivable_iqd: order.merchant_receivable_iqd,
      coupon_code: order.coupon_code ?? '',
      coupon_discount_iqd: order.coupon_discount_iqd ?? 0,
      payment_method_id: order.payment_method_id,
      due_on_delivery_iqd: order.due_on_delivery_iqd,
      customer_name: order.customer_name,
      // The number to call for THIS delivery: the one on the address the
      // customer chose at checkout, falling back to their account phone.
      customer_phone:
        (safeParse<Record<string, unknown>>(order.address_snapshot, {}).phone as string | undefined) ||
        order.customer_phone,
      address: safeParse(order.address_snapshot, {}),
    },
    items: items.results,
  });
});

/** The states a merchant may move their own order through. */
const MERCHANT_ORDER_FLOW: Record<string, readonly string[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['processing', 'cancelled'],
  processing: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  // Terminal: money settles on delivery, so there is no path onward.
  delivered: [],
  cancelled: [],
};

/**
 * Move an order forward.
 *
 * On delivery the merchant's pending payout becomes available (§77) — that
 * is the moment the sale is really theirs. The ledger row is flipped by a
 * conditional UPDATE keyed on the order, so a double tap cannot make the
 * money available twice.
 */
merchantRoutes.post('/orders/:id/status', async (c) => {
  await rateLimit(c, 'merchant-order-status', 120, 3600);
  const ctx = await requireStoreOwner(c);
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const body = await c.req.json().catch(() => ({}));
  const to = str(body.status, 'status', { min: 1, max: 30 });

  const order = await c.env.DB.prepare(
    'SELECT id, status FROM orders WHERE id = ? AND merchant_id = ?'
  ).bind(id, ctx.merchant.id).first<{ id: string; status: string }>();
  if (!order) throw notFound('Order not found');

  const allowed = MERCHANT_ORDER_FLOW[order.status] ?? [];
  if (!allowed.includes(to)) {
    throw conflict(`An order that is ${order.status} cannot become ${to}`);
  }

  const ts = nowIso();
  const stmts = [
    c.env.DB.prepare(
      `UPDATE orders SET status = ?, updated_at = ? WHERE id = ? AND merchant_id = ? AND status = ?`
    ).bind(to, ts, id, ctx.merchant.id, order.status),
  ];

  if (to === 'delivered') {
    stmts.push(
      c.env.DB.prepare(
        `UPDATE merchant_payout_ledger SET state = 'available'
          WHERE order_id = ? AND merchant_id = ? AND kind = 'sale_credit' AND state = 'pending'`
      ).bind(id, ctx.merchant.id)
    );
    /*
     * THE COMPLETION IS COUNTED ONCE, EVEN WHEN TWO TAPS BOTH READ `shipped`.
     *
     * Both taps pass the flow check above on the same stale read. The flip is
     * conditional on that status, so the second one matches zero rows — but
     * these two statements used to be unconditional, and the loser still
     * inserted a second «order_completed» reputation row and added a second
     * completed order. The ledger line above was always safe (it is fenced on
     * `state = 'pending'`); these were not.
     *
     * Both are now fenced on the one fact this batch establishes: the order IS
     * delivered and no completion has been recorded for it yet. The counter
     * runs FIRST because its guard reads the reputation row the next statement
     * writes; in the losing batch both guards see the winner's row and both
     * statements change nothing. One transaction, so there is no window between
     * them.
     */
    const notYetCounted = `EXISTS (SELECT 1 FROM orders WHERE id = ? AND merchant_id = ? AND status = 'delivered')
           AND NOT EXISTS (SELECT 1 FROM merchant_reputation_events
                            WHERE order_id = ? AND merchant_id = ? AND kind = 'order_completed')`;
    stmts.push(
      c.env.DB.prepare(
        `UPDATE community_merchants SET completed_orders = completed_orders + 1
          WHERE id = ? AND ${notYetCounted}`
      ).bind(ctx.merchant.id, id, ctx.merchant.id, id, ctx.merchant.id)
    );
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO merchant_reputation_events (id, merchant_id, kind, points, order_id)
         SELECT ?, ?, 'order_completed', 10, ?
          WHERE ${notYetCounted}`
      ).bind(newId('rep'), ctx.merchant.id, id, id, ctx.merchant.id, id, ctx.merchant.id)
    );
  }

  if (to === 'cancelled') {
    // The sale never happened: the pending credit is reversed rather than
    // deleted, so the ledger still explains itself.
    stmts.push(
      c.env.DB.prepare(
        `UPDATE merchant_payout_ledger SET state = 'reversed'
          WHERE order_id = ? AND merchant_id = ? AND kind = 'sale_credit' AND state = 'pending'`
      ).bind(id, ctx.merchant.id)
    );
  }

  const results = await c.env.DB.batch(stmts);
  // A double tap is a lost race, and the loser says so rather than reporting a
  // transition it did not make — and, above all, rather than telling the
  // customer twice. Nothing else in its batch changed anything (see above).
  if ((results[0]?.meta?.changes ?? 0) === 0) {
    throw conflict('The order changed while you were editing — reload and retry');
  }
  await audit(c.env.DB, ctx.store.user_id, 'merchant.order_status', id, { from: order.status, to });
  /*
   * THE BUYER IS TOLD, AS THE PLATFORM'S OWN DOORS TELL THEM.
   *
   * This route flipped a store order's status and notified nobody, so a
   * customer who bought from a community store heard nothing between «تم
   * استلام طلبك» and the parcel at the door. `notifyOrderStatus` is the one
   * writer the admin doors use: the same copy, the in-app row, the same event
   * key (so a replay is silent), and nothing for `processing`. After the
   * response, and flushed straight away rather than at the next cron.
   */
  try {
    c.executionCtx.waitUntil(
      notifyOrderStatus(c.env, id, to, { defer: (work) => c.executionCtx.waitUntil(work) })
    );
  } catch {
    // No ExecutionContext on this call path (a test harness): the notice is
    // still queued, just not kept alive past the response.
    void notifyOrderStatus(c.env, id, to);
  }
  return c.json({ success: true, status: to });
});

// ---------------------------------------------------------------- payouts

merchantRoutes.get('/payouts', async (c) => {
  const ctx = await requireStoreOwner(c);
  const balance = await merchantBalance(c.env.DB, ctx.merchant.id);
  const { results } = await c.env.DB.prepare(
    `SELECT id, kind, amount_iqd, state, order_id, community_order_id, note, created_at
       FROM merchant_payout_ledger WHERE merchant_id = ?
      ORDER BY created_at DESC LIMIT 100`
  ).bind(ctx.merchant.id).all();
  // The balance is a SUM over these rows, so the merchant can add up the
  // list and get the same number. A stored balance they could not reconcile
  // is the thing this design exists to avoid.
  return c.json({ success: true, balance, entries: results });
});

// ---------------------------------------------------------------- reviews

merchantRoutes.get('/reviews', async (c) => {
  const ctx = await requireStoreOwner(c);
  const { results } = await c.env.DB.prepare(
    `SELECT r.*, u.name AS customer_name
       FROM merchant_reviews r JOIN users u ON u.id = r.customer_id
      WHERE r.merchant_id = ? ORDER BY r.created_at DESC LIMIT 100`
  ).bind(ctx.merchant.id).all<Record<string, unknown>>();
  return c.json({
    success: true,
    reviews: results.map((r) => ({
      id: r.id,
      rating: r.rating,
      body: r.body,
      images: safeParse(r.images, []),
      customer_name: r.customer_name,
      merchant_reply: r.merchant_reply || null,
      merchant_replied_at: r.merchant_replied_at,
      hidden: !!r.hidden,
      order_id: r.order_id,
      community_order_id: r.community_order_id,
      created_at: r.created_at,
    })),
  });
});

/**
 * Reply to a review. Once.
 *
 * A merchant may answer a customer publicly, which is fair. They may not edit
 * that answer repeatedly after the fact, and they cannot touch the review
 * itself — hiding one is an admin moderation decision, never the reviewed
 * party's (§39).
 */
merchantRoutes.post('/reviews/:id/reply', async (c) => {
  await rateLimit(c, 'merchant-review-reply', 30, 3600);
  const ctx = await requireStoreOwner(c);
  const body = await c.req.json().catch(() => ({}));
  const reply = str(body.reply, 'reply', { min: 1, max: 1500 });

  const res = await c.env.DB.prepare(
    `UPDATE merchant_reviews SET merchant_reply = ?, merchant_replied_at = ?, updated_at = ?
      WHERE id = ? AND merchant_id = ? AND merchant_reply = ''`
  ).bind(reply, nowIso(), nowIso(), str(c.req.param('id'), 'id', { min: 1, max: 60 }), ctx.merchant.id).run();
  if (!res.meta.changes) throw conflict('That review is not yours, or you have already replied');

  return c.json({ success: true });
});

// -------------------------------------------------------------- customers

/**
 * The people who have actually bought from THIS store (§60).
 *
 * Not a user directory: it is built from this merchant's own orders, so a
 * merchant can only ever see someone they have traded with, and only the
 * totals of that trading relationship.
 */
merchantRoutes.get('/customers', async (c) => {
  const ctx = await requireStoreOwner(c);
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.name,
            COUNT(o.id) AS order_count,
            COALESCE(SUM(o.total_iqd), 0) AS lifetime_iqd,
            MAX(o.created_at) AS last_order_at
       FROM orders o JOIN users u ON u.id = o.user_id
      WHERE o.merchant_id = ?
      GROUP BY u.id, u.name
      ORDER BY last_order_at DESC LIMIT 100`
  ).bind(ctx.merchant.id).all();
  return c.json({ success: true, customers: results });
});

// -------------------------------------------------------------- analytics

/**
 * Real numbers, from this store's own rows (§50).
 *
 * Computed on read rather than from the pre-aggregated daily table, because
 * a store's lifetime volume is small enough to sum directly and a figure a
 * merchant can reconcile against their own order list is worth more than a
 * faster one they cannot.
 */
merchantRoutes.get('/analytics', async (c) => {
  const ctx = await requireStoreOwner(c);
  const user = c.get('user')!;
  const tier = await getTierStatus(c.env.DB, user.id);
  if (!benefits.merchantAnalytics(tier)) {
    throw forbidden('Analytics are part of LEVO PLUS. Renew to see them again.');
  }

  const orders = await c.env.DB.prepare(
    `SELECT COUNT(*) AS orders,
            COALESCE(SUM(total_iqd), 0) AS gross,
            COALESCE(SUM(platform_fee_iqd), 0) AS fees,
            COALESCE(SUM(merchant_receivable_iqd), 0) AS receivable,
            SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled
       FROM orders WHERE merchant_id = ?`
  ).bind(ctx.merchant.id).first<Record<string, number>>();

  const products = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN lifecycle = 'active' THEN 1 ELSE 0 END) AS active,
            COALESCE(SUM(view_count), 0) AS views,
            COALESCE(SUM(sold_count), 0) AS sold
       FROM community_products WHERE merchant_id = ?`
  ).bind(ctx.merchant.id).first<Record<string, number>>();

  const top = await c.env.DB.prepare(
    `SELECT id, name, sold_count, view_count, price_iqd FROM community_products
      WHERE merchant_id = ? ORDER BY sold_count DESC, view_count DESC LIMIT 5`
  ).bind(ctx.merchant.id).all();

  const offers = await c.env.DB.prepare(
    `SELECT COUNT(*) AS sent, SUM(CASE WHEN state = 'accepted' THEN 1 ELSE 0 END) AS accepted
       FROM community_offers WHERE merchant_id = ?`
  ).bind(ctx.merchant.id).first<Record<string, number>>();

  const followers = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM follows WHERE merchant_id = ?'
  ).bind(ctx.merchant.id).first<{ n: number }>();

  const repeat = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM (
       SELECT user_id FROM orders WHERE merchant_id = ? GROUP BY user_id HAVING COUNT(*) > 1
     )`
  ).bind(ctx.merchant.id).first<{ n: number }>();

  const orderCount = Number(orders?.orders ?? 0);
  const sent = Number(offers?.sent ?? 0);

  return c.json({
    success: true,
    orders: {
      total: orderCount,
      completed: Number(orders?.completed ?? 0),
      cancelled: Number(orders?.cancelled ?? 0),
      gross_iqd: Number(orders?.gross ?? 0),
      platform_fees_iqd: Number(orders?.fees ?? 0),
      receivable_iqd: Number(orders?.receivable ?? 0),
      // Guarded: an average over zero orders is not 0, it is "no data".
      average_order_iqd: orderCount ? Math.round(Number(orders?.gross ?? 0) / orderCount) : null,
    },
    products: {
      total: Number(products?.total ?? 0),
      active: Number(products?.active ?? 0),
      views: Number(products?.views ?? 0),
      sold: Number(products?.sold ?? 0),
    },
    top_products: top.results,
    offers: {
      sent,
      accepted: Number(offers?.accepted ?? 0),
      win_rate: sent ? Math.round((Number(offers?.accepted ?? 0) / sent) * 100) : null,
    },
    followers: followers?.n ?? 0,
    repeat_customers: repeat?.n ?? 0,
    rating: ctx.merchant.rating_count ? ctx.merchant.rating_avg_x100 / 100 : null,
    rating_count: ctx.merchant.rating_count,
    balance: await merchantBalance(c.env.DB, ctx.merchant.id),
  });
});

// ---------------------------------------------------------------- sections
//
// The shelves of the shop. Organising the catalogue is not a new commercial
// commitment, so a lapsed-PLUS merchant may still tidy their store —
// requireStoreOwner, not requireSellingPrivileges (§48).

function sectionShape(s: Record<string, unknown>) {
  return {
    id: s.id,
    name: s.name,
    name_ar: s.name_ar,
    sort_order: s.sort_order,
    active: !!s.active,
    product_count: s.product_count ?? undefined,
    created_at: s.created_at,
  };
}

merchantRoutes.get('/sections', async (c) => {
  const ctx = await requireStoreOwner(c);
  const { results } = await c.env.DB.prepare(
    `SELECT s.*, (SELECT COUNT(*) FROM community_products p
                   WHERE p.section_id = s.id AND p.lifecycle != 'archived') AS product_count
       FROM merchant_store_sections s WHERE s.store_id = ?
      ORDER BY s.sort_order, s.created_at`
  ).bind(ctx.store.id).all<Record<string, unknown>>();
  return c.json({ success: true, sections: results.map(sectionShape) });
});

merchantRoutes.post('/sections', async (c) => {
  await rateLimit(c, 'merchant-section', 60, 3600);
  const ctx = await requireStoreOwner(c);
  const body = await c.req.json().catch(() => ({}));
  const count = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM merchant_store_sections WHERE store_id = ?'
  ).bind(ctx.store.id).first<{ n: number }>();
  if ((count?.n ?? 0) >= 30) throw badRequest('A store can hold at most 30 sections');

  const id = newId('sec');
  await c.env.DB.prepare(
    `INSERT INTO merchant_store_sections (id, store_id, name, name_ar, sort_order, active)
     VALUES (?,?,?,?,?,1)`
  ).bind(
    id, ctx.store.id,
    str(body.name, 'name', { min: 1, max: 60 }),
    str(body.name_ar, 'name_ar', { min: 0, max: 60, required: false }),
    int(body.sort_order, 'sort_order', { min: 0, max: 999, def: 0 })
  ).run();
  const row = await c.env.DB.prepare('SELECT * FROM merchant_store_sections WHERE id = ?').bind(id).first();
  return c.json({ success: true, section: sectionShape(row as Record<string, unknown>) }, 201);
});

merchantRoutes.patch('/sections/:id', async (c) => {
  const ctx = await requireStoreOwner(c);
  const body = await c.req.json().catch(() => ({}));
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (body.name !== undefined) { sets.push('name = ?'); vals.push(str(body.name, 'name', { min: 1, max: 60 })); }
  if (body.name_ar !== undefined) { sets.push('name_ar = ?'); vals.push(str(body.name_ar, 'name_ar', { min: 0, max: 60, required: false })); }
  if (body.sort_order !== undefined) { sets.push('sort_order = ?'); vals.push(int(body.sort_order, 'sort_order', { min: 0, max: 999 })); }
  if (body.active !== undefined) { sets.push('active = ?'); vals.push(body.active ? 1 : 0); }
  if (!sets.length) throw badRequest('Nothing to update');
  vals.push(c.req.param('id'), ctx.store.id);
  const res = await c.env.DB.prepare(
    `UPDATE merchant_store_sections SET ${sets.join(', ')} WHERE id = ? AND store_id = ?`
  ).bind(...vals).run();
  if (!res.meta.changes) throw notFound('Section not found');
  return c.json({ success: true });
});

merchantRoutes.delete('/sections/:id', async (c) => {
  const ctx = await requireStoreOwner(c);
  const id = c.req.param('id');
  // Products survive their section: they become ungrouped, never deleted.
  const res = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE community_products SET section_id = NULL
        WHERE section_id = ? AND store_id = ?`
    ).bind(id, ctx.store.id),
    c.env.DB.prepare(
      'DELETE FROM merchant_store_sections WHERE id = ? AND store_id = ?'
    ).bind(id, ctx.store.id),
  ]);
  if (!res[1].meta.changes) throw notFound('Section not found');
  return c.json({ success: true });
});

// ---------------------------------------------------------------- services
//
// Advertising a service invites new work, so CREATING or re-activating one
// requires selling privileges; editing words or switching one off does not.

function serviceShape(s: Record<string, unknown>) {
  return {
    id: s.id,
    title: s.title,
    description: s.description,
    kind: s.kind,
    price_from_iqd: s.price_from_iqd,
    price_unit: s.price_unit,
    materials: safeParse(s.materials, []),
    imageUrl: s.image_key ? `/files/${s.image_key}` : null,
    active: !!s.active,
    sort_order: s.sort_order,
    created_at: s.created_at,
  };
}

const SERVICE_KINDS = ['print_service', 'design', 'finishing', 'scanning', 'repair', 'other'] as const;

async function readServiceBody(c: Context<AppContext>, userId: string, partial: boolean) {
  const body = await c.req.json().catch(() => ({}));
  const out: Record<string, unknown> = {};
  const has = (k: string) => body[k] !== undefined;
  if (!partial || has('title')) out.title = str(body.title, 'title', { min: 2, max: 90 });
  if (has('description')) out.description = str(body.description, 'description', { min: 0, max: 2000, required: false });
  if (has('kind')) out.kind = oneOf(body.kind, 'kind', SERVICE_KINDS);
  if (has('price_from_iqd'))
    out.price_from_iqd = body.price_from_iqd === null || body.price_from_iqd === ''
      ? null
      : int(body.price_from_iqd, 'price_from_iqd', { min: 0, max: 1_000_000_000 });
  if (has('price_unit')) out.price_unit = str(body.price_unit, 'price_unit', { min: 0, max: 40, required: false });
  if (has('materials')) out.materials = JSON.stringify(sanitizeList(body.materials, 20, 40));
  if (has('sort_order')) out.sort_order = int(body.sort_order, 'sort_order', { min: 0, max: 999 });
  if (has('active')) out.active = body.active ? 1 : 0;
  if (has('image_key')) {
    const raw = str(body.image_key, 'image_key', { min: 0, max: 200, required: false });
    if (!raw) out.image_key = null;
    else {
      const key = ownedMediaKey(raw, userId);
      if (!key) throw badRequest('image_key must be a file you uploaded to this store');
      out.image_key = key;
    }
  }
  return out;
}

merchantRoutes.get('/services', async (c) => {
  const ctx = await requireStoreOwner(c);
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM merchant_services WHERE store_id = ? ORDER BY sort_order, created_at'
  ).bind(ctx.store.id).all<Record<string, unknown>>();
  return c.json({ success: true, services: results.map(serviceShape) });
});

merchantRoutes.post('/services', async (c) => {
  await rateLimit(c, 'merchant-service', 60, 3600);
  const ctx = await requireSellingPrivileges(c);
  const count = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM merchant_services WHERE store_id = ?'
  ).bind(ctx.store.id).first<{ n: number }>();
  if ((count?.n ?? 0) >= 40) throw badRequest('A store can list at most 40 services');

  const f = await readServiceBody(c, ctx.store.user_id, false);
  const id = newId('svc');
  const ts = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO merchant_services
       (id, store_id, merchant_id, title, description, kind, price_from_iqd, price_unit,
        materials, image_key, active, sort_order, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, ctx.store.id, ctx.merchant.id,
    f.title, f.description ?? '', f.kind ?? 'print_service',
    f.price_from_iqd ?? null, f.price_unit ?? '', f.materials ?? '[]',
    f.image_key ?? null, f.active ?? 1, f.sort_order ?? 0, ts, ts
  ).run();
  await audit(c.env.DB, ctx.store.user_id, 'merchant.service_created', id, { store: ctx.store.id });
  const row = await c.env.DB.prepare('SELECT * FROM merchant_services WHERE id = ?').bind(id).first();
  return c.json({ success: true, service: serviceShape(row as Record<string, unknown>) }, 201);
});

merchantRoutes.patch('/services/:id', async (c) => {
  const ctx = await requireStoreOwner(c);
  const f = await readServiceBody(c, ctx.store.user_id, true);
  if (!Object.keys(f).length) throw badRequest('Nothing to update');
  // Switching a service back ON is a new invitation to the public — that one
  // transition needs selling privileges, the rest is bookkeeping.
  if (f.active === 1) await requireSellingPrivileges(c);
  const sets = Object.keys(f).map((k) => `${k} = ?`);
  const vals = Object.values(f);
  sets.push('updated_at = ?');
  vals.push(nowIso(), c.req.param('id'), ctx.store.id);
  const res = await c.env.DB.prepare(
    `UPDATE merchant_services SET ${sets.join(', ')} WHERE id = ? AND store_id = ?`
  ).bind(...vals).run();
  if (!res.meta.changes) throw notFound('Service not found');
  return c.json({ success: true });
});

merchantRoutes.delete('/services/:id', async (c) => {
  const ctx = await requireStoreOwner(c);
  const res = await c.env.DB.prepare(
    'DELETE FROM merchant_services WHERE id = ? AND store_id = ?'
  ).bind(c.req.param('id'), ctx.store.id).run();
  if (!res.meta.changes) throw notFound('Service not found');
  return c.json({ success: true });
});

// ---------------------------------------------------------------- showcase
//
// The workshop wall: printers, materials, finished works. Pure content.

function showcaseShape(s: Record<string, unknown>) {
  return {
    id: s.id,
    kind: s.kind,
    title: s.title,
    details: s.details,
    imageUrl: s.image_key ? `/files/${s.image_key}` : null,
    sort_order: s.sort_order,
    active: !!s.active,
    created_at: s.created_at,
  };
}

merchantRoutes.get('/showcase', async (c) => {
  const ctx = await requireStoreOwner(c);
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM merchant_showcase WHERE store_id = ? ORDER BY kind, sort_order, created_at'
  ).bind(ctx.store.id).all<Record<string, unknown>>();
  return c.json({ success: true, items: results.map(showcaseShape) });
});

merchantRoutes.post('/showcase', async (c) => {
  await rateLimit(c, 'merchant-showcase', 120, 3600);
  const ctx = await requireStoreOwner(c);
  const body = await c.req.json().catch(() => ({}));
  const count = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM merchant_showcase WHERE store_id = ?'
  ).bind(ctx.store.id).first<{ n: number }>();
  if ((count?.n ?? 0) >= 60) throw badRequest('A store can show at most 60 showcase items');

  let imageKey: string | null = null;
  if (body.image_key) {
    imageKey = ownedMediaKey(String(body.image_key), ctx.store.user_id);
    if (!imageKey) throw badRequest('image_key must be a file you uploaded to this store');
  }
  const id = newId('shw');
  await c.env.DB.prepare(
    `INSERT INTO merchant_showcase (id, store_id, kind, title, details, image_key, sort_order, active)
     VALUES (?,?,?,?,?,?,?,1)`
  ).bind(
    id, ctx.store.id,
    oneOf(body.kind, 'kind', ['printer', 'material', 'work'] as const),
    str(body.title, 'title', { min: 1, max: 90 }),
    str(body.details, 'details', { min: 0, max: 1000, required: false }),
    imageKey,
    int(body.sort_order, 'sort_order', { min: 0, max: 999, def: 0 })
  ).run();
  const row = await c.env.DB.prepare('SELECT * FROM merchant_showcase WHERE id = ?').bind(id).first();
  return c.json({ success: true, item: showcaseShape(row as Record<string, unknown>) }, 201);
});

merchantRoutes.patch('/showcase/:id', async (c) => {
  const ctx = await requireStoreOwner(c);
  const body = await c.req.json().catch(() => ({}));
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (body.title !== undefined) { sets.push('title = ?'); vals.push(str(body.title, 'title', { min: 1, max: 90 })); }
  if (body.details !== undefined) { sets.push('details = ?'); vals.push(str(body.details, 'details', { min: 0, max: 1000, required: false })); }
  if (body.kind !== undefined) { sets.push('kind = ?'); vals.push(oneOf(body.kind, 'kind', ['printer', 'material', 'work'] as const)); }
  if (body.sort_order !== undefined) { sets.push('sort_order = ?'); vals.push(int(body.sort_order, 'sort_order', { min: 0, max: 999 })); }
  if (body.active !== undefined) { sets.push('active = ?'); vals.push(body.active ? 1 : 0); }
  if (body.image_key !== undefined) {
    const raw = String(body.image_key ?? '');
    if (!raw) { sets.push('image_key = ?'); vals.push(null); }
    else {
      const key = ownedMediaKey(raw, ctx.store.user_id);
      if (!key) throw badRequest('image_key must be a file you uploaded to this store');
      sets.push('image_key = ?');
      vals.push(key);
    }
  }
  if (!sets.length) throw badRequest('Nothing to update');
  vals.push(c.req.param('id'), ctx.store.id);
  const res = await c.env.DB.prepare(
    `UPDATE merchant_showcase SET ${sets.join(', ')} WHERE id = ? AND store_id = ?`
  ).bind(...vals).run();
  if (!res.meta.changes) throw notFound('Showcase item not found');
  return c.json({ success: true });
});

merchantRoutes.delete('/showcase/:id', async (c) => {
  const ctx = await requireStoreOwner(c);
  const res = await c.env.DB.prepare(
    'DELETE FROM merchant_showcase WHERE id = ? AND store_id = ?'
  ).bind(c.req.param('id'), ctx.store.id).run();
  if (!res.meta.changes) throw notFound('Showcase item not found');
  return c.json({ success: true });
});

// ---------------------------------------------------------------- coupons
//
// The merchant's own discount codes. A coupon changes what customers pay, so
// creating or re-activating one needs selling privileges; pausing one never
// does. The codes are validated ONLY inside the store checkout — nothing here
// touches the platform's membership coupons.

function couponShape(cp: Record<string, unknown>) {
  return {
    id: cp.id,
    code: cp.code,
    kind: cp.kind,
    value: cp.value,
    min_total_iqd: cp.min_total_iqd,
    max_uses: cp.max_uses,
    used_count: cp.used_count,
    active: !!cp.active,
    starts_at: cp.starts_at,
    ends_at: cp.ends_at,
    created_at: cp.created_at,
  };
}

function normalizeCouponCode(v: unknown): string {
  const code = String(v ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{2,29}$/.test(code)) {
    throw badRequest('A code is 3–30 characters: letters, numbers and hyphens', 'BAD_COUPON_CODE');
  }
  return code;
}

function couponDates(body: Record<string, unknown>) {
  const out: { starts_at: string | null; ends_at: string | null } = { starts_at: null, ends_at: null };
  for (const k of ['starts_at', 'ends_at'] as const) {
    const v = body[k];
    if (typeof v === 'string' && v) {
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) throw badRequest(`${k} is not a valid date`);
      out[k] = d.toISOString();
    }
  }
  return out;
}

merchantRoutes.get('/coupons', async (c) => {
  const ctx = await requireStoreOwner(c);
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM merchant_coupons WHERE store_id = ? ORDER BY created_at DESC LIMIT 100'
  ).bind(ctx.store.id).all<Record<string, unknown>>();
  return c.json({ success: true, coupons: results.map(couponShape) });
});

merchantRoutes.post('/coupons', async (c) => {
  await rateLimit(c, 'merchant-coupon', 30, 3600);
  const ctx = await requireSellingPrivileges(c);
  const body = await c.req.json().catch(() => ({}));

  const code = normalizeCouponCode(body.code);
  const kind = oneOf(body.kind, 'kind', ['fixed_iqd', 'percent'] as const);
  const value = int(body.value, 'value', { min: 1, max: kind === 'percent' ? 90 : 100_000_000 });
  const dates = couponDates(body);

  const id = newId('mcp');
  const ts = nowIso();
  try {
    await c.env.DB.prepare(
      `INSERT INTO merchant_coupons
         (id, store_id, merchant_id, code, kind, value, min_total_iqd, max_uses,
          active, starts_at, ends_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?)`
    ).bind(
      id, ctx.store.id, ctx.merchant.id, code, kind, value,
      int(body.min_total_iqd, 'min_total_iqd', { min: 0, max: 1_000_000_000, def: 0 }),
      body.max_uses ? int(body.max_uses, 'max_uses', { min: 1, max: 1_000_000 }) : null,
      dates.starts_at, dates.ends_at, ts, ts
    ).run();
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw conflict('You already have a coupon with that code');
    throw e;
  }
  await audit(c.env.DB, ctx.store.user_id, 'merchant.coupon_created', id, { code, kind, value });
  const row = await c.env.DB.prepare('SELECT * FROM merchant_coupons WHERE id = ?').bind(id).first();
  return c.json({ success: true, coupon: couponShape(row as Record<string, unknown>) }, 201);
});

merchantRoutes.patch('/coupons/:id', async (c) => {
  const ctx = await requireStoreOwner(c);
  const body = await c.req.json().catch(() => ({}));
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (body.active !== undefined) {
    if (body.active) await requireSellingPrivileges(c);
    sets.push('active = ?');
    vals.push(body.active ? 1 : 0);
  }
  if (body.min_total_iqd !== undefined) {
    sets.push('min_total_iqd = ?');
    vals.push(int(body.min_total_iqd, 'min_total_iqd', { min: 0, max: 1_000_000_000 }));
  }
  if (body.max_uses !== undefined) {
    sets.push('max_uses = ?');
    vals.push(body.max_uses ? int(body.max_uses, 'max_uses', { min: 1, max: 1_000_000 }) : null);
  }
  if (body.starts_at !== undefined || body.ends_at !== undefined) {
    const dates = couponDates(body);
    if (body.starts_at !== undefined) { sets.push('starts_at = ?'); vals.push(dates.starts_at); }
    if (body.ends_at !== undefined) { sets.push('ends_at = ?'); vals.push(dates.ends_at); }
  }
  // Code, kind and value are immutable: a coupon someone saved to use later
  // must still mean what it said. Wrong terms → deactivate, make a new one.
  if (!sets.length) throw badRequest('Nothing to update');
  sets.push('updated_at = ?');
  vals.push(nowIso(), c.req.param('id'), ctx.store.id);
  const res = await c.env.DB.prepare(
    `UPDATE merchant_coupons SET ${sets.join(', ')} WHERE id = ? AND store_id = ?`
  ).bind(...vals).run();
  if (!res.meta.changes) throw notFound('Coupon not found');
  return c.json({ success: true });
});

merchantRoutes.delete('/coupons/:id', async (c) => {
  const ctx = await requireStoreOwner(c);
  // A used coupon is deactivated, not erased: orders reference its code.
  const used = await c.env.DB.prepare(
    'SELECT used_count FROM merchant_coupons WHERE id = ? AND store_id = ?'
  ).bind(c.req.param('id'), ctx.store.id).first<{ used_count: number }>();
  if (!used) throw notFound('Coupon not found');
  if (used.used_count > 0) {
    await c.env.DB.prepare(
      'UPDATE merchant_coupons SET active = 0, updated_at = ? WHERE id = ? AND store_id = ?'
    ).bind(nowIso(), c.req.param('id'), ctx.store.id).run();
    return c.json({ success: true, deactivated: true });
  }
  await c.env.DB.prepare(
    'DELETE FROM merchant_coupons WHERE id = ? AND store_id = ?'
  ).bind(c.req.param('id'), ctx.store.id).run();
  return c.json({ success: true, deactivated: false });
});

// ------------------------------------------------------------ custom orders
//
// The community-order side of the dashboard reads /api/marketplace/orders
// directly — the lifecycle lives there. What the dashboard needs from HERE is
// only the count of actionable ones, for the overview badge.
merchantRoutes.get('/custom-orders/summary', async (c) => {
  const ctx = await requireStoreOwner(c);
  const row = await c.env.DB.prepare(
    `SELECT
       SUM(CASE WHEN state = 'funded' THEN 1 ELSE 0 END) AS to_start,
       SUM(CASE WHEN state = 'in_progress' THEN 1 ELSE 0 END) AS in_progress,
       SUM(CASE WHEN state = 'merchant_marked_delivered' THEN 1 ELSE 0 END) AS awaiting_customer
       FROM community_orders WHERE merchant_id = ?`
  ).bind(ctx.merchant.id).first<Record<string, number>>();
  return c.json({
    success: true,
    to_start: Number(row?.to_start ?? 0),
    in_progress: Number(row?.in_progress ?? 0),
    awaiting_customer: Number(row?.awaiting_customer ?? 0),
  });
});
