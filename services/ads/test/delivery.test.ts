/**
 * The delivery engine end to end, against the REAL schema
 * (`migrations/0001_ads.sql` applied to an in-memory SQLite with foreign keys
 * and UNIQUE indexes on), driven through the REAL consumer, with a `fetch`
 * that throws unless a test explicitly allows one.
 *
 * The five properties the slice is judged on:
 *   - the sandbox never fetches;
 *   - consent gates the identifier, before persistence;
 *   - delivery is idempotent on (event_id, provider);
 *   - the three kill switches each stop the right thing;
 *   - a transient failure backs off, retries and finally dead-letters.
 */
import { test } from 'node:test';
import { uuidv7 } from '@levonis/platform-kit/correlation';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import type { EventEnvelope } from '@levonis/contracts/envelope';
import { MAX_DELIVERY_ATTEMPTS } from '@levonis/platform-kit/bus';
import { createAdsConsumer } from '../src/consumers';
import { deliverEnvelope, retryDue } from '../src/deliver';
import { ProviderRegistry } from '../src/registry';
import { dueRetries } from '../src/store';
import { adsDb, CONFIGURED_ENV, fixture, forbiddenFetch, producer, recordingFetch, ringOf, sign, UNCONFIGURED_ENV, type TestProducer } from './_harness';

const all = <T>(raw: DatabaseSync, sql: string, ...p: unknown[]): T[] => (raw.prepare(sql).all(...(p as never[])) as object[]).map((r) => ({ ...r })) as T[];
const count = (raw: DatabaseSync, sql: string, ...p: unknown[]): number => Number((raw.prepare(sql).get(...(p as never[])) as { n: number }).n);

interface Row {
  provider: string;
  status: string;
  attempts: number;
  error: string | null;
  next_attempt_at: string | null;
  payload: string;
  event_id: string;
  id: string;
}

const NOW = '2026-09-07T11:00:00.000Z';

async function rig(env: Record<string, string | undefined> = UNCONFIGURED_ENV, fetchImpl: typeof fetch = forbiddenFetch) {
  const { db, raw } = adsDb();
  const commerce = await producer('commerce');
  const identity = await producer('identity');
  const subs = await producer('subscriptions');
  const keys = await ringOf(commerce, identity, subs);
  const registry = new ProviderRegistry();
  const consumer = createAdsConsumer({ keys, deps: { env, registry, fetchImpl }, now: () => NOW });
  return { db, raw, commerce, identity, subs, registry, consumer, env, fetchImpl };
}

/** A `UserUpdated` that grants ads consent, so the later conversions have somewhere to join. */
async function grantConsent(rigged: Awaited<ReturnType<typeof rig>>, p: TestProducer = rigged.identity): Promise<EventEnvelope> {
  const env = await sign(p, fixture('UserUpdated'));
  await rigged.consumer.deliver(rigged.db, [env]);
  return env;
}

test('SANDBOX: with no provider secret set, every conversion is recorded status=sandbox and NOTHING reaches the network', async () => {
  const r = await rig(UNCONFIGURED_ENV, forbiddenFetch);
  await grantConsent(r);
  const purchase = await sign(r.commerce, fixture('PurchaseCompleted'));
  const res = await r.consumer.deliver(r.db, [purchase]);
  assert.deepEqual(res.results, [{ event_id: purchase.event_id, result: 'acked' }]);
  const rows = all<Row>(r.raw, 'SELECT provider, status, attempts, error, next_attempt_at, payload, event_id, id FROM ads_deliveries WHERE event_type = ?', 'PurchaseCompleted');
  assert.equal(rows.length, 4, 'one row per delivering provider');
  for (const row of rows) assert.equal(row.status, 'sandbox', `${row.provider} must be sandbox`);
  // the mapping still ran: a sandbox row carries the payload it would have sent
  const meta = rows.find((x) => x.provider === 'meta_capi')!;
  assert.equal((JSON.parse(meta.payload) as { event_id: string }).event_id, purchase.event_id);
});

test('CONSENT: without an ads snapshot the delivery is no_consent, no identifier is stored and nothing is sent', async () => {
  const r = await rig(CONFIGURED_ENV, forbiddenFetch);
  // no UserUpdated first: Ads has never heard of this user_hash
  const purchase = await sign(r.commerce, fixture('PurchaseCompleted'));
  await r.consumer.deliver(r.db, [purchase]);
  const rows = all<Row>(r.raw, 'SELECT provider, status, payload, attempts, error, next_attempt_at, event_id, id FROM ads_deliveries');
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.equal(row.status, 'no_consent');
    assert.equal(row.payload, '{}', 'a no_consent row carries no payload, so it carries no identifier');
  }
});

