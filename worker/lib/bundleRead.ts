/**
 * THE PUBLIC READ MODEL FOR COMPOSITION ROWS — docs/BUNDLES_MYSTERY.md §2,
 * §4, §9, §10 and §14.
 *
 * One pass turns a page of bundle rows into what a customer may see: the
 * scarcest-component availability verdict, the live price (derived, never the
 * cached copy), the eligibility verdict, and a payload from which every number
 * a viewer is not allowed to have has been REMOVED rather than merely not
 * rendered.
 *
 * FIVE RULES, all of them things that go wrong quietly if they are not held
 * here:
 *
 * 1. FOUR ROUND TRIPS FOR A WHOLE PAGE (§14). (1) the composition products —
 *    with `bundle_config` and `offer_windows` LEFT JOINed onto the same row,
 *    because a per-bundle read of either is the N+1 this design exists to
 *    avoid; (2) `bundle_components` with its allow-lists; (3) the product rows
 *    needed by the composition parents and their members; (4) one
 *    `loadRelationsViews` over that same set. Nothing in this file reads the
 *    database once per card, per component or per choice.
 *
 * 2. THE CARD QUOTES THE NUMBER THE DOOR CHARGES (§4.3). In a derived price
 *    mode `products.price_iqd` is a cached copy the admin save wrote; the
 *    charged price comes from the live component total. This pass has already
 *    resolved every component, so the fresh figure is in hand at exactly the
 *    point the stale one would be serialized, and it is what the `display_*`
 *    block carries.
 *
 * 3. THE LOCKED CARD IS AN ALLOW-LIST, NOT A REDACTION (§9). A locked payload
 *    is BUILT from a fixed short list of keys. Stripping fields from a full
 *    card is how the next field added to the card leaks: the allow-list makes
 *    the default "absent".
 *
 * 4. NO COUNTS, NO COMPONENTS, NO POOL IN A LISTING (§14). The listing carries
 *    a COARSE state and up to three main items. `blocking[]` carries real
 *    per-row stock numbers and never leaves the server; `max_bundles` reaches
 *    the customer only as `availability.stock.max_qty` on the detail, which is
 *    what the stepper needs.
 *
 * 5. THE BROWSER CLASSIFIES NOTHING. The state, the price, the tier verdict,
 *    the shipping type and the fulfilment modes are all server verdicts from
 *    `bundleAvailability` / `resolveBundlePrice` / `offerEligible`, so the
 *    card, the detail page, the cart and the door cannot disagree.
 */

import {
  bundleAvailability,
  COMPOSITION_LOW_BUNDLES,
  loadBundleComponents,
  loadCompositionMembers,
  resolveBundlePrice,
  type BundleComponentChoiceRow,
  type BundleComponentRow,
  type BundlePriceConfig,
  type CompositionAvailability,
  type CompositionState,
  type MemberRow,
  type ResolvedComponent,
  type SaleModeName,
} from './bundleComposition';
import { offerEligible, windowFromRow, type OfferCheck, type OfferWindow } from './offers';
import { resolveForOrderType, resolveStock } from './inventory';
import type { InventorySnapshot, StockResolution } from './inventory';
import { resolveUnitPrice, clampMemberLadder } from './pricing';
import type { MemberFallback, PreorderPricing, ProPricingPolicy, ResolvedPrice, Tier } from './pricing';
import { tierInherits, type TierStatus } from './entitlements';
import { effectiveAvailability } from '@levonis/pricing/availability';
import { typeForTransport, type ShippingType } from '@levonis/pricing/shippingType';
import { parseProductRow, type ProductDoc } from './productModel';
import { productImageForSelection } from './productSelectionImage';
import {
  applyRelations,
  capacityFrom,
  snapshotFrom,
  type ProductRelationsView,
} from './productOverlay';
import { isMissingTable } from './membershipBenefits';

// ---------------------------------------------------------------- the rows

/** `bundle_config`, with the defaults migration 0058 declares. A composition
 *  row with no config row is a `fixed`-price bundle, not an error. */
export interface BundleConfig extends BundlePriceConfig {
  max_qty_per_order: number;
  duplicate_policy: string;
  reveal_stage: string;
  show_odds: boolean;
}

export const DEFAULT_BUNDLE_CONFIG: BundleConfig = {
  price_mode: 'fixed',
  discount_percent: null,
  discount_iqd: null,
  plus_price_iqd: null,
  min_price_iqd: 1,
  max_qty_per_order: 5,
  duplicate_policy: '',
  reveal_stage: '',
  show_odds: false,
};

/**
 * The composition page's own SELECT list. `bundle_config` and `offer_windows`
 * ride on the product row under a prefix, so one round trip answers "which
 * bundles, priced how, gated how, open when" for a whole page.
 *
 * Every alias is prefixed because `products`, `bundle_config` and
 * `offer_windows` all carry `id`, `discount_percent`, `discount_iqd` and
 * `plus_price_iqd`: an unprefixed `bc.*` would silently overwrite the product
 * id with the config's, and `parseProductRow` would then read the wrong row.
 */
export const COMPOSITION_COLUMNS = `p.*,
  cfg.price_mode AS cfg_price_mode, cfg.discount_percent AS cfg_discount_percent,
  cfg.discount_iqd AS cfg_discount_iqd, cfg.min_price_iqd AS cfg_min_price_iqd,
  cfg.plus_price_iqd AS cfg_plus_price_iqd, cfg.max_qty_per_order AS cfg_max_qty_per_order,
  cfg.duplicate_policy AS cfg_duplicate_policy, cfg.reveal_stage AS cfg_reveal_stage,
  cfg.show_odds AS cfg_show_odds,
  w.id AS ofw_id, w.starts_at AS ofw_starts_at, w.ends_at AS ofw_ends_at,
  w.required_tiers AS ofw_required_tiers, w.offer_price_mode AS ofw_offer_price_mode,
  w.offer_price_iqd AS ofw_offer_price_iqd, w.discount_percent AS ofw_discount_percent,
  w.discount_iqd AS ofw_discount_iqd, w.plus_price_iqd AS ofw_plus_price_iqd,
  w.locked_preview AS ofw_locked_preview, w.active AS ofw_active`;

export const COMPOSITION_FROM = `FROM products p
  LEFT JOIN bundle_config cfg ON cfg.product_id = p.id
  LEFT JOIN offer_windows w ON w.subject_type = 'product' AND w.subject_id = p.id`;

