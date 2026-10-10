/**
 * THE OWNER'S SECURITY LOG — the `security_events` writer (FX programme plan
 * §14.2 S7, push 1s; table of migration 0177, unwritten until now).
 *
 * WHAT IS RECORDED, with ids and codes only — never a figure, a body, a query
 * string, an address or a key:
 *
 *   cost_denied           a refusal at a cost door: COST_ACCESS_DENIED or
 *                         OWNER_EMAIL_UNVERIFIED anywhere under /api/admin/*,
 *                         and the 401 / 403 FORBIDDEN a guest or a non-admin
 *                         hears at a cost router's own door (`COST_PATH_PREFIXES`)
 *   rate_limited          a 429 on the pricing and FX buckets (`WATCHED_BUCKETS`)
 *   owner_denied          the owner's session refused for freshness
 *                         (REAUTH_REQUIRED); another admin's is admin_denied
 *   scope_changed         every FX guard-setting change (FX_GUARD_CHANGED): the
 *                         guard is the scope of what the scheduler may apply on
 *                         its own, so a change to it is recorded like a change
 *                         of anyone's scope (critique F3)
 *   enumeration_suspected an owner cost request from a session, a network or a
 *                         browser not seen in the last 30 days
 *                         (OWNER_COST_NEW_CONTEXT) — which also rings the
 *                         owner's bell, with no figure (critique F15: the
 *                         pricing-read budget allows 1,200 an hour and the
 *                         whole catalogue's costs take about 100 requests, so
 *                         detection, not a lower limit, is the control)
 *
 * The 0177 table's kinds are fixed by a CHECK; these are the closest of them,
 * adapted without a migration, and `code` says exactly what happened.
 *
 * DEDUPLICATED AND BOUNDED. One row per (kind, code, actor, method + route,
 * UTC hour): a repeat adds to `count` and moves `last_at`. A guest's actor is
 * its day-salted address hash, so one guest's tries group and nobody's address
 * is stored. At most `DAILY_ROW_CAP` rows are active in any 24 hours; past
 * that, everything else of the day lands in ONE overflow row per kind. The
 * owner's context rows are one per (session, network, browser) triple.
 *
 * WHO IS NOT RECORDED. Only the authenticated probe accounts the owner
 * registered (`SECURITY_PROBE_USER_IDS`, comma-separated user ids — never the
 * owner's own). An anonymous request is ALWAYS recorded, whatever its headers:
 * the live probe runner says who it is only in its user agent
 * (`levonis-live-cost-probes/1`), which anyone can send (critique F11).
 *
 * NEVER IN THE WAY. Every write is best effort: a missing table (a database
 * behind 0177), a full D1, anything — the request's answer is unchanged, and
 * the write runs after the response where the platform allows it.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { matchedRoutes } from 'hono/route';
import type { AppContext, Env, SessionUser } from './types';
import { HttpError } from './http';
import { isOwner, isUnverifiedOwner, viewerClass, type ViewerClass } from './adminScope';
import { rateLimitedBucket } from './ratelimit';
import { baghdadDay } from './baghdadTime';
import { newId, sha256Hex } from './crypto';
import { notify } from './notifications';

/** The kinds the 0177 CHECK allows. */
export const SECURITY_EVENT_KINDS = [
  'cost_denied',
  'money_denied',
  'owner_denied',
  'admin_denied',
  'rate_limited',
  'role_changed',
  'scope_changed',
  'investor_changed',
  'grant_changed',
  'enumeration_suspected',
  'private_input_dropped',
  'idor_suspected',
] as const;
export type SecurityEventKind = (typeof SECURITY_EVENT_KINDS)[number];

/** The methods the 0177 CHECK allows; anything else is not recorded. */
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

/**
 * The cost routers' mount points (tests/costPredicateUsage.test.ts COST_ROUTERS,
 * plus the legacy investment register and the print-quote admin router, both
 * behind the cost door). A guest's 401 and a non-admin's 403 FORBIDDEN are cost
 * refusals only here; COST_ACCESS_DENIED is one wherever it is heard.
 * tests/securityEvents.test.ts holds this list to worker/index.ts.
 */
