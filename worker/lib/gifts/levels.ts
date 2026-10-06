/**
 * THE FIVE GIFT LEVELS, AS REAL STORE PRODUCTS (docs/REVIEWS_GIFTS.md §Levels).
 * Owner: lane S2. Lane S3's cartLine.ts reuses `validateGiftSelection` for
 * the add-to-cart door and the checkout (requireSellable = true).
 *
 * A level item is a `gift_pool_items` row with `product_id` (0165 columns):
 * the product + sale type + admin pins (option values, colour, pre-order
 * route) + the subset the customer may pick for what is not pinned. Items of
 * one level are ALTERNATIVES: the customer picks ONE after redeeming. Bundles
 * and mystery offers cannot be gifts in v1 (GIFT_COMPOSITION_UNSUPPORTED).
 *
 * Validation is the store's own, never a copy: products row (status active,
 * composition ''), `loadRelationsViews` + `validateSelection`
 * (worker/lib/productRelations.ts: OPTION_VALUE_NOT_FOUND,
 * OPTION_VALUE_INACTIVE, OPTION_GROUP_DUPLICATE_SELECTION,
 * OPTION_GROUP_REQUIRED, COLOR_NOT_FOUND, COLOR_INACTIVE,
 * COLOR_OPTION_MISMATCH, COLOR_REQUIRED), `resolveCartLine`
 * (worker/routes/cart.ts) and `saleAvailability` / `unusableOrderType`
 * (worker/routes/products.ts) — a stated sale type is honoured or refused,
 * never swapped. The same three calls, in the same order, as
 * `POST /api/cart/items`.
 *
 * Loading is split from checking: `loadGiftProduct` reads the product once and
 * `checkGiftSelection` is pure, so the levels editor can try every selection an
 * item allows without a query per combination.
 */
import { safeParse } from '../types';
import { getSettings } from '../settings';
import { applyRelations, capacityFrom, loadRelationsViews, snapshotFrom, type ProductRelationsView } from '../productOverlay';
import { parseProductRow, type ProductDoc } from '../productModel';
import { canonicalOptionValueIds, optionValueIdsInRelationOrder } from '../cartSelectionIdentity';
import { productImageForSelection } from '../productSelectionImage';
import { pricingContextFrom, resolveCartLine, type PricingContext } from '../../routes/cart';
import { saleAvailability, unusableOrderType } from '../../routes/products';
import type { GiftChoiceColor, GiftChoiceOption, GiftSnapshotItem } from './entitlements';

export type GiftSaleType = 'direct_sale' | 'pre_order';
export type GiftTransport = '' | 'air' | 'sea' | 'land';
export const GIFT_TRANSPORTS: readonly GiftTransport[] = ['', 'air', 'sea', 'land'];

/** At most this many option values in one selection (the cart door's own cap). */
export const GIFT_MAX_OPTION_VALUES = 12;
/** A level item may list at most this many allowed values / colours. */
export const GIFT_MAX_ALLOWED = 60;
/** The editor stops trying complete selections after this many. */
const MAX_COMBINATIONS = 256;

export interface GiftSelectionInput {
  productId: string;
  saleType: GiftSaleType;
  /** The COMPLETE selection (pins ∪ customer picks), any order; canonicalised inside. */
  optionValueIds: string[];
  colorId: string;
  transportMethod: GiftTransport;
}

export type GiftSelectionCode =
  | 'GIFT_PRODUCT_NOT_FOUND'
  | 'GIFT_PRODUCT_INACTIVE'
  | 'GIFT_COMPOSITION_UNSUPPORTED'
  | 'GIFT_SALE_TYPE_UNAVAILABLE'
  | 'GIFT_TRANSPORT_REQUIRED'
  | 'GIFT_SELECTION_INVALID'
  | 'OUT_OF_STOCK';

export interface GiftSelectionDisplay {
  name_ar: string;
  name_en: string;
  name_ckb: string;
  image: string;
  variant_ar: string;
  variant_en: string;
  variant_ckb: string;
  color_name: string;
  color_hex: string;
  regular_iqd: number;
  /** S2 addition (optional): the colour's authored Arabic / Sorani names. */
  color_name_ar?: string;
  color_name_ckb?: string;
}