/**
 * THE SAME SELECT WITHOUT THE OFFER JOIN — for a shop where migration 0060 was
 * never applied.
 *
 * `offer_windows` is an OPTIONAL feature, but it is joined into the row that
 * describes a bundle, so its absence took down every screen that reads one —
 * including a CART that merely contains a bundle line. A LEFT JOIN to a table
 * that does not exist is not a null, it is a hard SQLite error.
 *
 * Dropping the join is exactly equivalent to "no offer is running": the
 * `ofw_*` columns come back absent, and `windowFromJoin` already returns null
 * the moment `ofw_id` is null or undefined. So the bundle prices at its
 * ordinary price, which is the honest answer, rather than vanishing from the
 * customer's cart or 500ing the page.
 */
export const COMPOSITION_FROM_NO_OFFERS = `FROM products p
  LEFT JOIN bundle_config cfg ON cfg.product_id = p.id`;

/**
 * The same column list with every `w.<col> AS ofw_<x>` rewritten to
 * `NULL AS ofw_<x>`, DERIVED from the real list rather than written out again
 * — a second hand-maintained copy would drift the first time a column is
 * added, and drift here means a query that compiles and returns the wrong
 * shape. Selecting NULL keeps the row's shape identical, which is what lets
 * `windowFromJoin` answer "no offer" without any caller knowing.
 */
export const COMPOSITION_COLUMNS_NO_OFFERS = COMPOSITION_COLUMNS.replace(
  /\bw\.[A-Za-z_]+\s+AS\s+(ofw_[A-Za-z_]+)/g,
  'NULL AS $1'
);

/**
 * Run a composition SELECT, and answer it WITHOUT the offer join if and only
 * if the offer table is not installed. `build` receives the FROM clause so a
 * caller keeps its own WHERE and its own binds; it is called at most twice and
 * the second call is reached only after the first has already refused with
 * `no such table`.
 */
export async function compositionSelect(
  db: D1Database,
  build: (columns: string, from: string) => string,
  binds: readonly unknown[] = []
): Promise<Record<string, unknown>[]> {
  try {
    const r = await db
      .prepare(build(COMPOSITION_COLUMNS, COMPOSITION_FROM))
      .bind(...binds)
      .all<Record<string, unknown>>();
    return r.results ?? [];
  } catch (e) {
    // A MISSING TABLE ONLY. `offer_windows` with one column missing is a
    // table that EXISTS and may hold a live, advertised discount; dropping to
    // the no-offer projection there would charge the ordinary price for an
    // item the shop is advertising at 25% off, at HTTP 200, while logging
    // that 0060 "is not installed" — which would be false. See
    // `isMissingTable`.
    if (!isMissingTable(e)) throw e;
    console.warn('offers (migration 0060) not installed — bundles priced with no offer');
    const r = await db
      .prepare(build(COMPOSITION_COLUMNS_NO_OFFERS, COMPOSITION_FROM_NO_OFFERS))
      .bind(...binds)
      .all<Record<string, unknown>>();
    return r.results ?? [];
  }
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));

export function configFromRow(row: Record<string, unknown>): BundleConfig {
  if (row.cfg_price_mode === null || row.cfg_price_mode === undefined) return { ...DEFAULT_BUNDLE_CONFIG };
  const mode = String(row.cfg_price_mode);
  return {
    price_mode: mode === 'discount_percent' || mode === 'discount_iqd' ? mode : 'fixed',
    discount_percent: num(row.cfg_discount_percent),
    discount_iqd: num(row.cfg_discount_iqd),
    plus_price_iqd: num(row.cfg_plus_price_iqd),
    min_price_iqd: Math.max(1, Number(row.cfg_min_price_iqd) || 1),
    max_qty_per_order: Math.min(99, Math.max(1, Number(row.cfg_max_qty_per_order) || 5)),
    duplicate_policy: String(row.cfg_duplicate_policy ?? ''),
    reveal_stage: String(row.cfg_reveal_stage ?? ''),
    show_odds: !!row.cfg_show_odds,
  };
}

/** The joined `offer_windows` row, or null when the subject carries no window
 *  at all. Absent means "no offer", never "an offer that refuses" (§9). */
export function windowFromJoin(row: Record<string, unknown>): OfferWindow | null {
  if (row.ofw_id === null || row.ofw_id === undefined) return null;
  return windowFromRow({
    subject_type: 'product',
    subject_id: String(row.id ?? ''),
    id: String(row.ofw_id),
    starts_at: (row.ofw_starts_at as string | null) ?? null,
    ends_at: (row.ofw_ends_at as string | null) ?? null,
    required_tiers: String(row.ofw_required_tiers ?? '[]'),
    offer_price_mode: String(row.ofw_offer_price_mode ?? ''),
    offer_price_iqd: num(row.ofw_offer_price_iqd),
    discount_percent: num(row.ofw_discount_percent),
    discount_iqd: num(row.ofw_discount_iqd),
    plus_price_iqd: num(row.ofw_plus_price_iqd),
    locked_preview: Number(row.ofw_locked_preview ?? 1),
    active: Number(row.ofw_active ?? 1),
  });
}

// -------------------------------------------------------------- the result

export interface ResolvedComponentView extends ResolvedComponent {
  /** The member product, already overlaid with its relational rows. */
  doc: ProductDoc;
  /** The same authoritative relation view used to resolve this member's
   * selection. Images and physical dimensions must resolve against it too. */
  view: ProductRelationsView | null;
  /** Whether the buyer picks this component's option / colour (§1.4). */
  editable: { option: boolean; color: boolean };
  /** The allow-list a customer-selectable component may be chosen from, with
   *  the ids resolved to their real names. Empty for a pinned component. */
  choices: Array<{ dim: 'option_value' | 'color'; id: string; name: string; state: CompositionState }>;
  /** The coarse per-component state — never a count (§14). */
  state: CompositionState;
  /** The member row went draft or archived: the bundle cannot be sold. */
  unavailable: boolean;
  /**
   * Why this buyer's stored choice is no longer legal — an option value that
   * left the allow-list, a colour an admin deactivated, a component the admin
   * pinned after the line was written (§15.3 `BUNDLE_CHOICE_INVALID` /
   * `BUNDLE_COMPOSITION_CHANGED`). Empty on a read with no buyer behind it.
   */
  choice_errors: string[];
  /** The member's own active pre-order transports, for the shared-method rule. */
  transports: string[];
  /** This member sells ONLY as a pre-order. */
  preorder_only: boolean;
}

