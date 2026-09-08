/**
 * The service's own migration harness, and the property the slice turns on:
 * `notify_outbox` is the legacy `outbox` SHAPE, column for column, so the
 * monolith's rows can be copied in Phase 3 with an `INSERT SELECT` and no
 * transform.
 *
 * The comparison reads `migrations/0003_final_phase.sql` from the repository —
 * restating the legacy columns here would only prove the test agrees with
 * itself, and the day someone alters the core's table this test is what says so.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { idempotencySchemaSql, processedEventsSchemaSql } from '@levonis/platform-kit/idempotency';
import { NOTIFICATIONS_OWNS } from '../src/store';
import { migrationSql, REPO_ROOT } from './_harness';

interface Column {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

const columns = (db: DatabaseSync, table: string): Column[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Column[]).map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, pk: c.pk }));

const tablesIn = (db: DatabaseSync): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);

/** A throwaway database carrying only the legacy CREATE TABLE for `table`, taken from the root migration. */
function legacyTable(file: string, table: string): DatabaseSync {
  const sql = readFileSync(join(REPO_ROOT, 'migrations', file), 'utf8');
  const re = new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?${table} \\(([\\s\\S]*?)\\n\\);`);
  const m = re.exec(sql);
  assert.ok(m, `${file} no longer declares ${table}`);
  const db = new DatabaseSync(':memory:');
  // the legacy tables carry REFERENCES to tables that do not exist here; with
  // foreign keys OFF, SQLite records the declaration and asks no questions.
  db.exec(`CREATE TABLE ${table} (${m[1]}\n);`);
  return db;
}

test('the migration applies to a fresh database and creates exactly the owned tables plus the platform ones', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(migrationSql());
  assert.deepEqual(tablesIn(db), [...NOTIFICATIONS_OWNS, 'notifications_idempotency', 'notifications_processed_events'].sort());
});

test('applying it a second time is a no-op', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(migrationSql());
  db.exec(migrationSql());
  assert.equal(tablesIn(db).length, 6);
});

test('notify_outbox is the legacy `outbox` shape, column for column', () => {
  const mine = new DatabaseSync(':memory:');
  mine.exec(migrationSql());
  const legacy = legacyTable('0003_final_phase.sql', 'outbox');
  assert.deepEqual(columns(mine, 'notify_outbox'), columns(legacy, 'outbox'), 'a Phase 3 INSERT SELECT would no longer line up');
});

test('user_notifications is the legacy table minus the users(id) foreign key, which cannot exist in this database', () => {
  const mine = new DatabaseSync(':memory:');
  mine.exec(migrationSql());
  const legacy = legacyTable('0045_print_requests.sql', 'user_notifications');
  const mineCols = columns(mine, 'user_notifications');
  const legacyCols = columns(legacy, 'user_notifications');
  assert.deepEqual(mineCols.map((c) => c.name), legacyCols.map((c) => c.name));
  assert.deepEqual(mineCols, legacyCols, 'only the foreign key differs, and a foreign key is not a column');
  // and the difference that DOES exist is exactly the one claimed
  const legacySql = readFileSync(join(REPO_ROOT, 'migrations', '0045_print_requests.sql'), 'utf8');
  assert.ok(legacySql.includes('REFERENCES users(id)'), 'the core still has the foreign key this copy drops');
  const mineDdl = /CREATE TABLE IF NOT EXISTS user_notifications \(([\s\S]*?)\n\);/.exec(migrationSql());
  assert.ok(mineDdl, 'this migration still declares user_notifications');
  assert.ok(!/REFERENCES/.test(mineDdl[1]), 'the copy declares no foreign key at all');
});

test('the dedup indexes that make a duplicate message impossible are present', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(migrationSql());
  const indexes = (db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string; sql: string | null }>);
  const unique = indexes.filter((i) => (i.sql ?? '').includes('UNIQUE')).map((i) => i.name);
  assert.ok(unique.includes('idx_user_notifications_event'), 'UNIQUE (user_id, event_key)');
  // notify_outbox.event_key UNIQUE and notify_deliveries UNIQUE (event_key, channel) are
  // column constraints, so SQLite names them automatically: prove them by behaviour.
  db.prepare("INSERT INTO notify_outbox (id, kind, event_key, recipient, payload) VALUES ('a','email','k','x','{}')").run();
  assert.throws(() => db.prepare("INSERT INTO notify_outbox (id, kind, event_key, recipient, payload) VALUES ('b','email','k','x','{}')").run());
  db.prepare("INSERT INTO notify_deliveries (id, event_key, channel, status) VALUES ('a','k','email','sent')").run();
  assert.throws(() => db.prepare("INSERT INTO notify_deliveries (id, event_key, channel, status) VALUES ('b','k','email','sent')").run());
});

test('the platform tables match what the kit would create, column for column', () => {
  const mine = new DatabaseSync(':memory:');
  mine.exec(migrationSql());
  const kit = new DatabaseSync(':memory:');
  kit.exec(processedEventsSchemaSql('notifications'));
  kit.exec(idempotencySchemaSql('notifications'));
  for (const table of ['notifications_processed_events', 'notifications_idempotency']) {
    assert.deepEqual(columns(mine, table), columns(kit, table), `${table} drifted from the platform kit's shape`);
  }
});

test('the monolith keeps its own copies: nothing in this slice removes the core outbox or its transports', () => {
  for (const file of ['worker/lib/outbox.ts', 'worker/lib/telegram.ts', 'worker/lib/notifications.ts']) {
    const src = readFileSync(join(REPO_ROOT, file), 'utf8');
    assert.ok(src.length > 0, `${file} must still exist until Phase 3`);
  }
  const outbox = readFileSync(join(REPO_ROOT, 'worker', 'lib', 'outbox.ts'), 'utf8');
  assert.ok(/export async function processOutbox/.test(outbox), 'the core still owns its own pump');
  assert.ok(/export async function enqueue/.test(outbox), 'the core still owns its own enqueue');
});
