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
  // Per minute, by account or by network — the network hashed, never stored raw.
  await rateLimit(c, 'storefront-events', 240, 60, user ? undefined : (await sha256Hex(`net\n${ip}`)).slice(0, 24));

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
  const net = user ? '' : await saltedHash(salt, 'net', ip);
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