export interface BundlePricingView {
  applied_iqd: number;
  regular_iqd: number;
  prime_iqd: number | null;
  pro_iqd: number | null;
  plus_iqd: number | null;
  applied_tier: 'regular' | 'plus' | 'prime' | 'pro';
  component_total_iqd: number;
  discount_iqd: number;
  saving_percent: number;
  unit_subtotal_iqd: number;
  /** Which of the two mutually exclusive price sources answered (§4.5). */
  source: 'ladder' | 'derived' | 'offer';
  /**
   * The bundle ROW's own `resolveUnitPrice` output, before any derivation.
   *
   * The order snapshot is a `ResolvedPrice` with its rungs overwritten by the
   * figures actually charged (§6.2), so the checkout needs the resolver's own
   * object — its `direct`, its `transport`, its `pricing_basis` and its
   * `price_source` — rather than rebuilding a lookalike that would drift from
   * whatever the resolver learns next.
   */
  resolved: ResolvedPrice;
  errors: string[];
}

export interface ResolvedBundle {
  row: Record<string, unknown>;
  /** The composition product's own authoritative relations. This is separate
   *  from every member/component view below: its active `product_images` rows
   *  own the bundle/mystery cover used by cards, cart and order snapshots. */
  view: ProductRelationsView;
  doc: ProductDoc;
  config: BundleConfig;
  window: OfferWindow | null;
  offer: OfferCheck;
  components: ResolvedComponentView[];
  availability: CompositionAvailability;
  pricing: BundlePricingView;
  /** The viewer may see the numbers. False = the §9 allow-list only. */
  entitled: boolean;
  locked: boolean;
}

export interface CompositionViewer {
  tier: Tier;
  tierActive: boolean;
  proPolicy: ProPricingPolicy;
  transportDefaults: Array<{ method: string; commission_iqd: number }>;
  /** The membership itself, for `offerEligible`. `null` = a signed-out
   *  visitor, who is eligible unless a tier is actually required (§9). */
  status: TierStatus | null;
  /**
   * THE CONFIGURED MEMBERSHIP BENEFIT for one COMPONENT, supplied as a
   * function so this module needs no database of its own.
   *
   * It is deliberately applied to the components and NOT to the bundle's own
   * price. A bundle price is already a composed discount over what its parts
   * are worth; letting a category rule take another percentage off the parent
   * as well would discount the same goods twice — the exact stacking the
   * benefit rules refuse elsewhere. An owner who wants a bundle cheaper for
   * members types a member price on the bundle, which still wins outright.
   */
  memberFallbackFor?: (doc: { id?: string | null; category_id?: string | null; sub_category_id?: string | null }) => MemberFallback;
  nowMs: number;
  /**
   * HOW THE CUSTOMER PAYS, when the caller knows (the checkout does; a card
   * does not).
   *
   * The owner's rule is that a pre-order paid CASH ON DELIVERY is priced by the
   * direct-sale rules, and for a bundle the money that changes is the
   * COMPONENTS' transport commissions — they are charged on the parent (§2.2),
   * so a bundle resolved only at the prepaid basis would collect an air-freight
   * commission on an order that is paying cash at the door. A read with no
   * payment method behind it stays 'prepaid', which is exactly what the cart
   * and every card already assume.
   */
  preorderPricing?: PreorderPricing;
}

// ------------------------------------------------------------------ resolve

const TRANSPORT_ORDER = ['air', 'sea', 'land'] as const;
/** A customer-selectable component is judged on its BEST allowed choice, and
 *  the cartesian of two open dimensions is bounded so an admin who opened both
 *  on a product with many values cannot turn one card into a thousand
 *  `resolveStock` calls. */
const MAX_CHOICE_CANDIDATES = 24;

/**
 * A WHOLE PAGE OF COMPOSITION ROWS, RESOLVED — three reads, whatever the size.
 *
 * The caller has already done read (1), the composition products with their
 * config and window joined on. This does (2) the components with their
 * allow-lists and (3)+(4) the member products with one relations pass, through
 * `loadCompositionMembers` — the same loader the admin preview uses, so the
 * panel and the shop cannot read different rows.
 *
 * Named for the page on purpose: `bundleComposition.resolveComposition` is the
 * ADMIN SAVE's pass over unsaved form input for ONE bundle. Both end in the
 * same two verdict functions (`bundleAvailability`, `resolveBundlePrice`),
 * which is what §2.3 means by admin and shop never disagreeing.
 */
export async function resolveCompositionPage(
  db: D1Database,
  rows: Record<string, unknown>[],
  viewer: CompositionViewer
): Promise<Map<string, ResolvedBundle>> {
  return resolveCompositionLines(
    db,
    rows.map((r) => ({ key: String(r.id), row: r })),
    viewer
  );
}

/**
 * ONE BUYER'S CHOICE for one component of one line (§1.5, §5.1). `included`
 * carries an optional component the buyer un-ticked, which never lowers
 * `max_bundles` and never reaches the order snapshot.
 */
export interface ComponentChoice {
  option_value_ids: string[];
  color_id: string | null;
  included: boolean;
}

/**
 * A CART OR CHECKOUT LINE: the same composition row, resolved against the
 * choices this buyer actually stored rather than against the best allowed one.
 *
 * `key` is the cart item id, because two lines of one bundle with different
 * colours are two independent answers (§5.1) — keying the result by product id
 * would collapse them and price one of them with the other's components.
 */
export interface CompositionLineInput {
  key: string;
  row: Record<string, unknown>;
  choices?: Map<string, ComponentChoice>;
  /**
   * THE ROUTE THIS LINE IS ACTUALLY ON — `cart_items.transport_method`.
   *
   * A CARD has none: nobody has chosen a journey yet, and the card's question
   * is "can this be bought at all", so a pre-order component is read against
   * the best counter over the routes its member offers. A CART LINE does have
   * one, and must use it: the checkout resolves that line with exactly this
   * value, and a route holding its own quota is a different counter from the
   * shared pool. Reading the pool for a line that will spend air's quota makes
   * the cart publish a ceiling the sale does not have — too low and it caps a
   * customer who could buy more, too high and it promises places that are not
   * there. Absent = card; present = line.
   */
  transportMethod?: string;
}

/**
 * THE ONE PASS, for a page of cards OR a cart of lines.
 *
 * Cards and lines differ in exactly one respect — whose selection the
 * components are resolved against — so they share this function rather than
 * having a second resolver each: the card, the detail page, the cart and the
 * door are then incapable of quoting different prices or different states,
 * which is the property §2.3 exists to protect. Three reads whatever the size.
 */
