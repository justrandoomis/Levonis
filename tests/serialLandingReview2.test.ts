/**
 * The serial-scan LANDING reviews, ROUND 3 — one test per verified finding,
 * by name. Every case runs the real routes over the real migrations
 * (tests/fixtures/serialPrep.ts), the reviewers' reproductions made real.
 *
 *   F1  the printer flag is judged by its flips, not by being touched
 *   F2  an import keeps a product's extra placements (a printer catalog held
 *       beside a plain section), so a routine price row neither refuses nor
 *       turns a printer off
 *   F3  the OWNER_ONLY refusal reads in Sorani on the admin screens
 *   F4  an import confirm re-reads the live row: an owner's later serial word
 *       survives, and a row the live row now refuses fails alone
 *   F5  the unit history and the warranty receipt mask serial history like
 *       the serial page
 *   F6  the serial page never answers unmasked when its story fails
 *   F7  the bundle and mystery-offer editors judge §29; a bundle PARENT never
 *       gets warranty units of its own
 *
 * Run: npx tsx --test tests/serialLandingReview2.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { asD1, json, post, patch, get, row, all, count, stubApp, ctx, type App } from './fixtures/app';
import { world, order, USERS, SN, SN2, BOX } from './fixtures/serialPrep';
import { adminImportRoutes } from '../worker/routes/adminImport';
import { adminBundlesRoutes } from '../worker/routes/adminBundles';
import { adminMysteryRoutes } from '../worker/routes/mystery';
import { toCsv } from '../worker/lib/importCsv';
import { IMPORT_SERIALIZED_OWNER_ONLY, IMPORT_SERIAL_REFILE_OWNER_ONLY, importPlacements } from '../worker/lib/importApply';
import { lineDevicePolicy, printerFlagSerialFlips, serializationContext } from '../worker/lib/serialPolicy';
import { maskSerial, createUnitsOnDelivery, sweepDeliveredOrdersWithoutUnits } from '../worker/lib/deviceOps';
import { contractRefusal, refusalLang, refusalText, REFUSAL_STRINGS } from '../src/lib/refusalStrings';
import { COST_REFUSALS, serverMessage } from '../packages/contracts/src/costRefusals';
import { seedCatalogue, addBundle, orderBody } from './lib/bundles';
import { cartRoutes } from '../worker/routes/cart';
import { orderRoutes } from '../worker/routes/orders';

type World = ReturnType<typeof world>;

const opsOf = (w: World, id: string) =>
  JSON.parse(String(row<{ ops_policy: string }>(w.raw, 'SELECT ops_policy FROM products WHERE id = ?', id)!.ops_policy)) as Record<string, unknown>;

async function effective(w: World, id: string): Promise<boolean> {
  const p = row<{ ops_policy: string }>(w.raw, 'SELECT ops_policy FROM products WHERE id = ?', id)!;
  return lineDevicePolicy(p.ops_policy, id, await serializationContext(w.db, [id])).serialized;
}

const shelves = (w: World, id: string) =>
  all<{ catalog_id: string }>(w.raw, 'SELECT catalog_id FROM product_catalogs WHERE product_id = ? ORDER BY catalog_id', id).map((r) => r.catalog_id);

// ====================================================================== F1

test('F1: the printer flag is refused to a non-owner ONLY when it flips a product\'s effective answer', async () => {
  const w = world();
  const v2 = (who: keyof typeof USERS, id: string, body: Record<string, unknown>) => patch(w.as(who), `/api/admin/products-v2/catalogs/${id}`, body);
  const tax = (who: keyof typeof USERS, body: Record<string, unknown>) => post(w.as(who), '/api/admin/taxonomy/catalogs', body);

  // An EMPTY catalog: nothing can flip — on and off, through both editors.
  w.raw.exec(`INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en) VALUES ('ct_new', NULL, 'sp-new', 'جديد', 'New')`);
  assert.equal(await printerFlagSerialFlips(w.db, 'ct_new', true), 0);
  let res = await v2('adm', 'ct_new', { is_printer_catalog: true });
  assert.equal(res.status, 200, await res.clone().text());
  res = await v2('adm', 'ct_new', { is_printer_catalog: false });
  assert.equal(res.status, 200, await res.clone().text());
  res = await tax('adm', { id: 'ct_new', name_en: 'New', is_printer_catalog: true });
  assert.equal(res.status, 200, await res.clone().text());
  res = await tax('ast', { id: 'ct_new', name_en: 'New', is_printer_catalog: false });
  assert.equal(res.status, 200, await res.clone().text());

  // A catalog whose only product carries its OWN word: it keeps its answer.
  w.raw.exec(`
    INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en) VALUES ('ct_word', NULL, 'sp-word', 'كلمة', 'Word');
    INSERT INTO products (id,slug,name,name_ar,price_iqd,ops_policy) VALUES ('pW','sp-w','Worded','كلمة',1000,'{"serialized":false}');
    INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES ('pW','ct_word',1);
  `);
  res = await v2('adm', 'ct_word', { is_printer_catalog: true });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(await effective(w, 'pW'), false, 'its own word still decides');

  // A catalog holding a SILENT product: the filament would start needing a
  // serial — refused to a full admin and an assistant, on both editors.
  for (const who of ['adm', 'ast'] as const) {
    res = await v2(who, 'ct_fil', { is_printer_catalog: true });
    assert.equal(res.status, 403, `${who}: ${await res.clone().text()}`);
    const body = await json(res);
    assert.equal(body.code, 'OWNER_ONLY');
    assert.equal(body.details?.via, 'printer_flag');
    assert.equal(body.details?.products, 1);
    res = await tax(who, { id: 'ct_fil', name_en: 'Filament', is_printer_catalog: true });
    assert.equal(res.status, 403, who);
  }
  assert.equal(row<{ f: number }>(w.raw, "SELECT is_printer_catalog AS f FROM catalogs WHERE id = 'ct_fil'")!.f, 0, 'not flipped');
  assert.equal(await effective(w, 'pPLA'), false);
  // …and the other way: switching the printers off would stop two printers needing one.
  assert.equal(await printerFlagSerialFlips(w.db, 'ct_print', false), 2);
  res = await v2('adm', 'ct_print', { is_printer_catalog: false });
  assert.equal((await json(res)).details?.products, 2);
  // A printer that is a printer through ANOTHER catalog too is not flipped by this one.
  w.raw.exec(`
    INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, is_printer_catalog) VALUES ('ct_print2', NULL, 'sp-print2', 'طابعات ٢', 'Printers 2', 1);
    INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES ('pA1','ct_print2',1);
  `);
  res = await v2('adm', 'ct_print2', { is_printer_catalog: false });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(await effective(w, 'pA1'), true);

  // The owner may flip anything.
  res = await v2('boss', 'ct_fil', { is_printer_catalog: true });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(await effective(w, 'pPLA'), true);

  // CREATING a catalog with the printer flag: it holds no product — anyone's.
  for (const who of ['adm', 'ast'] as const) {
    res = await post(w.as(who), '/api/admin/products-v2/catalogs', { name_ar: `طابعات ليزر ${who}`, name_en: `Laser printers ${who}`, is_printer_catalog: true });
    assert.equal(res.status, 200, `${who}: ${await res.clone().text()}`);
    res = await tax(who, { name_en: `Resin printers ${who}`, name_ar: 'طابعات رزن', is_printer_catalog: true, active: true });
    assert.equal(res.status, 200, `${who}: ${await res.clone().text()}`);
  }
  assert.equal(
    count(
      w.raw,
      "SELECT COUNT(*) AS n FROM catalogs WHERE is_printer_catalog = 1 AND name_en IN ('Laser printers adm','Laser printers ast','Resin printers adm','Resin printers ast')"
    ),
    4
  );
});

// ================================================================ F2 / F4

const HEAD = ['row_type', 'key', 'name', 'status', 'category', 'sub_category', 'price_iqd', 'serialized'];
const sheet = (...rows: Array<Record<string, string>>) =>
  toCsv([HEAD, ...rows.map((r) => HEAD.map((h) => ({ row_type: 'product', status: 'draft', price_iqd: '100000', ...r })[h] ?? ''))]);
const importApp = (w: World, who: keyof typeof USERS): App => stubApp(w.db, USERS[who], (a) => a.route('/api/admin/import', adminImportRoutes));

async function preview(app: App, csv: string) {
  const form = new FormData();
  form.set('file', new File([csv], 'data.csv', { type: 'text/csv' }));
  form.set('category', 'ct_acc');
  const res = await app.request('/api/admin/import/preview', { method: 'POST', body: form, headers: { 'CF-Connecting-IP': '1.2.3.4' } }, undefined, ctx);
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body));
  return body as { import_id: string; rows: Array<{ key: string; action: string; errors: string[] }> };
}

async function confirm(app: App, importId: string) {
  const res = await app.request(
    '/api/admin/import/confirm',
    { method: 'POST', body: JSON.stringify({ import_id: importId }), headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' } },
    undefined,
    ctx
  );
  return json(res);
}

const serialErrors = (r: { errors: string[] }) => r.errors.filter((e) => e.includes(IMPORT_SERIALIZED_OWNER_ONLY) || e.includes(IMPORT_SERIAL_REFILE_OWNER_ONLY));

/** pA1 filed under a PLAIN section (ct_dev), its printer catalog held as an extra placement. */
function extraPlacementWorld() {
  const w = world();
  w.raw.exec(`
    UPDATE catalogs SET template_family = 'devices' WHERE id IN ('ct_acc','ct_print');
    INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, template_family) VALUES ('ct_dev', NULL, 'sp-dev', 'أجهزة', 'Devices', 'devices');
    UPDATE products SET category_id = 'ct_dev' WHERE id = 'pA1';
    INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES ('pA1','ct_dev',1);
  `);
  return w;
}

