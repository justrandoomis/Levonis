/**
 * Public storefront product API — served from the canonical ProductDoc
 * (worker/lib/productModel.ts) through projectPublic, so cost fields
 * (cost_iqd / product_cost_iqd) NEVER appear in any response here.
 *
 * Backward compatibility: route paths and legacy response field names are
 * preserved (name/name_ku/description/images/membership_prices/…), with the
 * v2 fields added alongside. Selling prices shown to the viewer come from
 * the central resolver at the viewer's SERVER-SIDE tier — the charged price
 * is always recomputed at checkout.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { safeParse } from '../lib/types';
import { notFound, int, str } from '../lib/http';
import { getSettings, PUBLIC_SETTING_KEYS } from '../lib/settings';
import { parseProductRow, projectPublic, projectAdmin } from '../lib/productModel';
import type { ProductDoc } from '../lib/productModel';
import { resolveUnitPrice, proPolicyFrom, DEFAULT_PRO_POLICY } from '../lib/pricing';
import type { Tier, ProPricingPolicy, ResolvedPrice } from '../lib/pricing';
import { effectiveTier } from '../lib/entitlements';
import { rateLimit } from '../lib/ratelimit';

export const productRoutes = new Hono<AppContext>();

// ---------------------------------------------------------------- helpers

/** Sanitizes the preorderTransportDefaults setting for the resolver:
 *  only methods with an explicitly configured integer commission survive. */
export function transportDefaultsFrom(value: unknown): Array<{ method: string; commission_iqd: number }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ method: string; commission_iqd: number }> = [];
  for (const item of value) {
    const d = item as Record<string, unknown>;
    if (
      d &&
      typeof d === 'object' &&
      typeof d.method === 'string' &&
      Number.isInteger(d.commission_iqd) &&
      (d.commission_iqd as number) >= 0
    ) {
      out.push({ method: d.method, commission_iqd: d.commission_iqd as number });
    }
  }
  return out;
}

interface PricingCtx {
  tier: Tier;
  tierActive: boolean;
  proPolicy: ProPricingPolicy;
  transportDefaults: Array<{ method: string; commission_iqd: number }>;
}

/** Viewer tier comes ONLY from the server-side session/memberships ledger. */
async function pricingCtx(c: Context<AppContext>): Promise<PricingCtx> {
  const user = c.get('user');
  const [tierInfo, settings] = await Promise.all([
    user ? effectiveTier(c.env, user) : Promise.resolve({ tier: 'free' as Tier, active: false }),
    getSettings(c.env.DB, ['proPricingPolicy', 'preorderTransportDefaults']).catch(() => ({}) as Record<string, unknown>),
  ]);
  const s = settings as Record<string, unknown>;
  return {
    tier: tierInfo.tier,
    tierActive: tierInfo.active,
    proPolicy: 'proPricingPolicy' in s ? proPolicyFrom(s.proPricingPolicy) : DEFAULT_PRO_POLICY,
    transportDefaults: transportDefaultsFrom(s.preorderTransportDefaults),
  };
}

/** Resolver output for public consumers — cost stripped, everything else kept. */
function publicQuote(r: ResolvedPrice) {
  const { cost_iqd, ...rest } = r;
  void cost_iqd;
  return rest;
}

/** Legacy flat [{key,value}] view of the v2 spec groups (old UI compatibility). */
function legacySpecs(doc: ProductDoc): Array<{ key: string; value: string }> {
  return doc.spec_groups.flatMap((g) =>
    g.rows.map((r) => ({ key: r.label_ar || r.label_en, value: r.value_ar || r.value_en }))
  );
}

