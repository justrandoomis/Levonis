import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext, SessionUser } from '../lib/types';
import { safeParse } from '../lib/types';
import { requireAuth, badRequest, conflict, notFound, str, int, unavailable, HttpError } from '../lib/http';
import { cartLineSelect } from '../lib/cartLineProjection';
import { newId, newOrderId } from '../lib/crypto';
import { readProductDeliveryOptions } from '../lib/productModel';
import { productImageForSelection } from '../lib/productSelectionImage';
import {
  EMPTY_PHYSICAL_DIMENSIONS,
  resolveSelectionPhysicalDimensions,
  type PhysicalDimensions,
} from '../lib/physicalDimensions';
import { deliversToHome, getSetting, getSettings, printerNoteIqdFrom } from '../lib/settings';
import type { DeliveryMethod, CheckoutPaymentMethod, ProPriorityDeliveryConfig, GiniPolicy } from '../lib/settings';
import { addDays, baghdadDay, baghdadDayOf, isDay } from '../lib/baghdadTime';
import { COMPOSED_SNAPSHOT, COST_BASIS, costSnapshot, type CostBasis } from '../lib/financeLedger';
import {
  MAX_DELIVERY_DAYS,
  dayLabel,
  deliveryWindow,
  validateDeliveryDay,
  type DeliveryDayPolicy,
} from '../lib/deliveryDay';
import {
  resolveCartLine,
  pricingContextFrom,
  publicBreakdown,
  resolveCartBundles,
  selectionFromCartRow,
  refuseIncompleteSelection,
} from './cart';
import type { ResolvedBundle } from '../lib/bundleRead';
import {
  allocateComponentValue,
  loadCompositionMembers,
  memberSnapshot,
  resolveComponentCounter,
} from '../lib/bundleComposition';
import { applyMysteryToBundles, resolveCartMystery } from '../lib/bundleCart';
import {
  drawMysteryLine,
  refuseMystery,
  type MysteryContext,
  type MysteryDraw,
} from '../lib/mysteryLine';
import {
  activePoolProductIds,
  allocationStatement,
  drawAuditStatement,
} from '../lib/mysteryDraw';
import { mysteryRefusal } from '../lib/mystery/issues';
import {
  isRevealed,
  loadAllocations,
  mysteryProjection,
  paidOrderIds,
  revealStampStatement,
  type AllocationRow,
} from '../lib/mysteryReveal';

/** One mystery cart line, resolved and drawn ONCE in the checkout pre-pass and
 *  read by all three `priceLines` passes and by the quote (§5.3, §7.4). */
interface MysteryLineResolution {
  ctx: MysteryContext;
  draw: MysteryDraw;
  cartItemId: string;
}
import {
  componentFeeBreakdown,
  componentFeesIqd,
  componentVariantLabel,
  compositionOptionSnapshot,
  includedComponents,
  refuseComposition,
  refusePhysicalLines,
} from '../lib/bundleCart';
import { loadOffers, offerEligible, offerKey, offerPriceRefusal, offerRedemptionStatement, subjectOf } from '../lib/offers';
import {
  allowedPaymentMethods,
  isBnpl,
  isCod,
  isPaymentMethodAllowed,
  isGini,
  GINI_ORDER_NO_RE,
  isPrepaid,
  preorderPricingFor,
  PAYMENT_METHOD_NOT_ALLOWED,
} from '../lib/paymentPolicy';
import type { PreorderPricing } from '../lib/pricing';
import { printerProductIds } from '../lib/printerIdentity';
import { printerHomeDeliveryAdvanceIqd } from '../lib/printerAdvance';
import { giniSplit, giniHoldUntil, giniStateOf } from '../lib/gini';
import { refuseNonPrinterWarranty } from '../lib/warrantyPlans';
import { lineOrderType, saleAvailability } from './products';
import { capacityFrom, EMPTY_RELATIONS, loadRelationsViews, snapshotFrom } from '../lib/productOverlay';
import {
  isCapacityScope,
  planInventory,
  reservationFenceStatement,
  resolveForOrderType,
  type OrderType,
} from '../lib/inventory';
import { dailyUserHash, emitFromRequest, eventsEnabled, outboxStatement, pumpAfter, waitUntilFrom } from '../lib/eventBus';
import { CheckoutStartedV1 } from '@levonis/contracts/events/v1/CheckoutStarted';
import { OrderCreatedV1 } from '@levonis/contracts/events/v1/OrderCreated';
import { planOrderReturn } from '../lib/orderInventory';
import { cancelledOrderRefundStatements } from '../lib/orderCancelOps';
import type { StockMove, StockResolution, StockTarget } from '../lib/inventory';
import { benefits, pricingTierContext, preorderGiftFor, shippingEntitlementContext } from '../lib/entitlements';
import {
  activeBenefitRules,
  ancestryFor,
  catalogAncestry,
  currentBenefitVersionId,
  degradeIfSchemaMissing,
  isSchemaMissing,
  resolveOrderBenefits,
  resolveProductBenefits,
} from '../lib/membershipBenefits';
import type { BenefitLineInput, ProductBenefits } from '../lib/membershipBenefits';
import type { ShippingBenefit, TaxBenefit } from '@levonis/pricing/membershipBenefits';
import type { Tier as PricingTier } from '../lib/pricing';
import type { PreorderGiftConfig, TierStatus } from '../lib/entitlements';
import {
  bnplCancellationStatement,
  bnplChargeStatement,
  bnplDueAt,
  bnplEligibility,
  type BnplEligibility,
} from '../lib/bnpl';
import { priorityDeliveryVerdict, type PriorityDeliveryVerdict } from '../lib/priorityDelivery';
import { validateCoupon } from '../lib/membershipOps';
import {
  getAvailableBalances,
  readWalletDust,
  usdSpendStatement,
  walletIqdAvailable,
  walletSpendCents,
} from '../lib/walletOps';
import { buildSupportSnapshot } from '../lib/supportCode';
import {
  eligibleMerchandiseIqd,
  netEligibleIqd,
  pointsForEligibleIqd,
  capRedeemablePoints,
  resolvePointsRule,
  getPointsRuleConfig,
  buildPurchaseAccrual,
  buildSettlementStatements,
  recordOrderSettlement,
  releaseAccrualForOrder,
  getOrderPointsSnapshots,
} from '../lib/pointsOps';
import type { PointsRule, OrderPointsSnapshot } from '../lib/pointsOps';
import { audit } from '../lib/audit';
import { rateLimit } from '../lib/ratelimit';
import { quoteShipping } from '../lib/shipping';
import { productDeliveryMethodAvailable } from '../lib/shipping';
import type { ProductDeliveryMethod, ShippingConfig, ShippingItem, ShippingQuote } from '../lib/shipping';
import { codDeliveryTaxIqd } from '../lib/codTax';
import { getRequiredCheckoutPolicies, preparePolicyAcceptance, isPolicyAcceptanceConflict } from '../lib/policyOps';
import { cartShippingType, typeForTransport, SHIPPING_TYPE_LABELS } from '../lib/shippingType';
import { initOrderStage, orderEndsAtTheDoor, stagePath, stageRowFrom } from '../lib/orderStageOps';
import { stageLabel, stagesFor, stageForLegacyStatus } from '../lib/orderStages';
import type { OrderStage } from '../lib/orderStages';
import { coverageState, maskSerial } from '../lib/deviceOps';
import type { ShippingType } from '../lib/shippingType';
import type { PolicyRef } from '../lib/policyOps';
import { createInvoiceForOrder } from '../lib/invoices';
import { announceAfterResponse, orderAnnouncement, orderTopic } from '../lib/adminTopicRouting';
import { notifyOrderPlaced } from '../lib/orderNotify';

export const orderRoutes = new Hono<AppContext>();
orderRoutes.use('*', requireAuth);

/**
 * THE CEIL THAT USED TO LIVE HERE IS GONE, AND THIS IS WHERE IT WENT.
 *
 * `function iqdToUsdCents(iqd, rate) { return Math.ceil((iqd * 100) / rate); }`
 * — «rounded up so the wallet never undercharges» — had exactly two callers,
 * both of them the wallet's share of a checkout. It is the SECOND door that
 * refused the customer in «الرصيد غير كافي»: a wallet credited by the owner's
 * floor holds 3,571 cents for a typed 50,000 د.ع, and applying 50,000 د.ع
 * through the ceil asked for 3,572 — one cent more than the same 50,000 د.ع
 * put in. Raising the reported balance alone would have moved the refusal from
 * one line to the next and downgraded its message from the explicit Arabic
 * printer sentence to a bare English one.
 *
 * The rule it expressed is NOT abandoned: a RESERVATION must never under-hold
 * the debt it guarantees, and worker/lib/escrowOps.ts still ceils for every
 * hold. A wallet application is not a reservation. It spends in the unit the
 * wallet is denominated in, at the same floor the credit used, and records the
 * dinars on the debit (migration 0108) so the balance falls by the figure the
 * customer was shown. That conversion is `walletSpendCents`
 * (worker/lib/walletOps.ts), shared now with the community store checkout and
 * the membership purchase so the three cannot disagree about whether a wallet
 * covers a dinar price.
 */

/**
 * The id as ANALYTICS sees it — and the enum swallows anything it has no
 * name for. This used to fall through to 'wallet' for every id that was
 * neither BNPL nor cash, so a Gini order would have been published as a
 * wallet purchase: a payment method that moved no Levo money at all counted
 * as the one that moves nothing but. The contract enum
 * (packages/contracts/src/events/common.ts) carries 'gini' now, and this
 * tests for it before the fallback rather than after.
 */
const eventPaymentMethod = (id: string): 'wallet' | 'cash' | 'bnpl' | 'gini' =>
  isBnpl(id) ? 'bnpl' : isGini(id) ? 'gini' : isCod(id) ? 'cash' : 'wallet';

/**
 * §5 unified financial snapshot: ONE server-computed money view every cart,
 * checkout, order-detail, admin-prep and invoice screen reads — no screen
 * recomputes totals on its own.
 *
 * Honesty rules encoded here:
 *  - merchandise is separated from fees; shipping/transport/warranty never
 *    earn points and are never covered by them.
 *  - the wallet is a PAYMENT MEANS, not a discount: wallet_applied never
 *    reduces the merchandise price, it settles part of the total.
 *  - a COD balance is never "paid" at creation. payment_state is derived from
 *    RECORDED collections when they were loaded, otherwise from what was
 *    actually prepaid — never from the order merely existing.
 *  - the support code is attribution only: it appears with an explicit
 *    zero monetary effect, never as a discount line.
 *
 * `points` and `settlement` require the accrual/settlement snapshot; callers
 * that do not load it (e.g. the admin order list) receive null there rather
 * than a fabricated zero.
 */
function financialSnapshot(
  o: Record<string, unknown>,
  items: Record<string, unknown>[],
  snap?: OrderPointsSnapshot
) {
  const coupon = safeParse<{ discount_iqd?: number } | null>(o.coupon_snapshot, null);
  const couponDiscount = coupon ? Number(coupon.discount_iqd) || 0 : 0;
  const subtotal = Number(o.subtotal_iqd) || 0;
  // Legacy orders (pre-0014) have no stored merchandise column — recompute it
  // from the per-line pricing snapshots instead of pretending 0 is real.
  const merchandise =
    o.merchandise_iqd === null || o.merchandise_iqd === undefined
      ? eligibleMerchandiseIqd(
          items.map((it) => ({
            qty: Number(it.qty) || 0,
            unit_price_iqd: Number(it.unit_price_iqd) || 0,
            pricing_snapshot: (it.pricing_snapshot as string | null) ?? null,
            warranty_snapshot: (it.warranty_snapshot as string | null) ?? null,
            transport_snapshot: (it.transport_snapshot as string | null) ?? null,
          }))
        )
      : Number(o.merchandise_iqd) || 0;
  const pointsUsed = Number(o.points_discount_iqd) || 0;
  const walletIqd = Number(o.wallet_applied_iqd) || 0;
  const codTax = Number(o.cod_tax_iqd) || 0;
  const total = Number(o.total_iqd) || 0;
  const due = Number(o.due_on_delivery_iqd) || 0;
  const bnplDue = Number(o.bnpl_due_iqd) || 0;
  /**
   * WHAT GINI ALREADY SETTLED, WHICH THIS VIEW WOULD OTHERWISE NEVER SEE.
   *
   * `paid` below is "wallet money, or what the courier actually collected" —
   * and a Gini order has neither for its goods. Gini paid them, outside
   * Levonis, before the order existed. Without this term the order reports
   * its FULL price outstanding for ever: at first only after a collection is
   * recorded (the delivery fee), which is the worst version of the bug,
   * because the number looks right on the order-detail screen until the
   * courier hands the fee in and then jumps to the whole product price.
   *
   * It is READ FROM THE STORED COLUMN, not inferred as `total - due`. The
   * subtraction happens to give the same answer today and stops doing so the
   * first time anything else is collected against the order.
   */
  const giniPaid = Number(o.gini_paid_iqd) || 0;
  const collected = snap ? snap.collected_iqd : null;
  const paid = giniPaid + (collected === null ? walletIqd : collected);
  const outstanding = Math.max(0, total - paid);
  const support = safeParse<Record<string, unknown> | null>(o.support_snapshot, null);

  return {
    // Goods vs fees — the points-eligible basis is merchandise only.
    merchandise_iqd: merchandise,
    fees_iqd: Math.max(0, subtotal - merchandise), // transport commissions + warranty fees
    subtotal_iqd: subtotal,
    coupon_discount_iqd: couponDiscount,
    // 1 point = exactly 1 IQD, applied to merchandise only.
    points_used: pointsUsed,
    points_value_iqd: pointsUsed,
    shipping_iqd: Number(o.shipping_iqd) || 0,
    cod_tax_iqd: codTax,
    delivery_waived: !!o.delivery_waived,
    total_iqd: total,
    // Payment means, with its ledger reference.
    wallet_applied_iqd: walletIqd,
    wallet_tx_id: walletIqd > 0 ? `wtx_ord_${String(o.id)}_usd` : null,
    points_tx_id: pointsUsed > 0 ? `wtx_ord_${String(o.id)}_pts` : null,
    due_on_delivery_iqd: due,
    bnpl_due_iqd: bnplDue,
    /** Settled inside the Gini app — a payment, never a discount. */
    gini_paid_iqd: giniPaid,
    bnpl_due_at: o.bnpl_due_at ?? null,
    collected_iqd: collected,
    outstanding_iqd: bnplDue > 0 ? bnplDue : collected === null ? due : outstanding,
    payment_state:
      bnplDue > 0
        ? 'bnpl_due'
        : outstanding <= 0 && (collected !== null || due <= 0)
          ? 'paid'
          : paid > 0
            ? 'partial'
            : 'cod_due',
    settlement: snap
      ? { collected_iqd: snap.collected_iqd, settled_at: snap.settled_at, fully_settled: snap.settled_at !== null }
      : null,
    // Earned points: pending amount and the date it becomes releasable.
    points: snap
      ? {
          state: snap.state,
          pending: snap.pending,
          released: snap.released,
          available_at: snap.available_at,
          eligible_iqd: snap.eligible_iqd,
          iqd_per_point: snap.iqd_per_point,
          rule_version: snap.rule_version,
          redeemed: snap.redeemed,
          redemption_state: snap.redemption_state,
        }
      : null,
    // Attribution only — explicitly zero money for the buyer (§3.3).
    support: support
      ? { referrer_username: support.referrer_username ?? '', ref: support.ref ?? '', discount_iqd: 0 }
      : null,
  };
}

/**
 * How far along its path an order is, as a fraction the customer's card can
 * draw without holding a copy of the path itself: `index` stages reached out
 * of `total`. A cancelled order (or a stage the path does not know) reports
 * 0 — the card draws nothing rather than a guessed position.
 */
function stageProgress(o: Record<string, unknown>, shippingType: ShippingType): { index: number; total: number } {
  const path = stagesFor(shippingType);
  const status = String(o.status ?? '');
  if (status === 'cancelled') return { index: 0, total: path.length };
  const raw = String(o.stage || '');
  // An order written before 0028 may carry no stage; its legacy status still
  // places it on the path honestly instead of at the start.
  const stage: OrderStage = (path as string[]).includes(raw)
    ? (raw as OrderStage)
    : stageForLegacyStatus(status, shippingType);
  const idx = path.indexOf(stage);
  return { index: idx < 0 ? 0 : idx + 1, total: path.length };
}

/**
 * THE CUSTOMER SEES ONE LINE PER THING THEY BOUGHT (§6.3).
 *
 * A bundle's components are real `order_items` rows — they must be, they are
 * the physical truth the reservation, the return and the warranty clock all key
 * on — but they are never top-level items in a customer payload: four extra
 * 0 IQD rows naming the member products would double the item count, break the
 * "one main item with expandable contents" rule the mandate states, and make
 * `Σ line` on the screen disagree with the order's own subtotal.
 */
export const topLevelItems = (items: Record<string, unknown>[]) =>
  items.filter((it) => !it.bundle_parent_item_id);

/** The parts of one bundle line, nested under it, from the rows already read —
 *  never a second query, and never a second price. */
function bundleBlock(parent: Record<string, unknown>, items: Record<string, unknown>[]) {
  const kids = items.filter((it) => String(it.bundle_parent_item_id ?? '') === String(parent.id));
  if (kids.length === 0) return null;
  const snapshot = safeParse<{ composition?: Record<string, unknown> } | null>(parent.pricing_snapshot, null);
  const composition = snapshot?.composition ?? null;
  // A MYSTERY line has no contents to expand — its spools are the physical
  // truth behind it, not a list the customer chose — so the components array
  // is empty here exactly as it is in the cart (§5.2, §8.2 row 12). What the
  // customer may see about the picks comes from `mysteryProjection` and
  // nothing else.
  if (composition && composition.kind === 'mystery') {
    return {
      kind: 'mystery',
      component_total_iqd: null,
      bundle_price_iqd: composition.bundle_price_iqd ?? null,
      bundle_discount_iqd: null,
      saving_percent: null,
      components: [] as Array<Record<string, unknown>>,
    };
  }
  return {
    kind: composition ? composition.kind : 'bundle',
    component_total_iqd: composition ? composition.component_total_iqd : null,
    bundle_price_iqd: composition ? composition.bundle_price_iqd : null,
    bundle_discount_iqd: composition ? composition.bundle_discount_iqd : null,
    saving_percent: composition ? composition.saving_percent : null,
    components: kids.map((k) => ({
      order_item_id: k.id,
      product_id: k.product_id,
      product_slug: (k.product_slug as string | null | undefined) ?? null,
      name: k.name_snapshot,
      image: k.image_snapshot,
      variant: k.option_snapshot,
      qty: k.qty,
      /** The component's own share of the bundle price — what a return of it
       *  refunds (§6.4). Never a second charge: its `line_total_iqd` is 0. */
      alloc_iqd: k.component_alloc_iqd ?? null,
      value_iqd: k.component_value_iqd ?? null,
    })),
  };
}

/**
 * The reveal inputs one order needs. Absent = no mystery block is emitted at
 * all, which is the safe default: a caller that forgot to load the
 * allocations shows the customer nothing rather than showing them everything.
 */
export interface MysteryView {
  allocations: Map<string, AllocationRow[]>;
  /** The orders whose recorded collections cover their total — the `'paid'`
   *  milestone. A SET, not a boolean: a page of orders holds paid and unpaid
   *  ones together, and one shared flag would reveal the unpaid ones. */
  paid: Set<string>;
  viewer: 'customer' | 'admin';
  lang?: string;
}

// ====================================================== the delivery day

/**
 * WHY THE PICKER IS NOT ON THE SCREEN — one of six sentences, never a
 * disabled control with nothing beside it.
 *
 *   PICKUP               there is no last mile of ours to schedule at all.
 *   PREORDER_NOT_ARRIVED the goods are still in transit; the window opens when
 *                        they reach the LEVO warehouse.
 *   WITH_COURIER         the parcel is already at the courier, and a day
 *                        changed now cannot reach the driver.
 *   FINISHED             delivered or cancelled — there is nothing left to
 *                        schedule.
 *   WINDOW_CLOSED        the frozen ceiling has passed, or this row predates
 *                        the feature and never had a window.
 */
export type DeliveryDateReason =
  | 'PICKUP'
  | 'PREORDER_NOT_ARRIVED'
  | 'WITH_COURIER'
  | 'FINISHED'
  | 'WINDOW_CLOSED';

/** One chip in the picker, with the words already on it. */
interface OfferedDay {
  day: string;
  label: string;
  is_today: boolean;
  is_tomorrow: boolean;
}

/**
 * The days still on offer for an order whose ceiling is ALREADY FROZEN.
 *
 * DELIBERATELY NOT `deliveryWindow()`. That function derives the ceiling from
 * an ANCHOR, which is the question checkout asks once. Asking it again later
 * with today as the anchor is the rolling window migration 0094 exists to
 * prevent: each hop looks legal on its own and the customer walks the order
 * forward for ever in weekly steps. Here the ceiling is a stored fact and
 * only the FLOOR moves, because yesterday cannot be offered however generous
 * the policy is.
 *
 * `policy.enabled` is read LIVE, not off the row: the flag on the order says
 * whether this order could ever have a day, and the policy says whether one is
 * being offered today. An owner switching the picker off closes it for every
 * order at once and switching it back on re-opens the same windows.
 */
function offeredDays(windowEnd: string, todayDay: string, policy: DeliveryDayPolicy, lang: string): OfferedDay[] {
  if (!policy.enabled || !isDay(windowEnd) || !isDay(todayDay)) return [];
  const start = policy.allow_same_day ? todayDay : addDays(todayDay, 1);
  const out: OfferedDay[] = [];
  // Bounded by the policy's own maximum, so a corrupt ceiling cannot become an
  // unbounded loop building a JSON array on a request thread.
  for (let d = start; d && d <= windowEnd && out.length <= MAX_DELIVERY_DAYS; d = addDays(d, 1)) {
    out.push({ day: d, ...dayLabel(d, todayDay, lang) });
  }
  return out;
}

export interface DeliveryDateVerb {
  can_change: boolean;
  /** The day the customer already asked for, or null for "as soon as possible". */
  selected: string | null;
  /** The frozen ceiling, reported even when shut so the screen can name it. */
  window_end: string | null;
  reason: DeliveryDateReason | null;
  days: OfferedDay[];
}

/**
 * THE THIRD VERB ON THE ORDER SCREEN, beside `can_cancel` and `can_review`.
 *
 * THE ORDER OF THE CHECKS IS THE ORDER OF THE SENTENCES. Pickup comes first
 * because it is permanent and true at every stage: a customer collecting from
 * the warehouse must not be told «تم التوصيل» is the reason there is no day
 * picker — there was never going to be one. After that the checks run from the
 * most final fact to the least.
 */
function deliveryDateVerb(
  o: Record<string, unknown>,
  policy: DeliveryDayPolicy,
  nowMs: number,
  lang: string
): DeliveryDateVerb {
  const selected = isDay(o.delivery_due_day) ? String(o.delivery_due_day) : null;
  const window_end = isDay(o.delivery_day_window_end) ? String(o.delivery_day_window_end) : null;
  const shut = (reason: DeliveryDateReason): DeliveryDateVerb => ({
    can_change: false,
    selected,
    window_end,
    reason,
    days: [],
  });

  if (!orderEndsAtTheDoor(o)) return shut('PICKUP');

  const status = String(o.status ?? '');
  const stage = String(o.stage || 'received');
  if (status === 'delivered' || status === 'cancelled' || stage === 'delivered' || stage === 'cancelled') {
    return shut('FINISHED');
  }
  /**
   * THE SHIPMENT IS A HARD BOUNDARY, not a soft one. `DeliveryDriver` exposes
   * `listStatuses`, `createShipment` and `getShipment` — and NO
   * `updateShipment` — so once Al-Waseet holds the parcel a day changed here
   * can never reach the driver. A promise we cannot transmit is not a promise,
   * it is a screen that disagrees with a van.
   */
  if (stage === 'out_for_delivery' || String(o.delivery_remote_id ?? '')) return shut('WITH_COURIER');

  if (Number(o.delivery_day_schedulable) !== 1) {
    // A pre-order earns its window at `at_levo_warehouse` (orderStageOps).
    // Anything else unschedulable is a row from before migration 0094: it has
    // no window and never will, which is the same closed answer by a different
    // name.
    return shut(String(o.shipping_type ?? '').startsWith('preorder_') ? 'PREORDER_NOT_ARRIVED' : 'WINDOW_CLOSED');
  }

  const days = window_end ? offeredDays(window_end, baghdadDay(nowMs), policy, lang) : [];
  if (days.length === 0) return shut('WINDOW_CLOSED');
  return { can_change: true, selected, window_end, reason: null, days };
}

/**
 * THE LAST GUARD BEFORE A DAY IS WRITTEN — the same one on both doors, the
 * checkout and the customer's later change.
 *
 * TWO CHECKS, NOT ONE. `validateDeliveryDay` decides the two facts that hold
 * whatever the policy says (not in the past, not past the frozen ceiling) and
 * names which one failed, so the customer reads a reason instead of "invalid".
 * Membership of `offered` is the other half: it is what enforces
 * `allow_same_day` and the policy's off switch, neither of which the validator
 * is given — its own docstring says so, and says that a caller letting a day
 * through that the offer never contained has skipped the offer.
 */
function refuseUnlessOffered(requested: string, todayDay: string, windowEnd: string, offered: string[]): void {
  switch (validateDeliveryDay({ requested, todayDay, windowEnd })) {
    case 'BAD_FORMAT':
      throw badRequest('The delivery day must be a calendar day, as YYYY-MM-DD.', 'DELIVERY_DAY_INVALID');
    case 'PAST':
      throw badRequest('That delivery day has already passed.', 'DELIVERY_DAY_PAST');
    case 'BEYOND_WINDOW':
      throw badRequest(
        'That delivery day is past the latest this order can be scheduled for.',
        'DELIVERY_DAY_BEYOND_WINDOW',
        { window_end: windowEnd }
      );
    case 'ok':
      break;
  }
  if (!offered.includes(requested)) {
    throw badRequest('That delivery day is not on offer for this order.', 'DELIVERY_DAY_NOT_OFFERED', {
      days: offered,
    });
  }
}

/** The four delivery-day columns checkout freezes onto a brand new order. */
interface CheckoutDeliveryDay {
  schedulable: 0 | 1;
  window_end: string | null;
  day: string | null;
  source: string;
}

/**
 * THE THREE FACTS CHECKOUT FREEZES, and the one it refuses.
 *
 * SCHEDULABLE is decided from the METHOD and the SALE, once: a home delivery
 * on a direct sale. A pre-order gets 0 here and earns it later, at
 * `at_levo_warehouse` — the first moment a last-mile day is a real choice
 * rather than a guess about a container (see orderStageOps).
 *
 * THE CEILING IS FROZEN, and that is owner decision (ب): «الأسبوع أقصد به مدة
 * سبعة أيام من تاريخ الطلب». It is the same rule as the benefit snapshot this
 * INSERT already writes — «تغيير الإعدادات غدًا يجب ألا يغيّر طلب الأمس» — and
 * it is also what makes the limit un-gameable: recomputed as "today + 7" it
 * would let a customer roll the order forward for ever in weekly hops, each
 * one looking perfectly legal on its own. A pre-order carries NULL, because
 * there is no honest ceiling to name before the goods are in the country.
 *
 * A DAY IS OPTIONAL AND A REFUSAL IS LOUD. Absent means "as soon as possible"
 * and is the ordinary case. But a day sent for an order that can never have
 * one is not silently dropped: the customer who picked Thursday would be shown
 * a confirmation with no day on it and no explanation anywhere.
 */
function checkoutDeliveryDay(
  comp: Pick<CheckoutComputation, 'delivery' | 'isPickup' | 'deliveryDayPolicy'>,
  shippingType: ShippingType,
  requested: string,
  createdAt: string
): CheckoutDeliveryDay {
  const toTheDoor = !comp.isPickup && deliversToHome(comp.delivery);
  const schedulable = toTheDoor && shippingType === 'direct';
  if (!schedulable) {
    if (requested) {
      throw badRequest(
        'A delivery day cannot be chosen for this order yet.',
        'DELIVERY_DAY_NOT_OFFERED',
        // Named, so the screen says WHICH of the two it is rather than
        // «غير متاح» — the two have opposite answers to "will I ever be able
        // to choose one?".
        { reason: toTheDoor ? 'PREORDER_NOT_ARRIVED' : 'PICKUP' }
      );
    }
    return { schedulable: 0, window_end: null, day: null, source: '' };
  }

  /**
   * `baghdadDayOf(created_at)`, NEVER `created_at.slice(0, 10)`. An order
   * placed at 01:00 Baghdad carries a created_at of 22:00 UTC the PREVIOUS
   * day, and slicing that string anchors the window a day early — selling that
   * customer a six-day week, silently, for the first three hours of every day.
   */
  const anchorDay = baghdadDayOf(createdAt);
  const window = deliveryWindow({ anchorDay, todayDay: anchorDay, policy: comp.deliveryDayPolicy });
  const window_end = window.end || null;

  if (!requested) return { schedulable: 1, window_end, day: null, source: '' };
  refuseUnlessOffered(requested, anchorDay, window.end, window.days);
  return { schedulable: 1, window_end, day: requested, source: 'customer' };
}

