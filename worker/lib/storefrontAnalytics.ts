/**
 * A STORE'S TRAFFIC — counted once per visitor per day, from its own pages,
 * without keeping anything that identifies anyone.
 *
 * WHAT WAS THERE. `merchant_store_analytics_daily` (0030) was never written;
 * product «views» were `view_count + 1` on every product GET, later deduped
 * per IP per day in `rate_limits` — so a carrier NAT (most of Iraq's mobile
 * traffic) counted a thousand shoppers as one, and a script with a few
 * addresses could still inflate it. Store views, add-to-cart and checkouts
 * were not captured at all (audit 04 §5.2, audit 01 B22).
 *
 * WHAT THIS IS. The storefront sends a first-party beacon
 * (worker/routes/storefrontEvents.ts); this module decides whether the event
 * counts and records it:
 *
 *   BOTS by user agent (`isBotUserAgent`) — crawlers, link previewers,
 *   headless browsers and HTTP libraries. Most never run the page's script at
 *   all; this catches the ones that do, and the scripted POST.
 *
 *   THE OWNER is never counted (the caller compares the session with the
 *   store's owner).
 *
 *   ONE VISITOR, ONE COUNT PER DAY. The visitor is a HASH:
 *   SHA-256(day's salt ‖ store ‖ seed), where the seed is the signed-in
 *   account or the anonymous first-party id the page keeps. The salt is random
 *   per Baghdad day and deleted two days later (`pruneStorefrontAnalytics`),
 *   so a stored hash cannot be linked back to the id, to an account, or to the
 *   same visitor on another day. No id, address or user agent is stored.
 *
 *   A NETWORK CAP. An anonymous id is whatever the page sends, so a script can
 *   mint a new one per request. At most `ANON_VISITORS_PER_NETWORK` distinct
 *   anonymous visitors per network per store per day are counted (the network
 *   is itself a salted hash); a signed-in account is not capped.
 *
 * AND THE COUNTERS ARE EXACT. A mark (store, day, event, product, visitor) is
 * inserted with this request's nonce; in the same batch every counter adds the
 * number of marks carrying THAT nonce — 1 if this request created the mark, 0
 * if it already existed. So a counter always equals the count of distinct
 * marks, whatever the retries and races.
 */

import { sha256Hex } from './crypto';
import { addDays } from './baghdadTime';

export const STOREFRONT_EVENTS = ['store_view', 'product_view', 'add_to_cart', 'checkout_started'] as const;
export type StorefrontEvent = (typeof STOREFRONT_EVENTS)[number];
export const PRODUCT_EVENTS: ReadonlySet<StorefrontEvent> = new Set(['product_view', 'add_to_cart']);

export type TrafficSource = 'direct' | 'search' | 'social' | 'other';

/** Distinct anonymous visitors one network may add to one store in one day. */
export const ANON_VISITORS_PER_NETWORK = 50;

// ------------------------------------------------------------------- bots

/**
 * Crawlers, link previewers, monitors, headless browsers and HTTP clients.
 * In-app browsers (Facebook's FBAN, Instagram, TikTok, WhatsApp's own
 * webview) are people and are NOT matched: the WhatsApp token is matched only
 * as the previewer's `WhatsApp/2.x` product token at the start of the string.
 */
const BOT_RE =
  /bot\/|bot;|crawl|spider|slurp|mediapartners|facebookexternalhit|facebot|embedly|preview|vkshare|w3c_validator|telegrambot|discordbot|skypeuripreview|slackbot|linkedinbot|twitterbot|applebot|yandex|baiduspider|petalbot|headless|phantomjs|selenium|puppeteer|playwright|lighthouse|pagespeed|gtmetrix|pingdom|uptime|statuscake|curl\/|wget\/|python-|python\/|aiohttp|httpx|go-http-client|java\/|okhttp|node-fetch|axios\/|undici|libwww|scrapy|httpclient|postmanruntime|insomnia/i;

