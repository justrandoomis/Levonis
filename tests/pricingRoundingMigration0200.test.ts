/**
 * MIGRATION 0200 — THE TWO PRICE CHECKS FOLLOW THE ROUNDING RULE (DECISIONS row 245).
 *
 * `product_sku_prices.regular_price_iqd` (0183) and `pricing_v2_sku_results.final_price_iqd` /
 * `direct_price_iqd` (0189) were CHECKed to a positive multiple of 1,000, so a 13,250 price could
 * not be stored. 0200 rebuilds both tables with the rule's CHECK — above 1,000 a multiple of 250,
 * at or below 1,000 any whole dinar ≥ 1 — and changes nothing else:
 *
 *   - every existing row is copied byte for byte (no price moves);
 *   - the twelve guards and the index are back, identical (an engine write still needs its guard,
 *     an import batch still cannot write a price);
 *   - before 0200 a 13,250 price is refused (a newer Worker on an older database fails closed).
 *
 * Run: node --import tsx --test tests/pricingRoundingMigration0200.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ROOT } from './fixtures/d1';
import { all, dbThrough, withoutTriggers } from './fixtures/app';

const SQL = readFileSync(join(ROOT, 'migrations/0200_price_rounding_250.sql'), 'utf8');
const TABLES = "('product_sku_prices', 'pricing_v2_sku_results')";

const guardsOf = (raw: DatabaseSync) =>
  (raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN ${TABLES} ORDER BY name`).all() as Array<{ name: string }>).map((t) => t.name);
const schemaOf = (raw: DatabaseSync) =>
  all<{ type: string; name: string; sql: string | null }>(raw, `SELECT type, name, sql FROM sqlite_master WHERE tbl_name IN ${TABLES} AND type IN ('trigger', 'index') ORDER BY type, name`);

function v2Row(price: number, combo = '', channel = 'direct_sale'): string {
  return `INSERT INTO pricing_v2_sku_results (product_id, combo_key, channel, method, anchor, final_price_iqd, exact_iqd, direct_price_iqd,
            direct_exact_iqd, usd_ceil6, deltas_usd, discount_usd, floor, usd_iqd_rate, usd_fx_version, inputs_seq, config_version, write_seq, computed_at)
          VALUES ('p1', '${combo}', '${channel}', 'usd', 'product_fixed', ${price}, '${price}', ${price}, '${price}', '8.75', '0', NULL, 'none', '1500', 1, 1, 1, 1, '2026-10-17T00:00:00Z');`;
}
const skuRow = (price: number, combo = 'o:m1') =>
  `INSERT INTO product_sku_prices (product_id, combo_key, channel, regular_price_iqd, write_seq, updated_at) VALUES ('p1', '${combo}', 'direct_sale', ${price}, 1, '2026-10-17T00:00:00Z');`;

function seeded(): DatabaseSync {
  const raw = dbThrough('0197');
  raw.exec(`INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images)
            VALUES ('p1','p1','P','P',24000,'active',1,'[]','[]','direct_sale','["direct_sale"]','[]','[]');`);
  withoutTriggers(raw, guardsOf(raw), `${skuRow(24_000)} ${skuRow(1_000, 'o:m2')} ${v2Row(24_000)}`);
  return raw;
}

test('before 0200: a 13,250 price is refused by the old CHECK (a newer Worker on an older database fails closed)', () => {
  const raw = seeded();
  assert.throws(() => withoutTriggers(raw, guardsOf(raw), skuRow(13_250, 'o:m3')), /CHECK constraint failed/);
  assert.throws(() => withoutTriggers(raw, guardsOf(raw), v2Row(13_250, 'o:m3')), /CHECK constraint failed/);
});

test('0200 keeps every row, every guard and the index, and moves no price', () => {
  const raw = seeded();
  const beforeRows = [all(raw, 'SELECT * FROM product_sku_prices ORDER BY combo_key'), all(raw, 'SELECT * FROM pricing_v2_sku_results ORDER BY combo_key')];
  const beforeSchema = schemaOf(raw);
  assert.equal(beforeSchema.filter((s) => s.type === 'trigger').length, 12);
  raw.exec(SQL);
  assert.deepEqual([all(raw, 'SELECT * FROM product_sku_prices ORDER BY combo_key'), all(raw, 'SELECT * FROM pricing_v2_sku_results ORDER BY combo_key')], beforeRows);
  assert.deepEqual(schemaOf(raw), beforeSchema, 'the same twelve guards and the same index, word for word');
  // The guards still guard: no engine batch, no write.
  assert.throws(() => raw.exec(skuRow(13_250, 'o:m3')), /ENGINE_MANAGED/);
  assert.deepEqual(all(raw, 'PRAGMA foreign_key_check'), []);
});

test('after 0200 the CHECK is the rule: above 1,000 a multiple of 250, at or below 1,000 any whole dinar ≥ 1', () => {
  const raw = seeded();
  raw.exec(SQL);
  const write = (sql: string) => withoutTriggers(raw, guardsOf(raw), sql);
  let n = 0;
  for (const ok of [13_250, 1_250, 999, 1_000, 1]) {
    n += 1;
    write(skuRow(ok, `o:ok${n}`));
    write(v2Row(ok, `o:ok${n}`));
  }
  for (const bad of [13_120, 1_001, 1_120, 0, -250]) {
    n += 1;
    assert.throws(() => write(skuRow(bad, `o:bad${n}`)), /CHECK constraint failed/, `product_sku_prices ${bad}`);
    assert.throws(() => write(v2Row(bad, `o:bad${n}`)), /CHECK constraint failed/, `pricing_v2_sku_results ${bad}`);
  }
});
