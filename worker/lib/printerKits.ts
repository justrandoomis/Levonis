/**
 * THE OWNER'S FILAMENT KITS (brief §H; owner rulings 2026-11-17, DECISIONS
 * row 339 phase 2).
 *
 * A kit is made by the owner in the printer-services list from REAL products
 * and variants (`kits[]`); the customer picks one for a printer, or skips.
 *
 *   · Its price is the SUM OF THE LIVE PRICES of its items — each judged and
 *     priced by the cart's own door (`judgeLevonisLine`, `resolveCartLine`),
 *     for this customer, exactly as if the item were added alone. No kit
 *     discount exists.
 *   · One kit per printer unit: each item's quantity is its per-unit count ×
 *     the printer's quantity, and follows the printer (0235 triggers).
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
import { kitsForPrinter, kitItemKey, KIT_NOT_OFFERED, KIT_UNAVAILABLE, type FilamentKit, type KitItem, type PrinterServicesConfig } from '@levonis/pricing/printerServices';
import { isComposition, judgeLevonisLine, loadAddContext, loadAddProduct, type AddContext, type AddLine, type AddShared, type JudgedLine } from './cartAdd';
import { cartPricing, resolveCartLine } from '../routes/cart';

/** The cart-line discriminator of a kit line: never merges with the same filament bought alone. */
export const KIT_LINE_PREFIX = 'kit:';
export const kitLineDiscriminator = (printerCartItemId: string) => `${KIT_LINE_PREFIX}${printerCartItemId}`;

/** The printer the kit is for, as its cart line (or the page's selection) states it. */
export interface KitPrinter {
  productId: string;
  optionValueIds: string[];
  fulfillmentType: string;
  transportMethod: string;
  qty: number;
}

export interface ResolvedKitItem {
  item: KitItem;
  ok: boolean;
  /** The refusal code of the item's own door when it cannot be sold now. */
  reason: string | null;
  product: Record<string, unknown> | null;
  actx: AddContext | null;
  judged: JudgedLine | null;
  line: AddLine;
  shared: AddShared;
  /** This customer's live unit price (null when unavailable). */
  unit_iqd: number | null;
  name: string;
  name_ar: string;
  slug: string;
  variant: string;
}

export interface ResolvedKit {
  kit: FilamentKit;
  items: ResolvedKitItem[];
  available: boolean;
  /** Per printer unit: Σ item unit × per-unit qty (null when any item is unavailable). */
  price_per_printer_iqd: number | null;
  /** For the printer's quantity. */
  total_iqd: number | null;
}

/** The kit, when the published list offers it with this printer selection; else null. */
export function offeredKit(config: PrinterServicesConfig | null, printer: Pick<KitPrinter, 'productId' | 'optionValueIds'>, kitId: string): FilamentKit | null {
  if (!config) return null;
  return kitsForPrinter(config, printer.productId, printer.optionValueIds).find((k) => k.id === kitId) ?? null;
}

/** The viewer's pricing context, loaded once per request and shared by every kit item (review S15). */
export type KitPricing = ReturnType<typeof cartPricing>;
export const kitPricing = (c: Context<AppContext>): KitPricing => {
  const pricing = cartPricing(c);
  pricing.catch(() => undefined); // awaited by the first item that needs it; never an unhandled rejection
  return pricing;
};

/**
 * Judges and prices every item of one kit for this customer and printer. The
 * printer's `fulfillmentType` is the type its row RESOLVES to (the caller's
 * job, review S11); `pricing` is the request's one pricing context.
 */
