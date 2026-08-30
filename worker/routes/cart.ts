import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { safeParse } from '../lib/types';
import { requireAuth, badRequest, notFound, int, str, oneOf } from '../lib/http';
import { newId } from '../lib/crypto';
import { getSettings } from '../lib/settings';
import { parseProductRow, type ProductDoc } from '../lib/productModel';
import {
  applyRelations,
  EMPTY_RELATIONS,
  loadRelationsViews,
  publicRelations,
  snapshotFrom,
} from '../lib/productOverlay';
import type { ProductRelationsView } from '../lib/productOverlay';
import { validateSelection } from '../lib/productRelations';
import { saleAvailability } from './products';
import {
  resolveUnitPrice,
  proPolicyFrom,
  type ProPricingPolicy,
  type ResolvedPrice,
  type Tier,
} from '../lib/pricing';
import { effectiveTier } from '../lib/entitlements';
import { supportEligibleProductIds } from '../lib/membershipOps';

export const cartRoutes = new Hono<AppContext>();
cartRoutes.use('*', requireAuth);

/**
 * SUPPORT CODES AND THIS FILE (integrated mandate §3.3).
 *
 * A support code has ZERO monetary effect, so nothing in the cart's pricing
 * path knows about one: no line, subtotal, discount or delivery figure below
 * reads a support ref, and the cart stores none. The ref lives in the
 * browser until checkout, where it rides the order body (`supportCode`) and
 * is resolved + frozen server-side into orders.support_snapshot
 * (worker/lib/supportCode.ts). The only thing added here is a per-line
 * DISPLAY flag — `support_gift_eligible` — so the cart can say truthfully
 * which line is the one the gift program looks at, resolved from explicit
 * admin flags (never a name match) exactly like the gift engine does.
 */

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
  /** §7 multi-group selection. `optionId` stays as the first entry so every
   *  pre-0018 reader keeps working. */
  optionValueIds?: string[];
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
  ctx: PricingContext,
  view?: ProductRelationsView
): { doc: ProductDoc; resolved: ResolvedPrice; variantLabel: string; selectionErrors: string[] } {
  // Options and colours come from the relational tables when the product has
  // them (migration 0022 gave every existing product its rows), so the cart
  // prices exactly what the storefront showed.
  const doc = view ? applyRelations(parseProductRow(row), view) : parseProductRow(row);
  const valueIds = (sel.optionValueIds && sel.optionValueIds.length
    ? sel.optionValueIds
    : sel.optionId
      ? [sel.optionId]
      : []
  ).filter(Boolean);

  // The resolver prices ONE option; with several groups the first selected
  // value carries the price override, and per-field inheritance fills the
  // rest — the same rule the admin form previews.
  const resolved = resolveUnitPrice({
    product: doc,
    optionId: valueIds[0] || null,
    colorId: sel.colorId || null,
    transportMethod: sel.transportMethod || null,
    warrantyPlanId: sel.warrantyPlanId || null,
    tier,
    tierActive,
    proPolicy: ctx.proPolicy,
    transportDefaults: ctx.transportDefaults,
  });

  // With relational links present, the real AND/OR algebra decides whether the
  // colour may be bought with these options — the resolver's single-option
  // check cannot express it.
  const selectionErrors =
    view && view.has_relations
      ? validateSelection({
          groups: view.groups,
          values: view.values,
          colors: view.colors,
          links: view.links,
          selectedValueIds: valueIds,
          selectedColorId: sel.colorId || null,
        })
      : [];

  const labels: string[] = [];
  for (const id of valueIds) {
    const o = doc.options.find((x: { id: string }) => x.id === id);
    labels.push(o ? o.name_en || o.name_ar || o.id : id);
  }
  if (sel.colorId) {
    const col = doc.colors.find((x: { id: string }) => x.id === sel.colorId);
    labels.push(col ? col.name_en || col.name_ar || col.id : sel.colorId);
  }
  return { doc, resolved, variantLabel: labels.join(' / '), selectionErrors };
}

