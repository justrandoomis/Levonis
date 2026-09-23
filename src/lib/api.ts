import { beginRequestFeedback, type MascotFeedback } from './mascotRequest';
import { noteCartResponse } from './cartCount';
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

/**
 * «غير مهيَّأ» AND «معطّل مؤقتًا» ARE NOT THE SAME REFUSAL, AND 503 CANNOT TELL
 * THEM APART.
 *
 * WHAT THIS COST, measured on the live shop on 2026-09-21. The owner reported
 * WhatsApp sign-in and sign-up showing «الدخول برمز عبر واتساب غير مُفعّل بعد —
 * لم يهيّئه المسؤول» while every part of it was configured. It was: the live
 * site answered `whatsappOtp: true`, WasenderAPI answered HTTP 200 for the
 * key, and the session behind it read `logged_out` — the shop's WhatsApp PHONE
 * had been unlinked. The server said exactly that, with the road that still
 * worked: 503 `WHATSAPP_UNAVAILABLE`, «واتساب غير متاح حالياً — استخدم تيليغرام
 * أو البريد».
 *
 * This predicate answered `true` for it, because it read only the STATUS. So
 * the correct sentence was thrown away, the screen was replaced by a warning
 * blaming the administrator for a setting that was already set, and the
 * alternative the server had named disappeared with it. The owner spent the
 * day looking for a missing key that was never missing.
 *
 * SO THE CODE DECIDES, NOT THE STATUS. Everything the server raises through
 * `unavailable()` is a 503; what separates the two families is the name:
 *
 *   …_NOT_CONFIGURED   an operator has never set this up. Nothing the visitor
 *                      does helps, and hiding the control is right.
 *   …_UNAVAILABLE      it IS set up and is down right now — a logged-out
 *                      WhatsApp session, a Telegram API that did not answer.
 *                      The visitor should see the server's sentence, keep the
 *                      screen, and be able to take the other road.
 *
 * A 503 WITH NO CODE KEEPS THE OLD ANSWER on purpose: two Telegram refusals
 * (worker/routes/auth.ts:1298, :1450) are genuinely "not configured" and carry
 * no code, and narrowing this by default would have turned a correct hidden
 * control into a dead button. Only a name that says OUTAGE opts out.
 */
export function isServiceOutage(e: unknown): boolean {
  return e instanceof ApiError && e.status === 503 && /_UNAVAILABLE$/.test(e.code ?? '');
}

