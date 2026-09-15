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
import { resolveUnitPrice, proPolicyFrom, DEFAULT_PRO_POLICY, type MemberFallback } from '../lib/pricing';
import type { Tier, ProPricingPolicy, ResolvedPrice } from '../lib/pricing';
import { pricingTierContext } from '../lib/entitlements';
import { activeBenefitRules, ancestryFor, catalogAncestry, degradeIfSchemaMissing, fallbackFor } from '../lib/membershipBenefits';
import type { BenefitRule } from '@levonis/pricing/membershipBenefits';
import type { TierStatus } from '../lib/entitlements';
import { rateLimit } from '../lib/ratelimit';
import { resolveStock, isLowStock, resolveCapacity } from '../lib/inventory';
import { COMPOSITION_LOW_BUNDLES } from '../lib/bundleComposition';
import type { SaleModeName } from '../lib/bundleComposition';
import type { CapacitySnapshot, InventorySnapshot, OrderType } from '../lib/inventory';
import { colorVisibility } from '../lib/productRelations';
import type { ColorLinkRow, GroupSelection } from '../lib/productRelations';
import {
  applyRelations,
  EMPTY_RELATIONS,
  loadRelationsView,
  loadRelationsViews,
  publicRelations,
  capacityFrom,
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
  /**
   * THE CONFIGURED MEMBERSHIP BENEFITS (migration 0074), so a product page
   * quotes the member price the cart and the checkout will charge.
   *
   * Empty for a signed-out visitor and for an inactive membership: the rules
   * are a benefit, and a benefit without a membership is the regular price.
   * `ancestry` lets a rule written on "Printers" reach a product filed under a
   * sub-section of it.
   */
  benefitRules: readonly BenefitRule[];
  catalogAncestry: Map<string, string[]> | null;
  /** Frozen per request so two quotes in one response cannot disagree about
   *  whether a dated rule was live. */
  benefitNowIso: string;
}

/** The rule that applies to ONE product for this viewer, in the shape
 *  `resolveUnitPrice` consults. The section comes from the product ROW. */
