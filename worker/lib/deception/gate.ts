/**
 * THE DECEPTION GATE (design §4.3, §F1) — registered in worker/index.ts right
 * after the session loader and before every route, followed at once by the
 * decoy router. On every Worker request but the static ones:
 *
 *   1. CANARY USE. Trap data from a decoy answer, presented anywhere a key, a
 *      credential or an id can be: the sign-in doors' body (whatever its
 *      content type or size), any request header, any cookie, the cart and
 *      checkout bodies, the URL. Where it was presented decides what it is
 *      worth (./actors.ts, the anti-framing rule):
 *        a header, a cookie, the sign-in body, or anything from a tool
 *            → the block AT ONCE: the moment the attacker learns he was caught
 *        a URL a browser opened or the app echoed, a body the app sent
 *            → LINKABLE: anyone can plant a link — recorded and scored, never
 *              a block on its own
 *        an image, a frame, a cross-site fetch → recorded only
 *   2. THE BLOCK CHECK, in memory: a valid unlifted device tag, a blocked
 *      account, or a blocked network — the last for TOOLS only (requests with
 *      no browser Sec-Fetch-* headers): a carrier's shared address must not
 *      lock out every phone behind it for one subscriber's scan, and a browser
 *      is held by its own tag and account. A tool signed in to an account made
 *      after the network was blocked is the network's. The verified owner is
 *      never blocked; /api/auth/* stays reachable under every block (signing
 *      in, proving an address, resetting a password, signing out).
 *   3. THE ROUTE runs.
 *   4. OBSERVATION, after the answer and never changing it — except to add the
 *      tag cookie when a score crossed the threshold: client-sent price fields,
 *      injection shapes, tamper switches, sign-in brute force, admin probing,
 *      other people's records. Linkable signals raise a score to 99 at most.
 *
 * FAIL-OPEN, ALWAYS. A missing table, a D1 error, anything — the request goes
 * through unchanged; this layer never produces a 5xx. On an ordinary request
 * with a warm snapshot it issues NO D1 statement.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { matchedRoutes } from 'hono/route';
import type { AppContext, SessionUser } from '../types';
import { SESSION_COOKIE_NAME, hasSessionCookie } from '../session';
import { rateLimitedBucket } from '../ratelimit';
import { recordSecurityEvent, routePatternOf, type SecurityDetail } from '../securityEvents';
import { sha256Hex } from '../crypto';
import { robotsAllows } from '../../routes/seo';
import { canaryScan, keySource, type CanaryWhere, type FoundCanary } from './canary';
import {
  TAG_COOKIE,
  claimsCrawler,
  clientIp,
  exemptionOf,
  fetchIntent,
  mintTag,
  networkKeyFor,
  networkKeys,
  readTag,
  referenceHex,
  tagCookieLine,
  tagDeleteLine,
  tagReference,
  urlEvidence,
  verifiedCrawler,
  type DeviceTag,
  type EvidenceClass,
  type Exemption,
  type FetchIntent,
} from './actors';
import { NETWORK_BLOCK_HOURS, NETWORK_SCORE_BLOCK_HOURS, countHit, openIncident, ringOwnerDeception, scheduleRefresh, settle, snapshotFor, warmForTag, type Snapshot } from './blocks';
import { ALWAYS_LINKABLE, LINKABLE_CAP, THRESHOLD, WEIGHTS, authBucket, bumpScore, idorPath, injectionIn, priceFieldsIn, tamperParams, watchedBody, type SignalCode } from './signals';
import { blockedResponse } from './strings';
import { decoyFor } from './decoys';

/** Never checked: the static and machine paths (no person behind them to block, and speed matters). */
const SKIP_EXACT = new Set(['/manifest.webmanifest', '/robots.txt', '/sitemap.xml', '/api/health']);
const SKIP_PREFIX = ['/files/', '/store-icon/'];
export const skipsGate = (path: string) => SKIP_EXACT.has(path) || SKIP_PREFIX.some((p) => path.startsWith(p));

/** Server-to-server doors: never a network block (a webhook's or Studio's egress address is shared). */
const SERVER_TO_SERVER = ['/api/telegram/', '/api/studio/'];
const serverToServer = (path: string) => SERVER_TO_SERVER.some((p) => path.startsWith(p));

