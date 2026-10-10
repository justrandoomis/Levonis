/**
 * THE OWNER'S SECURITY LOG — FX programme plan §14.2 S7, push 1s: the
 * `security_events` writer (worker/lib/securityEvents.ts) on 0177's table.
 *
 *   refusals     a cost door's 401 / 403 FORBIDDEN / COST_ACCESS_DENIED /
 *                OWNER_EMAIL_UNVERIFIED; a 429 on the pricing and FX buckets
 *                (the bucket named, the 429 body unchanged); the owner's
 *                freshness refusal (REAUTH_REQUIRED)
 *   guard        every FX guard-setting change: the pair, the act code and
 *                field NAMES — never a value; a non-guard change is not one
 *   context      an owner cost request from a session, network or browser not
 *                seen in 30 days: a row and one bell with no figure; the same
 *                context again is silent; bounded bells
 *   bounded      one row per (actor, route, hour), `count` for the repeats;
 *                past DAILY_ROW_CAP, one overflow row per kind; a row untouched
 *                for RETENTION_DAYS goes, PRUNE_PER_WRITE at most per write
 *   probes       only a SIGNED-IN registered probe account is exempt — a forged
 *                probe user agent still records the event
 *   privacy      ids and codes only: no address, no user agent, no session id,
 *                no query string, no figure
 *   never in the way   a database behind 0177 answers exactly as before
 *
 * Run: node --import tsx --test tests/securityEvents.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import type { AppContext } from '../worker/lib/types';
import { adminPricingRoutes } from '../worker/routes/adminPricing';
import { requireAdmin } from '../worker/lib/http';
import { requireCostRead } from '../worker/lib/costAccess';
import { rateLimitKey } from '../worker/lib/ratelimit';
import { baghdadDay } from '../worker/lib/baghdadTime';
import {
  CONTEXT_WINDOW_DAYS,
  COST_PATH_PREFIXES,
  DAILY_BELL_CAP,
  DAILY_ROW_CAP,
  FX_GUARD_CHANGED,
  OWNER_COST_NEW_CONTEXT,
  PRUNE_PER_WRITE,
  RETENTION_DAYS,
  SECURITY_ALERT_NOTICE,
  SECURITY_EVENT_KINDS,
  classifyRefusal,
  cleanDetail,
  ipNetwork,
  isCostPath,
  probeExempt,
  securityEventsDoor,
  targetOf,
} from '../worker/lib/securityEvents';
import { OWNER, all, asD1, dbThrough, freshDb, get, json, pending, put, post, row, stubApp, type StubUser } from './fixtures/app';
import { OWNER_ROW_SQL, pairOf } from './fixtures/fx';
import { codeOf } from './fixtures/source';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';

const BASE = '/api/admin/pricing';
const PROBE_UA = 'levonis-live-cost-probes/1 (read-only)';

/** A cost router of our own on a cost prefix, and a non-cost admin router — both answer 200. */
const costish = new Hono<AppContext>();
costish.use('*', requireAdmin, requireCostRead);
costish.get('/ping', (c) => c.json({ ok: true }));
const plain = new Hono<AppContext>();
plain.use('*', requireAdmin);
plain.get('/ping', (c) => c.json({ ok: true }));

function world(opts: { user?: StubUser | null; raw?: DatabaseSync; env?: Record<string, unknown>; sessionAgeSeconds?: number; sessionId?: string; door?: boolean } = {}) {
  const raw = opts.raw ?? freshDb();
  if (!opts.raw) raw.exec(OWNER_ROW_SQL);
  const app = stubApp(
    asD1(raw),
    opts.user === undefined ? OWNER : opts.user,
    (a) => {
      if (opts.sessionId) {
        const sid = opts.sessionId;
        a.use('*', async (c, next) => {
          c.set('sessionId', sid);
          await next();
        });
      }
      if (opts.door !== false) a.use('/api/admin/*', securityEventsDoor);
      a.route(BASE, adminPricingRoutes);
      a.route('/api/admin/invest', costish);
      a.route('/api/admin/other', plain);
    },
    { sessionAgeSeconds: opts.sessionAgeSeconds ?? 0, env: opts.env }
  );
  return { raw, app };
}