export async function resolveKit(c: Context<AppContext>, kit: FilamentKit, printer: KitPrinter, pricing: KitPricing = kitPricing(c)): Promise<ResolvedKit> {
  const units = Math.max(1, Math.trunc(printer.qty) || 1);
  const shared: AddShared = { transportMethod: printer.transportMethod, fulfillmentType: printer.fulfillmentType, warrantyPlanId: '', services: '' };
  const items: ResolvedKitItem[] = [];
  for (const item of kit.items) {
    const line: AddLine = { optionValueIds: [...item.option_value_ids], colorId: item.color_id ?? '', qty: Math.min(9999, item.qty * units) };
    const base: ResolvedKitItem = { item, ok: false, reason: null, product: null, actx: null, judged: null, line, shared, unit_iqd: null, name: '', name_ar: '', slug: '', variant: '' };
    let product: Record<string, unknown>;
    try {
      product = await loadAddProduct(c, item.product_id);
    } catch (e) {
      items.push({ ...base, reason: e instanceof HttpError ? e.code ?? 'UNAVAILABLE' : 'UNAVAILABLE' });
      continue;
    }
    const named = { ...base, product, name: String(product.name ?? ''), name_ar: String(product.name_ar ?? ''), slug: String(product.slug ?? '') };
    if (isComposition(product)) { items.push({ ...named, reason: 'KIT_ITEM_COMPOSITION' }); continue; }
    let actx: AddContext;
    try {
      actx = await loadAddContext(c, product, { warrantyPlanId: '', pricing });
    } catch (e) {
      items.push({ ...named, reason: e instanceof HttpError ? e.code ?? 'UNAVAILABLE' : 'UNAVAILABLE' });
      continue;
    }
    const verdict = judgeLevonisLine(actx, line, shared);
    if (!verdict.ok) { items.push({ ...named, actx, reason: verdict.error.code ?? 'UNAVAILABLE' }); continue; }
    const { resolved, variantLabel } = resolveCartLine(
      product,
      { optionId: line.optionValueIds[0] ?? '', optionValueIds: line.optionValueIds, colorId: line.colorId, transportMethod: shared.transportMethod, fulfillmentType: shared.fulfillmentType, warrantyPlanId: '' },
      actx.tier, actx.tierActive, actx.ctx, actx.view, 'prepaid', actx.isPrinter, actx.offer
    );
    items.push({ ...named, actx, judged: verdict.judged, ok: true, unit_iqd: resolved.unit_subtotal_iqd, variant: variantLabel });
  }
  const available = items.length > 0 && items.every((i) => i.ok);
  const per = available ? items.reduce((s, i) => s + (i.unit_iqd as number) * i.item.qty, 0) : null;
  return { kit, items, available, price_per_printer_iqd: per, total_iqd: per === null ? null : per * units };
}

/** What the page shows of a resolved kit: titles, items, live prices, availability. No ids beyond the product's. */
export function kitPublic(r: ResolvedKit) {
  return {
    id: r.kit.id,
    title: r.kit.title,
    available: r.available,
    price_per_printer_iqd: r.price_per_printer_iqd,
    total_iqd: r.total_iqd,
    discount_iqd: 0,
    items: r.items.map((i) => ({
      product_id: i.item.product_id,
      slug: i.slug,
      name: i.name,
      name_ar: i.name_ar,
      variant: i.variant,
      option_value_ids: i.item.option_value_ids,
      color_id: i.item.color_id,
      qty_per_printer: i.item.qty,
      qty: i.line.qty,
      unit_price_iqd: i.unit_iqd,
      available: i.ok,
      reason: i.reason,
    })),
  };
}

/** The refusal of a kit that cannot be added now, naming the first item and its own reason. */
export function kitUnavailable(r: ResolvedKit): HttpError {
  const bad = r.items.find((i) => !i.ok);
  return new HttpError(409, 'An item of this filament kit cannot be sold right now — choose another kit or skip it.', KIT_UNAVAILABLE, {
    kit_id: r.kit.id,
    product_id: bad?.item.product_id ?? null,
    reason: bad?.reason ?? null,
  });
}

export function kitNotOffered(kitId: string): HttpError {
  return new HttpError(409, 'This filament kit is not offered with this printer.', KIT_NOT_OFFERED, { kit_id: kitId });
}

/**
 * Do the kit lines in the cart still match the owner's kit for this printer
 * line? (Same items, each at its per-unit count × the printer's quantity.)
 */
export function kitLinesMatch(kit: FilamentKit, printerQty: number, lines: Array<{ product_id: string; option_value_ids: string[]; color_id: string; qty: number }>): boolean {
  // (The shipping type is compared by the checkout, which knows each line's resolved type — review S11.)
  if (lines.length !== kit.items.length) return false;
  const want = new Map(kit.items.map((i) => [kitItemKey(i), i.qty * printerQty]));
  return lines.every((l) => want.get(kitItemKey({ product_id: l.product_id, option_value_ids: l.option_value_ids, color_id: l.color_id || null })) === l.qty);
}
