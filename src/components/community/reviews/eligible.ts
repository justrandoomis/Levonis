/**
 * The transactions a customer may rate, as `GET /api/community-reviews/eligible`
 * lists them (worker/routes/merchantReviews.ts): each is ONE delivered store
 * order or ONE completed custom order — never both.
 */
export interface EligibleReview {
  order_id: string | null;
  community_order_id: string | null;
  merchant_id: string;
  store_id: string | null;
  merchant_name: string;
  created_at: string | null;
}

export const keyOf = (e: EligibleReview) => e.order_id ?? e.community_order_id ?? '';

/** A store order is rated on /orders, a custom order under «تنفيذ طلباتي» — never both. */
export const ofKind = (rows: EligibleReview[], kind: 'store' | 'custom') =>
  rows.filter((e) => (kind === 'store' ? !!e.order_id : !e.order_id && !!e.community_order_id));

/** What the rating names: the one transaction it is about. */
export const reviewTarget = (e: EligibleReview) =>
  e.order_id ? { order_id: e.order_id } : { community_order_id: e.community_order_id };
