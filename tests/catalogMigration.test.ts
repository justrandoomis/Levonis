/**
 * MIGRATIONS 0126 + 0127 AND THE LEGACY CONVERTER (merchant platform W2-F):
 * existing products move onto the new model and nothing a customer sees
 * changes; the pre-0126 options/colours JSON becomes variants only where
 * nothing has to be invented, and every other product keeps selling as before.
 *
 * Run: node --import tsx --test tests/catalogMigration.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dbThrough, asD1, all, row, count } from './fixtures/app';
import { ROOT } from './fixtures/d1';
import { convertLegacyProducts } from '../worker/lib/catalog/legacy';
import type { Env } from '../worker/lib/types';

const file = (n: string) => readdirSync(join(ROOT, 'migrations')).find((f) => f.startsWith(n))!;
const sql = (n: string) => readFileSync(join(ROOT, 'migrations', file(n)), 'utf8');

function legacyWorld() {
  const raw = dbThrough('0125');
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash) VALUES ('u1','A','a@x.co','h'), ('buyer','B','b@x.co','h');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('m1','u1','Ali');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name) VALUES ('s1','m1','u1','ali3d','Ali');
    INSERT INTO merchant_store_sections (id,store_id,name) VALUES ('sec1','s1','Figures');
    INSERT INTO community_products (id,merchant_id,store_id,slug,name,status,lifecycle,price_iqd,stock,track_stock,images,section_id,options,colors,created_at) VALUES
      ('live','m1','s1','a','Live','active','active',100,5,1,'["/files/merchants/u1/public/aaaa1111.webp","https://tracker.example/p.gif","/files/merchants/u1/public/bbbb2222.webp"]','sec1','[]','[]','2026-01-01T00:00:00.000Z'),
      ('draft','m1','s1','b','Draft','hidden','draft',100,5,1,'[]','sec1','[]','[]','2026-01-02T00:00:00.000Z'),
      ('soldout','m1','s1','c','Sold out','hidden','sold_out',100,0,1,'[]',NULL,'[]','[]','2026-01-03T00:00:00.000Z'),
      ('odd','m1','s1','d','Odd','hidden','active',100,5,1,'[]',NULL,'[]','[]','2026-01-04T00:00:00.000Z'),
      ('arch','m1','s1','e','Archived','hidden','archived',100,5,1,'not json',NULL,'[]','[]','2026-01-05T00:00:00.000Z'),
      ('opts','m1','s1','f','Untracked options','active','active',100,0,0,'[]',NULL,'["S",{"id":"m_id","name":"M"}]','["أحمر"]','2026-01-06T00:00:00.000Z'),
      ('one','m1','s1','g','One choice, tracked','active','active',100,7,1,'[]',NULL,'["Only"]','[]','2026-01-07T00:00:00.000Z'),
      ('shared','m1','s1','h','Shared stock','active','active',100,7,1,'[]',NULL,'["S","M"]','[]','2026-01-08T00:00:00.000Z'),
      ('broken','m1','s1','i','Broken','active','active',100,7,0,'[]',NULL,'[{"name":"no id"}]','[]','2026-01-09T00:00:00.000Z'),
      ('nullopts','m1','s1','j','Null options','active','active',100,7,0,'[]',NULL,'null','[]','2026-01-10T00:00:00.000Z');
    UPDATE community_products SET admin_hidden_at = '2026-05-01T00:00:00.000Z', status = 'hidden' WHERE id = 'odd';
    INSERT INTO cart_items (id,user_id,seller_type,merchant_id,store_id,community_product_id,option_id,color_id,qty) VALUES
      ('ci1','buyer','merchant','m1','s1','opts','m_id','أحمر',1),
      ('ci2','buyer','merchant','m1','s1','one','','',1);
  `);
  // 'odd' was hidden BY LEVONIS while its merchant had it live: it stays hidden.
  raw.exec(sql('0126'));
  raw.exec(sql('0127'));
  return raw;
}

test('0127: each product keeps exactly its storefront visibility, and gets the state that says so', () => {
  const raw = legacyWorld();
  const rows = Object.fromEntries(
    all<{ id: string; publish_state: string; lifecycle: string; status: string }>(raw, 'SELECT id, publish_state, lifecycle, status FROM community_products')
      .map((r) => [r.id, `${r.publish_state}/${r.lifecycle}/${r.status}`])
  );
  assert.equal(rows.live, 'published/active/active');
  assert.equal(rows.draft, 'draft/draft/hidden');
  assert.equal(rows.soldout, 'hidden/hidden/hidden', 'the old manual «sold out» took it off the storefront — it stays off');
  assert.equal(rows.odd, 'published/active/hidden', "Levonis's hide is still its own, and still wins");
  assert.equal(rows.arch, 'archived/archived/hidden');
});

test('0127: the gallery becomes ordered media rows (ours only); a section’s products become its members, newest first', () => {
  const raw = legacyWorld();
  assert.deepEqual(
    all<{ media_key: string; position: number }>(raw, "SELECT media_key, position FROM community_product_media WHERE product_id = 'live' ORDER BY position"),
    [{ media_key: 'merchants/u1/public/aaaa1111.webp', position: 0 }, { media_key: 'merchants/u1/public/bbbb2222.webp', position: 2 }]
  );
  assert.deepEqual(
    all<{ product_id: string }>(raw, "SELECT product_id FROM merchant_collection_products WHERE collection_id = 'sec1' ORDER BY position").map((r) => r.product_id),
    ['draft', 'live'],
    'the order the storefront showed: newest first'
  );
});

test('0127: a product whose options/colours JSON offered a choice is marked legacy; "null" and "[]" are simple', () => {
  const raw = legacyWorld();
  const modes = Object.fromEntries(all<{ id: string; variant_mode: string }>(raw, 'SELECT id, variant_mode FROM community_products').map((r) => [r.id, r.variant_mode]));
  assert.deepEqual([modes.opts, modes.one, modes.shared, modes.broken, modes.nullopts, modes.live], ['legacy', 'legacy', 'legacy', 'legacy', 'simple', 'simple']);
});

test('0127 is idempotent: a second run changes nothing', () => {
  const raw = legacyWorld();
  const snap = () => JSON.stringify([
    all(raw, 'SELECT id, publish_state, lifecycle, status, variant_mode FROM community_products ORDER BY id'),
    count(raw, 'SELECT COUNT(*) n FROM community_product_media'),
    count(raw, 'SELECT COUNT(*) n FROM merchant_collection_products'),
  ]);
  const before = snap();
  raw.exec(sql('0127'));
  assert.equal(snap(), before);
});

test('the converter: variants when nothing is invented, a note when something would be — and cart lines follow', async () => {
  const raw = legacyWorld();
  const env = { DB: asD1(raw) } as unknown as Env;
  const report = await convertLegacyProducts(env);
  assert.deepEqual(report, { converted: 2, kept_legacy: 2, errors: 0 });
  const p = (id: string) => row<{ variant_mode: string; legacy_variant_note: string | null; stock: number }>(raw, 'SELECT variant_mode, legacy_variant_note, stock FROM community_products WHERE id = ?', id)!;
  assert.equal(p('opts').variant_mode, 'variants');
  assert.equal(count(raw, "SELECT COUNT(*) n FROM community_product_variants WHERE product_id = 'opts'"), 2);
  assert.equal(p('one').variant_mode, 'variants');
  assert.equal(p('one').stock, 7, 'one combination takes the whole stock');
  assert.deepEqual([p('shared').variant_mode, p('shared').legacy_variant_note], ['legacy', 'shared_stock']);
  assert.deepEqual([p('broken').variant_mode, p('broken').legacy_variant_note], ['legacy', 'options_entry_without_id']);
  // The cart line that named (m_id, أحمر) now names the variant built from them.
  const ci1 = row<{ variant_id: string; option_id: string; color_id: string }>(raw, "SELECT variant_id, option_id, color_id FROM cart_items WHERE id = 'ci1'")!;
  const label = row<{ l: string }>(raw, `SELECT (SELECT name FROM community_product_option_values WHERE id = v.value1_id) || '/' ||
                                          (SELECT name FROM community_product_option_values WHERE id = v.value2_id) AS l
                                     FROM community_product_variants v WHERE v.id = ?`, ci1.variant_id)!.l;
  assert.equal(label, 'M/أحمر');
  assert.deepEqual([ci1.option_id, ci1.color_id], [ci1.variant_id, '']);
  // The line that chose nothing on a one-choice product is that choice.
  assert.ok(row<{ variant_id: string | null }>(raw, "SELECT variant_id FROM cart_items WHERE id = 'ci2'")!.variant_id);
  // A second run finds nothing to do.
  assert.deepEqual(await convertLegacyProducts(env), { converted: 0, kept_legacy: 0, errors: 0 });
});

test('the converter aborts cleanly when the merchant edited the product in between', async () => {
  const raw = legacyWorld();
  const d1 = asD1(raw);
  const racing = {
    prepare: (s: string) => d1.prepare(s),
    batch: (stmts: D1PreparedStatement[]) => {
      raw.exec(`UPDATE community_products SET options = '["S","M","L"]' WHERE id = 'opts'`);
      return d1.batch(stmts);
    },
  } as unknown as D1Database;
  const r = await convertLegacyProducts({ DB: racing } as unknown as Env, 1);
  assert.equal(r.errors, 1);
  assert.equal(row<{ variant_mode: string }>(raw, "SELECT variant_mode FROM community_products WHERE id = 'opts'")!.variant_mode, 'legacy');
  assert.equal(count(raw, "SELECT COUNT(*) n FROM community_product_variants WHERE product_id = 'opts'"), 0, 'nothing half-written');
});