/** Public per-line breakdown — cost fields NEVER cross this boundary. */
export function publicBreakdown(r: ResolvedPrice) {
  return {
    applied_iqd: r.applied_iqd,
    applied_tier: r.applied_tier,
    // Compare-at is gone (mandate §4): no strikethrough price is derived from
    // the retired original_price_iqd column anywhere.
    regular_iqd: r.regular_iqd,
    prime_iqd: r.prime_iqd,
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

export function selectionFromCartRow(row: Record<string, unknown>): CartSelection {
  const stored = safeParse<unknown[]>(String(row.option_value_ids ?? '[]'), []);
  const ids = stored.filter((x): x is string => typeof x === 'string' && !!x);
  const legacy = String(row.option_id ?? '');
  return {
    optionId: legacy,
    optionValueIds: ids.length ? ids : legacy ? [legacy] : [],
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
    `SELECT ci.id AS cart_item_id, ci.qty, ci.option_id, ci.option_value_ids, ci.color_id,
            ci.shipping_method_id, ci.transport_method, ci.warranty_plan_id, p.*
       FROM cart_items ci JOIN products p ON p.id = ci.product_id
      WHERE ci.user_id = ? ORDER BY ci.created_at DESC`
  )
    .bind(user.id)
    .all<Record<string, unknown>>();

  // Display-only: which lines carry the explicit support-gift eligibility
  // flag. One extra query for the whole cart, never per line, and it feeds
  // no price anywhere.
  const eligibleIds = await supportEligibleProductIds(
    c.env.DB,
    results.filter((r) => r.status === 'active').map((r) => String(r.id ?? ''))
  );

  // One batched read of every product's relational structure — never N+1.
  const views = await loadRelationsViews(
    c.env.DB,
    results.filter((r) => r.status === 'active').map((r) => ({ id: String(r.id), inventory_mode: r.inventory_mode }))
  );

  const items = [];
  for (const row of results) {
    if (row.status !== 'active') continue; // hidden products drop out of the cart view
    const view = views.get(String(row.id));
    const sel = selectionFromCartRow(row);
    const { doc, resolved, variantLabel, selectionErrors } = resolveCartLine(row, sel, tier, tierActive, ctx, view);
    // What this exact line can actually be sold as, from the authoritative
    // stock level — not from products.stock when the product tracks elsewhere.
    const availability = saleAvailability(doc, {
      optionValueIds: sel.optionValueIds ?? [],
      colorId: sel.colorId || null,
      qty: Number(row.qty) || 1,
      transportDefaults: ctx.transportDefaults,
      inventory: view
        ? snapshotFrom(view, {
            stock: doc.stock,
            reserved: Number(row.stock_reserved ?? 0),
            low_stock_threshold: (row.low_stock_threshold as number | null) ?? null,
          })
        : undefined,
      links: view?.links,
      preferredType: String(row.transport_method ?? '') ? 'pre_order' : null,
    });
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
      // §3.3/§3.4 display flag — NOT a price, NOT a promise of a gift to the
      // buyer: it marks the line the support-gift program evaluates for the
      // REFERRER after delivery and payment settlement.
      support_gift_eligible: eligibleIds.has(String(row.id ?? '')),
      // Legacy field kept for existing UI: the full per-unit amount.
      unit_price_iqd: resolved.unit_subtotal_iqd,
      breakdown: publicBreakdown(resolved),
      // Legacy field: the base row. `availability.stock` is the authoritative
      // figure for THIS selection.
      stock: row.stock,
      availability,
      selection_errors: selectionErrors,
      option_value_ids: sel.optionValueIds ?? [],
      relations: publicRelations(view ?? EMPTY_RELATIONS),
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
  // §7: one value per option group. The legacy single `optionId` is folded in
  // so an older client keeps working unchanged.
  const rawValueIds: unknown[] = Array.isArray(body.optionValueIds) ? body.optionValueIds : [];
  const optionValueIds: string[] = [
    ...new Set<string>([
      ...rawValueIds.filter((x): x is string => typeof x === 'string' && x.length > 0),
      ...(optionId ? [optionId] : []),
    ]),
  ].slice(0, 12);
  const colorId = str(body.colorId, 'colorId', { max: 60, required: false });
  const transportMethod = parseTransportMethod(body.transportMethod);
  const warrantyPlanId = str(body.warrantyPlanId, 'warrantyPlanId', { max: 60, required: false });

  const product = await c.env.DB.prepare("SELECT * FROM products WHERE id = ? AND status = 'active'")
    .bind(productId)
    .first<Record<string, unknown>>();
  if (!product) throw notFound('Product not found or unavailable');

  const [{ tier, active: tierActive }, ctx, views] = await Promise.all([
    effectiveTier(c.env, user),
    loadPricingContext(c.env.DB),
    loadRelationsViews(c.env.DB, [{ id: productId, inventory_mode: product.inventory_mode }]),
  ]);
  const view = views.get(productId);
  const { doc, resolved, selectionErrors } = resolveCartLine(
    product,
    { optionId, optionValueIds, colorId, transportMethod, warrantyPlanId },
    tier,
    tierActive,
    ctx,
    view
  );
  if (resolved.errors.length > 0) {
    throw badRequest(`Invalid selection: ${resolved.errors.join(', ')}`, 'VALIDATION');
  }
  // §7: the colour/option combination must be one the admin actually offers.
  if (selectionErrors.length > 0) {
    throw badRequest(`Invalid selection: ${selectionErrors.join(', ')}`, 'VALIDATION');
  }

  // Stock comes from the authoritative level for THIS selection — an
  // exhausted colour blocks the add even when the base row is full.
  const availability = saleAvailability(doc, {
    optionValueIds,
    colorId: colorId || null,
    qty,
    transportDefaults: ctx.transportDefaults,
    inventory: view
      ? snapshotFrom(view, {
          stock: doc.stock,
          reserved: Number(product.stock_reserved ?? 0),
          low_stock_threshold: (product.low_stock_threshold as number | null) ?? null,
        })
      : undefined,
    links: view?.links,
    preferredType: transportMethod ? 'pre_order' : null,
  });
  if (availability.mode === 'unavailable') {
    throw badRequest(
      availability.reason === 'OUT_OF_STOCK'
        ? 'That selection is out of stock.'
        : `This item cannot be added right now (${availability.reason ?? 'UNAVAILABLE'})`,
      availability.reason ?? 'UNAVAILABLE'
    );
  }
  if (!availability.qty_ok) {
    throw badRequest(
      availability.stock.available === null
        ? `At most ${availability.stock.max_qty} per order`
        : `Only ${availability.stock.available} left`,
      'QTY_UNAVAILABLE'
    );
  }

  // shipping_method_id stays '' — legacy column kept for the UNIQUE key only,
  // pricing is entirely resolver-driven now.
  // The full selection is stored canonically sorted so two requests that name
  // the same values in a different order are the same line. option_id keeps
  // the first value for the pre-0018 UNIQUE key and every legacy reader.
  const canonical = [...optionValueIds].sort();
  const primaryOption = canonical[0] ?? '';
  await c.env.DB.prepare(
    `INSERT INTO cart_items (id, user_id, product_id, option_id, option_value_ids, color_id,
                             shipping_method_id, transport_method, warranty_plan_id, qty)
     VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?)
     ON CONFLICT(user_id, product_id, option_id, color_id, shipping_method_id)
     DO UPDATE SET qty = MIN(99, qty + excluded.qty),
                   option_value_ids = excluded.option_value_ids,
                   transport_method = excluded.transport_method,
                   warranty_plan_id = excluded.warranty_plan_id`
  )
    .bind(
      newId('ci'), user.id, productId, primaryOption, JSON.stringify(canonical), colorId,
      transportMethod, warrantyPlanId, qty
    )
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
  const patchRawIds: unknown[] = Array.isArray(body.optionValueIds) ? body.optionValueIds : [];
  const optionValueIds: string[] =
    body.optionValueIds !== undefined || body.optionId !== undefined
      ? [
          ...new Set<string>([
            ...patchRawIds.filter((x): x is string => typeof x === 'string' && x.length > 0),
            ...(optionId ? [optionId] : []),
          ]),
        ].slice(0, 12)
      : (selectionFromCartRow(existing).optionValueIds ?? []);
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

  const [{ tier, active: tierActive }, ctx, views] = await Promise.all([
    effectiveTier(c.env, user),
    loadPricingContext(c.env.DB),
    loadRelationsViews(c.env.DB, [{ id: String(existing.product_id), inventory_mode: product.inventory_mode }]),
  ]);
  const view = views.get(String(existing.product_id));
  const { doc, resolved, selectionErrors } = resolveCartLine(
    product,
    { optionId, optionValueIds, colorId, transportMethod, warrantyPlanId },
    tier,
    tierActive,
    ctx,
    view
  );
  if (resolved.errors.length > 0) {
    throw badRequest(`Invalid selection: ${resolved.errors.join(', ')}`, 'VALIDATION');
  }
  if (selectionErrors.length > 0) {
    throw badRequest(`Invalid selection: ${selectionErrors.join(', ')}`, 'VALIDATION');
  }

  const availability = saleAvailability(doc, {
    optionValueIds,
    colorId: colorId || null,
    qty,
    transportDefaults: ctx.transportDefaults,
    inventory: view
      ? snapshotFrom(view, {
          stock: doc.stock,
          reserved: Number(product.stock_reserved ?? 0),
          low_stock_threshold: (product.low_stock_threshold as number | null) ?? null,
        })
      : undefined,
    links: view?.links,
    preferredType: transportMethod ? 'pre_order' : null,
  });
  if (availability.mode === 'unavailable') {
    throw badRequest(
      `This item cannot be updated right now (${availability.reason ?? 'UNAVAILABLE'})`,
      availability.reason ?? 'UNAVAILABLE'
    );
  }
  if (!availability.qty_ok) {
    throw badRequest(
      availability.stock.available === null
        ? `At most ${availability.stock.max_qty} per order`
        : `Only ${availability.stock.available} left`,
      'QTY_UNAVAILABLE'
    );
  }

  const canonical = [...optionValueIds].sort();
  await c.env.DB.prepare(
    `UPDATE cart_items SET qty = ?, option_id = ?, option_value_ids = ?, color_id = ?,
            transport_method = ?, warranty_plan_id = ?
      WHERE id = ? AND user_id = ?`
  )
    .bind(
      qty, canonical[0] ?? '', JSON.stringify(canonical), colorId,
      transportMethod, warrantyPlanId, id, user.id
    )
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