test('F2: the written placements are the stored extras plus the sheet\'s section pair (pure rule)', () => {
  assert.deepEqual(importPlacements(null, 'ct_a', 'ct_b'), ['ct_a', 'ct_b'], 'a new product gets exactly the sheet\'s pair');
  const stored = { placements: ['ct_print', 'ct_dev', 'ct_promo'], category_id: 'ct_dev', sub_category_id: null };
  assert.deepEqual(importPlacements(stored, 'ct_dev', null), ['ct_print', 'ct_promo', 'ct_dev'], 'same section: nothing lost');
  assert.deepEqual(importPlacements(stored, 'ct_acc', 'ct_fil'), ['ct_print', 'ct_promo', 'ct_acc', 'ct_fil'], 'a move drops only the old section');
});

test('F2: a full admin\'s price-only row for a printer held by an EXTRA placement passes, and the confirm keeps that placement', async () => {
  const w = extraPlacementWorld();
  assert.equal(await effective(w, 'pA1'), true);
  const app = importApp(w, 'adm');
  const pv = await preview(app, sheet({ key: 'sp-a1', name: 'Bambu Lab A1 Combo', category: 'sp-dev', price_iqd: '910000' }));
  assert.deepEqual(serialErrors(pv.rows[0]), [], JSON.stringify(pv.rows[0]));
  assert.equal(pv.rows[0].action, 'update', JSON.stringify(pv.rows[0]));
  const done = await confirm(app, pv.import_id);
  assert.equal(done.success, true, JSON.stringify(done));
  assert.equal(done.summary.updated, 1, JSON.stringify(done));
  assert.deepEqual(shelves(w, 'pA1'), ['ct_dev', 'ct_print'], 'the printer catalog survives the import');
  assert.equal(row<{ p: number }>(w.raw, "SELECT price_iqd AS p FROM products WHERE id = 'pA1'")!.p, 910000);
  assert.equal(await effective(w, 'pA1'), true, 'still a printer, still needs a serial');
});

