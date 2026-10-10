/**
 * THE DECEPTION GATE (design §4.3) — registered in worker/index.ts right after
 * the session loader and before every route, followed at once by the decoy
 * router. On every Worker request but the static ones:
 *
 *   1. CANARY USE. Trap data from a decoy answer, presented anywhere a key,
 *      a credential or an id can be: the URL, `Authorization`, `X-API-Key`,
 *      `X-Api-Token`, the session cookie, the sign-in doors' JSON, the cart
 *      and checkout bodies. A non-exempt use opens an incident and is answered
 *      with the block AT ONCE — the moment the attacker learns he was caught.
 *   2. THE BLOCK CHECK, in memory: a valid unlifted device tag, a blocked
 *      account, or — for an anonymous request only — a blocked network. The
 *      verified owner is never blocked; sign-in stays reachable under a device
 *      or network block (so the owner, or a CGNAT neighbour, can sign in);
 *      logging out stays reachable under an account block.
 *   3. THE ROUTE runs.
 *   4. OBSERVATION, after the answer and never changing it — except to add the
 *      tag cookie when a score crossed the threshold: client-sent price fields,
 *      injection shapes, tamper switches, sign-in brute force, admin probing,
 *      other people's records.
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
import { findCanaries, type CanaryWhere, type FoundCanary } from './canary';
import {
  clientIp,
  exemptionOf,
  fetchIntent,
  intentWeight,
  isCrawler,
  networkKeyFor,
  networkKeys,
  readTag,
  referenceHex,
  tagCookieLine,
  tagDeleteLine,
  tagReference,
  type DeviceTag,
  type Exemption,
  type FetchIntent,
} from './actors';
import {
  NETWORK_BLOCK_HOURS,
  NETWORK_SCORE_BLOCK_HOURS,
  countHit,
  openIncident,
  ringOwnerDeception,
  scheduleRefresh,
  settle,
  snapshotFor,
  warmForTag,
  type Snapshot,
} from './blocks';
import { THRESHOLD, WEIGHTS, authBucket, bumpScore, idorPath, injectionIn, priceFieldsIn, tamperParams, watchedBody, type SignalCode } from './signals';
import { blockedResponse } from './strings';
import { decoyFor } from './decoys';

/** Never checked: the static and machine paths (no person behind them to block, and speed matters). */
const SKIP_EXACT = new Set(['/manifest.webmanifest', '/robots.txt', '/sitemap.xml', '/api/health']);
const SKIP_PREFIX = ['/files/', '/store-icon/'];
export const skipsGate = (path: string) => SKIP_EXACT.has(path) || SKIP_PREFIX.some((p) => path.startsWith(p));

/** Server-to-server doors: never a network block (a webhook's or Studio's egress address is shared). */
const SERVER_TO_SERVER = ['/api/telegram/', '/api/studio/'];
const serverToServer = (path: string) => SERVER_TO_SERVER.some((p) => path.startsWith(p));

/** Where device and network blocks do not reach: signing in must stay possible. */
const signInPath = (path: string) => path === '/api/auth' || path.startsWith('/api/auth/') || path === '/api/settings/public';

/** The sign-in doors whose JSON is read for canary credentials. */
const CREDENTIAL_DOORS = new Set(['/api/auth/login', '/api/auth/otp/start', '/api/auth/forgot-password', '/api/auth/register']);
const CREDENTIAL_FIELDS = ['identifier', 'email', 'password', 'destination', 'username'];

const isJson = (c: Context<AppContext>) => /json/i.test(c.req.header('Content-Type') ?? '');

