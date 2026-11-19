/**
 * THE OWNER'S FILAMENT KITS AND PRINTER ADD-ONS (brief §H; owner rulings
 * 2026-11-17, DECISIONS row 339 phase 2; 2026-11-18, row 355 phase 4).
 *
 * A kit is made by the owner in the printer-services list from REAL products
 * and variants (`kits[]`); the customer picks one for a printer, or skips. An
 * add-on (`addons[]`, phase 4) is one product the customer ticks with a printer.
 *
 *   · Its price is the sum of the LIVE PRICES of its items — each judged and
 *     priced by the cart's own door (`judgeLevonisLine`, `resolveCartLine`),
 *     for this customer, exactly as if the item were added alone — less the
 *     owner's printer discount (phase 4, `unitDiscount`: percent of each unit,
 *     or a fixed amount per printer unit split over its units, capped at 90%).
 *   · One kit per printer unit: each item's quantity is its per-unit count ×
 *     the printer's quantity, and follows the printer (0235 triggers). Add-ons
 *     follow it the same way.
 *   · A kit item / add-on whose colour the CUSTOMER picks (phase 4): any active
 *     colour that can be sold for that quantity, or «random» — the system
 *     picks the cheapest available colour, then the most free stock, then the
 *     colour order, then the id (`pickRandomColour`). A chosen colour is never
 *     swapped: sold out is refused (KIT_COLOR_UNAVAILABLE).
 *   · Unavailable when ANY item is: not for sale, not priced, an incomplete
 *     selection, short of stock for that quantity, or unable to ship on the
 *     printer's own shipping type and route (a pre-order printer's kit must be
 *     pre-orderable on that route; a direct printer's must be on the shelf).
 *   · Its items are ordinary cart lines, so the checkout prices and RESERVES
 *     them like any line; they are linked to the printer line
 *     (cart_items.kit_parent_id → order_items.kit_parent_item_id).
 */
import type { Context } from 'hono';
import type { AppContext } from './types';
import { HttpError } from './http';
import {
  addonsForPrinter, colorModeOf, kitsForPrinter, kitItemKey, unitDiscount, KIT_NOT_OFFERED, KIT_UNAVAILABLE,
  type FilamentKit, type KitColorMode, type PrinterAddon, type PrinterDiscount, type PrinterServicesConfig,
} from '@levonis/pricing/printerServices';
import { isComposition, judgeLevonisLine, loadAddContext, loadAddProduct, type AddContext, type AddLine, type AddShared, type JudgedLine } from './cartAdd';
import { cartPricing, resolveCartLine } from '../routes/cart';
import { productImageForSelection } from './productSelectionImage';
import { addonPreorderSeparate, addonUnavailable, kitColourUnavailable, kitUnitsPerPrinter, pickRandomColour, type ColourCandidate, type LineColourMode } from './printerOffers';
import { ADDON_PREORDER_SEPARATE } from '@levonis/pricing/printerServices';

/** The cart-line discriminator of a kit line: never merges with the same filament bought alone. */
export const KIT_LINE_PREFIX = 'kit:';
export const kitLineDiscriminator = (printerCartItemId: string) => `${KIT_LINE_PREFIX}${printerCartItemId}`;

/** A customer's colour for one customer-colour item: a colour id, or «random» (the system picks). */
export const RANDOM_COLOUR = 'random';
/** productId (kit item) or addonId (add-on) → colour id | 'random'. Missing = random. */
export type ColourWishes = Record<string, string>;

/** The printer the kit is for, as its cart line (or the page's selection) states it. */
export interface KitPrinter {
  productId: string;
  optionValueIds: string[];
  fulfillmentType: string;
  transportMethod: string;
  qty: number;
}

/** One product (or exact variant) attached to a printer: a kit item or an add-on, per printer unit. */
export interface AttachedSpec {
  product_id: string;
  option_value_ids: string[];
  color_id: string | null;
  color_mode?: KitColorMode;
  qty: number;
}