/** Where no block reaches: signing in, proving an address, resetting a password and signing out must stay possible. */
export const signInPath = (path: string) => path === '/api/auth' || path.startsWith('/api/auth/') || path === '/api/settings/public';

/** The sign-in doors whose body is read for canary credentials. */
const CREDENTIAL_DOORS = new Set(['/api/auth/login', '/api/auth/otp/start', '/api/auth/forgot-password', '/api/auth/register']);
const CREDENTIAL_FIELDS = ['identifier', 'email', 'password', 'destination', 'username'];

/** Headers a browser sets on its own, from wherever it was sent: a link puts a canary there, the visitor does not. */
const NOT_SCANNED_HEADERS = new Set(['cookie', 'referer', 'origin']);
const MAX_SCANNED_HEADERS = 48;

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const isoMs = (v: unknown) => Date.parse(typeof v === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(v) ? `${v.replace(' ', 'T')}Z` : String(v ?? ''));

interface GateState {
  user: SessionUser | null;
  sessionLoaded: boolean;
  exemption: Exemption;
  intent: FetchIntent;
  /** The user agent claims a crawler that Cloudflare did not verify. */
  crawlerClaim: boolean;
  tag: DeviceTag | null;
  nowMs: number;
  /** An incident already opened on this request (no second one from its signals). */
  incident: boolean;
  body?: { text: string; json: Record<string, unknown> | null };
  deleteTag?: boolean;
}

/**
 * The body of a sign-in door or a watched cart / checkout request: read once
 * as text (Hono caches it, so the route's own `c.req.json()` parses the same
 * bytes), whatever its content type or length — the route reads it all
 * anyway, so a padded or mislabelled body hides nothing.
 */
async function bodyOf(c: Context<AppContext>, s: GateState): Promise<{ text: string; json: Record<string, unknown> | null }> {
  if (s.body) return s.body;
  let text = '';
  try {
    text = await c.req.text();
  } catch {
    text = '';
  }
  let json: Record<string, unknown> | null = null;
  try {
    const v: unknown = text ? JSON.parse(text) : null;
    json = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    json = null;
  }
  s.body = { text, json };
  return s.body;
}

/** The user behind a session cookie on a path that skips the loader — only on the rare paths that need it. */
async function peekSessionUser(c: Context<AppContext>): Promise<SessionUser | null> {
  try {
    const token = getCookie(c, SESSION_COOKIE_NAME);
    if (!token) return null;
    const row = await c.env.DB.prepare(
      `SELECT u.id, u.email, u.role, u.admin_scope, u.email_verified_at, u.created_at FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = ? AND s.expires_at > ?`
    )
      .bind(await sha256Hex(token), new Date().toISOString())
      .first<SessionUser>();
    return row ?? null;
  } catch {
    return null;
  }
}

/** The account behind this request: the loaded session, else (session-free paths) a peek — a cookie no session backs is no account. */
async function accountOf(c: Context<AppContext>, s: GateState): Promise<SessionUser | null> {
  if (s.sessionLoaded) return s.user;
  if (!hasSessionCookie(c.req.header('Cookie'))) return null;
  return peekSessionUser(c);
}

function withCookie(res: Response, line: string): Response {
  try {
    res.headers.append('Set-Cookie', line);
    return res;
  } catch {
    const copy = new Response(res.body, res);
    copy.headers.append('Set-Cookie', line);
    return copy;
  }
}

const event = (
  c: Context<AppContext>,
  s: GateState,
  kind: 'enumeration_suspected' | 'private_input_dropped' | 'rate_limited' | 'idor_suspected',
  code: string,
  status: number,
  detail: SecurityDetail
) => recordSecurityEvent(c, { kind, code, status, detail: { intent: s.intent, ...detail } }, { target: false });

// ------------------------------------------------------------- 1. canaries

