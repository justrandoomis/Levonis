import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext, SessionUser } from '../lib/types';
import { safeParse } from '../lib/types';
import { requireAuth, badRequest, notFound, str, int } from '../lib/http';
import { newId, newOrderId } from '../lib/crypto';
import { getSettings } from '../lib/settings';
import type { DeliveryMethod, CheckoutPaymentMethod } from '../lib/settings';
import { resolveCartLine, pricingContextFrom, publicBreakdown, selectionFromCartRow } from './cart';
import { EMPTY_RELATIONS, loadRelationsViews, snapshotFrom } from '../lib/productOverlay';
import { planInventory, resolveStock } from '../lib/inventory';
import { returnOrderStock } from '../lib/orderInventory';
import type { StockMove, StockTarget } from '../lib/inventory';
import { getTierStatus, preorderGiftFor } from '../lib/entitlements';
import type { PreorderGiftConfig, TierStatus } from '../lib/entitlements';
import {
  referralFreeDeliveryApplies,
  validateCoupon,
  grantPrinterGiftIfEligible,
} from '../lib/membershipOps';
import { getAvailableBalances, usdSpendStatement } from '../lib/walletOps';
import { buildSupportSnapshot } from '../lib/supportCode';
import {
  eligibleMerchandiseIqd,
  netEligibleIqd,
  pointsForEligibleIqd,
  capRedeemablePoints,
  resolvePointsRule,
  getPointsRuleConfig,
  buildPurchaseAccrualStatements,
  buildSettlementStatements,
  cancelPendingAccrualStatement,
  recordOrderSettlement,
  releaseAccrualForOrder,
  getOrderPointsSnapshots,
} from '../lib/pointsOps';
import type { PointsRule, OrderPointsSnapshot } from '../lib/pointsOps';
import { audit } from '../lib/audit';
import { rateLimit } from '../lib/ratelimit';
import { notifyAdmins } from '../lib/telegram';
import { quoteShipping } from '../lib/shipping';
import type { ShippingConfig, ShippingItem, ShippingQuote } from '../lib/shipping';
import { getRequiredCheckoutPolicies, verifyAndRecordAcceptance } from '../lib/policyOps';
import { typeForTransport, SHIPPING_TYPE_LABELS } from '../lib/shippingType';
import { initOrderStage, stagePath, stageRowFrom } from '../lib/orderStageOps';
import { stageLabel } from '../lib/orderStages';
import type { ShippingType } from '../lib/shippingType';
import type { PolicyRef } from '../lib/policyOps';
import { createInvoiceForOrder } from '../lib/invoices';
import { normalizePhone } from '../lib/phone';

export const orderRoutes = new Hono<AppContext>();
orderRoutes.use('*', requireAuth);

/** IQD -> USD cents, rounded up so the wallet never undercharges. */
function iqdToUsdCents(iqd: number, rate: number): number {
  return Math.ceil((iqd * 100) / rate);
}

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
  const total = Number(o.total_iqd) || 0;
  const due = Number(o.due_on_delivery_iqd) || 0;
  const collected = snap ? snap.collected_iqd : null;
  const paid = collected === null ? walletIqd : collected;
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
    delivery_waived: !!o.delivery_waived,
    total_iqd: total,
    // Payment means, with its ledger reference.
    wallet_applied_iqd: walletIqd,
    wallet_tx_id: walletIqd > 0 ? `wtx_ord_${String(o.id)}_usd` : null,
    points_tx_id: pointsUsed > 0 ? `wtx_ord_${String(o.id)}_pts` : null,
    due_on_delivery_iqd: due,
    collected_iqd: collected,
    outstanding_iqd: collected === null ? due : outstanding,
    payment_state: outstanding <= 0 && (collected !== null || due <= 0) ? 'paid' : paid > 0 ? 'partial' : 'cod_due',
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

export function orderPublic(
  o: Record<string, unknown>,
  items: Record<string, unknown>[],
  snap?: OrderPointsSnapshot
) {
  const coupon = safeParse<Record<string, unknown> | null>(o.coupon_snapshot, null);
  return {
    id: o.id,
    status: o.status,
    /** §1: which of the four journeys this order is on. */
    shipping_type: typeForTransport(
      String(o.shipping_type ?? '').startsWith('preorder_')
        ? String(o.shipping_type).slice('preorder_'.length)
        : ''
    ),
    /** §2/§3: where the order stands on that journey, and when it moved. */
    stage: String(o.stage || 'received'),
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
    subtotal_iqd: o.subtotal_iqd,
    shipping_iqd: o.shipping_iqd,
    delivery_waived: !!o.delivery_waived,
    membership_tier_snapshot: o.membership_tier_snapshot ?? 'free',
    priority: Number(o.priority) || 0,
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
    items: items.map((it) => ({
      id: it.id,
      product_id: it.product_id,
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
    })),
  };
}