export function isBotUserAgent(ua: string | null | undefined): boolean {
  const s = String(ua ?? '').trim();
  if (s.length < 12) return true;
  if (/^whatsapp\//i.test(s)) return true;
  return BOT_RE.test(s);
}

// --------------------------------------------------------------- referrer

const SEARCH = [
  'google.', 'bing.com', 'yahoo.', 'duckduckgo.com', 'yandex.', 'baidu.com', 'ecosia.org',
  'search.brave.com', 'startpage.com', 'qwant.com', 'naver.com',
];
const SOCIAL = [
  'facebook.com', 'fb.com', 'fb.me', 'instagram.com', 't.co', 'twitter.com', 'x.com', 'tiktok.com',
  'snapchat.com', 'youtube.com', 'youtu.be', 't.me', 'telegram.org', 'telegram.me', 'whatsapp.com',
  'wa.me', 'linkedin.com', 'lnkd.in', 'pinterest.com', 'reddit.com', 'threads.net', 'messenger.com',
];

/** Does `host` equal `domain` or sit under it, on a label boundary? */
function under(host: string, domain: string): boolean {
  if (domain.endsWith('.')) {
    // 'google.' — any public suffix: google.com, google.iq, www.google.co.uk
    const label = domain.slice(0, -1);
    return host === label || host.startsWith(`${label}.`) || host.includes(`.${label}.`);
  }
  return host === domain || host.endsWith(`.${domain}`);
}

/** Only the HOST of a referrer is ever looked at; anything else is refused. */
export function cleanReferrerHost(raw: unknown): string {
  const s = String(raw ?? '').trim().toLowerCase().replace(/^www\./, '');
  return /^[a-z0-9.-]{1,253}$/.test(s) && s.includes('.') ? s : '';
}

/**
 * Where a visit came from, coarse: no referrer or the store itself = direct;
 * a search engine; a social network or messenger; anything else (the
 * platform's own pages included) = other.
 */
export function classifyReferrer(rawHost: unknown, storeHost = ''): TrafficSource {
  const host = cleanReferrerHost(rawHost);
  if (!host) return 'direct';
  const own = cleanReferrerHost(storeHost);
  if (own && host === own) return 'direct';
  if (SEARCH.some((d) => under(host, d))) return 'search';
  if (SOCIAL.some((d) => under(host, d))) return 'social';
  return 'other';
}

// --------------------------------------------------------- visitor hashing

/** An anonymous first-party id as the page keeps it: 16–64 url-safe characters. */
export function cleanAnonId(raw: unknown): string {
  const s = String(raw ?? '');
  return /^[A-Za-z0-9_-]{16,64}$/.test(s) ? s : '';
}

/** The day's salt, created by the first request that needs it. */
export async function dailySalt(db: D1Database, day: string): Promise<string> {
  const fresh = crypto.getRandomValues(new Uint8Array(24));
  const salt = Array.from(fresh, (b) => b.toString(16).padStart(2, '0')).join('');
  await db.prepare('INSERT OR IGNORE INTO storefront_salts (day, salt) VALUES (?, ?)').bind(day, salt).run();
  const row = await db.prepare('SELECT salt FROM storefront_salts WHERE day = ?').bind(day).first<{ salt: string }>();
  return row?.salt ?? salt;
}

/** 128 bits of SHA-256: collisions inside one store's day are not a concern. */
export async function saltedHash(salt: string, ...parts: string[]): Promise<string> {
  return (await sha256Hex([salt, ...parts].join('\n'))).slice(0, 32);
}

// ------------------------------------------------------------- recording

export interface RecordInput {
  storeId: string;
  day: string;
  event: StorefrontEvent;
  /** '' for store-level events. */
  productId: string;
  visitor: string;
  /** Salted network hash for an ANONYMOUS visitor; '' for a signed-in one (not capped). */
  net: string;
  source: TrafficSource;
  nonce: string;
}

const MARKED_BY_NONCE = (event: string) =>
  `(SELECT COUNT(*) FROM storefront_event_marks
     WHERE store_id = ?1 AND day = ?2 AND event = ${event} AND product_id = ${event === "'visit'" ? "''" : '?8'}
       AND visitor = ?3 AND nonce = ?4)`;

/**
 * The statements that record one event: the marks, then every counter by the
 * marks THIS nonce created. One batch — all or nothing.
 */
export function recordStatements(db: D1Database, r: RecordInput): D1PreparedStatement[] {
  const params = [r.storeId, r.day, r.visitor, r.nonce, r.net, ANON_VISITORS_PER_NETWORK, r.event, r.productId, r.source];
  // Numbered parameters: a statement takes exactly as many values as its
  // highest `?n` (D1 and SQLite refuse a surplus).
  const b = (sql: string) => {
    const highest = Math.max(...[...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1])));
    return db.prepare(sql).bind(...params.slice(0, highest));
  };
  const visitNew = MARKED_BY_NONCE("'visit'");
  const eventNew = MARKED_BY_NONCE('?7');
  const stmts = [
    // The visitor's first event of the day in this store — capped per network
    // for anonymous visitors.
    b(`INSERT OR IGNORE INTO storefront_event_marks (store_id, day, event, product_id, visitor, nonce, net)
       SELECT ?1, ?2, 'visit', '', ?3, ?4, ?5
        WHERE ?5 = ''
           OR (SELECT COUNT(*) FROM storefront_event_marks
                WHERE store_id = ?1 AND day = ?2 AND event = 'visit' AND net = ?5) < ?6`),
    // The event itself, only for a visitor who is counted today.
    b(`INSERT OR IGNORE INTO storefront_event_marks (store_id, day, event, product_id, visitor, nonce, net)
       SELECT ?1, ?2, ?7, ?8, ?3, ?4, ?5
        WHERE EXISTS (SELECT 1 FROM storefront_event_marks
                       WHERE store_id = ?1 AND day = ?2 AND event = 'visit' AND product_id = '' AND visitor = ?3)`),
    b(`INSERT INTO merchant_store_analytics_daily
         (store_id, day, visitors, source_direct, source_search, source_social, source_other,
          store_views, product_views, add_to_cart, checkout_started)
       SELECT ?1, ?2, v.n,
              CASE WHEN ?9 = 'direct' THEN v.n ELSE 0 END,
              CASE WHEN ?9 = 'search' THEN v.n ELSE 0 END,
              CASE WHEN ?9 = 'social' THEN v.n ELSE 0 END,
              CASE WHEN ?9 = 'other' THEN v.n ELSE 0 END,
              CASE WHEN ?7 = 'store_view' THEN e.n ELSE 0 END,
              CASE WHEN ?7 = 'product_view' THEN e.n ELSE 0 END,
              CASE WHEN ?7 = 'add_to_cart' THEN e.n ELSE 0 END,
              CASE WHEN ?7 = 'checkout_started' THEN e.n ELSE 0 END
         FROM (SELECT ${visitNew} AS n) v, (SELECT ${eventNew} AS n) e
        WHERE v.n + e.n > 0
       ON CONFLICT (store_id, day) DO UPDATE SET
         visitors = visitors + excluded.visitors,
         source_direct = source_direct + excluded.source_direct,
         source_search = source_search + excluded.source_search,
         source_social = source_social + excluded.source_social,
         source_other = source_other + excluded.source_other,
         store_views = store_views + excluded.store_views,
         product_views = product_views + excluded.product_views,
         add_to_cart = add_to_cart + excluded.add_to_cart,
         checkout_started = checkout_started + excluded.checkout_started`),
  ];
  if (r.productId && PRODUCT_EVENTS.has(r.event)) {
    stmts.push(
      b(`INSERT INTO merchant_product_analytics_daily (store_id, product_id, day, views, add_to_cart)
         SELECT ?1, ?8, ?2,
                CASE WHEN ?7 = 'product_view' THEN e.n ELSE 0 END,
                CASE WHEN ?7 = 'add_to_cart' THEN e.n ELSE 0 END
           FROM (SELECT ${eventNew} AS n) e
          WHERE e.n > 0
         ON CONFLICT (product_id, day) DO UPDATE SET
           views = views + excluded.views,
           add_to_cart = add_to_cart + excluded.add_to_cart`)
    );
    if (r.event === 'product_view') {
      // The lifetime figure the product list, sort-by-views and insights read:
      // the sum of the same deduped daily views, no longer a raw GET count.
      stmts.push(
        b(`UPDATE community_products SET view_count = view_count + 1
            WHERE id = ?8 AND store_id = ?1 AND ?7 = 'product_view' AND ${eventNew} > 0`)
      );
    }
  }
  return stmts;
}

/** Records one event. Returns whether it added to any counter. */
export async function recordStorefrontEvent(db: D1Database, r: RecordInput): Promise<boolean> {
  await db.batch(recordStatements(db, r));
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM storefront_event_marks
        WHERE store_id = ? AND day = ? AND visitor = ? AND nonce = ?`
    )
    .bind(r.storeId, r.day, r.visitor, r.nonce)
    .first<{ n: number }>();
  return Number(row?.n ?? 0) > 0;
}

/**
 * The marks and salts whose day is over. A mark is only needed while its day
 * can still receive events, and a salt must not outlive that either — once it
 * is gone, nothing can re-derive a hash from an id.
 */
export async function pruneStorefrontAnalytics(db: D1Database, today: string): Promise<{ marks: number; salts: number }> {
  const keepFrom = addDays(today, -1);
  if (!keepFrom) return { marks: 0, salts: 0 };
  const marks = await db.prepare('DELETE FROM storefront_event_marks WHERE day < ?').bind(keepFrom).run();
  const salts = await db.prepare('DELETE FROM storefront_salts WHERE day < ?').bind(keepFrom).run();
  return { marks: marks.meta?.changes ?? 0, salts: salts.meta?.changes ?? 0 };
}
