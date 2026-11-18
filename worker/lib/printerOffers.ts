/**
 * «خصص طابعتك», PHASE 4 — THE PRINTER'S OFFERS ON THE BUYING PATH (owner rulings
 * 2026-11-18; DECISIONS row 355).
 *
 *   · THE OWNER'S PRINTER DISCOUNT LIVES INSIDE THE UNIT PRICE. A kit line or
 *     an add-on line is priced by the cart's own door (`resolveCartLine`) and
 *     then, right after, `applyPrinterDiscount` takes the owner's discount off
 *     the customer's own goods price (`applied_iqd`, never a pre-order fee or a
 *     delivery fee) — one call point per door (GET /api/cart, the checkout's
 *     line build). There is no discount line: profit, shares, refunds, points
 *     and invoices read the unit × qty they always read. `printer_discount_iqd`
 *     and `pricing_snapshot.printer_discount` are REPORT-ONLY.
 *   · A discounted line behaves like an offer-priced line: a coupon sees it as
 *     already discounted, and a membership rule applied at the line is worked
 *     out on the price before the discount (D10) — the two never stack.
 *   · The server re-prices at every door from the PUBLISHED list; the client
 *     sends ids only (kitId, kitColors, addonIds, addonColors).
 *   · «لون عشوائي»: the system picks the cheapest available colour, then the
 *     one with the most free stock, then the colour order, then its id —
 *     deterministic (`pickRandomColour`). A colour the CUSTOMER chose is never
 *     swapped: sold out is refused.
 *   · Store bundles linked to a printer are independent lines at their own
 *     price (`storeBundlesFor`).
 */
import type { Context } from 'hono';
import type { AppContext } from './types';
import { HttpError, badRequest } from './http';
import type { ResolvedPrice } from './pricing';
import { compositionDetail, pricingCtx } from '../routes/products';
import {
  addonsOf, kitsOf, storeBundleIdsFor, unitDiscount,
  ADDON_CHANGED, ADDON_NOT_OFFERED, ADDON_UNAVAILABLE, ADDON_WITHOUT_PRINTER, KIT_COLOR_UNAVAILABLE, MAX_STORE_BUNDLES,
  type PrinterDiscount, type PrinterServicesConfig,
} from '@levonis/pricing/printerServices';

// ------------------------------------------------------------ the attached line

export type AttachedKind = 'kit' | 'addon';
/** Who picked an attached line's colour: the owner's fixed colour, the customer, or the system. */
export type LineColourMode = 'fixed' | 'chosen' | 'random';

/** The add-on line's cart discriminator: never merges with the same product bought alone or in a kit. */
export const addonLineDiscriminator = (printerCartItemId: string, addonId: string) => `addon:${printerCartItemId}:${addonId}`;

/** What a cart row (or a checkout line's row) says it is attached to; null for every ordinary line. */
export function attachedLineOf(row: Record<string, unknown>): { kind: AttachedKind; id: string; parentId: string; unitQty: number; colorMode: LineColourMode } | null {
  const parentId = typeof row.kit_parent_id === 'string' && row.kit_parent_id ? row.kit_parent_id : '';
  if (!parentId) return null;
  const addonId = typeof row.addon_id === 'string' && row.addon_id ? row.addon_id : '';
  return {
    kind: addonId ? 'addon' : 'kit',
    id: addonId || String(row.kit_id ?? ''),
    parentId,
    unitQty: Number(row.kit_unit_qty) || 0,
    colorMode: colourModeOfRow(row),
  };
}

export function colourModeOfRow(row: Record<string, unknown>): LineColourMode {
  const m = row.kit_color_mode;
  return m === 'chosen' || m === 'random' ? m : 'fixed';
}

// ----------------------------------------------------------------- the discount

/** The owner's discount terms for one attached line under the published list (null = none). */
export interface PrinterLineDiscount {
  kind: AttachedKind;
  id: string;
  discount: PrinterDiscount;
  /** Units one printer unit gets of this kit / add-on: a fixed discount is split over them (floor). */
  units: number;
  revision: number;
}

/** The discount a kit line or an add-on line carries now, read from the PUBLISHED list by its id. */
export function printerLineDiscount(config: PrinterServicesConfig | null | undefined, row: Record<string, unknown>): PrinterLineDiscount | null {
  if (!config) return null;
  const attached = attachedLineOf(row);
  if (!attached || !attached.id) return null;
  const revision = Number(config.revision) || 0;
  if (attached.kind === 'kit') {
    const kit = kitsOf(config).find((k) => k.id === attached.id && k.active);
    if (!kit?.discount) return null;
    return { kind: 'kit', id: kit.id, discount: kit.discount, units: kitUnitsPerPrinter(kit.items), revision };
  }
  const addon = addonsOf(config).find((a) => a.id === attached.id && a.active);
  if (!addon?.discount) return null;
  return { kind: 'addon', id: addon.id, discount: addon.discount, units: Math.max(1, addon.qty), revision };
}

