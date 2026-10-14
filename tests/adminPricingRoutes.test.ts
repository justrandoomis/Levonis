/**
 * /api/admin/pricing — «التسعير والشحن» P1, the router (MVP plan §6 P1).
 *
 *   - the clean start (spec addendum A.6, DECISIONS row 222): the overview is
 *     counts only (published / needs pricing / saved / compositions); every V1
 *     product door (one product, the what-if, rules, inputs, typed prices) is
 *     409 PRICING_V2_MANAGED — pricingV2LegacyDoorsRefused.test.ts names each;
 *   - every other admin hears COST_ACCESS_DENIED, the same bytes for a real and
 *     an invented id; a customer is refused at the admin door, a guest is 401;
 *     the owner's unverified session hears OWNER_EMAIL_UNVERIFIED;
 *   - through the whole Worker: anonymous → 401 (the live probe's verdict), a
 *     cross-origin write is refused, a merchant host never reaches it, and the
 *     owner's answers are `private, no-store`.
 *
 * Run: node --import tsx --test tests/adminPricingRoutes.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { APEX, MERCHANT_HOST, OWNER, asD1, ctx, freshDb, stubApp, type StubUser } from './fixtures/app';
import { ROLES, call, type MatrixApp } from './fixtures/roleMatrix';
import { seedLegacyCatalogue, seedProfileRates } from './fixtures/legacyCatalogue';
import { adminPricingRoutes } from '../worker/routes/adminPricing';
import { noStoreUnlessSet } from '../worker/lib/edgePolicy';
import { serverMessage } from '../packages/contracts/src/costRefusals';
import { sha256Hex } from '../worker/lib/crypto';
import worker from '../worker/index';

function db(): DatabaseSync {
  const raw = freshDb();
  seedLegacyCatalogue(raw);
  seedProfileRates(raw);
  return raw;
}

const appAs = (raw: DatabaseSync, user: StubUser | null, host?: string): MatrixApp =>
  stubApp(
    asD1(raw),
    user,
    (a) => {
      a.use('/api/admin/*', noStoreUnlessSet);
      a.route('/api/admin/pricing', adminPricingRoutes);
    },
    host ? { host } : {}
  );

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Every key at any depth. */
function keysOf(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      keysOf(x, out);
    }
  }
  return out;
}

const AMS_HT = 'lp_08'; // census row 8: one model, land, a direct cell at +50,000, no fee

// ------------------------------------------------------------------ overview

test('overview (the clean start, spec addendum A.6): counts only — published, needs pricing, saved, compositions — private and never stored', async () => {
  const raw = db();
  const app = appAs(raw, OWNER);
  const res = await call(app, 'GET', '/api/admin/pricing/overview');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  const body = res.body as Json;
  assert.equal(body.success, true);
  assert.deepEqual(Object.keys(body.v2).sort(), ['compositions', 'needs_pricing', 'published', 'saved']);
  // Nothing is V2-published at the cut-over: every ordinary product needs pricing.
  const census = raw.prepare('SELECT COUNT(*) AS n FROM products').get() as { n: number };
  assert.equal(body.v2.published, 0);
  assert.equal(body.v2.needs_pricing + body.v2.compositions, Number(census.n));
  // Counts only: no figure, no product list, no rule amount.
  assert.equal('products' in body, false);
  assert.equal(keysOf(body).has('amount_iqd'), false);
  // Every V1 product door is closed (pricingV2LegacyDoorsRefused.test.ts covers each one).
  const one = await call(app, 'GET', `/api/admin/pricing/products/${AMS_HT}`);
  assert.deepEqual([one.status, (one.body as Json).code], [409, 'PRICING_V2_MANAGED']);
  assert.equal(one.headers.get('cache-control'), 'private, no-store');
});

// ------------------------------------------------------------------ who may ask

test('every other admin hears COST_ACCESS_DENIED — the same bytes for a real id, an invented one and a tampered query; customers and guests never reach it', async () => {
  const raw = db();
  for (const role of ['assistant', 'full', 'legacy_null', 'grantee_off', 'support_assistant'] as const) {
    const app = appAs(raw, ROLES[role]);
    const bodies: string[] = [];
    for (const [method, path] of [
      ['GET', '/api/admin/pricing/overview'],
      ['GET', `/api/admin/pricing/products/${AMS_HT}`],
      ['GET', '/api/admin/pricing/products/zz-no-such-id'],
      ['GET', `/api/admin/pricing/products/${AMS_HT}?include=cost&role=owner`],
      ['POST', `/api/admin/pricing/products/${AMS_HT}/what-if`],
      ['POST', '/api/admin/pricing/products/zz-no-such-id/what-if'],
    ] as const) {
      const res = await call(app, method, path, method === 'POST' ? { supplier_cost: '10', currency: 'EUR' } : undefined);
      assert.equal(res.status, 403, `${role} ${method} ${path}`);
      assert.equal((res.body as Json).code, 'COST_ACCESS_DENIED');
      assert.equal((res.body as Json).error, serverMessage('COST_ACCESS_DENIED'));
      assert.equal(res.headers.get('cache-control'), 'private, no-store');
      bodies.push(JSON.stringify(res.body));
    }
    assert.equal(new Set(bodies).size, 1, `${role}: the refusal differs between routes or ids`);
  }
  for (const role of ['customer', 'merchant', 'employee', 'investor'] as const) {
    const res = await call(appAs(raw, ROLES[role]), 'GET', `/api/admin/pricing/products/${AMS_HT}`);
    assert.equal(res.status, 403, role);
    assert.notEqual((res.body as Json).code, 'OWNER_EMAIL_UNVERIFIED');
  }
  assert.equal((await call(appAs(raw, null), 'GET', '/api/admin/pricing/overview')).status, 401);
  // The owner before the address is verified: the way out, no cost.
  const unverified = await call(appAs(raw, { ...OWNER, email_verified_at: null }), 'GET', `/api/admin/pricing/products/${AMS_HT}`);
  assert.deepEqual([unverified.status, (unverified.body as Json).code], [403, 'OWNER_EMAIL_UNVERIFIED']);
  // A merchant host never reaches administration (404, as every /api/admin route).
  assert.equal((await call(appAs(raw, OWNER, MERCHANT_HOST), 'GET', '/api/admin/pricing/overview')).status, 404);
});

