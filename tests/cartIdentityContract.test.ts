/**
 * Stage B only: 0083 contracts cart identity after the Stage A Worker has
 * drained every targeted five-column UPSERT.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';

const ADD = `
  INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,
                          shipping_method_id,transport_method,warranty_plan_id,qty)
  VALUES (?,?,?,?,?,?,'','','',?)
  ON CONFLICT DO UPDATE SET qty = MIN(99, qty + excluded.qty),
                            option_value_ids = excluded.option_value_ids`;

const OLD_TARGETED_ADD = `
  INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,qty)
  VALUES (?,?,?,?,?,?,?)
  ON CONFLICT(user_id,product_id,option_id,color_id,shipping_method_id)
    WHERE product_id IS NOT NULL
  DO UPDATE SET qty = MIN(99, qty + excluded.qty)`;

test('0083 contracts to stable complete identity and Release A keeps working', () => {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const dir = join(ROOT, 'migrations');
  const files = readdirSync(dir).filter((name) => name.endsWith('.sql')).sort();
  for (const file of files) {
    if (file.startsWith('0083')) break;
    raw.exec(readFileSync(join(dir, file), 'utf8'));
  }
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash) VALUES ('u1','Sara','s@x.co','h');
    INSERT INTO products (id,slug,name,price_iqd,status) VALUES
      ('p1','legacy','Legacy',5000,'active'),
      ('p2','multi','Multi',5000,'active');
    INSERT INTO products (id,slug,name,price_iqd,status,composition)
      VALUES ('bundle1','mystery','Mystery',5000,'active','mystery');
    INSERT INTO product_option_groups (id,product_id,name_en,sort,active) VALUES
      ('p1-model','p1','Model',10,1), ('p1-size','p1','Size',20,1),
      ('p2-model','p2','Model',10,1), ('p2-region','p2','Region',20,1);
    INSERT INTO product_option_values (id,product_id,group_id,name_en,sort,active) VALUES
      ('z-model','p1','p1-model','Z',0,1), ('a-size','p1','p1-size','A',0,1),
      ('model-a','p2','p2-model','A',0,1),
      ('region-eu','p2','p2-region','EU',0,1), ('region-us','p2','p2-region','US',1,1);
    INSERT INTO cart_items
      (id,user_id,seller_type,product_id,option_id,option_value_ids,warranty_plan_id,qty)
    VALUES
      ('legacy-a','u1','levonis','p1','z-model','["a-size","z-model"]','wp_ext12',1),
      ('legacy-b','u1','levonis','p1','a-size','["a-size","z-model"]','',2),
      ('bundle','u1','levonis','bundle1','bx_keep_me','["family-a"]','',1);
  `);

  raw.exec(readFileSync(join(dir, files.find((file) => file.startsWith('0083'))!), 'utf8'));

  const legacy = (raw.prepare("SELECT option_id,option_value_ids,warranty_plan_id,qty FROM cart_items WHERE product_id='p1'")
    .all() as Array<{ option_id: string; option_value_ids: string; warranty_plan_id: string; qty: number }>)
    .map((row) => ({ ...row }));
  assert.deepEqual(legacy, [{
    option_id: 'a-size',
    option_value_ids: '["a-size","z-model"]',
    warranty_plan_id: '',
    qty: 3,
  }]);
  assert.equal(
    (raw.prepare("SELECT option_id FROM cart_items WHERE id='bundle'").get() as { option_id: string }).option_id,
    'bx_keep_me',
    'contract migration rewrote a composition key'
  );

  const indexRows = raw.prepare(
    "SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name='cart_items'"
  ).all() as Array<{ name: string; sql: string }>;
  const levonis = indexRows.filter((row) => row.name.startsWith('idx_cart_levonis_line'));
  assert.equal(levonis.length, 1);
  assert.match(levonis[0].sql, /option_value_ids/);

  const add = (id: string, values: string[]) => {
    const canonical = [...new Set(values)].sort();
    raw.prepare(ADD).run(id, 'u1', 'p2', canonical[0] ?? '', JSON.stringify(canonical), '', 1);
  };
  add('eu-1', ['model-a', 'region-eu']);
  add('us', ['model-a', 'region-us']);
  raw.exec("UPDATE product_option_groups SET sort = CASE id WHEN 'p2-model' THEN 20 ELSE 10 END WHERE product_id='p2'");
  add('eu-2', ['region-eu', 'model-a']);

  const lines = (raw.prepare("SELECT option_value_ids,qty FROM cart_items WHERE product_id='p2' ORDER BY option_value_ids")
    .all() as Array<{ option_value_ids: string; qty: number }>)
    .map((row) => ({ ...row }));
  assert.deepEqual(lines, [
    { option_value_ids: '["model-a","region-eu"]', qty: 2 },
    { option_value_ids: '["model-a","region-us"]', qty: 1 },
  ]);
  assert.throws(
    () => raw.prepare(OLD_TARGETED_ADD).run('old','u1','p2','model-a','["model-a"]','',1),
    /ON CONFLICT|no unique|does not match/i
  );
});
