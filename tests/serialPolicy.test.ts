/**
 * §29 «requires_serial_number» — one flag, resolved at read time (migration
 * 0178, worker/lib/serialPolicy.ts): the product's own word, then the printer
 * flag, then the nearest section policy on its branch. The SQL twin used by
 * the delivered-units sweep must agree with the TypeScript rule on every
 * product, or the sweep would pick an order again on every run. Owner
 * decision 4 (2026-10-09): a used / open-box / refurbished grade turns
 * tracking on by itself for a printer only (the tests at the end).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { json, post, put, get, patch, row, count, stubApp, ctx, type App } from './fixtures/app';
import { world, order, USERS } from './fixtures/serialPrep';
import { adminImportRoutes } from '../worker/routes/adminImport';
import { applyPrinterWarrantyRules } from '../worker/lib/warrantyPlans';
import { lineDevicePolicy, serializationContext, serializedProductSql, anySectionSerialPolicy } from '../worker/lib/serialPolicy';
import { sweepDeliveredOrdersWithoutUnits } from '../worker/lib/deviceOps';
import { templateShape, parseImport, blankTemplate, toCsv } from '../worker/lib/importCsv';
import { IMPORT_SERIALIZED_OWNER_ONLY, normKey, resolveProduct, serialImportIssue } from '../worker/lib/importApply';
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
  // The printer flag — refused where it flips a product (landing round 3,
  // F1): the filament section holds a silent one.
  const flag = await post(w.as('adm'), '/api/admin/taxonomy/catalogs', { id: 'ct_fil', name_en: 'Filament', is_printer_catalog: true });
  assert.equal(flag.status, 403);
  assert.equal((await json(flag)).code, 'OWNER_ONLY');
  assert.equal((await post(w.as('adm'), '/api/admin/taxonomy/catalogs', { id: 'ct_fil', name_en: 'Filament', is_printer_catalog: false })).status, 200, 'an echo passes');
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

test('§29 an import sheet that changes `serialized` is refused by line for anyone but the owner; an echo passes', async () => {
  // `resolveProduct` is pure; the preview route asks `serialImportIssue` (with
  // the database: section policies, the stored filing) for every non-owner
  // row — tests/serialLandingReview.test.ts drives the route itself.
  const w = world();
  const shape = templateShape('printer', [], { includeCost: true });
  const parsed = parseImport(blankTemplate(shape, true), shape).products[0];
  const printers: CatalogRef = {
    id: 'ct_print', parent_id: null, slug: 'sp-printers', name_en: 'Printers', name_ar: 'طابعات', template_family: 'devices', is_printer_catalog: true,
  };
  const maps: ImportMaps = {
    brands: new Map(),
    catalogs: new Map([[normKey('Printers'), printers]]),
    facets: new Map(),
    familyOf: new Map([['ct_print', 'devices']]),
    images: new Map(),
    productSlugs: new Map(),
  };
  let n = 0;
  const newId = (prefix: string) => `${prefix}_${++n}`;
  const issueOf = async (serialized: boolean | null) => {
    const p = { ...parsed, category: 'Printers', serialized };
    const r = resolveProduct(p, null, maps, { newId, money: true });
    assert.equal(r.issues.some((i) => /owner|المالك/.test(i.message)), false, 'the pure resolver judges nothing about who may');
    return serialImportIssue(w.db, p, null, r);
  };
  const off = await issueOf(false);
  assert.equal(off?.message, IMPORT_SERIALIZED_OWNER_ONLY, 'switching a printer off is refused');
  assert.equal(off?.severity, 'error');
  assert.equal(await issueOf(true), null, 'the printer default, echoed');
  assert.equal(await issueOf(null), null, 'an empty cell keeps what is stored');
});

// ====================================================================== owner decision 4

/**
 * OWNER DECISION 4 (2026-10-09; DECISIONS row 192): serial tracking turns on
 * by itself for a used / open-box / refurbished device that needs a serial —
 * a printer — and not for an ordinary accessory. An AMS-like device gets it
 * from a section set to «required» or from the owner's own setting; nothing
 * already stored is changed.
 */