test('F2: the owner\'s confirm keeps the extra placement too, and a row that MOVES the product drops only its old section', async () => {
  const w = extraPlacementWorld();
  const owner = importApp(w, 'boss');
  let pv = await preview(owner, sheet({ key: 'sp-a1', name: 'Bambu Lab A1 Combo', category: 'sp-dev', price_iqd: '920000' }));
  let done = await confirm(owner, pv.import_id);
  assert.equal(done.success, true, JSON.stringify(done));
  assert.deepEqual(shelves(w, 'pA1'), ['ct_dev', 'ct_print']);
  // A full admin moves it to another section: the printer catalog stays, ct_dev goes.
  const adm = importApp(w, 'adm');
  pv = await preview(adm, sheet({ key: 'sp-a1', name: 'Bambu Lab A1 Combo', category: 'sp-acc', price_iqd: '920000' }));
  assert.deepEqual(serialErrors(pv.rows[0]), [], 'still a printer through its extra placement — nothing flips');
  done = await confirm(adm, pv.import_id);
  assert.equal(done.success, true, JSON.stringify(done));
  assert.deepEqual(shelves(w, 'pA1'), ['ct_acc', 'ct_print']);
  assert.equal(row<{ c: string }>(w.raw, "SELECT category_id AS c FROM products WHERE id = 'pA1'")!.c, 'ct_acc');
  assert.equal(await effective(w, 'pA1'), true);
});

