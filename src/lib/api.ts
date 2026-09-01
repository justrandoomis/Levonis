/**
 * Typed API client. All requests go to the Worker backend with cookie
 * credentials; the browser never builds SQL and never holds tokens.
 */

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    /**
     * Machine-readable context the server attached to a refusal, e.g. the
     * cart's current shipping type versus the one just attempted. Without it
     * the UI can only repeat the generic message; with it the UI can name
     * both types and offer the right way out.
     */
    public details?: Record<string, unknown>
  ) {
    super(message);
  }
}

export function isNotConfigured(e: unknown): boolean {
  return e instanceof ApiError && e.status === 503;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined && !(body instanceof FormData)) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  } else if (body instanceof FormData) {
    init.body = body;
  }
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'Network error — check your connection and try again');
  }
  let data: { success?: boolean; error?: string; code?: string; details?: Record<string, unknown> } & T;
  try {
    data = await res.json();
  } catch {
    throw new ApiError(res.status, res.ok ? 'Invalid server response' : `Server error (${res.status})`);
  }
  if (!res.ok || data.success === false) {
    throw new ApiError(res.status, data.error || `Server error (${res.status})`, data.code, data.details);
  }
  return data;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
};

// ---------------------------------------------------------------- types

export interface ApiUser {
  id: string;
  email: string;
  username: string | null;
  name: string;
  role: 'customer' | 'merchant' | 'admin';
  isAdmin: boolean;
  is_investor: boolean;
  /** Legacy column, no longer authoritative — see membership_tier. */
  subscription_plan: 'free' | 'plus' | 'pro';
  /** Effective membership tier resolved from the memberships ledger. */
  membership_tier: 'free' | 'plus' | 'pro' | 'prime';
  /** NULL for a non-admin. 'assistant' = no financial data (mandate §11). */
  admin_scope?: 'full' | 'assistant' | null;
  /** UI hint only — the SERVER decides and strips cost either way. */
  can_view_financials?: boolean;
  subscription_expiry: number;
  locale: 'en' | 'ar' | 'ku';
  avatar_key: string | null;
  bio: string;
  website: string;
  profile: Record<string, unknown>;
  /** ISO 3166-1 alpha-2, or null when the person has not said. */
  country: string | null;
  /** MASKED, e.g. `+9647******567` — the account's own verified number. */
  phone: string | null;
  has_phone: boolean;
  /** Whether Google sign-in is linked. The Google subject stays server-side. */
  has_google: boolean;
  /** Signup-wizard state: 'new' | 'existing' | 'skipped' | 'done'. Separate
   *  from `completion`, which is about the profile fields themselves. */
  onboarding: string;
  /** Derived on every read from the fields — never a stored flag. */
  completion: { percent: number; complete: boolean; missing: string[] };
  checkin_streak: number;
  last_checkin_day: string | null;
  created_at: string;
}

export interface ApiProduct {
  id: string;
  slug: string;
  status?: string;
  name: string;
  name_ar: string;
  name_ku?: string;
  description: string;
  description_ar: string;
  description_ku?: string;
  images: string[];
  options: Array<{ id: string; name?: string; name_ar?: string; image?: string; price_iqd?: number; prime_price_iqd?: number; pro_price_iqd?: number; cost_iqd?: number }>;
  colors: Array<{ id: string; name?: string; name_ar?: string; hex?: string; gradient?: string; image?: string; option_id?: string; linked_option_ids?: string[]; price_iqd?: number; prime_price_iqd?: number; pro_price_iqd?: number; cost_iqd?: number }>;
  selling_type: 'direct_sale' | 'pre_order' | 'bundle';
  sale_types?: Array<'direct_sale' | 'pre_order' | 'bundle'>;
  shipping_methods: Array<{ id: string; method?: string; delivery_time?: string; price_iqd?: number }>;
  price_iqd: number;
  prime_price_iqd?: number | null;
  pro_price_iqd?: number | null;
  /** What this viewer actually pays, and the regular price it is compared
   *  against. Compare-at (§4) no longer exists. The display price is the
   *  CHEAPEST way to buy the product — the minimum tier-resolved price
   *  across the base row and every active option/colour. */
  display_price_iqd?: number;
  display_applied_tier?: 'regular' | 'pro' | 'prime';
  display_regular_iqd?: number;
  /** Cheapest explicit PRIME / PRO price across levels; null = none exists.
   *  Feed the card's faint tier-teaser lines. */
  display_prime_iqd?: number | null;
  display_pro_iqd?: number | null;
  /** True when variants differ in price — the card may say «يبدأ من». */
  display_from?: boolean;
  /** Availability premium charged on direct (from-stock) lines; folded into
   *  the quote's final price server-side, shown only as the final number. */
  direct_surcharge_iqd?: number | null;
  product_cost_iqd?: number | null;
  membership_prices: { plus?: number; pro?: number };
  payment_options: string[];
  subcategory_id: string;
  categories: string;
  display_order: number;
  is_featured: boolean;
  specifications: Array<{ key: string; value: string }>;
  brand: string;
  labels: string[];
  hashtags: string[];
  algorithm_tags?: string[];
  features: string[];
  description_images: string[];
  description_videos: string[];
  stores: Array<{ name: string; url: string; price_iqd?: number }>;
  warranty_plans: Array<{ name: string; price_iqd?: number }>;
  how_to_use: string;
  stock: number | null;
  created_at: string;
  merchant?: { id: string; name: string; verified: boolean };
}