async function loadOrder(db: D1Database, orderId: string) {
  const order = await db.prepare('SELECT * FROM orders WHERE id = ?').bind(orderId).first<Record<string, unknown>>();
  if (!order) return null;
  const { results: items } = await db.prepare('SELECT * FROM order_items WHERE order_id = ?').bind(orderId).all();
  return { order, items };
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

/** products.ops_policy facts the shipping engine needs (explicit config only). */
function shippingFactsFrom(opsPolicyRaw: unknown): { size_class: ShippingItem['size_class']; is_spool: boolean } {
  const o = safeParse<Record<string, unknown>>(
    typeof opsPolicyRaw === 'string' ? opsPolicyRaw : JSON.stringify(opsPolicyRaw ?? {}),
    {}
  );
  const sc = o.size_class;
  return {
    size_class: sc === 'printer_small' || sc === 'printer_large' || sc === 'ordinary' ? sc : null,
    is_spool: o.is_spool === true,
  };
}

// -------------------------------------------------- approved PRO address

const collapse = (s: unknown) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

function phoneKey(raw: unknown): string {
  const s = String(raw ?? '');
  return normalizePhone(s) ?? s.replace(/\D+/g, '');
}

/**
 * Is the SELECTED checkout address the customer's current APPROVED default
 * PRO address (approved_addresses, 0003)? Read-only: approval/change flows
 * live in the PRO administration module. Matching normalizes harmless
 * whitespace/case and phone formats — it never mutates anything.
 * No approved row (non-PRO users, or PRO before approval) → false.
 */
async function isApprovedDefaultAddress(
  db: D1Database,
  userId: string,
  address: Record<string, unknown>
): Promise<boolean> {
  const approved = await db
    .prepare(
      `SELECT name, phone_e164, address, landmark FROM approved_addresses
        WHERE user_id = ? AND state = 'approved'
        ORDER BY version DESC LIMIT 1`
    )
    .bind(userId)
    .first<{ name: string; phone_e164: string; address: string; landmark: string }>();
  if (!approved) return false;
  return (
    collapse(address.name) === collapse(approved.name) &&
    collapse(address.address) === collapse(approved.address) &&
    phoneKey(address.phone) === phoneKey(approved.phone_e164)
  );
}

// -------------------------------------------------- shared checkout compute

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
  lines: ComputedLine[];
  productIds: string[];
  subtotal: number; // Σ unit_subtotal × qty (incl. commissions/warranty fees)
  merchandise: number; // Σ applied price × qty (product prices only)
  shipping: ShippingQuote;
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
  requiredAdvance: number;
  totalIqd: number; // payable after coupon+points (before wallet)
  dueOnDelivery: number;
  policies: PolicyRef[];
  printerGiftConfig: unknown;
  preorderGiftConfig: unknown;
}