/** Lets every write the door handed to waitUntil land. */
const drain = async () => {
  while (pending.length) await Promise.all(pending.splice(0));
};
type Ev = { id: string; bucket: string; kind: string; code: string; actor_id: string | null; actor_class: string; ip_hash: string; method: string; route: string; target_id: string | null; status: number; count: number; first_at: string; last_at: string; detail: string };
const events = (raw: DatabaseSync, kind?: string) =>
  kind ? all<Ev>(raw, 'SELECT * FROM security_events WHERE kind = ? ORDER BY first_at, id', kind) : all<Ev>(raw, 'SELECT * FROM security_events ORDER BY first_at, id');
const bells = (raw: DatabaseSync) =>
  all<{ title_ar: string; title_en: string; body_ar: string; body_en: string; meta: string; link: string; event_key: string }>(
    raw,
    "SELECT * FROM user_notifications WHERE user_id = 'usr_owner' AND kind = 'security_alert' ORDER BY created_at, id"
  );

const ASSISTANT: StubUser = { id: 'usr_asst', role: 'admin', email: 'asst@x.co', admin_scope: 'assistant' };
const FULL: StubUser = { id: 'usr_full', role: 'admin', email: 'full@x.co', admin_scope: 'full' };
const CUSTOMER: StubUser = { id: 'usr_cust', role: 'customer', email: 'cust@x.co' };

// ------------------------------------------------------------- refusals

test('a guest at a cost door: cost_denied UNAUTHORIZED 401 — the route PATTERN, the :id, a day-salted address hash; no address, no query', async () => {
  const { raw, app } = world({ user: null });
  const res = await get(app, `${BASE}/products/prd_secret1?note=private-thing`, { 'CF-Connecting-IP': '9.8.7.6' });
  assert.equal(res.status, 401);
  await drain();
  const [e, ...rest] = events(raw);
  assert.equal(rest.length, 0);
  assert.equal(e!.kind, 'cost_denied');
  assert.equal(e!.code, 'UNAUTHORIZED');
  assert.equal(e!.actor_id, null);
  assert.equal(e!.actor_class, 'guest');
  assert.equal(e!.method, 'GET');
  assert.equal(e!.route, `${BASE}/products/:id`);
  assert.equal(e!.target_id, 'prd_secret1');
  assert.equal(e!.status, 401);
  assert.match(e!.ip_hash, /^[0-9a-f]{16}$/);
  assert.equal(e!.detail, '{}');
  const text = JSON.stringify(e);
  assert.doesNotMatch(text, /9\.8\.7\.6|private-thing|note=/);
});

test('a forged probe user agent still records the event — anonymous, or signed in as an account the owner never registered', async () => {
  const registered = { SECURITY_PROBE_USER_IDS: 'usr_probe' };
  for (const [user, env] of [
    [null, undefined],
    [null, registered],
    [CUSTOMER, registered],
  ] as const) {
    const { raw, app } = world({ user: user as StubUser | null, env: env as Record<string, unknown> | undefined });
    const res = await get(app, `${BASE}/rates`, { 'user-agent': PROBE_UA });
    assert.ok(res.status === 401 || res.status === 403);
    await drain();
    const evs = events(raw);
    assert.equal(evs.length, 1, `recorded for ${user ? user.id : 'a guest'}`);
    assert.equal(evs[0]!.kind, 'cost_denied');
    assert.doesNotMatch(JSON.stringify(evs[0]), /levonis-live-cost-probes/);
  }
});

test('only a SIGNED-IN registered probe account is exempt — never a guest, never the owner', () => {
  const env = { SECURITY_PROBE_USER_IDS: ' usr_probe , usr_probe2 ', INITIAL_ADMIN_EMAIL: 'boss@x.co' };
  assert.equal(probeExempt(env, { id: 'usr_probe', email: 'p@x.co' }), true);
  assert.equal(probeExempt(env, { id: 'usr_probe2', email: 'p2@x.co' }), true);
  assert.equal(probeExempt(env, null), false, 'a guest is never exempt');
  assert.equal(probeExempt(env, { id: 'usr_other', email: 'o@x.co' }), false);
  assert.equal(probeExempt({ ...env, SECURITY_PROBE_USER_IDS: 'usr_owner' }, { id: 'usr_owner', email: 'BOSS@x.co ' }), false, 'the owner is never exempt');
  assert.equal(probeExempt({ INITIAL_ADMIN_EMAIL: 'boss@x.co' }, { id: 'usr_probe', email: 'p@x.co' }), false, 'nothing registered: nobody exempt');
});