/** One colour of a customer-colour item, judged for this quantity, type and route. */
export interface ResolvedColour {
  id: string;
  name: string;
  name_ar: string;
  name_ku: string;
  hex: string;
  sort: number;
  ok: boolean;
  reason: string | null;
  /** Unit price before the printer discount (unit subtotal; null when not sellable). */
  unit_iqd: number | null;
  /** The goods part the discount reads (applied price). */
  applied_iqd: number | null;
  free: number;
  judged: JudgedLine | null;
}

export interface ResolvedKitItem {
  item: AttachedSpec;
  ok: boolean;
  /** The refusal code of the item's own door when it cannot be sold now (or NO_COLOUR_IN_STOCK / KIT_COLOR_UNAVAILABLE). */
  reason: string | null;
  product: Record<string, unknown> | null;
  actx: AddContext | null;
  judged: JudgedLine | null;
  line: AddLine;
  shared: AddShared;
  /** This customer's live unit price BEFORE the printer discount (null when unavailable). */
  unit_iqd: number | null;
  applied_iqd: number | null;
  /** The printer discount per unit (0 when none). */
  discount_unit_iqd: number;
  /** What one unit is charged: unit_iqd − discount_unit_iqd. */
  after_unit_iqd: number | null;
  /** The owner's discount terms this item is priced under (null = none). */
  discount_terms: { discount: PrinterDiscount; units: number } | null;
  color_mode: KitColorMode;
  /** Who picked the line's colour: the owner (fixed), the customer (chosen) or the system (random). */
  chosen: LineColourMode;
  /** Customer-colour items: every active colour, judged; null otherwise. */
  colors: ResolvedColour[] | null;
  /** Customer-colour items: the system's pick now (null when none can be sold). */
  random_pick: ResolvedColour | null;
  /** A chosen colour that cannot be sold: which, and why. */
  colour_refusal: { color_id: string; reason: string } | null;
  name: string;
  name_ar: string;
  slug: string;
  variant: string;
  image: string;
  /** Phase 6: the promised lead days of the line as priced (the resolver's own answer); nulls when it states none. */
  lead_days?: { min: number | null; max: number | null };
}

export interface ResolvedKit {
  kit: FilamentKit;
  items: ResolvedKitItem[];
  available: boolean;
  /** Per printer unit, AFTER the discount: Σ item after-unit × per-unit qty (null when any item is unavailable). */
  price_per_printer_iqd: number | null;
  before_per_printer_iqd: number | null;
  discount_per_printer_iqd: number;
  /** For the printer's quantity. */
  total_iqd: number | null;
  before_total_iqd: number | null;
  discount_total_iqd: number;
}

export interface ResolvedAddon {
  addon: PrinterAddon;
  resolved: ResolvedKitItem;
  available: boolean;
  price_per_printer_iqd: number | null;
  before_per_printer_iqd: number | null;
  total_iqd: number | null;
  before_total_iqd: number | null;
  discount_total_iqd: number;
  /**
   * Phase 6: how the add-on can be bought. 'with_printer' = on the printer's own order type and route
   * (the only way it is ever a line of the printer's order). 'pre_order' = it cannot go with this
   * printer, but its product is sold by pre-order on `transport`: ordered separately
   * (`available` false, reason ADDON_PREORDER_SEPARATE), with the pre-order's own figures in `preorder`.
   */
  fulfillment: 'with_printer' | 'pre_order';
  transport: string | null;
  lead_days: { min: number | null; max: number | null };
  /** The pre-order as the part's own page sells it (informational; the engine's own unit price, the owner's discount NOT applied). */
  preorder: { transport: string; unit_price_iqd: number; lead_days: { min: number | null; max: number | null } } | null;
  /** Why it cannot go with the printer, when `fulfillment` is 'pre_order' (the with-printer door's own code). */
  with_printer_reason: string | null;
}

/** The kit, when the published list offers it with this printer selection; else null. */
export function offeredKit(config: PrinterServicesConfig | null, printer: Pick<KitPrinter, 'productId' | 'optionValueIds'>, kitId: string): FilamentKit | null {
  if (!config) return null;
  return kitsForPrinter(config, printer.productId, printer.optionValueIds).find((k) => k.id === kitId) ?? null;
}