async function computeCheckout(
  c: Context<AppContext>,
  user: SessionUser,
  input: CheckoutInput
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
  ]);
  const delivery = (settings.checkoutDeliveryMethods as DeliveryMethod[]).find((m) => m.id === input.deliveryMethodId);
  if (!delivery) throw badRequest('Please choose a valid delivery method');
  let payment: CheckoutPaymentMethod | null = null;
  if (input.paymentMethodId) {
    payment = (settings.checkoutPaymentMethods as CheckoutPaymentMethod[]).find((m) => m.id === input.paymentMethodId) ?? null;
    if (!payment) throw badRequest('Please choose a valid payment method');
  }
  const exchangeRate = Number(settings.exchangeRate) || 1400;
  const pricingCtx = pricingContextFrom(settings);
  const shippingConfig = shippingConfigFrom(settings.shippingPolicy);

  // Effective tier from the memberships ledger — never the client, never the
  // legacy users.* cache.
  const tierStatus = await getTierStatus(c.env.DB, user.id);

  // CONFIRMED §6.3: PRO purchase benefits exist only at the single approved
  // default PRO address. At any alternate address the WHOLE checkout context
  // is ordinary (no PRO product prices, no preorder-commission waiver, no
  // shipping waiver, no priority). Returning to the approved address restores
  // benefits automatically — this flag is recomputed per request, never stored.
  const atApprovedDefault =
    tierStatus.tier === 'pro' && tierStatus.active
      ? await isApprovedDefaultAddress(c.env.DB, user.id, address)
      : false;
  // Active restriction cases (§10) pause specific benefits without touching
  // the paid membership. Granularity note: the pricing resolver applies PRO
  // prices and the preorder-commission waiver through one flag, so gating
  // either 'proPricing' or 'noPreorderCommission' pauses that whole pricing
  // context; 'freeDelivery' gates only the shipping waiver below.
  const gatedBenefits = new Set(tierStatus.gated_benefits ?? []);
  const proContext =
    tierStatus.tier === 'pro' && tierStatus.active && atApprovedDefault &&
    !gatedBenefits.has('proPricing') && !gatedBenefits.has('noPreorderCommission');
  const pricingTierActive = tierStatus.tier === 'pro' ? proContext : tierStatus.active;

  // Load and price the cart lines server-side.
  let sql = `SELECT ci.id AS cart_item_id, ci.qty, ci.option_id, ci.option_value_ids, ci.color_id,
                    ci.shipping_method_id, ci.transport_method, ci.warranty_plan_id, p.*
               FROM cart_items ci JOIN products p ON p.id = ci.product_id
              WHERE ci.user_id = ?`;
  const params: unknown[] = [user.id];
  if (input.itemIds.length > 0) {
    sql += ` AND ci.id IN (${input.itemIds.map(() => '?').join(',')})`;
    params.push(...input.itemIds);
  }
  const { results: rows } = await c.env.DB.prepare(sql).bind(...params).all<Record<string, unknown>>();
  if (rows.length === 0) throw badRequest('Your cart is empty');

  // One batched read of every product's relational structure. Options,
  // colours and the authoritative stock level all come from here — checkout
  // and the storefront cannot disagree because they read the same rows.
  const views = await loadRelationsViews(
    c.env.DB,
    rows.map((r) => ({ id: String(r.id), inventory_mode: r.inventory_mode }))
  );

  let subtotal = 0;
  let merchandise = 0;
  const productIds: string[] = [];
  const lines: ComputedLine[] = [];
  const shippingItems: ShippingItem[] = [];
  for (const row of rows) {
    const displayName = String(row.name_ar || row.name);
    if (row.status !== 'active') throw badRequest(`"${displayName}" is no longer available — please remove it from your cart`);
    const view = views.get(String(row.id));
    const sel = selectionFromCartRow(row);
    const { doc, resolved, variantLabel, selectionErrors } = resolveCartLine(
      row,
      sel,
      tierStatus.tier,
      pricingTierActive,
      pricingCtx,
      view
    );
    if (resolved.errors.length > 0) {
      throw badRequest(`"${displayName}": ${resolved.errors.join(', ')}`, 'VALIDATION');
    }
    if (selectionErrors.length > 0) {
      throw badRequest(`"${displayName}": ${selectionErrors.join(', ')}`, 'VALIDATION');
    }
    const qty = Number(row.qty);

    // §7: the ONE authoritative stock level for this exact selection. The base
    // row is not consulted when the product tracks stock elsewhere, so an
    // exhausted colour stops the order even with base stock in hand.
    const snapshot = snapshotFrom(view ?? EMPTY_RELATIONS, {
        stock: doc.stock,
      reserved: Number(row.stock_reserved ?? 0),
      low_stock_threshold: (row.low_stock_threshold as number | null) ?? null,
    });
    const stockRes = resolveStock(snapshot, {
      option_value_ids: sel.optionValueIds ?? [],
      color_id: sel.colorId || null,
    });
    if (stockRes.error === 'VARIANT_NOT_MODELLED') {
      throw badRequest(`"${displayName}": that combination is not available for sale`, 'VARIANT_NOT_MODELLED');
    }
    if (stockRes.available !== null && stockRes.available < qty) {
      throw badRequest(`Only ${stockRes.available} of "${displayName}" left in stock`, 'OUT_OF_STOCK');
    }
    const unit = resolved.unit_subtotal_iqd;
    const line = unit * qty;
    subtotal += line;
    merchandise += resolved.applied_iqd * qty;
    productIds.push(String(row.id));
    const facts = shippingFactsFrom(row.ops_policy);
    shippingItems.push({ product_id: String(row.id), qty, size_class: facts.size_class, is_spool: facts.is_spool });
    // Persisted resolver snapshot: cost fields must NEVER be stored on the
    // order (it is served back to the buyer).
    const { cost_iqd, ...pricingSnapshot } = resolved;
    void cost_iqd;
    lines.push({
      cart_item_id: String(row.cart_item_id),
      id: newId('oi'),
      product_id: String(row.id),
      option_value_ids: sel.optionValueIds ?? [],
      stock_targets: stockRes.targets,
      name: String(row.name),
      name_ar: String(row.name_ar ?? ''),
      image: (doc.media.find((m) => m.primary) ?? doc.media[0])?.url ?? '',
      variant: variantLabel,
      option_id: String(row.option_id ?? ''),
      color_id: String(row.color_id ?? ''),
      shipping_method_id: String(row.shipping_method_id ?? ''),
      qty,
      unit,
      line,
      applied_iqd: resolved.applied_iqd,
      tracked: stockRes.tracked,
      pricing_snapshot: JSON.stringify(pricingSnapshot),
      warranty_snapshot: resolved.warranty ? JSON.stringify(resolved.warranty) : null,
      transport_snapshot: resolved.transport ? JSON.stringify(resolved.transport) : null,
      breakdown: publicBreakdown(resolved),
    });
  }

  // Independent promo path: referral free delivery — a SEPARATE policy from
  // the PRO waiver, passed into the quote so it is never doubled.
  const independentFreeDelivery = await referralFreeDeliveryApplies(c.env, user.id, productIds);

  // Store pickup: no last-mile delivery happens, so no delivery fees at all.
  const isPickup = delivery.id === 'pickup';

  // The selected delivery method's configured price is the ORDINARY tariff
  // for this order (standard = the confirmed 5,000 IQD default); printer and
  // carton components come from the owner-configured shippingPolicy on top.
  const methodOrdinary = Number.isInteger(delivery.price_iqd) && (delivery.price_iqd as number) >= 0
    ? (delivery.price_iqd as number)
    : shippingConfig.ordinary_iqd;
  const configForOrder: ShippingConfig = { ...shippingConfig, ordinary_iqd: methodOrdinary };

  // The delivery benefit can be gated per tier by an active restriction case:
  // PRO's waiver hangs off 'freeDelivery', PRIME's off 'primeDeliveryEligible'.
  const deliveryGate =
    tierStatus.tier === 'prime' ? 'primeDeliveryEligible' : 'freeDelivery';

  /** `primeBasisIqd` is the §5 basis — merchandise after product discounts,
   *  coupons AND points, before delivery — which is a different number from
   *  the PRO rule's configurable basis. */
  const runQuote = (basisIqd: number, primeBasisIqd?: number): ShippingQuote =>
    quoteShipping({
      items: shippingItems,
      merchandiseIqd: basisIqd,
      primeMerchandiseIqd: primeBasisIqd,
      tier: tierStatus.tier,
      tierActive: tierStatus.active && !gatedBenefits.has(deliveryGate),
      atApprovedDefaultAddress: atApprovedDefault,
      independentFreeDelivery,
      // Store pickup has no last mile, so nothing to protect; the flag is
      // dropped rather than charged for a delivery that does not happen.
      protectedDelivery: input.protectedDelivery && !isPickup,
      config: configForOrder,
    });

  const emptyQuote: ShippingQuote = {
    components: [],
    total_iqd: 0,
    total_before_waiver_iqd: 0,
    advance_due_iqd: 0,
    pro_waiver_applied: false,
    prime_waiver_applied: false,
    waiver_source: 'none',
    waiver_basis_iqd: merchandise,
    needs_config: [],
    assumptions: [],
    reasons: ['Store pickup — no delivery fee.'],
  };

  // Pass 1 (before coupon) prices the shipping used to validate the coupon;
  // the FINAL quote then applies the configured threshold basis.
  let shipping = isPickup ? emptyQuote : runQuote(merchandise);

  // Coupon — validated against the honest payable total (subtotal + the
  // delivery actually charged); applied FIRST: coupon, then points, then wallet.
  let couponDiscount = 0;
  let couponId: string | null = null;
  let couponSnapshot: string | null = null;
  if (input.couponCode) {
    const check = await validateCoupon(c.env, user.id, input.couponCode, subtotal + shipping.total_iqd);
    if (!check.ok || !check.coupon_id) {
      const reason = check.reason ?? 'COUPON_INVALID';
      throw badRequest(`Coupon could not be applied (${reason})`, reason);
    }
    couponId = check.coupon_id;
    couponDiscount = Math.max(0, Math.min(Math.floor(Number(check.discount_iqd) || 0), subtotal + shipping.total_iqd));
    couponSnapshot = JSON.stringify({
      coupon_id: check.coupon_id,
      code: check.code ?? input.couponCode.toUpperCase(),
      discount_iqd: couponDiscount,
    });
  }

  // Spendable balances only (mandate §11.1/§4.4: pending deposits and pending
  // points are NEVER spendable). getAvailableBalances is the wallet slice's
  // frozen contract — settled minus active holds/reservations.
  const available = await getAvailableBalances(c.env, user.id);
  const walletBalanceIqd = Math.floor((available.usd_cents_available * exchangeRate) / 100);

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
  const eligibleMerchandise = Math.max(0, merchandise - Math.min(couponDiscount, merchandise));
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
        : merchandise;
    shipping = runQuote(basis, Math.max(0, eligibleMerchandise - pointsDiscount));
  }

  const beforeDiscounts = Math.max(0, subtotal + shipping.total_iqd - couponDiscount);
  const afterPoints = beforeDiscounts - pointsDiscount;

  // §4.2 accrual basis, computed on the ORDER TOTAL (lines summed first, one
  // floor at the end) at the rate in force for THIS purchase instant.
  const ruleConfig = await getPointsRuleConfig(c.env);
  const pointsRule = resolvePointsRule(ruleConfig, new Date().toISOString());
  const netEligible = netEligibleIqd(merchandise, couponDiscount, pointsDiscount);
  const pointsEarnPending = pointsForEligibleIqd(netEligible, pointsRule.iqd_per_point);

  // §3.3 support attribution — resolved server-side, zero monetary effect.
  const supportSnapshot = await buildSupportSnapshot(c.env, user.id, input.supportRef || null);

  // Advance-payment requirements are paid from the wallet. Printer delivery
  // fees are payable in advance (§6.3) on top of the payment method's rule.
  let requiredAdvance = 0;
  if (input.paymentMethodId === 'half_advance') requiredAdvance = Math.ceil(afterPoints / 2);
  if (input.paymentMethodId === 'full_advance' || input.paymentMethodId === 'wallet') requiredAdvance = afterPoints;
  requiredAdvance = Math.min(Math.max(requiredAdvance, shipping.advance_due_iqd), afterPoints);

  let walletApplied = 0;
  if (requiredAdvance > 0 || input.useWallet) {
    walletApplied = Math.min(walletBalanceIqd, afterPoints);
  }
  if (walletApplied < requiredAdvance) {
    throw badRequest('Insufficient wallet balance for the required advance payment', 'INSUFFICIENT_BALANCE');
  }
  const walletUsdCents = walletApplied > 0 ? iqdToUsdCents(walletApplied, exchangeRate) : 0;
  if (walletUsdCents > available.usd_cents_available) {
    // Rounding pushed us past the balance; scale back to what the balance covers.
    walletApplied = Math.floor((available.usd_cents_available * exchangeRate) / 100);
    if (walletApplied < requiredAdvance) throw badRequest('Insufficient wallet balance', 'INSUFFICIENT_BALANCE');
  }
  const finalWalletUsdCents =
    walletApplied > 0 ? Math.min(iqdToUsdCents(walletApplied, exchangeRate), available.usd_cents_available) : 0;
  const dueOnDelivery = afterPoints - walletApplied;

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
    lines,
    productIds,
    subtotal,
    merchandise,
    shipping,
    isPickup,
    independentFreeDelivery,
    couponId,
    couponDiscount,
    couponSnapshot,
    pointsBalance: available.points_available,
    pointsDiscount,
    eligibleMerchandise,
    netEligible,
    pointsRule,
    pointsEarnPending,
    supportSnapshot,
    walletBalanceIqd,
    walletApplied,
    walletUsdCents: finalWalletUsdCents,
    requiredAdvance,
    totalIqd: afterPoints,
    dueOnDelivery,
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
  };
}

