/**
 * `/api/v1/analytics/*`: who may read which numbers, and in what shape.
 *
 * The merchant route is the interesting one — the whole reason Analytics does
 * not simply trust a `merchant_id` in the query string is that it owns no
 * merchant table and cannot ask one. It proves what it can (the principal's own
 * id, or a full-scope admin) and refuses the rest.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AnalyticsOverviewResponse, MerchantDailyResponse, PlatformDailyResponse } from '@levonis/contracts/http/analytics';
import { PRINCIPAL_HEADER } from '@levonis/contracts/http/common';
import type { EventEnvelope } from '@levonis/contracts/envelope';
import { buildPrincipal, signPrincipal, type MintInput } from '@levonis/platform-kit/principal';
import { generateKeyPair, importSigningKey } from '@levonis/platform-kit/keys';
import { createApp } from '../src/http';
import { analyticsConsumer } from '../src/consumer';
import { METRICS } from '../src/metrics';
import type { Env } from '../src/env';
import { analyticsDb } from './_db';
import { fixture, producers, nextEventId } from './_events';

const DAY = '2026-09-08';
const AT = `${DAY}T10:00:00.000Z`;

async function stack(opts: { issuer?: string } = {}) {
  const { db, raw } = analyticsDb();
  const material = await generateKeyPair();
  const signer = await importSigningKey(material.privateKeyB64, material.publicKeyB64);
  const env: Env = {
    DB: db,
    ALLOWED_CALLER_KIDS: `${opts.issuer ?? 'identity'}:${material.kid}:${material.publicKeyB64}`,
    ANALYTICS_HASH_SALT: 'salt',
    SVC_VERSION: 'test',
  };
  const app = createApp();
  const principal = async (patch: Partial<MintInput> = {}) =>
    signPrincipal(
      signer,
      buildPrincipal(
        {
          sub: 'usr_admin',
          sid_hash: 'sid',
          role: 'admin',
          scope: 'full',
          investor: false,
          tier: null,
          locale: 'en',
          host_kind: 'main',
          cid: 'cid_1',
          ...patch,
        },
        Math.floor(Date.now() / 1000)
      )
    );
  const get = (path: string, header?: string) =>
    app.fetch(new Request(`https://analytics.internal${path}`, { headers: header ? { [PRINCIPAL_HEADER]: header } : {} }), env);

  const p = await producers();
  const consumer = analyticsConsumer({ keys: p.ring, salt: 'salt', now: () => AT });
  const send = async (key: string, patch: Partial<EventEnvelope> = {}) => {
    const src = fixture(key);
    const envelope = { ...src, event_id: nextEventId(), created_at: AT, ...patch } as EventEnvelope;
    return consumer.deliver(db, [await p.sign(envelope)]);
  };
  return { db, raw, env, principal, get, send };
}

test('health answers without a principal, and its database check is real', async () => {
  const s = await stack();
  const res = await s.get('/health');
  assert.equal(res.status, 200);
  // The legacy fields stay, and §11.3's report is added on top. `checks.db` is
  // the part that matters: without it this route answers `ok` for a Worker
  // whose tables are all missing, which is the one thing the dark twin's URL
  // exists to catch before anything binds it.
  assert.deepEqual(await res.json(), {
    success: true,
    status: 'ok',
    version: 'test',
    ok: true,
    svc: 'analytics',
    ver: 'test',
    checks: { db: 'ok' },
  });
});

test('the admin read models need an admin principal signed by Identity, on the apex', async () => {
  const s = await stack();
  await s.send('OrderCreated.v1');

  assert.equal((await s.get('/api/v1/analytics/admin/overview')).status, 401);
  assert.equal((await s.get('/api/v1/analytics/admin/overview', await s.principal({ role: 'customer', scope: null }))).status, 403);
  assert.equal((await s.get('/api/v1/analytics/admin/overview', await s.principal({ host_kind: 'merchant' }))).status, 401);

  // an assistant admin MAY read the aggregates: they carry no money row and no
  // person — this is the one admin surface that is not `admin:full`
  const assistant = await s.get('/api/v1/analytics/admin/overview', await s.principal({ scope: 'assistant' }));
  assert.equal(assistant.status, 200);

  const other = await stack({ issuer: 'ads' });
  assert.equal((await other.get('/api/v1/analytics/admin/overview', await other.principal())).status, 401, 'only Identity may sign a principal');
});

test('overview answers the contract shape from the rollups', async () => {
  const s = await stack();
  await s.send('OrderCreated.v1');
  await s.send('OrderDelivered.v1');
  await s.send('UserCreated.v1');

  const res = await s.get('/api/v1/analytics/admin/overview', await s.principal());
  assert.equal(res.status, 200);
  const body = (await res.json()) as AnalyticsOverviewResponse;
  assert.equal(body.success, true);
  assert.deepEqual(Object.keys(body).sort(), ['orders', 'success', 'users', 'wallet']);
  assert.deepEqual(Object.keys(body.orders).sort(), ['delivered', 'pending', 'revenue_iqd', 'total']);
  assert.deepEqual(Object.keys(body.users).sort(), ['investors', 'plus', 'prime', 'pro', 'total']);
  assert.deepEqual(Object.keys(body.wallet).sort(), ['incoming_usd_cents', 'outgoing_usd_cents']);
  assert.equal(body.orders.total, 1);
  assert.equal(body.users.total, 1);
});

test('a range must be a day, and it filters', async () => {
  const s = await stack();
  await s.send('OrderCreated.v1');
  const header = await s.principal();

  const bad = await s.get('/api/v1/analytics/admin/overview?from=last-week', header);
  assert.equal(bad.status, 400);
  assert.equal(((await bad.json()) as { code: string }).code, 'CONTRACT_VIOLATION');

  const empty = (await (await s.get(`/api/v1/analytics/admin/overview?from=2099-01-01`, header)).json()) as AnalyticsOverviewResponse;
  assert.equal(empty.orders.total, 0);
  assert.equal(empty.from, '2099-01-01');

  const inRange = (await (await s.get(`/api/v1/analytics/admin/overview?from=${DAY}&to=${DAY}`, header)).json()) as AnalyticsOverviewResponse;
  assert.equal(inRange.orders.total, 1);
});

test('the daily series is `[{day, metric, value}]`, filterable by metric', async () => {
  const s = await stack();
  await s.send('OrderCreated.v1');
  await s.send('UserCreated.v1');
  const header = await s.principal();

  const all = (await (await s.get('/api/v1/analytics/admin/daily', header)).json()) as PlatformDailyResponse;
  assert.ok(all.points.length >= 2);
  for (const p of all.points) assert.deepEqual(Object.keys(p).sort(), ['day', 'metric', 'value']);

  const one = (await (await s.get(`/api/v1/analytics/admin/daily?metric=${METRICS.usersCreated}`, header)).json()) as PlatformDailyResponse;
  assert.deepEqual(one.points, [{ day: DAY, metric: METRICS.usersCreated, value: 1 }]);
});

test('a merchant reads its own numbers and nobody else`s; a full admin reads any', async () => {
  const s = await stack();
  const order = fixture('OrderCreated.v1');
  const mine = 'mch_mine';
  const theirs = 'mch_theirs';
  for (const id of [mine, theirs]) {
    await s.send('OrderCreated.v1', { payload: { ...(order.payload as object), merchant_id: id, seller_type: 'merchant' } } as Partial<EventEnvelope>);
  }

  const own = await s.get(
    `/api/v1/analytics/merchant/daily?merchant_id=${mine}`,
    await s.principal({ sub: mine, role: 'merchant', scope: null, host_kind: 'merchant' })
  );
  assert.equal(own.status, 200, 'a merchant reads from its storefront host');
  const body = (await own.json()) as MerchantDailyResponse;
  assert.equal(body.merchant_id, mine);
  assert.equal(body.points.find((p) => p.metric === METRICS.ordersCreated)?.value, 1);

  const someoneElse = await s.get(
    `/api/v1/analytics/merchant/daily?merchant_id=${theirs}`,
    await s.principal({ sub: mine, role: 'merchant', scope: null, host_kind: 'merchant' })
  );
  assert.equal(someoneElse.status, 403);

  const admin = await s.get(`/api/v1/analytics/merchant/daily?merchant_id=${theirs}`, await s.principal());
  assert.equal(admin.status, 200);

  const missing = await s.get('/api/v1/analytics/merchant/daily', await s.principal());
  assert.equal(missing.status, 400);
});

test('an unknown path is a 404 in the platform envelope', async () => {
  const s = await stack();
  const res = await s.get('/api/v1/analytics/admin/nope', await s.principal());
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { success: false, error: 'Not found', code: 'NOT_FOUND' });
});