/** The add-on, when the published list offers it with this printer selection; else null. */
export function offeredAddon(config: PrinterServicesConfig | null, printer: Pick<KitPrinter, 'productId' | 'optionValueIds'>, addonId: string): PrinterAddon | null {
  if (!config) return null;
  return addonsForPrinter(config, printer.productId, printer.optionValueIds).find((a) => a.id === addonId) ?? null;
}

/** The viewer's pricing context, loaded once per request and shared by every kit item (review S15). */
export type KitPricing = ReturnType<typeof cartPricing>;
export const kitPricing = (c: Context<AppContext>): KitPricing => {
  const pricing = cartPricing(c);
  pricing.catch(() => undefined); // awaited by the first item that needs it; never an unhandled rejection
  return pricing;
};

const cssHex = (v: unknown): string => (typeof v === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v.trim()) ? v.trim() : '');

/** Free units on the counter a judged line consumes (Infinity = untracked). */
function freeUnits(j: JudgedLine): number {
  const a = j.lineType === 'pre_order' ? j.availability.preorder.capacity.available : j.availability.stock.available;
  return typeof a === 'number' && Number.isFinite(a) ? a : Number.POSITIVE_INFINITY;
}

/**
 * Judges and prices ONE attached item (a kit item or an add-on) for this
 * customer and printer: its colour (fixed, chosen, or random), its live unit
 * price and the owner's discount on it.
 */
