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
 * ROUND 4 (the review of round 3), at the end of the file:
 *
 *   R1  a printer flag and a re-parent in one request are judged as ONE edit
 *   R2  a non-owner's write re-checks inside its batch that it flipped
 *       nothing (`serialAnswerFence`): a placement and a printer flag judged
 *       on stale reads cannot together flip a product, in either order; the
 *       owner's writes carry no fence
 *   R3  the import confirm's write is conditioned on the ops_policy it
 *       re-read: a word written in between fails that row alone
 *   R4  a sheet that names no section keeps the live filing
 *
 * Run: npx tsx --test tests/serialLandingReview2.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { asD1, json, post, patch, put, get, row, all, count, stubApp, ctx, type App } from './fixtures/app';
import { world, order, afterReadsOf, mountSerialWorld, USERS, SN, SN2, BOX } from './fixtures/serialPrep';
import { adminImportRoutes } from '../worker/routes/adminImport';
import { adminBundlesRoutes } from '../worker/routes/adminBundles';
import { adminMysteryRoutes } from '../worker/routes/mystery';
import { toCsv } from '../worker/lib/importCsv';
import { IMPORT_ROW_CHANGED_RETRY, IMPORT_SERIALIZED_OWNER_ONLY, IMPORT_SERIAL_REFILE_OWNER_ONLY, importPlacements } from '../worker/lib/importApply';
import { catalogEditSerialFlips, lineDevicePolicy, printerFlagSerialFlips, reparentSerialFlips, serializationContext } from '../worker/lib/serialPolicy';
import { createUnitsOnDelivery, sweepDeliveredOrdersWithoutUnits } from '../worker/lib/deviceOps';
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

test('F5: the unit history hides order numbers from an assistant, as the serial page does — and shows the serials whole (owner decision 1)', async () => {
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
  assert.equal(text.includes('ORD-SECRET'), false, `the order number reached an assistant: ${text}`);
  assert.deepEqual(ast.history[0].detail, { serial_norm: SN, detached_serial: SN2, order_id: null, reason: 'swap' }, 'whole serials, no order number, the rest untouched');
  for (const who of ['adm', 'boss'] as const) {
    const full = await json(await get(w.as(who), '/api/devices/admin/units/un1/history'));
    assert.deepEqual(full.history[0].detail, { serial_norm: SN, detached_serial: SN2, order_id: 'ORD-SECRET', reason: 'swap' }, who);
  }
});

test('F5: the warranty receipt\'s history shows an assistant the replaced and corrected serials whole (owner decision 1), without the order number', async () => {
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
  assert.equal(history.includes('ORD-W'), false, `the order number reached an assistant: ${history}`);
  const replaced = (ast.history as Array<{ action: string; detail: Record<string, unknown> }>).find((h) => h.action === 'warranty.replaced')!;
  assert.equal(replaced.detail.replaced_serial, SN);
  assert.equal(replaced.detail.new_serial, SN2);
  assert.equal(replaced.detail.order_id, null);
  assert.equal(replaced.detail.replaced_receipt_no, 'LV-W-000001', 'a receipt number is not an order number');
  const reissued = (ast.history as Array<{ action: string; detail: Record<string, unknown> }>).find((h) => h.action === 'warranty.reissued')!;
  assert.deepEqual(reissued.detail.corrected_serial, { from: SN2, to: SN });
  for (const who of ['adm', 'boss'] as const) {
    const full = JSON.stringify((await json(await get(w.as(who), '/api/admin/warranties/wr1'))).history);
    assert.ok(full.includes(SN2) && full.includes('ORD-W'), `${who} reads them whole`);
  }
});

// ====================================================================== F6

