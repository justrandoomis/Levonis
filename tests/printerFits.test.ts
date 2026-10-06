/**
 * «مواد الصيانة» AND «يناسب الطابعات» (migration 0148, owner 2026-09-27):
 *
 *   «لا توجد مواد الصيانه مثل Hotend، Build Plate، Spare Parts … عند إضافة
 *   المنتج في الحقول يكون هذه القطعة مخصصة لأي طابعه … مثلا الفوهة تكون مخصصة
 *   لطابعات متعددة مثل A1, A1 mini و A2L … بحيث تفيد عند الفلترة مواد الصيانه
 *   لطابعه معينه، وتفيد في صيانه وطلب صيانه الطابعه، وتفيد في الخوارزمية عندما
 *   يشتري المستخدم طابعة معينة يظهر له اقتراحات مواد الصيانة».
 *
 * Proven here, on real migrations, real SQLite and the real routers: the three
 * shelves and the form each one asks; the link written by the form, by a TXT
 * file (in the owner's own words) and by «تحديث البيانات»; the filter, the
 * product page's two sides, the order and the devices page; the claims queue;
 * the delete; and the minutes before 0148 reaches the database.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ROOT } from './fixtures/d1';
import { all, asD1, ctx, dbThrough, freshDb, get, json, post, row, stubApp, type App } from './fixtures/app';
import { templateRoutes } from '../worker/routes/template';
import { adminProductsRoutes } from '../worker/routes/adminProducts';
import { adminProductRelationsRoutes } from '../worker/routes/adminProductRelations';
import { catalogProductDetail, pricingCtxForUser, productRoutes, type PricingCtx } from '../worker/routes/products';
import { parseProductRow } from '../worker/lib/productModel';
import { orderRoutes } from '../worker/routes/orders';
import { deviceRoutes } from '../worker/routes/devices';
import { adminImportRoutes } from '../worker/routes/adminImport';
import { parseCsv, toCsv } from '../worker/lib/importCsv';
import { deleteProductPermanently } from '../worker/lib/productDeletion';
import { maintenanceFor, planPrinterFits } from '../worker/lib/printerFits';
import { matchPrinterRef } from '../worker/lib/templateRefs';
import { flatFields, groupsForSection, productTypeForBranch, type SectionRef } from '../worker/lib/templateFamilies';
import { activeFilterCount, listingParamPairs, parseListingParams } from '../packages/catalog/src/discovery';
import { appliedChips, quickChips, sheetSections } from '../src/lib/catalog/listingModel';
import { emptyListing } from '../src/lib/catalog/listingQuery';
import type { FacetSet } from '../src/lib/catalog/types';
import { toEditorDoc } from '../src/components/adminProducts/types';
import { hydrateRelations, relationsToWire, type RelationsResponse } from '../src/components/adminProducts/form/model';
import { productMediaFixtureEnv } from './fixtures/productMedia';

const OWNER = { id: 'usr_owner', role: 'admin' as const, email: 'boss@x.co', admin_scope: null };
const BUYER = { id: 'buyer', role: 'customer' as const, email: 'buyer@x.co' };

const USED_DOC = JSON.stringify({ kind: 'used', grade: 'good', warranty_months: 1, new_product_id: 'prd_a1' });

/** The store's printers — models, a hidden one, two «Pro»s and a used A1 named like its model. */
function seedPrinters(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','buyer@x.co','h','customer'), ('usr_owner','Owner','boss@x.co','h','admin');
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,inventory_mode,selling_type,sale_types,category_id,sub_category_id,created_at) VALUES
      ('prd_a1','bambu-lab-a1','Bambu Lab A1','Bambu Lab A1',900000,'active',5,'BASE','direct_sale','["direct_sale"]','cat_printers','cat_printers_fdm','2026-09-01T00:00:00.000Z'),
      ('prd_a1m','bambu-lab-a1-mini','Bambu Lab A1 mini','Bambu Lab A1 mini',650000,'active',5,'BASE','direct_sale','["direct_sale"]','cat_printers','cat_printers_fdm','2026-09-02T00:00:00.000Z'),
      ('prd_a2l','bambu-lab-a2l','Bambu Lab A2L','',1200000,'hidden',0,'BASE','direct_sale','["direct_sale"]','cat_printers','cat_printers_fdm','2026-09-03T00:00:00.000Z'),
      ('prd_h2d','bambu-lab-h2d-pro','Bambu Lab H2D Pro','',3000000,'active',1,'BASE','direct_sale','["direct_sale"]','cat_printers','cat_printers_fdm','2026-09-04T00:00:00.000Z'),
      ('prd_k1','creality-k1-pro','Creality K1 Pro','',800000,'active',1,'BASE','direct_sale','["direct_sale"]','cat_printers','cat_printers_fdm','2026-09-05T00:00:00.000Z');
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,inventory_mode,selling_type,sale_types,category_id,sub_category_id,condition_doc,created_at) VALUES
      ('prd_used_a1','bambu-lab-a1-used-7','Bambu Lab A1','Bambu Lab A1',600000,'active',1,'BASE','direct_sale','["direct_sale"]','cat_used','cat_used_printers','${USED_DOC}','2026-09-06T00:00:00.000Z');
    INSERT INTO product_catalogs (product_id,catalog_id,position) VALUES
      ('prd_a1','cat_printers_fdm',1),('prd_a1m','cat_printers_fdm',2),('prd_a2l','cat_printers_fdm',3),
      ('prd_h2d','cat_printers_fdm',4),('prd_k1','cat_printers_fdm',5),('prd_used_a1','cat_used_printers',1);
  `);
}

const mountAdmin = (a: Parameters<Parameters<typeof stubApp>[2]>[0]) => {
  a.route('/api/admin/template', templateRoutes);
  a.route('/api/admin/products-v2', adminProductsRoutes);
  a.route('/api/admin/products', adminProductRelationsRoutes);
};
const mountShop = (a: Parameters<Parameters<typeof stubApp>[2]>[0]) => {
  a.route('/api/products', productRoutes);
  a.route('/api/orders', orderRoutes);
  a.route('/api/devices', deviceRoutes);
};

function setup(raw: DatabaseSync = freshDb()) {
  seedPrinters(raw);
  const media = productMediaFixtureEnv();
  const db = asD1(raw);
  return {
    raw,
    db,
    admin: stubApp(db, OWNER, mountAdmin, { env: media.env }),
    shop: stubApp(db, BUYER, mountShop),
    guest: stubApp(db, null, mountShop),
  };
}

const partTxt = (slug: string, name: string, sub: string, fits: string | null, extra = '') =>
  [
    'template_version=2',
    `slug=${slug}`,
    `name_ar=${name}`,
    `name_en=${name}`,
    'price_iqd=15000',
    'selling_type=direct_sale',
    'category=maintenance-parts',
    `sub_category=${sub}`,
    'template_family=devices',
    ...(fits === null ? [] : [`fits_printers=${fits}`]),
    extra,
  ].join('\n');

async function applyTxt(app: App, text: string, extra: Record<string, unknown> = {}) {
  const res = await post(app, '/api/admin/template/apply', { text, mode: 'draft', confirm: true, ...extra });
  return { status: res.status, body: await json(res) };
}

const linksOf = (raw: DatabaseSync, productId: string) =>
  all<{ printer_id: string; position: number }>(
    raw,
    'SELECT printer_id, position FROM product_printer_fits WHERE product_id = ? ORDER BY position',
    productId
  ).map((r) => r.printer_id);

/** A nozzle (A1 mini, A1), a plate (A1), an AMS filed as an accessory (A1) — all published. */
async function seedParts(t: ReturnType<typeof setup>) {
  const nozzle = await applyTxt(t.admin, partTxt('hardened-nozzle-04', 'Hardened Nozzle 0.4', 'hotends-nozzles', 'A1 mini, A1'));
  assert.equal(nozzle.status, 200, JSON.stringify(nozzle.body));
  const plate = await applyTxt(t.admin, partTxt('textured-pei-plate', 'Textured PEI Plate', 'build-plates', 'bambu-lab-a1'));
  assert.equal(plate.status, 200, JSON.stringify(plate.body));
  const ams = await applyTxt(
    t.admin,
    partTxt('ams-lite-unit', 'AMS lite', 'build-plates', 'A1').replace('category=maintenance-parts', 'category=printer-accessories').replace('sub_category=build-plates', 'sub_category=fdm-printer-accessories')
  );
  assert.equal(ams.status, 200, JSON.stringify(ams.body));
  t.raw.exec("UPDATE products SET status = 'active' WHERE slug IN ('hardened-nozzle-04','textured-pei-plate','ams-lite-unit')");
  return { nozzle: String(nozzle.body.product_id), plate: String(plate.body.product_id), ams: String(ams.body.product_id) };
}

// ======================================================= the sections

test('0148 seeds «مواد الصيانة» with Hotends & Nozzles, Build Plates and Spare Parts, in the devices family', () => {
  const raw = freshDb();
  const rows = all(
    raw,
    `SELECT id, parent_id, slug, name_ar, name_en, name_ckb, is_printer_catalog, template_family
       FROM catalogs WHERE id LIKE 'cat_maint%' ORDER BY sort`
  );
  assert.deepEqual(
    rows.map((r) => [r.id, r.parent_id, r.slug, r.name_ar, r.name_en, r.is_printer_catalog, r.template_family]),
    [
      ['cat_maint', null, 'maintenance-parts', 'مواد الصيانة', 'Maintenance Parts', 0, 'devices'],
      ['cat_maint_hotend', 'cat_maint', 'hotends-nozzles', 'رؤوس الطباعة والفوهات', 'Hotends & Nozzles', 0, 'devices'],
      ['cat_maint_plate', 'cat_maint', 'build-plates', 'ألواح الطباعة', 'Build Plates', 0, 'devices'],
      ['cat_maint_spare', 'cat_maint', 'spare-parts', 'قطع الغيار', 'Spare Parts', 0, 'devices'],
    ]
  );
  // Sorani is the owner's hand: empty, and read as the Arabic name until written.
  assert.ok(rows.every((r) => r.name_ckb === ''));
});

test('a store that already owns «spare-parts» keeps it; 0148 takes the fallback, and a replay changes nothing', () => {
  const raw = dbThrough('0147');
  raw.exec(`INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, sort) VALUES ('mine', NULL, 'spare-parts', 'قسمي', 'Mine', 1)`);
  const sql = readFileSync(join(ROOT, 'migrations', '0148_maintenance_parts.sql'), 'utf8');
  raw.exec(sql);
  assert.equal(row<{ slug: string }>(raw, `SELECT slug FROM catalogs WHERE id = 'mine'`)!.slug, 'spare-parts');
  assert.equal(row<{ slug: string }>(raw, `SELECT slug FROM catalogs WHERE id = 'cat_maint_spare'`)!.slug, 'spare-parts-levo');
  raw.exec(sql);
  assert.equal(row<{ n: number }>(raw, `SELECT COUNT(*) AS n FROM catalogs WHERE id LIKE 'cat_maint%'`)!.n, 4);
});

test('each shelf is the parts form, asked only what it holds', () => {
  const b = (...pairs: Array<[string, string]>): SectionRef[] => pairs.map(([id, slug]) => ({ id, slug }));
  const root: [string, string] = ['cat_maint', 'maintenance-parts'];
  const ids = (branch: SectionRef[]) => groupsForSection('devices', branch).map((g) => g.id);
  for (const branch of [b(root), b(['cat_maint_hotend', 'hotends-nozzles'], root), b(['cat_maint_spare', 'spare-parts'], root)]) {
    assert.equal(productTypeForBranch('devices', branch), 'parts', branch[0].slug);
  }
  const hot = ids(b(['cat_maint_hotend', 'hotends-nozzles'], root));
  assert.ok(hot.includes('acc_hotend') && !hot.includes('acc_plate') && !hot.includes('acc_ams'), hot.join());
  const plate = ids(b(['cat_maint_plate', 'build-plates'], root));
  assert.ok(plate.includes('acc_plate') && !plate.includes('acc_hotend'), plate.join());
  const spare = ids(b(['cat_maint_spare', 'spare-parts'], root));
  for (const g of ['acc_hotend', 'acc_plate', 'acc_ams', 'acc_resin', 'laser_acc']) assert.ok(!spare.includes(g), `spare parts asked ${g}`);
  assert.ok(spare.includes('acc_common'), 'and still «يناسب الموديلات»');
  const top = ids(b(root));
  assert.ok(top.includes('acc_hotend') && top.includes('acc_plate') && !top.includes('acc_ams'), 'the root has not said which');
  // Only INSIDE «مواد الصيانة»: a hand-made «spare-parts» shelf elsewhere keeps what it had.
  const elsewhere = ids(b(['x', 'spare-parts'], ['cat_pacc_fdm', 'fdm-printer-accessories'], ['cat_pacc', 'printer-accessories']));
  for (const g of ['acc_ams', 'acc_hotend', 'acc_plate']) assert.ok(elsewhere.includes(g), g);
  assert.ok(flatFields(groupsForSection('devices', b(['cat_maint_hotend', 'hotends-nozzles'], root))).some((f) => f.id === 'nozzle_diameter'));
});

// ================================================= writing the link

test('a TXT file names printers the way the owner says them, and the links land in that order', async () => {
  const t = setup();
  const { nozzle } = await seedParts(t);
  assert.deepEqual(linksOf(t.raw, nozzle), ['prd_a1m', 'prd_a1'], '«A1 mini, A1» — the mini first, as written');
  const exported = await (await get(t.admin, `/api/admin/template/export/${nozzle}`)).text();
  assert.match(exported, /^fits_printers=bambu-lab-a1-mini,bambu-lab-a1$/m, 'exported as slugs, in order');
  // Re-applying its own export changes nothing.
  const again = await applyTxt(t.admin, exported, { mode: 'update', product_id: nozzle });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.deepEqual(linksOf(t.raw, nozzle), ['prd_a1m', 'prd_a1']);
});

test('a short name is matched on the END of a printer\'s name, a model before a used unit, and ambiguity is refused', () => {
  const rows = [
    { id: 'prd_a1', slug: 'bambu-lab-a1', name_en: 'Bambu Lab A1', name_ar: '', name_ckb: '', used: false },
    { id: 'prd_a1m', slug: 'bambu-lab-a1-mini', name_en: 'Bambu Lab A1 mini', name_ar: '', name_ckb: '', used: false },
    { id: 'prd_used', slug: 'a1-used', name_en: 'Bambu Lab A1', name_ar: '', name_ckb: '', used: true },
    { id: 'prd_h2d', slug: 'h2d-pro', name_en: 'Bambu Lab H2D Pro', name_ar: '', name_ckb: '', used: false },
    { id: 'prd_k1', slug: 'k1-pro', name_en: 'Creality K1 Pro', name_ar: '', name_ckb: '', used: false },
  ];
  assert.deepEqual(matchPrinterRef(rows, 'A1'), { kind: 'hit', id: 'prd_a1' }, 'the model, not its used unit');
  assert.deepEqual(matchPrinterRef(rows, 'A1 mini'), { kind: 'hit', id: 'prd_a1m' });
  assert.deepEqual(matchPrinterRef(rows, 'bambu-lab-a1-mini'), { kind: 'hit', id: 'prd_a1m' });
  assert.deepEqual(matchPrinterRef(rows, 'Pro'), { kind: 'ambiguous', candidates: ['h2d-pro', 'k1-pro'] });
  assert.deepEqual(matchPrinterRef(rows, 'A2'), { kind: 'miss' }, 'A2 is not the end of A2L, and not A1');
});

test('a printer the store does not have, or one the words cannot single out, goes to review — nothing is written', async () => {
  const t = setup();
  const res = await applyTxt(t.admin, partTxt('mystery-part', 'Mystery Part', 'spare-parts', 'A1, Z9, Pro'));
  assert.notEqual(res.status, 200);
  const review = JSON.stringify(res.body);
  assert.match(review, /Z9/);
  assert.match(review, /h2d-pro/);
  assert.equal(row(t.raw, `SELECT id FROM products WHERE slug = 'mystery-part'`), undefined);
});

async function formSave(t: ReturnType<typeof setup>, id: string, change: (doc: Record<string, unknown>) => void) {
  const p = await json(await get(t.admin, `/api/admin/products-v2/${id}`));
  const r = await json(await get(t.admin, `/api/admin/products/${id}/relations`));
  const doc = toEditorDoc(p.product) as unknown as Record<string, unknown>;
  const rel = hydrateRelations(r as unknown as RelationsResponse, p.product);
  const { options: _o, colors: _c, media: _m, ...docFields } = doc;
  void _o;
  void _c;
  void _m;
  const body: Record<string, unknown> = { ...docFields, relations: relationsToWire(rel), expected_updated_at: p.product.updated_at };
  change(body);
  const res = await post(t.admin, '/api/admin/products-v2', body);
  return { status: res.status, body: await json(res), loaded: doc };
}

test('the product form reads the links, saves them with the product, keeps them when it says nothing, clears them with []', async () => {
  const t = setup();
  const { nozzle } = await seedParts(t);
  const first = await formSave(t, nozzle, (b) => {
    b.printer_fit_ids = ['prd_a1', 'prd_k1'];
  });
  assert.deepEqual(first.loaded.printer_fit_ids, ['prd_a1m', 'prd_a1'], 'the form opened on the stored links');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(first.body.product.printer_fit_ids, ['prd_a1', 'prd_k1'], 'the save answers with the read-back');
  assert.deepEqual(linksOf(t.raw, nozzle), ['prd_a1', 'prd_k1']);

  const silent = await formSave(t, nozzle, (b) => {
    delete b.printer_fit_ids;
  });
  assert.equal(silent.status, 200, JSON.stringify(silent.body));
  assert.deepEqual(linksOf(t.raw, nozzle), ['prd_a1', 'prd_k1'], 'a client that never heard of the field clears nothing');

  const cleared = await formSave(t, nozzle, (b) => {
    b.printer_fit_ids = [];
  });
  assert.equal(cleared.status, 200);
  assert.deepEqual(linksOf(t.raw, nozzle), []);
});

test('a link to something that is not a printer, or to the part itself, is refused by name', async () => {
  const t = setup();
  const { nozzle, plate } = await seedParts(t);
  const notPrinter = await formSave(t, nozzle, (b) => {
    b.printer_fit_ids = ['prd_a1', plate];
  });
  assert.equal(notPrinter.status, 400);
  assert.equal(notPrinter.body.code, 'PRINTER_FITS_INVALID');
  assert.match(String(notPrinter.body.error), new RegExp(plate));
  const self = await formSave(t, nozzle, (b) => {
    b.printer_fit_ids = [nozzle];
  });
  assert.equal(self.status, 400);
  assert.deepEqual(linksOf(t.raw, nozzle), ['prd_a1m', 'prd_a1'], 'a refused save leaves the links as they were');
});

test('the picker lists every printer — models first, published first, used units last', async () => {
  const t = setup();
  const body = await json(await get(t.admin, '/api/admin/products-v2/printer-options'));
  const printers = body.printers as Array<{ id: string; status: string; used: boolean }>;
  assert.deepEqual(
    printers.map((p) => p.id),
    ['prd_a1', 'prd_a1m', 'prd_h2d', 'prd_k1', 'prd_a2l', 'prd_used_a1']
  );
  assert.equal(printers.find((p) => p.id === 'prd_a2l')!.status, 'hidden');
  assert.equal(printers.find((p) => p.id === 'prd_used_a1')!.used, true);
});

test('«تحديث البيانات» compares the printers with the section and writes them — and only them — from the file', async () => {
  const t = setup();
  const { nozzle } = await seedParts(t);
  const file = await (await get(t.admin, `/api/admin/template/section-export/${nozzle}`)).text();
  assert.match(file, /^fits_printers=bambu-lab-a1-mini,bambu-lab-a1$/m, 'the section file carries the key');
  const edited = file.replace(/^fits_printers=.*$/m, 'fits_printers=A1, H2D Pro') + '\nprice_iqd=1\n';
  const preview = await json(await post(t.admin, '/api/admin/template/section-preview', { product_id: nozzle, text: edited }));
  assert.deepEqual(
    (preview.changes as Array<{ field: string; before: string | null; after: string | null }>).filter((c) => c.field === 'fits_printers'),
    [{ field: 'fits_printers', before: 'bambu-lab-a1-mini, bambu-lab-a1', after: 'bambu-lab-a1, bambu-lab-h2d-pro' }]
  );
  assert.ok((preview.ignored_keys as string[]).includes('price_iqd'));
  const res = await post(t.admin, '/api/admin/template/apply', {
    text: edited,
    mode: 'update',
    confirm: true,
    scope: 'specs_content',
    product_id: nozzle,
    expected_updated_at: preview.updated_at,
  });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  assert.deepEqual(linksOf(t.raw, nozzle), ['prd_a1', 'prd_h2d']);
  assert.equal(row<{ price_iqd: number }>(t.raw, 'SELECT price_iqd FROM products WHERE id = ?', nozzle)!.price_iqd, 15000);
});

test('the spreadsheet lane carries «يناسب الطابعات» too: preview names a stranger, confirm writes, export returns it', async () => {
  const t = setup();
  const app = stubApp(t.db, OWNER, (a) => a.route('/api/admin/import', adminImportRoutes));
  const head = ['row_type', 'key', 'name', 'status', 'category', 'sub_category', 'price_iqd', 'stock', 'fits_printers'];
  const csv = (fits: string) =>
    toCsv([head, ['product', 'NZ-06', 'Nozzle 0.6', 'active', 'maintenance-parts', 'hotends-nozzles', '16000', '4', fits]]);
  const preview = async (text: string) => {
    const form = new FormData();
    form.set('file', new File([text], 'data.csv', { type: 'text/csv' }));
    form.set('category', 'cat_maint_hotend');
    const res = await app.request('/api/admin/import/preview', { method: 'POST', body: form, headers: { 'CF-Connecting-IP': '1.2.3.4' } }, undefined, ctx);
    return (await res.json()) as { import_id: string; rows: Array<{ errors: string[] }> };
  };
  const refused = await preview(csv('A1|Z9'));
  assert.ok(refused.rows[0].errors.some((e) => /Z9/.test(e)), JSON.stringify(refused.rows[0].errors));

  const ok = await preview(csv('A1 mini|bambu-lab-h2d-pro'));
  assert.deepEqual(ok.rows[0].errors, []);
  const res = await app.request(
    '/api/admin/import/confirm',
    { method: 'POST', body: JSON.stringify({ import_id: ok.import_id }), headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' } },
    undefined,
    ctx
  );
  const body = (await res.json()) as { rows: Array<{ product_id: string }> };
  const id = body.rows[0].product_id;
  assert.deepEqual(linksOf(t.raw, id), ['prd_a1m', 'prd_h2d']);

  const exported = await (await app.request(`/api/admin/import/export?category=cat_maint_hotend&format=csv`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }, undefined, ctx)).text();
  const rows = parseCsv(exported);
  const col = rows[0].indexOf('fits_printers');
  assert.ok(col > 0, 'the exported sheet has the column');
  const line = rows.find((r) => r.includes('NZ-06'))!;
  assert.equal(line[col], 'bambu-lab-a1-mini|bambu-lab-h2d-pro');
});

// ========================================================== the delete

test('deleting a printer takes its links; deleting a part takes its own — neither is blocked by the other', async () => {
  const t = setup();
  const { nozzle, plate } = await seedParts(t);
  const printer = await deleteProductPermanently(t.db, 'prd_a1m');
  assert.equal(printer.product_deleted, true);
  assert.deepEqual(linksOf(t.raw, nozzle), ['prd_a1']);
  const part = await deleteProductPermanently(t.db, plate);
  assert.equal(part.product_deleted, true);
  assert.equal(row<{ n: number }>(t.raw, 'SELECT COUNT(*) AS n FROM product_printer_fits WHERE product_id = ?', plate)!.n, 0);
  assert.ok((part.rows_deleted_by_table.product_printer_fits ?? 0) >= 1);
});

// ======================================================== the storefront

test('printer maintenance reads start while unrelated pricing is still pending', async () => {
  const t = setup();
  const readyPricing = await pricingCtxForUser(t.db, null);
  let releasePricing: (ctx: PricingCtx) => void = () => {};
  const pricing = new Promise<PricingCtx>((resolve) => { releasePricing = resolve; });
  let maintenanceStarted = false;
  const tracked = Object.create(t.db) as D1Database;
  tracked.prepare = (sql: string) => {
    if (/AS model_id/.test(sql)) maintenanceStarted = true;
    return t.db.prepare(sql);
  };
  const product = row(t.raw, "SELECT * FROM products WHERE id='prd_a1'")!;
  const detail = catalogProductDetail(tracked, product, parseProductRow(product), pricing);
  try {
    // Let all ready database promises run; the price remains deliberately
    // unresolved. A late maintenance waterfall cannot start in this window.
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(maintenanceStarted, true, 'independent maintenance work overlaps the main response');
  } finally {
    releasePricing(readyPricing);
  }
  const result = await detail;
  assert.equal(result.body.maintenance_parts, null, 'a printer with no linked parts still omits the shelf');
});

test('the part says which published printers it fits; the printer — and its used unit — count their parts', async () => {
  const t = setup();
  const { nozzle } = await seedParts(t);
  // A2L is hidden: linked, but never shown.
  t.raw.prepare('INSERT INTO product_printer_fits (product_id, printer_id, position) VALUES (?, ?, 2)').run(nozzle, 'prd_a2l');
  const part = await json(await get(t.guest, '/api/products/hardened-nozzle-04'));
  assert.deepEqual(
    (part.fits_printers as Array<{ slug: string }>).map((p) => p.slug),
    ['bambu-lab-a1-mini', 'bambu-lab-a1']
  );
  assert.equal(part.maintenance_parts, null, 'a nozzle has no maintenance shelf of its own');

  const a1 = await json(await get(t.guest, '/api/products/bambu-lab-a1'));
  // The nozzle and the plate; the AMS fits too, but it is an accessory, not a maintenance part.
  assert.deepEqual(a1.maintenance_parts, { count: 2, printer_slug: 'bambu-lab-a1', path: '/categories/maintenance-parts/all' });
  const used = await json(await get(t.guest, '/api/products/bambu-lab-a1-used-7'));
  assert.deepEqual(used.maintenance_parts, { count: 2, printer_slug: 'bambu-lab-a1', path: '/categories/maintenance-parts/all' }, 'a used unit shows its MODEL\'s parts');
  const k1 = await json(await get(t.guest, '/api/products/creality-k1-pro'));
  assert.equal(k1.maintenance_parts, null);
});

test('the listing narrows to a printer — in SQL without counts, in memory with them — and counts every printer', async () => {
  const t = setup();
  const { nozzle, plate, ams } = await seedParts(t);
  const ids = (b: Record<string, unknown>) => (b.products as Array<{ id: string }>).map((p) => p.id).sort();

  const a1 = await json(await get(t.guest, '/api/products?fits=bambu-lab-a1'));
  assert.deepEqual(ids(a1), [nozzle, plate, ams].sort(), 'every product linked to the A1, across sections');
  const shelf = await json(await get(t.guest, '/api/products?category=cat_maint&fits=bambu-lab-a1&limit=10'));
  assert.deepEqual(ids(shelf), [nozzle, plate].sort(), 'the shelf is «مواد الصيانة» only');
  const mini = await json(await get(t.guest, '/api/products?category=cat_maint&fits=bambu-lab-a1-mini'));
  assert.deepEqual(ids(mini), [nozzle]);

  const faceted = await json(await get(t.guest, '/api/products?category=cat_maint&fits=bambu-lab-a1-mini&facets=1'));
  assert.deepEqual(ids(faceted), [nozzle], 'memory applies the same filter the SQL does');
  assert.deepEqual(
    (faceted.facets.printers as Array<{ slug: string; count: number }>).map((p) => [p.slug, p.count]),
    [['bambu-lab-a1', 2], ['bambu-lab-a1-mini', 1]],
    'each printer counted with every OTHER filter applied'
  );
  const none = await json(await get(t.guest, '/api/products?fits=creality-k1-pro'));
  assert.deepEqual(none.products, []);
});

function seedOrder(raw: DatabaseSync, id: string, status: string, productId: string) {
  raw.prepare(
    `INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                         subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_type,created_at)
     VALUES (?,'buyer',?,'{}','standard','{}','cash',900000,0,1400,900000,900000,'direct',?)`
  ).run(id, status, `2026-09-2${id.slice(-1)}T00:00:00.000Z`);
  raw.prepare(
    `INSERT INTO order_items (id,order_id,product_id,name_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd)
     VALUES (?,?,?,'Printer','',1,900000,900000)`
  ).run(`oi_${id}`, id, productId);
}

test('the order that bought a printer offers its maintenance parts; a cancelled one does not', async () => {
  const t = setup();
  await seedParts(t);
  seedOrder(t.raw, 'ORD-1', 'confirmed', 'prd_used_a1');
  seedOrder(t.raw, 'ORD-2', 'cancelled', 'prd_a1m');
  const live = await json(await get(t.shop, '/api/orders/ORD-1'));
  assert.deepEqual(
    (live.order.maintenance_parts as Array<{ printer_slug: string; count: number; path: string }>).map((m) => [m.printer_slug, m.count, m.path]),
    [['bambu-lab-a1', 2, '/categories/maintenance-parts/all']],
    'a used A1 is offered the A1\'s parts'
  );
  const cancelled = await json(await get(t.shop, '/api/orders/ORD-2'));
  assert.deepEqual(cancelled.order.maintenance_parts, []);

});

test('the devices page and the claims queue point at the parts for the device\'s model', async () => {
  const t = setup();
  await seedParts(t);
  seedOrder(t.raw, 'ORD-3', 'delivered', 'prd_a1');
  t.raw.exec(`
    INSERT INTO order_item_units (id,order_id,order_item_id,product_id,owner_user_id,unit_index,delivered_at,warranty_end_at)
      VALUES ('oiu_1','ORD-3','oi_ORD-3','prd_a1','buyer',1,'2026-09-18T00:00:00.000Z','2027-09-18T00:00:00.000Z');
    INSERT INTO device_registrations (unit_id, user_id) VALUES ('oiu_1','buyer');
    INSERT INTO warranty_claims (id,user_id,unit_id,order_item_id,product_name,subject,description,status,stage)
      VALUES ('wc_1','buyer','oiu_1','oi_ORD-3','Bambu Lab A1','Nozzle clog','Clogged','submitted','received');
  `);
  const mine = await json(await get(t.shop, '/api/devices/mine'));
  assert.deepEqual(mine.devices[0].maintenance, { printer_slug: 'bambu-lab-a1', count: 2 });
  assert.equal(mine.maintenance_path, '/categories/maintenance-parts/all');
  const staff = stubApp(t.db, OWNER, mountShop);
  const claims = await json(await get(staff, '/api/devices/admin/claims'));
  assert.deepEqual(claims.claims[0].maintenance, { printer_slug: 'bambu-lab-a1', count: 2, path: '/categories/maintenance-parts/all' });
});

// ================================================== ahead of 0148

test('ahead of 0148 every reader answers «none», and only a save that asks for a link is refused', async () => {
  const raw = dbThrough('0147');
  seedPrinters(raw);
  const db = asD1(raw);
  const guest = stubApp(db, null, mountShop);
  const a1 = await json(await get(guest, '/api/products/bambu-lab-a1'));
  assert.equal(a1.success, true);
  assert.equal(a1.maintenance_parts, null);
  assert.deepEqual(a1.fits_printers, []);
  const listing = await json(await get(guest, '/api/products?fits=bambu-lab-a1'));
  assert.deepEqual(listing.products, []);
  const faceted = await json(await get(guest, '/api/products?facets=1'));
  assert.equal(faceted.success, true);
  assert.deepEqual(faceted.facets.printers, []);
  assert.deepEqual(await maintenanceFor(db, ['prd_a1']), new Map());
  assert.deepEqual((await planPrinterFits(db, 'prd_x', [])).stmts, [], 'nothing asked, nothing written');
  await assert.rejects(planPrinterFits(db, 'prd_x', ['prd_a1']), (e: Error & { code?: string }) => e.code === 'SERVICE_SETUP');
});

// ============================================ the URL and the filter sheet

test('the listing URL carries the printers as one sorted, bounded key in both vocabularies', () => {
  const read = (qs: string, mode: 'page' | 'api') => {
    const p = new URLSearchParams(qs);
    return parseListingParams((k) => p.get(k), mode);
  };
  const state = read('fits=bambu-lab-a1-mini,bambu-lab-a1,NOT A SLUG,طابعة-a1', 'page');
  assert.deepEqual(state.fits, ['bambu-lab-a1', 'bambu-lab-a1-mini', 'طابعة-a1']);
  assert.deepEqual(listingParamPairs(state, 'page'), [['fits', 'bambu-lab-a1,bambu-lab-a1-mini,طابعة-a1']]);
  assert.deepEqual(listingParamPairs(state, 'api'), [['fits', 'bambu-lab-a1,bambu-lab-a1-mini,طابعة-a1']]);
  assert.equal(activeFilterCount(state), 1);
  assert.equal(read('fits=' + Array.from({ length: 9 }, (_, i) => `p${i}`).join(','), 'api').fits.length, 6);
});

test('the filter sheet asks «يناسب الطابعة» first where it narrows the list, and the chips name the printer', () => {
  const facets = {
    total: 3,
    avail: { now: 0 },
    sale: { direct: 3, preorder: 0 },
    price: { min: 15000, max: 15000, histogram: [] },
    brands: [],
    printers: [
      { slug: 'bambu-lab-a1', id: 'prd_a1', name_ar: '', name_en: 'Bambu Lab A1', name_ckb: '', count: 2 },
      { slug: 'bambu-lab-a1-mini', id: 'prd_a1m', name_ar: '', name_en: 'Bambu Lab A1 mini', name_ckb: '', count: 1 },
    ],
    offer: 0,
    member: 0,
    specs: {},
  } as unknown as FacetSet;
  const state = emptyListing();
  assert.equal(sheetSections('default', facets, state)[0], 'printers');
  const chips = quickChips('default', facets, state, 'ar');
  assert.deepEqual(chips.filter((c) => c.id.startsWith('fits:')).map((c) => c.label), ['Bambu Lab A1', 'Bambu Lab A1 mini']);
  const on = chips.find((c) => c.id === 'fits:bambu-lab-a1-mini')!.next;
  assert.deepEqual(on.fits, ['bambu-lab-a1-mini']);
  assert.deepEqual(appliedChips(on, { lang: 'ar', facets }).map((c) => c.label), ['يناسب Bambu Lab A1 mini']);
  // Every product fits the one printer: the facet would change nothing, so it is not drawn.
  const same = { ...facets, printers: [{ ...facets.printers[0], count: 3 }] } as FacetSet;
  assert.ok(!sheetSections('default', same, state).includes('printers'));
});