async function resolveAttachedItem(
  c: Context<AppContext>,
  spec: AttachedSpec,
  printer: KitPrinter,
  pricing: KitPricing,
  wish: string | undefined,
  discount: PrinterDiscount | null | undefined,
  unitsPerPrinter: number,
  /** The product row and its add context when a caller already loaded them for this request (the pre-order lookup): no second read. */
  loaded?: { product: Record<string, unknown>; actx: AddContext }
): Promise<ResolvedKitItem> {
  const units = Math.max(1, Math.trunc(printer.qty) || 1);
  const shared: AddShared = { transportMethod: printer.transportMethod, fulfillmentType: printer.fulfillmentType, warrantyPlanId: '', services: '' };
  const mode = colorModeOf(spec);
  const line: AddLine = { optionValueIds: [...spec.option_value_ids], colorId: mode === 'fixed' ? spec.color_id ?? '' : '', qty: Math.min(9999, spec.qty * units) };
  const base: ResolvedKitItem = {
    item: spec, ok: false, reason: null, product: null, actx: null, judged: null, line, shared,
    unit_iqd: null, applied_iqd: null, discount_unit_iqd: 0, after_unit_iqd: null,
    discount_terms: discount ? { discount, units: unitsPerPrinter } : null,
    color_mode: mode, chosen: mode === 'fixed' ? 'fixed' : 'random', colors: null, random_pick: null, colour_refusal: null,
    name: '', name_ar: '', slug: '', variant: '', image: '',
  };
  let product: Record<string, unknown>;
  try {
    product = loaded ? loaded.product : await loadAddProduct(c, spec.product_id);
  } catch (e) {
    return { ...base, reason: e instanceof HttpError ? e.code ?? 'UNAVAILABLE' : 'UNAVAILABLE' };
  }
  const named = { ...base, product, name: String(product.name ?? ''), name_ar: String(product.name_ar ?? ''), slug: String(product.slug ?? '') };
  if (isComposition(product)) return { ...named, reason: 'KIT_ITEM_COMPOSITION' };
  let actx: AddContext;
  try {
    actx = loaded ? loaded.actx : await loadAddContext(c, product, { warrantyPlanId: '', pricing });
  } catch (e) {
    return { ...named, reason: e instanceof HttpError ? e.code ?? 'UNAVAILABLE' : 'UNAVAILABLE' };
  }
  const price = (colorId: string) => resolveCartLine(
    product,
    { optionId: line.optionValueIds[0] ?? '', optionValueIds: line.optionValueIds, colorId, transportMethod: shared.transportMethod, fulfillmentType: shared.fulfillmentType, warrantyPlanId: '' },
    actx.tier, actx.tierActive, actx.ctx, actx.view, 'prepaid', actx.isPrinter, actx.offer
  );
  const finish = (it: ResolvedKitItem, judged: JudgedLine, colorId: string): ResolvedKitItem => {
    const { doc, resolved, variantLabel } = price(colorId);
    const off = unitDiscount(discount ?? null, resolved.applied_iqd, unitsPerPrinter);
    return {
      ...it, actx, judged, ok: true, reason: null,
      line: { ...line, colorId },
      unit_iqd: resolved.unit_subtotal_iqd,
      applied_iqd: resolved.applied_iqd,
      discount_unit_iqd: off,
      after_unit_iqd: resolved.unit_subtotal_iqd - off,
      variant: variantLabel,
      image: productImageForSelection(doc, { optionValueIds: line.optionValueIds, colorId: colorId || null }, actx.view),
      lead_days: { min: resolved.fulfillment?.lead_time_min_days ?? null, max: resolved.fulfillment?.lead_time_max_days ?? null },
    };
  };

  if (mode === 'fixed') {
    const verdict = judgeLevonisLine(actx, line, shared);
    if (!verdict.ok) return { ...named, actx, reason: verdict.error.code ?? 'UNAVAILABLE' };
    return finish(named, verdict.judged, line.colorId);
  }

  // A CUSTOMER-COLOUR ITEM: every active colour this selection may take, judged for this quantity.
  const { doc } = price('');
  const colours: ResolvedColour[] = [];
  for (const col of doc.colors) {
    if (!col.active || (col.option_id && !line.optionValueIds.includes(col.option_id))) continue;
    const verdict = judgeLevonisLine(actx, { ...line, colorId: col.id }, shared);
    const named3 = { id: col.id, name: col.name_en || col.name_ar || col.id, name_ar: col.name_ar || col.name_en || '', name_ku: col.name_ckb || col.name_ar || '', hex: cssHex(col.hex), sort: Number(col.order) || 0 };
    if (!verdict.ok) {
      colours.push({ ...named3, ok: false, reason: verdict.error.code ?? 'UNAVAILABLE', unit_iqd: null, applied_iqd: null, free: 0, judged: null });
      continue;
    }
    const p = price(col.id);
    colours.push({ ...named3, ok: true, reason: null, unit_iqd: p.resolved.unit_subtotal_iqd, applied_iqd: p.resolved.applied_iqd, free: freeUnits(verdict.judged), judged: verdict.judged });
  }
  const sellable = colours.filter((x) => x.ok);
  const pickId = pickRandomColour(sellable.map((x): ColourCandidate => ({ id: x.id, unit_iqd: x.unit_iqd as number, free: x.free, sort: x.sort })));
  const pick = sellable.find((x) => x.id === pickId) ?? null;
  const withColours: ResolvedKitItem = { ...named, actx, colors: colours, random_pick: pick };
  if (wish && wish !== RANDOM_COLOUR) {
    const chosen = colours.find((x) => x.id === wish);
    if (!chosen || !chosen.ok) {
      const why = !chosen ? 'NOT_A_COLOUR' : chosen.reason === 'OUT_OF_STOCK' || chosen.reason === 'PREORDER_CAPACITY_EXHAUSTED' ? 'SOLD_OUT' : chosen.reason ?? 'UNAVAILABLE';
      return { ...withColours, chosen: 'chosen', line: { ...line, colorId: wish }, reason: 'KIT_COLOR_UNAVAILABLE', colour_refusal: { color_id: wish, reason: why } };
    }
    return finish({ ...withColours, chosen: 'chosen' }, chosen.judged!, chosen.id);
  }
  if (!pick) return { ...withColours, chosen: 'random', reason: 'NO_COLOUR_IN_STOCK' };
  return finish({ ...withColours, chosen: 'random' }, pick.judged!, pick.id);
}

/**
 * Judges and prices every item of one kit for this customer and printer. The
 * printer's `fulfillmentType` is the type its row RESOLVES to (the caller's
 * job, review S11); `pricing` is the request's one pricing context. `colours`
 * names the customer's colour per customer-colour item (by product id;
 * missing = random).
 */