test('a registered probe account signed in is not recorded; everyone else at the door is, by role', async () => {
  const env = { SECURITY_PROBE_USER_IDS: 'usr_probe' };
  const probe = world({ user: { id: 'usr_probe', role: 'customer', email: 'probe@x.co' }, env });
  assert.equal((await get(probe.app, `${BASE}/rates`)).status, 403);
  await drain();
  assert.equal(events(probe.raw).length, 0);

  for (const [user, status, code, cls] of [
    [CUSTOMER, 403, 'FORBIDDEN', 'customer'],
    [ASSISTANT, 403, 'COST_ACCESS_DENIED', 'assistant_admin'],
    [FULL, 403, 'COST_ACCESS_DENIED', 'full_admin'],
    [{ ...OWNER, email_verified_at: null }, 403, 'OWNER_EMAIL_UNVERIFIED', 'owner'],
  ] as const) {
    const { raw, app } = world({ user: user as StubUser, env });
    const res = await get(app, `${BASE}/rates`);
    assert.equal(res.status, status);
    assert.equal((await json(res)).code, code);
    await drain();
    const evs = events(raw);
    assert.equal(evs.length, 1, user.id);
    assert.deepEqual([evs[0]!.kind, evs[0]!.code, evs[0]!.actor_id, evs[0]!.actor_class], ['cost_denied', code, user.id, cls]);
  }
});

test('the door changes nothing in the answer: the same bytes with and without it', async () => {
  for (const user of [null, CUSTOMER, ASSISTANT] as const) {
    const a = world({ user: user as StubUser | null });
    const b = world({ user: user as StubUser | null, door: false });
    const ra = await get(a.app, `${BASE}/rates`);
    const rb = await get(b.app, `${BASE}/rates`);
    assert.equal(ra.status, rb.status);
    assert.equal(await ra.text(), await rb.text());
    assert.equal(ra.headers.get('cache-control'), rb.headers.get('cache-control'));
  }
  await drain();
});

test('a COST_ACCESS_DENIED anywhere is recorded; a 401 / 403 FORBIDDEN outside a cost router is not', async () => {
  const { raw, app } = world({ user: null });
  assert.equal((await get(app, '/api/admin/other/ping')).status, 401);
  await drain();
  assert.equal(events(raw).length, 0, 'a guest at a non-cost admin route is not a cost refusal');
  const cust = world({ user: CUSTOMER });
  assert.equal((await get(cust.app, '/api/admin/other/ping')).status, 403);
  await drain();
  assert.equal(events(cust.raw).length, 0);
  assert.deepEqual(classifyRefusal({ path: '/api/admin/products-v2/x', status: 403, code: 'COST_ACCESS_DENIED', ownerSession: false, bucket: null }), { kind: 'cost_denied', code: 'COST_ACCESS_DENIED' });
});

test('dedupe per (actor, route, hour): a repeat counts; another route or another actor is another row', async () => {
  const { raw, app } = world({ user: ASSISTANT });
  for (let i = 0; i < 3; i++) await get(app, `${BASE}/rates`);
  await get(app, `${BASE}/overview`);
  await drain();
  const evs = events(raw);
  assert.equal(evs.length, 2);
  const rates = evs.find((e) => e.route === `${BASE}/rates`)!;
  assert.equal(rates.count, 3);
  assert.match(rates.bucket, /\|\d{4}-\d{2}-\d{2}T\d{2}$/, 'the bucket ends with the UTC hour');
  const guest = world({ user: null, raw });
  await get(guest.app, `${BASE}/rates`, { 'CF-Connecting-IP': '5.5.5.5' });
  await get(guest.app, `${BASE}/rates`, { 'CF-Connecting-IP': '6.6.6.6' });
  await get(guest.app, `${BASE}/rates`, { 'CF-Connecting-IP': '6.6.6.6' });
  await drain();
  const guests = events(raw).filter((e) => e.actor_class === 'guest');
  assert.deepEqual(guests.map((e) => e.count).sort(), [1, 2], "one guest's tries group by its day-salted hash");
});

