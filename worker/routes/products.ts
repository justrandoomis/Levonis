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
import { safeParse, localeToApi } from '../lib/types';
import { dailyUserHash, emitBestEffort, eventsEnabled, waitUntilFrom } from '../lib/eventBus';
import { ProductViewedV1 } from '@levonis/contracts/events/v1/ProductViewed';
import { notFound, int, str } from '../lib/http';
import { getSetting, getSettings, PUBLIC_SETTING_KEYS } from '../lib/settings';
import { normalizeHomeBanners, normalizeSectionItems } from '../lib/homeContent';
import { parseProductRow, projectPublic, projectAdmin } from '../lib/productModel';
import type { ProductDoc } from '../lib/productModel';
import { resolveUnitPrice, proPolicyFrom, DEFAULT_PRO_POLICY } from '../lib/pricing';
import type { Tier, ProPricingPolicy, ResolvedPrice } from '../lib/pricing';
import { pricingTierContext } from '../lib/entitlements';
import type { TierStatus } from '../lib/entitlements';
import { rateLimit } from '../lib/ratelimit';
import { resolveStock, isLowStock } from '../lib/inventory';
import { COMPOSITION_LOW_BUNDLES } from '../lib/bundleComposition';
import type { SaleModeName } from '../lib/bundleComposition';
import type { InventorySnapshot } from '../lib/inventory';
import { colorVisibility } from '../lib/productRelations';
import type { ColorLinkRow, GroupSelection } from '../lib/productRelations';
import {
  applyRelations,
  EMPTY_RELATIONS,
  loadRelationsView,
  loadRelationsViews,
  publicRelations,
  snapshotFrom,
} from '../lib/productOverlay';
import type { ProductRelationsView } from '../lib/productOverlay';
import {
  bundleCard,
  componentViews,
  compositionMaxQty,
  cover,
  displayOverride,
  loadCompositionBySlug,
  lockedCard,
  offerBlock,
  publicAvailability,
  resolveCompositionLines,
  resolveCompositionPage,
  type ComponentChoice,
  type CompositionViewer,
  type ResolvedBundle,
} from '../lib/bundleRead';
import { loadBundleComponents } from '../lib/bundleComposition';
import {
  applyMysteryToBundles,
  loadCompositionRows,
  parseBundleChoices,
  resolveChoiceSet,
} from '../lib/bundleCart';
import { publicMysteryBlock, resolveMysteryLines, type MysteryContext } from '../lib/mysteryLine';
import { activePoolProductIds } from '../lib/mysteryDraw';
import { applyOfferToResolved, loadOffers, offerEligible, offerKey, scheduleState, subjectOf, type OfferView } from '../lib/offers';
import { isPrinterProduct } from '../lib/printerIdentity';
import { pricedPlans, WARRANTY_NOT_PRINTER } from '../lib/warrantyPlans';

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

export interface PricingCtx {
  tier: Tier;
  /** What the resolver is told: the membership's activity, except that a PRO
   *  is active for PRICING only inside the PRO purchase context (approved
   *  default address, benefits not restricted) — the checkout's own gate. */
  tierActive: boolean;
  /** The membership itself is active (a PRO outside the context still IS a
   *  PRO — the page must not ask them to subscribe). */
  membershipActive: boolean;
  /** PRO purchase benefits apply to this viewer's quotes. */
  proContext: boolean;
  proPolicy: ProPricingPolicy;
  transportDefaults: Array<{ method: string; commission_iqd: number }>;
  /**
   * The membership itself, resolved ONCE per request.
   *
   * `offerEligible` (§9) needs the whole `TierStatus` — the tier, whether it
   * is active, and which benefits an admin restriction case has paused — and
   * `getTierStatus` performs two writes per call. Carrying it here is what
   * keeps §14's "per-request, never per-row" true for a page of bundles: the
   * alternative is one membership resolution per card. `null` = a signed-out
   * visitor, who is eligible for anything that requires no tier.
   */
  tierStatus: TierStatus | null;
}

// ------------------------------------------------- sale mode / availability
/**
 * SELLABLE-STOCK AND SALE-MODE SEMANTICS (integrated mandate §7.2).
 *
 * What the storefront is allowed to claim about a product is derived here,
 * server-side, from the REAL stock model — never guessed in the browser:
 *
 *  - Stock comes from ONE authoritative level per product, chosen by
 *    `products.inventory_mode` (BASE / OPTION / COLOR / VARIANT_COMBINATION,
 *    migration 0018) and resolved by worker/lib/inventory.ts. `scope` reports
 *    which level actually answered, and `reserved` is the real held count from
 *    the inventory ledger — units held for a live order are NOT sellable.
 *    Levels are never summed: an exhausted colour blocks the sale no matter
 *    what the base row says. A product with no relational rows resolves at
 *    BASE, which is exactly what it did before.
 *  - Zero is never "unlimited": untracked (NULL) and 0 are different states.
 *  - A product may offer SEVERAL sale types at once (§6). Each is reported in
 *    `modes` with whether it is usable and why not. The default follows the
 *    mandate: direct sale when it is enabled and stock is actually available,
 *    otherwise pre-order when that is enabled and usable.
 *  - Pre-order is NOT invented for every out-of-stock product. It exists only
 *    where an admin enabled it AND at least one active transport offer
 *    resolves to a real integer commission (own value, else the admin
 *    default). Otherwise the honest answer is "unavailable" plus the machine
 *    reason.
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
    /** Which level actually answered — never a guess. 'composition' is a
     *  bundle or mystery row, whose own stock column is NULL by design and
     *  whose answer is computed from its members (§2.4). */
    scope: 'product' | 'base' | 'option' | 'color' | 'variant' | 'composition';
    on_hand: number | null; // null = untracked
    reserved: number; // units held for live orders — not sellable
    available: number | null; // sellable now; null = untracked
    max_qty: number; // 0 when nothing is sellable
    low: boolean; // at or below the configured warning level
  };
  selection: {
    option_required: boolean;
    color_required: boolean;
    option_id: string | null;
    /** The full multi-group selection (§7). */
    option_value_ids: string[];
    color_id: string | null;
    complete: boolean;
    errors: string[];
  };
  /** §6: every sale type the product offers, with whether it can be used. */
  modes: Array<{ type: 'direct_sale' | 'pre_order'; usable: boolean; reason: string | null }>;
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
> & { sale_types?: string[]; composition?: string };

const QTY_CEILING = 99; // matches the cart/checkout per-line cap

/** The per-line cap a product in an ACTIVE mystery pool is sold under, so its
 *  exact remaining stock is never published as a quantity limit (§8.2 row 18). */
export const POOL_MEMBER_MAX_QTY = 10;

