import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext, SessionUser } from '../lib/types';
import { safeParse } from '../lib/types';
import { requireAuth, badRequest, notFound, str } from '../lib/http';
import { newId, newOrderId } from '../lib/crypto';
import { getSettings } from '../lib/settings';
import type { DeliveryMethod, CheckoutPaymentMethod } from '../lib/settings';
import { resolveCartLine, pricingContextFrom, publicBreakdown } from './cart';
import { getTierStatus } from '../lib/entitlements';
import type { TierStatus } from '../lib/entitlements';
import {
  referralFreeDeliveryApplies,
  validateCoupon,
  grantPrinterGiftIfEligible,
} from '../lib/membershipOps';
import { getBalances } from '../lib/wallet';
import { audit } from '../lib/audit';
import { rateLimit } from '../lib/ratelimit';
import { notifyAdmins } from '../lib/telegram';
import { quoteShipping } from '../lib/shipping';
import type { ShippingConfig, ShippingItem, ShippingQuote } from '../lib/shipping';
import { getRequiredCheckoutPolicies, verifyAndRecordAcceptance } from '../lib/policyOps';
import type { PolicyRef } from '../lib/policyOps';
import { createInvoiceForOrder } from '../lib/invoices';
import { normalizePhone } from '../lib/phone';

export const orderRoutes = new Hono<AppContext>();
orderRoutes.use('*', requireAuth);

/** IQD -> USD cents, rounded up so the wallet never undercharges. */
function iqdToUsdCents(iqd: number, rate: number): number {
  return Math.ceil((iqd * 100) / rate);
}

