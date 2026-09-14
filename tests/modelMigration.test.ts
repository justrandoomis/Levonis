import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { asD1, row } from './fixtures/app';
import { applyRelations, loadRelationsView } from '../worker/lib/productOverlay';
import { parseProductRow } from '../worker/lib/productModel';
import { resolveUnitPrice } from '../worker/lib/pricing';

test('populated migrations merge explicit legacy models without losing route prices, holds, SKU, images or historical records', async () => {
  const raw = new DatabaseSync(':memory:'); raw.exec('PRAGMA foreign_keys=ON');
  const files = readdirSync(join(ROOT, 'migrations')).filter(f => f.endsWith('.sql')).sort();
  for (const file of files.filter(f => f < '0072')) raw.exec(readFileSync(join(ROOT, 'migrations', file), 'utf8'));
  raw.exec(`
    INSERT INTO users(id,email,name) VALUES ('u','history@test.com','History');
    INSERT INTO products(id,slug,name,price_iqd,prime_price_iqd,pro_price_iqd,sale_types,preorder_transports) VALUES ('p','legacy','Legacy',499000,479000,449000,'["direct_sale","pre_order"]','[{"method":"air","commission_iqd":80000,"active":true}]');
    INSERT INTO product_option_groups(id,product_id,name_en) VALUES ('g','p','Model');
    INSERT INTO product_option_values(id,product_id,group_id,name_en,variant_key,variant_label,availability_type,regular_adjust_iqd,prime_price_iqd,pro_price_iqd,cost_iqd,stock,reserved,sku_part,image,lead_time_text,lead_time_min_days,lead_time_max_days)
    VALUES ('mini-direct','p','g','A1 mini — Direct','mini','A1 mini','direct_sale',50000,529000,449000,310000,5,1,'DIRECT','/files/products/p/direct.webp','In stock',0,0),
           ('mini-preorder','p','g','A1 mini — Pre-order','mini','A1 mini','pre_order',0,479000,449000,300000,NULL,0,'PRE','/files/products/p/pre.webp','7–12 days',7,12);
    INSERT INTO product_images(id,product_id,url,option_value_id) VALUES ('image','p','/files/products/p/direct.webp','mini-direct');
    INSERT INTO cart_items(id,user_id,product_id,option_id,option_value_ids,qty) VALUES ('cart','u','p','mini-direct','["mini-direct"]',1);
    INSERT INTO orders(id,user_id,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd) VALUES ('o','u','{}','d','{}','cash',549000,1400,549000,549000);
    INSERT INTO order_items(id,order_id,product_id,name_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd) VALUES ('oi','o','p','Historical A1','Historical direct',1,549000,549000);
    INSERT INTO reviews(id,user_id,product_id,order_item_id,stars,body) VALUES ('review','u','p','oi',5,'Keep this');
    INSERT INTO review_rewards(id,review_id,user_id,kind) VALUES ('reward','review','u','points');
    INSERT INTO inventory_ledger(id,product_id,scope,scope_id,kind,qty,order_id,idempotency_key) VALUES ('ledger','p','option','mini-direct','reserve',1,'o','hold');
    INSERT INTO mystery_pools(id,name) VALUES ('pool','History');
    INSERT INTO mystery_pool_entries(id,pool_id,product_id) VALUES ('entry','pool','p');
    INSERT INTO mystery_allocations(order_item_id,spool_index,order_id,offer_product_id,pool_id,pool_entry_id,product_id,name_snapshot,sale_mode,seed,reveal_stage_snapshot,candidates_sha256) VALUES ('oi',0,'o','p','pool','entry','p','Historical draw','direct','seed','delivered','hash');
  `);
  // D1 applies one migration atomically. Use a transaction for each file, with
  // foreign keys ON throughout; a fresh empty schema alone cannot prove safety.
  for (const file of files.filter(f => f >= '0072')) raw.exec(`BEGIN;\n${readFileSync(join(ROOT, 'migrations', file), 'utf8')}\nCOMMIT;`);
  assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(row(raw, 'SELECT COUNT(*) n FROM product_option_values')?.n, 1);
  assert.equal(row(raw, 'SELECT COUNT(*) n FROM product_option_fulfillment')?.n, 2);
  assert.equal(row(raw, "SELECT COUNT(*) n FROM product_option_values WHERE availability_type<>''")?.n, 0);
  assert.equal(row(raw, 'SELECT name_en FROM product_option_values')?.name_en, 'A1 mini');
  assert.equal(row(raw, 'SELECT option_id FROM cart_items')?.option_id, 'mini-preorder');
  assert.equal(row(raw, 'SELECT fulfillment_type FROM cart_items')?.fulfillment_type, 'direct_sale');
  assert.equal(row(raw, 'SELECT option_value_id FROM product_images')?.option_value_id, 'mini-preorder');
  assert.equal(row(raw, 'SELECT scope FROM inventory_ledger')?.scope, 'fulfillment');
  assert.equal(row(raw, 'SELECT COUNT(*) n FROM review_rewards')?.n, 1);
  assert.equal(row(raw, 'SELECT name_snapshot FROM mystery_allocations')?.name_snapshot, 'Historical draw');
  const db = asD1(raw);
  const doc = applyRelations(parseProductRow(row(raw, 'SELECT * FROM products')!), await loadRelationsView(db, 'p', 'BASE'));
  const model = doc.options[0];
  assert.equal(model.regular_adjust_iqd, null, 'the moved delta must not be charged twice');
  assert.equal(model.direct?.reserved, 1);
  assert.equal(model.direct?.stock, 5);
  assert.equal(model.direct?.cost_iqd, 310000);
  assert.equal(model.direct?.sku_part, 'DIRECT');
  assert.equal(model.preorder?.sku_part, 'PRE');
  assert.equal(model.preorder?.lead_time_max_days, 12);
  const direct = resolveUnitPrice({ product: doc, optionId: model.id, fulfillmentType: 'direct_sale', tier: 'free', tierActive: false });
  assert.deepEqual(direct.errors, []); assert.equal(direct.unit_subtotal_iqd, 549000);
  assert.equal(resolveUnitPrice({ product: doc, optionId: model.id, transportMethod: 'air', tier: 'free', tierActive: false }).unit_subtotal_iqd, 579000);
});
