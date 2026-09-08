/**
 * The HTTP surfaces, driven as the real Hono app: the SPA inbox (whose shapes
 * must survive the Phase 4 prefix flip unchanged), the admin delivery history,
 * and the Telegram webhook.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRINCIPAL_HEADER } from '@levonis/contracts/http/common';
import type { MarkReadResponse, NotificationListResponse, NotifyDeliveriesResponse, UnreadCountResponse } from '@levonis/contracts/http/notifications';
import { classifyUpdate, TELEGRAM_SECRET_HEADER } from '../src/http/webhook';
import { principalOf } from '../src/http/public';
import { createApp } from '../src/app';
import { identity, notifyDb, resetPrincipalCache, UNCONFIGURED_ENV, type TestIdentity } from './_harness';

/** The Identity key every rig in this file trusts, minted once. */
const ID: TestIdentity = await identity();

function rig(vars: Record<string, string | undefined> = UNCONFIGURED_ENV) {
  const { db, raw } = notifyDb();
  const app = createApp();
  const env = { ALLOWED_CALLER_KIDS: ID.allowlist, ...vars, DB: db, GATEWAY_ONLY: 'off' } as unknown as Parameters<typeof app.fetch>[1];
  resetPrincipalCache(env as never);
  const call = (path: string, init?: RequestInit) => app.fetch(new Request(`https://notifications.invalid${path}`, init), env);
  return { call, raw, db, env };
}

/** A principal the way Identity mints it: a compact Ed25519-signed token. */
const principalToken = (sub: string, overrides: Record<string, unknown> = {}) => ID.mint({ sub, ...overrides });
const adminToken = () => ID.mint({ sub: 'usr_admin', role: 'admin', scope: 'full' });

const seed = (raw: ReturnType<typeof rig>['raw'], userId: string, id: string, at: string, read = false) =>
  raw
    .prepare(
      `INSERT INTO user_notifications (id, user_id, kind, title_ar, title_en, body_ar, body_en, link, entity_type, entity_id, event_key, read_at, created_at)
       VALUES (?, ?, 'order_update', 'ع', 'en', '', '', '/orders/1', 'order', '1', ?, ?, ?)`
    )
    .run(id, userId, `k:${id}`, read ? at : null, at);

test('the inbox refuses a request it cannot attribute — no principal, no rows', async () => {
  const { call, raw } = rig();
  seed(raw, 'usr_1', 'n1', '2026-09-07T10:00:00.000Z');
  for (const path of ['/api/notifications', '/api/notifications/unread-count']) {
    const res = await call(path);
    assert.equal(res.status, 401, path);
  }
  assert.equal((await call('/api/notifications/read', { method: 'POST', body: '{}' })).status, 401);
  // an anonymous marker is not a reader either
  const { env } = rig();
  assert.equal(await principalOf(env as never, await principalToken('anon:abcdef', { role: 'anonymous' })), null);
  assert.equal(await principalOf(env as never, 'not-a-token'), null);
  assert.equal(await principalOf(env as never, undefined), null);
});

test('the inbox returns only the caller\'s rows, newest first, with the contract\'s field names', async () => {
  const { call, raw } = rig();
  seed(raw, 'usr_1', 'n1', '2026-09-07T10:00:00.000Z');
  seed(raw, 'usr_1', 'n2', '2026-09-07T11:00:00.000Z', true);
  seed(raw, 'usr_2', 'n3', '2026-09-07T12:00:00.000Z');
  const token = await principalToken('usr_1');
  const res = await call('/api/notifications', { headers: { [PRINCIPAL_HEADER]: token } });
  const body = (await res.json()) as NotificationListResponse;
  assert.deepEqual(body.notifications.map((n) => n.id), ['n2', 'n1'], 'newest first, and nobody else\'s');
  assert.equal(body.unread, 1);
  assert.equal(body.next_before, '2026-09-07T10:00:00.000Z');
  assert.deepEqual(Object.keys(body.notifications[0]).sort(), [
    'body_ar', 'body_en', 'created_at', 'entity_id', 'entity_type', 'id', 'kind', 'link', 'read', 'title_ar', 'title_en',
  ]);
  assert.equal(body.notifications[0].read, true);
  // the read TIMESTAMP is not exposed, only the fact
  assert.ok(!Object.keys(body.notifications[0]).includes('read_at'));
});