export async function resolveCompositionLines(
  db: D1Database,
  lines: CompositionLineInput[],
  viewer: CompositionViewer
): Promise<Map<string, ResolvedBundle>> {
  const out = new Map<string, ResolvedBundle>();
  if (lines.length === 0) return out;

  const parentRows = [
    ...new Map(
      lines.map((line) => [
        String(line.row.id),
        { id: String(line.row.id), inventory_mode: line.row.inventory_mode },
      ])
    ).values(),
  ];
  const { byBundle, choicesByComponent } = await loadBundleComponents(
    db,
    parentRows.map((row) => row.id)
  );
  // Include the composition rows in the same batched product/relations read
  // already required for their members. That gives the cover one authoritative
  // `product_images` view without adding a parent-by-parent query path.
  const members = await loadCompositionMembers(
    db,
    [
      ...parentRows.map((row) => row.id),
      ...[...byBundle.values()].flat().map((c) => c.member_product_id),
    ]
  );

  for (const line of lines) {
    const id = String(line.row.id);
    const parent = members.get(id);
    // A parent disappearing between the joined page read and this batched
    // authoritative read is no longer a sellable line. Do not resurrect its
    // stale row (and especially its JSON gallery) for this response.
    if (!parent) continue;
    out.set(
      line.key,
      resolveOne(
        line.row,
        parent.view,
        byBundle.get(id) ?? [],
        choicesByComponent,
        members,
        viewer,
        line.choices,
        line.transportMethod
      )
    );
  }
  return out;
}

function resolveOne(
  row: Record<string, unknown>,
  view: ProductRelationsView,
  componentRows: BundleComponentRow[],
  choicesByComponent: Map<string, BundleComponentChoiceRow[]>,
  members: Map<string, MemberRow>,
  viewer: CompositionViewer,
  chosen?: Map<string, ComponentChoice>,
  /** The line's real route, or undefined for a card. See CompositionLineInput. */
  lineRoute?: string
): ResolvedBundle {
  // A composition product has an ordinary product gallery of its own. Overlay
  // it here, once, so every downstream surface reads active/canonical
  // `product_images`; stale `products.images` JSON can never become a card,
  // cart, checkout or immutable order image when relational rows exist.
  const doc = applyRelations(parseProductRow(row), view);
  const config = configFromRow(row);
  const window = windowFromJoin(row);
  const offer = offerEligible(viewer.status, { window, limits: null }, viewer.nowMs);

  // ---- every component, at the viewer's tier, against real stock ----------
  const partial = componentRows.map((c) =>
    resolveComponent(c, choicesByComponent.get(c.id) ?? [], members, viewer, chosen?.get(c.id), lineRoute)
  );
  const shipping = shippingPlan(partial);
  const components: ResolvedComponentView[] = partial.map((p, i) => ({
    ...p.component,
    shipping_type: shipping[i],
    unit: p.priceWith(shipping[i]),
    doc: p.doc,
    view: p.view,
    editable: p.editable,
    choices: p.choices,
    state: 'in_stock',
    unavailable: p.unavailable,
    choice_errors: p.choiceErrors,
    transports: p.transports,
    preorder_only: p.preorderOnly,
  }));

  // ---- the price: exactly one source, never two (§4.5, §4.6) -------------
  const pricing = resolvePricing(doc, config, window, components, viewer);

  // ---- the ONE state verdict ---------------------------------------------
  // `active` is the product's own status AND the price still being sellable:
  // a derived price that fell below its floor stops the sale rather than
  // dragging the bundle to nothing (§4.3).
  const sellable = doc.status === 'active' && !pricing.errors.includes('OFFER_INACTIVE');
  const availability = bundleAvailability(
    components,
    { starts_at: window?.starts_at ?? null, ends_at: window?.ends_at ?? null, nowMs: viewer.nowMs },
    sellable,
    offer
  );
  for (const e of pricing.errors) if (!availability.errors.includes(e)) availability.errors.push(e);

  // A member product that went draft or archived cannot be packed into a box,
  // whatever its stock row still says. `resolveStock` has no input for "this
  // product is no longer for sale", so the component carries the verdict as
  // `COMPONENT_UNAVAILABLE` and the state is corrected here — never silently.
  if (components.some((c) => c.included && c.unavailable)) {
    availability.max_bundles = 0;
    if (availability.state !== 'locked' && availability.state !== 'ended' && availability.state !== 'upcoming') {
      availability.state = 'sold_out';
    }
    if (!availability.errors.includes('COMPONENT_UNAVAILABLE')) availability.errors.push('COMPONENT_UNAVAILABLE');
  }

  for (const c of components) c.state = componentState(c, availability.state);

  return {
    row,
    view,
    doc,
    config,
    window,
    offer,
    components,
    availability,
    pricing,
    entitled: offer.ok || offer.reason !== 'MEMBERSHIP_REQUIRED',
    locked: !offer.ok && offer.reason === 'MEMBERSHIP_REQUIRED',
  };
}

interface PartialComponent {
  component: ResolvedComponent;
  doc: ProductDoc;
  view: ProductRelationsView | null;
  editable: { option: boolean; color: boolean };
  choices: ResolvedComponentView['choices'];
  unavailable: boolean;
  /** The member's own transport offers, for the shared-method rule (§17.12). */
  transports: string[];
  preorderOnly: boolean;
  directOnly: boolean;
  choiceErrors: string[];
  priceWith: (shipping: ShippingType) => ResolvedPrice;
}

