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
  /** Active PRO membership status, independent of identity verification. */
  pro_badge?: boolean;
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
  /** The merchant's own view only — the public shape carries `sales_tier`. */
  sold_count?: number;
  /** Public: sales rounded DOWN to a tier the product has passed, or null
   *  below the first tier — never the exact count (worker/lib/salesBadge.ts). */
  sales_tier?: number | null;
  view_count?: number;
  /** Public shape reports availability, never the exact count. */
  in_stock?: boolean;
  /**
   * Levonis's own hide, beside (never inside) the merchant's lifecycle
   * (migration 0118). While set, the product is off the storefront whatever
   * its lifecycle says, the merchant cannot publish it, and `reason` is what
   * they are told. Merchant's own reads only.
   */
  moderation?: { hidden_by_admin: boolean; reason: string; at: string } | null;
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
  /** The domain store addresses live under, from the server's configuration;
   *  null when none is configured (audit 01 B19). */
  root_domain?: string | null;
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
  /** The manager's filtered mode: server-side search/filters/sort + total. */
  productsPaged: (params: Record<string, string | number | undefined>) => {
    const qs = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join('&');
    return api.get<{ products: MerchantProduct[]; total: number; page: number; limit: number }>(
      `/api/merchant/products?${qs}`
    );
  },
  productsStats: () =>
    api.get<ProductsStats>('/api/merchant/products/stats'),
  productInsights: (id: string) =>
    api.get<{ product: MerchantProduct; insights: ProductInsights }>(
      `/api/merchant/products/${id}/insights`
    ),
  importProducts: (csv: string, confirm: boolean) =>
    api.post<ProductsImportReport>('/api/merchant/products/import', { csv, confirm }),
  createProduct: (body: Record<string, unknown>) =>
    api.post<{ product: MerchantProduct }>('/api/merchant/products', body),
  updateProduct: (id: string, body: Record<string, unknown>) =>
    api.patch<{ product: MerchantProduct }>(`/api/merchant/products/${id}`, body),
  deleteProduct: (id: string) => api.delete<{ archived: boolean }>(`/api/merchant/products/${id}`),
  duplicateProduct: (id: string) =>
    api.post<{ product: MerchantProduct }>(`/api/merchant/products/${id}/duplicate`),
  orders: (params = '') =>
    api.get<{ orders: Record<string, unknown>[]; next_cursor: string | null }>(`/api/merchant/orders${params}`),
  order: (id: string) =>
    api.get<{ order: Record<string, unknown>; items: Record<string, unknown>[] }>(`/api/merchant/orders/${id}`),
  setOrderStatus: (id: string, status: string, reason = '') =>
    api.post<{ status: string; refunded_usd_cents?: number }>(
      `/api/merchant/orders/${id}/status`,
      reason ? { status, reason } : { status }
    ),
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
    api.get<{ preferences: Record<string, boolean>; forced: string[]; wired?: string[] }>('/api/merchant/notifications'),
  setNotifications: (body: Record<string, boolean>) =>
    api.patch<{ preferences: Record<string, boolean>; forced: string[]; wired?: string[] }>('/api/merchant/notifications', body),
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
  resolve: () =>
    api.get<{ kind: string; store: MerchantStore | null; root_domain?: string | null }>('/api/storefront/resolve'),
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

/** The products manager's stat feed — every number a real aggregate. */
export interface ProductsStats {
  totals: {
    total: number;
    active: number;
    draft: number;
    hidden: number;
    out_of_stock: number;
    views: number;
    sold: number;
  };
  weekly: Array<{
    week: string;
    added: number;
    active_added: number;
    draft_added: number;
    hidden_added: number;
    views: number;
  }>;
  categories: string[];
  sales_daily: Array<{ day: string; orders: number; gross: number }>;
}

export interface ProductInsights {
  views: number;
  sold: number;
  revenue_iqd: number;
  units_ordered: number;
  orders: number;
  created_at: string;
  updated_at: string;
}

export interface ProductsImportReport {
  confirmed: boolean;
  created: number;
  valid: number;
  invalid: number;
  report: Array<{ row: number; name: string; ok: boolean; error?: string }>;
}

/** One saved store product, as the saved-items list renders it. */
export interface SavedProduct {
  /**
   * WHICH HEART SAVED THIS, and therefore which page opens it and which door
   * deletes it. 'store' = a merchant's own product in
   * `community_product_favorites`; 'catalog' = a shop product in `favorites`,
   * saved from the main product page. Both land on «المحفوظات»; treating them
   * as one is what made the catalogue ones invisible.
   */
  source: 'store' | 'catalog';
  product_id: string;
  slug: string;
  name: string;
  name_ar: string | null;
  image: string | null;
  price_iqd: number;
  original_price_iqd: number | null;
  /**
   * null on a catalogue product: its availability is the whole availability
   * engine, not a column, so this list does not claim one either way and the
   * card prints no availability note.
   */
  in_stock: boolean | null;
  saved_at: string;
  /** null on a catalogue product — it has no merchant behind it. */
  store_slug: string | null;
  store_name: string | null;
  store_url: string | null;
}