test('unread=1 filters, and unread-count agrees with the list', async () => {
  const { call, raw } = rig();
  seed(raw, 'usr_1', 'n1', '2026-09-07T10:00:00.000Z');
  seed(raw, 'usr_1', 'n2', '2026-09-07T11:00:00.000Z', true);
  const headers = { [PRINCIPAL_HEADER]: await principalToken('usr_1') };
  const list = (await (await call('/api/notifications?unread=1', { headers })).json()) as NotificationListResponse;
  assert.deepEqual(list.notifications.map((n) => n.id), ['n1']);
  const c = (await (await call('/api/notifications/unread-count', { headers })).json()) as UnreadCountResponse;
  assert.equal(c.unread, 1);
});

test('marking read is scoped to the owner IN SQL: a guessed id belonging to someone else changes nothing', async () => {
  const { call, raw } = rig();
  seed(raw, 'usr_1', 'mine', '2026-09-07T10:00:00.000Z');
  seed(raw, 'usr_2', 'theirs', '2026-09-07T10:00:00.000Z');
  const headers = { [PRINCIPAL_HEADER]: await principalToken('usr_1'), 'Content-Type': 'application/json' };
  const stolen = (await (await call('/api/notifications/read', { method: 'POST', headers, body: JSON.stringify({ id: 'theirs' }) })).json()) as MarkReadResponse;
  assert.equal(stolen.marked, 0);
  assert.equal(Number((raw.prepare("SELECT COUNT(*) AS n FROM user_notifications WHERE id = 'theirs' AND read_at IS NULL").get() as { n: number }).n), 1);

  const own = (await (await call('/api/notifications/read', { method: 'POST', headers, body: '{}' })).json()) as MarkReadResponse;
  assert.equal(own.marked, 1);
  assert.equal(own.unread, 0);
});

test('the admin delivery history reports rows and the outbox lag, and carries no body or recipient', async () => {
  const { call, raw } = rig();
  raw.prepare("INSERT INTO notify_deliveries (id, event_key, channel, template, status, attempts, error, created_at) VALUES ('d1','k1','email','', 'sent', 1, NULL, '2026-09-07T10:00:00.000Z')").run();
  raw.prepare("INSERT INTO notify_deliveries (id, event_key, channel, template, status, attempts, error, created_at) VALUES ('d2','k2','telegram','', 'failed', 2, 'telegram 500', '2026-09-07T10:00:01.000Z')").run();
  raw.prepare("INSERT INTO notify_outbox (id, kind, event_key, recipient, payload, created_at) VALUES ('o1','email','k3','a@b.test','{}','2026-09-07T09:00:00.000Z')").run();

  const admin = { [PRINCIPAL_HEADER]: await adminToken() };
  const body = (await (await call('/api/v1/notifications/admin/deliveries', { headers: admin })).json()) as NotifyDeliveriesResponse;
  assert.equal(body.rows.length, 2);
  assert.ok(typeof body.outbox_lag_s === 'number' && body.outbox_lag_s > 0, 'the oldest unsent row sets the lag');
  for (const row of body.rows) {
    assert.deepEqual(Object.keys(row).sort(), ['attempts', 'channel', 'created_at', 'delivered_at', 'error', 'event_key', 'id', 'status', 'template']);
  }
  const filtered = (await (await call('/api/v1/notifications/admin/deliveries?channel=telegram&status=failed', { headers: admin })).json()) as NotifyDeliveriesResponse;
  assert.deepEqual(filtered.rows.map((r) => r.id), ['d2']);
});