export type GiftSelectionResult =
  | {
      ok: true;
      canonical: { optionValueIds: string[]; primaryOptionId: string; colorId: string };
      /** The display block frozen into gift_snapshot at issue. */
      display: GiftSelectionDisplay;
    }
  | {
      ok: false;
      code: GiftSelectionCode;
      /** The store's own selection codes (validateSelection / resolver), for the admin form. */
      errors: string[];
    };

type SelectionFailure = Extract<GiftSelectionResult, { ok: false }>;
type SelectionSuccess = Extract<GiftSelectionResult, { ok: true }>;

const fail = (code: GiftSelectionCode, errors: string[]): SelectionFailure => ({
  ok: false,
  code,
  errors: [...new Set(errors.filter(Boolean))],
});

const text = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const isOn = (v: unknown): boolean => v !== 0 && v !== false && v !== '0';

// ------------------------------------------------------------- the product

/** Everything one product contributes to gift validation, read once. */
export interface GiftProductContext {
  productId: string;
  /** The `products` row in any status, or null when the id names nothing. */
  row: Record<string, unknown> | null;
  view: ProductRelationsView | undefined;
  /** Regular pricing only: a gift's value is the regular price, never a member's. */
  ctx: PricingContext;
}

export async function loadGiftProduct(env: { DB: D1Database }, productId: string): Promise<GiftProductContext> {
  const id = text(productId).slice(0, 80);
  const [row, settings] = await Promise.all([
    id
      ? env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(id).first<Record<string, unknown>>()
      : Promise.resolve(null),
    getSettings(env.DB, ['proPricingPolicy', 'preorderTransportDefaults']),
  ]);
  const ctx = pricingContextFrom(settings);
  if (!row) return { productId: id, row: null, view: undefined, ctx };
  const views = await loadRelationsViews(env.DB, [{ id, inventory_mode: row.inventory_mode }]);
  return { productId: id, row, view: views.get(id), ctx };
}

/** The product as the storefront reads it: the row with its relational options and colours applied. */
function productDoc(p: GiftProductContext): ProductDoc {
  const doc = parseProductRow(p.row!);
  return p.view ? applyRelations(doc, p.view) : doc;
}

/** The product-level gate shared by a selection and a level item. */
function productGate(p: GiftProductContext): SelectionFailure | null {
  if (!p.row) return fail('GIFT_PRODUCT_NOT_FOUND', ['PRODUCT_NOT_FOUND']);
  if (text(p.row.composition) !== '') return fail('GIFT_COMPOSITION_UNSUPPORTED', [text(p.row.composition).toUpperCase()]);
  if (text(p.row.status) !== 'active') return fail('GIFT_PRODUCT_INACTIVE', ['PRODUCT_INACTIVE']);
  return null;
}

/** Store codes that describe the SELECTION (wrong value, colour, pairing). */
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
 * ONE RULE for the levels editor, the manual gift, «choose item», the gift
 * cart door and the checkout. Pure: everything it reads is in `p`.
 * `requireSellable` adds today's facts (stock or capacity for ONE unit, the
 * sale type usable now); the admin editors pass false so an item can be
 * configured while out of stock.
 */