export function orderPublic(
  o: Record<string, unknown>,
  items: Record<string, unknown>[],
  snap?: OrderPointsSnapshot,
  mystery?: MysteryView
) {
  const coupon = safeParse<Record<string, unknown> | null>(o.coupon_snapshot, null);
  const shippingType = typeForTransport(
    String(o.shipping_type ?? '').startsWith('preorder_')
      ? String(o.shipping_type).slice('preorder_'.length)
      : ''
  );
  return {
    id: o.id,
    status: o.status,
    /** §1: which of the four journeys this order is on. */
    shipping_type: shippingType,
    /** §2/§3: where the order stands on that journey, and when it moved. */
    stage: String(o.stage || 'received'),
    /** Stages reached out of the path's length — the card's progress hairline. */
    progress: stageProgress(o, shippingType),
    stage_changed_at: o.stage_changed_at || o.updated_at || o.created_at,
    /**
     * The next stage and when it is expected — but ONLY when the clock owns
     * it. A stage waiting on an admin or on the courier carries no time, and
     * showing the customer a date we cannot keep would be worse than showing
     * none. The tracking numbers stay off this payload entirely; a customer
     * gets the stage, not the courier's internal ids.
     */
    next_stage: o.next_stage || null,
    next_stage_at: o.next_stage_at ?? null,
    /**
     * THE DELIVERY DAY, and it sits beside `next_stage_at` rather than inside
     * it. The two are deliberately different columns: `next_stage_at` is the
     * cron's alarm clock, which `sweepDueStages` selects on and then PROMOTES
     * the order by. A customer postponing 18-9 to 23-9 would, if the day lived
     * there, stop their own order being PREPARED for five days and receive it
     * unpacked. The day the box goes out and the clock that walks an order
     * through its stages are different facts (migration 0094).
     *
     * `null` means no day has been named — never "today", and nothing may
     * COALESCE it to one.
     */
    delivery_due_day: o.delivery_due_day ?? null,
    /** The frozen ceiling — «سبعة أيام من تاريخ الطلب» — never recomputed. */
    delivery_day_window_end: o.delivery_day_window_end ?? null,
    /** Could this order EVER have a day? A method fact, decided once. */
    delivery_day_schedulable: Number(o.delivery_day_schedulable) === 1,
    tracking_no: o.delivery_tracking_no || null,
    /**
     * A membership gift that ships WITH this order — today only «PRO + طلب
     * مسبق مدفوع مقدمًا = فلمنت هدية». It is worth 0 IQD on every total: the
     * customer paid the same price and a spool comes in the box, so it appears
     * beside the order rather than inside its arithmetic. Frozen at purchase,
     * so a membership that lapses later cannot take it back.
     */
    membership_gift: safeParse<Record<string, unknown> | null>(o.membership_gift, null),
    address: safeParse(o.address_snapshot, {}),
    delivery_method: safeParse(o.delivery_method_snapshot, {}),
    payment_method_id: o.payment_method_id,
    /**
     * «أقساط عبر تطبيق جني», as the customer's own screen needs to explain it:
     * what the app settled, where the order stands with the bank, and until
     * when it waits. Absent on every other payment method rather than a block
     * of zeroes, so a screen can test for it instead of for a state string.
     *
     * The barcode itself is deliberately NOT here. It is the token that tells
     * Gini the goods were handed over, and a customer's order payload is the
     * wrong place to publish it — staff scan it from the parcel, not from the
     * account page.
     */
    gini:
      String(o.payment_method_id ?? '') === 'gini'
        ? {
            order_no: String(o.gini_order_no ?? ''),
            state: giniStateOf(o.gini_state),
            paid_iqd: Number(o.gini_paid_iqd) || 0,
            hold_until: o.gini_hold_until ?? null,
            received_at: o.gini_received_at ?? null,
          }
        : null,
    subtotal_iqd: o.subtotal_iqd,
    shipping_iqd: o.shipping_iqd,
    cod_tax_iqd: Number(o.cod_tax_iqd) || 0,
    delivery_waived: !!o.delivery_waived,
    membership_tier_snapshot: o.membership_tier_snapshot ?? 'free',
    priority: Number(o.priority) || 0,
    fulfillment_service: o.fulfillment_service || 'standard',
    priority_due_at: o.priority_due_at ?? null,
    bnpl_due_iqd: Number(o.bnpl_due_iqd) || 0,
    bnpl_due_at: o.bnpl_due_at ?? null,
    coupon, // {coupon_id, code, discount_iqd} — never includes cost data
    coupon_discount_iqd: coupon ? Number(coupon.discount_iqd) || 0 : 0,
    points_discount_iqd: o.points_discount_iqd,
    wallet_applied_iqd: o.wallet_applied_iqd,
    total_iqd: o.total_iqd,
    due_on_delivery_iqd: o.due_on_delivery_iqd,
    delivered_at: o.delivered_at ?? null,
    created_at: o.created_at,
    updated_at: o.updated_at,
    /** §5: the single money view — every screen reads this, none recomputes. */
    financial: financialSnapshot(o, items, snap),
    items: topLevelItems(items).map((it) => {
      const transport = safeParse<{ method?: unknown } | null>(it.transport_snapshot, null);
      const warranty = safeParse<{ plan_id?: unknown } | null>(it.warranty_snapshot, null);
      const bundle = bundleBlock(it, items);
      // EVERY MYSTERY ROW LEAVES THROUGH ONE PROJECTION (§8.2), rather than
      // relying on the NULL `product_id` to do the work. The allocations hang
      // off the SPOOL rows, so they are gathered under the parent the customer
      // actually sees.
      const allocs = mystery
        ? items
            .filter((k) => String(k.bundle_parent_item_id ?? '') === String(it.id))
            .flatMap((k) => mystery.allocations.get(String(k.id)) ?? [])
        : [];
      const mysteryBlock = allocs.length
        ? mysteryProjection(
            allocs,
            {
              order: { stage: String(o.stage || 'received'), status: String(o.status ?? ''), shipping_type: shippingType },
              paid: mystery!.paid.has(String(o.id)),
              lang: mystery!.lang,
            },
            mystery!.viewer
          )
        : null;
      return {
        id: it.id,
        ...(bundle ? { bundle } : {}),
        ...(mysteryBlock ? { mystery: mysteryBlock } : {}),
        product_id: it.product_id,
        /** Present when the items were loaded with the products join (the
         *  customer routes); the storefront links to /product/:slug with it. */
        product_slug: (it.product_slug as string | null | undefined) ?? null,
        /**
         * Printer or not, from the owner's catalog flag (ORDER_ITEMS_SELECT
         * computes it). Present ONLY when the loader asked: a caller that
         * selected the bare row gets no field rather than an assumed `false`,
         * because the customer's screen shows the home-delivery note off it.
         */
        ...(it.is_printer === undefined || it.is_printer === null
          ? {}
          : {
              // A bundle's PARENT row is never in a printer catalog itself —
              // its components are — so the flag is carried up from them, or
              // the printer delivery note goes silent the moment a printer is
              // sold inside a bundle (§6.3).
              is_printer:
                !!Number(it.is_printer) ||
                items.some(
                  (k) => String(k.bundle_parent_item_id ?? '') === String(it.id) && !!Number(k.is_printer)
                ),
            }),
        name: it.name_snapshot,
        image: it.image_snapshot,
        variant: it.option_snapshot,
        qty: it.qty,
        unit_price_iqd: it.unit_price_iqd,
        line_total_iqd: it.line_total_iqd,
        // Resolver snapshots persisted at checkout time (cost fields stripped
        // before persistence — safe for the buyer to see).
        pricing: safeParse(it.pricing_snapshot, null),
        warranty: safeParse(it.warranty_snapshot, null),
        transport: safeParse(it.transport_snapshot, null),
        /**
         * The exact selection that was bought, in the shape POST /api/cart/items
         * accepts — so "buy again" repeats THIS line instead of the product's
         * default. Legacy items (pre-0008) carry empty ids and only the
         * display label; the cart then asks for a choice as it always has.
         */
        selection: {
          option_id: String(it.option_id ?? ''),
          option_value_ids: safeParse<unknown[]>(String(it.option_value_ids ?? '[]'), []).filter(
            (x): x is string => typeof x === 'string' && x.length > 0
          ),
          color_id: String(it.color_id ?? ''),
          transport_method:
            transport && (transport.method === 'air' || transport.method === 'sea' || transport.method === 'land')
              ? transport.method
              : '',
          warranty_plan_id: warranty && typeof warranty.plan_id === 'string' ? warranty.plan_id : '',
        },
      };
    }),
  };
}

/**
 * THE REVEAL INPUTS FOR A SET OF ORDERS — two queries for a whole page, never
 * one per order.
 *
 * Every route that serializes an order goes through this, so no screen can
 * accidentally omit the projection and show a mystery line as a nameless
 * zero-price row for ever. An order with no allocation costs one indexed read
 * and nothing else.
 */
/**
 * Refuses the customer's own cancellation once a mystery pick on the order has
 * been revealed. Admin cancellation is untouched: an admin cancelling a
 * revealed order is a support decision, not a re-roll.
 */
async function refuseRevealedCancel(
  db: D1Database,
  order: Record<string, unknown>,
  items: Record<string, unknown>[]
): Promise<void> {
  const orderId = String(order.id);
  const allocations = await loadAllocations(db, [orderId]);
  if (allocations.size === 0) return;
  const paid = (await paidOrderIds(db, [orderId])).has(orderId);
  const facts = {
    stage: String(order.stage || 'received'),
    status: String(order.status ?? ''),
    shipping_type: typeForTransport(
      String(order.shipping_type ?? '').startsWith('preorder_')
        ? String(order.shipping_type).slice('preorder_'.length)
        : ''
    ),
  };
  void items;
  for (const rows of allocations.values()) {
    for (const a of rows) {
      if (isRevealed(a, facts, paid)) throw mysteryRefusal('MYSTERY_REVEALED_NO_CANCEL');
    }
  }
}

/** The caller's language for a server-rendered stage label — the same
 *  `?lang=` the tracking route already reads, defaulted to Arabic. */
export const langOf = (c: Context<AppContext>): string =>
  ['ar', 'en', 'ckb'].includes(c.req.query('lang') ?? '') ? c.req.query('lang')! : 'ar';

export async function mysteryViewFor(
  db: D1Database,
  orderIds: string[],
  viewer: 'customer' | 'admin' = 'customer',
  lang?: string
): Promise<MysteryView | undefined> {
  const allocations = await loadAllocations(db, orderIds, { withSlug: viewer === 'admin' });
  if (allocations.size === 0) return undefined;
  return { allocations, paid: await paidOrderIds(db, orderIds), viewer, lang };
}

/** Items with the product's current slug beside the frozen snapshot, and
 *  whether the product is a printer (worker/lib/printerIdentity.ts — the
 *  same catalog flag, as one correlated EXISTS instead of a second round trip). */
export const ORDER_ITEMS_SELECT = `SELECT oi.*, p.slug AS product_slug,
            EXISTS (SELECT 1 FROM product_catalogs pc
                      JOIN catalogs c ON c.id = pc.catalog_id AND c.is_printer_catalog = 1
                     WHERE pc.product_id = oi.product_id) AS is_printer
       FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id`;

async function loadOrder(db: D1Database, orderId: string) {
  const order = await db.prepare('SELECT * FROM orders WHERE id = ?').bind(orderId).first<Record<string, unknown>>();
  if (!order) return null;
  const { results: items } = await db.prepare(`${ORDER_ITEMS_SELECT} WHERE oi.order_id = ?`).bind(orderId).all();
  return { order, items };
}

/**
 * Units the customer sees: sum of quantities, "8 items" on the card.
 *
 * A bundle counts ONCE, as the thing the customer bought — its component rows
 * are the physical truth behind it, not four more things in the basket, and
 * counting them would make the card say "5 items" for one bundle.
 */
function itemCount(items: Record<string, unknown>[]): number {
  return topLevelItems(items).reduce((n, it) => n + (Number(it.qty) || 0), 0);
}

// -------------------------------------------------- shipping configuration

const DEFAULT_SHIPPING_CONFIG: ShippingConfig = {
  ordinary_iqd: 5000,
  printer_small_iqd: null,
  printer_large_iqd: null,
  pro_threshold_iqd: 75000,
  threshold_basis: 'merchandise_after_coupon',
  pro_waiver_covers: 'all',
  prime_threshold_iqd: 150000,
  prime_waiver_covers: 'ordinary_only',
  carton_threshold_spools: null,
  carton_fee_iqd: null,
  printer_advance_required: true,
  protected_iqd: null,
};

/** Coerces the stored shippingPolicy setting (possibly partial) into a full config. */
export function shippingConfigFrom(raw: unknown): ShippingConfig {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<ShippingConfig>;
  const intOrNull = (v: unknown): number | null =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
  return {
    ordinary_iqd: intOrNull(o.ordinary_iqd) ?? DEFAULT_SHIPPING_CONFIG.ordinary_iqd,
    printer_small_iqd: intOrNull(o.printer_small_iqd),
    printer_large_iqd: intOrNull(o.printer_large_iqd),
    pro_threshold_iqd: intOrNull(o.pro_threshold_iqd) ?? DEFAULT_SHIPPING_CONFIG.pro_threshold_iqd,
    threshold_basis:
      o.threshold_basis === 'merchandise_before_coupon' ? 'merchandise_before_coupon' : 'merchandise_after_coupon',
    pro_waiver_covers: o.pro_waiver_covers === 'ordinary_only' ? 'ordinary_only' : 'all',
    prime_threshold_iqd: intOrNull(o.prime_threshold_iqd) ?? DEFAULT_SHIPPING_CONFIG.prime_threshold_iqd,
    prime_waiver_covers: o.prime_waiver_covers === 'all' ? 'all' : 'ordinary_only',
    carton_threshold_spools: intOrNull(o.carton_threshold_spools),
    carton_fee_iqd: intOrNull(o.carton_fee_iqd),
    printer_advance_required: o.printer_advance_required !== false,
    protected_iqd: intOrNull(o.protected_iqd),
  };
}

/**
 * ONE `order_items` ROW AS THE DATABASE WILL HOLD IT — the reference shape the
 * `OrderCreated` outbox row publishes.
 *
 * It exists so the event and the INSERT cannot drift: a mystery spool's
 * `product_id` is NULL in both, and `item_kind` says why rather than leaving a
 * consumer to guess what a null product means.
 */
function persistedItemRef(l: ComputedLine, all: ComputedLine[]) {
  const kind: 'ordinary' | 'bundle_parent' | 'bundle_component' | 'mystery' = l.mystery_spool
    ? 'mystery'
    : l.bundle_parent_item_id
      ? 'bundle_component'
      : all.some((x) => x.bundle_parent_item_id === l.id)
        ? 'bundle_parent'
        : 'ordinary';
  return {
    order_item_id: l.id,
    product_id: l.mystery_spool ? null : l.product_id,
    qty: l.qty,
    unit_price_iqd: Math.max(0, Math.round(l.unit)),
    is_printer: !!l.is_printer,
    warranty_plan_id: safeParse<{ plan_id?: string } | null>(l.warranty_snapshot, null)?.plan_id ?? null,
    ops_policy_id: null,
    item_kind: kind,
  };
}

/** products.ops_policy facts the shipping engine needs (explicit config only). */
function shippingFactsFrom(opsPolicyRaw: unknown): Pick<ShippingItem, 'size_class' | 'is_spool' | 'delivery'> {
  const o = safeParse<Record<string, unknown>>(
    typeof opsPolicyRaw === 'string' ? opsPolicyRaw : JSON.stringify(opsPolicyRaw ?? {}),
    {}
  );
  const sc = o.size_class;
  return {
    size_class: sc === 'printer_small' || sc === 'printer_large' || sc === 'ordinary' ? sc : null,
    is_spool: o.is_spool === true,
    delivery: readProductDeliveryOptions(o) ?? undefined,
  };
}

/**
 * ONE BUNDLE CART LINE → ONE PRICED PARENT AND ITS COMPONENT LINES (§5.3, §6.2).
 *
 * PURE, and deliberately so: `priceLines` runs up to three times per checkout
 * and `computeCheckout` may then swap the whole priced set, so anything that
 * read the database here would draw, price or judge differently between the
 * passes. Everything it needs was resolved once, before `priceLines` existed.
 *
 * THE MONEY SITS ON THE PARENT AND THE COMPONENTS ARE ZERO-PRICED, for three
 * reasons that are each a real defect otherwise:
 *
 *  - `Σ line_total_iqd` still equals `orders.subtotal_iqd`, so
 *    `financialSnapshot`'s legacy recomputation and the invoice totals stay
 *    consistent with no special case;
 *  - `unitMerchandiseIqd` prefers `pricing_snapshot.applied_iqd`, so points
 *    accrue on exactly what was paid — which is why a component's snapshot
 *    `applied_iqd` is pinned to 0 and the parent's to `bundle_price_iqd`;
 *  - device units, warranty coverage, return cases and price-protection claims
 *    all key on `order_items.id`, and the COMPONENT row is the one naming the
 *    real product — so a printer inside a bundle gets its unit and its warranty
 *    clock automatically.
 *
 * THE PARENT'S SNAPSHOT RUNGS ARE PINNED TO THE FIGURES ACTUALLY CHARGED. In a
 * derived price mode `resolveUnitPrice`'s `applied_iqd` comes from the
 * deliberately drift-allowed `products.price_iqd` (§4.3), and everything
 * downstream reads the snapshot rather than the line: the points reversal on a
 * refund, `financialSnapshot`'s legacy path and price protection would all use
 * the stale number.
 */
function priceCompositionLine(
  row: Record<string, unknown>,
  b: ResolvedBundle | undefined,
  printerIds: Set<string>,
  displayName: string,
  /**
   * 0075 — THE COUNTER EACH COMPONENT LINE CONSUMES, resolved by ORDER TYPE in
   * the async pre-pass (`componentCounters`) because this function is pure and
   * runs up to three times. Keyed `<cart_item_id>:<component_id>`, so two lines
   * of the same bundle with different choices are two independent answers and
   * the prepaid and cash-on-delivery passes read the SAME one — a payment
   * method is not an order type and may not re-target a counter.
   */
  counters: ReadonlyMap<string, StockResolution>,
  mystery?: MysteryLineResolution
): { lines: ComputedLine[]; subtotal: number; merchandise: number; shippingItems: ShippingItem[]; physicalLines: number } {
  const qty = Number(row.qty) || 1;
  if (!b) throw badRequest(`"${displayName}" is no longer available — please remove it from your cart`, 'OFFER_INACTIVE');

  // THE DOOR, AGAIN, ON THE STORED ROW — never on a client claim. Everything
  // §6.1 lists: active, the schedule, the tier gate, the price floor, every
  // stored choice still legal, the shipping type, the transport every
  // pre-order component offers, an opted-in optional component, the per-order
  // cap and the composition availability.
  const transportMethod = String(row.transport_method ?? '');
  // A mystery line's door is the pool's, and its transport is the mode's: the
  // components it would otherwise be judged against do not exist.
  if (mystery) refuseMystery(mystery.ctx, displayName);
  refuseComposition(b, qty, displayName, mystery ? {} : { transportMethod });

  const included = includedComponents(b);
  const componentFees = mystery ? 0 : componentFeesIqd(b);
  const bundlePrice = b.pricing.applied_iqd;
  const unit = b.pricing.unit_subtotal_iqd + componentFees;
  const line = unit * qty;
  const parentId = newId('oi');
  const basis: 'direct' | 'preorder' = transportMethod ? 'preorder' : 'direct';

  // The parent's snapshot: the composition block plus the rungs as charged.
  const composition = {
    kind: b.doc.composition,
    bundle_product_id: b.doc.id,
    bundle_name: { ar: b.doc.name_ar, en: b.doc.name_en, ckb: b.doc.name_ckb },
    component_total_iqd: b.pricing.component_total_iqd,
    bundle_price_iqd: bundlePrice,
    bundle_discount_iqd: b.pricing.discount_iqd,
    saving_percent: b.pricing.saving_percent,
    price_mode: b.config.price_mode,
    price_source: b.pricing.source,
    applied_tier: b.pricing.applied_tier,
    transport: {
      method: transportMethod,
      component_commission_iqd: componentFees,
      direct_surcharge_iqd: Math.max(0, b.pricing.unit_subtotal_iqd - bundlePrice),
      components: componentFeeBreakdown(b),
    },
    offer: b.window
      ? {
          offer_id: b.window.id,
          subject_type: 'product',
          subject_id: b.doc.id,
          required_tiers: b.offer.required_tiers,
          starts_at: b.window.starts_at,
          ends_at: b.window.ends_at,
          price_source: b.pricing.source,
          offer_price_mode: b.window.offer_price_mode,
          offer_discount_percent: b.window.discount_percent,
          offer_applied_iqd: bundlePrice,
        }
      : null,
    items: [] as Array<Record<string, unknown>>,
    /**
     * THE MYSTERY BLOCK ON THE PARENT'S SNAPSHOT — customer-safe by
     * construction. `items` above stays EMPTY for a mystery line: the parent's
     * whole `pricing_snapshot` is serialized into `orderPublic`'s `pricing`
     * field, so a single drawn product id written here would defeat every
     * milestone at once. The pick lives in `mystery_allocations` and reaches
     * the customer only through `mysteryProjection`.
     */
    mystery: mystery
      ? {
          spools: mystery.draw.spools.length,
          spool_qty: mystery.ctx.spool_qty,
          mode: mystery.draw.mode,
          reveal_stage: mystery.draw.reveal_stage,
          family_id: mystery.ctx.family_id,
        }
      : null,
  };

  // LARGEST-REMAINDER allocation of the PARENT's line total across the
  // components in proportion to their standalone line values, so
  // `Σ component_alloc_iqd === line_total_iqd` EXACTLY with no rounding left
  // over. It is stored, never re-derived, and it is what a return refunds.
  //
  // FOR A MYSTERY LINE the shares are UNIFORM and OFFER-DERIVED: every spool
  // is worth the same fraction of what the customer paid, and the drawn
  // item's own ladder appears nowhere (§6.2, §8.2 row 19). Pricing a spool at
  // the filament's standalone value would publish its price before the
  // reveal — a number an attacker reads straight off the invoice.
  const spools = mystery ? mystery.draw.spools : [];
  const values = mystery
    ? spools.map(() => 1)
    : included.map((k) => Math.max(0, k.unit.applied_iqd) * k.qty_per_bundle * qty);
  const allocs = allocateComponentValue(line, values);

  const lines: ComputedLine[] = [];
  const shippingItems: ShippingItem[] = [];
  spools.forEach((sp, i) => {
    const cand = sp.candidate;
    const childId = newId('oi');
    lines.push({
      cart_item_id: String(row.cart_item_id),
      id: childId,
      // The REAL drawn product: `planInventory` reserves against it and
      // `inventory_ledger.product_id` must name it. Only the order_items
      // INSERT binds NULL in its place (§7.7).
      product_id: cand.product_id,
      option_value_ids: [],
      /**
       * THE COUNTER THIS SPOOL SPENDS, picked by the POOL'S order type and
       * nothing else (0075, DECISION 4). `loadCandidates` resolves it through
       * `resolveForOrderType` + `capacityFrom`, so these are the drawn
       * member's SHELF rows in a direct pool and its (model x pre-order)
       * capacity — or the chosen route's own quota — in a pre-order one. They
       * used to be the shelf either way, which made a pre-order mystery take a
       * unit from under the direct buyer racing it while the import quota it
       * was really spending went uncounted.
       */
      stock_targets: cand.targets,
      // The OFFER's title and cover, never the filament's — the invoice, the
      // receipt, the courier payload and every e-mail read this field.
      name: b.doc.name_en || b.doc.name_ar || b.doc.id,
      name_ar: b.doc.name_ar,
      image: productImageForSelection(b.doc, { optionValueIds: [], colorId: null }, b.view),
      variant: '',
      option_id: '',
      color_id: '',
      shipping_method_id: '',
      qty: 1,
      unit: 0,
      line: 0,
      applied_iqd: 0,
      tracked: cand.available !== null,
      // NULL, not a redacted object: a snapshot that exists is a snapshot a
      // future reader fills in.
      pricing_snapshot: null as unknown as string,
      warranty_snapshot: null,
      transport_snapshot: null,
      breakdown: {
        applied_iqd: 0,
        applied_tier: 'regular',
        regular_iqd: 0,
        prime_iqd: null,
        pro_iqd: null,
        transport: null,
        direct: null,
        pricing_basis: basis,
        warranty: null,
        unit_subtotal_iqd: 0,
        price_source: 'offer',
        errors: [],
      } as unknown as ReturnType<typeof publicBreakdown>,
      is_printer: printerIds.has(cand.product_id),
      pricing_basis: basis,
      bundle_parent_item_id: parentId,
      bundle_component_id: '',
      component_value_iqd: allocs[i] ?? 0,
      component_alloc_iqd: allocs[i] ?? 0,
      mystery_spool: {
        spool_index: sp.spool_index,
        pool_id: mystery!.draw.pool_id,
        pool_entry_id: cand.entry_id,
        sale_mode: mystery!.draw.mode,
        seed: mystery!.draw.seed,
        reveal_stage_snapshot: mystery!.draw.reveal_stage,
        candidates_sha256: mystery!.draw.candidates_sha256,
        name_snapshot: cand.name_snapshot,
        image_snapshot: cand.image_snapshot,
        variant_snapshot: cand.variant_snapshot,
        option_value_ids: cand.option_value_ids,
        color_id: cand.color_id,
      },
      // The order-item columns are internal and never enter quoteLines or
      // orderPublic. Freeze the drawn candidate's exact option/colour/active
      // variant facts here so fulfilment does not fall back to the offer's
      // generic carton after the catalogue changes.
      physical_dimensions: cand.physical_dimensions ?? EMPTY_PHYSICAL_DIMENSIONS(),
    });
    /**
     * A MYSTERY SPOOL SHIPS ON THE OFFER'S OWN FACTS, NOT THE PICK'S (§8.2).
     *
     * Feeding the DRAWN candidate's `ops_policy` into the shipping engine put
     * the pick's size class into `quote.shipping.components[].kind`, which is
     * published on `POST /api/orders/quote` and then frozen into
     * `delivery_method_snapshot` and served back on `GET /api/orders/:id` from
     * the first second — a customer payload reading `printer_large` for an
     * order whose reveal milestone is 'delivered'. §8.2's table stops at row
     * 20 and never listed the shipping quote, so nothing caught it.
     *
     * Worse, it was a PRE-PURCHASE oracle: the same block is on the quote,
     * which draws but writes nothing, so a caller could grind quotes and read
     * a partition of the candidate set off the fee alone. Redacting only the
     * breakdown would leave that half open, because the FEE is the oracle.
     *
     * So the offer row's own `ops_policy` decides — one fact for every spool of
     * that offer, whatever is drawn. A mystery offer over devices is out of
     * scope (§17 decision 7), so the pools are filament and the offer's own
     * `is_spool` is the honest fact; the owner sets it where they set every
     * other shipping fact.
     */
    const facts = shippingFactsFrom(b.row.ops_policy);
    shippingItems.push({ product_id: String(b.doc.id), qty: 1, ...facts });
  });
  included.forEach((k, i) => {
    const componentQty = k.qty_per_bundle * qty;
    /**
     * A COMPONENT LINE RESOLVES ITS COUNTER BY THE SAME RULE A STANDALONE LINE
     * DOES (0075, DECISION 4).
     *
     * `k.resolution` is the composition READ MODEL's answer and it is
     * `resolveStock` — the member's SHELF — whatever the line's order type is.
     * Used as the reservation target it made a pre-order bundle decrement
     * `products.stock`, taking a unit from under the direct buyer racing it,
     * while the import quota it should have spent was never consulted and could
     * be oversold without bound through the bundle door. The pre-pass re-asked
     * the question through `resolveForOrderType` + `capacityFrom`; the read
     * model's answer stays only as the fallback for a member row that vanished
     * between the resolve and here, which `refuseComposition` has already
     * refused as COMPONENT_UNAVAILABLE.
     */
    const counter = counters.get(`${String(row.cart_item_id)}:${k.component_id}`) ?? k.resolution;
    /**
     * THE COST LEAVES THE SNAPSHOT AND GOES ONTO THE ROW (migration 0095).
     *
     * The destructure still STRIPS `cost_iqd` from `snapshot`, and that has not
     * become optional: `pricing_snapshot` is serialized straight back to the
     * buyer by `orderPublic`, so a cost inside it is a cost published to the
     * customer. What changed is where the stripped value goes. It used to be
     * thrown away — and because `order_items` had no cost column either, the
     * cost at the moment of sale was recorded NOWHERE, so profit could only be
     * computed against the product's cost TODAY and editing one supplier price
     * silently rewrote last month's profit.
     *
     * It is now carried to `order_items.cost_iqd`, which no customer-facing
     * serializer selects. THE SAME resolved value, never re-derived from the
     * product: `k.unit` already walked this component's option and colour
     * rungs, and a second walk can disagree with the first.
     *
     * A COMPONENT IS WHERE A BUNDLE'S GOODS ARE, so this is the row that
     * carries the bundle's cost of goods sold. The parent carries none — see
     * `COMPOSED_SNAPSHOT` below.
     */
    const { cost_iqd, ...snapshot } = k.unit;
    const componentCost = costSnapshot(cost_iqd);
    // The component's own resolver output, with `applied_iqd` set to 0 AFTER
    // the cost strip: points accrue on the parent and on the number actually
    // charged, never a second time on an inflated component total.
    const componentSnapshot = { ...snapshot, applied_iqd: 0, unit_subtotal_iqd: 0 };
    lines.push({
      cart_item_id: String(row.cart_item_id),
      id: newId('oi'),
      product_id: k.member_product_id,
      option_value_ids: k.selection.option_value_ids,
      stock_targets: counter.targets,
      name: k.doc.name_en || k.doc.name_ar || k.member_product_id,
      name_ar: k.doc.name_ar,
      image: productImageForSelection(
        k.doc,
        { optionValueIds: k.selection.option_value_ids, colorId: k.selection.color_id },
        k.view
      ),
      variant: componentVariantLabel(k),
      option_id: k.selection.option_value_ids[0] ?? '',
      color_id: k.selection.color_id ?? '',
      shipping_method_id: '',
      qty: componentQty,
      unit: 0,
      line: 0,
      applied_iqd: 0,
      tracked: counter.tracked,
      pricing_snapshot: JSON.stringify(componentSnapshot),
      warranty_snapshot: null,
      transport_snapshot: k.unit.transport ? JSON.stringify(k.unit.transport) : null,
      breakdown: publicBreakdown(k.unit),
      is_printer: printerIds.has(k.member_product_id),
      pricing_basis: basis,
      // ADMIN-ONLY, never serialized to a customer (migration 0095).
      cost_iqd: componentCost.cost_iqd,
      cost_basis: componentCost.cost_basis,
      bundle_parent_item_id: parentId,
      bundle_component_id: k.component_id,
      component_value_iqd: Math.max(0, k.unit.applied_iqd),
      component_alloc_iqd: allocs[i] ?? 0,
      physical_dimensions: resolveSelectionPhysicalDimensions(
        k.doc,
        k.view ?? EMPTY_RELATIONS,
        { optionValueIds: k.selection.option_value_ids, colorId: k.selection.color_id }
      ),
    });
    // The shipping quote reads the COMPONENTS' own facts, so a bundle holding
    // a printer reaches the printer freight branch and twelve spools reach the
    // carton threshold inside the existing `quoteShipping` — a bundle judged on
    // its own (empty) ops_policy would be quoted as one ordinary parcel.
    const facts = shippingFactsFrom(k.doc.ops_policy);
    shippingItems.push({
      product_id: k.member_product_id,
      qty: componentQty,
      ...facts,
    });
    composition.items.push({
      order_item_id: lines[lines.length - 1].id,
      component_id: k.component_id,
      product_id: k.member_product_id,
      name: k.doc.name_en || k.doc.name_ar || k.member_product_id,
      variant: componentVariantLabel(k),
      option_value_ids: k.selection.option_value_ids,
      color_id: k.selection.color_id ?? '',
      qty: componentQty,
      value_iqd: Math.max(0, k.unit.applied_iqd),
      alloc_iqd: allocs[i] ?? 0,
      // The component's `order_items.id` is ALSO the ledger `line_id` inside
      // `inventory_ledger.idempotency_key` — the inventory reservation
      // reference, with no new column and provably the same value the ledger
      // holds.
      reservation_line_id: lines[lines.length - 1].id,
      optional: k.optional,
    });
  });

  /**
   * THE PARENT RECORDS NO COST, AND THAT IS A DECISION, NOT AN OMISSION.
   *
   * The strip itself is unchanged and stays for the same reason as everywhere
   * else: `pricing_snapshot` is served back to the buyer.
   *
   * What is NOT carried onto the row is the bundle product's own `cost_iqd`,
   * even when the owner typed one. A bundle's goods are its COMPONENTS, and
   * each component is a separate `order_items` row in this same order already
   * carrying its own snapshotted cost. Recording a cost here as well would
   * count the same physical goods twice, and a gross margin that
   * double-subtracts is not merely wrong — it is wrong in the direction that
   * makes a profitable bundle look like a loss, which is the number that makes
   * an owner stop selling it.
   *
   * `COMPOSED_SNAPSHOT` says exactly that on the row, so the dashboard reads
   * "zero COGS by construction" rather than "cost unknown" and never estimates
   * a parent against the catalogue.
   */
  const { cost_iqd, ...bundleSnapshot } = b.pricing.resolved;
  void cost_iqd;
  const parent: ComputedLine = {
    cart_item_id: String(row.cart_item_id),
    id: parentId,
    product_id: b.doc.id,
    option_value_ids: [],
    // The bundle row itself is untracked and holds nothing: the components
    // carry every stock target, and this empty array is what keeps the parent
    // out of the `stockMoves` map with no filter of its own.
    stock_targets: [],
    name: b.doc.name_en || b.doc.name_ar || b.doc.id,
    name_ar: b.doc.name_ar,
    image: productImageForSelection(b.doc, { optionValueIds: [], colorId: null }, b.view),
    variant: compositionOptionSnapshot(b),
    /** The `bx_…` composition key, kept as provenance. Nothing derives a
     *  selection from it, and price protection refuses a parent claim by name
     *  rather than comparing it against a `price_history.variant_key` it can
     *  never match (§6.4). */
    option_id: String(row.option_id ?? ''),
    color_id: '',
    shipping_method_id: '',
    qty,
    unit,
    line,
    applied_iqd: bundlePrice,
    tracked: false,
    pricing_snapshot: JSON.stringify({
      ...bundleSnapshot,
      applied_iqd: bundlePrice,
      regular_iqd: b.pricing.regular_iqd,
      prime_iqd: b.pricing.prime_iqd,
      pro_iqd: b.pricing.pro_iqd,
      unit_subtotal_iqd: unit,
      applied_tier: b.pricing.applied_tier === 'plus' ? 'regular' : b.pricing.applied_tier,
      composition,
    }),
    warranty_snapshot: null,
    transport_snapshot:
      transportMethod || componentFees > 0
        ? JSON.stringify({
            method: transportMethod,
            commission_iqd: componentFees,
            waived: false,
            source: 'components',
            components: componentFeeBreakdown(b),
          })
        : null,
    breakdown: {
      ...publicBreakdown(b.pricing.resolved),
      applied_iqd: bundlePrice,
      // `ResolvedPrice.applied_tier` is a SHARED type and is deliberately not
      // widened to carry PLUS (§4.4): the four-value tier lives on the
      // composition block and on the `display_*` projection only. A PLUS
      // member is charged the PLUS number here — `applied_iqd` above — and the
      // composition block is where that rung is named.
      applied_tier: b.pricing.applied_tier === 'plus' ? 'regular' : b.pricing.applied_tier,
      regular_iqd: b.pricing.regular_iqd,
      prime_iqd: b.pricing.prime_iqd,
      pro_iqd: b.pricing.pro_iqd,
      unit_subtotal_iqd: unit,
    },
    // A bundle holding a printer must still fire the checkout's printer
    // delivery note, and the note reads the PARENT line the customer sees.
    is_printer:
      included.some((k) => printerIds.has(k.member_product_id)) ||
      spools.some((sp) => printerIds.has(sp.candidate.product_id)),
    pricing_basis: basis,
    // Zero cost of goods sold BY CONSTRUCTION — the goods are the component
    // rows. See the strip site above.
    cost_iqd: COMPOSED_SNAPSHOT.cost_iqd,
    cost_basis: COMPOSED_SNAPSHOT.cost_basis,
    bundle_parent_item_id: null,
    bundle_component_id: null,
    component_value_iqd: null,
    component_alloc_iqd: null,
    mystery_spool: null,
    /**
     * THE DISCLOSURE'S OWN TWO FIGURES, ON THE LINE THAT CARRIES THE MONEY.
     *
     * `quoteLines` emitted `included[]` with per-part values but neither the
     * struck component total nor the saving percentage, so the checkout fell
     * back to the CART line for both — and on a pre-order bundle the quote
     * re-prices for cash on delivery, which put a cart-basis "bought
     * separately" figure and a cart-basis "Save X%" badge beside a quote-basis
     * line total. That is the "two different orders on one screen" the file's
     * own comment at `src/pages/Checkout.tsx` forbids.
     */
    composition_total_iqd: b.pricing.component_total_iqd,
    composition_saving_percent: b.pricing.saving_percent,
    // The parent is a commercial grouping, not a second physical parcel. Its
    // component rows below carry the resolved cartons that actually ship.
    physical_dimensions: EMPTY_PHYSICAL_DIMENSIONS(),
  };

  return {
    lines: [parent, ...lines],
    subtotal: line,
    // MERCHANDISE IS THE BUNDLE PRICE AND NOTHING ELSE. The components'
    // commissions and surcharges are real money and ride on the parent's
    // `unit_subtotal_iqd`, but merchandise never includes a fee — the points
    // basis, the coupon minimum and the accrual all read it.
    merchandise: bundlePrice * qty,
    shippingItems,
    // THE CONTRACT'S OWN FORMULA (§3.1): `Σ over lines of (components or
    // spools) × qty`. A bundle writes one `order_items` row per component
    // whatever its quantity, so this is deliberately CONSERVATIVE for a
    // bundle and exact for a mystery line, where each spool is its own row —
    // one ceiling, judged the same way at add-to-cart and at the door, rather
    // than two that can disagree about the same cart.
    // A mystery line's spool rows are already one per (spool × qty), so they
    // are counted once; a bundle writes one row per component whatever its
    // quantity, so the multiplication there is deliberately conservative.
    physicalLines: mystery ? lines.length : lines.length * qty,
  };
}