test('F4: a full admin\'s confirm of an older preview does not undo the owner\'s later serial word', async () => {
  const w = world();
  w.raw.exec(`UPDATE catalogs SET template_family = 'devices' WHERE id IN ('ct_acc','ct_print')`);
  assert.equal(await effective(w, 'pAMS'), false);
  const app = importApp(w, 'adm');
  // The serialized cell is EMPTY: keep what is stored.
  const pv = await preview(app, sheet({ key: 'sp-ams-lite', name: 'Bambu Lab AMS Lite', category: 'sp-acc', sub_category: 'sp-ams', serialized: '', price_iqd: '410000' }));
  assert.equal(pv.rows[0].errors.length, 0, JSON.stringify(pv.rows[0]));
  // The owner now says this product needs a serial (and sets another key).
  const own = await post(w.as('boss'), '/api/devices/admin/products/pAMS/ops-policy', { serialized: true, warranty_base_months: 6 });
  assert.equal(own.status, 200, await own.clone().text());
  assert.equal(opsOf(w, 'pAMS').serialized, true);
  // The full admin confirms the old preview.
  const done = await confirm(app, pv.import_id);
  assert.equal(done.success, true, JSON.stringify(done));
  assert.equal(done.summary.updated, 1, JSON.stringify(done));
  assert.equal(opsOf(w, 'pAMS').serialized, true, 'the owner\'s word survives');
  assert.equal(opsOf(w, 'pAMS').warranty_base_months, 6, 'and so does every key the sheet did not set');
  assert.equal(await effective(w, 'pAMS'), true);
  assert.equal(row<{ p: number }>(w.raw, "SELECT price_iqd AS p FROM products WHERE id = 'pAMS'")!.p, 410000, 'the row\'s own cells are written');
});

test('F4: a row the LIVE row now refuses fails at confirm, alone — the other rows are written', async () => {
  const w = world();
  w.raw.exec(`
    UPDATE catalogs SET template_family = 'devices' WHERE id IN ('ct_acc','ct_print');
    UPDATE catalogs SET serial_policy = 'required' WHERE id = 'ct_ams';
  `);
  const app = importApp(w, 'adm');
  // At preview the AMS cell 'yes' only echoes its section's answer — it passes.
  const pv = await preview(
    app,
    sheet(
      { key: 'sp-ams-lite', name: 'Bambu Lab AMS Lite', category: 'sp-acc', sub_category: 'sp-ams', serialized: 'yes', price_iqd: '420000' },
      { key: 'sp-pla', name: 'PLA spool', category: 'sp-acc', sub_category: 'sp-fil', price_iqd: '27000' }
    )
  );
  for (const r of pv.rows) assert.deepEqual(serialErrors(r), [], JSON.stringify(r));
  // The owner then says this AMS needs NO serial: the sheet's 'yes' is now a change.
  assert.equal((await post(w.as('boss'), '/api/devices/admin/products/pAMS/ops-policy', { serialized: false })).status, 200);
  const done = await confirm(app, pv.import_id);
  assert.equal(done.success, true, JSON.stringify(done));
  const ams = (done.rows as Array<{ key: string; action: string; reason: string }>).find((r) => r.key === 'sp-ams-lite')!;
  const pla = (done.rows as Array<{ key: string; action: string; reason: string }>).find((r) => r.key === 'sp-pla')!;
  assert.equal(ams.action, 'failed', JSON.stringify(ams));
  assert.ok(ams.reason.includes(IMPORT_SERIALIZED_OWNER_ONLY), ams.reason);
  assert.ok(/^سطر \d+: /.test(ams.reason), 'the same shape as a preview refusal');
  assert.equal(pla.action, 'updated', JSON.stringify(pla));
  assert.equal(opsOf(w, 'pAMS').serialized, false, 'the owner\'s word stands');
  assert.equal(row<{ p: number }>(w.raw, "SELECT price_iqd AS p FROM products WHERE id = 'pAMS'")!.p, 399000, 'nothing of the refused row was written');
  assert.equal(row<{ p: number }>(w.raw, "SELECT price_iqd AS p FROM products WHERE id = 'pPLA'")!.p, 27000);
  // The owner's own confirm of the same kind of row is never refused.
  const owner = importApp(w, 'boss');
  const opv = await preview(owner, sheet({ key: 'sp-ams-lite', name: 'Bambu Lab AMS Lite', category: 'sp-acc', sub_category: 'sp-ams', serialized: 'yes' }));
  assert.equal((await confirm(owner, opv.import_id)).summary.updated, 1);
  assert.equal(opsOf(w, 'pAMS').serialized, true);
});