function resolveComponent(
  c: BundleComponentRow,
  allowList: BundleComponentChoiceRow[],
  members: Map<string, MemberRow>,
  viewer: CompositionViewer,
  chosen?: ComponentChoice,
  /** The line's real route, or undefined for a card. See CompositionLineInput. */
  lineRoute?: string
): PartialComponent {
  const member = members.get(c.member_product_id) ?? null;
  const doc = member ? member.doc : parseProductRow({ id: c.member_product_id });
  const unavailable = !member || doc.status !== 'active';
  // Needed before the stock resolution below, because WHICH counter a component
  // reads is decided by what the member sells, not by what is on its shelf.
  const saleTypes0 = doc.sale_types.length ? doc.sale_types : [doc.selling_type];

  const snapshot: InventorySnapshot =
    member && member.view.has_relations
      ? snapshotFrom(member.view, {
          stock: doc.stock,
          reserved: Number(member.row.stock_reserved ?? 0),
          low_stock_threshold: doc.low_stock_threshold,
        })
      : {
          inventory_mode: 'BASE',
          base: {
            stock: doc.stock,
            reserved: Number(member?.row.stock_reserved ?? 0),
            low_stock_threshold: doc.low_stock_threshold,
          },
          option_values: [],
          colors: [],
          variants: [],
          group_ids: [],
        };

  // The best allowed selection, because a customer-selectable component is
  // bought at ONE of its choices and the card must say whether ANY of them can
  // be. A pinned component has exactly one candidate, so this is a no-op there.
  const optionCandidates = candidateIds(c.option_value_ids, c.customer_picks_option, allowList, 'option_value', doc.options);
  const colorCandidates = candidateIds(c.color_id ? [c.color_id] : [], c.customer_picks_color, allowList, 'color', doc.colors);

  // A LINE THE BUYER OWNS IS RESOLVED ON THE BUYER'S OWN CHOICE, never on the
  // best one still available: dropping to a different colour because theirs
  // ran out would change what they bought after they pressed Place order.
  // Anything the allow-list no longer permits becomes a named refusal instead
  // (§15.3), and the door never repairs it silently.
  const choiceErrors: string[] = [];
  let best: { sel: { option_value_ids: string[]; color_id: string | null }; res: StockResolution } | null = null;
  if (chosen) {
    const opts = [...new Set(chosen.option_value_ids.filter(Boolean))].sort();
    const col = chosen.color_id || null;
    for (const id of opts) if (!optionCandidates.includes(id)) choiceErrors.push('BUNDLE_CHOICE_INVALID');
    if (col && !colorCandidates.includes(col)) choiceErrors.push('BUNDLE_CHOICE_INVALID');
    const sel = { option_value_ids: opts, color_id: col };
    best = { sel, res: resolveStock(snapshot, sel) };
  } else {
    let tried = 0;
    for (const optId of optionCandidates.length ? optionCandidates : [null]) {
      for (const colId of colorCandidates.length ? colorCandidates : [null]) {
        if (tried >= MAX_CHOICE_CANDIDATES) break;
        tried += 1;
        const sel = { option_value_ids: optId ? [optId] : [], color_id: colId };
        const res = resolveStock(snapshot, sel);
        if (best === null || rank(res) > rank(best.res)) best = { sel, res };
      }
    }
  }
  const selection = best?.sel ?? { option_value_ids: [], color_id: null };
  let resolution: StockResolution = best
    ? best.res
    : { targets: [], tracked: false, available: null, error: null };

  /**
   * A PRE-ORDER COMPONENT IS READ AGAINST ITS IMPORT QUOTA, NOT THE SHELF.
   *
   * Everything above answers `resolveStock`, which only ever knows about a
   * shelf. For a member that travels as a pre-order that is the WRONG COUNTER
   * in both directions: a model with an empty shelf and four import places read
   * as sold out, so `POST /api/cart/items` refused the bundle OUT_OF_STOCK while
   * the identical standalone pre-order line was accepted; and a model with a
   * full quota and stock on the shelf read as freely available.
   *
   * THE CONDITION IS `preorderOnly`, AND IT MATCHES `shippingPlan` EXACTLY.
   * That function — the one that decides each component's journey a few lines
   * below, and whose answer the CHECKOUT re-reads to pick the counter it
   * actually moves — returns 'direct' for every component that is not
   * `preorderOnly`, because a member that sells both ways travels with the
   * bundle rather than on an import. Reading a dual-mode member against its
   * import quota here would make this pass and that one aim at different rows
   * for the same component: the cart would refuse a bundle whose member had a
   * full quota and a stocked shelf, then the checkout would sell it off the
   * shelf. The two must agree, so they are asked the same question.
   *
   * WHICH ROUTE, ACROSS ALL OF THEM. `shippingPlan` needs every component
   * before it can freeze a journey, so no route exists at this point in the
   * read. Asking only the shared pool would refuse a bundle whose route holds
   * its own places — air with five free while the pool is empty — so the
   * answer here is the BEST counter over the routes the member offers. It is
   * the honest answer to "can this bundle be bought at all", and it can only
   * be more permissive than the door, never less: the CHECKOUT re-asks with
   * the buyer's real `cart_items.transport_method` and that answer, not this
   * one, is what moves a counter. This function describes; the door decides.
   */
  if (!unavailable && member && effectiveAvailability({ availability_type: '' }, saleTypes0) === 'pre_order') {
    const capacity = capacityFrom(member.view, selection.option_value_ids);
    if (lineRoute !== undefined) {
      // A LINE. The checkout resolves this very line with this very route, so
      // the cart asks the identical question and the two cannot publish
      // different ceilings for the same sale.
      resolution = resolveForOrderType('pre_order', snapshot, selection, capacity, lineRoute);
    } else {
      // A CARD. No journey has been chosen, so the honest question is "is there
      // ANY route this can be bought on". '' asks the shared pool; each method
      // asks that route's own quota when it holds one and the pool when it does
      // not. `rank` is the same "untracked beats a big number beats zero" order
      // the choice loop above uses, so the most permissive real answer wins and
      // an unanswerable one never does. A card can only over-promise, and the
      // line and the door both correct it before anything moves.
      const routes = doc.preorder_transports.filter((t) => t.active !== false).map((t) => String(t.method));
      let bestCap: StockResolution | null = null;
      for (const method of ['', ...routes]) {
        const res = resolveForOrderType('pre_order', snapshot, selection, capacity, method);
        if (bestCap === null || rank(res) > rank(bestCap)) bestCap = res;
      }
      if (bestCap) resolution = bestCap;
    }
  }

  const saleTypes = saleTypes0;
  const eff = effectiveAvailability({ availability_type: '' }, saleTypes);
  const transports = doc.preorder_transports.filter((t) => t.active !== false).map((t) => t.method);

  const priceWith = (shipping: ShippingType): ResolvedPrice =>
    resolveUnitPrice({
      product: doc,
      optionId: selection.option_value_ids[0] ?? null,
      colorId: selection.color_id,
      transportMethod: shipping === 'direct' ? null : transportOf(shipping),
      tier: viewer.tier,
      tierActive: viewer.tierActive,
      proPolicy: viewer.proPolicy,
      transportDefaults: viewer.transportDefaults,
      memberFallback: viewer.memberFallbackFor?.(doc),
      preorderPricing: viewer.preorderPricing ?? 'prepaid',
    });

  return {
    component: {
      component_id: c.id,
      member_product_id: c.member_product_id,
      qty_per_bundle: c.qty,
      optional: c.optional,
      // A read has no cart behind it, so an optional component is shown as
      // INCLUDED: the card must quote the full offer, and the cart is where a
      // buyer un-ticks one (§2.2). A line carries the buyer's own answer.
      included: chosen ? chosen.included : true,
      selection,
      resolution,
      unit: null as unknown as ResolvedPrice,
      sale_types: saleTypes,
      shipping_type: 'direct',
    },
    doc,
    view: member?.view ?? null,
    editable: { option: c.customer_picks_option, color: c.customer_picks_color },
    choices: choiceViews(c, allowList, doc),
    unavailable,
    transports,
    preorderOnly: eff === 'pre_order',
    directOnly: eff === 'direct_sale',
    choiceErrors: [...new Set(choiceErrors)],
    priceWith,
  };
}

