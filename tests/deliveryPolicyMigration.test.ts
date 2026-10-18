/**
 * MIGRATION 0201 — «إدارة التوصيل»: the owner's starting rules are seeded from
 * the live catalogue facts, the retired per-product stop moves into
 * «لا يُوصَّل», the old field is cleared, and a second run changes nothing.
 *
 * Run: node --import tsx --test tests/deliveryPolicyMigration.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { dbThrough } from './fixtures/app';
import { normalizeDeliveryPolicy, type DeliveryRuleGroup } from '../worker/lib/storeDelivery';

const SQL = readFileSync(join(ROOT, 'migrations/0201_delivery_policy.sql'), 'utf8');
const H2S = 'prd_65182590e9284a97a3e2';
const H2D = 'prd_7387063972434aab9f92';

function seed(withH2S = true) {
  const raw = dbThrough('0200');
  const insert = raw.prepare(
    `INSERT INTO products(id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,images,ops_policy)
     VALUES(?,?,?,?,1000,'active',1,'[]','[]','direct_sale','["direct_sale"]','[]',?)`
  );
  if (withH2S) insert.run(H2S, 'h2s', 'H2S', 'H2S', '{}');
  insert.run(H2D, 'h2d', 'H2D', 'H2D', '{"size_class":"printer_large"}');
  insert.run('stopped', 'stopped', 'Big', 'كبير', JSON.stringify({ delivery_options: { standard: { enabled: false, quantity_step: 1, fee_iqd: 0 }, personal: { enabled: true, quantity_step: 1, fee_iqd: 9 } } }));
  insert.run('open', 'open', 'Open', 'مفتوح', JSON.stringify({ delivery_options: { standard: { enabled: true, quantity_step: 1, fee_iqd: 0 }, personal: { enabled: true, quantity_step: 1, fee_iqd: 9 } }, is_spool: true }));
  insert.run('broken', 'broken', 'Broken', 'تالف', 'not json');
  return raw;
}

const stored = (raw: ReturnType<typeof dbThrough>) =>
  JSON.parse((raw.prepare("SELECT value FROM admin_settings WHERE key='deliveryPolicy'").get() as { value: string }).value);

test('0201 seeds the exact starting rules and clears delivery_options', () => {
  const raw = seed();
  raw.exec(SQL);
  const v = stored(raw);
  assert.equal(v.version, 1);
  assert.equal(v.default_fee_iqd, 5000);
  assert.deepEqual(v.governorates, {});
  assert.equal(v.updated_by, 'migration:0201');
  const byId = Object.fromEntries((v.groups as DeliveryRuleGroup[]).map((g) => [g.id, g]));
  assert.deepEqual(byId.g_printers, {
    id: 'g_printers', name: { ar: 'الطابعات', en: 'Printers', ckb: 'پرینتەرەکان' },
    enabled: true, mode: 'per_piece', fee_iqd: 10000, block_size: 1, product_ids: [],
    catalog_ids: ['cat_printers', 'cat_laser_machines', 'cat_used_printers'],
  });
  assert.deepEqual(byId.g_printers_large.product_ids, [H2S, H2D]);
  assert.equal(byId.g_printers_large.fee_iqd, 25000);
  assert.deepEqual(byId.g_filament.catalog_ids, ['cat_materials_fdm']);
  assert.equal(byId.g_filament.mode, 'per_block');
  assert.equal(byId.g_filament.block_size, 10);
  assert.deepEqual(byId.g_stopped.product_ids, ['stopped']);
  assert.equal(byId.g_stopped.mode, 'stopped');
  // Arrays are JSON, not strings (the json() wrapper around each subquery).
  assert.ok(Array.isArray(byId.g_printers.catalog_ids));

  const ops = (id: string) => (raw.prepare('SELECT ops_policy FROM products WHERE id=?').get(id) as { ops_policy: string }).ops_policy;
  assert.equal(JSON.parse(ops('stopped')).delivery_options, undefined);
  assert.deepEqual(JSON.parse(ops('open')), { is_spool: true }, 'the other ops facts stay');
  assert.equal(ops('broken'), 'not json', 'an unreadable row is left alone, never a failed migration');

  // The reader keeps every seeded group: none is malformed.
  assert.deepEqual(normalizeDeliveryPolicy(v).groups.map((g) => g.id), ['g_printers', 'g_printers_large', 'g_filament', 'g_stopped']);
  raw.close();
});

test('a missing H2S is simply not listed', () => {
  const raw = seed(false);
  raw.exec(SQL);
  const large = (stored(raw).groups as Array<{ id: string; product_ids: string[] }>).find((g) => g.id === 'g_printers_large')!;
  assert.deepEqual(large.product_ids, [H2D]);
  raw.close();
});

test('applying twice changes nothing; an owner-edited document is never overwritten', () => {
  const raw = seed();
  raw.exec(SQL);
  const first = (raw.prepare("SELECT value FROM admin_settings WHERE key='deliveryPolicy'").get() as { value: string }).value;
  raw.exec(SQL);
  assert.equal((raw.prepare("SELECT value FROM admin_settings WHERE key='deliveryPolicy'").get() as { value: string }).value, first);
  raw.prepare("UPDATE admin_settings SET value=? WHERE key='deliveryPolicy'").run('{"version":1,"default_fee_iqd":4000,"groups":[]}');
  raw.exec(SQL);
  assert.equal(stored(raw).default_fee_iqd, 4000);
  raw.close();
});