test(`bounded: past ${DAILY_ROW_CAP} rows in 24 hours a new event lands in ONE overflow row per kind; a known bucket still counts`, async () => {
  const { raw, app } = world({ user: ASSISTANT });
  await get(app, `${BASE}/rates`);
  await drain();
  raw.exec('BEGIN');
  const st = raw.prepare("INSERT INTO security_events (id, bucket, kind, code, actor_class, method, route, status) VALUES (?, ?, 'cost_denied', 'X', 'guest', 'GET', '/x', 403)");
  for (let i = 0; i < DAILY_ROW_CAP; i++) st.run(`sev_fill${i}`, `fill|${i}`);
  raw.exec('COMMIT');
  await get(app, `${BASE}/rates`);
  await get(app, `${BASE}/overview`);
  await get(app, `${BASE}/products/prd_1`);
  await drain();
  assert.equal(events(raw).length, DAILY_ROW_CAP + 2, 'the known row plus one overflow row');
  assert.equal(events(raw).find((e) => e.route === `${BASE}/rates`)!.count, 2, 'a known bucket still counts');
  const overflow = row<Ev>(raw, "SELECT * FROM security_events WHERE code = 'OVERFLOW'")!;
  assert.equal(overflow.bucket, `overflow|cost_denied|${baghdadDay(Date.now())}`);
  assert.equal(overflow.count, 2);
  assert.equal(overflow.actor_id, null);
});

test(`bounded in time: a row untouched for ${RETENTION_DAYS} days goes, at most ${PRUNE_PER_WRITE} with each write — a remembered owner context and a recent row stay`, async () => {
  const { raw, app } = world({ user: ASSISTANT });
  const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  raw.exec('BEGIN');
  const st = raw.prepare(
    "INSERT INTO security_events (id, bucket, kind, code, actor_class, method, route, status, first_at, last_at) VALUES (?, ?, 'cost_denied', 'X', 'guest', 'GET', '/x', 403, ?, ?)"
  );
  const expired = PRUNE_PER_WRITE + 4;
  for (let i = 0; i < expired; i++) st.run(`sev_old${i}`, `old|${i}`, ago(RETENTION_DAYS + 1 + i), ago(RETENTION_DAYS + 1 + i));
  st.run('sev_recent', 'recent|1', ago(RETENTION_DAYS - 1), ago(RETENTION_DAYS - 1));
  raw.exec('COMMIT');
  raw
    .prepare(
      "INSERT INTO security_events (id, bucket, kind, code, actor_id, actor_class, method, route, status, first_at, last_at) VALUES ('sev_ctx', 'ctx|1', 'enumeration_suspected', ?, 'usr_owner', 'owner', 'GET', '/y', 200, ?, ?)"
    )
    .run(OWNER_COST_NEW_CONTEXT, ago(CONTEXT_WINDOW_DAYS - 1), ago(CONTEXT_WINDOW_DAYS - 1));
  const left = () => all<{ id: string }>(raw, "SELECT id FROM security_events WHERE id LIKE 'sev_old%' ORDER BY last_at").map((r) => r.id);

  await get(app, `${BASE}/rates`);
  await drain();
  assert.equal(left().length, expired - PRUNE_PER_WRITE, 'one write drops at most PRUNE_PER_WRITE expired rows');
  assert.ok(left().every((id) => Number(id.slice('sev_old'.length)) < expired - PRUNE_PER_WRITE), 'the oldest go first');

  await get(app, `${BASE}/overview`);
  await drain();
  assert.equal(left().length, 0, 'the next write takes the rest');
  assert.ok(row(raw, "SELECT 1 AS x FROM security_events WHERE id = 'sev_recent'"), `a row touched within ${RETENTION_DAYS} days stays`);
  assert.ok(row(raw, "SELECT 1 AS x FROM security_events WHERE id = 'sev_ctx'"), 'a remembered owner context stays');
  assert.equal(events(raw).filter((e) => e.route.startsWith(BASE)).length, 2, 'the events themselves are written');
  assert.ok(RETENTION_DAYS > CONTEXT_WINDOW_DAYS, 'the retention outlives the context memory');
  assert.ok(PRUNE_PER_WRITE > 1, 'a write drops more than it adds');
});

