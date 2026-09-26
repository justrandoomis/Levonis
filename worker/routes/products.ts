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

import { likePattern, sqlLikeClause } from '../lib/sqlLike';
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
import { isConditionColumnMissing } from '../lib/conditionProjection';
import { catalogSubtreeFilter, homeCategoryTree } from '../lib/catalogMembership';
import { FACET_FIELD_IDS, parseListingParams } from '@levonis/catalog/discovery';
import { runListing, type BrandInfo, type ListingItem } from '../lib/listingFacets';
import {
  catalogIdForRetiredSlug,
  catalogIndexFor,
  productTypeOf,
  type CatalogIndex,
} from '../lib/catalogPresentation';
import { searchProducts } from '../lib/search/store';
import { suggestCompletion } from '../lib/search/complete';
import {
  SHELF_LIMIT,
  bestSellerIds,
  featuredIds,
  filamentCandidateIds,
  flashDealIds,
  seededShuffle,
  shuffleSeed,
} from '../lib/homeShelves';
import { isUnitExpressible, withinWindow } from '@levonis/pricing/membershipBenefits';
import { LINE_QTY_MAX, QTY_INPUT_MAX } from '@levonis/pricing/quantity';
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
import { resolveSiteMedia } from '../lib/siteMedia';
import { normalizeHomeBento } from '../lib/homeBento';
import { conditionSaving, parseConditionDoc } from '../lib/condition';
import { salesBadgeFor } from '../lib/salesBadge';
import { pricedPlans, WARRANTY_NOT_PRINTER } from '../lib/warrantyPlans';
import {
  canonicalOptionValueIds as canonicalSelectionOptionValueIds,
  optionValueIdsInRelationOrder,
} from '../lib/cartSelectionIdentity';

export const productRoutes = new Hono<AppContext>();

// ---------------------------------------------------------------- helpers

/**
 * Normalize a quote request's complete option selection in the same two
 * phases as the cart: first give the set one order-independent identity, then
 * restore the catalogue's authored group order for pricing. The latter is
 * important because the first authored group is the price-bearing model;
 * client array order must never be allowed to choose a different override.
 */
export function quoteOptionValueIds(
  submitted: unknown,
  legacyOptionId: unknown,
  relations: Pick<ProductRelationsView, 'groups' | 'values'>
): string[] {
  const canonical = canonicalSelectionOptionValueIds(
    Array.isArray(submitted) ? submitted : [],
    legacyOptionId
  ).slice(0, 12);
  return optionValueIdsInRelationOrder(canonical, relations);
}

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

/* --------------------------------------------- «المخفَّضة» — what is on offer */

/**
 * WHICH PRODUCTS THE WORD «مخفّض» NAMES — ONE ANSWER, FOR BOTH SURFACES.
 *
 * THE DEFECT THIS EXISTS FOR. Two places decide it: the home page's
 * «المخفَّضة» strip and `/api/products?type=discounted` behind its «عرض الكل».
 * Both asked the same obsolete question —
 *
 *     (pro_price_iqd IS NOT NULL AND pro_price_iqd < price_iqd)
 *  OR (prime_price_iqd IS NOT NULL AND prime_price_iqd < price_iqd)
 *
 * — "is there a TYPED tier price below the regular one?". That was the whole
 * truth while the only way to state a membership discount was to type a number
 * on every product. It stopped being the whole truth at migration 0074, when
 * `membership_benefit_rules` let the owner say «PRO 10% على الطابعات» ONCE —
 * which is how this shop actually states BOTH memberships. Live,
 * `/api/products/bambu-lab-a1` returns `pro_price_iqd: null` and
 * `prime_price_iqd: null` while its `membership_preview` carries a PRIME
 * saving of 15,000 and a PRO saving of 67,500. The only product in the
 * catalogue has two real discounts, both queries matched zero rows, and a
 * customer opening the shop concluded it runs no offers at all.
 *
 * THE OLD QUESTION IS KEPT, NOT REPLACED — the owner asked for this in so many
 * words. A typed `pro_price_iqd` below the regular price is the owner stating
 * a discount for that exact product, and it OUTRANKS any rule (`memberPrice`
 * in packages/pricing/src/pricing.ts). Dropping it to gain the rules would
 * trade one empty shelf for another. The predicate is the UNION.
 *
 * AND IT IS ONE FUNCTION, called from both places, because a fix applied to
 * one of them leaves the strip and the listing behind its own «عرض الكل»
 * disagreeing about what the word means — which is worse than being
 * consistently wrong, and impossible to report.
 *
 * WHAT IT COSTS: NOTHING. No new query, on either surface. `pricingCtx` already
 * loads every enabled rule and the whole `catalogs` ancestry ONCE per request
 * — it has to, because the product page's membership teaser needs them — so
 * the rules are already in memory before either statement is built. Asking D1
 * per product instead would be N+1 on the shop's first screen; asking it once
 * per request is what this reuses. The rules are turned into ONE `WHERE`
 * fragment carrying AT MOST TWO bound parameters (a JSON array each), so the
 * 100-parameter ceiling D1 refuses past is not approached however many rules
 * the owner writes.
 */

/**
 * Whether a rule still describes a real saving a CARD can print.
 *
 * `unitDiscountIqd` returns 0 for a percent/fixed of zero and for a per-unit
 * ceiling of zero, so a rule configured that way reaches products without
 * discounting them. Putting such a product on the offers shelf would be the
 * same empty promise from the other direction.
 */
function quotableDiscount(rule: BenefitRule): boolean {
  if (rule.cap_scope === 'per_unit' && rule.max_discount_iqd !== null && rule.max_discount_iqd <= 0) return false;
  if (rule.discount_mode === 'percent') return rule.percent !== null && Number.isFinite(rule.percent) && rule.percent > 0;
  if (rule.discount_mode === 'fixed') return rule.fixed_iqd !== null && Number.isFinite(rule.fixed_iqd) && rule.fixed_iqd > 0;
  return false;
}

/**
 * The rules that may put a product on the offers shelf.
 *
 * A SCHEDULED OR EXPIRED RULE IS NOT A DISCOUNT TODAY. `withinWindow` is the
 * same test `selectRule` applies when the cart prices the line, judged against
 * `ctx.benefitNowIso` — the clock frozen once per request — so a rule that
 * ended last week cannot badge a product, and one that starts next month
 * cannot either. Two shelves in one response can never disagree about whether
 * a dated rule was live, for the same reason.
 *
 * `isUnitExpressible` is the other filter, and it is what keeps the badge
 * honest. A rule whose effect depends on the ORDER — «أول قطعتين», a per-order
 * ceiling, a minimum subtotal — cannot be written as a unit price, so
 * `fallbackFor` deliberately keeps it out of the price resolver and the card
 * has no number to print for it. Letting it onto the shelf would put a card
 * there that looks exactly like every un-discounted card.
 *
 * Only PRIME and PRO. `membership_benefit_rules.tier` also accepts 'plus', but
 * PLUS is an offer-scoped rung (§4.4) that no ordinary product emits and no
 * card teases, so a PLUS rule has nothing to show here.
 */
export function shelfDiscountRules(ctx: PricingCtx): BenefitRule[] {
  return ctx.benefitRules.filter(
    (rule) =>
      rule.enabled &&
      rule.benefit_type === 'product_discount' &&
      (rule.tier === 'prime' || rule.tier === 'pro') &&
      withinWindow(rule, ctx.benefitNowIso) &&
      isUnitExpressible(rule) &&
      quotableDiscount(rule)
  );
}

/** The typed half of the union — the question both surfaces asked before. */
const TYPED_TIER_DISCOUNT =
  '(products.pro_price_iqd IS NOT NULL AND products.pro_price_iqd < products.price_iqd)' +
  ' OR (products.prime_price_iqd IS NOT NULL AND products.prime_price_iqd < products.price_iqd)';

/**
 * The whole `«مخفّض»` predicate as a parenthesised `WHERE` fragment, with its
 * own bindings.
 *
 * WHY THE SECTION RULES BECOME A RECURSIVE CTE AND NOT A LIST OF IDS. A rule
 * written on «الطابعات» reaches a product filed under «الطابعات ← FDM ←
 * Bambu»: `scopeMatches` tests the rule's catalog against the product's whole
 * ANCESTRY, not against the id on the row. Expanding that branch in TypeScript
 * would mean binding one parameter per descendant catalog, and a taxonomy that
 * grows past ~90 of them would start being refused by D1 mid-request — a
 * failure that arrives with the shop's growth and not with this change. The
 * CTE walks DOWN from the rule's own catalog inside SQLite instead, so the
 * whole set costs ONE parameter however deep the tree gets. `UNION` (not
 * `UNION ALL`) terminates a cycle, exactly as `catalogSubtreeFilter` does.
 *
 * It matches `category_id` / `sub_category_id` ONLY — deliberately NOT
 * `product_catalogs`. A placement says which shelves list a product; the rule
 * engine reads the CLASSIFICATION columns and nothing else
 * (`ancestryFor`), so folding placements in here would badge products the
 * resolver then refuses to discount.
 *
 * A KNOWN, BOUNDED IMPRECISION, stated rather than hidden: `selectRule` picks
 * the MOST SPECIFIC matching rule, so a product-scoped «اشترِ اثنتين» rule can
 * shadow a section-wide percentage that would otherwise have priced it. This
 * fragment tests "is any quotable rule reaching this product", which cannot see
 * that shadowing, so such a product appears on the shelf with no member number
 * on its card. It is a SUPERSET, never a wrong amount — the card prints only
 * what `resolveUnitPrice` returns, and for that product it returns nothing. A
 * sharper test would have to be per product, which is the N+1 this design
 * exists to avoid.
 */
