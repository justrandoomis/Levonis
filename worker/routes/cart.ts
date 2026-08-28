import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { safeParse } from '../lib/types';
import { requireAuth, badRequest, notFound, int, str, oneOf } from '../lib/http';
import { newId } from '../lib/crypto';
import { getSettings } from '../lib/settings';
import { parseProductRow, type ProductDoc } from '../lib/productModel';
import {
  resolveUnitPrice,
  proPolicyFrom,
  type ProPricingPolicy,
  type ResolvedPrice,
  type Tier,
} from '../lib/pricing';
import { effectiveTier } from '../lib/entitlements';

export const cartRoutes = new Hono<AppContext>();
cartRoutes.use('*', requireAuth);

/**
 * @deprecated Legacy check against the users.* subscription cache. New code
 * must use effectiveTier / getTierStatus (worker/lib/entitlements), which
 * read the memberships ledger — the server-side source of truth.
 */
export function planIsActive(plan: string, expiry: number): boolean {
  return plan !== 'free' && (expiry === 0 || expiry > Date.now());
}

// ------------------------------------------------------------ pricing context

export interface PricingContext {
  proPolicy: ProPricingPolicy;
  transportDefaults: Array<{ method: string; commission_iqd: number }>;
}

/** Keeps only defaults an admin actually configured (integer IQD >= 0). */
export function transportDefaultsFrom(value: unknown): PricingContext['transportDefaults'] {
  const arr = Array.isArray(value) ? value : [];
  const out: PricingContext['transportDefaults'] = [];
  for (const item of arr) {
    const d = item as Record<string, unknown>;
    if (
      d &&
      typeof d.method === 'string' &&
      typeof d.commission_iqd === 'number' &&
      Number.isInteger(d.commission_iqd) &&
      d.commission_iqd >= 0
    ) {
      out.push({ method: d.method, commission_iqd: d.commission_iqd });
    }
  }
  return out;
}

export function pricingContextFrom(settings: Record<string, unknown>): PricingContext {
  return {
    proPolicy: proPolicyFrom(settings.proPricingPolicy),
    transportDefaults: transportDefaultsFrom(settings.preorderTransportDefaults),
  };
}

export async function loadPricingContext(db: D1Database): Promise<PricingContext> {
  const settings = await getSettings(db, ['proPricingPolicy', 'preorderTransportDefaults']);
  return pricingContextFrom(settings);
}

export interface CartSelection {
  optionId: string;
  colorId: string;
  transportMethod: string;
  warrantyPlanId: string;
}

/**
 * Resolves one cart/checkout line through the central resolver — the ONLY
 * pricing path. Never trusts a client-sent price.
 */
export function resolveCartLine(
  row: Record<string, unknown>,
  sel: CartSelection,
  tier: Tier,
  tierActive: boolean,
  ctx: PricingContext
): { doc: ProductDoc; resolved: ResolvedPrice; variantLabel: string } {
  const doc = parseProductRow(row);
  const resolved = resolveUnitPrice({
    product: doc,
    optionId: sel.optionId || null,
    colorId: sel.colorId || null,
    transportMethod: sel.transportMethod || null,
    warrantyPlanId: sel.warrantyPlanId || null,
    tier,
    tierActive,
    proPolicy: ctx.proPolicy,
    transportDefaults: ctx.transportDefaults,
  });
  const labels: string[] = [];
  if (sel.optionId) {
    const o = doc.options.find((x) => x.id === sel.optionId);
    labels.push(o ? o.name_ar || o.name_en || o.id : sel.optionId);
  }
  if (sel.colorId) {
    const col = doc.colors.find((x) => x.id === sel.colorId);
    labels.push(col ? col.name_ar || col.name_en || col.id : sel.colorId);
  }
  return { doc, resolved, variantLabel: labels.join(' / ') };
}

/** Public per-line breakdown — cost fields NEVER cross this boundary. */
export function publicBreakdown(r: ResolvedPrice) {
  return {
    applied_iqd: r.applied_iqd,
    applied_tier: r.applied_tier,
    compare_at_iqd: r.compare_at_iqd,
    transport: r.transport,
    warranty: r.warranty,
    unit_subtotal_iqd: r.unit_subtotal_iqd,
    price_source: r.price_source,
    errors: r.errors,
  };
}

