import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { safeParse } from '../lib/types';
import { requireAuth, notFound, forbidden, str, int, jsonArray } from '../lib/http';
import { newId } from '../lib/crypto';
import { rateLimit } from '../lib/ratelimit';

export const communityRoutes = new Hono<AppContext>();

function merchantPublic(m: Record<string, unknown>) {
  return {
    id: m.id,
    name: m.name,
    bio: m.bio,
    avatarUrl: m.avatar_key ? `/files/${m.avatar_key}` : null,
    verified: !!m.verified,
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
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM community_merchants ORDER BY created_at DESC LIMIT 20'
  ).all();
  return c.json({ success: true, merchants: results.map(merchantPublic) });
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
  return c.json({
    success: true,
    merchant: merchantPublic(merchant),
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
  const { results } = await c.env.DB.prepare(
    `SELECT cm.* FROM follows f JOIN community_merchants cm ON cm.id = f.merchant_id
      WHERE f.user_id = ? ORDER BY f.created_at DESC`
  )
    .bind(user.id)
    .all();
  return c.json({ success: true, merchants: results.map(merchantPublic) });
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
  return c.json({ success: true, merchant: merchantPublic(merchant), products: products.map(communityProductPublic) });
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
  const id = newId('cm');
  // verified stays 0 — only an admin can mark a merchant verified.
  await c.env.DB.prepare('INSERT INTO community_merchants (id, user_id, name, bio) VALUES (?, ?, ?, ?)')
    .bind(id, user.id, name, bio)
    .run();
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
  return c.json({ success: true, complete: !!(user.username && user.name), hasStore: !!merchant });
});
