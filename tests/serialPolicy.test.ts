/**
 * §29 «requires_serial_number» — one flag, resolved at read time (migration
 * 0178, worker/lib/serialPolicy.ts): the product's own word, then the printer
 * flag, then the nearest section policy on its branch. The SQL twin used by
 * the delivered-units sweep must agree with the TypeScript rule on every
 * product, or the sweep would pick an order again on every run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { json, post, put, row, count } from './fixtures/app';
import { world } from './fixtures/serialPrep';
import { lineDevicePolicy, serializationContext, serializedProductSql, anySectionSerialPolicy } from '../worker/lib/serialPolicy';
import { sweepDeliveredOrdersWithoutUnits } from '../worker/lib/deviceOps';
import { templateShape, parseImport, blankTemplate } from '../worker/lib/importCsv';
import { normKey, resolveProduct } from '../worker/lib/importApply';
import type { CatalogRef, ImportMaps } from '../worker/lib/importApply';

const PRODUCTS = ['pA1', 'pX2D', 'pAMS', 'pPLA', 'pAMS2', 'pNone'];

async function agree(w: ReturnType<typeof world>) {
  const ctx = await serializationContext(w.db, PRODUCTS);
  const withCatalog = await anySectionSerialPolicy(w.db);
  for (const id of PRODUCTS) {
    const p = row<{ ops_policy: string }>(w.raw, 'SELECT ops_policy FROM products WHERE id = ?', id)!;
    const ts = lineDevicePolicy(p.ops_policy, id, ctx).serialized;
    const sql = row<{ x: number }>(w.raw, `SELECT ${serializedProductSql('p.id', 'p.ops_policy', withCatalog)} AS x FROM products p WHERE p.id = ?`, id)!.x === 1;
    assert.equal(sql, ts, `${id}: the sweep's SQL and the TypeScript rule disagree`);
  }
  return ctx;
}

test('§29 the rule: the product\'s word, then the printer flag, then the nearest section; a section never switches a printer off', async () => {
  const w = world();
  w.raw.exec(`
    INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en) VALUES ('ct_ams2', 'ct_ams', 'sp-ams2', 'AMS 2', 'AMS 2');
    INSERT INTO products (id,slug,name,price_iqd,ops_policy,sub_category_id) VALUES
      ('pAMS2','sp-ams-2','AMS 2 Pro',1,'{}','ct_ams2'), ('pNone','sp-none','Loose part',1,'{}',NULL);
  `);
  let ctx = await agree(w);
  assert.equal(lineDevicePolicy('{}', 'pAMS', ctx).serialized, false, 'no AMS is inferred from its name');
  assert.equal(lineDevicePolicy('{}', 'pA1', ctx).serialized, true, 'a printer is serialized by default');

  w.raw.exec(`UPDATE catalogs SET serial_policy = 'required' WHERE id = 'ct_acc'`);
  ctx = await agree(w);
  assert.equal(lineDevicePolicy('{}', 'pAMS', ctx).serialized, true, 'inherited from the accessories section');
  assert.equal(lineDevicePolicy('{}', 'pAMS2', ctx).serialized, true, 'through two levels, by classification');
  w.raw.exec(`UPDATE catalogs SET serial_policy = 'off' WHERE id = 'ct_ams'`);
  ctx = await agree(w);
  assert.equal(lineDevicePolicy('{}', 'pAMS', ctx).serialized, false, 'the nearest section wins');
  assert.equal(lineDevicePolicy('{}', 'pPLA', ctx).serialized, true, 'its sibling still inherits required');
  w.raw.exec(`UPDATE catalogs SET serial_policy = 'off' WHERE id = 'ct_print'`);
  ctx = await agree(w);
  assert.equal(lineDevicePolicy('{}', 'pA1', ctx).serialized, true, 'a section never switches a printer off');
  w.raw.exec(`UPDATE products SET ops_policy = '{"serialized":true}' WHERE id = 'pAMS'`);
  ctx = await agree(w);
  assert.equal(lineDevicePolicy('{"serialized":true}', 'pAMS', ctx).serialized, true, 'the product\'s own word wins');
});

test('§29 the delivered-units sweep follows the section policy and never re-picks an order', async () => {
  const w = world();
  w.raw.exec(`
    INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,delivered_at)
      VALUES ('ORD-S','u1','delivered','{}','home','{}','cash',1,1400,1,0,'2026-10-01T00:00:00.000Z'),
             ('ORD-F','u1','delivered','{}','home','{}','cash',1,1400,1,0,'2026-10-01T00:00:00.000Z');
    INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_iqd, line_total_iqd) VALUES
      ('ls','ORD-S','pAMS','AMS',1,1,1), ('lf','ORD-F','pPLA','PLA',1,1,1);
  `);
  assert.equal((await sweepDeliveredOrdersWithoutUnits(w.env, 50)).scanned, 0);
  w.raw.exec(`UPDATE catalogs SET serial_policy = 'required' WHERE id = 'ct_ams'`);
  const first = await sweepDeliveredOrdersWithoutUnits(w.env, 50);
  assert.equal(first.created, 1);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM order_item_units WHERE order_id = 'ORD-S'"), 1);
  assert.equal((await sweepDeliveredOrdersWithoutUnits(w.env, 50)).scanned, 0, 'an empty pass once repaired');
});

test('§29 owner-only: section policy, the printer flag, a product\'s serialized flag — and an echo is not an attempt', async () => {
  const w = world();
  // The printer flag.
  const flag = await post(w.as('adm'), '/api/admin/taxonomy/catalogs', { id: 'ct_acc', name_en: 'Accessories', is_printer_catalog: true });
  assert.equal(flag.status, 403);
  assert.equal((await json(flag)).code, 'OWNER_ONLY');
  assert.equal((await post(w.as('adm'), '/api/admin/taxonomy/catalogs', { id: 'ct_acc', name_en: 'Accessories', is_printer_catalog: false })).status, 200, 'an echo passes');
  // The explicit ops-policy door.
  const off = await post(w.as('adm'), '/api/devices/admin/products/pAMS/ops-policy', { serialized: true });
  assert.equal((await json(off)).code, 'OWNER_ONLY');
  assert.equal((await post(w.as('adm'), '/api/devices/admin/products/pAMS/ops-policy', { serialized: false })).status, 200, 'the effective value, echoed');
  assert.equal((await post(w.as('boss'), '/api/devices/admin/products/pAMS/ops-policy', { serialized: true })).status, 200);
  // The product form: switching it is refused; a save that echoes it is not an attempt.
  const doc = { id: 'pPLA', name_en: 'PLA spool', name_ar: 'خيط PLA', price_iqd: 25000, status: 'draft' };
  const save = await post(w.as('adm'), '/api/admin/products-v2', { ...doc, serialized: true });
  assert.equal(save.status, 403, await save.clone().text());
  assert.equal((await json(save)).code, 'OWNER_ONLY');
  const echo = await post(w.as('adm'), '/api/admin/products-v2', { ...doc, serialized: false });
  assert.notEqual((await json(echo)).code, 'OWNER_ONLY', 'the effective value, echoed, is not an attempt');
  const owner = await post(w.as('boss'), '/api/admin/products-v2', { ...doc, serialized: true });
  assert.notEqual((await json(owner)).code, 'OWNER_ONLY');
});

test('§29/critique-1 #23 re-filing a product whose own word is silent is the owner\'s when it flips the answer', async () => {
  const w = world();
  // Into the printer catalog: the filament would start needing a serial.
  const into = await put(w.as('adm'), '/api/admin/products-v2/pPLA/catalogs', { catalog_ids: ['ct_print'] });
  assert.equal(into.status, 403, await into.clone().text());
  assert.equal((await json(into)).code, 'OWNER_ONLY');
  // Between two sections that agree, anyone may.
  const sideways = await put(w.as('adm'), '/api/admin/products-v2/pPLA/catalogs', { catalog_ids: ['ct_ams'] });
  assert.equal(sideways.status, 200, await sideways.clone().text());
  // Into a 'required' section is the same change by another door.
  w.raw.exec(`UPDATE catalogs SET serial_policy = 'required' WHERE id = 'ct_fil'`);
  assert.equal((await json(await put(w.as('adm'), '/api/admin/products-v2/pPLA/catalogs', { catalog_ids: ['ct_fil'] }))).code, 'OWNER_ONLY');
  assert.equal((await put(w.as('boss'), '/api/admin/products-v2/pPLA/catalogs', { catalog_ids: ['ct_fil'] })).status, 200, 'the owner may');
  // A product with its own word keeps it wherever it is filed — nothing is asked.
  w.raw.exec(`UPDATE products SET ops_policy = '{"serialized":false}' WHERE id = 'pAMS'`);
  assert.equal((await put(w.as('adm'), '/api/admin/products-v2/pAMS/catalogs', { catalog_ids: ['ct_print'] })).status, 200);
});

test('§29 an import sheet that changes `serialized` is refused by line for anyone but the owner; an echo passes', () => {
  const shape = templateShape('printer', [], { includeCost: true });
  const parsed = parseImport(blankTemplate(shape, true), shape).products[0];
  const printers: CatalogRef = {
    id: 'cat_printers', parent_id: null, slug: 'printers', name_en: 'Printers', name_ar: 'الطابعات', template_family: 'devices', is_printer_catalog: true,
  };
  const maps: ImportMaps = {
    brands: new Map(),
    catalogs: new Map([[normKey('Printers'), printers]]),
    facets: new Map(),
    familyOf: new Map([['cat_printers', 'devices']]),
    images: new Map(),
    productSlugs: new Map(),
  };
  let n = 0;
  const newId = (prefix: string) => `${prefix}_${++n}`;
  const issuesOf = (serialized: boolean | null, owner: boolean) =>
    resolveProduct({ ...parsed, category: 'Printers', serialized }, null, maps, { newId, money: true, owner }).issues.filter((i) => /^serialized: only the owner/.test(i.message));
  assert.equal(issuesOf(false, false).length, 1, 'switching a printer off is refused');
  assert.equal(issuesOf(false, false)[0].severity, 'error');
  assert.equal(issuesOf(true, false).length, 0, 'the printer default, echoed');
  assert.equal(issuesOf(null, false).length, 0, 'an empty cell keeps what is stored');
  assert.equal(issuesOf(false, true).length, 0, 'the owner may');
});
