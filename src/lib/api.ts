import { beginRequestFeedback, type MascotFeedback } from './mascotRequest';
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
    public details?: Record<string, unknown>,
    /**
     * The WHOLE refusal body, exactly as the server sent it. Some routes
     * answer with their machine-readable context at the top level rather than
     * under `details` — the template apply names the section and field that
     * did not persist, and lists the mismatches, that way. Without the body
     * the UI could only repeat the sentence and would have to invent the
     * numbers, which is the failure mode docs/TXT_IMPORT_PARITY.md §5.4
     * forbids. Additive: `details` keeps its exact old meaning.
     */
    public body?: Record<string, unknown>
  ) {
    super(message);
  }
}

export function isNotConfigured(e: unknown): boolean {
  return e instanceof ApiError && e.status === 503;
}

/**
 * PER-REQUEST CONTROL: a caller may cancel, and every request has a deadline.
 *
 * Without a deadline a request that never settles never rejects, and any UI
 * whose "loading" flag is owned by the promise stays loading forever with no
 * error and no retry — which is exactly how the product page came to sit in
 * «يجري تحديث السعر…» after a mobile network handover. A timeout turns a hang
 * into an ordinary failure the UI already knows how to show and retry.
 */
export interface RequestOptions {
  /** The caller's own cancellation — a React effect cleanup, typically. */
  signal?: AbortSignal;
  /** Silent background polling must not animate loading/success on every tick. */
  mascot?: MascotFeedback;
  /** Deadline in ms. Defaults to DEFAULT_TIMEOUT_MS; 0 disables it. */
  timeoutMs?: number;
  /**
   * Extra request headers.
   *
   * Exists for ONE case: the print-quote flow lets a signed-out visitor upload
   * a model and be quoted for it, and the capability that proves the upload is
   * theirs travels in `X-Guest-Token`. It is not a cookie because it must NOT
   * be sent to anything else — a header the caller opts into per request is the
   * narrowest way to carry it. `Content-Type` is set after this, so a caller
   * cannot use it to change how a body is encoded.
   */
  headers?: Record<string, string>;
}

/**
 * Long enough that a slow Iraqi mobile round trip completes, short enough that
 * a dead connection surfaces as an error while the customer is still looking
 * at the screen. Uploads pass their own (or 0) — a large file legitimately
 * takes longer than any page interaction.
 */
const DEFAULT_TIMEOUT_MS = 20000;