export function benefitFallbackFor(
  ctx: PricingCtx,
  doc: { id?: string | null; category_id?: string | null; sub_category_id?: string | null }
): MemberFallback {
  if (!ctx.tierStatus) return { pro: null, prime: null };
  return fallbackFor(
    ctx.benefitRules,
    ctx.tierStatus,
    {
      product_id: doc.id ?? null,
      category_id: doc.category_id ?? null,
      sub_category_id: doc.sub_category_id ?? null,
      ancestry: ancestryFor(ctx.catalogAncestry, doc.category_id ?? null, doc.sub_category_id ?? null),
    },
    ctx.benefitNowIso
  );
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

/**
 * 0075 — PRE-ORDER CAPACITY, PER ROUTE. A SECOND ARRAY, NOT THREE MORE FIELDS
 * ON `TransportOptionView`.
 *
 * `transports` is the PRICE answer and several screens and tests read it as an
 * exact shape; capacity is a different question with a different lifetime (a
 * commission changes when the admin edits the product, a quota changes on every
 * sale). Keeping them apart means a client can cache one and re-read the other,
 * and it keeps the older shape byte-identical for callers that only price.
 *
 * `available: null` = untracked, which is unlimited and is what every catalogue
 * carried before 0075. `0` = tracked and full.
 *
 * `scope` says WHOSE number it is, and it is the field that makes the
 * shared-versus-independent rule visible instead of guessable: 'preorder'
 * means this route is spending from the model's SHARED pool (so air, sea and
 * land all show the same figure, and selling one by air lowers what sea can
 * sell), 'preorder_transport' means this route holds its OWN quota. `null` =
 * no counter at all.
 */
export interface PreorderRouteCapacity {
  method: string;
  available: number | null;
  scope: 'preorder' | 'preorder_transport' | null;
  scope_id: string;
  /** Commission configured AND a counter with room. */
  usable: boolean;
  reason: string | null;
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
    /** 0075 — one entry per offered route. See `PreorderRouteCapacity`. */
    routes: PreorderRouteCapacity[];
    /**
     * 0075 — THE COUNTER A PRE-ORDER OF THIS LINE WOULD CONSUME. It is NEVER
     * the `stock` block above: that is the shelf, and a pre-order does not
     * come off the shelf. `available: null` = untracked = unlimited, exactly
     * as a NULL `stock` means untracked.
     *
     * `scope_id` names the row so an admin screen can say WHICH counter, and
     * so a client never has to re-derive the shared-versus-independent rule.
     */
    capacity: {
      tracked: boolean;
      scope: 'preorder' | 'preorder_transport' | null;
      scope_id: string;
      available: number | null;
      max_qty: number;
    };
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


/**
 * THE EMPTY OFFER MAP, typed off `loadOffers` itself so it cannot drift.
 *
 * An absent `offer_windows` (migration 0060) means NO OFFER IS RUNNING, and a
 * product with no offer is priced at its ordinary price — which is exactly
 * what every reader does with an empty map. Degrading here is what stops one
 * uninstalled optional feature from taking the whole catalogue down, which is
 * the failure mode that actually happened on this shop.
 */
const EMPTY_OFFERS = (): Awaited<ReturnType<typeof loadOffers>> => new Map();

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
     * 0075 — THE PRE-ORDER COUNTER FOR THE CHOSEN MODEL (`capacityFrom`).
     * Absent or null = the model has no pre-order cell, which is UNTRACKED and
     * is how every product behaved before 0075: unlimited pre-orders. It is
     * never derived from `inventory`, because the two describe different
     * physical facts.
     */
    capacity?: CapacitySnapshot | null;
    /** The route the buyer chose, when they have. It selects WHICH capacity
     *  counter answers — never WHICH ORDER TYPE the line is (DECISION 4). */
    transportMethod?: string | null;
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
    // `resolveStock` only ever answers with a SHELF scope; the two capacity
    // scopes are reached through `resolveCapacity`, which this block never
    // calls and whose answer lives in `preorder.capacity` below. Narrowed
    // here rather than widened in the response type, so `stock.scope` cannot
    // start meaning "a pre-order quota" to a client that reads it.
    const answered = res.targets[0]?.scope;
    scope =
      answered && answered !== 'preorder' && answered !== 'preorder_transport'
        ? answered
        : input.inventory.inventory_mode === 'BASE'
          ? 'base'
          : 'variant';
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

  /**
   * 0075 — WHAT ONE ROUTE'S COUNTER SAYS. `resolveCapacity` holds the whole
   * shared-versus-independent rule, so this function never re-implements it:
   * ask it per method and it answers with the route's own quota if there is
   * one and the model's shared pool otherwise.
   */
  const capacityFor = (method: string) => resolveCapacity(input.capacity ?? null, method);

  const transports: TransportOptionView[] = doc.preorder_transports
    .filter((t) => t.active !== false)
    .map((t) => {
      const own = Number.isInteger(t.commission_iqd) ? (t.commission_iqd as number) : null;
      const fallback = defaults.find((d) => d.method === t.method);
      const commission = own !== null ? own : fallback ? fallback.commission_iqd : null;
      return { method: t.method, commission_iqd: commission, configured: commission !== null };
    });
  const routes: PreorderRouteCapacity[] = transports.map((t) => {
    const cap = capacityFor(t.method);
    const target = cap.targets[0] ?? null;
    // UNTRACKED IS SELLABLE. `available === null` means no limit was claimed,
    // so the route is usable on the strength of its commission alone — exactly
    // how every pre-order in the catalogue behaved before 0075. Zero is a
    // tracked counter that is empty, and it refuses. `COALESCE(capacity, 0)`
    // here would close the whole catalogue.
    const hasRoom = cap.available === null || cap.available > 0;
    return {
      method: t.method,
      available: cap.available,
      scope:
        target && (target.scope === 'preorder' || target.scope === 'preorder_transport') ? target.scope : null,
      scope_id: target?.scope_id ?? '',
      usable: t.configured && hasRoom,
      reason: !t.configured ? 'TRANSPORT_COMMISSION_UNCONFIGURED' : hasRoom ? null : 'PREORDER_CAPACITY_EXHAUSTED',
    };
  });
  const preorderUsable = preorderEnabled && routes.some((r) => r.usable);
  const preorderReason = preorderEnabled
    ? preorderUsable
      ? null
      : transports.length === 0
        ? 'NO_TRANSPORT_OFFERED'
        : // A route that is priced but has no units left is a DIFFERENT refusal
          // from one nobody priced, and the customer is owed the difference:
          // "we are not selling this by sea" versus "this month's sea quota is
          // full". Reported only when at least one route really is priced.
          transports.some((t) => t.configured)
          ? 'PREORDER_CAPACITY_EXHAUSTED'
          : 'TRANSPORT_COMMISSION_UNCONFIGURED'

    : 'PREORDER_NOT_ENABLED';

  /**
   * THE COUNTER THIS LINE WOULD CONSUME AS A PRE-ORDER, for the route the
   * buyer chose. With no route chosen the shared pool answers, which is the
   * honest "before you pick air/sea/land" figure: it is what every route that
   * has no quota of its own will spend from.
   */
  const chosenCapacity = capacityFor(String(input.transportMethod ?? ''));
  const capacityTarget = chosenCapacity.targets[0] ?? null;

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
   * The pre-order branch discards the SHELF `available`, and that is right: a
   * pre-order is bought from a supplier, not off a shelf. What it does NOT
   * discard, since 0075, is the pre-order's OWN counter — an untracked
   * capacity still gives the old unlimited ceiling, a tracked one caps the
   * stepper at what is really left, and the two are told apart by null-versus-
   * zero and never by `COALESCE`.
   *
   * A composition row is clamped on BOTH branches, by its own
   * `max_qty_per_order` as well: it may be a pre-order bundle carrying tracked
   * direct components that reserve normally.
   */
  const compositionCap = Math.min(QTY_CEILING, Math.max(0, Math.trunc(input.maxQtyPerOrder ?? QTY_CEILING)));
  const preorderCap = chosenCapacity.available === null ? QTY_CEILING : Math.min(QTY_CEILING, chosenCapacity.available);
  const maxQty =
    mode === 'unavailable'
      ? 0
      : isComposition
        ? Math.min(compositionCap, available === null ? QTY_CEILING : available)
        : mode === 'preorder'
          ? preorderCap
          : available === null
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
    preorder: {
      enabled: preorderEnabled,
      usable: preorderUsable,
      reason: preorderReason,
      transports,
      routes,
      capacity: {
        tracked: chosenCapacity.tracked,
        scope:
          capacityTarget && (capacityTarget.scope === 'preorder' || capacityTarget.scope === 'preorder_transport')
            ? capacityTarget.scope
            : null,
        scope_id: capacityTarget?.scope_id ?? '',
        available: chosenCapacity.available,
        max_qty: preorderCap,
      },
    },
    qty_ok: input.qty === undefined ? true : input.qty >= 1 && input.qty <= maxQty,
  };
}

