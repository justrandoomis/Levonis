/**
 * POST /api/meta-events — the browser's half of two Meta Conversions API
 * events (worker/lib/metaCapi.ts says what is sent to Meta and why).
 *
 * Body (JSON sent as text by `navigator.sendBeacon`, at most 1 KB):
 *   { event: 'PageView' | 'ViewContent',
 *     id: <the event id the browser pixel used, so Meta keeps one of the two>,
 *     path: <the page's path, no query string>,
 *     product?: <product id — ViewContent only> }
 *
 * Only these two come from a browser. AddToCart, InitiateCheckout and Purchase
 * are sent by the server's own doors (cart, quote, order) with the server's
 * own figures, so no price is ever taken from a request here.
 *
 * The answer is 204 whether or not anything was sent: a store host, a page
 * that is not reported, a crawler, a deployment without the secret — the
 * sender learns nothing about which. A malformed body is a 400 with a stable
 * code; a sender over the per-minute limit gets the platform's 429.
 */
import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { HttpError, badRequest } from '../lib/http';
import { rateLimit } from '../lib/ratelimit';
import { sha256Hex } from '../lib/crypto';
import { isBotUserAgent } from '../lib/storefrontAnalytics';
import { networkOf } from './storefrontEvents';
import {
  isMetaReportedPath,
  metaCapiConfigured,
  metaSourceUrl,
  metaUserData,
  nowSeconds,
  onMetaMainSite,
  sendMetaEventsLater,
  type MetaServerEvent,
} from '../lib/metaCapi';

export const metaEventRoutes = new Hono<AppContext>();

/** The largest body a beacon may carry. */
export const MAX_META_EVENT_BYTES = 1024;
/** The events a browser may report; everything else is the server's own. */
export const RELAYED_META_EVENTS = ['PageView', 'ViewContent'] as const;

const EVENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const PRODUCT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PATH_RE = /^\/[A-Za-z0-9._~%!$&'()*+,;=:@/-]{0,300}$/;

metaEventRoutes.post('/', async (c) => {
  c.header('Cache-Control', 'no-store');
  const declared = Number(c.req.header('Content-Length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_META_EVENT_BYTES) {
    throw new HttpError(413, 'Event too large', 'EVENT_TOO_LARGE');
  }
  const raw = await c.req.text();
  if (raw.length > MAX_META_EVENT_BYTES) throw new HttpError(413, 'Event too large', 'EVENT_TOO_LARGE');
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    body = parsed as Record<string, unknown>;
  } catch {
    throw badRequest('The event is not valid JSON', 'BAD_EVENT');
  }
  const event = body.event;
  if (typeof event !== 'string' || !(RELAYED_META_EVENTS as readonly string[]).includes(event)) {
    throw badRequest('Unknown event', 'BAD_EVENT');
  }
  const eventId = typeof body.id === 'string' && EVENT_ID_RE.test(body.id) ? body.id : '';
  if (!eventId) throw badRequest('id is required', 'BAD_EVENT');
  const path = typeof body.path === 'string' && PATH_RE.test(body.path) ? body.path : '';
  if (!path) throw badRequest('path is required', 'BAD_EVENT');
  const product = typeof body.product === 'string' && PRODUCT_ID_RE.test(body.product) ? body.product : '';
  if (event === 'ViewContent' && !product) throw badRequest('product is required for this event', 'BAD_EVENT');

  const nothing = () => c.body(null, 204);
  // The main site, a reported page, a configured deployment, a person: or nothing.
  if (!onMetaMainSite(c) || !metaCapiConfigured(c.env) || !isMetaReportedPath(path)) return nothing();
  if (event === 'ViewContent' && !/^\/(?:product|bundles)\/[^/]+\/?$/.test(path)) return nothing();
  if (isBotUserAgent(c.req.header('User-Agent'))) return nothing();

  const user = c.get('user');
  const network = networkOf(c.req.header('CF-Connecting-IP') || '');
  // Per minute, by account or by network — the network hashed, never stored raw.
  await rateLimit(c, 'meta-events', 120, 60, user ? undefined : (await sha256Hex(`net\n${network}`)).slice(0, 24));

  sendMetaEventsLater(c, async (): Promise<MetaServerEvent[]> => [
    {
      event_name: event as (typeof RELAYED_META_EVENTS)[number],
      event_time: nowSeconds(),
      event_id: eventId,
      action_source: 'website',
      event_source_url: metaSourceUrl(c, path),
      user_data: await metaUserData(c, user),
      ...(event === 'ViewContent' ? { custom_data: { content_type: 'product' as const, content_ids: [product] } } : {}),
    },
  ]);
  return nothing();
});
