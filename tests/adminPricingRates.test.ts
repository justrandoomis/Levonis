/**
 * THE OWNER'S RATES ROUTES (FX programme plan §8, §14.1; critiques F3, F4, L3).
 *
 *   DTO          GET /rates is an allow-list, built field by field; the key is a
 *                boolean, never the key; `effective_rates_iqd`, not the wage name
 *   bodies       strict allow-lists: an extra key — a server-computed one by
 *                name, `__proto__`, `constructor` — is 400 UNKNOWN_FIELD; a bad
 *                value is PRICING_INPUT_INVALID naming the field, never the value
 *   fences       a stale owner_version is 409 PRICING_CHANGED — and a routine
 *                scheduler check in between is NOT (L3)
 *   limits       both refresh buckets (10 an hour, 40 a day), charged by the
 *                refresh AND by a return to automatic (F4)
 *   fresh        guard settings, mode, interval and «تأكيد السعر الحالي» need a
 *                sign-in within 10 minutes; 13% manual sets in 24 h — the act
 *                being made counts, so the second needs it AND
 *                confirm_large_change (F3; FX-1 review C3)
 *   door         401 / 403 FORBIDDEN / 403 COST_ACCESS_DENIED; private,
 *                no-store on every answer; a cross-origin write refused
 *   install      a database without 0179: 503 PRICING_NOT_INSTALLED for the owner
 *
 * Run: node --import tsx --test tests/adminPricingRates.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import worker from '../worker/index';
import { APEX, OWNER, asD1, ctx, dbThrough, freshDb, get, json, post, providerFetch, put, stubApp, type StubUser } from './fixtures/app';
import { OWNER_ROW_SQL, applyRate, derivedOf, ecbBody, iqwealthBody, pairOf, fxEnv, fakeProviders } from './fixtures/fx';
import { adminPricingRoutes } from '../worker/routes/adminPricing';
import { runFxScheduler } from '../worker/lib/fx/scheduler';
import { rateLimitKey } from '../worker/lib/ratelimit';

const BASE = '/api/admin/pricing';
const FRESH = 0;
const STALE = 11 * 60;

function world(opts: { sessionAgeSeconds?: number; user?: StubUser | null; raw?: DatabaseSync; env?: Record<string, unknown> } = {}) {
  const raw = opts.raw ?? freshDb();
  if (!opts.raw) raw.exec(OWNER_ROW_SQL);
  const app = stubApp(asD1(raw), opts.user === undefined ? OWNER : opts.user, (a) => a.route(BASE, adminPricingRoutes), {
    sessionAgeSeconds: opts.sessionAgeSeconds ?? FRESH,
    env: opts.env,
  });
  return { raw, app };
}
type App = ReturnType<typeof world>['app'];
const ownerVersion = (raw: DatabaseSync, pair = 'USD_IQD') => Number(pairOf(raw, pair as never).owner_version);
const rates = async (app: App) => json(await get(app, `${BASE}/rates`));

test('GET /rates: the allow-list DTO — exactly these keys, the key a boolean, effective_rates_iqd, budgets and counts', async () => {
  const { app } = world({ env: { IRAQ_PARALLEL_FX_API_KEY: 'iqw_live_0123456789abcdef' } });
  const res = await get(app, `${BASE}/rates`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  const b = await json(res);
  assert.deepEqual(Object.keys(b).sort(), ['effective_rates_iqd', 'engine_products', 'key_configured', 'pairs', 'provider_budget', 'refresh_budget', 'reprice_blocked', 'shipping', 'stale_products', 'success'].sort());
  assert.equal(b.key_configured, true);
  assert.doesNotMatch(JSON.stringify(b), /iqw_live/);
  assert.deepEqual(b.pairs.map((p: { pair: string }) => p.pair), ['USD_IQD', 'EUR_USD', 'CNY_USD']);
  assert.deepEqual(Object.keys(b.pairs[0]).sort(), [
    'anomaly_threshold_pct', 'attribution', 'bound_max', 'bound_min', 'drift_anchor_at', 'drift_anchor_rate',
    'drift_threshold_pct', 'effective_applied_at', 'effective_rate', 'effective_source', 'effective_version', 'failing_since', 'fetch_status',
    'formula_holds', 'interval_hours', 'last_check_result', 'last_checked_at', 'last_error_code', 'last_known_good_rate', 'last_observed', 'last_successful_at',
    'manual_rate', 'market_adjustment_iqd', 'market_buy', 'market_rate', 'min_change_pct', 'mode', 'next_check_at', 'official_rate', 'owner_version', 'pair', 'pending',
    'provider', 'published_at', 'rejected', 'status',
  ]);
  assert.deepEqual(b.pairs[0].attribution, { text: 'IQWealth', url: 'https://iraqsm.com' });
  assert.deepEqual(Object.keys(b.effective_rates_iqd).sort(), ['CNY', 'EUR', 'USD']);
  assert.equal('effective_iqd' in b, false, 'never the staff-wage name (F14c)');
  assert.deepEqual(b.shipping.map((s: { profile: string; basis: string }) => [s.profile, s.basis]), [['GERMANY_LAND', 'weight'], ['CHINA_AIR', 'weight'], ['CHINA_SEA', 'volume']]);
  assert.deepEqual(b.refresh_budget, { used_today: 0, limit: 40 });
  assert.deepEqual(b.provider_budget, { USD_IQD: { used_today: 0, cap: 150 } });
  assert.equal(b.engine_products, 0);
  const noKey = world();
  assert.equal((await rates(noKey.app)).key_configured, false);
});

test('a database without 0179: every rates route answers the owner 503 PRICING_NOT_INSTALLED', async () => {
  const raw = dbThrough('0177');
  raw.exec(OWNER_ROW_SQL);
  const { app } = world({ raw });
  for (const [method, path, body] of [
    ['GET', '/rates', undefined],
    ['GET', '/rates/history', undefined],
    ['PUT', '/rates/fx/USD_IQD/manual', { owner_version: 1, rate: '1650' }],
    ['POST', '/rates/fx/refresh', {}],
    ['PUT', '/rates/shipping/CHINA_AIR', { version: 1, rate_iqd: '9000' }],
  ] as const) {
    const res = method === 'GET' ? await get(app, `${BASE}${path}`) : method === 'PUT' ? await put(app, `${BASE}${path}`, body) : await post(app, `${BASE}${path}`, body);
    assert.equal(res.status, 503, `${method} ${path}`);
    assert.equal((await json(res)).code, 'PRICING_NOT_INSTALLED');
  }
});

test('the door: guest 401, a customer 403 FORBIDDEN, an assistant and a full admin 403 COST_ACCESS_DENIED — every answer private, no-store', async () => {
  for (const [user, status, code] of [
    [null, 401, 'UNAUTHORIZED'],
    [{ id: 'u1', role: 'customer', email: 's@x.co' }, 403, 'FORBIDDEN'],
    [{ id: 'a1', role: 'admin', email: 'a@x.co', admin_scope: 'assistant' }, 403, 'COST_ACCESS_DENIED'],
    [{ id: 'f1', role: 'admin', email: 'f@x.co', admin_scope: 'full' }, 403, 'COST_ACCESS_DENIED'],
  ] as const) {
    const { app } = world({ user: user as StubUser | null });
    for (const res of [await get(app, `${BASE}/rates`), await put(app, `${BASE}/rates/fx/USD_IQD/manual`, { owner_version: 1, rate: '1650' })]) {
      assert.equal(res.status, status);
      assert.equal((await json(res)).code, code);
      assert.equal(res.headers.get('cache-control'), 'private, no-store');
    }
  }
});

test('mass assignment: every write refuses an extra key — server-computed names, __proto__, constructor — by name (400 UNKNOWN_FIELD)', async () => {
  const { app } = world();
  const cases: Array<[string, string, Record<string, unknown>]> = [
    ['PUT', '/rates/fx/USD_IQD/manual', { owner_version: 1, rate: '1650', effective_rate: '1' }],
    ['PUT', '/rates/fx/USD_IQD/manual', { owner_version: 1, rate: '1650', last_known_good_rate: '1' }],
    ['PUT', '/rates/fx/USD_IQD/settings', { owner_version: 1, status: 'OK' }],
    ['PUT', '/rates/fx/USD_IQD/settings', { owner_version: 1, pending_effective_rate: '1700' }],
    ['PUT', '/rates/fx/USD_IQD/settings', { owner_version: 1, effective_version: 9 }],
    ['PUT', '/rates/fx/USD_IQD/settings', { owner_version: 1, lease_token: 'x' }],
    ['PUT', '/rates/fx/USD_IQD/manual', { owner_version: 1, rate_iqd: '1650' }],
    ['POST', '/rates/fx/USD_IQD/review', { owner_version: 1, decision: 'approve', pending_market_rate: '1' }],
    ['POST', '/rates/fx/USD_IQD/confirm', { owner_version: 1, drift_anchor_rate: '1' }],
    ['POST', '/rates/fx/refresh', { pairs: ['USD_IQD'], trigger: 'cron' }],
    ['PUT', '/rates/shipping/CHINA_AIR', { version: 1, rate_iqd: '9000', basis: 'volume' }],
  ];
  for (const [method, path, body] of cases) {
    const res = method === 'PUT' ? await put(app, `${BASE}${path}`, body) : await post(app, `${BASE}${path}`, body);
    const b = await json(res);
    assert.equal(res.status, 400, `${method} ${path} ${Object.keys(body).join(',')}`);
    assert.equal(b.code, 'UNKNOWN_FIELD');
  }
  // Prototype keys arrive as own properties of the parsed body and are refused the same way.
  for (const raw of ['{"owner_version":1,"rate":"1650","__proto__":{"admin":true}}', '{"owner_version":1,"rate":"1650","constructor":{"prototype":{}}}']) {
    const res = await app.request(`${BASE}/rates/fx/USD_IQD/manual`, { method: 'PUT', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' }, body: raw }, undefined, ctx);
    assert.equal(res.status, 400);
    assert.equal((await json(res)).code, 'UNKNOWN_FIELD');
  }
  // An array where an object is expected is no body at all: the version is missing.
  const arr = await app.request(`${BASE}/rates/fx/USD_IQD/manual`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '[{"owner_version":1,"rate":"1650"}]' }, undefined, ctx);
  assert.equal((await json(arr)).code, 'PRICING_INPUT_INVALID');
});

test('validation never echoes a value: decimal fuzz on a manual rate; Arabic-Indic and Extended digits are digits', async () => {
  const { raw, app } = world();
  for (const bad of ['1e3', '.5', '5.', '1.2.3', '-0', '-1650', 'NaN', 'Infinity', '1'.repeat(81), '‏1650', '16 50', '0', '', 1650]) {
    const res = await put(app, `${BASE}/rates/fx/USD_IQD/manual`, { owner_version: ownerVersion(raw), rate: bad });
    const b = await json(res);
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal(b.code, 'PRICING_INPUT_INVALID');
    assert.deepEqual(b.details, { field: 'rate' });
    if (typeof bad === 'string' && bad.length > 2) assert.equal(JSON.stringify(b).includes(bad), false, 'the value is never echoed');
  }
  const above = await put(app, `${BASE}/rates/fx/USD_IQD/manual`, { owner_version: ownerVersion(raw), rate: '3001' });
  assert.equal((await json(above)).code, 'FX_RATE_OUT_OF_BOUNDS');
  const arabic = await put(app, `${BASE}/rates/fx/USD_IQD/manual`, { owner_version: ownerVersion(raw), rate: '١٦٥٠' });
  assert.equal(arabic.status, 200);
  assert.equal(pairOf(raw, 'USD_IQD').effective_rate, '1650');
  const persian = await put(app, `${BASE}/rates/fx/USD_IQD/manual`, { owner_version: ownerVersion(raw), rate: '۱۶۵۵.۵' });
  assert.equal(persian.status, 200);
  assert.equal(pairOf(raw, 'USD_IQD').effective_rate, '1655.5');
  const pair = await put(app, `${BASE}/rates/fx/XAU_USD/manual`, { owner_version: 1, rate: '1' });
  assert.deepEqual((await json(pair)).details, { field: 'pair' });
});

test('owner_version: a stale view is 409 PRICING_CHANGED — and a routine scheduler check in between is NOT a conflict (L3)', async () => {
  const { raw, app } = world();
  applyRate(raw, 'USD_IQD', '1660', new Date(Date.now() - 48 * 3600_000).toISOString(), new Date(Date.now() - 60 * 60_000).toISOString());
  const view = ownerVersion(raw);
  // A routine check: the same figure, a newer publication → UNCHANGED, owner_version untouched.
  const f = fakeProviders({ usd: () => new Response(iqwealthBody({ sell: 1661, publishedAt: new Date(Date.now() - 60_000).toISOString() }), { status: 200 }) });
  await runFxScheduler(fxEnv(raw), { now: new Date() }, { trigger: 'refresh', pairs: ['USD_IQD'], fetchImpl: f.fetch });
  assert.equal(pairOf(raw, 'USD_IQD').last_check_result, 'UNCHANGED');
  assert.equal(ownerVersion(raw), view, 'a routine check does not move owner_version');
  const ok = await put(app, `${BASE}/rates/fx/USD_IQD/manual`, { owner_version: view, rate: '1665' });
  assert.equal(ok.status, 200);
  const stale = await put(app, `${BASE}/rates/fx/USD_IQD/manual`, { owner_version: view, rate: '1670' });
  assert.equal(stale.status, 409);
  assert.equal((await json(stale)).code, 'PRICING_CHANGED');
});

test('refresh: both buckets — 10 an hour per user, 40 a day for the shop; a held lease is 409 FX_REFRESH_IN_PROGRESS', async () => {
  const { raw, app } = world();
  for (let i = 0; i < 10; i++) assert.equal((await post(app, `${BASE}/rates/fx/refresh`, { pairs: ['USD_IQD'] })).status, 200, `call ${i + 1}`);
  const eleventh = await post(app, `${BASE}/rates/fx/refresh`, { pairs: ['USD_IQD'] });
  assert.equal(eleventh.status, 429);
  assert.equal(eleventh.headers.get('cache-control'), 'private, no-store');
  // The shop-wide day bucket, whoever asks.
  const now = Math.floor(Date.now() / 1000);
  raw.prepare('INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 40) ON CONFLICT(key) DO UPDATE SET count = 40, window_start = excluded.window_start')
    .run(rateLimitKey('fx-refresh-global', null, '', 'global'), now - (now % 86400));
  const other = world({ raw, user: { ...OWNER } });
  raw.exec("DELETE FROM rate_limits WHERE key LIKE 'fx-refresh:u:%'");
  assert.equal((await post(other.app, `${BASE}/rates/fx/refresh`, { pairs: ['USD_IQD'] })).status, 429);
  // A run already holding the lease.
  const leased = world();
  leased.raw.exec(`UPDATE fx_rate_pairs SET lease_token = 'other', lease_until = '${new Date(Date.now() + 60_000).toISOString()}' WHERE pair = 'USD_IQD'`);
  const busy = await post(leased.app, `${BASE}/rates/fx/refresh`, { pairs: ['USD_IQD'] });
  assert.equal(busy.status, 409);
  assert.equal((await json(busy)).code, 'FX_REFRESH_IN_PROGRESS');
});

test('refresh with no key configured records NOT_CONFIGURED and makes no request; the answer is the rates plus a codes-only report', async () => {
  const { raw, app } = world();
  const before = providerFetch.attempts.length;
  const res = await post(app, `${BASE}/rates/fx/refresh`, { pairs: ['USD_IQD'] });
  const b = await json(res);
  assert.equal(res.status, 200);
  assert.equal(providerFetch.attempts.length, before);
  assert.deepEqual(b.report.checked, [{ pair: 'USD_IQD', result: 'NOT_CONFIGURED', code: 'KEY_MISSING' }]);
  assert.equal(pairOf(raw, 'USD_IQD').fetch_status, 'NOT_CONFIGURED');
  assert.ok(Array.isArray(b.pairs));
});

test('MANUAL↔AUTO toggling stops fetching after the 40th call of the day (F4): a return to automatic charges both buckets', async () => {
  const { raw, app } = world({ env: { IRAQ_PARALLEL_FX_API_KEY: 'iqw_live_0123456789abcdef' } });
  applyRate(raw, 'USD_IQD', '1660');
  providerFetch.handler = async () => new Response(iqwealthBody({ sell: 1661, publishedAt: new Date(Date.now() - 60_000).toISOString() }), { status: 200 });
  try {
    const now = Math.floor(Date.now() / 1000);
    raw.prepare('INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 39)').run(rateLimitKey('fx-refresh-global', null, '', 'global'), now - (now % 86400));
    const toggle = async (mode: 'AUTO' | 'MANUAL') => put(app, `${BASE}/rates/fx/USD_IQD/settings`, { owner_version: ownerVersion(raw), mode });
    assert.equal((await toggle('MANUAL')).status, 200);
    const before = providerFetch.attempts.length;
    assert.equal((await toggle('AUTO')).status, 200, 'the 40th call of the day');
    assert.equal(providerFetch.attempts.length, before + 1, 'it fetched');
    assert.equal((await toggle('MANUAL')).status, 200, 'turning OFF fetches nothing and charges nothing');
    const refused = await toggle('AUTO');
    assert.equal(refused.status, 429, 'the 41st is refused');
    assert.equal(providerFetch.attempts.length, before + 1, 'and fetches nothing');
    assert.equal(pairOf(raw, 'USD_IQD').mode, 'MANUAL', 'a refused return to automatic changes nothing');
  } finally {
    providerFetch.handler = null;
  }
});

test('fresh sign-in: threshold, drift, dead band, bounds, mode, interval or adjustment change without one → 401 REAUTH_REQUIRED', async () => {
  const stale = world({ sessionAgeSeconds: STALE });
  applyRate(stale.raw, 'USD_IQD', '1660');
  for (const body of [
    { anomaly_threshold_pct: '4' },
    { drift_threshold_pct: '8' },
    { min_change_pct: '0.2' },
    { bound_min: '900' },
    { bound_max: '3500' },
    { mode: 'MANUAL' },
    { interval_hours: 12 },
    // The adjustment moves the effective (and public) USD rate: a fresh sign-in too (WP-FX1A role table).
    { market_adjustment_iqd: '20' },
  ]) {
    const res = await put(stale.app, `${BASE}/rates/fx/USD_IQD/settings`, { owner_version: ownerVersion(stale.raw), ...body });
    assert.equal(res.status, 401, JSON.stringify(body));
    assert.equal((await json(res)).code, 'REAUTH_REQUIRED');
  }
  assert.equal(pairOf(stale.raw, 'USD_IQD').anomaly_threshold_pct, '3', 'nothing changed');
  assert.equal(pairOf(stale.raw, 'USD_IQD').market_adjustment_iqd, '0', 'nothing changed');
  assert.equal(pairOf(stale.raw, 'USD_IQD').effective_rate, '1660', 'nothing changed');
  const fresh = world({ sessionAgeSeconds: FRESH });
  const ok = await put(fresh.app, `${BASE}/rates/fx/USD_IQD/settings`, { owner_version: ownerVersion(fresh.raw), anomaly_threshold_pct: '4', drift_threshold_pct: '8' });
  assert.equal(ok.status, 200);
  assert.equal(pairOf(fresh.raw, 'USD_IQD').anomaly_threshold_pct, '4');
  // A guard change rings the owner's bell, with no figure.
  const bell = fresh.raw.prepare("SELECT body_ar, body_en, meta FROM user_notifications WHERE kind = 'fx_attention'").all();
  assert.equal(bell.length, 1);
  assert.doesNotMatch(JSON.stringify(bell.map((r) => ({ ...r }))), /[0-9٠-٩]/);
});

test('settings refuse what the row could not hold: dead band ≥ threshold, drift < threshold, bounds excluding the effective rate, an ECB adjustment or interval', async () => {
  const { raw, app } = world();
  applyRate(raw, 'USD_IQD', '1660');
  const v = () => ownerVersion(raw);
  const cases: Array<[Record<string, unknown>, string, string?]> = [
    [{ min_change_pct: '3' }, 'PRICING_INPUT_INVALID', 'min_change_pct'],
    [{ drift_threshold_pct: '2' }, 'PRICING_INPUT_INVALID', 'drift_threshold_pct'],
    [{ anomaly_threshold_pct: '51' }, 'PRICING_INPUT_INVALID', 'anomaly_threshold_pct'],
    [{ bound_min: '1700' }, 'FX_BOUNDS_EXCLUDE_EFFECTIVE'],
    [{ bound_min: '3000', bound_max: '2000' }, 'PRICING_INPUT_INVALID', 'bound_min'],
    [{ interval_hours: 24 }, 'PRICING_INPUT_INVALID', 'interval_hours'],
  ];
  for (const [body, code, field] of cases) {
    const res = await put(app, `${BASE}/rates/fx/USD_IQD/settings`, { owner_version: v(), ...body });
    const b = await json(res);
    assert.equal(b.code, code, JSON.stringify(body));
    if (field) assert.deepEqual(b.details, { field });
  }
  for (const body of [{ market_adjustment_iqd: '5' }, { interval_hours: 6 }]) {
    const res = await put(app, `${BASE}/rates/fx/EUR_USD/settings`, { owner_version: ownerVersion(raw, 'EUR_USD'), ...body });
    assert.equal((await json(res)).code, 'PRICING_INPUT_INVALID', JSON.stringify(body));
  }
  // Turning a pair off with no rate in force needs a typed rate (the manual route).
  const off = await put(app, `${BASE}/rates/fx/EUR_USD/settings`, { owner_version: ownerVersion(raw, 'EUR_USD'), mode: 'MANUAL' });
  assert.equal((await json(off)).code, 'FX_RATE_NOT_SET');
  // An interval while MANUAL is meaningless: the rate is manual.
  await put(app, `${BASE}/rates/fx/USD_IQD/settings`, { owner_version: v(), mode: 'MANUAL' });
  const interval = await put(app, `${BASE}/rates/fx/USD_IQD/settings`, { owner_version: v(), interval_hours: 12 });
  assert.equal((await json(interval)).code, 'FX_PAIR_MANUAL');
});

test('manual sets of 13% within 24 h: the act being made counts, so the second — and the third — need a fresh session and confirm_large_change (F3, §7.8; FX-1 review C3)', async () => {
  const stale = world({ sessionAgeSeconds: STALE });
  applyRate(stale.raw, 'USD_IQD', '1660');
  const set = (rate: string, extra: Record<string, unknown> = {}, app = stale.app) => put(app, `${BASE}/rates/fx/USD_IQD/manual`, { owner_version: ownerVersion(stale.raw), rate, ...extra });
  assert.equal((await set('1875.8')).status, 200, 'first 13%');
  // 13% + 13% = 26% in a day: above 15% with the act itself counted.
  const second = await set('2119.654');
  assert.equal(second.status, 409, 'second 13%');
  assert.equal((await json(second)).code, 'PRICING_LARGE_CHANGE_CONFIRM');
  const confirmedButStale = await set('2119.654', { confirm_large_change: true });
  assert.equal(confirmedButStale.status, 401);
  assert.equal((await json(confirmedButStale)).code, 'REAUTH_REQUIRED');
  const fresh = world({ raw: stale.raw, sessionAgeSeconds: FRESH });
  assert.equal((await set('2119.654', { confirm_large_change: true }, fresh.app)).status, 200);
  // The third (the plan's own case) needs both as well.
  const third = await set('2395.209');
  assert.equal(third.status, 409);
  assert.equal((await json(third)).code, 'PRICING_LARGE_CHANGE_CONFIRM');
  const thirdStale = await set('2395.209', { confirm_large_change: true });
  assert.equal((await json(thirdStale)).code, 'REAUTH_REQUIRED');
  assert.equal((await set('2395.209', { confirm_large_change: true }, fresh.app)).status, 200);
  assert.equal(pairOf(stale.raw, 'USD_IQD').effective_rate, '2395.209');
  // A single act above 15% needs the same, whatever the history.
  const one = world({ sessionAgeSeconds: FRESH });
  applyRate(one.raw, 'USD_IQD', '1660');
  const big = await put(one.app, `${BASE}/rates/fx/USD_IQD/manual`, { owner_version: ownerVersion(one.raw), rate: '2000' });
  assert.equal((await json(big)).code, 'PRICING_LARGE_CHANGE_CONFIRM');
});

test('«تأكيد السعر الحالي» needs a fresh session, and moves the drift anchor to the effective rate', async () => {
  const stale = world({ sessionAgeSeconds: STALE });
  applyRate(stale.raw, 'USD_IQD', '1660');
  stale.raw.exec("UPDATE fx_rate_pairs SET effective_rate = '1700', effective_version = effective_version + 1, last_known_good_rate = '1700' WHERE pair = 'USD_IQD'");
  const refused = await post(stale.app, `${BASE}/rates/fx/USD_IQD/confirm`, { owner_version: ownerVersion(stale.raw) });
  assert.equal(refused.status, 401);
  assert.equal((await json(refused)).code, 'REAUTH_REQUIRED');
  const fresh = world({ raw: stale.raw, sessionAgeSeconds: FRESH });
  assert.equal((await post(fresh.app, `${BASE}/rates/fx/USD_IQD/confirm`, { owner_version: ownerVersion(stale.raw) })).status, 200);
  assert.equal(pairOf(stale.raw, 'USD_IQD').drift_anchor_rate, '1700');
  const none = world();
  assert.equal((await json(await post(none.app, `${BASE}/rates/fx/EUR_USD/confirm`, { owner_version: 1 }))).code, 'FX_RATE_NOT_SET');
});

test('review: nothing pending → 409 FX_REVIEW_NOT_PENDING; a 25-hour-old candidate → 409 FX_REVIEW_STALE; approve, reject and keep as manual', async () => {
  const { raw, app } = world();
  applyRate(raw, 'USD_IQD', '1660');
  const v = () => ownerVersion(raw);
  assert.equal((await json(await post(app, `${BASE}/rates/fx/USD_IQD/review`, { owner_version: v(), decision: 'approve' }))).code, 'FX_REVIEW_NOT_PENDING');
  const hold = (observedHoursAgo: number) =>
    raw.exec(`UPDATE fx_rate_pairs SET pending_market_rate='1720', pending_effective_rate='1720', pending_reason='ANOMALY', pending_observed_at='${new Date(Date.now() - observedHoursAgo * 3600_000).toISOString()}', status='REVIEW_REQUIRED', owner_version = owner_version + 1 WHERE pair='USD_IQD'`);
  hold(25);
  assert.equal((await json(await post(app, `${BASE}/rates/fx/USD_IQD/review`, { owner_version: v(), decision: 'approve' }))).code, 'FX_REVIEW_STALE');
  assert.equal((await json(await post(app, `${BASE}/rates/fx/USD_IQD/review`, { owner_version: v(), decision: 'maybe' }))).code, 'PRICING_INPUT_INVALID');
  hold(1);
  assert.equal((await post(app, `${BASE}/rates/fx/USD_IQD/review`, { owner_version: v(), decision: 'reject' })).status, 200);
  assert.equal(pairOf(raw, 'USD_IQD').rejected_rate, '1720');
  hold(1);
  assert.equal((await post(app, `${BASE}/rates/fx/USD_IQD/review`, { owner_version: v(), decision: 'keep_manual' })).status, 200);
  assert.equal(pairOf(raw, 'USD_IQD').mode, 'MANUAL');
  assert.equal(pairOf(raw, 'USD_IQD').effective_rate, '1660');
  raw.exec("UPDATE fx_rate_pairs SET mode = 'AUTO', manual_rate = NULL WHERE pair = 'USD_IQD'");
  hold(1);
  assert.equal((await post(app, `${BASE}/rates/fx/USD_IQD/review`, { owner_version: v(), decision: 'approve' })).status, 200);
  assert.equal(pairOf(raw, 'USD_IQD').effective_rate, '1720');
  assert.equal(derivedOf(raw).USD!.rate_iqd, '1720');
});

test('shipping rate is IQD decimal text > 0; basis fixed per profile; never multiplied by any FX (§21)', async () => {
  const { raw, app } = world();
  applyRate(raw, 'USD_IQD', '1660');
  const res = await put(app, `${BASE}/rates/shipping/CHINA_SEA`, { version: 1, rate_iqd: '125000.5' });
  assert.equal(res.status, 200);
  const b = await json(res);
  const sea = b.shipping.find((s: { profile: string }) => s.profile === 'CHINA_SEA');
  assert.deepEqual([sea.basis, sea.rate_iqd, sea.version], ['volume', '125000.5', 2], 'stored as typed: dinars per CBM, no conversion');
  for (const bad of ['0', '-5', '1e5', 'abc', '1234567890']) {
    const r = await put(app, `${BASE}/rates/shipping/CHINA_AIR`, { version: 1, rate_iqd: bad });
    assert.deepEqual((await json(r)).details, { field: 'rate_iqd' }, bad);
  }
  assert.deepEqual((await json(await put(app, `${BASE}/rates/shipping/MARS_ROCKET`, { version: 1, rate_iqd: '1' }))).details, { field: 'profile' });
  assert.equal((await json(await put(app, `${BASE}/rates/shipping/CHINA_SEA`, { version: 1, rate_iqd: '125001' }))).code, 'PRICING_CHANGED');
  const big = await put(app, `${BASE}/rates/shipping/CHINA_SEA`, { version: 2, rate_iqd: '200000' });
  assert.equal((await json(big)).code, 'PRICING_LARGE_CHANGE_CONFIRM');
  assert.equal(raw.prepare("SELECT action FROM audit_log WHERE action = 'shipping.rate.update'").all().length, 1);
});

test('history: newest first, paged by time, at most 100 a page; a bad pair, limit or cursor is 400', async () => {
  const { raw, app } = world();
  for (let i = 0; i < 5; i++) {
    raw.prepare(`INSERT INTO fx_rate_log (id, pair, event, trigger_kind, result, created_at) VALUES (?, 'USD_IQD', 'check', 'cron', 'UNCHANGED', ?)`).run(`h${i}`, `2026-10-0${i + 1}T00:00:00.000Z`);
  }
  raw.prepare(`INSERT INTO fx_rate_log (id, pair, event, trigger_kind, result, created_at) VALUES ('e1', 'EUR_USD', 'check', 'cron', 'UNCHANGED', '2026-10-03T12:00:00.000Z')`).run();
  let b = await json(await get(app, `${BASE}/rates/history?pair=USD_IQD&limit=2`));
  assert.deepEqual(b.items.map((i: { id: string }) => i.id), ['h4', 'h3']);
  b = await json(await get(app, `${BASE}/rates/history?pair=USD_IQD&limit=2&before=${encodeURIComponent('2026-10-04T00:00:00.000Z')}`));
  assert.deepEqual(b.items.map((i: { id: string }) => i.id), ['h2', 'h1']);
  b = await json(await get(app, `${BASE}/rates/history`));
  assert.equal(b.items.length, 6);
  for (const q of ['pair=XAU', 'limit=101', 'limit=0', 'limit=abc', `before=${'x'.repeat(40)}`]) {
    const res = await get(app, `${BASE}/rates/history?${q}`);
    assert.equal(res.status, 400, q);
  }
});

test('a cross-origin write is refused by the Worker (originCheck), before the door', async () => {
  const raw = freshDb();
  const env = { DB: asD1(raw), STORE_ROOT_DOMAIN: APEX, APP_ORIGIN: `https://${APEX}`, INITIAL_ADMIN_EMAIL: 'boss@x.co', EXTRA_ALLOWED_ORIGINS: '', ASSETS: { fetch: async () => new Response('spa') } };
  const res = await worker.fetch(
    new Request(`https://${APEX}${BASE}/rates/fx/USD_IQD/manual`, {
      method: 'PUT',
      headers: { Host: APEX, Origin: 'https://evil.example', 'content-type': 'application/json', 'CF-Connecting-IP': '9.9.9.9' },
      body: JSON.stringify({ owner_version: 1, rate: '1650' }),
    }),
    env as never,
    ctx
  );
  assert.equal(res.status, 403);
  assert.equal(pairOf(raw, 'USD_IQD').effective_rate, null);
});

test('the ECB pairs answer too: a held first value approved for EUR writes the derived EUR row once U is in force', async () => {
  const { raw, app } = world();
  applyRate(raw, 'USD_IQD', '1660');
  const f = fakeProviders({ ecb: () => new Response(ecbBody({ day: new Date().toISOString().slice(0, 10) }), { status: 200 }) });
  await runFxScheduler(fxEnv(raw), { now: new Date() }, { trigger: 'refresh', pairs: ['EUR_USD', 'CNY_USD'], fetchImpl: f.fetch });
  for (const pair of ['EUR_USD', 'CNY_USD']) {
    const res = await post(app, `${BASE}/rates/fx/${pair}/review`, { owner_version: ownerVersion(raw, pair), decision: 'approve' });
    assert.equal(res.status, 200, pair);
  }
  const d = derivedOf(raw);
  assert.equal(d.EUR!.rate_iqd, '1856.876');
  assert.equal(d.CNY!.rate_iqd, '247.675932374');
});
