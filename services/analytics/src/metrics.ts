/**
 * Event → daily metrics (`01-TARGET.md` §9.2: "maintains
 * `analytics_daily_platform(day, metric, value)` and
 * `analytics_daily_merchant(day, merchant_id, metric, value)` idempotently by
 * `processed_events`").
 *
 * Pure and total: one function, no database, no clock, no I/O. That is what
 * makes the two paths agree — the fast path adds these numbers in the SAME
 * batch as the event row (so idempotency is the consumer's, for free), and the
 * repair pass re-runs the identical function over the stored rows and REPLACES
 * the day. If the two ever disagree, the repair pass wins and the difference is
 * a bug in exactly one place.
 *
 * Metrics are counters and integer sums only. No averages, no ratios: a stored
 * average cannot be re-derived after a repair, and every amount in this system
 * is already an integer (IQD dinars, USD cents, points).
 */
import type { OrderCreatedV1 } from '@levonis/contracts/events/v1/OrderCreated';
import type { OrderDeliveredV1 } from '@levonis/contracts/events/v1/OrderDelivered';
import type { OrderStatusChangedV1 } from '@levonis/contracts/events/v1/OrderStatusChanged';
import type { PurchaseCompletedV1 } from '@levonis/contracts/events/v1/PurchaseCompleted';
import type { PaymentCompletedV1 } from '@levonis/contracts/events/v1/PaymentCompleted';
import type { PaymentFailedV1 } from '@levonis/contracts/events/v1/PaymentFailed';
import type { RefundCompletedV1 } from '@levonis/contracts/events/v1/RefundCompleted';
import type { SubscriptionChangedV1 } from '@levonis/contracts/events/v1/SubscriptionChanged';
import type { CheckoutStartedV1 } from '@levonis/contracts/events/v1/CheckoutStarted';

/** One counter to add. `merchant_id` present ⇒ it belongs to the merchant rollup as well. */
export interface MetricPoint {
  metric: string;
  value: number;
  merchant_id?: string | null;
}

/** The metric names the read models ask for by name; every other name is additive telemetry. */
export const METRICS = {
  usersCreated: 'users_created',
  usersUpdated: 'users_updated',
  productViews: 'product_views',
  productsUpserted: 'products_upserted',
  inventoryMoves: 'inventory_moves',
  addToCart: 'add_to_cart',
  checkoutsStarted: 'checkouts_started',
  checkoutValueIqd: 'checkout_value_iqd',
  ordersCreated: 'orders_created',
  ordersPaid: 'orders_paid',
  ordersDelivered: 'orders_delivered',
  ordersCancelled: 'orders_cancelled',
  orderItems: 'order_items',
  gmvCreatedIqd: 'gmv_created_iqd',
  revenueIqd: 'revenue_iqd',
  purchases: 'purchases',
  paymentsAuthorized: 'payments_authorized',
  paymentsCompleted: 'payments_completed',
  paymentsFailed: 'payments_failed',
  walletIncomingUsdCents: 'wallet_incoming_usd_cents',
  walletOutgoingUsdCents: 'wallet_outgoing_usd_cents',
  refunds: 'refunds',
  refundsUsdCents: 'refunds_usd_cents',
  refundsPoints: 'refunds_points',
  referralsUsed: 'referrals_used',
  subscriptionsChanged: 'subscriptions_changed',
  requestsPublished: 'requests_published',
  rateLimitHits: 'rate_limit_hits',
  turnstileFailures: 'turnstile_failures',
} as const;

/** `subscription_active_pro` and friends — the tier counters `overview()` reports. */
export const tierMetric = (tier: string): string => `subscription_active_${tier.toLowerCase().replace(/[^a-z0-9_]/g, '')}`;
/** `payment_failed_insufficient_funds` — the failure-reason breakdown Risk and the admin panel both want. */
export const failureMetric = (reason: string): string => `payment_failed_${reason.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`;

type Mapper = (payload: Record<string, unknown>) => MetricPoint[];

const asRecord = <T>(payload: Record<string, unknown>): T => payload as unknown as T;

/**
 * One mapper per subscribed event key. An event with no counters (`UserUpdated`
 * beyond its count, `OrderPaid` beyond its count) still gets a mapper, so the
 * "every subscription has a mapper" test is a real check and not a list of
 * exceptions.
 */
