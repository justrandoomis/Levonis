/**
 * A GIFT IS A REAL STORE PRODUCT, VARIANT, COLOUR, QUANTITY AND SALE TYPE
 * (owner brief 2026-10-06 §1: «لا تنشئ منتجات هدايا منفصلة عن المتجر. يجب ربط
 * الهدية بالمنتج الحقيقي وVariant الحقيقي»; docs/GIFTS_QUICK_BUY.md D2, D3).
 *
 * ONE RULE for every door that names a gift's product: the level-item editor,
 * the manual product grant, «اختر هديتك», «استرداد الهدية», the gift cart door
 * and the checkout. It is the store's own chain, never a copy of it:
 * `resolveCartLine` (the model, colour, order-type and route rungs plus the
 * relational `validateSelection`), `saleAvailability` asked about the STATED
 * type, and `unusableOrderType` — a stated type is honoured or refused, never
 * swapped. Bundles and mystery offers cannot be gifts
 * (GIFT_COMPOSITION_UNSUPPORTED, decision S6).
 *
 * Loading is split from checking: `loadGiftProduct` reads a product once and
 * `checkGiftSelection` is pure, so a list of level items costs one read per
 * product, not per item.
 */
import { getSettings } from '../settings';
import { applyRelations, capacityFrom, loadRelationsViews, snapshotFrom, type ProductRelationsView } from '../productOverlay';
import { parseProductRow, type ProductDoc } from '../productModel';
import { canonicalOptionValueIds, optionValueIdsInRelationOrder } from '../cartSelectionIdentity';
import { productImageForSelection } from '../productSelectionImage';
import { pricingContextFrom, resolveCartLine, type PricingContext } from '../../routes/cart';
import { saleAvailability, unusableOrderType, type SaleAvailability } from '../../routes/products';

export type GiftSaleType = 'direct_sale' | 'pre_order';
export type GiftTransport = '' | 'air' | 'sea' | 'land';
export const GIFT_TRANSPORTS: readonly GiftTransport[] = ['', 'air', 'sea', 'land'];
/** The most units one gift may grant (the CHECKs on gift_pool_items.qty and gift_entitlements.gift_qty). */
export const GIFT_QTY_MAX = 99;
/** At most this many option values in one selection (the cart door's own cap). */
export const GIFT_MAX_OPTION_VALUES = 12;

export interface GiftSelectionInput {
  productId: string;
  saleType: string;
  /** The complete selection, any order; canonicalised inside. */
  optionValueIds: readonly string[];
  colorId: string;
  transportMethod: string;
  qty: number;
}

export type GiftSelectionCode =
  | 'GIFT_PRODUCT_NOT_FOUND'
  | 'GIFT_PRODUCT_INACTIVE'
  | 'GIFT_COMPOSITION_UNSUPPORTED'
  | 'GIFT_SALE_TYPE_UNAVAILABLE'
  | 'GIFT_TRANSPORT_REQUIRED'
  | 'GIFT_SELECTION_INVALID'
  | 'GIFT_QTY_INVALID'
  | 'OUT_OF_STOCK';

/** The canonical, frozen selection a gift row stores (`gift_*` columns). */
export interface GiftSelection {
  productId: string;
  optionValueIds: string[];
  colorId: string;
  qty: number;
  saleType: GiftSaleType;
  /** '' on a direct sale; the route on a pre-order. */
  transportMethod: GiftTransport;
}

/**
 * THE WORDS AND THE PICTURE A GIFT IS SHOWN WITH, frozen into
 * `gift_entitlements.gift_snapshot` when the product is fixed (D2: display
 * only — the cart and the checkout read the `gift_*` columns and the live
 * product, never this). `image` is a `/files/…` reference the media sweeper
 * protects (worker/lib/mediaRefs.ts).
 */