test('a 429 on the pricing bucket: rate_limited with the bucket NAME, the 429 body unchanged; the FX refresh bucket too', async () => {
  const { raw, app } = world();
  const now = Math.floor(Date.now() / 1000);
  raw.prepare('INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1200)').run(rateLimitKey('pricing-read', 'usr_owner', '1.2.3.4'), now - (now % 3600));
  const res = await get(app, `${BASE}/rates`);
  assert.equal(res.status, 429);
  const body = await res.text();
  assert.doesNotMatch(body, /pricing-read|bucket/);
  await drain();
  const [e] = events(raw, 'rate_limited');
  assert.equal(e!.code, 'RATE_LIMITED');
  assert.equal(e!.status, 429);
  assert.deepEqual(JSON.parse(e!.detail), { bucket: 'pricing-read' });

  const fx = world();
  fx.raw.prepare('INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 10)').run(rateLimitKey('fx-refresh', 'usr_owner', '1.2.3.4'), now - (now % 3600));
  assert.equal((await post(fx.app, `${BASE}/rates/fx/refresh`, {})).status, 429);
  await drain();
  assert.deepEqual(JSON.parse(events(fx.raw, 'rate_limited')[0]!.detail), { bucket: 'fx-refresh' });
  assert.equal(classifyRefusal({ path: '/api/admin/finance/x', status: 429, code: 'RATE_LIMITED', ownerSession: true, bucket: 'finance-read' }), null, 'another bucket is not one of these');
});

test("the owner's freshness refusal is recorded: owner_denied REAUTH_REQUIRED", async () => {
  const { raw, app } = world({ sessionAgeSeconds: 11 * 60 });
  const res = await put(app, `${BASE}/rates/fx/USD_IQD/settings`, { owner_version: Number(pairOf(raw, 'USD_IQD').owner_version), anomaly_threshold_pct: '4' });
  assert.equal(res.status, 401);
  assert.equal((await json(res)).code, 'REAUTH_REQUIRED');
  await drain();
  const [e] = events(raw, 'owner_denied');
  assert.deepEqual([e!.code, e!.actor_id, e!.actor_class, e!.status, e!.method], ['REAUTH_REQUIRED', 'usr_owner', 'owner', 401, 'PUT']);
  assert.equal(e!.target_id, 'USD_IQD');
  assert.equal(events(raw, 'scope_changed').length, 0, 'nothing changed');
});

test('every FX guard-setting change is recorded: scope_changed FX_GUARD_CHANGED, the pair, the act and field NAMES — never a value', async () => {
  const { raw, app } = world();
  const ok = await put(app, `${BASE}/rates/fx/USD_IQD/settings`, { owner_version: Number(pairOf(raw, 'USD_IQD').owner_version), anomaly_threshold_pct: '4', drift_threshold_pct: '8' });
  assert.equal(ok.status, 200);
  await drain();
  const [e, ...rest] = events(raw, 'scope_changed');
  assert.equal(rest.length, 0);
  assert.equal(e!.code, FX_GUARD_CHANGED);
  assert.deepEqual(JSON.parse(e!.detail), { pair: 'USD_IQD', act: 'fx.settings.update', fields: ['anomaly_threshold_pct', 'drift_threshold_pct'] });
  assert.doesNotMatch(e!.detail, /\d/, 'no figure');

  // The adjustment moves a rate but is not a guard setting (owner decision 5): no guard row.
  const adj = world();
  const moved = await put(adj.app, `${BASE}/rates/fx/USD_IQD/settings`, { owner_version: Number(pairOf(adj.raw, 'USD_IQD').owner_version), market_adjustment_iqd: '20' });
  assert.equal(moved.status, 200);
  await drain();
  assert.equal(events(adj.raw, 'scope_changed').length, 0);
});

// ------------------------------------------------------------- the owner's context

