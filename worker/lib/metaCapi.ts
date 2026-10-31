/**
 * META CONVERSIONS API — the server half of the Meta Pixel (owner request
 * 2026-10-31; docs/DECISIONS.md row 277; the browser half is src/lib/metaPixel.ts).
 *
 * WHAT IS SENT, AND FROM WHERE. Five events, every one from THIS server, so
 * every value is the server's own figure and none can be typed in by a browser:
 *   PageView        mirrored from the browser pixel's own page view, with the
 *                   SAME event id, so Meta keeps one (routes/metaEvents.ts);
 *   ViewContent     a product page was opened (routes/metaEvents.ts);
 *   AddToCart       a platform product was added to the cart (routes/cart.ts);
 *   InitiateCheckout the checkout was priced (routes/orders.ts, the quote);
 *   Purchase        an order was placed — after the order's batch committed
 *                   (routes/orders.ts placeOrder; Quick Buy included).
 * The MAIN SITE only — never a merchant's store host, never Print Cloud — and,
 * for the page-bound events, only the pages src/lib/metaPixel.ts allows
 * (`isMetaReportedPath` below is its server copy; tests/metaCapi.test.ts holds
 * the two to the same answers).
 *
 * WHO. With each event: the visitor's IP address and browser, Meta's own
 * `_fbp`/`_fbc` cookies when present, and for a signed-in customer their email
 * and phone number HASHED (SHA-256, never in clear; a phone-only account's
 * placeholder address is never sent). The privacy policy (version 4, chapter 7)
 * says exactly this — a new event or a new field is a change to it too.
 *
 * MONEY IS SENT IN US DOLLARS. Meta's currency list has no Iraqi dinar
 * (developers.facebook.com/docs/marketing-api/currencies, read 2026-10-31), so
 * IQD figures are converted at the shop's official rate — for a purchase, the
 * rate stored on the order itself.
 *
 * NOTHING WAITS ON META. Events leave after the response (waitUntil), and a
 * missing token, a timeout or a refusal never touches the customer's request.
 * With no `META_CAPI_ACCESS_TOKEN` secret nothing is sent at all.
 */
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { fetchWithBudget, PROVIDER_BUDGETS } from '@levonis/platform-kit/httpx';
import type { AppContext, Env } from './types';
import { sha256Hex } from './crypto';
import { isPlaceholderEmail } from './profileCompletion';
import { requestHost } from './http';
import { adminAllowedOn } from './hosts';
import { waitUntilFrom } from './eventBus';

/** The dataset is the pixel: the same id as src/lib/metaPixel.ts META_PIXEL_ID. */
export const META_DATASET_ID = '906446185408755';
/** Current at 2026-10-31; Conversions API versions are supported for at least two years. */
export const META_GRAPH_VERSION = 'v26.0';
export const META_CAPI_ENDPOINT = `https://graph.facebook.com/${META_GRAPH_VERSION}/${META_DATASET_ID}/events`;

export type MetaEventName = 'PageView' | 'ViewContent' | 'AddToCart' | 'InitiateCheckout' | 'Purchase';

export interface MetaContent {
  id: string;
  quantity: number;
  item_price?: number;
}

export interface MetaCustomData {
  currency?: 'USD';
  value?: number;
  content_ids?: string[];
  content_type?: 'product';
  contents?: MetaContent[];
  num_items?: number;
}

export interface MetaServerEvent {
  event_name: MetaEventName;
  event_time: number;
  event_id: string;
  action_source: 'website' | 'system_generated';
  event_source_url?: string;
  user_data: Record<string, string | string[]>;
  custom_data?: MetaCustomData;
}

export function metaCapiConfigured(env: Pick<Env, 'META_CAPI_ACCESS_TOKEN'>): boolean {
  return (env.META_CAPI_ACCESS_TOKEN || '').trim().length > 0;
}

/**
 * The platform's main site, as the SERVER classified the Host: never a
 * merchant's store, never a system host (Print Cloud). A host outside the root
 * domain (local development, workers.dev) counts, as it does for the browser.
 */
export function onMetaMainSite(c: Context<AppContext>): boolean {
  return adminAllowedOn(requestHost(c));
}