/** The storefront heart — per-user, so it lives outside /api/storefront. */
export const communityFavoritesApi = {
  list: () => api.get<{ items: SavedProduct[] }>('/api/community-favorites'),
  ids: () => api.get<{ product_ids: string[] }>('/api/community-favorites/ids'),
  add: (productId: string) => api.put<{ favorite: boolean }>(`/api/community-favorites/${productId}`),
  remove: (productId: string) => api.delete<{ favorite: boolean }>(`/api/community-favorites/${productId}`),
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
  /**
   * WHY a line cannot be bought, when it cannot (audit 02 B25): the product
   * was hidden or archived, the stock is short, the chosen option is gone,
   * the store stopped taking orders, the store is the customer's own, or the
   * line belongs to a store other than the one this cart is locked to.
   */
  unavailable_reason?: MerchantLineUnavailable | null;
  /** The option / colour the customer chose, as the store names it — '' for none. */
  variant?: string;
}

export type MerchantLineUnavailable =
  | 'unavailable'
  | 'out_of_stock'
  | 'option_gone'
  | 'store_closed'
  | 'own_store'
  | 'other_store';

export interface MerchantCartData {
  scope: { seller_type: string; merchant_id?: string; store_id?: string } | null;
  store: { id: string; slug: string; name: string; merchant_id: string } | null;
  items: MerchantCartLine[];
  subtotal_iqd: number;
}

export interface StoreQuote {
  store_id?: string;
  store_name: string;
  store_slug: string;
  lines: Array<{
    cart_item_id: string;
    product_id?: string;
    name: string;
    image: string;
    qty: number;
    unit_price_iqd: number;
    line_total_iqd: number;
    /** The option / colour chosen, as the store names it — '' for none. */
    variant?: string;
  }>;
  subtotal_iqd: number;
  delivery_iqd: number;
  coupon_code: string;
  discount_iqd: number;
  total_iqd: number;
  /** What placing the order charges if nothing moves (audit 02 B12). */
  expected_total_iqd: number;
  /**
   * The server's name for EVERY figure above. Placing the order sends it
   * back; if anything that costs money moved since, the server refuses
   * `409 QUOTE_CHANGED` with the fresh quote instead of charging the new
   * total silently.
   */
  quote_fingerprint: string;
  /**
   * PREPAID ONLY (§74). A community-store order is paid from the wallet
   * before the merchant ships it — there is no cash on delivery and no
   * warehouse pickup on this path — so the quote answers whether the wallet
   * can actually pay, rather than leaving the customer to find out at the
   * last tap. Every number is the server's.
   */
  payment_method: 'wallet';
  /** Spendable only — money already held for another order is not it. */
  wallet_available_iqd: number;
  wallet_covers: boolean;
  wallet_shortfall_iqd: number;
  /** Absolute: a merchant subdomain does not route `/wallet` itself. */
  wallet_topup_url: string;
}

/** What `/api/store-orders` answers about a placed order — the public projection (B18). */
export interface StoreOrderPublic {
  id: string;
  status: string;
  total_iqd: number;
  [key: string]: unknown;
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
  // No `payWithWallet`: there is nothing to choose. The server refuses an
  // explicit `false` with STORE_PREPAID_ONLY rather than silently charging a
  // wallet for a method the customer did not pick.
  place: (body: { addressId: string; idempotencyKey: string; quoteFingerprint: string; couponCode?: string }) =>
    api.post<{ order: StoreOrderPublic; replay?: boolean }>('/api/store-orders', body),
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
  /** False for an assistant-scope admin: the commission figures are null. */
  financial?: boolean;
  merchants: { total: number; verified: number; suspended: number };
  stores: { total: number; active: number };
  products: { total: number; active: number };
  requests: { total: number; open: number };
  offers: { total: number };
  /** Custom (request) orders, funded and never cancelled or refunded. */
  orders: { total: number; gross: number; fees: number | null; completed: number };
  /** Store-product sales, cancelled ones excluded. */
  store_sales?: { total: number; gross: number; fees: number | null };
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
  /** The store's real address, from the server's configured root domain. */
  store_url?: string | null;
  owner_email: string;
  owner_name: string;
  created_at: string;
}