test('an owner cost request from a new session, network or browser: one row and one bell with no figure; the same context again is silent', async () => {
  const raw = freshDb();
  raw.exec(OWNER_ROW_SQL);
  const at = (sessionId: string) => world({ raw, sessionId }).app;
  const read = async (sessionId: string, ip: string, ua: string) => {
    const res = await get(at(sessionId), `${BASE}/rates`, { 'CF-Connecting-IP': ip, 'User-Agent': ua });
    assert.equal(res.status, 200);
    await drain();
  };
  const ctxRows = () => events(raw, 'enumeration_suspected');

  await read('sess-A', '1.2.3.4', 'Browser-A');
  assert.equal(ctxRows().length, 1);
  const first = ctxRows()[0]!;
  assert.equal(first.code, OWNER_COST_NEW_CONTEXT);
  assert.equal(first.actor_id, 'usr_owner');
  assert.deepEqual(JSON.parse(first.detail).new, ['session', 'ip', 'ua'], 'nothing was seen before');
  assert.equal(bells(raw).length, 1);

  await read('sess-A', '1.2.3.4', 'Browser-A');
  await read('sess-A', '1.2.3.200', 'Browser-A');
  assert.equal(ctxRows().length, 1, 'the same context — and the same /24 network — is known');
  assert.equal(ctxRows()[0]!.count, 1, 'touched at most once an hour');
  assert.equal(bells(raw).length, 1);

  await read('sess-A', '5.6.7.8', 'Browser-A');
  assert.deepEqual(JSON.parse(ctxRows().at(-1)!.detail).new, ['ip']);
  await read('sess-A', '1.2.3.4', 'Browser-B');
  assert.deepEqual(JSON.parse(ctxRows().at(-1)!.detail).new, ['ua']);
  await read('sess-B', '1.2.3.4', 'Browser-A');
  assert.deepEqual(JSON.parse(ctxRows().at(-1)!.detail).new, ['session'], 'a stolen cookie is a known session — its new network and browser ring; a new sign-in rings too');
  assert.equal(ctxRows().length, 4);
  assert.equal(bells(raw).length, 4);

  for (const b of bells(raw)) {
    const meta = JSON.parse(b.meta) as Record<string, string>;
    for (const text of [b.title_ar, b.title_en, b.body_ar, b.body_en, meta.title_ckb, meta.body_ckb]) {
      assert.ok(text && text.length > 0);
      assert.doesNotMatch(text!, /[0-9٠-٩۰-۹]/, 'no figure, no digit at all');
    }
    assert.equal(b.link, '/settings');
    assert.equal(meta.reason, 'owner_cost_new_context');
  }
  assert.equal(bells(raw)[0]!.title_ar, SECURITY_ALERT_NOTICE.title.ar);

  // Privacy: fingerprints only — never the address, the browser string or the session id.
  const text = JSON.stringify(events(raw));
  assert.doesNotMatch(text, /1\.2\.3\.4|5\.6\.7\.8|Browser-A|Browser-B|sess-A|sess-B/);
  for (const e of ctxRows()) {
    const d = JSON.parse(e.detail) as Record<string, string>;
    for (const k of ['s', 'i', 'u']) assert.match(d[k]!, /^[0-9a-f]{16}$/);
  }
});

test('the 30-day window: a context last seen 31 days ago is new again; an hour-old one is touched, not rung', async () => {
  const raw = freshDb();
  raw.exec(OWNER_ROW_SQL);
  const read = async () => {
    await get(world({ raw, sessionId: 'sess-A' }).app, `${BASE}/rates`, { 'CF-Connecting-IP': '1.2.3.4', 'User-Agent': 'Browser-A' });
    await drain();
  };
  await read();
  const ctx = () => events(raw, 'enumeration_suspected');
  raw.prepare('UPDATE security_events SET last_at = ?').run(new Date(Date.now() - 2 * 3_600_000).toISOString());
  await read();
  assert.equal(ctx()[0]!.count, 2, 'known, an hour later: touched');
  assert.equal(bells(raw).length, 1);
  raw.prepare('UPDATE security_events SET last_at = ?').run(new Date(Date.now() - 31 * 86_400_000).toISOString());
  await read();
  assert.equal(ctx().length, 1, 'the same triple keeps its one row');
  assert.equal(ctx()[0]!.count, 3, 'seen again after the window: an event again');
  assert.ok(Date.parse(ctx()[0]!.last_at) > Date.now() - 60_000);
});