/**
 * AGGREGATED DEMAND PER STOCK ROW, ACROSS EVERY LINE OF THE ORDER (§3.2).
 *
 * Two component lines that resolve to one stock row stay two independent
 * guarded moves — collapsing them would lose the per-`order_item` trail returns
 * depend on — but their demand is summed before it is judged. Judging each move
 * against the full `available` independently would let a bundle needing two of
 * a colour sit beside a bare product needing two more of the same colour with
 * only three in stock: every per-line check passes, `planInventory` rejects
 * nothing, and the guards fail at commit with a permanent `CONFLICT_RETRY` on a
 * cart nobody is racing and no screen can explain.
 */
function refuseAggregateDemand(lines: ComputedLine[], poolMemberIds: ReadonlySet<string>): void {
  const demand = new Map<
    string,
    { needed: number; available: number | null; name: string; coarse: boolean; preorder: boolean }
  >();
  for (const l of lines) {
    for (const t of l.stock_targets) {
      // BASE stock lives on the product row itself, so its scope_id is '' and
      // the product id identifies the row — exactly as `planInventory` resolves
      // it. Keying on the scope alone would merge unrelated rows into one.
      const key = `${t.scope}:${t.scope_id || l.product_id}`;
      const available = t.stock === null ? null : Math.max(0, t.stock - Math.max(0, t.reserved));
      const coarse = poolMemberIds.has(l.product_id);
      const found = demand.get(key);
      if (found) {
        found.needed += l.qty;
        found.coarse = found.coarse || coarse;
      } else
        demand.set(key, {
          needed: l.qty,
          available,
          name: l.name_ar || l.name,
          coarse,
          // 0075: a capacity row is aggregated exactly like a stock row — two
          // lines sharing one pre-order pool sum before they are judged — but
          // it is not a shelf, so the refusal must not call it one.
          preorder: isCapacityScope(t.scope),
        });
    }
  }
  for (const [, d] of demand) {
    if (d.available !== null && d.needed > d.available) {
      if (d.preorder) {
        /**
         * COUNT-FREE FOR A MYSTERY-POOL MEMBER, ON THIS BRANCH TOO (§8.2 row
         * 18). Since 0075 reached the mystery door a PRE-ORDER spool reserves
         * the drawn member's import quota rather than its shelf, so this is
         * the branch a mystery line now lands on — and "Only 1 pre-order
         * place(s) left" would name a candidate's own counter, which is the
         * before-and-after oracle the coarse rule exists to close. The
         * `d.coarse` test below used to guard only the shelf sentences.
         */
        throw badRequest(
          d.coarse
            ? `The pre-order quota for "${d.name}" cannot cover this order`
            : d.available === 0
              ? `The pre-order quota for "${d.name}" is full`
              : `Only ${d.available} pre-order place(s) left for "${d.name}"`,
          'PREORDER_CAPACITY_EXHAUSTED'
        );
      }
      // A MYSTERY-POOL MEMBER'S REFUSAL CARRIES NO COUNT (§8.2 row 18, §15.1
      // rule 9). Naming the number here would let a buyer binary-search the
      // exact free stock of one candidate colour, before and after a mystery
      // purchase, without ever completing an order.
      if (d.coarse) throw badRequest(`"${d.name}" does not have enough stock for this order`, 'OUT_OF_STOCK');
      throw badRequest(`Only ${d.available} of "${d.name}" left in stock`, 'OUT_OF_STOCK');
    }
  }
}

// -------------------------------------------------- shared checkout compute
//
// The approved-default-address check and the PRO purchase context used to
// live here; they are worker/lib/entitlements.ts `pricingTierContext` now, so
// the product page, the cart and this checkout judge PRO with ONE function.

interface CheckoutInput {
  addressId: string;
  deliveryMethodId: string;
  paymentMethodId: string; // '' allowed in quote mode
  itemIds: string[];
  couponCode: string;
  usePoints: boolean;
  useWallet: boolean;
  /** §3.3 support code — attribution only, never a discount. */
  supportRef: string;
  /** The customer asked for protected (boxed) delivery — a paid add-on on top
   *  of the standard tariff, free for an eligible PRO. */
  protectedDelivery: boolean;
  /**
   * «يستطيع اختيار وتغيير يوم التوصيل» — the day the customer would like the
   * box to arrive, as 'YYYY-MM-DD', or '' for "as soon as possible".
   *
   * ABSENT IS LEGAL and is the common case. Checkout already asks for five
   * things; a sixth REQUIRED choice to complete a purchase is a step, not a
   * convenience. An empty value is not "today" and is never coerced to one —
   * the order simply carries no promised day, exactly as every order did
   * before this field existed.
   */
  requestedDeliveryDate: string;
  /**
   * «رقم الطلب في تطبيق جني» — the six digits Gini gave the customer for the
   * purchase they made in the app. '' for every other payment method, and
   * '' is also legal on a QUOTE for a Gini cart: the preview prices the order
   * before the customer has gone to the app, and refusing there would hide
   * the delivery fee that tells them what they will owe at the door.
   */
  giniOrderNo: string;
}

interface ComputedLine {
  cart_item_id: string;
  id: string;
  product_id: string;
  name: string;
  name_ar: string;
  image: string;
  variant: string;
  option_id: string;
  /** §7 full multi-group selection, stored on the order item. */
  option_value_ids: string[];
  color_id: string;
  shipping_method_id: string;
  qty: number;
  unit: number;
  line: number;
  applied_iqd: number;
  tracked: boolean;
  /** The authoritative stock rows this line consumes (worker/lib/inventory.ts).
   *  Empty when the line is untracked. */
  stock_targets: StockTarget[];
  pricing_snapshot: string;
  warranty_snapshot: string | null;
  transport_snapshot: string | null;
  breakdown: ReturnType<typeof publicBreakdown>;
  /** catalogs.is_printer_catalog — drives the home-delivery NOTE, never a fee. */
  is_printer: boolean;
  /** Which availability fee priced this line (worker/lib/pricing.ts). */
  pricing_basis: 'direct' | 'preorder';
  /** Immutable physical facts resolved for this exact selection. */
  physical_dimensions: PhysicalDimensions;
  /**
   * THE COST OF GOODS SOLD FOR THIS LINE, FROZEN (migration 0095) — and the
   * one field on this interface that must never reach a customer.
   *
   * It is the value the three `const { cost_iqd, ... }` strips above pull out
   * of the resolver output, carried here instead of discarded. Before 0095 it
   * was discarded and `order_items` had no cost column, so profit could only be
   * computed against the product's cost TODAY: editing a supplier price
   * rewrote the reported profit of sales already made and already banked.
   *
   * BOTH FIELDS ARE OPTIONAL, AND THAT IS LOAD-BEARING. A line that sets
   * neither — a mystery-box spool, whose draw carries no cost to snapshot and
   * whose `product_id` is bound NULL on purpose (§7.7) — falls through to the
   * `unrecorded` default at the INSERT, which is the honest answer for it. An
   * optional field cannot silently become a zero cost, which would report a
   * mystery box as pure margin.
   */
  cost_iqd?: number | null;
  /** Whether `cost_iqd` above is a recorded fact, a recorded absence, zero by
   *  construction, or nothing at all. See worker/lib/financeLedger.ts. */
  cost_basis?: CostBasis;
  /**
   * WHAT THE MEMBERSHIP BENEFIT RESOLVER NEEDS FROM THIS LINE (§3).
   *
   * The section and sub-section come from the PRODUCT ROW, never from a cart
   * payload, and `regular_unit_iqd` is the price before any membership — the
   * figure every percentage and ceiling in a rule is computed from.
   *
   * Absent on a composition parent and on its components: a bundle's price is
   * already a composed discount over its parts, and those parts were resolved
   * with this member's own rule inside them (`resolveCartBundles` is handed
   * the same pricing context), so a second rule on the parent would be the
   * double discount §17 forbids.
   */
  benefit?: {
    category_id: string | null;
    sub_category_id: string | null;
    regular_unit_iqd: number;
    /** The rule the RESOLVER credited for this line's member price, or null
     *  when a typed price, an offer or nothing set it. See `BenefitLineInput`. */
    applied_rule_id: string | null;
  };
  /** What the membership actually took off this line, frozen onto the order. */
  membership_discount_iqd?: number;
  membership_rule_id?: string | null;
  /**
   * THE FOUR COMPOSITION FIELDS (§1.6, §5.3), and nothing else.
   *
   * A bundle produces one PARENT line carrying the money and no stock targets,
   * and one COMPONENT line per included component carrying the real product,
   * the real stock targets and a price of zero. Everything downstream — the
   * `order_items` INSERT, the `stockMoves` map, `orderPublic`, the quote
   * serializer and the invoice — either reads them or ignores them.
   */
  bundle_parent_item_id?: string | null;
  bundle_component_id?: string | null;
  /** A component's UNDISCOUNTED standalone value, per unit (§6.2). Price
   *  protection reads it as `originalUnit`, which is why it is per unit and
   *  not per line. */
  component_value_iqd?: number | null;
  /** This component's share of the PARENT's `line_total_iqd`, by
   *  largest-remainder allocation, so `Σ alloc === line_total_iqd` exactly.
   *  Stored, never re-derived, and it is what a return refunds (§6.4). */
  component_alloc_iqd?: number | null;
  /** A composition PARENT's struck component total and saving percentage, on
   *  the same line and the same basis as `line_total_iqd`, so the checkout's
   *  disclosure never mixes a cart-basis figure with a quote-basis one. */
  composition_total_iqd?: number | null;
  composition_saving_percent?: number | null;
  /**
   * A MYSTERY SPOOL (§7.7). `product_id` above carries the REAL drawn product
   * — `planInventory` and the shipping facts need it — and only the
   * `INSERT INTO order_items` binds NULL in its place, which is what makes
   * most of §8.2 structural rather than procedural: the `products` join yields
   * no slug, `GET /api/orders/:id/units` finds nothing, the invoice writes the
   * offer's name and the courier payload says the offer's name, with no
   * filtering code at all. The pick itself lives only in
   * `mystery_allocations`.
   */
  mystery_spool?: {
    spool_index: number;
    pool_id: string;
    pool_entry_id: string;
    sale_mode: string;
    seed: string;
    reveal_stage_snapshot: string;
    candidates_sha256: string;
    name_snapshot: string;
    image_snapshot: string;
    variant_snapshot: string;
    option_value_ids: string[];
    color_id: string;
  } | null;
}

/** What the settlement resolved about this member, carried to the snapshot. */
interface CheckoutBenefits {
  tier: PricingTier;
  tier_active: boolean;
  /** The instant the rules were frozen for this settlement. */
  resolved_at: string;
  lines: ProductBenefits['lines'];
  /** The same rows keyed by ORDER ITEM id, for the per-item snapshot columns. */
  byLine: Map<string, ProductBenefits['lines'][number]>;
  /** The membership's whole saving on merchandise — what the customer is told
   *  they saved (§23). It is the sum of the next two. */
  discount_total_iqd: number;
  /** The part deducted AFTER the subtotal, the way a coupon is. */
  line_discount_iqd: number;
  /** The part already inside `subtotal_iqd`, because `resolveUnitPrice` put it
   *  in the unit prices. Recorded so the stored totals can be reconciled
   *  without re-running the resolver. */
  unit_discount_iqd: number;
  shipping: ShippingBenefit;
  tax: TaxBenefit;
}

interface CheckoutComputation {
  address: Record<string, unknown>;
  delivery: DeliveryMethod;
  payment: CheckoutPaymentMethod | null;
  /** The owner's global shipping rules as this order actually saw them. */
  shippingConfig: ShippingConfig;
  exchangeRate: number;
  tierStatus: TierStatus;
  atApprovedDefault: boolean;
  proContext: boolean; // PRO purchase benefits apply to THIS order
  /** §1: the one journey every line in this cart is on. */
  shippingType: ShippingType;
  /** The payment ids the storefront may offer for this cart (worker/lib/paymentPolicy.ts). */
  allowedPaymentMethods: string[];
  /** Server-computed PRO financing; null means the account is not eligible. */
  bnpl: BnplEligibility | null;
  bnplAmount: number;
  bnplDueAt: string | null;
  /** «خدمه اقساطي على تطبيق جني» — the owner's switch, as this checkout read it. */
  giniEnabled: boolean;
  giniPolicy: GiniPolicy;
  /** Settled inside the Gini app. 0 on every other payment method. */
  giniPaidIqd: number;
  /** The only money a Gini order owes us — the delivery fee, 0 for a pickup. */
  giniDeliveryDueIqd: number;
  /** Actual 12-hour service verdict for this method/address/cart. */
  priorityDelivery: PriorityDeliveryVerdict;
  /** 'direct' when the lines were priced by the direct-sale rule — a direct
   *  cart, or a pre-order cart paid cash on delivery; 'preorder' otherwise. */
  pricingBasis: 'direct' | 'preorder';
  /** Whether choosing cash on delivery changes ANY line's price on this
   *  pre-order cart (a line with a direct premium the customer would pay);
   *  false on a direct cart, and on a pre-order cart whose lines have no
   *  premium or whose customer is exempt from it. The screens explain the
   *  cash rule only when this is true. */
  codReprices: boolean;
  /** How much MORE this cart costs paid cash at the door than prepaid from
   *  the wallet, over the lines only — the number the screens show on the cash
   *  option so the difference is readable BEFORE it is chosen. 0 on a direct
   *  cart, and whenever `codReprices` is false. */
  codSurchargeIqd: number;
  /** A cash order the wallet settled in full: nothing is left to collect at
   *  the door, so it was priced as a PREPAID pre-order (H2) — whatever button
   *  was pressed. payment_method_id stays as sent. */
  prepaidByWallet: boolean;
  /** The printer home-delivery note amount (settings), or null when unset. */
  printerNoteIqd: number | null;
  /** The live delivery-day policy, as this checkout saw it. Its `max_days` is
   *  frozen onto the row as a ceiling and never re-read for this order again. */
  deliveryDayPolicy: DeliveryDayPolicy;
  lines: ComputedLine[];
  /** The composition products in this order — the offer subjects a redemption
   *  row is written for (§1.8). A bundle and a mystery offer share the subject
   *  key `('product', productId)` with an ordinary product, which is what makes
   *  this one promotion model rather than three. */
  compositionSubjects: Set<string>;
  /** The mystery lines this checkout drew, keyed by cart item id. Persisted
   *  only when `allocate` is true — the quote holds the same objects and
   *  writes none of them (§7.4). */
  mysteryLines: Map<string, MysteryLineResolution>;
  /** Whether this computation is allowed to persist its draw. */
  allocate: boolean;
  productIds: string[];
  subtotal: number; // Σ unit_subtotal × qty (incl. commissions/warranty fees)
  merchandise: number; // Σ applied price × qty (product prices only)
  shipping: ShippingQuote;
  /** What each configured delivery method would cost for THIS cart, priced by
   *  the same function that prices the order. `fee_iqd: null` with
   *  `available: false` means the cart cannot use that method at all. */
  deliveryMethodFees: Array<{ id: string; fee_iqd: number | null; available: boolean }>;
  isPickup: boolean;
  independentFreeDelivery: boolean;
  couponId: string | null;
  couponDiscount: number;
  couponSnapshot: string | null;
  pointsBalance: number;
  pointsDiscount: number;
  /** Eligible official-store merchandise AFTER coupon — the redemption cap. */
  eligibleMerchandise: number;
  /** Net eligible base the pending accrual is computed from (§4.2). */
  netEligible: number;
  pointsRule: PointsRule;
  /** Points this order will accrue as PENDING at purchase. */
  pointsEarnPending: number;
  supportSnapshot: { referrer_user_id: string; referrer_username: string; ref: string } | null;
  walletBalanceIqd: number;
  walletApplied: number;
  walletUsdCents: number;
  /** Whether `wallet_transactions` has migration 0108's dinar columns yet. */
  walletLedgerDinars: boolean;
  requiredAdvance: number;
  totalIqd: number; // payable after coupon+points (before wallet)
  dueOnDelivery: number;
  /** Frozen cash-on-delivery tax as CHARGED — after any membership exemption. */
  codTaxIqd: number;
  /** §14: what the existing tax engine calculated BEFORE the membership was
   *  consulted, and what the membership then waived. Both are recorded so a
   *  courier sheet, an invoice and a tax report can be reconciled against an
   *  order whose customer paid no tax. */
  codTaxBeforeExemptionIqd: number;
  codTaxExemptionIqd: number;
  codTaxExemptionRuleId: string | null;
  /** §19: the membership's whole effect on this order, for the snapshot. */
  benefits: CheckoutBenefits;
  policies: PolicyRef[];
  printerGiftConfig: unknown;
  preorderGiftConfig: unknown;
}

/**
 * Options the two doors differ by. `allocate` is `false` for
 * `POST /api/orders/quote` and `true` for `POST /api/orders`: the quote is
 * READ-ONLY and must never draw a mystery allocation or write a row (§7.4).
 * It is an explicit flag rather than an inference from the caller, because
 * "the quote happens not to write anything today" is not a guarantee — a hard
 * one on top of determinism is.
 */
interface CheckoutOptions {
  allocate: boolean;
}

