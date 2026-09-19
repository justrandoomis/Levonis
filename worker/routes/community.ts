import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { safeParse } from '../lib/types';
import { requireAuth, notFound, forbidden, str, int, jsonArray } from '../lib/http';
import { newId } from '../lib/crypto';
import { rateLimit } from '../lib/ratelimit';
import { getTierStatus, benefits, usersWithEntitlement } from '../lib/entitlements';
import { rootDomainFrom, storeUrl } from '../lib/hosts';
import { announceAfterResponse } from '../lib/adminTopicRouting';

export const communityRoutes = new Hono<AppContext>();

/**
 * PRO STATUS BADGE — deliberately separate from verification.
 *
 * `community_merchants.verified` remains an administrator's independent
 * moderation mark. `pro_badge` is an ACTIVE PRO membership status and is
 * never described as identity/KYC verification. PRO lapses → only the PRO
 * badge disappears; the admin mark is unchanged.
 *
 * Resolved for a whole page of merchants in two queries rather than one
 * getTierStatus per row, but through the SAME `benefits.proMerchantBadge`
 * check so the rule cannot drift from entitlements.ts.
 */
function merchantPublic(m: Record<string, unknown>, proBadges: Set<string>) {
  return {
    id: m.id,
    // The account behind the store, so a customer can open a conversation
    // with them. It is an opaque id — no email, no phone, nothing that
    // identifies the person beyond what the store page already shows — and
    // POST /api/chats/open is the only thing that accepts it.
    user_id: m.user_id,
    name: m.name,
    bio: m.bio,
    avatarUrl: m.avatar_key ? `/files/${m.avatar_key}` : null,
    verified: !!m.verified,
    pro_badge: proBadges.has(String(m.user_id)),
    created_at: m.created_at,
  };
}

function communityProductPublic(p: Record<string, unknown>) {
  return {
    id: p.id,
    slug: p.slug,
    merchant_id: p.merchant_id,
    name: p.name,
    name_ar: p.name_ar,
    description: p.description,
    description_ar: p.description_ar,
    images: safeParse(p.images, []),
    price_iqd: p.price_iqd,
    original_price_iqd: p.original_price_iqd,
    created_at: p.created_at,
  };
}

communityRoutes.get('/products', async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM community_products WHERE status = 'active' ORDER BY created_at DESC LIMIT 20"
  ).all();
  return c.json({ success: true, products: results.map(communityProductPublic) });
});

communityRoutes.get('/merchants', async (c) => {
  const root = rootDomainFrom(c.env);
  // The storefront half rides along so a directory card can send the visitor
  // straight to the shop's own address; a profile-only merchant has neither
  // slug nor URL and keeps the in-site page.
  const { results } = await c.env.DB.prepare(
    `SELECT cm.*, s.id AS store_id, s.slug AS store_slug, s.status AS store_status
       FROM community_merchants cm LEFT JOIN merchant_stores s ON s.merchant_id = cm.id
      ORDER BY cm.created_at DESC LIMIT 20`
  ).all<Record<string, unknown>>();
  const proBadges = await usersWithEntitlement(c.env.DB, results.map((m) => m.user_id), 'proMerchantBadge');
  return c.json({
    success: true,
    merchants: results.map((m) => ({
      ...merchantPublic(m, proBadges),
      store_slug: m.store_slug ?? null,
      // A suspended store is not advertised as a destination; the card falls
      // back to the in-site page. Paused shops keep their address — the page
      // itself says they are closed.
      store_url:
        m.store_slug && m.store_status !== 'suspended'
          ? storeUrl(String(m.store_slug), root, String(m.store_id))
          : null,
    })),
  });
});

