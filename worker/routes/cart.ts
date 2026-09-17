import { Hono } from 'hono';
import { cartShippingType, typeForTransport, type ShippingType } from '../lib/shippingType';
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
import { cartLineSelect } from '../lib/cartLineProjection';
import type { AppContext } from '../lib/types';
import { safeParse } from '../lib/types';
import {
  canonicalOptionValueIds,
  optionValueIdsJson,
  optionValueIdsInRelationOrder,
  sameOptionValueIds,
} from '../lib/cartSelectionIdentity';
import { requireAuth, badRequest, conflict, notFound, int, str, oneOf, HttpError } from '../lib/http';
import { newId } from '../lib/crypto';
import { dailyUserHash, emitBestEffort, eventsEnabled, waitUntilFrom } from '../lib/eventBus';
import { AddToCartV1 } from '@levonis/contracts/events/v1/AddToCart';
import { getSettings } from '../lib/settings';
import { parseProductRow, primaryMedia, type ProductDoc } from '../lib/productModel';
import {
  applyRelations,
  capacityFrom,
  EMPTY_RELATIONS,
  loadRelationsViews,
  publicRelations,
  snapshotFrom,
} from '../lib/productOverlay';
import type { ProductRelationsView } from '../lib/productOverlay';
import { validateSelection } from '../lib/productRelations';
import { validateCoupon } from '../lib/membershipOps';
import { rateLimit } from '../lib/ratelimit';
import { lineOrderType, saleAvailability, unusableOrderType } from './products';
import type { SaleAvailability } from './products';

/**
 * The one rule for an incomplete selection, shared by add, update and the
 * checkout revalidation in routes/orders.ts: a product that has active
 * options demands one (OPTION_REQUIRED), one that has active colours demands
 * a colour (COLOR_REQUIRED). The code is the first selection error so the
 * client can point at the right control.
 */
export function refuseIncompleteSelection(availability: SaleAvailability, label?: string): void {
  if (availability.selection.complete) return;
  const errors = availability.selection.errors;
  throw badRequest(
    `${label ? `"${label}": ` : ''}Choose ${errors.includes('OPTION_REQUIRED') ? 'an option' : 'a colour'} before adding this item (${errors.join(', ')})`,
    errors[0] ?? 'SELECTION_INCOMPLETE'
  );
}
import {
  resolveUnitPrice,
  proPolicyFrom,
  type PreorderPricing,
  type ProPricingPolicy,
  type ResolvedPrice,
  type Tier,
} from '../lib/pricing';
import { pricingTierContext, type TierStatus } from '../lib/entitlements';
import { applyOfferToResolved, loadOffers, offerEligible, offerKey, offerPriceRefusal, subjectOf, type OfferView } from '../lib/offers';
import {
  activeBenefitRules,
  ancestryFor,
  catalogAncestry,
  degradeIfSchemaMissing,
  fallbackFor,
  resolveMembershipBenefits,
  resolveOrderBenefits,
} from '../lib/membershipBenefits';
import type { BenefitLineInput } from '../lib/membershipBenefits';
import type { BenefitRule } from '@levonis/pricing/membershipBenefits';
import type { MemberFallback } from '@levonis/pricing/pricing';

import { compositionKey, loadBundleComponents, type BundleComponentRow } from '../lib/bundleComposition';
import {
  resolveCompositionLines,
  compositionMaxQty,
  type ComponentChoice,
  type CompositionLineInput,
  type ResolvedBundle,
} from '../lib/bundleRead';
import {
  applyMysteryToBundles,
  cartChoiceStatements,
  cartCompositionBlock,
  componentFeesIqd,
  keyInput,
  loadCartChoices,
  loadCompositionRows,
  mysteryFamilyOf,
  mysteryKeyInput,
  parseBundleChoices,
  physicalLines,
  refuseComposition,
  refusePhysicalLines,
  resolveCartMystery,
  resolveChoiceSet,
  resolveLineTransport,
} from '../lib/bundleCart';
import {
  mysteryPhysicalLines,
  refuseMystery,
  resolveMysteryLines,
  type MysteryContext,
} from '../lib/mysteryLine';
import { activePoolProductIds } from '../lib/mysteryDraw';
import { randomSeedHex } from '../lib/farm/rng';
import { bumpMetric, metricStatement } from '../lib/compositionAnalytics';

/** The refusal codes that mean "there is not enough of it", and only those.
 *  A membership lock or a closed window is not a stock problem and must not
 *  be counted as one (§12). */
const OOS_REFUSALS = new Set(['OUT_OF_STOCK', 'QTY_UNAVAILABLE', 'MYSTERY_NO_ELIGIBLE_STOCK', 'BUNDLE_OPTIONAL_UNAVAILABLE']);
import { supportEligibleProductIds } from '../lib/membershipOps';
import { isPrinterProduct, printerProductIds } from '../lib/printerIdentity';
import { pricedPlans, refuseNonPrinterWarranty } from '../lib/warrantyPlans';
import { productImageForSelection } from '../lib/productSelectionImage';

export const cartRoutes = new Hono<AppContext>();
cartRoutes.use('*', requireAuth);

/** 409 when a re-add would silently change the line's extended-warranty choice. */
export const CART_WARRANTY_CONFLICT = 'CART_WARRANTY_CONFLICT';

/**
 * The tier the cart prices with — the SAME PRO purchase context the product
 * page and the checkout use (worker/lib/entitlements.ts), judged at the
 * customer's default address: an active PRO whose default address is not the
 * approved one sees the surcharge here exactly as the door will charge it.
 */
async function cartTier(c: Context<AppContext>): Promise<{ tier: Tier; active: boolean; status: TierStatus }> {
  const user = c.get('user')!;
  const ctx = await pricingTierContext(c.env.DB, user.id);
  // The whole TierStatus rides along because `offerEligible` (§9) needs the
  // tier, whether it is active AND which benefits an admin restriction case
  // has paused — and `getTierStatus` performs two writes per call, so it is
  // resolved once per request and passed down, never once per line (§14).
  return { tier: ctx.tierStatus.tier, active: ctx.pricingTierActive, status: ctx.tierStatus };
}

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
  /**
   * THE CONFIGURED MEMBERSHIP BENEFITS (migration 0074), loaded once per
   * request and applied per line.
   *
   * `status` is the SERVER's resolved membership, never a tier from a request
   * body, and it is null for a guest or an admin preview — in which case no
   * rule applies and every price is the regular one. The rules travel with the
   * context rather than being re-queried per line because `priceLines` is a
   * synchronous pure function the checkout calls up to three times.
   */
  benefitRules: readonly BenefitRule[];
  benefitStatus: TierStatus | null;
  /**
   * The section tree as an ancestor index, so a rule written on "Printers"
   * reaches a product filed three levels down. Null where the caller had no
   * reason to read it, which degrades to exact section matching.
   */
  catalogAncestry: Map<string, string[]> | null;
  /** Frozen per request so three passes over the same cart cannot disagree
   *  about whether a dated rule was live. */
  nowIso: string;
}

/**
 * The rule that applies to ONE product for this member, in the shape
 * `resolveUnitPrice` consults where a line has no explicit member price.
 *
 * The product's section and sub-section come from the product ROW. A cart
 * payload could name any category it liked, and a discount that trusts the
 * browser's word for what a product is would be a discount anyone can grant
 * themselves.
 */