/** Untracked beats a big number beats zero beats an unanswerable selection. */
function rank(res: StockResolution): number {
  if (res.error) return -1;
  if (res.available === null) return Number.MAX_SAFE_INTEGER;
  return res.available;
}

const transportOf = (s: ShippingType): 'air' | 'sea' | 'land' =>
  s === 'preorder_air' ? 'air' : s === 'preorder_sea' ? 'sea' : 'land';

/**
 * ONE SHIPPING TYPE FOR THE WHOLE BUNDLE, or an honest `mixed`.
 *
 * The platform holds one shipping type per cart and freezes one onto
 * `orders.shipping_type`, so a bundle that resolved its components to two
 * types has no honest delivery date (§2.5). The rule of §17 decision 12: the
 * transport must be one that EVERY pre-order component offers. Where no such
 * method exists the components are deliberately left on different types so
 * `bundleAvailability` reports `mixed` and `BUNDLE_SHIPPING_MIXED` — never
 * forced onto the slowest transport, never split into two orders.
 */
function shippingPlan(parts: PartialComponent[]): ShippingType[] {
  const preorder = parts.filter((p) => p.preorderOnly);
  if (preorder.length === 0) return parts.map(() => 'direct');

  let shared: string[] | null = null;
  for (const p of preorder) {
    shared = shared === null ? [...p.transports] : shared.filter((m) => p.transports.includes(m));
  }
  const chosen = TRANSPORT_ORDER.find((m) => (shared ?? []).includes(m)) ?? null;
  return parts.map((p) => {
    // A component that only sells directly stays direct: that is exactly the
    // mix `bundleAvailability` must see and refuse.
    if (!p.preorderOnly) return 'direct';
    if (chosen) return typeForTransport(chosen);
    // No shared method: each pre-order component keeps its own first offer, so
    // the verdict is `mixed` rather than a silently chosen transport.
    return typeForTransport(TRANSPORT_ORDER.find((m) => p.transports.includes(m)) ?? '');
  });
}

function candidateIds(
  pinned: string[],
  customerPicks: boolean,
  allowList: BundleComponentChoiceRow[],
  dim: 'option_value' | 'color',
  levels: Array<{ id: string; active?: boolean }>
): string[] {
  if (pinned.length) return pinned;
  if (!customerPicks) return [];
  const active = levels.filter((l) => l.active !== false).map((l) => l.id);
  const allowed = allowList.filter((a) => a.dim === dim).map((a) => a.ref_id);
  // No rows for a dimension = "any active value of that dimension" (§1.4).
  return allowed.length ? active.filter((id) => allowed.includes(id)) : active;
}

function choiceViews(
  c: BundleComponentRow,
  allowList: BundleComponentChoiceRow[],
  doc: ProductDoc
): ResolvedComponentView['choices'] {
  const out: ResolvedComponentView['choices'] = [];
  if (c.customer_picks_option) {
    for (const id of candidateIds([], true, allowList, 'option_value', doc.options)) {
      const o = doc.options.find((x) => x.id === id);
      if (o) out.push({ dim: 'option_value', id, name: o.name_en, state: 'in_stock' });
    }
  }
  if (c.customer_picks_color) {
    for (const id of candidateIds([], true, allowList, 'color', doc.colors)) {
      const col = doc.colors.find((x) => x.id === id);
      if (col) out.push({ dim: 'color', id, name: col.name_en, state: 'in_stock' });
    }
  }
  return out;
}

/** The coarse per-component state — no counts ever leave this function. */
function componentState(c: ResolvedComponentView, bundleState: CompositionState): CompositionState {
  if (c.unavailable || c.resolution.error) return 'sold_out';
  const mode = effectiveAvailability({ availability_type: '' }, c.sale_types);
  if (mode === 'pre_order' || (c.shipping_type !== 'direct' && mode !== 'direct_sale')) return 'preorder';
  if (c.resolution.available === null) return bundleState === 'sold_out' ? 'sold_out' : 'in_stock';
  if (c.resolution.available < c.qty_per_bundle) return 'sold_out';
  return c.resolution.available <= c.qty_per_bundle * COMPOSITION_LOW_BUNDLES ? 'low' : 'in_stock';
}

// ------------------------------------------------------------------ pricing

/**
 * EXACTLY ONE PRICE SOURCE (§4.5, §4.6).
 *
 * A subject may carry `bundle_config.price_mode` or an `offer_windows` price,
 * never both — the two together are refused at admin save with
 * `OFFER_PRICE_CONFLICT`, and a row that reached this state anyway does not
 * sell rather than being priced by whichever branch ran first.
 */
