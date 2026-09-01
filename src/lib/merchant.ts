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
  /** Public follower count (returned by the storefront endpoints only). */
  followers?: number;
  /** Published-product count (storefront endpoints only). */
  product_count?: number;
  /** Share of visible reviews at 4★+, or null with no reviews yet. */
  positive_pct?: number | null;
  /** Published products currently discounted (storefront endpoints only). */
  deal_count?: number;
  /** The merchant-arranged header rows (visible items only on public reads). */
  profile_links?: ProfileWidget[];
  profile_facts?: ProfileWidget[];
  /** True once the merchant has arranged the facts row at least once —
   *  distinguishes "never configured" (honest fallback) from "deliberately
   *  emptied" (show nothing), without leaking hidden drafts. */
  profile_facts_configured?: boolean;
  created_at: string;
  merchant: StoreMerchantSummary;
}

/** One merchant-controlled header widget: a link pill or an info card. */
export interface ProfileWidget {
  /** A NAME from the fixed set — mapped to a component, never markup. */
  icon: string;
  title: string;
  /** Info cards only. */
  subtitle?: string;
  /** Link pills only — http(s), validated server-side. */
  url?: string;
  visible: boolean;
}

/**
 * Where a merchant card should take the visitor: the store's own subdomain
 * when one exists (a full navigation — the shop IS its own site), the
 * in-site page otherwise. The shared cookie keeps the session across hosts.
 */