export function isNotConfigured(e: unknown): boolean {
  return e instanceof ApiError && e.status === 503 && !isServiceOutage(e);
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
 *
 * EXPORTED BECAUSE THE BLOCKING OVERLAY MUST OUTLAST IT. src/components/ui/
 * AppBusy.tsx derives its safety ceiling from this number: a ceiling shorter
 * than the request deadline hands the page back to the customer while the
 * POST is still in flight, which is precisely the window the overlay exists
 * to cover. Reading the constant instead of copying it is what keeps the two
 * from drifting apart the next time either is tuned.
 */
export const DEFAULT_TIMEOUT_MS = 20000;

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
    // THE CART BADGE IS DERIVED FROM THE SERVER'S ANSWER, not maintained by
    // each caller. See `noteCartResponse` for which ten paths used to have to
    // remember, and which one actually did.
    noteCartResponse(path, data);
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
  /** The customer's own answer on WhatsApp order updates. True is the default
   *  and is what every account carried before the switch existed. */
  notify_whatsapp: boolean;
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
  /**
   * The product's main section, sub-section and brand — three ids the card
   * projection keeps so the «مختارات لك» tile can rank against what this
   * browser has recently opened, without any of it leaving the device
   * (src/lib/recentlyViewed.ts), and so the category rails can borrow a real
   * product photo for a sub-section (`catalogs` has no image column).
   * Optional: a locked composition card carries none of them.
   */
  category_id?: string | null;
  sub_category_id?: string | null;
  brand_id?: string | null;
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
  /** This product's page in the Gini instalments app; '' when it is not listed
   *  there. The product page draws «تريدها أقساط؟» only when it is a real
   *  http(s) link (src/components/product/GiniInstalmentsSheet.tsx). */
  gini_url?: string;
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

/**
 * Why the delivery day cannot be chosen — one of five, and the screen prints a
 * SENTENCE for each rather than disabling a control and saying nothing
 * (`deliveryDateVerb`, worker/routes/orders.ts).
 */
export type DeliveryDateReason =
  | 'PICKUP'
  | 'PREORDER_NOT_ARRIVED'
  | 'WITH_COURIER'
  | 'FINISHED'
  | 'WINDOW_CLOSED';

/**
 * One chip in the day picker, WITH THE WORDS ALREADY ON IT.
 *
 * `label` is «اليوم», «غدًا» or «الأربعاء ٢٣ أيلول», localised on the server
 * from the server's own Baghdad day. The browser renders it and never
 * re-formats it: `new Date('2026-09-23')` parses as UTC midnight, so a browser
 * west of Baghdad would render the twenty-second.
 */
export interface DeliveryDayOption {
  /** 'YYYY-MM-DD' — the value sent back, never parsed into a Date. */
  day: string;
  label: string;
  is_today: boolean;
  is_tomorrow: boolean;
}

/**
 * The day picker as a whole answer rather than a boolean: which days may be
 * picked, which one is picked, where the frozen ceiling sits, and — when none
 * of it applies — why. `GET /api/orders/:id` only.
 */
export interface OrderDeliveryDate {
  can_change: boolean;
  /** The chosen day, or null for "as soon as possible". */
  selected: string | null;
  /** «سبعة أيام من تاريخ الطلب», frozen at checkout and never recomputed. */
  window_end: string | null;
  reason: DeliveryDateReason | null;
  /** Empty whenever `can_change` is false. */
  days: DeliveryDayOption[];
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
  /**
   * «يستطيع اختيار وتغيير يوم التوصيل» — the Baghdad civil day the box goes
   * out, as `'YYYY-MM-DD'`, or null when no day has been named. NEVER a
   * `new Date(...)` argument: that string parses as UTC midnight, so a browser
   * on a negative offset renders the day before. The server sends a rendered
   * label beside it (`due_label` on the board) for exactly that reason.
   */
  delivery_due_day?: string | null;
  /** The frozen ceiling — «سبعة أيام من تاريخ الطلب» — never recomputed. */
  delivery_day_window_end?: string | null;
  /** Could this order EVER carry a day? A delivery-method fact, decided once. */
  delivery_day_schedulable?: boolean;
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
  /**
   * The Gini side of an order financed inside the app (worker/routes/orders.ts
   * `orderPublic`). Null — not a block of zeroes — on every other payment
   * method, so a screen tests for the block rather than for a state string.
   *
   * `state` is what decides whether the order is really going anywhere:
   * 'awaiting_receipt' means the receipt barcode has not been scanned, so the
   * shop may not prepare it and the hold expires at `hold_until`. The barcode
   * itself is deliberately not here — staff scan it off the parcel.
   */
  gini?: {
    order_no: string;
    state: '' | 'awaiting_receipt' | 'received' | 'expired';
    /** Settled inside the Gini app; never money Levonis collected. */
    paid_iqd: number;
    hold_until: string | null;
    received_at: string | null;
  } | null;
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
  /** The THIRD verb, beside `can_cancel` and `can_review` — the day picker as
   *  a whole answer, including why there is no picker when there is none. */
  delivery_date?: OrderDeliveryDate;
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
  /** Open box / used / refurbished; null for a new product. */
  condition?: import('./condition').ConditionEntry | null;
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
  /**
   * Settled inside the Gini app before the order existed — a PAYMENT, never a
   * discount, and never money Levonis collected. Read from the stored column
   * rather than inferred as `total − due`, because the subtraction stops
   * agreeing the first time anything else is collected against the order.
   * 0 on every other payment method.
   */
  gini_paid_iqd?: number;
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

/* ===========================================================================
 *  THE ADMIN ORDER BOARD — GET /api/admin/orders
 * ===========================================================================
 * The server decides; these types only describe what it decided. Every field
 * below is computed in `worker/routes/admin.ts` against the one Baghdad day
 * boundary (`worker/lib/baghdadTime.ts`), and NOTHING here may be re-derived
 * in the browser — the admin's laptop clock is not the shop's clock, and
 * between 00:00 and 03:00 Baghdad a UTC-derived "today" is still yesterday.
 * That window is the early-morning shift when the delivery runs are planned,
 * which is the one time of day this screen is load-bearing.
 */

/** Which day-group header a row belongs under. Computed SERVER-side. */
export type OrderDueBucket = 'overdue' | 'today' | 'tomorrow' | 'week' | 'later' | 'unscheduled';

/**
 * `scope` IS THE BOARD, `type`/`status` narrow it. Pre-orders are a SCOPE and
 * not a bucket — «فصلها في الطلبات المسبقة» — because a container in transit
 * is a different kind of waiting from a box that must go out this morning.
 */
export type AdminOrderScope = 'open' | 'preorder' | 'all' | 'delivered' | 'cancelled';

/**
 * Which reading of the search box won. One box, four readings, tried in a
 * fixed order (`worker/lib/orderSearch.ts`) — and the screen SAYS which one
 * won, because a classifier that guesses wrong is cheap to correct and
 * expensive to hide.
 */
export type OrderSearchKind = 'none' | 'order_id' | 'date' | 'phone' | 'name';

/** The resolved date behind a `search_kind === 'date'` result. */
export interface OrderSearchDateEcho {
  /** First Baghdad civil day covered, `'YYYY-MM-DD'`. Render its PARTS. */
  day_from: string;
  day_to: string;
  /** True when `5-9` was read day-first, which is how Iraq writes a date. */
  assumed_day_first: boolean;
  assumed_year: boolean;
  /** The day the OTHER reading would give, ready to be sent back verbatim as
   *  the query for a one-tap flip. Null when there is no second reading. */
  flip_day: string | null;
}

/** One row of the board. The fulfilment fields the packing bench reads. */
export interface AdminOrderRow extends ApiOrder {
  /**
   * The ACCOUNT holder's name, which is often not the person the parcel is
   * for — `address.name` is. Both exist because a gift or an office address
   * makes them differ often enough that showing only one misdirects parcels.
   */
  customer_name?: string;
  customer_phone?: string | null;
  /** Merchant orders share this table and are BADGED, never counted as ours. */
  seller_type?: string;
  /** Set when the day MOVED after checkout. An order that silently sinks down
   *  the list looks, to the admin who saw it this morning, like one that
   *  vanished — so the row says «مؤجل» rather than just re-sorting. */
  delivery_day_changed_at?: string | null;
  due_bucket?: OrderDueBucket;
  /** «اليوم» / «غدًا» / «الأربعاء ٢٣ أيلول», localised BY THE SERVER. The
   *  screen renders this string and never formats a day itself. */
  due_label?: string;
  /**
   * THE ONE-TAP MOVE, decided by the server — the next stage on THIS order's
   * own path, already labelled in the caller's language. `null` at the end of
   * the path and for a cancelled order, and the row then shows no button.
   *
   * It is a STAGE, never a status: the path is fourteen stages long for a
   * pre-order and the first five differ per journey, so a row that guessed
   * "confirmed comes after pending" would offer moves the stage door then
   * refuses. `source` is who normally makes this move (manual / automatic /
   * delivery_api), so the row can mark the ones that are the clock's or the
   * courier's rather than presenting them as ordinary.
   */
  quick_next?: { stage: string; label: string; source: 'manual' | 'automatic' | 'delivery_api' } | null;
}

/** The whole board in one answer: a page, its totals, and what it understood. */
export interface AdminOrdersResponse {
  orders: AdminOrderRow[];
  total: number;
  limit: number;
  offset: number;
  scope: AdminOrderScope;
  due: string | null;
  type: string | null;
  status: string | null;
  /** The three anchors the buckets were computed against. */
  today: string;
  tomorrow: string;
  week_end: string;
  search_kind: OrderSearchKind;
  search: {
    raw: string;
    /** True when this lookup IGNORED the scope and every filter — an order
     *  number or a phone number is a lookup, not a browse, and most of why an
     *  admin searches is to ask about an order that is already finished. */
    pierced: boolean;
    date?: OrderSearchDateEcho;
  } | null;
  /**
   * The group headers, over the whole filtered board rather than this page.
   * `today` and `overdue` are disjoint here; the LIST merges them, because a
   * box that should have gone out on Tuesday is not a separate kind of work on
   * Wednesday — it is today's work, and the most urgent of it.
   */
  counts: {
    total: number;
    overdue: number;
    today: number;
    tomorrow: number;
    week: number;
    later: number;
    unscheduled: number;
  };
  /**
   * «عدد بجانب كل خيار» — how many rows each filter option would return.
   *
   * Each vector honours the OTHER select and ignores its own, so the number
   * beside the option currently selected equals `counts.total`. Computed by
   * the server from one GROUP BY, for the reason everything else on this board
   * is: the screen renders decisions, it does not make them.
   *
   * `null` for a PIERCED lookup (an order number, a phone number). That is not
   * a browse — there are no other options to count, and counting them would
   * mean a GROUP BY over every order ever placed for a screen showing one row.
   */
  options: {
    type: { all: number; direct: number; preorder_air: number; preorder_sea: number; preorder_land: number };
    status: {
      any: number;
      pending: number;
      confirmed: number;
      processing: number;
      shipped: number;
      delivered: number;
      cancelled: number;
    };
  } | null;
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
  /** The dinars the customer typed (migration 0106), or null for a request
   *  filed before the column existed. Read for display, never recomputed. */
  declared_amount_iqd: number | null;
  /** The commission withheld, in ledger cents — written when the request was
   *  filed, so a later rate or rate-policy change cannot restate it.
   *  `null` on a route that does not carry it. */
  fee_cents?: number | null;
  /** WHAT THE CUSTOMER IS ACTUALLY OWED, in ledger cents: `amount_cents -
   *  fee_cents`, held together by a CHECK in migration 0015. The commission is
   *  DEDUCTED from the requested amount, so this — not `amount` — is the
   *  figure a human transfers. */
  net_cents?: number | null;
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
  /** A DEPOSIT's own testimony (migration 0105), on the routes that join it.
   *  Absent on the routes that do not — `undefined` means "not carried here",
   *  `null` means "this transfer recorded none", and only the second one is a
   *  reason to fall back to converting the cents. */
  deposit?: { declared_amount_iqd: number | null } | null;
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
  /**
   * Does this method end at the CUSTOMER'S DOOR? It decides whether the day
   * picker is offered at all — there is no "which day would you like it" for a
   * pickup, because nobody is driving anywhere.
   *
   * `undefined` MEANS "infer `id !== 'pickup'`", which is the rule
   * `deliversToHome` states on the server side of the same array. Reading it
   * as a bare `id !== 'pickup'` test is what breaks the day the owner adds
   * «استلام من الفرع الثاني» to this admin-editable list and its customers
   * start being asked which day to drive to them.
   */
  home_delivery?: boolean;
  /**
   * WHERE THE CUSTOMER IS BEING ASKED TO COME, for a method that asks them to
   * come somewhere. Absent (the normal case, and every home delivery) means no
   * link is drawn — the shop's address is the owner's to state, in the admin,
   * and a guessed map pin would point customers at a place that does not
   * exist. See the field's note in worker/lib/settings.ts.
   */
  map_url?: string;
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
  /**
   * THE DOOR CHARGE'S RATE, as the administrator set it.
   *
   * Public because checkout explains the charge in a sentence BEFORE it can
   * quote one, so there is no order to read the rate off. Optional because a
   * client that reaches a server older than this field must fall back to the
   * compiled default rather than printing «undefined» in the sentence.
   */
  codTaxPerBlockIqd?: number | null;
  codTaxBlockIqd?: number | null;
  /**
   * The delivery-day offer itself — «بحد أقصى أسبوع» as three values.
   *
   * It is public (`PUBLIC_SETTING_KEYS`) for one screen: checkout has to draw
   * the picker BEFORE an order exists, so there is no `delivery_date` block
   * to read the offer off. `enabled` is the owner's off switch and closes the
   * picker everywhere at once.
   */
  deliveryDayPolicy?: { enabled: boolean; max_days: number; allow_same_day: boolean };
  /**
   * «خدمة التقسيط عبر تطبيق جني» as the owner configured it.
   *
   * Public because the product page draws «تريدها أقساط؟» for a SIGNED-OUT
   * visitor, with no cart and no quote to read the condition off. `conditions`
   * is the bank's own rule in the owner's words — never machine-translated, so
   * `pickText` falls back to a language they did write rather than to a blank.
   * Optional: a client on a worker that predates the setting falls back to the
   * sheet's compiled sentence instead of printing nothing.
   */
  giniPolicy?: {
    enabled: boolean;
    conditions: LocalizedText;
    /** How long a placed Gini order waits for its receipt scan before it is cancelled. */
    hold_hours: number;
    app_url: string;
  };
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
  /** Active products in this catalog OR anywhere below it. */
  product_count: number;
  /**
   * The `/files/...` path of the picture an ADMIN chose for this section, or
   * '' when they have not chosen one (migration 0100).
   *
   * Empty is the ordinary case and not a failure: CategoryBoard then borrows a
   * photo from a product already on the page, and draws the section's monogram
   * when there is not even one of those. The three states are ranked in that
   * order deliberately — an authored picture is a decision, a borrowed one is
   * a guess, and the monogram is the designed state for a section with no
   * artwork at all.
   */
  image_url?: string;
  /**
   * The sub-sections that actually hold products — «الأقسام الفرعية التي فيها
   * المنتجات». Present on a main section, absent on a brand and on a child.
   * An empty array means the section's products are all filed at its own
   * level, which is a different thing from having no products.
   */
  children?: HomeTaxon[];
}

/**
 * The catalog a product listing was filtered by, as GET /api/products
 * resolves it.
 *
 * Deliberately NOT `HomeTaxon`: that type carries `product_count`, a
 * descendant-inclusive roll-up the home tree computes. This is one
 * primary-key probe and knows no count, and a zero there would read as a
 * number rather than as an absence.
 *
 * CATEGORY names ARE localized — `loc(name_ar, name_en, name_ckb)` — unlike
 * PRODUCT names, which are English in every language and never translated.
 */
export interface ResolvedCategory {
  id: string;
  slug: string;
  name_ar: string;
  name_en: string;
  name_ckb: string;
}

/**
 * The listing envelope. `category` is ABSENT when the request carried no
 * category filter, and explicitly `null` when it carried one that names no
 * catalog — which includes the supported legacy case of a free-text
 * `products.subcategory_id` token with real products behind it. The heading
 * renders those two facts differently, which is why they are two facts.
 */
export interface ProductsListResponse {
  products: ApiProduct[];
  category?: ResolvedCategory | null;
}

// ----------------------------------------------- «خبرني لما يرجع» (0092)

/**
 * THE STOCK-ALERT DOOR, WRITTEN DOWN SO THE UI CANNOT GUESS AT IT.
 *
 * Every route below is mounted at /api/stock-alerts and sits behind
 * `requireAuth`, so an anonymous request is answered 401 — the sign-in bounce
 * is part of the contract, not an error to report.
 *
 *   POST   /api/stock-alerts
 *     body { productId, kind, optionValueId?, colorId? }
 *     → { success, alert: StockAlertRow | null, readiness, channel }
 *
 *   PUT    /api/stock-alerts/product/:productId        (the sheet's Save)
 *     body { alerts: Array<{ kind, optionValueId?, colorId? }> }
 *     → { success, alerts: StockAlertRow[], readiness, channel }
 *     ONE batch: the wishes that left are cancelled and the wishes that stayed
 *     are re-armed together or not at all. An empty array cancels every
 *     standing alert on that product. An unarmable wish refuses the WHOLE
 *     save, so a partial set never reaches the screen.
 *
 *   GET    /api/stock-alerts/product/:productId
 *     → { success, alerts: StockAlertRow[] }   live rows only ('armed'/'firing')
 *
 *   GET    /api/stock-alerts                            («تنبيهاتي»)
 *     → { success, limit, alerts: StockAlertListEntry[] }
 *
 *   DELETE /api/stock-alerts/:alertId
 *     → { success, removed }                   404 when it is not yours
 *
 * REFUSALS, AND THE ONE THAT IS NOT A FAILURE.
 *
 *   400 ALERT_<reason>             permanent: this wish can never come true.
 *                                  The reasons are 0092's AlertDeadReason plus
 *                                  VARIANT_NOT_MODELLED, which only the DOOR
 *                                  refuses (the sweep tolerates it, because
 *                                  creating the variant row is itself one of
 *                                  the restock paths).
 *   409 ALERT_LIMIT_REACHED        forty standing alerts is the cap.
 *   429 RATE_LIMITED               the route's own limiter.
 *   503 ALERT_TEMPORARILY_UNAVAILABLE
 *                                  «ASK AGAIN LATER», NOT «FAILED». The
 *                                  resolver's context was degraded — a
 *                                  relational read did not come back — so the
 *                                  door refused to promise something it could
 *                                  not verify. Nothing is wrong with the
 *                                  request and the next one usually succeeds,
 *                                  so any UI that renders this as an error is
 *                                  telling the customer something untrue.
 */
export interface StockAlertRow {
  id: string;
  product_id: string;
  /** 'product' | 'option_value' | 'color' | 'combination' (0092's CHECK). */
  kind: string;
  /** '' — the schema's sentinel — when the alert does not name one. */
  option_value_id: string;
  color_id: string;
  state: string;
  /** How many times this person has re-armed it; the row survives a re-arm. */
  arm_seq: number;
  armed_channel: string;
  armed_at: string;
  notified_at: string;
  /* No `expires_at`. The column exists in migration 0092 and is dead by the
     owner's ruling — an alert has no time limit, it waits until the product
     returns and then fires once. The route stopped writing and stopped sending
     it; see the note at the top of worker/routes/stockAlerts.ts. */
  dead_reason: string;
}

/** One channel's readiness, as the server judged it for THIS account. The
 *  destination is masked or null and is never the address itself. */
export interface StockAlertChannelState {
  channel: string;
  ready: boolean;
  blocker: string | null;
  destination_masked: string | null;
  can_activate: boolean;
  action: { kind: 'link_telegram' | 'verify_email'; href: string } | null;
}

export interface StockAlertReadiness {
  channels: StockAlertChannelState[];
  any_outbound_ready: boolean;
  /** Never null: the in-app inbox is the floor. This is the ONLY thing a
   *  confirmation sentence may name. */
  recommended: string;
  primary_channel: string;
  delivery: string[];
}

export interface StockAlertSaveResponse {
  success: boolean;
  alerts: StockAlertRow[];
  readiness: StockAlertReadiness;
  channel: string;
}

export interface StockAlertsForProductResponse {
  success: boolean;
  alerts: StockAlertRow[];
}

/** A row of «تنبيهاتي»: the same alert plus the labels the list needs, so a
 *  list of forty alerts costs one query rather than forty catalogue loads. */
export interface StockAlertListEntry {
  id: string;
  product_id: string;
  slug: string;
  name: LocalizedText;
  image: string | null;
  kind: string;
  option_value_id: string;
  color_id: string;
  option_value: LocalizedText | null;
  color: LocalizedText | null;
  state: string;
  arm_seq: number;
  armed_channel: string;
  armed_at: string;
  notified_at: string | null;
  /* No `expires_at` — see StockAlertRow above. */
  /** Why a reconciled alert can never come true. Null while it is still
   *  waiting — the two must never render the same. */
  dead_reason: string | null;
}

export interface StockAlertListResponse {
  success: boolean;
  limit: number;
  alerts: StockAlertListEntry[];
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

/**
 * A CATALOGUE CARD THAT CARRIES ITS GRADE.
 *
 * `ApiProduct` deliberately does not declare `condition`: the field is present
 * only on a row the owner graded, and putting it on the base type would let
 * every card in the shop read `p.condition` and get `undefined` for the
 * hundreds of new products where the question does not apply. Until now the
 * two consumers that DO care each wrote the same inline cast —
 * `(p as ApiProduct & { condition?: ConditionEntry | null })` — which is a
 * type assertion, not a check, repeated in more than one file. Naming it once
 * is what stops the third copy from being written slightly differently.
 *
 * `condition_reference` is the NEW product's current price, computed by the
 * server when it found an honest saving. It is not a compare-at price on this
 * row and must never be rendered as one (see OpenBoxShelf's note): striking
 * through it means "the new one costs this", not "this was cheaper before".
 */
export type GradedProduct = ApiProduct & {
  condition?: import('./condition').ConditionEntry | null;
  condition_reference?: { reference_iqd: number; saving_iqd: number };
};

/**
 * THE SHOP'S GRADED STOCK — open box, used and refurbished.
 *
 * WHY THIS READS /api/home AND NOT A FILTER ON /api/products. There is no
 * condition filter on the listing endpoint. `GET /api/products` accepts
 * `search`, `category`, `type` and a bounded `limit`/`offset` and nothing
 * else, so "every used printer in the catalogue" cannot be asked for: a client
 * would have to page the WHOLE catalogue and sieve it, which means a page that
 * says «لا توجد طابعات مستعملة» whenever the used units happen to sit past the
 * pages it bothered to fetch. Answering "none" because we stopped looking is
 * the one thing a stock page must never do.
 *
 * `GET /api/home` already runs the only server-side selection that exists on
 * this concept — `WHERE status = 'active' AND condition_doc <> '{}'`, newest
 * first — and publishes it as `open_box`. So this asks the server the question
 * the server can actually answer, and the page states the shelf's limit in
 * words rather than implying it has the whole catalogue. A real `condition`
 * filter on /api/products is the proper fix and needs a Worker change.
 *
 * An empty array is an honest answer here, not a degraded one: the same
 * predicate returns nothing on a database where migration 0085 has not landed,
 * and the server treats that as "no graded stock yet" by design.
 */
export function fetchGradedStock(opts?: RequestOptions): Promise<GradedProduct[]> {
  return api
    .get<{ open_box?: GradedProduct[] }>('/api/home', opts)
    .then((d) => (Array.isArray(d.open_box) ? d.open_box : []));
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

/**
 * A WALLET AMOUNT AS AN ADMIN SHOULD READ IT: dinars.
 *
 * «في لوحة الإدارة عند طلب تعبئة محفظة اجعله يكون العملة هي العملة العراقية
 *  بالافتراضي وليس الدولار — المشكلة يظهر العملة بالدولار.»
 *
 * The «$35.72» the owner saw is not a dinar figure wearing a dollar sign. The
 * LEDGER IS GENUINELY USD CENTS — migrations/0001_init.sql says so in its
 * header, and 0015_wallet_holds.sql states in writing that the stored unit
 * stays USD cents because changing it would be a destructive rewrite of live
 * balances rather than a migration. A customer who types 50,000 د.ع has it
 * stored as 3,572 cents, and the admin screens were printing that raw number.
 *
 * So this is a presentation fix, and the conversion already existed on both
 * sides — the customer's own wallet page and the Telegram review card have
 * been converting all along. This helper exists so the four admin screens
 * cannot drift apart from each other again.
 */
export function formatWalletIqd(cents: number, exchangeRate: number): string {
  return formatIqd(usdCentsToIqd(cents, exchangeRate));
}

/**
 * THE DOLLAR ROUNDS DOWN — «وعند الدولار يقرب الى عدد صحيح اقل».
 *
 * The owner's instruction, verbatim: «في المحفظة الاعتماد على السعر المدخل
 * بدون تقريب، وعند الدولار يقرب الى عدد صحيح اقل — مثلا 35.71 = 50,000».
 * At 1,400 IQD/USD, floor(5,000,000 / 1,400) = 3,571 cents = $35.71, which is
 * that example exactly. This function used to CEIL and produced $35.72.
 *
 * THIS PARAGRAPH REPLACES AN ARGUMENT THAT NO LONGER HOLDS. The comment that
 * stood here said the ceil was the right direction because the alternative
 * credits less than was transferred, and that «Math.round only turns +8 into
 * −6, which is worse». That reasoning was about which drift to prefer, and the
 * owner has now chosen. It is not deleted quietly: the trade-off it named is
 * real and is stated below, so nobody re-argues it from scratch and silently
 * flips the rule back.
 *
 * WHICH WAY THE ERROR NOW GOES, ON EACH SIDE. Flooring is bounded by one cent
 * — 13 د.ع at 1,400 — AT ONE RATE, which is the only claim this bound makes.
 * A tab left open while the owner moves the rate is a different and much
 * larger disagreement, and it is not answered here: the server refuses to
 * record a typed figure its own rate does not convert onto the cents that
 * arrived (`corroboratedDeclaredIqd`, worker/lib/walletOps.ts), so such a
 * request files with no testimony rather than with a figure that is 3,565 د.ع
 * out. Within one rate the drift leans in OPPOSITE directions for the two
 * operations:
 *   • a DEPOSIT credits slightly LESS than was transferred, so the shop gains;
 *   • a WITHDRAWAL reserves and debits slightly LESS than is paid out, so the
 *     customer gains.
 * Before this change a withdrawal of a typed 50,000 د.ع reserved 3,572 cents,
 * worth 50,008 د.ع — eight dinars MORE than the customer asked for, taken from
 * the customer. Floor ends that.
 *
 * IT DOES NOT PUT BOTH DRIFTS ON ONE PARTY, and an earlier draft of this
 * header said it did — «to the shop's side on withdrawals and to the shop's
 * side on deposits too» — which negates one of the two bullets whichever way
 * «side» is read. The bullets are the whole truth and they point OPPOSITE
 * ways: on a deposit the shop keeps the remainder, on a withdrawal the
 * customer keeps it. One rule, one function, two different beneficiaries.
 * That asymmetry is the decision, not an oversight in it, and it is written
 * out here so nobody reads a single tidy sentence into the code and flips the
 * rule back believing the bullets were the typo.
 *
 * THE DRIFT IS ABSORBED, NOT SHOWN. Rule (1) of the same instruction — «الاعتماد
 * على السعر المدخل بدون تقريب» — is what makes that acceptable: a transaction
 * RECORDS the dinar figure the customer typed (migration 0105 for deposits,
 * 0106 for withdrawals) and every screen prints that figure, so the customer
 * never reads a number they did not type. The cents remain the money. A
 * BALANCE has no typed figure and keeps converting through `usdCentsToIqd`.
 *
 * SCOPE: «في المحفظة» — the wallet. The escrow/purchase-hold conversions
 * (worker/lib/escrowOps.ts, worker/routes/orders.ts, worker/routes/
 * storeOrders.ts, worker/routes/memberships.ts) stay CEIL, because a hold that
 * floors is short of the debit it exists to guarantee and a charge that floors
 * undercharges a debt denominated in dinars. Those are not wallet top-ups and
 * the owner's sentence does not reach them.
 */
export function iqdToUsdCents(iqd: number, exchangeRate: number): number {
  return Math.floor((iqd * 100) / exchangeRate);
}

/**
 * A DEPOSIT'S DINARS AS THE CUSTOMER TYPED THEM — never as the ledger
 * re-derives them.
 *
 * «كتبت ٥٠,٠٠٠ وظهر ٥٠,٠٠٨.» The pair above is not a round trip and cannot be
 * made into one: at 1,400 IQD/USD a cent is 14 د.ع, so only multiples of 14
 * are representable and 50,000 is not one of them. No rounding rule repairs
 * that — it only chooses which way the remainder falls. Since the owner's
 * «وعند الدولار يقرب الى عدد صحيح اقل», BOTH helpers floor: `iqdToUsdCents`
 * down to the whole cent and `usdCentsToIqd` down to the whole dinar. That is
 * why this function exists rather than a cleverer rule.
 *
 * So the dinar figure is READ, not computed, whenever the request recorded it
 * — `wallet_deposit_meta.declared_amount_iqd` for a deposit (migration 0105)
 * and `wallet_withdrawals.declared_amount_iqd` for a withdrawal (0106). One
 * helper serves both: the name is historic, the contract is not. The fallback is
 * deliberately ONE-DIRECTIONAL: a row filed before that column existed, or
 * one typed in dollars, still converts from the authoritative cents. Nothing
 * ever converts the other way — the cents are the money, the dinars are the
 * customer's testimony about the transfer, and a credit is only ever computed
 * from the money.
 *
 * `??` rather than `||` matters: strictNullChecks is off, and a NULL from an
 * old row must take the fallback for being ABSENT, not for being falsy.
 */
export function depositDeclaredIqd(
  declaredAmountIqd: number | null | undefined,
  cents: number,
  exchangeRate: number
): number {
  const declared = declaredAmountIqd as number;
  return Number.isInteger(declared) && declared > 0 ? declared : usdCentsToIqd(cents, exchangeRate);
}

let idempotencyCounter = 0;
export function newIdempotencyKey(): string {
  idempotencyCounter += 1;
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${idempotencyCounter}`;
}

/** Upload a file; returns its key + URL. */
export async function uploadFile(
  file: File,
  purpose: 'receipt' | 'avatar' | 'chat' | 'product' | 'community' | 'support',
  /**
   * The thing this file belongs to, when it is not the uploader.
   *
   * A chat attachment is filed under the CONVERSATION — the owner chose that
   * ordering so one thread's pictures sit in one folder — so a chat upload
   * must say which conversation. The server verifies participation before it
   * stores a byte, so passing a chat you are not in is refused rather than
   * trusted.
   *
   * A SUPPORT attachment is filed under the TICKET for the same reason and
   * checked the same way: `purpose:'support'` must name the ticket, and the
   * server refuses a ticket that is not yours before storing anything.
   */
  entityId?: string
): Promise<{ key: string; url: string; mime?: string; bytes?: number; width?: number | null; height?: number | null; visibility?: 'public' | 'private' }> {
  const originalName = file.name;
  let prepared = file;
  let width: number | undefined;
  let height: number | undefined;
  {
    /**
     * EVERY PURPOSE, not two of them.
     *
     * This used to run for `product` and `avatar` only, so a photograph sent in
     * a chat, a payment receipt and a merchant's community image were stored
     * exactly as the phone produced them — several megabytes of camera JPEG,
     * downloaded in full every time anyone opened the thread. The owner asked
     * for «جميع الصور بدون استثناء»; `prepareUploadImage` owns the ceiling for
     * each one.
     *
     * Lazy because image conversion belongs to the upload moment, not to the
     * entry bundle every shopper downloads.
     */
    const mod = await import('./imagePreprocess');
    const result = await mod.prepareUploadImage(file, purpose);
    prepared = result.file;
    width = result.width;
    height = result.height;
  }
  const form = new FormData();
  form.append('purpose', purpose);
  if (entityId) form.append('entity_id', entityId);
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

// ------------------------------------------- can we actually reach this person

/**
 * WHERE A MESSAGE CAN ACTUALLY GO — the server's own answer, never the
 * client's guess.
 *
 * worker/lib/channelReadiness.ts computes readiness as the AND of two facts
 * the browser cannot see on its own: whether this DEPLOYMENT can carry a
 * channel (a Telegram token, a WhatsApp session that is not logged out, an
 * email provider) and whether this ACCOUNT has somewhere for it to land. A UI
 * that decided «you have no channels» from the profile alone would tell a
 * customer to link Telegram on a deployment whose bot is not answering, and
 * the tap would 503. So this type carries the server's verdict verbatim and
 * every surface renders it rather than re-deriving it.
 *
 * `any_outbound_ready` IS THE WHOLE PREDICATE for the post-success nudge:
 * 'inapp' is the FLOOR (a signed-in account is always reachable in the inbox)
 * and is deliberately excluded from it, so `false` means exactly "we have no
 * way to reach this person once they close the tab".
 *
 * These types are declared here rather than aliased onto the StockAlert*
 * readiness types above even though the server sends one shape: the stock
 * alert section belongs to that feature and is edited with it, and a rename
 * there must not be able to break an unrelated checkout screen. The SHAPE is
 * owned by the server; both copies are readers of it.
 */
export interface NotifyChannelState {
  /** 'inapp' | 'telegram' | 'whatsapp' | 'email'. */
  channel: string;
  ready: boolean;
  /** `ChannelBlocker` — why it is not ready. Null when it is. */
  blocker: string | null;
  /** MASKED or null. Never the address, the number or the chat id. */
  destination_masked: string | null;
  /** Would the activation route actually succeed if this were tapped now? */
  can_activate: boolean;
  /**
   * Where the fix lives, PUBLISHED BY THE SERVER. Never hard-code the path:
   * WhatsApp has no activation route of its own (a phone number is only ever
   * written after Telegram contact verification), so its action deliberately
   * points at Telegram linking, and only the server knows that.
   */
  action: { kind: 'link_telegram' | 'verify_email'; href: string } | null;
}

export interface NotifyChannelReadiness {
  channels: NotifyChannelState[];
  /** telegram/whatsapp/email only — the in-app inbox is not an outbound win. */
  any_outbound_ready: boolean;
  /** Never empty: the floor is 'inapp'. The only thing a sentence may name. */
  recommended: string;
  /** What the customer CHOSE, '' when they never chose. Not what is ready. */
  primary_channel: string;
  /** Where a message actually goes right now. */
  delivery: string[];
}

/**
 * THE DEVICES SIGNED IN TO THIS ACCOUNT — «تحقق من الجلسات».
 *
 * `id` is NOT `sessions.id`. That column is sha256 of the cookie token, the
 * value the session lookup matches on, and handing a list of them to a browser
 * would mean an XSS walking away with the exact strings the session table is
 * keyed by. The server publishes sha256 of it instead: a stable handle that
 * names a row for revoke and is useless for anything else.
 */
export interface ApiSession {
  id: string;
  created_at: string;
  expires_at: string;
  /** Echoed verbatim; naming the device is the client's job, not the server's. */
  user_agent: string;
  current: boolean;
}

export function listSessions(opts?: RequestOptions): Promise<{ success: boolean; sessions: ApiSession[] }> {
  return api.get<{ success: boolean; sessions: ApiSession[] }>('/api/auth/sessions', opts);
}

/** End one other device. The CURRENT session is refused by the server — signing
 *  out is what ends this one, and it clears the cookie too. */
export function revokeSession(id: string): Promise<{ success: boolean }> {
  return api.delete<{ success: boolean }>(`/api/auth/sessions/${encodeURIComponent(id)}`);
}

/** End every other device and stay signed in here. This is what the settings
 *  page used to tell people to achieve by CHANGING THEIR PASSWORD. */
export function revokeOtherSessions(): Promise<{ success: boolean; revoked: number }> {
  return api.post<{ success: boolean; revoked: number }>('/api/auth/sessions/revoke-others', {});
}

/**
 * GET /api/notifications/channels — the readiness answer for the signed-in
 * customer. 401 for a guest, which callers treat as "say nothing" rather than
 * as an error: a visitor who is not signed in has no channels to offer.
 *
 * The route answers `Cache-Control: no-store` on purpose — readiness flips the
 * instant somebody finishes linking Telegram — so this is always a live read.
 */
export function fetchNotifyChannels(opts?: RequestOptions): Promise<NotifyChannelReadiness> {
  return api.get<NotifyChannelReadiness & { success: boolean }>('/api/notifications/channels', opts);
}

// ------------------------------------------------ the financial dashboard

/**
 * «لوحة الأرباح» — the owner's profit reporting, as it comes off the wire.
 *
 * THESE TYPES MIRROR worker/lib/financeReport.ts FIELD FOR FIELD, and they are
 * declared here rather than imported from the Worker for the reason every
 * other admin type in this file is: `src/` is bundled for a browser and the
 * Worker tree is not part of that graph. The SHAPE is owned by the server;
 * this is a reader of it.
 *
 * ---------------------------------------------------------------------------
 * EVERY BYTE BEHIND HERE IS COST AND MARGIN DETAIL.
 *
 * Mandate §11, quoted in full in worker/lib/adminScope.ts: «cost وجميع تفاصيل
 * الربح متاحة فقط للمالك/الدور المالي. مساعد الأدمن العادي لا يراها في API ولا
 * في HTML ولا في export». The three endpoints below refuse an assistant admin
 * at the door with `FINANCIAL_SCOPE_REQUIRED` — the WHOLE router, before a
 * query runs, because there is no safe subset of a profit report. Nothing on
 * the client may re-derive a financial number from a non-financial endpoint to
 * work around that, and `ApiUser.can_view_financials` is a UI HINT for hiding
 * a tab nobody can use — never the gate itself.
 *
 * ---------------------------------------------------------------------------
 * TWO PROFITS, AND THE TYPE SYSTEM IS WHERE THEY STOP BEING MERGED.
 *
 *   GROSS = revenue − cost of goods sold.   Belongs to a product, so it is
 *                                           reported per product and per
 *                                           category.
 *   NET   = gross + collections − points − operating expenses. PER PERIOD
 *                                           ONLY: rent belongs to no product,
 *                                           so a per-product net profit is an
 *                                           invention, not a number.
 *
 * `FinanceBreakdownTotals` is `FinanceTotals` with the period-only fields
 * REMOVED — the exact list `stripPeriodOnly()` deletes on the server. So a
 * component that reaches for `row.totals.net_profit_iqd` on a product does not
 * render a plausible zero: it fails to compile. That is the whole reason the
 * two are separate types instead of one optional-field type.
 */

/** 'day' | 'week' | 'month' | 'range' — 'range' collapses the span to one bucket. */
export type FinanceGranularity = 'day' | 'week' | 'month' | 'range';

/** An inclusive span of BAGHDAD calendar days. Never a UTC day (see §baghdadTime). */
export interface FinanceRange {
  from: string;
  to: string;
  days: number;
}

export interface FinanceTotals {
  /** Sales revenue recognised in this bucket, before refunds. */
  gross_revenue_iqd: number;
  /** Revenue reversed by refunds DECIDED in this bucket. */
  refunded_revenue_iqd: number;
  /** `gross_revenue − refunded_revenue`. The headline «المبيعات». */
  revenue_iqd: number;
  /** The part of `revenue_iqd` whose cost is known, measured or estimated. */
  costed_revenue_iqd: number;
  /** The part whose cost is UNKNOWN. The margin does not speak for it. */
  uncosted_revenue_iqd: number;
  cogs_iqd: number;
  refunded_cogs_iqd: number;
  /** `costed_revenue − cogs`. Both sides describe the same lines. */
  gross_profit_iqd: number;
  /** Over COSTED revenue, or null with no base — never 0. */
  gross_margin_percent: number | null;
  shipping_collected_iqd: number;
  cod_tax_collected_iqd: number;
  points_redeemed_iqd: number;
  /**
   * Order-level coupon discounts, SUBTRACTED in reaching net profit on the
   * server (`seal()` in worker/lib/financeReport.ts).
   *
   * It was missing from this mirror, and the omission was not harmless: the
   * decomposition card prints every term of that arithmetic so the owner can
   * take the headline apart, and a term absent from the TYPE is a term the
   * card cannot print and the compiler cannot miss. The printed lines then
   * added to a different number than the net profit above them — a gap with
   * nothing to attribute it to, on the one card whose whole purpose is that
   * there is never such a gap.
   */
  coupon_discount_iqd: number;
  operating_expenses_iqd: number;
  net_profit_iqd: number;
  net_margin_percent: number | null;
  orders: number;
  lines: number;
  units: number;
  refunded_units: number;
  refund_cases: number;
  expense_entries: number;
  /** True when ANY line here priced its cost from the catalogue, not a snapshot. */
  estimated: boolean;
  estimated_lines: number;
  estimated_units: number;
  estimated_cogs_iqd: number;
  uncosted_lines: number;
  uncosted_units: number;
  /**
   * THE OTHER END OF THE CONFIDENCE SCALE FROM `estimated_*`.
   *
   * Lines whose COGS was measured against the cost LAYERS the sale actually
   * consumed — «محسوبة حسب دفعات الشراء» — rather than against the unit cost
   * the resolver believed at the till. `fifo_cogs_iqd` is a SUBSET of
   * `cogs_iqd`, never something to add to it, so the screen can report what
   * share of the cost basis is measured this way and leave the rest labelled
   * as what it is.
   */
  fifo_lines: number;
  fifo_cogs_iqd: number;
}

/**
 * The period-only fields, named once so the omission below cannot drift out of
 * step with `PERIOD_ONLY_FIELDS` in worker/lib/financeReport.ts.
 */
export type FinancePeriodOnlyField =
  | 'shipping_collected_iqd'
  | 'cod_tax_collected_iqd'
  | 'points_redeemed_iqd'
  | 'coupon_discount_iqd'
  | 'operating_expenses_iqd'
  | 'net_profit_iqd'
  | 'net_margin_percent'
  | 'expense_entries';

/** A product's or a category's totals: gross profit, and no net profit to read. */
export type FinanceBreakdownTotals = Omit<FinanceTotals, FinancePeriodOnlyField>;

/**
 * A difference between two periods. `*_percent` is NULL when the earlier side
 * was zero or negative: a month that went from 0 to 900,000 did not grow by a
 * percentage, it started — and «+∞%» on a profit screen is a fabrication.
 */
export interface FinanceChange {
  revenue_iqd: number;
  revenue_percent: number | null;
  gross_profit_iqd: number;
  gross_profit_percent: number | null;
  net_profit_iqd: number;
  net_profit_percent: number | null;
  orders: number;
}

export interface FinanceBucket {
  /** 'YYYY-MM-DD' for a day or a week start, 'YYYY-MM' for a month, 'range'. */
  key: string;
  from: string;
  to: string;
  totals: FinanceTotals;
  /** Against the PREVIOUS BUCKET IN THIS LIST. Null on the first one. */
  change: FinanceChange | null;
}

export interface FinanceExpenseCategoryTotal {
  id: string | null;
  slug: string;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  entries: number;
  amount_iqd: number;
}

/** What the server's fold could not place in any bucket, reported not dropped. */
export interface FinanceUnbucketed {
  sale_lines: number;
  sale_revenue_iqd: number;
  refund_cases: number;
  expense_entries: number;
  expense_amount_iqd: number;
}

export interface FinanceReportMeta {
  recognition: 'delivered_baghdad_day';
  timezone: 'Asia/Baghdad';
  week_starts_on: 'saturday';
  currency: 'IQD';
  /** FALSE = migration 0095 has not landed and EVERY cost is an estimate. */
  cost_snapshot_available: boolean;
  /** FALSE = there is no expense ledger, so net profit equals gross profit. */
  operating_expenses_available: boolean;
  /**
   * FALSE = migration 0098 has not landed, so no sale can be costed from the
   * lots it ate. A statement about the MECHANISM: the screen may only claim a
   * FIFO basis when this is true AND `totals.fifo_lines` is non-zero, because
   * a shop whose stock all predates 0098 has the machinery and nothing for it
   * to read.
   */
  fifo_available: boolean;
  /** Delivered orders carrying no delivery date — in NO period, at any range. */
  unrecognized_orders: number;
  unbucketed: FinanceUnbucketed;
}

export interface FinancePeriodReport {
  range: FinanceRange;
  granularity: FinanceGranularity;
  buckets: FinanceBucket[];
  totals: FinanceTotals;
  expense_categories: FinanceExpenseCategoryTotal[];
  previous: { range: FinanceRange; totals: FinanceTotals };
  /** This period against the PRECEDING PERIOD OF EQUAL LENGTH. */
  change: FinanceChange;
  meta: FinanceReportMeta;
}

export interface FinanceBreakdownRow {
  id: string | null;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  slug: string;
  /** Product rows only. */
  category_id?: string | null;
  sub_category_id?: string | null;
  totals: FinanceBreakdownTotals;
}

/**
 * A breakdown's metadata is a SHORTER list than a period's on purpose:
 * `unrecognized_orders` and the unbucketed counts are properties of a period
 * fold, and a breakdown does not fold by period.
 */
export interface FinanceBreakdownMeta {
  recognition: 'delivered_baghdad_day';
  timezone: 'Asia/Baghdad';
  currency: 'IQD';
  cost_snapshot_available: boolean;
  net_profit_is_period_only: true;
}

export interface FinanceProductsReport {
  range: FinanceRange;
  /** The database said there are more rows than `limit`, rather than a guess. */
  truncated: boolean;
  limit: number;
  products: FinanceBreakdownRow[];
  meta: FinanceBreakdownMeta;
}

export interface FinanceCategoriesReport {
  range: FinanceRange;
  level: 'main' | 'sub';
  truncated: boolean;
  limit: number;
  categories: FinanceBreakdownRow[];
  meta: FinanceBreakdownMeta;
}

/**
 * The query every finance endpoint takes. `from`/`to` are BAGHDAD days: the
 * server rejects anything else, and sending a `toISOString().slice(0,10)`
 * would ask for yesterday for the first three hours of every Iraqi day.
 */
export interface FinanceQuery {
  from: string;
  to: string;
}

const financePath = (path: string, params: Record<string, string | number | undefined>): string => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  const query = q.toString();
  return query ? `${path}?${query}` : path;
};

/** GET /api/admin/finance/report/summary — buckets, totals, and the comparison. */
export function fetchFinanceSummary(
  query: FinanceQuery & { granularity: FinanceGranularity },
  opts?: RequestOptions
): Promise<FinancePeriodReport> {
  return api.get<FinancePeriodReport & { success: boolean }>(
    financePath('/api/admin/finance/report/summary', {
      from: query.from,
      to: query.to,
      granularity: query.granularity,
    }),
    opts
  );
}

/** GET /api/admin/finance/report/products — GROSS profit per product. Never net. */
export function fetchFinanceProducts(
  query: FinanceQuery & { limit?: number },
  opts?: RequestOptions
): Promise<FinanceProductsReport> {
  return api.get<FinanceProductsReport & { success: boolean }>(
    financePath('/api/admin/finance/report/products', {
      from: query.from,
      to: query.to,
      limit: query.limit,
    }),
    opts
  );
}

/** GET /api/admin/finance/report/categories — the same, rolled up to a rung. */
export function fetchFinanceCategories(
  query: FinanceQuery & { level: 'main' | 'sub'; limit?: number },
  opts?: RequestOptions
): Promise<FinanceCategoriesReport> {
  return api.get<FinanceCategoriesReport & { success: boolean }>(
    financePath('/api/admin/finance/report/categories', {
      from: query.from,
      to: query.to,
      level: query.level,
      limit: query.limit,
    }),
    opts
  );
}

// ===========================================================================
//  «إدارة المخزون» — INVENTORY
// ===========================================================================

/**
 * THESE TYPES MIRROR THE ADMIN INVENTORY ROUTES, and they are OPTIONAL WHERE
 * THE SERVER MAY REMOVE THEM.
 *
 * ###########################################################################
 * #  EVERY `?`-MARKED FIELD BELOW IS A FIELD AN ASSISTANT ADMIN NEVER SEES. #
 * ###########################################################################
 *
 * Unlike the finance endpoints — which refuse an assistant at the door,
 * because there is no useful non-financial part of a profit report — the
 * inventory endpoints are OPEN to an assistant and strip the money from the
 * payload instead (mandate §52: they run the warehouse, they do not see what
 * it cost). `projectForAdmin` deletes the cost keys server-side.
 *
 * So the honest TypeScript for a cost field here is `number | null |
 * undefined`, and that is why they are marked optional: a component that
 * renders `line.inventory_value_iqd` unconditionally will not compile, which
 * is the point. `undefined` means "you are not allowed to know", `null` means
 * "nobody knows" — the screen must not render them the same way.
 */

export type InventoryScope = 'base' | 'option' | 'color' | 'variant';
export type IncomingStatus = 'draft' | 'incoming' | 'partial' | 'received' | 'cancelled';
export type AdjustReason = 'count' | 'damaged' | 'lost' | 'supplier_shortage' | 'other';

export const ADJUST_REASONS: readonly AdjustReason[] = ['count', 'damaged', 'lost', 'supplier_shortage', 'other'];

export interface InventoryOverview {
  on_hand_units: number;
  active_lots: number;
  /** Units on the shelf whose cost nobody knows. Reported so the value figure
   *  below cannot be read as covering them. */
  unpriced_units: number;
  inventory_value_iqd?: number;
  incoming_purchases: number;
  incoming_units: number;
  incoming_purchase_total_iqd?: number;
  aging_units: { d0_30: number; d31_90: number; d91_180: number; d180_plus: number };
}

export interface InventoryLine {
  product_id: string | null;
  product_name: string | null;
  product_sku: string | null;
  product_image: string | null;
  inventory_mode: string | null;
  scope: InventoryScope;
  scope_id: string;
  on_hand: number;
  lot_count: number;
  oldest_received_at: string | null;
  unpriced_units: number;
  inventory_value_iqd?: number | null;
  /** «التكلفة التالية» — what the NEXT unit sold will cost. */
  oldest_unit_cost_iqd?: number | null;
  newest_unit_cost_iqd?: number | null;
}

export interface InventoryLot {
  id: string;
  product_id: string | null;
  scope: InventoryScope;
  scope_id: string;
  qty_received: number;
  qty_remaining: number;
  cost_basis: 'received' | 'opening' | 'opening_unpriced';
  received_at: string;
  purchase_date: string | null;
  supplier_name: string | null;
  consumed: number;
  unit_cost_iqd?: number | null;
  purchase_unit_iqd?: number | null;
  shipping_share_iqd?: number | null;
  internal_share_iqd?: number | null;
  total_cost_iqd?: number | null;
}

export interface IncomingPurchase {
  id: string;
  product_id: string | null;
  product_name: string | null;
  product_image: string | null;
  scope: InventoryScope;
  scope_id: string;
  qty_ordered: number;
  qty_received: number;
  qty_outstanding: number;
  status: IncomingStatus;
  supplier_id: string | null;
  supplier_name: string | null;
  supplier_ref: string;
  purchase_date: string | null;
  expected_at: string | null;
  tracking: string;
  notes: string;
  source_currency: string;
  source_unit_amount: number | null;
  exchange_rate_used: number | null;
  created_at: string;
  purchase_unit_iqd?: number;
  shipping_total_iqd?: number | null;
  internal_delivery_total_iqd?: number | null;
  purchase_total_iqd?: number;
}

/** The server's own arithmetic for one receipt. The dialog NEVER recomputes
 *  it — a preview that does its own sums is a preview that can disagree with
 *  the thing it is confirming. */
export interface LotCostBreakdown {
  purchaseUnitIqd: number;
  shippingShareIqd: number | null;
  internalShareIqd: number | null;
  unitCostIqd: number | null;
  totalCostIqd: number | null;
  /** False when a component was left blank. The receipt is refused. */
  complete: boolean;
}

export type ReceiveRefusalCode =
  | 'ALREADY_RECEIVED'
  | 'CANCELLED'
  | 'QTY_EXCEEDS_ORDER'
  | 'QTY_INVALID'
  | 'COST_NOT_STATED';

export interface ReceivePreview {
  ok: boolean;
  qty?: number;
  remaining?: number;
  cost?: LotCostBreakdown;
  code?: ReceiveRefusalCode;
  message?: string;
}

export interface InventoryMovement {
  id: string;
  product_id: string | null;
  product_name: string | null;
  scope: InventoryScope | 'preorder' | 'preorder_transport';
  scope_id: string;
  kind: string;
  qty: number;
  order_id: string | null;
  reason: string;
  created_at: string;
  actor_name: string | null;
}

export interface InventorySupplier {
  id: string;
  name: string;
  contact: string;
  notes: string;
  active: number;
}

export interface ProfitPreview {
  ready: boolean;
  cost: LotCostBreakdown;
  selling_price_iqd?: number;
  gross_profit_iqd?: number;
  margin_percent?: number;
  total_gross_profit_iqd?: number;
}

const INV = '/api/admin/inventory';

export const fetchInventoryOverview = (opts?: RequestOptions) =>
  api.get<InventoryOverview & { success: boolean }>(`${INV}/overview`, opts);

export const fetchInventoryLines = (
  query: { q?: string; product_id?: string; limit?: number; offset?: number } = {},
  opts?: RequestOptions
) =>
  api.get<{ success: boolean; lines: InventoryLine[]; limit: number; offset: number }>(
    financePath(`${INV}/lines`, query),
    opts
  );

export const fetchInventoryLots = (
  query: { product_id?: string; scope?: InventoryScope; scope_id?: string },
  opts?: RequestOptions
) => api.get<{ success: boolean; lots: InventoryLot[] }>(financePath(`${INV}/lots`, query), opts);

export const fetchIncoming = (query: { status?: IncomingStatus } = {}, opts?: RequestOptions) =>
  api.get<{ success: boolean; incoming: IncomingPurchase[] }>(financePath(`${INV}/incoming`, query), opts);

export const createIncoming = (body: Record<string, unknown>) =>
  api.post<{ success: boolean; id: string }>(`${INV}/incoming`, body);

export const updateIncoming = (id: string, body: Record<string, unknown>) =>
  api.patch<{ success: boolean; changed: number }>(`${INV}/incoming/${id}`, body);

export const fetchReceivePreview = (id: string, qty: number, opts?: RequestOptions) =>
  api.get<ReceivePreview & { success: boolean }>(financePath(`${INV}/incoming/${id}/receive-preview`, { qty }), opts);

/**
 * `receiptId` IS THE CLIENT'S, ONE PER PRESS OF THE BUTTON, and that is the
 * whole double-tap defence. A server-minted id would differ on every retry,
 * which is exactly how one press becomes two receipts and ten units become
 * twenty. The caller mints it BEFORE the first attempt and reuses it for
 * every retry of that same press.
 */
export const receiveIncoming = (id: string, receiptId: string, qty: number) =>
  api.post<{ success: boolean; already?: boolean; lot_id?: string; qty?: number; status?: IncomingStatus; cost?: LotCostBreakdown; message?: string }>(
    `${INV}/incoming/${id}/receive`,
    { receipt_id: receiptId, qty }
  );

export const fetchProfitPreview = (id: string, opts?: RequestOptions) =>
  api.get<ProfitPreview & { success: boolean }>(`${INV}/incoming/${id}/profit-preview`, opts);

export const fetchMovements = (query: { product_id?: string; limit?: number } = {}, opts?: RequestOptions) =>
  api.get<{ success: boolean; movements: InventoryMovement[] }>(financePath(`${INV}/movements`, query), opts);

export const createAdjustment = (body: {
  product_id: string;
  scope: InventoryScope;
  scope_id?: string;
  delta: number;
  reason: AdjustReason;
  note?: string;
}) => api.post<{ success: boolean }>(`${INV}/adjustments`, body);

export const fetchSuppliers = (opts?: RequestOptions) =>
  api.get<{ success: boolean; suppliers: InventorySupplier[] }>(`${INV}/suppliers`, opts);

export const createSupplier = (body: { name: string; contact?: string; notes?: string }) =>
  api.post<{ success: boolean; id: string }>(`${INV}/suppliers`, body);

// ------------------------------------------- the operating-expense ledger

/**
 * «يستطيع الادمن في لوحه الاداره اضافه تكاليف اخرى ... لا علاقه لها بالمنتج
 *  الاساسي او ما يظهر للمستخدم، انها خاصه في لوحه الادمن» — THE WRITE SIDE.
 *
 * The dashboard above READS operating expenses as one aggregate per period.
 * These are the calls that put them there, and without them the owner's actual
 * request is not delivered at all: eight endpoints nothing calls, an empty
 * `operating_expenses` table forever, and a «الربح الصافي» permanently equal to
 * «الربح الإجمالي» — a net profit that silently ignores rent and salaries,
 * which is the number the owner would price against.
 *
 * SAME GATE, SAME ROUTER. `/api/admin/finance/*` carries `requireAdmin` plus a
 * router-level financial check on `*`, so an assistant admin is refused before
 * a query runs — here as everywhere else, the client's job is to explain the
 * refusal, never to be the gate.
 *
 * AN EXPENSE BELONGS TO NO PRODUCT and there is no field for one. That is the
 * owner's own model: product cost is ONE level, on the product; everything
 * else is an operating expense and is period-level only.
 */

export interface ExpenseCategory {
  id: string;
  slug: string;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  sort?: number;
  /** A category is deactivated, never deleted: no past expense may lose its label. */
  active: boolean;
}

export interface ExpenseEntry {
  id: string;
  category_id: string;
  category_slug: string;
  category_name_ar: string;
  amount_iqd: number;
  /** The BAGHDAD civil day the owner says it belongs to — not the day it was typed. */
  expense_day: string;
  title: string;
  note: string;
  /** Set when the row was created as one month of a repeat; no report reads it. */
  series_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  /** Removal is a VOID, not a delete: the row stays, with who removed it and why. */
  voided: boolean;
  voided_at: string | null;
  voided_by: string | null;
  void_reason: string;
}

export interface ExpenseLedgerPage {
  from: string;
  to: string;
  expenses: ExpenseEntry[];
  /** The PERIOD's total, from an unbounded SUM — not the page's. */
  total_iqd: number;
  /** What the returned rows alone add up to, so the visible list adds up. */
  page_total_iqd: number;
  count: number;
  limit: number;
  truncated: boolean;
}

export function fetchExpenseCategories(opts?: RequestOptions): Promise<{ categories: ExpenseCategory[] }> {
  return api.get<{ categories: ExpenseCategory[]; success: boolean }>('/api/admin/finance/expense-categories', opts);
}

export function createExpenseCategory(
  body: { name_ar: string; name_en?: string; name_ckb?: string },
  opts?: RequestOptions
): Promise<{ category: ExpenseCategory }> {
  return api.post<{ category: ExpenseCategory; success: boolean }>('/api/admin/finance/expense-categories', body, opts);
}

export function updateExpenseCategory(
  id: string,
  body: { name_ar?: string; name_en?: string; name_ckb?: string; active?: boolean },
  opts?: RequestOptions
): Promise<{ success: boolean }> {
  return api.patch<{ success: boolean }>(`/api/admin/finance/expense-categories/${encodeURIComponent(id)}`, body, opts);
}

/** The ledger for a period. `include_voided` shows what was removed, and by whom. */
export function fetchExpenses(
  query: { from: string; to: string; category_id?: string; include_voided?: boolean; limit?: number },
  opts?: RequestOptions
): Promise<ExpenseLedgerPage> {
  return api.get<ExpenseLedgerPage & { success: boolean }>(
    financePath('/api/admin/finance/expenses', {
      from: query.from,
      to: query.to,
      category_id: query.category_id,
      include_voided: query.include_voided ? '1' : undefined,
      limit: query.limit,
    }),
    opts
  );
}

/**
 * Record an expense. `repeat_months` writes N REAL ROWS NOW — it is not a
 * recurrence rule, and nothing generates rows later. The server's own comment
 * says why: a rule evaluated at report time makes last January's profit depend
 * on this June's edit, which is the same silent rewriting of history the cost
 * snapshot exists to abolish.
 */
export function createExpense(
  body: {
    category_id: string;
    amount_iqd: number;
    expense_day: string;
    title?: string;
    note?: string;
    repeat_months?: number;
  },
  opts?: RequestOptions
): Promise<{ ids: string[]; series_id: string | null; days: string[] }> {
  return api.post<{ ids: string[]; series_id: string | null; days: string[]; success: boolean }>(
    '/api/admin/finance/expenses',
    body,
    opts
  );
}

export function updateExpense(
  id: string,
  body: { category_id?: string; amount_iqd?: number; expense_day?: string; title?: string; note?: string },
  opts?: RequestOptions
): Promise<{ success: boolean }> {
  return api.patch<{ success: boolean }>(`/api/admin/finance/expenses/${encodeURIComponent(id)}`, body, opts);
}

/** VOID, not delete — a removed expense changes a net profit the owner may
 *  already have acted on, so the row and the reason stay. */
export function voidExpense(id: string, reason: string, opts?: RequestOptions): Promise<{ voided: boolean }> {
  return api.delete<{ voided: boolean; success: boolean }>(
    financePath(`/api/admin/finance/expenses/${encodeURIComponent(id)}`, { reason }),
    opts
  );
}

export function restoreExpense(id: string, opts?: RequestOptions): Promise<{ restored: boolean }> {
  return api.post<{ restored: boolean; success: boolean }>(
    `/api/admin/finance/expenses/${encodeURIComponent(id)}/restore`,
    undefined,
    opts
  );
}