/** A kit's units per printer unit: Σ item counts (a fixed discount is split over every spool of the kit). */
export const kitUnitsPerPrinter = (items: ReadonlyArray<{ qty: number }>) => Math.max(1, items.reduce((s, i) => s + (Number(i.qty) || 0), 0));

/** What the order freezes (pricing_snapshot.printer_discount) and the cart shows. */
export interface AppliedPrinterDiscount {
  kind: AttachedKind;
  id: string;
  mode: PrinterDiscount['mode'];
  value: number;
  /** The customer's own unit price before the discount (goods only). */
  before_unit_iqd: number;
  discount_unit_iqd: number;
  revision: number;
}

/**
 * THE ONE PLACE THE DISCOUNT ENTERS A PRICE. Lowers `applied_iqd` and
 * `unit_subtotal_iqd` by the per-unit discount (`unitDiscount`: percent of the
 * customer's goods price, or the fixed amount split per unit, capped at 90%);
 * `regular_iqd` is unchanged, so `applied < regular` marks the line discounted
 * the way an offer does, and `offer_before_iqd` (unless a live offer already
 * set it) is the price before — the struck price every surface draws. A line
 * the resolver refused, or with no discount, is returned untouched. The dollar
 * twins of the charged figures are dropped: these dinars have no dollar base.
 */
export function applyPrinterDiscount<T extends ResolvedPrice>(resolved: T, d: PrinterLineDiscount | null): { resolved: T; applied: AppliedPrinterDiscount | null } {
  if (!d || resolved.errors.length > 0) return { resolved, applied: null };
  const before = Math.max(0, Math.trunc(resolved.applied_iqd));
  const off = unitDiscount(d.discount, before, d.units);
  if (off <= 0) return { resolved, applied: null };
  const { applied_usd_cents: _a, unit_subtotal_usd_cents: _u, ...rest } = resolved;
  const hadOffer = typeof resolved.offer_before_iqd === 'number';
  const out = {
    ...rest,
    applied_iqd: before - off,
    unit_subtotal_iqd: Math.max(0, Math.trunc(resolved.unit_subtotal_iqd) - off),
    offer_before_iqd: hadOffer ? resolved.offer_before_iqd : before,
  } as T;
  if (!hadOffer) delete (out as { offer_before_usd_cents?: number }).offer_before_usd_cents;
  return {
    resolved: out,
    applied: { kind: d.kind, id: d.id, mode: d.discount.mode, value: d.discount.value, before_unit_iqd: before, discount_unit_iqd: off, revision: d.revision },
  };
}

/**
 * The REGULAR unit a membership rule reads on a discounted line: the regular
 * price less the printer discount (the «offer regular»), while the line's
 * `offer_before_iqd` carries the price before — so a rule applied at the line
 * takes only what it saves BEYOND the discount (D10), never on top of it.
 */
export function benefitRegularUnit(resolved: Pick<ResolvedPrice, 'regular_iqd' | 'applied_iqd'>, applied: AppliedPrinterDiscount | null): number {
  if (!applied) return resolved.regular_iqd;
  return Math.max(resolved.applied_iqd, resolved.regular_iqd - applied.discount_unit_iqd);
}

/** The cart / quote view of an applied discount (absent when none). */
export const printerDiscountView = (a: AppliedPrinterDiscount | null) =>
  a ? { printer_discount: { before_unit_iqd: a.before_unit_iqd, discount_unit_iqd: a.discount_unit_iqd } } : {};

// --------------------------------------------------------------- random colour

export interface ColourCandidate {
  id: string;
  /** The unit price this colour sells at (before any printer discount). */
  unit_iqd: number;
  /** Free units on the counter this line consumes; Infinity = untracked. */
  free: number;
  /** The owner's colour order. */
  sort: number;
}

/**
 * «لون عشوائي»: the cheapest colour, then the most free stock, then the
 * colour order, then the id. Pure and deterministic; null when none is offered.
 */
export function pickRandomColour(cands: readonly ColourCandidate[]): string | null {
  let best: ColourCandidate | null = null;
  for (const c of cands) {
    if (!best) { best = c; continue; }
    const better = c.unit_iqd !== best.unit_iqd ? c.unit_iqd < best.unit_iqd
      : c.free !== best.free ? c.free > best.free
        : c.sort !== best.sort ? c.sort < best.sort
          : c.id < best.id;
    if (better) best = c;
  }
  return best?.id ?? null;
}

/**
 * A RANDOM line whose stored colour can no longer serve its quantity is
 * re-picked by the same rule (GET /api/cart in memory, the checkout for the
 * order); a line whose colour still serves keeps it, and so does a line no
 * colour can serve (the ordinary stock refusal then speaks). Never for a
 * colour the customer chose.
 */