export async function resolveKit(c: Context<AppContext>, kit: FilamentKit, printer: KitPrinter, pricing: KitPricing = kitPricing(c), colours: ColourWishes = {}): Promise<ResolvedKit> {
  const units = Math.max(1, Math.trunc(printer.qty) || 1);
  const perPrinterUnits = kitUnitsPerPrinter(kit.items);
  const items: ResolvedKitItem[] = [];
  for (const item of kit.items) {
    items.push(await resolveAttachedItem(c, item, printer, pricing, colorModeOf(item) === 'customer' ? colours[item.product_id] : undefined, kit.discount ?? null, perPrinterUnits));
  }
  const available = items.length > 0 && items.every((i) => i.ok);
  const sum = (f: (i: ResolvedKitItem) => number) => items.reduce((s, i) => s + f(i) * i.item.qty, 0);
  const per = available ? sum((i) => i.after_unit_iqd as number) : null;
  const before = available ? sum((i) => i.unit_iqd as number) : null;
  const off = available ? sum((i) => i.discount_unit_iqd) : 0;
  return {
    kit, items, available,
    price_per_printer_iqd: per, before_per_printer_iqd: before, discount_per_printer_iqd: off,
    total_iqd: per === null ? null : per * units, before_total_iqd: before === null ? null : before * units, discount_total_iqd: off * units,
  };
}

/** One add-on for this customer and printer (its colour: `wish`, missing = random). */
export async function resolveAddon(c: Context<AppContext>, addon: PrinterAddon, printer: KitPrinter, pricing: KitPricing = kitPricing(c), wish?: string): Promise<ResolvedAddon> {
  const units = Math.max(1, Math.trunc(printer.qty) || 1);
  const colourWish = colorModeOf(addon) === 'customer' ? wish : undefined;
  let r = await resolveAttachedItem(c, addon, printer, pricing, colourWish, addon.discount, Math.max(1, addon.qty));
  const noLead = { min: null, max: null };
  let preorder: ResolvedAddon['preorder'] = null;
  let withPrinterReason: string | null = null;
  /**
   * «IF NOT AVAILABLE PUT THEM ON PRE-ORDER» (owner, 2026-11-19). An add-on that cannot go with a READY
   * printer (off the shelf, or its product sells by pre-order only) is looked up as its product's OWN
   * pre-order: every route, judged and priced by the cart's door exactly as the part's page would sell it,
   * and ONE chosen deterministically — the cheapest unit, then sea before air before land.
   * It is never made a line of the printer's order: one order is one journey (the cart's one-shipping-type
   * rule), so the answer says «pre-order, ordered separately» with the route and the lead days.
   * A pre-order printer's add-on already follows the printer's route; a refused COLOUR stays that refusal.
   */
  const printerIsReady = !printer.transportMethod && printer.fulfillmentType !== 'pre_order';
  if (!r.ok && !r.colour_refusal && r.product && r.actx && printerIsReady) {
    const found: Array<{ transport: string; unit: number; lead: { min: number | null; max: number | null } }> = [];
    // The product row and its context are the ones just read: each route is judged in memory, with no further read.
    const loaded = { product: r.product, actx: r.actx };
    for (const transport of PREORDER_ROUTES) {
      const p = await resolveAttachedItem(c, addon, { ...printer, fulfillmentType: 'pre_order', transportMethod: transport }, pricing, colourWish, null, 1, loaded);
      if (p.ok && typeof p.unit_iqd === 'number') found.push({ transport, unit: p.unit_iqd, lead: p.lead_days ?? noLead });
    }
    // Stable sort: the cheapest unit first; equal prices keep the route order (sea, air, land).
    found.sort((x, y) => x.unit - y.unit);
    if (found[0]) {
      preorder = { transport: found[0].transport, unit_price_iqd: found[0].unit, lead_days: found[0].lead };
      withPrinterReason = r.reason;
      r = { ...r, reason: ADDON_PREORDER_SEPARATE };
    }
  }
  const per = r.ok ? (r.after_unit_iqd as number) * addon.qty : null;
  const before = r.ok ? (r.unit_iqd as number) * addon.qty : null;
  return {
    addon, resolved: r, available: r.ok,
    price_per_printer_iqd: per, before_per_printer_iqd: before,
    total_iqd: per === null ? null : per * units, before_total_iqd: before === null ? null : before * units,
    discount_total_iqd: r.ok ? r.discount_unit_iqd * addon.qty * units : 0,
    fulfillment: preorder ? 'pre_order' : 'with_printer',
    transport: preorder ? preorder.transport : r.ok ? r.shared.transportMethod || null : null,
    lead_days: preorder ? preorder.lead_days : r.ok ? r.lead_days ?? noLead : noLead,
    preorder,
    with_printer_reason: withPrinterReason,
  };
}