export interface GiftSnapshot {
  v: 1;
  product_id: string;
  option_value_ids: string[];
  color_id: string;
  qty: number;
  sale_type: GiftSaleType;
  transport_method: GiftTransport;
  slug: string;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  image: string;
  variant_ar: string;
  variant_en: string;
  variant_ckb: string;
  color_name_ar: string;
  color_name_en: string;
  color_name_ckb: string;
  color_hex: string;
  sku: string;
  /** The product's REGULAR unit price for this selection when the snapshot was taken — never charged. */
  regular_unit_iqd: number;
  /** regular_unit_iqd × qty: what the gift is worth, shown beside its 0 IQD line. */
  value_iqd: number;
  lead_time_text: string;
  captured_at: string;
}

export type GiftSelectionResult =
  | { ok: true; selection: GiftSelection; snapshot: GiftSnapshot; availability: SaleAvailability }
  | { ok: false; code: GiftSelectionCode; errors: string[] };

type Failure = Extract<GiftSelectionResult, { ok: false }>;

const fail = (code: GiftSelectionCode, errors: string[]): Failure => ({
  ok: false,
  code,
  errors: [...new Set(errors.filter(Boolean))],
});

const text = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const isOn = (v: unknown): boolean => v !== 0 && v !== false && v !== '0';

// ------------------------------------------------------------- the product

/** Everything one product contributes to a gift decision, read once. */
export interface GiftProductContext {
  productId: string;
  /** The `products` row in any status, or null when the id names nothing. */
  row: Record<string, unknown> | null;
  view: ProductRelationsView | undefined;
  /** Regular pricing only: a gift's value is the regular price, never a member's. */
  ctx: PricingContext;
}

export async function loadGiftProduct(env: { DB: D1Database }, productId: string): Promise<GiftProductContext> {
  const id = text(productId).trim().slice(0, 80);
  const [row, settings] = await Promise.all([
    id ? env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(id).first<Record<string, unknown>>() : Promise.resolve(null),
    getSettings(env.DB, ['proPricingPolicy', 'preorderTransportDefaults']),
  ]);
  const ctx = pricingContextFrom(settings);
  if (!row) return { productId: id, row: null, view: undefined, ctx };
  const views = await loadRelationsViews(env.DB, [{ id, inventory_mode: row.inventory_mode }]);
  return { productId: id, row, view: views.get(id), ctx };
}