test('CONSENT: withdrawing consent erases the stored hashes rather than merely stopping their use', async () => {
  const r = await rig(UNCONFIGURED_ENV);
  await grantConsent(r);
  const stored = all<{ email_hash: string | null; phone_hash: string | null; consent: string; first_ads_at: string | null }>(
    r.raw,
    'SELECT email_hash, phone_hash, consent, first_ads_at FROM ads_consent_snapshots'
  );
  assert.equal(stored.length, 1);
  assert.equal(stored[0].consent, 'ads');
  assert.ok(stored[0].email_hash && stored[0].phone_hash);

  const withdrawn = fixture('UserUpdated');
  withdrawn.event_id = '01a07b4f-78e8-7882-9f2a-20ed4c30c3d0';
  withdrawn.aggregate_seq = 2;
  (withdrawn.payload as Record<string, unknown>).marketing_consent = 'none';
  await r.consumer.deliver(r.db, [await sign(r.identity, withdrawn)]);
  const after = all<{ email_hash: string | null; phone_hash: string | null; consent: string; first_ads_at: string | null }>(
    r.raw,
    'SELECT email_hash, phone_hash, consent, first_ads_at FROM ads_consent_snapshots'
  );
  assert.equal(after[0].consent, 'none');
  assert.equal(after[0].email_hash, null, 'the hash is gone, not flagged');
  assert.equal(after[0].phone_hash, null);
  assert.ok(after[0].first_ads_at, 'the first-consent stamp survives, so CompleteRegistration never fires twice');
});

test('CONSENT: an out-of-order redelivery of an older UserUpdated cannot resurrect a withdrawn consent', async () => {
  const r = await rig(UNCONFIGURED_ENV);
  const first = await grantConsent(r); // seq 1, consent ads
  const withdrawn = fixture('UserUpdated');
  withdrawn.event_id = '01a07b4f-78e8-7882-9f2a-20ed4c30c3d1';
  withdrawn.aggregate_seq = 5;
  (withdrawn.payload as Record<string, unknown>).marketing_consent = 'none';
  await r.consumer.deliver(r.db, [await sign(r.identity, withdrawn)]);
  // the seq-1 event arrives again with a different event_id (a genuine replay from another producer run)
  const late = { ...first, event_id: '01a07b4f-78e8-7882-9f2a-20ed4c30c3d2' };
  await r.consumer.deliver(r.db, [await sign(r.identity, late as EventEnvelope)]);
  const row = all<{ consent: string; last_seq: number }>(r.raw, 'SELECT consent, last_seq FROM ads_consent_snapshots')[0];
  assert.equal(row.consent, 'none');
  assert.equal(row.last_seq, 5);
});

test('CompleteRegistration fires on the FIRST transition to ads consent and never again', async () => {
  const r = await rig(UNCONFIGURED_ENV);
  await grantConsent(r);
  assert.equal(count(r.raw, "SELECT COUNT(*) AS n FROM ads_deliveries WHERE event_type = 'UserUpdated'"), 4);
  const again = fixture('UserUpdated');
  again.event_id = '01a07b4f-78e8-7882-9f2a-20ed4c30c3d3';
  again.aggregate_seq = 2;
  await r.consumer.deliver(r.db, [await sign(r.identity, again)]);
  assert.equal(count(r.raw, "SELECT COUNT(*) AS n FROM ads_deliveries WHERE event_type = 'UserUpdated'"), 4, 'a second ads-consent event maps to nothing');
});

test('IDEMPOTENCY: a redelivered envelope produces no second delivery row and is acked as replayed', async () => {
  const r = await rig(UNCONFIGURED_ENV);
  await grantConsent(r);
  const purchase = await sign(r.commerce, fixture('PurchaseCompleted'));
  await r.consumer.deliver(r.db, [purchase]);
  const second = await r.consumer.deliver(r.db, [purchase, purchase]);
  assert.deepEqual(second.results.map((x) => x.result), ['replayed', 'replayed']);
  assert.equal(count(r.raw, "SELECT COUNT(*) AS n FROM ads_deliveries WHERE event_type = 'PurchaseCompleted'"), 4);
});

