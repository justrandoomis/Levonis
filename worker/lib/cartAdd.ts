/**
 * THE RULES OF AN ORDINARY ADD-TO-CART, WRITTEN ONCE (docs/ux/COLOUR-QUANTITIES.md §4.2).
 *
 * `POST /api/cart/items` judged one line inline. The batch door
 * (`POST /api/cart/items/batch`) judges up to forty lines of one product, and
 * a second copy of these refusals would drift from the first the day either is
 * edited — a colour the single door refuses would then reach the cart through
 * the batch. So the single door's body is split at its natural seams, here,
 * and BOTH doors call the same functions:
 *
 *   `loadAddProduct`      the sellable product read (404 / 409 PRICE_NOT_AVAILABLE);
 *   `loadAddContext`      the PRODUCT-level reads and refusals, once per request:
 *                         pricing, relations, the printer flag, the offers, the
 *                         mystery `coarseStock` probe, WARRANTY_NOT_PRINTER and the
 *                         live-offer MEMBERSHIP_REQUIRED gate;
 *   `judgeLevonisLine`    PURE — every LINE-level refusal in the single door's
 *                         order, returning what the write needs or the exact
 *                         HttpError the single door throws;
 *
 * The write itself, `upsertStatement`, stays in worker/routes/cart.ts beside
 * the bundle upsert: tests/cartMultiOptionIdentity.test.ts holds that file to
 * exactly two targetless upserts (the 0082 rolling-deploy rule), and both
 * doors call the one statement from there.
 *
 * tests/cartBatchParity.test.ts holds the two doors to the same status, code
 * and details for every refusal, and to the identical row for a success.
 */
import type { Context } from 'hono';
import type { AppContext } from './types';
import { HttpError, badRequest, notFound } from './http';
import { listing, refuseIfOnlyCatalog } from './listing';
import { loadRelationsViews, snapshotFrom, capacityFrom, EMPTY_RELATIONS, type ProductRelationsView } from './productOverlay';
import { isPrinterProduct } from './printerIdentity';
import { refuseNonPrinterWarranty } from './warrantyPlans';
import { degradeIfSchemaMissing } from './membershipBenefits';
import { loadOffers, offerEligible, offerKey, offerPriceRefusal, subjectOf, type OfferView } from './offers';
import { activePoolProductIds } from './mysteryDraw';
import { SKU_STRICT_ERROR, type Tier } from './pricing';
import type { TierStatus } from './entitlements';
import type { ProductDoc } from './productModel';
import { canonicalOptionValueIds, optionValueIdsJson } from './cartSelectionIdentity';
import { resolveForOrderType, type OrderType, type StockResolution } from './inventory';
import { LINE_QTY_MAX } from '@levonis/pricing/quantity';
import {
  cartPricing,
  refuseIncompleteSelection,
  refuseQty,
  resolveCartLine,
  type PricingContext,
} from '../routes/cart';
import { lineOrderType, saleAvailability, unusableOrderType, type SaleAvailability } from '../routes/products';

/** What every line of one add shares: the route, the order type and the warranty plan. */
export interface AddShared {
  transportMethod: string;
  fulfillmentType: string;
  warrantyPlanId: string;
}

/** One line of an add: its own selection and quantity. */
export interface AddLine {
  /** Canonical, at most 12 (the door's parser). */
  optionValueIds: string[];
  colorId: string;
  qty: number;
}

/** The product-level facts of one add, read once per request. */
export interface AddContext {
  product: Record<string, unknown>;
  productId: string;
  tier: Tier;
  tierActive: boolean;
  status: TierStatus;
  ctx: PricingContext;
  view: ProductRelationsView | undefined;
  isPrinter: boolean;
  offer: { view: OfferView | null; eligible: boolean; nowMs: number };
  /** §8.2 row 18: a mystery-pool member's refusals carry no count. */
  coarseStock: boolean;
}

/** What a line that passed every check carries to the write. */
export interface JudgedLine {
  doc: ProductDoc;
  canonical: string[];
  canonicalJson: string;
  /** The lexically first canonical value: it is part of the unique key. */
  primaryOption: string;
  availability: SaleAvailability;
  /** The type this row will be (`lineOrderType`), '' only for a legacy shape. */
  lineType: '' | OrderType;
  /** What a merge with an existing identical line may reach. */
  ceiling: number;
}

/**
 * SELLABLE (worker/lib/listing.ts): a held or unpriced product is not added.
 * One a customer can still see (catalog-only, DECISIONS row 240) answers 409
 * PRICE_NOT_AVAILABLE; any other answers 404.
 */
export async function loadAddProduct(c: Context<AppContext>, productId: string): Promise<Record<string, unknown>> {
  const product = await c.env.DB.prepare(`SELECT * FROM products WHERE id = ? AND ${(await listing(c.env.DB)).sellable('products')}`)
    .bind(productId)
    .first<Record<string, unknown>>();
  if (!product) {
    await refuseIfOnlyCatalog(c.env.DB, productId);
    throw notFound('Product not found or unavailable');
  }
  return product;
}