communityRoutes.get('/requests', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT cr.*, u.username AS customer_username FROM community_requests cr
       LEFT JOIN users u ON u.id = cr.customer_id
      WHERE cr.status = 'open' ORDER BY cr.created_at DESC LIMIT 20`
  ).all<Record<string, unknown>>();
  return c.json({
    success: true,
    requests: results.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      status: r.status,
      customer_username: r.customer_username,
      created_at: r.created_at,
    })),
  });
});

communityRoutes.post('/requests', requireAuth, async (c) => {
  await rateLimit(c, 'community-request', 10, 3600);
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const title = str(body.title, 'title', { min: 3, max: 150 });
  const description = str(body.description, 'description', { max: 2000, required: false });
  const id = newId('creq');
  await c.env.DB.prepare(
    'INSERT INTO community_requests (id, customer_id, title, description) VALUES (?, ?, ?, ?)'
  )
    .bind(id, user.id, title, description)
    .run();
  return c.json({ success: true, id });
});

communityRoutes.post('/requests/:id/close', requireAuth, async (c) => {
  const user = c.get('user')!;
  const res = await c.env.DB.prepare(
    "UPDATE community_requests SET status = 'closed' WHERE id = ? AND customer_id = ?"
  )
    .bind(c.req.param('id'), user.id)
    .run();
  if (res.meta.changes === 0) throw notFound('Request not found');
  return c.json({ success: true });
});

// Merchant storefront ---------------------------------------------------------

communityRoutes.get('/store/:id', async (c) => {
  const id = c.req.param('id');
  const merchant = await c.env.DB.prepare('SELECT * FROM community_merchants WHERE id = ?')
    .bind(id)
    .first<Record<string, unknown>>();
  if (!merchant) throw notFound('Store not found');
  const [{ results: products }, followers] = await Promise.all([
    c.env.DB.prepare(
      "SELECT * FROM community_products WHERE merchant_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 100"
    )
      .bind(id)
      .all(),
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM follows WHERE merchant_id = ?').bind(id).first<{ n: number }>(),
  ]);
  const user = c.get('user');
  let following = false;
  if (user) {
    const f = await c.env.DB.prepare('SELECT 1 AS x FROM follows WHERE user_id = ? AND merchant_id = ?')
      .bind(user.id, id)
      .first();
    following = !!f;
  }
  const proBadges = await usersWithEntitlement(c.env.DB, [merchant.user_id], 'proMerchantBadge');
  return c.json({
    success: true,
    merchant: merchantPublic(merchant, proBadges),
    products: products.map(communityProductPublic),
    followers: followers?.n ?? 0,
    following,
  });
});

communityRoutes.post('/store/:id/follow', requireAuth, async (c) => {
  const user = c.get('user')!;
  const id = c.req.param('id');
  const merchant = await c.env.DB.prepare('SELECT id FROM community_merchants WHERE id = ?').bind(id).first();
  if (!merchant) throw notFound('Store not found');
  await c.env.DB.prepare(
    'INSERT INTO follows (user_id, merchant_id) VALUES (?, ?) ON CONFLICT DO NOTHING'
  )
    .bind(user.id, id)
    .run();
  return c.json({ success: true, following: true });
});

communityRoutes.delete('/store/:id/follow', requireAuth, async (c) => {
  const user = c.get('user')!;
  await c.env.DB.prepare('DELETE FROM follows WHERE user_id = ? AND merchant_id = ?')
    .bind(user.id, c.req.param('id'))
    .run();
  return c.json({ success: true, following: false });
});

communityRoutes.get('/followed', requireAuth, async (c) => {
  const user = c.get('user')!;
  const root = rootDomainFrom(c.env);
  const { results } = await c.env.DB.prepare(
    `SELECT cm.*, s.id AS store_id, s.slug AS store_slug, s.status AS store_status
       FROM follows f
       JOIN community_merchants cm ON cm.id = f.merchant_id
       LEFT JOIN merchant_stores s ON s.merchant_id = cm.id
      WHERE f.user_id = ? ORDER BY f.created_at DESC`
  )
    .bind(user.id)
    .all<Record<string, unknown>>();
  const proBadges = await usersWithEntitlement(c.env.DB, results.map((m) => m.user_id), 'proMerchantBadge');
  return c.json({
    success: true,
    merchants: results.map((m) => ({
      ...merchantPublic(m, proBadges),
      store_slug: m.store_slug ?? null,
      store_url:
        m.store_slug && m.store_status !== 'suspended'
          ? storeUrl(String(m.store_slug), root, String(m.store_id))
          : null,
    })),
  });
});

// Merchant self-service -------------------------------------------------------

/** The signed-in user's merchant profile (creates none; explicit setup). */
communityRoutes.get('/my-store', requireAuth, async (c) => {
  const user = c.get('user')!;
  const merchant = await c.env.DB.prepare('SELECT * FROM community_merchants WHERE user_id = ?')
    .bind(user.id)
    .first<Record<string, unknown>>();
  if (!merchant) return c.json({ success: true, merchant: null, products: [] });
  const { results: products } = await c.env.DB.prepare(
    'SELECT * FROM community_products WHERE merchant_id = ? ORDER BY created_at DESC'
  )
    .bind(merchant.id)
    .all();
  const proBadges = await usersWithEntitlement(c.env.DB, [user.id], 'proMerchantBadge');
  return c.json({ success: true, merchant: merchantPublic(merchant, proBadges), products: products.map(communityProductPublic) });
});

communityRoutes.post('/my-store', requireAuth, async (c) => {
  await rateLimit(c, 'store-save', 30, 3600);
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const name = str(body.name, 'name', { min: 2, max: 100 });
  const bio = str(body.bio, 'bio', { max: 500, required: false });

  const existing = await c.env.DB.prepare('SELECT id FROM community_merchants WHERE user_id = ?')
    .bind(user.id)
    .first<{ id: string }>();
  if (existing) {
    await c.env.DB.prepare('UPDATE community_merchants SET name = ?, bio = ? WHERE id = ?')
      .bind(name, bio, existing.id)
      .run();
    return c.json({ success: true, id: existing.id });
  }
  // Creating a NEW merchant profile is a PLUS benefit inherited by PREMIUM
  // and PRO — server-side tier check, never a client flag.
  // server-side tier check, never a client flag. Existing merchants above
  // are grandfathered for updates and product management.
  const status = await getTierStatus(c.env.DB, user.id);
  if (!benefits.merchantProfile(status)) {
    throw forbidden('يتطلب عضوية LEVO PLUS أو PREMIUM أو PRO / Requires an active LEVO PLUS, PREMIUM, or PRO membership');
  }

  const id = newId('cm');
  // verified stays 0 — the stored flag is the admin's mark. A PRO owner's
  // badge is resolved from the memberships ledger on every read instead
  // (proBadgeOwners), so it follows the membership and never goes stale.
  await c.env.DB.prepare('INSERT INTO community_merchants (id, user_id, name, bio) VALUES (?, ?, ?, ?)')
    .bind(id, user.id, name, bio)
    .run();
  /**
   * «⚡ Merchants verification» GETS ITS TRAFFIC.
   *
   * `verified` stays 0 above — the flag is the admin's mark, deliberately — so
   * this row is a person WAITING on a human. Nothing told that human. A new
   * merchant sat unverified for as long as it took somebody to notice, and an
   * unverified merchant is one whose customers see no badge on a store they
   * are being asked to pay.
   *
   * The name is a shopfront the merchant chose to publish, so it is the one
   * customer-supplied string that belongs here; the bio is not, because it is
   * 500 characters of prose and the id opens all of it in the admin panel.
   */
  announceAfterResponse(
    c,
    'merchant_verification',
    `⚡ New merchant profile awaiting verification` +
      `\nMerchant: ${id}` +
      `\nName: ${name.slice(0, 80)}`
  );
  return c.json({ success: true, id });
});

async function requireOwnMerchant(c: Context<AppContext>) {
  const user = c.get('user')!;
  const merchant = await c.env.DB.prepare('SELECT id FROM community_merchants WHERE user_id = ?')
    .bind(user.id)
    .first<{ id: string }>();
  if (!merchant) throw forbidden('Set up your store profile first');
  return merchant.id;
}

communityRoutes.post('/my-store/products', requireAuth, async (c) => {
  await rateLimit(c, 'store-product', 60, 3600);
  const merchantId = await requireOwnMerchant(c);
  const body = await c.req.json().catch(() => ({}));
  const name = str(body.name, 'name', { min: 2, max: 150 });
  const nameAr = str(body.name_ar, 'name_ar', { max: 150, required: false });
  const description = str(body.description, 'description', { max: 3000, required: false });
  const descriptionAr = str(body.description_ar, 'description_ar', { max: 3000, required: false });
  const price = int(body.price_iqd, 'price_iqd', { min: 0, max: 1_000_000_000 });
  const original = body.original_price_iqd == null ? null : int(body.original_price_iqd, 'original_price_iqd', { min: 0, max: 1_000_000_000 });
  const images = jsonArray(body.images, 'images', 12);

  const id = newId('cp');
  const slugBase = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'item';
  const slug = `${slugBase}-${id.slice(-6)}`;
  await c.env.DB.prepare(
    `INSERT INTO community_products (id, merchant_id, slug, name, name_ar, description, description_ar, images, price_iqd, original_price_iqd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, merchantId, slug, name, nameAr, description, descriptionAr, images, price, original)
    .run();
  return c.json({ success: true, id, slug });
});

communityRoutes.delete('/my-store/products/:id', requireAuth, async (c) => {
  const merchantId = await requireOwnMerchant(c);
  const res = await c.env.DB.prepare('DELETE FROM community_products WHERE id = ? AND merchant_id = ?')
    .bind(c.req.param('id'), merchantId)
    .run();
  if (res.meta.changes === 0) throw notFound('Product not found');
  return c.json({ success: true });
});

// Community profile completeness (used by the /community route guard).
communityRoutes.get('/profile-status', requireAuth, async (c) => {
  const user = c.get('user')!;
  const merchant = await c.env.DB.prepare('SELECT id FROM community_merchants WHERE user_id = ?')
    .bind(user.id)
    .first();
  // merchant_allowed: existing merchants are grandfathered; new stores need
  // an active paid membership (server-side inherited entitlement check).
  const status = await getTierStatus(c.env.DB, user.id);
  return c.json({
    success: true,
    complete: !!(user.username && user.name),
    hasStore: !!merchant,
    merchant_allowed: !!merchant || benefits.merchantProfile(status),
  });
});