export function storeHref(storeUrl: string | null | undefined, merchantId: string): string {
  if (storeUrl && /^https?:\/\//.test(storeUrl)) {
    try {
      if (new URL(storeUrl).origin !== window.location.origin) return storeUrl;
    } catch {
      /* fall through to the in-site page */
    }
  }
  return `/community/store/${merchantId}`;
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
  section_id?: string | null;
  featured?: boolean;
  sold_count: number;
  view_count?: number;
  /** Public shape reports availability, never the exact count. */
  in_stock?: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface StoreSection {
  id: string;
  name: string;
  name_ar: string;
  sort_order?: number;
  active?: boolean;
  product_count?: number;
}

export interface StoreService {
  id: string;
  title: string;
  description: string;
  kind: string;
  price_from_iqd: number | null;
  price_unit: string;
  materials: string[];
  imageUrl: string | null;
  active?: boolean;
  sort_order?: number;
}

export interface ShowcaseItem {
  id: string;
  kind: 'printer' | 'material' | 'work';
  title: string;
  details: string;
  imageUrl: string | null;
  active?: boolean;
  sort_order?: number;
}

export interface MerchantCoupon {
  id: string;
  code: string;
  kind: 'fixed_iqd' | 'percent';
  value: number;
  min_total_iqd: number;
  max_uses: number | null;
  used_count: number;
  active: boolean;
  starts_at: string | null;
  ends_at: string | null;
  created_at: string;
}

export interface CommunityOrderRow {
  id: string;
  state: string;
  price_iqd: number;
  merchant_receivable_iqd: number;
  created_at: string;
  delivered_at: string | null;
  completed_at: string | null;
  auto_complete_at: string | null;
  request_title: string;
  merchant_name: string;
  store_slug: string | null;
  role: 'customer' | 'merchant';
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
  changeSlug: (slug: string) =>
    api.post<{ slug: string; changed: boolean }>('/api/merchant/store/slug', { slug }),

  sections: () => api.get<{ sections: StoreSection[] }>('/api/merchant/sections'),
  createSection: (body: Record<string, unknown>) =>
    api.post<{ section: StoreSection }>('/api/merchant/sections', body),
  updateSection: (id: string, body: Record<string, unknown>) =>
    api.patch(`/api/merchant/sections/${id}`, body),
  deleteSection: (id: string) => api.delete(`/api/merchant/sections/${id}`),

  services: () => api.get<{ services: StoreService[] }>('/api/merchant/services'),
  createService: (body: Record<string, unknown>) =>
    api.post<{ service: StoreService }>('/api/merchant/services', body),
  updateService: (id: string, body: Record<string, unknown>) =>
    api.patch(`/api/merchant/services/${id}`, body),
  deleteService: (id: string) => api.delete(`/api/merchant/services/${id}`),

  showcase: () => api.get<{ items: ShowcaseItem[] }>('/api/merchant/showcase'),
  createShowcase: (body: Record<string, unknown>) =>
    api.post<{ item: ShowcaseItem }>('/api/merchant/showcase', body),
  updateShowcase: (id: string, body: Record<string, unknown>) =>
    api.patch(`/api/merchant/showcase/${id}`, body),
  deleteShowcase: (id: string) => api.delete(`/api/merchant/showcase/${id}`),

  coupons: () => api.get<{ coupons: MerchantCoupon[] }>('/api/merchant/coupons'),
  createCoupon: (body: Record<string, unknown>) =>
    api.post<{ coupon: MerchantCoupon }>('/api/merchant/coupons', body),
  updateCoupon: (id: string, body: Record<string, unknown>) =>
    api.patch(`/api/merchant/coupons/${id}`, body),
  deleteCoupon: (id: string) => api.delete<{ deactivated: boolean }>(`/api/merchant/coupons/${id}`),

  customOrdersSummary: () =>
    api.get<{ to_start: number; in_progress: number; awaiting_customer: number }>(
      '/api/merchant/custom-orders/summary'
    ),
};

/** The community-order lifecycle (request → offer → escrow), either side. */
export const communityOrdersApi = {
  list: () => api.get<{ orders: CommunityOrderRow[] }>('/api/marketplace/orders'),
  get: (id: string) =>
    api.get<{
      order: Record<string, unknown>;
      role: 'customer' | 'merchant';
      escrow: Record<string, unknown> | null;
      can: Record<string, boolean>;
    }>(`/api/marketplace/orders/${id}`),
  start: (id: string) => api.post(`/api/marketplace/orders/${id}/start`),
  delivered: (id: string) =>
    api.post<{ auto_complete_at: string | null }>(`/api/marketplace/orders/${id}/delivered`),
  confirm: (id: string) => api.post(`/api/marketplace/orders/${id}/confirm`),
  dispute: (id: string, description: string) =>
    api.post<{ complaint_id: string }>(`/api/marketplace/orders/${id}/dispute`, { description }),
  cancel: (id: string) => api.post<{ refunded: boolean }>(`/api/marketplace/orders/${id}/cancel`),
};

export const storefrontApi = {
  resolve: () => api.get<{ kind: string; store: MerchantStore | null }>('/api/storefront/resolve'),
  store: (slug: string) => api.get<{ store: MerchantStore }>(`/api/storefront/${slug}`),
  /** Legacy-link resolution: accepts a store id OR a merchant id (§57). */
  storeById: (id: string) => api.get<{ store: MerchantStore }>(`/api/storefront/by-id/${encodeURIComponent(id)}`),
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
  sections: (slug: string) => api.get<{ sections: StoreSection[] }>(`/api/storefront/${slug}/sections`),
  services: (slug: string) => api.get<{ services: StoreService[] }>(`/api/storefront/${slug}/services`),
  showcase: (slug: string) => api.get<{ items: ShowcaseItem[] }>(`/api/storefront/${slug}/showcase`),
};

/** The merchant cart + store checkout, priced entirely server-side. */
export interface MerchantCartLine {
  cart_item_id: string;
  product_id: string;
  name: string;
  name_ar: string;
  images: string[];
  qty: number;
  option_id: string;
  color_id: string;
  unit_price_iqd: number;
  original_price_iqd: number | null;
  line_total_iqd: number;
  prep_days: number;
  available: boolean;
  stock: number | null;
}

export interface MerchantCartData {
  scope: { seller_type: string; merchant_id?: string; store_id?: string } | null;
  store: { id: string; slug: string; name: string; merchant_id: string } | null;
  items: MerchantCartLine[];
  subtotal_iqd: number;
}

export interface StoreQuote {
  store_name: string;
  store_slug: string;
  lines: Array<{ cart_item_id: string; name: string; image: string; qty: number; unit_price_iqd: number; line_total_iqd: number }>;
  subtotal_iqd: number;
  delivery_iqd: number;
  coupon_code: string;
  discount_iqd: number;
  total_iqd: number;
}

export const storeCheckoutApi = {
  cart: () => api.get<MerchantCartData>('/api/cart/merchant'),
  scope: () =>
    api.get<{ scope: { seller_type: string } | null; store: Record<string, unknown> | null; count: number }>(
      '/api/cart/scope'
    ),
  setQty: (cartItemId: string, qty: number) =>
    api.patch<MerchantCartData>(`/api/cart/merchant-items/${cartItemId}`, { qty }),
  removeLine: (cartItemId: string) => api.delete<MerchantCartData>(`/api/cart/merchant-items/${cartItemId}`),
  quote: (couponCode = '') =>
    api.post<{ quote: StoreQuote }>('/api/store-orders/quote', couponCode ? { couponCode } : {}),
  place: (body: { addressId: string; payWithWallet: boolean; idempotencyKey: string; couponCode?: string }) =>
    api.post<{ order: Record<string, unknown>; replay?: boolean }>('/api/store-orders', body),
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

// ---------------------------------------------------------------------------
// PLATFORM ADMIN
//
// These call /api/admin/community/*, which the Worker serves ONLY on the apex
// host. On a merchant storefront every one of them answers 404 by design — the
// guard that makes wildcard subdomains safe. Nothing here should ever be
// rendered on a store host, and if it somehow were, it would get nothing.
// ---------------------------------------------------------------------------

export interface CommunityOverview {
  merchants: { total: number; verified: number; suspended: number };
  stores: { total: number; active: number };
  products: { total: number; active: number };
  requests: { total: number; open: number };
  offers: { total: number };
  orders: { total: number; gross: number; fees: number; completed: number };
  escrows: Array<{ state: string; n: number; total: number }>;
  complaints: { total: number; open: number };
}

export interface AdminMerchantRow {
  id: string;
  user_id: string;
  name: string;
  status: string;
  status_reason: string;
  verified: number;
  badge: string;
  badge_override: string;
  rating_avg_x100: number;
  rating_count: number;
  completed_orders: number;
  store_id: string | null;
  store_slug: string | null;
  store_status: string | null;
  store_status_reason: string | null;
  store_name: string | null;
  owner_email: string;
  owner_name: string;
  created_at: string;
}

export interface AdminComplaintRow {
  id: string;
  reporter_id: string;
  reporter_name: string;
  merchant_id: string | null;
  merchant_name: string | null;
  community_order_id: string | null;
  order_id: string | null;
  category: string;
  description: string;
  status: string;
  priority: string;
  resolution: string;
  created_at: string;
}

export interface AdminEscrow {
  id: string;
  community_order_id: string;
  customer_id: string;
  merchant_id: string;
  gross_iqd: number;
  platform_fee_iqd: number;
  merchant_receivable_iqd: number;
  released_iqd: number;
  refunded_iqd: number;
  state: string;
  held_at: string | null;
  released_at: string | null;
  refunded_at: string | null;
  disputed_at: string | null;
}

export interface AdminRequestRow {
  id: string;
  title: string;
  state: string;
  status: string;
  category: string;
  quantity: number;
  budget_iqd: number | null;
  governorate: string;
  visibility: string;
  deadline: string | null;
  expires_at: string | null;
  accepted_offer_id: string | null;
  community_order_id: string | null;
  created_at: string;
  customer_id: string;
  customer_name: string;
  customer_email: string;
  offers_total: number;
  offers_pending: number;
}

export interface AdminOfferRow {
  id: string;
  request_id: string;
  merchant_id: string;
  merchant_name: string;
  merchant_status: string;
  badge: string;
  verified: number;
  store_slug: string | null;
  price_iqd: number;
  completion_days: number;
  delivery_method: string;
  message: string;
  state: string;
  created_at: string;
}

export interface AdminReviewRow {
  id: string;
  merchant_id: string;
  merchant_name: string;
  rating: number;
  body: string;
  hidden: number;
  merchant_reply: string;
  edited_count: number;
  order_id: string | null;
  community_order_id: string | null;
  customer_name: string;
  customer_email: string;
  rating_avg_x100: number;
  rating_count: number;
  created_at: string;
}

export interface AdminReputationEvent {
  id: string;
  kind: string;
  points: number;
  note: string;
  order_id: string | null;
  community_order_id: string | null;
  review_id: string | null;
  created_at: string;
}

export interface AdminReputation {
  merchant: Record<string, string | number>;
  /** What the published criteria award right now — shown next to any override. */
  earned_badge: string;
  badge_override: string;
  reputation_points: number;
  breakdown: Array<{ rating: number; n: number }>;
  events: AdminReputationEvent[];
}

export const adminCommunityApi = {
  overview: () => api.get<{ success: true } & CommunityOverview>('/api/admin/community/overview'),
  settings: () => api.get<{ settings: Record<string, string> }>('/api/admin/community/settings'),
  saveSettings: (body: Record<string, number>) =>
    api.patch<{ settings: Record<string, number>; applies_to: string }>('/api/admin/community/settings', body),

  merchants: (q = '') =>
    api.get<{ merchants: AdminMerchantRow[] }>(
      `/api/admin/community/merchants${q ? `?q=${encodeURIComponent(q)}` : ''}`
    ),
  verify: (id: string, verified: boolean) =>
    api.post<{ verified: boolean }>(`/api/admin/community/merchants/${id}/verify`, { verified }),
  setStatus: (id: string, status: string, reason: string) =>
    api.post<{ status: string }>(`/api/admin/community/merchants/${id}/status`, { status, reason }),
  setBadge: (id: string, badge: string) =>
    api.post(`/api/admin/community/merchants/${id}/badge`, { badge }),
  /** Suspending a STORE is a different sanction from suspending its merchant. */
  setStoreStatus: (storeId: string, status: 'active' | 'suspended', reason: string) =>
    api.post<{ status: string }>(`/api/admin/community/stores/${storeId}/status`, { status, reason }),
  finance: (id: string) =>
    api.get<{
      balance: { available_iqd: number; pending_iqd: number; paid_iqd: number };
      ledger: Record<string, unknown>[];
      escrows: AdminEscrow[];
    }>(`/api/admin/community/merchants/${id}/finance`),
  payout: (id: string, amount_iqd: number, note: string, idempotencyKey: string) =>
    api.post<{ replayed: boolean; balance: { available_iqd: number; pending_iqd: number; paid_iqd: number } }>(
      `/api/admin/community/merchants/${id}/payout`,
      { amount_iqd, note, idempotencyKey }
    ),

  complaints: (status = '') =>
    api.get<{ complaints: AdminComplaintRow[] }>(
      `/api/admin/community/complaints${status ? `?status=${status}` : ''}`
    ),
  complaint: (id: string) =>
    api.get<{
      complaint: AdminComplaintRow;
      messages: Record<string, unknown>[];
      escrow: AdminEscrow | null;
      escrow_events: Record<string, unknown>[];
    }>(`/api/admin/community/complaints/${id}`),
  setComplaintStatus: (id: string, status: string, resolution: string) =>
    api.post<{ status: string }>(`/api/admin/community/complaints/${id}/status`, { status, resolution }),

  /** The settlement decision. Appends events; never rewrites amounts. */
  resolveEscrow: (id: string, decision: 'release' | 'refund' | 'partial_refund', reason: string, amount_iqd?: number) =>
    api.post<{ decision: string; replayed: boolean }>(`/api/admin/community/escrows/${id}/resolve`, {
      decision,
      reason,
      ...(amount_iqd !== undefined ? { amount_iqd } : {}),
    }),

  requests: (state = '', q = '') =>
    api.get<{ requests: AdminRequestRow[] }>(
      `/api/admin/community/requests?state=${encodeURIComponent(state)}&q=${encodeURIComponent(q)}`
    ),
  request: (id: string) =>
    api.get<{
      request: Record<string, unknown>;
      offers: AdminOfferRow[];
      files: Array<{ id: string; file_name: string; content_type: string; size_bytes: number; kind: string }>;
      order: Record<string, unknown> | null;
      escrow: AdminEscrow | null;
    }>(`/api/admin/community/requests/${id}`),
  rejectOffer: (id: string, reason: string) =>
    api.post<{ state: string }>(`/api/admin/community/offers/${id}/reject`, { reason }),

  reviews: (params: { merchant?: string; hidden?: string; maxRating?: number } = {}) =>
    api.get<{ reviews: AdminReviewRow[] }>(
      `/api/admin/community/reviews?merchant=${encodeURIComponent(params.merchant ?? '')}` +
        `&hidden=${encodeURIComponent(params.hidden ?? '')}&maxRating=${params.maxRating ?? 5}`
    ),
  reputation: (id: string) =>
    api.get<AdminReputation>(`/api/admin/community/merchants/${id}/reputation`),
  adjustReputation: (id: string, points: number, note: string) =>
    api.post(`/api/admin/community/merchants/${id}/reputation`, { points, note }),

  hideProduct: (id: string) => api.post(`/api/admin/community/products/${id}/hide`),
  hideReview: (id: string, hidden: boolean) =>
    api.post<{ hidden: boolean }>(`/api/admin/community/reviews/${id}/hide`, { hidden }),
  removeRequest: (id: string, reason: string) =>
    api.post(`/api/admin/community/requests/${id}/remove`, { reason }),
};