/**
 * THE ORDER TYPE ONE CART LINE ALREADY IS — the checkout's own rule, in the one
 * place both doors read it from (0073/0075, DECISION 4).
 *
 * `POST /api/orders` types every bare line as: the stored `fulfillment_type`
 * when the customer stated one, else pre-order when the line carries a
 * transport method, else direct sale. That chain decided which counter the
 * sale moves while `GET /api/cart` knew only the FIRST step of it, so a LEGACY
 * line — `cart_items.fulfillment_type = ''` with a stored `transport_method`,
 * exactly the shape migration 0073 leaves behind — was described by the cart
 * as a direct sale off the shelf and then judged and refused by the door as a
 * pre-order against a full import quota. Two answers about two different
 * counters for one line.
 *
 * `''` IS RETURNED WHEN THE LINE ITSELF SAYS NOTHING — no stored type and no
 * transport — because this function answers about the ROW's own two columns
 * and nothing else. That absence is a DEFAULT to apply, not a fact to invent
 * here, and applying it is `lineOrderType` below: one function, so the cart
 * and the checkout cannot default the same row two different ways.
 */
export function statedOrderType(stated: string, transportMethod: string): '' | OrderType {
  if (stated === 'pre_order' || stated === 'direct_sale') return stated;
  return transportMethod ? 'pre_order' : '';
}

/**
 * THE ORDER TYPE ONE ROW IS, WITH THE DEFAULT APPLIED — the ONE answer the
 * read model, the cart doors and the checkout all judge a line by (DECISION 4).
 *
 * `statedOrderType` above answers only about the row's own two columns, and
 * returns '' for a row that states NEITHER a type NOR a transport. That '' was
 * then resolved twice, in two places, into two different answers: `GET
 * /api/cart` left `saleAvailability`'s DESCRIPTIVE fallback standing (direct
 * sale when the shelf has units, else pre-order), while `POST /api/orders`
 * applied `|| 'direct_sale'` and judged the SHELF. On a dual-mode model with
 * an empty shelf and an open import quota that is a live pre-order counter in
 * the cart and an out-of-stock shelf at the door — one row, two counters.
 *
 * So the DEFAULT is taken from the same description both sides already hold:
 * `saleAvailability`'s own fallback, which is the answer a page gets and the
 * answer the cart shows. The caller passes the availability it computed for
 * that row — same selection, same inventory, same capacity — so both sides ask
 * one question of one function instead of two that happen to agree.
 *
 * '' IS STILL RETURNED for a row the description cannot type at all (`mode:
 * "unavailable"`): there is no usable counter to default to, the line is
 * refused either way, and inventing a type there would only change which
 * refusal is named. The checkout keeps its `|| 'direct_sale'` for that case,
 * byte for byte what it did before.
 */
export function lineOrderType(a: SaleAvailability, stated: string, transportMethod: string): '' | OrderType {
  const declared = statedOrderType(stated, transportMethod);
  if (declared) return declared;
  return a.mode === 'preorder' ? 'pre_order' : a.mode === 'direct_sale' ? 'direct_sale' : '';
}