/**
 * The pages a page-bound event may come from — the server copy of
 * src/lib/metaPixel.ts TRACKED_PATHS (tests/metaCapi.test.ts compares them).
 */
const REPORTED_PATHS: readonly RegExp[] = [
  /^\/$/,
  /^\/products$/,
  /^\/product\/[^/]+$/,
  /^\/categories(?:\/[^/]+){0,2}$/,
  /^\/compare$/,
  /^\/used-printers$/,
  /^\/bundles(?:\/[^/]+)?$/,
  /^\/cart$/,
  /^\/checkout$/,
  /^\/community(?:\/(?:stores|makers|projects))?$/,
  /^\/community\/projects\/(?!new$)[^/]+$/,
  /^\/community\/store\/[^/]+(?:\/p\/[^/]+)?$/,
  /^\/u\/[^/]+$/,
  /^\/tools$/,
  /^\/printer-finder$/,
  /^\/policies(?:\/[^/]+)?$/,
  /^\/policy$/,
];

export function isMetaReportedPath(pathname: string): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return REPORTED_PATHS.some((pattern) => pattern.test(path));
}

export function normalizeMetaEmail(email: string | null | undefined): string | null {
  const e = String(email ?? '').trim().toLowerCase();
  if (!e || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) || isPlaceholderEmail(e)) return null;
  return e;
}

/** E.164 (`+9647701234567`) → digits with the country code (`9647701234567`). */
export function normalizeMetaPhone(phone: string | null | undefined): string | null {
  const digits = String(phone ?? '').replace(/\D/g, '').replace(/^00/, '');
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

const FBP = /^fb\.\d\.\d{10,16}\.\d{1,24}$/;
const FBC = /^fb\.\d\.\d{10,16}\.[A-Za-z0-9_-]{1,512}$/;

/**
 * Who, for Meta's matching. The email and phone are hashed here and never
 * leave in clear; IP, browser and Meta's own cookie values are sent as they
 * are (Meta requires those unhashed).
 */
export async function metaUserData(
  c: Context<AppContext>,
  user: { email?: string | null; phone_e164?: string | null } | null,
  opts: { browser?: boolean } = {}
): Promise<Record<string, string | string[]>> {
  const out: Record<string, string | string[]> = {};
  const em = normalizeMetaEmail(user?.email);
  if (em) out.em = [await sha256Hex(em)];
  const ph = normalizeMetaPhone(user?.phone_e164);
  if (ph) out.ph = [await sha256Hex(ph)];
  if (opts.browser === false) return out;
  const ip = (c.req.header('CF-Connecting-IP') || '').trim();
  if (ip && ip.length <= 64 && !/\s/.test(ip)) out.client_ip_address = ip;
  const ua = (c.req.header('User-Agent') || '').trim();
  if (ua) out.client_user_agent = ua.slice(0, 512);
  const fbp = readCookie(c, '_fbp');
  if (fbp && FBP.test(fbp)) out.fbp = fbp;
  const fbc = readCookie(c, '_fbc');
  if (fbc && FBC.test(fbc)) out.fbc = fbc;
  return out;
}

function readCookie(c: Context<AppContext>, name: string): string | undefined {
  try {
    return getCookie(c, name) || undefined;
  } catch {
    return undefined;
  }
}

/** IQD → US dollars at a whole-dinar rate, to the cent; null when either is unusable. */
export function iqdToUsd(iqd: number, iqdPerUsd: number): number | null {
  if (!Number.isFinite(iqd) || iqd < 0 || !Number.isFinite(iqdPerUsd) || iqdPerUsd <= 0) return null;
  return Math.round((iqd / iqdPerUsd) * 100) / 100;
}

/** `https://<host><path>` for a server-built event — the request's own origin, never a query string. */
export function metaSourceUrl(c: Context<AppContext>, path: string): string | undefined {
  try {
    return `${new URL(c.req.url).origin}${path}`;
  } catch {
    return undefined;
  }
}

/** A deterministic, opaque event id: no order number or account id leaves in clear. */
export async function metaEventId(kind: string, ...parts: string[]): Promise<string> {
  return `${kind}_${(await sha256Hex(['meta-event', kind, ...parts].join('\n'))).slice(0, 40)}`;
}

/** One POST to Meta. Never throws; the answer says what happened. */
export async function sendMetaEvents(
  env: Pick<Env, 'META_CAPI_ACCESS_TOKEN' | 'META_CAPI_TEST_EVENT_CODE'>,
  events: MetaServerEvent[],
  opts: { fetchImpl?: typeof fetch } = {}
): Promise<'sent' | 'not-configured' | 'failed'> {
  const token = (env.META_CAPI_ACCESS_TOKEN || '').trim();
  if (!token) return 'not-configured';
  if (!events.length) return 'sent';
  // Form fields, as Meta's own example sends them: the token travels in the
  // body, never in a URL that a log could keep.
  const form = new URLSearchParams();
  form.set('data', JSON.stringify(events));
  form.set('access_token', token);
  const testCode = (env.META_CAPI_TEST_EVENT_CODE || '').trim();
  if (testCode) form.set('test_event_code', testCode);
  try {
    const res = await fetchWithBudget(
      META_CAPI_ENDPOINT,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() },
      {
        timeoutMs: PROVIDER_BUDGETS.ads.timeoutMs,
        // A retried batch is safe: Meta keeps the first copy of an event_id.
        retries: PROVIDER_BUDGETS.ads.retries,
        provider: 'meta_capi',
        fetchImpl: opts.fetchImpl,
      }
    );
    if (!res.ok) {
      console.warn(`meta-capi: refused (${res.status}) ${(await res.text().catch(() => '')).slice(0, 300)}`);
      return 'failed';
    }
    return 'sent';
  } catch (err) {
    console.warn(`meta-capi: unreachable ${String(err).slice(0, 200)}`);
    return 'failed';
  }
}

