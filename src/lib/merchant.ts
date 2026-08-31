/**
 * Types and helpers for the merchant/storefront half of the app.
 *
 * Kept beside `lib/api.ts` rather than inside it: the store types are large
 * and only a handful of screens need them, and api.ts is already the file
 * every page imports. Nothing here is authoritative — every field is what the
 * server said, and every capability flag comes from the server's own
 * entitlement check (`/api/merchant/me`). The UI never decides whether
 * someone may sell; it renders the answer.
 */

import { api } from './api';

export interface StoreMerchantSummary {
  id: string;
  name: string;
  verified: boolean;
  status?: string;
  badge: string;
  rating: number | null;
  rating_count: number;
  completed_orders: number;
}

export interface MerchantStore {
  id: string;
  merchant_id: string;
  slug: string;
  /** Canonical public URL. Falls back to the in-app route when wildcard DNS
   *  is not configured, so a link is never dead. */
  url: string;
  name: string;
  tagline: string;
  description: string;
  logoUrl: string | null;
  bannerUrl: string | null;
  accent: string;
  categories: string[];
  governorate: string;
  service_areas: string[];
  contact_phone: string | null;
  contact_phone_public?: boolean;
  business_hours: Array<{ day: string; open: string; close: string }>;
  policies: Record<string, string>;
  delivery_settings?: Record<string, unknown>;
  social_links: Record<string, string>;
  accepts_custom_requests: boolean;
  sells_direct_products: boolean;
  status: string;
  status_reason?: string;
  open?: boolean;
  created_at: string;
  merchant: StoreMerchantSummary;
}

export interface MerchantProduct {
  id: string;
  slug: string;
  name: string;
  name_ar: string;
  description: string;
  description_ar: string;
  images: string[];
  price_iqd: number;
  original_price_iqd: number | null;
  sku?: string;
  stock?: number;
  track_stock?: boolean;
  category: string;
  condition: string;
  options: unknown[];
  colors: unknown[];
  delivery_methods: string[];
  prep_days: number;
  status?: string;
  lifecycle?: string;
  sold_count: number;
  view_count?: number;
  /** Public shape reports availability, never the exact count. */
  in_stock?: boolean;
  created_at?: string;
  updated_at?: string;
}

/** Everything the server says this account may do in the community. */
export interface MerchantMe {
  eligible: boolean;
  tier: string;
  tier_active: boolean;
  expires_at: string | null;
  gated_benefits: string[];
  can: {
    store: boolean;
    products: boolean;
    orders: boolean;
    offers: boolean;
    analytics: boolean;
    subdomain: boolean;
  };
  store: MerchantStore | null;
  selling: { canSell: boolean; reason: string };
  suggested_slug: string | null;
}

export type SlugRejection =
  | 'too_short' | 'too_long' | 'invalid_characters'
  | 'reserved' | 'taken' | 'recently_released';

export interface SlugCheck {
  ok: boolean;
  reason: SlugRejection | null;
  /** What would actually be stored — mixed case is normalised, not rejected. */
  slug: string;
}

export const merchantApi = {
  me: () => api.get<{ success: true } & MerchantMe>('/api/merchant/me'),
  checkSlug: (slug: string) =>
    api.get<{ success: true } & SlugCheck>(`/api/merchant/slug-check?slug=${encodeURIComponent(slug)}`),
  onboard: (body: Record<string, unknown>) =>
    api.post<{ store: MerchantStore }>('/api/merchant/onboard', body),
  updateStore: (body: Record<string, unknown>) =>
    api.patch<{ store: MerchantStore }>('/api/merchant/store', body),
  products: (cursor?: string) =>
    api.get<{ products: MerchantProduct[]; next_cursor: string | null }>(
      `/api/merchant/products${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`
    ),
  createProduct: (body: Record<string, unknown>) =>
    api.post<{ product: MerchantProduct }>('/api/merchant/products', body),
  updateProduct: (id: string, body: Record<string, unknown>) =>
    api.patch<{ product: MerchantProduct }>(`/api/merchant/products/${id}`, body),
  deleteProduct: (id: string) => api.delete<{ archived: boolean }>(`/api/merchant/products/${id}`),
  duplicateProduct: (id: string) =>
    api.post<{ product: MerchantProduct }>(`/api/merchant/products/${id}/duplicate`),
  orders: (params = '') => api.get<{ orders: Record<string, unknown>[] }>(`/api/merchant/orders${params}`),
  order: (id: string) =>
    api.get<{ order: Record<string, unknown>; items: Record<string, unknown>[] }>(`/api/merchant/orders/${id}`),
  setOrderStatus: (id: string, status: string) =>
    api.post<{ status: string }>(`/api/merchant/orders/${id}/status`, { status }),
  analytics: () => api.get<Record<string, unknown>>('/api/merchant/analytics'),
  payouts: () =>
    api.get<{ balance: { available_iqd: number; pending_iqd: number; paid_iqd: number }; entries: Record<string, unknown>[] }>(
      '/api/merchant/payouts'
    ),
  reviews: () => api.get<{ reviews: Record<string, unknown>[] }>('/api/merchant/reviews'),
  replyReview: (id: string, reply: string) =>
    api.post(`/api/merchant/reviews/${id}/reply`, { reply }),
  followers: () => api.get<{ total: number; followers: Record<string, unknown>[] }>('/api/merchant/followers'),
  customers: () => api.get<{ customers: Record<string, unknown>[] }>('/api/merchant/customers'),
  notifications: () =>
    api.get<{ preferences: Record<string, boolean>; forced: string[] }>('/api/merchant/notifications'),
  setNotifications: (body: Record<string, boolean>) =>
    api.patch<{ preferences: Record<string, boolean>; forced: string[] }>('/api/merchant/notifications', body),
  subscription: () => api.get<Record<string, unknown>>('/api/merchant/subscription'),
};

