/**
 * WHO IS ASKING, AND COULD SOMEONE ELSE HAVE MADE THEIR BROWSER ASK
 * (design §3.1, §3.2, §4.2 and §F1).
 *
 *   account  u:<user id>, when the session is loaded
 *   device   d:<tag id> — the `lv_pref` cookie (an innocuous name on purpose;
 *            documented here as the device tag): `<tagId 16 hex>.<exp
 *            epoch-seconds base36>.<mac 16 hex>`, HMAC-signed, carrying its
 *            own expiry, so enforcing it needs no database. It is set ONLY on
 *            a block answer (an incident, or an account-blocked answer to a
 *            new browser) — never on ordinary traffic and never on a decoy's
 *            deceiving answer. Its first 10 hex are the incident's reference.
 *   network  n:<HMAC(K, "lv-net|" + net + "|" + Baghdad day)[0:32]> — the
 *            exact IPv4 address or the IPv6 /64 (and, for an IPv6 /48 that
 *            exhausted its budget, the /48), keyed by the deception secret so a
 *            database reader cannot enumerate it back to an address.
 *
 * THE ANTI-FRAMING RULE. Evidence counts at full weight only where nobody
 * else could have put it: a REQUEST WITHOUT ANY Sec-Fetch-* HEADER (a tool —
 * every current browser sends them), or a canary in a header, a cookie or the
 * sign-in body. Anything a link can carry — a decoy opened by a navigation,
 * a canary in a URL the app echoed into its own fetch, an injection-shaped
 * query — is LINKABLE: it scores, but a linkable score alone never reaches
 * the threshold (./signals.ts LINKABLE_CAP). A subresource, a frame, a
 * cross-site fetch or a navigation without a click is INDUCED: recorded only.
 * Forged or partial Sec-Fetch-* headers are a tool's: a browser always sends
 * Site, Mode and Dest together, with values it knows.
 */
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import type { AppContext, Env, SessionUser } from '../types';
import { isOwner, isUnverifiedOwner } from '../adminScope';
import { baghdadDay } from '../baghdadTime';
import { sha256Hex } from '../crypto';
import { rootDomainFrom, sessionCookieDomain } from '../hosts';
import { probeExempt } from '../securityEvents';
import { hmacHex, keySource, randomHex, type KeyEnv } from './canary';

// ------------------------------------------------------------- intent

export type FetchIntent = 'tool' | 'script' | 'typed' | 'clicked' | 'induced';

const SITES = new Set(['none', 'same-origin', 'same-site', 'cross-site']);
const MODES = new Set(['cors', 'navigate', 'no-cors', 'same-origin', 'websocket', 'nested-navigate']);
const DESTS = new Set([
  'audio', 'audioworklet', 'document', 'embed', 'empty', 'font', 'frame', 'iframe', 'image', 'json', 'manifest', 'object',
  'paintworklet', 'report', 'script', 'serviceworker', 'sharedworker', 'style', 'track', 'video', 'webidentity', 'worker', 'xslt',
]);

/**
 * From the browser's Sec-Fetch-* headers (design §3.2, §F1):
 *   tool     none of them, or a set no browser sends (partial, unknown values,
 *            a user flag off a navigation, a cross-site JSON write)
 *   typed    a top-level navigation the browser started itself (address bar,
 *            bookmark, a link opened from another app)
 *   clicked  a top-level navigation the visitor clicked, from any site
 *   script   this site's own fetch
 *   induced  a subresource, a frame, a cross-site fetch, or a navigation
 *            without a click — what a page can make a visitor's browser send
 */
export function fetchIntent(headers: { get(name: string): string | null | undefined }, method = 'GET'): FetchIntent {
  const site = (headers.get('Sec-Fetch-Site') ?? '').toLowerCase();
  const mode = (headers.get('Sec-Fetch-Mode') ?? '').toLowerCase();
  const dest = (headers.get('Sec-Fetch-Dest') ?? '').toLowerCase();
  const user = headers.get('Sec-Fetch-User') ?? '';
  if (!site && !mode && !dest && !user) return 'tool';
  if (!SITES.has(site) || !MODES.has(mode) || !DESTS.has(dest)) return 'tool';
  if (user && (user !== '?1' || (mode !== 'navigate' && mode !== 'nested-navigate'))) return 'tool';
  if (mode === 'navigate' || mode === 'nested-navigate') {
    if (dest !== 'document' || mode === 'nested-navigate') return 'induced';
    if (site === 'none') return 'typed';
    return user === '?1' ? 'clicked' : 'induced';
  }
  if (site === 'same-origin' || site === 'none') {
    if ((mode === 'cors' || mode === 'same-origin' || mode === 'websocket') && dest === 'empty') return 'script';
    return 'induced';
  }
  // Cross-site or same-site and not a navigation: a page elsewhere made it,
  // unless it is a write no page can send without a preflight this site never grants.
  const m = method.toUpperCase();
  const type = (headers.get('Content-Type') ?? '').toLowerCase();
  if (!['GET', 'HEAD', 'POST'].includes(m) || (m === 'POST' && type && !/^(text\/plain|application\/x-www-form-urlencoded|multipart\/form-data)\b/.test(type))) return 'tool';
  return 'induced';
}