async function computeCheckout(
  c: Context<AppContext>,
  user: SessionUser,
  input: CheckoutInput,
  options: CheckoutOptions = { allocate: false }
): Promise<CheckoutComputation> {
  const address = await c.env.DB.prepare('SELECT * FROM addresses WHERE id = ? AND user_id = ?')
    .bind(input.addressId, user.id)
    .first<Record<string, unknown>>();
  if (!address) throw badRequest('Please choose a valid delivery address');

  const settings = await getSettings(c.env.DB, [
    'checkoutDeliveryMethods',
    'checkoutPaymentMethods',
    'exchangeRate',
    'proPricingPolicy',
    'preorderTransportDefaults',
    'printerGiftConfig',
    'preorderGiftConfig',
    'shippingPolicy',
    'printerHomeDeliveryNoteIqd',
    'bnplPolicy',
    'proPriorityDelivery',
    // THE DOOR CHARGE'S RATE, in the same batch as the fees it is charged on
    // top of. Omitting it here would not fail: `normalizeCodTaxRate` falls
    // back to the compiled default, so the quote would keep working and would
    // quietly ignore whatever the owner had set — a silent wrong number on an
    // invoice, which is the worst shape a bug can take here.
    'codTaxPerBlockIqd',
    'codTaxBlockIqd',
    // Read in the SAME batch as the other eleven: checkout has to freeze the
    // day ceiling onto the row, and a second round trip for one small object
    // would be one more thing between the customer and a placed order.
    'deliveryDayPolicy',
    // Whether «أقساط عبر تطبيق جني» may be offered at all, and how long a
    // Gini order waits for its receipt scan. Read here with the payment
    // methods it gates, so the offered list and the hold frozen onto the row
    // come from one snapshot of the owner's settings.
    'giniPolicy',
  ]);
  const delivery = (settings.checkoutDeliveryMethods as DeliveryMethod[]).find((m) => m.id === input.deliveryMethodId);
  if (!delivery) throw badRequest('Please choose a valid delivery method');
  let payment: CheckoutPaymentMethod | null = null;
  if (input.paymentMethodId) {
    payment = (settings.checkoutPaymentMethods as CheckoutPaymentMethod[]).find((m) => m.id === input.paymentMethodId) ?? null;
    if (!payment) throw badRequest('Please choose a valid payment method');
  }
  const exchangeRate = Number(settings.exchangeRate) || 1400;
  const shippingConfig = shippingConfigFrom(settings.shippingPolicy);

  // Effective tier from the memberships ledger — never the client, never the
  // legacy users.* cache — and the PRO purchase context judged at the address
  // the customer SELECTED (worker/lib/entitlements.ts `pricingTierContext`,
  // the same function the product page and the cart use at the default
  // address): CONFIRMED §6.3, PRO purchase benefits exist only at the single
  // approved default PRO address, and an active restriction case on
  // 'proPricing' / 'noPreorderCommission' pauses the whole pricing context.
  // 'freeDelivery' gates only the shipping waiver below.
  const [{ tierStatus, atApprovedDefault, proContext, pricingTierActive }, benefitRules, benefitAncestry] = await Promise.all([
    pricingTierContext(c.env.DB, user.id, address),
    /**
     * THE CONFIGURED MEMBERSHIP BENEFITS (migration 0074), read ONCE for the
     * whole settlement and frozen onto the order below.
     *
     * Read here, beside the tier, because everything downstream is either
     * synchronous (`priceLines` runs up to three times) or inside the atomic
     * write batch. `activeBenefitRules` returns only enabled rows; whether
     * THIS member earns one is decided per line by the entitlement gate.
     */
    activeBenefitRules(c.env.DB),
    // The section tree, so a rule on "Printers" reaches a product filed under
    // a sub-section of it (`catalogAncestry`).
    catalogAncestry(c.env.DB),
  ]);
  /**
   * The rules the ORDER was priced with, frozen at this instant. Every pass
   * below reads this one context, so the requested-basis pass, the prepaid
   * pass and the cash-on-delivery pass cannot disagree about whether a dated
   * rule was live, and §21's version id recorded on the order names exactly
   * the configuration these figures came from.
   */
  const benefitNowIso = new Date().toISOString();
  const pricingCtx = pricingContextFrom(settings, {
    rules: tierStatus.active ? benefitRules : [],
    status: tierStatus,
    ancestry: benefitAncestry,
    nowIso: benefitNowIso,
  });
  // Load and price the cart lines server-side.
  //
  // THROUGH THE SAME DOOR THE CART READS. This statement names the same
  // `cart_items` columns, so it fails in the same window — and it used to
  // fail ALONE, leaving a customer with a cart that rendered correctly and a
  // checkout that 500'd the moment they opened it. See
  // worker/lib/cartLineProjection.ts for why an absent column is filled with
  // its own migration's DEFAULT rather than degraded away.
  const params: unknown[] = [user.id];
  const filter =
    input.itemIds.length > 0 ? ` AND ci.id IN (${input.itemIds.map(() => '?').join(',')})` : '';
  if (input.itemIds.length > 0) params.push(...input.itemIds);
  const rows = await cartLineSelect(
    c.env.DB,
    (projection) =>
      `SELECT ci.id AS cart_item_id, ci.qty, ${projection}, p.*
         FROM cart_items ci JOIN products p ON p.id = ci.product_id
        WHERE ci.user_id = ?${filter}`,
    params
  );
  if (rows.length === 0) throw badRequest('Your cart is empty');

  // §1: the cart rule guarantees one shipping type across the lines, so the
  // first line speaks for the cart — the same derivation POST / freezes onto
  // the order. It decides which payment methods may be offered, and how a
  // pre-order line is priced once the method is known.
  const shippingType: ShippingType = cartShippingType(rows) ?? 'direct';
  // BNPL is added to the offered ids only after the server resolves an active
  // PRO membership, account approval, KYC, approved address and available
  // credit. A client-supplied `bnpl` id cannot put itself on this list.
  const bnplBase = await bnplEligibility(c.env.DB, user.id, address);
  // «خدمه اقساطي على تطبيق جني» is offered only while the owner has it on.
  // It is not an eligibility question — the bank decides who it finances, and
  // it decides inside its own app, which is why nothing here asks about this
  // customer at all.
  const giniPolicy = settings.giniPolicy as GiniPolicy;
  const giniEnabled = giniPolicy.enabled === true;
  const methodOptions = { bnplEligible: bnplBase.eligible, giniEnabled };
  const allowedMethods = allowedPaymentMethods(shippingType, methodOptions);
  // The owner's rule: pay in advance from the wallet, or cash on delivery.
  // An id the settings still list but the policy does not accept (a
  // half-advance) is refused with the offered list beside the refusal, so
  // the client can repaint its choices instead of guessing. Quote mode with
  // no id yet stays allowed and prices as prepaid.
  if (
    input.paymentMethodId &&
    !isPaymentMethodAllowed(input.paymentMethodId, shippingType, methodOptions)
  ) {
    throw badRequest(
      isBnpl(input.paymentMethodId)
        ? `BNPL is not available for this checkout (${bnplBase.reason ?? 'NOT_ELIGIBLE'}).`
        : 'This payment method is not available for this order — pay in advance from your wallet or choose cash on delivery.',
      isBnpl(input.paymentMethodId) ? bnplBase.reason ?? 'BNPL_NOT_ELIGIBLE' : PAYMENT_METHOD_NOT_ALLOWED,
      { payment_method_id: input.paymentMethodId, allowed_payment_methods: allowedMethods, shipping_type: shippingType }
    );
  }
  /**
   * «رقم الطلب في تطبيق جني — رقم مكون من ٦ ارقام», CHECKED SERVER-SIDE.
   *
   * It is the only handle we have on a purchase Levonis did not process:
   * without it nobody here can find the order in Gini, tell the platform the
   * customer received the goods, or answer a dispute with the bank. The shape
   * is checked in the client's ordered blocker list, here, and again by the
   * CHECK on `orders.gini_order_no` (migration 0103).
   *
   * ONLY AT THE ORDER DOOR. A quote is a preview: it prices, it does not
   * refuse (see the long note inside `settle` on why throwing here once took
   * the whole checkout screen down). A customer who has selected Gini and not
   * yet typed the number gets a correct quote showing the delivery fee, which
   * is exactly the number that helps them decide.
   */
  if (options.allocate && isGini(input.paymentMethodId) && !GINI_ORDER_NO_RE.test(input.giniOrderNo)) {
    throw badRequest(
      'أدخل رقم الطلب في تطبيق جني المكوّن من ٦ أرقام. / Enter the 6-digit Gini order number.',
      'GINI_ORDER_NO_REQUIRED'
    );
  }
  // «If the customer chooses Cash on Delivery, the price must follow the same
  // pricing rules as Direct Sale.» The resolver is told how the customer pays
  // and answers with the right availability fee; the transport method itself
  // is untouched, so the order below is still a pre-order on its journey.
  const requestedPricing = preorderPricingFor(input.paymentMethodId);
  const isPreorderCart = shippingType !== 'direct';

  // One batched read of every product's relational structure. Options,
  // colours and the authoritative stock level all come from here — checkout
  // and the storefront cannot disagree because they read the same rows.
  //
  // THE COMPOSITION PRE-PASS RUNS HERE TOO (§5.3). `priceLines` is a
  // synchronous pure function over already-loaded rows, and that is
  // load-bearing: `computeCheckout` calls it up to THREE times (requested
  // basis, prepaid, cash on delivery) and may then swap the whole priced set.
  // So every database read a bundle line needs — its components, its stored
  // choices, its config, its window and its members' stock — happens once,
  // here, and all three passes then read the same resolution.
  const compositionRows = rows.filter((r) => String(r.composition ?? '') !== '');
  /**
   * SCHEDULED SPECIAL OFFERS ON THE ORDINARY LINES (§9, §12) — read here, in
   * the pre-pass, for the same reason the composition is: `priceLines` is
   * synchronous and runs three times.
   *
   * The window is the same row a bundle uses, on the same subject key, and
   * `applyOfferToResolved` is the same function the card called. That is what
   * makes "the card, the cart and the door quote the offer price" a property
   * of the code rather than of three call sites agreeing by luck.
   */
  const ordinaryRows = rows.filter((r) => String(r.composition ?? '') === '');
  const offerNow = Date.now();
  /**
   * AN OFFER IS OPTIONAL; BEING ABLE TO PAY IS NOT.
   *
   * The cart learned to survive a shop whose optional feature tables are not
   * installed — but the CHECKOUT has its own reads, and a customer who reaches
   * a cart that renders and then cannot pay is worse served than one who was
   * told at the door. An absent `offer_windows` means no offer is running, and
   * a line with no offer prices at its ordinary price, which is exactly what
   * this map answers with when it is empty. It is NOT degraded when the table
   * exists and the query fails for any other reason: that is a real fault and
   * must stay loud rather than quietly dropping a discount the customer was
   * shown in their cart.
   */
  const lineOffers = await degradeIfSchemaMissing(
    'offers (migration 0060)',
    () => loadOffers(c.env.DB, ordinaryRows.map((r) => subjectOf(String(r.id)))),
    new Map<string, Awaited<ReturnType<typeof loadOffers>> extends Map<string, infer V> ? V : never>()
  );
  /** Which ordinary subjects contributed a live offer price or gate to this
   *  order — the subjects a redemption row is written for, so `offer_limits`
   *  works on an ordinary product with no new machinery at all. */
  const offerSubjects = new Set<string>();
  const resolveBundlesFor = (basis: PreorderPricing) =>
    resolveCartBundles(c.env.DB, compositionRows, tierStatus.tier, pricingTierActive, pricingCtx, tierStatus, Date.now(), basis);
  // ONE RESOLUTION PER PRICING BASIS, and the second one only when a pre-order
  // cart could actually be priced the other way. The owner's rule is that a
  // pre-order paid CASH ON DELIVERY follows the direct-sale pricing rules, and
  // for a bundle the money that changes is its COMPONENTS' transport
  // commissions — which ride on the parent (§2.2). Resolving only at the
  // prepaid basis would charge an air-freight commission on an order paying
  // cash at the door, and `cod_reprices` would tell the customer the price was
  // the same either way.
  const bundlesByBasis: Record<PreorderPricing, Map<string, ResolvedBundle>> = {
    prepaid: await resolveBundlesFor('prepaid'),
    cod:
      compositionRows.length && isPreorderCart
        ? await resolveBundlesFor('cod')
        : new Map<string, ResolvedBundle>(),
  };
  const bundles = bundlesByBasis.prepaid;

  /**
   * THE MYSTERY PRE-PASS (§5.3, §7.4), beside the composition one and for the
   * same reason: `priceLines` is synchronous and runs up to three times, so
   * the candidate query, the seed and the DRAW all happen exactly once, here,
   * and every pass — and the quote — sees the same filament.
   *
   * The draw is a pure function of (the offer's server-held secret, the
   * server-written `cart_items.draw_salt`, the candidate list, the weights and
   * the duplicate policy). No value the client chooses is an input, the
   * checkout idempotency key least of all. `allocate` decides whether the
   * result is PERSISTED, never whether it is computed — which is how the
   * quote can price and reserve-check the same spools it will sell while
   * writing nothing (§7.4).
   */
  const mysteryCtxs = await resolveCartMystery(c.env.DB, compositionRows, bundlesByBasis.prepaid, Date.now());
  applyMysteryToBundles(mysteryCtxs, bundlesByBasis.cod);
  const mysteryLines = new Map<string, MysteryLineResolution>();
  for (const row of compositionRows) {
    const key = String(row.cart_item_id);
    const ctx = mysteryCtxs.get(key);
    if (!ctx) continue;
    mysteryLines.set(key, {
      ctx,
      cartItemId: key,
      draw: await drawMysteryLine(c.env.DB, ctx, {
        cartItemId: key,
        drawSalt: String(row.draw_salt ?? ''),
        qty: Number(row.qty) || 1,
        label: String(row.name_ar || row.name),
      }),
    });
  }
  const drawnIds = [...mysteryLines.values()].flatMap((m) => m.draw.spools.map((sp) => sp.candidate.product_id));

  // A bundle's printers are its COMPONENTS' — the parent row is never in a
  // printer catalog itself — so the member ids join the same one query. Without
  // them the checkout's printer delivery note would go silent the moment a
  // printer was sold inside a bundle.
  const memberIds = [...bundles.values()].flatMap((b) => b.components.map((k) => k.member_product_id));
  const [views, printerIds, poolMemberIds, members] = await Promise.all([
    loadRelationsViews(
      c.env.DB,
      rows.map((r) => ({ id: String(r.id), inventory_mode: r.inventory_mode }))
    ),
    // Which lines are printers (catalog flag) — for the home-delivery NOTE on
    // the quote and the order, the printers-only warranty gate, and the
    // printer's 12-month warranty base. One query for the whole cart; never
    // a fee.
    printerProductIds(c.env.DB, [...rows.map((r) => String(r.id)), ...memberIds, ...drawnIds]),
    /**
     * §8.2 ROW 18 AT THE CHECKOUT DOOR.
     *
     * The two stock refusals below quote an exact `available` — "Only 7 of
     * \"X\" left in stock" — and `priceLines` is synchronous, so the pool
     * membership set is resolved here, once, and passed down beside the tier
     * context (§14). Without it a buyer could bump a quantity until the
     * refusal named the count of a candidate's colour row, before and after a
     * mystery purchase, and read the pick off the difference — with the money
     * never leaving their wallet.
     */
    // A shop with no mystery pools installed has no pool members, which is what
    // an empty set says. The §14 leak this guards against needs a pool to leak
    // FROM, so the guard is vacuous — not weakened — when 0061 is absent.
    degradeIfSchemaMissing(
      'mystery pools (migration 0061)',
      () => activePoolProductIds(c.env.DB, [...rows.map((r) => String(r.id)), ...memberIds, ...drawnIds]),
      new Set<string>()
    ),
    /**
     * THE MEMBER PRODUCTS WITH THEIR RELATIONAL OVERLAY — the pre-order cells
     * and route quotas included. The composition read model loads them to
     * PRICE and DESCRIBE the components; the door needs them to answer a
     * different question the read model never asks, so it is asked here where
     * awaiting is still allowed (`priceLines` is synchronous and runs up to
     * three times).
     */
    loadCompositionMembers(c.env.DB, memberIds),
  ]);

  /**
   * 0075 AT THE BUNDLE DOOR — ONE COUNTER PER COMPONENT, PICKED BY ORDER TYPE.
   *
   * `resolveComponentCounter` is `resolveForOrderType` + `capacityFrom`, the
   * same pair a bare product line goes through a few hundred lines below, so
   * the bundle door and the ordinary door cannot aim at different rows for the
   * same product. A direct component keeps its shelf; a pre-order component
   * spends its (model x pre-order) cell, or the chosen route's own quota, and
   * NEVER `products.stock`.
   *
   * Resolved ONCE, from `bundlesByBasis.prepaid`, and shared by both pricing
   * passes: the components, their selections and the line's transport are
   * identical under either basis, and re-resolving per basis would be an
   * invitation to let the payment method change the counter — which it must
   * never do. A member row that failed to load keeps no entry: the read model
   * has already marked that component COMPONENT_UNAVAILABLE and
   * `refuseComposition` refuses the line before any of this is read.
   *
   * These targets then flow into `refuseAggregateDemand` with every other
   * line's, so a bundle and a bare pre-order of the same model SUM against one
   * quota before either is judged, and into `planInventory`, which reserves
   * capacity rows through the same guards and the same UNIQUE idempotency key
   * as a shelf — so the release stays exactly-once with no new lifecycle.
   */
  const componentCounters = new Map<string, StockResolution>();
  for (const cartRow of compositionRows) {
    const cartItemId = String(cartRow.cart_item_id);
    const resolvedBundle = bundles.get(cartItemId);
    if (!resolvedBundle) continue;
    // The ROUTE is the buyer's own, off the bundle's cart row — the column
    // `resolveLineTransport` already proved every pre-order component offers.
    // The read model's per-component `shipping_type` is the FIRST method they
    // share, so reading the route off it would spend air's pool for a bundle
    // the customer put on land.
    const lineTransport = String(cartRow.transport_method ?? '');
    for (const k of includedComponents(resolvedBundle)) {
      const member = members.get(k.member_product_id);
      if (!member) continue;
      componentCounters.set(
        `${cartItemId}:${k.component_id}`,
        resolveComponentCounter(k, memberSnapshot(member), member.view, lineTransport)
      );
    }
  }

  interface PricedLines {
    lines: ComputedLine[];
    subtotal: number;
    merchandise: number;
    productIds: string[];
    shippingItems: ShippingItem[];
    /** One cart, one type, one payment method — so every line shares a basis;
     *  reading it back off the lines keeps this true by construction. */
    pricingBasis: 'direct' | 'preorder';
  }

  /**
   * Prices every cart line for ONE pre-order pricing basis. Pure over the rows
   * already loaded (the resolver, the stock check and the selection guards are
   * all synchronous), so the checkout can price the cart under the requested
   * basis AND under the alternative — to say honestly whether cash on
   * delivery changes the price at all, and to re-price a cash order the
   * wallet settled in full as the prepaid order it actually is.
   */
  const priceLines = (preorderPricing: PreorderPricing): PricedLines => {
    let subtotal = 0;
    let merchandise = 0;
    const productIds: string[] = [];
    const lines: ComputedLine[] = [];
    const shippingItems: ShippingItem[] = [];
    /** Physical `order_items` rows this order would write (§3.1). */
    let physical = 0;
    for (const row of rows) {
      const displayName = String(row.name_ar || row.name);

      // ---- A COMPOSITION LINE (§5.3, §6.1) --------------------------------
      // One PARENT line carrying the money and no stock targets, plus one
      // COMPONENT line per included component carrying the real product, the
      // real stock targets and a price of zero. Nothing is drawn, read or
      // awaited here: the pre-pass above already resolved this line, so all
      // three pricing passes see the same components and the same figures.
      if (String(row.composition ?? '') !== '') {
        const resolvedForBasis =
          preorderPricing === 'cod' && bundlesByBasis.cod.size ? bundlesByBasis.cod : bundlesByBasis.prepaid;
        const priced = priceCompositionLine(
          row,
          resolvedForBasis.get(String(row.cart_item_id)),
          printerIds,
          displayName,
          componentCounters,
          mysteryLines.get(String(row.cart_item_id))
        );
        lines.push(...priced.lines);
        subtotal += priced.subtotal;
        merchandise += priced.merchandise;
        productIds.push(String(row.id));
        shippingItems.push(...priced.shippingItems);
        physical += priced.physicalLines;
        continue;
      }

      if (row.status !== 'active') throw badRequest(`"${displayName}" is no longer available — please remove it from your cart`);
      const view = views.get(String(row.id));
      const sel = selectionFromCartRow(row);
      const isPrinter = printerIds.has(String(row.id));
      // THE DOOR RE-CHECKS THE OFFER, independently of the list and of the
      // cart (§15.1 rule 6). A window that expired, was switched off or gates
      // a tier this buyer does not hold refuses HERE with its own named code
      // — never silently falls back to the ladder price the customer was not
      // shown, and never sells a members-only price to a non-member.
      const offerView = lineOffers.get(offerKey(subjectOf(String(row.id)))) ?? null;
      const offerCheck = offerEligible(tierStatus, offerView, offerNow);
      // AN ORDINARY PRODUCT OUTLIVES ITS PROMOTIONS. A window that has ended,
      // has not started or was switched off contributes no price and no
      // refusal here: the product is still an ordinary catalogue product and
      // an expired promo must not make it permanently unbuyable. What a LIVE
      // window can still do is gate who may take its price, and that refusal
      // is the one this door raises. (A COMPOSITION row is different — there
      // the window IS the offer, and `refuseComposition` refuses it.)
      if (offerView?.window && !offerCheck.ok && offerCheck.reason === 'MEMBERSHIP_REQUIRED') {
        throw new HttpError(403, `"${displayName}" is available to members only`, 'MEMBERSHIP_REQUIRED', {
          required_tiers: offerCheck.required_tiers,
        });
      }
      const { doc, resolved, variantLabel, selectionErrors, offerId } = resolveCartLine(
        row,
        sel,
        tierStatus.tier,
        pricingTierActive,
        pricingCtx,
        view,
        preorderPricing,
        isPrinter,
        { view: offerView, eligible: offerCheck.ok, nowMs: offerNow }
      );
      // A window with LIMITS but no price still needs its redemption row, or
      // `max_per_user` on an ordinary product would never count anything.
      if (offerView?.window && (offerId || offerView.limits)) offerSubjects.add(String(row.id));
      if (offerPriceRefusal(resolved.errors)) {
        throw badRequest(`"${displayName}" is not available right now`, 'OFFER_INACTIVE');
      }
      if (resolved.errors.length > 0) {
        throw badRequest(`"${displayName}": ${resolved.errors.join(', ')}`, 'VALIDATION');
      }
      if (selectionErrors.length > 0) {
        throw badRequest(`"${displayName}": ${selectionErrors.join(', ')}`, 'VALIDATION');
      }
      const qty = Number(row.qty);

      // §7: the ONE authoritative stock level for this exact selection. The
      // base row is not consulted when the product tracks stock elsewhere, so
      // an exhausted colour stops the order even with base stock in hand.
      const snapshot = snapshotFrom(view ?? EMPTY_RELATIONS, {
        stock: doc.stock,
        reserved: Number(row.stock_reserved ?? 0),
        low_stock_threshold: (row.low_stock_threshold as number | null) ?? null,
      });
      /**
       * WHICH COUNTER THIS LINE CONSUMES — DECIDED BY THE ORDER TYPE ALONE
       * (0075, DECISION 4).
       *
       * The stored `fulfillment_type` is the customer's own answer; the
       * transport is only the fallback for a line written before that column
       * existed. `preorderPricing` — which is CASH ON DELIVERY versus PREPAID —
       * is deliberately not consulted here and is not in scope of this
       * expression: a payment method is how the money arrives, not what the
       * order is, and a COD pre-order must consume the pre-order capacity and
       * leave the shelf alone exactly as a prepaid one does. `priceLines` runs
       * twice, once per basis, and both passes resolve the same targets.
       */
      // `lineOrderType` IS this whole chain, and it is the same function
      // `GET /api/cart` types the line with — one rule, one place, so the read
      // model and this door cannot answer about different counters for one row.
      //
      // ITS THIRD STEP — the DEFAULT for a row that states neither a type nor a
      // transport — is the description this door has already computed, which is
      // the one the cart shows. A bare `|| 'direct_sale'` here was the second
      // half of the defect: on a dual-mode model with an empty shelf and an
      // open import quota the cart described a live pre-order counter and this
      // door refused about the shelf. `|| 'direct_sale'` survives only for a
      // row nothing can type (`mode: "unavailable"`), where it is byte for byte
      // what it did before and the line is refused on its counter below anyway.
      const capacity = view ? capacityFrom(view, sel.optionValueIds ?? []) : null;
      // The DESCRIPTION of this exact row, asked with the line's own declared
      // preference — the same inputs `GET /api/cart` asks with.
      const described = saleAvailability(doc, {
        optionValueIds: sel.optionValueIds ?? [],
        colorId: sel.colorId || null,
        qty,
        // §8.2 row 18: the checkout is a customer payload too.
        coarseStock: poolMemberIds.has(String(row.id)),
        transportDefaults: pricingCtx.transportDefaults,
        inventory: snapshot,
        links: view?.links,
        preferredType: sel.fulfillmentType || (sel.transportMethod ? 'pre_order' : null),
        capacity,
        transportMethod: sel.transportMethod,
      });
      const orderType: OrderType = lineOrderType(described, sel.fulfillmentType, sel.transportMethod) || 'direct_sale';
      // The checkout must not trust a cart row written before the cart refused
      // incomplete selections (or one a product acquired options after): a
      // legacy JSON-column line with no option is refused here with the same
      // rule the cart applies, instead of being priced at the base and stored
      // with an empty option_id.
      refuseIncompleteSelection(described, displayName);
      // An extended warranty is a PRINTER's option (owner mandate). The cart
      // already refuses it elsewhere; the checkout re-checks the stored row so
      // a line written before the rule, or a product that left the printer
      // catalog since, cannot buy one at the door. The order is the last
      // moment a plan can be attached — nothing after this writes
      // warranty_snapshot.
      refuseNonPrinterWarranty(isPrinter, sel.warrantyPlanId, displayName);
      // THE ONE COUNTER, and the ONE authority. A direct sale reads the shelf
      // `resolveStock` already returns; a pre-order reads its capacity and
      // never the shelf — so a model that is sold out for direct sale is still
      // pre-orderable, and a pre-order can never eat the units a direct buyer
      // is about to take.
      const stockRes = resolveForOrderType(
        orderType,
        snapshot,
        { option_value_ids: sel.optionValueIds ?? [], color_id: sel.colorId || null },
        capacity,
        sel.transportMethod
      );
      if (stockRes.error === 'VARIANT_NOT_MODELLED') {
        throw badRequest(`"${displayName}": that combination is not available for sale`, 'VARIANT_NOT_MODELLED');
      }
      if (stockRes.available !== null && stockRes.available < qty) {
        // A PRE-ORDER IS NOT "OUT OF STOCK". There is no shelf; the import
        // quota is full, which is a different fact and a different wait, and
        // the existing code would have named the wrong one.
        /**
         * THE REMAINDER TRAVELS AS DATA, NOT ONLY AS ENGLISH PROSE.
         *
         * «المستخدم الثاني يريد التاكيد … يجب التاكد بان المخزون يتحدث ويعطيه
         *  اشعارا بان المتبقي فقط 2.»
         *
         * The sentence here has always carried the number — in English, with
         * the product name interpolated into it. An Arabic customer read
         * `Only 2 of "بي إل إيه" left in stock`, because the client can only
         * translate a CODE and this refusal's only machine-readable part was
         * the code. `details` is the existing channel for exactly this
         * (worker/lib/http.ts), so the count goes there and the client builds
         * «لم يبقَ سوى 2» in the customer's own language.
         *
         * `coarse` IS THE MYSTERY-POOL RULE, carried into the data.
         * docs/BUNDLES_MYSTERY.md §8.2 row 18: a pool member's refusal must
         * name no count, because "only 2 left" is a before/after oracle on the
         * draw. So the count is OMITTED rather than sent-and-hidden — a client
         * cannot leak a number it was never given.
         */
        const coarse = poolMemberIds.has(String(row.id));
        const stockDetails: Record<string, unknown> = {
          // The PRODUCT, not the cart line: `CartSelection` carries no line id,
          // and the product is what the customer recognises anyway — it is
          // already named in the sentence.
          product_id: String(row.id),
          requested: qty,
          coarse,
          ...(coarse ? {} : { available: stockRes.available }),
        };
        if (orderType === 'pre_order') {
          // A PRE-ORDER IS NOT "OUT OF STOCK": there is no shelf, the import
          // quota is full, and that is a different fact and a different wait.
          throw badRequest(
            coarse
              ? `The pre-order quota for "${displayName}" cannot cover this order`
              : stockRes.available === 0
                ? `The pre-order quota for "${displayName}" is full`
                : `Only ${stockRes.available} pre-order place(s) left for "${displayName}"`,
            'PREORDER_CAPACITY_EXHAUSTED',
            stockDetails
          );
        }
        if (coarse) {
          throw badRequest(`"${displayName}" does not have enough stock for this order`, 'OUT_OF_STOCK', stockDetails);
        }
        throw badRequest(
          `Only ${stockRes.available} of "${displayName}" left in stock`,
          'OUT_OF_STOCK',
          stockDetails
        );
      }
      const unit = resolved.unit_subtotal_iqd;
      const line = unit * qty;
      subtotal += line;
      merchandise += resolved.applied_iqd * qty;
      productIds.push(String(row.id));
      const facts = shippingFactsFrom(row.ops_policy);
      shippingItems.push({ product_id: String(row.id), qty, ...facts });
      // Persisted resolver snapshot: cost fields must NEVER be stored on the
      // order (it is served back to the buyer). It carries `direct.waived`,
      // `transport.waived_by` and `pricing_basis`, so an invoice, a refund or
      // an admin can later explain WHY this line's fee is what it is — a
      // cash-on-delivery pre-order priced as a direct sale must stay legible
      // after the cart that produced it is gone.
      const { cost_iqd, ...pricingSnapshot } = resolved;
      /**
       * …AND THE STRIPPED COST GOES ONTO THE ROW, NOT INTO THE BIN (0095).
       *
       * `void cost_iqd` used to stand here, and it was the whole defect: the
       * order snapshot correctly refused to publish the cost to the buyer, and
       * `order_items` had no cost column, so THE COST AT THE MOMENT OF SALE WAS
       * RECORDED NOWHERE. Every profit figure was therefore computed against
       * the product's CURRENT cost, and one edit to a supplier price silently
       * rewrote the profit of every order ever placed for that product. A
       * history that moves behind the owner cannot be reconciled with anything.
       *
       * `costSnapshot` takes THIS resolver's answer — the one that priced the
       * line, having already walked the option, colour, fulfilment and
       * transport rungs — and never re-derives it from the product row. Two
       * derivations of one sale can disagree, and then neither is evidence.
       *
       * A NULL here is stored as `unpriced`, a RECORDED FACT meaning "there was
       * no cost configured when this sold". That is deliberately not the same
       * as the `unrecorded` default every pre-0095 row carries: only the latter
       * may be estimated against today's catalogue, and only with the word
       * «تقدير» beside it on screen.
       */
      const lineCost = costSnapshot(cost_iqd);
      /**
       * WHICH OFFER PRODUCED THIS PRICE, frozen (§12). Without the id and its
       * figures on the row, "why was this line 40,000 when the product is
       * 50,000" is unanswerable the moment the window is edited or deleted —
       * and an offer window is a mutable row an admin will edit.
       */
      const offerSnapshot =
        offerId && offerView?.window
          ? {
              offer_id: offerId,
              subject_type: 'product',
              subject_id: String(row.id),
              required_tiers: offerView.window.required_tiers,
              starts_at: offerView.window.starts_at,
              ends_at: offerView.window.ends_at,
              offer_price_mode: offerView.window.offer_price_mode,
              offer_discount_percent: offerView.window.discount_percent,
              offer_applied_iqd: resolved.applied_iqd,
              price_source: 'offer',
            }
          : null;
      lines.push({
        cart_item_id: String(row.cart_item_id),
        id: newId('oi'),
        product_id: String(row.id),
        option_value_ids: sel.optionValueIds ?? [],
        stock_targets: stockRes.targets,
        name: String(row.name),
        name_ar: String(row.name_ar ?? ''),
        image: productImageForSelection(doc, {
          optionValueIds: sel.optionValueIds ?? [],
          colorId: sel.colorId || null,
        }, view),
        variant: variantLabel,
        option_id: String(row.option_id ?? ''),
        color_id: String(row.color_id ?? ''),
        shipping_method_id: String(row.shipping_method_id ?? ''),
        qty,
        unit,
        line,
        applied_iqd: resolved.applied_iqd,
        tracked: stockRes.tracked,
        pricing_snapshot: JSON.stringify(offerSnapshot ? { ...pricingSnapshot, offer: offerSnapshot } : pricingSnapshot),
        warranty_snapshot: resolved.warranty ? JSON.stringify(resolved.warranty) : null,
        transport_snapshot: resolved.transport ? JSON.stringify(resolved.transport) : null,
        breakdown: publicBreakdown(resolved),
        is_printer: isPrinter,
        pricing_basis: resolved.pricing_basis,
        // ADMIN-ONLY. Stored on the row, stripped from the snapshot above, and
        // selected by no customer-facing serializer (migration 0095).
        cost_iqd: lineCost.cost_iqd,
        cost_basis: lineCost.cost_basis,
        benefit: {
          category_id: (row.category_id as string | null) ?? null,
          sub_category_id: (row.sub_category_id as string | null) ?? null,
          regular_unit_iqd: resolved.regular_iqd,
          applied_rule_id: tierStatus.tier === 'pro' ? resolved.member_rule.pro : resolved.member_rule.prime,
        },
        physical_dimensions: resolveSelectionPhysicalDimensions(
          doc,
          view ?? EMPTY_RELATIONS,
          { optionValueIds: sel.optionValueIds ?? [], colorId: sel.colorId || null }
        ),
      });
    }
    // THE PHYSICAL-LINE CEILING (§3.1) — a door refusal naming the limit, not a
    // clamp. `max_qty_per_order` reaches 99, so one order could otherwise ask
    // one D1 batch for thousands of `order_items` and inventory statements and
    // meet an opaque bound-parameter error instead of a sentence.
    refusePhysicalLines(physical + lines.filter((l) => !l.bundle_parent_item_id).length);

    // AGGREGATED DEMAND PER STOCK ROW, ACROSS EVERY LINE (§3.2). Two lines that
    // resolve to one row stay two independent guarded moves — the per-item
    // trail returns depend on — but their demand is SUMMED before it is judged.
    // Without this a bundle and a bare product of the same colour pass every
    // per-line check, `planInventory` rejects nothing, and the sequential
    // guards fail at commit: a permanent, deterministic "a stock level changed"
    // on a cart nobody is racing.
    refuseAggregateDemand(lines, poolMemberIds);

    return {
      lines,
      subtotal,
      merchandise,
      productIds,
      shippingItems,
      pricingBasis: lines.some((l) => l.pricing_basis === 'preorder') ? 'preorder' : 'direct',
    };
  };

  // The cart under the requested basis, and — for a pre-order cart — under
  // the other one, so the screens can say whether cash on delivery changes a
  // single dinar here (it does not when no line carries a direct premium, or
  // when this customer is exempt from it).
  let priced = priceLines(requestedPricing);
  const prepaidPriced = isPreorderCart ? (requestedPricing === 'prepaid' ? priced : priceLines('prepaid')) : priced;
  const codPriced = isPreorderCart ? (requestedPricing === 'cod' ? priced : priceLines('cod')) : priced;
  const codReprices =
    isPreorderCart && prepaidPriced.lines.some((l, i) => l.unit !== codPriced.lines[i].unit);
  /**
   * «كما أنه يجب توضيح هذا الفرق قبل أن يختار» — BY HOW MUCH, not just whether.
   *
   * `codReprices` is a boolean, so the screen could only ever say "cash is
   * priced as a direct sale" in the abstract, and only AFTER cash had already
   * been picked and re-quoted. The buyer has to be able to read the price of
   * each door before opening one, so the difference is published as a number
   * and both screens put it on the cash option itself.
   *
   * It is the LINES' difference alone, which is the whole of what the pricing
   * basis decides. The cash tax and the delivery fee are their own rows,
   * already itemised under the total, and folding them in here would make one
   * number mean three things.
   *
   * Always >= 0: the door is never cheaper than the wallet (pricing.ts pairs
   * the commission waiver with the direct ladder actually having supplied the
   * price). `Math.max` is a floor against a misconfiguration, not a hope —
   * a negative shown as a discount on cash would be the wrong way round.
   */
  const codSurchargeIqd = isPreorderCart
    ? Math.max(
        0,
        codPriced.lines.reduce((sum, l, i) => sum + (l.unit - prepaidPriced.lines[i].unit) * l.qty, 0)
      )
    : 0;

  /**
   * THE REFERRAL DELIVERY WAIVER IS WITHDRAWN. Owner's decision, on this
   * report: «ألغِ المكافأة تماماً».
   *
   * It used to call `referralFreeDeliveryApplies` — a referred friend buying
   * a printer had the WHOLE delivery fee waived, whichever method they chose,
   * and it asked for no subscription at all. That is how «لبعض المستخدمين»
   * saw «التوصيل مجاناً» on a 1,255,000 د.ع order against a 50,000 د.ع
   * personal tariff, and it is the answer to «المستخدم لم يكن مشتركا
   * بالاشتراك البرو وقد حصل على خصم»: nothing about it was ever a membership.
   *
   * A PRO subscriber's free delivery — standard AND personal, the owner's own
   * rule — is untouched by this: it comes from the benefit rules below, not
   * from here.
   *
   * The engine keeps its `independentFreeDelivery` input, because an
   * owner-approved promotion is a real thing a future rule may express. What
   * is gone is the one promotion that granted it without anybody deciding to.
   * The REFERRER's own reward (`referral_rewards`, campaign 'printer') is a
   * different payment to a different person and is not touched.
   */
  const independentFreeDelivery = false;

  // Store pickup: no last-mile delivery happens, so no delivery fees at all.
  const isPickup = delivery.id === 'pickup';
  const productDeliveryMethod: ProductDeliveryMethod | null =
    delivery.id === 'standard' || delivery.id === 'personal' ? delivery.id : null;
  if (!isPickup && priced.shippingItems.some((item) => item.delivery !== undefined)) {
    if (!productDeliveryMethod) {
      throw badRequest(
        'This delivery method is not configured for one or more products in the cart.',
        'DELIVERY_METHOD_UNAVAILABLE',
        { delivery_method_id: delivery.id }
      );
    }
    const availability = productDeliveryMethodAvailable(priced.shippingItems, productDeliveryMethod);
    if (!availability.available) {
      throw badRequest(
        'The selected delivery method is unavailable for one or more products in the cart.',
        'DELIVERY_METHOD_UNAVAILABLE',
        {
          delivery_method_id: productDeliveryMethod,
          unavailable_product_ids: availability.unavailable_product_ids,
        }
      );
    }
  }

  // The selected delivery method's configured price is the ORDINARY tariff
  // for this order (standard = the confirmed 5,000 IQD default); printer and
  // carton components come from the owner-configured shippingPolicy on top.
  const methodOrdinary = Number.isInteger(delivery.price_iqd) && (delivery.price_iqd as number) >= 0
    ? (delivery.price_iqd as number)
    : shippingConfig.ordinary_iqd;
  const configForOrder: ShippingConfig = { ...shippingConfig, ordinary_iqd: methodOrdinary };
  /**
   * The same substitution for ANY method, so pricing a method other than the
   * selected one uses ITS tariff.
   *
   * `configForOrder` above bakes in the CHOSEN method's `price_iqd`. The
   * per-method preview below must not reuse it: on a cart with no per-product
   * delivery rule the ordinary tariff is the whole fee, so reusing one
   * method's config made every card print the selected method's number and the
   * figures still moved on every click — the very defect the preview exists to
   * remove.
   */
  const configForMethod = (m: DeliveryMethod): ShippingConfig => {
    const ordinary =
      Number.isInteger(m.price_iqd) && (m.price_iqd as number) >= 0
        ? (m.price_iqd as number)
        : shippingConfig.ordinary_iqd;
    return { ...shippingConfig, ordinary_iqd: ordinary };
  };

  const shippingEntitlements = shippingEntitlementContext(tierStatus);

  // Spendable balances only (mandate §11.1/§4.4: pending deposits and pending
  // points are NEVER spendable). getAvailableBalances is the wallet slice's
  // frozen contract — settled minus active holds/reservations. Read once —
  // the balance does not change with the pricing basis.
  /**
   * THE BALANCE IN DINARS — «يضاف كما هو ولكن يحول الى الدولار وليس العكس».
   *
   * This line used to be `Math.floor(usd_cents_available * exchangeRate / 100)`
   * and it is where a customer who paid 50,000 د.ع became 49,994. The printer
   * advance below is a NATIVE dinar figure (`printerHomeDeliveryNoteIqd`, read
   * verbatim by worker/lib/printerAdvance.ts), so the comparison at
   * `walletApplied < requiredAdvance` is dinars against dinars and the six
   * dinars the floor discarded refused a customer who had paid enough.
   *
   * `walletIqdAvailable` (worker/lib/walletOps.ts, contract in migration 0108)
   * adds back exactly the remainder the recorded testimony proves was paid,
   * clamped to one cent's worth. It is NEVER BELOW the old conversion, so no
   * order that quoted before can quote worse now.
   */
  const [available, walletDust] = await Promise.all([
    getAvailableBalances(c.env, user.id),
    readWalletDust(c.env.DB, user.id),
  ]);
  const walletBalanceIqd = walletIqdAvailable(available.usd_cents_available, walletDust.dust_iqd, exchangeRate);

  // §4.2 accrual rule at the rate in force for THIS purchase instant, and the
  // §3.3 support attribution — resolved server-side, zero monetary effect.
  const ruleConfig = await getPointsRuleConfig(c.env);
  const pointsRule = resolvePointsRule(ruleConfig, new Date().toISOString());
  const supportSnapshot = await buildSupportSnapshot(c.env, user.id, input.supportRef || null);

  /**
   * Everything from the priced lines to the money due — shipping, coupon,
   * points, wallet — for ONE pricing of the cart. Kept as a function of the
   * priced lines so a cash order the wallet settles in full can be re-settled
   * as the prepaid order it is, with every dependent figure (coupon minimum,
   * PRIME waiver basis, accrual) recomputed on the price actually charged
   * rather than patched.
   */
  const settle = async (p: PricedLines) => {
    const { shippingItems } = p;

    /**
     * §3 / §10 — THE MEMBERSHIP'S EFFECT ON THE MERCHANDISE, resolved before
     * anything else touches the money.
     *
     * Most of it is already in the unit prices: `resolveUnitPrice` consulted
     * the same rules when it priced each line, which is what makes the product
     * page, the cart and this door quote one number. What is left here is the
     * part a unit price cannot carry — a quantity limit, a per-order ceiling,
     * a minimum order value — and it is subtracted ONCE, from the line totals,
     * before the coupon, the points and the delivery threshold are computed on
     * them (§12: the basis is merchandise AFTER product discounts).
     */
    const benefitLines: BenefitLineInput[] = p.lines.flatMap((l) =>
      l.benefit
        ? [{
            product_id: l.product_id,
            category_id: l.benefit.category_id,
            sub_category_id: l.benefit.sub_category_id,
            ancestry: ancestryFor(benefitAncestry, l.benefit.category_id, l.benefit.sub_category_id),
            regular_unit_iqd: l.benefit.regular_unit_iqd,
            applied_unit_iqd: l.applied_iqd,
            applied_rule_id: l.benefit.applied_rule_id,
            qty: l.qty,
          }]
        : []
    );
    const productBenefits = resolveProductBenefits({
      rules: pricingCtx.benefitRules,
      status: tierStatus,
      lines: benefitLines,
      nowIso: benefitNowIso,
    });
    /**
     * Keyed by ORDER ITEM id, not product id: two cart lines can hold the same
     * product with different options, and a map keyed by product would give
     * both of them one line's benefit. `resolveProductBenefits` answers in
     * input order, so zipping is exact.
     */
    const eligibleLines = p.lines.filter((l) => l.benefit);
    const benefitByLine = new Map<string, ProductBenefits['lines'][number]>();
    eligibleLines.forEach((l, i) => {
      const b = productBenefits.lines[i];
      if (b) benefitByLine.set(l.id, b);
    });

    /**
     * `subtotal` and `merchandise` STAY as the lines came out, because that is
     * what `orders.subtotal_iqd` and `merchandise_iqd` mean and what the
     * `order_items` rows add up to. The order-level part of the membership is
     * deducted the way a coupon is — after the subtotal, in its own column —
     * so the stored figures still reconcile line by line.
     */
    const { subtotal, merchandise } = p;
    const lineDiscount = Math.min(productBenefits.line_discount_iqd, merchandise);
    /** Merchandise as every downstream rule should see it (§12: after product
     *  discounts). */
    const memberMerchandise = Math.max(0, merchandise - lineDiscount);

    /** `primeBasisIqd` is the §5 basis — merchandise after product discounts,
     *  coupons AND points, before delivery — which is a different number from
     *  the PRO rule's configurable basis. */
    /**
     * The configured free-delivery rule, resolved against the SAME basis the
     * quote is about to compare. `deliveryMethodId` is the method the customer
     * actually chose, so a PREMIUM rule listing standard only refuses a
     * personal delivery here rather than in the UI.
     */
    const orderBenefitsAt = (basisIqd: number, methodId: string = delivery.id) =>
      resolveOrderBenefits({
        rules: pricingCtx.benefitRules,
        status: tierStatus,
        shippingBasisIqd: basisIqd,
        deliveryMethod: methodId === 'standard' || methodId === 'personal' ? methodId : null,
        nowIso: benefitNowIso,
      });
    /**
     * `methodId` defaults to the method the customer chose, which is every
     * caller but one: `deliveryMethodFees` below re-runs this for EVERY
     * configured method so the checkout screen can print a real fee on each
     * card instead of a base rate that ignores the cart. It is a pure
     * function over figures already in hand, so N methods cost no queries.
     */
    const runQuote = (basisIqd: number, primeBasisIqd?: number, methodId: string = delivery.id): ShippingQuote =>
      quoteShipping({
        items: shippingItems,
        deliveryMethod:
          methodId === 'standard' || methodId === 'personal' ? (methodId as ProductDeliveryMethod) : undefined,
        merchandiseIqd: basisIqd,
        primeMerchandiseIqd: primeBasisIqd,
        tier: tierStatus.tier,
        tierActive: tierStatus.active,
        ...shippingEntitlements,
        atApprovedDefaultAddress: atApprovedDefault,
        independentFreeDelivery,
        // The PRO rule's own basis is `basisIqd`; PREMIUM's is the after-points
        // figure the caller passes as `primeMerchandiseIqd` (§5), so the rule
        // is tested against whichever number this member's tier is judged on.
        membershipShipping: orderBenefitsAt(
          tierStatus.tier === 'prime' ? (primeBasisIqd ?? basisIqd) : basisIqd,
          methodId
        ).shipping,
        // Store pickup has no last mile, so nothing to protect; the flag is
        // dropped rather than charged for a delivery that does not happen.
        protectedDelivery: input.protectedDelivery && methodId !== 'pickup',
        config:
          methodId === delivery.id
            ? configForOrder
            : configForMethod(
                (settings.checkoutDeliveryMethods as DeliveryMethod[]).find((m) => m.id === methodId) ?? delivery
              ),
      });

    const emptyQuote: ShippingQuote = {
      components: [],
      total_iqd: 0,
      total_before_waiver_iqd: 0,
      advance_due_iqd: 0,
      pro_waiver_applied: false,
      prime_waiver_applied: false,
      membership_subsidy_iqd: 0,
      membership_subsidy_capped: false,
      membership_rule_id: null,
      waiver_source: 'none',
      waiver_basis_iqd: merchandise,
      needs_config: [],
      assumptions: [],
      reasons: ['Store pickup — no delivery fee.'],
    };

    // Pass 1 (before coupon) prices the shipping used to validate the coupon;
    // the FINAL quote then applies the configured threshold basis.
    let shipping = isPickup ? emptyQuote : runQuote(memberMerchandise);

    // Coupon — validated against the honest payable total (subtotal + the
    // delivery actually charged); applied FIRST: coupon, then points, then wallet.
    let couponDiscount = 0;
    let couponId: string | null = null;
    let couponSnapshot: string | null = null;
    if (input.couponCode) {
      const couponBasis = Math.max(0, subtotal - lineDiscount) + shipping.total_iqd;
      const check = await validateCoupon(c.env, user.id, input.couponCode, couponBasis);
      if (!check.ok || !check.coupon_id) {
        const reason = check.reason ?? 'COUPON_INVALID';
        throw badRequest(`Coupon could not be applied (${reason})`, reason);
      }
      couponId = check.coupon_id;
      couponDiscount = Math.max(0, Math.min(Math.floor(Number(check.discount_iqd) || 0), couponBasis));
      couponSnapshot = JSON.stringify({
        coupon_id: check.coupon_id,
        code: check.code ?? input.couponCode.toUpperCase(),
        discount_iqd: couponDiscount,
      });
    }

    // §4.4 redemption: "use my points" applies ALL available points, capped at
    // the ELIGIBLE MERCHANDISE value after product/membership/coupon discounts —
    // never delivery, never transport commissions or warranty fees, never
    // community-store lines (community_products have no checkout path here; all
    // cart lines come from the official `products` catalogue). The amount is
    // EXACT: 739 available against a 75,000 basis redeems 739 IQD.
    //
    // Computed BEFORE the final shipping quote because the LEVO PRIME waiver is
    // tested against merchandise after coupons AND points (product-form §5).
    // There is no circularity: neither the coupon cap nor the points cap depends
    // on the delivery fee.
    const eligibleMerchandise = Math.max(0, memberMerchandise - Math.min(couponDiscount, memberMerchandise));
    let pointsDiscount = 0;
    if (input.usePoints && available.points_available > 0) {
      pointsDiscount = capRedeemablePoints(available.points_available, eligibleMerchandise);
    }

    // Final quote with the configured threshold basis (decision row 17 default:
    // merchandise AFTER coupon discounts, before shipping) for the PRO rule, and
    // the after-coupon-and-points basis for the PRIME rule.
    if (!isPickup) {
      const basis =
        configForOrder.threshold_basis === 'merchandise_after_coupon'
          ? eligibleMerchandise
          : memberMerchandise;
      shipping = runQuote(basis, Math.max(0, eligibleMerchandise - pointsDiscount));
    }

    const beforeDiscounts = Math.max(0, subtotal - lineDiscount + shipping.total_iqd - couponDiscount);
    const afterPoints = beforeDiscounts - pointsDiscount;

    // §4.2 accrual basis, computed on the ORDER TOTAL (lines summed first, one
    // floor at the end).
    const netEligible = netEligibleIqd(memberMerchandise, couponDiscount, pointsDiscount);
    const pointsEarnPending = pointsForEligibleIqd(netEligible, pointsRule.iqd_per_point);

    // Advance-payment requirements are paid from the wallet: "pay in advance"
    // means the whole payable total (worker/lib/paymentPolicy.ts — a half
    // advance is refused above). Printer delivery fees are payable in advance
    // (§6.3) on top of the payment method's rule.
    let requiredAdvance = 0;
    if (isPrepaid(input.paymentMethodId)) requiredAdvance = afterPoints;

    /**
     * THE PRINTER HOME-DELIVERY ADVANCE IS NOW ENFORCED, NOT ANNOUNCED.
     *
     * `printerHomeDeliveryNoteIqd` was display-only: the product page, the cart
     * and this checkout all told the customer that 50,000 IQD is paid from the
     * wallet in advance, and no code path ever asked for it — a printer order
     * was accepted with an empty wallet. It now joins `shipping.advance_due_iqd`
     * in the same `max`, so the existing wallet machinery below debits it and
     * refuses with INSUFFICIENT_BALANCE when the balance cannot cover it.
     *
     * Deliberately NOT routed through the shipping fee engine's printer
     * components — see worker/lib/printerAdvance.ts for why that lever would
     * break every printer checkout instead of guarding it.
     */
    /**
     * AND IT IS 0 ON A GINI ORDER — «بدون طلب ٥٠ الف للطابعه».
     *
     * The advance exists because a printer sent to a home is a large,
     * awkward, non-returnable delivery and the shop wants skin in the game
     * before it loads one onto a van. A Gini printer has already been PAID
     * FOR IN FULL inside the app before this checkout ever happened; asking
     * its buyer for 50,000 from a Levo wallet they may not even use is asking
     * twice for commitment they have already given. Forced to 0 here rather
     * than only in `requiredAdvance` below, because this figure is ALSO what
     * the checkout screen prints to explain why money is wanted — and a
     * screen that announces an advance nothing will collect is the defect
     * this number was introduced to remove.
     */
    const isGiniOrder = isGini(input.paymentMethodId);
    const printerAdvance = isGiniOrder
      ? 0
      : printerHomeDeliveryAdvanceIqd({
          hasPrinterLine: p.lines.some((l) => l.is_printer),
          isPickup,
          noteIqd: printerNoteIqdFrom(settings.printerHomeDeliveryNoteIqd),
        });

    requiredAdvance = Math.min(Math.max(requiredAdvance, shipping.advance_due_iqd, printerAdvance), afterPoints);
    /**
     * NOTHING IS REQUIRED IN ADVANCE FOR A GINI ORDER, from any rule.
     *
     * `requiredAdvance` is a MAX over several of them, so zeroing the printer
     * contributor alone is not enough — `shipping.advance_due_iqd` is the
     * other live one, and the next rule added to that max would silently
     * reach a Gini order too. The client greys its confirm button out on
     * `applied_iqd >= required_advance_iqd`, so anything surviving here is a
     * Gini checkout nobody can complete, refused with a balance message that
     * describes a payment Levonis is not taking.
     */
    if (isGiniOrder) requiredAdvance = 0;

    /**
     * AN ADVANCE TAKES THE ADVANCE, NOT THE WHOLE WALLET.
     *
     * This used to read `if (requiredAdvance > 0 || input.useWallet)` and then
     * apply `min(balance, afterPoints)` — the ENTIRE balance — in both cases.
     * For a prepaid method the two are the same number, because `requiredAdvance`
     * is `afterPoints` there, so the bug never showed: `shipping.advance_due_iqd`
     * is the only other contributor and it is always 0 while the printer fee
     * mapping stays unconfigured.
     *
     * The printer advance makes that path live, and the difference is the whole
     * point of the rule. Someone who chose cash on delivery and owes a 50,000
     * advance on a 904,000 order must lose 50,000 from the wallet and pay the
     * rest at the door. Sweeping the balance would silently convert their COD
     * order into a prepaid one and empty an account they never offered.
     */
    let walletApplied = 0;
    if (isGiniOrder) {
      /**
       * THE WALLET MUST NOT PART-PAY A GINI ORDER.
       *
       * `useWallet` takes `min(balance, afterPoints)` — the WHOLE payable, not
       * an advance — and a checkout screen that leaves its wallet toggle on
       * while the customer switches to Gini would hand us a price Qi Card has
       * already financed. The customer would be charged twice for one
       * product, once in their Levo balance and once in their instalments,
       * and the second charge is not one we could see to refund.
       *
       * Refused rather than ignored-on-the-client: the toggle is a client
       * fact and this is the only place that decides what the wallet pays.
       */
      walletApplied = 0;
    } else if (input.useWallet) {
      walletApplied = Math.min(walletBalanceIqd, afterPoints);
    } else if (requiredAdvance > 0) {
      walletApplied = Math.min(walletBalanceIqd, requiredAdvance);
    }
    if (walletApplied < requiredAdvance) {
      /**
       * A QUOTE IS A PREVIEW. IT PRICES; IT DOES NOT REFUSE.
       *
       * `computeCheckout` is shared by `POST /api/orders/quote` and
       * `POST /api/orders`, and `options.allocate` is the only thing that
       * separates them. Every other refusal in here is about whether the order
       * may EXIST — a sold-out line, a closed offer, a quota. This one is not:
       * it is about whether the customer has PAID YET, which is the one
       * question a preview must be allowed to answer with a number instead of
       * an error.
       *
       * Throwing it on the quote took the whole screen down, and four separate
       * reports were this one line:
       *   - «سعر التوصيل لا يظهر للخيارات» — every delivery card reads from
       *     the quote; with no quote all three render «—».
       *   - «الضريبة لا تعمل» — the COD tax row reads `quote.cod_tax_iqd`.
       *     No quote, no row. The rule was never broken.
       *   - «تعذر حساب عرض السعر» — the catch nulls the quote and shows that
       *     sentence.
       *   - «لا يوضح بأن الرصيد غير كافي» — and this is the cruel part. The
       *     client decides sufficiency from `quote.wallet.applied_iqd >=
       *     quote.wallet.required_advance_iqd`, and the panel that EXPLAINS a
       *     printer advance is gated on `quote !== null`. The condition that
       *     caused the refusal destroyed the quote that would have explained
       *     it, so the button stayed enabled and the customer learned only by
       *     pressing it.
       *
       * Store pickup hid all of it: `printerHomeDeliveryAdvanceIqd` returns 0
       * for a pickup, so that one configuration quoted fine — which is why the
       * screenshot with three real prices and the report of no prices are the
       * same cart.
       *
       * Not a new rule and not a relaxed one: the ORDER door still refuses on
       * exactly the same condition, one line below. The quote now returns
       * `requiredAdvance` and `walletApplied` as the data they always were,
       * and the screen it feeds already knows what to do with them.
       */
      if (options.allocate) {
        // Name the rule that is asking. "Insufficient balance" on a printer
        // order reads as a bug when the customer was never told an advance was
        // due; saying the amount and the reason turns it into an instruction.
        throw badRequest(
          printerAdvance > 0 && printerAdvance >= requiredAdvance
            ? `توصيل الطابعة إلى المنزل يتطلب دفع ${printerAdvance.toLocaleString('en-US')} د.ع مقدماً من المحفظة قبل إتمام الطلب. / Home delivery of a printer requires ${printerAdvance.toLocaleString('en-US')} IQD paid in advance from your wallet before the order can be placed.`
            : 'Insufficient wallet balance for the required advance payment',
          'INSUFFICIENT_BALANCE',
          { required_advance_iqd: requiredAdvance, printer_advance_iqd: printerAdvance, wallet_available_iqd: walletBalanceIqd }
        );
      }
    }
    /**
     * THE SECOND DOOR, AND WHY IT USED TO RE-REFUSE EVERY FIX TO THE FIRST.
     *
     * `iqdToUsdCents` at the top of this file CEILS — «rounded up so the
     * wallet never undercharges» — and that is still right for a HOLD, which
     * must not under-reserve the debt it exists to guarantee. IT IS WRONG FOR
     * A WALLET APPLICATION, and this is the arithmetic: a wallet credited by
     * the owner's floor holds 3,571 cents for a typed 50,000 د.ع. Applying
     * 50,000 د.ع through the ceil asks for 3,572 — one cent MORE than the same
     * 50,000 د.ع put in — so the line below scaled `walletApplied` back to
     * 49,994 and the order refused with the bare English «Insufficient wallet
     * balance», one screen after the explicit Arabic printer sentence.
     *
     * The wallet pays in the unit the wallet is denominated in.
     * `walletSpendCents` (worker/lib/walletOps.ts) is the one place that
     * converts a dinar-quoted payment into cents, it floors, and it never asks
     * for more cents than the wallet holds. The dinars are recorded on the
     * debit (migration 0108) so the balance falls by exactly `walletApplied`
     * and not by the cents' conversion. That is «وليس العكس» applied to the
     * spend side: the dinar is the source, the cent is derived from it.
     *
     * WHAT USED TO STAND HERE AND WAS WRONG. Two lines claimed to "scale back
     * to what the balance covers" by reassigning `walletApplied =
     * walletIqdAvailable(...)` — the identical figure `walletApplied` had just
     * been min()'d against, so nothing was ever scaled back and the refusal
     * re-tested a number that could not have changed. The cap belongs on the
     * CENTS, which is the side that can overflow, and `walletSpendCents` now
     * carries it.
     *
     * WHO PAYS THE REMAINDER, because the header this replaces claimed nobody
     * did. The dinar balance may stand up to one cent per testified deposit
     * above what its cents convert to, so an order that spends the whole
     * balance is credited up to one cent's worth — 13 د.ع at 1,400 — more than
     * leaves the wallet. THAT IS THE SHOP REPAYING ITS OWN UNDER-CREDIT: every
     * one of those dinars arrived by bank transfer and was floored away when
     * the deposit was approved. It is bounded by what was floored away, it is
     * cancelled on this very debit (which records `walletApplied` dinars, so
     * the remainder it spent stops being counted), and it is the mirror image
     * of the ceil that used to put the same cent on the customer.
     */
    const walletUsdCents = walletSpendCents(walletApplied, available.usd_cents_available, exchangeRate);
    /**
     * A WALLET PAYMENT WORTH LESS THAN A CENT IS NOT A WALLET PAYMENT.
     *
     * `CHECK (amount > 0)` on `wallet_transactions` means a zero-cent debit
     * cannot be written, and the checkout batch guards its own debit with
     * `if (comp.walletUsdCents > 0)`. So an application of, say, 10 د.ع at
     * 1,400 — floor(1,000 / 1,400) = 0 cents — used to reduce
     * `payableBeforeCodTax` by 10 د.ع against NO ledger row and NO balance
     * movement, on every order, for ever. Under the old ceil it was always at
     * least one cent and the hole did not exist.
     *
     * The wallet therefore pays nothing here rather than paying for free. The
     * customer owes those few dinars at the door, which is where they would
     * have owed them had they left the toggle off, and the balance they were
     * shown is untouched.
     */
    if (walletUsdCents <= 0) walletApplied = 0;
    const finalWalletUsdCents = walletUsdCents;
    const payableBeforeCodTax = Math.max(0, afterPoints - walletApplied);
    /**
     * §14 — THE TAX IS CALCULATED IN FULL, THEN EXEMPTED.
     *
     * The existing cash-on-delivery tax engine is untouched and still runs on
     * every order: `codTaxBeforeExemptionIqd` is what the courier's cash sheet
     * and the tax report see. The membership then waives it as a BENEFIT, and
     * both numbers are recorded, so an invoice can say "COD tax 12,000 / PRO
     * exemption -12,000" instead of a silent zero nobody can reconcile.
     *
     * Whether a tier is exempt is a CONFIGURED rule, never `tier === 'pro'`:
     * an owner who switches the PRO exemption off in the admin switches it off
     * here, and one who switches PREMIUM's on switches it on.
     */
    const codTaxBeforeExemptionIqd = codDeliveryTaxIqd(
      {
        paymentMethodId: input.paymentMethodId,
        deliveryMethodId: delivery.id,
        payableBeforeTaxIqd: payableBeforeCodTax,
      },
      // THE ADMINISTRATOR'S RATE, read with the rest of the settings this
      // quote is already built from. `settings` is the same object the
      // delivery methods and the printer note come out of, so the rate cannot
      // be read from a different snapshot than the fees beside it.
      { blockIqd: Number(settings.codTaxBlockIqd), perBlockIqd: Number(settings.codTaxPerBlockIqd) }
    );
    const taxBenefit = orderBenefitsAt(shipping.waiver_basis_iqd).tax;
    const codTaxExemptionIqd = taxBenefit.cod_exempt ? codTaxBeforeExemptionIqd : 0;
    const codTaxIqd = Math.max(0, codTaxBeforeExemptionIqd - codTaxExemptionIqd);
    const financedIqd = isBnpl(input.paymentMethodId) ? payableBeforeCodTax : 0;

    /**
     * THE GINI SPLIT — computed HERE, inside `settle`, and returned from it.
     *
     * `settle` runs up to THREE times for one checkout (the requested basis,
     * the prepaid re-settle, the cash-on-delivery re-price) and
     * `computeCheckout` may discard the winner and settle a different priced
     * set. A Gini figure calculated after this function returns belongs to a
     * pricing basis that did not win — the same reason `financedIqd` is
     * returned from here on the line above rather than derived outside.
     *
     * The invariant, which `giniSplit` enforces by construction:
     *     giniPaidIqd + giniDeliveryDueIqd === payableBeforeCodTax
     * The delivery fee is ALREADY inside `payableBeforeCodTax` (it entered
     * through `beforeDiscounts`), so the door amount is carved OUT of the
     * payable and never added to it, and it is clamped to the payable so a
     * coupon-and-points order that costs less than its own delivery cannot
     * produce a negative "paid by Gini". `shipping.total_iqd` is the fee AS
     * CHARGED — after the waiver and the membership subsidy — so a PRO whose
     * delivery was waived is asked for nothing at the door.
     */
    const { paidIqd: giniPaidIqd, deliveryDueIqd: giniDeliveryDueIqd } = isGiniOrder
      ? giniSplit(payableBeforeCodTax, shipping.total_iqd)
      : { paidIqd: 0, deliveryDueIqd: 0 };

    /**
     * NO COURIER CASH CHARGE ON A GINI ORDER, AND THAT IS A DECISION.
     *
     * `codDeliveryTaxIqd` already answers 0 for this id, because it tests for
     * 'cash' and its two aliases — so today the outcome is right by string
     * matching rather than by intent, and the next id added to that test
     * would change this order's total without anyone meaning to.
     *
     * The rule is charged per COMPLETE 500,000 IQD collected at the door. A
     * Gini order's door amount is a delivery fee — five figures at the very
     * most — so a whole block can never be reached and the honest charge is 0
     * on the arithmetic as well as on the id. «ويظهر المبلغ الذي يدفع عند
     * التوصيل فقط»: the customer is told the fee and pays the fee.
     */
    const dueOnDelivery = isBnpl(input.paymentMethodId)
      ? 0
      : isGiniOrder
        ? giniDeliveryDueIqd
        : payableBeforeCodTax + codTaxIqd;

    /**
     * Priced for EVERY configured method, not just the chosen one. A method
     * the cart cannot use is reported as unavailable rather than priced, so
     * the screen can grey it out instead of quoting a delivery that would be
     * refused at the door.
     */
    const deliveryMethodFees: Array<{ id: string; fee_iqd: number | null; available: boolean }> = (
      settings.checkoutDeliveryMethods as DeliveryMethod[]
    ).map((m) => {
      if (m.id === 'pickup') return { id: m.id, fee_iqd: 0, available: true };
      const asProduct: ProductDeliveryMethod | null =
        m.id === 'standard' || m.id === 'personal' ? m.id : null;
      // The same two doors the chosen method goes through above — asked here
      // as a question instead of thrown as a refusal.
      if (priced.shippingItems.some((item) => item.delivery !== undefined)) {
        if (!asProduct) return { id: m.id, fee_iqd: null, available: false };
        if (!productDeliveryMethodAvailable(priced.shippingItems, asProduct).available) {
          return { id: m.id, fee_iqd: null, available: false };
        }
      }
      // The SAME basis the chosen method's own final quote uses, so the
      // card's figure and the summary's figure cannot disagree.
      const q = runQuote(memberMerchandise, undefined, m.id);
      return { id: m.id, fee_iqd: q.total_iqd, available: true };
    });

    return {
      shipping,
      deliveryMethodFees,
      couponId,
      couponDiscount,
      couponSnapshot,
      pointsDiscount,
      eligibleMerchandise,
      netEligible,
      pointsEarnPending,
      walletApplied,
      walletUsdCents: finalWalletUsdCents,
      requiredAdvance,
      /**
       * Reported separately from `requiredAdvance` so the checkout screen can
       * say WHY money must be in the wallet. `requiredAdvance` is a max over
       * several rules, and "pay 50,000 in advance for the printer" is a very
       * different sentence from "this payment method is prepaid".
       */
      printerAdvance,
      totalIqd: afterPoints + codTaxIqd,
      dueOnDelivery,
      codTaxIqd,
      codTaxBeforeExemptionIqd,
      codTaxExemptionIqd,
      codTaxExemptionRuleId: codTaxExemptionIqd > 0 ? taxBenefit.rule_id : null,
      financedIqd,
      /**
       * §5 — WHAT GINI SETTLED AND WHAT IS LEFT FOR THE DOOR, from the basis
       * that actually won. Both are 0 on every other payment method, and
       * their sum is `payableBeforeCodTax` by construction.
       */
      giniPaidIqd,
      giniDeliveryDueIqd,
      /** §19 — everything the order freezes about this membership's effect. */
      benefits: {
        tier: tierStatus.tier,
        tier_active: tierStatus.active,
        resolved_at: benefitNowIso,
        lines: productBenefits.lines,
        byLine: benefitByLine,
        discount_total_iqd: productBenefits.discount_total_iqd,
        line_discount_iqd: lineDiscount,
        unit_discount_iqd: Math.max(0, productBenefits.discount_total_iqd - productBenefits.line_discount_iqd),
        shipping: orderBenefitsAt(shipping.waiver_basis_iqd).shipping,
        tax: taxBenefit,
      },
    };
  };

  let settled = await settle(priced);

  // «مدفوع مقدمًا» means nothing is left to collect at the door. A cash-on-
  // delivery pre-order whose wallet payment settles the WHOLE total is a
  // prepaid order whatever button was pressed, so it is re-priced under the
  // pre-order rule — the cheaper figure, which the wallet still covers — and
  // recorded as prepaid by wallet. payment_method_id stays as sent; the
  // lines' pricing_basis says 'preorder'. A cash order the wallet covers only
  // in part stays COD-priced: money is still collected at the door.
  let prepaidByWallet = false;
  if (isPreorderCart && isCod(input.paymentMethodId) && priced.pricingBasis === 'direct' && settled.dueOnDelivery === 0) {
    priced = prepaidPriced;
    settled = await settle(priced);
    prepaidByWallet = settled.dueOnDelivery === 0;
  }

  let finalBnpl: BnplEligibility | null = null;
  let finalBnplDueAt: string | null = null;
  if (isBnpl(input.paymentMethodId)) {
    if (settled.financedIqd <= 0) throw badRequest('There is no remaining amount to finance', 'BNPL_AMOUNT_TOO_LOW');
    finalBnpl = await bnplEligibility(c.env.DB, user.id, address, settled.financedIqd);
    if (!finalBnpl.eligible) {
      throw badRequest(`BNPL is not available for this amount (${finalBnpl.reason ?? 'NOT_ELIGIBLE'}).`, finalBnpl.reason ?? 'BNPL_NOT_ELIGIBLE');
    }
    finalBnplDueAt = bnplDueAt(new Date().toISOString(), finalBnpl.due_days);
  }

  const priorityDelivery = priorityDeliveryVerdict({
    status: tierStatus,
    atApprovedDefault,
    config: settings.proPriorityDelivery as ProPriorityDeliveryConfig,
    deliveryMethodId: delivery.id,
    shippingType,
    address,
    nowIso: new Date().toISOString(),
  });

  const policies = await getRequiredCheckoutPolicies(c.env);

  return {
    address,
    delivery,
    payment,
    shippingConfig: configForOrder,
    exchangeRate,
    tierStatus,
    atApprovedDefault,
    proContext,
    shippingType,
    allowedPaymentMethods: allowedMethods,
    bnpl: finalBnpl ?? (bnplBase.eligible ? bnplBase : null),
    bnplAmount: settled.financedIqd,
    bnplDueAt: finalBnplDueAt,
    giniEnabled,
    giniPolicy,
    // From `settled`, never recomputed out here: the basis that won is the
    // only one whose figures belong on this order.
    giniPaidIqd: settled.giniPaidIqd,
    giniDeliveryDueIqd: settled.giniDeliveryDueIqd,
    priorityDelivery,
    pricingBasis: priced.pricingBasis,
    codReprices,
    codSurchargeIqd,
    prepaidByWallet,
    printerNoteIqd: printerNoteIqdFrom(settings.printerHomeDeliveryNoteIqd),
    // Already clamped to 1..30 by `normalizedSetting` → `resolveDeliveryDayPolicy`.
    deliveryDayPolicy: settings.deliveryDayPolicy as DeliveryDayPolicy,
    lines: priced.lines,
    compositionSubjects: new Set([...compositionRows.map((r) => String(r.id)), ...offerSubjects]),
    mysteryLines,
    allocate: options.allocate === true,
    productIds: priced.productIds,
    subtotal: priced.subtotal,
    merchandise: priced.merchandise,
    shipping: settled.shipping,
    /**
     * WHAT EVERY OTHER DELIVERY METHOD WOULD COST, for the same cart.
     *
     * The checkout screen used to print `method.price_iqd` — the flat rate
     * configured in settings — on every card except the selected one, and the
     * SERVER's figure only on the selected one. For a cart whose fee is
     * per-product and per-quantity («محسوب حسب القطع والكمية») those are
     * different numbers, so selecting a method made its price jump and made
     * the previously-selected one drop back to its base rate. It read as two
     * options swapping prices; it was one real figure and one placeholder.
     *
     * `runQuote` is pure over figures already computed, so pricing all of them
     * costs no extra queries — and it is the SAME function that prices the
     * order, which is what stops the preview and the charge from drifting.
     */
    deliveryMethodFees: settled.deliveryMethodFees,
    isPickup,
    independentFreeDelivery,
    couponId: settled.couponId,
    couponDiscount: settled.couponDiscount,
    couponSnapshot: settled.couponSnapshot,
    pointsBalance: available.points_available,
    pointsDiscount: settled.pointsDiscount,
    eligibleMerchandise: settled.eligibleMerchandise,
    netEligible: settled.netEligible,
    pointsRule,
    pointsEarnPending: settled.pointsEarnPending,
    supportSnapshot,
    walletBalanceIqd,
    walletApplied: settled.walletApplied,
    walletUsdCents: settled.walletUsdCents,
    walletLedgerDinars: walletDust.ledger_dinars,
    requiredAdvance: settled.requiredAdvance,
    totalIqd: settled.totalIqd,
    dueOnDelivery: settled.dueOnDelivery,
    codTaxIqd: settled.codTaxIqd,
    codTaxBeforeExemptionIqd: settled.codTaxBeforeExemptionIqd,
    codTaxExemptionIqd: settled.codTaxExemptionIqd,
    codTaxExemptionRuleId: settled.codTaxExemptionRuleId,
    benefits: settled.benefits,
    policies,
    printerGiftConfig: settings.printerGiftConfig,
    preorderGiftConfig: settings.preorderGiftConfig,
  };
}

