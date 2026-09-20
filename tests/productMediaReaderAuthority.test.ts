/**
 * Catalogue card readers must never treat `products.images` as authority.
 *
 * The fixture deliberately creates a post-migration divergence: an external
 * stale mirror beside one canonical `product_images` row and one quarantined
 * provenance row. Every surface must choose the canonical row in one batched
 * read; a product with quarantine only must expose no image at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adminInventoryRoutes } from '../worker/routes/adminInventory';
import { adminProductsRoutes } from '../worker/routes/adminProducts';
import { compareRoutes } from '../worker/routes/compare';
import { profileRoutes } from '../worker/routes/profile';
import { stockAlertRoutes } from '../worker/routes/stockAlerts';
import { asD1, freshDb, get, json, stubApp, type StubUser } from './fixtures/app';

const CUSTOMER: StubUser = { id: 'media_customer', role: 'customer', email: 'media@example.com' };
const ADMIN: StubUser = { id: 'media_admin', role: 'admin', email: 'boss@x.co', admin_scope: null };
const GOOD = '/files/products/authority/gallery/primary.webp';
const BAD = 'https://bad.example/stale-product.jpg';

function setup() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,username)
      VALUES ('media_customer','Customer','media@example.com','h','customer','media_customer'),
             ('media_admin','Admin','boss@x.co','h','admin','media_admin');

    INSERT INTO products
      (id,slug,name,name_ar,name_ku,price_iqd,status,stock,images,spec_fields,template_family,inventory_mode)
      VALUES
      ('p_media','authority-product','Authority product','منتج موثوق','',1000,'active',4,
       '["${BAD}"]','{"print_speed":"500"}','devices','BASE'),
      ('p_quarantine','quarantine-only','Quarantine only','محجور','',2000,'active',2,
       '["${BAD}"]','{"print_speed":"300"}','devices','BASE');

    INSERT INTO product_images
      (id,product_id,url,r2_key,source_url,content_type,sort_order,is_primary,quarantined,quarantine_reason)
      VALUES
      ('img_good','p_media','${GOOD}','products/authority/gallery/primary.webp','','image/webp',9,1,0,''),
      ('img_bad','p_media','','','https://bad.example/quarantined.jpg','',0,0,1,'external_or_unsafe_url'),
      ('img_only_bad','p_quarantine','','','https://bad.example/only.jpg','',0,0,1,'external_or_unsafe_url');

    INSERT INTO favorites (user_id,product_id) VALUES
      ('media_customer','p_media'), ('media_customer','p_quarantine');

    INSERT INTO product_stock_alerts
      (id,user_id,product_id,kind,state,armed_channel)
      VALUES ('alert_good','media_customer','p_media','product','armed','in_app'),
             ('alert_empty','media_customer','p_quarantine','product','armed','in_app');

    INSERT INTO inventory_lots
      (id,product_id,scope,scope_id,qty_received,qty_remaining,cost_basis,received_at)
      VALUES ('lot_good','p_media','base','',2,2,'opening_unpriced','2026-01-01T00:00:00.000Z'),
             ('lot_empty','p_quarantine','base','',1,1,'opening_unpriced','2026-01-02T00:00:00.000Z');

    INSERT INTO incoming_inventory
      (id,product_id,scope,scope_id,qty_ordered,purchase_unit_iqd,status,created_by)
      VALUES ('incoming_good','p_media','base','',2,1000,'incoming','media_admin'),
             ('incoming_empty','p_quarantine','base','',1,1000,'incoming','media_admin');
  `);

  const db = asD1(raw);
  return {
    customer: stubApp(db, CUSTOMER, (app) => {
      app.route('/api/profile', profileRoutes);
      app.route('/api/stock-alerts', stockAlertRoutes);
    }),
    public: stubApp(db, null, (app) => app.route('/api/compare', compareRoutes)),
    admin: stubApp(db, ADMIN, (app) => {
      app.route('/api/admin/products-v2', adminProductsRoutes);
      app.route('/api/admin/inventory', adminInventoryRoutes);
    }),
  };
}

function byId(rows: Array<Record<string, unknown>>, idField: string, id: string): Record<string, unknown> {
  const found = rows.find((row) => row[idField] === id);
  assert.ok(found, `${id} missing from response`);
  return found;
}

function assertNoHotlink(payload: unknown): void {
  assert.equal(JSON.stringify(payload).includes('bad.example'), false);
}

test('favorites, compare and stock alerts use active product_images and fail closed on quarantine-only media', async () => {
  const apps = setup();

  const favorites = await json(await get(apps.customer, '/api/profile/favorites'));
  assert.equal(byId(favorites.favorites, 'id', 'p_media').image, GOOD);
  assert.equal(byId(favorites.favorites, 'id', 'p_quarantine').image, '');
  assertNoHotlink(favorites);

  const comparison = await json(await get(apps.public, '/api/compare?ids=p_media,p_quarantine'));
  assert.equal(byId(comparison.products, 'id', 'p_media').image, GOOD);
  assert.equal(byId(comparison.products, 'id', 'p_quarantine').image, null);
  assertNoHotlink(comparison);

  const candidates = await json(await get(apps.public, '/api/compare/candidates?for=p_media'));
  assert.equal(candidates.for.image, GOOD);
  assert.equal(byId(candidates.products, 'id', 'p_quarantine').image, null);
  assertNoHotlink(candidates);

  const alerts = await json(await get(apps.customer, '/api/stock-alerts'));
  assert.equal(byId(alerts.alerts, 'product_id', 'p_media').image, GOOD);
  assert.equal(byId(alerts.alerts, 'product_id', 'p_quarantine').image, null);
  assertNoHotlink(alerts);
});

test('admin product and inventory cards use the same batched relation authority', async () => {
  const apps = setup();

  const products = await json(await get(apps.admin, '/api/admin/products-v2?limit=100'));
  assert.equal(byId(products.products, 'id', 'p_media').image, GOOD);
  assert.equal(byId(products.products, 'id', 'p_quarantine').image, '');
  assertNoHotlink(products);

  const lines = await json(await get(apps.admin, '/api/admin/inventory/lines?limit=100'));
  assert.equal(byId(lines.lines, 'product_id', 'p_media').product_image, GOOD);
  assert.equal(byId(lines.lines, 'product_id', 'p_quarantine').product_image, null);
  assertNoHotlink(lines);

  const incoming = await json(await get(apps.admin, '/api/admin/inventory/incoming'));
  assert.equal(byId(incoming.incoming, 'product_id', 'p_media').product_image, GOOD);
  assert.equal(byId(incoming.incoming, 'product_id', 'p_quarantine').product_image, null);
  assertNoHotlink(incoming);
});
