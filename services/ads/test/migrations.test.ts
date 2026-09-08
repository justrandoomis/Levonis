/**
 * The service's own migration harness, giving `services/ads/migrations/` the
 * same guarantee `node scripts/migrate-check.mjs --twice` gives the root
 * stream: it applies to a fresh database, it applies a second time without
 * duplicating a row or failing, and the platform tables it declares are the
 * ones the platform kit would have created.
 *
 * The root harness cannot do this — it reads `migrations/` only, and this
 * service's database is a different D1 — so the guarantee has to live here, in
 * a test the root `npm run test:unit` runs through `test-workspaces.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { idempotencySchemaSql, processedEventsSchemaSql } from '@levonis/platform-kit/idempotency';
import { ADS_OWNS } from '../src/store';
import { migrationSql } from './_harness';

const tablesIn = (db: DatabaseSync): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);

const rows = (db: DatabaseSync, table: string): number => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);

test('the migration applies to a fresh database and creates exactly the owned tables plus the platform ones', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(migrationSql());
  assert.deepEqual(tablesIn(db), [...ADS_OWNS, 'ads_idempotency', 'ads_processed_events'].sort());
});

test('applying it a second time is a no-op: no error, no duplicated seed row', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(migrationSql());
  const before = { providers: rows(db, 'ads_providers'), map: rows(db, 'ads_event_map') };
  db.exec(migrationSql());
  assert.deepEqual({ providers: rows(db, 'ads_providers'), map: rows(db, 'ads_event_map') }, before);
});

test('the seed covers every event Ads subscribes to, for every delivering provider', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(migrationSql());
  const seeded = (db.prepare('SELECT event_type, provider FROM ads_event_map').all() as Array<{ event_type: string; provider: string }>);
  const types = [...new Set(seeded.map((r) => r.event_type))].sort();
  assert.deepEqual(types, ['AddToCart', 'CheckoutStarted', 'ProductViewed', 'PurchaseCompleted', 'SubscriptionChanged', 'UserUpdated']);
  for (const t of types) {
    const providers = seeded.filter((r) => r.event_type === t).map((r) => r.provider).sort();
    assert.deepEqual(providers, ['google_ads', 'meta_capi', 'snapchat', 'tiktok'], `${t} is mapped for every delivering provider`);
  }
  // `noop` is in the registry but is never a mapping target: it exists to be the default, not to be used.
  assert.equal(seeded.filter((r) => r.provider === 'noop').length, 0);
});

test('the platform tables match what the kit would create, column for column', () => {
  const mine = new DatabaseSync(':memory:');
  mine.exec(migrationSql());
  const kit = new DatabaseSync(':memory:');
  kit.exec(processedEventsSchemaSql('ads'));
  kit.exec(idempotencySchemaSql('ads'));
  const columns = (db: DatabaseSync, table: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string; notnull: number; pk: number }>).map(
      (c) => `${c.name}:${c.type}:${c.notnull}:${c.pk}`
    );
  for (const table of ['ads_processed_events', 'ads_idempotency']) {
    assert.deepEqual(columns(mine, table), columns(kit, table), `${table} drifted from the platform kit's shape`);
  }
});

test('a foreign key stops a delivery row naming a provider that is not in the registry table', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(migrationSql());
  assert.throws(() =>
    db
      .prepare("INSERT INTO ads_deliveries (id, event_id, event_type, provider, status, created_at) VALUES ('a','e','T','not_a_provider','sandbox','now')")
      .run()
  );
});