export function orderPublic(o: Record<string, unknown>, items: Record<string, unknown>[]) {
  const coupon = safeParse<Record<string, unknown> | null>(o.coupon_snapshot, null);
  return {
    id: o.id,
    status: o.status,
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
  carton_threshold_spools: null,
  carton_fee_iqd: null,
  printer_advance_required: true,
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
    carton_threshold_spools: intOrNull(o.carton_threshold_spools),
    carton_fee_iqd: intOrNull(o.carton_fee_iqd),
    printer_advance_required: o.printer_advance_required !== false,
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
  color_id: string;
  shipping_method_id: string;
  qty: number;
  unit: number;
  line: number;
  applied_iqd: number;
  tracked: boolean;
  pricing_snapshot: string;
  warranty_snapshot: string | null;
  transport_snapshot: string | null;
  breakdown: ReturnType<typeof publicBreakdown>;
}

interface CheckoutComputation {
  address: Record<string, unknown>;
  delivery: DeliveryMethod;
  payment: CheckoutPaymentMethod | null;
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
  walletBalanceIqd: number;
  walletApplied: number;
  walletUsdCents: number;
  requiredAdvance: number;
  totalIqd: number; // payable after coupon+points (before wallet)
  dueOnDelivery: number;
  policies: PolicyRef[];
  printerGiftConfig: unknown;
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
  let sql = `SELECT ci.id AS cart_item_id, ci.qty, ci.option_id, ci.color_id, ci.shipping_method_id,
                    ci.transport_method, ci.warranty_plan_id, p.*
               FROM cart_items ci JOIN products p ON p.id = ci.product_id
              WHERE ci.user_id = ?`;
  const params: unknown[] = [user.id];
  if (input.itemIds.length > 0) {
    sql += ` AND ci.id IN (${input.itemIds.map(() => '?').join(',')})`;
    params.push(...input.itemIds);
  }
  const { results: rows } = await c.env.DB.prepare(sql).bind(...params).all<Record<string, unknown>>();
  if (rows.length === 0) throw badRequest('Your cart is empty');

  let subtotal = 0;
  let merchandise = 0;
  const productIds: string[] = [];
  const lines: ComputedLine[] = [];
  const shippingItems: ShippingItem[] = [];
  for (const row of rows) {
    const displayName = String(row.name_ar || row.name);
    if (row.status !== 'active') throw badRequest(`"${displayName}" is no longer available — please remove it from your cart`);
    const { doc, resolved, variantLabel } = resolveCartLine(
      row,
      {
        optionId: String(row.option_id ?? ''),
        colorId: String(row.color_id ?? ''),
        transportMethod: String(row.transport_method ?? ''),
        warrantyPlanId: String(row.warranty_plan_id ?? ''),
      },
      tierStatus.tier,
      pricingTierActive,
      pricingCtx
    );
    if (resolved.errors.length > 0) {
      throw badRequest(`"${displayName}": ${resolved.errors.join(', ')}`, 'VALIDATION');
    }
    const qty = Number(row.qty);
    if (row.stock !== null && Number(row.stock) < qty) {
      throw badRequest(`Only ${row.stock} of "${displayName}" left in stock`);
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
      tracked: row.stock !== null,
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

  const runQuote = (basisIqd: number): ShippingQuote =>
    quoteShipping({
      items: shippingItems,
      merchandiseIqd: basisIqd,
      tier: tierStatus.tier,
      tierActive: tierStatus.active && !gatedBenefits.has('freeDelivery'),
      atApprovedDefaultAddress: atApprovedDefault,
      independentFreeDelivery,
      config: configForOrder,
    });

  const emptyQuote: ShippingQuote = {
    components: [],
    total_iqd: 0,
    total_before_waiver_iqd: 0,
    advance_due_iqd: 0,
    pro_waiver_applied: false,
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

  // Final quote with the configured threshold basis (decision row 17 default:
  // merchandise AFTER coupon discounts, before shipping).
  if (!isPickup) {
    const basis =
      configForOrder.threshold_basis === 'merchandise_after_coupon'
        ? Math.max(0, merchandise - Math.min(couponDiscount, merchandise))
        : merchandise;
    shipping = runQuote(basis);
  }

  const beforeDiscounts = Math.max(0, subtotal + shipping.total_iqd - couponDiscount);

  const balances = await getBalances(c.env.DB, user.id);
  const walletBalanceIqd = Math.floor((balances.usd_cents * exchangeRate) / 100);

  // Points: 1 point = 1 IQD, applied before the wallet.
  let pointsDiscount = 0;
  if (input.usePoints && balances.points > 0) {
    pointsDiscount = Math.min(balances.points, beforeDiscounts);
  }
  const afterPoints = beforeDiscounts - pointsDiscount;

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
  if (walletUsdCents > balances.usd_cents) {
    // Rounding pushed us past the balance; scale back to what the balance covers.
    walletApplied = Math.floor((balances.usd_cents * exchangeRate) / 100);
    if (walletApplied < requiredAdvance) throw badRequest('Insufficient wallet balance', 'INSUFFICIENT_BALANCE');
  }
  const finalWalletUsdCents =
    walletApplied > 0 ? Math.min(iqdToUsdCents(walletApplied, exchangeRate), balances.usd_cents) : 0;
  const dueOnDelivery = afterPoints - walletApplied;

  const policies = await getRequiredCheckoutPolicies(c.env);

  return {
    address,
    delivery,
    payment,
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
    pointsBalance: balances.points,
    pointsDiscount,
    walletBalanceIqd,
    walletApplied,
    walletUsdCents: finalWalletUsdCents,
    requiredAdvance,
    totalIqd: afterPoints,
    dueOnDelivery,
    policies,
    printerGiftConfig: settings.printerGiftConfig,
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
  const out = [];
  for (const o of orders) {
    const { results: items } = await c.env.DB.prepare('SELECT * FROM order_items WHERE order_id = ?')
      .bind(o.id)
      .all();
    out.push(orderPublic(o, items));
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
      coupon: comp.couponSnapshot ? safeParse(comp.couponSnapshot, null) : null,
      points: { balance: comp.pointsBalance, applied_iqd: comp.pointsDiscount },
      wallet: {
        balance_iqd: comp.walletBalanceIqd,
        applied_iqd: comp.walletApplied,
        required_advance_iqd: comp.requiredAdvance,
      },
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
    return c.json({ success: true, order: orderPublic(data.order, data.items), invoice_no: inv?.invoice_no ?? null, replay: true });
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
  // PRO priority preparation is a CONTEXTUAL purchase benefit: only in the
  // eligible PRO checkout context (approved default address), and pausable
  // by an active priorityService restriction case (§10).
  const priority =
    comp.proContext && !(comp.tierStatus.gated_benefits ?? []).includes('priorityService') ? 1 : 0;

  // The delivery-method snapshot keeps its original fields (backward
  // compatible) and gains the authoritative shipping quote for transparency.
  const deliverySnapshot = JSON.stringify({ ...comp.delivery, quote: comp.shipping });

  const stmts = [
    c.env.DB.prepare(
      `INSERT INTO orders (id, user_id, status, address_snapshot, delivery_method_id, delivery_method_snapshot,
         payment_method_id, subtotal_iqd, shipping_iqd, points_discount_iqd, wallet_applied_iqd,
         wallet_applied_usd_cents, exchange_rate, total_iqd, due_on_delivery_iqd, idempotency_key,
         membership_tier_snapshot, delivery_waived, priority, coupon_snapshot, created_at, updated_at)
       VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      orderId, user.id, JSON.stringify(comp.address), input.deliveryMethodId, deliverySnapshot,
      input.paymentMethodId, comp.subtotal, shippingTotal, comp.pointsDiscount, comp.walletApplied,
      comp.walletUsdCents, comp.exchangeRate, comp.totalIqd, comp.dueOnDelivery, idempotencyKey,
      comp.tierStatus.active ? comp.tierStatus.tier : 'free', deliveryWaived, priority, comp.couponSnapshot, now, now
    ),
  ];

  if (comp.couponId) {
    // UNIQUE(order_id) makes the redemption idempotent with the order itself.
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
           option_id, color_id, shipping_method_id, qty, unit_price_iqd, line_total_iqd,
           pricing_snapshot, warranty_snapshot, transport_snapshot)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        it.id, orderId, it.product_id, it.name, it.image, it.variant,
        it.option_id, it.color_id, it.shipping_method_id, it.qty, it.unit, it.line,
        it.pricing_snapshot, it.warranty_snapshot, it.transport_snapshot
      )
    );
    if (it.tracked) {
      // CHECK (stock >= 0) aborts the whole batch on oversell.
      stmts.push(
        c.env.DB.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').bind(it.qty, it.product_id)
      );
    }
  }

  if (comp.pointsDiscount > 0) {
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
      ).bind(newId('wtx'), user.id, comp.pointsDiscount, `Points used on order ${orderId}`, orderId, now)
    );
  }
  if (comp.walletUsdCents > 0) {
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at)
         SELECT ?1, ?2, 'withdrawal', 'USD',
           CASE WHEN (SELECT COALESCE(SUM(CASE WHEN type='deposit' THEN amount ELSE -amount END),0)
                        FROM wallet_transactions WHERE user_id = ?2 AND currency='USD' AND status='approved') >= ?3
                THEN ?3 ELSE -1 END,
           'approved', ?4, ?5, 'system', ?6`
      ).bind(newId('wtx'), user.id, comp.walletUsdCents, `Wallet payment on order ${orderId}`, orderId, now)
    );
  }

  // Remove the purchased lines from the cart.
  for (const it of comp.lines) {
    stmts.push(c.env.DB.prepare('DELETE FROM cart_items WHERE id = ? AND user_id = ?').bind(it.cart_item_id, user.id));
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
        return c.json({ success: true, order: orderPublic(d.order, d.items), replay: true });
      }
    }
    if (msg.includes('CHECK')) {
      throw badRequest('Order could not be placed: a balance or stock level changed. Please review your cart and try again.', 'CONFLICT_RETRY');
    }
    console.error('Order batch failed', msg);
    throw badRequest('Order could not be placed. Please try again.');
  }

  await audit(c.env.DB, user.id, 'order.create', orderId, {
    total_iqd: comp.totalIqd, wallet_applied_iqd: comp.walletApplied, points: comp.pointsDiscount,
    payment: input.paymentMethodId, coupon_iqd: comp.couponDiscount,
    tier: comp.tierStatus.active ? comp.tierStatus.tier : 'free',
    pro_context: comp.proContext, at_approved_default: comp.atApprovedDefault,
    shipping_iqd: shippingTotal, delivery_waived: deliveryWaived,
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
  return c.json({
    success: true,
    order: orderPublic(data.order, data.items),
    invoice_no: invoice?.invoiceNo ?? null,
    shipping_quote: comp.shipping,
  });
});

orderRoutes.get('/:id', async (c) => {
  const user = c.get('user')!;
  const data = await loadOrder(c.env.DB, c.req.param('id'));
  if (!data || (data.order.user_id !== user.id && user.role !== 'admin')) throw notFound('Order not found');
  return c.json({ success: true, order: orderPublic(data.order, data.items) });
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

  const stmts = [];
  // Restore tracked stock.
  for (const it of data.items) {
    if (it.product_id) {
      stmts.push(
        c.env.DB.prepare('UPDATE products SET stock = stock + ? WHERE id = ? AND stock IS NOT NULL').bind(it.qty, it.product_id)
      );
    }
  }
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
  const points = Number(data.order.points_discount_iqd) || 0;
  if (points > 0) {
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at)
         VALUES (?, ?, 'deposit', 'POINT', ?, 'approved', ?, ?, 'system', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
      ).bind(`wtx_refund_${id}_pts`, user.id, points, `Points refund for cancelled order ${id}`, id)
    );
  }
  if (stmts.length > 0) await c.env.DB.batch(stmts);
  await audit(c.env.DB, user.id, 'order.cancel', id, { refund_usd_cents: walletCents, refund_points: points });
  const after = (await loadOrder(c.env.DB, id))!;
  return c.json({ success: true, order: orderPublic(after.order, after.items) });
});