type World = ReturnType<typeof world>;
const USED = { kind: 'used', grade: 'good', warranty_months: 1 };
const opsOf = (w: World, id: string) => JSON.parse(String(row<{ ops_policy: string }>(w.raw, 'SELECT ops_policy FROM products WHERE id = ?', id)!.ops_policy)) as Record<string, unknown>;
async function effective(w: World, id: string): Promise<boolean> {
  const p = row<{ ops_policy: string }>(w.raw, 'SELECT ops_policy FROM products WHERE id = ?', id)!;
  return lineDevicePolicy(p.ops_policy, id, await serializationContext(w.db, [id])).serialized;
}
const DOCS: Record<string, { name_en: string; name_ar: string; price_iqd: number }> = {
  pA1: { name_en: 'Bambu Lab A1 Combo', name_ar: 'طابعة A1 كومبو', price_iqd: 899000 },
  pAMS: { name_en: 'Bambu Lab AMS Lite', name_ar: 'AMS لايت', price_iqd: 399000 },
  pPLA: { name_en: 'PLA spool', name_ar: 'خيط PLA', price_iqd: 25000 },
};
const grade = (w: World, who: keyof typeof USERS, id: string) =>
  post(w.as(who), '/api/admin/products-v2', { id, ...DOCS[id], status: 'draft', condition: USED });

test('owner decision 4, the product form: a graded printer is tracked, a graded accessory is not, a graded AMS follows its «required» section — for the owner and an assistant alike', async () => {
  for (const who of ['boss', 'ast'] as const) {
    const w = world();
    w.raw.exec(`UPDATE catalogs SET serial_policy = 'required' WHERE id = 'ct_ams'`);
    for (const id of ['pA1', 'pAMS', 'pPLA']) {
      const r = await grade(w, who, id);
      assert.equal(r.status, 200, `${who} ${id}: ${await r.clone().text()}`);
    }
    assert.equal(opsOf(w, 'pA1').serialized, true, `${who}: a used printer is tracked per unit`);
    assert.equal(await effective(w, 'pA1'), true);
    assert.equal('serialized' in opsOf(w, 'pAMS'), false, `${who}: the AMS keeps following its section, nothing pinned`);
    assert.equal(await effective(w, 'pAMS'), true, `${who}: …which says «required»`);
    assert.equal('serialized' in opsOf(w, 'pPLA'), false, `${who}: an ordinary accessory gets no word`);
    assert.equal(await effective(w, 'pPLA'), false, `${who}: and needs no serial`);
    // The owner's explicit word survives a re-grade, either way.
    w.raw.exec(`UPDATE products SET ops_policy = '{"serialized":true}' WHERE id = 'pPLA'`);
    assert.equal((await grade(w, 'boss', 'pPLA')).status, 200);
    assert.equal(opsOf(w, 'pPLA').serialized, true, 'an explicit word is kept');
  }
});

test('owner decision 4: a graded accessory asks for no serial at preparation and gets no warranty unit at delivery; a graded AMS in a «required» section does', async () => {
  const w = world();
  w.raw.exec(`UPDATE catalogs SET serial_policy = 'required' WHERE id = 'ct_ams'`);
  for (const id of ['pAMS', 'pPLA']) assert.equal((await grade(w, 'boss', id)).status, 200, id);
  order(w.raw, 'ORD-USED', [{ id: 'lp', product: 'pPLA', qty: 2 }, { id: 'la', product: 'pAMS' }]);
  const view = (await json(await get(w.as('adm'), '/api/admin/orders/ORD-USED/serials'))).serials;
  assert.deepEqual(view.slots.map((s: { order_item_id: string }) => s.order_item_id), ['la'], 'one slot: the AMS');
  assert.equal(view.required, 1);
  assert.equal((await patch(w.as('boss'), '/api/admin/orders/ORD-USED/stage', { stage: 'delivered' })).status, 200);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM order_item_units WHERE order_item_id = 'lp'"), 0, 'no unit for the accessory');
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM order_item_units WHERE order_item_id = 'la'"), 1, 'a unit for the AMS');
});