/** One of a merchant's products as moderation sees it (admin only). */
export interface AdminMerchantProduct {
  id: string;
  slug: string;
  name: string;
  name_ar: string;
  price_iqd: number;
  image: string | null;
  lifecycle: string;
  /** On the storefront right now. */
  live: boolean;
  admin_hidden: boolean;
  admin_hidden_at: string | null;
  admin_hidden_reason: string;
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
  /** 1 when the reporter or the merchant wrote last (or nobody has answered
   *  yet) — worker/routes/adminChats.ts `COMPLAINT_AWAITS_DESK_SQL`. */
  awaiting_reply?: number;
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

/** One row of a complaint thread. `internal` is an admin-only note that the
 *  parties never see (migration 0031); everything else is the reply. */
export interface AdminComplaintMessage {
  id: string;
  complaint_id: string;
  sender_id: string;
  sender_role: string;
  sender_name: string | null;
  body: string;
  file_key: string | null;
  /** `/files/<key>` and the element it renders as, composed by the server. */
  file_url?: string | null;
  kind?: 'text' | 'image' | 'video';
  internal: number;
  created_at: string;
  /** Client only: on screen, not yet acknowledged by the server. */
  pending?: boolean;
}

export const adminCommunityApi = {
  overview: () => api.get<{ success: true } & CommunityOverview>('/api/admin/community/overview'),
  settings: () => api.get<{ settings: Record<string, string> }>('/api/admin/community/settings'),
  saveSettings: (body: Record<string, number>) =>
    api.patch<{ settings: Record<string, number>; applies_to: string }>('/api/admin/community/settings', body),

  /**
   * The maintenance gate — «ليفو كوميونيتي تحت الصيانة، واسمح بالأعضاء من
   * قائمة في الادارة». Its own pair of routes rather than a couple of keys in
   * `settings` above, because opening the community is a door and every flip
   * of it is audited on the server (worker/routes/adminCommunity.ts).
   */
  gate: () =>
    api.get<{
      open: boolean;
      closed: boolean;
      allowed_user_ids: string[];
      members: Array<{ id: string; username: string | null; name: string | null; email: string | null }>;
    }>('/api/admin/community/gate'),
  saveGate: (open: boolean, allowed_user_ids: string[]) =>
    api.put<{ open: boolean; closed: boolean; allowed_user_ids: string[]; changed: boolean }>(
      '/api/admin/community/gate',
      { open, allowed_user_ids }
    ),

  merchants: (q = '') =>
    api.get<{ merchants: AdminMerchantRow[] }>(
      `/api/admin/community/merchants${q ? `?q=${encodeURIComponent(q)}` : ''}`
    ),
  verify: (id: string, verified: boolean) =>
    api.post<{ verified: boolean }>(`/api/admin/community/merchants/${id}/verify`, { verified }),
  setStatus: (id: string, status: string, reason: string) =>
    api.post<{ status: string; store_status: string | null }>(`/api/admin/community/merchants/${id}/status`, { status, reason }),
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
      messages: AdminComplaintMessage[];
      escrow: AdminEscrow | null;
      escrow_events: Record<string, unknown>[];
    }>(`/api/admin/community/complaints/${id}`),
  setComplaintStatus: (id: string, status: string, resolution: string) =>
    api.post<{ status: string }>(`/api/admin/community/complaints/${id}/status`, { status, resolution }),
  /**
   * The REPLY. A status is not an answer — see the route's own header in
   * worker/routes/adminCommunity.ts. `internal` is passed explicitly on every
   * call, never left to a default, because the difference between the two is
   * whether the person who complained reads it.
   */
  replyToComplaint: (id: string, body: string, internal: boolean, fileKey?: string) =>
    api.post<{ message: AdminComplaintMessage }>(`/api/admin/community/complaints/${id}/messages`, {
      body,
      internal,
      // An attachment uploaded with purpose 'complaint' — see the route.
      ...(fileKey ? { fileKey } : {}),
    }),

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

  /** Levonis's own hide — sticky, with the reason the merchant is shown. */
  hideProduct: (id: string, hidden: boolean, reason = '') =>
    api.post<{ hidden: boolean }>(`/api/admin/community/products/${id}/hide`, { hidden, reason }),
  merchantProducts: (id: string) =>
    api.get<{ products: AdminMerchantProduct[] }>(`/api/admin/community/merchants/${id}/products`),
  hideReview: (id: string, hidden: boolean) =>
    api.post<{ hidden: boolean }>(`/api/admin/community/reviews/${id}/hide`, { hidden }),
  removeRequest: (id: string, reason: string) =>
    api.post(`/api/admin/community/requests/${id}/remove`, { reason }),
};
