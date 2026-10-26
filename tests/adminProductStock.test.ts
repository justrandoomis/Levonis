import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get, json, stubApp } from './fixtures/app';
import { AMS, AMS_MODEL, OWNER_USER, pricingWorld } from './fixtures/procurementPricing';
import { seedOptionless } from './fixtures/pricingV2';
import { adminProductsRoutes } from '../worker/routes/adminProducts';
import { adminInventoryRoutes } from '../worker/routes/adminInventory';

type World = ReturnType<typeof pricingWorld>;
type Product = { id: string; stock: number | null; stock_reserved: number; has_direct_sale: boolean; needs_pricing: boolean };
const reader = (w: World) => stubApp(w.db, OWNER_USER, app => {
  app.route('/api/admin/products-v2', adminProductsRoutes);
  app.route('/api/admin/inventory', adminInventoryRoutes);
}, { publishV2: false });
async function products(w: World, query = ''): Promise<{ products: Product[]; total: number }> {
  const response = await get(reader(w), `/api/admin/products-v2?limit=100&${query}`);
  assert.equal(response.status, 200);
  return await json(response) as { products: Product[]; total: number };
}
async function product(w: World, id: string) {
  const row = (await products(w)).products.find(p => p.id === id);
  assert.ok(row, `missing product ${id}`);
  return row;
}

test('an imported variant receipt appears in both inventory and products before pricing or fulfillment setup, without receiving twice', async () => {
  const w = pricingWorld();
  // The import writes option/variant identities without fulfillment cells.
  w.raw.prepare('DELETE FROM product_option_fulfillment WHERE product_id=?').run(AMS);
  w.raw.prepare("UPDATE products SET inventory_mode='VARIANT_COMBINATION',stock=0 WHERE id=?").run(AMS);
  w.raw.prepare('INSERT INTO product_variants(id,product_id,combo_key,active,stock) VALUES (?,?,?,1,NULL)').run('import-received', AMS, `o:${AMS_MODEL}`);
  w.raw.prepare(`INSERT INTO product_source_refs(source,source_product_id,product_id,source_handle,canonical_url,match_kind,stock_decision,fingerprint,fetched_at,import_run_id)
    VALUES ('bambu_us',?,?,?,'https://us.store.bambulab.com/products/test','created','not_configured','test','2026-10-26','test')`).run(AMS, AMS, AMS);
  const purchase = await w.save(w.draft({ lines: [{ product_id: AMS, scope: 'variant', scope_id: 'import-received', qty_ordered: 2, source_unit_amount: 10, weight_g: 10, volume_mm3: 0 }] }));
  const operation = crypto.randomUUID();
  assert.equal((await w.receive(purchase, operation)).status, 200);
  assert.equal((await w.receive(purchase, operation)).status, 200);
  assert.equal(w.raw.prepare('SELECT stock FROM product_variants WHERE id=?').get('import-received')?.stock, 2);
  const inventory = await json(await get(reader(w), `/api/admin/inventory/lines?product_id=${AMS}`));
  assert.equal((inventory.lines as Array<{ on_hand: number }>).reduce((sum, line) => sum + line.on_hand, 0), 2);
  const row = await product(w, AMS);
  assert.equal(row.stock, 2, 'the product list must show the units already received');
  assert.equal(row.stock_reserved, 0);
  assert.equal(row.needs_pricing, true, 'stock visibility does not publish a price');
  assert.equal(w.raw.prepare('SELECT SUM(qty_remaining) AS n FROM inventory_lots WHERE product_id=?').get(AMS)?.n, 2);
});

test('option stock inherits product-level direct sale when no fulfillment cells exist', async () => {
  const w = pricingWorld();
  w.raw.prepare('DELETE FROM product_option_fulfillment WHERE product_id=?').run(AMS);
  w.raw.prepare('UPDATE product_option_values SET stock=7,reserved=2 WHERE id=?').run(AMS_MODEL);
  const row = await product(w, AMS);
  assert.equal(row.stock, 7);
  assert.equal(row.stock_reserved, 2);
  assert.equal(row.has_direct_sale, true);
});

test('color-only variants inherit product-level direct sale without an option token', async () => {
  const w = pricingWorld(), id = 'color-only-variant';
  seedOptionless(w.raw, id, { colours: 1, saleTypes: ['direct_sale'] });
  w.raw.prepare("UPDATE products SET inventory_mode='VARIANT_COMBINATION',stock=0 WHERE id=?").run(id);
  w.raw.prepare('INSERT INTO product_variants(id,product_id,combo_key,active,stock,reserved) VALUES (?,?,?,1,4,1)').run(`${id}-v`, id, `c:${id}_c0`);
  const row = await product(w, id);
  assert.equal(row.stock, 4);
  assert.equal(row.stock_reserved, 1);
});