export function discountedWhere(ctx: PricingCtx): { sql: string; params: string[] } {
  const rules = shelfDiscountRules(ctx);
  /**
   * A GLOBAL RULE REACHES EVERY PRODUCT, so the predicate is simply true and
   * the shelf is the catalogue. Not a special case being clever — it is what
   * «خصم على كل شيء» means, and narrowing it would hide products that really
   * are discounted.
   */
  if (rules.some((rule) => rule.scope === 'global')) return { sql: '(1 = 1)', params: [] };

  const ids = (pick: (r: BenefitRule) => string | null) => [
    ...new Set(rules.map(pick).filter((id): id is string => typeof id === 'string' && id !== '')),
  ];
  const productIds = ids((r) => (r.scope === 'product' ? r.product_id : null));
  // Both section scopes resolve against the SAME ancestry union in
  // `scopeMatches`, so one branch walk answers both.
  const catalogIds = ids((r) =>
    r.scope === 'category' ? r.category_id : r.scope === 'sub_category' ? r.sub_category_id : null
  );

  const parts = [TYPED_TIER_DISCOUNT];
  const params: string[] = [];
  if (productIds.length > 0) {
    parts.push('products.id IN (SELECT value FROM json_each(?))');
    params.push(JSON.stringify(productIds));
  }
  if (catalogIds.length > 0) {
    parts.push(`products.id IN (
      WITH RECURSIVE benefit_branch(id) AS (
        SELECT value FROM json_each(?)
        UNION
        SELECT c.id FROM catalogs c JOIN benefit_branch b ON c.parent_id = b.id
      )
      SELECT p.id FROM products p JOIN benefit_branch b ON b.id = p.category_id
      UNION
      SELECT p.id FROM products p JOIN benefit_branch b ON b.id = p.sub_category_id
    )`);
    params.push(JSON.stringify(catalogIds));
  }
  return { sql: `(${parts.join('\n      OR ')})`, params };
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

/** The per-line storage ceiling (`cart_items.qty <= 99`), one constant for every door. */
const QTY_CEILING = LINE_QTY_MAX;

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
  const declaredActiveOptions = doc.options.filter((o) => o.active !== false);
  const inventoryGroupOf = new Map(
    (input.inventory?.option_values ?? []).map((value) => [value.id, value.group_id] as const)
  );
  const activeInventoryGroups = new Set(input.inventory?.group_ids ?? []);
  const hasRelationalGroupRows = input.inventory?.has_group_rows === true;
  const activeOptions =
    input.inventory && (hasRelationalGroupRows || input.inventory.group_ids.length > 0)
      ? declaredActiveOptions.filter((option) => {
          const groupId = inventoryGroupOf.get(option.id);
          return !!groupId && activeInventoryGroups.has(groupId);
        })
      : declaredActiveOptions;
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
    for (const chosen of chosenOptions) {
      const groupId = groupOf.get(chosen.id);
      if (groupId) groupSelection[groupId] = chosen.id;
    }
  }
  const colorSelectable = (c: { id: string; option_id: string | null }): boolean =>
    links.length
      ? colorVisibility(c.id, links, groupSelection).visible
      : !c.option_id || selectedValueIds.includes(c.option_id);

  if (color && !colorSelectable(color)) errors.push('COLOR_OPTION_MISMATCH');
  const selectableColors = activeColors.filter(colorSelectable);

  const optionRequired = activeOptions.length > 0;
  // Colour is a per-selection dimension. A mixed product may have colours for
  // model A while model B is intentionally colourless; only colours visible
  // for the current complete tuple make a colour mandatory.
  const colorRequired = selectableColors.length > 0;
  if (optionRequired && chosenOptions.length === 0) errors.push('OPTION_REQUIRED');
  if (input.inventory && input.inventory.group_ids.length > 0) {
    const groupOf = inventoryGroupOf;
    const requiredGroups = new Set(
      activeOptions
        .map((o) => groupOf.get(o.id))
        .filter((id): id is string => !!id && activeInventoryGroups.has(id))
    );
    const selectedPerGroup = new Map<string, number>();
    for (const id of selectedValueIds) {
      const groupId = groupOf.get(id);
      // A stale value under an inactive group is already rejected as
      // OPTION_INACTIVE above. Hidden groups do not also participate in the
      // public one-value-per-group completeness rule.
      if (!groupId || !activeInventoryGroups.has(groupId)) continue;
      selectedPerGroup.set(groupId, (selectedPerGroup.get(groupId) ?? 0) + 1);
    }
    if ([...selectedPerGroup.values()].some((count) => count > 1)) {
      errors.push('OPTION_GROUP_DUPLICATE_SELECTION');
    }
    if ([...requiredGroups].some((groupId) => (selectedPerGroup.get(groupId) ?? 0) === 0)) {
      errors.push('OPTION_GROUP_REQUIRED');
    }
  }
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
          : input.inventory.inventory_mode === 'OPTION'
            ? 'option'
            : input.inventory.inventory_mode === 'COLOR'
              ? 'color'
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
  /**
   * `sale_types` is derived by TWO different doors — `saleTypesFromCells` in
   * adminProductRelations.ts and `deriveSaleTypes` in productPersistence.ts —
   * so it can lag behind a model whose own cell says otherwise. The cell is
   * the more specific statement, so it counts as well.
   *
   * BEFORE A MODEL IS PICKED, THE ANSWER IS THE PRODUCT'S — WHICH IS THE UNION.
   *
   * The pre-order half of this filtered on `selectedValueIds` alone, so on the
   * FIRST PAINT — no option chosen, which is every visitor's first second on
   * the page — the set was empty and no cell was ever consulted. A product
   * whose every model offers pre-order with a priced route came back
   * `PREORDER_NOT_ENABLED`, `modes: [direct_sale]`, `transports: []`: the page
   * was told the product has no pre-order at all, so it drew no order-type
   * chooser, and the buyer had to guess that picking a model would reveal one.
   *
   * With nothing selected the honest answer is what the product OFFERS —
   * anywhere in its models. The moment a model is chosen the set narrows to
   * that model and every later answer is about it alone, exactly as before.
   */
  const cellScope = activeOptions.filter(
    (o) => selectedValueIds.length === 0 || selectedValueIds.includes(o.id)
  );
  const anyCellSays = (type: 'direct_sale' | 'pre_order') =>
    cellScope.some((o) => o.fulfillments?.some((f) => f.fulfillment_type === type && f.enabled !== false));
  /**
   * Every selected value that explicitly declares fulfilment participates in
   * the verdict. Modern cells win for their own value; a legacy
   * `availability_type` is still an explicit declaration; a value with
   * neither is neutral and inherits the selection/product answer.
   *
   * This matters for multi-group selections: [modern direct model + legacy
   * pre-order-only size] is NOT direct, while [modern direct model + neutral
   * size] is. Looking only at `selectedHasCells` used to erase the legacy
   * declaration as soon as any sibling group had a modern cell.
   */
  const selectedDeclarations = selectedValueIds.length > 0
    ? cellScope.filter(
        (o) =>
          (o.fulfillments?.length ?? 0) > 0 ||
          o.availability_type === 'direct_sale' ||
          o.availability_type === 'pre_order'
      )
    : [];
  const declarationAllows = (
    option: (typeof cellScope)[number],
    type: 'direct_sale' | 'pre_order'
  ): boolean => {
    const cells = option.fulfillments ?? [];
    if (cells.length > 0) {
      return cells.some((f) => f.fulfillment_type === type && f.enabled !== false);
    }
    return option.availability_type === type;
  };
  const selectedDeclarationsAllow = (type: 'direct_sale' | 'pre_order') =>
    selectedDeclarations.length > 0 && selectedDeclarations.every((o) => declarationAllows(o, type));
  const productDirect = saleTypes.includes('direct_sale') || saleTypes.includes('bundle');
  const productPreorder = saleTypes.includes('pre_order');

  const directEnabled = isComposition
    ? compositionModes.includes('direct_sale')
    : selectedDeclarations.length > 0
      ? selectedDeclarationsAllow('direct_sale')
      : productDirect || anyCellSays('direct_sale');
  const preorderEnabled = isComposition
    ? compositionModes.includes('pre_order')
    : selectedDeclarations.length > 0
      ? selectedDeclarationsAllow('pre_order')
      : productPreorder || anyCellSays('pre_order');

  /**
   * 0075 — WHAT ONE ROUTE'S COUNTER SAYS. `resolveCapacity` holds the whole
   * shared-versus-independent rule, so this function never re-implements it:
   * ask it per method and it answers with the route's own quota if there is
   * one and the model's shared pool otherwise.
   */
  // Pre-order is availability only. Legacy capacity columns may remain while
  // old reservations drain, but they no longer limit a customer-facing route
  // and are never presented as pre-order stock.
  const capacityFor = (_method: string) => resolveCapacity(null, '');

  /**
   * THE ROUTES THIS MODEL ACTUALLY OFFERS — the model's own first, the
   * product's list as the fallback it was always meant to be.
   *
   * THE BUG THIS FIXES. 0073 moved pre-order transports onto the MODEL, and
   * the admin's «نوع الطلب لكل موديل» door writes `product_option_fulfillment`
   * / `product_option_transports` and mirrors only `sale_types` back to the
   * product row — it never writes `products.preorder_transports`. This reader
   * consulted the product column alone, so a shop that enabled pre-order on a
   * model and gave it a LAND route got `transports.length === 0`, hence
   * `NO_TRANSPORT_OFFERED`, hence `preorderUsable === false`, hence no
   * order-type selector on the product page at all. Direct sale was the only
   * thing left standing and pre-order was unreachable — with the route sitting
   * configured in the admin the whole time.
   *
   * Reader and writer now agree. The ladder is FIRST-MATCH, never a sum, and
   * it is the same one `packages/pricing` applies when the line is quoted, so
   * the pill the page paints is the price the cart will charge:
   *
   *   1. this MODEL's row for this route (`surcharge_iqd`)
   *   2. the PRODUCT's commission for the method
   *   3. the admin default for the method
   */
  /**
   * THE ROUTES ARE READ OVER THE SAME SCOPE AS THE ORDER TYPES.
   *
   * `chosenOptions` is empty before a model is picked, so this produced no
   * cells, hence no `modelRoutes`, hence `offeredMethods` fell back to a
   * product column the per-model door never writes — `transports: []` and
   * `NO_TRANSPORT_OFFERED`. Answering "this product has no pre-order route"
   * while every one of its models has a priced LAND route is the same untruth
   * as the one above, one step further down.
   *
   * `cellScope` IS `chosenOptions` once anything is selected, so the priced
   * answer for a real selection is byte for byte what it was; only the
   * unselected first paint changes, from a false negative to the union.
   */
  const preorderCells = cellScope
    .map((o) => o.fulfillments?.find((f) => f.fulfillment_type === 'pre_order' && f.enabled !== false) ?? null)
    .filter((f): f is NonNullable<typeof f> => f !== null);
  const modelRoutes = preorderCells
    .flatMap((f) => f.transports ?? [])
    .filter((t) => t.enabled !== false);

  const productRoutes = doc.preorder_transports.filter((t) => t.active !== false);
  const commissionFor = (method: string): number => {
    const own = modelRoutes.find((t) => t.method === method)?.surcharge_iqd;
    if (own !== null && own !== undefined && Number.isInteger(own) && own >= 0) return own;
    const fromProduct = productRoutes.find((t) => t.method === method)?.commission_iqd;
    if (Number.isInteger(fromProduct)) return fromProduct as number;
    const fallback = defaults.find((d) => d.method === method);
    // An enabled route with no surcharge is a zero-increase route, not a
    // broken configuration. Availability is the checkbox; the amount is an
    // optional addition.
    return fallback ? fallback.commission_iqd : 0;
  };

  // A model that declares its own routes REPLACES the product list for this
  // selection; with none declared the product's list is what is on offer.
  const offeredMethods = modelRoutes.length
    ? [...new Set(modelRoutes.map((t) => t.method))]
    : productRoutes.map((t) => t.method);

  const transports: TransportOptionView[] = offeredMethods.map((method) => {
    const commission = commissionFor(method);
    return { method, commission_iqd: commission, configured: true };
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

  // A direct sale must name a real shelf. NULL used to mean “unlimited” and
  // let a misconfigured product sell without stock; it now fails closed. The
  // admin writers require either 0 (sold out) or a positive integer.
  const directUsable = directEnabled && tracked && available !== null && available > 0;
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

export interface InitialDirectSaleSelection {
  option_id: string | null;
  /** Complete relational choice; `option_id` remains for legacy clients. */
  option_value_ids: string[];
  color_id: string | null;
  fulfillment_type: 'direct_sale';
  availability: SaleAvailability;
}

interface ActiveOptionLayout {
  /** Active value ids, one array per represented group, in catalogue order. */
  groups: string[][];
  groupByOptionId: Map<string, string>;
  activeOptionIds: Set<string>;
}

/** Joins the public active option list to the inventory snapshot's group ids. */
function activeOptionLayout(
  doc: AvailabilityDoc,
  inventory: InventorySnapshot,
  allowedGroupIds?: ReadonlySet<string>
): ActiveOptionLayout {
  const declaredActiveOptionIds = new Set(doc.options.filter((o) => o.active !== false).map((o) => o.id));
  // `group_ids: []` is ambiguous by itself: it is both the old flat-option
  // shape and the result when every relational group is inactive. The
  // snapshot marker (or an explicit group set from the route) makes the
  // latter strict, so values from hidden groups cannot be rediscovered by the
  // rolling-deploy fallback below.
  const constrainedGroupIds = allowedGroupIds ?? (
    inventory.has_group_rows === true || inventory.group_ids.length > 0
      ? new Set(inventory.group_ids)
      : undefined
  );
  const activeOptionIds = constrainedGroupIds
    ? new Set(
        inventory.option_values
          .filter((row) => constrainedGroupIds.has(row.group_id) && declaredActiveOptionIds.has(row.id))
          .map((row) => row.id)
      )
    : declaredActiveOptionIds;
  const groupByOptionId = new Map<string, string>();
  const idsByGroup = new Map<string, string[]>();

  for (const row of inventory.option_values) {
    if (
      !activeOptionIds.has(row.id) ||
      !row.group_id ||
      (constrainedGroupIds && !constrainedGroupIds.has(row.group_id))
    ) continue;
    groupByOptionId.set(row.id, row.group_id);
    const ids = idsByGroup.get(row.group_id) ?? [];
    if (!ids.includes(row.id)) ids.push(row.id);
    idsByGroup.set(row.group_id, ids);
  }

  // `group_ids` is already in the admin's display order. Include a defensive
  // discovered tail for rolling-deploy fixtures/snapshots that predate it.
  const orderedGroupIds = [
    ...new Set([
      ...inventory.group_ids.filter((id) => idsByGroup.has(id)),
      ...idsByGroup.keys(),
    ]),
  ];
  return {
    groups: orderedGroupIds.map((id) => idsByGroup.get(id) ?? []).filter((ids) => ids.length > 0),
    groupByOptionId,
    activeOptionIds,
  };
}

function completeActiveOptionSelection(ids: string[], layout: ActiveOptionLayout): boolean {
  if (layout.groups.length === 0) {
    // Legacy flat options are one chooser even though no group row exists.
    return layout.activeOptionIds.size === 0
      ? ids.length === 0
      : ids.length === 1 && layout.activeOptionIds.has(ids[0]);
  }
  const counts = new Map<string, number>();
  for (const id of ids) {
    if (!layout.activeOptionIds.has(id)) return false;
    const groupId = layout.groupByOptionId.get(id);
    if (!groupId) return false;
    counts.set(groupId, (counts.get(groupId) ?? 0) + 1);
  }
  return layout.groups.every((group) => {
    const groupId = layout.groupByOptionId.get(group[0]);
    return !!groupId && counts.get(groupId) === 1;
  });
}

interface ParsedVariantSelection {
  optionValueIds: string[];
  colorId: string | null;
  normalizedKey: string;
}

type DirectDeclaration = 'allow' | 'block' | 'neutral';

/** The same per-value declaration rule used by canonical availability. */
function directDeclarationForOption(
  option: AvailabilityDoc['options'][number] | undefined
): DirectDeclaration {
  if (!option) return 'block';
  const cells = option.fulfillments ?? [];
  if (cells.length > 0) {
    return cells.some(
      (cell) => cell.fulfillment_type === 'direct_sale' && cell.enabled !== false
    )
      ? 'allow'
      : 'block';
  }
  if (option.availability_type === 'direct_sale') return 'allow';
  if (option.availability_type === 'pre_order') return 'block';
  return 'neutral';
}

/** Strict parser: stale/ambiguous variant rows are not public inventory. */
function parseVariantSelection(combo: string): ParsedVariantSelection | null {
  const optionValueIds: string[] = [];
  let colorId: string | null = null;
  for (const token of combo.split('|').filter(Boolean)) {
    if (token.startsWith('o:')) {
      const id = token.slice(2);
      if (!id || optionValueIds.includes(id)) return null;
      optionValueIds.push(id);
      continue;
    }
    if (token.startsWith('c:')) {
      const id = token.slice(2);
      if (!id || colorId !== null) return null;
      colorId = id;
      continue;
    }
    return null;
  }
  const normalizedKey = [
    ...[...optionValueIds].sort().map((id) => `o:${id}`),
    ...(colorId ? [`c:${colorId}`] : []),
  ].join('|');
  return { optionValueIds, colorId, normalizedKey };
}

/**
 * The first complete selection that the SAME availability engine proves can
 * be sold from the shelf. This is the product page's opening selection; it is
 * intentionally server-derived so OPTION, COLOR, VARIANT_COMBINATION,
 * reservations, colour links and disabled fulfilment cells cannot drift from
 * what cart/checkout will enforce.
 */
export function firstUsableDirectSelection(
  sourceDoc: AvailabilityDoc,
  input: {
    inventory: InventorySnapshot;
    links?: ColorLinkRow[];
    /** Active relation groups; inactive groups never demand a storefront choice. */
    activeGroupIds?: ReadonlySet<string>;
    transportDefaults?: Array<{ method: string; commission_iqd: number }>;
    coarseStock?: boolean;
  }
): InitialDirectSaleSelection | null {
  const declaredOptions = sourceDoc.options.filter((o) => o.active !== false);
  const colors = sourceDoc.colors.filter((c) => c.active !== false);
  const layout = activeOptionLayout(sourceDoc, input.inventory, input.activeGroupIds);
  const relationalGroupsKnown =
    input.activeGroupIds !== undefined || input.inventory.has_group_rows === true;
  const options = relationalGroupsKnown
    ? declaredOptions.filter((option) => layout.activeOptionIds.has(option.id))
    : declaredOptions;
  const doc = relationalGroupsKnown
    ? { ...sourceDoc, options: sourceDoc.options.filter((option) => layout.activeOptionIds.has(option.id)) }
    : sourceDoc;
  const activeColorIds = new Set(colors.map((c) => c.id));
  const optionById = new Map(options.map((option) => [option.id, option] as const));
  const inventoryOptionById = new Map(
    input.inventory.option_values.map((row) => [row.id, row] as const)
  );

  // A relational chooser whose groups/values are all hidden is not a legacy
  // no-option product. There is no customer selection to default to.
  if (
    relationalGroupsKnown &&
    input.inventory.option_values.length > 0 &&
    layout.groups.length === 0
  ) return null;

  const MAX_OPENING_SELECTIONS = 4096;
  let evaluatedSelections = 0;
  const evaluate = (
    optionValueIds: string[],
    colorId: string | null,
    inventory = input.inventory
  ): InitialDirectSaleSelection | null => {
    if (evaluatedSelections >= MAX_OPENING_SELECTIONS) return null;
    evaluatedSelections += 1;
    const availability = saleAvailability(doc, {
      optionValueIds,
      colorId,
      inventory,
      links: input.links,
      transportDefaults: input.transportDefaults,
      coarseStock: input.coarseStock,
      preferredType: 'direct_sale',
    });
    const direct = availability.modes.find((m) => m.type === 'direct_sale');
    if (!availability.selection.complete || availability.mode !== 'direct_sale' || !direct?.usable) return null;
    return {
      option_id: optionValueIds[0] ?? null,
      option_value_ids: optionValueIds,
      color_id: colorId,
      fulfillment_type: 'direct_sale',
      availability,
    };
  };

  if (input.inventory.inventory_mode === 'VARIANT_COMBINATION') {
    // Iterate actual modelled rows rather than an exponential Cartesian
    // product. A stale row is rejected unless all options/colour are active,
    // the selection covers every active group, and the canonical availability
    // engine proves direct sale is usable.
    const seen = new Set<string>();
    for (const variant of input.inventory.variants) {
      if (!variant.active) continue;
      const parsed = parseVariantSelection(variant.combo_key);
      if (!parsed || seen.has(parsed.normalizedKey)) continue;
      seen.add(parsed.normalizedKey);
      if (!completeActiveOptionSelection(parsed.optionValueIds, layout)) continue;
      if (parsed.colorId && !activeColorIds.has(parsed.colorId)) {
        continue;
      }
      // A direct opening choice needs a finite shelf with at least one unit.
      // Empty/untracked rows can never pass `evaluate`, so they must not burn
      // the bounded search budget ahead of a later stocked combination.
      if (sellableRemainder(variant.stock, variant.reserved) <= 0) continue;
      // Variant keys are canonicalised lexically for identity, while pricing
      // deliberately uses the first OPTION GROUP. Restore the catalogue's
      // group order before the selection reaches either the legacy option_id
      // field or the price resolver.
      const orderedIds = layout.groups.length
        ? layout.groups
            .map((group) => group.find((id) => parsed.optionValueIds.includes(id)) ?? '')
            .filter(Boolean)
        : parsed.optionValueIds;
      // Avoid resolveStock's linear variant lookup for every candidate. The
      // candidate has already been strictly parsed and de-duplicated, so a
      // one-row canonical snapshot is the same stock question in O(1).
      const candidateInventory: InventorySnapshot = {
        ...input.inventory,
        variants: [{ ...variant, combo_key: parsed.normalizedKey }],
      };
      const result = evaluate(orderedIds, parsed.colorId, candidateInventory);
      if (result) return result;
      if (evaluatedSelections >= MAX_OPENING_SELECTIONS) return null;
    }
    return null;
  }

  // Try real colours first. When a complete option selection owns no
  // selectable colour, the final null candidate is valid and intentional.
  const openingColors = input.inventory.inventory_mode === 'COLOR'
    ? colors.filter((color) => {
        const row = input.inventory.colors.find((candidate) => candidate.id === color.id);
        return !!row && sellableRemainder(row.stock, row.reserved) > 0;
      })
    : colors;
  const evaluateOptions = (optionValueIds: string[]): InitialDirectSaleSelection | null => {
    const selectedByGroup: GroupSelection = {};
    for (const id of optionValueIds) {
      const groupId = layout.groupByOptionId.get(id);
      if (groupId) selectedByGroup[groupId] = id;
    }
    const visible = colors.filter((color) =>
      (input.links?.length ?? 0) > 0
        ? colorVisibility(color.id, input.links ?? [], selectedByGroup).visible
        : !color.option_id || optionValueIds.includes(color.option_id)
    );
    const visibleIds = new Set(visible.map((color) => color.id));
    const colorIds: Array<string | null> = visible.length > 0
      ? openingColors.filter((color) => visibleIds.has(color.id)).map((color) => color.id)
      : [null];
    for (const colorId of colorIds) {
      if (evaluatedSelections >= MAX_OPENING_SELECTIONS) return null;
      const result = evaluate(optionValueIds, colorId);
      if (result) return result;
    }
    return null;
  };

  if (layout.groups.length > 0) {
    // Explicit pre-order-only values can never participate in a direct-sale
    // witness. In OPTION mode, a tracked empty row can never participate
    // either because the resolver takes the minimum across selected rows.
    // Pruning these before the Cartesian walk both preserves semantics and
    // prevents a valid last-in-order 10×10×10×10 witness from sitting beyond
    // the safety cap.
    const candidateGroups = layout.groups.map((group) =>
      group
        .filter((id) => directDeclarationForOption(optionById.get(id)) !== 'block')
        .filter((id) => {
          if (input.inventory.inventory_mode !== 'OPTION') return true;
          const row = inventoryOptionById.get(id);
          return !!row && (row.stock === null || sellableRemainder(row.stock, row.reserved) > 0);
        })
        .sort((left, right) => {
          const rank = (id: string) => directDeclarationForOption(optionById.get(id)) === 'allow' ? 0 : 1;
          return rank(left) - rank(right);
        })
    );
    if (candidateGroups.some((group) => group.length === 0)) return null;
    if (
      input.inventory.inventory_mode === 'OPTION' &&
      !candidateGroups.some((group) =>
        group.some((id) => {
          const row = inventoryOptionById.get(id);
          return !!row && row.stock !== null && sellableRemainder(row.stock, row.reserved) > 0;
        })
      )
    ) return null;

    const chosen: string[] = [];
    // Product data is admin-authored, but an accidental 12×12×12×12 matrix
    // must not turn a detail GET into an unbounded search. Failing closed here
    // leaves the ordinary chooser available; it never invents a default.
    const visit = (depth: number): InitialDirectSaleSelection | null => {
      if (evaluatedSelections >= MAX_OPENING_SELECTIONS) return null;
      if (depth === candidateGroups.length) {
        return evaluateOptions([...chosen]);
      }
      for (const id of candidateGroups[depth]) {
        chosen.push(id);
        const result = visit(depth + 1);
        chosen.pop();
        if (result) return result;
      }
      return null;
    };
    return visit(0);
  }

  if (options.length === 0) return evaluateOptions([]);
  for (const option of options) {
    const result = evaluateOptions([option.id]);
    if (result) return result;
  }
  return null;
}

const sellableRemainder = (stock: number | null | undefined, reserved: number | null | undefined): number =>
  stock === null || stock === undefined
    ? 0
    : Math.max(0, Math.trunc(stock) - Math.max(0, Math.trunc(reserved ?? 0)));

/**
 * Product cards are computed for a whole catalogue page inside one Worker
 * request. A malformed 10×10×10×10 option graph must not turn one card into
 * ten thousand availability resolutions (then repeat that per value/colour).
 * The proof below is memoized and shares this strict per-product budget; if a
 * catalogue exceeds it we fail closed and publish no exact direct-stock count.
 */
export const DIRECT_STOCK_SELECTION_EVALUATION_CAP = 512;

/**
 * Exact direct-sale units for a PRODUCT CARD.
 *
 * Only the level selected by `inventory_mode` is summed. In particular we
 * never add option stock to colour or variant stock. Rows with NULL stock are
 * not unlimited, reservations are removed row-by-row, and a combination is
 * counted once even when it contains several option tokens.
 *
 * `null` means either “direct sale is not offered” or “the exact count is
 * intentionally hidden for a mystery-pool member”; `0` means direct sale is
 * configured but every authoritative shelf is empty/untracked.
 */
export function directStockAvailable(
  doc: ProductDoc,
  view: ProductRelationsView,
  base: { stock: number | null; reserved: number },
  coarseStock = false
): number | null {
  if (coarseStock || (doc.composition ?? '') !== '') return null;

  const saleTypes = doc.sale_types?.length ? doc.sale_types : [doc.selling_type || 'direct_sale'];
  const productDirect = saleTypes.includes('direct_sale') || saleTypes.includes('bundle');
  const activeOptions = doc.options.filter((o) => o.active !== false);
  const optionById = new Map(activeOptions.map((o) => [o.id, o] as const));
  const directDeclaration = (id: string): DirectDeclaration => {
    return directDeclarationForOption(optionById.get(id));
  };
  const anyDirect = productDirect || activeOptions.some((option) => directDeclaration(option.id) === 'allow');
  if (!anyDirect) return null;

  const activeGroupIds = new Set(
    view.groups
      .filter((group) => group.active !== 0 && group.active !== false)
      .map((group) => group.id)
  );
  const hasGroupRows = view.groups.length > 0;
  const activeValueRows = view.values.filter(
    (value) =>
      value.active !== 0 &&
      value.active !== false &&
      optionById.has(value.id) &&
      (!hasGroupRows || activeGroupIds.has(value.group_id))
  );
  const valueById = new Map(activeValueRows.map((value) => [value.id, value] as const));
  const idsByGroup = new Map<string, string[]>();
  for (const value of activeValueRows) {
    const groupId = value.group_id || '__legacy_option_group__';
    const ids = idsByGroup.get(groupId) ?? [];
    ids.push(value.id);
    idsByGroup.set(groupId, ids);
  }
  let groupIds = hasGroupRows
    ? view.groups
        .filter((group) => group.active !== 0 && group.active !== false && idsByGroup.has(group.id))
        .map((group) => group.id)
    : [...idsByGroup.keys()];
  // BASE products and legacy fixtures may still carry flat JSON options with
  // no relation rows. They are one chooser, not N required groups.
  if (groupIds.length === 0 && activeOptions.length > 0 && !hasGroupRows) {
    const legacyGroupId = '__legacy_option_group__';
    idsByGroup.set(legacyGroupId, activeOptions.map((option) => option.id));
    groupIds = [legacyGroupId];
  }
  // Relational groups that are all inactive (or have no public active value)
  // are not a legacy flat chooser. No hidden row may make the card claim
  // direct stock, regardless of which inventory level owns its counter.
  if (hasGroupRows && groupIds.length === 0) return 0;

  const inventory = snapshotFrom(view, {
    stock: base.stock,
    reserved: base.reserved,
    low_stock_threshold: null,
  });
  const activeColors = doc.colors.filter((color) => color.active !== false);
  const colorById = new Map(activeColors.map((color) => [color.id, color] as const));
  const directSelectionMemo = new Map<string, boolean>();
  let directSelectionEvaluations = 0;
  let directSelectionEvaluationCapped = false;

  /**
   * Proves a real, complete selection exists. It fixes one value per active
   * group, applies the colour's AND-across/OR-within links, and then delegates
   * the final mode/stock verdict to the canonical availability engine.
   * `forcedOptionId` lets OPTION totals count only rows that can participate
   * in at least one complete direct-sale selection.
   */
  const hasCompleteDirectSelection = (
    colorId: string | null,
    forcedOptionId: string | null = null
  ): boolean => {
    if (directSelectionEvaluationCapped) return false;
    const memoKey = JSON.stringify([colorId, forcedOptionId]);
    const memoized = directSelectionMemo.get(memoKey);
    if (memoized !== undefined) return memoized;
    const remember = (result: boolean): boolean => {
      if (!directSelectionEvaluationCapped) directSelectionMemo.set(memoKey, result);
      return result;
    };

    const color = colorId ? colorById.get(colorId) ?? null : null;
    if (colorId && !color) return remember(false);

    const linksForColor = colorId ? view.links.filter((link) => link.color_id === colorId) : [];
    const groupIdSet = new Set(groupIds);
    if (linksForColor.some((link) => !groupIdSet.has(link.group_id))) return remember(false);

    let forcedGroupId: string | null = null;
    if (forcedOptionId) {
      for (const groupId of groupIds) {
        if ((idsByGroup.get(groupId) ?? []).includes(forcedOptionId)) {
          forcedGroupId = groupId;
          break;
        }
      }
      if (!forcedGroupId) return remember(false);
    }

    const candidatesByGroup: string[][] = [];
    for (const groupId of groupIds) {
      const linkedIds = new Set(
        linksForColor
          .filter((link) => link.group_id === groupId)
          .map((link) => link.option_value_id)
      );
      let candidates = [...(idsByGroup.get(groupId) ?? [])];
      if (forcedGroupId === groupId && forcedOptionId) {
        candidates = candidates.filter((id) => id === forcedOptionId);
      }
      if (linkedIds.size > 0) candidates = candidates.filter((id) => linkedIds.has(id));

      // The legacy single-link field predates relation rows. Keep it truthful
      // for BASE products and rolling-deploy data that has no link table yet.
      if (color && linksForColor.length === 0 && color.option_id) {
        const legacyOptionGroup = groupIds.find((id) => (idsByGroup.get(id) ?? []).includes(color.option_id!));
        if (!legacyOptionGroup) return remember(false);
        if (legacyOptionGroup === groupId) candidates = candidates.filter((id) => id === color.option_id);
      }

      candidates = candidates.filter((id) => directDeclaration(id) !== 'block');
      if (view.inventory_mode === 'OPTION') {
        candidates = candidates.filter((id) => {
          const row = valueById.get(id);
          return !row || row.stock === null || sellableRemainder(row.stock, row.reserved) > 0;
        });
      }
      // Try explicit direct declarations before neutral values. A neutral
      // secondary value may inherit a direct model chosen in another group,
      // but cannot create direct sale by itself when the product union is stale.
      candidates.sort((a, b) => {
        const rank = (id: string) => directDeclaration(id) === 'allow' ? 0 : 1;
        return rank(a) - rank(b);
      });
      if (candidates.length === 0) return remember(false);
      candidatesByGroup.push(candidates);
    }

    const selected: string[] = [];
    const visit = (depth: number): boolean => {
      if (directSelectionEvaluationCapped) return false;
      if (depth === candidatesByGroup.length) {
        if (directSelectionEvaluations >= DIRECT_STOCK_SELECTION_EVALUATION_CAP) {
          directSelectionEvaluationCapped = true;
          return false;
        }
        directSelectionEvaluations += 1;
        const availability = saleAvailability(doc, {
          optionValueIds: selected,
          colorId,
          inventory,
          links: view.links,
          preferredType: 'direct_sale',
        });
        const direct = availability.modes.find((mode) => mode.type === 'direct_sale');
        return availability.selection.complete && availability.mode === 'direct_sale' && direct?.usable === true;
      }
      for (const id of candidatesByGroup[depth]) {
        selected.push(id);
        const usable = visit(depth + 1);
        selected.pop();
        if (usable) return true;
        if (directSelectionEvaluationCapped) return false;
      }
      return false;
    };
    return remember(visit(0));
  };

  // Null is a real candidate for an option tuple to which no active colour is
  // linked. saleAvailability rejects it when that tuple does expose colours.
  const activeColorIds: Array<string | null> = [
    ...activeColors.map((color) => color.id),
    null,
  ];
  const hasCompleteDirectForAnyColor = (forcedOptionId: string | null = null): boolean =>
    activeColorIds.some((colorId) => hasCompleteDirectSelection(colorId, forcedOptionId));

  switch (view.inventory_mode) {
    case 'OPTION': {
      /**
       * One order consumes one selected row from every tracked group and the
       * inventory resolver answers with their minimum. The card's catalogue-
       * wide capacity is therefore: sum the selectable rows *within* each
       * tracked group, then take the minimum *across* groups. Adding every row
       * across every group double-counted the same physical sales.
       */
      const totals = new Map<string, number>();
      for (const value of activeValueRows) {
        // NULL is an untracked row, not a finite quantity to include in an
        // exact stock badge. A group becomes constraining once it has a real
        // counter, exactly like resolveStock's tracked-target filter.
        if (value.stock === null || value.stock === undefined) continue;
        // A finite counter on an explicitly pre-order-only value is not a
        // direct-sale counter. Do not let it make an otherwise-untracked
        // direct group look tracked; the complete-selection proof below still
        // makes a product with no direct value in a required group resolve 0.
        if (directDeclaration(value.id) === 'block') continue;
        const groupId = value.group_id || '__legacy_option_group__';
        if (!totals.has(groupId)) totals.set(groupId, 0);
        const remaining = sellableRemainder(value.stock, value.reserved);
        if (remaining > 0 && hasCompleteDirectForAnyColor(value.id)) {
          totals.set(groupId, (totals.get(groupId) ?? 0) + remaining);
        }
        if (directSelectionEvaluationCapped) return 0;
      }
      return totals.size > 0 ? Math.min(...totals.values()) : 0;
    }

    case 'COLOR': {
      let total = 0;
      for (const color of view.colors) {
        if (color.active === 0 || color.active === false) continue;
        const remaining = sellableRemainder(color.stock, color.reserved);
        if (remaining > 0 && hasCompleteDirectSelection(color.id)) total += remaining;
        if (directSelectionEvaluationCapped) return 0;
      }
      return total;
    }

    case 'VARIANT_COMBINATION': {
      const variantActiveGroupIds = view.groups.length > 0
        ? new Set(
            view.groups
              .filter((group) => group.active !== 0 && group.active !== false)
              .map((group) => group.id)
          )
        : undefined;
      const layout = activeOptionLayout(doc, inventory, variantActiveGroupIds);
      const variantActiveColorIds = new Set(activeColors.map((color) => color.id));
      const seen = new Set<string>();
      let total = 0;
      let checked = 0;

      for (const variant of view.variants) {
        if (!variant.active) continue;
        const parsed = parseVariantSelection(variant.combo_key);
        if (!parsed || seen.has(parsed.normalizedKey)) continue;
        seen.add(parsed.normalizedKey);
        if (!completeActiveOptionSelection(parsed.optionValueIds, layout)) continue;
        if (parsed.colorId && !variantActiveColorIds.has(parsed.colorId)) {
          continue;
        }
        const remaining = sellableRemainder(variant.stock, variant.reserved);
        // Zero and NULL cannot contribute to an exact direct-stock total and
        // cannot pass canonical direct availability. Skip them before the
        // proof budget so a late stocked witness remains discoverable.
        if (remaining <= 0) continue;
        if (checked >= DIRECT_STOCK_SELECTION_EVALUATION_CAP) return 0;
        checked += 1;
        // Every explicit selected fulfilment cell must permit direct sale;
        // saleAvailability also validates links and the exact active variant.
        // Use the already-validated row as a one-entry canonical index so
        // resolveStock does not linearly scan the whole variant table once
        // per row (O(V²) on a large catalogue).
        const candidateInventory: InventorySnapshot = {
          ...inventory,
          variants: [{
            id: variant.id,
            combo_key: parsed.normalizedKey,
            stock: variant.stock,
            reserved: variant.reserved ?? 0,
            low_stock_threshold: variant.low_stock_threshold,
            active: true,
          }],
        };
        const availability = saleAvailability(doc, {
          optionValueIds: parsed.optionValueIds,
          colorId: parsed.colorId,
          inventory: candidateInventory,
          links: view.links,
          preferredType: 'direct_sale',
        });
        const direct = availability.modes.find((m) => m.type === 'direct_sale');
        if (!availability.selection.complete || availability.mode !== 'direct_sale' || !direct?.usable) continue;
        total += remaining;
      }
      return total;
    }

    case 'BASE':
    default: {
      // Legacy flat products only. New direct-sale products are written with
      // OPTION/COLOR/VARIANT_COMBINATION, but a numeric legacy shelf remains
      // a truthful finite count and must not be relabelled “unlimited”.
      const complete = hasCompleteDirectForAnyColor();
      return directSelectionEvaluationCapped
        ? 0
        : complete
          ? sellableRemainder(base.stock, base.reserved)
          : 0;
    }
  }
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
  /**
   * The SAME merged route list `saleAvailability` offers — the selected
   * model's own routes first, the product's as fallback. Iterating only
   * `doc.preorder_transports` here priced nothing for a model that declares
   * its routes itself, so the page had a pill with no price behind it.
   */
  const selected = doc.options.find((o) => o.id === sel.optionId && o.active !== false) ?? null;
  const modelPreRoutes = (
    selected?.fulfillments?.find((f) => f.fulfillment_type === 'pre_order' && f.enabled !== false)?.transports ?? []
  ).filter((t) => t.enabled !== false);
  const methods = modelPreRoutes.length
    ? [...new Set(modelPreRoutes.map((t) => t.method))]
    : doc.preorder_transports.filter((t) => t.active !== false).map((t) => t.method);
  for (const method of methods) {
    const t = { method };
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
  const projected = projectAdmin(doc);
  return {
    ...projected, // full document incl. cost fields + translation meta
    ...legacyAliases(doc),
    images: projected.media.map((m) => m.url), // legacy string[] view
    algorithm_tags: doc.legacy.algorithm_tags,
    updated_at: doc.updated_at,
  };
}

/**
 * Project an already parsed/overlaid product document without parsing it a
 * second time as a database row. Relation-aware readers use this after
 * `applyRelations`; feeding the document back through `parseProductRow` would
 * reinterpret its in-memory arrays as legacy JSON columns and could silently
 * discard the authoritative overlay.
 */
export function productDocumentPublic(
  doc: ProductDoc,
  opts: { includeInternal?: boolean } = {}
): Record<string, unknown> {
  return opts.includeInternal ? adminShape(doc) : publicShape(doc);
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
  return productDocumentPublic(parseProductRow(p), opts);
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
  const directStock = directStockAvailable(
    doc,
    view ?? EMPTY_RELATIONS,
    { stock: doc.stock, reserved: heldBase },
    coarseStock
  );
  if (directStock !== null) out.direct_stock_available = directStock;
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
  /** A LIVE OFFER REPLACED THE LADDER — read by the membership teaser below. */
  let offerPriced = false;
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
      offerPriced = true;
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
  /**
   * THE FAINT «PRIME … / PRO … للمشتركين» LINE, WHEN THE SAVING IS A RULE
   * RATHER THAN A TYPED NUMBER.
   *
   * THE OTHER HALF OF THE EMPTY-SHELF DEFECT, and the half that would have made
   * fixing the query pointless. `display_prime_iqd` / `display_pro_iqd` are
   * read straight out of the loop above, and that loop resolves with
   * `benefitFallbackFor(ctx, doc)` — the fallback for THE VIEWER, which is
   * `{ pro: null, prime: null }` for anyone signed out. So on a shop whose
   * memberships live entirely in `membership_benefit_rules`, both came back
   * null for every visitor and `CardPrice` drew no teaser at all. Repairing the
   * shelf alone would have filled it with cards that look exactly like every
   * un-discounted card — the same complaint, one screen later.
   *
   * WHAT A SIGNED-OUT VISITOR SEES, and why it is not a member price. These two
   * fields are TIER-LABELLED advertisements — `CardPrice` prints them as
   * «PRIME 660,000 (للمشتركين)», under the regular price the guest actually
   * pays. `display_price_iqd` and `display_applied_tier` are NOT touched here:
   * the guest's own price stays the regular price and their own tier stays
   * 'regular'. Nothing below prices this viewer as a member — it prices the
   * MEMBERSHIP, exactly as `membershipPreview` already does for the same
   * product on `/api/products/:slug`, with the same rules and the same frozen
   * clock. Those two answers disagreed before this: the product page told a
   * guest PRO saves 67,500 while the card beside it said nothing.
   *
   * ONE TIER AT A TIME, IN ITS OWN RESOLUTION. `fallbackFor` fills only the
   * tier it is asked about, and the result is read back from that tier's rung
   * alone, because `clampMemberLadder` fills an empty PRO rung DOWN from PRIME.
   * Folding both fallbacks into the loop above would be the inversion
   * `fallbackFor`'s own comment warns about — a PRO member handed a PREMIUM
   * discount larger than their own — and it would be doing it on the price the
   * viewer is charged.
   *
   * IT NEVER RUNS FOR A PRODUCT NO RULE REACHES. `fallbackFor` is pure
   * in-memory work over rules `pricingCtx` already loaded, and it returns
   * nothing unless a rule genuinely selects for this product, so the extra
   * price resolutions happen only on the handful of cards that have something
   * to say. No query, on any card.
   *
   * A LIVE OFFER SUPPRESSES IT. When `applyOfferToResolved` priced this line the
   * offer replaced the whole ladder, and what a membership would then be worth
   * on top of it is not a question this function can answer. It prints nothing
   * rather than a number the door might not honour.
   */
  if (!offerPriced && (primeMin === null || proMin === null)) {
    const benefitTarget = {
      product_id: doc.id,
      category_id: doc.category_id,
      sub_category_id: doc.sub_category_id,
      ancestry: ancestryFor(ctx.catalogAncestry, doc.category_id, doc.sub_category_id),
    };
    for (const tier of ['prime', 'pro'] as const) {
      // A price the owner TYPED on this product already won in the loop above
      // and outranks any rule (`memberPrice`), so that tier is left alone.
      if (tier === 'prime' ? primeMin !== null : proMin !== null) continue;
      const memberFallback = fallbackFor(ctx.benefitRules, previewStatus(tier), benefitTarget, ctx.benefitNowIso);
      if (memberFallback.prime === null && memberFallback.pro === null) continue;
      let cheapest: number | null = null;
      for (const sel of levels) {
        const r = resolveUnitPrice({
          product: doc,
          optionId: sel.optionId ?? null,
          colorId: sel.colorId ?? null,
          tier,
          tierActive: true,
          proPolicy: ctx.proPolicy,
          transportDefaults: ctx.transportDefaults,
          memberFallback,
        });
        const rung = tier === 'prime' ? r.prime_iqd : r.pro_iqd;
        /**
         * Strictly below the regular price of the SAME level, so a rung the
         * ladder merely clamped level with the regular price is not advertised
         * as a discount — AND STRICTLY ABOVE ZERO.
         *
         * `quotableDiscount` validates the RULE (a percent above zero, a fixed
         * amount above zero, a per-unit cap above zero) but nothing can
         * validate it against a PRICE it has not met yet. A fixed rule of
         * 50,000 reaching a product that costs 20,000 makes `unitDiscountIqd`
         * clamp the discount at the price and the rung comes back 0 — which is
         * "strictly below the regular price" and would have printed «PRO 0
         * (للمشتركين)» on every card, to every signed-out visitor. Before the
         * teaser existed a misconfigured rule was visible only to the member it
         * affected; it is now published store-wide, so the guard belongs here.
         */
        if (rung !== null && rung > 0 && rung < r.regular_iqd) {
          cheapest = cheapest === null ? rung : Math.min(cheapest, rung);
        }
      }
      if (tier === 'prime') primeMin = cheapest;
      else proMin = cheapest;
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
  const publicRow = publicWithDisplayPrice(b.row, ctx, b.view, displayOverride(b));
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
  // Open box / used / refurbished. A card that does not say so is a card that
  // sells a used printer as a new one, so the grade travels with the shelf
  // entry rather than waiting for the product page.
  'condition',
  // A composition links to /bundles/<product_slug>; an ordinary row has none.
  'product_slug',
  'name',
  'status',
  // `productImage.ts` prefers the primary media entry and falls back to the
  // published `images` list, so a card needs both.
  'media',
  'images',
  // «الصورة الرئيسية للوضع الفاتح» (0138): the light-theme main image, present
  // only when the product has one — the card shows it on the light theme and
  // the gallery primary on the dark one.
  'light_image',
  'price_iqd',
  'display_price_iqd',
  'display_regular_iqd',
  'display_prime_iqd',
  'display_pro_iqd',
  'display_applied_tier',
  'display_from',
  // Exact sellable direct-sale units from the ONE authoritative inventory
  // level. Cards render it only when positive; zero remains a truthful API
  // answer for a configured but exhausted shelf.
  'direct_stock_available',
  // Set alongside `offer` when a live window has a PLUS rung.
  'display_plus_iqd',
  // The countdown and the members-only lock chip.
  'offer',
  /**
   * WHICH SECTION AND WHICH BRAND — two id strings, for the «مختارات لك» tile.
   *
   * That tile ranks products against what THIS BROWSER has recently opened,
   * entirely on the client (src/lib/recentlyViewed.ts), because the shop
   * records no browsing telemetry and none was added for one tile. The
   * ranking needs something to match on, and "same section" is the signal
   * that actually predicts interest.
   *
   * Two short ids are not what this projection exists to keep out: it exists
   * to stop the option ladder, the colour matrix, the spec groups, the usage
   * guide and three languages of description riding on every tile.
   */
  'category_id',
  /**
   * The SECOND consumer, and the reason this one joined the projection: the
   * category rails on the home page key a representative photo off the
   * sub-section a product is filed under. `catalogs` has no image column and
   * never has had, so the alternative to this id was a monogram on every
   * card or a second query per section.
   *
   * WHAT IT DOES NOT PROMISE. This is the CLASSIFICATION column, while a
   * section's `product_count` rolls up through the union of classification
   * and `product_catalogs` across every descendant
   * (worker/lib/catalogMembership.ts). A sub-section can therefore truthfully
   * say «4 منتجات» and still have no product here to take a picture from. The
   * card is built to be correct with no picture; the count and the artwork
   * are allowed to disagree.
   */
  'sub_category_id',
  'brand_id',
  /*
   * CATALOG DISCOVERY (docs/ux/CATALOG_DISCOVERY.md §0, §4, §11). A card could
   * not say «طلب مسبق» because the listing never told it, and the compare
   * toggle cannot be offered only on comparable types without the type. Three
   * short values; the heavy fields stay out.
   *   sale_types   — ['direct_sale', 'pre_order', …], the product's own list.
   *   created_at   — «الأحدث», and the «جديد» the card may one day draw.
   *   compare_type — the product type its branch resolves to (`printer`,
   *                  `laser`, `filament`, …), set by `withCompareType` where
   *                  the taxonomy is at hand; absent when nothing names one.
   * (No `card_name`: owner answer Q2 — the card shows the part of the name
   * before the first « / », derived on the client; no new column.)
   */
  'sale_types',
  'created_at',
  'compare_type',
] as const;

export function cardShape(out: Record<string, unknown>): Record<string, unknown> {
  const card: Record<string, unknown> = {};
  for (const k of CARD_FIELDS) {
    if (out[k] !== undefined) card[k] = out[k];
  }
  return card;
}

export function compositionCard(b: ResolvedBundle, ctx: PricingCtx): Record<string, unknown> {
  return bundleCard(b, publicWithDisplayPrice(b.row, ctx, b.view, displayOverride(b)));
}

/**
 * `compare_type` on an ordinary product card, from the product ROW (its
 * classification and `template_family`) and the taxonomy index — the compare
 * page's own rule (`productTypeOf`), so a card never offers a comparison the
 * page would refuse as a type mismatch. Never set on a composition card.
 */
export function withCompareType(
  card: Record<string, unknown>,
  row: Record<string, unknown>,
  idx: CatalogIndex | null
): Record<string, unknown> {
  if (!idx) return card;
  const t = productTypeOf(row, idx);
  if (t) card.compare_type = t;
  return card;
}

/**
 * ORDINARY product rows → cards, through the ONE pricing path every listing
 * uses: batched relations, batched offers, the mystery-pool coarse rule, then
 * `publicWithDisplayPrice` and the card projection. Composition rows are the
 * caller's (they have their own builder). Exported for the catalog pages and
 * the printer finder, so neither can quote a price the product page does not.
 */
export async function resolveProductCards(
  db: D1Database,
  rows: Record<string, unknown>[],
  ctx: PricingCtx,
  idx: CatalogIndex | null
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  if (rows.length === 0) return out;
  const ids = rows.map((r) => String(r.id));
  const [views, offers, pooled] = await Promise.all([
    loadRelationsViews(db, rows.map((r) => ({ id: String(r.id), inventory_mode: r.inventory_mode }))),
    degradeIfSchemaMissing('offers (migration 0060)', () => loadOffers(db, ids.map((id) => subjectOf(id))), EMPTY_OFFERS()),
    degradeIfSchemaMissing('mystery pools (migration 0061)', () => activePoolProductIds(db, ids), new Set<string>()),
  ]);
  for (const r of rows) {
    const id = String(r.id);
    const card = cardShape(
      publicWithDisplayPrice(r, ctx, views.get(id), undefined, offers.get(offerKey(subjectOf(id))), pooled.has(id))
    );
    out.set(id, withCompareType(card, r, idx));
  }
  return out;
}

/**
 * The parameters that turn `/api/products` into the specialised listing
 * (docs/ux/CATALOG_DISCOVERY.md §11). A request carrying NONE of them takes the
 * old path — same SQL, same ORDER BY, same paging — so every existing caller
 * (the home rails, search, «عرض المزيد», saved links) is untouched.
 */
const LISTING_PARAM_KEYS = [
  'sort', 'avail', 'sale', 'price', 'brand', 'offer', 'member', 'facets',
  ...FACET_FIELD_IDS.map((f) => `f.${f}`),
];

/**
 * How many candidates the listing resolves in memory. The price a filter or a
 * sort reads is the VIEWER'S resolved price, which SQL does not hold, so the
 * route narrows in SQL by what it can (section, search, brand), resolves at
 * most this many through the pricing path, and says `truncated: true` when the
 * section held more. 300 is ~12 pages of 24 and one bounded request.
 */
export const LISTING_CANDIDATE_CAP = 300;

const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A resolved card (ordinary or composition) → what the listing filters read. */
function listingItemOf(row: Record<string, unknown>, card: Record<string, unknown>, rank: number, brandSlug: string | null): ListingItem {
  const price = numOrNull(card.display_price_iqd) ?? numOrNull(card.price_iqd) ?? (Number(row.price_iqd) || 0);
  const saleTypes = Array.isArray(card.sale_types)
    ? (card.sale_types as unknown[]).map(String)
    : safeParse<unknown[]>(String(row.sale_types ?? '[]'), []).map(String);
  const offer = card.offer as { schedule_state?: string } | null | undefined;
  const specs = safeParse<Record<string, unknown>>(String(row.spec_fields ?? '{}'), {});
  return {
    id: String(row.id),
    card,
    name: String(card.name ?? row.name ?? ''),
    price,
    regular: numOrNull(card.display_regular_iqd) ?? price,
    prime: numOrNull(card.display_prime_iqd),
    pro: numOrNull(card.display_pro_iqd),
    available: Math.max(0, numOrNull(card.direct_stock_available) ?? 0),
    saleTypes: saleTypes.length ? saleTypes : [String(row.selling_type || 'direct_sale')],
    brandId: row.brand_id ? String(row.brand_id) : null,
    brandSlug,
    createdAt: String(row.created_at ?? ''),
    rank,
    scheduledOffer: !!offer && (offer.schedule_state === 'live' || offer.schedule_state === 'upcoming'),
    specs: specs && typeof specs === 'object' && !Array.isArray(specs) ? specs : {},
  };
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

/**
 * The catalog a listing was filtered by, as this endpoint resolves it.
 *
 * Deliberately NOT the home page's `HomeTaxon`: that type carries a
 * descendant-inclusive `product_count` computed by the home tree's counting
 * CTE, and this is one primary-key probe that knows no count. A zero there
 * would be read as a number rather than as an absence.
 */
interface ResolvedCategoryRow {
  id: string;
  slug: string;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  /** The canonical storefront path (catalog discovery); absent when unknown. */
  path?: string;
}

productRoutes.get('/', async (c) => {
  const q = c.req.query();
  const search = str(q.search, 'search', { max: 100, required: false });
  const category = str(q.category, 'category', { max: 60, required: false });
  const type = str(q.type, 'type', { max: 20, required: false }); // 'bundle' | 'discounted' | 'featured'
  const limit = int(q.limit, 'limit', { min: 1, max: 50, def: 20 });
  const offset = int(q.offset, 'offset', { min: 0, max: 10_000, def: 0 });

  /**
   * THE SPECIALISED LISTING (catalog discovery S1). Parsed by the one grammar
   * the page writes its URL with (@levonis/catalog/discovery); an unknown value
   * is dropped there, never thrown. `listing` is false for every request that
   * existed before it, and those keep the exact path below.
   */
  const listing = LISTING_PARAM_KEYS.some((k) => q[k] !== undefined);
  const listingState = parseListingParams((k) => (k === 'search' ? search : q[k]), 'api');
  const wantsFacets = q.facets === '1';
  // The taxonomy index: card `compare_type` and the category's `path`. Memoised
  // per isolate (catalogPresentation.ts), so this is usually free.
  const idxPromise = catalogIndexFor(c.env.DB);
  idxPromise.catch(() => {});

  /**
   * STARTED HERE, at the top, because `type=discounted` now BUILDS ITS WHERE
   * CLAUSE out of the membership rules this carries (`discountedWhere`), and
   * that clause has to exist before the ORDER BY and the LIMIT are appended.
   *
   * Moving it up costs nothing and saves a round trip: it runs alongside the
   * category probe and the search-index read below — both of which this route
   * already awaited before touching `pricingCtx` — so by the time the filter
   * block needs it, it is almost always resolved. Every other listing awaits it
   * exactly where it always did, in the wave with the main statement, and its
   * behaviour is unchanged.
   *
   * THE `catch` IS NOT DECORATION. The search branch below RETURNS from inside
   * itself when the index matches nothing, leaving this promise in flight; a
   * rejection with no handler attached surfaces as an unhandled rejection on
   * the isolate rather than as this request's error. The handler discards
   * nothing — every path that needs the value still awaits the promise itself
   * and still sees the rejection.
   */
  const ctxPromise = pricingCtx(c);
  ctxPromise.catch(() => {});

  /**
   * WHAT THE CUSTOMER IS LOOKING AT, NOT WHICH ROW WE FILTERED ON.
   *
   * The storefront heading read «الفئة: cat_printers_fdm» — the owner reported
   * it from their phone, with a screenshot. The page had no honest
   * alternative: this listing echoed nothing about the category, so the only
   * string it could print was the URL parameter.
   *
   * WHY THE CLIENT CANNOT LOOK IT UP ITSELF. The only public source of catalog
   * names is /api/home's tree, and that tree is deliberately partial —
   * `homeCategoryTree` caps at 12 roots and 8 children, drops every catalog
   * whose roll-up count is zero, excludes inactive ones and dedupes by display
   * name (worker/lib/catalogMembership.ts). A perfectly valid deep link can
   * therefore name a catalog that list does not contain, and a client-side
   * lookup would be right most of the time and silently wrong on exactly the
   * links nobody tests.
   *
   * WHY IT IS RESOLVED HERE, twenty lines early. The search branch below
   * returns from inside itself when the index matches nothing, long before the
   * category clause. Resolving at the bottom would answer a
   * `?search=…&category=…` request with the field missing — a fix that works
   * on three links out of four is the kind that gets reported again.
   *
   * ONE PROBE ON A PRIMARY KEY (or on the UNIQUE `slug`) returning one short
   * row is the whole cost. `active` is deliberately NOT filtered:
   * `catalogSubtreeFilter` does not check it either, so a deactivated catalog
   * still lists its products, and an unnamed heading over a full grid is worse
   * than the name.
   */
  let categoryRef: ResolvedCategoryRow | null = null;
  if (category) {
    categoryRef =
      (await c.env.DB.prepare(
        // `id` first in the tiebreak: the id is the identifier this API
        // documents, and accepting the slug as well is what makes a
        // hand-typed /products?category=fdm-printers work.
        'SELECT id, slug, name_ar, name_en, name_ckb FROM catalogs WHERE id = ?1 OR slug = ?1 ORDER BY (id = ?1) DESC LIMIT 1'
      )
        .bind(category)
        .first<ResolvedCategoryRow>()) ?? null;
    // A SLUG THE ADMIN RENAMED AWAY FROM (0136, owner Q11) still names its
    // section, so an old shared link keeps listing and can be replaced to the
    // new path. Only consulted when nothing live matched.
    if (!categoryRef) {
      const retired = await catalogIdForRetiredSlug(c.env.DB, category);
      if (retired) {
        categoryRef =
          (await c.env.DB.prepare('SELECT id, slug, name_ar, name_en, name_ckb FROM catalogs WHERE id = ?')
            .bind(retired)
            .first<ResolvedCategoryRow>()) ?? null;
      }
    }
    /**
     * WHERE THIS CATALOG LIVES NOW — `/categories/printers/fdm-printers` — so
     * the storefront can `replace` an old `/products?category=` link with the
     * canonical category URL (docs/ux/CATALOG_DISCOVERY.md §2 «Routes»).
     */
    if (categoryRef) {
      const idx = await idxPromise.catch(() => null);
      if (idx?.byId.has(categoryRef.id)) categoryRef = { ...categoryRef, path: idx.path(categoryRef.id) };
    }
  }
  /**
   * ABSENT vs NULL, because they are different facts and the heading renders
   * them differently: no key at all means "no filter was applied", and an
   * explicit null means "a filter was applied and it names no catalog we can
   * put a word to". The second is a SUPPORTED live state, not an error —
   * `products.subcategory_id` still holds free-text tokens from before the
   * taxonomy existed, and tests/homeCategories.test.ts pins that those rows
   * keep listing.
   */
  const categoryField = category ? { category: categoryRef } : {};

  let sql = "SELECT * FROM products WHERE status = 'active'";
  const params: unknown[] = [];
  /**
   * THE SEARCH THAT COULD NOT FIND THIS SHOP'S OWN FLAGSHIP.
   *
   * This was `name LIKE '%q%' OR name_ar LIKE '%q%' OR name_ku LIKE '%q%' OR
   * description LIKE '%q%'` — four unindexed substring scans, no tokenisation,
   * no ranking. A customer typing «بامبو» or «بمبو» or «اكس تو دي» or «طابعه»
   * got nothing, because none of those is a substring of "Bambu Lab X2D
   * Combo". The owner's brief was «مهما كتب يظهر الذي يريده».
   *
   * It is an INDEX now — see worker/lib/search/ for the whole design: Arabic
   * normalisation, romanisation so «بامبو» and "bambu" meet, a dictionary the
   * owner can extend for «طابعة» → printer, bounded typo tolerance, and
   * weighted ranking. The engine returns ids, best first; this route keeps
   * that order and resolves them through the same pricing path every other
   * listing uses, so a search result can never quote a price the product page
   * does not.
   *
   * A SEARCH THAT MATCHES NOTHING RETURNS NOTHING. There is no substring
   * fallback: one would quietly hand back whatever happened to contain the
   * letters, which is how a search engine starts showing people things they
   * did not ask for. An honest empty state is the better answer.
   *
   * DEGRADES TO THE OLD BEHAVIOUR while migration 0089 has not been applied:
   * a missing `search_tokens` TABLE genuinely holds no postings, which is the
   * sanctioned reading in worker/lib/membershipBenefits.ts — and answering
   * "no results" for every search on a shop that is mid-deploy would be worse
   * than the substring scan it replaces, so that one case falls back.
   */
  let searchOrder: string[] | null = null;
  /**
   * WHETHER THE SHOPPER IS STILL TYPING THE LAST WORD. `str()` trims, so the
   * one signal that says "that word is finished" — a trailing space — is read
   * off the raw parameter. "hot" is still on its way to "Hotend"; "hot " is
   * the word hot. See `completing` in worker/lib/search/index.ts.
   */
  const rawSearch = typeof q.search === 'string' ? q.search : '';
  const typingLastWord = !/\s$/u.test(rawSearch);
  if (search) {
    const hits = await degradeIfSchemaMissing(
      'search index (migration 0089)',
      () => searchProducts(c.env.DB, search, { limit: 200, completeLast: typingLastWord }),
      null as { ids: string[]; indexReady: boolean } | null
    );
    // A missing TABLE, or a table that exists and is still empty because the
    // backfill has not caught up — both mean "the index cannot answer yet",
    // and both fall back rather than telling every shopper there is nothing.
    if (hits === null || !hits.indexReady) {
      sql += ` AND (${sqlLikeClause(['name', 'name_ar', 'name_ku', 'description'])})`;
      const like = likePattern(search);
      params.push(like, like, like, like);
    } else if (hits.ids.length === 0) {
      // The category block rides this exit as well — see the note above.
      return c.json({
        success: true,
        products: [],
        ...categoryField,
        ...(listing ? { total: 0, truncated: false, sort: listingState.sort } : {}),
      });
    } else {
      /**
       * ONE BOUND PARAMETER FOR THE WHOLE HIT LIST — and the same again for
       * the ORDER BY below.
       *
       * This bound every id twice, once here and once in the `CASE` that keeps
       * the ranking, and the engine returns up to 200 ids. D1 refuses a
       * statement with more than 100 bound parameters, so any search that
       * ranked fifty products or more — «H», a brand the home tiles link to,
       * "hotend" on a real catalogue — answered 500 and the page showed its
       * error card instead of results. node:sqlite allows 32766, which is why
       * nothing in the suite noticed. `json_each` keeps the count constant
       * however many products match.
       */
      searchOrder = hits.ids;
      sql += ' AND id IN (SELECT value FROM json_each(?))';
      params.push(JSON.stringify(hits.ids));
    }
  }
  if (category) {
    /**
     * A CATEGORY MEANS THAT CATALOG AND EVERYTHING UNDER IT.
     *
     * This used to be `subcategory_id = ? OR id IN (SELECT product_id FROM
     * product_catalogs WHERE catalog_id = ?)`, which missed both halves of the
     * membership relation: the classification columns the product form
     * actually writes, and every descendant catalog. Tapping "Printers" — the
     * main section the owner put three products under — listed nothing,
     * because the products are classified under "FDM Printers" and the
     * placement table was empty. See worker/lib/catalogMembership.ts.
     */
    /**
     * The RESOLVED id when the parameter named a catalog, the parameter itself
     * when it did not. The fallback is not padding: a pre-taxonomy free-text
     * `products.subcategory_id` token has no `catalogs` row at all and those
     * products must keep listing. Binding the resolved id is also what makes
     * accepting a SLUG safe — otherwise the slug would name a heading over a
     * grid the subtree filter left empty.
     */
    const subtree = catalogSubtreeFilter(categoryRef?.id ?? category, 'products');
    sql += ` AND ${subtree.sql}`;
    params.push(...subtree.params);
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
  /**
   * 'discounted' used to mean "has a compare-at price above the selling
   * price". Compare-at was retired in §4, and the replacement — "a TYPED tier
   * price below the regular one" — went stale in its turn at migration 0074,
   * when a membership discount became a RULE the owner writes once instead of
   * a number typed on every product. Both readings are true at once now, and
   * `discountedWhere` is the single place that says so, shared with the home
   * page's «المخفَّضة» strip so the strip and this listing behind its «عرض
   * الكل» cannot drift apart again.
   */
  if (type === 'discounted') {
    const reach = discountedWhere(await ctxPromise);
    sql += ` AND ${reach.sql}`;
    params.push(...reach.params);
  }
  if (type === 'featured') sql += ' AND is_featured = 1';
  /**
   * BRAND NARROWS IN SQL — as ONE bound parameter however many brands are
   * ticked (json_each), so the statement stays far under D1's 100 — but only
   * when no facet counts were asked for: the brand facet's own counts must see
   * the other brands (disjunctive), so with `facets=1` the brand filter is
   * applied in memory like every other one. Memory always re-applies it, so the
   * two paths cannot disagree.
   */
  if (listing && !wantsFacets && listingState.brands.length) {
    sql += ' AND brand_id IN (SELECT b.id FROM brands b WHERE b.slug IN (SELECT value FROM json_each(?)))';
    params.push(JSON.stringify(listingState.brands));
  }
  /**
   * A SEARCH RESULT IS ORDERED BY RELEVANCE, NOT BY THE SHELF ORDER.
   *
   * `IN (...)` has no order at all, and `display_order` is the merchandiser's
   * order — right for browsing a section, wrong for a query, where the whole
   * point is that the best match comes first. So a search keeps the ranking
   * the engine produced and pages through it, and everything else keeps the
   * shelf order it always had.
   */
  if (searchOrder) {
    // The id's position in the engine's ranking — `key` is the array index
    // `json_each` reports — rather than a `CASE` with one bound id per branch.
    sql += ' ORDER BY (SELECT CAST(r.key AS INTEGER) FROM json_each(?) r WHERE r.value = products.id) LIMIT ? OFFSET ?';
    params.push(JSON.stringify(searchOrder));
  } else {
    sql += ' ORDER BY display_order ASC, created_at DESC LIMIT ? OFFSET ?';
  }
  // The listing pages in MEMORY, after the viewer's prices are known, so SQL
  // hands back the whole capped candidate set in its natural order (+1 row to
  // learn whether the cap bit).
  if (listing) params.push(LISTING_CANDIDATE_CAP + 1, 0);
  else params.push(limit, offset);

  const [{ results: fetched }, ctx, idx] = await Promise.all([
    c.env.DB.prepare(sql).bind(...params).all<Record<string, unknown>>(),
    ctxPromise,
    idxPromise.catch(() => null),
  ]);
  const truncated = listing && fetched.length > LISTING_CANDIDATE_CAP;
  const results = truncated ? fetched.slice(0, LISTING_CANDIDATE_CAP) : fetched;
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
  /**
   * THE GREY COMPLETION IN THE SEARCH BOX («اقتراحات بلون رصاصي في الشريط
   * الكتابي نفسه»): the word the shopper is still typing, completed from the
   * names of the products this very answer ranked first — so the grey word
   * always names something on the list under it. Only on a search, and never
   * after a trailing space. worker/lib/search/complete.ts.
   */
  const suggestion = search
    ? {
        suggestion: typingLastWord
          ? suggestCompletion(
              search,
              results.flatMap((r) => [r.name, r.name_ar, r.name_ku])
            )
          : null,
      }
    : {};
  const cards = results.map((p) => {
    const b = compositions.get(String(p.id));
    // A composition card has its own narrow shape, and a LOCKED one has its
    // member prices stripped in there. `cardShape` must not touch it.
    if (b) return compositionCard(b, ctx);
    return withCompareType(
      cardShape(
        publicWithDisplayPrice(
          p,
          ctx,
          views.get(String(p.id)),
          undefined,
          offers.get(offerKey(subjectOf(String(p.id)))),
          pooled.has(String(p.id))
        )
      ),
      p,
      idx
    );
  });
  if (!listing) {
    return c.json({
      success: true,
      ...categoryField,
      ...suggestion,
      products: cards,
    });
  }

  /**
   * THE LISTING STEP: filter, sort and count over the resolved candidates
   * (worker/lib/listingFacets.ts), then page. The brand names for the facet
   * come from ONE read keyed by a json_each list.
   */
  const brandIds = [...new Set(results.map((r) => String(r.brand_id ?? '')).filter(Boolean))];
  const brandRows = brandIds.length
    ? ((
        await c.env.DB.prepare(
          'SELECT id, slug, name_ar, name_en, name_ckb FROM brands WHERE id IN (SELECT value FROM json_each(?))'
        )
          .bind(JSON.stringify(brandIds))
          .all<BrandInfo>()
      ).results ?? [])
    : [];
  const brands = new Map(brandRows.map((b) => [b.id, b]));
  const items = results.map((row, i) =>
    listingItemOf(row, cards[i], i, brands.get(String(row.brand_id ?? ''))?.slug ?? null)
  );
  const run = runListing(items, listingState, { facets: wantsFacets, brands });
  return c.json({
    success: true,
    ...categoryField,
    ...suggestion,
    products: run.items.slice(offset, offset + limit).map((i) => i.card),
    total: run.items.length,
    truncated,
    sort: listingState.sort,
    ...(run.facets ? { facets: run.facets } : {}),
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

    const [ctx, favRow, brandRow, relations, isPrinter, salesBadge, ratingRow] = await Promise.all([
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
      // The header's "how many have sold" tier. Joins this batch rather than
      // running after it, so the badge costs the page no extra round trip.
      salesBadgeFor(c.env.DB, String(row.id)),
      // The header's score. Same aggregate the reviews tab computes, on the
      // same `status = 'published'` filter, so the two can never disagree.
      c.env.DB.prepare(
        "SELECT COUNT(*) AS n, AVG(stars) AS avg_stars FROM reviews WHERE product_id = ? AND status = 'published'"
      )
        .bind(String(row.id))
        .first<{ n: number; avg_stars: number | null }>(),
    ]);
    /**
     * The linked new product's live price, when this listing is a used copy.
     * One extra read, and only for a graded row — an ordinary product pays
     * nothing for this feature.
     */
    let conditionReference: { reference_iqd: number; saving_iqd: number } | null = null;
    if (parsed.condition?.new_product_id) {
      const ref = await c.env.DB.prepare(
        "SELECT price_iqd FROM products WHERE id = ? AND status = 'active'"
      )
        .bind(parsed.condition.new_product_id)
        .first<{ price_iqd: number }>();
      conditionReference = conditionSaving(Number(parsed.price_iqd) || 0, ref ? Number(ref.price_iqd) : null);
    }
    const ratingCount = Number(ratingRow?.n) || 0;
    const ratingSummary = ratingCount > 0
      ? { average: Math.round(Number(ratingRow?.avg_stars ?? 0) * 10) / 10, count: ratingCount }
      : null;
    const doc = applyRelations(parsed, relations);
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

    const inventory = snapshotFrom(relations, {
      stock: doc.stock,
      reserved: Number(row.stock_reserved ?? 0),
      low_stock_threshold: (row.low_stock_threshold as number | null) ?? null,
    });
    const initialSelection = firstUsableDirectSelection(doc, {
      inventory,
      links: relations.links,
      activeGroupIds: relations.has_relations
        ? new Set(
            relations.groups.filter((group) => group.active !== 0 && group.active !== false).map((group) => group.id)
          )
        : undefined,
      transportDefaults: ctx.transportDefaults,
      coarseStock: poolMember,
    });
    const initialOptionValueIds = initialSelection?.option_value_ids ?? [];
    const initialOptionId = initialOptionValueIds[0] ?? null;
    const initialColorId = initialSelection?.color_id ?? null;
    const resolved = resolveUnitPrice({
      product: doc,
      optionId: initialOptionId,
      colorId: initialColorId,
      fulfillmentType: initialSelection ? 'direct_sale' : undefined,
      tier: ctx.tier,
      tierActive: ctx.tierActive,
      proPolicy: ctx.proPolicy,
      transportDefaults: ctx.transportDefaults,
      memberFallback: benefitFallbackFor(ctx, doc),
      isPrinter,
    });
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
      /**
       * The two header signals the page could not previously show.
       *
       * `sales_badge` is the TIER, not the count — worker/lib/salesBadge.ts
       * explains why the exact figure must not leave the Worker. Null below
       * the first tier, so a new product shows nothing rather than "0+".
       *
       * `rating` was reachable only through GET /api/reviews/product/:slug,
       * which the reviews TAB fetches — so the header could not show a score
       * until the shopper scrolled to and opened that tab. One extra aggregate
       * here is cheaper than the page being unable to answer "is this any
       * good?" above the fold.
       */
      sales_badge: salesBadge,
      rating: ratingSummary,
      /**
       * The new product's CURRENT price, for the struck-through comparison on
       * a graded listing. Resolved server-side so the page never has to fetch
       * a second product to price the first, and omitted entirely when there
       * is nothing honest to show — no link, a hidden reference, or a used
       * price that is not actually lower.
       */
      condition_reference: conditionReference,
      // The structure the JSON model could not express: option GROUPS, the
      // real many-to-many colour links, modelled combinations and bound
      // images. Null when the product has no relational rows at all.
      relations: publicRelations(relations, poolMember),
      // When a shelf-backed direct selection exists, every first-paint block
      // below answers that SAME selection. Otherwise they retain the legacy
      // base/null answer until the customer chooses.
      initial_selection: initialSelection
        ? {
            option_id: initialOptionId,
            option_value_ids: initialOptionValueIds,
            color_id: initialColorId,
            fulfillment_type: 'direct_sale' as const,
          }
        : null,
      pricing: publicQuote(resolved), // opening-selection resolver result, cost-free
      // §8/§9: the opening selection's member prices, from the live rules, so the
      // page can state the benefit on first paint rather than waiting for the
      // debounced quote to say what a membership is worth here.
      membership_preview: membershipPreview(
        ctx,
        doc,
        { optionId: initialOptionId, colorId: initialColorId },
        isPrinter
      ),
      // EVERY SELECTION THE CHOOSERS CAN REACH, PRICED HERE (see `priceLevels`).
      // The page paints the exact figure on the same frame as the tap, and the
      // debounced quote becomes a confirmation rather than a prerequisite.
      price_levels: priceLevels(doc, ctx, offer, Date.now()),
      // The final price of every way to get the opening selection (the quote
      // re-computes them per selection) — the page's fulfilment pills and
      // transport rows read these, and compute nothing.
      pricing_modes: pricingModes(
        doc,
        ctx,
        { optionId: initialOptionId, colorId: initialColorId },
        isPrinter
      ),
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
      availability:
        initialSelection?.availability ??
        saleAvailability(doc, {
          coarseStock: poolMember,
          transportDefaults: ctx.transportDefaults,
          inventory,
          links: relations.links,
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
  // Read up to what the quantity field can hold; above the ceiling the answer
  // is `availability.qty_ok: false` with `max_qty`, never a VALIDATION error.
  const qty = int(body.qty, 'qty', { min: 1, max: QTY_INPUT_MAX, def: 1 });

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
  const optionValueIds = quoteOptionValueIds(body.optionValueIds, rawOptionId, relations);
  // The resolver prices ONE option and the first selected value carries the
  // override — `resolveCartLine`'s authored-group rule, so neither reversing
  // the request array nor adding a secondary group can select a different
  // price-bearing model. With only `optionId` sent this remains that id, which
  // is what every existing caller sends.
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
/**
 * The graded shelf's rows — empty rather than fatal when migration 0085 has
 * not been applied yet.
 *
 * `'{}'` is `condition_doc`'s migration-declared DEFAULT and the value
 * `parseConditionDoc` reads as "not graded", so on a database without the
 * column EVERY row would fall outside `condition_doc <> '{}'`. An empty shelf
 * is therefore not a degraded answer that might be hiding listings; it is the
 * answer, one migration early. `isConditionColumnMissing` is what keeps that
 * true — a missing products TABLE, or any OTHER absent column, still throws.
 */
async function openBoxShelf(db: D1Database): Promise<Record<string, unknown>[]> {
  try {
    const r = await db
      .prepare("SELECT * FROM products WHERE status = 'active' AND condition_doc <> '{}' ORDER BY created_at DESC LIMIT 12")
      .all<Record<string, unknown>>();
    return r.results ?? [];
  } catch (e) {
    if (await isConditionColumnMissing(db, e)) return [];
    throw e;
  }
}

export const homeRoutes = new Hono<AppContext>();

homeRoutes.get('/', async (c) => {
  /**
   * THE MEMBERSHIP RULES ARE NOW AN INPUT TO THE DISCOUNTS QUERY, so the one
   * request that already loads them is started first and the strip's statement
   * is CHAINED off it rather than awaited before the wave.
   *
   * Everything else on the first screen — the settings, the latest strip, the
   * graded shelf, the taxonomy, the brands — keeps flying in parallel with it,
   * so the page waits on `max(the rest, pricingCtx + discounted)` instead of
   * gaining a round trip of its own. `pricingCtx` is two small reads that this
   * route already performed; nothing new is read.
   */
  const ctxPromise = pricingCtx(c);
  const settingsPromise = getSettings(c.env.DB, PUBLIC_SETTING_KEYS);
  const [settings, discounted, latest, openBoxRows, categories, brands, ctx] = await Promise.all([
    settingsPromise,
    /**
     * THE DISCOUNTS STRIP SELECTED ON A RETIRED CONCEPT, so it was always empty.
     *
     * It asked for `original_price_iqd > price_iqd` — the compare-at price
     * that §4 retired and the admin form now shows read-only, which nothing
     * writes any more. Live, this returned zero rows, so a section the owner
     * can see in the admin panel simply never appeared on the page.
     *
     * The honest reading of "discounted" in this shop is the one
     * `/api/products?type=discounted` already uses: a real membership price
     * BELOW the regular one. Same predicate, so the home strip and the
     * listing behind its "see all" can no longer disagree about what the word
     * means. `composition = ''` for the same reason the listing excludes
     * them — a bundle's availability is computed from its members and it
     * belongs on the bundles shelf, not here.
     *
     * AND THEN IT WAS EMPTY AGAIN, for the second time and the same reason:
     * "a real membership price" was read as a TYPED `pro_price_iqd` /
     * `prime_price_iqd`, while this shop states both memberships in
     * `membership_benefit_rules` and types neither column. The predicate is
     * now the UNION of the two, built by `discountedWhere` — which is a
     * function, and not a copy of a WHERE clause, precisely so that "same
     * predicate" above stays a fact rather than a hope.
     */
    ctxPromise.then((ready) => {
      const reach = discountedWhere(ready);
      return c.env.DB.prepare(
        `SELECT * FROM products
          WHERE status = 'active' AND composition = ''
            AND ${reach.sql}
          ORDER BY created_at DESC LIMIT 10`
      )
        .bind(...reach.params)
        .all<Record<string, unknown>>();
    }),
    c.env.DB.prepare("SELECT * FROM products WHERE status = 'active' ORDER BY created_at DESC LIMIT 20").all<
      Record<string, unknown>
    >(),
    // OPEN BOX / USED / REFURBISHED, newest first.
    //
    // `condition_doc <> '{}'` is the same predicate migration 0085's PARTIAL
    // index is built on, so this reads the index rather than scanning the
    // catalogue on the shop's first screen. The shelf shows a fixed handful;
    // the full list lives behind its own listing.
    //
    // Through openBoxShelf, because this ONE optional strip naming a column
    // from the newest migration is what turned the whole first screen into an
    // error card when a deploy landed ahead of its database — see
    // worker/lib/conditionProjection.ts.
    openBoxShelf(c.env.DB),
    /**
     * THE REAL TAXONOMY — MAIN SECTIONS, EACH WITH THE SUB-SECTIONS THAT HOLD
     * SOMETHING. «الأقسام الرئيسية ثم الأقسام الفرعية التي فيها المنتجات».
     *
     * This used to count through `product_catalogs` alone and returned `[]`
     * against the live database, so the home page showed no categories at all
     * while the admin listed «الطابعات · 3». The join table was empty — and
     * being emptied on every product save — because the product form records
     * the owner's choice in `category_id` / `sub_category_id`. One membership
     * relation over both, with counts that roll up from descendants, lives in
     * worker/lib/catalogMembership.ts along with the whole story.
     */
    // The sections the owner put in a bento square survive the tree's caps
    // (worker/lib/homeBento.ts), so an assignment is never cut off the page.
    settingsPromise.then((s) =>
      homeCategoryTree(c.env.DB, {
        keep: new Set(Object.values(normalizeHomeBento((s as Record<string, unknown>).homeBento)).map((a) => a!.category)),
      })
    ),
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
    ctxPromise,
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
  for (const r of [...discounted.results, ...latest.results, ...openBoxRows]) {
    homeRows.set(String(r.id), { id: String(r.id), inventory_mode: r.inventory_mode });
  }
  const [homeViews, homePooled, homeOffers] = await Promise.all([
    loadRelationsViews(c.env.DB, [...homeRows.values()]),
    // §8.2 row 18 on the home rails too: the same card, the same `stock` field.
    degradeIfSchemaMissing('mystery pools (migration 0061)', () => activePoolProductIds(c.env.DB, [...homeRows.keys()].map(String)), new Set<string>()),
    /**
     * SCHEDULED OFFERS, ON THE FIRST SCREEN — the shop's flash deals.
     *
     * `offer_windows` (migration 0060) is fully built, admin-editable at
     * /api/admin/offers, and honoured by /api/products and /api/bundles. The
     * home page passed a literal `null` where every one of those passes the
     * offer view, so a deal the owner scheduled priced correctly on the
     * listing and the product page and at NO price at all on the page every
     * visitor lands on first — no offer price, no countdown, no badge.
     *
     * One batched read for every card on the page, exactly as the listing
     * does it (§14), and the price still comes from `resolveOfferPrice` — the
     * same resolution the checkout charges, never a discount computed here.
     */
    degradeIfSchemaMissing(
      'offers (migration 0060)',
      () => loadOffers(c.env.DB, [...homeRows.keys()].map((id) => subjectOf(String(id)))),
      EMPTY_OFFERS()
    ),
  ]);

  /** The offer view for one card, or undefined when nothing is scheduled. */
  const offerFor = (id: unknown) => homeOffers.get(offerKey(subjectOf(String(id))));

  /**
   * The new-product prices the graded shelf compares against, in ONE read.
   *
   * Only ACTIVE rows: a used listing that points at a product the owner has
   * since hidden must not keep advertising a saving against a price the shop
   * no longer offers.
   */
  const referenceIds = [
    ...new Set(
      openBoxRows
        .map((r) => parseConditionDoc(r.condition_doc)?.new_product_id)
        .filter((id): id is string => typeof id === 'string' && id !== '')
    ),
  ];
  const referencePrices = new Map<string, number>();
  if (referenceIds.length > 0) {
    const { results: refRows } = await c.env.DB.prepare(
      `SELECT id, price_iqd FROM products WHERE status = 'active' AND id IN (${referenceIds.map(() => '?').join(',')})`
    )
      .bind(...referenceIds)
      .all<{ id: string; price_iqd: number }>();
    for (const r of refRows ?? []) referencePrices.set(String(r.id), Number(r.price_iqd) || 0);
  }
  const openBoxCards = openBoxRows.map((p) => {
    const card = cardShape(
      publicWithDisplayPrice(p, ctx, homeViews.get(String(p.id)), undefined, offerFor(p.id), homePooled.has(String(p.id)))
    );
    const condition = parseConditionDoc(p.condition_doc);
    const reference = condition?.new_product_id ? referencePrices.get(condition.new_product_id) : undefined;
    const saving = conditionSaving(Number(card.display_price_iqd ?? card.price_iqd ?? 0), reference);
    return saving ? { ...card, condition_reference: saving } : card;
  });

  return c.json({
    success: true,
    settings: safeSettings,
    discounted: discounted.results.map((p) =>
      cardShape(publicWithDisplayPrice(p, ctx, homeViews.get(String(p.id)), undefined, offerFor(p.id), homePooled.has(String(p.id))))
    ),
    latest: latest.results.map((p) =>
      cardShape(publicWithDisplayPrice(p, ctx, homeViews.get(String(p.id)), undefined, offerFor(p.id), homePooled.has(String(p.id))))
    ),
    // Already filtered to catalogs that hold something, at both levels —
    // homeCategoryTree drops the empties rather than making the client do it.
    categories,
    brands: brands.results.filter((r) => Number(r.product_count) > 0),
    // The first screen's own artwork — brand marks and service icons. Resolved
    // here rather than in the client so the seeded defaults and the owner's
    // uploads arrive as one already-decided list of URLs, and the storefront
    // never has to know what `UiUx/MainPage/` is. `mainPageMedia` is already in
    // PUBLIC_SETTING_KEYS, so this costs no extra read.
    siteMedia: resolveSiteMedia((safeSettings as Record<string, unknown>).mainPageMedia),
    /**
     * The graded shelf, each card carrying the CURRENT price of the new
     * product it is a copy of.
     *
     * Resolved here rather than on the card, because one batched read answers
     * the whole shelf: twelve cards would otherwise be twelve lookups on the
     * first screen. A link to a product that is gone, hidden, or not actually
     * dearer simply yields no comparison — conditionSaving() refuses to print
     * a zero or negative saving beside a struck-through number.
     */
    open_box: openBoxCards,
  });
});

// ------------------------------------------------------- home shelves (§below the fold)

/**
 * THE SECOND REQUEST THE HOME PAGE MAKES, and the reason it is second.
 *
 * `/api/home` is what the first screen waits on. These shelves — best sellers,
 * flash deals, the combo rail, the filament shuffle, the two rotating tiles —
 * are all below the fold, so making the paint wait on them would slow the page
 * every visitor sees to serve the part most of them scroll past. They are
 * fetched after it, and a slow or failed answer here costs the shopper nothing
 * they are currently looking at.
 *
 * EVERY SHELF IS PRICED THROUGH ONE RESOLUTION. The queries in
 * worker/lib/homeShelves.ts return IDS; the rows are read once, the relational
 * overlay and the offer windows are loaded once for all of them together, and
 * every card goes through the same `publicWithDisplayPrice` the product page
 * and the cart use. No shelf computes a discount of its own — that is how a
 * page ends up quoting a number the checkout refuses.
 *
 * A SHELF THAT CANNOT BE BUILT IS ABSENT, NOT WRONG. Each one degrades to an
 * empty list only where the doctrine in worker/lib/membershipBenefits.ts
 * permits it: a missing TABLE genuinely holds no rows. `offer_windows`
 * (migration 0060) is the one that matters here, and "no offers table" really
 * does mean "no offer is running".
 */
homeRoutes.get('/sections', async (c) => {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  /**
   * The filament root, by SLUG rather than by the seeded id.
   *
   * Nothing else in the worker matches on a seed id, and an owner may rename,
   * re-parent or replace this branch. Looking it up by slug means a shop that
   * calls its materials section something else still gets a shelf, and one
   * that has no such section gets no shelf instead of an error.
   */
  const filamentRoot = await c.env.DB
    .prepare("SELECT id FROM catalogs WHERE slug IN ('printing-materials','fdm-materials') AND active = 1 ORDER BY parent_id IS NOT NULL LIMIT 1")
    .first<{ id: string }>();

  const [bestIds, dealIds, filamentPool, featured, ctx] = await Promise.all([
    bestSellerIds(c.env.DB),
    degradeIfSchemaMissing('offers (migration 0060)', () => flashDealIds(c.env.DB, nowIso), [] as string[]),
    filamentRoot ? filamentCandidateIds(c.env.DB, filamentRoot.id) : Promise.resolve([] as string[]),
    featuredIds(c.env.DB),
    pricingCtx(c),
  ]);

  // The shuffle happens here, over ids, with a seed that is stable inside a
  // ten-minute bucket — see homeShelves.ts for why not ORDER BY RANDOM().
  const filament = seededShuffle(filamentPool, shuffleSeed(nowMs)).slice(0, SHELF_LIMIT);

  const wanted = [...new Set([...bestIds, ...dealIds, ...filament, ...featured])];
  if (wanted.length === 0) {
    return c.json({ success: true, best_sellers: [], flash_deals: [], filament: [], super_deals: [] });
  }

  const ph = wanted.map(() => '?').join(',');
  const { results: rows } = await c.env.DB
    .prepare(`SELECT * FROM products WHERE id IN (${ph})`)
    .bind(...wanted)
    .all<Record<string, unknown>>();

  const [views, offers, pooled] = await Promise.all([
    loadRelationsViews(c.env.DB, rows.map((r) => ({ id: String(r.id), inventory_mode: r.inventory_mode }))),
    degradeIfSchemaMissing('offers (migration 0060)', () => loadOffers(c.env.DB, rows.map((r) => subjectOf(String(r.id)))), EMPTY_OFFERS()),
    degradeIfSchemaMissing('mystery pools (migration 0061)', () => activePoolProductIds(c.env.DB, rows.map((r) => String(r.id))), new Set<string>()),
  ]);

  const cardById = new Map<string, Record<string, unknown>>();
  for (const p of rows) {
    const id = String(p.id);
    cardById.set(
      id,
      cardShape(
        publicWithDisplayPrice(
          p,
          ctx,
          views.get(id),
          undefined,
          offers.get(offerKey(subjectOf(id))),
          pooled.has(id)
        )
      )
    );
  }
  // `IN (...)` does not preserve the ranking each query established, so the
  // order is re-applied from the id lists rather than read off the rows.
  const pick = (ids: string[]) => ids.map((id) => cardById.get(id)).filter((x): x is Record<string, unknown> => !!x);

  return c.json({
    success: true,
    best_sellers: pick(bestIds),
    flash_deals: pick(dealIds),
    filament: pick(filament),
    super_deals: pick(featured),
  });
});
