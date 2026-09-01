/**
 * Saved store products — /api/community-favorites/*.
 *
 * The heart on a storefront product card. Deliberately NOT part of
 * /api/storefront/*: those responses are identical for every viewer (§59),
 * so per-user state lives here behind auth, and the profile page intersects
 * the two client-side — the same split the follow feature uses.
 *
 * Mounted on every host: a visitor hearts a product on the store's own
 * subdomain as naturally as on the apex, the shared parent-domain cookie
 * carrying their session across.
 */

import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAuth, notFound } from '../lib/http';
import { rateLimit } from '../lib/ratelimit';
import { rootDomainFrom, storeUrl } from '../lib/hosts';

export const communityFavoriteRoutes = new Hono<AppContext>();

/** The saved list, newest first, joined to what is still actually for sale. */
communityFavoriteRoutes.get('/', requireAuth, async (c) => {
  const user = c.get('user')!;
  const db = c.env.DB;
  const root = rootDomainFrom(c.env);
  const { results } = await db
    .prepare(
      `SELECT f.product_id, f.created_at AS saved_at,
              p.slug, p.name, p.name_ar, p.images, p.price_iqd, p.original_price_iqd,
              p.stock, p.track_stock,
              s.slug AS store_slug, s.name AS store_name, s.id AS store_id, s.status AS store_status
         FROM community_product_favorites f
         JOIN community_products p ON p.id = f.product_id
         JOIN merchant_stores s ON s.id = p.store_id
        WHERE f.user_id = ? AND p.status = 'active' AND p.lifecycle = 'active'
        ORDER BY f.created_at DESC
        LIMIT 100`
    )
    .bind(user.id)
    .all();
  return c.json({
    items: (results ?? []).map((r) => {
      let image: string | null = null;
      try {
        const imgs = JSON.parse(String(r.images ?? '[]'));
        image = Array.isArray(imgs) && imgs.length ? String(imgs[0]) : null;
      } catch {
        image = null;
      }
      return {
        product_id: r.product_id,
        slug: r.slug,
        name: r.name,
        name_ar: r.name_ar,
        image,
        price_iqd: r.price_iqd,
        original_price_iqd: r.original_price_iqd,
        in_stock: !r.track_stock || Number(r.stock ?? 0) > 0,
        saved_at: r.saved_at,
        store_slug: r.store_slug,
        store_name: r.store_name,
        store_url:
          r.store_slug && r.store_status !== 'suspended'
            ? storeUrl(String(r.store_slug), root, String(r.store_id))
            : null,
      };
    }),
  });
});

/** Just the ids — the storefront grid hydrates its hearts from this. */
communityFavoriteRoutes.get('/ids', requireAuth, async (c) => {
  const user = c.get('user')!;
  const { results } = await c.env.DB.prepare(
    'SELECT product_id FROM community_product_favorites WHERE user_id = ? LIMIT 500'
  )
    .bind(user.id)
    .all();
  return c.json({ product_ids: (results ?? []).map((r) => String(r.product_id)) });
});

communityFavoriteRoutes.put('/:productId', requireAuth, async (c) => {
  const user = c.get('user')!;
  await rateLimit(c, 'cfav', 120, 3600);
  const productId = c.req.param('productId');
  const product = await c.env.DB.prepare(
    "SELECT id FROM community_products WHERE id = ? AND status = 'active' AND lifecycle = 'active'"
  )
    .bind(productId)
    .first();
  if (!product) throw notFound('product_not_found');
  await c.env.DB.prepare(
    'INSERT INTO community_product_favorites (user_id, product_id) VALUES (?, ?) ON CONFLICT DO NOTHING'
  )
    .bind(user.id, productId)
    .run();
  return c.json({ success: true, favorite: true });
});

communityFavoriteRoutes.delete('/:productId', requireAuth, async (c) => {
  const user = c.get('user')!;
  await c.env.DB.prepare(
    'DELETE FROM community_product_favorites WHERE user_id = ? AND product_id = ?'
  )
    .bind(user.id, c.req.param('productId'))
    .run();
  return c.json({ success: true, favorite: false });
});