async function canaryTexts(c: Context<AppContext>, s: GateState): Promise<Array<readonly [string, CanaryWhere]>> {
  const texts: Array<readonly [string, CanaryWhere]> = [];
  const method = c.req.method.toUpperCase();
  if (method === 'POST' && CREDENTIAL_DOORS.has(c.req.path)) {
    const body = await bodyOf(c, s);
    if (body.json) for (const f of CREDENTIAL_FIELDS) if (typeof body.json[f] === 'string') texts.push([String(body.json[f]).slice(0, 320), 'credentials']);
    texts.push([body.text.slice(0, 65_536), 'credentials']);
  }
  let n = 0;
  c.req.raw.headers.forEach((value, name) => {
    if (n >= MAX_SCANNED_HEADERS || NOT_SCANNED_HEADERS.has(name.toLowerCase())) return;
    n += 1;
    if (value) texts.push([value.slice(0, 4096), 'header']);
  });
  const cookie = c.req.header('Cookie');
  if (cookie) for (const part of cookie.split(';').slice(0, 48)) texts.push([safeDecode(part.trim()).slice(0, 4096), 'cookie']);
  if (watchedBody(method, c.req.path)) {
    const body = await bodyOf(c, s);
    if (body.json && typeof body.json.productId === 'string') texts.push([body.json.productId.slice(0, 64), 'body']);
  }
  const url = new URL(c.req.url);
  texts.push([safeDecode(`${url.pathname}${url.search}`), 'url']);
  return texts;
}

/** What evidence found in this place is worth, given how the request was made (./actors.ts). */
function placeClass(where: CanaryWhere, s: GateState): EvidenceClass {
  if (where === 'header' || where === 'cookie') return 'hard';
  if (where === 'credentials') return s.intent === 'induced' ? 'induced' : 'hard';
  if (where === 'body') return s.intent === 'tool' ? 'hard' : s.intent === 'induced' ? 'induced' : 'linkable';
  return urlEvidence(s.intent, s.crawlerClaim);
}

const RANK: Record<EvidenceClass, number> = { hard: 0, linkable: 1, induced: 2 };

interface BatchRow {
  batch_id: string;
  decoy: string;
  incident_id: string | null;
}

async function batchRow(db: D1Database, batch: string): Promise<BatchRow | null> {
  try {
    return await db.prepare('SELECT batch_id, decoy, incident_id FROM security_canaries WHERE batch_id = ?').bind(batch).first<BatchRow>();
  } catch {
    return null;
  }
}

/** A score crossing on the canary path answers with the block at once; otherwise the request goes on. */
function crossingAnswer(c: Context<AppContext>, s: GateState, crossed: Crossing | null): Response | null {
  if (!crossed) return null;
  const res = blockedResponse(c, crossed.reference, !s.user);
  return crossed.line ? withCookie(res, crossed.line) : res;
}