test('IDEMPOTENCY: even with the processed_events row removed, UNIQUE (event_id, provider) collapses the second attempt', async () => {
  const r = await rig(UNCONFIGURED_ENV);
  await grantConsent(r);
  const purchase = await sign(r.commerce, fixture('PurchaseCompleted'));
  await r.consumer.deliver(r.db, [purchase]);
  r.raw.prepare('DELETE FROM ads_processed_events WHERE event_id = ?').run(purchase.event_id);
  const res = await r.consumer.deliver(r.db, [purchase]);
  assert.equal(res.results[0].result, 'acked');
  assert.equal(count(r.raw, "SELECT COUNT(*) AS n FROM ads_deliveries WHERE event_type = 'PurchaseCompleted'"), 4, 'the table itself refuses the duplicate');
});

test('KILL SWITCH — global: ADS_ENABLED off writes nothing at all, not even a row', async () => {
  const r = await rig({ ...UNCONFIGURED_ENV, ADS_ENABLED: 'off' });
  await grantConsent(r);
  const purchase = await sign(r.commerce, fixture('PurchaseCompleted'));
  const res = await r.consumer.deliver(r.db, [purchase]);
  assert.equal(res.results[0].result, 'acked', 'the event is still acked: the producer must not be held open');
  assert.equal(count(r.raw, 'SELECT COUNT(*) AS n FROM ads_deliveries'), 0);
  assert.equal(count(r.raw, 'SELECT COUNT(*) AS n FROM ads_consent_snapshots'), 0);
});

test('KILL SWITCH — global fails CLOSED: an unset, empty or misspelt var is off', async () => {
  for (const value of [undefined, '', 'yes', 'true', 'ON ']) {
    const r = await rig({ ADS_ENABLED: value });
    await r.consumer.deliver(r.db, [await sign(r.commerce, fixture('PurchaseCompleted'))]);
    const expected = (value ?? '').trim().toLowerCase() === 'on' ? 4 : 0;
    assert.equal(count(r.raw, 'SELECT COUNT(*) AS n FROM ads_deliveries'), expected, `ADS_ENABLED=${String(value)}`);
  }
});

test('KILL SWITCH — per provider: a disabled provider gets no row; the others are untouched', async () => {
  const r = await rig(UNCONFIGURED_ENV);
  await grantConsent(r);
  r.raw.prepare("UPDATE ads_providers SET enabled = 0 WHERE name = 'tiktok'").run();
  await r.consumer.deliver(r.db, [await sign(r.commerce, fixture('PurchaseCompleted'))]);
  const providers = all<{ provider: string }>(r.raw, "SELECT provider FROM ads_deliveries WHERE event_type = 'PurchaseCompleted' ORDER BY provider").map((x) => x.provider);
  assert.deepEqual(providers, ['google_ads', 'meta_capi', 'snapchat']);
});

test('KILL SWITCH — per event: a disabled event type produces nothing for anyone', async () => {
  const r = await rig(UNCONFIGURED_ENV);
  await grantConsent(r);
  r.raw.prepare("UPDATE ads_event_map SET enabled = 0 WHERE event_type = 'PurchaseCompleted'").run();
  await r.consumer.deliver(r.db, [await sign(r.commerce, fixture('PurchaseCompleted'))]);
  assert.equal(count(r.raw, "SELECT COUNT(*) AS n FROM ads_deliveries WHERE event_type = 'PurchaseCompleted'"), 0);
});

test('SubscriptionChanged maps only while the membership is active', async () => {
  const r = await rig(UNCONFIGURED_ENV);
  const inactive = fixture('SubscriptionChanged');
  (inactive.payload as Record<string, unknown>).active = false;
  await r.consumer.deliver(r.db, [await sign(r.subs, inactive)]);
  assert.equal(count(r.raw, "SELECT COUNT(*) AS n FROM ads_deliveries WHERE event_type = 'SubscriptionChanged'"), 0);
  // and the user_id it carries — a `pii` field — is never persisted
  assert.equal(count(r.raw, "SELECT COUNT(*) AS n FROM ads_deliveries WHERE payload LIKE '%usr_01%'"), 0);
});

test('a personal envelope is refused before any state is touched, whatever the subscriptions table says', async () => {
  const r = await rig(UNCONFIGURED_ENV);
  const ledger = await producer('ledger');
  const keys = await ringOf(ledger);
  const consumer = createAdsConsumer({ keys, deps: { env: r.env, registry: r.registry, fetchImpl: forbiddenFetch } });
  const res = await consumer.deliver(r.db, [await sign(ledger, fixture('DepositDecided'))]);
  // A type this consumer has no handler for is RETRYABLE, not poison: it is
  // what a consumer that has not been redeployed yet looks like.
  assert.equal(res.results[0].result, 'retry', 'DepositDecided is not a type this consumer accepts at all');
  assert.equal(count(r.raw, 'SELECT COUNT(*) AS n FROM ads_deliveries'), 0);
});