/** The request's JSON body through Hono's cache (the route reads the same parse), or null. */
async function jsonBody(c: Context<AppContext>): Promise<Record<string, unknown> | null> {
  if (!isJson(c)) return null;
  const len = Number(c.req.header('Content-Length') ?? '0');
  if (len > 65_536) return null;
  try {
    const v: unknown = await c.req.json();
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

interface GateState {
  user: SessionUser | null;
  sessionLoaded: boolean;
  exemption: Exemption;
  intent: FetchIntent;
  tag: DeviceTag | null;
  nowMs: number;
  /** An incident already opened on this request (no second one from its signals). */
  incident: boolean;
  answer?: Response;
  deleteTag?: boolean;
}

/** Is this request anonymous for a network block? A loaded session decides; elsewhere the cookie's presence does. */
function anonymous(c: Context<AppContext>, s: GateState): boolean {
  if (s.sessionLoaded) return !s.user;
  return !hasSessionCookie(c.req.header('Cookie'));
}

/** The user behind a session cookie on a path that skips the loader — only for a tagged request (rare). */
async function peekSessionUser(c: Context<AppContext>): Promise<SessionUser | null> {
  try {
    const token = getCookie(c, SESSION_COOKIE_NAME);
    if (!token) return null;
    const row = await c.env.DB.prepare(
      `SELECT u.id, u.email, u.role, u.admin_scope, u.email_verified_at FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = ? AND s.expires_at > ?`
    )
      .bind(await sha256Hex(token), new Date().toISOString())
      .first<SessionUser>();
    return row ?? null;
  } catch {
    return null;
  }
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

// ------------------------------------------------------------- 1. canaries

async function canaryTexts(c: Context<AppContext>): Promise<Array<readonly [string, CanaryWhere]>> {
  const texts: Array<readonly [string, CanaryWhere]> = [];
  const url = new URL(c.req.url);
  texts.push([safeDecode(`${url.pathname}${url.search}`), 'url']);
  for (const h of ['Authorization', 'X-API-Key', 'X-Api-Token']) {
    const v = c.req.header(h);
    if (v) texts.push([v, 'header']);
  }
  const session = getCookie(c, SESSION_COOKIE_NAME);
  if (session) texts.push([session, 'cookie']);
  const method = c.req.method.toUpperCase();
  if (method === 'POST' && CREDENTIAL_DOORS.has(c.req.path)) {
    const body = await jsonBody(c);
    if (body) for (const f of CREDENTIAL_FIELDS) if (typeof body[f] === 'string') texts.push([String(body[f]).slice(0, 320), 'credentials']);
  } else if (watchedBody(method, c.req.path)) {
    const body = await jsonBody(c);
    if (body && typeof body.productId === 'string') texts.push([body.productId.slice(0, 64), 'body']);
  }
  return texts;
}

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

function detailFor(s: GateState, extra: SecurityDetail): SecurityDetail {
  return { intent: s.intent, ...extra };
}

/** A canary presented: confirm, record, and block unless the actor is exempt. Returns the block answer, or nothing. */
async function onCanary(c: Context<AppContext>, s: GateState, found: FoundCanary[]): Promise<Response | null> {
  const db = c.env.DB;
  // The strongest first: a credential, a header, a cookie or a body cannot be induced.
  const ordered = [...found].sort((a, b) => (a.where === 'url' ? 1 : 0) - (b.where === 'url' ? 1 : 0));
  const first = ordered[0]!;
  const row = await batchRow(db, first.batch);
  const confirmed = first.kind !== 'p' || !!row;
  const nowIso = new Date(s.nowMs).toISOString();
  if (row) {
    await settle(c, () =>
      db
        .prepare('UPDATE security_canaries SET first_used_at = COALESCE(first_used_at, ?), use_count = use_count + 1 WHERE batch_id = ?')
        .bind(nowIso, first.batch)
        .run()
    );
  }
  const base: SecurityDetail = { batch: first.batch, sig: 'CANARY_USED' };
  if (row?.decoy) base.decoy = row.decoy;
  if (!confirmed) {
    // A product-shaped id with a valid tag but no batch row: past the daily cap, or chance. Scored, not blocked.
    await recordSecurityEvent(c, { kind: 'enumeration_suspected', code: 'CANARY_UNCONFIRMED', status: 200, detail: detailFor(s, { batch: first.batch, sig: 'CANARY_UNCONFIRMED' }) });
    await score(c, s, [{ code: 'CANARY_UNCONFIRMED', weight: WEIGHTS.CANARY_UNCONFIRMED }], 200);
    return null;
  }
  const inUrlOnly = first.where === 'url';
  const weight = inUrlOnly ? intentWeight(s.intent) : 'full';
  if (weight === 'none') {
    await recordSecurityEvent(c, { kind: 'enumeration_suspected', code: 'CANARY_INDUCED', status: 200, detail: detailFor(s, { ...base, sig: 'CANARY_INDUCED' }) });
    return null;
  }
  if (s.exemption === 'owner') {
    await recordSecurityEvent(c, { kind: 'enumeration_suspected', code: 'CANARY_USED', status: 200, detail: detailFor(s, { ...base, ex: 'owner' }) });
    await settle(c, () => ringOwnerDeception(c.env, db, 'ownCanary', `own_${first.batch}_${s.nowMs}`, '', s.nowMs));
    return null;
  }
  if (s.exemption === 'admin' && !row) {
    await recordSecurityEvent(c, { kind: 'enumeration_suspected', code: 'CANARY_USED', status: 200, detail: detailFor(s, { ...base, ex: 'admin' }) });
    return null;
  }
  if (weight === 'partial') {
    await recordSecurityEvent(c, { kind: 'enumeration_suspected', code: 'CANARY_USED', status: 200, detail: detailFor(s, { ...base, ex: 'clicked' }) });
    await score(c, s, [{ code: 'CANARY_CLICKED', weight: WEIGHTS.CANARY_CLICKED }], 200);
    return null;
  }
  await recordSecurityEvent(c, { kind: 'enumeration_suspected', code: 'CANARY_USED', status: 403, detail: detailFor(s, base) });
  const anon = anonymous(c, s);
  const crawler = isCrawler(c);
  const netKey = anon && !crawler && !serverToServer(c.req.path) ? await networkKeyFor(clientIp(c), s.nowMs) : '';
  const incident = await openIncident(c, {
    reason: 'canary_used',
    signal: 'CANARY_USED',
    user: s.user,
    account: !!s.user,
    network: netKey ? { key: netKey, hours: NETWORK_BLOCK_HOURS } : null,
    intent: s.intent,
  });
  s.incident = true;
  const res = blockedResponse(c, incident.reference, !s.user);
  return withCookie(res, tagCookieLine(c, incident.tag, s.nowMs));
}

// ------------------------------------------------------------- 2. the block check

const TAG_MINT_EVERY_MS = 600_000;
const tagMints = new WeakMap<object, Map<string, number>>();
function tagMintDue(db: object, userId: string, nowMs: number): boolean {
  let m = tagMints.get(db);
  if (!m) tagMints.set(db, (m = new Map()));
  const last = m.get(userId);
  if (last !== undefined && nowMs - last < TAG_MINT_EVERY_MS) return false;
  if (m.size > 5000) m.clear();
  m.set(userId, nowMs);
  return true;
}

async function blockCheck(c: Context<AppContext>, s: GateState, snap: Snapshot | null): Promise<Response | null> {
  const path = c.req.path;
  const db = c.env.DB;
  const offerSignIn = !s.user;
  // The device tag: stateless; the snapshot only says whether the owner lifted it.
  if (s.tag && !signInPath(path)) {
    if (snap) await warmForTag(db, snap, s.nowMs);
    if (snap?.lifted.has(s.tag.tagId)) {
      s.deleteTag = true;
    } else {
      let exempt = s.exemption === 'owner' || s.exemption === 'probe';
      if (!exempt && !s.sessionLoaded && hasSessionCookie(c.req.header('Cookie'))) {
        const ex = exemptionOf(c.env, await peekSessionUser(c));
        exempt = ex === 'owner' || ex === 'probe';
      }
      if (!exempt) {
        if (snap) countHit(c, db, snap, 'device', s.tag.tagId, s.nowMs);
        return blockedResponse(c, tagReference(s.tag.tagId), offerSignIn);
      }
    }
  }
  if (!snap) return null;
  // The account.
  if (s.user && s.exemption !== 'owner' && s.exemption !== 'probe' && !(c.req.method === 'POST' && path === '/api/auth/logout')) {
    const b = snap.accounts.get(s.user.id);
    if (b && b.expiresMs > s.nowMs) {
      countHit(c, db, snap, 'account', s.user.id, s.nowMs);
      let res = blockedResponse(c, b.reference, false);
      // The account's browser is tagged too, so signing out does not undo the
      // block — at most once in ten minutes per account per isolate, so a
      // blocked account hammering without cookies writes nothing more.
      if (!s.tag && tagMintDue(db, s.user.id, s.nowMs)) {
        const hex = referenceHex(b.reference);
        if (hex) {
          const incident = await openIncident(c, {
            reason: 'score_threshold',
            signal: 'ACCOUNT_BLOCKED',
            user: s.user,
            account: false,
            network: null,
            intent: s.intent,
            reuse: { incidentId: b.incidentId, referenceHex: hex },
            deviceOnly: true,
          });
          if (incident.written) res = withCookie(res, tagCookieLine(c, incident.tag, s.nowMs));
        }
      }
      return res;
    }
  }
  // The network: anonymous requests only, never sign-in, never a server-to-server door, never a crawler on an allowed path.
  if (snap.networks.size > 0 && !signInPath(path) && !serverToServer(path) && anonymous(c, s)) {
    if (isCrawler(c) && robotsAllows(path, c.get('host')?.kind ?? 'main')) return null;
    for (const key of await networkKeys(clientIp(c), s.nowMs)) {
      const b = snap.networks.get(key);
      if (b && b.expiresMs > s.nowMs) {
        countHit(c, db, snap, 'network', key, s.nowMs);
        return blockedResponse(c, b.reference, offerSignIn);
      }
    }
  }
  return null;
}

// ------------------------------------------------------------- 4. observation

interface Signal {
  code: SignalCode;
  weight: number;
}

/** The actor keys a signal scores: the account when signed in, else the network; and the device tag when there is one. */
async function actorKeys(c: Context<AppContext>, s: GateState): Promise<string[]> {
  const keys: string[] = [];
  if (s.user) keys.push(`u:${s.user.id}`);
  else {
    const n = await networkKeyFor(clientIp(c), s.nowMs);
    if (n) keys.push(`n:${n}`);
  }
  if (s.tag) keys.push(`d:${s.tag.tagId}`);
  return keys;
}

/** Raises the scores; a crossing opens an incident (never for an admin: recorded only). Returns the tag cookie line, if one was set. */
async function score(c: Context<AppContext>, s: GateState, signals: Signal[], status: number): Promise<string | null> {
  if (signals.length === 0 || s.exemption === 'owner' || s.exemption === 'probe') return null;
  const db = c.env.DB;
  const now = new Date(s.nowMs);
  let top = 0;
  for (const key of await actorKeys(c, s)) {
    for (const sig of signals) {
      const v = await bumpScore(db, key, sig.code, sig.weight, now);
      if (v !== null && v > top) top = v;
    }
  }
  if (signals.some((x) => x.code === 'IDOR_PROBE') && top >= 50) {
    await recordSecurityEvent(c, { kind: 'idor_suspected', code: 'IDOR_PROBE', status, detail: { sig: 'IDOR_PROBE' } });
  }
  if (top < THRESHOLD || s.incident || s.exemption === 'admin') return null;
  const anon = anonymous(c, s);
  const crawler = isCrawler(c);
  const full = intentWeight(s.intent) === 'full';
  const netKey = anon && full && !crawler && !serverToServer(c.req.path) ? await networkKeyFor(clientIp(c), s.nowMs) : '';
  const strongest = [...signals].sort((a, b) => b.weight - a.weight)[0]!;
  const incident = await openIncident(c, {
    reason: 'score_threshold',
    signal: strongest.code,
    user: s.user,
    account: !!s.user,
    network: netKey ? { key: netKey, hours: NETWORK_SCORE_BLOCK_HOURS } : null,
    intent: s.intent,
  });
  s.incident = true;
  return tagCookieLine(c, incident.tag, s.nowMs);
}

/**
 * THE QUIET SIGNALS COUNT ONCE PER TARGET. A refusal on another person's
 * record or an admin path counts once per (actor, path) in six hours, and a
 * sign-in 429 once per (actor, bucket) a minute — per isolate. A scanner walks
 * many ids and paths and keeps adding; a customer whose open page keeps
 * polling a conversation that was removed, or who retries a forgotten
 * password a few times after the limit, does not.
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
  if (intentWeight(s.intent) === 'none') return;
  const path = c.req.path;
  // A decoy answers for itself (worker/routes/decoys.ts): its own incident, never a second one here.
  if (decoyFor(path)) return;
  if (isCrawler(c) && robotsAllows(path, c.get('host')?.kind ?? 'main')) return;
  const status = c.res?.status ?? 200;
  const signals: Signal[] = [];
  const events: Array<{ kind: 'private_input_dropped' | 'enumeration_suspected' | 'rate_limited'; code: string; detail: SecurityDetail }> = [];
  if (watchedBody(method, path)) {
    const body = await jsonBody(c);
    const fields = body ? priceFieldsIn(body) : [];
    if (fields.length) {
      signals.push({ code: 'CLIENT_PRICE_FIELDS', weight: WEIGHTS.CLIENT_PRICE_FIELDS });
      events.push({ kind: 'private_input_dropped', code: 'CLIENT_PRICE_FIELDS', detail: { fields, sig: 'CLIENT_PRICE_FIELDS' } });
    }
  }
  if (injectionIn(c.req.url)) {
    signals.push({ code: 'INJECTION_PATTERN', weight: WEIGHTS.INJECTION_PATTERN });
    events.push({ kind: 'enumeration_suspected', code: 'INJECTION_PATTERN', detail: { sig: 'INJECTION_PATTERN' } });
  }
  const tamper = tamperParams(path, new URL(c.req.url).searchParams);
  if (tamper.length) {
    signals.push({ code: 'TAMPER_PARAMS', weight: WEIGHTS.TAMPER_PARAMS });
    events.push({ kind: 'enumeration_suspected', code: 'TAMPER_PARAMS', detail: { fields: tamper, sig: 'TAMPER_PARAMS' } });
  }
  if (status === 429) {
    const bucket = rateLimitedBucket(c);
    if (authBucket(bucket)) {
      signals.push({ code: 'AUTH_BRUTE_FORCE', weight: WEIGHTS.AUTH_BRUTE_FORCE });
      events.push({ kind: 'rate_limited', code: 'AUTH_BRUTE_FORCE', detail: { bucket: bucket ?? undefined, sig: 'AUTH_BRUTE_FORCE' } });
    }
  }
  const nonAdmin = !s.user || s.user.role !== 'admin';
  if (nonAdmin && (path === '/api/admin' || path.startsWith('/api/admin/')) && (status === 401 || status === 403 || status === 404)) {
    signals.push(routeMatched(c) ? { code: 'ADMIN_REFUSED', weight: WEIGHTS.ADMIN_REFUSED } : { code: 'ADMIN_ROUTE_GUESS', weight: WEIGHTS.ADMIN_ROUTE_GUESS });
  }
  if (s.user && s.user.role !== 'admin' && (status === 403 || status === 404) && idorPath(path) && routePatternOf(c).includes('/:')) {
    signals.push({ code: 'IDOR_PROBE', weight: WEIGHTS.IDOR_PROBE });
  }
  if (signals.length === 0) return;
  // The quiet signals count once per target (see QUIET_WINDOW_MS).
  if (signals.some((x) => QUIET_WINDOW_MS[x.code])) {
    const actor = s.user ? `u:${s.user.id}` : `n:${await networkKeyFor(clientIp(c), s.nowMs)}`;
    const target = (code: SignalCode) => (code === 'AUTH_BRUTE_FORCE' ? rateLimitedBucket(c) ?? '' : path);
    for (let i = signals.length - 1; i >= 0; i--) {
      const w = QUIET_WINDOW_MS[signals[i]!.code];
      if (w && !firstInWindow(c.env.DB, `${signals[i]!.code}|${actor}|${target(signals[i]!.code)}`, w, s.nowMs)) signals.splice(i, 1);
    }
    if (signals.length === 0) return;
  }
  for (const e of events) await recordSecurityEvent(c, { kind: e.kind, code: e.code, status, detail: detailFor(s, e.detail) });
  const line = await score(c, s, signals, status);
  if (line) c.res = withCookie(c.res, line);
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
      intent: fetchIntent(c.req.raw.headers),
      tag: null,
      nowMs,
      incident: false,
    };
    if (s.exemption !== 'probe' && db) {
      const found = await findCanaries(c.env, await canaryTexts(c));
      if (found.length) {
        const answer = await onCanary(c, s, found);
        if (answer) return answer;
      }
    }
    if (getCookie(c, 'lv_pref')) s.tag = await readTag(c, nowMs);
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
