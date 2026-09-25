/**
 * POST /api/storefront/events — the storefront's first-party analytics beacon.
 *
 * Body (JSON, sent as text by `navigator.sendBeacon`, at most 2 KB):
 *   { event: 'store_view' | 'product_view' | 'add_to_cart' | 'checkout_started',
 *     store: <store id>, product?: <product id — required for product events>,
 *     visitor?: <the page's anonymous first-party id>, ref?: <referrer HOST only> }
 *
 * The answer is 204 whether or not the event counted: a crawler, the store's
 * own owner, a suspended store, a product of another store, a network over its
 * daily cap — each is simply not counted, and the sender learns nothing about
 * which. A malformed body is a 400 with a stable code; a sender over the
 * per-minute limit gets the platform's 429.
 *
 * `order_placed` is not a beacon event: orders are read from `orders` by the
 * analytics API, where a cancellation can correct them.
 *
 * Every rule of what counts, and how the visitor is hashed so nothing that
 * identifies anyone is stored, is in worker/lib/storefrontAnalytics.ts.
 */
import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { HttpError, badRequest } from '../lib/http';
import { rateLimit } from '../lib/ratelimit';
import { sha256Hex } from '../lib/crypto';
import { baghdadDay } from '../lib/baghdadTime';
import { rootDomainFrom } from '../lib/hosts';
import {
  PRODUCT_EVENTS,
  STOREFRONT_EVENTS,
  classifyReferrer,
  cleanAnonId,
  dailySalt,
  isBotUserAgent,
  recordStorefrontEvent,
  saltedHash,
  type StorefrontEvent,
} from '../lib/storefrontAnalytics';

/**
 * THE NETWORK A CLIENT ADDRESS BELONGS TO (review W2-5 p2): an IPv4 address
 * as it is, an IPv6 address as its /64 — one subscriber is routinely handed a
 * whole /64, so keyed on the full address one phone rotating its privacy
 * address is an unlimited number of «networks». IPv4-mapped IPv6
 * (`::ffff:1.2.3.4`) is the IPv4 address. Anything unparseable is kept as is.
 */
export function networkOf(ip: string): string {
  const raw = ip.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (!raw.includes(':')) return raw;
  const halves = raw.split('::');
  if (halves.length > 2) return raw;
  const parse = (part: string): string[] | null => {
    if (!part) return [];
    const out: string[] = [];
    for (const g of part.split(':')) {
      const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(g);
      if (v4) {
        const [a, b, c, d] = v4.slice(1).map(Number);
        if ([a, b, c, d].some((n) => n > 255)) return null;
        out.push(((a << 8) | b).toString(16), ((c << 8) | d).toString(16));
      } else if (/^[0-9a-f]{1,4}$/.test(g)) out.push(g);
      else return null;
    }
    return out;
  };
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if (!head || !tail) return raw;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return raw;
  const groups = [...head, ...new Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail].map((g) => parseInt(g, 16));
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join('.');
  }
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(':')}::/64`;
}

export const storefrontEventRoutes = new Hono<AppContext>();

/** The largest body a beacon may carry. */
export const MAX_EVENT_BYTES = 2048;
/** Beacons per minute from one account or one network, across every store. */
export const EVENTS_PER_MINUTE = 240; // the literal in the rateLimit call below (the gateway parity test reads it)

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

storefrontEventRoutes.post('/', async (c) => {
  c.header('Cache-Control', 'no-store');
  const declared = Number(c.req.header('Content-Length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_EVENT_BYTES) {
    throw new HttpError(413, 'Event too large', 'EVENT_TOO_LARGE');
  }
  const raw = await c.req.text();
  if (raw.length > MAX_EVENT_BYTES) throw new HttpError(413, 'Event too large', 'EVENT_TOO_LARGE');
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    body = parsed as Record<string, unknown>;
  } catch {
    throw badRequest('The event is not valid JSON', 'BAD_EVENT');
  }
  const event = body.event;
  if (typeof event !== 'string' || !(STOREFRONT_EVENTS as readonly string[]).includes(event)) {
    throw badRequest('Unknown event', 'BAD_EVENT');
  }
  const storeId = typeof body.store === 'string' && ID_RE.test(body.store) ? body.store : '';
  if (!storeId) throw badRequest('store is required', 'BAD_EVENT');
  const isProductEvent = PRODUCT_EVENTS.has(event as StorefrontEvent);
  const productId = isProductEvent && typeof body.product === 'string' && ID_RE.test(body.product) ? body.product : '';
  if (isProductEvent && !productId) throw badRequest('product is required for this event', 'BAD_EVENT');

  const noCount = () => c.body(null, 204);
  const ua = c.req.header('User-Agent') ?? '';
  if (isBotUserAgent(ua)) return noCount();

  const user = c.get('user');
  const ip = c.req.header('CF-Connecting-IP') || '';
  // IPv4 as is, IPv6 as its /64 (review W2-5 p2) — for the rate limit AND the per-network cap below.
  const network = networkOf(ip);
  // Per minute, by account or by network — the network hashed, never stored raw.
  await rateLimit(c, 'storefront-events', 240, 60, user ? undefined : (await sha256Hex(`net\n${network}`)).slice(0, 24));

  const store = await c.env.DB.prepare(
    `SELECT s.id, s.slug, s.user_id, s.status, m.status AS merchant_status,
            (SELECT p.id FROM community_products p
              WHERE p.id = ?2 AND p.store_id = s.id AND p.status = 'active') AS product_id
       FROM merchant_stores s
       JOIN community_merchants m ON m.id = s.merchant_id
      WHERE s.id = ?1`
  )
    .bind(storeId, productId)
    .first<{ id: string; slug: string; user_id: string; status: string; merchant_status: string; product_id: string | null }>();
  if (!store) return noCount();
  // A sanctioned store serves nothing of itself (owner decision 2026-09-24),
  // so nothing about it is being viewed.
  if (store.status === 'suspended' || store.merchant_status === 'suspended') return noCount();
  // The store's own owner looking at their shop is not traffic.
  if (user && user.id === store.user_id) return noCount();
  if (isProductEvent && store.product_id !== productId) return noCount();

  const day = baghdadDay(Date.now());
  const salt = await dailySalt(c.env.DB, day);
  const anon = cleanAnonId(body.visitor);
  // The seed never leaves this function: only its salted hash is stored.
  const seed = user ? `u:${user.id}` : anon ? `a:${anon}` : `n:${ip}\n${ua}`;
  const visitor = await saltedHash(salt, store.id, seed);
  const net = user ? '' : await saltedHash(salt, 'net', network);
  const root = rootDomainFrom(c.env);
  const source = classifyReferrer(body.ref, root ? `${store.slug}.${root}` : '');

  await recordStorefrontEvent(c.env.DB, {
    storeId: store.id,
    day,
    event: event as StorefrontEvent,
    productId: isProductEvent ? productId : '',
    visitor,
    net,
    source,
    nonce: crypto.randomUUID(),
  });
  return noCount();
});