/** Field aliases the pre-v2 UI reads. All non-sensitive. */
function legacyAliases(doc: ProductDoc) {
  return {
    name: doc.name_en,
    name_ku: doc.name_ckb,
    description: doc.description_en,
    description_ku: doc.description_ckb,
    // Old UI plan-price shape; sourced from the canonical PRO price so the
    // display can never disagree with what the resolver charges.
    membership_prices: doc.pro_price_iqd !== null ? { pro: doc.pro_price_iqd } : {},
    subcategory_id: doc.legacy.subcategory_id,
    categories: doc.legacy.categories,
    brand: doc.legacy.brand_text,
    shipping_methods: doc.legacy.shipping_methods,
    features: doc.legacy.features,
    description_images: doc.legacy.description_images,
    description_videos: doc.legacy.description_videos,
    stores: doc.legacy.stores,
    specifications: legacySpecs(doc),
  };
}

function publicShape(doc: ProductDoc): Record<string, unknown> {
  return { ...projectPublic(doc), ...legacyAliases(doc) };
}

function adminShape(doc: ProductDoc): Record<string, unknown> {
  return {
    ...projectAdmin(doc), // full document incl. cost fields + translation meta
    ...legacyAliases(doc),
    images: doc.media.map((m) => m.url), // legacy string[] view
    algorithm_tags: doc.legacy.algorithm_tags,
    updated_at: doc.updated_at,
  };
}

/**
 * Public product projection. Kept as the stable export other routes import
 * (misc/home, admin listings): parses the row into the canonical doc, then
 * projects publicly (cost-free) or, with includeInternal, as the full admin
 * document. Legacy field names are preserved either way.
 */
export function productPublic(
  p: Record<string, unknown>,
  opts: { includeInternal?: boolean } = {}
): Record<string, unknown> {
  const doc = parseProductRow(p);
  return opts.includeInternal ? adminShape(doc) : publicShape(doc);
}

/** Public shape + the viewer-tier resolved display price (base selection). */
function publicWithDisplayPrice(row: Record<string, unknown>, ctx: PricingCtx): Record<string, unknown> {
  const doc = parseProductRow(row);
  const out = publicShape(doc);
  const resolved = resolveUnitPrice({
    product: doc,
    tier: ctx.tier,
    tierActive: ctx.tierActive,
    proPolicy: ctx.proPolicy,
    transportDefaults: ctx.transportDefaults,
  });
  out.display_price_iqd = resolved.applied_iqd;
  out.display_applied_tier = resolved.applied_tier;
  out.display_compare_at_iqd = resolved.compare_at_iqd;
  return out;
}

// ---------------------------------------------------------------- routes

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
    // Legacy subcategory ids and v2 catalog ids share this filter.
    sql += ' AND (subcategory_id = ? OR id IN (SELECT product_id FROM product_catalogs WHERE catalog_id = ?))';
    params.push(category, category);
  }
  if (type === 'bundle') sql += " AND selling_type = 'bundle'";
  if (type === 'discounted') sql += ' AND original_price_iqd IS NOT NULL AND original_price_iqd > price_iqd';
  if (type === 'featured') sql += ' AND is_featured = 1';
  sql += ' ORDER BY display_order ASC, created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const [{ results }, ctx] = await Promise.all([
    c.env.DB.prepare(sql).bind(...params).all<Record<string, unknown>>(),
    pricingCtx(c),
  ]);
  return c.json({ success: true, products: results.map((p) => publicWithDisplayPrice(p, ctx)) });
});