export function saleAvailability(
  doc: AvailabilityDoc,
  input: {
    /** Legacy single-option selection; folded into option_value_ids. */
    optionId?: string | null;
    /** §7 multi-group selection: one value per option group. */
    optionValueIds?: string[];
    colorId?: string | null;
    qty?: number;
    transportDefaults?: Array<{ method: string; commission_iqd: number }>;
    /** When supplied, THE authority on stock (worker/lib/inventory.ts). */
    inventory?: InventorySnapshot;
    /** Colour→option links, for the OR-within / AND-across visibility rule. */
    links?: ColorLinkRow[];
    /**
     * §8.2 ROW 18 — THE PUBLICATION RULE FOR A MYSTERY-POOL MEMBER.
     *
     * Levonis publishes EXACT sellable counts per option value and per colour
     * to anonymous callers. A buyer snapshots the catalogue, checks out, and
     * snapshots again: exactly one colour row has dropped by exactly
     * `spool_qty × qty`. Two unauthenticated GETs defeat `'confirmed'`,
     * `'preparing'`, `'shipped'` and `'delivered'` completely and
     * deterministically — every other defence in the reveal design is
     * downstream of a channel that is already open.
     *
     * So membership of an ACTIVE mystery pool is a publication rule: the
     * customer sees the coarse state and a CLAMPED `max_qty`, and admins keep
     * the exact counts. §17 decision 10 is the owner's trade.
     */
    coarseStock?: boolean;
    /** Which sale type the buyer asked for, when both are offered. */
    preferredType?: string | null;
    /**
     * A COMPOSITION ROW'S ANSWER, and the reason this function fails CLOSED.
     *
     * `products.stock` is NULL on a bundle for ever, and NULL means "untracked
     * → sell 99" everywhere else in this function. There are six call sites; a
     * single one that forgot to thread these would advertise 99 units of a
     * bundle whose real availability may be 0. So a composition row that
     * arrives with `compositionMax` undefined is UNAVAILABLE with
     * `COMPOSITION_MAX_REQUIRED` and `max_qty: 0` — never an untracked 99.
     *
     * `bundleAvailability().max_bundles` / `.modes`, and the offer's own
     * `bundle_config.max_qty_per_order`.
     */
    compositionMax?: number | null;
    compositionModes?: SaleModeName[];
    maxQtyPerOrder?: number;
  } = {}
): SaleAvailability {
  const defaults = input.transportDefaults ?? [];
  const colorId = input.colorId || '';
  const selectedValueIds = [
    ...new Set([...(input.optionValueIds ?? []), ...(input.optionId ? [input.optionId] : [])]),
  ].filter(Boolean);

  // ---- selection (a hidden option/color is not selectable)
  const activeOptions = doc.options.filter((o) => o.active !== false);
  const activeColors = doc.colors.filter((c) => c.active !== false);
  const errors: string[] = [];

  const chosenOptions = selectedValueIds
    .map((id) => activeOptions.find((o) => o.id === id) ?? null)
    .filter((o): o is (typeof activeOptions)[number] => o !== null);
  for (const id of selectedValueIds) {
    if (!activeOptions.some((o) => o.id === id)) {
      errors.push(doc.options.some((o) => o.id === id) ? 'OPTION_INACTIVE' : 'OPTION_NOT_FOUND');
    }
  }
  const option = chosenOptions[0] ?? null;

  const color = colorId ? (activeColors.find((c) => c.id === colorId) ?? null) : null;
  if (colorId && !color) {
    errors.push(doc.colors.some((c) => c.id === colorId) ? 'COLOR_INACTIVE' : 'COLOR_NOT_FOUND');
  }

  // Colour visibility. With relational links present the real algebra decides
  // (OR inside a group, AND across groups); otherwise the legacy single
  // option_id field does, exactly as before.
  const links = input.links ?? [];
  const groupSelection: GroupSelection = {};
  if (links.length && input.inventory) {
    const groupOf = new Map(input.inventory.option_values.map((v) => [v.id, v.group_id] as const));
    for (const id of selectedValueIds) {
      const g = groupOf.get(id);
      if (g) groupSelection[g] = id;
    }
  }
  const colorSelectable = (c: { id: string; option_id: string | null }): boolean =>
    links.length
      ? colorVisibility(c.id, links, groupSelection).visible
      : !c.option_id || selectedValueIds.includes(c.option_id);

  if (color && !colorSelectable(color)) errors.push('COLOR_OPTION_MISMATCH');
  const selectableColors = activeColors.filter(colorSelectable);

  const optionRequired = activeOptions.length > 0;
  const colorRequired = selectableColors.length > 0 || (activeColors.length > 0 && selectedValueIds.length === 0);
  if (optionRequired && chosenOptions.length === 0) errors.push('OPTION_REQUIRED');
  if (colorRequired && !color) errors.push('COLOR_REQUIRED');

  // ---- stock: the ONE authoritative level for this selection
  let tracked: boolean;
  let onHand: number | null;
  let reserved: number;
  let available: number | null;
  let scope: SaleAvailability['stock']['scope'];
  let low = false;

  if (input.inventory) {
    const res = resolveStock(input.inventory, {
      option_value_ids: selectedValueIds,
      color_id: color ? color.id : null,
    });
    tracked = res.tracked;
    scope = res.targets[0]?.scope ?? (input.inventory.inventory_mode === 'BASE' ? 'base' : 'variant');
    onHand = res.targets.length
      ? res.targets.reduce<number>((m, t) => Math.min(m, t.stock ?? Infinity), Infinity)
      : null;
    if (onHand === Infinity) onHand = null;
    reserved = res.targets.reduce<number>((m, t) => Math.max(m, t.reserved ?? 0), 0);
    available = res.available;
    low = isLowStock(res);
    if (res.error === 'VARIANT_NOT_MODELLED') errors.push('VARIANT_NOT_MODELLED');
  } else {
    tracked = doc.stock !== null && doc.stock !== undefined;
    onHand = tracked ? Math.trunc(doc.stock as number) : null;
    reserved = 0;
    available = onHand === null ? null : Math.max(0, onHand - reserved);
    scope = 'product';
  }

  // ---- a composition row answers from its MEMBERS, or not at all ----------
  const isComposition = (doc.composition ?? '') !== '';
  const compositionUnanswered =
    isComposition && (input.compositionMax === undefined || input.compositionModes === undefined);
  if (isComposition) {
    scope = 'composition';
    reserved = 0;
    if (compositionUnanswered) {
      // FAIL CLOSED. The bundle row's own NULL stock is never read as untracked.
      available = 0;
      onHand = 0;
      tracked = true;
      low = false;
    } else {
      available = input.compositionMax ?? null;
      onHand = available;
      tracked = available !== null;
      low = available !== null && available > 0 && available <= COMPOSITION_LOW_BUNDLES;
    }
  }

  // ---- sale types (§6): a product may offer more than one at a time
  const saleTypes =
    doc.sale_types && doc.sale_types.length ? doc.sale_types : [doc.selling_type || 'direct_sale'];
  /**
   * A COMPOSITION ROW'S MODES COME FROM ITS COMPONENTS, NEVER FROM THE 'bundle'
   * TOKEN. `sale_types = ["bundle","pre_order"]` would otherwise turn direct
   * sale on for a pre-order bundle — a direct-sale button, a direct price basis
   * with no transport commission, and a five-stage delivery promise on a bundle
   * that has no stock at all.
   */
  const compositionModes = input.compositionModes ?? [];
  const directEnabled = isComposition
    ? compositionModes.includes('direct_sale')
    : saleTypes.includes('direct_sale') || saleTypes.includes('bundle');
  const preorderEnabled = isComposition ? compositionModes.includes('pre_order') : saleTypes.includes('pre_order');

  const transports: TransportOptionView[] = doc.preorder_transports
    .filter((t) => t.active !== false)
    .map((t) => {
      const own = Number.isInteger(t.commission_iqd) ? (t.commission_iqd as number) : null;
      const fallback = defaults.find((d) => d.method === t.method);
      const commission = own !== null ? own : fallback ? fallback.commission_iqd : null;
      return { method: t.method, commission_iqd: commission, configured: commission !== null };
    });
  const preorderUsable = preorderEnabled && transports.some((t) => t.configured);
  const preorderReason = preorderEnabled
    ? preorderUsable
      ? null
      : transports.length === 0
        ? 'NO_TRANSPORT_OFFERED'
        : 'TRANSPORT_COMMISSION_UNCONFIGURED'
    : 'PREORDER_NOT_ENABLED';

  const directUsable = directEnabled && (available === null || available > 0);
  const directReason = directEnabled ? (directUsable ? null : 'OUT_OF_STOCK') : 'DIRECT_SALE_NOT_ENABLED';

  const modes: SaleAvailability['modes'] = [];
  if (directEnabled) modes.push({ type: 'direct_sale', usable: directUsable, reason: directReason });
  if (preorderEnabled) modes.push({ type: 'pre_order', usable: preorderUsable, reason: preorderReason });

  // §6 default: direct sale when it is enabled AND stock is really available;
  // otherwise pre-order when that is enabled and usable. A buyer who asked for
  // a specific type gets it when it is usable.
  let mode: SaleMode;
  let reason: string | null = null;
  const wants = input.preferredType;
  if (wants === 'pre_order' && preorderUsable) {
    mode = 'preorder';
  } else if (wants === 'direct_sale' && directUsable) {
    mode = 'direct_sale';
  } else if (directUsable) {
    mode = 'direct_sale';
  } else if (preorderUsable) {
    mode = 'preorder';
  } else {
    mode = 'unavailable';
    reason = directEnabled ? directReason : preorderReason;
  }

  if (compositionUnanswered) {
    mode = 'unavailable';
    reason = 'COMPOSITION_MAX_REQUIRED';
  }

  /**
   * The pre-order branch discards `available` for an ordinary product, and that
   * is right: a pre-order is bought from a supplier, not off a shelf. It is
   * WRONG for a composition row, which may be a pre-order bundle carrying
   * tracked direct components that reserve normally — so a composition row is
   * clamped on BOTH branches, by its own `max_qty_per_order` as well.
   */
  const compositionCap = Math.min(QTY_CEILING, Math.max(0, Math.trunc(input.maxQtyPerOrder ?? QTY_CEILING)));
  const maxQty =
    mode === 'unavailable'
      ? 0
      : isComposition
        ? Math.min(compositionCap, available === null ? QTY_CEILING : available)
        : mode === 'preorder' || available === null
          ? QTY_CEILING
          : Math.min(QTY_CEILING, available);

  return {
    mode,
    reason,
    selling_type: doc.selling_type,
    stock: input.coarseStock
      ? {
          tracked,
          scope,
          on_hand: null,
          reserved: 0,
          available: null,
          // A FLAT CAP WHILE IT IS IN STOCK, 0 WHEN IT IS NOT.
          // `min(maxQty, cap)` would have been the obvious clamp and is
          // exactly wrong: with nine in stock it publishes nine, and the
          // difference between two anonymous reads is the size of the
          // purchase — which is the whole attack §8.2 row 18 describes. So the
          // number the customer sees does not move as stock moves. A request
          // above what is really there is refused honestly at the door with
          // OUT_OF_STOCK, which publishes nothing.
          //
          // A COMPOSITION ROW KEEPS ITS OWN CAP. `max_qty` there is already
          // clamped by `bundle_config.max_qty_per_order` (§2.4), and §10
          // requires it so the stepper disables at the limit — flattening it
          // would let the stepper offer more than the door will sell. What is
          // suppressed for a mystery offer is the COUNT beside it: `on_hand`
          // and `available` were the eligible pool's whole sellable supply,
          // published to an anonymous caller with `max-age=60` and moving with
          // every mystery purchase, against §8.2 row 13 and §10's "coarse
          // availability state only, no counts".
          max_qty: maxQty <= 0 ? 0 : isComposition ? maxQty : POOL_MEMBER_MAX_QTY,
          low,
        }
      : { tracked, scope, on_hand: onHand, reserved, available, max_qty: maxQty, low },
    selection: {
      option_required: optionRequired,
      color_required: colorRequired,
      option_id: option ? option.id : null,
      option_value_ids: selectedValueIds,
      color_id: color ? color.id : null,
      complete: errors.length === 0,
      errors: [...new Set(errors)],
    },
    modes,
    preorder: { enabled: preorderEnabled, usable: preorderUsable, reason: preorderReason, transports },
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
    stock: {
      tracked: false,
      scope: 'product',
      on_hand: null,
      reserved: 0,
      available: null,
      max_qty: 0,
      low: false,
    },
    selection: {
      option_required: false,
      color_required: false,
      option_id: null,
      option_value_ids: [],
      color_id: null,
      complete: true,
      errors: [],
    },
    modes: [],
    preorder: { enabled: false, usable: false, reason: 'PREORDER_NOT_ENABLED', transports: [] },
    qty_ok: false,
  };
}