test(`at most ${DAILY_BELL_CAP} security bells a day — the rows are written regardless`, async () => {
  const raw = freshDb();
  raw.exec(OWNER_ROW_SQL);
  for (let i = 0; i < DAILY_BELL_CAP + 2; i++) {
    await get(world({ raw, sessionId: `sess-${i}` }).app, `${BASE}/rates`, { 'User-Agent': 'Browser-A' });
    await drain();
  }
  assert.equal(events(raw, 'enumeration_suspected').length, DAILY_BELL_CAP + 2);
  assert.equal(bells(raw).length, DAILY_BELL_CAP);
});

test('no context check outside a cost path, for a non-owner, for the unverified owner, or on a refusal', async () => {
  const raw = freshDb();
  raw.exec(OWNER_ROW_SQL);
  assert.equal((await get(world({ raw }).app, '/api/admin/other/ping')).status, 200);
  await drain();
  assert.equal(events(raw).length, 0, 'a non-cost admin route');
  assert.equal((await get(world({ raw }).app, '/api/admin/invest/ping')).status, 200);
  await drain();
  assert.equal(events(raw, 'enumeration_suspected').length, 1, 'any cost path, not only the pricing router');
  const unverified = world({ user: { ...OWNER, email_verified_at: null } });
  await get(unverified.app, `${BASE}/rates`);
  await drain();
  assert.equal(events(unverified.raw, 'enumeration_suspected').length, 0);
  assert.equal(events(unverified.raw, 'cost_denied').length, 1);
});

test('never in the way: a database behind 0177 answers exactly as before, and nothing throws', async () => {
  const raw = dbThrough('0176');
  raw.exec(OWNER_ROW_SQL);
  for (const user of [null, ASSISTANT]) {
    const a = world({ raw, user: user as StubUser | null });
    const b = world({ raw, user: user as StubUser | null, door: false });
    const ra = await get(a.app, `${BASE}/rates`);
    const rb = await get(b.app, `${BASE}/rates`);
    assert.equal(ra.status, rb.status);
    assert.equal(await ra.text(), await rb.text());
  }
  const owner = await get(world({ raw }).app, '/api/admin/invest/ping');
  assert.equal(owner.status, 200, "the owner's context check meets no table and steps aside");
  await drain();
  assert.equal(row(raw, "SELECT 1 AS x FROM sqlite_master WHERE name = 'security_events'"), undefined);
});

// ------------------------------------------------------------- pure parts and the wiring