export const METRIC_MAPPERS: Record<string, Mapper> = {
  'UserCreated.v1': () => [{ metric: METRICS.usersCreated, value: 1 }],
  'UserUpdated.v1': () => [{ metric: METRICS.usersUpdated, value: 1 }],
  'ProductViewed.v1': () => [{ metric: METRICS.productViews, value: 1 }],
  'ProductAdded.v1': () => [{ metric: METRICS.productsUpserted, value: 1 }],
  'InventoryChanged.v1': () => [{ metric: METRICS.inventoryMoves, value: 1 }],
  'AddToCart.v1': () => [{ metric: METRICS.addToCart, value: 1 }],

  'CheckoutStarted.v1': (p) => {
    const a = asRecord<CheckoutStartedV1>(p);
    return [
      { metric: METRICS.checkoutsStarted, value: 1 },
      { metric: METRICS.checkoutValueIqd, value: a.totals?.grand_iqd ?? 0 },
    ];
  },

  'OrderCreated.v1': (p) => {
    const a = asRecord<OrderCreatedV1>(p);
    return [
      { metric: METRICS.ordersCreated, value: 1, merchant_id: a.merchant_id },
      { metric: METRICS.orderItems, value: a.items?.length ?? 0, merchant_id: a.merchant_id },
      { metric: METRICS.gmvCreatedIqd, value: a.totals?.total_iqd ?? 0, merchant_id: a.merchant_id },
    ];
  },

  'OrderPaid.v1': () => [{ metric: METRICS.ordersPaid, value: 1 }],

  'OrderDelivered.v1': (p) => {
    const a = asRecord<OrderDeliveredV1>(p);
    return [{ metric: METRICS.ordersDelivered, value: 1, merchant_id: a.merchant_id }];
  },

  'OrderStatusChanged.v1': (p) => {
    const a = asRecord<OrderStatusChangedV1>(p);
    // Only the terminal transition earns a counter: a status machine that
    // emits a metric per hop turns the rollup into a log.
    return a.to === 'cancelled' ? [{ metric: METRICS.ordersCancelled, value: 1 }] : [];
  },

  'PurchaseCompleted.v1': (p) => {
    const a = asRecord<PurchaseCompletedV1>(p);
    return [
      { metric: METRICS.purchases, value: 1 },
      { metric: METRICS.revenueIqd, value: a.value_iqd ?? 0 },
    ];
  },

  'PaymentAuthorized.v1': () => [{ metric: METRICS.paymentsAuthorized, value: 1 }],

  'PaymentCompleted.v1': (p) => {
    const a = asRecord<PaymentCompletedV1>(p);
    const out: MetricPoint[] = [{ metric: METRICS.paymentsCompleted, value: 1 }];
    // Wallet flow, in the currency the ledger uses for it. A COD settlement or
    // an escrow release is not money entering or leaving a wallet balance.
    if (a.currency === 'USD' && a.kind === 'deposit_approved') out.push({ metric: METRICS.walletIncomingUsdCents, value: a.amount ?? 0 });
    if (a.currency === 'USD' && a.kind === 'wallet_debit') out.push({ metric: METRICS.walletOutgoingUsdCents, value: a.amount ?? 0 });
    return out;
  },

  'PaymentFailed.v1': (p) => {
    const a = asRecord<PaymentFailedV1>(p);
    return [
      { metric: METRICS.paymentsFailed, value: 1 },
      { metric: failureMetric(a.reason ?? 'unknown'), value: 1 },
    ];
  },

  'RefundCompleted.v1': (p) => {
    const a = asRecord<RefundCompletedV1>(p);
    return [
      { metric: METRICS.refunds, value: 1 },
      { metric: METRICS.refundsUsdCents, value: a.usd_cents ?? 0 },
      { metric: METRICS.refundsPoints, value: a.points ?? 0 },
    ];
  },

  'ReferralUsed.v1': () => [{ metric: METRICS.referralsUsed, value: 1 }],

  'SubscriptionChanged.v1': (p) => {
    const a = asRecord<SubscriptionChangedV1>(p);
    const out: MetricPoint[] = [{ metric: METRICS.subscriptionsChanged, value: 1 }];
    if (a.active && a.to_tier) out.push({ metric: tierMetric(a.to_tier), value: 1 });
    return out;
  },

  'RequestPublished.v1': () => [{ metric: METRICS.requestsPublished, value: 1 }],
  'RateLimitHit.v1': () => [{ metric: METRICS.rateLimitHits, value: 1 }],
  'TurnstileFailed.v1': () => [{ metric: METRICS.turnstileFailures, value: 1 }],
};

export const METRIC_EVENT_KEYS = Object.keys(METRIC_MAPPERS);

/**
 * The counters one event contributes. Zero-valued points are dropped: a row
 * that says "0 was added" costs a write and tells nobody anything.
 */
export function metricsOf(key: string, payload: Record<string, unknown>): MetricPoint[] {
  const map = METRIC_MAPPERS[key];
  if (!map) return [];
  return map(payload).filter((m) => Number.isFinite(m.value) && m.value !== 0);
}
