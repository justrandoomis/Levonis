/**
 * THE CONSTANT THAT NOTICES A DEPLOY LANDING AHEAD OF ITS DATABASE.
 *
 * `EXPECTED_MIGRATION` exists so a running Worker can say whether the database
 * under it has had the migration its own code needs. A Worker has no
 * filesystem, so the value cannot be counted at runtime — which means the only
 * thing keeping it true is this file. A stale constant notices nothing, and a
 * check that notices nothing is worse than no check, because it reports
 * success.
 *
 * The same registry-plus-parity-test shape this codebase already uses for
 * table ownership and the template families.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asD1, dbThrough, freshDb } from './fixtures/app';
import {
  EXPECTED_MIGRATION,
  EXPECTED_MIGRATION_COUNT,
  migrationNumber,
  readSchemaStatus,
} from '../worker/lib/schemaVersion';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migrations = () => readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')).sort();

test('EXPECTED_MIGRATION is the newest file in migrations/ — add one, update it here', () => {
  const newest = migrations().at(-1);
  assert.equal(
    EXPECTED_MIGRATION,
    newest,
    `worker/lib/schemaVersion.ts must name the newest migration. ` +
      `It says ${EXPECTED_MIGRATION}; the newest file is ${newest}.`
  );
});

test('EXPECTED_MIGRATION_COUNT is how many migration files there are', () => {
  assert.equal(
    EXPECTED_MIGRATION_COUNT,
    migrations().length,
    'the count is what catches a HOLE in the applied set, which the newest name cannot see'
  );
});

test('migrationNumber reads the leading number and survives a rename around it', () => {
  assert.equal(migrationNumber('0087_auth_otp.sql'), 87);
  assert.equal(migrationNumber('0085_product_condition.sql'), 85);
  // A file renamed around its number is the SAME migration to a deploy.
  assert.equal(migrationNumber('0085_product_condition_v2.sql'), 85);
  assert.equal(migrationNumber('0001_init.sql'), 1);
  assert.equal(migrationNumber('not-a-migration.sql'), null);
  assert.equal(migrationNumber(''), null);
});

test('every migration filename starts with the four digits this check reads', () => {
  for (const f of migrations()) {
    assert.notEqual(migrationNumber(f), null, `${f} has no leading number, so drift cannot be measured against it`);
  }
});

// =========================================================================
// THE ANSWER, AGAINST REAL DATABASES
// =========================================================================

/** What `wrangler d1 migrations apply` leaves behind. The unit harness applies
 *  the .sql files directly and never creates this, which is itself a case. */
function recordApplied(raw: ReturnType<typeof freshDb>, names: string[]) {
  raw.exec(
    'CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT)'
  );
  for (const n of names) raw.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(n);
}

test('a database with every migration applied reads CURRENT', async () => {
  const raw = freshDb();
  recordApplied(raw, migrations());
  const s = await readSchemaStatus(asD1(raw));
  assert.equal(s.state, 'current');
  assert.equal(s.behind, 0);
  assert.equal(s.applied, EXPECTED_MIGRATION);
});

test('THE OUTAGE: a database at 0083 under code that expects 0087 reads BEHIND, by four', async () => {
  const raw = dbThrough('0083');
  recordApplied(raw, migrations().filter((f) => f.slice(0, 4) <= '0083'));
  const s = await readSchemaStatus(asD1(raw));
  assert.equal(s.state, 'behind', 'this is the state that answered {"status":"ok"} for hours');
  assert.equal(s.behind, 4, '0084, 0085, 0086, 0087');
  assert.equal(s.expected, EXPECTED_MIGRATION);
  assert.equal(s.applied, '0083_cart_multi_option_identity_contract.sql');
});

