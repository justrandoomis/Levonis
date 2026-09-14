import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { row, all, asD1 } from './fixtures/app';
import { returnOrderStock } from '../worker/lib/orderInventory';

const files = readdirSync(join(ROOT, 'migrations')).filter(f => f.endsWith('.sql')).sort();
function apply(raw: DatabaseSync, file: string) {
  raw.exec('BEGIN');
  try { raw.exec(readFileSync(join(ROOT, 'migrations', file), 'utf8')); raw.exec('COMMIT'); }
  catch (error) { raw.exec('ROLLBACK'); throw error; }
}
function legacy() {
  const raw = new DatabaseSync(':memory:'); raw.exec('PRAGMA foreign_keys=ON');
  for (const f of files.filter(f => f < '0072')) apply(raw, f);
  raw.exec(`
    INSERT INTO users(id,email,name,role) VALUES ('buyer','buyer@test.com','Buyer','customer');
    INSERT INTO products(id,slug,name,price_iqd) VALUES ('a1','a1-mini','A1 mini',499000);
    INSERT INTO product_option_groups(id,product_id,name_en) VALUES ('models','a1','Model');
    INSERT INTO product_option_values(id,product_id,group_id,name_en,variant_key,variant_label,availability_type,regular_price_iqd,prime_price_iqd,pro_price_iqd,cost_iqd,stock,reserved,image,sku_part,lead_time_text)
    VALUES ('mini-preorder','a1','models','A1 mini — Pre-order','mini','A1 mini','pre_order',499000,479000,449000,300000,NULL,0,'/files/products/mini-pre.webp','MINI-P','7–12 days'),
           ('mini-direct','a1','models','A1 mini — Direct','mini','A1 mini','direct_sale',549000,529000,449000,310000,5,1,'/files/products/mini-direct.webp','MINI-D','In stock'),
           ('combo-preorder','a1','models','A1 mini Combo — Pre-order','combo','','pre_order',679000,659000,629000,500000,NULL,0,'','COMBO-P','21–28 days'),
           ('combo-direct','a1','models','A1 mini Combo — Direct','combo','','direct_sale',699000,689000,629000,520000,3,0,'','COMBO-D','In stock');
    INSERT INTO product_images(id,product_id,url,option_value_id) VALUES ('image','a1','/files/products/mini-direct.webp','mini-direct');
    INSERT INTO cart_items(id,user_id,product_id,option_id,option_value_ids,qty) VALUES
      ('cart-pre','buyer','a1','mini-preorder','["mini-preorder"]',1),
      ('cart-direct','buyer','a1','mini-direct','["mini-direct"]',1);
    INSERT INTO orders(id,user_id,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd)
    VALUES ('old-order','buyer','{}','standard','{}','cash',549000,1400,549000,549000);
    INSERT INTO order_items(id,order_id,product_id,name_snapshot,option_snapshot,option_id,option_value_ids,qty,unit_price_iqd,line_total_iqd)
    VALUES ('old-line','old-order','a1','A1 mini','A1 mini — Direct','mini-direct','["mini-direct"]',1,549000,549000);
    INSERT INTO inventory_ledger(id,product_id,scope,scope_id,kind,qty,order_id,idempotency_key)
    VALUES ('reserved','a1','option','mini-direct','reserve',1,'old-order','reserve:old-order:old-line:option:mini-direct');
    INSERT INTO reviews(id,user_id,product_id,order_item_id,stars,body,status) VALUES ('review','buyer','a1','old-line',5,'Keep this review','published');
    INSERT INTO review_rewards(id,review_id,user_id,kind) VALUES ('reward','review','buyer','points');
  `);
  return raw;
}

test('populated migrations merge legacy models while preserving cart journeys, every price, inventory and review/reward history', async () => {
  const raw = legacy();
  const history = row(raw, 'SELECT * FROM order_items');
  const review = row(raw, 'SELECT * FROM reviews');
  for (const f of files.filter(f => f >= '0072')) apply(raw, f);
  assert.deepEqual(all(raw, 'PRAGMA foreign_key_check'), []);
  assert.equal(row(raw, 'SELECT COUNT(*) n FROM product_option_values')?.n, 2);
  assert.equal(row(raw, 'SELECT COUNT(*) n FROM product_option_fulfillment')?.n, 4);
  assert.equal(row(raw, "SELECT COUNT(*) n FROM product_option_values WHERE availability_type<>''")?.n, 0);
  assert.deepEqual(all(raw, 'SELECT name_en FROM product_option_values ORDER BY name_en'), [{ name_en: 'A1 mini' }, { name_en: 'A1 mini Combo' }]);
  assert.deepEqual(row(raw, "SELECT regular_price_iqd,prime_price_iqd,pro_price_iqd,cost_iqd,stock,reserved,image,sku_part,lead_time_text FROM product_option_fulfillment WHERE option_id='mini-preorder' AND fulfillment_type='direct_sale'"), {
    regular_price_iqd: 549000, prime_price_iqd: 529000, pro_price_iqd: 449000, cost_iqd: 310000,
    stock: 5, reserved: 1, image: '/files/products/mini-direct.webp', sku_part: 'MINI-D', lead_time_text: 'In stock',
  });
  assert.deepEqual(all(raw, 'SELECT option_id,fulfillment_type FROM cart_items ORDER BY id'), [
    { option_id: 'mini-preorder', fulfillment_type: 'direct_sale' }, { option_id: 'mini-preorder', fulfillment_type: 'pre_order' },
  ]);
  assert.equal(row(raw, 'SELECT option_value_id FROM product_images')?.option_value_id, 'mini-preorder');
  assert.deepEqual(row(raw, 'SELECT * FROM reviews'), review);
  const { selection_snapshot: _newSnapshot, ...afterHistory } = row(raw, 'SELECT * FROM order_items')!;
  assert.deepEqual(afterHistory, history);
  assert.equal(row(raw, 'SELECT COUNT(*) n FROM review_rewards')?.n, 1);
  assert.equal(row(raw, 'SELECT scope FROM inventory_ledger')?.scope, 'fulfillment');
  await returnOrderStock(asD1(raw), 'old-order', 'buyer');
  assert.equal(row(raw, "SELECT reserved FROM product_option_fulfillment WHERE id='ful_mini-preorder_direct_sale'")?.reserved, 0);
  assert.equal(row(raw, "SELECT stock FROM product_option_fulfillment WHERE id='ful_mini-preorder_direct_sale'")?.stock, 5);
});

test('ambiguous duplicate legacy journeys abort migration atomically rather than discard price/stock', () => {
  const raw = legacy();
  raw.exec("UPDATE product_option_values SET variant_key='mini' WHERE id='combo-direct'");
  for (const f of files.filter(f => f >= '0072' && f < '0075')) apply(raw, f);
  assert.throws(() => apply(raw, files.find(f => f.startsWith('0075'))!), /UNIQUE/);
  assert.equal(row(raw, 'SELECT COUNT(*) n FROM product_option_values')?.n, 4);
  assert.equal(row(raw, 'SELECT COUNT(*) n FROM product_option_fulfillment')?.n, 0);
  assert.equal(row(raw, 'SELECT COUNT(*) n FROM product_option_aliases')?.n, 0);
});