/**
 * Viewer tier comes ONLY from the server-side session/memberships ledger —
 * through the SAME PRO purchase context the cart and the checkout use
 * (worker/lib/entitlements.ts `pricingTierContext`), judged at the viewer's
 * default address. So a PRO whose default address is not the approved one is
 * shown the surcharge here, exactly as the door will charge it.
 */
export async function pricingCtx(c: Context<AppContext>): Promise<PricingCtx> {
  const user = c.get('user');
  const [tierInfo, settings] = await Promise.all([
    user ? pricingTierContext(c.env.DB, user.id) : Promise.resolve(null),
    getSettings(c.env.DB, ['proPricingPolicy', 'preorderTransportDefaults']).catch(() => ({}) as Record<string, unknown>),
  ]);
  const s = settings as Record<string, unknown>;
  return {
    tier: tierInfo ? tierInfo.tierStatus.tier : 'free',
    tierActive: tierInfo ? tierInfo.pricingTierActive : false,
    membershipActive: tierInfo ? tierInfo.tierStatus.active : false,
    proContext: tierInfo ? tierInfo.proContext : false,
    proPolicy: 'proPricingPolicy' in s ? proPolicyFrom(s.proPricingPolicy) : DEFAULT_PRO_POLICY,
    transportDefaults: transportDefaultsFrom(s.preorderTransportDefaults),
    tierStatus: tierInfo ? tierInfo.tierStatus : null,
  };
}

/** The viewer's tier as the storefront may know it — never a browser input. */
function viewerTier(ctx: PricingCtx) {
  return {
    tier: ctx.tier,
    active: ctx.membershipActive,
    /** The tier the figures on this response were priced with. */
    pricing_active: ctx.tierActive,
    pro_benefits_context: ctx.proContext,
  };
}

/** Resolver output for public consumers — cost stripped, everything else kept. */
function publicQuote(r: ResolvedPrice) {
  const { cost_iqd, ...rest } = r;
  void cost_iqd;
  return rest;
}

/**
 * THE FINAL PRICE OF EVERY WAY TO GET THIS SELECTION, computed here so the
 * product page never does its own "applied + surcharge" arithmetic: the
 * direct pill, each pre-order journey (as paid in advance, and as paid cash
 * on delivery) and whether cash on delivery changes the number at all — with
 * the PRO exemptions exactly as the checkout applies them. The warranty plan
 * is left out on purpose: these are the prices of the WAYS TO BUY, and the
 * chooser adds its fee beside them. Selection-validity errors (a colour on
 * the wrong option) are not this function's business — only the numbers.
 */
export interface PricingModes {
  /** A direct sale of this selection, or null when the line cannot be fulfilled from stock. */
  direct: { unit_subtotal_iqd: number; direct: ResolvedPrice['direct'] } | null;
  preorder: Array<{
    method: string;
    /** Paid in advance: the configured pre-order price. null = commission unconfigured. */
    prepaid: { unit_subtotal_iqd: number; transport: ResolvedPrice['transport'] } | null;
    /** Paid cash on delivery: priced as a direct sale WHEN the product has a direct premium. */
    cod: { unit_subtotal_iqd: number; direct: ResolvedPrice['direct']; pricing_basis: ResolvedPrice['pricing_basis'] } | null;
    /** The two figures above differ. */
    cod_reprices: boolean;
  }>;
  /** Any journey on which cash on delivery changes the price. */
  cod_reprices: boolean;
}