/** A composition row (bundle, mystery) takes its own door (§5); the batch has none. */
export const isComposition = (product: Record<string, unknown>): boolean => String(product.composition ?? '') !== '';

/**
 * The product-level half of an add: every read and every refusal that does not
 * depend on which line is being added. Done ONCE for a batch of forty lines.
 */
export async function loadAddContext(
  c: Context<AppContext>,
  product: Record<string, unknown>,
  opts: { warrantyPlanId: string }
): Promise<AddContext> {
  const productId = String(product.id);
  const [{ tier, active: tierActive, status, ctx }, views, isPrinter, addOffers, pool] = await Promise.all([
    cartPricing(c),
    loadRelationsViews(c.env.DB, [{ id: productId, inventory_mode: product.inventory_mode }]),
    // The owner's catalog flag decides whether an extended warranty may ride
    // on this line at all — "this system applies to printers only".
    opts.warrantyPlanId ? isPrinterProduct(c.env.DB, productId) : Promise.resolve(false),
    // Same rule as the cart read: no 0060 means no window exists, so the
    // ladder price IS this line's price. Anything other than a missing table
    // still refuses the add rather than storing a line at the wrong price.
    degradeIfSchemaMissing(
      'special offers (migration 0060)',
      () => loadOffers(c.env.DB, [subjectOf(productId)]),
      new Map<string, OfferView>()
    ),
    // Stock comes from the authoritative level for THIS selection — and it is
    // COARSE FOR A MYSTERY-POOL MEMBER (§8.2 row 18). The refusals quote
    // `availability.stock.available`, so an add-to-cart of qty 99 was an
    // oracle on its own: "Only 7 left" for one candidate and "Only 9 left" for
    // the rest names the drawn colour without buying anything. The coarse
    // branch returns `available: null`, so both refusals take their existing
    // count-free path with no new branch.
    degradeIfSchemaMissing('mystery pools (migration 0061)', () => activePoolProductIds(c.env.DB, [productId]), new Set<string>()),
  ]);
  refuseNonPrinterWarranty(isPrinter, opts.warrantyPlanId);
  // ADD-TO-CART RE-CHECKS THE OFFER INDEPENDENTLY (§15.1 rule 6). A window
  // that ended, was switched off or gates a tier this buyer does not hold
  // refuses here rather than letting the line sit in a cart the checkout will
  // reject with a different sentence.
  const nowMs = Date.now();
  const offerView = addOffers.get(offerKey(subjectOf(productId))) ?? null;
  const offerCheck = offerEligible(status, offerView, nowMs);
  // Only a LIVE window can refuse: an ordinary product outlives its
  // promotions, and an expired one must not make it permanently unbuyable.
  if (offerView?.window && !offerCheck.ok && offerCheck.reason === 'MEMBERSHIP_REQUIRED') {
    throw new HttpError(403, `"${String(product.name_ar || product.name)}" is available to members only`, 'MEMBERSHIP_REQUIRED', {
      required_tiers: offerCheck.required_tiers,
    });
  }
  return {
    product,
    productId,
    tier,
    tierActive,
    status,
    ctx,
    view: views.get(productId),
    isPrinter,
    offer: { view: offerView, eligible: offerCheck.ok, nowMs },
    coarseStock: pool.size > 0,
  };
}

/**
 * Every LINE-level refusal of the single door, in the single door's order.
 * Throws the HttpError the single door throws; returns what the write needs.
 * Pure: no I/O.
 */
