import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { safeParse } from '../lib/types';
import { notFound, int, str } from '../lib/http';
import { getSettings, PUBLIC_SETTING_KEYS } from '../lib/settings';

export const productRoutes = new Hono<AppContext>();

/**
 * Public product projection: parses JSON columns, strips internal fields
 * (cost prices), and only ever serves status='active' rows. Membership
 * prices are included so the UI can show plan pricing, but the price the
 * customer is charged is always recomputed server-side at checkout.
 */
export function productPublic(p: Record<string, unknown>, opts: { includeInternal?: boolean } = {}) {
  const options = safeParse<Array<Record<string, unknown>>>(p.options, []);
  const colors = safeParse<Array<Record<string, unknown>>>(p.colors, []);
  const out: Record<string, unknown> = {
    id: p.id,
    slug: p.slug,
    status: p.status,
    name: p.name,
    name_ar: p.name_ar,
    name_ku: p.name_ku,
    description: p.description,
    description_ar: p.description_ar,
    description_ku: p.description_ku,
    images: safeParse(p.images, []),
    options: opts.includeInternal ? options : options.map(stripCost),
    colors: opts.includeInternal ? colors : colors.map(stripCost),
    selling_type: p.selling_type,
    shipping_methods: safeParse(p.shipping_methods, []),
    price_iqd: p.price_iqd,
    original_price_iqd: p.original_price_iqd,
    membership_prices: safeParse(p.membership_prices, {}),
    payment_options: safeParse(p.payment_options, []),
    subcategory_id: p.subcategory_id,
    categories: p.categories,
    display_order: p.display_order,
    is_featured: !!p.is_featured,
    specifications: safeParse(p.specifications, []),
    brand: p.brand,
    labels: safeParse(p.labels, []),
    hashtags: safeParse(p.hashtags, []),
    features: safeParse(p.features, []),
    description_images: safeParse(p.description_images, []),
    description_videos: safeParse(p.description_videos, []),
    stores: safeParse(p.stores, []),
    warranty_plans: safeParse(p.warranty_plans, []),
    how_to_use: p.how_to_use,
    stock: p.stock,
    created_at: p.created_at,
  };
  if (opts.includeInternal) {
    out.product_cost_iqd = p.product_cost_iqd;
    out.algorithm_tags = safeParse(p.algorithm_tags, []);
  }
  return out;
}

function stripCost(v: Record<string, unknown>) {
  const { cost_iqd, cost, ...rest } = v;
  return rest;
}

productRoutes.get('/', async (c) => {
  const q = c.req.query();
  const search = str(q.search, 'search', { max: 100, required: false });
  const category = str(q.category, 'category', { max: 60, required: false });
  const type = str(q.type, 'type', { max: 20, required: false }); // 'bundle' | 'discounted' | 'featured'
  const limit = int(q.limit, 'limit', { min: 1, max: 50, def: 20 });
  const offset = int(q.offset, 'offset', { min: 0, max: 10_000, def: 0 });

  let sql = "SELECT * FROM products WHERE status = 'active'";
  const params: unknown[] = [];
  if (search) {
    sql += ' AND (name LIKE ? OR name_ar LIKE ? OR name_ku LIKE ? OR description LIKE ?)';
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  if (category) {
    sql += ' AND subcategory_id = ?';
    params.push(category);
  }
  if (type === 'bundle') sql += " AND selling_type = 'bundle'";
  if (type === 'discounted') sql += ' AND original_price_iqd IS NOT NULL AND original_price_iqd > price_iqd';
  if (type === 'featured') sql += ' AND is_featured = 1';
  sql += ' ORDER BY display_order ASC, created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const { results } = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json({ success: true, products: results.map((p) => productPublic(p)) });
});

productRoutes.get('/:slug', async (c) => {
  const slug = c.req.param('slug');
  const row = await c.env.DB.prepare("SELECT * FROM products WHERE slug = ? AND status = 'active'")
    .bind(slug)
    .first<Record<string, unknown>>();
  if (row) {
    const user = c.get('user');
    let favorite = false;
    if (user) {
      const fav = await c.env.DB.prepare('SELECT 1 AS x FROM favorites WHERE user_id = ? AND product_id = ?')
        .bind(user.id, row.id)
        .first();
      favorite = !!fav;
    }
    return c.json({ success: true, product: productPublic(row), source: 'catalog', favorite });
  }
  // Community products share the product-detail page.
  const cp = await c.env.DB.prepare(
    `SELECT cp.*, cm.name AS merchant_name, cm.verified AS merchant_verified, cm.id AS m_id
       FROM community_products cp JOIN community_merchants cm ON cm.id = cp.merchant_id
      WHERE cp.slug = ? AND cp.status = 'active'`
  )
    .bind(slug)
    .first<Record<string, unknown>>();
  if (!cp) throw notFound('Product not found');
  return c.json({
    success: true,
    source: 'community',
    favorite: false,
    product: {
      id: cp.id,
      slug: cp.slug,
      name: cp.name,
      name_ar: cp.name_ar,
      description: cp.description,
      description_ar: cp.description_ar,
      images: safeParse(cp.images, []),
      price_iqd: cp.price_iqd,
      original_price_iqd: cp.original_price_iqd,
      merchant: { id: cp.m_id, name: cp.merchant_name, verified: !!cp.merchant_verified },
      options: [],
      colors: [],
      shipping_methods: [],
      membership_prices: {},
      specifications: [],
      selling_type: 'direct_sale',
      created_at: cp.created_at,
    },
  });
});

/** Aggregated payload for the storefront home page. */
export const homeRoutes = new Hono<AppContext>();

homeRoutes.get('/', async (c) => {
  const [settings, discounted, latest] = await Promise.all([
    getSettings(c.env.DB, PUBLIC_SETTING_KEYS),
    c.env.DB.prepare(
      "SELECT * FROM products WHERE status = 'active' AND original_price_iqd IS NOT NULL AND original_price_iqd > price_iqd ORDER BY created_at DESC LIMIT 10"
    ).all(),
    c.env.DB.prepare("SELECT * FROM products WHERE status = 'active' ORDER BY created_at DESC LIMIT 20").all(),
  ]);
  return c.json({
    success: true,
    settings,
    discounted: discounted.results.map((p) => productPublic(p)),
    latest: latest.results.map((p) => productPublic(p)),
  });
});