// ------------------------------------------------------------------ routes

orderRoutes.get('/', async (c) => {
  const user = c.get('user')!;
  const status = str(c.req.query('status'), 'status', { max: 20, required: false });
  let sql = 'SELECT * FROM orders WHERE user_id = ?';
  const params: unknown[] = [user.id];
  if (status && status !== 'All' && status !== 'null') {
    sql += ' AND status = ?';
    params.push(status.toLowerCase());
  }
  sql += ' ORDER BY created_at DESC LIMIT 100';
  const { results: orders } = await c.env.DB.prepare(sql).bind(...params).all<Record<string, unknown>>();
  // One snapshot query for the whole page — the §5 money view is never
  // recomputed per row, and never in the browser.
  const snaps = await getOrderPointsSnapshots(c.env, orders.map((o) => String(o.id)));
  const out = [];
  for (const o of orders) {
    const { results: items } = await c.env.DB.prepare('SELECT * FROM order_items WHERE order_id = ?')
      .bind(o.id)
      .all();
    out.push(orderPublic(o, items, snaps.get(String(o.id))));
  }
  return c.json({ success: true, orders: out });
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
orderRoutes.post('/quote', async (c) => {
  await rateLimit(c, 'order_quote', 60, 300);
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const input = checkoutInputFrom(body, false);
  const comp = await computeCheckout(c, user, input);

  const blockers: string[] = [];
  if (comp.shipping.needs_config.length > 0) blockers.push('SHIPPING_NEEDS_CONFIG');

  return c.json({
    success: true,
    quote: {
      lines: comp.lines.map((l) => ({
        cart_item_id: l.cart_item_id,
        product_id: l.product_id,
        name: l.name,
        name_ar: l.name_ar,
        variant: l.variant,
        qty: l.qty,
        unit_price_iqd: l.unit,
        line_total_iqd: l.line,
        breakdown: l.breakdown,
      })),
      merchandise_iqd: comp.merchandise,
      subtotal_iqd: comp.subtotal,
      shipping: comp.shipping,
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
  const existing = await c.env.DB.prepare('SELECT id FROM orders WHERE idempotency_key = ? AND user_id = ?')
    .bind(idempotencyKey, user.id)
    .first<{ id: string }>();
  if (existing) {
    const data = (await loadOrder(c.env.DB, existing.id))!;
    const inv = await c.env.DB.prepare('SELECT invoice_no FROM invoices WHERE order_id = ? AND revision = 1')
      .bind(existing.id)
      .first<{ invoice_no: string }>();
    const snaps = await getOrderPointsSnapshots(c.env, [existing.id]);
    return c.json({
      success: true,
      order: orderPublic(data.order, data.items, snaps.get(existing.id)),
      invoice_no: inv?.invoice_no ?? null,
      replay: true,
    });
  }

  const comp = await computeCheckout(c, user, input);

  // Honest blocker (§6.3): an unpriced fee component (printer size mapping /
  // carton fee not configured by the owner yet) can NEVER be silently waived
  // or invented — the order cannot complete until the owner configures it.
  if (comp.shipping.needs_config.length > 0) {
    throw badRequest(
      'Delivery fees for part of this order are not configured yet (printer/carton delivery mapping). Please contact support or try again later.',
      'SHIPPING_NEEDS_CONFIG'
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
  await verifyAndRecordAcceptance(c.env, user.id, `order:${orderId}`, acceptanceList);

  const shippingTotal = comp.shipping.total_iqd;
  const deliveryWaived = comp.shipping.total_iqd < comp.shipping.total_before_waiver_iqd ? 1 : 0;
  // WHICH waiver produced the free delivery is recorded apart from the fact of
  // it: the referral waiver is one-per-friend, and the check that enforces
  // "one" reads this column at the next checkout (referralFreeDeliveryApplies).
  const referralWaived = comp.shipping.waiver_source === 'promotion' ? 1 : 0;
  // PRO priority preparation is a CONTEXTUAL purchase benefit: only in the
  // eligible PRO checkout context (approved default address), and pausable
  // by an active priorityService restriction case (§10).
  const priority =
    comp.proContext && !(comp.tierStatus.gated_benefits ?? []).includes('priorityService') ? 1 : 0;

  // The delivery-method snapshot keeps its original fields (backward
  // compatible) and gains the authoritative shipping quote for transparency.
  const deliverySnapshot = JSON.stringify({ ...comp.delivery, quote: comp.shipping });

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

  const stmts = [
    c.env.DB.prepare(
      `INSERT INTO orders (id, user_id, status, address_snapshot, delivery_method_id, delivery_method_snapshot,
         payment_method_id, subtotal_iqd, shipping_iqd, points_discount_iqd, wallet_applied_iqd,
         wallet_applied_usd_cents, exchange_rate, total_iqd, due_on_delivery_iqd, idempotency_key,
         membership_tier_snapshot, delivery_waived, priority, coupon_snapshot, merchandise_iqd,
         support_snapshot, shipping_type, membership_gift, referral_delivery_waived, created_at, updated_at)
       VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      orderId, user.id, JSON.stringify(comp.address), input.deliveryMethodId, deliverySnapshot,
      input.paymentMethodId, comp.subtotal, shippingTotal, comp.pointsDiscount, comp.walletApplied,
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
      orderShippingType, membershipGift, referralWaived, now, now
    ),
  ];

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

  for (const it of comp.lines) {
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO order_items (id, order_id, product_id, name_snapshot, image_snapshot, option_snapshot,
           option_id, option_value_ids, color_id, shipping_method_id, qty, unit_price_iqd, line_total_iqd,
           pricing_snapshot, warranty_snapshot, transport_snapshot)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        it.id, orderId, it.product_id, it.name, it.image, it.variant,
        it.option_id, JSON.stringify(it.option_value_ids), it.color_id, it.shipping_method_id,
        it.qty, it.unit, it.line,
        it.pricing_snapshot, it.warranty_snapshot, it.transport_snapshot
      )
    );
    // Stock moves through the inventory ledger AFTER this batch commits (see
    // below): it needs its own idempotency-keyed batch so a retry of the whole
    // checkout is a no-op rather than a second deduction.
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
      })
    );
  }

  // §4.3 purchase-points accrual, created PENDING in the SAME transaction that
  // confirms the purchase. purchase_at = `now` — the server instant this batch
  // commits the order (stock reserved, money and points debited). A failed
  // attempt writes nothing, so a cart or an aborted checkout can never start
  // the clock. available_at = purchase_at + 7×24h and never moves afterwards.
  const settledAtPurchase = comp.dueOnDelivery <= 0;
  const { statements: accrualStmts, accrual } = buildPurchaseAccrualStatements(c.env, {
    orderId,
    userId: user.id,
    purchaseAt: now,
    netEligibleIqd: comp.netEligible,
    rule: comp.pointsRule,
    settledAtPurchase,
  });
  stmts.push(...accrualStmts);

  // §11.5 settlement ledger: what was actually PREPAID at purchase. A COD
  // balance is recorded as outstanding, never as collected — the order is
  // "paid" only when a collection is recorded later.
  stmts.push(
    ...buildSettlementStatements(c.env, orderId, {
      kind: 'prepaid_at_purchase',
      amountIqd: comp.walletApplied,
      eventKey: 'purchase',
      note: settledAtPurchase ? 'Paid in full at purchase' : 'Advance paid at purchase; balance due on delivery',
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
    }));
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
  }

  try {
    await c.env.DB.batch(stmts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('UNIQUE') && msg.includes('idempotency_key')) {
      const replay = await c.env.DB.prepare('SELECT id FROM orders WHERE idempotency_key = ? AND user_id = ?')
        .bind(idempotencyKey, user.id)
        .first<{ id: string }>();
      if (replay) {
        const d = (await loadOrder(c.env.DB, replay.id))!;
        const snaps = await getOrderPointsSnapshots(c.env, [replay.id]);
        return c.json({ success: true, order: orderPublic(d.order, d.items, snaps.get(replay.id)), replay: true });
      }
    }
    if (msg.includes('COUPON_PER_USER_LIMIT')) {
      throw badRequest('Coupon could not be applied (PER_USER_LIMIT_REACHED)', 'PER_USER_LIMIT_REACHED');
    }
    if (msg.includes('COUPON_GLOBAL_LIMIT')) {
      throw badRequest('Coupon could not be applied (GLOBAL_LIMIT_REACHED)', 'GLOBAL_LIMIT_REACHED');
    }
    if (msg.includes('CHECK')) {
      throw badRequest('Order could not be placed: a balance or stock level changed. Please review your cart and try again.', 'CONFLICT_RETRY');
    }
    console.error('Order batch failed', msg);
    throw badRequest('Order could not be placed. Please try again.');
  }

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
    tier: comp.tierStatus.active ? comp.tierStatus.tier : 'free',
    pro_context: comp.proContext, at_approved_default: comp.atApprovedDefault,
    shipping_iqd: shippingTotal, delivery_waived: deliveryWaived,
    merchandise_iqd: comp.merchandise, points_eligible_iqd: comp.netEligible,
    points_pending: accrual.points, points_rule: comp.pointsRule.version,
    points_available_at: accrual.available_at, settled_at_purchase: settledAtPurchase,
    support_referrer: comp.supportSnapshot?.referrer_user_id ?? null,
  });

  // Invoice (§3D): created after the order stands; createInvoiceForOrder
  // NEVER throws — a failed invoice never undoes a valid purchase, and an
  // admin retry can re-issue it (idempotent per order+revision).
  const invoice = await createInvoiceForOrder(c.env, orderId);

  // PLUS gift on printer purchase — only when the owner enabled it and set the
  // milestone to the payment event (grant itself is idempotent per order).
  const printerGift = comp.printerGiftConfig as { enabled: boolean; plan_id: string; milestone: 'paid' | 'delivered' };
  if (printerGift?.enabled === true && printerGift.milestone === 'paid') {
    c.executionCtx.waitUntil(grantPrinterGiftIfEligible(c.env, orderId));
  }
  c.executionCtx.waitUntil(
    notifyAdmins(
      c.env,
      `🛒 New order ${orderId}\nCustomer: ${user.username || user.email}\nItems: ${comp.lines.length}\nTotal: ${comp.totalIqd.toLocaleString()} IQD (${input.paymentMethodId})\nDue on delivery: ${comp.dueOnDelivery.toLocaleString()} IQD`
    )
  );
  const data = (await loadOrder(c.env.DB, orderId))!;
  const snaps = await getOrderPointsSnapshots(c.env, [orderId]);
  return c.json({
    success: true,
    order: orderPublic(data.order, data.items, snaps.get(orderId)),
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
  return c.json({ success: true, order: orderPublic(data.order, data.items, snaps.get(id)) });
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

  // Flip the status first with a conditional UPDATE so concurrent cancel
  // requests cannot both proceed to the refund step.
  const flip = await c.env.DB.prepare(
    `UPDATE orders SET status = 'cancelled', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND status = 'pending'`
  )
    .bind(id)
    .run();
  if (flip.meta.changes === 0) throw badRequest('This order was already cancelled or has progressed');

  const now = new Date().toISOString();
  const stmts = [];
  // §7: the units this order was holding go back through the ledger — a
  // release when it was never confirmed, a restore when it had been. The raw
  // "stock = stock + qty" it replaces could not tell those apart and would
  // have handed back units that were never taken.
  const returned = await returnOrderStock(c.env.DB, id, user.id);
  // Refund wallet and points that were applied. Deterministic transaction ids
  // make the refund idempotent if this step ever has to be re-run.
  const walletCents = Number(data.order.wallet_applied_usd_cents) || 0;
  if (walletCents > 0) {
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at)
         VALUES (?, ?, 'deposit', 'USD', ?, 'approved', ?, ?, 'system', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
      ).bind(`wtx_refund_${id}_usd`, user.id, walletCents, `Refund for cancelled order ${id}`, id)
    );
  }
  // §4.4: a refund returns POINTS AS POINTS (never as cash) and cash by its
  // own channel. The deterministic id makes a re-run idempotent; the
  // reservation flip records that the redemption was given back.
  const points = Number(data.order.points_discount_iqd) || 0;
  if (points > 0) {
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at)
         VALUES (?, ?, 'deposit', 'POINT', ?, 'approved', ?, ?, 'system', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
      ).bind(`wtx_refund_${id}_pts`, user.id, points, `Points refund for cancelled order ${id}`, id)
    );
    stmts.push(
      c.env.DB.prepare(
        `UPDATE points_reservations
            SET state = 'refunded', refunded_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE order_id = ? AND state = 'committed'`
      ).bind(id)
    );
  }
  // §4.3: the pending accrual of a cancelled order is cancelled, never
  // released. Conditional on state='pending', so an accrual that somehow
  // already released is left to the reversal path instead of vanishing.
  stmts.push(cancelPendingAccrualStatement(c.env, id, 'order_cancelled', now));

  if (stmts.length > 0) await c.env.DB.batch(stmts);
  await audit(c.env.DB, user.id, 'order.cancel', id, {
    refund_usd_cents: walletCents,
    refund_points: points,
    stock_returned: returned.kind,
    stock_rows: returned.applied,
  });
  const after = (await loadOrder(c.env.DB, id))!;
  const snaps = await getOrderPointsSnapshots(c.env, [id]);
  return c.json({ success: true, order: orderPublic(after.order, after.items, snaps.get(id)) });
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
    order: orderPublic(data.order, data.items, snaps.get(id)),
  });
});