/** How much a piece of evidence weighs (design §F1). */
export type EvidenceClass = 'hard' | 'linkable' | 'induced';

/** Evidence carried by the URL (a decoy path, a query canary, an injection or tamper shape, an id). */
export function urlEvidence(intent: FetchIntent, claimsCrawler: boolean): EvidenceClass {
  if (intent === 'induced') return 'induced';
  // A crawler follows links anyone can plant; a browser opens them.
  return intent === 'tool' && !claimsCrawler ? 'hard' : 'linkable';
}

// ------------------------------------------------------------- crawlers

/** Search crawlers and link-preview bots by user agent — a CLAIM anyone can send: never an exemption. */
const CRAWLER_UA =
  /googlebot|bingbot|duckduckbot|yandex(?:bot)?|baiduspider|applebot|facebookexternalhit|twitterbot|telegrambot|whatsapp|linkedinbot|slackbot|discordbot|petalbot|ahrefsbot|semrushbot/i;

export function crawlerClaim(ua: string | null | undefined): boolean {
  return !!ua && CRAWLER_UA.test(ua);
}

type CfBits = { verifiedBotCategory?: string; botManagement?: { verifiedBot?: boolean }; country?: string; asn?: number };
export function cfOf(c: Context<AppContext>): CfBits {
  try {
    return ((c.req.raw as Request & { cf?: CfBits }).cf ?? {}) as CfBits;
  } catch {
    return {};
  }
}

/** A crawler Cloudflare verified — the only kind that is exempt (a user agent alone is a claim). */
export function verifiedCrawler(c: Context<AppContext>): boolean {
  const cf = cfOf(c);
  return !!cf.verifiedBotCategory || cf.botManagement?.verifiedBot === true;
}

/** The user agent claims a crawler or a preview bot (Cloudflare did not verify it). */
export const claimsCrawler = (c: Context<AppContext>) => !verifiedCrawler(c) && crawlerClaim(c.req.header('User-Agent'));

// ------------------------------------------------------------- network

/** The exact IPv4 address, or the IPv6 /64 — never a /24 (a CGNAT address is already shared). */
export function exactNetwork(ip: string): string {
  const v = ip.trim().toLowerCase();
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(v)) return v;
  return v6Prefix(v, 4);
}

/** The prefix whose incidents share one write budget: the IPv4 /24, the IPv6 /48. */
export function prefixNetwork(ip: string): string {
  const v = ip.trim().toLowerCase();
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(v);
  if (m) return `${m[1]}.${m[2]}.${m[3]}.0/24`;
  return v6Prefix(v, 3);
}

function v6Prefix(v: string, groups: 3 | 4): string {
  if (!v.includes(':')) return '';
  const [head = '', tail] = v.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = tail === undefined ? [] : Array(Math.max(0, 8 - h.length - t.length)).fill('0');
  const full = [...h, ...fill, ...t];
  if (full.length < groups || full.slice(0, groups).some((x) => !/^[0-9a-f]{1,4}$/.test(x))) return '';
  return `${full.slice(0, groups).map((x) => x.replace(/^0+(?=.)/, '')).join(':')}::/${groups * 16}`;
}

/** A network's actor key for one Baghdad day (32 hex): keyed by the deception secret when there is one. */
export async function keyForNet(env: KeyEnv | undefined, net: string, nowMs: number, offsetDays = 0): Promise<string> {
  if (!net) return '';
  const msg = `lv-net|${net}|${baghdadDay(nowMs, offsetDays)}`;
  const mac = await hmacHex(env, msg);
  return (mac ?? (await sha256Hex(msg))).slice(0, 32);
}

/** The address's own network key (exact IPv4, IPv6 /64) for one Baghdad day. */
export async function networkKeyFor(env: KeyEnv | undefined, ip: string, nowMs: number, offsetDays = 0): Promise<string> {
  return keyForNet(env, exactNetwork(ip), nowMs, offsetDays);
}

/** Every key a block on this address may sit under: its network today and yesterday, and for IPv6 its /48 too. */
export async function networkKeys(env: KeyEnv | undefined, ip: string, nowMs: number): Promise<string[]> {
  const exact = exactNetwork(ip);
  if (!exact) return [];
  const out = [await keyForNet(env, exact, nowMs), await keyForNet(env, exact, nowMs, -1)];
  if (exact.includes(':')) {
    const wide = prefixNetwork(ip);
    if (wide) out.push(await keyForNet(env, wide, nowMs), await keyForNet(env, wide, nowMs, -1));
  }
  return out;
}

export const clientIp = (c: Context<AppContext>) => c.req.header('CF-Connecting-IP') ?? '';