test('the pure parts: networks, targets, the detail allow-list, the refusal classes', () => {
  assert.equal(ipNetwork('1.2.3.4'), '1.2.3.0/24');
  assert.equal(ipNetwork('2a02:ab8:1:2::5'), '2a02:ab8:1::/48');
  assert.equal(ipNetwork('2a02:0ab8:0001:0002:0:0:0:5'), '2a02:ab8:1::/48');
  assert.equal(ipNetwork('::1'), '0:0:0::/48');
  assert.equal(ipNetwork('unknown'), '');
  assert.equal(ipNetwork(''), '');
  assert.equal(targetOf('/api/admin/pricing/products/:id', '/api/admin/pricing/products/prd_9'), 'prd_9');
  assert.equal(targetOf('/api/admin/pricing/products/:id', '/api/admin/pricing/products/%3Cscript%3E'), null);
  assert.equal(targetOf('/api/admin/pricing/rates', '/api/admin/pricing/rates'), null);
  assert.equal(
    cleanDetail({ bucket: 'pricing-read', pair: '1660.5', fields: ['anomaly_threshold_pct', '37.25', 'x y'], new: ['ip', 'ip'], s: 'abc', ...({ rate: '1660' } as object) }),
    JSON.stringify({ bucket: 'pricing-read', fields: ['anomaly_threshold_pct'], new: ['ip'] })
  );
  // The deception layer's keys (DECISIONS row 206): codes, a reference, a 10-hex batch and a 16-hex tag — never a figure, an address or a token.
  assert.equal(
    cleanDetail({ decoy: 'env', sig: 'DECOY_HIT', ex: 'owner', intent: 'tool', ref: 'LV-081NKX90', cc: 'IQ', asn: 'AS50710', batch: '602d0f176a', d: '020359f52088dc83' }),
    JSON.stringify({ decoy: 'env', sig: 'DECOY_HIT', ex: 'owner', intent: 'tool', ref: 'LV-081NKX90', cc: 'IQ', asn: 'AS50710', d: '020359f52088dc83', batch: '602d0f176a' })
  );
  assert.equal(
    cleanDetail({ decoy: '9.9.9.9', sig: 'lvk_live_602d0f176a8b52e5a098d76a847b26ac', ex: 'Lv-602d0f176a-c4bb93e0be', ref: 'lvk_live_602d0f176a8b52e5a098d76a847b26ac', batch: 'ZZ', d: 'Lv-602d0f176a-c4bb93e0be', cc: '203.0.113.7', asn: '1660' }),
    '{}'
  );
  const cls = (path: string, status: number, code: string | undefined, ownerSession = false, bucket: string | null = null) => classifyRefusal({ path, status, code, ownerSession, bucket });
  assert.equal(cls(`${BASE}/rates`, 401, 'UNAUTHORIZED')?.kind, 'cost_denied');
  assert.equal(cls(`${BASE}/rates`, 403, 'FORBIDDEN')?.kind, 'cost_denied');
  assert.equal(cls('/api/admin/users', 401, 'UNAUTHORIZED'), null);
  assert.equal(cls(`${BASE}/rates`, 401, 'REAUTH_REQUIRED', true)?.kind, 'owner_denied');
  assert.equal(cls('/api/admin/users/x', 401, 'REAUTH_REQUIRED', false)?.kind, 'admin_denied');
  assert.equal(cls(`${BASE}/rates`, 409, 'PRICING_CHANGED'), null);
  assert.equal(cls(`${BASE}/rates`, 404, 'NOT_FOUND'), null);
  for (const k of ['cost_denied', 'rate_limited', 'owner_denied', 'admin_denied', 'scope_changed', 'enumeration_suspected']) {
    assert.ok((SECURITY_EVENT_KINDS as readonly string[]).includes(k));
  }
});

test("the kinds are 0177's CHECK list, verbatim", () => {
  const sql = readFileSync(join(ROOT, 'migrations/0177_cost_access_security.sql'), 'utf8');
  const m = /kind\s+TEXT NOT NULL CHECK \(kind IN \(([\s\S]*?)\)\)/.exec(sql);
  assert.ok(m);
  const kinds = [...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
  assert.deepEqual(kinds, [...SECURITY_EVENT_KINDS]);
});

test('worker/index.ts mounts the door on /api/admin/* above every admin router, and every cost router sits on a cost path', () => {
  const src = codeOf('worker/index.ts');
  const door = src.indexOf("app.use('/api/admin/*', securityEventsDoor);");
  assert.ok(door > 0, 'the door is mounted');
  const firstAdmin = src.search(/app\.route\('\/api\/admin/);
  assert.ok(firstAdmin > door, 'above the first admin router');
  const cost = new Set(['adminFinanceRoutes', 'adminFinanceReportRoutes', 'adminFinanceWorkspaceRoutes', 'adminFinancePeopleRoutes', 'adminFinanceOperationsRoutes', 'adminPricingRoutes', 'adminPrintQuoteRoutes']);
  const mounted = [...src.matchAll(/app\.route\('([^']+)',\s*(\w+)\)/g)].filter((m) => cost.has(m[2]!));
  assert.equal(new Set(mounted.map((m) => m[2])).size, cost.size, 'every cost router is mounted');
  for (const m of mounted) assert.ok(isCostPath(`${m[1]}/anything`), `${m[2]} at ${m[1]}`);
  assert.ok(isCostPath('/api/admin/investment-finance/profiles/x') && isCostPath('/api/admin/investment-finance/legacy'));
  assert.equal(isCostPath('/api/admin/pricing-other'), false, 'a prefix is a path segment');
  assert.ok(COST_PATH_PREFIXES.every((p) => p.startsWith('/api/admin/')));
});