/** Several products at once, for a list of level items or of gifts. */
export async function loadGiftProducts(env: { DB: D1Database }, productIds: readonly string[]): Promise<Map<string, GiftProductContext>> {
  const ids = [...new Set(productIds.map((p) => text(p).trim()).filter(Boolean))];
  const out = new Map<string, GiftProductContext>();
  if (ids.length === 0) return out;
  const [rows, settings] = await Promise.all([
    env.DB.prepare('SELECT * FROM products WHERE id IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(ids))
      .all<Record<string, unknown>>(),
    getSettings(env.DB, ['proPricingPolicy', 'preorderTransportDefaults']),
  ]);
  const ctx = pricingContextFrom(settings);
  const byId = new Map((rows.results ?? []).map((r) => [text(r.id), r]));
  const views = await loadRelationsViews(
    env.DB,
    [...byId.values()].map((r) => ({ id: text(r.id), inventory_mode: r.inventory_mode }))
  );
  for (const id of ids) {
    const row = byId.get(id) ?? null;
    out.set(id, { productId: id, row, view: row ? views.get(id) : undefined, ctx });
  }
  return out;
}

/** The product as the storefront reads it: the row with its relational options and colours applied. */
function productDoc(p: GiftProductContext): ProductDoc {
  const doc = parseProductRow(p.row!);
  return p.view ? applyRelations(doc, p.view) : doc;
}

/** The product-level gate every gift decision shares. */
function productGate(p: GiftProductContext): Failure | null {
  if (!p.row) return fail('GIFT_PRODUCT_NOT_FOUND', ['PRODUCT_NOT_FOUND']);
  if (text(p.row.composition) !== '') return fail('GIFT_COMPOSITION_UNSUPPORTED', [text(p.row.composition).toUpperCase()]);
  if (text(p.row.status) !== 'active') return fail('GIFT_PRODUCT_INACTIVE', ['PRODUCT_INACTIVE']);
  return null;
}

/** Store codes that describe the SELECTION (a wrong value, colour or pairing). */
const SELECTION_CODES = new Set([
  'OPTION_NOT_FOUND',
  'OPTION_INACTIVE',
  'OPTION_REQUIRED',
  'OPTION_VALUE_NOT_FOUND',
  'OPTION_VALUE_INACTIVE',
  'OPTION_GROUP_DUPLICATE_SELECTION',
  'OPTION_GROUP_REQUIRED',
  'COLOR_NOT_FOUND',
  'COLOR_INACTIVE',
  'COLOR_OPTION_MISMATCH',
  'COLOR_REQUIRED',
  'VARIANT_NOT_MODELLED',
  'TRANSPORT_NOT_APPLICABLE',
  'REGULAR_PRICE_INVALID',
]);
/** Store codes that say the stated SALE TYPE or route is not offered. */
const SALE_TYPE_CODES = new Set([
  'FULFILLMENT_NOT_OFFERED',
  'FULFILLMENT_DISABLED',
  'TRANSPORT_NOT_OFFERED',
  'TRANSPORT_DISABLED',
  'DIRECT_SALE_NOT_ENABLED',
  'PREORDER_NOT_ENABLED',
  'NO_TRANSPORT_OFFERED',
]);
/** A sale type that IS offered but cannot be sold today for want of units. */
const STOCK_CODES = new Set(['OUT_OF_STOCK', 'PREORDER_CAPACITY_EXHAUSTED', 'QTY_UNAVAILABLE']);

/**
 * THE ONE RULE. Pure: everything it reads is in `p`.
 *
 * `requireSellable` adds today's facts — enough stock (or pre-order room) for
 * `qty` units of the stated type. The admin editors pass false so an item can
 * be configured while it is out of stock; «اختر» and every door after it pass
 * true, so a customer is never handed a gift that cannot be ordered.
 */
export function checkGiftSelection(
  p: GiftProductContext,
  input: GiftSelectionInput,
  opts: { requireSellable: boolean; now?: string }
): GiftSelectionResult {
  const gate = productGate(p);
  if (gate) return gate;
  const row = p.row!;
  const saleType = input.saleType;
  if (saleType !== 'direct_sale' && saleType !== 'pre_order') return fail('GIFT_SALE_TYPE_UNAVAILABLE', ['SALE_TYPE_INVALID']);
  const transport = text(input.transportMethod);
  if (!GIFT_TRANSPORTS.includes(transport as GiftTransport)) return fail('GIFT_SELECTION_INVALID', ['TRANSPORT_INVALID']);
  if (saleType === 'direct_sale' && transport) return fail('GIFT_SELECTION_INVALID', ['TRANSPORT_NOT_APPLICABLE']);
  if (saleType === 'pre_order' && !transport) return fail('GIFT_TRANSPORT_REQUIRED', ['TRANSPORT_REQUIRED']);
  const qty = Number(input.qty);
  if (!Number.isInteger(qty) || qty < 1 || qty > GIFT_QTY_MAX) return fail('GIFT_QTY_INVALID', ['QTY_INVALID']);

  const canonical = canonicalOptionValueIds(Array.isArray(input.optionValueIds) ? [...input.optionValueIds] : []);
  if (canonical.length > GIFT_MAX_OPTION_VALUES) return fail('GIFT_SELECTION_INVALID', ['OPTION_GROUP_DUPLICATE_SELECTION']);
  const colorId = text(input.colorId);

  // The cart door's resolution, verbatim: the regular ladder (a gift's value is
  // never a member's price), the stated type and route, and with relational
  // rows `validateSelection` judges the colour/option algebra.
  const { doc, resolved, selectionErrors } = resolveCartLine(
    row,
    {
      optionId: canonical[0] ?? '',
      optionValueIds: canonical,
      colorId,
      transportMethod: transport,
      fulfillmentType: saleType,
      warrantyPlanId: '',
    },
    'free',
    false,
    p.ctx,
    p.view,
    'prepaid',
    false
  );
  const availability = saleAvailability(doc, {
    optionValueIds: canonical,
    colorId: colorId || null,
    qty,
    transportDefaults: p.ctx.transportDefaults,
    inventory: p.view
      ? snapshotFrom(p.view, {
          stock: doc.stock,
          reserved: Number(row.stock_reserved ?? 0),
          low_stock_threshold: (row.low_stock_threshold as number | null) ?? null,
        })
      : undefined,
    links: p.view?.links,
    preferredType: saleType,
    capacity: p.view ? capacityFrom(p.view, canonical) : null,
    transportMethod: transport,
  });

  // 1. The selection itself — a value of another product, a colour not linked
  //    to the chosen model, a group left empty.
  const selection = [
    ...selectionErrors,
    ...availability.selection.errors,
    ...resolved.errors.filter((e) => SELECTION_CODES.has(e)),
  ];
  if (selection.length) return fail('GIFT_SELECTION_INVALID', selection);
  // A product with live option groups is sold as ONE complete model; a legacy
  // JSON-column product with options must name one too (the cart's own rule).
  if (!availability.selection.complete) return fail('GIFT_SELECTION_INVALID', availability.selection.errors);

  // 2. The stated sale type must be one this model offers.
  if (resolved.errors.includes('TRANSPORT_REQUIRED')) return fail('GIFT_TRANSPORT_REQUIRED', ['TRANSPORT_REQUIRED']);
  const saleErrors = resolved.errors.filter((e) => SALE_TYPE_CODES.has(e));
  if (saleErrors.length) return fail('GIFT_SALE_TYPE_UNAVAILABLE', saleErrors);
  const mode = availability.modes.find((m) => m.type === saleType);
  if (!mode) return fail('GIFT_SALE_TYPE_UNAVAILABLE', [saleType === 'pre_order' ? 'PREORDER_NOT_ENABLED' : 'DIRECT_SALE_NOT_ENABLED']);
  if (saleType === 'pre_order' && !availability.preorder.transports.some((t) => t.method === transport)) {
    return fail('GIFT_SALE_TYPE_UNAVAILABLE', ['TRANSPORT_NOT_OFFERED']);
  }
  const other = resolved.errors.filter((e) => !SELECTION_CODES.has(e) && !SALE_TYPE_CODES.has(e));
  if (other.length) return fail('GIFT_SELECTION_INVALID', other);

  // 3. Today's facts, only where units are about to be promised.
  if (opts.requireSellable) {
    const refusal = unusableOrderType(availability, saleType);
    if (refusal) return fail(STOCK_CODES.has(refusal.code) ? 'OUT_OF_STOCK' : 'GIFT_SALE_TYPE_UNAVAILABLE', [refusal.code]);
    if (availability.mode === 'unavailable') {
      const why = availability.reason ?? 'UNAVAILABLE';
      return fail(STOCK_CODES.has(why) ? 'OUT_OF_STOCK' : 'GIFT_SALE_TYPE_UNAVAILABLE', [why]);
    }
    if (!availability.qty_ok) return fail('OUT_OF_STOCK', ['QTY_UNAVAILABLE']);
  }

  const sel: GiftSelection = {
    productId: p.productId,
    optionValueIds: canonical,
    colorId,
    qty,
    saleType,
    transportMethod: transport as GiftTransport,
  };
  return {
    ok: true,
    selection: sel,
    snapshot: snapshotFor(p, doc, sel, Number(resolved.regular_iqd) || 0, text(resolved.fulfillment?.lead_time_text), opts.now),
    availability,
  };
}

export async function validateGiftSelection(
  env: { DB: D1Database },
  input: GiftSelectionInput,
  opts: { requireSellable: boolean }
): Promise<GiftSelectionResult> {
  return checkGiftSelection(await loadGiftProduct(env, input.productId), input, opts);
}

// ----------------------------------------------------------------- labels

function productNames(row: Record<string, unknown>) {
  const en = text(row.name);
  const ar = text(row.name_ar) || en;
  return { name_en: en || ar, name_ar: ar, name_ckb: text(row.name_ku) || ar };
}

function snapshotFor(
  p: GiftProductContext,
  doc: ProductDoc,
  sel: GiftSelection,
  regularUnitIqd: number,
  leadTime: string,
  now?: string
): GiftSnapshot {
  const row = p.row!;
  const ordered = optionValueIdsInRelationOrder(sel.optionValueIds, p.view);
  const options = ordered
    .map((id) => doc.options.find((o) => o.id === id))
    .filter((o): o is NonNullable<typeof o> => !!o);
  const color = sel.colorId ? doc.colors.find((c) => c.id === sel.colorId) ?? null : null;
  const label = (o: { name_ar: string; name_en: string; name_ckb: string }) => ({
    ar: o.name_ar || o.name_en,
    en: o.name_en || o.name_ar,
    ckb: o.name_ckb || o.name_ar || o.name_en,
  });
  const labels = options.map(label);
  const parts = [
    ...(p.view?.values ?? []).filter((v) => ordered.includes(v.id)).map((v) => text(v.sku_part)),
    ...(p.view?.colors ?? []).filter((c) => c.id === sel.colorId).map((c) => text(c.sku_part)),
  ].filter(Boolean);
  const unit = Math.max(0, Math.round(regularUnitIqd));
  return {
    v: 1,
    product_id: sel.productId,
    option_value_ids: sel.optionValueIds,
    color_id: sel.colorId,
    qty: sel.qty,
    sale_type: sel.saleType,
    transport_method: sel.transportMethod,
    slug: text(row.slug),
    ...productNames(row),
    image: productImageForSelection(doc, { optionValueIds: ordered, colorId: sel.colorId || null }, p.view),
    variant_ar: labels.map((l) => l.ar).join(' / '),
    variant_en: labels.map((l) => l.en).join(' / '),
    variant_ckb: labels.map((l) => l.ckb).join(' / '),
    color_name_ar: color ? label(color).ar : '',
    color_name_en: color ? label(color).en : '',
    color_name_ckb: color ? label(color).ckb : '',
    color_hex: color ? text(color.hex) : '',
    sku: [text(row.sku), ...parts].filter(Boolean).join('-'),
    regular_unit_iqd: unit,
    value_iqd: unit * sel.qty,
    lead_time_text: leadTime,
    captured_at: now ?? new Date().toISOString(),
  };
}

/** A stored snapshot, or null for a legacy row / unparsable JSON. */
export function parseGiftSnapshot(raw: unknown): GiftSnapshot | null {
  try {
    const s = JSON.parse(text(raw) || '{}') as Partial<GiftSnapshot> | null;
    if (!s || s.v !== 1 || typeof s.product_id !== 'string') return null;
    return s as GiftSnapshot;
  } catch {
    return null;
  }
}

/** The frozen selection a gift (or a level item) row stores, or null when nothing is fixed yet. */
export function selectionFromColumns(row: {
  product_id?: unknown;
  option_value_ids?: unknown;
  color_id?: unknown;
  qty?: unknown;
  sale_type?: unknown;
  transport_method?: unknown;
}): GiftSelection | null {
  const productId = text(row.product_id);
  const saleType = text(row.sale_type);
  if (!productId || (saleType !== 'direct_sale' && saleType !== 'pre_order')) return null;
  let ids: unknown = [];
  try {
    ids = JSON.parse(text(row.option_value_ids) || '[]');
  } catch {
    ids = [];
  }
  const transport = text(row.transport_method);
  return {
    productId,
    optionValueIds: canonicalOptionValueIds(Array.isArray(ids) ? ids : []),
    colorId: text(row.color_id),
    qty: Math.max(1, Math.trunc(Number(row.qty) || 1)),
    saleType,
    // A direct sale has no route, whatever a column says.
    transportMethod: (saleType === 'pre_order' && GIFT_TRANSPORTS.includes(transport as GiftTransport) ? transport : '') as GiftTransport,
  };
}

/** The `gift_*` columns of an entitlement as a selection. */
export function giftSelectionOf(g: Record<string, unknown> | null | undefined): GiftSelection | null {
  if (!g) return null;
  return selectionFromColumns({
    product_id: g.gift_product_id,
    option_value_ids: g.gift_option_value_ids,
    color_id: g.gift_color_id,
    qty: g.gift_qty,
    sale_type: g.gift_sale_type,
    transport_method: g.gift_transport_method,
  });
}

export const selectionInput = (s: GiftSelection): GiftSelectionInput => ({
  productId: s.productId,
  saleType: s.saleType,
  optionValueIds: s.optionValueIds,
  colorId: s.colorId,
  transportMethod: s.transportMethod,
  qty: s.qty,
});

// ------------------------------------------------------ the admin projection

/**
 * WHAT AN ADMIN MAY PIN FOR THIS PRODUCT — the level-item editor and the
 * manual grant sheet: the sale types it really offers, its live groups and
 * values (each model's own order types and routes), its colours with their
 * option links, and the pre-order routes. Never a cost.
 */
export function giftOptionsProjection(p: GiftProductContext) {
  const row = p.row!;
  const doc = productDoc(p);
  const availability = saleAvailability(doc, {
    transportDefaults: p.ctx.transportDefaults,
    inventory: p.view
      ? snapshotFrom(p.view, {
          stock: doc.stock,
          reserved: Number(row.stock_reserved ?? 0),
          low_stock_threshold: (row.low_stock_threshold as number | null) ?? null,
        })
      : undefined,
    links: p.view?.links,
  });
  const fulfillments = p.view?.fulfillments ?? [];
  const transports = p.view?.transports ?? [];
  const label = (o: { name_ar?: string | null; name_en?: string | null; name_ckb?: string | null }) => {
    const en = text(o.name_en);
    const ar = text(o.name_ar) || en;
    return { name_en: en || ar, name_ar: ar, name_ckb: text(o.name_ckb) || ar };
  };
  const groups = (p.view?.groups ?? [])
    .filter((g) => isOn(g.active))
    .map((g) => ({
      id: g.id,
      name_en: text(g.name_en),
      values: (p.view?.values ?? [])
        .filter((v) => v.group_id === g.id && isOn(v.active))
        .map((v) => {
          const cells = fulfillments.filter((f) => f.option_id === v.id && isOn(f.enabled));
          return {
            id: v.id,
            ...label(v),
            stock: v.stock ?? null,
            /** This model's own order types ([] = it inherits the product's). */
            sale_types: cells.map((f) => f.fulfillment_type),
            routes: cells
              .filter((f) => f.fulfillment_type === 'pre_order')
              .flatMap((f) => transports.filter((t) => t.fulfillment_id === f.id && isOn(t.enabled)).map((t) => t.method)),
          };
        }),
    }));
  // A product without relational rows may still carry options in its legacy JSON.
  const legacyOptions =
    groups.length === 0
      ? doc.options.filter((o) => o.active).map((o) => ({ id: o.id, ...label(o), stock: o.stock ?? null, sale_types: [], routes: [] }))
      : [];
  const links = p.view?.links ?? [];
  const colors = (p.view?.colors?.length ? p.view.colors : [])
    .filter((c) => isOn(c.active))
    .map((c) => ({
      id: c.id,
      ...label(c),
      hex: text(c.hex),
      stock: c.stock ?? null,
      links: links.filter((l) => l.color_id === c.id).map((l) => ({ group_id: l.group_id, option_value_id: l.option_value_id })),
    }));
  const legacyColors =
    colors.length === 0 && !(p.view?.colors?.length)
      ? doc.colors.filter((c) => c.active).map((c) => ({ id: c.id, ...label(c), hex: c.hex, stock: c.stock ?? null, links: [] }))
      : [];
  return {
    product: {
      id: p.productId,
      slug: text(row.slug),
      ...productNames(row),
      image: productImageForSelection(doc, { optionValueIds: [], colorId: null }, p.view),
      status: text(row.status),
      composition: text(row.composition),
      price_iqd: Number(row.price_iqd) || 0,
    },
    giftable: text(row.status) === 'active' && text(row.composition) === '',
    sale_types: availability.modes.map((m) => m.type),
    groups: groups.length ? groups : legacyOptions.length ? [{ id: '', name_en: '', values: legacyOptions }] : [],
    colors: colors.length ? colors : legacyColors,
    transports: availability.preorder.transports.map((t) => t.method),
  };
}