// ------------------------------------------------------------- references

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 10 hex (40 bits) → 'LV-' + 8 Crockford base32. */
export function referenceOf(hex10: string): string {
  let n = BigInt(`0x${hex10.slice(0, 10).padStart(10, '0')}`);
  let s = '';
  for (let i = 0; i < 8; i++) {
    s = CROCKFORD[Number(n & 31n)] + s;
    n >>= 5n;
  }
  return `LV-${s}`;
}

/** 'LV-' + 8 Crockford → its 10 hex, or null. */
export function referenceHex(ref: string): string | null {
  const m = /^LV-([0-9A-HJKMNP-TV-Z]{8})$/.exec(ref);
  if (!m) return null;
  let n = 0n;
  for (const ch of m[1]!) n = n * 32n + BigInt(CROCKFORD.indexOf(ch));
  return n.toString(16).padStart(10, '0');
}

export const newReferenceHex = () => randomHex(5);

// ------------------------------------------------------------- the device tag

export const TAG_COOKIE = 'lv_pref';
export const TAG_DAYS = 30;

export interface DeviceTag {
  tagId: string;
  /** Epoch seconds. */
  exp: number;
}

const tagMac = async (env: KeyEnv | undefined, tagId: string, exp36: string) => (await hmacHex(env, `lv-tag|${tagId}|${exp36}`))?.slice(0, 16) ?? null;

/**
 * A new tag for an incident whose reference is `refHex` (the tag's first 10
 * hex), expiring after TAG_DAYS or at `expSec` (an account block's own end).
 * Null without a key: no tag can be minted that anyone could not forge.
 */
export async function mintTag(env: KeyEnv | undefined, refHex: string, nowMs: number, expSec?: number): Promise<(DeviceTag & { value: string }) | null> {
  if (!keySource(env)) return null;
  const tagId = `${refHex.slice(0, 10)}${randomHex(3)}`;
  const exp = expSec ?? Math.floor(nowMs / 1000) + TAG_DAYS * 86_400;
  const exp36 = exp.toString(36);
  const mac = await tagMac(env, tagId, exp36);
  return mac ? { tagId, exp, value: `${tagId}.${exp36}.${mac}` } : null;
}

/** The request's tag when it is well-formed, signed and unexpired; null otherwise (a forged or expired tag is no tag). */
export async function readTag(c: Context<AppContext>, nowMs: number): Promise<DeviceTag | null> {
  try {
    const raw = getCookie(c, TAG_COOKIE);
    if (!raw) return null;
    const m = /^([0-9a-f]{16})\.([0-9a-z]{1,10})\.([0-9a-f]{16})$/.exec(raw);
    if (!m) return null;
    const exp = parseInt(m[2]!, 36);
    if (!Number.isFinite(exp) || exp * 1000 <= nowMs) return null;
    const mac = await tagMac(c.env, m[1]!, m[2]!);
    if (!mac || mac !== m[3]) return null;
    return { tagId: m[1]!, exp };
  } catch {
    return null;
  }
}

/** The incident reference a tag carries. */
export const tagReference = (tagId: string) => referenceOf(tagId.slice(0, 10));

function cookieAttrs(c: Context<AppContext>) {
  const domain = sessionCookieDomain(c.req.header('Host'), rootDomainFrom(c.env));
  return { httpOnly: true, secure: true, sameSite: 'Lax' as const, path: '/', ...(domain ? { domain } : {}) };
}

/** The Set-Cookie line for a tag, for a response that was already built. */
export function tagCookieLine(c: Context<AppContext>, tag: DeviceTag & { value: string }, nowMs: number): string {
  const a = cookieAttrs(c);
  const maxAge = Math.max(60, tag.exp - Math.floor(nowMs / 1000));
  return `${TAG_COOKIE}=${tag.value}; Max-Age=${maxAge}; Path=/${a.domain ? `; Domain=${a.domain}` : ''}; HttpOnly; Secure; SameSite=Lax`;
}

/** The Set-Cookie line that removes the tag (a lifted one), with the attributes it was set with. */
export function tagDeleteLine(c: Context<AppContext>): string {
  const a = cookieAttrs(c);
  return `${TAG_COOKIE}=; Max-Age=0; Path=/${a.domain ? `; Domain=${a.domain}` : ''}; HttpOnly; Secure; SameSite=Lax`;
}

// ------------------------------------------------------------- exemptions

export type Exemption = 'owner' | 'admin' | 'probe' | null;

/**
 * The verified owner is never blocked (and the database refuses an owner row);
 * any other admin — the unverified owner row included — is blocked only by a
 * confirmed canary in a place no link reaches; a registered probe account is
 * exempt. The unverified owner row stays an admin here on purpose: the address
 * alone is not the owner (an admin row can carry it before it is proven), and
 * a block never shuts the way out — /api/auth/* (the e-mail proof among it)
 * stays open under every block, and the proven owner is exempt at once.
 */
export function exemptionOf(env: Env, user: SessionUser | null | undefined): Exemption {
  if (!user) return null;
  if (user.role === 'admin' && isOwner(env, user) && !isUnverifiedOwner(env, user)) return 'owner';
  if (user.role === 'admin') return 'admin';
  if (probeExempt(env, user)) return 'probe';
  return null;
}