export function checkGiftSelection(
  p: GiftProductContext,
  input: GiftSelectionInput,
  opts: { requireSellable: boolean }
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

  const canonical = canonicalOptionValueIds(Array.isArray(input.optionValueIds) ? input.optionValueIds : []);
  if (canonical.length > GIFT_MAX_OPTION_VALUES) return fail('GIFT_SELECTION_INVALID', ['OPTION_GROUP_DUPLICATE_SELECTION']);
  const colorId = text(input.colorId);

  // The cart door's resolution, verbatim: the resolver prices and validates the
  // stated type and route; with relational rows, validateSelection judges the
  // colour/option algebra.
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
    qty: 1,
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
  //    to the chosen option, a group left empty.
  const selection = [
    ...selectionErrors,
    ...availability.selection.errors,
    ...resolved.errors.filter((e) => SELECTION_CODES.has(e)),
  ];
  if (selection.length) return fail('GIFT_SELECTION_INVALID', selection);

  // 2. The stated sale type must be one this product (this model) offers.
  if (resolved.errors.includes('TRANSPORT_REQUIRED')) return fail('GIFT_TRANSPORT_REQUIRED', ['TRANSPORT_REQUIRED']);
  const saleErrors = resolved.errors.filter((e) => SALE_TYPE_CODES.has(e));
  if (saleErrors.length) return fail('GIFT_SALE_TYPE_UNAVAILABLE', saleErrors);
  const mode = availability.modes.find((m) => m.type === saleType);
  if (!mode) return fail('GIFT_SALE_TYPE_UNAVAILABLE', [saleType === 'pre_order' ? 'PREORDER_NOT_ENABLED' : 'DIRECT_SALE_NOT_ENABLED']);
  if (saleType === 'pre_order' && !availability.preorder.transports.some((t) => t.method === transport)) {
    return fail('GIFT_SALE_TYPE_UNAVAILABLE', ['TRANSPORT_NOT_OFFERED']);
  }
  const otherErrors = resolved.errors.filter((e) => !SELECTION_CODES.has(e) && !SALE_TYPE_CODES.has(e));
  if (otherErrors.length) return fail('GIFT_SELECTION_INVALID', otherErrors);

  // 3. Today's facts, only where a unit is about to be sold.
  if (opts.requireSellable) {
    const refusal = unusableOrderType(availability, saleType);
    if (refusal) return fail(STOCK_CODES.has(refusal.code) ? 'OUT_OF_STOCK' : 'GIFT_SALE_TYPE_UNAVAILABLE', [refusal.code]);
    if (saleType === 'pre_order') {
      const route = availability.preorder.routes.find((r) => r.method === transport);
      if (!route?.usable) {
        const why = route?.reason ?? 'TRANSPORT_NOT_OFFERED';
        return fail(STOCK_CODES.has(why) ? 'OUT_OF_STOCK' : 'GIFT_SALE_TYPE_UNAVAILABLE', [why]);
      }
    }
    if (availability.mode === 'unavailable') {
      const why = availability.reason ?? 'UNAVAILABLE';
      return fail(STOCK_CODES.has(why) ? 'OUT_OF_STOCK' : 'GIFT_SALE_TYPE_UNAVAILABLE', [why]);
    }
    if (!availability.qty_ok) return fail('OUT_OF_STOCK', ['QTY_UNAVAILABLE']);
  }

  return {
    ok: true,
    canonical: { optionValueIds: canonical, primaryOptionId: canonical[0] ?? '', colorId },
    display: displayFor(p, doc, canonical, colorId, Number(resolved.regular_iqd) || 0),
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

interface Labelled {
  id: string;
  name_en: string;
  name_ar: string;
  name_ckb: string;
}

/** Every option value of the product with its authored names (relational rows first). */
function optionLabels(p: GiftProductContext, doc?: { options?: Array<Record<string, unknown>> }): Map<string, Labelled & { group_id: string }> {
  const out = new Map<string, Labelled & { group_id: string }>();
  for (const v of p.view?.values ?? []) {
    const en = text(v.name_en);
    const ar = text(v.name_ar) || en;
    out.set(v.id, { id: v.id, name_en: en || ar, name_ar: ar, name_ckb: text(v.name_ckb) || ar, group_id: v.group_id });
  }
  for (const o of doc?.options ?? []) {
    const id = text(o.id);
    if (!id || out.has(id)) continue;
    const en = text(o.name_en);
    const ar = text(o.name_ar) || en;
    out.set(id, { id, name_en: en || ar, name_ar: ar, name_ckb: text(o.name_ckb) || ar, group_id: '' });
  }
  return out;
}

function colorLabels(p: GiftProductContext, doc?: { colors?: Array<Record<string, unknown>> }): Map<string, Labelled & { hex: string }> {
  const out = new Map<string, Labelled & { hex: string }>();
  for (const c of p.view?.colors ?? []) {
    const en = text(c.name_en);
    const ar = text(c.name_ar) || en;
    out.set(c.id, { id: c.id, name_en: en || ar, name_ar: ar, name_ckb: text(c.name_ckb) || ar, hex: text(c.hex) });
  }
  for (const c of doc?.colors ?? []) {
    const id = text(c.id);
    if (!id || out.has(id)) continue;
    const en = text(c.name_en);
    const ar = text(c.name_ar) || en;
    out.set(id, { id, name_en: en || ar, name_ar: ar, name_ckb: text(c.name_ckb) || ar, hex: text(c.hex) });
  }
  return out;
}

function productNames(row: Record<string, unknown>) {
  const en = text(row.name);
  const ar = text(row.name_ar) || en;
  return { name_en: en || ar, name_ar: ar, name_ckb: text(row.name_ku) || ar };
}

function displayFor(
  p: GiftProductContext,
  doc: { options?: unknown; colors?: unknown },
  optionValueIds: string[],
  colorId: string,
  regularIqd: number
): GiftSelectionDisplay {
  const row = p.row!;
  const docLike = doc as { options?: Array<Record<string, unknown>>; colors?: Array<Record<string, unknown>> };
  const opt = optionLabels(p, docLike);
  const col = colorLabels(p, docLike);
  const ordered = optionValueIdsInRelationOrder(optionValueIds, p.view);
  const labels = ordered.map((id) => opt.get(id)).filter((x): x is NonNullable<typeof x> => !!x);
  const color = colorId ? col.get(colorId) ?? null : null;
  const image = productImageForSelection(
    doc as Parameters<typeof productImageForSelection>[0],
    { optionValueIds: ordered, colorId: colorId || null },
    p.view
  );
  return {
    ...productNames(row),
    image,
    variant_ar: labels.map((l) => l.name_ar).join(' / '),
    variant_en: labels.map((l) => l.name_en).join(' / '),
    variant_ckb: labels.map((l) => l.name_ckb).join(' / '),
    color_name: color ? color.name_en : '',
    color_hex: color ? color.hex : '',
    regular_iqd: regularIqd,
    color_name_ar: color ? color.name_ar : '',
    color_name_ckb: color ? color.name_ckb : '',
  };
}

// --------------------------------------------------------------- level items

/** A level item as the admin saves it (POST/PUT /api/reviews/admin/pools). */
export interface LevelItemInput {
  level: number;
  productId: string;
  saleType: GiftSaleType;
  optionValueIds: string[];
  colorId: string;
  transportMethod: GiftTransport;
  allowedOptionValueIds: string[];
  allowedColorIds: string[];
  active: boolean;
  sort?: number;
}

export type LevelItemCode = GiftSelectionCode | 'GIFT_ITEM_CHOICES_INVALID';

export type LevelItemVerdict =
  | {
      ok: true;
      /** Every complete selection the item allows that the store accepts (capped). */
      selections: Array<{ optionValueIds: string[]; colorId: string; result: SelectionSuccess }>;
    }
  | { ok: false; code: LevelItemCode; errors: string[] };

/**
 * A level item is valid when every active option group is either pinned or
 * has at least one allowed value of THAT group, the colour is pinned or has
 * an allowed list (when the product has visible colours), no allowed id
 * belongs to another product, every allowed id takes part in at least one
 * complete selection the store accepts, and at least one complete selection
 * built from pins + allowed values passes `checkGiftSelection(requireSellable:false)`.
 */
export function checkLevelItem(p: GiftProductContext, input: LevelItemInput): LevelItemVerdict {
  const gate = productGate(p);
  if (gate) return gate;
  const choices = (errors: string[]) => ({ ok: false as const, code: 'GIFT_ITEM_CHOICES_INVALID' as const, errors: [...new Set(errors)] });

  const values = new Map((p.view?.values ?? []).map((v) => [v.id, v] as const));
  const colors = new Map((p.view?.colors ?? []).map((c) => [c.id, c] as const));
  const groups = (p.view?.groups ?? []).filter((g) => isOn(g.active));
  const pins = canonicalOptionValueIds(input.optionValueIds ?? []);
  const allowed = canonicalOptionValueIds(input.allowedOptionValueIds ?? []);
  const allowedColors = canonicalOptionValueIds(input.allowedColorIds ?? []);
  const pinColor = text(input.colorId);
  if (pins.length > GIFT_MAX_OPTION_VALUES || allowed.length > GIFT_MAX_ALLOWED || allowedColors.length > GIFT_MAX_ALLOWED) {
    return choices(['TOO_MANY_CHOICES']);
  }

  // Pins: real, live values of THIS product, one per group.
  const pinnedGroups = new Set<string>();
  for (const id of pins) {
    const v = values.get(id);
    if (!v) return fail('GIFT_SELECTION_INVALID', ['OPTION_VALUE_NOT_FOUND']);
    if (!isOn(v.active)) return fail('GIFT_SELECTION_INVALID', ['OPTION_VALUE_INACTIVE']);
    if (pinnedGroups.has(v.group_id)) return fail('GIFT_SELECTION_INVALID', ['OPTION_GROUP_DUPLICATE_SELECTION']);
    pinnedGroups.add(v.group_id);
  }
  // Allowed values: of THIS product, live, and never in a pinned group — a pin
  // is never overridable by the customer.
  const allowedByGroup = new Map<string, string[]>();
  for (const id of allowed) {
    const v = values.get(id);
    if (!v) return choices(['OPTION_VALUE_NOT_FOUND']);
    if (!isOn(v.active)) return choices(['OPTION_VALUE_INACTIVE']);
    if (pinnedGroups.has(v.group_id)) return choices(['OPTION_GROUP_PINNED']);
    allowedByGroup.set(v.group_id, [...(allowedByGroup.get(v.group_id) ?? []), id]);
  }
  // Every live group with a live value is decided: pinned, or the customer has
  // at least one value to pick from.
  for (const g of groups) {
    const hasLive = (p.view?.values ?? []).some((v) => v.group_id === g.id && isOn(v.active));
    if (hasLive && !pinnedGroups.has(g.id) && !allowedByGroup.has(g.id)) return choices(['OPTION_GROUP_REQUIRED']);
  }
  // Colours: pinned XOR an allowed list, each of THIS product and live.
  if (pinColor && allowedColors.length) return choices(['COLOR_PINNED']);
  if (pinColor) {
    const c = colors.get(pinColor);
    if (!c) return fail('GIFT_SELECTION_INVALID', ['COLOR_NOT_FOUND']);
    if (!isOn(c.active)) return fail('GIFT_SELECTION_INVALID', ['COLOR_INACTIVE']);
  }
  for (const id of allowedColors) {
    const c = colors.get(id);
    if (!c) return choices(['COLOR_NOT_FOUND']);
    if (!isOn(c.active)) return choices(['COLOR_INACTIVE']);
  }

  // Try every complete selection the item allows, the way the store would.
  const groupLists = [...allowedByGroup.values()];
  const colorList = pinColor ? [pinColor] : allowedColors.length ? allowedColors : [''];
  const selections: Array<{ optionValueIds: string[]; colorId: string; result: SelectionSuccess }> = [];
  const usedValues = new Set<string>();
  const usedColors = new Set<string>();
  let firstFailure: SelectionFailure | null = null;
  const failureFor = new Map<string, string[]>();
  let tried = 0;
  const walk = (i: number, picked: string[]) => {
    if (tried >= MAX_COMBINATIONS) return;
    if (i < groupLists.length) {
      for (const id of groupLists[i]) walk(i + 1, [...picked, id]);
      return;
    }
    for (const colorId of colorList) {
      if (tried >= MAX_COMBINATIONS) return;
      tried++;
      const ids = canonicalOptionValueIds([...pins, ...picked]);
      const r = checkGiftSelection(
        p,
        { productId: p.productId, saleType: input.saleType, optionValueIds: ids, colorId, transportMethod: input.transportMethod },
        { requireSellable: false }
      );
      if (r.ok) {
        selections.push({ optionValueIds: ids, colorId, result: r });
        for (const id of picked) usedValues.add(id);
        if (colorId) usedColors.add(colorId);
      } else {
        firstFailure ??= r;
        for (const id of [...picked, colorId].filter(Boolean)) failureFor.set(id, failureFor.get(id) ?? r.errors);
      }
    }
  };
  walk(0, []);

  if (selections.length === 0) {
    const f = firstFailure as SelectionFailure | null;
    return f ? { ok: false, code: f.code, errors: f.errors } : fail('GIFT_SELECTION_INVALID', ['NO_SELECTION']);
  }
  // An allowed value the customer could pick but the store would refuse in
  // every combination (a colour linked to no allowed option) is refused here,
  // at save time, rather than in front of the customer.
  if (tried < MAX_COMBINATIONS) {
    const dead = [...allowed.filter((id) => !usedValues.has(id)), ...allowedColors.filter((id) => !usedColors.has(id))];
    if (dead.length) return choices(dead.flatMap((id) => failureFor.get(id) ?? ['CHOICE_NEVER_VALID']));
  }
  return { ok: true, selections };
}

export async function validateLevelItem(
  env: { DB: D1Database },
  input: LevelItemInput
): Promise<{ ok: true } | { ok: false; code: LevelItemCode; errors: string[] }> {
  const verdict = checkLevelItem(await loadGiftProduct(env, input.productId), input);
  return verdict.ok ? { ok: true } : verdict;
}

/** A `gift_pool_items` row in the editor's input shape (product rows only). */
export function levelItemInputFromRow(row: Record<string, unknown>): LevelItemInput {
  const ids = (v: unknown) => canonicalOptionValueIds(safeParse<unknown[]>(text(v) || '[]', []));
  const sale = text(row.sale_type);
  const transport = text(row.transport_method);
  return {
    level: Number(row.level),
    productId: text(row.product_id),
    saleType: sale === 'pre_order' ? 'pre_order' : 'direct_sale',
    optionValueIds: ids(row.option_value_ids),
    colorId: text(row.color_id),
    transportMethod: (GIFT_TRANSPORTS.includes(transport as GiftTransport) ? transport : '') as GiftTransport,
    allowedOptionValueIds: ids(row.allowed_option_value_ids),
    allowedColorIds: ids(row.allowed_color_ids),
    active: isOn(row.active),
    sort: Number(row.sort) || 0,
  };
}

// ------------------------------------------------------------- the snapshot

/** Labels of the pins and of every value the customer may pick, frozen at issue. */
function choiceLabels(p: GiftProductContext, pins: string[], allowed: string[], pinColor: string, allowedColors: string[]) {
  const opt = optionLabels(p);
  const col = colorLabels(p);
  const groupName = new Map((p.view?.groups ?? []).map((g) => [g.id, text(g.name_en)] as const));
  const options: GiftChoiceOption[] = [];
  for (const [ids, pinned] of [[pins, true], [allowed, false]] as const) {
    for (const id of optionValueIdsInRelationOrder(ids, p.view)) {
      const l = opt.get(id);
      if (!l) continue;
      options.push({ id, group_id: l.group_id, group_name: groupName.get(l.group_id) ?? '', name_ar: l.name_ar, name_en: l.name_en, name_ckb: l.name_ckb, pinned });
    }
  }
  const links = p.view?.links ?? [];
  const colorsOut: GiftChoiceColor[] = [];
  for (const [ids, pinned] of [[pinColor ? [pinColor] : [], true], [allowedColors, false]] as const) {
    for (const id of ids) {
      const l = col.get(id);
      if (!l) continue;
      colorsOut.push({
        id,
        name_ar: l.name_ar,
        name_en: l.name_en,
        name_ckb: l.name_ckb,
        hex: l.hex,
        pinned,
        links: links.filter((k) => k.color_id === id).map((k) => ({ group_id: k.group_id, option_value_id: k.option_value_id })),
      });
    }
  }
  return { options, colors: colorsOut };
}

/**
 * One level item frozen for a granted gift, or the refusal that keeps it out.
 * The display is the pins' own (the customer's picks are labelled in
 * `choices`); `regular_iqd` is the lowest regular price any allowed selection
 * has, so the card never overstates the gift.
 */
export function snapshotItemFor(
  p: GiftProductContext,
  ref: string,
  poolItemId: string | null,
  item: LevelItemInput
): { ok: true; item: GiftSnapshotItem } | { ok: false; code: LevelItemCode; errors: string[] } {
  const verdict = checkLevelItem(p, item);
  if (!verdict.ok) return verdict;
  const pins = canonicalOptionValueIds(item.optionValueIds);
  const allowed = canonicalOptionValueIds(item.allowedOptionValueIds);
  const allowedColors = canonicalOptionValueIds(item.allowedColorIds);
  const fixed = allowed.length === 0 && allowedColors.length === 0;
  const first = verdict.selections[0].result;
  const base = fixed ? first.display : pinsDisplay(p, pins, item.colorId, first.display);
  const lowest = Math.min(...verdict.selections.map((s) => s.result.display.regular_iqd));
  return {
    ok: true,
    item: {
      ref,
      pool_item_id: poolItemId,
      product_id: p.productId,
      sale_type: item.saleType,
      option_value_ids: fixed ? first.canonical.optionValueIds : pins,
      color_id: fixed ? first.canonical.colorId : item.colorId,
      transport_method: item.transportMethod,
      allowed_option_value_ids: allowed,
      allowed_color_ids: allowedColors,
      display: { ...base, regular_iqd: Number.isFinite(lowest) ? lowest : base.regular_iqd },
      choices: choiceLabels(p, pins, allowed, item.colorId, allowedColors),
    },
  };
}

function pinsDisplay(p: GiftProductContext, pins: string[], colorId: string, any: GiftSelectionDisplay): GiftSelectionDisplay {
  const opt = optionLabels(p);
  const col = colorLabels(p);
  const labels = optionValueIdsInRelationOrder(pins, p.view).map((id) => opt.get(id)).filter((x): x is NonNullable<typeof x> => !!x);
  const color = colorId ? col.get(colorId) ?? null : null;
  const image = productImageForSelection(productDoc(p), { optionValueIds: pins, colorId: colorId || null }, p.view) || any.image;
  return {
    ...any,
    image,
    variant_ar: labels.map((l) => l.name_ar).join(' / '),
    variant_en: labels.map((l) => l.name_en).join(' / '),
    variant_ckb: labels.map((l) => l.name_ckb).join(' / '),
    color_name: color ? color.name_en : '',
    color_hex: color ? color.hex : '',
    color_name_ar: color ? color.name_ar : '',
    color_name_ckb: color ? color.name_ckb : '',
  };
}

/** The manual gift: ONE product, fully pinned, nothing left for the customer to pick. */
export function manualSnapshotItem(
  p: GiftProductContext,
  input: GiftSelectionInput
): { ok: true; item: GiftSnapshotItem } | { ok: false; code: GiftSelectionCode; errors: string[] } {
  const r = checkGiftSelection(p, input, { requireSellable: false });
  if (!r.ok) return r;
  return {
    ok: true,
    item: {
      ref: 'manual',
      pool_item_id: null,
      product_id: p.productId,
      sale_type: input.saleType,
      option_value_ids: r.canonical.optionValueIds,
      color_id: r.canonical.colorId,
      transport_method: input.transportMethod,
      allowed_option_value_ids: [],
      allowed_color_ids: [],
      display: r.display,
      choices: choiceLabels(p, r.canonical.optionValueIds, [], r.canonical.colorId, []),
    },
  };
}

// ------------------------------------------------------ the admin projection

/**
 * GET /api/reviews/admin/gift-options/:productId — what an admin may pick for
 * this product: the sale types it really offers, its live groups and values
 * (with each model's own order types and routes), its colours with their
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
  const opt = optionLabels(p, doc as unknown as { options?: Array<Record<string, unknown>> });
  const col = colorLabels(p, doc as unknown as { colors?: Array<Record<string, unknown>> });
  const fulfillments = p.view?.fulfillments ?? [];
  const transports = p.view?.transports ?? [];
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
            ...opt.get(v.id)!,
            /** This model's own order types and routes ([] = inherits the product's). */
            sale_types: cells.map((f) => f.fulfillment_type),
            routes: cells
              .filter((f) => f.fulfillment_type === 'pre_order')
              .flatMap((f) => transports.filter((t) => t.fulfillment_id === f.id && isOn(t.enabled)).map((t) => t.method)),
          };
        }),
    }));
  const links = p.view?.links ?? [];
  const colors = (p.view?.colors ?? [])
    .filter((c) => isOn(c.active))
    .map((c) => ({
      ...col.get(c.id)!,
      links: links.filter((l) => l.color_id === c.id).map((l) => ({ group_id: l.group_id, option_value_id: l.option_value_id })),
    }));
  return {
    product: { id: p.productId, ...productNames(row), image: productImageForSelection(doc, { optionValueIds: [], colorId: null }, p.view), status: text(row.status), composition: text(row.composition) },
    giftable: text(row.status) === 'active' && text(row.composition) === '',
    sale_types: availability.modes.map((m) => m.type),
    modes: availability.modes,
    groups,
    colors,
    transports: availability.preorder.transports.map((t) => t.method),
  };
}
