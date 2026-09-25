/**
 * GET /api/merchant/analytics/report — the shape the analytics page reads
 * (worker/routes/merchantAnalytics.ts). Every optional field is optional on
 * purpose: the server leaves out a figure it has no source for, and the page
 * leaves out what the server left out.
 */
import { api } from '../../../lib/api';

export interface ReportTrafficTotals {
  visitors: number;
  store_views: number;
  product_views: number;
  add_to_cart: number;
  checkout_started: number;
}

export interface AnalyticsReport {
  range: { from: string; to: string; days: number; timezone: string };
  traffic?: {
    since: string;
    counted_from: string;
    totals: ReportTrafficTotals;
    sources: { direct: number; search: number; social: number; other: number };
    series: Array<{ day: string } & ReportTrafficTotals>;
  };
  orders: {
    totals: { orders: number; gross_iqd: number; receivable_iqd: number; cancelled: number; average_order_iqd?: number };
    series: Array<{ day: string; orders: number; gross_iqd: number }>;
  };
  funnel?: {
    from: string;
    visitors: number;
    product_views: number;
    add_to_cart: number;
    checkout_started: number;
    orders: number;
    conversion_percent?: number;
  };
  products: {
    top: Array<{ id: string; name: string; units: number; revenue_iqd: number; orders: number }>;
    least_viewed?: Array<{ id: string; name: string; views: number; add_to_cart: number }>;
    most_viewed?: Array<{ id: string; name: string; views: number; add_to_cart: number }>;
  };
  customers: { customers: number; returning: number; new: number };
  coupons: Array<{
    code: string;
    orders: number;
    discount_iqd: number;
    gross_iqd: number;
    coupon_id?: string;
    used_count?: number;
    max_uses?: number | null;
    ends_at?: string | null;
    active?: boolean;
  }>;
  governorates: Array<{ governorate: string; orders: number; gross_iqd: number }>;
  governorates_unspecified?: number;
  requests: {
    matched: number;
    notified: number;
    offers_sent: number;
    offers_accepted: number;
    win_rate_percent?: number;
    custom_orders_completed: number;
    custom_orders_receivable_iqd: number;
  };
  previous?: {
    range: { from: string; to: string; days: number };
    orders?: { orders: number; gross_iqd: number; receivable_iqd: number; average_order_iqd?: number };
    traffic?: {
      visitors: number;
      product_views: number;
      add_to_cart: number;
      checkout_started: number;
      orders?: number;
      conversion_percent?: number;
    };
  };
}

export function fetchReport(from: string, to: string) {
  const qs = new URLSearchParams({ from, to }).toString();
  return api.get<{ success: true } & AnalyticsReport>(`/api/merchant/analytics/report?${qs}`);
}
