import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IdempotencyStore, idempotencySchemaSql, assertIdempotencyKey } from '../src/idempotency';
import { KitError } from '../src/errors';
import { memoryDb } from './_sqlite';

test('the command idempotency store is scoped to the caller: user B replaying user A key never receives A response', async () => {
  const { db } = memoryDb(idempotencySchemaSql('commerce'));
  const store = new IdempotencyStore(db, { prefix: 'commerce', service: 'commerce', storeBodies: true, now: () => '2026-09-07T10:00:00.000Z' });
  const key = 'c9d1d7b2-9f7e-4d3a-8f1a-1b2c3d4e5f60';
  const hash = await IdempotencyStore.hashPayload({ lines: [{ product_id: 'p1', qty: 1 }] });
  assert.deepEqual(await store.begin('usr_A', key, hash), { kind: 'new' });
  assert.deepEqual(await store.begin('usr_A', key, hash), { kind: 'in_progress' });
  await store.complete('usr_A', key, 200, { order_id: 'ord_01' });
  assert.deepEqual(await store.begin('usr_A', key, hash), { kind: 'replay', status: 200, body: '{"order_id":"ord_01"}' });
  assert.deepEqual(await store.begin('usr_B', key, hash), { kind: 'new' }, 'a different scope is a different command');
  // same key, different payload -> 409 IDEMPOTENCY_MISMATCH
  const other = await IdempotencyStore.hashPayload({ lines: [{ product_id: 'p1', qty: 2 }] });
  await assert.rejects(() => store.begin('usr_A', key, other), (e: unknown) => e instanceof KitError && e.code === 'IDEMPOTENCY_MISMATCH' && e.status === 409);
});

test('keys shorter than 16 characters are refused with 400; bodies are not stored when the route recomputes', async () => {
  const { db } = memoryDb(idempotencySchemaSql('ledger'));
  const store = new IdempotencyStore(db, { prefix: 'ledger', service: 'ledger' });
  await assert.rejects(() => store.begin('usr_A', 'short', 'h'), (e: unknown) => e instanceof KitError && e.code === 'IDEMPOTENCY_KEY_INVALID' && e.status === 400);
  assert.throws(() => assertIdempotencyKey(12345), KitError);
  await store.begin('usr_A', 'a-long-enough-key-0001', 'h');
  await store.complete('usr_A', 'a-long-enough-key-0001', 200, { secret: 'never stored' });
  const r = await store.begin('usr_A', 'a-long-enough-key-0001', 'h');
  assert.deepEqual(r, { kind: 'replay', status: 200, body: null });
  await store.release('usr_A', 'a-long-enough-key-0001');
  assert.equal((await store.begin('usr_A', 'a-long-enough-key-0001', 'h')).kind, 'replay', 'release only frees in-progress claims');
  assert.equal(await store.prune('2999-01-01T00:00:00.000Z'), 1);
});
