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

// ------------------------------------------------- sale mode / availability
/**
 * SELLABLE-STOCK AND SALE-MODE SEMANTICS (integrated mandate §7.2).
 *
 * What the storefront is allowed to claim about a product is derived here,
 * server-side, from the REAL stock model — never guessed in the browser:
 *
 *  - Stock is tracked on `products.stock` ONLY (INTEGER, NULL = untracked;
 *    migrations/0001_init.sql). There is no per-option/per-color stock column
 *    and no stock-reservation table anywhere in the schema, so `scope` is
 *    reported honestly as 'product' and `reserved` is 0 with a documented
 *    basis: a confirmed order decrements the row inside the same D1 batch
 *    that creates it (worker/routes/orders.ts), guarded by CHECK (stock >= 0),
 *    and a cancellation adds it back. Nothing is held between those points,
 *    so on-hand IS sellable. The UI must therefore NOT present the product
 *    number as a per-variant figure — `scope` is what it may say.
 *  - Zero is never "unlimited": untracked (NULL) and 0 are different states.
 *  - Pre-order is NOT invented for every out-of-stock product. It exists only
 *    where an admin marked the product `selling_type = 'pre_order'` AND at
 *    least one active transport offer resolves to a real integer commission
 *    (own value, else the admin default). Otherwise the honest answer is
 *    "unavailable" plus the machine reason.
 *  - A required option/color must be chosen before any price or stock claim:
 *    every active option REPLACES the base price (worker/lib/pricing.ts), so
 *    an unchosen option means the page has no authoritative unit price yet.
 *
 * These are display/validation facts. Cart and checkout re-derive price,
 * transport and stock server-side from the same DB row and reject anything
 * that disagrees — the client's `is_preorder`/`price` are never trusted.
 */

export type SaleMode = 'direct_sale' | 'preorder' | 'unavailable';

export interface TransportOptionView {
  method: string;
  commission_iqd: number | null; // resolved (own value, else admin default)
  configured: boolean; // false = no integer commission anywhere → unusable
}

export interface SaleAvailability {
  mode: SaleMode;
  /** Machine reason when mode = 'unavailable' (null otherwise). */
  reason: string | null;
  selling_type: string;
  stock: {
    tracked: boolean;
    scope: 'product'; // the schema tracks stock at product level only
    on_hand: number | null; // null = untracked
    reserved: number; // no reservation ledger exists → always 0
    available: number | null; // sellable now; null = untracked
    max_qty: number; // 0 when nothing is sellable
  };
  selection: {
    option_required: boolean;
    color_required: boolean;
    option_id: string | null;
    color_id: string | null;
    complete: boolean;
    errors: string[];
  };
  preorder: {
    enabled: boolean;
    usable: boolean;
    reason: string | null;
    transports: TransportOptionView[];
  };
  /** Requested qty (when supplied) fits inside max_qty. */
  qty_ok: boolean;
}

type AvailabilityDoc = Pick<
  ProductDoc,
  'selling_type' | 'stock' | 'options' | 'colors' | 'preorder_transports'
>;

const QTY_CEILING = 99; // matches the cart/checkout per-line cap