/** The pre-order routes an add-on's own pre-order is looked up on, in tie-break order. */
const PREORDER_ROUTES = ['sea', 'air', 'land'] as const;

/** The colour choices of a customer-colour item, as the page shows them (after / before prices, no stock counts). */
function colourChoices(i: ResolvedKitItem) {
  if (!i.colors) return {};
  const after = (x: ResolvedColour) => (x.unit_iqd === null || x.applied_iqd === null ? null
    : x.unit_iqd - (i.discount_terms ? unitDiscount(i.discount_terms.discount, x.applied_iqd, i.discount_terms.units) : 0));
  return {
    colors: i.colors.map((x) => ({ id: x.id, name: x.name, name_ar: x.name_ar, name_ku: x.name_ku, hex: x.hex, available: x.ok, unit_price_iqd: after(x), before_unit_price_iqd: x.unit_iqd })),
    random: {
      available: !!i.random_pick,
      color_id: i.random_pick?.id ?? null,
      unit_price_iqd: i.random_pick ? after(i.random_pick) : null,
      before_unit_price_iqd: i.random_pick?.unit_iqd ?? null,
    },
  };
}

function itemPublic(i: ResolvedKitItem) {
  return {
    product_id: i.item.product_id,
    slug: i.slug,
    name: i.name,
    name_ar: i.name_ar,
    variant: i.variant,
    option_value_ids: i.item.option_value_ids,
    color_id: i.color_mode === 'fixed' ? i.item.color_id : i.line.colorId || null,
    color_mode: i.color_mode,
    chosen: i.chosen,
    qty_per_printer: i.item.qty,
    qty: i.line.qty,
    unit_price_iqd: i.after_unit_iqd,
    before_unit_price_iqd: i.unit_iqd,
    discount_unit_iqd: i.discount_unit_iqd,
    available: i.ok,
    reason: i.reason,
    ...colourChoices(i),
  };
}

/** What the page shows of a resolved kit: titles, items, live prices before / after, availability. No ids beyond the product's. */
export function kitPublic(r: ResolvedKit) {
  return {
    id: r.kit.id,
    title: r.kit.title,
    available: r.available,
    discount: r.kit.discount ?? null,
    price_per_printer_iqd: r.price_per_printer_iqd,
    before_per_printer_iqd: r.before_per_printer_iqd,
    discount_per_printer_iqd: r.discount_per_printer_iqd,
    total_iqd: r.total_iqd,
    before_total_iqd: r.before_total_iqd,
    discount_iqd: r.discount_total_iqd,
    items: r.items.map(itemPublic),
  };
}

/** What the page shows of a resolved add-on. */
export function addonPublic(r: ResolvedAddon) {
  const i = r.resolved;
  const it = itemPublic(i);
  return {
    id: r.addon.id,
    title: r.addon.title,
    product_id: it.product_id,
    slug: it.slug,
    name: it.name,
    name_ar: it.name_ar,
    variant: it.variant,
    image: i.image,
    option_value_ids: it.option_value_ids,
    color_id: it.color_id,
    color_mode: it.color_mode,
    chosen: it.chosen,
    qty_per_printer: r.addon.qty,
    qty: i.line.qty,
    discount: r.addon.discount ?? null,
    available: r.available,
    reason: i.reason,
    unit_price_iqd: i.after_unit_iqd,
    before_unit_price_iqd: i.unit_iqd,
    discount_unit_iqd: i.discount_unit_iqd,
    price_per_printer_iqd: r.price_per_printer_iqd,
    before_per_printer_iqd: r.before_per_printer_iqd,
    total_iqd: r.total_iqd,
    before_total_iqd: r.before_total_iqd,
    // Phase 6: 'with_printer' (a line of the printer's order) or 'pre_order' (its product sells by pre-order
    // only: ordered separately — `available` is false, `reason` ADDON_PREORDER_SEPARATE, `preorder` its figures).
    fulfillment: r.fulfillment,
    transport: r.transport,
    lead_days: r.lead_days,
    ...(r.preorder ? { preorder: r.preorder, with_printer_reason: r.with_printer_reason } : {}),
    ...colourChoices(i),
  };
}