export function repickRandomColour(input: {
  colours: ReadonlyArray<{ id: string; active: boolean; option_id: string | null; order: number }>;
  optionValueIds: readonly string[];
  storedColorId: string;
  serves: (colorId: string) => { ok: boolean; free: number };
  priceOf: (colorId: string) => number | null;
}): string {
  if (input.storedColorId && input.serves(input.storedColorId).ok) return input.storedColorId;
  const cands: ColourCandidate[] = [];
  for (const col of input.colours) {
    if (!col.active || (col.option_id && !input.optionValueIds.includes(col.option_id))) continue;
    const s = input.serves(col.id);
    if (!s.ok) continue;
    const price = input.priceOf(col.id);
    if (price === null) continue;
    cands.push({ id: col.id, unit_iqd: price, free: s.free, sort: Number(col.order) || 0 });
  }
  return pickRandomColour(cands) ?? input.storedColorId;
}

// ------------------------------------------------------------------- refusals

export function kitColourUnavailable(details: { kit_id?: string; addon_id?: string; product_id: string; color_id: string; reason: string }): HttpError {
  return new HttpError(409, 'The colour you chose is not available — choose another colour or «random».', KIT_COLOR_UNAVAILABLE, details);
}
export function addonNotOffered(addonId: string): HttpError {
  return new HttpError(409, 'This add-on is not offered with this printer.', ADDON_NOT_OFFERED, { addon_id: addonId });
}
export function addonUnavailable(addonId: string, productId: string | null, reason: string | null, extra: Record<string, unknown> = {}): HttpError {
  return new HttpError(409, 'This add-on cannot be sold right now — remove it or try again later.', ADDON_UNAVAILABLE, { addon_id: addonId, product_id: productId, reason, ...extra });
}
export function addonChanged(printerCartItemId: string, addonId: string): HttpError {
  return new HttpError(409, 'An add-on of this printer changed — choose it again.', ADDON_CHANGED, { cart_item_id: printerCartItemId, addon_id: addonId });
}
export function addonWithoutPrinter(cartItemId: string): HttpError {
  return badRequest('An add-on is bought together with its printer — tick the printer too.', ADDON_WITHOUT_PRINTER, { cart_item_id: cartItemId });
}

// ------------------------------------------------------------- store bundles

export interface StoreBundlePublic {
  id: string;
  slug: string;
  name: string;
  name_ar: string;
  name_ku: string;
  image: string;
  before_iqd: number | null;
  after_iqd: number | null;
  saving_percent: number | null;
  needs_choices: boolean;
  /** The bundle can be bought now ('available' or 'preorder'). */
  available: boolean;
}

/**
 * The owner's store bundles linked to this printer product (≤ 8, owner order),
 * each read through the bundle page's own door (`compositionDetail`) for this
 * viewer: before = the parts' total, after = the bundle's own price. A bundle
 * that is hidden, locked or gone is dropped. No extra discount (money rule 7).
 */
export async function storeBundlesFor(c: Context<AppContext>, config: PrinterServicesConfig | null, productId: string): Promise<StoreBundlePublic[]> {
  if (!config) return [];
  const ids = storeBundleIdsFor(config, productId).slice(0, MAX_STORE_BUNDLES);
  if (!ids.length) return [];
  const rows = await c.env.DB.prepare(`SELECT id, slug FROM products WHERE id IN (SELECT value FROM json_each(?)) AND composition = 'bundle'`)
    .bind(JSON.stringify(ids)).all<{ id: string; slug: string }>().then((r) => r.results ?? []).catch(() => [] as Array<{ id: string; slug: string }>);
  if (!rows.length) return [];
  const slugOf = new Map(rows.map((r) => [r.id, r.slug]));
  const ctx = await pricingCtx(c);
  const out: StoreBundlePublic[] = [];
  for (const id of ids) {
    const slug = slugOf.get(id);
    if (!slug) continue;
    const b = await compositionDetail(c.env.DB, slug, ctx).catch(() => null);
    if (!b || b.locked === true) continue;
    const comp = (b.composition ?? {}) as { component_total_iqd?: unknown; saving_percent?: unknown; components?: Array<{ editable?: { option?: unknown; color?: unknown } | null; included?: unknown }>; availability_state?: unknown };
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null);
    out.push({
      id,
      slug: String(b.slug ?? slug),
      name: String(b.name ?? ''),
      name_ar: String(b.name_ar ?? ''),
      name_ku: String(b.name_ku ?? ''),
      image: typeof b.image === 'string' ? b.image : '',
      before_iqd: num(comp.component_total_iqd),
      after_iqd: num(b.display_price_iqd),
      saving_percent: num(comp.saving_percent),
      needs_choices: (comp.components ?? []).some((k) => k.editable?.option === true || k.editable?.color === true),
      available: ['available', 'preorder'].includes(String(comp.availability_state ?? b.availability_state ?? '')),
    });
  }
  return out;
}