test('a database with NO d1_migrations table is UNKNOWN, not behind', async () => {
  // The unit harness, and any database not built by wrangler. Reporting drift
  // here would cry wolf on every test run and on every locally seeded database.
  const raw = freshDb();
  const s = await readSchemaStatus(asD1(raw));
  assert.equal(s.state, 'unknown');
  assert.equal(s.behind, 0);
  assert.equal(s.applied, null);
});

test('a database AHEAD of the code is reported, not treated as an error', async () => {
  // The ordinary state during a rollback: the database has run something this
  // Worker has never heard of. The reader wants to know; it is not a fault.
  const raw = freshDb();
  recordApplied(raw, [...migrations(), '0099_from_the_future.sql']);
  const s = await readSchemaStatus(asD1(raw));
  assert.equal(s.state, 'ahead');
  assert.equal(s.behind, 0);
});

test('readSchemaStatus never throws — a broken probe must still answer', async () => {
  const exploding = {
    prepare() {
      throw new Error('D1_ERROR: connection lost');
    },
  } as unknown as D1Database;
  const s = await readSchemaStatus(exploding);
  assert.equal(s.state, 'unknown');
  assert.equal(s.expected, EXPECTED_MIGRATION);
});

test('A HOLE IN THE MIDDLE reads as BEHIND, not as healthy', () => {
  // `repair-staging-db.yml` exists because this database once had tables from
  // 0018 while d1_migrations recorded 0012. A check that reads only the newest
  // name would call "0087 applied, 0086 skipped" current — the right maximum
  // and a missing migration.
  const raw = freshDb();
  recordApplied(raw, migrations().filter((f) => f.slice(0, 4) !== '0086'));
  return readSchemaStatus(asD1(raw)).then((s) => {
    assert.equal(s.applied, EXPECTED_MIGRATION, 'the newest name is exactly right, which is the trap');
    assert.equal(s.state, 'behind', 'and the count is what catches it');
    assert.equal(s.behind, 1);
    assert.equal(s.applied_count, EXPECTED_MIGRATION_COUNT - 1);
  });
});

test('the counts are reported, so a reader can see WHAT is short as well as that something is', async () => {
  const raw = dbThrough('0083');
  recordApplied(raw, migrations().filter((f) => f.slice(0, 4) <= '0083'));
  const s = await readSchemaStatus(asD1(raw));
  assert.equal(s.expected_count, EXPECTED_MIGRATION_COUNT);
  assert.equal(s.applied_count, EXPECTED_MIGRATION_COUNT - 4);
});

// =========================================================================
// THE SWEEPER MIGRATION 0087 PROMISED
// =========================================================================

test('expired sign-in codes are actually pruned — 0087 named a sweeper that did not exist', async () => {
  // The index comment said "the sweeper's index (jobs.ts prunes expired rows)"
  // while jobs.ts pruned otp_challenges only. Every expired challenge stayed,
  // and so did every DECOY row the anti-enumeration path writes for an address
  // with no account — one per probe. A security table that only grows is a
  // slow leak of exactly the addresses somebody went looking for.
  const { runDurableJobs } = await import('../worker/lib/jobs');
  const raw = freshDb();
  const old = new Date(Date.now() - 40 * 24 * 3600_000).toISOString();
  const fresh = new Date(Date.now() + 600_000).toISOString();
  raw.prepare(
    `INSERT INTO auth_otp (id, channel, destination, purpose, verifier, expires_at)
     VALUES ('a_old','email','probe@example.com','signin','x', ?)`
  ).run(old);
  raw.prepare(
    `INSERT INTO auth_otp (id, channel, destination, purpose, verifier, expires_at)
     VALUES ('a_live','email','real@example.com','signin','y', ?)`
  ).run(fresh);

  const report = await runDurableJobs({ DB: asD1(raw) } as never);
  assert.equal(report.pruned_auth_otp, 1, 'the long-expired challenge is gone');
  const left = raw.prepare('SELECT id FROM auth_otp').all() as { id: string }[];
  assert.deepEqual(left.map((r) => r.id), ['a_live'], 'and the live one is untouched');
});