test('the router itself marks every answer private, no-store — its own refusals included, without the /api/admin layer', async () => {
  const raw = db();
  const bare = (user: StubUser | null) => stubApp(asD1(raw), user, (a) => a.route('/api/admin/pricing', adminPricingRoutes));
  for (const [user, status] of [[null, 401], [ROLES.customer, 403], [ROLES.full, 403], [OWNER, 200]] as const) {
    const res = await call(bare(user), 'GET', '/api/admin/pricing/overview');
    assert.equal(res.status, status);
    assert.equal(res.headers.get('cache-control'), 'private, no-store', `${user?.id ?? 'guest'}`);
  }
});

// ------------------------------------------------------------------ the whole Worker

async function viaWorker(raw: DatabaseSync, path: string, init: { method?: string; cookie?: string; origin?: string; body?: unknown; host?: string } = {}) {
  const env = {
    DB: asD1(raw),
    STORE_ROOT_DOMAIN: APEX,
    APP_ORIGIN: `https://${APEX}`,
    INITIAL_ADMIN_EMAIL: 'boss@x.co',
    EXTRA_ALLOWED_ORIGINS: '',
    ASSETS: { fetch: async () => new Response('spa') },
  };
  const headers: Record<string, string> = { Host: init.host ?? APEX, accept: 'application/json', 'CF-Connecting-IP': '9.9.9.9' };
  if (init.cookie) headers.Cookie = init.cookie;
  if (init.origin) headers.Origin = init.origin;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const res = await worker.fetch(
    new Request(`https://${init.host ?? APEX}${path}`, { method: init.method ?? 'GET', headers, body: init.body !== undefined ? JSON.stringify(init.body) : undefined }),
    env as never,
    ctx
  );
  const text = await res.text();
  let json: Json = {};
  try {
    json = JSON.parse(text) as Json;
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, headers: res.headers };
}

async function ownerSession(raw: DatabaseSync): Promise<string> {
  raw.exec("INSERT INTO users (id, name, email, password_hash, role, admin_scope, email_verified_at) VALUES ('usr_owner', 'Owner', 'boss@x.co', 'h', 'admin', NULL, '2026-01-01T00:00:00.000Z')");
  const token = `pricing-test-${Math.random().toString(36).slice(2)}`;
  raw.prepare('INSERT INTO sessions (id, user_id, expires_at, user_agent) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), 'usr_owner', new Date(Date.now() + 86_400_000).toISOString(), 'test');
  return `levonis_session=${token}`;
}

test('the whole Worker: anonymous → 401 (the live probe), the owner is served private, no-store, a cross-origin what-if is refused', async () => {
  const raw = db();
  const anon = await viaWorker(raw, '/api/admin/pricing/overview');
  assert.equal(anon.status, 401);
  const cookie = await ownerSession(raw);
  const overview = await viaWorker(raw, '/api/admin/pricing/overview', { cookie });
  assert.equal(overview.status, 200);
  assert.equal(overview.headers.get('cache-control'), 'private, no-store');
  assert.equal(overview.json.v2.published, 0);
  // The same-origin what-if reaches the router, whose V1 door is closed (the clean start).
  const same = await viaWorker(raw, `/api/admin/pricing/products/${AMS_HT}/what-if`, { method: 'POST', cookie, origin: `https://${APEX}`, body: { supplier_cost: '500', currency: 'EUR' } });
  assert.deepEqual([same.status, same.json.code], [409, 'PRICING_V2_MANAGED']);
  assert.equal(same.headers.get('cache-control'), 'private, no-store');
  const cross = await viaWorker(raw, `/api/admin/pricing/products/${AMS_HT}/what-if`, { method: 'POST', cookie, origin: 'https://evil.example', body: { supplier_cost: '500', currency: 'EUR' } });
  assert.equal(cross.status, 403);
  assert.equal(JSON.stringify(cross.json).includes('843000'), false, 'a refused cross-origin call carries no price');
  // A storefront host shares the cookie and never reaches the owner's screen.
  const merchant = await viaWorker(raw, '/api/admin/pricing/overview', { cookie, host: MERCHANT_HOST });
  assert.equal(merchant.status, 404);
});