/** Canaries presented (or canary-shaped junk past the check): confirm, record, and block on hard evidence. Returns the block answer, or nothing. */
async function onCanary(c: Context<AppContext>, s: GateState, found: FoundCanary[], flood: CanaryWhere | null): Promise<Response | null> {
  const db = c.env.DB;
  if (found.length === 0) {
    // More canary-shaped strings than are checked: junk to hide a real one — a probe of the trap itself.
    const cls = flood ? placeClass(flood, s) : 'induced';
    if (cls === 'induced') return null;
    await event(c, s, 'enumeration_suspected', 'CANARY_FLOOD', 200, { sig: 'CANARY_FLOOD' });
    return crossingAnswer(c, s, await score(c, s, [{ code: 'CANARY_FLOOD', weight: WEIGHTS.CANARY_FLOOD, linkable: cls === 'linkable' }], 200));
  }
  // The strongest first: what no link could have put there; a self-confirming kind before a product id.
  const ordered = [...found].sort((a, b) => RANK[placeClass(a.where, s)] - RANK[placeClass(b.where, s)] || (a.kind === 'p' ? 1 : 0) - (b.kind === 'p' ? 1 : 0));
  const first = ordered[0]!;
  const cls = placeClass(first.where, s);
  const row = await batchRow(db, first.batch);
  const confirmed = first.kind !== 'p' || !!row;
  if (row) {
    await settle(c, () =>
      db
        .prepare('UPDATE security_canaries SET first_used_at = COALESCE(first_used_at, ?), use_count = use_count + 1 WHERE batch_id = ?')
        .bind(new Date(s.nowMs).toISOString(), first.batch)
        .run()
    );
  }
  const base: SecurityDetail = { batch: first.batch, sig: 'CANARY_USED' };
  if (row?.decoy) base.decoy = row.decoy;
  if (cls === 'induced') {
    await event(c, s, 'enumeration_suspected', 'CANARY_INDUCED', 200, { ...base, sig: 'CANARY_INDUCED' });
    return null;
  }
  // Who presented it: the loaded session, or (a session-free path) the account behind the cookie — the owner is the owner everywhere.
  const account = await accountOf(c, s);
  const exemption = s.sessionLoaded ? s.exemption : exemptionOf(c.env, account);
  if (exemption === 'probe') return null;
  if (exemption === 'owner') {
    await event(c, s, 'enumeration_suspected', 'CANARY_USED', 200, { ...base, ex: 'owner' });
    await settle(c, () => ringOwnerDeception(c.env, db, 'ownCanary', `own_${first.batch}_${s.nowMs}`, '', s.nowMs));
    return null;
  }
  if (!confirmed) {
    // A product-shaped id with a valid MAC but no batch row: past the daily cap, or chance. Scored, not blocked.
    await event(c, s, 'enumeration_suspected', 'CANARY_UNCONFIRMED', 200, { batch: first.batch, sig: 'CANARY_UNCONFIRMED' });
    return crossingAnswer(c, s, await score(c, s, [{ code: 'CANARY_UNCONFIRMED', weight: WEIGHTS.CANARY_UNCONFIRMED, linkable: cls === 'linkable' }], 200));
  }
  if (cls === 'linkable') {
    // A link anyone could have handed over: counted, never a block on its own.
    await event(c, s, 'enumeration_suspected', 'CANARY_USED', 200, { ...base, ex: 'linked' });
    return crossingAnswer(c, s, await score(c, s, [{ code: 'CANARY_LINKED', weight: WEIGHTS.CANARY_LINKED, linkable: true }], 200));
  }
  if (exemption === 'admin' && !row) {
    await event(c, s, 'enumeration_suspected', 'CANARY_USED', 200, { ...base, ex: 'admin' });
    return null;
  }
  await event(c, s, 'enumeration_suspected', 'CANARY_USED', 403, base);
  const ip = clientIp(c);
  const incident = await openIncident(c, {
    reason: 'canary_used',
    signal: 'CANARY_USED',
    user: account,
    account: !!account,
    network: !account && ip && !serverToServer(c.req.path) ? { ip, hours: NETWORK_BLOCK_HOURS } : null,
    intent: s.intent,
  });
  s.incident = true;
  const res = blockedResponse(c, incident.reference, !account);
  return incident.tag ? withCookie(res, tagCookieLine(c, incident.tag, s.nowMs)) : res;
}

// ------------------------------------------------------------- 2. the block check

/**
 * An account-blocked answer tags the browser it went to, so signing out does
 * not undo the block — statelessly (no row: lifting the account lifts every
 * tag of its incident) and never past the account block's own end.
 */
async function retag(c: Context<AppContext>, res: Response, reference: string, expiresMs: number, nowMs: number): Promise<Response> {
  const hex = referenceHex(reference);
  if (!hex) return res;
  const tag = await mintTag(c.env, hex, nowMs, Math.floor(expiresMs / 1000)).catch(() => null);
  return tag ? withCookie(res, tagCookieLine(c, tag, nowMs)) : res;
}