const stripCost = <T extends { cost_iqd: number | null }>(x: T) => {
  const { cost_iqd, ...rest } = x;
  void cost_iqd;
  return rest;
};

function selectionFromCartRow(row: Record<string, unknown>): CartSelection {
  return {
    optionId: String(row.option_id ?? ''),
    colorId: String(row.color_id ?? ''),
    transportMethod: String(row.transport_method ?? ''),
    warrantyPlanId: String(row.warranty_plan_id ?? ''),
  };
}

// ------------------------------------------------------------------- routes

async function loadCart(c: Context<AppContext>) {
  const user = c.get('user')!;
  const [{ tier, active: tierActive }, ctx] = await Promise.all([
    effectiveTier(c.env, user),
    loadPricingContext(c.env.DB),
  ]);
  const { results } = await c.env.DB.prepare(
    `SELECT ci.id AS cart_item_id, ci.qty, ci.option_id, ci.color_id, ci.shipping_method_id,
            ci.transport_method, ci.warranty_plan_id, p.*
       FROM cart_items ci JOIN products p ON p.id = ci.product_id
      WHERE ci.user_id = ? ORDER BY ci.created_at DESC`
  )
    .bind(user.id)
    .all<Record<string, unknown>>();

  const items = [];
  for (const row of results) {
    if (row.status !== 'active') continue; // hidden products drop out of the cart view
    const { doc, resolved, variantLabel } = resolveCartLine(row, selectionFromCartRow(row), tier, tierActive, ctx);
    items.push({
      id: row.cart_item_id,
      productId: row.id,
      slug: row.slug,
      name: row.name,
      name_ar: row.name_ar,
      image: (doc.media.find((m) => m.primary) ?? doc.media[0])?.url ?? '',
      qty: row.qty,
      option_id: row.option_id,
      color_id: row.color_id,
      transport_method: row.transport_method,
      warranty_plan_id: row.warranty_plan_id,
      shipping_method_id: row.shipping_method_id, // legacy column, no longer priced
      selling_type: doc.selling_type,
      variantLabel,
      // Legacy field kept for existing UI: the full per-unit amount.
      unit_price_iqd: resolved.unit_subtotal_iqd,
      original_price_iqd: resolved.compare_at_iqd,
      breakdown: publicBreakdown(resolved),
      stock: row.stock,
      options: doc.options.filter((o) => o.active).map(stripCost),
      colors: doc.colors.filter((col) => col.active).map(stripCost),
      warranty_plans: doc.warranty_plans.filter((w) => w.active),
      preorder_transports: doc.preorder_transports.filter((t) => t.active),
      shipping_methods: safeParse(row.shipping_methods, []), // legacy UI compatibility
    });
  }
  return { items, tier, tierActive };
}

cartRoutes.get('/', async (c) => {
  const { items, tier, tierActive } = await loadCart(c);
  return c.json({ success: true, items, tier, tierActive });
});

function parseTransportMethod(v: unknown): string {
  if (v === undefined || v === null || v === '') return '';
  return oneOf(v, 'transportMethod', ['air', 'sea', 'land'] as const);
}

