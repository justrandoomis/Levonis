/**
 * `levonis-analytics` HTTP contract — `/api/v1/analytics/*` (`01-TARGET.md` §9.2,
 * row 17). These read models replace `admin.ts:125-159` and
 * `merchant.ts:1443-1487` over time, so the field names below are the ones those
 * routes already return: the SPA panels keep their shape when the prefix flips.
 * Every field annotated `pii` is dropped at ingest, so nothing here identifies a
 * person. Type-only.
 */

/** One row of `analytics_daily_platform(day, metric, value)`. */
export interface DailyPlatformPoint {
  /** `YYYY-MM-DD`, UTC */
  day: string;
  metric: string;
  value: number;
}

/** One row of `analytics_daily_merchant(day, merchant_id, metric, value)`. */
export interface DailyMerchantPoint extends DailyPlatformPoint {
  merchant_id: string;
}

/**
 * `GET /api/v1/analytics/admin/overview` — the aggregate half of today's
 * `GET /api/admin/overview`. The pending-wallet and recent-order LISTS stay with
 * their owning services (they carry `users` joins and money rows); Analytics
 * serves counters only.
 */
export interface AnalyticsOverviewResponse {
  success: true;
  orders: { total: number; pending: number; delivered: number; revenue_iqd: number };
  users: { total: number; pro: number; prime: number; plus: number; investors: number };
  wallet: { incoming_usd_cents: number; outgoing_usd_cents: number };
  /** the day range the counters cover; absent means all time */
  from?: string;
  to?: string;
}

/**
 * `GET /api/v1/analytics/merchant/daily?merchant_id=…&from=…&to=…` — a merchant
 * reads only its own id (the principal's `sub` must own the merchant); an
 * `admin:full` principal may read any.
 */
export interface MerchantDailyResponse {
  success: true;
  merchant_id: string;
  points: DailyMerchantPoint[];
}

/** `GET /api/v1/analytics/admin/daily?metric=…&from=…&to=…` */
export interface PlatformDailyResponse {
  success: true;
  points: DailyPlatformPoint[];
}
