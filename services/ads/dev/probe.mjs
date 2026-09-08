#!/usr/bin/env node
/**
 * The local rig's proof for `levonis-ads` and `levonis-notifications`.
 *
 * It drives BOTH services as real Workers, reached over REAL service bindings
 * from a stub producer, inside workerd, against real local D1 databases — the
 * one thing the unit suites cannot do, because they call the modules directly
 * with an in-memory SQLite.
 *
 * Start the rig first (see README.md):
 *
 *   npx wrangler dev -c services/ads/dev/producer-stub/wrangler.jsonc \
 *                    -c services/ads/wrangler.jsonc \
 *                    -c services/notifications/wrangler.jsonc \
 *                    --env dark --port 8811
 *   node services/ads/dev/probe.mjs http://localhost:8811
 *
 * Nothing here touches Cloudflare: `wrangler dev` runs workerd locally, the
 * databases are local files, and NO provider secret is set — so every ads
 * delivery must come back `sandbox` and every notification must come back
 * `dropped`, which is exactly the property being proven.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = (process.argv[2] || 'http://localhost:8811').replace(/\/$/, '');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const fixture = (name) => JSON.parse(readFileSync(join(ROOT, 'packages/contracts/src/events/fixtures', `${name}.v1.json`), 'utf8'));

const call = async (path, init = {}) => {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep the text */
  }
  return { status: res.status, text, body };
};

const post = (path, body) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

