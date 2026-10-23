import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dbThrough, freshDb } from './fixtures/app';
import { wavesD1 } from './fixtures/wavesD1';
import { getTierStatus } from '../worker/lib/entitlements';

test('unchanged free and paid accounts use one read wave and no writes; revocation stays immediate', async () => {
  const raw = freshDb();
  const { db, waves } = wavesD1(raw);
  raw.exec(`
    INSERT INTO users (id,email,password_hash) VALUES ('free','free@x.co','h'), ('paid','paid@x.co','h');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at)
      VALUES ('m','paid','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z');
  `);
  // First read repairs the derived fields; later reads still consult authority.
  await getTierStatus(db, 'paid');
  for (const [id, tier] of [['free', 'free'], ['paid', 'plus']]) {
    waves.reset();
    assert.equal((await getTierStatus(db, id)).tier, tier);
    assert.equal(waves.counts.waves, 1, waves.counts.sqls.join('\n'));
    assert.equal(waves.counts.executions, 3);
    assert.ok(waves.counts.sqls.every((sql) => sql.startsWith('SELECT ')), 'ordinary browsing must not issue writes');
  }
  raw.exec("UPDATE memberships SET state = 'cancelled' WHERE id = 'm'");
  assert.equal((await getTierStatus(db, 'paid')).tier, 'free');
  assert.equal(raw.prepare("SELECT membership_tier FROM users WHERE id = 'paid'").get()!.membership_tier, 'free');
  raw.close();
});

test('expiry and a later renewal stay immediate, including before pause columns exist', async () => {
  for (const legacy of [false, true]) {
    const raw = legacy ? dbThrough('0144') : freshDb();
    const { db, waves } = wavesD1(raw);
    raw.exec(`
      INSERT INTO users (id,email,password_hash,membership_tier) VALUES ('u','u@x.co','h','pro');
      INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at) VALUES
        ('old','u','pro_12mo','pro','active',12,'2019-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z');
    `);
    assert.equal((await getTierStatus(db, 'u')).tier, 'free');
    assert.equal(raw.prepare("SELECT state FROM memberships WHERE id = 'old'").get()!.state, 'expired');
    raw.exec(`INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at)
      VALUES ('current','u','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z')`);
    assert.equal((await getTierStatus(db, 'u')).tier, 'plus');
    waves.reset();
    assert.equal((await getTierStatus(db, 'u')).tier, 'plus');
    assert.equal(waves.counts.waves, 1);
    assert.ok(waves.counts.sqls.every((sql) => sql.startsWith('SELECT ')));
    raw.close();
  }
});