async function requestRaw<T>(method: string, path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
  const init: RequestInit = { method, credentials: 'same-origin', headers: { ...opts?.headers } };
  if (body !== undefined && !(body instanceof FormData)) {
    // After the caller's headers, never before: the body encoding is this
    // function's to decide.
    init.headers = { ...opts?.headers, 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  } else if (body instanceof FormData) {
    init.body = body;
  }
  const controller = new AbortController();
  init.signal = controller.signal;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timedOut = false;
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : null;
  const onCallerAbort = () => controller.abort();
  opts?.signal?.addEventListener('abort', onCallerAbort);
  /**
   * THE DEADLINE COVERS THE BODY, NOT JUST THE HEADERS.
   *
   * `await fetch(...)` resolves the moment the response HEADERS arrive. The
   * body is still streaming, and reading it is a second await with its own
   * chance to hang. The timer used to be cleared between the two, which left
   * `await res.json()` running with no deadline and no signal — so a response
   * whose headers arrived and whose body then stalled produced a promise that
   * NEVER SETTLED. Not rejected: never settled.
   *
   * That is a far worse failure than a slow request, because every consumer in
   * this app releases its loading state in a `finally`, and a `finally` cannot
   * run for a promise that does not settle. One stalled body froze
   * `AuthContext`'s isLoaded, Home's critical-ready flag and the pages' busy
   * flags at their initial values for the life of the tab — which is how the
   * mascot came to sit at bootstrap size in the middle of a fully rendered
   * page, still waiting for an app that had already arrived.
   *
   * One try/finally around BOTH awaits fixes it: the AbortController's
   * deadline now also aborts a stalled body read, and it surfaces as the
   * ordinary network error the retry UI already knows how to show.
   */
  try {
    const res = await fetch(path, init);
    let data: { success?: boolean; error?: string; code?: string; details?: Record<string, unknown> } & T;
    try {
      data = await res.json();
    } catch (err) {
      // An abort landing DURING the body read is the deadline or the caller,
      // never a malformed payload. Rethrow it so the classification below —
      // which is the one place that can tell those two apart — decides.
      if (controller.signal.aborted) throw err;
      throw new ApiError(res.status, res.ok ? 'Invalid server response' : `Server error (${res.status})`);
    }
    if (!res.ok || data.success === false) {
      throw new ApiError(
        res.status,
        data.error || `Server error (${res.status})`,
        data.code,
        data.details,
        data as unknown as Record<string, unknown>
      );
    }
    return data;
  } catch (err) {
    // Everything this function decided to throw is already the right error.
    if (err instanceof ApiError) throw err;
    // A caller-cancelled request is not a failure to report: the effect that
    // started it has already moved on, and its own cleanup owns the state.
    // A DEADLINE, though, is a real failure the customer must be able to see
    // and retry — so it travels as the ordinary network error.
    if (opts?.signal?.aborted && !timedOut) throw new ApiError(0, 'Request cancelled', 'ABORTED');
    throw new ApiError(0, 'Network error — check your connection and try again');
  } finally {
    if (timer) clearTimeout(timer);
    opts?.signal?.removeEventListener('abort', onCallerAbort);
  }
}

async function request<T>(method: string, path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
  const feedback = beginRequestFeedback(method, path, opts?.mascot);
  try {
    const result = await requestRaw<T>(method, path, body, opts);
    feedback.finish();
    return result;
  } catch (error) {
    feedback.finish(error instanceof ApiError ? error : { status: 0 });
    throw error;
  }
}

/**
 * TWO COMPONENTS ASKING THE SAME QUESTION AT THE SAME MOMENT ASK IT ONCE.
 *
 * THE DEFECT. Nothing deduplicated anything. `/api/cart` is fetched
 * independently by `BottomNav` (for the badge), by `Cart` and by `Checkout`;
 * `/api/home` by `Home` and again by `Bundles` (which reads only the category
 * list from it). Mounting a page therefore issued the same GET two or three
 * times in the same tick, and every one of them was a real round trip.
 *
 * WHY COALESCING AND NOT A CACHE. A cache has to decide how long an answer
 * stays true, and on this platform a price can move while the screen is open —
 * `useFreshOnReturn` exists precisely because a stale total is worse than a
 * slow one. This stores nothing and expires nothing. It only notices that a
 * request for the same URL is ALREADY IN FLIGHT and hands the second caller
 * the same promise. Both get the same fresh response the server is already
 * composing; the instant it settles the entry is gone. There is no window in
 * which a stored answer can be served, so there is no staleness to reason
 * about.
 *
 * GET ONLY, and deliberately. A repeated POST/PUT/PATCH/DELETE is an ACTION,
 * and two of them are two intentions — the cart's own double-tap guards decide
 * that, not this. Merging them here would silently swallow a retry.
 *
 * A caller that passes its own AbortSignal opts out: it wants control over a
 * request it can cancel, and cancelling a shared promise would cancel it for
 * whoever else is waiting on it.
 */
const inflightGets = new Map<string, Promise<unknown>>();

function coalescedGet<T>(path: string, opts?: RequestOptions): Promise<T> {
  if (opts?.signal) return request<T>('GET', path, undefined, opts);
  const existing = inflightGets.get(path);
  if (existing) return existing as Promise<T>;
  const started = request<T>('GET', path, undefined, opts).finally(() => {
    inflightGets.delete(path);
  });
  inflightGets.set(path, started);
  return started;
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => coalescedGet<T>(path, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('POST', path, body, opts),
  put: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('PUT', path, body, opts),
  patch: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('PATCH', path, body, opts),
  delete: <T>(path: string, opts?: RequestOptions) => request<T>('DELETE', path, undefined, opts),
};

/** True for a request the CALLER cancelled — never worth showing to anyone. */
export function isAborted(e: unknown): boolean {
  return e instanceof ApiError && e.code === 'ABORTED';
}

/**
 * THE REASON, NOT THE CATEGORY.
 *
 * `e instanceof ApiError ? e.message : 'فشل الرفع'` was written across the admin
 * to avoid printing an internal exception at a customer. It has the opposite
 * effect where it is actually used: `requestRaw` already converts EVERY network
 * and server failure into an `ApiError`, so the only errors that reach the
 * `else` branch are the ones thrown BEFORE the request — the image decoder, the
 * WebP encoder, the size guards. Those are exactly the failures whose reason the
 * admin needs, and they were the only ones being thrown away. An upload that
 * failed because the file is 74 MB, and one that failed because the phone has no
 * WebP encoder, both read as "فشل الرفع / upload failed" with nothing to act on.
 *
 * `ApiError extends Error`, so one branch covers both. A non-Error throw (which
 * nothing in this codebase does) still falls back to the caller's wording.
 */
export function failureText(e: unknown, fallback: string): string {
  if (isAborted(e)) return fallback;
  const message = e instanceof Error ? e.message.trim() : '';
  return message || fallback;
}

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
  /**
   * A SCHEDULED SPECIAL OFFER on this product (docs/BUNDLES_MYSTERY.md §9,
   * §12) — the same `offer_windows` row a bundle uses, on the same subject.
   * Present only when one exists; a missing field means ABSENT, never an
   * assumed `false`. While the window is `live` and the viewer is eligible,
   * the `display_*` block above it already carries the OFFER price, so a card
   * renders the countdown and the badge and computes nothing.
   */
  offer?: {
    offer_id: string | null;
    required_tiers: string[];
    starts_at: string | null;
    ends_at: string | null;
    /** Present on an ordinary product's card; a bundle card's offer block
     *  carries the schedule alone and its state lives in
     *  `composition.availability_state`. */
    schedule_state?: 'upcoming' | 'live' | 'ended';
    price_source?: 'ladder' | 'offer';
    locked?: boolean;
  } | null;
  /** The offer's PLUS rung, offer-scoped only (§4.4). */
  display_plus_iqd?: number | null;
  /**
   * A COMPOSITION CARD CARRIES ITS OWN SLUG KEY (§10).
   *
   * `GET /api/products?type=bundle` and the search branch serialize a
   * composition row through the SAME builder `GET /api/bundles` uses, so a
   * bundle or a mystery offer arrives as a `BundleCard` — locked or not — and
   * `product_slug` is the field that identifies one. A grid reads it to link to
   * `/bundles/<slug>`, where the row can actually be bought; the ordinary
   * product renderer has nothing to show for a composition row (no components,
   * no saving line, `stock: null`, `options: []`).
   */
  product_slug?: string;
  status?: string;
  name: string;
  name_ar: string;
  name_ku?: string;
  description: string;
  description_ar: string;
  description_ku?: string;
  /** Canonical media metadata. The explicit primary wins over legacy order. */
  media?: Array<{
    id: string;
    url: string;
    primary: boolean;
    order: number;
    alt_ar?: string;
    alt_en?: string;
    alt_ckb?: string;
  }>;
  images: string[];
  options: Array<{ id: string; name?: string; name_ar?: string; image?: string; price_iqd?: number; prime_price_iqd?: number; pro_price_iqd?: number; cost_iqd?: number }>;
  colors: Array<{ id: string; name?: string; name_ar?: string; hex?: string; gradient?: string; image?: string; option_id?: string; linked_option_ids?: string[]; price_iqd?: number; prime_price_iqd?: number; pro_price_iqd?: number; cost_iqd?: number }>;
  selling_type: 'direct_sale' | 'pre_order' | 'bundle';
  sale_types?: Array<'direct_sale' | 'pre_order' | 'bundle'>;
  shipping_methods: Array<{ id: string; method?: string; delivery_time?: string; price_iqd?: number }>;
  /** null on legacy products that still use the global delivery tariff. */
  delivery_options?: {
    standard: { enabled: boolean; quantity_step: number; fee_iqd: number };
    personal: { enabled: boolean; quantity_step: number; fee_iqd: number };
  } | null;
  price_iqd: number;
  prime_price_iqd?: number | null;
  pro_price_iqd?: number | null;
  /** What this viewer actually pays, and the regular price it is compared
   *  against. Compare-at (§4) no longer exists. The display price is the
   *  CHEAPEST way to buy the product — the minimum tier-resolved price
   *  across the base row and every active option/colour. */
  display_price_iqd?: number;
  /** 'plus' is emitted for COMPOSITION rows only (a bundle or a mystery
   *  offer): the shared price resolver has three rungs and no PLUS, so a PLUS
   *  member would be shown the regular price on every card and then charged
   *  the PLUS price at the door. No ordinary product row ever carries it. */
  display_applied_tier?: 'regular' | 'plus' | 'pro' | 'prime';
  display_regular_iqd?: number;
  /** Cheapest explicit PRIME / PRO price across levels; null = none exists.
   *  Feed the card's faint tier-teaser lines. */
  display_prime_iqd?: number | null;
  display_pro_iqd?: number | null;
  /** True when variants differ in price — the card may say «يبدأ من». */
  display_from?: boolean;
  /** Exact sellable units across the product's authoritative direct-sale
   *  option/colour combinations. Omitted when the count is intentionally
   *  hidden; cards render the edge only when this is greater than zero. */
  direct_stock_available?: number;
  /** Availability premium charged on direct-priced lines (a direct sale, or a
   *  pre-order paid cash on delivery); waived for an active PRO. Folded into
   *  the quote's final price server-side, shown only as the final number. */
  direct_surcharge_iqd?: number | null;
  /** The owner's catalog flag (catalogs.is_printer_catalog) — the printer
   *  home-delivery note keys off this, never off a fee mapping. */
  is_printer?: boolean;
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
  how_to_use_ar?: string;
  how_to_use_ckb?: string;
  stock: number | null;
  created_at: string;
  merchant?: { id: string; name: string; verified: boolean };
}

/** One extended-warranty option as GET /api/cart lists it for a printer line. */
export interface CartWarrantyPlan {
  id: string;
  title_ar?: string;
  title_en?: string;
  title_ckb?: string;
  duration_months: number;
  duration_kind: 'total' | 'extension' | string;
  /** Resolved by the server against this line's regular price — the exact dinar charged. */
  fee_iqd: number;
  fee_percent?: number | null;
  basis_iqd?: number;
  base_months?: number | null;
  total_months?: number | null;
}

/** The chosen plan as the resolver priced it for the line (frozen at checkout). */
export interface CartWarrantySnapshot {
  plan_id: string;
  title_ar?: string;
  title_en?: string;
  fee_iqd: number;
  duration_months?: number;
  duration_kind?: string;
  fee_percent?: number | null;
  basis_iqd?: number;
  base_months?: number | null;
  total_months?: number | null;
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
  /** Complete canonical relational selection; option_id remains its stable
   * lexical legacy identity while server pricing uses authored group order. */
  option_value_ids?: string[];
  color_id: string;
  /** Legacy column; the line's journey is `transport_method`. */
  shipping_method_id: string;
  /** '' = direct sale; air | sea | land = the pre-order journey (§1). */
  transport_method?: string;
  /** From catalogs.is_printer_catalog — shows the home-delivery note. */
  is_printer?: boolean;
  /** Cash on delivery would change THIS pre-order line's price (it carries a
   *  direct premium this customer pays). The cart explains the rule only then. */
  cod_reprices?: boolean;
  variantLabel: string;
  /** The cart prices a pre-order line as PREPAID; the checkout quote is the
   *  authority once a payment method is chosen. */
  unit_price_iqd: number;
  /** Server-resolved price breakdown for this line. `regular_iqd` vs
   *  `applied_iqd` is the only honest saving to display (§4 retired
   *  compare-at). */
  breakdown?: {
    applied_iqd: number;
    applied_tier: 'regular' | 'pro' | 'prime';
    regular_iqd: number;
    prime_iqd: number | null;
    pro_iqd?: number | null;
    transport?: OrderItemTransport | null;
    /** The direct-sale premium that applies; `waived` = an active PRO pays 0. */
    direct?: { surcharge_iqd: number; waived: boolean } | null;
    /** Which availability fee priced the line. */
    pricing_basis?: 'direct' | 'preorder';
    /** The extended-warranty plan on this line, as the resolver priced it. */
    warranty?: CartWarrantySnapshot | null;
    unit_subtotal_iqd: number;
    price_source: string;
    errors: string[];
  };
  /** The chosen extended-warranty plan id ('' = none). One plan per line,
   *  applied to every unit of the line. */
  warranty_plan_id?: string;
  /** The plans this PRINTER line may carry, each with its fee already resolved
   *  against the line's regular price. Empty for a non-printer. */
  warranty_plans?: CartWarrantyPlan[];
  stock: number | null;
  /** Server verdict for THIS selection: stock at the authoritative level and
   *  whether the line has chosen everything the product requires. */
  availability?: {
    mode?: string;
    reason?: string | null;
    qty_ok?: boolean;
    selection?: { complete: boolean; errors: string[] };
    /**
     * THE SHELF, at the level `products.inventory_mode` selects — never the
     * legacy `CartItem.stock` base row, which is a different number whenever
     * the product tracks stock per option, colour or combination.
     * `available: null` = untracked. `max_qty` is the per-line ceiling the
     * server will actually honour, already clamped by the pre-order counter on
     * a pre-order line (0075), so no screen has to clamp anything itself.
     */
    stock?: {
      tracked: boolean;
      scope: string;
      on_hand: number | null;
      reserved: number;
      available: number | null;
      max_qty: number;
      low: boolean;
    };
    /**
     * 0075 — THE PRE-ORDER COUNTER THIS LINE WOULD CONSUME, which is never the
     * shelf above: the selected route's own quota when it has one, else the
     * model's shared pool. `available: null` = untracked = unlimited, exactly
     * as a null stock means untracked; `0` is tracked and refuses.
     */
    preorder?: {
      enabled?: boolean;
      usable?: boolean;
      reason?: string | null;
      capacity?: {
        tracked: boolean;
        scope: 'preorder' | 'preorder_transport' | null;
        scope_id: string;
        available: number | null;
        max_qty: number;
      };
      routes?: Array<{
        method: string;
        available: number | null;
        scope: 'preorder' | 'preorder_transport' | null;
        scope_id: string;
        usable: boolean;
        reason: string | null;
      }>;
    };
  };
  options: ApiProduct['options'];
  colors: ApiProduct['colors'];
  shipping_methods: ApiProduct['shipping_methods'];
  /** Server-derived method availability for this exact physical line. */
  delivery_availability?: { standard: boolean; personal: boolean };
  /** 'bundle' / 'mystery' for a composition line; absent on an ordinary one. */
  kind?: 'bundle' | 'mystery';
  /**
   * THE BUNDLE, AS ONE LINE WITH ITS CONTENTS (docs/BUNDLES_MYSTERY.md §5.2).
   *
   * The components live ONLY here: they are never top-level `items[]` entries,
   * so the cart's own totals and the coupon basis cannot double-count them.
   * Every figure is the server's — the browser classifies nothing and computes
   * nothing — and each component's `value_iqd` is its STANDALONE value, while
   * the discount is stated once, on the bundle.
   */
  composition?: CartComposition;
}

/** One component of a bundle cart line, as the customer may see it. */
export interface CartComponentView {
  component_id: string;
  product_id: string;
  product: { slug: string; name: string; name_ar: string; image: string };
  variant: string;
  qty_per_bundle: number;
  optional: boolean;
  included: boolean;
  editable: { option: boolean; color: boolean };
  /** The component's STANDALONE value — never a discounted share. */
  value_iqd: number;
  availability: { state: string };
  choices: Array<{ dim: 'option_value' | 'color'; id: string; name: string }>;
}

export interface CartComposition {
  kind: string;
  component_total_iqd: number;
  bundle_price_iqd: number;
  discount_iqd: number;
  saving_percent: number;
  /** 'plus' exists only on a composition row (§4.4): the offer-scoped rung the
   *  shared product ladder does not have. */
  applied_tier: 'regular' | 'plus' | 'prime' | 'pro';
  price_source: 'ladder' | 'derived' | 'offer';
  max_bundles: number | null;
  max_qty: number;
  max_qty_per_order: number;
  availability_state: string;
  shipping_type: string;
  modes: string[];
  /** Always `[]` for a mystery line, before AND after the reveal (§8.2). */
  components: CartComponentView[];
  /**
   * A MYSTERY LINE'S ONLY DISCLOSURE (§5.2): how many spools, which mode, the
   * family the buyer narrowed to, and WHEN the contents are revealed. No pool,
   * no candidate, no weight, no product ever crosses this boundary — `odds`
   * appears only when the admin switched disclosure on, and even then it is
   * aggregated by family and names nothing.
   */
  mystery?: {
    spool_qty: number;
    modes: string[];
    families: string[];
    family_id: string;
    customer_picks_family: boolean;
    reveal_stage: string;
    /** The milestone IN WORDS, rendered by the server's own `stageLabel` —
     *  never a second stage table in the browser (§9, §13.2). */
    reveal_stage_label?: string;
    mode: string | null;
    odds?: Array<{ family_id: string; percent: number }>;
  };
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
  /**
   * PRO/KYC AWARENESS the server computes for this exact screen
   * (worker/routes/addresses.ts: "so the UI/checkout can explain
   * eligibility"). Both were being computed on every read and thrown away by
   * every client — so a PRO could edit the address backing their approved
   * snapshot, the server would detect the divergence, and nothing said a word.
   */
  backs_approved_snapshot?: boolean;
  /** null = this row does not back the snapshot; false = it did and no longer
   *  matches it. */
  matches_approved_snapshot?: boolean | null;
}

export type OrderStatus = 'pending' | 'confirmed' | 'processing' | 'shipped' | 'delivered' | 'cancelled';

/** The four journeys an order can be on (worker/lib/shippingType.ts). */
export type OrderShippingType = 'direct' | 'preorder_air' | 'preorder_sea' | 'preorder_land';

/**
 * The pre-order journey of a line, frozen at checkout. The method is kept even
 * when the commission was not charged; `waived_by` says why it was not — the
 * PRO waiver, or the line having been priced as a direct sale because it was
 * paid cash on delivery.
 */
export interface OrderItemTransport {
  method?: string;
  commission_iqd?: number;
  waived?: boolean;
  waived_by?: 'pro' | 'cod_direct_pricing' | string;
}

/** Per-line price breakdown frozen at checkout (cost fields stripped). */
export interface OrderItemPricing {
  applied_iqd?: number;
  applied_tier?: 'regular' | 'pro' | 'prime' | string;
  regular_iqd?: number;
  prime_iqd?: number | null;
  pro_iqd?: number | null;
  transport?: OrderItemTransport | null;
  /** The direct-sale premium that applied; `waived` = an active PRO paid 0 of it. */
  direct?: { surcharge_iqd: number; waived: boolean } | null;
  /** 'direct' = priced by the direct-sale rule (a direct line, or a pre-order
   *  paid cash on delivery); 'preorder' = the transport commission applied. */
  pricing_basis?: 'direct' | 'preorder' | string;
  unit_subtotal_iqd?: number;
  price_source?: string;
}

/** The exact selection bought, in the shape POST /api/cart/items accepts. */
export interface OrderItemSelection {
  option_id: string;
  option_value_ids: string[];
  color_id: string;
  transport_method: '' | 'air' | 'sea' | 'land';
  warranty_plan_id: string;
}

export interface ApiOrderItem {
  id: string;
  product_id: string | null;
  /** The product's CURRENT slug (null when the product is gone). */
  product_slug?: string | null;
  name: string;
  image: string;
  variant: string;
  qty: number;
  unit_price_iqd: number;
  line_total_iqd: number;
  pricing?: OrderItemPricing | null;
  /** The extended-warranty plan frozen at checkout; `total_months` /
   *  `base_months` are present on orders placed since the extension round. */
  warranty?: {
    plan_id?: string;
    title_ar?: string;
    title_en?: string;
    fee_iqd?: number;
    duration_months?: number;
    duration_kind?: string;
    fee_percent?: number | null;
    basis_iqd?: number;
    base_months?: number | null;
    total_months?: number | null;
  } | null;
  transport?: OrderItemTransport | null;
  /** From catalogs.is_printer_catalog; present when the customer routes
   *  loaded the item — never assumed when absent. */
  is_printer?: boolean;
  selection?: OrderItemSelection;
  /**
   * THE BUNDLE'S PARTS, NESTED UNDER THE PRICED LINE (§6.3). Present only on a
   * bundle parent; the component rows are never top-level items, because four
   * extra 0 IQD rows naming the member products would double the item count and
   * make the screen's line sum disagree with the order's own subtotal.
   */
  bundle?: {
    kind: string;
    component_total_iqd: number | null;
    bundle_price_iqd: number | null;
    bundle_discount_iqd: number | null;
    saving_percent: number | null;
    components: Array<{
      order_item_id: string;
      product_id: string | null;
      product_slug?: string | null;
      name: string;
      image: string;
      variant: string;
      qty: number;
      /** This component's share of the bundle price — what a return refunds. */
      alloc_iqd: number | null;
      /** Its undiscounted standalone value, frozen at checkout. */
      value_iqd: number | null;
    }>;
  } | null;
  /**
   * A MYSTERY LINE'S REVEAL STATE (docs/BUNDLES_MYSTERY.md §8.2).
   *
   * Before the milestone the server sends `{ revealed: false, spools,
   * reveal_at }` and NOTHING else — `picks` is ABSENT, not empty, so a
   * component that reads it optionally cannot render a placeholder that hints
   * at what is coming. After the milestone the picks arrive from the frozen
   * allocation snapshots. An admin payload carries them throughout, with
   * `pending_customer_reveal` marking the ones the customer has not seen.
   */
  mystery?: {
    revealed: boolean;
    spools: number;
    reveal_at: string;
    /** Rendered from the SERVER's `stageLabel`, never a second client table. */
    reveal_stage_label?: string;
    revealed_at?: string | null;
    sale_mode?: string;
    pending_customer_reveal?: boolean;
    picks?: Array<{
      spool_index: number;
      product_id: string;
      product_slug?: string | null;
      name: string;
      image: string;
      variant: string;
      color_id: string;
      option_value_ids: string[];
    }>;
  } | null;
}

/** Stages reached out of the path's length — the card's progress hairline. */
export interface OrderStageProgress {
  index: number;
  total: number;
}

export interface OrderInvoiceRef {
  id: string;
  invoice_no: string;
  revision?: number;
  payment_status?: string;
}

/** Points EARNED by an order: pending under the 7-day hold, or released. */
export interface OrderPointsEarned {
  state: 'none' | 'pending' | 'released' | 'cancelled' | 'reversed' | string;
  pending: number;
  released: number;
  available_at: string | null;
  eligible_iqd?: number;
  iqd_per_point?: number | null;
  rule_version?: string | null;
  redeemed?: number;
  redemption_state?: string;
}

export interface ApiOrder {
  id: string;
  status: OrderStatus;
  address: Partial<ApiAddress>;
  delivery_method: { id?: string; titleAr?: string; titleEn?: string; price_iqd?: number };
  payment_method_id: string;
  subtotal_iqd: number;
  shipping_iqd: number;
  /** Frozen cash-on-delivery tax. Zero for pickup and non-COD payments. */
  cod_tax_iqd: number;
  points_discount_iqd: number;
  wallet_applied_iqd: number;
  total_iqd: number;
  due_on_delivery_iqd: number;
  created_at: string;
  updated_at: string;
  items: ApiOrderItem[];
  email?: string;
  username?: string;
  user_id?: string;
  // ---- the customer's tracking view (orders.ts orderPublic) ----
  shipping_type?: OrderShippingType;
  /** Where the order stands on its path; the tracking endpoint labels it. */
  stage?: string;
  stage_changed_at?: string;
  next_stage?: string | null;
  /** Non-null ONLY when the clock owns the next move — never a guess. */
  next_stage_at?: string | null;
  tracking_no?: string | null;
  delivered_at?: string | null;
  delivery_waived?: boolean;
  membership_tier_snapshot?: string;
  /** Server-snapshotted fulfilment lane. `pro_priority_12h` is only emitted
   *  after the Worker proves the active PRO, approved address and service
   *  coverage requirements at checkout. */
  priority?: number;
  fulfillment_service?: 'standard' | 'pro_priority' | 'pro_priority_12h' | string;
  priority_due_at?: string | null;
  /** Amount financed through the PRO-only BNPL ledger and its contractual due
   *  date. These are server values, never calculated from the selected client
   *  payment label. */
  bnpl_due_iqd?: number;
  bnpl_due_at?: string | null;
  coupon?: { coupon_id?: string; code?: string; discount_iqd?: number } | null;
  coupon_discount_iqd?: number;
  progress?: OrderStageProgress;
  /** §5: the single money view — every screen reads this, none recomputes. */
  financial?: OrderFinancial;
  /** Sum of quantities — "8 items" on the card. */
  item_count?: number;
  // ---- GET /api/orders/:id only ----
  invoice?: OrderInvoiceRef | null;
  can_cancel?: boolean;
  can_review?: boolean;
  /** A membership gift that ships WITH the order and is worth 0 IQD on every
   *  total — today only «PRO + طلب مسبق مدفوع مقدمًا = فلمنت هدية». */
  membership_gift?: {
    kind: string;
    reason: string;
    product_id: string;
    label_ar: string;
    qty: number;
    value_iqd: number;
    granted_at: string;
  } | null;
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
  /** Server-calculated and snapshotted; clients must never recompute it. */
  cod_tax_iqd: number;
  delivery_waived: boolean;
  total_iqd: number;
  wallet_applied_iqd: number;
  due_on_delivery_iqd: number;
  bnpl_due_iqd?: number;
  bnpl_due_at?: string | null;
  collected_iqd: number | null;
  outstanding_iqd: number;
  payment_state: 'paid' | 'partial' | 'cod_due' | 'bnpl_due' | string;
  wallet_tx_id?: string | null;
  points_tx_id?: string | null;
  settlement?: { collected_iqd: number; settled_at: string | null; fully_settled: boolean } | null;
  /** Null when the accrual snapshot was not loaded — never a fabricated zero. */
  points?: OrderPointsEarned | null;
  support?: { referrer_username: string; ref: string; discount_iqd: 0 } | null;
}

/** One serialized device inside an order, as GET /api/orders/:id/units shows it. */
export interface OrderUnitPublic {
  unit_id: string;
  order_item_id: string;
  unit_index: number;
  product: { id: string | null; slug: string | null; name: string; name_ar: string; image: string };
  /** MASKED — last four characters only; null when no serial was assigned. */
  serial: string | null;
  delivered_at: string | null;
  warranty: {
    start_at: string | null;
    end_at: string | null;
    state: 'active' | 'expired' | 'needs_config' | 'not_delivered';
    remaining_days: number | null;
  };
  /** Whether the buyer holds it, another account does, or nobody yet. */
  linked: 'mine' | 'other' | 'none';
  receipt_no: string | null;
  replaced: boolean;
}

export interface OrderTrackingStep {
  stage: string;
  label: string;
  reached: boolean;
  current: boolean;
  at: string | null;
}

/** GET /api/orders/:id/tracking — labels resolved server-side. */
export interface OrderTrackingPublic {
  order_id: string;
  shipping_type: OrderShippingType | string;
  shipping_type_label: string;
  stage: string;
  stage_changed_at: string;
  next_stage_at: string | null;
  tracking_no: string | null;
  steps: OrderTrackingStep[];
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

/** The workflow row behind a hold-backed withdrawal (migration 0015); null
 *  for deposits and for withdrawals filed before holds existed. Its state —
 *  not the ledger row's status — is what an administrator acts on. */
export interface WalletWithdrawalRef {
  id: string;
  state: 'requested' | 'approved' | 'processing' | 'paid' | 'rejected' | 'cancelled' | 'failed';
  needs_reconciliation: boolean;
  payout_reference: string | null;
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
  withdrawal?: WalletWithdrawalRef | null;
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
  /** The printer home-delivery NOTE amount — informational, never a fee, and
   *  rendered only when the server sent a positive integer. */
  printerHomeDeliveryNoteIqd?: number | null;
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

/**
 * One piece of main-page artwork, already resolved by the server.
 *
 * The client deliberately does NOT know the slot list, the `UiUx/MainPage/`
 * prefix or which slots have seeded defaults — worker/lib/siteMedia.ts owns
 * all three, and /api/home sends the decided answer. That is what keeps the
 * two sides from drifting: there is no second copy of the list to update.
 *
 * `url` is '' for a slot the owner has not filled and that has no default; a
 * consumer treats that as "keep drawing what you drew before".
 */
export interface SiteMediaEntry {
  slot: string;
  group: 'brand' | 'service' | 'banner';
  label: string;
  link: string;
  url: string;
  custom: boolean;
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
): Promise<{ key: string; url: string; mime?: string; bytes?: number; width?: number | null; height?: number | null; visibility?: 'public' | 'private' }> {
  const originalName = file.name;
  let prepared = file;
  let width: number | undefined;
  let height: number | undefined;
  if (purpose === 'product' || purpose === 'avatar') {
    // Lazy because image conversion belongs to the upload moment, not to the
    // entry bundle every shopper downloads.
    //
    // AN AVATAR IS CONVERTED TOO, and at its own much smaller ceiling. It was
    // stored as the phone produced it — several megabytes of camera JPEG — and
    // then downloaded in full to fill the 32x32 chip in the header, on every
    // page, for every visitor.
    const mod = await import('./imagePreprocess');
    const result = purpose === 'avatar' ? await mod.prepareAvatarImage(file) : await mod.prepareProductImage(file);
    prepared = result.file;
    width = result.width;
    height = result.height;
  }
  const form = new FormData();
  form.append('purpose', purpose);
  form.append('file', prepared);
  form.append('originalName', originalName);
  if (width) form.append('width', String(width));
  if (height) form.append('height', String(height));
  return api.post<{ key: string; url: string; mime?: string; bytes?: number; width?: number | null; height?: number | null; visibility?: 'public' | 'private' }>(
    '/api/uploads',
    form,
    { timeoutMs: uploadTimeoutMs(prepared.size) }
  );
}

/**
 * A DEADLINE SIZED FOR THE BODY, NOT FOR A JSON GET.
 *
 * `DEFAULT_TIMEOUT_MS` is 20 seconds, which is generous for a request whose
 * body is a few hundred bytes and far too short for one that is megabytes of
 * image over a phone. The route accepts video up to 40 MB; 20 seconds cannot
 * carry that on any connection the owner's customers actually have, and the
 * abort surfaced as "Network error — check your connection", blaming a
 * connection that was working.
 *
 * 32 KB/s is a deliberately pessimistic uplink — bad mobile data, not Wi-Fi —
 * so a request that exceeds this really has stalled rather than merely been
 * slow. The ceiling keeps a genuinely dead socket from hanging the button
 * forever.
 */
export function uploadTimeoutMs(bytes: number): number {
  const allowance = 30_000 + Math.ceil(Math.max(0, bytes) / 1024) * 31;
  return Math.min(300_000, allowance);
}