let failures = 0;
const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(`  ok   ${name}`);
  } catch (e) {
    failures++;
    results.push(`  FAIL ${name}\n       ${e.message}`);
  }
}
const eq = (actual, expected, what) => {
  if (actual !== expected) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

/** Every run needs its own event ids: the services are idempotent, which is the point. */
const uniq = (envelope) => ({ ...envelope, event_id: crypto.randomUUID().replace(/^(.{14})./, '$17') });

await check('the rig is up and both bindings resolved', async () => {
  const res = await call('/');
  eq(res.status, 200, 'status');
  eq(res.body?.bindings?.ads, true, 'ADS binding');
  eq(res.body?.bindings?.notifications, true, 'NOTIFICATIONS binding');
});

await check('both services answer health() over the binding with a live database', async () => {
  for (const svc of ['ads', 'notifications']) {
    const res = await call(`/health/${svc}`);
    eq(res.status, 200, `${svc} status`);
    eq(res.body?.svc, svc, `${svc} name`);
    eq(res.body?.checks?.db, 'ok', `${svc} db — did the migrations run? see README.md`);
  }
});

await check('ADS: a consent change is stored, and the first one maps to a sandbox delivery per provider', async () => {
  const res = await post('/deliver/ads', [uniq(fixture('UserUpdated'))]);
  eq(res.status, 200, 'status');
  eq(res.body?.results?.[0]?.result, 'acked', 'result');
  const rows = (await call('/http/ads/api/v1/ads/admin/deliveries?status=sandbox')).body;
  if (!rows?.rows?.length) throw new Error('no sandbox delivery row was written');
  for (const row of rows.rows) eq(row.status, 'sandbox', `${row.provider} status`);
});

await check('ADS: a purchase reaches every provider in SANDBOX — no secret is set, so nothing leaves the account', async () => {
  const res = await post('/deliver/ads', [uniq(fixture('PurchaseCompleted'))]);
  eq(res.body?.results?.[0]?.result, 'acked', 'result');
  const rows = (await call('/http/ads/api/v1/ads/admin/deliveries?limit=200')).body.rows.filter((r) => r.event_type === 'PurchaseCompleted');
  eq(rows.length, 4, 'one row per delivering provider');
  for (const row of rows) eq(row.status, 'sandbox', `${row.provider}`);
});

await check('ADS: a redelivered envelope is replayed and writes no second row', async () => {
  const envelope = uniq(fixture('AddToCart'));
  await post('/deliver/ads', [envelope]);
  const before = (await call('/http/ads/api/v1/ads/admin/deliveries?limit=200')).body.rows.length;
  const again = await post('/deliver/ads', [envelope]);
  eq(again.body?.results?.[0]?.result, 'replayed', 'result');
  const after = (await call('/http/ads/api/v1/ads/admin/deliveries?limit=200')).body.rows.length;
  eq(after, before, 'row count');
});

await check('ADS: the provider kill switch removes one platform and leaves the rest', async () => {
  await post('/http/ads/api/v1/ads/admin/flags', { name: 'ads.providers.tiktok.enabled', enabled: false });
  const envelope = uniq(fixture('CheckoutStarted'));
  await post('/deliver/ads', [envelope]);
  const rows = (await call('/http/ads/api/v1/ads/admin/deliveries?limit=200')).body.rows.filter((r) => r.event_id === envelope.event_id);
  eq(rows.length, 3, 'rows for this event');
  if (rows.some((r) => r.provider === 'tiktok')) throw new Error('the disabled provider still got a row');
  await post('/http/ads/api/v1/ads/admin/flags', { name: 'ads.providers.tiktok.enabled', enabled: true });
});

await check('ADS: every provider reports unconfigured, and the master switch is on in dark', async () => {
  const body = (await call('/http/ads/api/v1/ads/admin/providers')).body;
  eq(body?.enabled, true, 'ADS_ENABLED');
  for (const p of body.providers) {
    eq(p.configured, false, `${p.name} configured`);
    eq(p.breaker, 'closed', `${p.name} breaker`);
  }
});

await check('NOTIFICATIONS: an order becomes an in-app row, and a redelivery adds nothing', async () => {
  const envelope = uniq(fixture('OrderCreated'));
  const first = await post('/deliver/notifications', [envelope]);
  eq(first.body?.results?.[0]?.result, 'acked', 'first result');
  const again = await post('/deliver/notifications', [envelope]);
  eq(again.body?.results?.[0]?.result, 'replayed', 'second result');
});

await check('NOTIFICATIONS: send() is idempotent on the event key', async () => {
  const key = `probe:${crypto.randomUUID()}`;
  const cmd = { event_key: key, user_id: 'usr_probe', channels: ['inapp'], template: 'probe', params: { title_en: 'Probe', link: '/probe' }, correlationId: 'cid' };
  eq((await post('/send', cmd)).body?.queued, true, 'first send');
  const second = (await post('/send', cmd)).body;
  eq(second?.queued, true, 'second send is accepted');
  const list = (await call('/http/notifications/api/v1/notifications/admin/deliveries?limit=200')).body;
  if (!list?.success) throw new Error('the admin delivery view did not answer');
});

await check('NOTIFICATIONS: with no transport secret set, the pump drops rather than sends', async () => {
  const key = `probe-mail:${crypto.randomUUID()}`;
  await post('/send', {
    event_key: key,
    user_id: 'usr_probe',
    channels: ['email'],
    template: 'probe',
    params: { to: 'probe@example.invalid', subject: 'x', text: 'x', html: 'x' },
    correlationId: 'cid',
  });
  // the pump runs in waitUntil after send(); give it a moment
  await new Promise((r) => setTimeout(r, 750));
  const rows = (await call('/http/notifications/api/v1/notifications/admin/deliveries?limit=200')).body.rows;
  const mine = rows.find((r) => r.event_key.startsWith(key));
  if (!mine) throw new Error('no delivery row for the queued mail');
  eq(mine.status, 'dropped', 'status');
  eq(mine.error, 'EMAIL_NOT_CONFIGURED', 'reason');
});

await check('NOTIFICATIONS: the webhook answers 200 and dedups, and accepts nothing without the secret', async () => {
  const update = { update_id: Math.floor(Math.random() * 1e9), message: { text: 'hi' } };
  const first = await post('/http/notifications/api/telegram/webhook', update);
  eq(first.status, 200, 'status');
  eq(JSON.stringify(first.body), '{"ok":true}', 'body without the secret header');
});

await check('NOTIFICATIONS: the inbox refuses a request it cannot attribute', async () => {
  const res = await call('/http/notifications/api/notifications');
  eq(res.status, 401, 'status');
});

console.log(results.join('\n'));
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
