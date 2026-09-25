/**
 * The state machines behind a community transaction.
 *
 * A request, an offer and a community order each move through a fixed set of
 * states, and the legal moves are declared here as data rather than scattered
 * as `if` statements across routes. That is the difference between a rule and
 * a habit: a route cannot forget a transition table, and a reader can see the
 * whole lifecycle in one place instead of reconstructing it from six handlers.
 *
 * 0001 gave community_requests only (open|closed), which cannot express what
 * actually happens — a request with offers arriving is not the same as one
 * whose offer was accepted and whose work is under way, and "closed" hides
 * whether it completed, expired or was cancelled. Migration 0031 adds the
 * real states in a new column; `status` is kept in step as a coarse mirror so
 * every existing reader stays truthful.
 */

export const REQUEST_STATES = [
  'draft',
  'open',
  'receiving_offers',
  'offer_selected',
  'in_progress',
  'delivered',
  'completed',
  'cancelled',
  'disputed',
  'expired',
] as const;
export type RequestState = (typeof REQUEST_STATES)[number];

/**
 * Legal moves. Absence is refusal — there is no "any other transition is
 * probably fine" path.
 */
export const REQUEST_TRANSITIONS: Record<RequestState, readonly RequestState[]> = {
  // An abandoned draft expires (the sweep, worker/lib/communityRequests.ts):
  // it was never on the board, so nothing else has to move with it.
  draft: ['open', 'cancelled', 'expired'],
  open: ['receiving_offers', 'cancelled', 'expired'],
  // A request can go straight from open to selected when the customer accepts
  // the first offer that arrives.
  receiving_offers: ['offer_selected', 'cancelled', 'expired'],
  offer_selected: ['in_progress', 'cancelled', 'disputed'],
  in_progress: ['delivered', 'disputed', 'cancelled'],
  delivered: ['completed', 'disputed'],
  // Terminal. A completed transaction is history; reopening it would mean
  // money already settled could move again.
  completed: [],
  cancelled: [],
  // A dispute resolves into exactly one of the two settled outcomes.
  disputed: ['completed', 'cancelled'],
  expired: ['open'],
};

/** `open` covers everything a merchant may still bid on. */
export const REQUEST_OPEN_STATES: readonly RequestState[] = ['open', 'receiving_offers'];