function checkoutInputFrom(body: Record<string, unknown>, requirePayment: boolean): CheckoutInput {
  return {
    addressId: str(body.addressId, 'addressId', { min: 1, max: 60 }),
    deliveryMethodId: str(body.deliveryMethodId, 'deliveryMethodId', { min: 1, max: 60 }),
    paymentMethodId: requirePayment
      ? str(body.paymentMethodId, 'paymentMethodId', { min: 1, max: 60 })
      : str(body.paymentMethodId, 'paymentMethodId', { max: 60, required: false }),
    itemIds: Array.isArray(body.itemIds) ? body.itemIds.map(String).slice(0, 100) : [],
    couponCode: str(body.couponCode, 'couponCode', { max: 60, required: false }),
    usePoints: body.usePoints === true,
    useWallet: body.useWallet === true,
    // Accepted from either field name; resolved server-side and worth exactly
    // 0 IQD to the buyer — it only attributes the order to a supporter.
    supportRef: str(body.supportCode ?? body.supportRef, 'supportCode', { max: 60, required: false }),
    protectedDelivery: body.protectedDelivery === true,
    // A civil day is ten characters; anything longer is not one, and the
    // shape itself is checked against the order's own window below rather
    // than here — this only keeps a megabyte out of the validator.
    requestedDeliveryDate: str(body.requestedDeliveryDate, 'requestedDeliveryDate', { max: 10, required: false }),
    // Six characters is the whole value; the SHAPE is judged in
    // `computeCheckout`, where the payment method is known and a quote is
    // still allowed to answer with a price instead of an error.
    giniOrderNo: str(body.giniOrderNo, 'giniOrderNo', { max: 6, required: false }),
  };
}

