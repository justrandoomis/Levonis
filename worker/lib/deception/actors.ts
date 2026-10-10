/**
 * WHO IS ASKING, AND DID THEY MEAN TO (design §3.1, §3.2, §4.2).
 *
 *   account  u:<user id>, when the session is loaded
 *   device   d:<tag id> — the `lv_pref` cookie (an innocuous name on purpose;
 *            documented here as the device tag): `<tagId 16 hex>.<exp
 *            epoch-seconds base36>.<mac 16 hex>`, HMAC-signed, carrying its
 *            own expiry, so enforcing it needs no database. It is set ONLY
 *            when an incident tags the actor — never on ordinary traffic, so
 *            the edge-cache rules and storefront speed are untouched — and
 *            never on a network-only block answer (a CGNAT neighbour would
 *            otherwise inherit a 30-day block). Its first 10 hex are the
 *            incident's reference, so a device-blocked answer can name the
 *            reference with no read.
 *   network  n:<sha256("lv-net|" + net + "|" + Baghdad day)[0:32]> — the exact
 *            IPv4 address or the IPv6 /64, salted by day like security_events'
 *            own hash; never an address, never a /24.
 *
 * THE ANTI-FRAMING RULE (`fetchIntent`). Only a deliberate request counts.
 * Without it an `<img src="/.env">` in a community post would get every
 * viewer blocked. A subresource, a cross-site request or a navigation without
 * user activation is INDUCED: recorded, never scored.
 */
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import type { AppContext, Env, SessionUser } from '../types';
import { isOwner, isUnverifiedOwner } from '../adminScope';
import { baghdadDay } from '../baghdadTime';
import { sha256Hex } from '../crypto';
import { rootDomainFrom, sessionCookieDomain } from '../hosts';
import { probeExempt } from '../securityEvents';
import { hmacHex, randomHex } from './canary';

// ------------------------------------------------------------- intent

export type FetchIntent = 'tool' | 'script' | 'typed' | 'clicked' | 'induced';

/** From the browser's Sec-Fetch-* headers (design §3.2). */
export function fetchIntent(headers: { get(name: string): string | null | undefined }): FetchIntent {
  const site = (headers.get('Sec-Fetch-Site') ?? '').toLowerCase();
  const mode = (headers.get('Sec-Fetch-Mode') ?? '').toLowerCase();
  const dest = (headers.get('Sec-Fetch-Dest') ?? '').toLowerCase();
  const user = headers.get('Sec-Fetch-User') ?? '';
  if (!site && !mode && !dest) return 'tool';
  if (site === 'cross-site') return 'induced';
  if (mode === 'navigate') {
    if (site === 'none') return 'typed';
    if ((site === 'same-origin' || site === 'same-site') && user === '?1') return 'clicked';
    return 'induced';
  }
  if (dest === 'empty' && (site === 'same-origin' || site === 'none' || site === '')) return 'script';
  return 'induced';
}

/** Full weight, partial weight, or none. */
export const intentWeight = (i: FetchIntent): 'full' | 'partial' | 'none' =>
  i === 'induced' ? 'none' : i === 'clicked' ? 'partial' : 'full';

// ------------------------------------------------------------- crawlers

/** Search crawlers and link-preview bots by user agent (a CLAIM: anyone can send it). */
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

/** A crawler by user agent or by Cloudflare's verified-bot signal. */
export function isCrawler(c: Context<AppContext>): boolean {
  const cf = cfOf(c);
  return crawlerClaim(c.req.header('User-Agent')) || !!cf.verifiedBotCategory || cf.botManagement?.verifiedBot === true;
}

// ------------------------------------------------------------- network

/** The exact IPv4 address, or the IPv6 /64 — never a /24 (a CGNAT address is already shared). */
export function exactNetwork(ip: string): string {
  const v = ip.trim().toLowerCase();
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(v)) return v;
  if (!v.includes(':')) return '';
  const [head = '', tail] = v.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = tail === undefined ? [] : Array(Math.max(0, 8 - h.length - t.length)).fill('0');
  const full = [...h, ...fill, ...t];
  if (full.length < 4 || full.slice(0, 4).some((x) => !/^[0-9a-f]{1,4}$/.test(x))) return '';
  return `${full.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/** The network's actor key for one Baghdad day (32 hex). */
export async function networkKeyFor(ip: string, nowMs: number, offsetDays = 0): Promise<string> {
  const net = exactNetwork(ip);
  if (!net) return '';
  return (await sha256Hex(`lv-net|${net}|${baghdadDay(nowMs, offsetDays)}`)).slice(0, 32);
}

/** Today's and yesterday's keys — a 24-hour block survives midnight. */
export async function networkKeys(ip: string, nowMs: number): Promise<string[]> {
  const today = await networkKeyFor(ip, nowMs);
  if (!today) return [];
  return [today, await networkKeyFor(ip, nowMs, -1)];
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

const tagMac = async (env: Pick<Env, 'SECURITY_CANARY_KEY'>, tagId: string, exp36: string) =>
  (await hmacHex(env, `lv-tag|${tagId}|${exp36}`)).slice(0, 16);

/** A new tag for an incident whose reference is `refHex` (the tag's first 10 hex). */
export async function mintTag(env: Pick<Env, 'SECURITY_CANARY_KEY'>, refHex: string, nowMs: number): Promise<DeviceTag & { value: string }> {
  const tagId = `${refHex.slice(0, 10)}${randomHex(3)}`;
  const exp = Math.floor(nowMs / 1000) + TAG_DAYS * 86_400;
  const exp36 = exp.toString(36);
  return { tagId, exp, value: `${tagId}.${exp36}.${await tagMac(env, tagId, exp36)}` };
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
    if ((await tagMac(c.env, m[1]!, m[2]!)) !== m[3]) return null;
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
 * confirmed canary; a registered probe account is exempt.
 */
export function exemptionOf(env: Env, user: SessionUser | null | undefined): Exemption {
  if (!user) return null;
  if (user.role === 'admin' && isOwner(env, user) && !isUnverifiedOwner(env, user)) return 'owner';
  if (user.role === 'admin') return 'admin';
  if (probeExempt(env, user)) return 'probe';
  return null;
}