export const COST_PATH_PREFIXES = [
  '/api/admin/pricing',
  '/api/admin/finance',
  '/api/admin/finance-operations',
  '/api/admin/finance-workspace',
  '/api/admin/finance-people',
  '/api/admin/investment-finance/profiles',
  '/api/admin/investment-finance/legacy',
  '/api/admin/invest',
  '/api/admin/print-quote',
] as const;

export function isCostPath(path: string): boolean {
  return COST_PATH_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

/** The pricing and FX rate-limit buckets whose 429 is recorded. */
export const WATCHED_BUCKETS = ['pricing-read', 'pricing-write', 'fx-refresh', 'fx-refresh-global'] as const;

export const OWNER_COST_NEW_CONTEXT = 'OWNER_COST_NEW_CONTEXT';
export const FX_GUARD_CHANGED = 'FX_GUARD_CHANGED';

/** Rows active in any 24 hours before everything else of the day collapses into one overflow row per kind. */
export const DAILY_ROW_CAP = 2000;
/** "Not seen in the last 30 days." */
export const CONTEXT_WINDOW_DAYS = 30;
/** At most this many security bells a Baghdad day; the rows are written regardless. */
export const DAILY_BELL_CAP = 5;

// ------------------------------------------------------------- detail

/**
 * THE ONLY KEYS `detail` MAY CARRY, each a code, a name or an opaque hash
 * (0177: allow-listed keys, ≤ 1,000 characters):
 *   bucket   the rate-limit bucket that refused
 *   pair     an FX pair id
 *   act      the audit action code of an FX act
 *   fields   field NAMES an FX guard change touched
 *   new      which of session / ip / ua was not seen ('session' | 'ip' | 'ua')
 *   s, i, u  16-hex fingerprints of the session, the network and the browser
 */
export interface SecurityDetail {
  bucket?: string;
  pair?: string;
  act?: string;
  fields?: string[];
  new?: Array<'session' | 'ip' | 'ua'>;
  s?: string;
  i?: string;
  u?: string;
}

/** A code or a name: starts with a letter, so no figure ever passes as one. */
const CODE_LIKE = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const HEX16 = /^[0-9a-f]{16}$/;

/** Drops every key and value outside the allow-list; never throws. */
export function cleanDetail(d: SecurityDetail | undefined): string {
  const out: Record<string, unknown> = {};
  if (d) {
    for (const k of ['bucket', 'pair', 'act'] as const) {
      const v = d[k];
      if (typeof v === 'string' && CODE_LIKE.test(v)) out[k] = v;
    }
    if (Array.isArray(d.fields)) {
      const f = d.fields.filter((x) => typeof x === 'string' && CODE_LIKE.test(x)).slice(0, 12);
      if (f.length) out.fields = f;
    }
    if (Array.isArray(d.new)) {
      const n = d.new.filter((x) => x === 'session' || x === 'ip' || x === 'ua');
      out.new = [...new Set(n)];
    }
    for (const k of ['s', 'i', 'u'] as const) {
      const v = d[k];
      if (typeof v === 'string' && HEX16.test(v)) out[k] = v;
    }
  }
  const text = JSON.stringify(out);
  return text.length <= 1000 ? text : '{}';
}

// ------------------------------------------------------------- the request

/**
 * The Hono route PATTERN that answered (or would have answered) the request —
 * '/api/admin/pricing/products/:id', never the raw URL or its query string.
 * A refusal at the door still names the route the router matched behind it.
 */
export function routePatternOf(c: Context<AppContext>): string {
  try {
    const routes = matchedRoutes(c);
    for (let i = routes.length - 1; i >= 0; i--) {
      const r = routes[i]!;
      if (r.method !== 'ALL') return r.path.slice(0, 200);
    }
    const last = routes.at(-1)?.path;
    if (last) return last.slice(0, 200);
  } catch {
    /* no match result (a direct call): fall through */
  }
  return '(unmatched)';
}

/** The `:param` the pattern names in this path — the first one, a code-like id of ≤ 80 characters, or null. */
export function targetOf(pattern: string, path: string): string | null {
  const ps = pattern.split('/');
  const xs = path.split('/');
  for (let i = 0; i < ps.length && i < xs.length; i++) {
    if (ps[i]!.startsWith(':')) {
      let v = xs[i]!;
      try {
        v = decodeURIComponent(v);
      } catch {
        return null;
      }
      return /^[A-Za-z0-9_.:-]{1,80}$/.test(v) ? v : null;
    }
  }
  return null;
}

/** sha256(ip | Baghdad day), first 16 hex — groups one guest's tries within a day; stores no address. */
export async function ipDayHash(ip: string, nowMs: number): Promise<string> {
  if (!ip) return '';
  return (await sha256Hex(`${ip}|${baghdadDay(nowMs)}`)).slice(0, 16);
}

/**
 * The NETWORK an address belongs to: its /24 (IPv4) or /48 (IPv6). A mobile
 * carrier moves its subscribers' addresses within a network many times a day;
 * the network is what "a place not seen before" means, and a fingerprint of
 * it is not the address.
 */
export function ipNetwork(ip: string): string {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  if (!ip.includes(':')) return '';
  const [head = '', tail] = ip.trim().toLowerCase().split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = tail === undefined ? [] : Array(Math.max(0, 8 - h.length - t.length)).fill('0');
  const full = [...h, ...fill, ...t];
  if (full.length < 3 || full.slice(0, 3).some((x) => !/^[0-9a-f]{1,4}$/.test(x))) return '';
  return `${full.slice(0, 3).map((x) => x.replace(/^0+(?=.)/, '')).join(':')}::/48`;
}

/** An opaque 16-hex fingerprint of one context part. Empty input → ''. */
async function fingerprint(part: 's' | 'i' | 'u', value: string): Promise<string> {
  if (!value) return '';
  return (await sha256Hex(`levonis-sev|${part}|${value}`)).slice(0, 16);
}

/**
 * The probe accounts the owner registered (`SECURITY_PROBE_USER_IDS`), and
 * only when the request is SIGNED IN as one of them. Never a guest, never the
 * owner, never by user agent or any other header.
 */
export function probeExempt(env: Pick<Env, 'SECURITY_PROBE_USER_IDS' | 'INITIAL_ADMIN_EMAIL'>, user: Pick<SessionUser, 'id' | 'email'> | null | undefined): boolean {
  if (!user || typeof user.id !== 'string' || !user.id) return false;
  if (isOwner(env as Env, user)) return false;
  const ids = (env.SECURITY_PROBE_USER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.includes(user.id);
}

/**
 * Which refusal this answer is, or null. Pure: the path, the answer's status
 * and code, whether the session is the owner's, and the rate-limit bucket
 * that refused (if one did).
 */
export function classifyRefusal(input: {
  path: string;
  status: number;
  code: string | undefined;
  ownerSession: boolean;
  bucket: string | null;
}): { kind: SecurityEventKind; code: string; detail?: SecurityDetail } | null {
  const { path, status, code, ownerSession, bucket } = input;
  if (status === 403 && (code === 'COST_ACCESS_DENIED' || code === 'OWNER_EMAIL_UNVERIFIED')) {
    return { kind: 'cost_denied', code };
  }
  if (isCostPath(path) && status === 401 && code === 'UNAUTHORIZED') return { kind: 'cost_denied', code };
  if (isCostPath(path) && status === 403 && code === 'FORBIDDEN') return { kind: 'cost_denied', code };
  if (status === 429 && bucket && (WATCHED_BUCKETS as readonly string[]).includes(bucket)) {
    return { kind: 'rate_limited', code: 'RATE_LIMITED', detail: { bucket } };
  }
  if (status === 401 && code === 'REAUTH_REQUIRED') {
    return { kind: ownerSession ? 'owner_denied' : 'admin_denied', code };
  }
  return null;
}

// ------------------------------------------------------------- the write

interface EventRow {
  bucket: string;
  kind: SecurityEventKind;
  code: string;
  actorId: string | null;
  actorClass: ViewerClass;
  ipHash: string;
  method: string;
  route: string;
  targetId: string | null;
  status: number;
  detail: string;
}

const isMissingTable = (e: unknown) => /no such table/i.test(e instanceof Error ? e.message : String(e));

/**
 * Upserts one row: a new bucket inserts (while fewer than DAILY_ROW_CAP rows
 * were active in the last 24 hours), a known one adds to `count`. Past the cap
 * the event lands in the kind's overflow row for the Baghdad day. Returns
 * 'written' | 'overflow' | 'skipped'. Never throws.
 */
async function writeRow(db: D1Database, r: EventRow, now: Date): Promise<'written' | 'overflow' | 'skipped'> {
  const at = now.toISOString();
  const since = new Date(now.getTime() - 86_400_000).toISOString();
  try {
    const res = await db
      .prepare(
        `INSERT INTO security_events
           (id, bucket, kind, code, actor_id, actor_class, ip_hash, method, route, target_id, status, first_at, last_at, detail)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12, ?13
          WHERE EXISTS (SELECT 1 FROM security_events WHERE bucket = ?2)
             OR (SELECT COUNT(*) FROM (SELECT 1 FROM security_events WHERE last_at >= ?14 LIMIT ?15)) < ?15
         ON CONFLICT(bucket) DO UPDATE SET count = count + 1, last_at = excluded.last_at, status = excluded.status`
      )
      .bind(
        newId('sev'),
        r.bucket,
        r.kind,
        r.code.slice(0, 64),
        r.actorId,
        r.actorClass,
        r.ipHash,
        r.method,
        r.route.slice(0, 200),
        r.targetId,
        r.status,
        at,
        r.detail,
        since,
        DAILY_ROW_CAP
      )
      .run();
    if (Number(res.meta?.changes ?? 0) > 0) return 'written';
    await db
      .prepare(
        `INSERT INTO security_events
           (id, bucket, kind, code, actor_id, actor_class, ip_hash, method, route, target_id, status, first_at, last_at, detail)
         VALUES (?1, ?2, ?3, 'OVERFLOW', NULL, 'guest', '', ?4, '*', NULL, ?5, ?6, ?6, '{}')
         ON CONFLICT(bucket) DO UPDATE SET count = count + 1, last_at = excluded.last_at`
      )
      .bind(newId('sev'), `overflow|${r.kind}|${baghdadDay(now.getTime())}`, r.kind, r.method, r.status, at)
      .run();
    return 'overflow';
  } catch (e) {
    if (!isMissingTable(e)) console.error('security event not written:', e instanceof Error ? e.name : 'unknown');
    return 'skipped';
  }
}

/** Runs `work` after the response where the platform allows it, else now. Never throws. */
async function settle(c: Context<AppContext>, work: () => Promise<unknown>): Promise<void> {
  const safe = () => work().catch(() => undefined);
  try {
    c.executionCtx.waitUntil(safe());
    return;
  } catch {
    /* no ExecutionContext (a direct call): run it in line */
  }
  await safe();
}

async function rowFor(
  c: Context<AppContext>,
  ev: { kind: SecurityEventKind; code: string; status: number; detail?: SecurityDetail },
  now: Date,
  bucketOverride?: string
): Promise<EventRow | null> {
  const method = c.req.method.toUpperCase();
  if (!METHODS.has(method)) return null;
  const user = c.get('user') ?? null;
  const ipHash = await ipDayHash(c.req.header('CF-Connecting-IP') ?? '', now.getTime());
  const route = routePatternOf(c);
  const actorKey = user?.id ?? `guest:${ipHash || '-'}`;
  const bucket = bucketOverride ?? [ev.kind, ev.code, actorKey, `${method} ${route}`, now.toISOString().slice(0, 13)].join('|');
  return {
    bucket,
    kind: ev.kind,
    code: ev.code,
    actorId: user?.id ?? null,
    actorClass: viewerClass(c.env, user),
    ipHash,
    method,
    route,
    targetId: targetOf(route, c.req.path),
    status: ev.status,
    detail: cleanDetail(ev.detail),
  };
}

/**
 * Records one event for this request's actor. For a route's own events (an FX
 * guard change); the refusals are recorded by `securityEventsDoor`. Awaits the
 * write (or hands it to waitUntil); never throws.
 */
export async function recordSecurityEvent(
  c: Context<AppContext>,
  ev: { kind: SecurityEventKind; code: string; status: number; detail?: SecurityDetail }
): Promise<void> {
  try {
    if (probeExempt(c.env, c.get('user'))) return;
    const now = new Date();
    const row = await rowFor(c, ev, now);
    if (!row) return;
    await settle(c, () => writeRow(c.env.DB, row, now));
  } catch {
    /* never in the way */
  }
}

// ------------------------------------------------------------- owner cost context

export const SECURITY_ALERT_NOTICE = {
  title: {
    ar: 'فُتحت بيانات التكلفة من مكان جديد',
    en: 'Cost data was opened from somewhere new',
    ckb: 'زانیاریی تێچوو لە شوێنێکی نوێوە کرایەوە',
  },
  body: {
    ar: 'فُتحت بيانات التكلفة من حسابك بجلسة أو شبكة أو متصفح لم يُرَ خلال الشهر الأخير. إن كنت أنت فلا شيء عليك. وإن لم تكن أنت، فأنهِ الجلسات الأخرى من «الإعدادات» وغيّر كلمة المرور.',
    en: 'Cost data in your account was opened from a session, network or browser not seen in the past month. If this was you, there is nothing to do. If it was not, end the other sessions in Settings and change your password.',
    ckb: 'زانیارییەکانی تێچوو لە هەژمارەکەتەوە لە دانیشتنێک، تۆڕێک یان وێبگەڕێکەوە کرانەوە کە لە مانگی ڕابردوودا نەبینراوە. ئەگەر خۆت بوویت، پێویست بە هیچ ناکات. ئەگەر تۆ نەبوویت، لە «ڕێکخستنەکان» دانیشتنەکانی تر کۆتایی پێبهێنە و وشەی نهێنییەکەت بگۆڕە.',
  },
} as const;

/** The three fingerprints of this request's context. */
export async function contextOf(c: Context<AppContext>): Promise<{ s: string; i: string; u: string }> {
  return {
    s: await fingerprint('s', c.get('sessionId') ?? ''),
    i: await fingerprint('i', ipNetwork(c.req.header('CF-Connecting-IP') ?? '')),
    u: await fingerprint('u', (c.req.header('User-Agent') ?? '').slice(0, 255)),
  };
}

/**
 * AN OWNER COST REQUEST FROM A CONTEXT NOT SEEN IN 30 DAYS. The rows of this
 * code ARE the memory: each is one (session, network, browser) triple the
 * owner used, `last_at` its last use (moved at most once an hour). A request
 * whose session, network or browser appears in none of them within the window
 * is an event: its triple gets a row (`new` names what was unseen) and the
 * owner's bell rings — no figure, at most once a day per triple and
 * DAILY_BELL_CAP a day in all. A part this request does not have (no session
 * id, no address, no user agent) is never "new".
 */
export async function checkOwnerCostContext(c: Context<AppContext>, user: SessionUser, now: Date): Promise<void> {
  const db = c.env.DB;
  const fp = await contextOf(c);
  const cutoff = new Date(now.getTime() - CONTEXT_WINDOW_DAYS * 86_400_000).toISOString();
  const hourStart = `${now.toISOString().slice(0, 13)}:00:00.000Z`;
  const triple = `${fp.s || '-'}.${fp.i || '-'}.${fp.u || '-'}`;
  const bucket = ['enumeration_suspected', OWNER_COST_NEW_CONTEXT, user.id, `ctx:${triple}`].join('|');
  let seen: { s: number | null; i: number | null; u: number | null; stale: number | null } | null;
  try {
    seen = await db
      .prepare(
        `SELECT MAX(json_extract(detail, '$.s') = ?1) AS s,
                MAX(json_extract(detail, '$.i') = ?2) AS i,
                MAX(json_extract(detail, '$.u') = ?3) AS u,
                MAX(bucket = ?4 AND last_at < ?5) AS stale
           FROM security_events
          WHERE actor_id = ?6 AND kind = 'enumeration_suspected' AND code = ?7 AND last_at >= ?8`
      )
      .bind(fp.s, fp.i, fp.u, bucket, hourStart, user.id, OWNER_COST_NEW_CONTEXT, cutoff)
      .first();
  } catch (e) {
    if (!isMissingTable(e)) console.error('security context not read:', e instanceof Error ? e.name : 'unknown');
    return;
  }
  const unseen: Array<'session' | 'ip' | 'ua'> = [];
  if (fp.s && !seen?.s) unseen.push('session');
  if (fp.i && !seen?.i) unseen.push('ip');
  if (fp.u && !seen?.u) unseen.push('ua');
  if (unseen.length === 0) {
    // Known in every part: keep the triple's row fresh, at most once an hour.
    if (seen?.stale) {
      await db
        .prepare('UPDATE security_events SET count = count + 1, last_at = ? WHERE bucket = ? AND last_at < ?')
        .bind(now.toISOString(), bucket, hourStart)
        .run()
        .catch(() => undefined);
    }
    return;
  }
  const row = await rowFor(
    c,
    { kind: 'enumeration_suspected', code: OWNER_COST_NEW_CONTEXT, status: c.res.status, detail: { new: unseen, s: fp.s || undefined, i: fp.i || undefined, u: fp.u || undefined } },
    now,
    bucket
  );
  if (!row) return;
  const wrote = await writeRow(db, row, now);
  if (wrote === 'skipped') return;
  await ringOwner(db, user.id, triple, now);
}

async function ringOwner(db: D1Database, ownerId: string, triple: string, now: Date): Promise<void> {
  const day = baghdadDay(now.getTime());
  try {
    const today = await db
      .prepare("SELECT COUNT(*) AS n FROM user_notifications WHERE user_id = ? AND kind = 'security_alert' AND event_key LIKE ?")
      .bind(ownerId, `security_alert:${day}:%`)
      .first<{ n: number }>();
    if (Number(today?.n ?? 0) >= DAILY_BELL_CAP) return;
  } catch {
    return;
  }
  await notify(db, {
    userId: ownerId,
    kind: 'security_alert',
    title_ar: SECURITY_ALERT_NOTICE.title.ar,
    title_en: SECURITY_ALERT_NOTICE.title.en,
    body_ar: SECURITY_ALERT_NOTICE.body.ar,
    body_en: SECURITY_ALERT_NOTICE.body.en,
    link: '/settings',
    meta: { title_ckb: SECURITY_ALERT_NOTICE.title.ckb, body_ckb: SECURITY_ALERT_NOTICE.body.ckb, reason: 'owner_cost_new_context' },
    eventKey: `security_alert:${day}:${triple}`,
  });
}

// ------------------------------------------------------------- the door

/**
 * Mounted on `/api/admin/*` in worker/index.ts, before every admin router. It
 * lets the request run, then reads the answer: a refusal `classifyRefusal`
 * names is recorded; a 2xx on a cost path for the verified owner is checked
 * for a new context. Changes nothing in the answer.
 */
export const securityEventsDoor: MiddlewareHandler<AppContext> = async (c, next) => {
  await next();
  try {
    const user = c.get('user') ?? null;
    const status = c.res.status;
    const err = c.error;
    const code = err instanceof HttpError ? err.code : undefined;
    const path = c.req.path;
    if (status >= 400) {
      const ownerSession = !!user && user.role === 'admin' && isOwner(c.env, user);
      const ev = classifyRefusal({ path, status, code, ownerSession, bucket: rateLimitedBucket(c) });
      if (!ev) return;
      if (probeExempt(c.env, user)) return;
      const now = new Date();
      const row = await rowFor(c, { ...ev, status }, now);
      if (!row) return;
      await settle(c, () => writeRow(c.env.DB, row, now));
      return;
    }
    if (status >= 200 && status < 300 && user && user.role === 'admin' && isOwner(c.env, user) && !isUnverifiedOwner(c.env, user) && isCostPath(path)) {
      const now = new Date();
      await settle(c, () => checkOwnerCostContext(c, user, now));
    }
  } catch {
    /* never in the way */
  }
};