// ------------------------------------------------------------------ routes

const ORDER_STATUSES = ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'];

/**
 * The customer's own orders, newest first, one page at a time.
 *
 *   ?status=   one legacy status, or several comma-separated
 *              (`confirmed,processing` is the "to ship" view) — an unknown
 *              value yields an empty page, as the single-status filter always
 *              did, never the whole list.
 *   ?limit=    page size, default 20, at most 50.
 *   ?before=   cursor: the `created_at` of the last order already shown.
 *
 * `next_before` is the cursor for the following page and null on the last
 * one. Items for the whole page come from ONE query instead of one per
 * order — the list was the slowest thing on the account screen.
 */
orderRoutes.get('/', async (c) => {
  const user = c.get('user')!;
  const statusRaw = str(c.req.query('status'), 'status', { max: 80, required: false });
  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: 50, def: 20 });
  // The cursor is `created_at|id` of the last order shown, so two orders
  // written in the same millisecond (or legacy rows with second-resolution
  // timestamps) are never skipped at a page boundary. A bare ISO timestamp is
  // still accepted for any client that stored the old cursor.
  const beforeRaw = str(c.req.query('before'), 'before', { max: 120, required: false });
  const sep = beforeRaw.indexOf('|');
  const beforeAt = sep >= 0 ? beforeRaw.slice(0, sep) : beforeRaw;
  const beforeId = sep >= 0 ? beforeRaw.slice(sep + 1) : '';
  if (beforeRaw && (!Number.isFinite(Date.parse(beforeAt)) || (sep >= 0 && !beforeId))) {
    throw badRequest('before must be an ISO timestamp, optionally followed by |<order id>');
  }

  let sql = 'SELECT * FROM orders WHERE user_id = ?';
  const params: unknown[] = [user.id];
  if (statusRaw && statusRaw !== 'All' && statusRaw !== 'null') {
    const wanted = statusRaw
      .toLowerCase()
      .split(',')
      .map((x) => x.trim())
      .filter((x) => ORDER_STATUSES.includes(x));
    // A filter that names no real status matches nothing — the same answer
    // the old `WHERE status = 'bogus'` gave, made explicit.
    if (wanted.length === 0) return c.json({ success: true, orders: [], next_before: null });
    sql += ` AND status IN (${wanted.map(() => '?').join(',')})`;
    params.push(...wanted);
  }
  if (beforeRaw) {
    if (beforeId) {
      // Same ordering as ORDER BY below: newest first, then id descending.
      sql += ' AND (created_at < ? OR (created_at = ? AND id < ?))';
      params.push(beforeAt, beforeAt, beforeId);
    } else {
      sql += ' AND created_at < ?';
      params.push(beforeAt);
    }
  }
  // One row past the page says whether a next page exists, without a COUNT.
  sql += ' ORDER BY created_at DESC, id DESC LIMIT ?';
  params.push(limit + 1);
  const { results: rows } = await c.env.DB.prepare(sql).bind(...params).all<Record<string, unknown>>();
  const hasMore = rows.length > limit;
  const orders = hasMore ? rows.slice(0, limit) : rows;
  const ids = orders.map((o) => String(o.id));

  // One snapshot query for the whole page — the §5 money view is never
  // recomputed per row, and never in the browser.
  const snaps = await getOrderPointsSnapshots(c.env, ids);
  const itemsByOrder = new Map<string, Record<string, unknown>[]>();
  if (ids.length > 0) {
    const { results: items } = await c.env.DB.prepare(
      `${ORDER_ITEMS_SELECT} WHERE oi.order_id IN (${ids.map(() => '?').join(',')}) ORDER BY oi.rowid`
    )
      .bind(...ids)
      .all<Record<string, unknown>>();
    for (const it of items) {
      const key = String(it.order_id);
      const list = itemsByOrder.get(key);
      if (list) list.push(it);
      else itemsByOrder.set(key, [it]);
    }
  }
  const mysteryView = await mysteryViewFor(c.env.DB, ids, 'customer', langOf(c));
  const out = orders.map((o) => {
    const items = itemsByOrder.get(String(o.id)) ?? [];
    return { ...orderPublic(o, items, snaps.get(String(o.id)), mysteryView), item_count: itemCount(items) };
  });
  return c.json({
    success: true,
    orders: out,
    next_before: hasMore ? `${String(orders[orders.length - 1].created_at)}|${String(orders[orders.length - 1].id)}` : null,
  });
});

orderRoutes.get('/counts', async (c) => {
  const user = c.get('user')!;
  const { results } = await c.env.DB.prepare(
    'SELECT status, COUNT(*) AS n FROM orders WHERE user_id = ? GROUP BY status'
  )
    .bind(user.id)
    .all<{ status: string; n: number }>();
  const counts: Record<string, number> = {};
  for (const r of results) counts[r.status] = r.n;
  return c.json({ success: true, counts });
});

/**
 * Server-authoritative pre-checkout quote (§6.3): the full money breakdown
 * for the CURRENT cart/address/method selection — per-line resolver
 * breakdowns, the shipping quote with human-readable reasons and honest
 * needs_config flags, points/wallet previews and the required policy list.
 * Read-only: nothing is reserved, charged or recorded.
 */
/**
 * THE QUOTE'S LINES — ONE PER CART LINE, WITH A BUNDLE'S PARTS NESTED (§6.3).
 *
 * `POST /api/orders/quote` never touches `order_items`, so the audit of every
 * `ORDER_ITEMS_SELECT` consumer misses it — and `priceLines` pushes one
 * component `ComputedLine` per component into this same array, each carrying
 * the PARENT's `cart_item_id`. The checkout screen maps `quote.lines` 1:1 with
 * `key={l.cart_item_id}`, so a four-component bundle would render the bundle
 * plus four extra 0 IQD rows under four duplicate React keys, naming the member
 * products, on the last screen before payment.
 *
 * `is_printer` is carried up onto the parent by `priceCompositionLine`, so the
 * printer delivery note still fires for a printer bought inside a bundle.
 */
function quoteLines(lines: ComputedLine[]) {
  const children = new Map<string, ComputedLine[]>();
  for (const l of lines) {
    if (!l.bundle_parent_item_id) continue;
    const arr = children.get(l.bundle_parent_item_id);
    if (arr) arr.push(l);
    else children.set(l.bundle_parent_item_id, [l]);
  }
  return lines
    .filter((l) => !l.bundle_parent_item_id)
    .map((l) => {
      const kids = children.get(l.id) ?? [];
      return {
        cart_item_id: l.cart_item_id,
        product_id: l.product_id,
        /** A mystery line says how many spools and nothing else — the quote is
         *  a CUSTOMER payload and §8.2 row 20 puts it on the leak list. */
        ...(kids.some((k) => k.mystery_spool) ? { mystery: { revealed: false, spools: kids.length } } : {}),
        name: l.name,
        name_ar: l.name_ar,
        image: l.image,
        variant: l.variant,
        qty: l.qty,
        unit_price_iqd: l.unit,
        line_total_iqd: l.line,
        is_printer: l.is_printer,
        breakdown: l.breakdown,
        ...(kids.length
          ? {
              // The two figures the disclosure struck through and badged. On
              // the QUOTE's basis, beside the quote's own line total.
              component_total_iqd: l.composition_total_iqd ?? null,
              saving_percent: l.composition_saving_percent ?? null,
              /** The bundle's parts, for the checkout's expandable disclosure.
               *  Never a top-level line, never a second price. */
              included: kids.map((k) => ({
                // THE DRAWN PRODUCT IS NOT PUBLISHED HERE (§8.2 row 20). The
                // spool's `ComputedLine.product_id` carries the real product
                // because `planInventory` needs it; the quote is the customer's
                // last screen before payment and gets the same NULL the
                // `order_items` row will be written with.
                product_id: k.mystery_spool ? null : k.product_id,
                name: k.name,
                name_ar: k.name_ar,
                image: k.image,
                variant: k.variant,
                qty: k.qty,
                value_iqd: k.component_value_iqd ?? 0,
              })),
            }
          : {}),
      };
    });
}

orderRoutes.post('/quote', async (c) => {
  await rateLimit(c, 'order_quote', 60, 300);
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const input = checkoutInputFrom(body, false);
  // READ-ONLY: `allocate: false` — the quote prices and reports availability,
  // and nothing is drawn and nothing is written (§7.4).
  const comp = await computeCheckout(c, user, input, { allocate: false });

  const blockers: string[] = [];
  if (comp.shipping.needs_config.length > 0) blockers.push('SHIPPING_NEEDS_CONFIG');
  /**
   * AN ADVANCE THE WALLET CANNOT COVER IS A BLOCKER, and it was not one.
   *
   * `can_checkout` is the server's answer to "may this be bought?", and
   * src/pages/Checkout.tsx's own header calls it "the last word". It was not:
   * a cart with a printer going to a home address requires 50,000 IQD in the
   * Levo wallet (`printerHomeDeliveryAdvanceIqd`), and the quote answered
   * `can_checkout: true` for a cart its own order door then refused with 400
   * INSUFFICIENT_BALANCE. The client had to re-derive the verdict from
   * `wallet.required_advance_iqd` to get it right, which is the second
   * implementation this field exists to remove.
   *
   * The INSUFFICIENT_BALANCE throw below is gated on `options.allocate`, so
   * the QUOTE never threw for this — it priced happily and said yes. Now it
   * prices happily and says no, which is what a preview that refuses nothing
   * but reports everything is supposed to do.
   */
  if (comp.requiredAdvance > comp.walletApplied) blockers.push('ADVANCE_NOT_COVERED');

  return c.json({
    success: true,
    quote: {
      /**
       * THE PRICE AUTHORITY for the checkout screen. The cart prices a
       * pre-order line as prepaid; these lines are priced for the payment
       * method actually chosen, so the summary must render them — not the
       * cart's numbers — the moment a quote exists.
       */
      lines: quoteLines(comp.lines),
      merchandise_iqd: comp.merchandise,
      subtotal_iqd: comp.subtotal,
      /** §1: the journey this cart is on — unchanged by how it is paid. */
      shipping_type: comp.shippingType,
      /** The payment ids the storefront may offer for this cart. */
      allowed_payment_methods: comp.allowedPaymentMethods,
      bnpl: comp.bnpl
        ? {
            eligible: comp.bnpl.eligible,
            available_iqd: comp.bnpl.available_iqd,
            outstanding_iqd: comp.bnpl.outstanding_iqd,
            financed_iqd: comp.bnplAmount,
            due_at: comp.bnplDueAt,
          }
        : { eligible: false },
      /**
       * «أقساط عبر تطبيق جني» as this cart sees it.
       *
       * `paid_iqd` and `delivery_due_iqd` always sum to the payable, so the
       * screen can print «يُدفع عند الاستلام: كلفة التوصيل فقط» from the
       * server's own arithmetic instead of subtracting one figure from
       * another and arriving at a different number. They are 0 unless the
       * customer has actually chosen Gini — a preview of another method must
       * not show a door amount that method will not charge.
       */
      gini: {
        available: comp.giniEnabled,
        selected: comp.giniPaidIqd > 0 || comp.giniDeliveryDueIqd > 0,
        paid_iqd: comp.giniPaidIqd,
        delivery_due_iqd: comp.giniDeliveryDueIqd,
        conditions: comp.giniPolicy.conditions,
        app_url: comp.giniPolicy.app_url,
        hold_hours: comp.giniPolicy.hold_hours,
      },
      priority_delivery: comp.priorityDelivery,
      /** 'direct' when the lines were priced by the direct-sale rule (a direct
       *  cart, or a pre-order cart paid cash on delivery); 'preorder' when the
       *  transport commission applies. */
      pricing_basis: comp.pricingBasis,
      /**
       * Does cash on delivery change a single dinar on THIS cart? False on a
       * direct cart, on a pre-order cart whose lines carry no direct premium
       * (the commission stays either way), and for a customer exempt from the
       * premium. The screen explains the cash rule only when this is true.
       */
      cod_reprices: comp.codReprices,
      cod_surcharge_iqd: comp.codSurchargeIqd,
      /**
       * A cash order the wallet settled in full was re-priced as the PREPAID
       * pre-order it is (nothing is collected at the door), so the lines
       * above carry the pre-order figure. The screen says so.
       */
      prepaid_by_wallet: comp.prepaidByWallet,
      /**
       * Informational notes, never part of any total. The printer note is
       * echoed only when a line is a printer AND a home delivery is requested
       * (no note for store pickup) AND the owner has an amount configured.
       *
       * AND NOT ON A GINI ORDER — «بدون طلب ٥٠ الف للطابعه». The note's own
       * sentence is «يدفع 50,000 د.ع مقدماً», and on a Gini printer nothing
       * will be asked for: the machine was paid for inside the app and
       * `requiredAdvance` is 0. Printing the note anyway would put a figure on
       * the screen that no step of this checkout ever collects, which is the
       * exact failure the advance was made enforceable to end.
       */
      notes: {
        printer_home_delivery_iqd:
          !comp.isPickup && !isGini(input.paymentMethodId) && comp.lines.some((l) => l.is_printer)
            ? comp.printerNoteIqd
            : null,
      },
      shipping: comp.shipping,
      /** Every method's real fee for this cart — so the screen prints a true
       *  figure on every card before the customer has chosen anything. */
      delivery_method_fees: comp.deliveryMethodFees,
      is_pickup: comp.isPickup,
      /**
       * Whether the protected-delivery add-on can be offered at all, and what
       * it costs THIS customer. The fee is quoted even when the toggle is off,
       * because "protect my parcel for 4,000 IQD" is a decision the customer
       * makes from the price — and `waived` is how an eligible PRO learns the
       * answer is free rather than being shown a fee it will never pay.
       */
      protected_delivery: {
        available: comp.shippingConfig.protected_iqd !== null && !comp.isPickup,
        selected: input.protectedDelivery && !comp.isPickup,
        fee_iqd: comp.shippingConfig.protected_iqd,
        waived: comp.shipping.components.some((k) => k.kind === 'protected' && k.waived),
      },
      coupon: comp.couponSnapshot ? safeParse(comp.couponSnapshot, null) : null,
      // §5 unified snapshot, preview edition: the eligible basis the cap and
      // the accrual both come from is shown, so the customer sees WHY the
      // discount is what it is before committing.
      points: {
        balance: comp.pointsBalance,          // spendable only — pending is excluded
        applied_iqd: comp.pointsDiscount,     // 1 point = exactly 1 IQD
        eligible_merchandise_iqd: comp.eligibleMerchandise, // the redemption cap
        earn_eligible_iqd: comp.netEligible,  // accrual basis after discounts + points
        earn_pending: comp.pointsEarnPending, // pending at purchase, released after 7 days + settlement
        iqd_per_point: comp.pointsRule.iqd_per_point,
        rule_version: comp.pointsRule.version,
        hold_days: 7,
      },
      // Attribution only: this code supports a user and changes no price.
      support: comp.supportSnapshot
        ? {
            referrer_username: comp.supportSnapshot.referrer_username,
            ref: comp.supportSnapshot.ref,
            discount_iqd: 0,
          }
        : null,
      wallet: {
        balance_iqd: comp.walletBalanceIqd,
        applied_iqd: comp.walletApplied,
        required_advance_iqd: comp.requiredAdvance,
      },
      merchandise_after_coupon_iqd: comp.eligibleMerchandise,
      total_iqd: comp.totalIqd,
      cod_tax_iqd: comp.codTaxIqd,
      /**
       * §11 / §14 — THE CASH-ON-DELIVERY TAX, AND ITS EXEMPTION, AS TWO
       * NUMBERS.
       *
       * The screen shows both: «ضريبة الدفع عند الاستلام 12,000» and
       * «إعفاء عضوية PRO −12,000». A single zero would be cheaper to render
       * and would tell the customer nothing about what their membership just
       * did for them — and would leave a courier's cash sheet with nothing to
       * reconcile against.
       */
      cod_tax_before_exemption_iqd: comp.codTaxBeforeExemptionIqd,
      cod_tax_exemption_iqd: comp.codTaxExemptionIqd,
      /**
       * §11 — WHAT THE MEMBERSHIP IS WORTH ON THIS ORDER, itemised.
       *
       * `discount_total_iqd` is the whole saving on merchandise: the part
       * already inside the line prices above plus `order_discount_iqd`, which
       * is deducted after the subtotal the way a coupon is. Naming them apart
       * is what lets the screen show a summary that adds up.
       */
      membership_benefits: {
        tier: comp.benefits.tier,
        active: comp.benefits.tier_active,
        discount_total_iqd: comp.benefits.discount_total_iqd,
        unit_discount_iqd: comp.benefits.unit_discount_iqd,
        order_discount_iqd: comp.benefits.line_discount_iqd,
        lines: comp.benefits.lines,
        shipping: {
          ...comp.benefits.shipping,
          fee_before_benefit_iqd: comp.shipping.total_before_waiver_iqd,
          fee_paid_iqd: comp.shipping.total_iqd,
          subsidy_iqd: comp.shipping.membership_subsidy_iqd,
          subsidy_capped: comp.shipping.membership_subsidy_capped,
        },
        cod_tax: {
          rule_id: comp.codTaxExemptionRuleId,
          exempt: comp.benefits.tax.cod_exempt,
          before_exemption_iqd: comp.codTaxBeforeExemptionIqd,
          exemption_iqd: comp.codTaxExemptionIqd,
          charged_iqd: comp.codTaxIqd,
        },
      },
      due_on_delivery_iqd: comp.dueOnDelivery,
      tier: {
        tier: comp.tierStatus.tier,
        active: comp.tierStatus.active,
        at_approved_default_address: comp.atApprovedDefault,
        pro_benefits_context: comp.proContext,
      },
      policies: comp.policies,
      blockers,
      can_checkout: blockers.length === 0,
    },
  });
});