function resolvePricing(
  doc: ProductDoc,
  config: BundleConfig,
  window: OfferWindow | null,
  components: ResolvedComponentView[],
  viewer: CompositionViewer
): BundlePricingView {
  const base = resolveUnitPrice({
    product: doc,
    tier: viewer.tier,
    tierActive: viewer.tierActive,
    proPolicy: viewer.proPolicy,
    transportDefaults: viewer.transportDefaults,
  });

  const componentTotal = components
    .filter((c) => c.included)
    .reduce((sum, c) => sum + Math.max(0, Math.trunc(c.unit.applied_iqd)) * c.qty_per_bundle, 0);

  const windowPrices = !!window && window.active && window.offer_price_mode !== '';
  const derived = config.price_mode !== 'fixed';
  if (windowPrices && derived) {
    return {
      applied_iqd: base.applied_iqd,
      regular_iqd: base.regular_iqd,
      prime_iqd: base.prime_iqd,
      pro_iqd: base.pro_iqd,
      plus_iqd: null,
      applied_tier: base.applied_tier === 'pro' || base.applied_tier === 'prime' ? base.applied_tier : 'regular',
      component_total_iqd: componentTotal,
      discount_iqd: 0,
      saving_percent: 0,
      unit_subtotal_iqd: base.unit_subtotal_iqd,
      source: 'ladder',
      resolved: base,
      errors: ['OFFER_PRICE_CONFLICT', 'OFFER_INACTIVE'],
    };
  }

  if (windowPrices) {
    // The window's own price, with the member rungs clamped against IT — the
    // anchor is the offer price, never the row's stored `price_iqd`.
    const w = window as OfferWindow;
    let regular = base.regular_iqd;
    if (w.offer_price_mode === 'fixed') regular = Math.max(0, Math.trunc(w.offer_price_iqd ?? base.regular_iqd));
    else if (w.offer_price_mode === 'discount_percent') {
      const p = Math.min(90, Math.max(1, Math.trunc(w.discount_percent ?? 0)));
      regular = Math.max(0, Math.floor((base.regular_iqd * (100 - p)) / 100));
    } else if (w.offer_price_mode === 'discount_iqd') {
      regular = base.regular_iqd - Math.max(0, Math.trunc(w.discount_iqd ?? 0));
    }
    // THE WINDOW PRICE OBEYS `bundle_config.min_price_iqd` TOO (§4.3).
    // Both of §4.3's floors were written for `bundle_config.price_mode`, and
    // §4.6 then made a live window the SOLE price source — so a window
    // `discount_iqd` of 4,000,000 on a bundle with a 100,000 floor sold it for
    // nothing, with the floor silently ignored. `Math.max(0, …)` is what made
    // it silent: it turned an impossible price into a free one. A price under
    // the floor does not clamp and does not sell — `refuseComposition` already
    // refuses on `OFFER_INACTIVE`, and the card reads the same error list.
    const floorIqd = Math.max(1, Math.trunc(config.min_price_iqd || 1));
    if (regular < floorIqd) {
      return {
        applied_iqd: base.applied_iqd,
        regular_iqd: base.regular_iqd,
        prime_iqd: base.prime_iqd,
        pro_iqd: base.pro_iqd,
        plus_iqd: null,
        applied_tier: base.applied_tier === 'pro' || base.applied_tier === 'prime' ? base.applied_tier : 'regular',
        component_total_iqd: componentTotal,
        discount_iqd: 0,
        saving_percent: 0,
        unit_subtotal_iqd: base.unit_subtotal_iqd,
        source: 'ladder',
        resolved: base,
        errors: ['DERIVED_PRICE_BELOW_FLOOR', 'OFFER_INACTIVE'],
      };
    }
    const ladder = memberLadder(regular, base, w.plus_price_iqd, viewer);
    const discount = Math.max(0, componentTotal - ladder.applied);
    return {
      applied_iqd: ladder.applied,
      regular_iqd: regular,
      prime_iqd: ladder.prime,
      pro_iqd: ladder.pro,
      plus_iqd: ladder.plus,
      applied_tier: ladder.tier,
      component_total_iqd: componentTotal,
      discount_iqd: discount,
      saving_percent: componentTotal > 0 ? Math.round((discount * 100) / componentTotal) : 0,
      unit_subtotal_iqd: ladder.applied + Math.max(0, base.unit_subtotal_iqd - base.applied_iqd),
      source: 'offer',
      resolved: base,
      errors: [],
    };
  }

  const priced = resolveBundlePrice({
    resolved: base,
    config,
    componentTotalIqd: componentTotal,
    tier: viewer.tier,
    tierActive: viewer.tierActive,
  });
  return {
    applied_iqd: priced.bundle_price_iqd,
    regular_iqd: priced.regular_iqd,
    prime_iqd: priced.prime_iqd,
    pro_iqd: priced.pro_iqd,
    plus_iqd: priced.plus_iqd,
    applied_tier: priced.applied_tier,
    component_total_iqd: priced.component_total_iqd,
    discount_iqd: priced.discount_iqd,
    saving_percent: priced.saving_percent,
    unit_subtotal_iqd: priced.unit_subtotal_iqd,
    source: derived ? 'derived' : 'ladder',
    resolved: base,
    errors: priced.errors,
  };
}

/** The rungs, clamped against the offer's own regular price, and the one this
 *  viewer is actually charged. Identical in shape to `resolveBundlePrice`'s so
 *  the card renders the two sources the same way. */
function memberLadder(
  regular: number,
  base: ResolvedPrice,
  plusPrice: number | null,
  viewer: CompositionViewer
): { applied: number; prime: number | null; pro: number | null; plus: number | null; tier: BundlePricingView['applied_tier'] } {
  const { prime, pro } = clampMemberLadder(regular, base.prime_iqd, base.pro_iqd);
  let plus: number | null = plusPrice === null || plusPrice === undefined ? null : Math.max(0, Math.trunc(plusPrice));
  if (plus !== null) {
    plus = Math.min(plus, regular);
    if (prime !== null) plus = Math.max(plus, prime);
    if (pro !== null) plus = Math.max(plus, pro);
  }
  if (viewer.tier === 'pro' && viewer.tierActive && (pro !== null || prime !== null || plus !== null))
    return { applied: pro ?? prime ?? plus!, prime, pro, plus, tier: 'pro' };
  if (viewer.tier === 'prime' && viewer.tierActive && (prime !== null || plus !== null))
    return { applied: prime ?? plus!, prime, pro, plus, tier: 'prime' };
  if (viewer.tierActive && tierInherits(viewer.tier, 'plus') && plus !== null)
    return { applied: plus, prime, pro, plus, tier: 'plus' };
  return { applied: regular, prime, pro, plus, tier: 'regular' };
}

// -------------------------------------------------------------- serializers

/**
 * The `display_*` override a composition row carries (§4.3, §4.4).
 *
 * Two things `publicWithDisplayPrice` cannot produce on its own: the DERIVED
 * price (it resolves the row's cached `price_iqd`) and the PLUS rung (the
 * shared resolver has three rungs and no PLUS). Without both, a PLUS member
 * would be shown the regular price on the grid and charged the PLUS price at
 * the door, and a derived-mode bundle would quote a number the cart does not
 * charge.
 */
export function displayOverride(b: ResolvedBundle) {
  return {
    display_price_iqd: b.pricing.applied_iqd,
    display_regular_iqd: b.pricing.regular_iqd,
    display_prime_iqd: b.pricing.prime_iqd,
    display_pro_iqd: b.pricing.pro_iqd,
    display_applied_tier: b.pricing.applied_tier,
    display_from: false,
  };
}

/** `max_qty` for a composition row: the scarcest component, the offer's own
 *  per-order cap and the line ceiling, whichever is smallest. */