async function blockCheck(c: Context<AppContext>, s: GateState, snap: Snapshot | null): Promise<Response | null> {
  const path = c.req.path;
  const db = c.env.DB;
  if (signInPath(path)) return null;
  // The device tag: stateless; the snapshot only says whether the owner lifted it (or its incident's account).
  if (s.tag) {
    if (snap) await warmForTag(db, snap, s.nowMs);
    if (snap && (snap.lifted.has(s.tag.tagId) || snap.liftedRefs.has(s.tag.tagId.slice(0, 10)))) {
      s.deleteTag = true;
    } else {
      let exempt = s.exemption === 'owner' || s.exemption === 'probe';
      if (!exempt && !s.sessionLoaded && hasSessionCookie(c.req.header('Cookie'))) {
        const ex = exemptionOf(c.env, await peekSessionUser(c));
        exempt = ex === 'owner' || ex === 'probe';
      }
      if (!exempt) {
        if (snap) countHit(c, db, snap, 'device', s.tag.tagId, s.nowMs);
        return blockedResponse(c, tagReference(s.tag.tagId), !s.user);
      }
    }
  }
  if (!snap) return null;
  // The account.
  if (s.user && s.exemption !== 'owner' && s.exemption !== 'probe') {
    const b = snap.accounts.get(s.user.id);
    if (b && b.expiresMs > s.nowMs) {
      countHit(c, db, snap, 'account', s.user.id, s.nowMs);
      const res = blockedResponse(c, b.reference, false);
      return s.tag ? res : retag(c, res, b.reference, b.expiresMs, s.nowMs);
    }
  }
  // The network: TOOLS only — never a browser on a shared address, never a server-to-server door, never a verified crawler on an allowed path.
  if (snap.networks.size === 0 || s.intent !== 'tool' || serverToServer(path)) return null;
  if (verifiedCrawler(c) && robotsAllows(path, c.get('host')?.kind ?? 'main')) return null;
  for (const key of await networkKeys(c.env, clientIp(c), s.nowMs)) {
    const b = snap.networks.get(key);
    if (!b || b.expiresMs <= s.nowMs) continue;
    const account = await accountOf(c, s);
    if (account) {
      // A signed-in tool passes — unless its account was made after this block: signing up does not escape it.
      const ex = exemptionOf(c.env, account);
      if (ex === 'owner' || ex === 'probe' || ex === 'admin') return null;
      const created = isoMs((account as SessionUser & { created_at?: string }).created_at);
      if (!(created > b.createdMs)) return null;
    }
    countHit(c, db, snap, 'network', key, s.nowMs);
    return blockedResponse(c, b.reference, !account);
  }
  return null;
}

// ------------------------------------------------------------- 4. observation

interface Signal {
  code: SignalCode;
  weight: number;
  /** Raises a score to LINKABLE_CAP at most. */
  linkable: boolean;
}

interface Crossing {
  reference: string;
  line: string | null;
}

/**
 * Raises the scores; a crossing opens an incident (never for an admin:
 * recorded only). The actor keys: the account when signed in, else the
 * network (never for a sign-in 429: a carrier address shares that bucket);
 * and the device tag when there is one. Returns the crossing, or null.
 */
async function score(c: Context<AppContext>, s: GateState, signals: Signal[], status: number): Promise<Crossing | null> {
  if (signals.length === 0 || s.exemption === 'owner' || s.exemption === 'probe') return null;
  const db = c.env.DB;
  const now = new Date(s.nowMs);
  const netKey = s.user ? '' : await networkKeyFor(c.env, clientIp(c), s.nowMs);
  let top = 0;
  for (const sig of signals) {
    const keys: string[] = [];
    if (s.user) keys.push(`u:${s.user.id}`);
    else if (netKey && sig.code !== 'AUTH_BRUTE_FORCE') keys.push(`n:${netKey}`);
    if (s.tag) keys.push(`d:${s.tag.tagId}`);
    const linkable = sig.linkable || ALWAYS_LINKABLE.has(sig.code);
    for (const key of keys) {
      const v = await bumpScore(db, key, sig.code, sig.weight, now, linkable ? LINKABLE_CAP : null);
      if (v !== null && v > top) top = v;
    }
  }
  if (signals.some((x) => x.code === 'IDOR_PROBE') && top >= 50) {
    await event(c, s, 'idor_suspected', 'IDOR_PROBE', status, { sig: 'IDOR_PROBE' });
  }
  if (top < THRESHOLD || s.incident || s.exemption === 'admin') return null;
  const ip = clientIp(c);
  const strongest = [...signals].sort((a, b) => b.weight - a.weight)[0]!;
  const incident = await openIncident(c, {
    reason: 'score_threshold',
    signal: strongest.code,
    user: s.user,
    account: !!s.user,
    // Only a tool's crossing places a network block (and only tools meet one).
    network: !s.user && ip && s.intent === 'tool' && !serverToServer(c.req.path) ? { ip, hours: NETWORK_SCORE_BLOCK_HOURS } : null,
    intent: s.intent,
  });
  s.incident = true;
  return { reference: incident.reference, line: incident.tag ? tagCookieLine(c, incident.tag, s.nowMs) : null };
}