export interface CartItem {
  id: string;
  productId: string;
  slug: string;
  name: string;
  name_ar: string;
  image: string;
  qty: number;
  option_id: string;
  color_id: string;
  shipping_method_id: string;
  variantLabel: string;
  unit_price_iqd: number;
  /** Server-resolved price breakdown for this line. `regular_iqd` vs
   *  `applied_iqd` is the only honest saving to display (§4 retired
   *  compare-at). */
  breakdown?: {
    applied_iqd: number;
    applied_tier: 'regular' | 'pro' | 'prime';
    regular_iqd: number;
    prime_iqd: number | null;
    unit_subtotal_iqd: number;
    price_source: string;
    errors: string[];
  };
  stock: number | null;
  options: ApiProduct['options'];
  colors: ApiProduct['colors'];
  shipping_methods: ApiProduct['shipping_methods'];
}

export interface ApiAddress {
  id: string;
  label: string;
  name: string;
  phone: string;
  address: string;
  landmark: string;
  /** 0026: the parts a courier's form asks for. Empty on every address saved
   *  before that migration — nothing was parsed out of the old free-text
   *  line, because guessing would have produced confident, wrong data. */
  governorate: string;
  area: string;
  notes: string;
  is_default: number;
  created_at: string;
}

export interface ApiOrder {
  id: string;
  status: 'pending' | 'confirmed' | 'processing' | 'shipped' | 'delivered' | 'cancelled';
  address: Partial<ApiAddress>;
  delivery_method: { id?: string; titleAr?: string; titleEn?: string; price_iqd?: number };
  payment_method_id: string;
  subtotal_iqd: number;
  shipping_iqd: number;
  points_discount_iqd: number;
  wallet_applied_iqd: number;
  total_iqd: number;
  due_on_delivery_iqd: number;
  created_at: string;
  updated_at: string;
  items: Array<{
    id: string;
    product_id: string | null;
    name: string;
    image: string;
    variant: string;
    qty: number;
    unit_price_iqd: number;
    line_total_iqd: number;
  }>;
  email?: string;
  username?: string;
  user_id?: string;
}

/** One order item unit — a physical device with its own serial and cover. */
export interface OrderUnit {
  id: string;
  order_item_id: string;
  unit_index: number;
  serial: string | null;
  warranty_base_months: number | null;
  warranty_ext_months: number;
  warranty_start_at: string | null;
  warranty_end_at: string | null;
}

/** The money view every screen reads and none recomputes (orders.ts §5). */
export interface OrderFinancial {
  merchandise_iqd: number;
  fees_iqd: number;
  subtotal_iqd: number;
  coupon_discount_iqd: number;
  points_used: number;
  points_value_iqd: number;
  shipping_iqd: number;
  delivery_waived: boolean;
  total_iqd: number;
  wallet_applied_iqd: number;
  due_on_delivery_iqd: number;
  collected_iqd: number | null;
  outstanding_iqd: number;
  payment_state: string;
}

/** Everything the fulfilment screen needs for ONE order. */
export interface AdminOrderDetail extends ApiOrder {
  admin_note: string;
  membership_tier_snapshot?: string;
  delivery_waived?: boolean;
  coupon?: { code?: string; discount_iqd?: number } | null;
  coupon_discount_iqd?: number;
  financial: OrderFinancial;
  customer: {
    id: string | null;
    name: string | null;
    username: string | null;
    email: string | null;
    account_phone: string | null;
    membership_tier: string;
    member_since: string | null;
  };
  units: OrderUnit[];
  invoice: { id: string; invoice_no: string; revision: number; payment_status: string } | null;
  chat_id: string | null;
  /**
   * The tracking path, computed server-side. The panel holds no copy of the
   * stage list, its labels or which moves are legal — the owner already
   * reported the cost of a panel deciding that for itself ("عند تحديث الطلب
   * يظهر خيارين فقط"). Absent when the enrichment failed, which the modal
   * degrades on rather than 500ing.
   */
  tracking?: AdminOrderTracking;
}