export function pricingModes(
  doc: ProductDoc,
  ctx: PricingCtx,
  sel: { optionId: string | null; colorId: string | null },
  isPrinter: boolean
): PricingModes {
  const resolve = (transportMethod: string | null, preorderPricing: 'prepaid' | 'cod') =>
    resolveUnitPrice({
      product: doc,
      optionId: sel.optionId,
      colorId: sel.colorId,
      transportMethod,
      tier: ctx.tier,
      tierActive: ctx.tierActive,
      proPolicy: ctx.proPolicy,
      transportDefaults: ctx.transportDefaults,
      preorderPricing,
      isPrinter,
    });
  const d = resolve(null, 'prepaid');
  const direct = d.errors.includes('TRANSPORT_REQUIRED') ? null : { unit_subtotal_iqd: d.unit_subtotal_iqd, direct: d.direct };
  const unusable = new Set(['TRANSPORT_NOT_APPLICABLE', 'TRANSPORT_NOT_OFFERED', 'TRANSPORT_COMMISSION_UNCONFIGURED']);
  const preorder: PricingModes['preorder'] = [];
  for (const t of doc.preorder_transports) {
    if (t.active === false) continue;
    const prepaid = resolve(t.method, 'prepaid');
    if (prepaid.errors.some((e) => unusable.has(e))) {
      preorder.push({ method: t.method, prepaid: null, cod: null, cod_reprices: false });
      continue;
    }
    const cod = resolve(t.method, 'cod');
    preorder.push({
      method: t.method,
      prepaid: { unit_subtotal_iqd: prepaid.unit_subtotal_iqd, transport: prepaid.transport },
      cod: { unit_subtotal_iqd: cod.unit_subtotal_iqd, direct: cod.direct, pricing_basis: cod.pricing_basis },
      cod_reprices: cod.unit_subtotal_iqd !== prepaid.unit_subtotal_iqd,
    });
  }
  return { direct, preorder, cod_reprices: preorder.some((m) => m.cod_reprices) };
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

function publicShape(doc: ProductDoc, coarse = false): Record<string, unknown> {
  return { ...projectPublic(doc, coarse), ...legacyAliases(doc) };
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

/**
 * Public shape + the viewer-tier resolved display price.
 *
 * THE CARD PRICE IS THE CHEAPEST WAY TO BUY THE PRODUCT, not the base row's
 * price (the owner's rule: «يعرض السعر الأساسي للمنتج — الذي يكون غالبًا أقل
 * سعر للخيار أو اللون»). Every active option and colour is resolved through
 * the SAME resolver that prices checkout — per-field inheritance, PRO
 * policy, PRIME clamps — and the minimum applied price wins; its own
 * regular price rides along so a member's strikethrough compares the same
 * variant, never two different ones. display_prime/pro_iqd are the cheapest
 * member prices across levels, for the card's faint tier teasers; null =
 * that tier has no explicit price anywhere on the product.
 */
export function publicWithDisplayPrice(
  row: Record<string, unknown>,
  ctx: PricingCtx,
  view?: ProductRelationsView,
  /**
   * A COMPOSITION ROW'S OWN DISPLAY BLOCK (§4.3, §4.4), and the two reasons it
   * cannot be computed below.
   *
   * A derived-mode bundle's charged price comes from the LIVE component total,
   * while `products.price_iqd` is a cached copy the admin save wrote; resolving
   * the row would quote a number the cart does not charge, with only a
   * client-side "the price moved" note as protection. And the shared resolver
   * has three rungs and no PLUS, so a PLUS member would be shown the regular
   * price on the grid, the home shelf and search, then charged the PLUS price
   * at the door — the page/cart/door identity §15.4 case 9 asserts.
   *
   * `worker/lib/bundleRead.ts` computes both from the same pass that produced
   * `component_total_iqd`, and hands them here. No product row ever supplies
   * this argument, and none ever emits `display_applied_tier: 'plus'`.
   */
  composition?: {
    display_price_iqd: number;
    display_regular_iqd: number;
    display_prime_iqd: number | null;
    display_pro_iqd: number | null;
    display_applied_tier: 'regular' | 'plus' | 'prime' | 'pro';
    display_from: boolean;
  },
  /**
   * A SCHEDULED SPECIAL OFFER ON AN ORDINARY PRODUCT (§9, §10, §12).
   *
   * The same `offer_windows` row a bundle uses, on the same subject key — the
   * dividend of putting bundles in `products`. While the window is LIVE its
   * price replaces the ladder here and at the door, both through
   * `resolveOfferPrice`; while it is `upcoming` or `ended` it changes no price
   * and contributes only its schedule, so a countdown can be attached to a
   * product without touching what it costs today.
   *
   * A composition row never takes this argument: its price already came from
   * the one resolution pass, which consulted the same window.
   */
  offer?: OfferView | null,
  /** §8.2 row 18: this product is in an ACTIVE mystery pool, so the exact
   *  counters are suppressed here as well as inside `publicRelations`. The
   *  base `stock` field is the one a card reads, and it moves by exactly the
   *  size of a mystery purchase. */
  coarseStock = false
): Record<string, unknown> {
  const doc = view ? applyRelations(parseProductRow(row), view) : parseProductRow(row);
  // The coarse rule is applied by the ONE projector, so `options[].stock` and
  // `colors[].stock` are blanked with the base counter rather than beside it.
  const out = publicShape(doc, coarseStock);
  // §7: the stock a buyer sees is what they can still buy — the base units
  // minus the holds open checkouts have taken. Raw stock (and the holds
  // themselves) stay admin-side numbers.
  const heldBase = Number(row.stock_reserved ?? 0);
  if (!coarseStock && doc.stock !== null && heldBase > 0) out.stock = Math.max(0, doc.stock - heldBase);
  const levels: Array<{ optionId?: string; colorId?: string }> = [{}];
  for (const o of doc.options) if (o.active !== false) levels.push({ optionId: o.id });
  for (const col of doc.colors) if (col.active !== false) levels.push({ colorId: col.id });
  let best: ResolvedPrice | null = null;
  let maxApplied = 0;
  let primeMin: number | null = null;
  let proMin: number | null = null;
  for (const sel of levels) {
    // Selection-validity errors (a colour linked to an unchosen option, a
    // pre-order product with no transport picked) do not disturb the price
    // arithmetic — only the numbers are read here, never the errors.
    const r = resolveUnitPrice({
      product: doc,
      optionId: sel.optionId ?? null,
      colorId: sel.colorId ?? null,
      tier: ctx.tier,
      tierActive: ctx.tierActive,
      proPolicy: ctx.proPolicy,
      transportDefaults: ctx.transportDefaults,
    });
    if (!best || r.applied_iqd < best.applied_iqd) best = r;
    if (r.applied_iqd > maxApplied) maxApplied = r.applied_iqd;
    if (r.prime_iqd !== null) primeMin = primeMin === null ? r.prime_iqd : Math.min(primeMin, r.prime_iqd);
    if (r.pro_iqd !== null) proMin = proMin === null ? r.pro_iqd : Math.min(proMin, r.pro_iqd);
  }
  let resolved = best!;
  if (offer && (doc.composition ?? '') === '') {
    // ELIGIBILITY GATES THE PRICE, not only the purchase. Showing an
    // ineligible viewer the members-only offer price and then refusing them
    // at the door is exactly the page/cart/door disagreement §15.4 case 9
    // exists to prevent — so an ungated window prices for everyone, guests
    // included, and a gated one prices only for whoever may actually buy it.
    const check = offerEligible(ctx.tierStatus, offer, Date.now());
    const applied = check.ok
      ? applyOfferToResolved(resolved, offer, ctx.tier, ctx.tierActive, Date.now())
      : { resolved, source: 'ladder' as const, offer_id: offer.window?.id ?? null, plus_iqd: null };
    if (applied.source === 'offer') {
      // The rungs move together, so the "from" comparison below stays honest:
      // every level is discounted by the same rule.
      const delta = resolved.applied_iqd - applied.resolved.applied_iqd;
      maxApplied = Math.max(0, maxApplied - delta);
      primeMin = applied.resolved.prime_iqd;
      proMin = applied.resolved.pro_iqd;
    }
    resolved = applied.resolved;
    const w = offer.window;
    if (w) {
      out.offer = {
        offer_id: w.id,
        required_tiers: w.required_tiers,
        starts_at: w.starts_at,
        ends_at: w.ends_at,
        schedule_state: scheduleState(w.starts_at, w.ends_at, Date.now()),
        price_source: applied.source,
        /** The card badges the gate; the door re-checks it independently. */
        locked: !check.ok && check.reason === 'MEMBERSHIP_REQUIRED',
      };
      if (applied.plus_iqd !== null) out.display_plus_iqd = applied.plus_iqd;
    }
  }
  out.display_price_iqd = resolved.applied_iqd;
  out.display_applied_tier = resolved.applied_tier;
  // §4: no compare-at. The regular price is exposed so a member can see what
  // their membership saved — a real comparison, not a fabricated one.
  out.display_regular_iqd = resolved.regular_iqd;
  out.display_prime_iqd = primeMin;
  out.display_pro_iqd = proMin;
  // True when variants genuinely differ in price — the card may say «يبدأ من».
  out.display_from = maxApplied > resolved.applied_iqd;
  // A composition row's block is OVERWRITTEN, never merged: the freshly derived
  // figures and the offer-scoped PLUS rung replace the cached ladder entirely.
  if (composition && (doc.composition ?? '') !== '') Object.assign(out, composition);
  return out;
}

/**
 * THE COMPOSITION VIEWER — one membership resolution, passed down (§14).
 *
 * `pricingCtx` already performed it for this request; nothing below resolves a
 * tier per card, and `getTierStatus` (two writes per call) is never reached
 * from inside a loop.
 */
export function compositionViewer(ctx: PricingCtx, nowMs = Date.now()): CompositionViewer {
  return {
    tier: ctx.tier,
    tierActive: ctx.tierActive,
    proPolicy: ctx.proPolicy,
    transportDefaults: ctx.transportDefaults,
    status: ctx.tierStatus,
    nowMs,
  };
}

/**
 * ONE BUNDLE, FULLY RESOLVED, AS A CUSTOMER MAY SEE IT (§10, §14).
 *
 * Lives here rather than in `worker/routes/bundles.ts` because it needs
 * `saleAvailability`, `pricingModes` and `publicWithDisplayPrice`, and because
 * BOTH doors serve it: `GET /api/bundles/:slug`, and `GET /api/products/:slug`
 * for an old link to a composition slug. One builder means the two can never
 * answer differently — which is the whole point of the redirect existing.
 *
 * A LOCKED viewer gets the §9 allow-list and nothing else: no components, no
 * counts, no member prices, no saving. The lock is a 200 so the page renders
 * an honest lock rather than an error, and `POST /api/cart/items` and
 * `POST /api/orders` re-check the same verdict independently.
 */
/**
 * A PAGE OF COMPOSITION ROWS, WITH THE MYSTERY PRE-PASS APPLIED.
 *
 * A mystery offer has no `bundle_components`, so the composition pass alone
 * resolves it to `unconfigured` and the listing would drop it. The pool's
 * verdict is what makes it sellable, and it is loaded here — once per pool for
 * the whole page — so the card, the detail page, the cart and the door all
 * read the same availability (§2.3, §7).
 */
export async function resolveCompositionPageWithMystery(
  db: D1Database,
  rows: Record<string, unknown>[],
  ctx: PricingCtx,
  nowMs = Date.now()
): Promise<{ resolved: Map<string, ResolvedBundle>; mystery: Map<string, MysteryContext> }> {
  const resolved = await resolveCompositionPage(db, rows, compositionViewer(ctx, nowMs));
  const requests = rows
    .map((r) => ({ key: String(r.id), bundle: resolved.get(String(r.id)) }))
    .filter((x): x is { key: string; bundle: ResolvedBundle } => !!x.bundle && x.bundle.doc.composition === 'mystery')
    .map((x) => ({ key: x.key, bundle: x.bundle }));
  if (requests.length === 0) return { resolved, mystery: new Map() };
  const mystery = await resolveMysteryLines(db, requests, nowMs);
  applyMysteryToBundles(mystery, resolved);
  return { resolved, mystery };
}

export function compositionDetailBody(
  b: ResolvedBundle,
  ctx: PricingCtx,
  mystery?: MysteryContext
): Record<string, unknown> {
  const publicRow = publicWithDisplayPrice(b.row, ctx, undefined, displayOverride(b));
  if (b.locked) return { ...lockedCard(b, publicRow), viewer_tier: viewerTier(ctx) };

  // Bound to `doc` deliberately: `tests/bundleAvailability.test.ts` pins that
  // every one of the six call sites hands this function the WHOLE product
  // document, because the fail-closed branch reads `doc.composition` and a
  // partial object assembled at a call site would defeat it silently.
  const doc = b.doc;
  const availability = saleAvailability(doc, {
    transportDefaults: ctx.transportDefaults,
    inventory: snapshotFrom(EMPTY_RELATIONS, { stock: doc.stock, reserved: 0, low_stock_threshold: null }),
    // The two inputs `saleAvailability` fails CLOSED without (§2.4). A bundle's
    // own stock column is NULL by design, and NULL means "sell 99" everywhere
    // else in that function.
    compositionMax: b.availability.max_bundles,
    compositionModes: b.availability.modes,
    maxQtyPerOrder: b.config.max_qty_per_order,
    // §8.2 row 13 / §10: a MYSTERY offer reports a coarse state and never a
    // candidate count. `publicAvailability` already drops every count from the
    // `composition` block; this one is the `availability` block beside it,
    // which was publishing `floor(Σ eligible available ÷ spool_qty)` — the
    // live sellable supply of the whole pool — to anonymous callers.
    coarseStock: doc.composition === 'mystery',
  });

  return {
    ...bundleCard(b, publicRow),
    images: publicRow.images,
    description_images: (publicRow as { description_images?: unknown }).description_images ?? [],
    spec_groups: (publicRow as { spec_groups?: unknown }).spec_groups ?? [],
    composition: {
      kind: doc.composition,
      component_total_iqd: b.pricing.component_total_iqd,
      discount_iqd: b.pricing.discount_iqd,
      saving_percent: b.pricing.saving_percent,
      price_source: b.pricing.source,
      max_qty_per_order: b.config.max_qty_per_order,
      max_qty: compositionMaxQty(b),
      ...publicAvailability(b),
      availability_state: b.availability.state,
      components: componentViews(b),
      main_items: (bundleCard(b, publicRow) as { composition: { main_items: unknown } }).composition.main_items,
    },
    /**
     * §10's mystery detail block: `{ spool_qty, families[], modes[],
     * reveal_stage, odds? }` — AND NEVER A POOL. `odds` appears only when the
     * admin switched disclosure on, and even then it is aggregated by family,
     * so it names no product, no colour and no entry.
     */
    ...(mystery ? { mystery: publicMysteryBlock(mystery) } : {}),
    availability,
    pricing_modes: pricingModes(doc, ctx, { optionId: null, colorId: null }, false),
    offer: offerBlock(b),
    viewer_tier: viewerTier(ctx),
  };
}

/** The whole detail read for one slug: the joined row, the three composition
 *  reads, and the payload. Returns null when no composition row owns the slug. */
export async function compositionDetail(
  db: D1Database,
  slug: string,
  ctx: PricingCtx
): Promise<Record<string, unknown> | null> {
  const row = await loadCompositionBySlug(db, slug);
  if (!row || String(row.status ?? '') !== 'active') return null;
  const { resolved, mystery } = await resolveCompositionPageWithMystery(db, [row], ctx);
  const b = resolved.get(String(row.id));
  return b ? compositionDetailBody(b, ctx, mystery.get(String(row.id))) : null;
}

/** The listing card for one already-resolved bundle. Exported so
 *  `worker/routes/bundles.ts` serializes through the same two functions the
 *  detail does — a card and a page that disagree is the bug this prevents. */
export function compositionCard(b: ResolvedBundle, ctx: PricingCtx): Record<string, unknown> {
  return bundleCard(b, publicWithDisplayPrice(b.row, ctx, undefined, displayOverride(b)));
}

export { cover as compositionCover };

// ---------------------------------------------------------------- routes

/**
 * What the print-price calculator needs: the shop's REAL filaments, with a
 * real price per gram, and the owner's service rates.
 *
 * WHY THE PRICE PER GRAM IS DERIVED AND NOT TYPED IN. A calculator seeded
 * with made-up material prices is worse than no calculator: a customer plans
 * around the number and then meets a different one at checkout. Every figure
 * here comes from a product the shop actually sells — its price, divided by
 * the net weight on its own spec sheet. A filament with no net weight, or no
 * price, is simply not offered rather than guessed at.
 *
 * The service rates are the owner's decision and start unset. The calculator
 * shows the material cost either way and says plainly that the rest is not
 * published yet, rather than quietly quoting material-only as a total.
 */
productRoutes.get('/print-calculator', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, slug, name, name_ar, name_ku, price_iqd, spec_fields, images, template_family
       FROM products
      WHERE status = 'active' AND template_family = 'materials' AND price_iqd > 0
      ORDER BY price_iqd
      LIMIT 200`
  ).all<Record<string, unknown>>();

  const filaments: Array<Record<string, unknown>> = [];
  for (const row of results ?? []) {
    const specs = safeParse<Record<string, string>>(String(row.spec_fields ?? '{}'), {});
    // The materials template stores net weight in grams (templateFamilies.ts).
    // Accepts "1000", "1000 g", "1,000g" — and refuses anything else rather
    // than coercing a stray value into a price.
    const raw = String(specs.net_weight ?? '').replace(/[,\s]/g, '');
    const grams = Number(raw.replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(grams) || grams <= 0) continue;
    const price = Number(row.price_iqd) || 0;
    if (price <= 0) continue;
    filaments.push({
      id: row.id,
      slug: row.slug,
      name: row.name,
      name_ar: row.name_ar,
      name_ku: row.name_ku,
      price_iqd: price,
      net_weight_g: grams,
      // Rounded to the dinar because that is the smallest unit anyone pays in.
      iqd_per_gram: Math.round((price / grams) * 100) / 100,
      material_type: specs.material_type ?? specs.material ?? '',
    });
  }

  const rates = await getSetting(c.env.DB, 'printServicePricing');
  return c.json({
    success: true,
    filaments,
    // Honest nulls, echoed as they are stored. `configured` exists so a screen
    // does not have to decide what "0" means.
    rates: {
      machine_iqd_per_hour: rates?.machine_iqd_per_hour ?? null,
      setup_fee_iqd: rates?.setup_fee_iqd ?? null,
      margin_percent: rates?.margin_percent ?? null,
      configured:
        rates?.machine_iqd_per_hour !== null && rates?.machine_iqd_per_hour !== undefined,
    },
  });
});

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
  /**
   * COMPOSITION ROWS ARE NOT ORDINARY CATALOGUE PRODUCTS (§10).
   *
   * A bundle's `products.stock` is NULL for ever and its availability is
   * computed from its members, so listing one beside real products would put a
   * card on the grid whose stock question this endpoint cannot answer — and
   * `saleAvailability` deliberately fails CLOSED for it (§2.4), so it would
   * read as permanently unavailable. The default listing therefore excludes
   * them, `type=bundle` FLIPS the filter to show only them, and a SEARCH still
   * finds them on purpose: someone typing the bundle's name is looking for the
   * bundle, and the card links to /bundles/<slug> where it can be bought.
   */
  if (type === 'bundle') {
    // The existing multi-valued filter, unchanged — a composition row is pinned
    // to selling_type 'bundle' with 'bundle' at sale_types[0] (§1.2), so it
    // matches without a second clause, and a legacy row that carried the token
    // before this feature keeps matching too.
    sql += " AND (selling_type = 'bundle' OR EXISTS (SELECT 1 FROM json_each(products.sale_types) st WHERE st.value = 'bundle'))";
  } else if (!search) {
    sql += " AND composition = ''";
  }
  if (type === 'preorder') {
    sql += " AND (selling_type = 'pre_order' OR EXISTS (SELECT 1 FROM json_each(products.sale_types) st WHERE st.value = 'pre_order'))";
  }
  // 'discounted' used to mean "has a compare-at price above the selling
  // price". Compare-at was retired in §4, so the honest reading is now "has a
  // real membership price below the regular one".
  if (type === 'discounted') {
    sql += ' AND ((pro_price_iqd IS NOT NULL AND pro_price_iqd < price_iqd) OR (prime_price_iqd IS NOT NULL AND prime_price_iqd < price_iqd))';
  }
  if (type === 'featured') sql += ' AND is_featured = 1';
  sql += ' ORDER BY display_order ASC, created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const [{ results }, ctx] = await Promise.all([
    c.env.DB.prepare(sql).bind(...params).all<Record<string, unknown>>(),
    pricingCtx(c),
  ]);
  // One batched read for the whole page rather than N+1 per card — and one
  // chunked read of every scheduled offer on it, so a special offer costs the
  // listing one query, not one per card (§14).
  const [views, offers, pooled] = await Promise.all([
    loadRelationsViews(
      c.env.DB,
      results.map((r) => ({ id: String(r.id), inventory_mode: r.inventory_mode }))
    ),
    loadOffers(c.env.DB, results.map((r) => subjectOf(String(r.id)))),
    // §8.2 row 18, for the LISTING too: a card carries `stock`, and a grid
    // captured before and after a purchase is the same two GETs.
    activePoolProductIds(c.env.DB, results.map((r) => String(r.id))),
  ]);
  /**
   * A COMPOSITION ROW IS SERIALIZED BY THE COMPOSITION BUILDER, HERE TOO (§9).
   *
   * `?type=bundle` and the search branch both select composition rows, and
   * handing them to `publicWithDisplayPrice` published `price_iqd`,
   * `display_price_iqd`, `display_prime_iqd` and `display_pro_iqd` for a
   * GATED offer to a viewer who may not buy it — the exact keys §9's locked
   * ALLOW-LIST names as the ones that must be stripped, and which
   * `GET /api/bundles/:slug` already strips. One builder for both doors is
   * the stated point of §10's redirect, so the listing uses it: a locked row
   * comes back as `lockedCard`, an unlocked one as the same card the bundles
   * grid renders, and neither can quote a member price a non-member cannot
   * get.
   */
  const compositionIds = results.filter((r) => String(r.composition ?? '') !== '').map((r) => String(r.id));
  // The JOINED rows: `bundle_config` and `offer_windows` are what decide the
  // price mode and the lock, and the bare `products` row carries neither.
  const compositionJoined = compositionIds.length
    ? [...(await loadCompositionRows(c.env.DB, compositionIds)).values()]
    : [];
  const compositions = compositionJoined.length
    ? (await resolveCompositionPageWithMystery(c.env.DB, compositionJoined, ctx)).resolved
    : new Map<string, ResolvedBundle>();
  return c.json({
    success: true,
    products: results.map((p) => {
      const b = compositions.get(String(p.id));
      if (b) return compositionCard(b, ctx);
      return publicWithDisplayPrice(
        p,
        ctx,
        views.get(String(p.id)),
        undefined,
        offers.get(offerKey(subjectOf(String(p.id)))),
        pooled.has(String(p.id))
      );
    }),
  });
});

productRoutes.get('/:slug', async (c) => {
  const slug = c.req.param('slug');
  const row = await c.env.DB.prepare("SELECT * FROM products WHERE slug = ? AND status = 'active'")
    .bind(slug)
    .first<Record<string, unknown>>();
  if (row) {
    const user = c.get('user');
    const parsed = parseProductRow(row);

    /**
     * AN OLD LINK TO A COMPOSITION SLUG STILL WORKS (§10).
     *
     * A bundle is a real `products` row, so /product/<slug> resolves to it —
     * and the ordinary product payload is the wrong answer for one: its stock
     * column is NULL by design, it has no options or colours of its own, and
     * its price may be derived from its members. So the composition payload is
     * returned instead, with the canonical location beside it. The client
     * navigates; the payload is already correct if it does not.
     */
    if (parsed.composition !== '') {
      const ctx = await pricingCtx(c);
      const bundle = await compositionDetail(c.env.DB, slug, ctx);
      if (!bundle) throw notFound('Product not found');
      return c.json({
        success: true,
        source: 'catalog',
        redirect: `/bundles/${slug}`,
        bundle,
        product: bundle,
        viewer_tier: viewerTier(ctx),
      });
    }

    const [ctx, favRow, brandRow, relations, isPrinter] = await Promise.all([
      pricingCtx(c),
      user
        ? c.env.DB.prepare('SELECT 1 AS x FROM favorites WHERE user_id = ? AND product_id = ?')
            .bind(user.id, row.id)
            .first()
        : Promise.resolve(null),
      parsed.brand_id
        ? c.env.DB.prepare('SELECT id, name_ar, name_en, name_ckb FROM brands WHERE id = ? AND active = 1')
            .bind(parsed.brand_id)
            .first<{ id: string; name_ar: string; name_en: string; name_ckb: string }>()
        : Promise.resolve(null),
      // Options, colours, links, variants and images come from the TABLES.
      // Migration 0022 gave every existing product its rows, so this is the
      // single source of truth, not a second one.
      loadRelationsView(c.env.DB, String(row.id), row.inventory_mode),
      // The owner's catalog flag: the page shows the printer home-delivery
      // note off it (worker/lib/printerIdentity.ts) — never off ops_policy.
      isPrinterProduct(c.env.DB, String(row.id)),
    ]);
    const doc = applyRelations(parsed, relations);

    const resolved = resolveUnitPrice({
      product: doc,
      tier: ctx.tier,
      tierActive: ctx.tierActive,
      proPolicy: ctx.proPolicy,
      transportDefaults: ctx.transportDefaults,
      isPrinter,
    });
    // ONE FIELD, ONE MEANING. `display_price_iqd` is the CARD price — the
    // cheapest way to buy the product — everywhere else it appears, and this
    // endpoint used to set it to the base selection instead. A customer who
    // tapped a card reading 250,000 got a page whose own card field said
    // 400,000, and any surface reading the detail response (a share preview,
    // a saved-products row) repeated the higher number. The base-selection
    // quote is still returned, unchanged, as `pricing` — that is what the
    // page prices with until the customer picks an option.
    // §8.2 ROW 18. One indexed read (`idx_mystery_entries_product`), resolved
    // once per request and passed down — never once per option value or
    // colour. A product that is in no pool costs one empty query and the
    // payload is byte-identical to today's.
    const poolMember = (await activePoolProductIds(c.env.DB, [String(row.id)])).size > 0;
    const out = publicWithDisplayPrice(
      row,
      ctx,
      relations,
      undefined,
      (await loadOffers(c.env.DB, [subjectOf(String(row.id))])).get(offerKey(subjectOf(String(row.id)))),
      poolMember
    );
    // A fact about the product, not a price: the storefront renders the
    // home-delivery note beside a printer's price block from this flag.
    out.is_printer = isPrinter;
    // The extended-warranty options with their fee resolved against the BASE
    // selection's regular price (the quote re-prices them per selection), and
    // the total months each yields — so "+12 months → 24 total · +67,425"
    // is the server's sentence, never the browser's arithmetic. Empty for a
    // non-printer: the cart would refuse the plan (WARRANTY_NOT_PRINTER).
    out.warranty_plans = pricedPlans(doc.warranty_plans, resolved.regular_iqd, doc.warranty_base_months, isPrinter);

    // `ProductViewed` (03-EVENTS.md §3.2) — `best_effort` and SAMPLED (1:1
    // signed in, 1:5 anonymous): it never touches the outbox and never adds a
    // D1 write to a page read. The viewer travels as a daily-salted hash, or
    // not at all when nobody is signed in.
    if (eventsEnabled(c.env) && (user || Math.random() < 0.2)) {
      await emitBestEffort(
        c.env.DB,
        ProductViewedV1,
        {
          product_id: String(row.id),
          slug,
          catalog_id: parsed.category_id ? String(parsed.category_id) : null,
          brand_id: parsed.brand_id ? String(parsed.brand_id) : null,
          lang: localeToApi(user?.locale ?? 'en'),
          host_kind: c.get('host').kind === 'merchant' ? 'merchant' : 'main',
          tier: ctx.tierActive ? ctx.tier : null,
          viewer_hash: user ? await dailyUserHash(user.id) : null,
        },
        { aggregateId: String(row.id), actorId: user?.id ?? null, waitUntil: waitUntilFrom(c) }
      );
    }

    return c.json({
      success: true,
      product: out,
      source: 'catalog',
      favorite: !!favRow,
      brand: brandRow ?? null,
      // The structure the JSON model could not express: option GROUPS, the
      // real many-to-many colour links, modelled combinations and bound
      // images. Null when the product has no relational rows at all.
      relations: publicRelations(relations, poolMember),
      pricing: publicQuote(resolved), // base-selection resolver result, cost-free
      // The final price of every way to get the BASE selection (the quote
      // re-computes them per selection) — the page's fulfilment pills and
      // transport rows read these, and compute nothing.
      pricing_modes: pricingModes(doc, ctx, { optionId: null, colorId: null }, isPrinter),
      // §7.2 — the sale mode the page may DEFAULT to, derived from the real
      // stock model and the admin pre-order policy (never from the browser).
      availability: saleAvailability(doc, {
        coarseStock: poolMember,
        transportDefaults: ctx.transportDefaults,
        inventory: snapshotFrom(relations, {
          stock: doc.stock,
          reserved: Number(row.stock_reserved ?? 0),
          low_stock_threshold: (row.low_stock_threshold as number | null) ?? null,
        }),
      }),
      viewer_tier: viewerTier(ctx),
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

  /**
   * A COMPOSITION ROW IS QUOTED BY THE COMPOSITION BUILDER (§10, §9).
   *
   * This endpoint is §10's composition quote, and it used to have no
   * composition branch at all: a bundle fell into the ordinary path, where
   * `resolveUnitPrice` published `price_iqd`, `prime_price_iqd` and
   * `pro_price_iqd` for a GATED offer to a viewer who may not buy it — the
   * keys §9's locked ALLOW-LIST exists to strip — while `saleAvailability`
   * failed closed with `COMPOSITION_MAX_REQUIRED` so the payload was
   * simultaneously a leak and useless. It also re-checked no offer
   * eligibility, which §6.1 requires of every door.
   *
   * `compositionDetailBody` is the one builder `GET /api/bundles/:slug` uses,
   * so a locked viewer gets `lockedCard` here too, and the choices, family and
   * mode from §5.2's body are honoured. NOTHING IS DRAWN: `resolveMysteryLines`
   * reports the pool's availability, and `allocate` is a checkout-only concept
   * (§7.4).
   */
  const parsedRow = parseProductRow(row);
  if (parsedRow.composition !== '') {
    await rateLimit(c, 'composition_quote', 60, 300);
    const ctx = await pricingCtx(c);
    const joined = await loadCompositionRows(c.env.DB, [String(row.id)]);
    const compRow = joined.get(String(row.id));
    if (!compRow) throw notFound('Product not found');
    const isMystery = parsedRow.composition === 'mystery';
    const components = (await loadBundleComponents(c.env.DB, [String(row.id)])).byBundle.get(String(row.id)) ?? [];
    const label = String(row.name_ar || row.name || row.slug);
    const choices = isMystery
      ? new Map<string, ComponentChoice>()
      : resolveChoiceSet(components, parseBundleChoices(body.bundleChoices), label);
    const resolvedMap = await resolveCompositionLines(
      c.env.DB,
      [{ key: String(row.id), row: compRow, choices }],
      compositionViewer(ctx)
    );
    const b = resolvedMap.get(String(row.id));
    if (!b) throw notFound('Product not found');
    let mysteryCtx: MysteryContext | undefined;
    if (isMystery) {
      const ctxs = await resolveMysteryLines(
        c.env.DB,
        [
          {
            key: String(row.id),
            bundle: b,
            familyId: str(body.mysteryFamilyId, 'mysteryFamilyId', { max: 60, required: false }),
            transportMethod: typeof body.transportMethod === 'string' ? body.transportMethod : '',
            requestedMode: typeof body.mysteryMode === 'string' ? body.mysteryMode : null,
          },
        ],
        Date.now()
      );
      applyMysteryToBundles(ctxs, resolvedMap);
      mysteryCtx = ctxs.get(String(row.id));
    }
    const built = compositionDetailBody(resolvedMap.get(String(row.id))!, ctx, mysteryCtx);
    // A locked payload is the §9 allow-list and carries no price at all, so it
    // gets no quote block either — the lock IS the answer.
    if ((built as { locked?: boolean }).locked) {
      return c.json({ success: true, product: built, bundle: built, quote: null, viewer_tier: viewerTier(ctx) });
    }
    const priced = resolvedMap.get(String(row.id))!;
    return c.json({
      success: true,
      product: built,
      bundle: built,
      quote: {
        applied_iqd: priced.pricing.applied_iqd,
        regular_iqd: priced.pricing.regular_iqd,
        applied_tier: priced.pricing.applied_tier,
        unit_subtotal_iqd: priced.pricing.unit_subtotal_iqd,
        component_total_iqd: priced.pricing.component_total_iqd,
        discount_iqd: priced.pricing.discount_iqd,
        saving_percent: priced.pricing.saving_percent,
        qty,
        line_total_iqd: priced.pricing.unit_subtotal_iqd * qty,
        errors: priced.pricing.errors,
      },
      viewer_tier: viewerTier(ctx),
    });
  }

  // The relational tables are the truth for options/colours/stock — exactly
  // as the detail endpoint reads them. Quoting from the bare row made every
  // option saved through the current admin form (whose structure lives ONLY
  // in the tables) answer OPTION_NOT_FOUND, and per-colour stock invisible.
  const [relations, ctx, isPrinter] = await Promise.all([
    loadRelationsView(c.env.DB, String(row.id), row.inventory_mode),
    pricingCtx(c), // tier ONLY from the session, never the body
    isPrinterProduct(c.env.DB, String(row.id)),
  ]);
  const doc = applyRelations(parseProductRow(row), relations);

  const optionId = typeof body.optionId === 'string' && body.optionId ? body.optionId : null;
  const colorId = typeof body.colorId === 'string' && body.colorId ? body.colorId : null;
  const transportMethod = typeof body.transportMethod === 'string' ? body.transportMethod : null;
  const warrantyPlanId = typeof body.warrantyPlanId === 'string' && body.warrantyPlanId ? body.warrantyPlanId : null;

  const resolved = resolveUnitPrice({
    product: doc,
    optionId,
    colorId,
    transportMethod,
    warrantyPlanId,
    tier: ctx.tier,
    tierActive: ctx.tierActive,
    proPolicy: ctx.proPolicy,
    transportDefaults: ctx.transportDefaults,
    isPrinter,
  });
  // The same printers-only rule the cart enforces, reported the way the page
  // reports every other selection error — so the button disables here rather
  // than the add failing a moment later.
  if (warrantyPlanId && !isPrinter && !resolved.errors.includes(WARRANTY_NOT_PRINTER)) {
    resolved.errors.push(WARRANTY_NOT_PRINTER);
  }

  return c.json({
    success: true,
    quote: {
      ...publicQuote(resolved),
      qty,
      line_total_iqd: resolved.unit_subtotal_iqd * qty,
    },
    // The final price of every way to get THIS selection — direct, and each
    // pre-order journey paid in advance or cash on delivery — so the page's
    // pills show the server's numbers and never their own arithmetic.
    pricing_modes: pricingModes(doc, ctx, { optionId, colorId }, isPrinter),
    // Every extended-warranty option priced for THIS selection's regular price
    // (an option surcharge moves a percent fee), so the chooser can show the
    // exact dinar of each plan before one is picked.
    warranty_plans: pricedPlans(doc.warranty_plans, resolved.regular_iqd, doc.warranty_base_months, isPrinter),
    // Availability for THIS selection — changing option/color re-checks it,
    // against the REAL inventory snapshot and colour links, and asking for a
    // transport is asking for the pre-order journey (same rule as the cart).
    availability: saleAvailability(doc, {
      coarseStock: (await activePoolProductIds(c.env.DB, [String(row.id)])).size > 0,
      optionId,
      colorId,
      qty,
      transportDefaults: ctx.transportDefaults,
      inventory: snapshotFrom(relations, {
        stock: doc.stock,
        reserved: Number(row.stock_reserved ?? 0),
        low_stock_threshold: (row.low_stock_threshold as number | null) ?? null,
      }),
      links: relations.links,
      preferredType: transportMethod ? 'pre_order' : null,
    }),
    viewer_tier: viewerTier(ctx),
  });
});

// ---------------------------------------------------------------- home

/** Aggregated payload for the storefront home page. */
export const homeRoutes = new Hono<AppContext>();

homeRoutes.get('/', async (c) => {
  const [settings, discounted, latest, categories, brands, ctx] = await Promise.all([
    getSettings(c.env.DB, PUBLIC_SETTING_KEYS),
    c.env.DB.prepare(
      "SELECT * FROM products WHERE status = 'active' AND original_price_iqd IS NOT NULL AND original_price_iqd > price_iqd ORDER BY created_at DESC LIMIT 10"
    ).all<Record<string, unknown>>(),
    c.env.DB.prepare("SELECT * FROM products WHERE status = 'active' ORDER BY created_at DESC LIMIT 20").all<
      Record<string, unknown>
    >(),
    // The REAL taxonomy, so the categories strip works without the owner
    // retyping their own catalog into the home settings. Only catalogs that
    // actually have something to show are returned — an empty category on the
    // home page is a dead end for the customer.
    //
    // GROUPED BY NAME, and that is not cosmetic. The live database holds
    // SEVEN top-level catalogs called "Printers" and seven brands called
    // "Bambu Lab", left behind by repeated seeding — so the ungrouped query
    // rendered seven identical chips in a row. One chip per distinct name,
    // pointing at the id that actually holds the most products, is what a
    // customer can use. The duplicate ROWS are a data problem for the owner
    // to clean up; the storefront must not put them on the home page
    // meanwhile.
    c.env.DB.prepare(
      `WITH counted AS (
         SELECT c.id, c.slug, c.name_ar, c.name_en, c.name_ckb, c.sort,
                (SELECT COUNT(*) FROM product_catalogs pc
                   JOIN products p ON p.id = pc.product_id
                  WHERE pc.catalog_id = c.id AND p.status = 'active') AS n
           FROM catalogs c
          WHERE c.active = 1 AND c.parent_id IS NULL
       )
       SELECT id, slug, name_ar, name_en, name_ckb,
              SUM(n) OVER (PARTITION BY COALESCE(NULLIF(name_en,''), name_ar)) AS product_count
         FROM counted
        WHERE n = (SELECT MAX(n) FROM counted c2
                    WHERE COALESCE(NULLIF(c2.name_en,''), c2.name_ar)
                        = COALESCE(NULLIF(counted.name_en,''), counted.name_ar))
        GROUP BY COALESCE(NULLIF(name_en,''), name_ar)
        ORDER BY sort, name_en
        LIMIT 12`
    ).all<Record<string, unknown>>(),
    c.env.DB.prepare(
      `WITH counted AS (
         SELECT b.id, b.slug, b.name_ar, b.name_en, b.name_ckb,
                (SELECT COUNT(*) FROM products p
                  WHERE p.brand_id = b.id AND p.status = 'active') AS n
           FROM brands b
          WHERE b.active = 1
       )
       SELECT id, slug, name_ar, name_en, name_ckb,
              SUM(n) OVER (PARTITION BY COALESCE(NULLIF(name_en,''), name_ar)) AS product_count
         FROM counted
        WHERE n = (SELECT MAX(n) FROM counted b2
                    WHERE COALESCE(NULLIF(b2.name_en,''), b2.name_ar)
                        = COALESCE(NULLIF(counted.name_en,''), counted.name_ar))
        GROUP BY COALESCE(NULLIF(name_en,''), name_ar)
        ORDER BY product_count DESC, name_en
        LIMIT 12`
    ).all<Record<string, unknown>>(),
    pricingCtx(c),
  ]);

  // Normalize on the way OUT as well as on the way in: rows written before
  // lib/homeContent.ts existed never went through the validator, and the
  // storefront puts these straight into an <img src> and an <a href>.
  const raw = settings as Record<string, unknown>;
  const safeSettings = {
    ...raw,
    homeBanners: normalizeHomeBanners(raw.homeBanners),
    homeSectionItems: normalizeSectionItems(raw.homeSectionItems),
  };

  // THE HOME CARDS PRICE FROM THE SAME PLACE THE CART DOES. Without the
  // relational overlay a card falls back to the `products.options` /
  // `products.colors` JSON mirrors, and an owner who repriced an option in the
  // form would see the home page keep the old number while the product page
  // and the cart showed the new one — the very split the price-change round
  // was about. One batched read for both strips, not N+1 per card.
  // A product can be in BOTH strips, and the same id twice would bind a
  // duplicate placeholder for nothing.
  const homeRows = new Map<string, { id: string; inventory_mode: unknown }>();
  for (const r of [...discounted.results, ...latest.results]) {
    homeRows.set(String(r.id), { id: String(r.id), inventory_mode: r.inventory_mode });
  }
  const [homeViews, homePooled] = await Promise.all([
    loadRelationsViews(c.env.DB, [...homeRows.values()]),
    // §8.2 row 18 on the home rails too: the same card, the same `stock` field.
    activePoolProductIds(c.env.DB, [...homeRows.keys()].map(String)),
  ]);

  return c.json({
    success: true,
    settings: safeSettings,
    discounted: discounted.results.map((p) =>
      publicWithDisplayPrice(p, ctx, homeViews.get(String(p.id)), undefined, null, homePooled.has(String(p.id)))
    ),
    latest: latest.results.map((p) =>
      publicWithDisplayPrice(p, ctx, homeViews.get(String(p.id)), undefined, null, homePooled.has(String(p.id)))
    ),
    categories: categories.results.filter((r) => Number(r.product_count) > 0),
    brands: brands.results.filter((r) => Number(r.product_count) > 0),
  });
});