/** The dataset's own id and name: what the owner's check asks Meta for. */
export const META_DATASET_CHECK_URL = `https://graph.facebook.com/${META_GRAPH_VERSION}/${META_DATASET_ID}?fields=id,name`;

/** Meta's answer to the owner's check (Admin → Providers). Never carries the token. */
export interface MetaCapiCheck {
  /** The Worker has META_CAPI_ACCESS_TOKEN. */
  configured: boolean;
  /** META_CAPI_TEST_EVENT_CODE is set: server events land in Events Manager → Test events only. */
  testMode: boolean;
  /** Meta answered with this dataset's id. */
  ok: boolean;
  status: number | null;
  datasetName: string | null;
  error: { code: number | null; subcode: number | null; type: string | null; message: string } | null;
}

/**
 * ASKS META WHETHER THE TOKEN REACHES THE DATASET (owner report 2026-10-31:
 * "No server events"). A secret can be present and wrong, expired, or set on
 * another Worker; only Meta can say. This is a READ of the dataset's own id
 * and name: no event is created and nothing is counted (an event sent with a
 * test code still counts, so none is sent). The token travels in the
 * Authorization header, never in a URL, and never comes back in the answer.
 */
export async function checkMetaCapi(
  env: Pick<Env, 'META_CAPI_ACCESS_TOKEN' | 'META_CAPI_TEST_EVENT_CODE'>,
  opts: { fetchImpl?: typeof fetch } = {}
): Promise<MetaCapiCheck> {
  const token = (env.META_CAPI_ACCESS_TOKEN || '').trim();
  const testMode = (env.META_CAPI_TEST_EVENT_CODE || '').trim().length > 0;
  const base: MetaCapiCheck = { configured: token.length > 0, testMode, ok: false, status: null, datasetName: null, error: null };
  if (!token) return base;
  const clean = (text: string, max: number) => text.split(token).join('***').slice(0, max);
  try {
    const res = await fetchWithBudget(
      META_DATASET_CHECK_URL,
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      { timeoutMs: PROVIDER_BUDGETS.ads.timeoutMs, retries: 0, provider: 'meta_capi', fetchImpl: opts.fetchImpl }
    );
    const body = (await res.json().catch(() => null)) as {
      id?: unknown;
      name?: unknown;
      error?: { message?: unknown; type?: unknown; code?: unknown; error_subcode?: unknown };
    } | null;
    if (res.ok && body && String(body.id ?? '') === META_DATASET_ID) {
      return { ...base, ok: true, status: res.status, datasetName: typeof body.name === 'string' ? clean(body.name, 120) : null };
    }
    const e = body?.error;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    return {
      ...base,
      status: res.status,
      error: {
        code: num(e?.code),
        subcode: num(e?.error_subcode),
        type: typeof e?.type === 'string' ? clean(e.type, 60) : null,
        message: clean(typeof e?.message === 'string' ? e.message : `HTTP ${res.status}`, 300),
      },
    };
  } catch (err) {
    return { ...base, error: { code: null, subcode: null, type: 'unreachable', message: clean(String(err), 200) } };
  }
}

