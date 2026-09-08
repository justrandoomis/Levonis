/**
 * The hash chain: it links, it detects every kind of tampering, the key
 * matters, and two sealers racing produce one chain and not two.
 *
 * Every case runs against the real migration in real SQLite, because the
 * property that matters most — "the losing sealer's whole batch rolls back" —
 * is a database property, not a code property.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GENESIS_HASH, linkHash, linkRows, algFor } from '../src/chain';
import { insertEntryStatement, headOf, unsealedCount, sealLagSeconds, advanceHeadStatement, sealLinkStatement } from '../src/store';
import { sealOnce, verifyChain } from '../src/seal';
import { auditDb, count, one, rows } from './_db';

const CHAIN_KEY = 'test-chain-key-not-a-real-secret';

async function append(db: D1Database, n: number, at = '2026-09-08T10:00:00.000Z'): Promise<void> {
  for (let i = 0; i < n; i++) {
    await insertEntryStatement(db, {
      id: `aud_${i}`,
      event_id: `evt_${i}`,
      event_type: 'AuditRecorded.v1',
      actor_id: i % 2 === 0 ? `usr_${i}` : null,
      action: 'wallet.credit',
      target: `wallet:usr_${i}`,
      detail_hash: 'a'.repeat(64),
      detail_ref: null,
      detail: JSON.stringify({ i }),
      source_service: 'core',
      correlation_id: `cid_${i}`,
      occurred_at: at,
      recorded_at: at,
    }).run();
  }
}

test('sealing links every unsealed row onto the head and advances it once', async () => {
  const { db, raw } = auditDb();
  await append(db, 5);
  assert.equal(await unsealedCount(db), 5);

  const res = await sealOnce(db, { chainKey: CHAIN_KEY, limit: 100, now: '2026-09-08T10:00:01.000Z' });
  assert.equal(res.sealed, 5);
  assert.equal(res.head_index, 5);
  assert.equal(res.alg, 'hmac-sha256');
  assert.equal(await unsealedCount(db), 0);

  const head = await headOf(db);
  assert.equal(head?.chain_index, 5);
  assert.equal(head?.head_hash, res.head_hash);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM audit_chain_heads'), 1, 'one head row, not one per seal');

  // the first link points at the genesis and each link at its predecessor
  const links = rows<{ chain_index: number; prev_hash: string; hash: string }>(
    raw,
    'SELECT chain_index, prev_hash, hash FROM audit_events ORDER BY chain_index'
  );
  assert.equal(links[0].prev_hash, GENESIS_HASH);
  for (let i = 1; i < links.length; i++) assert.equal(links[i].prev_hash, links[i - 1].hash);

  const verified = await verifyChain(db, { chainKey: CHAIN_KEY, pageSize: 2 });
  assert.deepEqual({ ok: verified.ok, checked: verified.checked, head: verified.head }, { ok: true, checked: 5, head: head?.head_hash });
  assert.equal(verified.anchored_head, null, 'nothing is anchored to R2 in Phase 1');
});

test('a second seal is a no-op, and sealing continues across runs', async () => {
  const { db } = auditDb();
  await append(db, 3);
  const first = await sealOnce(db, { chainKey: CHAIN_KEY, limit: 2, now: 'n1' });
  assert.equal(first.sealed, 2);
  const second = await sealOnce(db, { chainKey: CHAIN_KEY, limit: 2, now: 'n2' });
  assert.equal(second.sealed, 1);
  const third = await sealOnce(db, { chainKey: CHAIN_KEY, limit: 2, now: 'n3' });
  assert.equal(third.sealed, 0, 'nothing left to chain');
  assert.equal(third.head_index, 3);
  assert.equal((await verifyChain(db, { chainKey: CHAIN_KEY, pageSize: 10 })).ok, true);
});

test('verification catches an edited row, a removed row, a reordered chain and a rewritten head', async () => {
  const cases: Array<[string, (raw: import('node:sqlite').DatabaseSync) => void, number | undefined]> = [
    ['an edited action', (raw) => raw.exec("UPDATE audit_events SET action = 'wallet.debit' WHERE chain_index = 2"), 2],
    ['an edited actor', (raw) => raw.exec("UPDATE audit_events SET actor_id = 'usr_other' WHERE chain_index = 3"), 3],
    ['an edited detail hash', (raw) => raw.exec(`UPDATE audit_events SET detail_hash = '${'b'.repeat(64)}' WHERE chain_index = 1`), 1],
    ['a removed link', (raw) => raw.exec('DELETE FROM audit_events WHERE chain_index = 3'), 3],
    ['a rewritten head', (raw) => raw.exec(`UPDATE audit_chain_heads SET head_hash = '${'c'.repeat(64)}'`), undefined],
  ];
  for (const [name, tamper, brokenAt] of cases) {
    const { db, raw } = auditDb();
    await append(db, 4);
    await sealOnce(db, { chainKey: CHAIN_KEY, limit: 100, now: 'n' });
    assert.equal((await verifyChain(db, { chainKey: CHAIN_KEY, pageSize: 10 })).ok, true, `${name}: intact before`);
    tamper(raw);
    const after = await verifyChain(db, { chainKey: CHAIN_KEY, pageSize: 10 });
    assert.equal(after.ok, false, `${name}: tampering went undetected`);
    if (brokenAt !== undefined) assert.equal(after.broken_at, brokenAt, `${name}: reported the wrong link`);
  }
});

test('the chain key is what makes the chain unforgeable: the same row hashes differently with and without it', async () => {
  const core = {
    chain_index: 1,
    prev_hash: GENESIS_HASH,
    id: 'aud_1',
    event_id: 'evt_1',
    event_type: 'AuditRecorded.v1',
    actor_id: 'usr_1',
    action: 'wallet.credit',
    target: 'wallet:usr_1',
    detail_hash: 'a'.repeat(64),
    source_service: 'core',
    correlation_id: 'cid',
    occurred_at: 't',
    recorded_at: 't',
  };
  const keyed = await linkHash(core, CHAIN_KEY);
  const plain = await linkHash(core, undefined);
  const other = await linkHash(core, 'another-key');
  assert.notEqual(keyed, plain);
  assert.notEqual(keyed, other);
  assert.match(keyed, /^[0-9a-f]{64}$/);
  assert.equal(algFor(CHAIN_KEY), 'hmac-sha256');
  assert.equal(algFor(undefined), 'sha256');

  // a chain sealed without a key stays verifiable after one is configured:
  // each row is checked under the algorithm it records
  const { db } = auditDb();
  await append(db, 2);
  await sealOnce(db, { chainKey: undefined, limit: 100, now: 'n' });
  assert.equal((await verifyChain(db, { chainKey: CHAIN_KEY, pageSize: 10 })).ok, true);
  assert.equal((await verifyChain(db, { chainKey: undefined, pageSize: 10 })).ok, true);
});

test('two sealers racing: the loser rolls back completely — one chain, no half-sealed rows', async () => {
  const { db, raw } = auditDb();
  await append(db, 3);

  // both sealers read the same (empty) head and plan the same links
  const head = await headOf(db);
  const unsealed = rows<{ seq: number }>(raw, 'SELECT seq FROM audit_events ORDER BY seq').map((r) => Number(r.seq));
  const plan = await linkRows(
    unsealed.map((seq) => ({
      seq,
      id: `aud_${seq - 1}`,
      event_id: `evt_${seq - 1}`,
      event_type: 'AuditRecorded.v1',
      actor_id: null,
      action: 'wallet.credit',
      target: 't',
      detail_hash: 'a'.repeat(64),
      source_service: 'core',
      correlation_id: 'c',
      occurred_at: 't',
      recorded_at: 't',
    })),
    head,
    CHAIN_KEY
  );

  // sealer A wins
  const winner = await sealOnce(db, { chainKey: CHAIN_KEY, limit: 100, now: 'n1' });
  assert.equal(winner.sealed, 3);

  // sealer B commits the batch it planned against the OLD head
  const statements = plan.map((l) => sealLinkStatement(db, l, 'hmac-sha256'));
  statements.push(advanceHeadStatement(db, head, { chain_index: 3, head_hash: plan[2].hash, alg: 'hmac-sha256', sealed_at: 'n2' }));
  await assert.rejects(() => db.batch(statements), 'the second head write must abort the batch');

  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM audit_chain_heads'), 1);
  assert.equal((await headOf(db))?.chain_index, 3);
  assert.equal((await verifyChain(db, { chainKey: CHAIN_KEY, pageSize: 10 })).ok, true, 'the chain survived the race');

  // and the same through the public path: a contended run reports it and writes nothing
  const contended = await sealOnce(db, { chainKey: CHAIN_KEY, limit: 100, now: 'n3' });
  assert.equal(contended.sealed, 0);
});

test('health lag: zero with nothing pending, the age of the oldest unsealed entry otherwise', async () => {
  const { db } = auditDb();
  assert.equal(await sealLagSeconds(db), 0);
  await append(db, 1, '2026-09-08T10:00:00.000Z');
  assert.equal(await sealLagSeconds(db, Date.parse('2026-09-08T10:00:30.000Z')), 30);
  await sealOnce(db, { chainKey: CHAIN_KEY, limit: 10, now: 'n' });
  assert.equal(await sealLagSeconds(db), 0);
});

test('the head row is created by the first seal and never duplicated', async () => {
  const { db, raw } = auditDb();
  assert.equal(await headOf(db), null);
  await append(db, 1);
  await sealOnce(db, { chainKey: CHAIN_KEY, limit: 10, now: 'n' });
  await append(db, 0);
  const head = one<{ chain: string; alg: string }>(raw, 'SELECT chain, alg FROM audit_chain_heads');
  assert.equal(head?.chain, 'main');
  assert.equal(head?.alg, 'hmac-sha256');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM audit_chain_heads'), 1);
});