export const storefrontApi = {
  resolve: () => api.get<{ kind: string; store: MerchantStore | null }>('/api/storefront/resolve'),
  store: (slug: string) => api.get<{ store: MerchantStore }>(`/api/storefront/${slug}`),
  products: (slug: string, params = '') =>
    api.get<{ products: MerchantProduct[]; next_cursor: string | null }>(
      `/api/storefront/${slug}/products${params}`
    ),
  product: (slug: string, productSlug: string) =>
    api.get<{ product: MerchantProduct; store: MerchantStore }>(
      `/api/storefront/${slug}/products/${productSlug}`
    ),
  reviews: (slug: string) =>
    api.get<{
      average: number | null;
      count: number;
      distribution: Record<string, number>;
      reviews: Array<Record<string, unknown>>;
    }>(`/api/storefront/${slug}/reviews`),
};

/**
 * Why a slug was refused, in the customer's language.
 *
 * Each reason needs its own sentence: "taken" and "reserved" are different
 * problems with different next steps, and "recently released" needs an
 * explanation or it reads as a bug.
 */
export function slugMessage(
  reason: SlugRejection | null,
  loc: (ar: string, en: string, ckb?: string) => string
): string {
  switch (reason) {
    case 'too_short':
      return loc('العنوان قصير جدًا (3 أحرف على الأقل)', 'Too short (at least 3 characters)', 'زۆر کورتە (لانیکەم ٣ پیت)');
    case 'too_long':
      return loc('العنوان طويل جدًا (32 حرفًا كحد أقصى)', 'Too long (32 characters maximum)', 'زۆر درێژە (زۆرترین ٣٢ پیت)');
    case 'invalid_characters':
      return loc(
        'حروف إنجليزية صغيرة وأرقام وشرطة فقط',
        'Lowercase letters, numbers and hyphens only',
        'تەنها پیتی بچووکی ئینگلیزی، ژمارە و هێڵ'
      );
    case 'reserved':
      return loc('هذا العنوان محجوز للمنصة', 'That address is reserved by the platform', 'ئەم ناونیشانە بۆ پلاتفۆرم پاراستراوە');
    case 'taken':
      return loc('هذا العنوان مأخوذ بالفعل', 'That address is already taken', 'ئەم ناونیشانە پێشتر وەرگیراوە');
    case 'recently_released':
      return loc(
        'هذا العنوان كان لمتجر آخر وما زال محجوزًا لفترة',
        'That address belonged to another store and is still reserved for a while',
        'ئەم ناونیشانە هی فرۆشگایەکی تر بووە و هێشتا بۆ ماوەیەک پاراستراوە'
      );
    default:
      return '';
  }
}

/** IQD, formatted the way the rest of the app formats it. */
export function iqd(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return `${Number(n).toLocaleString('en-US')} IQD`;
}

/** Merchant badge label. Names are localised; the criteria are not negotiable. */
export function badgeLabel(
  badge: string,
  loc: (ar: string, en: string, ckb?: string) => string
): string {
  switch (badge) {
    case 'trusted':
      return loc('موثوق', 'Trusted', 'متمانەپێکراو');
    case 'professional':
      return loc('محترف', 'Professional', 'پیشەیی');
    case 'elite':
      return loc('نخبة', 'Elite', 'نخبە');
    case 'featured':
      return loc('مميّز', 'Featured', 'تایبەت');
    default:
      return loc('جديد', 'New', 'نوێ');
  }
}