productRoutes.get('/:slug', async (c) => {
  const slug = c.req.param('slug');
  const row = await c.env.DB.prepare("SELECT * FROM products WHERE slug = ? AND status = 'active'")
    .bind(slug)
    .first<Record<string, unknown>>();
  if (row) {
    const user = c.get('user');
    const doc = parseProductRow(row);

    const [ctx, favRow, brandRow] = await Promise.all([
      pricingCtx(c),
      user
        ? c.env.DB.prepare('SELECT 1 AS x FROM favorites WHERE user_id = ? AND product_id = ?')
            .bind(user.id, row.id)
            .first()
        : Promise.resolve(null),
      doc.brand_id
        ? c.env.DB.prepare('SELECT id, name_ar, name_en, name_ckb FROM brands WHERE id = ? AND active = 1')
            .bind(doc.brand_id)
            .first<{ id: string; name_ar: string; name_en: string; name_ckb: string }>()
        : Promise.resolve(null),
    ]);

    const resolved = resolveUnitPrice({
      product: doc,
      tier: ctx.tier,
      tierActive: ctx.tierActive,
      proPolicy: ctx.proPolicy,
      transportDefaults: ctx.transportDefaults,
    });
    const out = publicShape(doc);
    out.display_price_iqd = resolved.applied_iqd;
    out.display_applied_tier = resolved.applied_tier;
    out.display_compare_at_iqd = resolved.compare_at_iqd;

    return c.json({
      success: true,
      product: out,
      source: 'catalog',
      favorite: !!favRow,
      brand: brandRow ?? null,
      pricing: publicQuote(resolved), // base-selection resolver result, cost-free
      viewer_tier: { tier: ctx.tier, active: ctx.tierActive },
    });
  }

  // Community products share the product-detail page (kept as-is).
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

/**
 * Live price quote for the product page (auth optional). The viewer's tier
 * comes exclusively from the session — a tier in the body is ignored. The
 * result never contains cost fields; checkout re-resolves server-side.
 */
productRoutes.post('/:slug/quote', async (c) => {
  await rateLimit(c, 'product_quote', 120, 60);
  const slug = c.req.param('slug');
  const row = await c.env.DB.prepare("SELECT * FROM products WHERE slug = ? AND status = 'active'")
    .bind(slug)
    .first<Record<string, unknown>>();
  if (!row) throw notFound('Product not found');

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const qty = int(body.qty, 'qty', { min: 1, max: 99, def: 1 });

  const doc = parseProductRow(row);
  const ctx = await pricingCtx(c); // tier ONLY from the session, never the body

  const resolved = resolveUnitPrice({
    product: doc,
    optionId: typeof body.optionId === 'string' && body.optionId ? body.optionId : null,
    colorId: typeof body.colorId === 'string' && body.colorId ? body.colorId : null,
    transportMethod: typeof body.transportMethod === 'string' ? body.transportMethod : null,
    warrantyPlanId: typeof body.warrantyPlanId === 'string' && body.warrantyPlanId ? body.warrantyPlanId : null,
    tier: ctx.tier,
    tierActive: ctx.tierActive,
    proPolicy: ctx.proPolicy,
    transportDefaults: ctx.transportDefaults,
  });

  return c.json({
    success: true,
    quote: {
      ...publicQuote(resolved),
      qty,
      line_total_iqd: resolved.unit_subtotal_iqd * qty,
    },
    viewer_tier: { tier: ctx.tier, active: ctx.tierActive },
  });
});

// ---------------------------------------------------------------- home

/** Aggregated payload for the storefront home page. */
export const homeRoutes = new Hono<AppContext>();

homeRoutes.get('/', async (c) => {
  const [settings, discounted, latest, ctx] = await Promise.all([
    getSettings(c.env.DB, PUBLIC_SETTING_KEYS),
    c.env.DB.prepare(
      "SELECT * FROM products WHERE status = 'active' AND original_price_iqd IS NOT NULL AND original_price_iqd > price_iqd ORDER BY created_at DESC LIMIT 10"
    ).all<Record<string, unknown>>(),
    c.env.DB.prepare("SELECT * FROM products WHERE status = 'active' ORDER BY created_at DESC LIMIT 20").all<
      Record<string, unknown>
    >(),
    pricingCtx(c),
  ]);
  return c.json({
    success: true,
    settings,
    discounted: discounted.results.map((p) => publicWithDisplayPrice(p, ctx)),
    latest: latest.results.map((p) => publicWithDisplayPrice(p, ctx)),
  });
});