export function judgeLevonisLineOrThrow(actx: AddContext, line: AddLine, shared: AddShared): JudgedLine {
  const { product, ctx, view } = actx;
  const { optionValueIds, colorId, qty } = line;
  const { transportMethod, fulfillmentType, warrantyPlanId } = shared;
  const optionId = optionValueIds[0] ?? '';
  const { doc, resolved, selectionErrors } = resolveCartLine(
    product,
    { optionId, optionValueIds, colorId, transportMethod, fulfillmentType, warrantyPlanId },
    actx.tier,
    actx.tierActive,
    ctx,
    view,
    'prepaid',
    actx.isPrinter,
    actx.offer
  );
  if (offerPriceRefusal(resolved.errors)) {
    throw badRequest('This offer is not available right now', 'OFFER_INACTIVE');
  }
  // A MISSING ROUTE KEEPS ITS OWN CODE. Now that the product page always
  // states the order type, the resolver narrows `saleTypes` to the stated one
  // and raises TRANSPORT_REQUIRED here (packages/pricing/src/pricing.ts) —
  // ninety lines before the door's own guard below can be reached. Flattening
  // it to 'VALIDATION' handed the customer an untranslated code inside an
  // English sentence, when the page already speaks this one in all three
  // languages. The guard below still answers the legacy shape: a body with
  // NEITHER field on a product that sells both ways, which the resolver cannot
  // narrow and therefore never flags.
  if (resolved.errors.length === 1 && resolved.errors[0] === 'TRANSPORT_REQUIRED') {
    throw badRequest('Choose a shipping method for this pre-order', 'TRANSPORT_REQUIRED');
  }
  // Pricing V2 strict (spec C-13): a SKU × channel not priced yet is not for sale — the page speaks this code.
  // An incomplete selection has no SKU row either: «choose an option» is the truer answer there, and since
  // the clean start every ordinary product is strict, so the selection guard speaks first.
  if (resolved.errors.includes(SKU_STRICT_ERROR)) {
    refuseIncompleteSelection(saleAvailability(doc, { optionValueIds, colorId: colorId || null, qty: 1 }));
    throw badRequest('That option is not available right now', SKU_STRICT_ERROR);
  }
  if (resolved.errors.length > 0) {
    throw badRequest(`Invalid selection: ${resolved.errors.join(', ')}`, 'VALIDATION');
  }
  // §7: the colour/option combination must be one the admin actually offers.
  if (selectionErrors.length > 0) {
    throw badRequest(`Invalid selection: ${selectionErrors.join(', ')}`, 'VALIDATION');
  }

  const availability = saleAvailability(doc, {
    optionValueIds,
    colorId: colorId || null,
    qty,
    coarseStock: actx.coarseStock,
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
  const lineType = lineOrderType(availability, fulfillmentType, transportMethod);
  const stated = unusableOrderType(availability, lineType);
  if (stated) throw badRequest(stated.message, stated.code);
  // A PRE-ORDER WITHOUT A ROUTE IS A LINE NO PART OF THIS SHOP AGREES ABOUT.
  //
  // The pricing resolver only raises TRANSPORT_REQUIRED when the order type is
  // narrowed to pre-order — either stated outright or because the product
  // sells exactly one way (packages/pricing/src/pricing.ts). A DUAL-MODE
  // product whose direct shelf is empty falls through both tests when the body
  // carries neither field, and the row was then stored with an empty type and
  // an empty route: the money resolved it to a direct sale, `GET /api/cart`
  // and the checkout resolved the same row to a pre-order. One row, two
  // answers, and the customer read «بيع مباشر» under a pre-order they had
  // chosen.
  //
  // Keyed on `lineOrderType` — the read model's rule and the checkout's rule —
  // so the door refuses exactly the lines the rest of the stack calls
  // pre-orders. It cannot fire when no route is offered at all: `preorderUsable`
  // is false for an empty transport list, so `mode` is 'unavailable' and the
  // refusal below wins first with NO_TRANSPORT_OFFERED. The offered routes ride
  // along in `details` so a caller can render a chooser instead of a dead end.
  if (lineType === 'pre_order' && !transportMethod) {
    throw new HttpError(400, 'Choose a shipping method for this pre-order', 'TRANSPORT_REQUIRED', {
      transport_methods: availability.preorder.transports.filter((t) => t.configured).map((t) => t.method),
    });
  }
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

  // The full selection is stored canonically sorted so two requests that name
  // the same values in a different order are the same line. option_id is the
  // lexically first canonical value as well: it participates in the unique
  // key, so tying it to mutable admin group order would let reordering groups
  // create a duplicate of the exact same option_value_ids selection. Pricing
  // already used authored group order in resolveCartLine above and stays
  // deliberately separate from this persisted identity.
  const canonical = canonicalOptionValueIds(optionValueIds);
  return {
    doc,
    canonical,
    canonicalJson: optionValueIdsJson(canonical),
    primaryOption: canonical[0] ?? '',
    availability,
    lineType,
    // A SECOND ADD OF THE SAME LINE IS HELD TO THE SAME CEILING. The door
    // judged `qty` alone against `max_qty`; the merge adds what the line
    // already holds, and used to stop only at the storage limit — so two
    // adds of 600 on a shelf of 1,000 left a line the checkout refuses.
    // The merged line becomes the most this selection sells (the owner's
    // rule: set the most, never say no), never less than this add.
    ceiling: Math.max(qty, Math.min(LINE_QTY_MAX, availability.stock.max_qty)),
  };
}

/** The same judgement, as data: the refusal the single door would throw, or the judged line. */
export function judgeLevonisLine(
  actx: AddContext,
  line: AddLine,
  shared: AddShared
): { ok: true; judged: JudgedLine } | { ok: false; error: HttpError } {
  try {
    return { ok: true, judged: judgeLevonisLineOrThrow(actx, line, shared) };
  } catch (e) {
    if (e instanceof HttpError) return { ok: false, error: e };
    throw e;
  }
}

/**
 * The stock counters this judged line draws on — the CHECKOUT's resolver
 * (`resolveForOrderType`, as worker/routes/orders.ts calls it), so the batch
 * door sums demand exactly where the checkout will.
 */
export function lineStockTargets(actx: AddContext, judged: JudgedLine, line: AddLine, shared: AddShared): StockResolution {
  const { product, view } = actx;
  return resolveForOrderType(
    judged.lineType || 'direct_sale',
    snapshotFrom(view ?? EMPTY_RELATIONS, {
      stock: judged.doc.stock,
      reserved: Number(product.stock_reserved ?? 0),
      low_stock_threshold: (product.low_stock_threshold as number | null) ?? null,
    }),
    { option_value_ids: line.optionValueIds, color_id: line.colorId || null },
    view ? capacityFrom(view, line.optionValueIds) : null,
    shared.transportMethod
  );
}