cartRoutes.post('/items', async (c) => {
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const productId = str(body.productId, 'productId', { min: 1, max: 60 });
  const qty = int(body.qty, 'qty', { min: 1, max: 99, def: 1 });
  const optionId = str(body.optionId, 'optionId', { max: 60, required: false });
  const colorId = str(body.colorId, 'colorId', { max: 60, required: false });
  const transportMethod = parseTransportMethod(body.transportMethod);
  const warrantyPlanId = str(body.warrantyPlanId, 'warrantyPlanId', { max: 60, required: false });

  const product = await c.env.DB.prepare("SELECT * FROM products WHERE id = ? AND status = 'active'")
    .bind(productId)
    .first<Record<string, unknown>>();
  if (!product) throw notFound('Product not found or unavailable');

  const [{ tier, active: tierActive }, ctx] = await Promise.all([
    effectiveTier(c.env, user),
    loadPricingContext(c.env.DB),
  ]);
  const { resolved } = resolveCartLine(
    product,
    { optionId, colorId, transportMethod, warrantyPlanId },
    tier,
    tierActive,
    ctx
  );
  if (resolved.errors.length > 0) {
    throw badRequest(`Invalid selection: ${resolved.errors.join(', ')}`, 'VALIDATION');
  }
  const stock = product.stock as number | null;
  if (stock !== null && stock < qty) {
    throw badRequest(`Only ${stock} left in stock`);
  }

  // shipping_method_id stays '' — legacy column kept for the UNIQUE key only,
  // pricing is entirely resolver-driven now.
  await c.env.DB.prepare(
    `INSERT INTO cart_items (id, user_id, product_id, option_id, color_id, shipping_method_id, transport_method, warranty_plan_id, qty)
     VALUES (?, ?, ?, ?, ?, '', ?, ?, ?)
     ON CONFLICT(user_id, product_id, option_id, color_id, shipping_method_id)
     DO UPDATE SET qty = MIN(99, qty + excluded.qty),
                   transport_method = excluded.transport_method,
                   warranty_plan_id = excluded.warranty_plan_id`
  )
    .bind(newId('ci'), user.id, productId, optionId, colorId, transportMethod, warrantyPlanId, qty)
    .run();

  const { items, tier: t, tierActive: ta } = await loadCart(c);
  return c.json({ success: true, items, tier: t, tierActive: ta });
});

cartRoutes.patch('/items/:id', async (c) => {
  const user = c.get('user')!;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));

  const existing = await c.env.DB.prepare('SELECT * FROM cart_items WHERE id = ? AND user_id = ?')
    .bind(id, user.id)
    .first<Record<string, unknown>>();
  if (!existing) throw notFound('Cart item not found');

  const qty = body.qty !== undefined ? int(body.qty, 'qty', { min: 1, max: 99 }) : (existing.qty as number);
  const optionId =
    body.optionId !== undefined ? str(body.optionId, 'optionId', { max: 60, required: false }) : String(existing.option_id);
  const colorId =
    body.colorId !== undefined ? str(body.colorId, 'colorId', { max: 60, required: false }) : String(existing.color_id);
  const transportMethod =
    body.transportMethod !== undefined
      ? parseTransportMethod(body.transportMethod)
      : String(existing.transport_method ?? '');
  const warrantyPlanId =
    body.warrantyPlanId !== undefined
      ? str(body.warrantyPlanId, 'warrantyPlanId', { max: 60, required: false })
      : String(existing.warranty_plan_id ?? '');

  const product = await c.env.DB.prepare('SELECT * FROM products WHERE id = ?')
    .bind(existing.product_id)
    .first<Record<string, unknown>>();
  // A vanished product can never be validated — reject instead of skipping
  // validation (previous behavior silently accepted any selection here).
  if (!product) throw badRequest('This product no longer exists — please remove it from your cart');

  const [{ tier, active: tierActive }, ctx] = await Promise.all([
    effectiveTier(c.env, user),
    loadPricingContext(c.env.DB),
  ]);
  const { resolved } = resolveCartLine(
    product,
    { optionId, colorId, transportMethod, warrantyPlanId },
    tier,
    tierActive,
    ctx
  );
  if (resolved.errors.length > 0) {
    throw badRequest(`Invalid selection: ${resolved.errors.join(', ')}`, 'VALIDATION');
  }
  const stock = product.stock as number | null;
  if (stock !== null && stock < qty) throw badRequest(`Only ${stock} left in stock`);

  await c.env.DB.prepare(
    `UPDATE cart_items SET qty = ?, option_id = ?, color_id = ?, transport_method = ?, warranty_plan_id = ?
      WHERE id = ? AND user_id = ?`
  )
    .bind(qty, optionId, colorId, transportMethod, warrantyPlanId, id, user.id)
    .run();

  const { items, tier: t, tierActive: ta } = await loadCart(c);
  return c.json({ success: true, items, tier: t, tierActive: ta });
});

cartRoutes.delete('/items/:id', async (c) => {
  const user = c.get('user')!;
  await c.env.DB.prepare('DELETE FROM cart_items WHERE id = ? AND user_id = ?')
    .bind(c.req.param('id'), user.id)
    .run();
  const { items, tier, tierActive } = await loadCart(c);
  return c.json({ success: true, items, tier, tierActive });
});