/**
 * THE QUIET SIGNALS COUNT ONCE PER TARGET. A refusal on another person's
 * record or an admin path counts once per (actor, path) in six hours, and a
 * sign-in 429 once per (actor, bucket) a minute — per isolate. A scanner walks
 * many ids and paths and keeps adding; a customer whose open page keeps
 * polling a conversation that was removed, or who retries a forgotten
 * password a few times after the limit, does not. (The admin refusals and the
 * sign-in 429s are linkable besides: counted in every isolate, they stop at 99.)
 */
const QUIET_WINDOW_MS: Partial<Record<SignalCode, number>> = {
  IDOR_PROBE: 6 * 3_600_000,
  ADMIN_REFUSED: 6 * 3_600_000,
  ADMIN_ROUTE_GUESS: 6 * 3_600_000,
  AUTH_BRUTE_FORCE: 60_000,
};
const quietSeen = new WeakMap<object, Map<string, number>>();
function firstInWindow(db: object, key: string, windowMs: number, nowMs: number): boolean {
  let m = quietSeen.get(db);
  if (!m) quietSeen.set(db, (m = new Map()));
  const last = m.get(key);
  if (last !== undefined && nowMs - last < windowMs) return false;
  if (m.size > 20_000) m.clear();
  m.set(key, nowMs);
  return true;
}

/** Did a route handler (not only middleware) match this request? */
function routeMatched(c: Context<AppContext>): boolean {
  try {
    return matchedRoutes(c).some((r) => r.method !== 'ALL');
  } catch {
    return false;
  }
}

async function observe(c: Context<AppContext>, s: GateState): Promise<void> {
  if (s.exemption === 'owner' || s.exemption === 'probe') return;
  const method = c.req.method.toUpperCase();
  if (method === 'HEAD' || method === 'OPTIONS') return;
  if (s.intent === 'induced') return;
  const path = c.req.path;
  // A decoy answers for itself (worker/routes/decoys.ts): never a second count here.
  if (decoyFor(path)) return;
  if (verifiedCrawler(c) && robotsAllows(path, c.get('host')?.kind ?? 'main')) return;
  // What the URL carries is linkable unless a tool sent it.
  const urlLinkable = urlEvidence(s.intent, s.crawlerClaim) !== 'hard';
  const status = c.res?.status ?? 200;
  const signals: Signal[] = [];
  const events: Array<{ kind: 'private_input_dropped' | 'enumeration_suspected' | 'rate_limited'; code: string; detail: SecurityDetail }> = [];
  // A body the route did not read and that is past any cart's size is not read here either.
  if (watchedBody(method, path) && (s.body || Number(c.req.header('Content-Length') ?? '0') <= 1_048_576)) {
    const body = await bodyOf(c, s);
    const fields = body.json ? priceFieldsIn(body.json) : [];
    if (fields.length) {
      // No page of this site sends one, and no link can make it: hard evidence.
      signals.push({ code: 'CLIENT_PRICE_FIELDS', weight: WEIGHTS.CLIENT_PRICE_FIELDS, linkable: false });
      events.push({ kind: 'private_input_dropped', code: 'CLIENT_PRICE_FIELDS', detail: { fields, sig: 'CLIENT_PRICE_FIELDS' } });
    }
  }
  if (injectionIn(c.req.url)) {
    signals.push({ code: 'INJECTION_PATTERN', weight: WEIGHTS.INJECTION_PATTERN, linkable: urlLinkable });
    events.push({ kind: 'enumeration_suspected', code: 'INJECTION_PATTERN', detail: { sig: 'INJECTION_PATTERN' } });
  }
  const tamper = tamperParams(path, new URL(c.req.url).searchParams);
  if (tamper.length) {
    signals.push({ code: 'TAMPER_PARAMS', weight: WEIGHTS.TAMPER_PARAMS, linkable: urlLinkable });
    events.push({ kind: 'enumeration_suspected', code: 'TAMPER_PARAMS', detail: { fields: tamper, sig: 'TAMPER_PARAMS' } });
  }
  if (status === 429) {
    const bucket = rateLimitedBucket(c);
    if (authBucket(bucket)) {
      signals.push({ code: 'AUTH_BRUTE_FORCE', weight: WEIGHTS.AUTH_BRUTE_FORCE, linkable: true });
      events.push({ kind: 'rate_limited', code: 'AUTH_BRUTE_FORCE', detail: { bucket: bucket ?? undefined, sig: 'AUTH_BRUTE_FORCE' } });
    }
  }
  const nonAdmin = !s.user || s.user.role !== 'admin';
  if (nonAdmin && (path === '/api/admin' || path.startsWith('/api/admin/')) && (status === 401 || status === 403 || status === 404)) {
    signals.push(
      routeMatched(c)
        ? { code: 'ADMIN_REFUSED', weight: WEIGHTS.ADMIN_REFUSED, linkable: true }
        : { code: 'ADMIN_ROUTE_GUESS', weight: WEIGHTS.ADMIN_ROUTE_GUESS, linkable: true }
    );
  }
  if (s.user && s.user.role !== 'admin' && (status === 403 || status === 404) && idorPath(path) && routePatternOf(c).includes('/:')) {
    signals.push({ code: 'IDOR_PROBE', weight: WEIGHTS.IDOR_PROBE, linkable: urlLinkable });
  }
  if (signals.length === 0) return;
  // The quiet signals count once per target (see QUIET_WINDOW_MS).
  if (signals.some((x) => QUIET_WINDOW_MS[x.code])) {
    const actor = s.user ? `u:${s.user.id}` : `n:${await networkKeyFor(c.env, clientIp(c), s.nowMs)}`;
    const target = (code: SignalCode) => (code === 'AUTH_BRUTE_FORCE' ? (rateLimitedBucket(c) ?? '') : path);
    for (let i = signals.length - 1; i >= 0; i--) {
      const w = QUIET_WINDOW_MS[signals[i]!.code];
      if (w && !firstInWindow(c.env.DB, `${signals[i]!.code}|${actor}|${target(signals[i]!.code)}`, w, s.nowMs)) signals.splice(i, 1);
    }
    if (signals.length === 0) return;
  }
  for (const e of events) await event(c, s, e.kind, e.code, status, e.detail);
  const crossed = await score(c, s, signals, status);
  if (crossed?.line) c.res = withCookie(c.res, crossed.line);
}

