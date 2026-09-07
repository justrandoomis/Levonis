import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SagaStore, sagaSchemaSql, canTransition, sweepAction, SAGA_STUCK_AFTER_FAILURES } from '../src/saga';
import { memoryDb, row, count } from './_sqlite';

let t = Date.UTC(2026, 8, 7, 10, 0, 0);
const now = () => new Date(t).toISOString();

function setup() {
  const { db, raw } = memoryDb(sagaSchemaSql('commerce') + 'CREATE TABLE orders (id TEXT PRIMARY KEY, saga_id TEXT NOT NULL);');
  return { db, raw, store: new SagaStore(db, 'commerce', now) };
}

test('legal transitions only; the sweep decision follows the state', () => {
  assert.ok(canTransition('started', 'local_committed'));
  assert.ok(canTransition('started', 'compensating'));
  assert.ok(canTransition('local_committed', 'done'));
  assert.ok(!canTransition('done', 'started'));
  assert.ok(!canTransition('compensating', 'local_committed'), 'a compensating saga never commits');
  assert.equal(sweepAction('started'), 'compensate');
  assert.equal(sweepAction('local_committed'), 'retry_commit');
  assert.equal(sweepAction('compensating'), 'retry_compensation');
  assert.equal(sweepAction('done'), 'none');
});

test('the fence on both sides: request wins -> the sweep flips 0 rows; sweep wins -> the local batch aborts and persists nothing', async () => {
  const { db, raw, store } = setup();
  await store.begin({ id: 'saga_1', kind: 'checkout', userId: 'usr_01', aggregateId: 'ord_1', input: { quote: 1 } });
  // request side: fence + guarded local batch
  await db.batch([store.fenceStatement('saga_1', 'started', 'local_committed', 'local'), store.fenceGuardStatement('saga_1', 'local_committed'), db.prepare("INSERT INTO orders (id, saga_id) VALUES ('ord_1', 'saga_1')")]);
  assert.equal(row(raw, "SELECT state FROM commerce_sagas WHERE id = 'saga_1'")!.state, 'local_committed');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM orders'), 1);
  // the sweep arriving late changes nothing
  assert.equal(await store.transition('saga_1', 'started', 'compensating'), false);
  // the other race: the sweep flips first, then the request's batch must abort as a whole
  await store.begin({ id: 'saga_2', kind: 'checkout', userId: 'usr_02', aggregateId: 'ord_2', input: {} });
  assert.equal(await store.transition('saga_2', 'started', 'compensating', 'sweep'), true);
  await assert.rejects(
    () => db.batch([store.fenceStatement('saga_2', 'started', 'local_committed'), store.fenceGuardStatement('saga_2', 'local_committed'), db.prepare("INSERT INTO orders (id, saga_id) VALUES ('ord_2', 'saga_2')")]),
    /NOT NULL/
  );
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM orders WHERE id = 'ord_2'"), 0, 'nothing persisted');
  assert.equal(row(raw, "SELECT state FROM commerce_sagas WHERE id = 'saga_2'")!.state, 'compensating');
  assert.throws(() => store.fenceStatement('saga_2', 'done', 'started'), /illegal transition/);
});

test('one in-flight saga per user, stuck excluded; failures count up to stuck; stale selection', async () => {
  const { db, raw, store } = setup();
  await store.begin({ id: 's1', kind: 'checkout', userId: 'usr_01', aggregateId: 'o1', input: {} });
  await assert.rejects(() => store.begin({ id: 's2', kind: 'checkout', userId: 'usr_01', aggregateId: 'o2', input: {} }), /UNIQUE/);
  await store.transition('s1', 'started', 'local_committed');
  for (let i = 1; i < SAGA_STUCK_AFTER_FAILURES; i++) {
    const r = await store.recordFailure('s1', `commit failed ${i}`);
    assert.equal(r.stuck, false);
  }
  const last = await store.recordFailure('s1', 'commit failed again');
  assert.equal(last.stuck, true);
  assert.equal(last.failures, SAGA_STUCK_AFTER_FAILURES);
  // a stuck saga never blocks the customer's next order
  await store.begin({ id: 's3', kind: 'checkout', userId: 'usr_01', aggregateId: 'o3', input: {} });
  t += 130_000;
  const stale = await store.stale('checkout', new Date(t - 120_000).toISOString());
  assert.deepEqual(stale.map((s) => s.id), ['s3'], 'only in-flight sagas older than the window; stuck is not in flight');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM commerce_sagas WHERE state = 'stuck'"), 1);
  void db;
});