/**
 * Sends after the response. Nothing leaves without the secret, and nothing
 * leaves where there is no ExecutionContext (a test's bare request).
 */
export function sendMetaEventsLater(c: Context<AppContext>, build: () => Promise<MetaServerEvent[]>): void {
  if (!metaCapiConfigured(c.env ?? {})) return;
  const later = waitUntilFrom(c);
  if (!later) return;
  later(
    build()
      .then((events) => sendMetaEvents(c.env, events))
      .catch((err) => console.warn(`meta-capi: not built ${String(err).slice(0, 200)}`))
  );
}

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export interface MetaLine {
  product_id: string;
  qty: number;
  unit_iqd: number;
}

/** A checkout line as worker/routes/orders.ts computes it (ComputedLine, the fields read here). */
export interface CheckoutLineLike {
  product_id: string | null;
  qty: number;
  unit: number;
  gift?: unknown;
  bundle_parent_item_id?: string | null;
}

/**
 * The lines Meta is told about: one per cart line — a bundle's component rows
 * (which carry their parent's id, see orders.ts quoteLines) and 0 IQD gifts are
 * not purchases of their own.
 */
export function metaLinesFrom(lines: readonly CheckoutLineLike[]): MetaLine[] {
  return lines
    .filter((l) => !l.bundle_parent_item_id && !l.gift && l.product_id)
    .map((l) => ({ product_id: String(l.product_id), qty: l.qty, unit_iqd: l.unit }));
}

type MetaCustomer = { id: string; email?: string | null; phone_e164?: string | null };

/**
 * InitiateCheckout, from the checkout's quote. The quote is asked again on
 * every change of address or payment method, so the event id is the same for
 * one customer, one cart and one day: Meta keeps the first copy of an id.
 */
export function queueMetaInitiateCheckout(
  c: Context<AppContext>,
  user: MetaCustomer,
  comp: { lines: readonly CheckoutLineLike[]; totalIqd: number; exchangeRate: number }
): void {
  if (!onMetaMainSite(c)) return;
  sendMetaEventsLater(c, async () => {
    const lines = metaLinesFrom(comp.lines);
    if (!lines.length) return [];
    const signature = lines.map((l) => `${l.product_id}x${l.qty}`).sort().join(',');
    const day = new Date().toISOString().slice(0, 10);
    return [
      {
        event_name: 'InitiateCheckout',
        event_time: nowSeconds(),
        event_id: await metaEventId('ic', user.id, day, signature),
        action_source: 'website',
        event_source_url: metaSourceUrl(c, '/checkout'),
        user_data: await metaUserData(c, user),
        custom_data: metaLinesData(lines, comp.totalIqd, comp.exchangeRate, { numItems: true }),
      },
    ];
  });
}

/**
 * Purchase, after the order's batch committed. A Quick Buy order may be
 * submitted by the cron after the customer has gone (worker/lib/quickBuy/
 * finalize.ts): with no browser behind the request it is sent as
 * `system_generated`, with the hashed email and phone only.
 */