orderRoutes.post('/', async (c) => {
  await rateLimit(c, 'checkout', 15, 300);
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));

  const input = checkoutInputFrom(body, true);
  const idempotencyKey = str(body.idempotencyKey, 'idempotencyKey', { min: 8, max: 80 });

  // Idempotent replay: return the already-created order.
  //
  // Both arms on purpose (0064). `client_idempotency_key` is where every new
  // order stores the key and is unique PER USER; `idempotency_key` is the
  // legacy globally-unique column, still holding every key written before the
  // migration — so a retry that was in flight across the deploy still replays
  // its own order instead of being told it never happened.
  const existing = await c.env.DB.prepare(
    'SELECT id FROM orders WHERE user_id = ?1 AND (client_idempotency_key = ?2 OR idempotency_key = ?2)'
  )
    .bind(user.id, idempotencyKey)
    .first<{ id: string }>();
  if (existing) {
    const data = (await loadOrder(c.env.DB, existing.id))!;
    const inv = await c.env.DB.prepare('SELECT invoice_no FROM invoices WHERE order_id = ? AND revision = 1')
      .bind(existing.id)
      .first<{ invoice_no: string }>();
    const snaps = await getOrderPointsSnapshots(c.env, [existing.id]);
    return c.json({
      success: true,
      order: orderPublic(data.order, data.items, snaps.get(existing.id), await mysteryViewFor(c.env.DB, [existing.id], 'customer', langOf(c))),
      invoice_no: inv?.invoice_no ?? null,
      replay: true,
    });
  }

  const comp = await computeCheckout(c, user, input, { allocate: true });

  // Honest blocker (§6.3): an unpriced fee component (printer size mapping /
  // carton fee not configured by the owner yet) can NEVER be silently waived
  // or invented — the order cannot complete until the owner configures it.
  if (comp.shipping.needs_config.length > 0) {
    throw badRequest(
      'Delivery fees for part of this order are not configured yet (printer/carton delivery mapping). Please contact support or try again later.',
      'SHIPPING_NEEDS_CONFIG'
    );
  }

  // `CheckoutStarted` (03-EVENTS.md §3.6) — the quote step, keyed on the
  // checkout session (the idempotency key until `checkout_sagas` exists). At
  // most one per session: the outbox's UNIQUE (aggregate_type, aggregate_id,
  // aggregate_seq) enforces it, and a replay is a logged no-op rather than a
  // second event, because this is written on its own and never inside the
  // order's batch.
  if (eventsEnabled(c.env)) {
    await emitFromRequest(
      c,
      CheckoutStartedV1,
      {
        session_id: idempotencyKey,
        user_hash: await dailyUserHash(user.id),
        lines: comp.lines.map((l) => ({ product_id: l.product_id, qty: l.qty })),
        totals: {
          items_iqd: Math.max(0, comp.merchandise),
          delivery_iqd: Math.max(0, comp.shipping.total_iqd),
          discount_iqd: Math.max(0, comp.couponDiscount + comp.pointsDiscount),
          grand_iqd: Math.max(0, comp.totalIqd),
        },
        payment_method: eventPaymentMethod(input.paymentMethodId),
        seller_type: 'platform',
      },
      { aggregateId: idempotencyKey, actorId: user.id, aggregateSeq: 1 }
    );
  }

  const orderId = newOrderId();
  const now = new Date().toISOString();
  // The cart rule guarantees a single type across the lines, so the first one
  // speaks for the order. Falls back to direct for an order with no transport,
  // which is what "no transport" has always meant.
  const orderShippingType: ShippingType = typeForTransport(
    comp.lines
      .map((l) => safeParse<{ method?: unknown } | null>(l.transport_snapshot, null)?.method)
      .find((m) => m === 'air' || m === 'sea' || m === 'land') ?? ''
  );

  // Versioned-policy consent (§7): required BEFORE anything is written. When
  // no checkout policy is published yet, the list is empty and nothing is
  // required (honest empty — enforcement turns on when the owner publishes).
  const acceptanceList = Array.isArray(body.policyAcceptance)
    ? (body.policyAcceptance as Array<{ key?: unknown; version?: unknown }>).slice(0, 20).map((a) => ({
        key: String(a?.key ?? ''),
        version: Number(a?.version),
      }))
    : undefined;
  const policyAcceptance = await preparePolicyAcceptance(c.env, user.id, `order:${orderId}`, acceptanceList, {
    locale: body.policyLocale ?? langOf(c), orderId,
  });

  const shippingTotal = comp.shipping.total_iqd;
  const deliveryWaived = comp.shipping.total_iqd < comp.shipping.total_before_waiver_iqd ? 1 : 0;
  /**
   * The configuration version these figures were computed under. Read at
   * settlement rather than copied per rule so one integer answers "which set
   * of rules produced this order" for every column below at once.
   */
  const benefitVersionId = await currentBenefitVersionId(c.env.DB);
  const benefitSnapshot = JSON.stringify({
    version_id: benefitVersionId,
    tier: comp.benefits.tier,
    tier_active: comp.benefits.tier_active,
    resolved_at: comp.benefits.resolved_at,
    discount_total_iqd: comp.benefits.discount_total_iqd,
    line_discount_iqd: comp.benefits.line_discount_iqd,
    unit_discount_iqd: comp.benefits.unit_discount_iqd,
    lines: comp.benefits.lines,
    shipping: {
      ...comp.benefits.shipping,
      fee_before_benefit_iqd: comp.shipping.total_before_waiver_iqd,
      fee_paid_iqd: shippingTotal,
      subsidy_iqd: comp.shipping.membership_subsidy_iqd,
      subsidy_capped: comp.shipping.membership_subsidy_capped,
      waiver_source: comp.shipping.waiver_source,
    },
    cod_tax: {
      rule_id: comp.codTaxExemptionRuleId,
      exempt: comp.benefits.tax.cod_exempt,
      before_exemption_iqd: comp.codTaxBeforeExemptionIqd,
      exemption_iqd: comp.codTaxExemptionIqd,
      charged_iqd: comp.codTaxIqd,
    },
  });
  // WHICH waiver produced the free delivery is recorded apart from the fact of
  // it. The referral waiver that used to set this is withdrawn, so the column
  // now only ever takes a 1 from a promotion the owner adds deliberately — and
  // the rows already carrying a 1 keep explaining the orders they belong to.
  const referralWaived = comp.shipping.waiver_source === 'promotion' ? 1 : 0;
  // PRO preparation/support priority is membership-wide. The 12-hour SLA is
  // narrower and is snapshot separately only where method/address/cart pass.
  const priority = benefits.priorityService(comp.tierStatus) ? 1 : 0;
  const fulfillmentService = comp.priorityDelivery.eligible ? 'pro_priority_12h' : priority ? 'pro_priority' : 'standard';

  // The delivery-method snapshot keeps its original fields (backward
  // compatible) and gains the authoritative shipping quote for transparency.
  const deliverySnapshot = JSON.stringify({
    ...comp.delivery,
    quote: comp.shipping,
    priority_delivery: comp.priorityDelivery,
  });

  /**
   * «PRO + طلب مسبق مدفوع مقدمًا = فلمنت هدية». The rule itself is in
   * worker/lib/entitlements.ts beside every other membership benefit; the
   * checkout only supplies the facts and FREEZES the answer onto the order, so
   * a membership that lapses next month cannot retract a spool already earned
   * — the same reason membership_tier_snapshot is written two lines above.
   */
  const gift = preorderGiftFor({
    config: comp.preorderGiftConfig as PreorderGiftConfig | null,
    proContext: comp.proContext,
    isPreorder: orderShippingType.startsWith('preorder_'),
    dueOnDeliveryIqd: comp.dueOnDelivery,
    now,
  });
  const membershipGift = gift ? JSON.stringify(gift) : '';

  /**
   * «يستطيع اختيار وتغيير يوم التوصيل في أي وقت يريد ولكن بحد أقصى أسبوع» —
   * resolved BEFORE the batch, because a day the customer may not have is a
   * refusal, and a refusal must happen before any row is written.
   */
  const deliveryDay = checkoutDeliveryDay(comp, orderShippingType, input.requestedDeliveryDate, now);

  /**
   * «ملاحظه مهمه ... ان الطلب لم يتم تاكيده الا بعد طلب من تطبيق جني وتاكيد
   * مسح باركود الاستلام، وبخلاف ذلك يبقى الطلب معلقا حتى ٢٤ ساعه ويلغي في
   * حال عدم الاستجابة» — the whole Gini contract, as four bound values.
   *
   * The order is created `pending` at `received` like every other order: there
   * is no 'gini_pending' status and there must not be one (migration 0103 says
   * why). `gini_state` is what tells a waiting-for-Gini order apart from a
   * waiting-for-an-admin one, and it is the flag the confirm gate and the
   * sweep both read.
   *
   * THE DEADLINE IS FROZEN HERE. `giniHoldUntil` is computed once, from the
   * policy as this checkout read it, so an owner who changes `hold_hours`
   * tomorrow cannot shorten a window a customer was already promised.
   */
  const isGiniPayment = isGini(input.paymentMethodId);
  const giniState = isGiniPayment ? 'awaiting_receipt' : '';
  const giniHoldUntilIso = isGiniPayment ? giniHoldUntil(now, comp.giniPolicy.hold_hours) : null;
  const giniOrderNo = isGiniPayment ? input.giniOrderNo : '';

  const stmts = [
    c.env.DB.prepare(
      `INSERT INTO orders (id, user_id, status, address_snapshot, delivery_method_id, delivery_method_snapshot,
         payment_method_id, subtotal_iqd, shipping_iqd, cod_tax_iqd, points_discount_iqd, wallet_applied_iqd,
         wallet_applied_usd_cents, exchange_rate, total_iqd, due_on_delivery_iqd, client_idempotency_key,
         membership_tier_snapshot, delivery_waived, priority, coupon_snapshot, merchandise_iqd,
         support_snapshot, shipping_type, membership_gift, referral_delivery_waived,
         fulfillment_service, priority_due_at, bnpl_due_iqd, bnpl_due_at,
         benefit_version_id, membership_discount_iqd, shipping_before_benefit_iqd, shipping_benefit_iqd,
         cod_tax_before_exemption_iqd, cod_tax_exemption_iqd, benefit_snapshot,
         delivery_day_schedulable, delivery_day_window_end, delivery_due_day, delivery_day_source,
         gini_order_no, gini_paid_iqd, gini_state, gini_hold_until,
         created_at, updated_at)
       VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      orderId, user.id, JSON.stringify(comp.address), input.deliveryMethodId, deliverySnapshot,
      input.paymentMethodId, comp.subtotal, shippingTotal, comp.codTaxIqd, comp.pointsDiscount, comp.walletApplied,
      comp.walletUsdCents, comp.exchangeRate, comp.totalIqd, comp.dueOnDelivery, idempotencyKey,
      comp.tierStatus.active ? comp.tierStatus.tier : 'free', deliveryWaived, priority, comp.couponSnapshot,
      // §5: merchandise is stored apart from fees so every screen and the
      // invoice read ONE basis. Support attribution is frozen here and can
      // never be re-pointed after purchase (§3.3) — worth 0 IQD to the buyer.
      comp.merchandise, comp.supportSnapshot ? JSON.stringify(comp.supportSnapshot) : null,
      // §1: the journey this order is on, frozen at purchase. A direct order
      // moves through five states and a pre-order through fourteen, so the
      // state machine must not have to re-derive the path from lines that can
      // change afterwards. The cart guarantees one type, so the first line
      // speaks for all of them.
      orderShippingType, membershipGift, referralWaived,
      fulfillmentService, comp.priorityDelivery.due_at, comp.bnplAmount, comp.bnplDueAt,
      /**
       * §19 / §21 — THE MEMBERSHIP BENEFIT SNAPSHOT.
       *
       * Everything the membership was worth on THIS order, and the id of the
       * configuration version it was worth it under, frozen at this instant.
       * The owner may change a percentage, a threshold or a tax exemption
       * tomorrow; none of it reaches these columns, which is the whole
       * requirement — «تغيير الإعدادات غدًا يجب ألا يغيّر طلب الأمس». Nothing
       * re-reads the live rules to explain an order once this row exists.
       */
      benefitVersionId, comp.benefits.discount_total_iqd,
      comp.shipping.total_before_waiver_iqd, comp.shipping.total_before_waiver_iqd - shippingTotal,
      comp.codTaxBeforeExemptionIqd, comp.codTaxExemptionIqd, benefitSnapshot,
      /**
       * THE DELIVERY DAY, frozen by the same rule as the benefit snapshot
       * above it. `delivery_day_changed_at` and `delivery_day_changes` are
       * deliberately left at their defaults: a choice made AT checkout is the
       * first value, not a change to one, and a support question about an
       * order whose day kept moving must be able to tell those apart.
       */
      deliveryDay.schedulable, deliveryDay.window_end, deliveryDay.day, deliveryDay.source,
      /**
       * IN THE SAME BATCH AS THE ORDER — the four Gini columns are not a
       * follow-up write. `gini_paid_iqd` is what the money view and the
       * invoice read to know the goods were settled, and `gini_state` is what
       * the confirm gate reads before it lets stock be deducted; an order
       * that committed without them is an order whose price is outstanding
       * and whose receipt requirement does not exist. Both are facts about
       * this row, so they land with it or not at all.
       */
      giniOrderNo, comp.giniPaidIqd, giniState, giniHoldUntilIso,
      now, now
    ),
  ];

  // Foreign-key order association and consent commit or roll back together.
  stmts.push(...policyAcceptance.statements);

  if (comp.bnplAmount > 0 && comp.bnplDueAt) {
    // The database trigger re-checks membership, approval, KYC, address and
    // remaining limit inside this same transaction.
    stmts.push(
      bnplChargeStatement(c.env.DB, {
        userId: user.id,
        orderId,
        amountIqd: comp.bnplAmount,
        dueAt: comp.bnplDueAt,
        createdAt: now,
      })
    );
  }

  if (comp.couponId) {
    // UNIQUE(order_id) makes the redemption idempotent with the order itself.
    // The coupon's per-user and global limits are enforced by a BEFORE INSERT
    // trigger on this table (migration 0049), inside this same transaction —
    // validateCoupon's counts above are advice, this is the decision. A
    // refused redemption aborts the batch and the order with it.
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO coupon_redemptions (id, coupon_id, user_id, order_id, amount_iqd, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(newId('crd'), comp.couponId, user.id, orderId, comp.couponDiscount, now)
    );
  }

  // ONE `offer_redemptions` ROW PER (SUBJECT, ORDER), with `qty` SUMMED across
  // every line of that subject in this order (§1.8, §3.1 step 3) — never one
  // row per line. An order may legitimately hold two lines of one bundle (two
  // different colour choices, §5.1), and a second INSERT would hit
  // `UNIQUE (subject_type, subject_id, order_id)` and abort the batch with a
  // message the catch block does not map: a permanent generic failure on a cart
  // that could never succeed. The read-time count is advice; the BEFORE INSERT
  // trigger on this table is the decision, inside this same transaction.
  const redemptions = new Map<string, number>();
  for (const it of comp.lines) {
    if (it.bundle_parent_item_id) continue; // a component redeems nothing of its own
    if (!comp.compositionSubjects.has(it.product_id)) continue;
    redemptions.set(it.product_id, (redemptions.get(it.product_id) ?? 0) + it.qty);
  }
  for (const [productId, qty] of redemptions) {
    stmts.push(offerRedemptionStatement(c.env.DB, subjectOf(productId), user.id, orderId, qty));
  }

  for (const it of comp.lines) {
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO order_items (id, order_id, product_id, name_snapshot, image_snapshot, option_snapshot,
           option_id, option_value_ids, color_id, shipping_method_id, qty, unit_price_iqd, line_total_iqd,
           pricing_snapshot, warranty_snapshot, transport_snapshot,
           bundle_parent_item_id, bundle_component_id, component_value_iqd, component_alloc_iqd,
           membership_discount_iqd, membership_rule_id, cost_iqd, cost_basis,
           net_weight_g, width_mm, depth_mm, height_mm,
           package_weight_g, package_width_mm, package_depth_mm, package_height_mm)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        it.id, orderId,
        // §7.7: a MYSTERY SPOOL binds NULL here on purpose. It is the single
        // choice that removes the largest class of reveal leak — the
        // `ORDER_ITEMS_SELECT` join to `products` yields no slug,
        // `GET /api/orders/:id/units` finds nothing to join, the invoice and
        // the courier payload say the offer's name — with no filtering code at
        // all. `ComputedLine.product_id` still carries the real product, which
        // is what `planInventory` reserves against below.
        it.mystery_spool ? null : it.product_id,
        it.name, it.image, it.variant,
        it.option_id, JSON.stringify(it.option_value_ids), it.color_id, it.shipping_method_id,
        it.qty, it.unit, it.line,
        // …and `pricing_snapshot = null`, never the drawn item's ladder
        // (§6.2, §8.2 row 19). The share it was worth is on
        // `component_value_iqd`, offer-derived.
        it.mystery_spool ? null : it.pricing_snapshot,
        it.warranty_snapshot, it.transport_snapshot,
        it.bundle_parent_item_id ?? null, it.bundle_component_id ?? null,
        it.component_value_iqd ?? null, it.component_alloc_iqd ?? null,
        // §19 — WHAT THE MEMBERSHIP TOOK OFF THIS LINE, and under which rule.
        // Frozen per item so a return, a partial refund or a question about
        // one product answers from the row itself, and an admin editing the
        // rule tomorrow cannot change the answer.
        comp.benefits.byLine.get(it.id)?.total_iqd ?? 0,
        comp.benefits.byLine.get(it.id)?.rule_id ?? null,
        /**
         * THE COST OF GOODS SOLD, AS IT WAS AT THIS INSTANT (migration 0095).
         *
         * It is bound here and NOWHERE ELSE, from `ComputedLine`, which took it
         * from the same resolver output that priced the line. Nothing on this
         * path re-reads a product to work it out: the resolver already walked
         * the option, colour, fulfilment and transport rungs for this exact
         * selection, and a second walk is a second answer.
         *
         * WHY THIS DOES NOT LEAK TO THE CUSTOMER, checked rather than assumed:
         * `orderPublic` builds each item object from an explicit field list, so
         * a column added to the row cannot appear in a customer payload by
         * growing it; the invoice (worker/lib/invoices.ts), the delivery and
         * warranty events, the returns screens and the stage sweep all name
         * their columns one by one; and the only two `SELECT *`-shaped readers
         * of this table are `ORDER_ITEMS_SELECT`, whose rows go through
         * `orderPublic`, and the merchant-store endpoint, which is filtered to
         * `orders.merchant_id = ?` — a column this checkout never writes, so it
         * can never see a row this INSERT produced.
         *
         * A LINE THAT SET NEITHER FIELD FALLS THROUGH TO 'unrecorded' — today
         * that is the mystery-box spool, whose draw record carries no cost and
         * whose `product_id` is bound NULL two lines up so the pick cannot leak
         * (§7.7). 'unrecorded' makes the dashboard say "unknown"; a bound 0
         * would make it say "pure profit", which is a lie the owner would price
         * against.
         */
        it.cost_iqd ?? null,
        it.cost_basis ?? COST_BASIS.unrecorded,
        it.physical_dimensions.net_weight_g,
        it.physical_dimensions.width_mm,
        it.physical_dimensions.depth_mm,
        it.physical_dimensions.height_mm,
        it.physical_dimensions.package_weight_g,
        it.physical_dimensions.package_width_mm,
        it.physical_dimensions.package_depth_mm,
        it.physical_dimensions.package_height_mm
      )
    );
    // THE ALLOCATION, in the ORDER'S OWN BATCH — never a second batch and
    // never a post-response write. `PRIMARY KEY (order_item_id, spool_index)`
    // is the replay fence: a replay that somehow re-entered this path collides
    // and aborts the whole batch (§7.4).
    if (it.mystery_spool && comp.allocate) {
      stmts.push(
        allocationStatement(c.env.DB, {
          order_item_id: it.id,
          spool_index: it.mystery_spool.spool_index,
          order_id: orderId,
          offer_product_id: String(
            comp.lines.find((l) => l.id === it.bundle_parent_item_id)?.product_id ?? it.product_id
          ),
          pool_id: it.mystery_spool.pool_id,
          candidate: {
            entry_id: it.mystery_spool.pool_entry_id,
            product_id: it.product_id,
            option_value_ids: it.mystery_spool.option_value_ids,
            color_id: it.mystery_spool.color_id,
            family_id: '',
            weight: 0,
            available: null,
            targets: [],
            name_snapshot: it.mystery_spool.name_snapshot,
            image_snapshot: it.mystery_spool.image_snapshot,
            variant_snapshot: it.mystery_spool.variant_snapshot,
          },
          sale_mode: it.mystery_spool.sale_mode as 'direct' | 'preorder',
          seed: it.mystery_spool.seed,
          reveal_stage_snapshot: it.mystery_spool.reveal_stage_snapshot,
          candidates_sha256: it.mystery_spool.candidates_sha256,
        })
      );
    }
    // Stock moves through the inventory ledger AFTER this batch commits (see
    // below): it needs its own idempotency-keyed batch so a retry of the whole
    // checkout is a no-op rather than a second deduction.
  }

  // ONE `mystery_draw_audits` ROW PER LINE (never per spool): the candidate
  // list and the weights the draw actually ran against, so `(seed,
  // candidates, weightedIndex)` reproduces the winner years later. Nothing
  // about a randomised money mechanism can be audited without it.
  if (comp.allocate) {
    for (const [cartItemId, m] of comp.mysteryLines) {
      stmts.push(
        drawAuditStatement(c.env.DB, {
          order_id: orderId,
          offer_product_id: m.ctx.offer_product_id,
          cart_item_id: cartItemId,
          pool_id: m.draw.pool_id,
          canonical: m.draw.canonical,
          sha256: m.draw.candidates_sha256,
        })
      );
    }
  }

  // §4.4 points redemption: RESERVE and COMMIT inside this one batch. There is
  // no window in which the order exists without its spend and none in which
  // points are held without an order — a failed checkout rolls both back
  // together, which IS the release-on-failure path (no orphan reservation can
  // survive). Two concurrent orders cannot double-spend: the ledger amount
  // below is computed against the live balance INSIDE the statement, so the
  // loser's amount goes negative, violates CHECK (amount > 0) and aborts its
  // whole batch — order, stock, wallet and points together.
  if (comp.pointsDiscount > 0) {
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO points_reservations (id, order_id, user_id, points, eligible_basis_iqd, state, wallet_tx_id, created_at)
         VALUES (?, ?, ?, ?, ?, 'committed', ?, ?)`
      ).bind(
        newId('prs'), orderId, user.id, comp.pointsDiscount, comp.eligibleMerchandise,
        `wtx_ord_${orderId}_pts`, now
      )
    );
    // Conditional amount: goes negative (violating CHECK amount > 0) when the
    // live balance no longer covers it, aborting the batch atomically.
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at)
         SELECT ?1, ?2, 'withdrawal', 'POINT',
           CASE WHEN (SELECT COALESCE(SUM(CASE WHEN type='deposit' THEN amount ELSE -amount END),0)
                        FROM wallet_transactions WHERE user_id = ?2 AND currency='POINT' AND status='approved') >= ?3
                THEN ?3 ELSE -1 END,
           'approved', ?4, ?5, 'system', ?6`
      ).bind(`wtx_ord_${orderId}_pts`, user.id, comp.pointsDiscount, `Points used on order ${orderId}`, orderId, now)
    );
  }
  if (comp.walletUsdCents > 0) {
    // Guarded on the SPENDABLE balance (settled minus active holds) — the same
    // number getAvailableBalances showed a moment ago — so money reserved for
    // a withdrawal cannot also pay for this order (see usdSpendStatement).
    stmts.push(
      usdSpendStatement(c.env.DB, {
        txId: `wtx_ord_${orderId}_usd`,
        userId: user.id,
        amountCents: comp.walletUsdCents,
        note: `Wallet payment on order ${orderId}`,
        ref: orderId,
        nowIso: now,
        /**
         * THE DINARS THIS DEBIT WAS QUOTED IN (migration 0108). The order
         * charged `walletApplied` DINARS; the cents above are what that figure
         * floors to. Recording the pair is what makes the balance fall by the
         * figure the customer was shown rather than by its conversion — a
         * wallet filled with 50,000 د.ع and spent on a 50,000 د.ع advance
         * reads zero, not the six-dinar remainder of its own credit.
         *
         * Only when the database can hold it: `readWalletDust` above already
         * probed those columns, so a Worker live ahead of its migration writes
         * the row exactly as it always did instead of aborting a money batch.
         */
        amountIqd: comp.walletLedgerDinars ? comp.walletApplied : null,
        exchangeRateSnapshot: comp.walletLedgerDinars ? comp.exchangeRate : null,
      })
    );
  }

  // §4.3 purchase-points accrual, created PENDING in the SAME transaction that
  // confirms the purchase. purchase_at = `now` — the server instant this batch
  // commits the order (stock reserved, money and points debited). A failed
  // attempt writes nothing, so a cart or an aborted checkout can never start
  // the clock. available_at = purchase_at + 7×24h and never moves afterwards.
  const settledAtPurchase = comp.dueOnDelivery <= 0 && comp.bnplAmount <= 0;
  /**
   * THE AWAIT IS THE POINT. `buildPurchaseAccrualStatements` is synchronous and
   * therefore cannot look up the buyer's subscription, so the plan it returns
   * reports the PRE-multiplier base while the statement it returns writes the
   * multiplied value. Every customer-facing surface reads the ROW and was
   * always right; the `order.create` audit record below reads this plan, and
   * said 750 for a PRO purchase that accrued 1,500.
   *
   * Nobody was short-changed, which is why it survived. But the audit log is
   * where a points dispute is settled — an admin asked why a member holds
   * 1,500 points reads the record of the purchase — and it disagreed with the
   * ledger by a factor of two on every subscriber order. `buildPurchaseAccrual`
   * resolves the tier first, so the plan states what was really written.
   */
  const { statements: accrualStmts, accrual } = await buildPurchaseAccrual(c.env, {
    orderId,
    userId: user.id,
    purchaseAt: now,
    netEligibleIqd: comp.netEligible,
    rule: comp.pointsRule,
    settledAtPurchase,
  });
  stmts.push(...accrualStmts);

  // A FULLY PREPAID ORDER IS PAID THE INSTANT IT EXISTS — its purchase
  // settlement is written in this very batch — so a reveal-at-`'paid'` offer
  // is stamped here rather than waiting for a collection that will never be
  // recorded. It rides after the allocation INSERTs, in the same transaction,
  // so it can never stamp a row that did not commit.
  if (comp.allocate && settledAtPurchase) {
    const stamp = revealStampStatement(c.env.DB, orderId, ['paid'], now);
    if (stamp) stmts.push(stamp);
  }

  // §11.5 settlement ledger: what was actually PREPAID at purchase. A COD
  // balance is recorded as outstanding, never as collected — the order is
  // "paid" only when a collection is recorded later.
  stmts.push(
    ...buildSettlementStatements(c.env, orderId, {
      kind: 'prepaid_at_purchase',
      amountIqd: comp.walletApplied,
      eventKey: 'purchase',
      note: settledAtPurchase
        ? 'Paid in full at purchase'
        : comp.bnplAmount > 0
          ? 'Wallet portion collected; remaining balance financed by BNPL'
          : 'Advance paid at purchase; balance due on delivery',
      recordedBy: 'system',
      settledAt: now,
    })
  );

  // Remove the purchased lines from the cart.
  for (const it of comp.lines) {
    stmts.push(c.env.DB.prepare('DELETE FROM cart_items WHERE id = ? AND user_id = ?').bind(it.cart_item_id, user.id));
  }

  // §7 stock: RESERVE and DEDUCT are planned here and appended to THIS batch,
  // so the order and its stock movement commit or roll back together. The
  // ledger's UNIQUE idempotency_key is keyed on the order id, so a retried
  // checkout — the same idempotency key, the same order id — plans zero
  // statements and cannot deduct a second time.
  const stockMoves: StockMove[] = comp.lines
    .filter((it) => it.stock_targets.length > 0)
    .map((it) => ({
      product_id: it.product_id,
      qty: it.qty,
      line_id: it.id,
      targets: it.stock_targets,
      // §8.2 row 10: this move's `InventoryChanged` names the drawn product,
      // as it must, but not the order it belongs to — otherwise one join
      // against `OrderCreated` hands a bus consumer exactly the per-order fact
      // row 9 withheld.
      mystery: !!it.mystery_spool,
    }));
  /** The `InventoryChanged` ids this batch commits, delivered with the order's. */
  const inventoryEventIds: string[] = [];
  let plannedReserveRows = 0;
  if (stockMoves.length > 0) {
    const reservePlan = await planInventory(c.env.DB, stockMoves, {
      kind: 'reserve',
      operationId: orderId,
      orderId,
      actorUserId: user.id,
      reason: 'checkout',
    });
    if (reservePlan.rejected.length > 0) {
      throw badRequest(
        'A stock level changed while you were checking out. Please review your cart and try again.',
        'CONFLICT_RETRY'
      );
    }
    // Only a HOLD is taken here. §7 puts the real decrement at confirmation
    // and the return at cancellation, so an order that is never confirmed
    // frees its units instead of permanently consuming them.
    stmts.push(...reservePlan.statements);
    inventoryEventIds.push(...reservePlan.eventIds);
    plannedReserveRows = reservePlan.plannedLedgerRows;
  }
  // THE RESERVATION FENCE (§3.3) — the last inventory statement of the batch,
  // for EVERY order, not only one holding a bundle. `planInventory`'s guards
  // are conditional: one that stops holding between the plan-time read and the
  // commit matches zero rows and the batch still commits, leaving an order
  // whose stock was never held. The fence counts the ledger rows this batch
  // actually wrote and its CHECK rolls everything back — order, wallet spend,
  // points and all — when the count is short. A line with nothing to reserve
  // (a pre-order, an untracked product) fences at expected = 0, which passes.
  stmts.push(reservationFenceStatement(c.env.DB, orderId, 'reserve', plannedReserveRows));

  // `OrderCreated` (03-EVENTS.md §3.7) — the outbox row rides in the ORDER'S
  // OWN BATCH, so the event exists if and only if the order does. References
  // only: no commission, no platform fee, no receivable, no address (its id),
  // no admin note. Returns null while the bus is off, and then this batch is
  // exactly the batch it is today.
  const orderEvent = await outboxStatement(
    c.env.DB,
    OrderCreatedV1,
    {
      order_id: orderId,
      user_id: user.id,
      user_hash: await dailyUserHash(user.id),
      seller_type: 'platform',
      merchant_id: null,
      store_id: null,
      payment_state: comp.bnplAmount > 0 ? 'financed' : comp.walletUsdCents > 0 ? 'authorized' : 'cod',
      // WHAT THE DATABASE WILL HOLD, not what the cart computed (§7.7). The
      // NULL a mystery spool's row is bound with is applied here through the
      // SAME helper the INSERT above uses, so the bus can never publish a
      // drawn product id the `order_items` row does not carry — and the event
      // can never silently vanish, which is what binding a bare null against
      // the old non-nullable `orderItemRef` would have caused.
      items: comp.lines.map((l) => persistedItemRef(l, comp.lines)),
      totals: {
        merchandise_iqd: Math.max(0, comp.merchandise),
        delivery_iqd: Math.max(0, shippingTotal),
        discount_iqd: Math.max(0, comp.couponDiscount + comp.pointsDiscount),
        total_iqd: Math.max(0, comp.totalIqd),
      },
      payment: {
        method: eventPaymentMethod(input.paymentMethodId),
        wallet_usd_cents: Math.max(0, comp.walletUsdCents),
        points: Math.max(0, comp.pointsDiscount),
        cod_iqd: Math.max(0, comp.dueOnDelivery),
        exchange_rate: comp.exchangeRate,
      },
      shipping_type: orderShippingType,
      address_snapshot_ref: String((comp.address as { id?: unknown }).id ?? input.addressId ?? orderId),
      coupon_code: comp.couponId ? String(comp.couponId) : null,
      membership_gift: membershipGift !== '',
      referral_delivery_waived: referralWaived === 1,
      idempotency_key: idempotencyKey,
      created_at: now,
    },
    { aggregateId: orderId, actorId: user.id, aggregateSeq: 1 }
  );
  if (orderEvent) stmts.push(orderEvent.statement);

  try {
    await c.env.DB.batch(stmts);
  } catch (e) {
    if (isPolicyAcceptanceConflict(e)) {
      throw badRequest('Policies changed; reload and review them again', 'POLICY_ACCEPTANCE_REQUIRED');
    }
    const msg = e instanceof Error ? e.message : String(e);
    // The ORDERS key, and nothing else. `inventory_ledger.idempotency_key` is
    // in this very batch (the reservation rows) and is also globally UNIQUE,
    // so a bare `includes('idempotency_key')` catches a concurrent stock loss
    // — which this route deliberately answers with CONFLICT_RETRY — and would
    // report it as key reuse. Both order messages name the table: the legacy
    // column raises `orders.idempotency_key`, the per-user index raises
    // `orders.user_id, orders.client_idempotency_key`.
    if (msg.includes('UNIQUE') && (msg.includes('orders.idempotency_key') || msg.includes('orders.client_idempotency_key'))) {
      const replay = await c.env.DB.prepare(
        'SELECT id FROM orders WHERE user_id = ?1 AND (client_idempotency_key = ?2 OR idempotency_key = ?2)'
      )
        .bind(user.id, idempotencyKey)
        .first<{ id: string }>();
      if (replay) {
        const d = (await loadOrder(c.env.DB, replay.id))!;
        const snaps = await getOrderPointsSnapshots(c.env, [replay.id]);
        return c.json({
          success: true,
          order: orderPublic(d.order, d.items, snaps.get(replay.id), await mysteryViewFor(c.env.DB, [replay.id], 'customer', langOf(c))),
          replay: true,
        });
      }
      // The orders key collided and this user has no such order. Before 0064
      // that meant another account had spent the key and the request fell
      // through to a generic "please try again" it could never escape. It
      // should now be unreachable — which is exactly why it says so out loud
      // instead of hiding in the generic branch.
      throw conflict(
        'This checkout key was already used. Start the checkout again.',
        'IDEMPOTENCY_KEY_REUSED'
      );
    }
    if (msg.includes('COUPON_PER_USER_LIMIT')) {
      throw badRequest('Coupon could not be applied (PER_USER_LIMIT_REACHED)', 'PER_USER_LIMIT_REACHED');
    }
    if (msg.includes('COUPON_GLOBAL_LIMIT')) {
      throw badRequest('Coupon could not be applied (GLOBAL_LIMIT_REACHED)', 'GLOBAL_LIMIT_REACHED');
    }
    // The offer limits of §1.8. The read-time count is advice; this trigger is
    // the decision, and its ABORT rolls the whole checkout back — the same
    // two-layer contract the coupon limits above already follow.
    if (msg.includes('OFFER_PER_USER_LIMIT')) {
      throw badRequest('You have already used this offer the maximum number of times (PER_USER_LIMIT_REACHED)', 'PER_USER_LIMIT_REACHED');
    }
    if (msg.includes('OFFER_GLOBAL_LIMIT')) {
      throw badRequest('This offer has reached its limit (GLOBAL_LIMIT_REACHED)', 'GLOBAL_LIMIT_REACHED');
    }
    for (const [internalCode, publicCode] of [
      ['BNPL_PRO_REQUIRED', 'PRO_REQUIRED'],
      ['BNPL_RESTRICTED', 'BNPL_RESTRICTED'],
      ['BNPL_NOT_APPROVED', 'BNPL_NOT_APPROVED'],
      ['BNPL_IDENTITY_REQUIRED', 'IDENTITY_VERIFICATION_REQUIRED'],
      ['BNPL_APPROVED_ADDRESS_REQUIRED', 'APPROVED_ADDRESS_REQUIRED'],
      ['BNPL_LIMIT_EXCEEDED', 'BNPL_LIMIT_EXCEEDED'],
    ] as const) {
      if (msg.includes(internalCode)) {
        throw badRequest('BNPL eligibility changed. Please review checkout.', publicCode);
      }
    }
    if (msg.includes('CHECK')) {
      throw badRequest('Order could not be placed: a balance or stock level changed. Please review your cart and try again.', 'CONFLICT_RETRY');
    }
    console.error('Order batch failed', msg);
    /**
     * A DEPLOYMENT AHEAD OF ITS DATABASE IS NOT THE CUSTOMER'S MISTAKE.
     *
     * Everything above this line is a 4xx because the customer can act on it:
     * review the cart, top up, choose another address. A missing table or
     * column is not in that class — no amount of retrying will add a column —
     * and answering "please try again" for it sends the one person who can
     * see the problem away, while the storefront around the checkout still
     * looks perfectly healthy. Migration 0076 produces exactly this state:
     * home, catalogue, cart and quote all answer 200, and not one order can
     * be placed.
     *
     * SERVICE_SETUP says so honestly, and src/components/ui/AsyncStates.tsx
     * renders it as «جزء من المتجر قيد التجهيز — إعادة المحاولة لن تفيد قبل
     * اكتماله». The 503 is deliberate: it is the shop's fault, not the
     * shopper's, and it is temporary.
     */
    if (isSchemaMissing(e)) {
      throw unavailable(
        'Checkout is unavailable while the shop finishes setting up. This is not a problem with your cart.',
        'SERVICE_SETUP'
      );
    }
    throw badRequest('Order could not be placed. Please try again.');
  }

  // Delivered after the response, and only the ids this request just wrote:
  // no lock and no "select everything pending" on the shared database.
  //
  // EVERY id, not only the order's. The same batch committed the reservation's
  // `InventoryChanged` rows; handing the pump one of the two left the stock
  // facts waiting for the cron — the highest-volume event in the system taking
  // up to fifteen minutes while the order event beside it went at once.
  pumpAfter(c.env.DB, [orderEvent?.eventId, ...inventoryEventIds], waitUntilFrom(c));

  // The order takes on its tracking stage the moment it exists. Deliberately
  // AFTER the batch, not inside it: the first stage's successor is manual
  // (an admin confirms), so nothing is scheduled yet and a failure here costs
  // the history row, not the order. Never fatal to a checkout that already
  // committed — reporting "order failed" for an order that exists would be
  // the worse lie.
  try {
    await initOrderStage(c.env, orderId, orderShippingType, now);
  } catch (e) {
    console.error('stage init failed for order', orderId, e);
  }

  await audit(c.env.DB, user.id, 'order.create', orderId, {
    total_iqd: comp.totalIqd, wallet_applied_iqd: comp.walletApplied, points: comp.pointsDiscount,
    payment: input.paymentMethodId, coupon_iqd: comp.couponDiscount,
    // Which availability rule priced the lines, beside the journey they are
    // on: a pre-order paid cash on delivery reads 'direct' + 'preorder_*';
    // one the wallet settled in full reads 'preorder' + prepaid_by_wallet.
    pricing_basis: comp.pricingBasis, shipping_type: orderShippingType,
    prepaid_by_wallet: comp.prepaidByWallet,
    tier: comp.tierStatus.active ? comp.tierStatus.tier : 'free',
    pro_context: comp.proContext, at_approved_default: comp.atApprovedDefault,
    shipping_iqd: shippingTotal, delivery_waived: deliveryWaived,
    cod_tax_iqd: comp.codTaxIqd,
    merchandise_iqd: comp.merchandise, points_eligible_iqd: comp.netEligible,
    points_pending: accrual.points, points_rule: comp.pointsRule.version,
    points_available_at: accrual.available_at, settled_at_purchase: settledAtPurchase,
    bnpl_iqd: comp.bnplAmount, bnpl_due_at: comp.bnplDueAt,
    fulfillment_service: fulfillmentService, priority_due_at: comp.priorityDelivery.due_at,
    support_referrer: comp.supportSnapshot?.referrer_user_id ?? null,
  });

  // Invoice (§3D): created after the order stands; createInvoiceForOrder
  // NEVER throws — a failed invoice never undoes a valid purchase, and an
  // admin retry can re-issue it (idempotent per order+revision).
  const invoice = await createInvoiceForOrder(c.env, orderId);

  /*
   * THE PRINTER GIFT MEMBERSHIP IS NOT GRANTED HERE ANY MORE. Owner's
   * decision: «الهديه تعطى يدويا وليس تلقائيا».
   *
   * This door was the worse of the two: `milestone: 'paid'` fires the instant
   * the order ROW is written, which for cash on delivery is before a single
   * dinar has been collected — and nothing revoked the membership if the order
   * was then cancelled. A customer could place a printer order, cancel it, and
   * keep a live PRO or PLUS row that every benefit in the shop then honoured.
   * That is the other half of «المستخدم لم يكن مشتركا بالاشتراك البرو وقد حصل
   * على خصم»: by the ledger he WAS subscribed, and nobody had decided it.
   *
   * The gift now goes through a person. `POST /api/memberships/admin/grant`
   * already grants any plan to any account, the admin screen already calls it
   * (src/components/adminMemberships/actions.tsx), and an administrator can
   * see the order before deciding. `grantPrinterGiftIfEligible` stays in
   * worker/lib/membershipOps.ts with its idempotency intact so a manual path
   * can still use it; nothing calls it on a schedule.
   */
  // The CUSTOMER hears about their own order too — email, WhatsApp and
  // Telegram, on whichever of the three can reach them. Until this line the
  // only party told an order existed was the admin group below.
  c.executionCtx.waitUntil(notifyOrderPlaced(c.env, orderId));
  /**
   * THE GROUP HEARS ABOUT IT IN THE QUEUE THE ORDER ACTUALLY BELONGS TO.
   *
   * This passed the flat literal `'orders'`, and that one word defeated the
   * whole reason the owner split the topic in two. The group has «📝 Orders
   * pre-order» and «📝 Orders direct», never a single «Orders»: while the old
   * `orders` binding survives, every pre-order and every same-day sale piled
   * into one thread; the moment that legacy row goes away the fallback chain
   * (`orders → orders_direct`) files EVERY order as a direct sale. Either way
   * the highest-volume notification on the platform was the one event the
   * split never applied to — a shipment six weeks out sitting in the queue the
   * owner scans for what to print this morning.
   *
   * `orderShippingType` is the value this handler already priced the cart with
   * (line 3326), so the topic cannot disagree with the order; `orderTopic`
   * derives the answer from the shared `isPreorder`, never a second copy of it.
   *
   * `announceAfterResponse` rather than a bare `waitUntil(notifyAdminTopic(…))`:
   * the router reads D1 twice before it reaches Telegram and a D1 error there
   * is a REJECTED promise, not the returned miss this call site assumed — an
   * unhandled rejection riding on the request of a customer who has just paid.
   * The wrapper cannot reject.
   *
   * AND THE TEXT IS NO LONGER WRITTEN HERE. It used to be one English template
   * literal on this line carrying seven facts — a username, a COUNT of items, a
   * total — so the owner learned that an order existed and nothing about what
   * was in it, and opened the admin panel every time to find out. The builder
   * lives in adminTopicRouting.ts beside the routing policy it belongs to, is
   * written in Arabic for the group that reads it, and is fed ONLY values this
   * handler has already computed and validated: `comp.lines` carry the product
   * names, the resolved «option / colour» text and the per-line money, and
   * `comp.address` is the row this checkout already read. Nothing here queries.
   *
   * `comp.address.address` — the street line — is deliberately NOT passed, and
   * the builder does not accept it: see the privacy contract in the header of
   * adminTopicRouting.ts for exactly what this message may say about a person —
   * name, MASKED phone, governorate/area/landmark — and why the door is not on
   * that list.
   */
  announceAfterResponse(
    c,
    orderTopic(orderShippingType),
    orderAnnouncement({
      orderId,
      customerName: user.name || user.username || `#${user.id}`,
      phone: comp.address?.phone,
      governorate: comp.address?.governorate,
      area: comp.address?.area,
      landmark: comp.address?.landmark,
      shippingType: orderShippingType,
      paymentMethodId: input.paymentMethodId,
      fulfilmentService: fulfillmentService,
      totalIqd: comp.totalIqd,
      bnplIqd: comp.bnplAmount,
      bnplDueAt: comp.bnplDueAt,
      dueOnDeliveryIqd: comp.dueOnDelivery,
      lines: comp.lines,
    })
  );
  const data = (await loadOrder(c.env.DB, orderId))!;
  const snaps = await getOrderPointsSnapshots(c.env, [orderId]);
  return c.json({
    success: true,
    order: orderPublic(data.order, data.items, snaps.get(orderId), await mysteryViewFor(c.env.DB, [orderId], 'customer', langOf(c))),
    invoice_no: invoice?.invoiceNo ?? null,
    shipping_quote: comp.shipping,
  });
});

