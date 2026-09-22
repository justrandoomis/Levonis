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
import { loadAuthoritativeProductImages } from '../lib/productSelectionImage';

export const communityFavoriteRoutes = new Hono<AppContext>();

/**
 * EVERYTHING THE VISITOR SAVED, newest first, joined to what is still for sale.
 *
 * «في المحفوظات عند حفظ منتج معين لا يظهر وتظهر لا توجد منتجات محفوظه بعد» —
 * the heart worked and the page was empty, because there are TWO hearts and
 * this route only knew about one of them.
 *
 * The storefront heart (Storefront.tsx) writes `community_product_favorites`,
 * a merchant's own product. The main product page's heart (Product.tsx, via
 * PUT /api/profile/favorites/:id) writes `favorites`, a catalogue product.
 * Two tables, because they reference two different products tables and a
 * foreign key cannot point at either — not a mistake to merge away.
 *
 * But «المحفوظات» is ONE screen in the profile, and the buyer who tapped the
 * heart on a Bambu printer is not thinking about which table it landed in. So
 * the SCREEN is merged here, where both reads already live behind the same
 * session, and every row says which `source` it came from — that is what lets
 * the card open the right page and the heart delete the right row rather than
 * silently failing against the other table.
 *
 * `/api/profile/favorites` stays exactly as it is: the profile's own
 * collection strip reads it, and it is the catalogue heart's write door.
 */
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
  /**
   * The CATALOGUE side of the same screen. Read separately rather than
   * UNION'd: the two rows come from different products tables with different
   * columns, and the image is not a column here at all — it is whatever
   * `loadAuthoritativeProductImages` resolves, the same function the profile's
   * own collection strip uses, so one product cannot show two different
   * pictures on two screens.
   *
   * `status = 'active'` mirrors GET /api/profile/favorites exactly: a saved
   * product the shop has since retired drops off both, and it drops off
   * QUIETLY — a list of things that can no longer be bought is not a feature.
   */
  const catalogue = await db
    .prepare(
      `SELECT f.product_id, f.created_at AS saved_at,
              p.slug, p.name, p.name_ar, p.price_iqd, p.original_price_iqd
         FROM favorites f
         JOIN products p ON p.id = f.product_id
        WHERE f.user_id = ? AND p.status = 'active'
        ORDER BY f.created_at DESC
        LIMIT 100`
    )
    .bind(user.id)
    .all<Record<string, unknown>>();
  const catalogueRows = catalogue.results ?? [];
  const catalogueImages = await loadAuthoritativeProductImages(
    db,
    catalogueRows.map((r) => String(r.product_id))
  );

  const storeItems = (results ?? []).map((r) => {
    let image: string | null = null;
    try {
      const imgs = JSON.parse(String(r.images ?? '[]'));
      image = Array.isArray(imgs) && imgs.length ? String(imgs[0]) : null;
    } catch {
      image = null;
    }
    return {
      source: 'store' as const,
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
  });

  const catalogueItems = catalogueRows.map((r) => ({
    source: 'catalog' as const,
    product_id: String(r.product_id),
    slug: String(r.slug ?? ''),
    name: r.name,
    name_ar: r.name_ar,
    image: catalogueImages.get(String(r.product_id)) ?? null,
    price_iqd: r.price_iqd,
    original_price_iqd: r.original_price_iqd ?? null,
    /**
     * NOT KNOWN FROM HERE, and so not claimed.
     *
     * A storefront product's availability IS one column. A catalogue
     * product's is the whole availability engine — `inventory_mode`, the
     * per-option and per-colour levels, the pre-order capacity and its
     * transport quotas — and `products.stock` is meaningless on its own for
     * every mode but SIMPLE. Reading it anyway would print «غير متوفر» on a
     * printer that is in stock in three colours, and `true` would promise a
     * sold-out one. A saved list is a shortcut back to the page that can
     * answer properly; null is that, and the card prints nothing.
     */
    in_stock: null,
    saved_at: r.saved_at,
    // A catalogue product has no merchant. These stay null rather than being
    // filled with the shop's own name: the card uses them to decide whether to
    // leave the site, and a truthy value here would send the buyer to a
    // subdomain that does not exist.
    store_slug: null,
    store_name: null,
    store_url: null,
  }));

  // ONE list in save order, not two sections. `saved_at` is the only ordering
  // the buyer has any model of — "the last thing I hearted is at the top" —
  // and it holds across both tables because both stamp the same column.
  const items = [...storeItems, ...catalogueItems].sort((a, b) =>
    String(b.saved_at ?? '').localeCompare(String(a.saved_at ?? ''))
  );
  return c.json({ items });
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
