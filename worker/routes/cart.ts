import { Hono } from 'hono';
import { cartShippingType, typeForTransport } from '../lib/shippingType';
import {
  cartSellerScope,
  sellerConflict,
  conflictDetails,
  merchantScope,
  PLATFORM_SCOPE,
  CART_SELLER_CONFLICT,
  type SellerLine,
} from '../lib/cartSeller';
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
import { validateCoupon } from '../lib/membershipOps';
import { rateLimit } from '../lib/ratelimit';
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

/**
 * Is this promo code real, and may THIS customer use it?
 *
 * WHY IT LIVES ON THE CART AND NOT ON THE QUOTE. The final discount depends
 * on the payable total, which needs an address and a delivery method the
 * customer has not chosen yet while they are still looking at their cart. The
 * checkout quote stays the authority on the AMOUNT. This answers the question
 * the cart can actually ask — does the code exist, is it live, is it for my
 * tier, have I used it up — against the merchandise total the SERVER computes
 * from the cart rows, never a number the browser sent.
 *
 * Delivery is deliberately excluded from that total, so a code whose minimum
 * this cart only clears once delivery is added reads as "minimum not met"
 * here rather than being promised and then refused at checkout.
 *
 * It redeems nothing, and it says nothing about a code the customer did not
 * type: the minimum spend is only returned for a code that exists and is
 * live, because returning it for one that does not would confirm which codes
 * are real to anyone guessing.
 */
cartRoutes.post('/coupon-check', async (c) => {
  await rateLimit(c, 'coupon_check', 30, 300);
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const code = str(body.code, 'code', { max: 60 });

  const { items } = await loadCart(c);
  if (items.length === 0) throw badRequest('Your cart is empty', 'CART_EMPTY');
  const merchandise = items.reduce(
    (sum, it) => sum + Number((it as { unit_price_iqd?: number }).unit_price_iqd ?? 0) * Number((it as { qty?: number }).qty ?? 0),
    0
  );

  const check = await validateCoupon(c.env, user.id, code, merchandise);
  if (!check.ok) {
    const row = await c.env.DB
      .prepare('SELECT min_total_iqd, tier_required FROM coupons WHERE code = ? AND active = 1')
      .bind(code.trim().toUpperCase())
      .first<{ min_total_iqd: number; tier_required: string | null }>();
    return c.json({
      success: true,
      valid: false,
      reason: check.reason ?? 'COUPON_INVALID',
      min_total_iqd: row ? row.min_total_iqd : null,
      tier_required: row ? row.tier_required : null,
      cart_total_iqd: merchandise,
    });
  }
  return c.json({
    success: true,
    valid: true,
    code: check.code,
    // An ESTIMATE against merchandise only, and named for what it is. The
    // checkout quote is the authority and will differ once delivery counts.
    estimated_discount_iqd: check.discount_iqd,
    cart_total_iqd: merchandise,
  });
});