export interface AdminOrderTracking {
  shipping_type: string;
  stage: string;
  stage_source: string;
  stage_changed_at: string;
  next_stage: string | null;
  next_stage_at: string | null;
  delivery: {
    provider: string;
    remote_id: string;
    tracking_no: string;
    status_text: string;
    synced_at: string | null;
    error: string;
  };
  steps: Array<{
    stage: string;
    source: 'manual' | 'automatic' | 'delivery_api';
    reached: boolean;
    current: boolean;
    at: string | null;
    label_ar: string;
    label_en: string;
  }>;
  available: Array<{
    stage: string;
    source: 'manual' | 'automatic' | 'delivery_api';
    label_ar: string;
    label_en: string;
  }>;
  history: Array<{
    stage: string;
    status: string;
    source: string;
    changed_at: string;
    changed_by: string;
    note: string;
  }>;
}

export interface WalletTx {
  id: string;
  type: 'deposit' | 'withdrawal';
  currency: 'USD' | 'POINT';
  amount: number; // USD cents or points
  status: 'pending' | 'approved' | 'rejected';
  date: string;
  note: string;
  adminNote: string;
  accountNumber: string;
  paymentMethod: string;
  hasReceipt: boolean;
  receiptUrl: string | null;
  ref: string;
  email?: string;
  username?: string;
  userId?: string;
}

export interface DeliveryMethod {
  id: string;
  titleAr: string;
  titleEn: string;
  descAr: string;
  descEn: string;
  price_iqd: number;
  icon: string;
}
export interface CheckoutPaymentMethod { id: string; titleAr: string; titleEn: string; icon: string }
export interface CartShippingMethod { id: string; titleAr: string; titleEn: string; descAr: string; descEn: string }
export interface ManualPaymentMethod { id: string; name: string; details: string }

export interface PublicSettings {
  exchangeRate: number;
  currency: 'IQD' | 'USD';
  adVideoUrl: string;
  paymentMethods: ManualPaymentMethod[];
  checkoutDeliveryMethods: DeliveryMethod[];
  checkoutPaymentMethods: CheckoutPaymentMethod[];
  cartShippingMethods: CartShippingMethod[];
  homeSections: Array<{ id: string; titleEn: string; titleAr: string; isVisible: boolean }>;
  homeBanners: Record<string, HomeBanner[]>;
  homeSectionItems: Record<string, HomeSectionItem[]>;
  homeAds: Array<{ id: string; text: string; animation: string }>;
}

/** Owner-authored copy, one string per language. Never machine-translated —
 *  an empty language falls back to one the owner actually wrote. */
export interface LocalizedText {
  ar: string;
  en: string;
  ckb: string;
}

export interface HomeBanner {
  id: string;
  image: string;
  link: string;
  title: LocalizedText;
  subtitle: LocalizedText;
  cta: LocalizedText;
}

export interface HomeSectionItem {
  id: string;
  title: string;
  subtitle: string;
  image: string;
  link: string;
}

/** A top-level catalog or a brand, as the home page shows it. */
export interface HomeTaxon {
  id: string;
  slug: string;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  product_count: number;
}

/** The string to show for `lang`, falling back to the first language the
 *  owner filled in. Mirrors pickText in worker/lib/homeContent.ts. */
export function pickText(t: LocalizedText | undefined, lang: string): string {
  if (!t) return '';
  const order =
    lang === 'en' ? [t.en, t.ar, t.ckb] : lang === 'ckb' ? [t.ckb, t.ar, t.en] : [t.ar, t.en, t.ckb];
  return order.find((v) => !!v) ?? '';
}

// ---------------------------------------------------------------- helpers

/** Format an IQD integer amount for display. */
export function formatIqd(amount: number): string {
  return `${Math.round(amount).toLocaleString()} د.ع`;
}

/** Format USD cents for display. */
export function formatUsdCents(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function usdCentsToIqd(cents: number, exchangeRate: number): number {
  return Math.floor((cents * exchangeRate) / 100);
}

export function iqdToUsdCents(iqd: number, exchangeRate: number): number {
  return Math.ceil((iqd * 100) / exchangeRate);
}

let idempotencyCounter = 0;
export function newIdempotencyKey(): string {
  idempotencyCounter += 1;
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${idempotencyCounter}`;
}

/** Upload a file; returns its key + URL. */
export async function uploadFile(
  file: File,
  purpose: 'receipt' | 'avatar' | 'chat' | 'product' | 'community'
): Promise<{ key: string; url: string }> {
  const form = new FormData();
  form.append('purpose', purpose);
  form.append('file', file);
  return api.post<{ key: string; url: string }>('/api/uploads', form);
}