const IMPORT_HEAD = ['row_type', 'key', 'name', 'status', 'category', 'sub_category', 'price_iqd', 'serialized', 'condition_kind', 'condition_grade', 'condition_warranty_months'];
const usedSheet = (...rows: Array<Record<string, string>>) =>
  toCsv([
    IMPORT_HEAD,
    ...rows.map((r) =>
      IMPORT_HEAD.map(
        (h) => ({ row_type: 'product', status: 'draft', price_iqd: '100000', serialized: '', condition_kind: 'used', condition_grade: 'good', condition_warranty_months: '1', ...r })[h] ?? ''
      )
    ),
  ]);
const importApp = (w: World, who: keyof typeof USERS): App => stubApp(w.db, USERS[who], (a) => a.route('/api/admin/import', adminImportRoutes));
async function importSheet(app: App, csv: string) {
  const form = new FormData();
  form.set('file', new File([csv], 'data.csv', { type: 'text/csv' }));
  form.set('category', 'ct_acc');
  const res = await app.request('/api/admin/import/preview', { method: 'POST', body: form, headers: { 'CF-Connecting-IP': '1.2.3.4' } }, undefined, ctx);
  const preview = await json(res);
  assert.equal(res.status, 200, JSON.stringify(preview));
  const done = await app.request(
    '/api/admin/import/confirm',
    { method: 'POST', body: JSON.stringify({ import_id: preview.import_id }), headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' } },
    undefined,
    ctx
  );
  return { preview, done: await json(done) };
}

test('owner decision 4: the import sheet (preview and confirm) and the guard behind the TXT template give the form\'s answers — a graded printer tracked, a graded accessory not', async () => {
  const w = world();
  w.raw.exec(`
    UPDATE catalogs SET template_family = 'devices' WHERE id IN ('ct_acc','ct_print');
    UPDATE products SET category_id = 'ct_print' WHERE id = 'pA1';
    UPDATE products SET category_id = 'ct_acc', sub_category_id = 'ct_fil' WHERE id = 'pPLA';
  `);
  // The import sheet, as a non-owner: both rows pass the preview and are written.
  const { preview, done } = await importSheet(
    importApp(w, 'adm'),
    usedSheet(
      { key: 'sp-a1', name: 'Bambu Lab A1 Combo', category: 'sp-printers' },
      { key: 'sp-pla', name: 'PLA spool', category: 'sp-acc', sub_category: 'sp-fil' }
    )
  );
  for (const r of preview.rows as Array<{ key: string; action: string; errors: string[] }>) assert.deepEqual(r.errors, [], JSON.stringify(r));
  assert.equal(done.success, true, JSON.stringify(done));
  for (const id of ['pA1', 'pPLA']) {
    const doc = JSON.parse(String(row<{ condition_doc: string }>(w.raw, 'SELECT condition_doc FROM products WHERE id = ?', id)!.condition_doc));
    assert.equal(doc.kind, 'used', `${id}: the grade was written`);
  }
  assert.equal(opsOf(w, 'pA1').serialized, true, 'a used printer is tracked');
  assert.equal(await effective(w, 'pA1'), true);
  assert.equal('serialized' in opsOf(w, 'pPLA'), false, 'a used accessory gets no word');
  assert.equal(await effective(w, 'pPLA'), false);

  // The TXT template, the product form, the admin product route and the
  // import confirm all call applyPrinterWarrantyRules (the TXT template's own
  // keys carry no grade today, so it reaches the rule only with what the
  // document holds). The same answers from the guard itself:
  const condition = { kind: 'used', grade: 'good', warranty_months: 1 } as never;
  const guarded = async (id: string, catalogIds: string[]) => {
    const doc = { id, category_id: null, sub_category_id: null, warranty_plans: [], serialized: null as boolean | null, warranty_base_months: null, condition };
    await applyPrinterWarrantyRules(w.db, doc, catalogIds);
    return doc.serialized;
  };
  assert.equal(await guarded('pA1', ['ct_print']), true);
  assert.equal(await guarded('pPLA', ['ct_fil']), null);
  assert.equal(await guarded('pAMS', ['ct_ams']), null, 'an AMS is not inferred: its section decides at read time');
});