export function queueMetaPurchase(
  c: Context<AppContext>,
  user: MetaCustomer,
  order: { id: string; totalIqd: number; exchangeRate: number; lines: readonly CheckoutLineLike[] },
  opts: { quickBuy: boolean }
): void {
  // A Quick Buy is opened from the main site's product page only; every other
  // order counts only when it was placed on the main site.
  if (!opts.quickBuy && !onMetaMainSite(c)) return;
  sendMetaEventsLater(c, async () => {
    const lines = metaLinesFrom(order.lines);
    const fromBrowser = Boolean((c.req.header('User-Agent') || '').trim());
    const user_data = await metaUserData(c, user, { browser: fromBrowser });
    if (!Object.keys(user_data).length) return [];
    return [
      {
        event_name: 'Purchase',
        event_time: nowSeconds(),
        event_id: await metaEventId('purchase', order.id),
        action_source: fromBrowser ? 'website' : 'system_generated',
        ...(fromBrowser ? { event_source_url: metaSourceUrl(c, opts.quickBuy ? '/' : '/checkout') } : {}),
        user_data,
        custom_data: metaLinesData(lines, order.totalIqd, order.exchangeRate),
      },
    ];
  });
}

/**
 * The page an add came from, as a reported path — the Referer's path when it
 * is one of the allowlisted pages, else the cart. Never its query string.
 */
export function metaRefererPath(c: Context<AppContext>, fallback: string): string {
  try {
    const ref = c.req.header('Referer');
    if (ref) {
      const url = new URL(ref);
      if (url.origin === new URL(c.req.url).origin && isMetaReportedPath(url.pathname)) return url.pathname;
    }
  } catch {
    // an unparseable Referer reads as absent
  }
  return fallback;
}

/** A line just added to the cart, at the shop's own dollar price for it (null when the cart carries none). */
export interface MetaCartAdd {
  product_id: string;
  qty: number;
  unit_usd_cents: number | null;
}

/**
 * AddToCart, for platform products added on the main site, at the dollar price
 * the cart just resolved (`unit_price_usd_cents`, DECISIONS row 248) — no rate
 * is read here: the FX module has its own short list of importers
 * (tests/pricingCurrencyRoles.test.ts). A line with no dollar price is sent
 * without one, and then the event carries no value.
 */
export function queueMetaAddToCart(c: Context<AppContext>, user: MetaCustomer, lines: MetaCartAdd[]): void {
  const added = lines.filter((l) => l.product_id && l.qty > 0);
  if (!onMetaMainSite(c) || !added.length) return;
  const sourcePath = metaRefererPath(c, '/cart');
  sendMetaEventsLater(c, async () => {
    const contents: MetaContent[] = added.map((l) =>
      l.unit_usd_cents === null ? { id: l.product_id, quantity: l.qty } : { id: l.product_id, quantity: l.qty, item_price: l.unit_usd_cents / 100 }
    );
    const custom_data: MetaCustomData = { content_type: 'product', content_ids: [...new Set(added.map((l) => l.product_id))], contents };
    if (added.every((l) => l.unit_usd_cents !== null)) {
      custom_data.currency = 'USD';
      custom_data.value = added.reduce((n, l) => n + (l.unit_usd_cents as number) * l.qty, 0) / 100;
    }
    return [
      {
        event_name: 'AddToCart',
        event_time: nowSeconds(),
        event_id: `atc_${crypto.randomUUID().replace(/-/g, '')}`,
        action_source: 'website',
        event_source_url: metaSourceUrl(c, sourcePath),
        user_data: await metaUserData(c, user),
        custom_data,
      },
    ];
  });
}

/** custom_data for a set of priced lines, in USD at `iqdPerUsd`. */
export function metaLinesData(lines: MetaLine[], totalIqd: number, iqdPerUsd: number, opts: { numItems?: boolean } = {}): MetaCustomData {
  const contents: MetaContent[] = [];
  for (const l of lines) {
    if (!l.product_id || !(l.qty > 0)) continue;
    const price = iqdToUsd(l.unit_iqd, iqdPerUsd);
    contents.push(price === null ? { id: l.product_id, quantity: l.qty } : { id: l.product_id, quantity: l.qty, item_price: price });
  }
  const data: MetaCustomData = { content_type: 'product', content_ids: [...new Set(contents.map((x) => x.id))], contents };
  const value = iqdToUsd(totalIqd, iqdPerUsd);
  if (value !== null) {
    data.currency = 'USD';
    data.value = value;
  }
  if (opts.numItems) data.num_items = contents.reduce((n, x) => n + x.quantity, 0);
  return data;
}
