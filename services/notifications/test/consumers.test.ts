/**
 * The four consumers and the pump, against the REAL schema
 * (`migrations/0001_notifications.sql` applied to an in-memory SQLite with
 * foreign keys and UNIQUE indexes on) and a `fetch` that throws unless a test
 * allows one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { createNotificationsConsumer, type ContactResolver } from '../src/consumers';
import { pump } from '../src/pump';
import { TransportRegistry } from '../src/transports/registry';
import { CONFIGURED_ENV, fixture, forbiddenFetch, notifyDb, producer, recordingFetch, ringOf, sign, UNCONFIGURED_ENV } from './_harness';

const all = <T>(raw: DatabaseSync, sql: string, ...p: unknown[]): T[] => (raw.prepare(sql).all(...(p as never[])) as object[]).map((r) => ({ ...r })) as T[];
const count = (raw: DatabaseSync, sql: string, ...p: unknown[]): number => Number((raw.prepare(sql).get(...(p as never[])) as { n: number }).n);

const NOW = '2026-09-07T12:00:00.000Z';

const resolver: ContactResolver = {
  async contactFor() {
    return { email: 'new@example.com', locale: 'ar' };
  },
  async verifyLinkFor() {
    return '/verify?token=opaque';
  },
};

async function rig(env: Record<string, string | undefined> = UNCONFIGURED_ENV, contacts?: ContactResolver) {
  const { db, raw } = notifyDb();
  const identity = await producer('identity');
  const commerce = await producer('commerce');
  const ledger = await producer('ledger');
  const marketplace = await producer('marketplace');
  const keys = await ringOf(identity, commerce, ledger, marketplace);
  const consumer = createNotificationsConsumer({ keys, env, contacts, now: () => NOW });
  return { db, raw, identity, commerce, ledger, marketplace, consumer, env };
}

test('UserCreated with a bound contact resolver enqueues the verification mail, keyed on the user', async () => {
  const r = await rig({ ...UNCONFIGURED_ENV, APP_ORIGIN: 'https://levonis-iq.com' }, resolver);
  const res = await r.consumer.deliver(r.db, [await sign(r.identity, fixture('UserCreated'))]);
  assert.equal(res.results[0].result, 'acked');
  const rows = all<{ event_key: string; kind: string; recipient: string; state: string; payload: string }>(r.raw, 'SELECT event_key, kind, recipient, state, payload FROM notify_outbox');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event_key, 'user:usr_01:verify');
  assert.equal(rows[0].kind, 'email');
  assert.equal(rows[0].state, 'pending');
  const payload = JSON.parse(rows[0].payload) as { to: string; html: string; text: string };
  assert.equal(payload.to, 'new@example.com');
  // paths in the app, ABSOLUTE urls in mail — a link in an email must be clickable
  assert.ok(payload.text.includes('https://levonis-iq.com/verify?token=opaque'));
});

test('UserCreated with NO contact resolver records the event honestly as skipped, and sends nothing', async () => {
  const r = await rig();
  await r.consumer.deliver(r.db, [await sign(r.identity, fixture('UserCreated'))]);
  const row = all<{ state: string; last_error: string; recipient: string }>(r.raw, 'SELECT state, last_error, recipient FROM notify_outbox')[0];
  assert.equal(row.state, 'skipped');
  assert.match(row.last_error, /NO_CONTACT_RESOLVER/);
  assert.equal(row.recipient, '', 'there is no recipient to record, and none is invented');
  // a skipped row is never claimed by the pump
  const report = await pump({ db: r.db, env: CONFIGURED_ENV, transports: new TransportRegistry(), fetchImpl: forbiddenFetch, now: () => NOW });
  assert.equal(report.claimed, 0);
});

test('UserCreated for an already-verified signup does nothing at all', async () => {
  const r = await rig(UNCONFIGURED_ENV, resolver);
  const verified = fixture('UserCreated');
  (verified.payload as Record<string, unknown>).email_verified = true;
  await r.consumer.deliver(r.db, [await sign(r.identity, verified)]);
  assert.equal(count(r.raw, 'SELECT COUNT(*) AS n FROM notify_outbox'), 0);
});

test('OrderCreated writes the customer inbox row and, when the group is configured, the admin message', async () => {
  const withoutGroup = await rig();
  await withoutGroup.consumer.deliver(withoutGroup.db, [await sign(withoutGroup.commerce, fixture('OrderCreated'))]);
  assert.equal(count(withoutGroup.raw, 'SELECT COUNT(*) AS n FROM user_notifications'), 1);
  assert.equal(count(withoutGroup.raw, 'SELECT COUNT(*) AS n FROM notify_outbox'), 0, 'no group id means no recipient, so no row');

  const withGroup = await rig({ ...UNCONFIGURED_ENV, TELEGRAM_ADMIN_CHAT_ID: '-100123' });
  await withGroup.consumer.deliver(withGroup.db, [await sign(withGroup.commerce, fixture('OrderCreated'))]);
  const admin = all<{ event_key: string; recipient: string; payload: string }>(withGroup.raw, 'SELECT event_key, recipient, payload FROM notify_outbox')[0];
  assert.match(admin.event_key, /^order:.+:admin$/);
  assert.equal(admin.recipient, '-100123');
  const text = (JSON.parse(admin.payload) as { text: string }).text;
  // totals only: no name, address, phone or contact of any kind
  assert.ok(text.includes('IQD'));
  assert.ok(!/usr_|@|\+964/.test(text));
});

test('the in-app row carries a PATH, never an origin', async () => {
  const r = await rig();
  await r.consumer.deliver(r.db, [await sign(r.commerce, fixture('OrderCreated'))]);
  const link = all<{ link: string }>(r.raw, 'SELECT link FROM user_notifications')[0].link;
  assert.ok(link.startsWith('/'), link);
  assert.ok(!link.includes('http'), 'a stored origin is a stored mistake');
});

test('DepositDecided — a personal envelope this service IS allowed — becomes one inbox row', async () => {
  const r = await rig();
  const res = await r.consumer.deliver(r.db, [await sign(r.ledger, fixture('DepositDecided'))]);
  assert.equal(res.results[0].result, 'acked');
  const row = all<{ event_key: string; title_en: string; user_id: string }>(r.raw, 'SELECT event_key, title_en, user_id FROM user_notifications')[0];
  assert.match(row.event_key, /^deposit:.+:(approved|rejected)$/);
  assert.ok(row.title_en.length > 0);
});

test('RequestPublished tells every matched merchant once — and the same merchant twice never', async () => {
  const r = await rig();
  const event = fixture('RequestPublished');
  (event.payload as Record<string, unknown>).matched_merchant_ids = ['mrc_1', 'mrc_2'];
  const signed = await sign(r.marketplace, event);
  await r.consumer.deliver(r.db, [signed]);
  assert.equal(count(r.raw, 'SELECT COUNT(*) AS n FROM user_notifications'), 2);

  // a redelivery with a NEW event_id (a genuine re-emit) still cannot duplicate a merchant's row
  const reemit = { ...event, event_id: '01a07b50-0000-7000-8000-000000000001' };
  await r.consumer.deliver(r.db, [await sign(r.marketplace, reemit)]);
  assert.equal(count(r.raw, 'SELECT COUNT(*) AS n FROM user_notifications'), 2, 'UNIQUE (user_id, event_key) refuses it');
});

test('IDEMPOTENCY: a redelivered envelope is replayed and writes nothing a second time', async () => {
  const r = await rig(UNCONFIGURED_ENV, resolver);
  const event = await sign(r.identity, fixture('UserCreated'));
  await r.consumer.deliver(r.db, [event]);
  const again = await r.consumer.deliver(r.db, [event, event]);
  assert.deepEqual(again.results.map((x) => x.result), ['replayed', 'replayed']);
  assert.equal(count(r.raw, 'SELECT COUNT(*) AS n FROM notify_outbox'), 1);
});

test('IDEMPOTENCY: even without the processed_events row, notify_outbox.event_key refuses the duplicate', async () => {
  const r = await rig(UNCONFIGURED_ENV, resolver);
  const event = await sign(r.identity, fixture('UserCreated'));
  await r.consumer.deliver(r.db, [event]);
  r.raw.prepare('DELETE FROM notifications_processed_events').run();
  await r.consumer.deliver(r.db, [event]);
  assert.equal(count(r.raw, 'SELECT COUNT(*) AS n FROM notify_outbox'), 1, 'the UNIQUE index is the second line of defence');
});

test('an event this service does not handle is refused, not half-processed — and is RETRYABLE, not poison', async () => {
  const r = await rig();
  const catalog = await producer('catalog');
  const keys = await ringOf(catalog);
  const consumer = createNotificationsConsumer({ keys, env: r.env });
  const res = await consumer.deliver(r.db, [await sign(catalog, fixture('ProductViewed'))]);
  // "no handler for this key" is the normal, temporary state of a consumer
  // that has not been redeployed yet — every service bundles its own contracts
  // snapshot and the svc-*.yml workflows deploy independently. Dead-lettering
  // it on the first attempt would lose every event emitted in a deploy window.
  assert.equal(res.results[0].result, 'retry');
  assert.equal(count(r.raw, 'SELECT COUNT(*) AS n FROM user_notifications'), 0);
});

test('a forged envelope — right type, wrong producer — is refused before any row is written', async () => {
  const r = await rig();
  const impostor = await producer('reviews');
  const keys = await ringOf(impostor);
  const consumer = createNotificationsConsumer({ keys, env: r.env });
  const event = fixture('DepositDecided');
  event.source_service = 'reviews';
  const res = await consumer.deliver(r.db, [await sign(impostor, event)]);
  assert.equal(res.results[0].result, 'forged');
  assert.equal(count(r.raw, 'SELECT COUNT(*) AS n FROM user_notifications'), 0);
});

// ------------------------------------------------------------------ pump

test('PUMP: the master switch off claims nothing and sends nothing', async () => {
  const r = await rig(UNCONFIGURED_ENV, resolver);
  await r.consumer.deliver(r.db, [await sign(r.identity, fixture('UserCreated'))]);
  const report = await pump({ db: r.db, env: { ...CONFIGURED_ENV, NOTIFY_DELIVERY: 'off' }, transports: new TransportRegistry(), fetchImpl: forbiddenFetch, now: () => NOW });
  assert.deepEqual(report, { claimed: 0, sent: 0, failed: 0, dropped: 0, skipped: 0, disabled: true });
  assert.equal(count(r.raw, "SELECT COUNT(*) AS n FROM notify_outbox WHERE state = 'pending'"), 1, 'the row is still there, unsent');
});

test('PUMP: the master switch fails CLOSED — unset, empty or misspelt is off', async () => {
  for (const value of [undefined, '', 'yes', 'true']) {
    const r = await rig(UNCONFIGURED_ENV, resolver);
    await r.consumer.deliver(r.db, [await sign(r.identity, fixture('UserCreated'))]);
    const report = await pump({ db: r.db, env: { ...CONFIGURED_ENV, NOTIFY_DELIVERY: value }, transports: new TransportRegistry(), fetchImpl: forbiddenFetch, now: () => NOW });
    assert.equal(report.disabled, true, String(value));
  }
});

test('PUMP: an unconfigured transport drops the row with its own reason and makes NO request', async () => {
  const r = await rig(UNCONFIGURED_ENV, resolver);
  await r.consumer.deliver(r.db, [await sign(r.identity, fixture('UserCreated'))]);
  const report = await pump({ db: r.db, env: UNCONFIGURED_ENV, transports: new TransportRegistry(), fetchImpl: forbiddenFetch, now: () => NOW });
  assert.equal(report.dropped, 1);
  assert.equal(report.sent, 0);
  const row = all<{ state: string; last_error: string }>(r.raw, 'SELECT state, last_error FROM notify_outbox')[0];
  assert.equal(row.state, 'dead');
  assert.equal(row.last_error, 'EMAIL_NOT_CONFIGURED');
  const delivery = all<{ status: string; error: string; channel: string }>(r.raw, 'SELECT status, error, channel FROM notify_deliveries')[0];
  assert.equal(delivery.status, 'dropped');
  assert.equal(delivery.channel, 'email');
});

test('PUMP: a configured transport sends once, records sent, and never sends the same row again', async () => {
  const r = await rig(UNCONFIGURED_ENV, resolver);
  await r.consumer.deliver(r.db, [await sign(r.identity, fixture('UserCreated'))]);
  const { impl, calls } = recordingFetch({ status: 200, body: { id: 'msg_1' } });
  const first = await pump({ db: r.db, env: CONFIGURED_ENV, transports: new TransportRegistry(), fetchImpl: impl, now: () => NOW });
  assert.equal(first.sent, 1);
  assert.equal(calls.length, 1);
  assert.equal((calls[0].init.headers as Record<string, string>)['Idempotency-Key'], 'user:usr_01:verify');

  const second = await pump({ db: r.db, env: CONFIGURED_ENV, transports: new TransportRegistry(), fetchImpl: impl, now: () => NOW });
  assert.deepEqual({ claimed: second.claimed, sent: second.sent }, { claimed: 0, sent: 0 }, 'a sent row is never claimed again');
  assert.equal(calls.length, 1);
  const row = all<{ state: string; sent_at: string; attempts: number }>(r.raw, 'SELECT state, sent_at, attempts FROM notify_outbox')[0];
  assert.deepEqual({ state: row.state, sent_at: row.sent_at, attempts: row.attempts }, { state: 'sent', sent_at: NOW, attempts: 1 });
});

test('PUMP: the staging allowlist skips a non-allowlisted recipient without sending, and logs no address', async () => {
  const r = await rig(UNCONFIGURED_ENV, resolver);
  await r.consumer.deliver(r.db, [await sign(r.identity, fixture('UserCreated'))]);
  const logged: unknown[] = [];
  const report = await pump({
    db: r.db,
    env: { ...CONFIGURED_ENV, EMAIL_ALLOWED_RECIPIENTS: 'only@allowed.test' },
    transports: new TransportRegistry(),
    fetchImpl: forbiddenFetch,
    now: () => NOW,
    log: {
      debug() {},
      info() {},
      warn: (_m: string, f?: Record<string, unknown>) => void logged.push(f),
      error() {},
      money() {},
      child() {
        return this;
      },
    } as never,
  });
  assert.equal(report.skipped, 1);
  assert.equal(all<{ state: string }>(r.raw, 'SELECT state FROM notify_outbox')[0].state, 'skipped');
  assert.equal(JSON.stringify(logged).includes('new@example.com'), false, 'an address is a contact and is never logged');
});

test('PUMP: a 5xx becomes failed and is retried until the attempt ceiling turns it dead', async () => {
  const r = await rig(UNCONFIGURED_ENV, resolver);
  await r.consumer.deliver(r.db, [await sign(r.identity, fixture('UserCreated'))]);
  const { impl } = recordingFetch({ status: 500, body: { message: 'down' } });
  for (let i = 0; i < 6; i++) {
    await pump({ db: r.db, env: CONFIGURED_ENV, transports: new TransportRegistry(), fetchImpl: impl, now: () => NOW });
  }
  const row = all<{ state: string; attempts: number; last_error: string }>(r.raw, 'SELECT state, attempts, last_error FROM notify_outbox')[0];
  assert.equal(row.state, 'dead');
  assert.equal(row.attempts, 5, 'MAX_ATTEMPTS, exactly as the core has it');
  assert.match(row.last_error, /resend 500/);
});

test('PUMP: an unparseable payload is dead on the first attempt — retrying it would never help', async () => {
  const { db, raw } = notifyDb();
  raw.prepare("INSERT INTO notify_outbox (id, kind, event_key, recipient, payload) VALUES ('o1','email','k','a@b.test','not json')").run();
  const report = await pump({ db, env: CONFIGURED_ENV, transports: new TransportRegistry(), fetchImpl: forbiddenFetch, now: () => NOW });
  assert.equal(report.failed, 1);
  assert.equal(all<{ state: string }>(raw, 'SELECT state FROM notify_outbox')[0].state, 'dead');
});
