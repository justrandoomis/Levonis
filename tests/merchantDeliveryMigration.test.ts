/**
 * MIGRATION 0120 — the delivery profile backfill is exactly
 * `profileFromLegacySettings`, applied to live-shaped rows, safely:
 * a JSON that does not parse is empty, re-running changes nothing, and the
 * legacy column is left as it was (rollback reads it).
 *
 * Run: node --import tsx --test tests/merchantDeliveryMigration.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { all, dbThrough, freshDb, hasColumn } from './fixtures/app';
import { normalizeStoredProfile, profileFromLegacySettings } from '../packages/shipping/src/merchantDelivery';

const SQL = readFileSync(join(ROOT, 'migrations/0120_merchant_delivery.sql'), 'utf8');

const LEGACY: Array<[string, string]> = [
  ['s_fee', '{"fee_iqd":5000,"free_over_iqd":50000,"note":"التوصيل خلال ٢-٤ أيام"}'],
  ['s_empty', '{}'],
  ['s_zero', '{"fee_iqd":0,"note":"free"}'],
  ['s_float', '{"fee_iqd":700.9,"free_over_iqd":999.5}'],
  ['s_text', '{"fee_iqd":"3000","free_over_iqd":"20000"}'],
  ['s_huge', '{"fee_iqd":5000000,"free_over_iqd":9999999999}'],
  ['s_negative', '{"fee_iqd":-50,"free_over_iqd":-1}'],
  ['s_broken', 'not json at all'],
  ['s_note_only', '{"note":"  call first  "}'],
];

function seed(raw: ReturnType<typeof freshDb>) {
  raw.exec("INSERT INTO users (id,name,email,password_hash,role) VALUES ('u','U','u@x.co','h','merchant')");
  LEGACY.forEach(([id, json], i) => {
    raw.exec(`INSERT INTO users (id,name,email,password_hash,role) VALUES ('u${i}','U','u${i}@x.co','h','merchant')`);
    raw.exec(`INSERT INTO community_merchants (id,user_id,name,status) VALUES ('m${i}','u${i}','M','active')`);
    raw.prepare(`INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,delivery_settings) VALUES (?,?,?,?,?,?)`)
      .run(id, `m${i}`, `u${i}`, `slug${i}`, 'S', json);
  });
}

test('every existing store gets the profile its legacy JSON describes — the same answer as the TypeScript mapping', () => {
  const raw = dbThrough('0119');
  seed(raw);
  raw.exec(SQL);
  const rows = all(raw, 'SELECT * FROM merchant_delivery_profiles ORDER BY store_id');
  assert.equal(rows.length, LEGACY.length, 'one profile per store');
  for (const [id, json] of LEGACY) {
    const row = rows.find((r) => r.store_id === id)!;
    const fromSql = normalizeStoredProfile(row);
    const fromTs = profileFromLegacySettings(json);
    assert.deepEqual(
      { ...fromSql, version: 0 },
      { ...fromTs, version: 0 },
      `${id}: ${json}`
    );
    assert.equal(row.version, 1);
    assert.equal(row.updated_by, 'migration:0120');
  }
  // The legacy column is untouched — a rollback of the code still reads it.
  assert.equal(all(raw, "SELECT delivery_settings FROM merchant_stores WHERE id = 's_fee'")[0].delivery_settings, LEGACY[0][1]);
});

test('re-running the backfill changes nothing, and a new database has the tables and the order columns', () => {
  const raw = dbThrough('0119');
  seed(raw);
  raw.exec(SQL.split('ALTER TABLE orders')[0]);
  raw.exec("UPDATE merchant_delivery_profiles SET default_fee_iqd = 1234, version = 5 WHERE store_id = 's_fee'");
  raw.exec(SQL.split('ALTER TABLE orders')[0]);
  const row = all(raw, "SELECT default_fee_iqd, version FROM merchant_delivery_profiles WHERE store_id = 's_fee'")[0];
  assert.deepEqual({ ...row }, { default_fee_iqd: 1234, version: 5 }, 'INSERT OR IGNORE: a merchant edit is never overwritten');

  const fresh = freshDb();
  for (const col of ['delivery_governorate', 'delivery_rule', 'delivery_prep_days', 'quote_fingerprint']) {
    assert.ok(hasColumn(fresh, 'orders', col), col);
  }
});

test('the database refuses what the API refuses: unknown governorates, a fee rule without a fee, pickup without a place', () => {
  const raw = freshDb();
  seed(raw);
  const bad = [
    "INSERT INTO merchant_delivery_rules (store_id, governorate_id, mode, fee_iqd) VALUES ('s_fee','Baghdad','fee',1)",
    "INSERT INTO merchant_delivery_rules (store_id, governorate_id, mode, fee_iqd) VALUES ('s_fee','basra','fee',NULL)",
    "INSERT INTO merchant_delivery_rules (store_id, governorate_id, mode, fee_iqd) VALUES ('s_fee','basra','fee',1000001)",
    "INSERT INTO merchant_delivery_rules (store_id, governorate_id, mode) VALUES ('s_fee','basra','sometimes')",
    "INSERT INTO merchant_delivery_profiles (store_id, pickup_enabled) VALUES ('s_empty', 1)",
    "INSERT INTO merchant_delivery_profiles (store_id, default_fee_iqd) VALUES ('s_empty', -1)",
    "INSERT INTO merchant_delivery_profiles (store_id, free_over_basis) VALUES ('s_empty', 'before_discount')",
    "UPDATE orders SET delivery_rule = 'guess'",
  ];
  raw.exec("DELETE FROM merchant_delivery_profiles WHERE store_id = 's_empty'");
  raw.exec(`INSERT INTO orders (id,user_id,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd)
            VALUES ('o1','u','{}','merchant','{}','wallet',0,1400,0,0)`);
  for (const sql of bad) assert.throws(() => raw.exec(sql), /CHECK constraint failed|NOT NULL/, sql);
  raw.exec("INSERT INTO merchant_delivery_rules (store_id, governorate_id, mode, fee_iqd) VALUES ('s_fee','basra','fee',9000)");
  raw.exec("DELETE FROM merchant_stores WHERE id = 's_fee'");
  assert.equal(all(raw, "SELECT * FROM merchant_delivery_rules WHERE store_id = 's_fee'").length, 0, 'cascade with the store');
});