test('the webhook answers 200 to everything, dedups on update_id, and accepts nothing without the secret', async () => {
  const { call, raw } = rig({ ...UNCONFIGURED_ENV, TELEGRAM_WEBHOOK_SECRET: 'hook-secret' });
  const post = (body: unknown, secret?: string) =>
    call('/api/telegram/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(secret ? { [TELEGRAM_SECRET_HEADER]: secret } : {}) },
      body: JSON.stringify(body),
    });

  // no secret header: still 200 (Telegram retries anything else), but nothing recorded
  const anonymous = await post({ update_id: 1 });
  assert.equal(anonymous.status, 200);
  assert.deepEqual(await anonymous.json(), { ok: true });
  assert.equal(Number((raw.prepare('SELECT COUNT(*) AS n FROM telegram_updates').get() as { n: number }).n), 0);

  // wrong secret: same
  assert.deepEqual(await (await post({ update_id: 1 }, 'wrong')).json(), { ok: true });
  assert.equal(Number((raw.prepare('SELECT COUNT(*) AS n FROM telegram_updates').get() as { n: number }).n), 0);

  const first = await post({ update_id: 42, callback_query: { data: 'dep:approve:1' } }, 'hook-secret');
  assert.deepEqual(await first.json(), { ok: true });
  const replay = await post({ update_id: 42, callback_query: { data: 'dep:approve:1' } }, 'hook-secret');
  assert.deepEqual(await replay.json(), { ok: true, duplicate: true });
  assert.equal(Number((raw.prepare('SELECT COUNT(*) AS n FROM telegram_updates').get() as { n: number }).n), 1);

  // a malformed body is still a 200, and still records nothing
  assert.equal((await call('/api/telegram/webhook', { method: 'POST', headers: { [TELEGRAM_SECRET_HEADER]: 'hook-secret' }, body: 'not json' })).status, 200);
});

test('with no webhook secret configured the endpoint accepts nothing at all', async () => {
  const { call, raw } = rig();
  const res = await call('/api/telegram/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [TELEGRAM_SECRET_HEADER]: '' },
    body: JSON.stringify({ update_id: 7 }),
  });
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(Number((raw.prepare('SELECT COUNT(*) AS n FROM telegram_updates').get() as { n: number }).n), 0);
});

test('the update classifier fixes the shape the router will dispatch on', () => {
  assert.equal(classifyUpdate({ callback_query: { data: 'dep:approve:req_1' } }), 'wallet_approval');
  assert.equal(classifyUpdate({ callback_query: { data: 'wd:reject:w_1' } }), 'wallet_approval');
  assert.equal(classifyUpdate({ callback_query: { data: 'link:usr_1' } }), 'identity');
  assert.equal(classifyUpdate({ message: { text: 'hello' } }), 'unrouted');
  assert.equal(classifyUpdate({}), 'unrouted');
});

test('GET /health reports the database and the outbox lag', async () => {
  const { call } = rig();
  const body = (await (await call('/health')).json()) as { ok: boolean; svc: string; checks: { db: string; outbox_lag_s: number | null } };
  assert.equal(body.svc, 'notifications');
  assert.equal(body.checks.db, 'ok');
  assert.equal(body.checks.outbox_lag_s, null, 'an empty outbox has no lag, which is not the same as zero');
  assert.equal(body.ok, true);
});

test('with GATEWAY_ONLY=on nothing but a health probe gets in without a signed gateway hop', async () => {
  const { db } = notifyDb();
  const app = createApp();
  const env = { DB: db, GATEWAY_ONLY: 'on', HEALTH_PROBE_TOKEN: 'probe-token-value' } as unknown as Parameters<typeof app.fetch>[1];
  const blocked = await app.fetch(new Request('https://notifications.invalid/api/notifications'), env);
  assert.equal(blocked.status, 403);
  const probed = await app.fetch(new Request('https://notifications.invalid/health', { headers: { 'x-health-probe': 'probe-token-value' } }), env);
  assert.equal(probed.status, 200);
});