orderRoutes.get('/:id', async (c) => {
  const user = c.get('user')!;
  const id = c.req.param('id');
  const data = await loadOrder(c.env.DB, id);
  if (!data || (data.order.user_id !== user.id && user.role !== 'admin')) throw notFound('Order not found');
  const snaps = await getOrderPointsSnapshots(c.env, [id]);
  // The LATEST revision: a corrected invoice supersedes the one before it,
  // and the customer prints the document that is currently true.
  const invoice = await c.env.DB.prepare(
    'SELECT id, invoice_no, revision, payment_status FROM invoices WHERE order_id = ? ORDER BY revision DESC LIMIT 1'
  )
    .bind(id)
    .first<{ id: string; invoice_no: string; revision: number; payment_status: string }>();
  const status = String(data.order.status);
  return c.json({
    success: true,
    order: {
      ...orderPublic(data.order, data.items, snaps.get(id), await mysteryViewFor(c.env.DB, [id], 'customer', langOf(c))),
      item_count: itemCount(data.items),
      invoice: invoice ?? null,
      // The three verbs the detail screen offers, decided here so the page
      // never has to know which statuses permit which.
      can_cancel: status === 'pending',
      can_review: status === 'delivered',
      /**
       * The day picker, as a whole answer rather than a boolean: which days
       * may be picked, which one is picked, where the ceiling is, and — when
       * none of it applies — WHY. A disabled control with no sentence beside
       * it is a support ticket.
       */
      delivery_date: deliveryDateVerb(
        data.order,
        await getSetting(c.env.DB, 'deliveryDayPolicy'),
        Date.now(),
        langOf(c)
      ),
    },
  });
});

/**
 * «يستطيع اختيار وتغيير يوم التوصيل في أي وقت يريد» — the customer moves their
 * own delivery day, or clears it back to "as soon as possible" with `null`.
 *
 * THE OWNER BOUND THE DESTINATION, NOT THE COUNT. «في أي وقت يريد» is the
 * whole instruction, so there is no quota here — every legal day inside the
 * frozen ceiling is reachable however many times the customer changes their
 * mind. `delivery_day_changes` is still incremented, because the first
 * question asked about an order the courier keeps missing is how often the day
 * moved, and a single `changed_at` cannot answer it.
 *
 * REFUSED ONCE THE PARCEL EXISTS, and that is a hard boundary rather than a
 * courtesy: `DeliveryDriver` has `listStatuses`, `createShipment` and
 * `getShipment`, and NO `updateShipment`. A day accepted after the shipment is
 * created would live on our screen and nowhere else.
 */
orderRoutes.patch('/:id/delivery-date', async (c) => {
  const user = c.get('user')!;
  const id = c.req.param('id');
  await rateLimit(c, 'order_delivery_date', 30, 300);

  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  // `null` CLEARS the day — the customer changing their mind back to "as soon
  // as possible" is a change like any other, not a missing field. `undefined`
  // is the missing field, and it is refused rather than read as a clear.
  const raw = body.date;
  if (raw !== null && typeof raw !== 'string') {
    throw badRequest('date must be a day as YYYY-MM-DD, or null to clear it.', 'DELIVERY_DAY_INVALID');
  }
  const requested = raw === null ? '' : str(raw, 'date', { max: 10, required: false });

  const order = await c.env.DB.prepare('SELECT * FROM orders WHERE id = ?')
    .bind(id)
    .first<Record<string, unknown>>();
  // OWNER ONLY, and 404 for everyone else — the same answer the cancel route
  // gives, so nobody learns an order exists by trying to reschedule it. An
  // admin does not get a back door here either: an admin changing a customer's
  // promised day is a support action with its own audit trail, not this route.
  if (!order || String(order.user_id) !== user.id) throw notFound('Order not found');

  const policy = await getSetting(c.env.DB, 'deliveryDayPolicy');
  const lang = langOf(c);
  const verb = deliveryDateVerb(order, policy, Date.now(), lang);
  if (!verb.can_change) {
    // The refusal carries the same vocabulary GET /:id reports, so the screen
    // that drew the picker and the error that closed it say the same word.
    throw conflict(
      'The delivery day for this order can no longer be changed.',
      `DELIVERY_DAY_${verb.reason ?? 'WINDOW_CLOSED'}`
    );
  }
  if (requested) {
    refuseUnlessOffered(requested, baghdadDay(Date.now()), verb.window_end ?? '', verb.days.map((d) => d.day));
  }

  const now = new Date().toISOString();
  /**
   * FENCED ON EVERYTHING THE VERB ABOVE WAS DECIDED FROM.
   * `POST /api/admin/orders/:id/delivery` can create the courier shipment in
   * the same second this request read the row, and an unfenced UPDATE would
   * write a day onto a parcel that is already on a waybill — the one outcome
   * the refusal above exists to prevent. Zero changes is not silence: it is
   * reported as a race, in words the customer can act on.
   */
  const res = await c.env.DB.prepare(
    `UPDATE orders
        SET delivery_due_day = ?, delivery_day_source = ?, delivery_day_changed_at = ?,
            delivery_day_changes = delivery_day_changes + 1,
            updated_at = ?
      WHERE id = ? AND delivery_day_schedulable = 1 AND delivery_remote_id = ''
        AND stage = ? AND status NOT IN ('delivered','cancelled')`
  )
    // The stage bound is the COLUMN as it was read, not the defaulted reading
    // of it — a fence that quietly substitutes a value is not fencing on what
    // it saw.
    .bind(
      requested || null, requested ? 'customer' : '', now, now,
      id, String(order.stage ?? '')
    )
    .run();
  if ((res as unknown as { meta: { changes: number } }).meta.changes === 0) {
    throw conflict(
      'This order moved while you were choosing — please reopen it and try again.',
      'DELIVERY_DAY_RACED'
    );
  }

  await audit(c.env.DB, user.id, 'order.delivery_date', id, {
    from: order.delivery_due_day ?? null,
    to: requested || null,
    // The running total AFTER this change — the number a support agent reads
    // when a customer says the courier keeps missing them.
    changes: (Number(order.delivery_day_changes) || 0) + 1,
    window_end: verb.window_end,
  });

  const after = await c.env.DB.prepare('SELECT * FROM orders WHERE id = ?')
    .bind(id)
    .first<Record<string, unknown>>();
  return c.json({
    success: true,
    delivery_date: deliveryDateVerb(after ?? order, policy, Date.now(), lang),
  });
});

interface OrderUnitRow extends Record<string, unknown> {
  id: string;
  order_item_id: string;
  unit_index: number;
  product_id: string | null;
  delivered_at: string | null;
  warranty_start_at: string | null;
  warranty_end_at: string | null;
  replaced_by_unit_id: string | null;
  serial_raw: string | null;
  reg_user_id: string | null;
  receipt_no: string | null;
  name_snapshot: string | null;
  image_snapshot: string | null;
  slug: string | null;
  p_name: string | null;
  p_name_ar: string | null;
}

/**
 * The serialized devices inside ONE order, as the customer may see them.
 *
 * Owner or admin, 404 otherwise — the same answer as GET /:id, so nobody
 * learns an order exists by asking for its units. The serial is MASKED to
 * its last four characters; the full value is on the paper receipt and in
 * the admin's screen, not in a customer payload that ends up in a screenshot.
 *
 * `linked` says whether the buyer's own account holds the device, another
 * account does, or nobody does yet — and says nothing else. Which other
 * account is never revealed (deviceOps §4).
 */
orderRoutes.get('/:id/units', async (c) => {
  const user = c.get('user')!;
  const id = c.req.param('id');
  const order = await c.env.DB.prepare('SELECT id, user_id FROM orders WHERE id = ?')
    .bind(id)
    .first<{ id: string; user_id: string }>();
  if (!order || (order.user_id !== user.id && user.role !== 'admin')) throw notFound('Order not found');

  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.order_item_id, u.unit_index, u.product_id, u.delivered_at, u.warranty_start_at,
            u.warranty_end_at, u.replaced_by_unit_id,
            s.serial_raw, r.user_id AS reg_user_id, wr.receipt_no,
            oi.name_snapshot, oi.image_snapshot,
            p.slug, p.name AS p_name, p.name_ar AS p_name_ar
       FROM order_item_units u
       LEFT JOIN device_serials s ON s.unit_id = u.id
       LEFT JOIN device_registrations r ON r.unit_id = u.id AND r.revoked_at IS NULL
       LEFT JOIN warranty_receipts wr ON wr.unit_id = u.id AND wr.status = 'active'
       LEFT JOIN order_items oi ON oi.id = u.order_item_id
       LEFT JOIN products p ON p.id = u.product_id
      WHERE u.order_id = ?
      ORDER BY u.order_item_id, u.unit_index`
  )
    .bind(id)
    .all<OrderUnitRow>();

  const units = results.map((r) => {
    const cov = coverageState(r.delivered_at, r.warranty_end_at);
    return {
      unit_id: r.id,
      order_item_id: r.order_item_id,
      unit_index: Number(r.unit_index) || 0,
      product: {
        id: r.product_id,
        slug: r.slug ?? null,
        name: String(r.p_name ?? r.name_snapshot ?? ''),
        name_ar: String(r.p_name_ar ?? ''),
        // `image_snapshot` has existed since the initial order schema. An empty
        // string is therefore an authoritative "sold without an image" fact,
        // not permission to read mutable catalogue media later.
        image: String(r.image_snapshot ?? ''),
      },
      serial: r.serial_raw ? maskSerial(r.serial_raw) : null,
      delivered_at: r.delivered_at,
      warranty: {
        start_at: r.warranty_start_at,
        end_at: r.warranty_end_at,
        state: cov.state,
        remaining_days: cov.remaining_days,
      },
      // Relative to the order's OWNER: for the customer that is themselves;
      // for an admin it says whether the buyer linked their own device.
      linked: r.reg_user_id ? (r.reg_user_id === order.user_id ? 'mine' : 'other') : 'none',
      receipt_no: r.receipt_no ?? null,
      // A replaced device's coverage lives on its replacement; the screen
      // offers no "register" for a unit that is no longer the customer's.
      replaced: !!r.replaced_by_unit_id,
    };
  });
  return c.json({ success: true, order_id: id, units });
});

/**
 * The customer's tracker: the whole path their order walks, which stages it
 * has reached, and when.
 *
 * Deliberately separate from the order payload — a customer opening their
 * order list does not need fourteen rows of history for every order, and the
 * list endpoint is already the slowest thing the account screen does.
 *
 * The labels are resolved SERVER-SIDE. The freight stage names the mode
 * ("جارٍ التجهيز للشحن البحري") and the browser would have to hold its own
 * copy of the path to build that, which is one more thing to drift.
 *
 * The courier's internal ids are not here. The tracking number is, because
 * that is the customer's to have; the merchant id and the raw provider status
 * are not.
 */
orderRoutes.get('/:id/tracking', async (c) => {
  const user = c.get('user')!;
  const id = c.req.param('id');
  const lang = ['ar', 'en', 'ckb'].includes(c.req.query('lang') ?? '') ? c.req.query('lang')! : 'ar';
  const row = await c.env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first<Record<string, unknown>>();
  if (!row || (row.user_id !== user.id && user.role !== 'admin')) throw notFound('Order not found');
  const order = stageRowFrom(row);

  const { results: history } = await c.env.DB.prepare(
    'SELECT stage, changed_at FROM order_status_history WHERE order_id = ? ORDER BY changed_at'
  )
    .bind(id)
    .all<{ stage: string; changed_at: string }>();

  return c.json({
    success: true,
    order_id: id,
    shipping_type: order.shipping_type,
    shipping_type_label: SHIPPING_TYPE_LABELS[order.shipping_type][lang as 'ar' | 'en' | 'ckb'],
    stage: order.stage,
    stage_changed_at: order.stage_changed_at,
    // Only ever non-null when the clock owns the next move. A stage waiting
    // on a person or on the courier promises the customer nothing.
    next_stage_at: order.next_stage_at,
    tracking_no: row.delivery_tracking_no || null,
    steps: stagePath(order.shipping_type, order.stage, history ?? []).map((v) => ({
      stage: v.stage,
      label: stageLabel(v.stage, order.shipping_type, lang),
      reached: v.reached,
      current: v.current,
      at: v.at,
    })),
  });
});

orderRoutes.post('/:id/cancel', async (c) => {
  const user = c.get('user')!;
  const id = c.req.param('id');
  const data = await loadOrder(c.env.DB, id);
  if (!data || data.order.user_id !== user.id) throw notFound('Order not found');
  if (data.order.status !== 'pending') {
    throw badRequest('Only pending orders can be cancelled — please contact support');
  }
  /**
   * A REVEALED MYSTERY ORDER CANNOT BE SELF-CANCELLED (§7.3, §15.3).
   *
   * A reveal-at-`'paid'` offer is bought, revealed, and — without this — could
   * be cancelled and re-rolled until the expensive filament came up. The
   * redemption slot is deliberately NOT freed by a cancellation either (§17
   * decision 4), so the two together close the re-roll: the draw has been
   * shown, and it stands.
   */
  await refuseRevealedCancel(c.env.DB, data.order, data.items);

  const now = new Date().toISOString();
  const walletCents = Number(data.order.wallet_applied_usd_cents) || 0;
  const points = Number(data.order.points_discount_iqd) || 0;
  // §7: the units this order was holding go back through the ledger — a
  // release when it was never confirmed, a restore when it had been. Planned
  // here (reads only) and executed in the batch below.
  const stock = await planOrderReturn(c.env.DB, id, user.id);

  // ONE transaction: the conditional status flip, the stock return, the
  // refund of wallet money and points, the reservation flip and the accrual
  // cancellation (see orderCancelOps). The flip used to be a `.run()` of its
  // own with the refund in a later batch — a failure between the two left a
  // cancelled, unrefunded order that the `status === 'pending'` guard above
  // then refused to retry for ever. Now a lost flip aborts the whole batch
  // (nothing is written), and a transient failure leaves the order pending so
  // the same request can simply be sent again.
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE orders SET status = 'cancelled', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ? AND status = 'pending'`
      ).bind(id),
      ...(stock.plan?.statements ?? []),
      ...(await cancelledOrderRefundStatements(c.env, data.order, 'system', now)),
      bnplCancellationStatement(c.env.DB, user.id, id, now),
    ]);
  } catch (e) {
    // The fence aborts the batch when the flip matched no row — a concurrent
    // cancel or an admin transition won. Anything else is a genuine failure,
    // and the order is untouched: surface it and let the retry work.
    const again = await c.env.DB.prepare('SELECT status FROM orders WHERE id = ?').bind(id).first<{ status: string }>();
    if (again && again.status !== 'pending') throw badRequest('This order was already cancelled or has progressed');
    throw e;
  }
  await audit(c.env.DB, user.id, 'order.cancel', id, {
    refund_usd_cents: walletCents,
    refund_points: points,
    stock_returned: stock.kind,
    stock_rows: stock.plan?.applied ?? 0,
  });
  const after = (await loadOrder(c.env.DB, id))!;
  const snaps = await getOrderPointsSnapshots(c.env, [id]);
  return c.json({
    success: true,
    order: orderPublic(after.order, after.items, snaps.get(id), await mysteryViewFor(c.env.DB, [id], 'customer', langOf(c))),
  });
});

/**
 * Record a payment collection against an order (mandate §11.5 / §4.3).
 *
 * ADMIN ONLY — the route group is auth-gated, so the role is re-checked here
 * server-side; a customer can never mark their own COD as collected.
 *
 * Delivery is NOT collection: this endpoint is the only thing that can settle
 * a COD order, and it is what makes a pending points accrual releasable. A
 * collection recorded on day 9 releases the accrual on day 9 — the seven-day
 * clock started at purchase and is never restarted. Idempotent per
 * (order_id, event_key): a replayed callback or a double-clicked button
 * records exactly one row and moves no money twice.
 */
orderRoutes.post('/:id/settlement', async (c) => {
  const user = c.get('user')!;
  if (user.role !== 'admin') throw notFound('Order not found');
  await rateLimit(c, 'order_settlement', 60, 300);
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));

  const amountIqd = int(body.amountIqd, 'amountIqd', { min: 0, max: 1_000_000_000 });
  const reference = str(body.reference, 'reference', { max: 200, required: false });
  const note = str(body.note, 'note', { max: 300, required: false });
  const kind = body.kind === 'adjustment' ? 'adjustment' : 'cod_collection';
  // The business event key: an explicit reference when the courier supplied
  // one (so the same receipt can never be booked twice), otherwise an
  // explicit client-supplied key. No key = no idempotency, so we require one.
  const eventKey = str(body.eventKey ?? (reference ? `${kind}:${reference}` : ''), 'eventKey', {
    min: 3,
    max: 120,
  });

  const result = await recordOrderSettlement(c.env, id, {
    kind,
    amountIqd,
    eventKey,
    reference,
    note,
    recordedBy: 'admin',
    actorId: user.id,
  });
  if (result.reason === 'order_not_found') throw notFound('Order not found');
  if (result.reason === 'order_cancelled') throw badRequest('A cancelled order cannot record a collection');

  await audit(c.env.DB, user.id, 'order.settlement', id, {
    kind, amount_iqd: amountIqd, event_key: eventKey, reference,
    duplicate: result.duplicate, collected_iqd: result.collected_iqd, fully_settled: result.fully_settled,
  });

  // THE `'paid'` MILESTONE (§8.1). Recording the collection is the only thing
  // that makes a cash-on-delivery order paid, so it is the only thing that can
  // cross this milestone for one. `revealed_at IS NULL` makes it idempotent
  // under a replayed courier callback, and the derivation would answer the
  // same either way — the stamp is what FREEZES it, so a later refund or an
  // edit of the offer cannot un-tell the customer what they bought.
  if (result.fully_settled) {
    const stamp = revealStampStatement(c.env.DB, id, ['paid'], new Date().toISOString());
    if (stamp) await stamp.run();
  }

  // Opportunistic release on the settlement EVENT (a server event, never a
  // page open). Fully idempotent and identical to what the durable job does,
  // so a day-9 collection does not wait for the next cron tick.
  const release = result.fully_settled ? await releaseAccrualForOrder(c.env, id) : null;

  const data = (await loadOrder(c.env.DB, id))!;
  const snaps = await getOrderPointsSnapshots(c.env, [id]);
  return c.json({
    success: true,
    settlement: {
      recorded: result.recorded,
      duplicate: result.duplicate,
      collected_iqd: result.collected_iqd,
      total_iqd: result.total_iqd,
      outstanding_iqd: Math.max(0, result.total_iqd - result.collected_iqd),
      fully_settled: result.fully_settled,
    },
    points_released: release ? { released: release.awarded, points: release.points, reason: release.reason ?? null } : null,
    order: orderPublic(data.order, data.items, snaps.get(id), await mysteryViewFor(c.env.DB, [id], 'customer', langOf(c))),
  });
});