export function compositionMaxQty(b: ResolvedBundle): number {
  const cap = Math.min(99, b.config.max_qty_per_order);
  if (b.availability.max_bundles === null) return cap;
  return Math.max(0, Math.min(cap, b.availability.max_bundles));
}

export const cover = (row: Record<string, unknown>): string => {
  const images = (row as { images?: unknown }).images;
  const list = Array.isArray(images) ? images : [];
  const first = list[0];
  if (typeof first === 'string') return first;
  if (first && typeof first === 'object' && typeof (first as { url?: unknown }).url === 'string') {
    return (first as { url: string }).url;
  }
  return '';
};

/** The offer block a card and a detail both carry: identity, gate, schedule.
 *  Never a price — a window's price reaches the viewer only through
 *  `display_*`, and only when they may pay it. */
export function offerBlock(b: ResolvedBundle) {
  return {
    offer_id: b.window?.id ?? null,
    required_tiers: b.offer.required_tiers,
    starts_at: b.window?.starts_at ?? null,
    ends_at: b.window?.ends_at ?? null,
  };
}

/**
 * THE LOCKED PAYLOAD — the §9 ALLOW-LIST, built rather than redacted.
 *
 * Exactly: id, product_slug, the three names, the cover, required_tiers,
 * starts_at, ends_at, locked, availability_state, and `display_regular_iqd`
 * ONLY when the window says a preview is allowed. Everything else — the
 * member prices, the applied tier, the whole composition block with its
 * component total, its saving and its main items, and every availability
 * count — is simply never written here.
 *
 * A locked card is a 200, never a 403: the page renders an honest lock
 * instead of an error path, and the purchase doors re-check independently.
 */
export function lockedCard(b: ResolvedBundle, _publicRow: Record<string, unknown>) {
  const card: Record<string, unknown> = {
    id: b.doc.id,
    product_slug: b.doc.slug,
    name: b.doc.name_en,
    name_ar: b.doc.name_ar,
    name_ku: b.doc.name_ckb,
    image: productImageForSelection(b.doc, { optionValueIds: [], colorId: null }, b.view),
    locked: true,
    availability_state: b.availability.state,
    offer: offerBlock(b),
  };
  if (b.offer.locked_preview) card.display_regular_iqd = b.pricing.regular_iqd;
  return card;
}

/**
 * THE UNLOCKED CARD (§10, §14). Light on purpose: a coarse state, up to three
 * main items, and the price block. Never the full component list, never a
 * per-component count, never a pool, never a weight.
 */
export function bundleCard(b: ResolvedBundle, publicRow: Record<string, unknown>) {
  if (b.locked) return lockedCard(b, publicRow);
  return {
    id: b.doc.id,
    product_slug: b.doc.slug,
    slug: b.doc.slug,
    name: b.doc.name_en,
    name_ar: b.doc.name_ar,
    name_ku: b.doc.name_ckb,
    description: b.doc.description_en,
    description_ar: b.doc.description_ar,
    description_ku: b.doc.description_ckb,
    image: productImageForSelection(b.doc, { optionValueIds: [], colorId: null }, b.view),
    sort: b.doc.display_order,
    is_featured: b.doc.is_featured,
    locked: false,
    availability_state: b.availability.state,
    ...displayOverride(b),
    composition: {
      kind: b.doc.composition,
      component_total_iqd: b.pricing.component_total_iqd,
      saving_percent: b.pricing.saving_percent,
      availability_state: b.availability.state,
      member_exclusive: b.availability.member_exclusive,
      shipping_type: b.availability.shipping_type,
      modes: b.availability.modes,
      main_items: mainItems(b),
    },
    offer: offerBlock(b),
  };
}

/** Up to three included items — a name and a thumbnail, nothing else (§14). */
function mainItems(b: ResolvedBundle) {
  return b.components
    .filter((c) => c.included)
    .slice(0, 3)
    .map((c) => ({
      product_id: c.member_product_id,
      slug: c.doc.slug,
      name: c.doc.name_en,
      image: productImageForSelection(
        c.doc,
        { optionValueIds: c.selection.option_value_ids, colorId: c.selection.color_id },
        c.view
      ),
      qty: c.qty_per_bundle,
    }));
}

/**
 * The detail page's component list. Names, images, variant labels, quantity,
 * whether it is optional or editable, the allowed choices for an editable one
 * — and a COARSE state per component. No `available`, no `reserved`, no
 * `needed`: `blocking[]` stays on the server.
 */
export function componentViews(b: ResolvedBundle) {
  return b.components.map((c) => ({
    component_id: c.component_id,
    product_id: c.member_product_id,
    slug: c.doc.slug,
    name: c.doc.name_en,
    image: productImageForSelection(
      c.doc,
      { optionValueIds: c.selection.option_value_ids, colorId: c.selection.color_id },
      c.view
    ),
    qty_per_bundle: c.qty_per_bundle,
    optional: c.optional,
    included: c.included,
    editable: c.editable,
    state: c.state,
    variant_label: variantLabel(c),
    choices: c.choices.map((ch) => ({ dim: ch.dim, id: ch.id, name: ch.name })),
  }));
}

/** «PLA Basic · 1.75mm · Black» — the option and colour NAMES, English in
 *  every language exactly as product names are (§13.3). */
function variantLabel(c: ResolvedComponentView): string {
  const parts: string[] = [];
  for (const id of c.selection.option_value_ids) {
    const o = c.doc.options.find((x) => x.id === id);
    if (o) parts.push(o.name_en);
  }
  if (c.selection.color_id) {
    const col = c.doc.colors.find((x) => x.id === c.selection.color_id);
    if (col) parts.push(col.name_en);
  }
  return parts.join(' · ');
}

/** The subset of `bundleAvailability` a customer may see: the verdict, the
 *  fulfilment modes and the shipping type. Every count is dropped here. */
export function publicAvailability(b: ResolvedBundle) {
  return {
    state: b.availability.state,
    shipping_type: b.availability.shipping_type,
    modes: b.availability.modes,
    member_exclusive: b.availability.member_exclusive,
  };
}

export type { SaleModeName };

// ------------------------------------------------------------------ queries

/** One composition row by slug, with its config and its offer window on the
 *  same row — the detail page's equivalent of the listing's first read. */
export async function loadCompositionBySlug(
  db: D1Database,
  slug: string
): Promise<Record<string, unknown> | null> {
  const rows = await compositionSelect(
    db,
    (cols, from) => `SELECT ${cols} ${from} WHERE p.slug = ? AND p.composition <> '' LIMIT 1`,
    [slug]
  );
  return rows[0] ?? null;
}