/**
 * THE ORDER TYPE THE CUSTOMER STATED IS NOT A PREFERENCE THE DOOR MAY OVERRULE.
 *
 * `saleAvailability` DESCRIBES a product: with no stated type it falls back
 * from direct sale to pre-order so a page can still show a buy button, and
 * that fallback is right for a page. It is wrong for a DOOR. A customer who
 * chose "buy now" on a model whose last unit has just gone must be told it is
 * gone — not handed a pre-order with a different price, a different wait and a
 * different counter behind their back. The same in reverse: a pre-order whose
 * import quota is full must not become a direct sale off a shelf the customer
 * never asked about.
 *
 * Returns the refusal for a stated type that cannot be used, or null when the
 * line may proceed. `stated` empty — a legacy line, or a product that sells
 * exactly one way — returns null and keeps the old behaviour untouched.
 */
export function unusableOrderType(
  a: SaleAvailability,
  stated: string
): { code: string; message: string } | null {
  if (stated !== 'direct_sale' && stated !== 'pre_order') return null;
  // THE ROUTE THE CUSTOMER CHOSE, NOT THE PRODUCT'S BEST ROUTE. `modes` says
  // whether the product can be pre-ordered AT ALL — true while any one route
  // has room — so a customer who picked the one full route would otherwise be
  // told "only 0 left" (a quantity problem) instead of "this route's quota is
  // full" (a route problem they can solve by choosing another).
  if (stated === 'pre_order' && a.preorder.capacity.tracked && (a.preorder.capacity.available ?? 0) <= 0) {
    return { code: 'PREORDER_CAPACITY_EXHAUSTED', message: 'The pre-order quota for this selection is full.' };
  }
  const mode = a.modes.find((m) => m.type === stated);
  if (mode?.usable) return null;
  const code = mode?.reason ?? (stated === 'pre_order' ? 'PREORDER_NOT_ENABLED' : 'DIRECT_SALE_NOT_ENABLED');
  return {
    code,
    message:
      code === 'OUT_OF_STOCK'
        ? 'That selection is out of stock.'
        : code === 'PREORDER_CAPACITY_EXHAUSTED'
          ? 'The pre-order quota for this selection is full.'
          : stated === 'pre_order'
            ? `This item cannot be pre-ordered right now (${code})`
            : `This item cannot be bought directly right now (${code})`,
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
    preorder: {
      enabled: false,
      usable: false,
      reason: 'PREORDER_NOT_ENABLED',
      transports: [],
      routes: [],
      capacity: { tracked: false, scope: null, scope_id: '', available: null, max_qty: 0 },
    },
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
  /**
   * Loaded for EVERY viewer, member or not. A guest earns no benefit, but §9
   * asks this page to say what a membership would be worth on this exact
   * product — and a teaser computed from anything other than the live rules is
   * the hardcoded promise this whole system exists to remove. Both tables are
   * a few rows.
   */
  const [benefitRules, ancestry] = await Promise.all([activeBenefitRules(c.env.DB), catalogAncestry(c.env.DB)]);
  return {
    benefitRules,
    catalogAncestry: ancestry,
    benefitNowIso: new Date().toISOString(),
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

/**
 * §8 AND §9 — WHAT EACH MEMBERSHIP WOULD PAY FOR THIS EXACT SELECTION.
 *
 * A member sees their own price everywhere else on this page; this is the
 * OTHER half — the honest, specific number that makes "PRO price 1,665,000,
 * you save 185,000" a fact rather than a slogan. It is resolved through
 * `resolveUnitPrice` with the same rules the checkout reads, so the figure a
 * visitor is shown before subscribing is the figure they will be charged
 * after.
 *
 * `null` for a tier means there is nothing to promise: no explicit member
 * price on the line and no rule that fits in a unit price. Nothing here
 * invents an "up to" number.
 */
export interface MembershipPreviewTier {
  unit_iqd: number;
  regular_iqd: number;
  saving_iqd: number;
  rule_id: string | null;
}

function previewStatus(tier: 'prime' | 'pro'): TierStatus {
  return { tier, active: true, expires_at: null, pending_launch: null, gated_benefits: [] };
}

export function membershipPreview(
  ctx: PricingCtx,
  doc: ProductDoc,
  sel: { optionId: string | null; colorId: string | null; transportMethod?: string | null },
  isPrinter: boolean
): { prime: MembershipPreviewTier | null; pro: MembershipPreviewTier | null } {
  const target = {
    product_id: doc.id,
    category_id: doc.category_id,
    sub_category_id: doc.sub_category_id,
    ancestry: ancestryFor(ctx.catalogAncestry, doc.category_id, doc.sub_category_id),
  };
  const forTier = (tier: 'prime' | 'pro'): MembershipPreviewTier | null => {
    const r = resolveUnitPrice({
      product: doc,
      optionId: sel.optionId,
      colorId: sel.colorId,
      transportMethod: sel.transportMethod ?? null,
      tier,
      tierActive: true,
      proPolicy: ctx.proPolicy,
      transportDefaults: ctx.transportDefaults,
      memberFallback: fallbackFor(ctx.benefitRules, previewStatus(tier), target, ctx.benefitNowIso),
      isPrinter,
    });
    if (r.errors.length > 0) return null;
    const saving = r.regular_iqd - r.applied_iqd;
    if (saving <= 0) return null;
    return {
      unit_iqd: r.applied_iqd,
      regular_iqd: r.regular_iqd,
      saving_iqd: saving,
      rule_id: tier === 'pro' ? r.member_rule.pro : r.member_rule.prime,
    };
  };
  return { prime: forTier('prime'), pro: forTier('pro') };
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
      memberFallback: benefitFallbackFor(ctx, doc),
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
 * EVERY PRICE THE CUSTOMER CAN REACH IN ONE TAP, RESOLVED ONCE, ON THE SERVER.
 *
 * THE DEFECT THIS CLOSES. The product page had exactly one source for a price:
 * `POST /api/products/:slug/quote`, behind a 220 ms debounce. So every touch of
 * an option or a colour cost a debounce plus a network round trip before the
 * figure could change — and while that was in flight the page had nothing to
 * show. On an Iraqi mobile connection that is most of a second of «يجري تحديث
 * السعر…» on every single tap of the control whose entire job is to set the
 * price.
 *
 * WHY THE ANSWER IS HERE AND NOT IN THE BROWSER. The obvious fix is to run the
 * resolver client-side. It is the wrong one. `applyOfferToResolved` can replace
 * the whole ladder while a scheduled window is live (§9), `offerEligible` gates
 * that window on a membership the browser cannot verify, and `proPolicy` is a
 * store setting that is deliberately not public. A browser resolver would be
 * right until the day an offer went live and then quietly disagree with the
 * checkout — the page/cart/door split §15.4 case 9 exists to prevent.
 *
 * So the server answers all of them at once, with the code that already prices
 * the door, and the page reads the answer. `publicWithDisplayPrice` ALREADY
 * walks base + every option + every colour on this same request (that loop is
 * where `display_price_iqd` and `display_from` come from) and throws away
 * everything but the minimum and the maximum. This keeps the numbers.
 *
 * COST. `resolveUnitPrice` is a pure function over a document already in
 * memory: no D1 query, no await, no I/O. The extra work is the COMBINATIONS —
 * bounded by `MAX_LEVELS` below — and the payload, which is three integers per
 * reachable selection.
 *
 * WHAT A LEVEL PRICE MEANS. It is the selection priced with NO transport and
 * NO extended-warranty plan: the state the page opens in, and the one it is in
 * for all but the last tap before checkout. When a transport or a plan IS
 * chosen the quote's `unit_subtotal_iqd` is the authority and the page marks
 * the level figure provisional until it lands. `applied_iqd` is never
 * provisional — a transport does not move the ladder.
 */

/** One selection's prices, as the door would charge them today. */
export interface PriceLevel {
  /** The unit ladder price at the viewer's tier, offer applied. */
  applied_iqd: number;
  /** The same selection's regular price — the member strikethrough. */
  regular_iqd: number;
  /** applied + the direct-sale premium: what the page multiplies by quantity. */
  unit_subtotal_iqd: number;
  /** Which rung won — the page's PRO/PRIME badge, never inferred in the browser. */
  applied_tier: ResolvedPrice['applied_tier'];
}

export interface PriceLevels {
  base: PriceLevel;
  /** By option id. */
  option: Record<string, PriceLevel>;
  /** By colour id. */
  color: Record<string, PriceLevel>;
  /** By `optionId + '|' + colorId` — the page's own selection key. */
  combo: Record<string, PriceLevel>;
  /**
   * FALSE when the combination grid was too large to publish and only the
   * single-level prices are here. The page must not present a combination
   * price as final while this is false — it waits for the quote, exactly as
   * it did before this field existed. Honest by construction: a missing key
   * and a wrong key are not the same thing.
   */
  complete: boolean;
}

/**
 * The ceiling on published selections. A catalogue with 12 options and 12
 * colours reaches 144 combinations, ~9 KB of JSON — still cheap against the
 * round trip it removes. Past this the payload stops paying for itself and
 * the page falls back to the quote for combinations only; base, option and
 * colour prices are always published, because those are what the first tap
 * reaches.
 */
const MAX_LEVELS = 240;

/**
 * Resolve one selection exactly as `publicWithDisplayPrice` and the quote do —
 * same resolver, same context, same offer rule, same eligibility check.
 *
 * `isPrinter` is deliberately not threaded: it feeds `effectiveBaseMonths` for
 * warranty totals only (packages/pricing/src/pricing.ts:721) and cannot move a
 * unit price, and no level here carries a warranty plan.
 */
function levelPrice(
  doc: ProductDoc,
  ctx: PricingCtx,
  offer: OfferView | null | undefined,
  optionId: string | null,
  colorId: string | null,
  now: number
): PriceLevel {
  let r = resolveUnitPrice({
    product: doc,
    optionId,
    colorId,
    tier: ctx.tier,
    tierActive: ctx.tierActive,
    proPolicy: ctx.proPolicy,
    transportDefaults: ctx.transportDefaults,
    memberFallback: benefitFallbackFor(ctx, doc),
  });
  if (offer && (doc.composition ?? '') === '' && offerEligible(ctx.tierStatus, offer, now).ok) {
    r = applyOfferToResolved(r, offer, ctx.tier, ctx.tierActive, now).resolved;
  }
  return {
    applied_iqd: r.applied_iqd,
    regular_iqd: r.regular_iqd,
    unit_subtotal_iqd: r.unit_subtotal_iqd,
    applied_tier: r.applied_tier,
  };
}

/**
 * Every selection the choosers can reach, priced. Pure and synchronous.
 *
 * A colour that is sold with only some options contributes only those pairs —
 * `option_ids` is the link the relational rows carry, and an empty/absent one
 * means the colour is offered with every option.
 */
export function priceLevels(
  doc: ProductDoc,
  ctx: PricingCtx,
  offer: OfferView | null | undefined,
  now: number
): PriceLevels {
  const options = doc.options.filter((o) => o.active !== false);
  const colors = doc.colors.filter((c) => c.active !== false);
  const at = (optionId: string | null, colorId: string | null) =>
    levelPrice(doc, ctx, offer, optionId, colorId, now);

  const option: Record<string, PriceLevel> = {};
  for (const o of options) option[o.id] = at(o.id, null);
  const color: Record<string, PriceLevel> = {};
  for (const c of colors) color[c.id] = at(null, c.id);

  const pairs: Array<[string, string]> = [];
  for (const o of options) {
    for (const c of colors) {
      const links = c.option_ids && c.option_ids.length > 0 ? c.option_ids : c.option_id ? [c.option_id] : [];
      if (links.length > 0 && !links.includes(o.id)) continue;
      pairs.push([o.id, c.id]);
    }
  }
  const complete = 1 + options.length + colors.length + pairs.length <= MAX_LEVELS;
  const combo: Record<string, PriceLevel> = {};
  if (complete) for (const [o, c] of pairs) combo[`${o}|${c}`] = at(o, c);

  return { base: at(null, null), option, color, combo, complete };
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
      memberFallback: benefitFallbackFor(ctx, doc),
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
    // The COMPONENTS carry the member's configured rule; the bundle's own
    // price does not (see `CompositionViewer.memberFallbackFor`).
    memberFallbackFor: (doc) => benefitFallbackFor(ctx, doc),
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
/**
 * WHAT A CARD ACTUALLY NEEDS — and it is not the whole product.
 *
 * THE DEFECT. `/api/home` returns 30 products and `/api/products` up to 50,
 * and every one of them was serialized through the FULL public projection: 42
 * keys from `projectPublic` plus 14 legacy aliases plus the six display keys —
 * the complete option ladder, every colour with its four price columns, the
 * spec groups, the usage guide with its per-step media, the description in
 * three languages, the warranty plans, the content blocks. A printer document
 * measures tens of kilobytes on its own; a home page shipped hundreds of
 * kilobytes to megabytes of JSON so that a grid could draw a picture, a name
 * and a price.
 *
 * Every consumer was enumerated before this list was written — `Home.tsx`,
 * `Products.tsx`, `Profile.tsx`, `ProductCard.tsx`, `CardPrice.tsx` and
 * `productImage.ts` — and between them they read exactly the fields below.
 * (`Bundles.tsx` reads only `categories` from `/api/home`; it was paying for
 * thirty product documents it never opened.)
 *
 * WHAT THIS DELIBERATELY DOES NOT CHANGE. The SQL stays `SELECT *` and the
 * resolver still runs over the whole document: `display_price_iqd` is computed
 * by walking every option and colour (that loop is what makes the card price
 * the cheapest way to buy the product), so narrowing the QUERY would change
 * prices. This narrows only what is SERIALIZED, after the price is resolved.
 * No number moves.
 *
 * It is also never applied to a composition row: `compositionCard` already
 * returns its own deliberately narrow shape, and a locked bundle's card strips
 * member prices there. Running this over it instead would be a different bug.
 */
const CARD_FIELDS = [
  'id',
  'slug',
  // A composition links to /bundles/<product_slug>; an ordinary row has none.
  'product_slug',
  'name',
  'status',
  // `productImage.ts` prefers the primary media entry and falls back to the
  // published `images` list, so a card needs both.
  'media',
  'images',
  'price_iqd',
  'display_price_iqd',
  'display_regular_iqd',
  'display_prime_iqd',
  'display_pro_iqd',
  'display_applied_tier',
  'display_from',
  // Set alongside `offer` when a live window has a PLUS rung.
  'display_plus_iqd',
  // The countdown and the members-only lock chip.
  'offer',
] as const;

export function cardShape(out: Record<string, unknown>): Record<string, unknown> {
  const card: Record<string, unknown> = {};
  for (const k of CARD_FIELDS) {
    if (out[k] !== undefined) card[k] = out[k];
  }
  return card;
}

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
    degradeIfSchemaMissing('offers (migration 0060)', () => loadOffers(c.env.DB, results.map((r) => subjectOf(String(r.id)))), EMPTY_OFFERS()),
    // §8.2 row 18, for the LISTING too: a card carries `stock`, and a grid
    // captured before and after a purchase is the same two GETs.
    degradeIfSchemaMissing('mystery pools (migration 0061)', () => activePoolProductIds(c.env.DB, results.map((r) => String(r.id))), new Set<string>()),
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
      // A composition card has its own narrow shape, and a LOCKED one has its
      // member prices stripped in there. `cardShape` must not touch it.
      if (b) return compositionCard(b, ctx);
      return cardShape(
        publicWithDisplayPrice(
          p,
          ctx,
          views.get(String(p.id)),
          undefined,
          offers.get(offerKey(subjectOf(String(p.id)))),
          pooled.has(String(p.id))
        )
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
      memberFallback: benefitFallbackFor(ctx, doc),
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
    const poolMember = (await degradeIfSchemaMissing('mystery pools (migration 0061)', () => activePoolProductIds(c.env.DB, [String(row.id)]), new Set<string>())).size > 0;
    // Hoisted out of the call below: the SAME window has to price the display
    // block and the per-selection levels, or the page would paint an offer
    // price on the card and a ladder price the moment a variant was tapped.
    const offer = (await degradeIfSchemaMissing('offers (migration 0060)', () => loadOffers(c.env.DB, [subjectOf(String(row.id))]), EMPTY_OFFERS())).get(offerKey(subjectOf(String(row.id))));
    const out = publicWithDisplayPrice(row, ctx, relations, undefined, offer, poolMember);
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
      // §8/§9: the base selection's member prices, from the live rules, so the
      // page can state the benefit on first paint rather than waiting for the
      // debounced quote to say what a membership is worth here.
      membership_preview: membershipPreview(ctx, doc, { optionId: null, colorId: null }, isPrinter),
      // EVERY SELECTION THE CHOOSERS CAN REACH, PRICED HERE (see `priceLevels`).
      // The page paints the exact figure on the same frame as the tap, and the
      // debounced quote becomes a confirmation rather than a prerequisite.
      price_levels: priceLevels(doc, ctx, offer, Date.now()),
      // The final price of every way to get the BASE selection (the quote
      // re-computes them per selection) — the page's fulfilment pills and
      // transport rows read these, and compute nothing.
      pricing_modes: pricingModes(doc, ctx, { optionId: null, colorId: null }, isPrinter),
      // §7.2 — the sale mode the page may DEFAULT to, derived from the real
      // stock model and the admin pre-order policy (never from the browser).
      //
      // NO `capacity` HERE, AND THAT IS THE HONEST ANSWER. Capacity is
      // configured per (model x pre-order) and this block describes the page
      // before any model has been chosen. Reporting the largest model's quota
      // would promise units of a model the customer has not picked; reporting
      // the smallest would hide a model that is wide open. The per-selection
      // quote below answers with the real counter the moment a model is
      // tapped, and the cart and the checkout re-derive it server-side
      // regardless of what this block said.
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

  const rawOptionId = typeof body.optionId === 'string' && body.optionId ? body.optionId : null;
  /**
   * §7: ONE VALUE PER OPTION GROUP — THE WHOLE SELECTION, exactly as the cart
   * add door parses it.
   *
   * This endpoint used to read `optionId` alone and hand `saleAvailability` a
   * single value, so on a MULTI-GROUP product the page published a different
   * counter from the one the add door charges: a product whose only tracked
   * pre-order quota lives on the SECOND group's value answered
   * `preorder.capacity {tracked: false, available: null, max_qty: 99}` and
   * `qty_ok: true` — a stepper to 99 — and `POST /api/cart/items` then refused
   * the same selection `QTY_UNAVAILABLE` "Only 1 left". A descriptive pass and
   * the door must answer about the SAME counter; the only way to guarantee
   * that is to ask with the same selection.
   *
   * The legacy single `optionId` is folded in (and kept first when it is the
   * only thing sent), so a client that has not learned the field is byte-for-
   * byte unaffected.
   */
  const rawValueIds: unknown[] = Array.isArray(body.optionValueIds) ? body.optionValueIds : [];
  const optionValueIds: string[] = [
    ...new Set<string>([
      ...rawValueIds.filter((x): x is string => typeof x === 'string' && x.length > 0),
      ...(rawOptionId ? [rawOptionId] : []),
    ]),
  ].slice(0, 12);
  // The resolver prices ONE option and the first selected value carries the
  // override — `resolveCartLine`'s rule, so the quote and the cart cannot
  // price the same selection differently. With only `optionId` sent this IS
  // `optionId`, which is what every existing caller sends.
  const optionId = optionValueIds[0] ?? null;
  const colorId = typeof body.colorId === 'string' && body.colorId ? body.colorId : null;
  const transportMethod = typeof body.transportMethod === 'string' ? body.transportMethod : null;
  // 0073. The ORDER TYPE as its own answer. Absent = the page has not asked
  // (the product sells one way), and the resolver infers it exactly as before.
  const fulfillmentType =
    body.fulfillmentType === 'direct_sale' || body.fulfillmentType === 'pre_order' ? body.fulfillmentType : null;
  const warrantyPlanId = typeof body.warrantyPlanId === 'string' && body.warrantyPlanId ? body.warrantyPlanId : null;

  const resolved = resolveUnitPrice({
    product: doc,
    optionId,
    colorId,
    transportMethod,
    fulfillmentType,
    warrantyPlanId,
    tier: ctx.tier,
    tierActive: ctx.tierActive,
    proPolicy: ctx.proPolicy,
    transportDefaults: ctx.transportDefaults,
    memberFallback: benefitFallbackFor(ctx, doc),
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
    // §8/§9: what PREMIUM and PRO pay for THIS selection, from the live rules.
    // The page shows the viewer's own line as a price, and the other tier's as
    // the one-line invitation §9 asks for — never a gold advertisement.
    membership_preview: membershipPreview(ctx, doc, { optionId, colorId, transportMethod }, isPrinter),
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
      coarseStock: (await degradeIfSchemaMissing('mystery pools (migration 0061)', () => activePoolProductIds(c.env.DB, [String(row.id)]), new Set<string>())).size > 0,
      optionValueIds,
      colorId,
      qty,
      transportDefaults: ctx.transportDefaults,
      inventory: snapshotFrom(relations, {
        stock: doc.stock,
        reserved: Number(row.stock_reserved ?? 0),
        low_stock_threshold: (row.low_stock_threshold as number | null) ?? null,
      }),
      links: relations.links,
      // THE ORDER TYPE THE CUSTOMER STATED WINS. The transport is only the
      // fallback for a client that has not learned to send `fulfillmentType`
      // yet (0073's own rule), and it is an inference about the ORDER TYPE —
      // never about the payment method, which cannot change either (DECISION 4).
      preferredType: fulfillmentType ?? (transportMethod ? 'pre_order' : null),
      // 0075. The pre-order counter for the MODEL this selection names, and
      // the route it named, so the page's transport rows show what is really
      // left instead of an unconditional 99. THE WHOLE SELECTION, never one
      // value of it: `capacityFrom` scans the selected values for the one that
      // carries a tracked pre-order cell and REFUSES an ambiguous pair, and a
      // single value hides both the quota on another group's value and the
      // ambiguity the door would raise.
      capacity: capacityFrom(relations, optionValueIds),
      transportMethod,
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
    degradeIfSchemaMissing('mystery pools (migration 0061)', () => activePoolProductIds(c.env.DB, [...homeRows.keys()].map(String)), new Set<string>()),
  ]);

  return c.json({
    success: true,
    settings: safeSettings,
    discounted: discounted.results.map((p) =>
      cardShape(publicWithDisplayPrice(p, ctx, homeViews.get(String(p.id)), undefined, null, homePooled.has(String(p.id))))
    ),
    latest: latest.results.map((p) =>
      cardShape(publicWithDisplayPrice(p, ctx, homeViews.get(String(p.id)), undefined, null, homePooled.has(String(p.id))))
    ),
    categories: categories.results.filter((r) => Number(r.product_count) > 0),
    brands: brands.results.filter((r) => Number(r.product_count) > 0),
  });
});