export function canMoveRequest(from: RequestState, to: RequestState): boolean {
  return (REQUEST_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * The coarse `status` that mirrors a state, for the 0001 column and any
 * reader that predates the lifecycle.
 */
export function requestStatusFor(state: RequestState): 'open' | 'closed' {
  return REQUEST_OPEN_STATES.includes(state) ? 'open' : 'closed';
}

// ------------------------------------------------------------------ offers

export const OFFER_STATES = ['pending', 'accepted', 'rejected', 'withdrawn', 'expired', 'superseded'] as const;
export type OfferState = (typeof OFFER_STATES)[number];

export const OFFER_TRANSITIONS: Record<OfferState, readonly OfferState[]> = {
  pending: ['accepted', 'rejected', 'withdrawn', 'expired', 'superseded'],
  // Terminal in every direction. Once accepted, the offer's price and promise
  // are the contract; "un-accepting" would let a merchant change what they
  // owe after the customer committed (§26).
  accepted: [],
  rejected: [],
  withdrawn: [],
  expired: [],
  superseded: [],
};

export function canMoveOffer(from: OfferState, to: OfferState): boolean {
  return (OFFER_TRANSITIONS[from] ?? []).includes(to);
}

/** Offers that still occupy the merchant's one live slot on a request. */
export const OFFER_LIVE_STATES: readonly OfferState[] = ['pending', 'accepted'];

/** May the merchant still change this offer? Only before anyone relies on it. */
export function offerIsEditable(state: OfferState): boolean {
  return state === 'pending';
}

// -------------------------------------------------------- community orders

export const COMMUNITY_ORDER_STATES = [
  'accepted',
  'funded',
  'in_progress',
  'merchant_marked_delivered',
  'customer_confirmed',
  'completed',
  'disputed',
  'cancelled',
  'refunded',
] as const;
export type CommunityOrderState = (typeof COMMUNITY_ORDER_STATES)[number];

export const COMMUNITY_ORDER_TRANSITIONS: Record<CommunityOrderState, readonly CommunityOrderState[]> = {
  // `accepted` exists for the instant between creating the order and the
  // escrow being confirmed. It should never be observed for long, and an
  // order stuck there means funding failed.
  accepted: ['funded', 'cancelled'],
  funded: ['in_progress', 'cancelled', 'disputed'],
  in_progress: ['merchant_marked_delivered', 'disputed', 'cancelled'],
  // The merchant saying "done" does NOT release money (§33). It asks the
  // customer.
  merchant_marked_delivered: ['customer_confirmed', 'disputed', 'in_progress'],
  customer_confirmed: ['completed'],
  completed: [],
  disputed: ['completed', 'refunded', 'cancelled'],
  cancelled: [],
  refunded: [],
};

export function canMoveCommunityOrder(from: CommunityOrderState, to: CommunityOrderState): boolean {
  return (COMMUNITY_ORDER_TRANSITIONS[from] ?? []).includes(to);
}

/** Work is under way: neither side may simply walk away without a decision. */
export function orderIsActive(state: CommunityOrderState): boolean {
  return ['funded', 'in_progress', 'merchant_marked_delivered', 'disputed'].includes(state);
}

/** Settled for good. Money has finished moving. */
export function orderIsSettled(state: CommunityOrderState): boolean {
  return ['completed', 'cancelled', 'refunded'].includes(state);
}

/**
 * Who may cancel, and does it need an admin? (§35)
 *
 * The rule follows the work, not the calendar. Before a merchant starts,
 * cancelling costs nobody anything and refunds cleanly. Once work is under
 * way, one side walking away imposes a real loss on the other, so it becomes
 * a dispute for an admin rather than a button either party can press.
 */
export function cancellationPolicy(state: CommunityOrderState): {
  allowed: boolean;
  by: readonly ('customer' | 'merchant' | 'admin')[];
  refund: 'full' | 'decided_by_admin' | 'none';
} {
  switch (state) {
    case 'accepted':
    case 'funded':
      return { allowed: true, by: ['customer', 'merchant', 'admin'], refund: 'full' };
    case 'in_progress':
    case 'merchant_marked_delivered':
      return { allowed: true, by: ['admin'], refund: 'decided_by_admin' };
    case 'disputed':
      return { allowed: true, by: ['admin'], refund: 'decided_by_admin' };
    default:
      return { allowed: false, by: [], refund: 'none' };
  }
}

/**
 * CUSTOM ORDERS THAT EARNED THE MERCHANT MONEY, AND HOW MUCH (review F9) —
 * for the analytics, over `community_orders o LEFT JOIN community_escrows e
 * ON e.community_order_id = o.id`.
 *
 * A dispute an admin settles by a PARTIAL refund is a completed job whose
 * escrow reads `partially_refunded` (the flag — no new column). Before the
 * fix the order was left `refunded`, and those legacy rows count too when
 * their escrow says part was kept. The receivable is the part the merchant
 * KEPT — the same figure `refundEscrow` credits (the kept gross less the
 * order's commission on it, `partialRefundCommission`), not the order's
 * original receivable.
 */
export const CUSTOM_ORDER_EARNED_SQL = `(o.state = 'completed' OR (o.state = 'refunded' AND e.state = 'partially_refunded'))`;
export const CUSTOM_ORDER_KEPT_RECEIVABLE_SQL = `CASE WHEN e.state = 'partially_refunded'
  THEN (e.gross_iqd - e.refunded_iqd) - MIN(e.gross_iqd - e.refunded_iqd, MAX(0, CAST(ROUND(
         CASE WHEN o.commission_percent_x100 > 0
              THEN (e.gross_iqd - e.refunded_iqd) * o.commission_percent_x100 / 10000.0
              ELSE (e.gross_iqd - e.refunded_iqd) * 1.0 * e.platform_fee_iqd / e.gross_iqd END) AS INTEGER)))
  ELSE o.merchant_receivable_iqd END`;
/** When it earned: completion, or for a legacy partial row the refund's stamp. */
export const CUSTOM_ORDER_EARNED_AT_SQL = `COALESCE(o.completed_at, e.refunded_at)`;