test('RETRY: a 5xx becomes a failed row with a backoff, the sweeper retries it, and it finally dead-letters', async () => {
  const r = await rig(CONFIGURED_ENV, recordingFetch({ status: 503, body: { error: 'busy' } }).impl);
  await grantConsent(r);
  const purchase = await sign(r.commerce, fixture('PurchaseCompleted'));
  await r.consumer.deliver(r.db, [purchase]);
  // deliver() QUEUES; it never sends (see the header of src/deliver.ts).
  assert.equal(count(r.raw, "SELECT COUNT(*) AS n FROM ads_deliveries WHERE status = 'pending' AND event_type = 'PurchaseCompleted'"), 4);

  const deps = { db: r.db, env: CONFIGURED_ENV, registry: r.registry, fetchImpl: r.fetchImpl, now: () => NOW };
  await retryDue(await dueRetries(r.db, NOW), deps);
  const failed = all<Row>(r.raw, "SELECT id, provider, status, attempts, error, next_attempt_at, payload, event_id FROM ads_deliveries WHERE status = 'failed'");
  assert.ok(failed.length >= 1, 'a 5xx is a retryable failure');
  for (const row of failed) {
    assert.equal(row.attempts, 1);
    assert.ok(row.next_attempt_at && row.next_attempt_at > NOW, 'a backoff was set');
  }

  // the sweeper: nothing is due yet
  assert.equal((await dueRetries(r.db, NOW)).length, 0);

  // drive it to the attempt ceiling
  for (let i = 0; i < MAX_DELIVERY_ATTEMPTS + 1; i++) {
    r.raw.prepare("UPDATE ads_deliveries SET next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE status = 'failed'").run();
    const due = await dueRetries(r.db, NOW);
    if (due.length === 0) break;
    await retryDue(due, deps);
  }
  assert.equal(count(r.raw, "SELECT COUNT(*) AS n FROM ads_deliveries WHERE status = 'failed'"), 0);
  const dead = count(r.raw, "SELECT COUNT(*) AS n FROM ads_deliveries WHERE status = 'dead'");
  assert.ok(dead >= 1, 'out of attempts means dead');
  assert.equal(count(r.raw, 'SELECT COUNT(*) AS n FROM ads_dead_letters'), dead, 'every dead delivery has exactly one DLQ row');
});

/**
 * TWO OVERLAPPING TICKS MUST NOT SEND THE SAME ROW TWICE.
 *
 * The cron is `* * * * *` and a sweep of a slow provider takes minutes, so
 * ticks overlap by construction. The claim is what makes the second tick find
 * nothing to do.
 */
test('the sweeper claims a row before sending it, so an overlapping tick sends nothing', async () => {
  const { impl, calls } = recordingFetch({ status: 503, body: { error: 'busy' } });
  const r = await rig(CONFIGURED_ENV, impl);
  await grantConsent(r);
  await r.consumer.deliver(r.db, [await sign(r.commerce, fixture('PurchaseCompleted'))]);
  const deps = { db: r.db, env: CONFIGURED_ENV, registry: r.registry, fetchImpl: impl, retries: 0, now: () => NOW };

  // Both ticks read the same due set — the overlap this guards against.
  const due = await dueRetries(r.db, NOW);
  assert.ok(due.length >= 4);
  const first = await retryDue(due, deps);
  const before = calls.length;
  const second = await retryDue(due, deps);
  assert.equal(first.retried, due.length);
  assert.equal(second.retried, 0, 'the second tick claimed nothing');
  assert.equal(calls.length, before, 'and therefore made no request');
});

test('a sweep stops at its send budget and leaves the rest due', async () => {
  const { impl, calls } = recordingFetch({ status: 200, body: { events_received: 1, code: 0, status: 'SUCCESS' } });
  const r = await rig(CONFIGURED_ENV, impl);
  await grantConsent(r);
  await r.consumer.deliver(r.db, [await sign(r.commerce, fixture('PurchaseCompleted'))]);
  const due = await dueRetries(r.db, NOW);
  const report = await retryDue(due, { db: r.db, env: CONFIGURED_ENV, registry: r.registry, fetchImpl: impl, retries: 0, now: () => NOW, sendBudget: 2 });
  assert.equal(report.retried, 2);
  assert.equal(report.deferred, due.length - 2, 'the rest are left for the next tick');
  assert.equal(calls.length, 2, 'the budget bounds the OUTBOUND work, which is the point');
});