export function saleAvailability(
  doc: AvailabilityDoc,
  input: {
    optionId?: string | null;
    colorId?: string | null;
    qty?: number;
    transportDefaults?: Array<{ method: string; commission_iqd: number }>;
  } = {}
): SaleAvailability {
  const defaults = input.transportDefaults ?? [];
  const optionId = input.optionId || '';
  const colorId = input.colorId || '';

  // ---- selection (a hidden option/color is not selectable)
  const activeOptions = doc.options.filter((o) => o.active !== false);
  const activeColors = doc.colors.filter((c) => c.active !== false);
  const errors: string[] = [];

  const option = optionId ? activeOptions.find((o) => o.id === optionId) ?? null : null;
  if (optionId && !option) {
    errors.push(doc.options.some((o) => o.id === optionId) ? 'OPTION_INACTIVE' : 'OPTION_NOT_FOUND');
  }

  const color = colorId ? activeColors.find((c) => c.id === colorId) ?? null : null;
  if (colorId && !color) {
    errors.push(doc.colors.some((c) => c.id === colorId) ? 'COLOR_INACTIVE' : 'COLOR_NOT_FOUND');
  }
  if (color && color.option_id && color.option_id !== (option?.id ?? null)) {
    errors.push('COLOR_OPTION_MISMATCH');
  }

  // Colors linked to an option only count once that option is the chosen one;
  // with no option chosen yet the whole active set is still on the table.
  const selectableColors = option
    ? activeColors.filter((c) => !c.option_id || c.option_id === option.id)
    : activeColors;

  const optionRequired = activeOptions.length > 0;
  const colorRequired = selectableColors.length > 0;
  if (optionRequired && !option) errors.push('OPTION_REQUIRED');
  if (colorRequired && !color) errors.push('COLOR_REQUIRED');

  // ---- stock (product-level; no reservations exist in the schema)
  const tracked = doc.stock !== null && doc.stock !== undefined;
  const onHand = tracked ? Math.trunc(doc.stock as number) : null;
  const reserved = 0;
  const available = onHand === null ? null : Math.max(0, onHand - reserved);

  // ---- pre-order policy (admin-enabled + a usable transport)
  const enabled = doc.selling_type === 'pre_order';
  const transports: TransportOptionView[] = doc.preorder_transports
    .filter((t) => t.active !== false)
    .map((t) => {
      const own = Number.isInteger(t.commission_iqd) ? (t.commission_iqd as number) : null;
      const fallback = defaults.find((d) => d.method === t.method);
      const commission = own !== null ? own : fallback ? fallback.commission_iqd : null;
      return { method: t.method, commission_iqd: commission, configured: commission !== null };
    });
  const usable = enabled && transports.some((t) => t.configured);
  const preorderReason = enabled
    ? usable
      ? null
      : transports.length === 0
        ? 'NO_TRANSPORT_OFFERED'
        : 'TRANSPORT_COMMISSION_UNCONFIGURED'
    : 'PREORDER_NOT_ENABLED';

  // ---- mode
  let mode: SaleMode;
  let reason: string | null = null;
  if (enabled) {
    if (usable) {
      mode = 'preorder';
    } else {
      mode = 'unavailable';
      reason = preorderReason;
    }
  } else if (available === null || available > 0) {
    mode = 'direct_sale';
  } else {
    mode = 'unavailable';
    reason = 'OUT_OF_STOCK';
  }

  const maxQty =
    mode === 'unavailable'
      ? 0
      : mode === 'preorder' || available === null
        ? QTY_CEILING
        : Math.min(QTY_CEILING, available);

  return {
    mode,
    reason,
    selling_type: doc.selling_type,
    stock: { tracked, scope: 'product', on_hand: onHand, reserved, available, max_qty: maxQty },
    selection: {
      option_required: optionRequired,
      color_required: colorRequired,
      option_id: option ? option.id : null,
      color_id: color ? color.id : null,
      complete: errors.length === 0,
      errors,
    },
    preorder: { enabled, usable, reason: preorderReason, transports },
    qty_ok: input.qty === undefined ? true : input.qty >= 1 && input.qty <= maxQty,
  };
}

/**
 * Community listings live in `community_products` — a table with no stock,
 * no options and no cart path (POST /api/cart/items resolves `products`
 * only). Saying anything else on the product page would be a fake buy button,
 * so the shape is returned with an explicit reason instead.
 */
export function communityAvailability(): SaleAvailability {
  return {
    mode: 'unavailable',
    reason: 'COMMUNITY_LISTING_NOT_SELLABLE',
    selling_type: 'direct_sale',
    stock: { tracked: false, scope: 'product', on_hand: null, reserved: 0, available: null, max_qty: 0 },
    selection: {
      option_required: false,
      color_required: false,
      option_id: null,
      color_id: null,
      complete: true,
      errors: [],
    },
    preorder: { enabled: false, usable: false, reason: 'PREORDER_NOT_ENABLED', transports: [] },
    qty_ok: false,
  };
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
  // §4: no compare-at. The regular price is exposed so a member can see what
  // their membership saved — a real comparison, not a fabricated one.
  out.display_regular_iqd = resolved.regular_iqd;
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
    out.display_regular_iqd = resolved.regular_iqd;

    return c.json({
      success: true,
      product: out,
      source: 'catalog',
      favorite: !!favRow,
      brand: brandRow ?? null,
      pricing: publicQuote(resolved), // base-selection resolver result, cost-free
      // §7.2 — the sale mode the page may DEFAULT to, derived from the real
      // stock model and the admin pre-order policy (never from the browser).
      availability: saleAvailability(doc, { transportDefaults: ctx.transportDefaults }),
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
    availability: communityAvailability(),
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

  const optionId = typeof body.optionId === 'string' && body.optionId ? body.optionId : null;
  const colorId = typeof body.colorId === 'string' && body.colorId ? body.colorId : null;

  const resolved = resolveUnitPrice({
    product: doc,
    optionId,
    colorId,
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
    // Availability for THIS selection — changing option/color re-checks it.
    availability: saleAvailability(doc, {
      optionId,
      colorId,
      qty,
      transportDefaults: ctx.transportDefaults,
    }),
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