// ------------------------------------------------------------- the middleware

export const deceptionGate: MiddlewareHandler<AppContext> = async (c, next) => {
  const path = c.req.path;
  if (skipsGate(path) || c.req.method === 'OPTIONS') return next();
  let s: GateState | null = null;
  try {
    const nowMs = Date.now();
    const db = c.env?.DB;
    const snap = snapshotFor(db);
    const loaded = c.get('user');
    // The background refresh rides only on requests that already read the
    // session: the public, session-free paths (the home and product documents,
    // the storefront reads, the public API) stay free of any D1 statement —
    // they use the snapshot the other requests of this isolate keep warm.
    if (snap && db && loaded !== undefined) scheduleRefresh(c, db, snap, nowMs);
    const user = loaded ?? null;
    s = {
      user,
      sessionLoaded: loaded !== undefined,
      exemption: exemptionOf(c.env, user),
      intent: fetchIntent(c.req.raw.headers, c.req.method),
      crawlerClaim: claimsCrawler(c),
      tag: null,
      nowMs,
      incident: false,
    };
    // Without a key there is no trap data to find (worker/lib/deception/canary.ts): nothing is read.
    if (s.exemption !== 'probe' && db && keySource(c.env)) {
      const { found, flood } = await canaryScan(c.env, await canaryTexts(c, s));
      if (found.length || flood) {
        const answer = await onCanary(c, s, found, flood);
        if (answer) return answer;
      }
    }
    if (getCookie(c, TAG_COOKIE)) s.tag = await readTag(c, nowMs);
    const blocked = await blockCheck(c, s, snap);
    if (blocked) return blocked;
  } catch {
    /* fail open */
  }
  await next();
  if (!s) return;
  try {
    if (s.deleteTag) c.res = withCookie(c.res, tagDeleteLine(c));
    await observe(c, s);
  } catch {
    /* never in the way */
  }
};