export function memberFallbackFor(
  ctx: PricingContext,
  doc: { category_id?: string | null; sub_category_id?: string | null; id?: string | null }
): MemberFallback {
  if (!ctx.benefitStatus) return { pro: null, prime: null };
  return fallbackFor(
    ctx.benefitRules,
    ctx.benefitStatus,
    {
      product_id: doc.id ?? null,
      category_id: doc.category_id ?? null,
      sub_category_id: doc.sub_category_id ?? null,
      ancestry: ancestryFor(ctx.catalogAncestry, doc.category_id ?? null, doc.sub_category_id ?? null),
    },
    ctx.nowIso
  );
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

export function pricingContextFrom(
  settings: Record<string, unknown>,
  benefits?: {
    rules: readonly BenefitRule[];
    status: TierStatus | null;
    ancestry?: Map<string, string[]> | null;
    nowIso?: string;
  }
): PricingContext {
  return {
    proPolicy: proPolicyFrom(settings.proPricingPolicy),
    transportDefaults: transportDefaultsFrom(settings.preorderTransportDefaults),
    benefitRules: benefits?.rules ?? [],
    benefitStatus: benefits?.status ?? null,
    catalogAncestry: benefits?.ancestry ?? null,
    nowIso: benefits?.nowIso ?? new Date().toISOString(),
  };
}

export async function loadPricingContext(db: D1Database, status?: TierStatus | null): Promise<PricingContext> {
  const member = !!status && status.active;
  const [settings, rules, ancestry] = await Promise.all([
    getSettings(db, ['proPricingPolicy', 'preorderTransportDefaults']),
    // A guest earns no benefit, so their request does not pay for either query.
    member ? activeBenefitRules(db) : Promise.resolve([] as BenefitRule[]),
    member ? catalogAncestry(db) : Promise.resolve(null),
  ]);
  return pricingContextFrom(settings, { rules, status: status ?? null, ancestry });
}

/**
 * THE SAME TWO LOADS, STARTED BEFORE THE TIER IS KNOWN.
 *
 * `loadPricingContext` needs the membership to decide whether the rules are
 * worth querying, which would serialise it behind `cartTier`. Every cart door
 * is authenticated, so the member is not hypothetical and the rules table is
 * small and cached: starting both in the same `Promise.all` as the tier costs
 * one query and saves a round trip on the hot path.
 */
async function loadPricingParts(db: D1Database) {
  const [settings, rules, ancestry] = await Promise.all([
    getSettings(db, ['proPricingPolicy', 'preorderTransportDefaults']),
    activeBenefitRules(db),
    catalogAncestry(db),
  ]);
  return { settings, rules, ancestry };
}

/**
 * THE ONE CART PRICING PREAMBLE: who the member is, and what the admin has
 * configured for them — resolved once per request and passed down.
 *
 * Both halves are server-side reads. Nothing here is taken from the request
 * body, so a browser cannot name its own tier, its own category or its own
 * discount (§24).
 */
export async function cartPricing(
  c: Context<AppContext>
): Promise<{ tier: Tier; active: boolean; status: TierStatus; ctx: PricingContext }> {
  const [t, parts] = await Promise.all([cartTier(c), loadPricingParts(c.env.DB)]);
  return {
    ...t,
    ctx: pricingContextFrom(parts.settings, {
      // An expired or paused membership earns nothing, and `resolveMembershipBenefits`
      // says so through the entitlement gate — but keeping the rules out of the
      // context as well means a stale `status` can never leak one.
      rules: t.status.active ? parts.rules : [],
      status: t.status,
      ancestry: parts.ancestry,
    }),
  };
}

export interface CartSelection {
  optionId: string;
  colorId: string;
  transportMethod: string;
  /**
   * 0073. THE ORDER TYPE THE CUSTOMER CHOSE, stored on the line instead of
   * being read back out of "did they pick a transport?". '' = a legacy line,
   * or a product that sells one way, and both resolve exactly as before.
   */
  fulfillmentType: string;
  warrantyPlanId: string;
  /** §7 multi-group selection. `optionId` stays as the authored first-group
   *  value so every pre-0018 reader keeps seeing the price-bearing model. */
  optionValueIds?: string[];
}

/**
 * Resolves one cart/checkout line through the central resolver — the ONLY
 * pricing path. Never trusts a client-sent price.
 *
 * `preorderPricing` is the checkout's knowledge of HOW the customer pays: a
 * pre-order line paid cash on delivery is priced as a direct sale (owner
 * mandate). The cart itself never knows a payment method, so it always prices
 * 'prepaid' — the configured pre-order price — and the checkout quote is the
 * authority the moment a method is chosen.
 *
 * `isPrinter` is the owner's catalog flag for the line's product: a printer
 * with no configured warranty base is priced with the 12-month default, so
 * the plan's total months here are the ones its delivered unit will record.
 */
export function resolveCartLine(
  row: Record<string, unknown>,
  sel: CartSelection,
  tier: Tier,
  tierActive: boolean,
  ctx: PricingContext,
  view?: ProductRelationsView,
  preorderPricing: PreorderPricing = 'prepaid',
  isPrinter = false,
  /**
   * A SCHEDULED SPECIAL OFFER ON THIS ORDINARY PRODUCT (§4.6, §9). The card,
   * this line and the checkout door all price it through the same
   * `resolveOfferPrice`, so a live window cannot quote one number on the grid
   * and another in the cart. Eligibility is judged by the caller, which is the
   * only place that holds the viewer's membership.
   */
  offer?: { view: OfferView | null; eligible: boolean; nowMs: number }
): { doc: ProductDoc; resolved: ResolvedPrice; variantLabel: string; selectionErrors: string[]; offerId: string | null } {
  // Options and colours come from the relational tables when the product has
  // them (migration 0022 gave every existing product its rows), so the cart
  // prices exactly what the storefront showed.
  const doc = view ? applyRelations(parseProductRow(row), view) : parseProductRow(row);
  // One deterministic order for pricing, labels, persistence and identity.
  // A request may list option groups in any order; it must never change which
  // value supplies the inherited price or create a second cart line.
  const storedIds = canonicalOptionValueIds(sel.optionValueIds ?? []);
  const identityIds = storedIds.length ? storedIds : canonicalOptionValueIds([], sel.optionId);
  const valueIds = optionValueIdsInRelationOrder(identityIds, view);

  // The resolver prices ONE option; with several groups the first selected
  // value carries the price override, and per-field inheritance fills the
  // rest — the same rule the admin form previews.
  const resolved = resolveUnitPrice({
    product: doc,
    optionId: valueIds[0] || null,
    colorId: sel.colorId || null,
    transportMethod: sel.transportMethod || null,
    fulfillmentType:
      sel.fulfillmentType === 'direct_sale' || sel.fulfillmentType === 'pre_order' ? sel.fulfillmentType : null,
    warrantyPlanId: sel.warrantyPlanId || null,
    tier,
    tierActive,
    proPolicy: ctx.proPolicy,
    memberFallback: memberFallbackFor(ctx, doc),
    transportDefaults: ctx.transportDefaults,
    preorderPricing,
    isPrinter,
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
  const withOffer =
    offer && offer.eligible && (doc.composition ?? '') === ''
      ? applyOfferToResolved(resolved, offer.view, tier, tierActive, offer.nowMs)
      : { resolved, offer_id: offer?.view?.window?.id ?? null, source: 'ladder' as const, plus_iqd: null };

  return {
    doc,
    resolved: withOffer.resolved,
    variantLabel: labels.join(' / '),
    selectionErrors,
    // The offer this line was priced under, frozen into the order snapshot by
    // the checkout so "which offer produced this price" is answerable years
    // later (§12).
    offerId: withOffer.source === 'offer' ? withOffer.offer_id : null,
  };
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
    pro_iqd: r.pro_iqd,
    transport: r.transport,
    // The direct-sale premium, named — with `waived` for a PRO — so a cart or
    // checkout line can explain its final number instead of folding the
    // premium silently into unit_subtotal_iqd.
    direct: r.direct,
    /** Which availability fee priced the line: commission or direct premium. */
    pricing_basis: r.pricing_basis,
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

/** §8.2 row 18 at option-value and colour level: a pool member's per-level
 *  counters are not published, in the cart any more than in the catalogue. */
const coarseLevel = <T extends Record<string, unknown>>(x: T, coarse: boolean): T =>
  coarse ? ({ ...x, stock: null, low_stock_threshold: null } as T) : x;

/**
 * The selection one cart row carries — and an EMPTY one for a composition row.
 *
 * A bundle line stores its `compositionKey` in `option_id` for line identity
 * (§5.1), and that key is line identity and NOTHING ELSE. Blanking `optionId`
 * alone is not sufficient: this function returns
 * `optionValueIds: ids.length ? ids : legacy ? [legacy] : []`, so a composition
 * row — `option_value_ids = '[]'`, `option_id = 'bx_…'` — would carry
 * `optionValueIds: ['bx_…']` anyway, `resolveCartLine` would rebuild
 * `optionId: valueIds[0]` from it, and BOTH `resolveUnitPrice` and
 * `saleAvailability` would push `OPTION_NOT_FOUND` — the first turning every
 * bundle checkout into a 400 VALIDATION, the second making
 * `refuseIncompleteSelection` throw the nonsense "Choose a colour before adding
 * this item (OPTION_NOT_FOUND)".
 *
 * It is decided HERE, from `products.composition`, rather than at each caller:
 * the one function that derives a selection from a row is the one place that
 * knows the row is a composition, and `products.composition` rides on every
 * cart and checkout SELECT (`p.*`) for exactly this purpose.
 */
export function selectionFromCartRow(row: Record<string, unknown>): CartSelection {
  const transportMethod = String(row.transport_method ?? '');
  // 0073. The stored order type, when the line has one. A composition has no
  // model and therefore no cell, so it keeps the inference it always had.
  const stored = String(row.fulfillment_type ?? '');
  const fulfillmentType = stored === 'direct_sale' || stored === 'pre_order' ? stored : '';
  if (String(row.composition ?? '') !== '') {
    return { optionId: '', optionValueIds: [], colorId: '', transportMethod, fulfillmentType: '', warrantyPlanId: '' };
  }
  const storedIds = safeParse<unknown[]>(String(row.option_value_ids ?? '[]'), []);
  const legacy = String(row.option_id ?? '');
  const fullIds = canonicalOptionValueIds(storedIds);
  const ids = fullIds.length ? fullIds : canonicalOptionValueIds([], legacy);
  return {
    optionId: ids[0] ?? '',
    optionValueIds: ids,
    colorId: String(row.color_id ?? ''),
    transportMethod,
    fulfillmentType,
    warrantyPlanId: String(row.warranty_plan_id ?? ''),
  };
}

// ----------------------------------------------------------- bundle lines

/**
 * Every composition line in the cart, resolved against the buyer's OWN stored
 * choices, in three reads for the whole cart.
 *
 * Keyed by `cart_items.id` and not by product id, deliberately: two lines of
 * one bundle with different colours are two independent answers (§5.1), and a
 * map keyed by product would price one of them with the other's components.
 */
export async function resolveCartBundles(
  db: D1Database,
  rows: Record<string, unknown>[],
  tier: Tier,
  tierActive: boolean,
  ctx: PricingContext,
  status: TierStatus | null,
  nowMs = Date.now(),
  /** How the customer pays, when the caller knows. The cart never does — it
   *  prices every pre-order line as prepaid and lets the checkout quote be the
   *  authority the moment a payment method is chosen. */
  preorderPricing: PreorderPricing = 'prepaid'
): Promise<Map<string, ResolvedBundle>> {
  if (rows.length === 0) return new Map();
  const [joined, choices] = await Promise.all([
    loadCompositionRows(db, rows.map((r) => String(r.id))),
    loadCartChoices(db, rows.map((r) => String(r.cart_item_id))),
  ]);
  const lines: CompositionLineInput[] = [];
  for (const r of rows) {
    const row = joined.get(String(r.id));
    if (row)
      lines.push({
        key: String(r.cart_item_id),
        row,
        choices: choices.get(String(r.cart_item_id)),
        // 0075. The line's OWN route, so the ceiling the cart publishes is the
        // counter the checkout will actually spend — the shared pool and a
        // route's own quota are different counters, not different numbers.
        transportMethod: String(r.transport_method ?? ''),
      });
  }
  return resolveCompositionLines(db, lines, {
    tier,
    tierActive,
    proPolicy: ctx.proPolicy,
    transportDefaults: ctx.transportDefaults,
    // The COMPONENTS carry the member's configured rule; the bundle's own
    // price does not (see `CompositionViewer.memberFallbackFor`).
    memberFallbackFor: (doc) => memberFallbackFor(ctx, doc),
    status,
    nowMs,
    preorderPricing,
  });
}

/**
 * ONE MAIN ITEM WITH EXPANDABLE CONTENTS (§5.2, case 10).
 *
 * The components live under `composition.components` and are never top-level
 * `items[]` entries, so the cart's own totals and the coupon merchandise sum
 * cannot double-count them. The unit price is the bundle's own — merchandise
 * plus the fees the components' journeys really cost (§2.2) — and every figure
 * on it is the server's.
 */
function compositionCartItem(
  row: Record<string, unknown>,
  b: ResolvedBundle,
  printerIds: Set<string>,
  mystery?: MysteryContext,
  /** The customer's own language, for the ONE server-rendered sentence a
   *  mystery line carries — the reveal milestone in words (§13.3). */
  lang = 'ar'
) {
  const unit = b.pricing.unit_subtotal_iqd + componentFeesIqd(b);
  const qty = Number(row.qty) || 1;
  const deliveryDocs = b.doc.composition === 'mystery' ? [b.doc] : b.components.filter((k) => k.included).map((k) => k.doc);
  const deliveryAvailability = {
    standard: deliveryDocs.every((d) => !d.delivery_options || d.delivery_options.standard.enabled),
    personal: deliveryDocs.every((d) => !d.delivery_options || d.delivery_options.personal.enabled),
  };
  return {
    id: row.cart_item_id,
    kind: b.doc.composition === 'mystery' ? 'mystery' : 'bundle',
    productId: b.doc.id,
    slug: b.doc.slug,
    name: b.doc.name_en,
    name_ar: b.doc.name_ar,
    name_ku: b.doc.name_ckb,
    image: primaryMedia(b.doc.media)?.url ?? '',
    qty,
    // Line identity, echoed as it is stored. Nothing derives a selection from
    // it — `selectionFromCartRow` returns an empty selection for this row.
    option_id: row.option_id,
    color_id: '',
    transport_method: row.transport_method ?? '',
    warranty_plan_id: '',
    shipping_method_id: '',
    selling_type: b.doc.selling_type,
    variantLabel: '',
    support_gift_eligible: false,
    /** True when any COMPONENT is a printer: the note belongs on the line the
     *  customer sees, and the parent row carries no catalog of its own. */
    is_printer: b.components.some((k) => k.included && printerIds.has(k.member_product_id)),
    cod_reprices: false,
    unit_price_iqd: unit,
    // The same shape an ordinary line carries — `publicBreakdown`, with the
    // figures actually charged written over the resolver's. `applied_tier`
    // stays inside the shared three-value union: the PLUS rung is
    // offer-scoped and is named on the composition block, never on a field
    // every other line in the cart also carries (§4.4).
    breakdown: {
      ...publicBreakdown(b.pricing.resolved),
      applied_iqd: b.pricing.applied_iqd,
      applied_tier: b.pricing.applied_tier === 'plus' ? 'regular' : b.pricing.applied_tier,
      regular_iqd: b.pricing.regular_iqd,
      prime_iqd: b.pricing.prime_iqd,
      pro_iqd: b.pricing.pro_iqd,
      unit_subtotal_iqd: unit,
      price_source: b.pricing.source,
      errors: b.pricing.errors,
    },
    stock: null,
    composition: cartCompositionBlock(b, mystery, lang),
    availability: {
      mode: b.availability.state === 'sold_out' ? 'unavailable' : 'available',
      reason: b.availability.state === 'sold_out' ? 'OUT_OF_STOCK' : null,
      state: b.availability.state,
      scope: 'composition',
      max_qty: compositionMaxQty(b),
      shipping_type: b.availability.shipping_type,
      modes: b.availability.modes,
    },
    selection_errors: b.components.flatMap((k) => k.choice_errors),
    option_value_ids: [],
    relations: null,
    options: [],
    colors: [],
    warranty_plans: [],
    preorder_transports: [],
    shipping_methods: [],
    delivery_availability: deliveryAvailability,
  };
}

// ------------------------------------------------------------ the cart rows

/**
 * THE SELECTION COLUMNS ON A CART LINE, AND THE VALUE EACH ONE HAS WHEN ITS
 * MIGRATION HAS NOT RUN.
 *
 * `cart_items` has been widened four times since 0001 — `transport_method`
 * and `warranty_plan_id` (0002), `option_value_ids` (0023), `fulfillment_type`
 * (0073) — and `loadCart` names every one of them. Name a column a database
 * does not have and SQLite refuses the WHOLE statement, so on a deployment
 * that is one migration ahead of its database this single SELECT took the
 * cart screen down with `no such column: ci.fulfillment_type` while the
 * orders, points, farm and home screens — which never read a cart line —
 * carried on working. That is the shape of the reported defect exactly.
 *
 * THE DEFAULT HERE IS NOT A GUESS. Each one is the DEFAULT the migration
 * itself declares, and SQLite can only answer `no such column` for a column
 * that is not in the table — which means no row has ever stored a value for
 * it, which means the default is the value every row holds. `selectionFromCartRow`
 * already reads exactly these defaults for a line written before the column
 * existed, so a cart read this way is priced by the same code, down the same
 * branch, as a legacy line: nothing is approximated and no price moves.
 */
const cartLineSql = (projection: string) =>
  `SELECT ci.id AS cart_item_id, ci.qty, ${projection}, p.*
     FROM cart_items ci JOIN products p ON p.id = ci.product_id
    WHERE ci.user_id = ? ORDER BY ci.created_at DESC`;

/** The cart's lines, read with the columns this database actually has. The
 *  registry, the retry and the reasoning all live in
 *  worker/lib/cartLineProjection.ts, which the checkout reads through too. */
const cartLineRows = (db: D1Database, userId: string) => cartLineSelect(db, cartLineSql, [userId]);

// ------------------------------------------------------------------- routes

async function loadCart(c: Context<AppContext>) {
  const user = c.get('user')!;
  const { tier, active: tierActive, status, ctx } = await cartPricing(c);
  const results = await cartLineRows(c.env.DB, user.id);

  // Display-only: which lines carry the explicit support-gift eligibility
  // flag. One extra query for the whole cart, never per line, and it feeds
  // no price anywhere.
  const activeIds = results.filter((r) => r.status === 'active').map((r) => String(r.id ?? ''));
  const [eligibleIds, printerIds, poolMemberIds] = await Promise.all([
    // A DISPLAY FLAG IS NOT WORTH A 500 (the `soft` pattern in
    // worker/routes/admin.ts, added after one `chats.order_id` lookup took the
    // whole fulfilment modal down). §3.3 says a support code has ZERO monetary
    // effect, so an unflagged line is a missing sentence, never a wrong price.
    degradeIfSchemaMissing('support gift eligibility (migration 0016)', () => supportEligibleProductIds(c.env.DB, activeIds), new Set<string>()),
    /**
     * Which lines are printers (owner's catalog flag), so the cart can show
     * the home-delivery note beside them.
     *
     * NOT DEGRADED, and the asymmetry with the two reads around it is the
     * whole point: `isPrinter` is handed to `resolveUnitPrice` and to
     * `pricedPlans`, where it decides the warranty base months a percent plan
     * is charged on. It is a PRICE input, so an unreadable answer must stop
     * the screen rather than quietly reprice an extended warranty. It reads
     * `catalogs`/`product_catalogs` (0002) — required schema — which is the
     * same line drawn from the other side.
     */
    printerProductIds(c.env.DB, activeIds),
    /**
     * §8.2 ROW 18 IS A PUBLICATION RULE, NOT A CATALOGUE-ROUTE RULE.
     *
     * `coarseStock` was threaded only through `worker/routes/products.ts`,
     * while `GET /api/cart` reads the same four stock tables and published
     * `stock: 9` and `availability.stock.available: 9` for a pool member. Since
     * `reserve` bumps `stock_reserved` inside the order's own batch, a buyer
     * could snapshot the candidates through their own cart before and after
     * checkout and read the drawn product AND the spool count off the delta —
     * defeating every milestone including 'paid', the one §17 decision 10
     * promises is deliverable even if coarse counts are rejected.
     *
     * One indexed read for the whole cart (`idx_mystery_entries_product`),
     * resolved once and passed down beside the tier context (§14).
     *
     * THIS ONE IS A DISCLOSURE GATE, so degrading it needs its own argument
     * rather than the general one: masking exists to hide WHICH products a
     * live pool draws from, and 0061's tables are where a pool is stored. If
     * `mystery_pool_entries` is not in the database then no pool has ever been
     * created, no product is a candidate for one, and there is nothing for the
     * mask to hide. A pool that DOES exist behind a locked or unreadable table
     * is a different matter entirely, and `isSchemaMissing` refuses to absorb
     * that: it still throws, and the stock count stays unpublished.
     */
    degradeIfSchemaMissing('mystery pools (migration 0061)', () => activePoolProductIds(c.env.DB, activeIds), new Set<string>()),
  ]);

  // One batched read of every product's relational structure — never N+1.
  const views = await loadRelationsViews(
    c.env.DB,
    results.filter((r) => r.status === 'active').map((r) => ({ id: String(r.id), inventory_mode: r.inventory_mode }))
  );

  // THE COMPOSITION LINES, RESOLVED IN ONE PASS FOR THE WHOLE CART (§5.2).
  // The bundle rows are re-read with `bundle_config` and `offer_windows`
  // joined on, their stored choices come back in one chunked query, and the
  // resolution runs through the SAME functions the card, the detail page and
  // the door use — so no screen can quote a different price or a different
  // state from another. A cart with no bundle in it costs nothing extra.
  const compositionRows = results.filter((r) => r.status === 'active' && String(r.composition ?? '') !== '');
  const resolvedBundles = await resolveCartBundles(c.env.DB, compositionRows, tier, tierActive, ctx, status);
  // THE MYSTERY PRE-PASS (§7): one candidate query per pool for the whole
  // cart, and the pool's verdict written over each mystery line's (empty)
  // component availability.
  const mysteryCtxs = await resolveCartMystery(c.env.DB, compositionRows, resolvedBundles);
  // Scheduled special offers on the ORDINARY lines — one chunked read for the
  // whole cart. The same `offer_windows` row a bundle uses, on the same
  // subject key, resolved by the same function the card and the door use.
  // A store with no 0060 has no offer window and no offer limit, so every
  // line prices at the ladder price — which is the price it would get from an
  // empty `offer_windows` anyway. An offer that EXISTS but cannot be read is
  // not absorbed (see `isSchemaMissing`): quoting the ladder price over a live
  // discount would overcharge the customer, and that is worth an error page.
  const lineOffers = await degradeIfSchemaMissing(
    'special offers (migration 0060)',
    () =>
      loadOffers(
        c.env.DB,
        results.filter((r) => r.status === 'active' && String(r.composition ?? '') === '').map((r) => subjectOf(String(r.id)))
      ),
    new Map<string, OfferView>()
  );
  const nowMs = Date.now();
  // A bundle's printers are its COMPONENTS' — the parent row is never in a
  // printer catalog itself — so the home-delivery note fires for a printer
  // bought inside a bundle exactly as it does for one bought alone. One extra
  // query, and only when the cart actually holds a composition line.
  const bundlePrinterIds = resolvedBundles.size
    ? await printerProductIds(
        c.env.DB,
        [...resolvedBundles.values()].flatMap((b) => b.components.map((k) => k.member_product_id))
      )
    : new Set<string>();

  const items = [];
  /**
   * §10 — WHAT THE MEMBERSHIP IS WORTH ON THIS CART, computed HERE.
   *
   * The cart page used to work its own saving out of `regular − applied` per
   * line, which can only ever see the part that fits in a unit price: a
   * quantity limit or a per-order ceiling was invisible there, so the page
   * promised a number the checkout then reduced. One server answer removes
   * the possibility.
   *
   * Composition lines are left out on purpose — a bundle's price is already a
   * composed discount and its components were resolved with the member's own
   * rule inside them.
   */
  const benefitLines: BenefitLineInput[] = [];
  const unavailableDelivery = {
    standard: new Set<string>(),
    personal: new Set<string>(),
  };
  const constrainDelivery = (doc: Pick<ProductDoc, 'id' | 'delivery_options'>) => {
    if (!doc.delivery_options) return; // legacy global tariff supports both
    if (!doc.delivery_options.standard.enabled) unavailableDelivery.standard.add(doc.id);
    if (!doc.delivery_options.personal.enabled) unavailableDelivery.personal.add(doc.id);
  };
  for (const row of results) {
    if (row.status !== 'active') continue; // hidden products drop out of the cart view
    const composition = String(row.composition ?? '');
    if (composition !== '') {
      const b = resolvedBundles.get(String(row.cart_item_id));
      if (!b) continue; // the composition rows vanished under us; nothing honest to render
      // Fixed bundles ship their included components; mystery offers expose
      // only the offer row's shipping facts, matching the checkout anti-leak
      // rule in orders.ts.
      if (b.doc.composition === 'mystery') constrainDelivery(b.doc);
      else b.components.filter((k) => k.included).forEach((k) => constrainDelivery(k.doc));
      items.push(
        compositionCartItem(row, b, bundlePrinterIds, mysteryCtxs.get(String(row.cart_item_id)), user.locale ?? 'ar')
      );
      continue;
    }
    const view = views.get(String(row.id));
    const sel = selectionFromCartRow(row);
    const isPrinter = printerIds.has(String(row.id ?? ''));
    const coarseStock = poolMemberIds.has(String(row.id ?? ''));
    const offerView = lineOffers.get(offerKey(subjectOf(String(row.id)))) ?? null;
    const offerCheck = offerEligible(status, offerView, nowMs);
    const offerInput = { view: offerView, eligible: offerCheck.ok, nowMs };
    const { doc, resolved, variantLabel, selectionErrors } = resolveCartLine(
      row,
      sel,
      tier,
      tierActive,
      ctx,
      view,
      'prepaid',
      isPrinter,
      offerInput
    );
    constrainDelivery(doc);
    benefitLines.push({
      product_id: String(row.id),
      category_id: doc.category_id ?? null,
      sub_category_id: doc.sub_category_id ?? null,
      ancestry: ancestryFor(ctx.catalogAncestry, doc.category_id ?? null, doc.sub_category_id ?? null),
      regular_unit_iqd: resolved.regular_iqd,
      applied_unit_iqd: resolved.applied_iqd,
      // Which rule the resolver actually credited — a typed member price or a
      // live offer beats one, and a rule that did not set this price must not
      // be reported as having saved anything.
      applied_rule_id: tier === 'pro' ? resolved.member_rule.pro : resolved.member_rule.prime,
      qty: Number(row.qty) || 0,
    });
    // Would cash on delivery change THIS line's price? Only when the product
    // carries a direct premium this customer pays — the same rule the checkout
    // applies — so the cart explains the cash rule only where it bites.
    const codReprices = sel.transportMethod
      ? resolveCartLine(row, sel, tier, tierActive, ctx, view, 'cod', isPrinter, offerInput).resolved.unit_subtotal_iqd !==
        resolved.unit_subtotal_iqd
      : false;
    // What this exact line can actually be sold as, from the authoritative
    // stock level — not from products.stock when the product tracks elsewhere.
    //
    // 0075 — AND AS THE ORDER TYPE IT WAS STORED WITH. `statedAvailability`
    // applies the same guard the add and patch doors apply, so a pre-order
    // line whose quota filled up is reported against ITS counter instead of
    // being quietly re-described as a direct sale off a shelf the customer
    // never asked about.
    const availability = statedAvailability(
      saleAvailability(doc, {
        optionValueIds: sel.optionValueIds ?? [],
        colorId: sel.colorId || null,
        qty: Number(row.qty) || 1,
        coarseStock,
        transportDefaults: ctx.transportDefaults,
        inventory: view
          ? snapshotFrom(view, {
              stock: doc.stock,
              reserved: Number(row.stock_reserved ?? 0),
              low_stock_threshold: (row.low_stock_threshold as number | null) ?? null,
            })
          : undefined,
        links: view?.links,
        // 0073. What the customer CHOSE, falling back to the old inference for a
        // line written before the order type was a field of its own.
        preferredType: sel.fulfillmentType || (sel.transportMethod ? 'pre_order' : null),
        // 0075. The pre-order counter for THIS line's model and route, so a cart
        // line whose quota filled up while it sat there says so before the
        // customer reaches the door.
        capacity: view ? capacityFrom(view, sel.optionValueIds ?? []) : null,
        transportMethod: sel.transportMethod,
      }),
      sel.fulfillmentType,
      sel.transportMethod
    );
    items.push({
      id: row.cart_item_id,
      productId: row.id,
      slug: row.slug,
      name: row.name,
      name_ar: row.name_ar,
      image: productImageForSelection(doc, {
        optionValueIds: sel.optionValueIds ?? [],
        colorId: sel.colorId || null,
      }, view),
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
      /** From catalogs.is_printer_catalog — the printer home-delivery note keys off this. */
      is_printer: isPrinter,
      /** Cash on delivery would change this pre-order line's price (it carries
       *  a direct premium this customer pays). False on a direct line and on a
       *  pre-order line with no premium — the cart says nothing there. */
      cod_reprices: codReprices,
      // Legacy field kept for existing UI: the full per-unit amount. The cart
      // prices a pre-order line as PREPAID (its configured pre-order price);
      // the checkout quote re-prices it once a payment method is chosen.
      unit_price_iqd: resolved.unit_subtotal_iqd,
      breakdown: publicBreakdown(resolved),
      // Legacy field: the base row. `availability.stock` is the authoritative
      // figure for THIS selection. Null for a mystery-pool member — the cart
      // is a customer payload like any other (§8.2 row 18).
      stock: coarseStock ? null : row.stock,
      low_stock_threshold: coarseStock ? null : ((row.low_stock_threshold as number | null) ?? null),
      availability,
      selection_errors: selectionErrors,
      option_value_ids: sel.optionValueIds ?? [],
      relations: publicRelations(view ?? EMPTY_RELATIONS, coarseStock),
      options: doc.options.filter((o) => o.active).map(stripCost).map((o) => coarseLevel(o, coarseStock)),
      colors: doc.colors.filter((col) => col.active).map(stripCost).map((col) => coarseLevel(col, coarseStock)),
      // The extended-warranty options for THIS line, each with its fee already
      // resolved against the line's regular price (a percent plan) and the
      // total it yields — what the cart's "Extended Warranty" disclosure
      // shows before the customer picks one. Printers only; the cart refuses
      // a plan on anything else (WARRANTY_NOT_PRINTER).
      warranty_plans: pricedPlans(doc.warranty_plans, resolved.regular_iqd, doc.warranty_base_months, isPrinter),
      preorder_transports: doc.preorder_transports.filter((t) => t.active),
      shipping_methods: safeParse(row.shipping_methods, []), // legacy UI compatibility
      delivery_options: doc.delivery_options ?? null,
      delivery_availability: {
        standard: !doc.delivery_options || doc.delivery_options.standard.enabled,
        personal: !doc.delivery_options || doc.delivery_options.personal.enabled,
      },
    });
  }
  /**
   * The same resolver the checkout runs, over the cart as it stands. The
   * delivery half is answered PER METHOD rather than for one chosen method,
   * because the cart is where a customer is still deciding — "free with
   * standard delivery" is the sentence that belongs on this screen.
   */
  const merchandise = benefitLines.reduce((n, l) => n + l.applied_unit_iqd * l.qty, 0);
  const membership = ctx.benefitStatus
    ? (() => {
        const resolvedBenefits = resolveMembershipBenefits({
          rules: ctx.benefitRules,
          status: ctx.benefitStatus!,
          lines: benefitLines,
          shippingBasisIqd: merchandise,
          deliveryMethod: null,
          nowIso: ctx.nowIso,
        });
        const perMethod = (['standard', 'personal'] as const).map((method) => ({
          method,
          ...resolveOrderBenefits({
            rules: ctx.benefitRules,
            status: ctx.benefitStatus!,
            shippingBasisIqd: merchandise,
            deliveryMethod: method,
            nowIso: ctx.nowIso,
          }).shipping,
        }));
        return {
          tier: ctx.benefitStatus!.tier,
          active: ctx.benefitStatus!.active,
          /** The saving already inside the unit prices above, plus the part
           *  the checkout takes off the order — named apart so the page can
           *  show a line total that adds up. */
          discount_total_iqd: resolvedBenefits.discount_total_iqd,
          order_discount_iqd: resolvedBenefits.line_discount_iqd,
          merchandise_iqd: Math.max(0, merchandise - resolvedBenefits.line_discount_iqd),
          lines: resolvedBenefits.lines,
          free_shipping: perMethod,
          cod_tax_exempt: resolvedBenefits.tax.cod_exempt,
        };
      })()
    : null;

  return {
    items,
    tier,
    tierActive,
    membership,
    delivery_methods: {
      standard: { available: unavailableDelivery.standard.size === 0, unavailable_product_ids: [...unavailableDelivery.standard] },
      personal: { available: unavailableDelivery.personal.size === 0, unavailable_product_ids: [...unavailableDelivery.personal] },
      pickup: { available: true, unavailable_product_ids: [] as string[] },
    },
  };
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
  const { items, tier, tierActive, delivery_methods, membership } = await loadCart(c);
  // §1: the type the cart is locked to, so the storefront can say so before
  // the customer discovers it by being refused. null = empty, so any type may
  // still be started.
  const shippingType = cartShippingType(items as Array<{ transport_method?: unknown }>);
  // WHOSE CART THIS IS, answered from the rows already in hand.
  //
  // The page used to ask `/cart/scope` in a second request — the same table,
  // the same user, for columns this handler had already read — and could not
  // decide which cart screen to render until it landed. That is a whole extra
  // round trip on the critical path, and a visible two-stage flash for a
  // merchant cart: the platform cart rendered first, then swapped.
  //
  // `/cart/scope` stays exactly as it is: it also resolves the STORE, which
  // this response has no business carrying.
  return c.json({
    success: true,
    items,
    tier,
    tierActive,
    // §10: the server's own answer about what this membership saved, so the
    // page states it instead of subtracting two numbers and hoping.
    membership,
    delivery_methods,
    shipping_type: shippingType,
    scope: cartSellerScope(items as unknown as SellerLine[]),
  });
});

/**
 * ONE SHIPPING TYPE PER CART, and ONE SELLER PER CART — the two rules every
 * add path obeys, held in one function so a bundle line cannot slip past
 * either of them.
 *
 * Direct, air, sea and land are four different journeys with four different
 * timelines and four different tracking paths, and a basket holding two of
 * them has no honest delivery date to show. The first item decides; a mismatch
 * is refused with both types named, so the client can offer the only two real
 * ways out (empty the cart and start this type, or keep what is there).
 *
 * `replaceCart: true` is that first choice arriving as one request: the caller
 * has already confirmed, and doing it in a single call means a cart can never
 * be left emptied with nothing added because the second request failed.
 */
async function enforceCartScope(
  c: Context<AppContext>,
  incomingType: ShippingType,
  replaceCart: boolean
): Promise<void> {
  const user = c.get('user')!;
  const { results: existingLines } = await c.env.DB
    .prepare('SELECT transport_method, seller_type, merchant_id, store_id FROM cart_items WHERE user_id = ?')
    .bind(user.id)
    .all<{ transport_method: string; seller_type: string; merchant_id: string | null; store_id: string | null }>();
  const currentType = cartShippingType(existingLines);

  // This is a Levonis product; if the cart is currently a merchant's, the two
  // cannot settle as one order — different fulfilment, different commission,
  // different party responsible. Refused the same way whether or not the
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
    return;
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
}

function parseTransportMethod(v: unknown): string {
  if (v === undefined || v === null || v === '') return '';
  return oneOf(v, 'transportMethod', ['air', 'sea', 'land'] as const);
}

/**
 * 0073. THE ORDER TYPE, AS AN INDEPENDENT ANSWER.
 *
 * Absent means "not stated", which is what every client sent before this
 * existed — the resolver then infers it exactly as it always did. Only a word
 * it actually knows is accepted; anything else is a bad request rather than a
 * silent fallback, because guessing here would sell the wrong thing.
 */
export function parseFulfillmentType(v: unknown): string {
  if (v === undefined || v === null || v === '') return '';
  return oneOf(v, 'fulfillmentType', ['direct_sale', 'pre_order'] as const);
}

/**
 * ADD ONE BUNDLE LINE (§5.1, §5.2, §6.1).
 *
 * The client sends the bundle's product id, a quantity, a transport method for
 * a pre-order bundle and — only where the admin allows a choice — a
 * `bundleChoices[]` array of ids. A price, a component total, a saving, a
 * discount, a stock number, a membership flag, a composition key, the component
 * LIST, a pool, a weight or a drawn item in that body is IGNORED: none of them
 * is read here, and the server owns every one of them.
 *
 * The line is an ORDINARY `cart_items` row whose `option_id` carries the
 * server-computed `compositionKey`. The partial `idx_cart_levonis_line` also
 * includes canonical option_value_ids JSON (0082), so ordinary products
 * distinguish every group while composition keys still distinguish choices.
 * Two bundles with different colours are two lines; two with identical choices
 * merge into one line at qty 2.
 *
 * The upsert and the `cart_bundle_choices` rows go in ONE batch, so a line can
 * never exist without the composition that explains it.
 */
async function addCompositionLine(
  c: Context<AppContext>,
  product: Record<string, unknown>,
  qty: number,
  transportMethod: string,
  body: Record<string, unknown>
) {
  const user = c.get('user')!;
  const productId = String(product.id);
  const label = String(product.name_ar || product.name || productId);

  const isMystery = String(product.composition) === 'mystery';

  /**
   * §7.5 AND §15.1 RULE 9: THE COMPOSITION DOORS ARE RATE-LIMITED PER USER.
   *
   * Both sections record the residual enumeration risk as an ACCEPTED BOUND on
   * the basis that this limiter exists — and it did not. `POST /api/cart/items`
   * and `PATCH /api/cart/items/:id` were unlimited, and removing a mystery line
   * and re-adding it writes a fresh `randomSeedHex()` and therefore a fresh
   * draw. On its own that is harmless; combined with any availability oracle it
   * turned a deterministic seed into a free, unbounded grinder for a favourable
   * roll, which is exactly the property §7.3 says the seed alone cannot
   * protect. The bound is the one the contract names, under the name it names.
   */
  await rateLimit(c, 'composition_quote', 60, 300);

  const [{ tier, active: tierActive, status, ctx }, loaded] = await Promise.all([
    cartPricing(c),
    loadBundleComponents(c.env.DB, [productId]),
  ]);
  const components: BundleComponentRow[] = loaded.byBundle.get(productId) ?? [];
  // A MYSTERY offer has no components by design — its contents are drawn, not
  // composed — so the empty list is a fault only for a bundle.
  if (components.length === 0 && !isMystery) {
    throw badRequest(`"${label}" is not available right now`, 'OFFER_INACTIVE');
  }

  // The complete choice set — the admin's pins plus the customer's picks,
  // refused rather than guessed at where one is missing or not permitted. A
  // mystery line has nothing to choose: `bundleChoices` on it is ignored, not
  // echoed (§5.2).
  const choices = isMystery
    ? new Map<string, ComponentChoice>()
    : resolveChoiceSet(components, parseBundleChoices(body.bundleChoices), label);

  const joined = await loadCompositionRows(c.env.DB, [productId]);
  const row = joined.get(productId);
  if (!row) throw notFound('Product not found or unavailable');
  const resolvedMap = await resolveCompositionLines(
    c.env.DB,
    // The route the customer is asking for, so the door judges the counter it
    // is about to spend rather than the shared pool.
    [{ key: productId, row, choices, transportMethod }],
    { tier, tierActive, proPolicy: ctx.proPolicy, transportDefaults: ctx.transportDefaults, status, nowMs: Date.now() }
  );

  // THE MYSTERY PRE-PASS (§7). The pool's verdict replaces the (empty)
  // component list's, so the ONE availability every screen reads is the
  // eligible pool's — the same function the admin preview uses.
  let mysteryCtx: MysteryContext | null = null;
  let familyId = '';
  if (isMystery) {
    const ctxs = await resolveMysteryLines(
      c.env.DB,
      [
        {
          key: productId,
          bundle: resolvedMap.get(productId)!,
          familyId: str(body.mysteryFamilyId, 'mysteryFamilyId', { max: 60, required: false }),
          transportMethod,
          requestedMode: typeof body.mysteryMode === 'string' ? body.mysteryMode : null,
        },
      ],
      Date.now()
    );
    applyMysteryToBundles(ctxs, resolvedMap);
    mysteryCtx = ctxs.get(productId) ?? null;
    familyId = mysteryCtx?.family_id ?? '';
  }
  const b = resolvedMap.get(productId)!;

  // THE DOOR. Everything §6.1 lists, on the server's own resolution: the
  // offer, the schedule, the tier, the price floor, the choices, the shipping
  // type, an opted-in optional component, the per-order cap and the stock.
  const method = isMystery
    ? mysteryCtx?.mode === 'preorder'
      ? transportMethod || 'air'
      : ''
    : resolveLineTransport(b, transportMethod, label);
  try {
    if (mysteryCtx) refuseMystery(mysteryCtx, label);
    refuseComposition(b, qty, label, isMystery ? {} : { transportMethod: method });
    refusePhysicalLines(mysteryCtx ? mysteryPhysicalLines(mysteryCtx, qty) : physicalLines(b, qty));
  } catch (e) {
    // §12's `oos_blocks`: the one fact no table records — that availability
    // refused a purchase. Counted only for a genuine availability refusal, so
    // a membership lock or a schedule does not inflate a stock figure, and
    // never allowed to change the refusal the customer receives.
    if (e instanceof HttpError && OOS_REFUSALS.has(e.code ?? '')) {
      await bumpMetric(c.env.DB, productId, 'oos_blocks');
    }
    throw e;
  }

  await enforceCartScope(c, typeForTransport(method), body.replaceCart === true);

  const key = compositionKey(isMystery ? mysteryKeyInput(familyId) : keyInput(choices));
  const identityIds = canonicalOptionValueIds(familyId ? [familyId] : []);
  const identityJson = optionValueIdsJson(identityIds);

  // A MERGE IS AN ADD, AND THE CAP APPLIES TO WHAT THE LINE WILL HOLD. Two
  // adds of the same bundle land on one line (identical choices ⇒ identical
  // key), so the cap is judged against the merged quantity and refused with
  // the number — never clamped afterwards, which would silently rewrite the
  // one number the customer is touching.
  const merged = await c.env.DB
    .prepare(
      `SELECT id, qty FROM cart_items
        WHERE user_id = ? AND product_id = ? AND option_id = ? AND option_value_ids = ?
          AND color_id = '' AND shipping_method_id = ''`
    )
    .bind(user.id, productId, key, identityJson)
    .first<{ id: string; qty: number }>();
  if (merged) refuseComposition(b, (Number(merged.qty) || 0) + qty, label);

  const lineId = newId('ci');
  // `draw_salt` is written by the SERVER when a mystery line is created and
  // rewritten never (§1.5): it is the only variable input to the draw seed, and
  // it exists so that no value the client chooses — least of all the checkout
  // idempotency key — can be ground for a favourable roll.
  const salt = isMystery ? randomSeedHex() : '';
  const addMetric = metricStatement(c.env.DB, productId, 'adds');

  // Intentionally no conflict target. Release A must run against 0032's
  // five-column index before 0082, both v1+v2 during the rolling deploy, and
  // 0083's six-column index afterwards. Naming either shape would strand the
  // Worker on one side of that expand/contract boundary.
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO cart_items (id, user_id, product_id, option_id, option_value_ids, color_id,
                               shipping_method_id, transport_method, warranty_plan_id, qty, draw_salt)
       VALUES (?, ?, ?, ?, ?, '', '', ?, '', ?, ?)
       ON CONFLICT DO UPDATE SET qty = MIN(99, qty + excluded.qty),
                     transport_method = excluded.transport_method`
    ).bind(lineId, user.id, productId, key, identityJson, method, qty, salt),
    ...cartChoiceStatements(c.env.DB, user.id, productId, key, identityIds, choices),
    // §12's `adds`, in the SAME batch as the line it counts — so a counted add
    // is an add that happened, and a tap costs no extra round trip.
    ...(addMetric ? [addMetric] : []),
  ]);

  const { items, tier: t, tierActive: ta } = await loadCart(c);
  return c.json({ success: true, items, tier: t, tierActive: ta });
}

/**
 * THE STORED ORDER TYPE SURVIVES THE READ PATH TOO (0075).
 *
 * `saleAvailability` DESCRIBES a product. Its descriptive fallback — no direct
 * sale? then pre-order; no pre-order? then direct sale — is right for a page
 * that has not been told what the buyer wants, and it is what lets a product
 * card still show a buy button. It is wrong for a LINE THAT IS ALREADY IN A
 * BASKET, because that line has an order type already: a stored fact, priced
 * on that basis, that decides which counter it will consume at the door.
 *
 * The add door and the patch door both refuse the fallback through
 * `unusableOrderType`. `GET /api/cart` did not. So when a pre-order line's
 * quota filled up while it sat in the basket, the fallback silently re-typed
 * it: the response came back `mode: "direct_sale"`, `reason: null` and the
 * SHELF's count, the cart screen showed no warning at all, and the `+` button
 * offered to raise the quantity to a number of units that line will never be
 * sold from. The customer found out at the checkout, which re-checks properly.
 *
 * This keeps the line's own order type, names the refusal, and publishes a
 * ceiling of zero — so the counter a client reads (`preorder.capacity` for a
 * pre-order line, `stock` for a direct one) is the counter that actually
 * limits it. The counters themselves are NOT rewritten: the shelf still says
 * what is on the shelf and the quota still says what is in the quota. Nothing
 * is summed, and neither is zeroed to mean "sold out" — `max_qty` is the one
 * number that says how many of THIS line may still be bought, and it is 0.
 *
 * AND IT TYPES THE LINE THE WAY THE DOOR DOES, NOT ONLY BY `fulfillment_type`.
 * `unusableOrderType` answers null for any stated value that is not exactly
 * `direct_sale` or `pre_order`, so a LEGACY line — `fulfillment_type = ''` with
 * a stored `transport_method`, exactly the shape migration 0073 leaves behind —
 * came back untouched while `POST /api/orders` typed that same line `pre_order`
 * from its transport. The cart described a direct sale off the shelf and the
 * door refused a pre-order against a full import quota: two answers about two
 * different counters for one line. `lineOrderType` is the checkout's own
 * chain, so there is one rule and it lives in one place.
 *
 * A line whose own row states NOTHING — no stored type and no transport — is
 * typed by `lineOrderType` from this very description, which is the same
 * default `POST /api/orders` now applies to that row. The two used to differ:
 * the cart left the fallback standing (an open import quota) and the door
 * defaulted to `direct_sale` and judged the shelf. The counters are still not
 * rewritten and no refusal is invented — a row the description cannot type at
 * all comes back exactly as `saleAvailability` described it.
 */
export function statedAvailability(
  a: SaleAvailability,
  stated: string,
  transportMethod: string
): SaleAvailability {
  const effective = lineOrderType(a, stated, transportMethod);
  const refusal = unusableOrderType(a, effective);
  if (!refusal) return a;
  return {
    ...a,
    // NOT `unavailable`: the mode is how every client learns which counter
    // this line spends, and erasing it is the same defect one step along.
    mode: effective === 'pre_order' ? 'preorder' : 'direct_sale',
    reason: refusal.code,
    stock: { ...a.stock, max_qty: 0 },
    preorder: { ...a.preorder, capacity: { ...a.preorder.capacity, max_qty: 0 } },
    qty_ok: false,
  };
}

/**
 * "MORE THAN WE HAVE" — FROM THE COUNTER THAT ACTUALLY LIMITS THIS LINE.
 *
 * A pre-order's limit is its IMPORT QUOTA, not the shelf, so quoting
 * `stock.available` on a pre-order line was doubly wrong: it named a number
 * that does not constrain the line, and on a model that is merely sold out for
 * direct sale it read "Only 0 left" for a pre-order the shop was happy to take.
 * `max_qty` is already the clamp `saleAvailability` computed from whichever
 * counter answered, so it is the honest ceiling in both modes.
 */
function refuseQty(availability: SaleAvailability) {
  const remaining =
    availability.mode === 'preorder' ? availability.preorder.capacity.available : availability.stock.available;
  return badRequest(
    remaining === null ? `At most ${availability.stock.max_qty} per order` : `Only ${remaining} left`,
    'QTY_UNAVAILABLE'
  );
}

cartRoutes.post('/items', async (c) => {
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const productId = str(body.productId, 'productId', { min: 1, max: 60 });
  const qty = int(body.qty, 'qty', { min: 1, max: 99, def: 1 });
  const legacyOptionId = str(body.optionId, 'optionId', { max: 60, required: false });
  // §7: one value per option group. The legacy single `optionId` is folded in
  // so an older client keeps working unchanged.
  const rawValueIds: unknown[] = Array.isArray(body.optionValueIds) ? body.optionValueIds : [];
  const optionValueIds = canonicalOptionValueIds(rawValueIds, legacyOptionId).slice(0, 12);
  const optionId = optionValueIds[0] ?? '';
  const colorId = str(body.colorId, 'colorId', { max: 60, required: false });
  const transportMethod = parseTransportMethod(body.transportMethod);
  const fulfillmentType = parseFulfillmentType(body.fulfillmentType);
  const warrantyPlanId = str(body.warrantyPlanId, 'warrantyPlanId', { max: 60, required: false });

  const product = await c.env.DB.prepare("SELECT * FROM products WHERE id = ? AND status = 'active'")
    .bind(productId)
    .first<Record<string, unknown>>();
  if (!product) throw notFound('Product not found or unavailable');

  // A COMPOSITION ROW TAKES ITS OWN DOOR (§5). It has no options, no colours,
  // no warranty plan and no stock of its own, so none of the ordinary
  // resolution below applies to it — and every figure it needs comes from the
  // same resolution pass the card and the detail page ran.
  if (String(product.composition ?? '') !== '') {
    return await addCompositionLine(c, product, qty, transportMethod, body);
  }

  const [{ tier, active: tierActive, status: addStatus, ctx }, views, isPrinter, addOffers] = await Promise.all([
    cartPricing(c),
    loadRelationsViews(c.env.DB, [{ id: productId, inventory_mode: product.inventory_mode }]),
    // The owner's catalog flag decides whether an extended warranty may ride
    // on this line at all — "this system applies to printers only".
    warrantyPlanId ? isPrinterProduct(c.env.DB, productId) : Promise.resolve(false),
    // Same rule as the cart read: no 0060 means no window exists, so the
    // ladder price IS this line's price. Anything other than a missing table
    // still refuses the add rather than storing a line at the wrong price.
    degradeIfSchemaMissing(
      'special offers (migration 0060)',
      () => loadOffers(c.env.DB, [subjectOf(productId)]),
      new Map<string, OfferView>()
    ),
  ]);
  refuseNonPrinterWarranty(isPrinter, warrantyPlanId);
  const view = views.get(productId);
  // ADD-TO-CART RE-CHECKS THE OFFER INDEPENDENTLY (§15.1 rule 6). A window
  // that ended, was switched off or gates a tier this buyer does not hold
  // refuses here rather than letting the line sit in a cart the checkout will
  // reject with a different sentence.
  const addNow = Date.now();
  const addOfferView = addOffers.get(offerKey(subjectOf(productId))) ?? null;
  const addOfferCheck = offerEligible(addStatus, addOfferView, addNow);
  // Only a LIVE window can refuse: an ordinary product outlives its
  // promotions, and an expired one must not make it permanently unbuyable.
  if (addOfferView?.window && !addOfferCheck.ok && addOfferCheck.reason === 'MEMBERSHIP_REQUIRED') {
    throw new HttpError(403, `"${String(product.name_ar || product.name)}" is available to members only`, 'MEMBERSHIP_REQUIRED', {
      required_tiers: addOfferCheck.required_tiers,
    });
  }
  const { doc, resolved, selectionErrors } = resolveCartLine(
    product,
    { optionId, optionValueIds, colorId, transportMethod, fulfillmentType, warrantyPlanId },
    tier,
    tierActive,
    ctx,
    view,
    'prepaid',
    isPrinter,
    { view: addOfferView, eligible: addOfferCheck.ok, nowMs: addNow }
  );
  if (offerPriceRefusal(resolved.errors)) {
    throw badRequest('This offer is not available right now', 'OFFER_INACTIVE');
  }
  if (resolved.errors.length > 0) {
    throw badRequest(`Invalid selection: ${resolved.errors.join(', ')}`, 'VALIDATION');
  }
  // §7: the colour/option combination must be one the admin actually offers.
  if (selectionErrors.length > 0) {
    throw badRequest(`Invalid selection: ${selectionErrors.join(', ')}`, 'VALIDATION');
  }

  // Stock comes from the authoritative level for THIS selection — an
  // exhausted colour blocks the add even when the base row is full.
  //
  // AND IT IS COARSE FOR A MYSTERY-POOL MEMBER (§8.2 row 18). The refusals
  // below quote `availability.stock.available`, so an add-to-cart of qty 99
  // was an oracle on its own: "Only 7 left" for one candidate and "Only 9
  // left" for the rest names the drawn colour without buying anything. The
  // coarse branch returns `available: null`, so both refusals take their
  // existing count-free path with no new branch.
  const coarseStock =
    (
      await degradeIfSchemaMissing(
        'mystery pools (migration 0061)',
        () => activePoolProductIds(c.env.DB, [String(product.id)]),
        new Set<string>()
      )
    ).size > 0;
  const availability = saleAvailability(doc, {
    optionValueIds,
    colorId: colorId || null,
    qty,
    coarseStock,
    transportDefaults: ctx.transportDefaults,
    inventory: view
      ? snapshotFrom(view, {
          stock: doc.stock,
          reserved: Number(product.stock_reserved ?? 0),
          low_stock_threshold: (product.low_stock_threshold as number | null) ?? null,
        })
      : undefined,
    links: view?.links,
    // 0073/0075 — THE ORDER TYPE THE CUSTOMER STATED, NOT ONE INFERRED FROM
    // THE ROUTE. The transport is only the fallback for a client that has not
    // learned to send `fulfillmentType`; without this the add validated a
    // stated pre-order against the model's SHELF, so a sold-out direct model
    // refused a pre-order it had capacity for.
    preferredType: fulfillmentType || (transportMethod ? 'pre_order' : null),
    capacity: view ? capacityFrom(view, optionValueIds) : null,
    transportMethod,
  });
  // A product with options or colours is sold as ONE of them. The relational
  // path enforces that in validateSelection; a legacy JSON-column product
  // reached this point with no option at all and was added at the base
  // price — a line the shop never offers. saleAvailability already knows
  // (it is what disables the storefront button), so the cart listens to it.
  // Checked before stock so "choose an option" wins over "out of stock".
  refuseIncompleteSelection(availability);
  // THE ORDER TYPE IS HONOURED OR REFUSED, NEVER QUIETLY SWAPPED. Without
  // this, "buy now" on a model whose last unit had gone fell through to the
  // pre-order branch and the line landed in the cart as a pre-order — a
  // different price, a different wait and a different counter than the one the
  // customer pressed.
  //
  // AND IT IS THE TYPE THIS ROW WILL BE, not the raw field. The door used to
  // hand `unusableOrderType` the body's `fulfillmentType` verbatim, which
  // answers null for anything that is not exactly one of the two types — so a
  // body carrying a TRANSPORT and no stated type (exactly what
  // src/components/orders/ReorderButton.tsx builds) was validated against the
  // descriptive fallback, admitted against the SHELF, and stored as a row that
  // both `GET /api/cart` and `POST /api/orders` then type `pre_order`: admitted
  // against one counter and described by another in the same response.
  // `lineOrderType` is the read model's own rule and the checkout's own rule.
  const statedAdd = unusableOrderType(availability, lineOrderType(availability, fulfillmentType, transportMethod));
  if (statedAdd) throw badRequest(statedAdd.message, statedAdd.code);
  if (availability.mode === 'unavailable') {
    throw badRequest(
      availability.reason === 'OUT_OF_STOCK'
        ? 'That selection is out of stock.'
        : availability.reason === 'PREORDER_CAPACITY_EXHAUSTED'
          ? // "Out of stock" would be a lie about a pre-order: there is no
            // shelf, the IMPORT QUOTA is full. The customer needs to know it is
            // a different wait, not a different shop.
            'The pre-order quota for this selection is full.'
          : `This item cannot be added right now (${availability.reason ?? 'UNAVAILABLE'})`,
      availability.reason ?? 'UNAVAILABLE'
    );
  }
  if (!availability.qty_ok) throw refuseQty(availability);

  // ONE SHIPPING TYPE PER CART and ONE SELLER PER CART, checked before
  // anything is written — the same two rules, in the same function, for an
  // ordinary product and for a bundle.
  await enforceCartScope(c, typeForTransport(transportMethod), body.replaceCart === true);

  // shipping_method_id stays '' — legacy column kept for the UNIQUE key only,
  // pricing is entirely resolver-driven now.
  // The full selection is stored canonically sorted so two requests that name
  // the same values in a different order are the same line. option_id is the
  // lexically first canonical value as well: it participates in the unique
  // key, so tying it to mutable admin group order would let reordering groups
  // create a duplicate of the exact same option_value_ids selection. Pricing
  // already used authored group order in resolveCartLine above and stays
  // deliberately separate from this persisted identity.
  const canonical = canonicalOptionValueIds(optionValueIds);
  const canonicalJson = optionValueIdsJson(canonical);
  const primaryOption = canonical[0] ?? '';

  // ONE PLAN PER LINE, AND THE LINE'S PLAN IS THE CUSTOMER'S TO CHANGE. The
  // merge key (user, product, option, colour) says nothing about the warranty,
  // so a second add of the same printer lands on the existing line — and must
  // not rewrite its extended-warranty choice on the way in: a chosen +24 would
  // vanish from both units, or a plan would be applied to a unit the customer
  // never picked it for. An add that names a DIFFERENT plan than the line
  // holds (including a line with none) is refused, naming the fix; an add that
  // names none keeps the line's plan (the CASE in the upsert below).
  const existingLine = await c.env.DB
    .prepare(
      `SELECT id, warranty_plan_id FROM cart_items
        WHERE user_id = ? AND product_id = ? AND option_id = ? AND option_value_ids = ?
          AND color_id = ? AND shipping_method_id = ''`
    )
    .bind(user.id, productId, primaryOption, canonicalJson, colorId)
    .first<{ id: string; warranty_plan_id: string | null }>();
  if (existingLine && warrantyPlanId && warrantyPlanId !== String(existingLine.warranty_plan_id ?? '')) {
    throw conflict(
      'This printer is already in your cart with a different extended-warranty choice — change it from the cart.',
      CART_WARRANTY_CONFLICT
    );
  }

  // Intentionally targetless for the same three-schema rollout as the bundle
  // upsert above: old-only, v1+v2, then v2-only. Stage C enables the multi-
  // group UI only after the separate 0083 contract deployment completes.
  await c.env.DB.prepare(
    `INSERT INTO cart_items (id, user_id, product_id, option_id, option_value_ids, color_id,
                             shipping_method_id, transport_method, fulfillment_type, warranty_plan_id, qty)
     VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?)
     ON CONFLICT DO UPDATE SET qty = MIN(99, qty + excluded.qty),
                   option_value_ids = excluded.option_value_ids,
                   transport_method = excluded.transport_method,
                   fulfillment_type = excluded.fulfillment_type,
                   warranty_plan_id = CASE WHEN excluded.warranty_plan_id = ''
                                           THEN cart_items.warranty_plan_id
                                           ELSE excluded.warranty_plan_id END`
  )
    .bind(
      newId('ci'), user.id, productId, primaryOption, canonicalJson, colorId,
      transportMethod, fulfillmentType, warrantyPlanId, qty
    )
    .run();

  const { items, tier: t, tierActive: ta } = await loadCart(c);

  // `AddToCart` (03-EVENTS.md §3.5) — `best_effort` BY DESIGN: it is fired at
  // the subscribers over RPC in `waitUntil` and never written to the outbox,
  // because five D1 writes per add-to-cart in the customer database would buy
  // nothing a dropped telemetry event costs. The price is the one the cart
  // just resolved, not a second lookup.
  if (eventsEnabled(c.env)) {
    const line = items.find(
      (it) =>
        String(it.productId) === productId &&
        sameOptionValueIds(Array.isArray(it.option_value_ids) ? it.option_value_ids : [], canonical) &&
        String(it.color_id ?? '') === colorId
    );
    await emitBestEffort(
      c.env.DB,
      AddToCartV1,
      {
        user_hash: await dailyUserHash(user.id),
        product_id: productId,
        line_key: `${productId}:${canonicalJson}:${colorId}`,
        qty,
        seller_type: 'platform',
        price_iqd_snapshot: Math.max(0, Math.round(Number(line?.unit_price_iqd ?? 0))),
      },
      { aggregateId: user.id, actorId: user.id, waitUntil: waitUntilFrom(c) }
    );
  }

  return c.json({ success: true, items, tier: t, tierActive: ta });
});

/**
 * EDIT ONE BUNDLE LINE — a quantity, or a different set of choices (§10).
 *
 * A quantity above `min(max_bundles, max_qty_per_order, 99)` is REFUSED with
 * `BUNDLE_QTY_LIMIT` naming the number, never silently clamped: the cart
 * already refuses a quantity rather than rewriting the one number the customer
 * is touching, and the composition availability exposes `max_qty` so the
 * stepper disables at the limit before they get there.
 *
 * A CHOICE EDIT RECOMPUTES THE LINE IDENTITY, which may merge this line into
 * another one that already holds the same choices — and the response says so
 * (`merged_into`), rather than leaving the customer with two lines they cannot
 * tell apart or one that silently swallowed the other.
 */
async function patchCompositionLine(
  c: Context<AppContext>,
  existing: Record<string, unknown>,
  product: Record<string, unknown>,
  body: Record<string, unknown>
) {
  const user = c.get('user')!;
  const id = String(existing.id);
  const productId = String(product.id);
  const label = String(product.name_ar || product.name || productId);
  const qty = body.qty !== undefined ? int(body.qty, 'qty', { min: 1, max: 99 }) : Number(existing.qty) || 1;

  // §7.5 / §15.1 rule 9 — the same per-user bound as the add and the quote.
  await rateLimit(c, 'composition_quote', 60, 300);

  const [{ tier, active: tierActive, status, ctx }, loaded, storedChoices] = await Promise.all([
    cartPricing(c),
    loadBundleComponents(c.env.DB, [productId]),
    loadCartChoices(c.env.DB, [id]),
  ]);
  const isMystery = String(product.composition) === 'mystery';
  const components: BundleComponentRow[] = loaded.byBundle.get(productId) ?? [];
  if (components.length === 0 && !isMystery) throw badRequest(`"${label}" is not available right now`, 'OFFER_INACTIVE');

  // An edit that names no choices keeps the ones the line already holds; one
  // that names them is re-validated from scratch against the admin's rows.
  // A mystery line has nothing to edit but its quantity.
  const editing = !isMystery && body.bundleChoices !== undefined;
  const choices = isMystery
    ? new Map<string, ComponentChoice>()
    : editing
      ? resolveChoiceSet(components, parseBundleChoices(body.bundleChoices), label)
      : restoreChoiceSet(components, storedChoices.get(id));

  const joined = await loadCompositionRows(c.env.DB, [productId]);
  const row = joined.get(productId);
  if (!row) throw notFound('Cart item not found');
  const method = String(existing.transport_method ?? '');
  const resolvedMap = await resolveCompositionLines(
    c.env.DB,
    // The line's STORED route — the same one the mystery pre-pass below reads,
    // and the one the checkout will resolve this line with.
    [{ key: productId, row, choices, transportMethod: method }],
    { tier, tierActive, proPolicy: ctx.proPolicy, transportDefaults: ctx.transportDefaults, status, nowMs: Date.now() }
  );
  let mysteryCtx: MysteryContext | null = null;
  if (isMystery) {
    const ctxs = await resolveMysteryLines(
      c.env.DB,
      [{ key: productId, bundle: resolvedMap.get(productId)!, familyId: mysteryFamilyOf(existing), transportMethod: method }],
      Date.now()
    );
    applyMysteryToBundles(ctxs, resolvedMap);
    mysteryCtx = ctxs.get(productId) ?? null;
  }
  const b = resolvedMap.get(productId)!;
  if (mysteryCtx) refuseMystery(mysteryCtx, label);
  refuseComposition(b, qty, label, isMystery ? {} : { transportMethod: method });
  refusePhysicalLines(mysteryCtx ? mysteryPhysicalLines(mysteryCtx, qty) : physicalLines(b, qty));

  const key = isMystery
    ? compositionKey(mysteryKeyInput(mysteryFamilyOf(existing)))
    : compositionKey(keyInput(choices));
  const identityIds = canonicalOptionValueIds(isMystery ? [mysteryFamilyOf(existing)] : []);
  const identityJson = optionValueIdsJson(identityIds);
  const currentKey = String(existing.option_id ?? '');
  let mergedInto: string | null = null;
  if (key !== currentKey) {
    const twin = await c.env.DB
      .prepare(
        `SELECT id, qty FROM cart_items
          WHERE user_id = ? AND product_id = ? AND option_id = ? AND option_value_ids = ?
            AND color_id = '' AND shipping_method_id = '' AND id <> ?`
      )
      .bind(user.id, productId, key, identityJson, id)
      .first<{ id: string; qty: number }>();
    if (twin) {
      // The same bundle with the same choices is the same line. The two are
      // merged rather than left as two rows that render identically, and the
      // merged quantity is judged against the cap like any other add.
      const total = Math.min(99, (Number(twin.qty) || 0) + qty);
      refuseComposition(b, total, label);
      mergedInto = twin.id;
      await c.env.DB.batch([
        c.env.DB.prepare('UPDATE cart_items SET qty = ? WHERE id = ? AND user_id = ?').bind(total, twin.id, user.id),
        c.env.DB.prepare('DELETE FROM cart_items WHERE id = ? AND user_id = ?').bind(id, user.id),
        ...cartChoiceStatements(c.env.DB, user.id, productId, key, identityIds, choices),
      ]);
      const cart = await loadCart(c);
      return c.json({ success: true, items: cart.items, tier: cart.tier, tierActive: cart.tierActive, merged_into: mergedInto });
    }
  }

  await c.env.DB.batch([
    c.env.DB
      .prepare('UPDATE cart_items SET qty = ?, option_id = ?, option_value_ids = ? WHERE id = ? AND user_id = ?')
      .bind(qty, key, identityJson, id, user.id),
    ...cartChoiceStatements(c.env.DB, user.id, productId, key, identityIds, choices),
  ]);

  const { items, tier: t, tierActive: ta } = await loadCart(c);
  return c.json({ success: true, items, tier: t, tierActive: ta });
}

/** The stored choices, re-checked against the components as they are TODAY. A
 *  component the admin pinned or removed since the line was written makes the
 *  stored row illegal, and it is refused by name rather than carried on. */
function restoreChoiceSet(
  components: BundleComponentRow[],
  stored: Map<string, ComponentChoice> | undefined
): Map<string, ComponentChoice> {
  const submitted = components
    .filter((c) => c.customer_picks_option || c.customer_picks_color || c.optional)
    .map((c) => {
      const ch = stored?.get(c.id);
      return {
        componentId: c.id,
        optionValueIds: c.customer_picks_option ? (ch?.option_value_ids ?? []) : [],
        colorId: c.customer_picks_color ? (ch?.color_id ?? '') : '',
        included: ch ? ch.included : true,
      };
    });
  return resolveChoiceSet(components, submitted, '');
}

cartRoutes.patch('/items/:id', async (c) => {
  const user = c.get('user')!;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));

  const existing = await c.env.DB.prepare('SELECT * FROM cart_items WHERE id = ? AND user_id = ?')
    .bind(id, user.id)
    .first<Record<string, unknown>>();
  if (!existing) throw notFound('Cart item not found');

  const lineProduct = await c.env.DB.prepare('SELECT id, name, name_ar, composition FROM products WHERE id = ?')
    .bind(existing.product_id)
    .first<Record<string, unknown>>();
  if (lineProduct && String(lineProduct.composition ?? '') !== '') {
    return await patchCompositionLine(c, existing, lineProduct, body);
  }

  const qty = body.qty !== undefined ? int(body.qty, 'qty', { min: 1, max: 99 }) : (existing.qty as number);
  const submittedOptionId =
    body.optionId !== undefined ? str(body.optionId, 'optionId', { max: 60, required: false }) : null;
  const patchRawIds: unknown[] = Array.isArray(body.optionValueIds) ? body.optionValueIds : [];
  const optionValueIds =
    body.optionValueIds !== undefined
      ? canonicalOptionValueIds(patchRawIds, submittedOptionId ?? '').slice(0, 12)
      : submittedOptionId !== null
        ? canonicalOptionValueIds([], submittedOptionId)
        : canonicalOptionValueIds(selectionFromCartRow(existing).optionValueIds ?? []);
  const optionId = optionValueIds[0] ?? '';
  const colorId =
    body.colorId !== undefined ? str(body.colorId, 'colorId', { max: 60, required: false }) : String(existing.color_id);
  const transportMethod =
    body.transportMethod !== undefined
      ? parseTransportMethod(body.transportMethod)
      : String(existing.transport_method ?? '');
  const fulfillmentType =
    body.fulfillmentType !== undefined
      ? parseFulfillmentType(body.fulfillmentType)
      : String(existing.fulfillment_type ?? '');
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

  const [{ tier, active: tierActive, ctx }, views, isPrinter] = await Promise.all([
    cartPricing(c),
    loadRelationsViews(c.env.DB, [{ id: String(existing.product_id), inventory_mode: product.inventory_mode }]),
    // Setting or changing the plan from the cart's disclosure runs the same
    // printers-only gate as the add; clearing it ('') needs no check.
    warrantyPlanId ? isPrinterProduct(c.env.DB, String(existing.product_id)) : Promise.resolve(false),
  ]);
  refuseNonPrinterWarranty(isPrinter, warrantyPlanId);
  const view = views.get(String(existing.product_id));
  const { doc, resolved, selectionErrors } = resolveCartLine(
    product,
    { optionId, optionValueIds, colorId, transportMethod, fulfillmentType, warrantyPlanId },
    tier,
    tierActive,
    ctx,
    view,
    'prepaid',
    isPrinter
  );
  if (offerPriceRefusal(resolved.errors)) {
    throw badRequest('This offer is not available right now', 'OFFER_INACTIVE');
  }
  if (resolved.errors.length > 0) {
    throw badRequest(`Invalid selection: ${resolved.errors.join(', ')}`, 'VALIDATION');
  }
  if (selectionErrors.length > 0) {
    throw badRequest(`Invalid selection: ${selectionErrors.join(', ')}`, 'VALIDATION');
  }

  // §8.2 row 18, on the PATCH door as well: "Only N left" from a qty bump is
  // the same oracle the add path carried.
  const coarseStock =
    (
      await degradeIfSchemaMissing(
        'mystery pools (migration 0061)',
        () => activePoolProductIds(c.env.DB, [String(existing.product_id)]),
        new Set<string>()
      )
    ).size > 0;
  const availability = saleAvailability(doc, {
    optionValueIds,
    colorId: colorId || null,
    qty,
    coarseStock,
    transportDefaults: ctx.transportDefaults,
    inventory: view
      ? snapshotFrom(view, {
          stock: doc.stock,
          reserved: Number(product.stock_reserved ?? 0),
          low_stock_threshold: (product.low_stock_threshold as number | null) ?? null,
        })
      : undefined,
    links: view?.links,
    // The same rule as the add door: the stored/incoming ORDER TYPE decides
    // which counter this line is judged against (DECISION 4).
    preferredType: fulfillmentType || (transportMethod ? 'pre_order' : null),
    capacity: view ? capacityFrom(view, optionValueIds) : null,
    transportMethod,
  });
  // An update may also CLEAR a chosen option (an explicit empty list is the
  // new selection) — the same rule as an add.
  refuseIncompleteSelection(availability);
  // The same rule on the edit door, typed the same way: changing the quantity
  // of a pre-order must not silently re-type the line when its quota filled up,
  // and a PATCH that carries a transport with no stated type is the same row
  // the add door writes.
  const statedPatch = unusableOrderType(availability, lineOrderType(availability, fulfillmentType, transportMethod));
  if (statedPatch) throw badRequest(statedPatch.message, statedPatch.code);
  if (availability.mode === 'unavailable') {
    throw badRequest(
      availability.reason === 'PREORDER_CAPACITY_EXHAUSTED'
        ? 'The pre-order quota for this selection is full.'
        : `This item cannot be updated right now (${availability.reason ?? 'UNAVAILABLE'})`,
      availability.reason ?? 'UNAVAILABLE'
    );
  }
  if (!availability.qty_ok) throw refuseQty(availability);

  const canonical = canonicalOptionValueIds(optionValueIds);
  const canonicalJson = optionValueIdsJson(canonical);
  // Stable line identity, never the mutable authored group order. The price
  // was resolved above through resolveCartLine, which orders this same set by
  // active relation groups without changing what is stored or indexed.
  const primaryOption = canonical[0] ?? '';
  const shippingMethodId = String(existing.shipping_method_id ?? '');

  // Editing a line into an already-existing complete selection must be a
  // named conflict, not a UNIQUE-index exception and generic 500.
  const identityTwin = await c.env.DB
    .prepare(
      `SELECT id FROM cart_items
        WHERE user_id = ? AND product_id = ? AND option_id = ? AND option_value_ids = ?
          AND color_id = ? AND shipping_method_id = ? AND id <> ?`
    )
    .bind(user.id, existing.product_id, primaryOption, canonicalJson, colorId, shippingMethodId, id)
    .first<{ id: string }>();
  if (identityTwin) {
    throw conflict(
      'This exact option and colour combination is already in your cart.',
      'CART_LINE_ALREADY_EXISTS'
    );
  }
  await c.env.DB.prepare(
    `UPDATE cart_items SET qty = ?, option_id = ?, option_value_ids = ?, color_id = ?,
            transport_method = ?, fulfillment_type = ?, warranty_plan_id = ?
      WHERE id = ? AND user_id = ?`
  )
    .bind(
      qty, primaryOption, canonicalJson, colorId,
      transportMethod, fulfillmentType, warrantyPlanId, id, user.id
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
     ON CONFLICT (user_id, community_product_id, option_id, color_id)
       WHERE community_product_id IS NOT NULL
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

/**
 * Change a merchant line's quantity. The platform PATCH cannot serve these
 * lines — it validates against the Levonis catalogue resolver, which a
 * community product deliberately never enters (§15) — so the merchant cart
 * gets its own two verbs with the same ownership rule: the WHERE clause.
 */
cartRoutes.patch('/merchant-items/:id', async (c) => {
  const user = c.get('user')!;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const qty = int(body.qty, 'qty', { min: 1, max: 99 });

  const line = await c.env.DB.prepare(
    `SELECT ci.id, p.stock, p.track_stock, p.lifecycle, p.status
       FROM cart_items ci JOIN community_products p ON p.id = ci.community_product_id
      WHERE ci.id = ? AND ci.user_id = ? AND ci.seller_type = 'merchant'`
  ).bind(id, user.id).first<Record<string, unknown>>();
  if (!line) throw notFound('Cart item not found');
  if (line.lifecycle !== 'active' || line.status !== 'active') {
    throw badRequest('This product is no longer available', 'UNAVAILABLE');
  }
  if (line.track_stock && Number(line.stock) < qty) {
    throw badRequest('Not enough stock for that quantity', 'OUT_OF_STOCK', { available: Number(line.stock) });
  }

  await c.env.DB.prepare('UPDATE cart_items SET qty = ? WHERE id = ? AND user_id = ?')
    .bind(qty, id, user.id).run();
  return c.json({ success: true, ...(await loadMerchantCart(c)) });
});

cartRoutes.delete('/merchant-items/:id', async (c) => {
  const user = c.get('user')!;
  await c.env.DB.prepare(
    `DELETE FROM cart_items WHERE id = ? AND user_id = ? AND seller_type = 'merchant'`
  ).bind(c.req.param('id'), user.id).run();
  return c.json({ success: true, ...(await loadMerchantCart(c)) });
});