test('an untracked sibling does not hide received option, color or variant quantities', async () => {
  for (const mode of ['OPTION', 'COLOR', 'VARIANT_COMBINATION']) {
    const w = pricingWorld();
    if (mode === 'OPTION') {
      const group = w.raw.prepare('SELECT group_id FROM product_option_values WHERE id=?').get(AMS_MODEL)!.group_id!;
      w.raw.prepare("INSERT INTO product_option_values(id,product_id,group_id,name_en,active,stock) VALUES ('unknown',?,?,'Unknown',1,NULL)").run(AMS, group);
      w.raw.prepare("INSERT INTO product_option_fulfillment(id,product_id,option_id,fulfillment_type,enabled) VALUES ('unknown-direct',?,'unknown','direct_sale',1)").run(AMS);
      w.raw.prepare('UPDATE product_option_values SET stock=3,reserved=1 WHERE id=?').run(AMS_MODEL);
    } else {
      w.raw.prepare('UPDATE products SET inventory_mode=? WHERE id=?').run(mode, AMS);
      if (mode === 'COLOR') {
        w.raw.prepare("INSERT INTO product_colors(id,product_id,name_en,hex,active,stock,reserved) VALUES ('known',?,'Known','#000000',1,3,1),('unknown',?,'Unknown','#ffffff',1,NULL,0)").run(AMS, AMS);
      } else {
        w.raw.prepare("INSERT INTO product_colors(id,product_id,name_en,hex,active,stock) VALUES ('unreceived',?,'Unreceived','#ffffff',1,NULL)").run(AMS);
        w.raw.prepare("INSERT INTO product_variants(id,product_id,combo_key,active,stock,reserved) VALUES ('known',?,?,1,3,1),('unknown',?,?,1,NULL,0)").run(AMS, `o:${AMS_MODEL}`, AMS, `o:${AMS_MODEL}|c:unreceived`);
      }
    }
    const row = await product(w, AMS);
    assert.equal(row.stock, 3, mode);
    assert.equal(row.stock_reserved, 1, mode);
    const inStock = (await products(w, 'stock=in')).products.map(p => p.id);
    const lowStock = (await products(w, 'stock=low')).products.map(p => p.id);
    const out = (await products(w, 'stock=out')).products.map(p => p.id);
    assert.ok(inStock.includes(AMS), mode);
    assert.ok(lowStock.includes(AMS), mode);
    assert.ok(!out.includes(AMS), mode);
  }
});

test('configured direct-sale cells exclude preorder-only and disabled choices and count reservations once', async () => {
  for (const mode of ['OPTION', 'VARIANT_COMBINATION']) {
    const w = pricingWorld();
    const group = w.raw.prepare('SELECT group_id FROM product_option_values WHERE id=?').get(AMS_MODEL)!.group_id!;
    for (const [id, type, enabled] of [['preorder', 'pre_order', 1], ['disabled', 'direct_sale', 0]] as const) {
      w.raw.prepare('INSERT INTO product_option_values(id,product_id,group_id,name_en,active,stock,reserved) VALUES (?,?,?, ?,1,50,10)').run(id, AMS, group, id);
      w.raw.prepare('INSERT INTO product_option_fulfillment(id,product_id,option_id,fulfillment_type,enabled) VALUES (?,?,?,?,?)').run(`${id}-cell`, AMS, id, type, enabled);
    }
    w.raw.prepare('UPDATE product_option_values SET stock=6,reserved=2 WHERE id=?').run(AMS_MODEL);
    if (mode === 'VARIANT_COMBINATION') {
      w.raw.prepare('UPDATE products SET inventory_mode=? WHERE id=?').run(mode, AMS);
      for (const [id, stock, reserved, active] of [[AMS_MODEL, 6, 2, 1], ['preorder', 50, 10, 1], ['disabled', 50, 10, 1], ['inactive', 20, 0, 0]] as const) {
        w.raw.prepare('INSERT INTO product_variants(id,product_id,combo_key,stock,reserved,active) VALUES (?,?,?,?,?,?)').run(`v-${id}`, AMS, `o:${id === 'inactive' ? AMS_MODEL : id}${id === 'inactive' ? '|c:inactive' : ''}`, stock, reserved, active);
      }
    }
    const row = await product(w, AMS);
    assert.equal(row.stock, 6, mode);
    assert.equal(row.stock_reserved, 2, mode);
  }
});

test('missing and entirely untracked inventory remain zero; preorder-only products stay preorder-only', async () => {
  const w = pricingWorld();
  for (const mode of ['OPTION', 'COLOR', 'VARIANT_COMBINATION']) {
    w.raw.prepare('UPDATE products SET inventory_mode=? WHERE id=?').run(mode, AMS);
    w.raw.prepare('UPDATE product_option_values SET stock=NULL WHERE product_id=?').run(AMS);
    assert.equal((await product(w, AMS)).stock, 0, mode);
  }
  w.raw.prepare('UPDATE product_option_fulfillment SET enabled=0 WHERE product_id=? AND fulfillment_type=?').run(AMS, 'direct_sale');
  const row = await product(w, AMS);
  assert.equal(row.has_direct_sale, false);
  assert.equal(row.stock, null);
  assert.equal(row.stock_reserved, 0);
});