/** The refusal of a kit that cannot be added now, naming the first item and its own reason. */
export function kitUnavailable(r: ResolvedKit): HttpError {
  const bad = r.items.find((i) => !i.ok);
  if (bad?.colour_refusal) {
    return kitColourUnavailable({ kit_id: r.kit.id, product_id: bad.item.product_id, color_id: bad.colour_refusal.color_id, reason: bad.colour_refusal.reason });
  }
  return new HttpError(409, 'An item of this filament kit cannot be sold right now — choose another kit or skip it.', KIT_UNAVAILABLE, {
    kit_id: r.kit.id,
    product_id: bad?.item.product_id ?? null,
    reason: bad?.reason ?? null,
  });
}

/** The refusal of an add-on that cannot be added now. */
export function addonUnavailableOf(r: ResolvedAddon): HttpError {
  const i = r.resolved;
  if (i.colour_refusal) return kitColourUnavailable({ addon_id: r.addon.id, product_id: i.item.product_id, color_id: i.colour_refusal.color_id, reason: i.colour_refusal.reason });
  // Phase 6: sold by pre-order only — its own code, naming the part's page, the route and the lead days.
  if (r.preorder) {
    return addonPreorderSeparate(r.addon.id, i.item.product_id, { slug: i.slug, transport: r.preorder.transport, lead_days: r.preorder.lead_days, reason: r.with_printer_reason });
  }
  return addonUnavailable(r.addon.id, i.item.product_id, i.reason);
}

export function kitNotOffered(kitId: string): HttpError {
  return new HttpError(409, 'This filament kit is not offered with this printer.', KIT_NOT_OFFERED, { kit_id: kitId });
}

type CartAttachedLine = { product_id: string; option_value_ids: string[]; color_id: string; qty: number };

/** Does one cart line hold this kit item / add-on (its colour: the owner's fixed one, or any for a customer-colour item)? */
function holds(spec: AttachedSpec, l: CartAttachedLine): boolean {
  if (colorModeOf(spec) === 'fixed') return kitItemKey(spec) === kitItemKey({ product_id: l.product_id, option_value_ids: l.option_value_ids, color_id: l.color_id || null });
  return !!l.color_id && kitItemKey({ ...spec, color_id: null }) === kitItemKey({ product_id: l.product_id, option_value_ids: l.option_value_ids, color_id: null });
}

/**
 * Do the kit lines in the cart still match the owner's kit for this printer
 * line? (Same items, each at its per-unit count × the printer's quantity; a
 * customer-colour item in any colour.)
 */
export function kitLinesMatch(kit: FilamentKit, printerQty: number, lines: CartAttachedLine[]): boolean {
  // (The shipping type is compared by the checkout, which knows each line's resolved type — review S11.)
  if (lines.length !== kit.items.length) return false;
  const used = new Set<number>();
  for (const item of kit.items) {
    const at = lines.findIndex((l, n) => !used.has(n) && holds(item, l) && l.qty === item.qty * printerQty);
    if (at < 0) return false;
    used.add(at);
  }
  return true;
}

/** Does this add-on's ONE cart line still match the owner's add-on (product, selection, colour rule, qty × printer)? */
export function addonLinesMatch(addon: PrinterAddon, printerQty: number, lines: CartAttachedLine[]): boolean {
  return lines.length === 1 && holds(addon, lines[0]) && lines[0].qty === addon.qty * printerQty;
}