// ====================================================================== F3

test('F3: the OWNER_ONLY refusal renders by code in ar / en / ckb on the admin screens; other messages are untouched', () => {
  const refusal = { code: 'OWNER_ONLY', message: serverMessage('OWNER_ONLY') };
  assert.equal(contractRefusal(refusal, 'ckb'), COST_REFUSALS.OWNER_ONLY.ckb);
  assert.equal(contractRefusal(refusal, 'en'), COST_REFUSALS.OWNER_ONLY.en);
  assert.equal(contractRefusal(refusal, 'ar'), COST_REFUSALS.OWNER_ONLY.ar);
  assert.notEqual(COST_REFUSALS.OWNER_ONLY.ckb, COST_REFUSALS.OWNER_ONLY.ar, 'real Sorani, not the Arabic');
  assert.equal(contractRefusal({ code: 'VALIDATION', message: 'name_en: required' }, 'ckb'), 'name_en: required', 'any other code keeps the server sentence');
  assert.equal(contractRefusal({ code: 'VALIDATION', message: 'x' }, 'ckb', 'shown before'), 'shown before');
  assert.equal(contractRefusal(new Error('boom'), 'ckb'), 'boom');
  assert.equal(refusalLang('ckb'), 'ckb');
  assert.equal(refusalLang('fr'), 'ar');
  // The new 503 of F6 has its three sentences too.
  const s = REFUSAL_STRINGS.SERIAL_STORY_UNAVAILABLE;
  assert.ok(s && /[؀-ۿ]/.test(s.ar) && /[a-z]/i.test(s.en) && /[ەێۆڕڵ]/.test(s.ckb) && s.ckb !== s.ar);
  assert.equal(refusalText('SERIAL_STORY_UNAVAILABLE', 'ckb'), s.ckb);
  // The four screens read the code, not the raw sentence.
  const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  assert.match(src('src/components/adminTaxonomy/shared.tsx'), /setErr\(errMsg\(e, lang\)\)/);
  assert.match(src('src/components/adminProducts/ProductForm.tsx'), /contractRefusal\(e, refusalLang\(lang\), failureText\(e/);
  assert.match(src('src/components/adminProducts/form/SectionUpdateSheet.tsx'), /said\(preview\.validation_error, preview\.validation_error\.message\)/);
  const panel = src('src/components/adminProducts/ImportPanel.tsx');
  assert.equal((panel.match(/validationText\((res|f)\.validation_error, lang\)/g) ?? []).length, 2);
});

// ====================================================================== F5

test('F5: the unit history masks serials and order numbers for an assistant, as the serial page does', async () => {
  const w = world();
  order(w.raw, 'ORD-SECRET', [{ id: 'oi1', product: 'pA1' }], { status: 'delivered', stage: 'delivered' });
  w.raw.exec(`
    INSERT INTO order_item_units (id, order_id, order_item_id, product_id, owner_user_id, unit_index) VALUES ('un1','ORD-SECRET','oi1','pA1','u1',1);
    INSERT INTO audit_log (actor_id, action, target, detail) VALUES
      ('boss','device.serial_reassign','un1','{"serial_norm":"${SN}","detached_serial":"${SN2}","order_id":"ORD-SECRET","reason":"swap"}');
  `);
  const ast = await json(await get(w.as('ast'), '/api/devices/admin/units/un1/history'));
  assert.equal(ast.success, true, JSON.stringify(ast));
  const text = JSON.stringify(ast);
  for (const whole of [SN, SN2, 'ORD-SECRET']) assert.equal(text.includes(whole), false, `${whole} reached an assistant: ${text}`);
  assert.equal(ast.history[0].detail.detached_serial, maskSerial(SN2));
  assert.equal(ast.history[0].detail.reason, 'swap', 'the rest of the row is untouched');
  for (const who of ['adm', 'boss'] as const) {
    const full = await json(await get(w.as(who), '/api/devices/admin/units/un1/history'));
    assert.deepEqual(full.history[0].detail, { serial_norm: SN, detached_serial: SN2, order_id: 'ORD-SECRET', reason: 'swap' }, who);
  }
});

test('F5: the warranty receipt\'s history masks the replaced and corrected serials for an assistant', async () => {
  const w = world();
  order(w.raw, 'ORD-W', [{ id: 'oiw', product: 'pA1' }], { status: 'delivered', stage: 'delivered' });
  w.raw.exec(`
    INSERT INTO order_item_units (id, order_id, order_item_id, product_id, owner_user_id, unit_index) VALUES ('unw','ORD-W','oiw','pA1','u1',1);
    INSERT INTO warranty_receipts (id, receipt_no, unit_id, order_id, order_item_id, product_id, user_id, serial_norm, serial_raw, status)
      VALUES ('wr1','LV-W-000001','unw','ORD-W','oiw','pA1','u1','${SN}','${SN}','active');
    INSERT INTO audit_log (actor_id, action, target, detail) VALUES
      ('boss','warranty.replaced','wr1','{"replaced_serial":"${SN}","new_serial":"${SN2}","order_id":"ORD-W","replaced_receipt_no":"LV-W-000001"}'),
      ('boss','warranty.reissued','wr1','{"corrected_serial":{"from":"${SN2}","to":"${SN}"},"reason":"typo"}');
  `);
  const ast = await json(await get(w.as('ast'), '/api/admin/warranties/wr1'));
  assert.equal(ast.success, true, JSON.stringify(ast));
  const history = JSON.stringify(ast.history);
  for (const whole of [SN, SN2, 'ORD-W']) assert.equal(history.includes(whole), false, `${whole} reached an assistant: ${history}`);
  const replaced = (ast.history as Array<{ action: string; detail: Record<string, unknown> }>).find((h) => h.action === 'warranty.replaced')!;
  assert.equal(replaced.detail.replaced_serial, maskSerial(SN));
  assert.equal(replaced.detail.replaced_receipt_no, 'LV-W-000001', 'a receipt number is not a serial');
  for (const who of ['adm', 'boss'] as const) {
    const full = JSON.stringify((await json(await get(w.as(who), '/api/admin/warranties/wr1'))).history);
    assert.ok(full.includes(SN2) && full.includes('ORD-W'), `${who} reads them whole`);
  }
});

// ====================================================================== F6

test('F6: when the serial story fails on a migrated database the page answers 503 — never the whole serial', async () => {
  const w = world();
  w.raw.exec(`
    INSERT INTO serial_inventory (serial_norm, serial_raw, model_name, product_id, box_sn, created_by) VALUES ('${SN}','${SN}','A1 Combo','pA1','${BOX}','boss');
    INSERT INTO audit_log (actor_id, action, target, detail) VALUES ('boss','serial_inventory.update','${SN}','{"from":{"box_sn":"${BOX}","order_id":"ORD-SECRET"}}');
  `);
  const ok = JSON.stringify(await json(await get(w.as('ast'), `/api/devices/admin/serial-inventory/${SN}`)));
  assert.equal(ok.includes(SN), false);
  // A transient failure inside the story only (its warranty_receipts read).
  w.raw.exec(`ALTER TABLE warranty_receipts RENAME TO warranty_receipts_x`);
  for (const who of ['ast', 'adm'] as const) {
    const page = await get(w.as(who), `/api/devices/admin/serial-inventory/${SN}`);
    const text = await page.text();
    assert.equal(page.status, 503, `${who}: ${text}`);
    assert.equal(JSON.parse(text).code, 'SERIAL_STORY_UNAVAILABLE');
    for (const whole of [SN, BOX, 'ORD-SECRET']) assert.equal(text.includes(whole), false, `${who}: ${whole} leaked`);
  }
  w.raw.exec(`ALTER TABLE warranty_receipts_x RENAME TO warranty_receipts`);
  const back = await json(await get(w.as('ast'), `/api/devices/admin/serial-inventory/${SN}`));
  assert.equal(back.success, true);
  assert.equal(back.row.serial, maskSerial(SN), 'masked again once the story reads');
});

// ====================================================================== F7

const KIT = {
  name_en: 'Printer kit',
  name_ar: 'حزمة طابعة',
  price_iqd: 850000,
  status: 'draft',
  components: [{ member_product_id: 'prd_printer', qty: 1, sort: 0 }, { member_product_id: 'prd_spool', qty: 2, sort: 1 }],
  config: { price_mode: 'fixed', max_qty_per_order: 5, min_price_iqd: 1 },
};

function compositionWorld() {
  const w = world();
  w.raw.exec(`
    INSERT INTO products (id, slug, status, name, name_ar, price_iqd, stock, stock_reserved, inventory_mode, sale_types, selling_type, preorder_transports, images, ops_policy)
      VALUES ('prd_printer','kit-printer','active','Printer','طابعة',900000,5,0,'BASE','["direct_sale"]','direct_sale','[]','[]','{}'),
             ('prd_spool','kit-spool','active','Spool','خيط',20000,6,0,'BASE','["direct_sale"]','direct_sale','[]','[]','{}');
    INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES ('prd_printer','ct_print',3);
  `);
  const app = (who: keyof typeof USERS) =>
    stubApp(w.db, USERS[who], (a) => {
      a.route('/api/admin/bundles', adminBundlesRoutes);
      a.route('/api/admin/mystery', adminMysteryRoutes);
    });
  const put = (a: App, path: string, body: unknown) =>
    a.request(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { ...w, app, put };
}

test('F7: the bundle editor judges a non-owner\'s serial word and filing like every other door', async () => {
  const w = compositionWorld();
  for (const who of ['adm', 'ast'] as const) {
    // A bundle switched on at birth.
    const on = await post(w.app(who), '/api/admin/bundles', { ...KIT, name_en: `Kit ${who}`, serialized: true });
    assert.equal(on.status, 403, `${who}: ${await on.clone().text()}`);
    assert.equal((await json(on)).code, 'OWNER_ONLY');
    const viaOps = await post(w.app(who), '/api/admin/bundles', { ...KIT, name_en: `Kit ${who} 2`, ops_policy: { serialized: true } });
    assert.equal(viaOps.status, 403, who);
  }
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM products WHERE composition = 'bundle'"), 0, 'nothing was created');
  // An ordinary bundle by a full admin: fine.
  const made = await json(await post(w.app('adm'), '/api/admin/bundles', KIT));
  assert.equal(made.success, true, JSON.stringify(made));
  const id = String(made.product.id);
  // Re-filing it under the printers would make it need a serial: refused.
  const refile = await w.put(w.app('adm'), `/api/admin/bundles/${id}`, { ...KIT, catalog_ids: ['ct_print'] });
  assert.equal(refile.status, 403, await refile.clone().text());
  assert.equal((await json(refile)).details?.via, 'placement');
  assert.deepEqual(shelves(w, id), []);
  // The owner sets the bundle's word; a full admin's ordinary save (the panel
  // never sends `serialized`) keeps it instead of wiping it.
  w.raw.prepare(`UPDATE products SET ops_policy = '{"serialized":false,"size_class":"large"}' WHERE id = ?`).run(id);
  const save = await w.put(w.app('adm'), `/api/admin/bundles/${id}`, { ...KIT, name_en: 'Printer kit+' });
  assert.equal(save.status, 200, await save.clone().text());
  assert.equal(opsOf(w, id).serialized, false, 'the owner\'s word is kept');
  // The owner may do all of it.
  const owner = await w.put(w.app('boss'), `/api/admin/bundles/${id}`, { ...KIT, catalog_ids: ['ct_print'], serialized: true });
  assert.equal(owner.status, 200, await owner.clone().text());
  assert.equal(await effective(w, id), true);
});

test('F7: the mystery-offer editor judges a non-owner\'s serial word too', async () => {
  const w = compositionWorld();
  const offer = { name_en: 'Mystery Filament', name_ar: 'فتيل عشوائي', price_iqd: 30_000, status: 'draft', spool_qty: 1, max_qty_per_order: 3 };
  for (const who of ['adm', 'ast'] as const) {
    const on = await post(w.app(who), '/api/admin/mystery/offers', { ...offer, serialized: true });
    assert.equal(on.status, 403, `${who}: ${await on.clone().text()}`);
    assert.equal((await json(on)).code, 'OWNER_ONLY');
    const filed = await post(w.app(who), '/api/admin/mystery/offers', { ...offer, category_id: 'ct_print', serialized: false });
    assert.equal(filed.status, 403, `${who}: a printer switched off at birth`);
  }
  const plain = await post(w.app('adm'), '/api/admin/mystery/offers', offer);
  assert.equal(plain.status, 200, await plain.clone().text());
  const owner = await post(w.app('boss'), '/api/admin/mystery/offers', { ...offer, name_en: 'Owner mystery', serialized: true });
  assert.equal(owner.status, 200, await owner.clone().text());
});

test('F7: a bundle PARENT never gets warranty units of its own — its components carry the devices', async () => {
  const raw = seedCatalogue();
  raw.exec(`
    INSERT OR IGNORE INTO catalogs (id,slug,name_ar,name_en,is_printer_catalog) VALUES ('cat_pr','printers-test','طابعات','Printers',1);
    INSERT INTO product_catalogs (product_id,catalog_id,position) SELECT 'p_printer', id, 0 FROM catalogs WHERE is_printer_catalog = 1 LIMIT 1;
  `);
  addBundle(raw, { id: 'prd_b1', slug: 'starter', priceIqd: 400_000 });
  // The parent row itself says «serialized» (filed under the printers, word true).
  raw.exec(`UPDATE products SET ops_policy = '{"serialized":true}' WHERE id = 'prd_b1'`);
  raw.exec(`INSERT INTO product_catalogs (product_id,catalog_id,position) VALUES ('prd_b1','cat_pr',9)`);
  const db = asD1(raw);
  const shop = stubApp(db, { id: 'buyer', role: 'customer', email: 's@x.co' }, (a) => {
    a.route('/api/cart', cartRoutes);
    a.route('/api/orders', orderRoutes);
  });
  assert.equal((await json(await post(shop, '/api/cart/items', { productId: 'prd_b1', qty: 1 }))).success, true);
  const res = await json(await post(shop, '/api/orders', orderBody()));
  assert.equal(res.success, true, JSON.stringify(res));
  const orderId = String(res.order.id);
  const created = await createUnitsOnDelivery({ DB: db } as never, orderId, new Date().toISOString());
  assert.equal(created.created, 1, 'one unit: the printer component, not the parent');
  const units = all<{ product_id: string }>(raw, 'SELECT product_id FROM order_item_units WHERE order_id = ?', orderId);
  assert.deepEqual(units.map((u) => u.product_id), ['p_printer']);

  // The SQL twin agrees: an order whose ONLY serialized line is a parent is
  // never a candidate (it would be picked, and yield nothing, every run).
  raw.exec(`DELETE FROM order_item_units WHERE order_id = '${orderId}'`);
  raw.exec(`DELETE FROM product_catalogs WHERE product_id = 'p_printer'`);
  raw.prepare("UPDATE orders SET status = 'delivered', delivered_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(orderId);
  const sweep = await sweepDeliveredOrdersWithoutUnits({ DB: db } as never);
  assert.equal(sweep.scanned, 0, JSON.stringify(sweep));
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM order_item_units'), 0);
});