cartRoutes.get('/', async (c) => {
  const { items, tier, tierActive } = await loadCart(c);
  // §1: the type the cart is locked to, so the storefront can say so before
  // the customer discovers it by being refused. null = empty, so any type may
  // still be started.
  const shippingType = cartShippingType(items as Array<{ transport_method?: unknown }>);
  return c.json({ success: true, items, tier, tierActive, shipping_type: shippingType });
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

  // ONE SHIPPING TYPE PER CART, checked before anything is written.
  //
  // Direct, air, sea and land are four different journeys with four different
  // timelines and four different tracking paths — a basket holding two of them
  // has no honest delivery date to show. The first item decides; a mismatch is
  // refused with both types named, so the client can offer the only two real
  // ways out (empty the cart and start this type, or keep what is there).
  //
  // `replaceCart: true` is that first choice arriving as one request: the
  // caller has already confirmed, and doing it in a single call means a cart
  // can never be left emptied with nothing added because the second request
  // failed.
  const incomingType = typeForTransport(transportMethod);
  const { results: existingLines } = await c.env.DB
    .prepare('SELECT transport_method, seller_type, merchant_id, store_id FROM cart_items WHERE user_id = ?')
    .bind(user.id)
    .all<{ transport_method: string; seller_type: string; merchant_id: string | null; store_id: string | null }>();
  const currentType = cartShippingType(existingLines);
  const replaceCart = body.replaceCart === true;

  // ONE SELLER PER CART (§14). This is a Levonis product; if the cart is
  // currently a merchant's, the two cannot settle as one order — different
  // fulfilment, different commission, different party responsible. Checked
  // before any pricing work, and refused the same way whether or not the
  // client showed the customer a dialogue first.
  const sellerClash = sellerConflict(existingLines as SellerLine[], PLATFORM_SCOPE);
  if (sellerClash && !replaceCart) {
    const shop = sellerClash.current.merchant_id
      ? await c.env.DB.prepare('SELECT name FROM community_merchants WHERE id = ?')
          .bind(sellerClash.current.merchant_id)
          .first<{ name: string }>()
      : null;
    throw badRequest(
      'Your cart holds items from another store. Empty it to shop from LEVONIS.',
      CART_SELLER_CONFLICT,
      conflictDetails(sellerClash, { current: shop?.name ?? null, incoming: 'LEVONIS' })
    );
  }
  if (sellerClash && replaceCart) {
    await c.env.DB.prepare('DELETE FROM cart_items WHERE user_id = ?').bind(user.id).run();
    existingLines.length = 0;
  }

  if (currentType !== null && currentType !== incomingType) {
    if (!replaceCart) {
      throw badRequest(
        'Your cart holds items with a different shipping type. It must be emptied to add this one.',
        'CART_SHIPPING_CONFLICT',
        { cart_shipping_type: currentType, incoming_shipping_type: incomingType }
      );
    }
    await c.env.DB.prepare('DELETE FROM cart_items WHERE user_id = ?').bind(user.id).run();
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

  // The one-type rule has a second door. POST /items guards the ADD, but
  // editing an existing line's transport changes its type in place — and in a
  // two-line cart that is exactly the mix the rule forbids, arrived at from
  // the cart screen instead of the product screen. Only the OTHER lines are
  // consulted: re-typing the only line in the cart re-types the whole cart,
  // which is legal and is how a customer switches air to sea.
  const incomingType = typeForTransport(transportMethod);
  if (typeForTransport(existing.transport_method) !== incomingType) {
    const { results: otherLines } = await c.env.DB
      .prepare('SELECT transport_method FROM cart_items WHERE user_id = ? AND id != ?')
      .bind(user.id, id)
      .all<{ transport_method: string }>();
    const otherType = cartShippingType(otherLines);
    if (otherType !== null && otherType !== incomingType) {
      throw badRequest(
        'Your cart holds items with a different shipping type. It must be emptied to add this one.',
        'CART_SHIPPING_CONFLICT',
        { cart_shipping_type: otherType, incoming_shipping_type: incomingType }
      );
    }
  }

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

/**
 * Empties the cart.
 *
 * Exists for the shipping-type conflict: "empty the cart and add this item"
 * is one confirmed intent, and POST /items with `replaceCart: true` does it
 * atomically. This is the plain version for a customer who just wants to
 * start over, and it never touches anything but their own rows.
 */
cartRoutes.delete('/', async (c) => {
  const user = c.get('user')!;
  const res = await c.env.DB.prepare('DELETE FROM cart_items WHERE user_id = ?').bind(user.id).run();
  return c.json({ success: true, removed: res.meta.changes ?? 0 });
});

cartRoutes.delete('/items/:id', async (c) => {
  const user = c.get('user')!;
  await c.env.DB.prepare('DELETE FROM cart_items WHERE id = ? AND user_id = ?')
    .bind(c.req.param('id'), user.id)
    .run();
  const { items, tier, tierActive } = await loadCart(c);
  return c.json({ success: true, items, tier, tierActive });
});

// ---------------------------------------------------------------------------
// MERCHANT PRODUCTS IN THE SAME CART
//
// The same cart table, the same customer, the same checkout — one cart
// infrastructure (§14). What differs is the seller, and the seller is what
// decides whether two lines can sit together.
//
// PRICE IS NEVER TAKEN FROM THE BROWSER (§17). The client sends an id and a
// quantity; everything that costs money is read from D1 here. A client that
// posts `price_iqd` is ignored, not trusted and not rejected-with-a-hint.
// ---------------------------------------------------------------------------

/** Loads a merchant product that is actually buyable right now. */
async function loadBuyableMerchantProduct(c: Context<AppContext>, productId: string) {
  const row = await c.env.DB.prepare(
    `SELECT p.*, s.id AS s_id, s.slug AS s_slug, s.name AS s_name, s.status AS s_status,
            m.id AS m_id, m.name AS m_name, m.status AS m_status
       FROM community_products p
       JOIN merchant_stores s ON s.id = p.store_id
       JOIN community_merchants m ON m.id = p.merchant_id
      WHERE p.id = ?`
  ).bind(productId).first<Record<string, unknown>>();

  if (!row) throw notFound('Product not found');
  // Each refusal names only what a shopper needs to know. "This store is not
  // taking orders" is true whether the merchant paused it, an admin suspended
  // it, or their subscription lapsed — a customer has no business being told
  // which, and a probe learns nothing about another account's billing.
  if (row.lifecycle !== 'active' || row.status !== 'active') throw notFound('Product not found');
  if (row.s_status !== 'active' || row.m_status === 'suspended') {
    throw badRequest('This store is not taking orders right now', 'STORE_CLOSED');
  }
  return row;
}

cartRoutes.post('/merchant-items', async (c) => {
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const productId = str(body.productId, 'productId', { min: 1, max: 60 });
  const qty = int(body.qty, 'qty', { min: 1, max: 99, def: 1 });
  const optionId = str(body.optionId, 'optionId', { max: 60, required: false });
  const colorId = str(body.colorId, 'colorId', { max: 60, required: false });
  const replaceCart = body.replaceCart === true;

  const product = await loadBuyableMerchantProduct(c, productId);
  const incoming = merchantScope(String(product.m_id), String(product.s_id));

  const { results: existingLines } = await c.env.DB
    .prepare('SELECT seller_type, merchant_id, store_id FROM cart_items WHERE user_id = ?')
    .bind(user.id)
    .all<SellerLine>();

  const clash = sellerConflict(existingLines, incoming);
  if (clash && !replaceCart) {
    // Name BOTH shops. "Items from another store" leaves the customer
    // guessing which of the shops they were browsing is in the way.
    const currentName = clash.current.seller_type === 'levonis'
      ? 'LEVONIS'
      : (await c.env.DB.prepare('SELECT name FROM community_merchants WHERE id = ?')
          .bind(clash.current.merchant_id)
          .first<{ name: string }>())?.name ?? null;
    throw badRequest(
      'Your cart holds items from a different seller. Empty it to shop from this store.',
      CART_SELLER_CONFLICT,
      conflictDetails(clash, { current: currentName, incoming: String(product.m_name) })
    );
  }
  if (clash && replaceCart) {
    // One request, one confirmed intent — so the cart can never be left
    // emptied with nothing added because a second call failed.
    await c.env.DB.prepare('DELETE FROM cart_items WHERE user_id = ?').bind(user.id).run();
  }

  // Stock, from the row that was just read under the same request.
  if (product.track_stock && Number(product.stock) < qty) {
    throw badRequest('Not enough stock for that quantity', 'OUT_OF_STOCK', {
      available: Number(product.stock),
    });
  }

  const id = newId('ci');
  await c.env.DB.prepare(
    `INSERT INTO cart_items
       (id, user_id, seller_type, merchant_id, store_id, community_product_id, option_id, color_id, qty)
     VALUES (?, ?, 'merchant', ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, product_id, community_product_id, option_id, color_id, shipping_method_id)
     DO UPDATE SET qty = MIN(99, cart_items.qty + excluded.qty)`
  ).bind(id, user.id, product.m_id, product.s_id, productId, optionId, colorId, qty).run();

  const cart = await loadMerchantCart(c);
  return c.json({ success: true, ...cart }, 201);
});

/**
 * The merchant half of the cart, priced from the database.
 *
 * Kept separate from `loadCart` rather than folded into it: `loadCart` runs
 * the whole platform pricing resolver — membership pricing, transport
 * defaults, warranty plans, support-gift eligibility — none of which applies
 * to a merchant's own goods. Forcing one function to do both would make the
 * platform path harder to read in order to serve a path that needs almost
 * none of it. The two never run together anyway: a cart is one seller.
 */
async function loadMerchantCart(c: Context<AppContext>) {
  const user = c.get('user')!;
  const { results } = await c.env.DB.prepare(
    `SELECT ci.id AS cart_item_id, ci.qty, ci.option_id, ci.color_id,
            p.id, p.name, p.name_ar, p.images, p.price_iqd, p.original_price_iqd,
            p.stock, p.track_stock, p.lifecycle, p.prep_days,
            s.id AS store_id, s.slug AS store_slug, s.name AS store_name,
            m.id AS merchant_id, m.name AS merchant_name
       FROM cart_items ci
       JOIN community_products p ON p.id = ci.community_product_id
       JOIN merchant_stores s ON s.id = ci.store_id
       JOIN community_merchants m ON m.id = ci.merchant_id
      WHERE ci.user_id = ? AND ci.seller_type = 'merchant'
      ORDER BY ci.created_at DESC`
  ).bind(user.id).all<Record<string, unknown>>();

  let subtotal = 0;
  const items = results.map((r) => {
    const unit = Number(r.price_iqd) || 0;
    const qty = Number(r.qty) || 1;
    const line = unit * qty;
    subtotal += line;
    return {
      cart_item_id: r.cart_item_id,
      product_id: r.id,
      name: r.name,
      name_ar: r.name_ar,
      images: safeParse(r.images, []),
      qty,
      option_id: r.option_id,
      color_id: r.color_id,
      unit_price_iqd: unit,
      original_price_iqd: r.original_price_iqd,
      line_total_iqd: line,
      prep_days: r.prep_days,
      // Whether this line can still be bought. A product hidden or sold out
      // after it was added stays visible in the cart, flagged, rather than
      // vanishing without explanation.
      available: r.lifecycle === 'active' && (!r.track_stock || Number(r.stock) >= qty),
      stock: r.track_stock ? Number(r.stock) : null,
    };
  });

  const first = results[0];
  return {
    scope: cartSellerScope(
      results.map((r) => ({ seller_type: 'merchant', merchant_id: r.merchant_id, store_id: r.store_id }))
    ),
    store: first
      ? { id: first.store_id, slug: first.store_slug, name: first.store_name, merchant_id: first.merchant_id }
      : null,
    items,
    subtotal_iqd: subtotal,
  };
}

/**
 * What is in the cart, and whose it is.
 *
 * The frontend calls this to decide which cart view to render. A cart is one
 * seller, so the answer is one shape or the other, never both.
 */
cartRoutes.get('/scope', async (c) => {
  const user = c.get('user')!;
  const { results } = await c.env.DB
    .prepare('SELECT seller_type, merchant_id, store_id FROM cart_items WHERE user_id = ?')
    .bind(user.id)
    .all<SellerLine>();
  const scope = cartSellerScope(results);
  if (!scope || scope.seller_type === 'levonis') {
    return c.json({ success: true, scope, store: null, count: results.length });
  }
  const store = await c.env.DB.prepare(
    `SELECT s.id, s.slug, s.name, m.id AS merchant_id, m.name AS merchant_name
       FROM merchant_stores s JOIN community_merchants m ON m.id = s.merchant_id
      WHERE s.id = ?`
  ).bind(scope.store_id).first();
  return c.json({ success: true, scope, store, count: results.length });
});

/** The merchant cart, priced. Returns an empty cart rather than 404 for a platform cart. */
cartRoutes.get('/merchant', async (c) => {
  return c.json({ success: true, ...(await loadMerchantCart(c)) });
});