test('F6: when the serial story fails on a migrated database the page answers 503 — never an unfiltered page', async () => {
  const w = world();
  w.raw.exec(`
    INSERT INTO serial_inventory (serial_norm, serial_raw, model_name, product_id, box_sn, created_by) VALUES ('${SN}','${SN}','A1 Combo','pA1','${BOX}','boss');
    INSERT INTO audit_log (actor_id, action, target, detail) VALUES ('boss','serial_inventory.update','${SN}','{"from":{"box_sn":"${BOX}","order_id":"ORD-SECRET"}}');
  `);
  const ok = JSON.stringify(await json(await get(w.as('ast'), `/api/devices/admin/serial-inventory/${SN}`)));
  assert.ok(ok.includes(SN), 'owner decision 1: the assistant reads the serial whole');
  assert.equal(ok.includes('ORD-SECRET'), false, 'but never the order number');
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
  assert.equal(back.row.serial, SN, 'whole again once the story reads');
  assert.equal(JSON.stringify(back).includes('ORD-SECRET'), false, 'and still no order number');
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

// ====================================================================== ROUND 4

const flagOf = (w: World, id: string) => row<{ f: number }>(w.raw, 'SELECT is_printer_catalog AS f FROM catalogs WHERE id = ?', id)!.f;
const parentOf = (w: World, id: string) => row<{ p: string | null }>(w.raw, 'SELECT parent_id AS p FROM catalogs WHERE id = ?', id)!.p;

/** A printer catalog (ct_p2) filed under a 'required' branch (ct_devs); one silent printer in it (pP). */
function nestedPrinterWorld() {
  const w = world();
  w.raw.exec(`
    INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, serial_policy) VALUES ('ct_devs', NULL, 'sp-devs', 'أجهزة', 'Devices', 'required');
    INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, is_printer_catalog) VALUES ('ct_p2', 'ct_devs', 'sp-p2', 'طابعات ٢', 'Printers 2', 1);
    INSERT INTO products (id,slug,name,name_ar,price_iqd,ops_policy,category_id,sub_category_id) VALUES ('pP','sp-pp','Printer P','طابعة',1000,'{}','ct_p2',NULL);
    INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES ('pP','ct_p2',1);
  `);
  return w;
}

const catalogDoor = (door: 'v2' | 'tax', app: App, id: string, body: Record<string, unknown>) =>
  door === 'v2' ? patch(app, `/api/admin/products-v2/catalogs/${id}`, body) : post(app, '/api/admin/taxonomy/catalogs', { id, ...body });

// ====================================================================== R1

test('R1: a printer flag and a re-parent in ONE request are judged as one edit — refused when together they flip a product, on both editors', async () => {
  for (const door of ['v2', 'tax'] as const) {
    for (const who of ['adm', 'ast'] as const) {
      const w = nestedPrinterWorld();
      assert.equal(await effective(w, 'pP'), true, 'a printer');
      // Each half alone flips nothing: off, it still inherits 'required';
      // moved out, it is still a printer.
      assert.equal(await printerFlagSerialFlips(w.db, 'ct_p2', false), 0);
      assert.equal(await reparentSerialFlips(w.db, 'ct_p2', null), 0);
      assert.equal(await catalogEditSerialFlips(w.db, 'ct_p2', { flag: false, parentId: null }), 1, 'together they flip pP');
      const res = await catalogDoor(door, w.as(who), 'ct_p2', { name_en: 'Printers 2', is_printer_catalog: false, parent_id: null });
      assert.equal(res.status, 403, `${door}/${who}: ${await res.clone().text()}`);
      const body = await json(res);
      assert.equal(body.code, 'OWNER_ONLY');
      assert.equal(body.details?.via, 'printer_flag_and_reparent');
      assert.deepEqual(body.details?.fields, ['is_printer_catalog', 'parent_id']);
      assert.equal(body.details?.products, 1);
      assert.equal(flagOf(w, 'ct_p2'), 1, 'nothing written');
      assert.equal(parentOf(w, 'ct_p2'), 'ct_devs');
      assert.equal(await effective(w, 'pP'), true);
    }
  }
});

test('R1: the same two changes one at a time — the second is refused, exactly as in round 3', async () => {
  for (const door of ['v2', 'tax'] as const) {
    const w = nestedPrinterWorld();
    const off = await catalogDoor(door, w.as('adm'), 'ct_p2', { name_en: 'Printers 2', is_printer_catalog: false });
    assert.equal(off.status, 200, `${door}: ${await off.clone().text()}`);
    assert.equal(await effective(w, 'pP'), true, 'still required through its branch');
    const move = await catalogDoor(door, w.as('adm'), 'ct_p2', { name_en: 'Printers 2', parent_id: null });
    assert.equal(move.status, 403, door);
    const body = await json(move);
    assert.equal(body.details?.via, 'reparent');
    assert.equal(body.details?.field, 'parent_id');
    assert.equal(parentOf(w, 'ct_p2'), 'ct_devs');
    assert.equal(await effective(w, 'pP'), true);
  }
});

test('R1: an edit judged as a whole passes when together nothing flips; the owner may do either', async () => {
  for (const door of ['v2', 'tax'] as const) {
    const w = world();
    // A printer catalog at the root, one silent printer in it, and a 'required' branch.
    w.raw.exec(`
      INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, serial_policy) VALUES ('ct_devs', NULL, 'sp-devs', 'أجهزة', 'Devices', 'required');
      INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, is_printer_catalog) VALUES ('ct_p3', NULL, 'sp-p3', 'طابعات ٣', 'Printers 3', 1);
      INSERT INTO products (id,slug,name,name_ar,price_iqd,ops_policy) VALUES ('pQ','sp-pq','Printer Q','طابعة',1000,'{}');
      INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES ('pQ','ct_p3',1);
    `);
    // The flag alone would stop pQ needing a serial; moved under 'required' at
    // the same time, it keeps needing one — one edit, nothing flips.
    assert.equal(await printerFlagSerialFlips(w.db, 'ct_p3', false), 1);
    assert.equal(await catalogEditSerialFlips(w.db, 'ct_p3', { flag: false, parentId: 'ct_devs' }), 0);
    const res = await catalogDoor(door, w.as('ast'), 'ct_p3', { name_en: 'Printers 3', is_printer_catalog: false, parent_id: 'ct_devs' });
    assert.equal(res.status, 200, `${door}: ${await res.clone().text()}`);
    assert.equal(flagOf(w, 'ct_p3'), 0);
    assert.equal(parentOf(w, 'ct_p3'), 'ct_devs');
    assert.equal(await effective(w, 'pQ'), true);
  }
  // The owner's combined edit that DOES flip is his to make.
  for (const door of ['v2', 'tax'] as const) {
    const w = nestedPrinterWorld();
    const res = await catalogDoor(door, w.as('boss'), 'ct_p2', { name_en: 'Printers 2', is_printer_catalog: false, parent_id: null });
    assert.equal(res.status, 200, `${door}: ${await res.clone().text()}`);
    assert.equal(await effective(w, 'pP'), false);
  }
});

// ====================================================================== R2

const withNewCatalog = () => {
  const w = world();
  w.raw.exec(`INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en) VALUES ('ct_new', NULL, 'sp-new', 'جديد', 'New')`);
  return w;
};
const placeIntoNew = (app: App) => put(app, '/api/admin/products-v2/pPLA/catalogs', { catalog_ids: ['ct_fil', 'ct_new'] });

test('R2: a placement judged before a printer flag landed is refused at its write — the placement reads first, the flag commits, the placement lands last', async () => {
  const w = withNewCatalog();
  assert.equal(await effective(w, 'pPLA'), false);
  const r = await afterReadsOf(w, 'adm', placeIntoNew, () => patch(w.as('ast'), '/api/admin/products-v2/catalogs/ct_new', { is_printer_catalog: true }));
  assert.equal(r.bReachedBatch, true);
  assert.equal(r.a.status, 200, 'the flag on an EMPTY catalog flips nothing — anyone\'s');
  assert.equal(r.b.status, 409, await r.b.clone().text());
  const body = await json(r.b);
  assert.equal(body.code, 'SERIAL_FILING_CHANGED');
  assert.equal(body.error, serverMessage('SERIAL_FILING_CHANGED'));
  assert.deepEqual(shelves(w, 'pPLA'), ['ct_fil'], 'the placement was not written');
  assert.equal(await effective(w, 'pPLA'), false, 'two non-owner requests did not flip it');
  // Read again, the same placement is now a §29 change: the owner's.
  const again = await placeIntoNew(w.as('adm'));
  assert.equal(again.status, 403, await again.clone().text());
});

test('R2: a printer flag judged before a placement landed is refused at its write — the flag reads first, the placement commits, the flag lands last (both catalog editors)', async () => {
  for (const door of ['v2', 'tax'] as const) {
    const w = withNewCatalog();
    const r = await afterReadsOf(
      w,
      'ast',
      (app) => catalogDoor(door, app, 'ct_new', { name_en: 'New', is_printer_catalog: true }),
      () => placeIntoNew(w.as('adm'))
    );
    assert.equal(r.bReachedBatch, true, door);
    assert.equal(r.a.status, 200, `${door}: a placement into a plain catalog flips nothing`);
    assert.equal(r.b.status, 409, `${door}: ${await r.b.clone().text()}`);
    assert.equal((await json(r.b)).code, 'SERIAL_FILING_CHANGED');
    assert.equal(flagOf(w, 'ct_new'), 0, `${door}: the flag was not written`);
    assert.deepEqual(shelves(w, 'pPLA'), ['ct_fil', 'ct_new']);
    assert.equal(await effective(w, 'pPLA'), false);
  }
});

test('R2: the product form, judged before a printer flag landed, is refused at its write too', async () => {
  const w = withNewCatalog();
  const r = await afterReadsOf(
    w,
    'adm',
    (app) =>
      post(app, '/api/admin/products-v2', {
        id: 'pPLA', name_en: 'PLA spool', name_ar: 'خيط PLA', price_iqd: 25000, status: 'draft', catalog_ids: ['ct_fil', 'ct_new'],
      }),
    () => patch(w.as('ast'), '/api/admin/products-v2/catalogs/ct_new', { is_printer_catalog: true })
  );
  assert.equal(r.bReachedBatch, true);
  assert.equal(r.a.status, 200);
  assert.equal(r.b.status, 409, await r.b.clone().text());
  assert.equal((await json(r.b)).code, 'SERIAL_FILING_CHANGED');
  assert.deepEqual(shelves(w, 'pPLA'), ['ct_fil']);
  assert.equal(await effective(w, 'pPLA'), false);
});

test('R2: the owner\'s writes carry no fence — his placement lands whatever changed meanwhile, and none of his catalog or product writes prepares one', async () => {
  // The race of the first R2 test with the owner placing: his write lands.
  const w = withNewCatalog();
  const r = await afterReadsOf(w, 'boss', placeIntoNew, () => patch(w.as('ast'), '/api/admin/products-v2/catalogs/ct_new', { is_printer_catalog: true }));
  assert.equal(r.bReachedBatch, true);
  assert.equal(r.b.status, 200, await r.b.clone().text());
  assert.deepEqual(shelves(w, 'pPLA'), ['ct_fil', 'ct_new']);
  assert.equal(await effective(w, 'pPLA'), true, 'the owner\'s call');

  // Every statement a request prepares, recorded.
  const recorded = (x: World) => {
    const seen: string[] = [];
    const db = {
      prepare: (sql: string) => {
        seen.push(sql);
        return x.db.prepare(sql);
      },
      batch: (stmts: D1PreparedStatement[]) => x.db.batch(stmts),
    } as unknown as D1Database;
    return { seen, app: (who: keyof typeof USERS) => stubApp(db, USERS[who], mountSerialWorld) };
  };
  const fenced = (seen: string[]) => seen.some((sql) => /INSERT INTO ops_guards/.test(sql));
  // Each one a real change that flips nothing, so a non-owner passes too.
  const writes = (app: App) => [
    () => post(app, '/api/admin/taxonomy/catalogs', { id: 'ct_new', name_en: 'New', is_printer_catalog: true }),
    () => patch(app, '/api/admin/products-v2/catalogs/ct_new', { is_printer_catalog: false }),
    () => patch(app, '/api/admin/products-v2/catalogs/ct_new', { parent_id: 'ct_acc' }),
    () => put(app, '/api/admin/products-v2/pAMS/catalogs', { catalog_ids: ['ct_ams', 'ct_new'] }),
    () =>
      post(app, '/api/admin/products-v2', {
        id: 'pAMS', name_en: 'Bambu Lab AMS Lite', name_ar: 'AMS لايت', price_iqd: 399000, status: 'draft', catalog_ids: ['ct_ams'],
      }),
  ];
  for (const who of ['boss', 'adm'] as const) {
    const x = withNewCatalog();
    const rec = recorded(x);
    for (const [i, write] of writes(rec.app(who)).entries()) {
      rec.seen.length = 0;
      const res = await write();
      assert.equal(res.status, 200, `${who} write ${i}: ${await res.clone().text()}`);
      assert.equal(fenced(rec.seen), who === 'adm', `${who} write ${i}: ${who === 'boss' ? 'the owner is never fenced' : 'a non-owner always is'}`);
    }
  }
});

test('R2 under owner decision 4: a non-owner\'s grade on an accessory with no word writes no `serialized` (no 409); on a printer it still writes `true`, and the fence lets it through', async () => {
  // docs/SERIAL_SCAN.md §29: until owner decision 4 (2026-10-09) a used /
  // open-box / refurbished grade turned tracking on for ANY product with no
  // word of its own. Now only a printer's grade does — and a printer already
  // answers «needs a serial», so the word it writes flips nothing and the
  // answer fence must not turn it into a 409.
  for (const who of ['adm', 'ast'] as const) {
    const w = world();
    assert.equal(await effective(w, 'pPLA'), false);
    const res = await post(w.as(who), '/api/admin/products-v2', {
      id: 'pPLA', name_en: 'PLA spool', name_ar: 'خيط PLA', price_iqd: 25000, status: 'draft',
      condition: { kind: 'used', grade: 'good', warranty_months: 1 },
    });
    assert.equal(res.status, 200, `${who}: ${await res.clone().text()}`);
    assert.equal('serialized' in opsOf(w, 'pPLA'), false, `${who}: no word written on the accessory`);
    assert.equal(await effective(w, 'pPLA'), false);
    const printer = await post(w.as(who), '/api/admin/products-v2', {
      id: 'pA1', name_en: 'Bambu Lab A1 Combo', name_ar: 'طابعة A1 كومبو', price_iqd: 899000, status: 'draft',
      condition: { kind: 'refurbished', grade: 'excellent', warranty_months: 12 },
    });
    assert.equal(printer.status, 200, `${who}: ${await printer.clone().text()}`);
    assert.equal(opsOf(w, 'pA1').serialized, true, `${who}: the used printer is tracked`);
    assert.equal(await effective(w, 'pA1'), true);
  }
});

test('R2: SERIAL_FILING_CHANGED has its three sentences in the contract, and the admin screens render it by code', () => {
  const s = COST_REFUSALS.SERIAL_FILING_CHANGED;
  assert.ok(/[؀-ۿ]/.test(s.ar) && /[a-z]/i.test(s.en) && /[ەێۆڕڵ]/.test(s.ckb));
  assert.notEqual(s.ckb, s.ar, 'real Sorani, not the Arabic');
  assert.doesNotMatch(s.ckb, /[ةىيك]/, 'no Arabic-only letter in the Sorani');
  assert.equal(REFUSAL_STRINGS.SERIAL_FILING_CHANGED, s);
  const refusal = { code: 'SERIAL_FILING_CHANGED', message: serverMessage('SERIAL_FILING_CHANGED') };
  for (const lang of ['ar', 'en', 'ckb'] as const) assert.equal(contractRefusal(refusal, lang), s[lang]);
  // The import row's sentence carries all three languages too.
  const [ar, en, ckb] = IMPORT_ROW_CHANGED_RETRY.split(' / ');
  assert.ok(/[؀-ۿ]/.test(ar) && /[a-z]/i.test(en) && /[ەێۆڕڵ]/.test(ckb) && ckb !== ar);
  assert.doesNotMatch(ckb, /[ةىيك]/);
});

// ====================================================================== R3

/** The confirm, held at its first product batch so another request can land between its re-read and its write. */
async function confirmHeldAtFirstRow(w: World, who: keyof typeof USERS, importId: string, between: () => Promise<unknown>) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let signal!: () => void;
  const at = new Promise<void>((r) => (signal = r));
  let held = false;
  const db = {
    prepare: (sql: string) => w.db.prepare(sql),
    batch: async (stmts: D1PreparedStatement[]) => {
      if (!held && stmts.length > 3) {
        held = true;
        signal();
        await gate;
      }
      return w.db.batch(stmts);
    },
  } as unknown as D1Database;
  const app = stubApp(db, USERS[who], (a) => a.route('/api/admin/import', adminImportRoutes));
  const pending = confirm(app, importId);
  await Promise.race([at, pending]);
  assert.equal(held, true, 'the confirm reached a product batch');
  await between();
  release();
  return pending;
}

test('R3: a word the owner writes between the confirm\'s re-read and its write fails THAT row with a retry sentence — his word stands, the rest of the sheet is written', async () => {
  for (const between of ['serialized', 'months'] as const) {
    const w = world();
    w.raw.exec(`
      UPDATE catalogs SET template_family = 'devices' WHERE id IN ('ct_acc','ct_print');
      UPDATE products SET category_id = 'ct_acc', sub_category_id = 'ct_ams' WHERE id = 'pAMS';
      UPDATE products SET category_id = 'ct_acc', sub_category_id = 'ct_fil' WHERE id = 'pPLA';
    `);
    const pv = await preview(
      importApp(w, 'adm'),
      sheet(
        { key: 'sp-ams-lite', name: 'Bambu Lab AMS Lite', category: 'sp-acc', sub_category: 'sp-ams', price_iqd: '410000' },
        { key: 'sp-pla', name: 'PLA spool', category: 'sp-acc', sub_category: 'sp-fil', price_iqd: '27000' }
      )
    );
    for (const r of pv.rows) assert.equal(r.errors.length, 0, JSON.stringify(r));
    // 'serialized' changes the answer (the answer fence would catch it too);
    // 'months' leaves it alone, so only the ops_policy condition stands in
    // the way of overwriting it.
    const done = await confirmHeldAtFirstRow(w, 'adm', pv.import_id, async () => {
      const body = between === 'serialized' ? { serialized: true } : { warranty_base_months: 6 };
      const own = await post(w.as('boss'), '/api/devices/admin/products/pAMS/ops-policy', body);
      assert.equal(own.status, 200, await own.clone().text());
    });
    assert.equal(done.success, true, JSON.stringify(done));
    const rows = done.rows as Array<{ key: string; action: string; reason: string }>;
    const ams = rows.find((r) => r.key === 'sp-ams-lite')!;
    const pla = rows.find((r) => r.key === 'sp-pla')!;
    assert.equal(ams.action, 'failed', `${between}: ${JSON.stringify(ams)}`);
    assert.ok(ams.reason.includes(IMPORT_ROW_CHANGED_RETRY), ams.reason);
    assert.ok(/^سطر \d+: /.test(ams.reason), 'the shape of every row refusal');
    assert.equal(pla.action, 'updated', JSON.stringify(pla));
    if (between === 'serialized') assert.equal(opsOf(w, 'pAMS').serialized, true, 'the owner\'s word stands');
    else assert.equal(opsOf(w, 'pAMS').warranty_base_months, 6, 'the owner\'s months stand');
    assert.equal(row<{ p: number }>(w.raw, "SELECT price_iqd AS p FROM products WHERE id = 'pAMS'")!.p, 399000, 'nothing of that row was written');
    assert.equal(row<{ p: number }>(w.raw, "SELECT price_iqd AS p FROM products WHERE id = 'pPLA'")!.p, 27000, 'the next row was');
  }
});

// ====================================================================== R4

const NO_SECTION = ['row_type', 'key', 'name', 'status', 'price_iqd'];

test('R4: a sheet whose section cells are absent or empty keeps the LIVE filing — a re-filing made after its preview survives the confirm', async () => {
  for (const cols of [NO_SECTION, HEAD] as const) {
    const w = world();
    w.raw.exec(`
      UPDATE catalogs SET template_family = 'devices' WHERE id IN ('ct_acc','ct_print');
      UPDATE products SET category_id = 'ct_acc', sub_category_id = 'ct_fil' WHERE id = 'pPLA';
    `);
    const csv = toCsv([cols, cols.map((h) => ({ row_type: 'product', key: 'sp-pla', name: 'PLA spool', status: 'draft', price_iqd: '26000' } as Record<string, string>)[h] ?? '')]);
    const app = importApp(w, 'adm');
    const pv = await preview(app, csv);
    assert.equal(pv.rows[0].errors.length, 0, JSON.stringify(pv.rows[0]));
    // The owner re-files the spool under AMS after the preview.
    w.raw.exec(`
      UPDATE products SET sub_category_id = 'ct_ams' WHERE id = 'pPLA';
      DELETE FROM product_catalogs WHERE product_id = 'pPLA' AND catalog_id = 'ct_fil';
      INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES ('pPLA','ct_ams',99);
    `);
    const done = await confirm(app, pv.import_id);
    assert.equal(done.summary.updated, 1, JSON.stringify(done));
    const p = row<{ c: string; s: string; price: number }>(w.raw, "SELECT category_id AS c, sub_category_id AS s, price_iqd AS price FROM products WHERE id = 'pPLA'")!;
    const label = cols === NO_SECTION ? 'absent' : 'empty';
    assert.equal(p.s, 'ct_ams', `${label}: the owner's re-filing is kept`);
    assert.equal(p.c, 'ct_acc');
    assert.equal(p.price, 26000, `${label}: the row's own cells are written`);
    assert.ok(!shelves(w, 'pPLA').includes('ct_fil'), `${label}: the old shelf is not put back`);
    assert.ok(shelves(w, 'pPLA').includes('ct_ams'));
  }
});

test('R4: the serial re-check judges the live filing it keeps; a sheet that DOES name a section still moves the product (round 3)', async () => {
  const w = world();
  w.raw.exec(`
    UPDATE catalogs SET template_family = 'devices' WHERE id IN ('ct_acc','ct_print');
    UPDATE products SET category_id = 'ct_acc', sub_category_id = 'ct_fil' WHERE id = 'pPLA';
  `);
  const csv = toCsv([NO_SECTION, ['product', 'sp-pla', 'PLA spool', 'draft', '26500']]);
  const app = importApp(w, 'adm');
  const pv = await preview(app, csv);
  // The owner files the spool under the printers after the preview — it now needs a serial.
  w.raw.exec(`
    UPDATE products SET category_id = 'ct_print', sub_category_id = NULL WHERE id = 'pPLA';
    INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES ('pPLA','ct_print',99);
  `);
  assert.equal(await effective(w, 'pPLA'), true);
  // Round 3 wrote the preview's pair back — a re-filing out of the printers,
  // refused to a full admin at the confirm. The live filing is kept instead:
  // nothing flips, the row is written.
  const done = await confirm(app, pv.import_id);
  assert.equal(done.summary.updated, 1, JSON.stringify(done));
  assert.equal(row<{ c: string }>(w.raw, "SELECT category_id AS c FROM products WHERE id = 'pPLA'")!.c, 'ct_print');
  assert.equal(await effective(w, 'pPLA'), true);
  assert.equal(row<{ p: number }>(w.raw, "SELECT price_iqd AS p FROM products WHERE id = 'pPLA'")!.p, 26500);

  // A sheet that names the section: the sheet's pair is written, as in round 3.
  const owner = importApp(w, 'boss');
  const named = await preview(owner, sheet({ key: 'sp-pla', name: 'PLA spool', category: 'sp-acc', sub_category: 'sp-fil', price_iqd: '27000' }));
  w.raw.exec(`UPDATE products SET sub_category_id = 'ct_ams' WHERE id = 'pPLA'`);
  assert.equal((await confirm(owner, named.import_id)).summary.updated, 1);
  const p = row<{ c: string; s: string }>(w.raw, "SELECT category_id AS c, sub_category_id AS s FROM products WHERE id = 'pPLA'")!;
  assert.deepEqual([p.c, p.s], ['ct_acc', 'ct_fil'], 'the sheet said where it goes');
});