test('deliver() makes no outbound request at all, however many events and providers are in play', async () => {
  const r = await rig(CONFIGURED_ENV, forbiddenFetch);
  await grantConsent(r);
  const batch = [];
  for (let i = 0; i < 10; i++) {
    batch.push(await sign(r.commerce, { ...fixture('PurchaseCompleted'), event_id: uuidv7() }));
  }
  // `forbiddenFetch` THROWS: the proof is that the batch succeeds at all.
  const res = await r.consumer.deliver(r.db, batch);
  assert.deepEqual([...new Set(res.results.map((x) => x.result))], ['acked']);
  assert.equal(count(r.raw, "SELECT COUNT(*) AS n FROM ads_deliveries WHERE status = 'pending' AND event_type = 'PurchaseCompleted'"), 40, '10 events x 4 providers, all queued');
});

test('RETRY: a 4xx is rejected once and never retried — our payload is wrong, repeating it is noise', async () => {
  const r = await rig(CONFIGURED_ENV, recordingFetch({ status: 400, body: { error: 'bad payload' } }).impl);
  await grantConsent(r);
  await r.consumer.deliver(r.db, [await sign(r.commerce, fixture('PurchaseCompleted'))]);
  await retryDue(await dueRetries(r.db, NOW), { db: r.db, env: CONFIGURED_ENV, registry: r.registry, fetchImpl: r.fetchImpl, now: () => NOW });
  assert.ok(count(r.raw, "SELECT COUNT(*) AS n FROM ads_deliveries WHERE status = 'rejected'") >= 1);
  assert.equal((await dueRetries(r.db, '2100-01-01T00:00:00.000Z')).length, 0, 'a rejected row is never swept');
});

test('BREAKER: five consecutive failures open the per-provider breaker and the sixth attempt fails fast', async () => {
  const { db } = adsDb();
  const registry = new ProviderRegistry();
  const { impl, calls } = recordingFetch({ status: 500, body: {} });
  const resolved = registry.resolve('meta_capi', CONFIGURED_ENV)!;
  const deps = { db, env: CONFIGURED_ENV, registry, fetchImpl: impl, retries: 0, timeoutMs: 500 };
  const mapped = { event_id: 'e', event_type: 'PurchaseCompleted', event_name: 'Purchase', body: {} };
  const { attempt } = await import('../src/deliver');
  for (let i = 0; i < 5; i++) await attempt(resolved, mapped, deps, 'cid', NOW, 0);
  assert.equal(resolved.breaker.state, 'open');
  const before = calls.length;
  const out = await attempt(resolved, mapped, deps, 'cid', NOW, 0);
  assert.equal(calls.length, before, 'an open breaker makes no request');
  assert.equal(out.status, 'failed', 'and the conversion is postponed, never dropped');
});

test('a successful send is recorded sent, with a delivery time and no backoff', async () => {
  const r = await rig(CONFIGURED_ENV, recordingFetch({ status: 200, body: { events_received: 1, code: 0, status: 'SUCCESS' } }).impl);
  await grantConsent(r);
  await r.consumer.deliver(r.db, [await sign(r.commerce, fixture('PurchaseCompleted'))]);
  await retryDue(await dueRetries(r.db, NOW), { db: r.db, env: CONFIGURED_ENV, registry: r.registry, fetchImpl: r.fetchImpl, now: () => NOW });
  const rows = all<Row & { delivered_at: string | null }>(r.raw, "SELECT provider, status, attempts, error, next_attempt_at, payload, event_id, id, delivered_at FROM ads_deliveries WHERE event_type = 'PurchaseCompleted'");
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.equal(row.status, 'sent', row.provider);
    assert.equal(row.delivered_at, NOW);
    assert.equal(row.next_attempt_at, null);
  }
});

test('the engine returns statements rather than executing them, so the side effect and processed_events commit together', async () => {
  const r = await rig(UNCONFIGURED_ENV);
  await grantConsent(r);
  const result = await deliverEnvelope(await sign(r.commerce, fixture('PurchaseCompleted')), {
    db: r.db,
    env: UNCONFIGURED_ENV,
    registry: r.registry,
    now: () => NOW,
    fetchImpl: forbiddenFetch,
  });
  assert.equal(result.statements.length, 4);
  assert.equal(result.transient, false);
  assert.equal(count(r.raw, "SELECT COUNT(*) AS n FROM ads_deliveries WHERE event_type = 'PurchaseCompleted'"), 0, 'nothing was written yet');
});
