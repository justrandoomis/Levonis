/**
 * The serial-scan LANDING reviews (S1 privacy review, migration/regressions
 * review), one test per finding, by name. Every case runs the real routes
 * over the real migrations (tests/fixtures/serialPrep.ts).
 *
 *   S1 #1   a new product's `serialized` is the owner's (form CREATE path)
 *   S1 #2   the import sheet judges the section policy and the re-filing
 *           (also the migration review's #2), and the TXT template the same
 *   S1 #3   the serial page masks a serial at every depth of a history row
 *   S1 #4   a non-owner's echo never pins an inherited answer
 *   Mig #1  OWNER_ONLY / IDEMPOTENCY_MISMATCH speak the contract's sentence
 *   Mig #3  re-parenting a section is the owner's when it flips a product
 *           (the printer flag the same, since round 3 —
 *           tests/serialLandingReview2.test.ts)
 *
 * Run: node --import tsx --test tests/serialLandingReview.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { json, post, patch, get, row, count, stubApp, ctx, type App } from './fixtures/app';
import { world, USERS, SN, SN2, BOX } from './fixtures/serialPrep';
import { adminImportRoutes } from '../worker/routes/adminImport';
import { templateRoutes } from '../worker/routes/template';
import { toCsv } from '../worker/lib/importCsv';
import { IMPORT_SERIALIZED_OWNER_ONLY, IMPORT_SERIAL_REFILE_OWNER_ONLY } from '../worker/lib/importApply';
import { lineDevicePolicy, serializationContext } from '../worker/lib/serialPolicy';
import { maskedDetail, SERIAL_TEXT, refuse } from '../worker/lib/serialAssignments';
import { maskSerial } from '../worker/lib/deviceOps';
import { serverMessage } from '../packages/contracts/src/costRefusals';

type World = ReturnType<typeof world>;

const opsOf = (w: World, id: string) => JSON.parse(String(row<{ ops_policy: string }>(w.raw, 'SELECT ops_policy FROM products WHERE id = ?', id)!.ops_policy)) as Record<string, unknown>;

async function effective(w: World, id: string): Promise<boolean> {
  const p = row<{ ops_policy: string }>(w.raw, 'SELECT ops_policy FROM products WHERE id = ?', id)!;
  return lineDevicePolicy(p.ops_policy, id, await serializationContext(w.db, [id])).serialized;
}

// ------------------------------------------------------------------ S1 #1

test('S1 #1: creating a product with a `serialized` that differs from its placement is the owner\'s (form create path)', async () => {
  for (const who of ['adm', 'ast'] as const) {
    const w = world();
    // A printer switched off at birth.
    const printer = await post(w.as(who), '/api/admin/products-v2', {
      name_en: 'New printer', name_ar: 'طابعة جديدة', price_iqd: 899000, status: 'draft',
      category_id: 'ct_print', catalog_ids: ['ct_print'], serialized: false,
    });
    assert.equal(printer.status, 403, `${who}: ${await printer.clone().text()}`);
    assert.equal((await json(printer)).code, 'OWNER_ONLY');
    // An AMS born in a 'required' section with serialization off.
    w.raw.exec(`UPDATE catalogs SET serial_policy = 'required' WHERE id = 'ct_ams'`);
    const ams = await post(w.as(who), '/api/admin/products-v2', {
      name_en: 'AMS HT', name_ar: 'AMS HT', price_iqd: 300000, status: 'draft',
      category_id: 'ct_acc', sub_category_id: 'ct_ams', catalog_ids: ['ct_ams'], serialized: false,
    });
    assert.equal(ams.status, 403, who);
    // …and by the other key the save reads (`ops_policy.serialized`).
    const viaOps = await post(w.as(who), '/api/admin/products-v2', {
      name_en: 'AMS HT 2', name_ar: 'AMS HT 2', price_iqd: 300000, status: 'draft',
      category_id: 'ct_acc', sub_category_id: 'ct_ams', catalog_ids: ['ct_ams'], ops_policy: { serialized: false },
    });
    assert.equal(viaOps.status, 403, `${who} via ops_policy`);
    // A filament switched on at birth.
    const fil = await post(w.as(who), '/api/admin/products-v2', {
      name_en: 'PETG spool', name_ar: 'خيط PETG', price_iqd: 25000, status: 'draft',
      category_id: 'ct_acc', sub_category_id: 'ct_fil', catalog_ids: ['ct_fil'], serialized: true,
    });
    assert.equal(fil.status, 403, who);
    assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM products WHERE name IN ('New printer','AMS HT','AMS HT 2','PETG spool')"), 0, 'nothing was created');
  }
  // The answer the placement already gives passes, and the owner may say anything.
  const w = world();
  const same = await post(w.as('ast'), '/api/admin/products-v2', {
    name_en: 'Plain printer', name_ar: 'طابعة', price_iqd: 899000, status: 'draft',
    category_id: 'ct_print', catalog_ids: ['ct_print'], serialized: true,
  });
  assert.equal(same.status, 200, await same.clone().text());
  const owner = await post(w.as('boss'), '/api/admin/products-v2', {
    name_en: 'Owner printer', name_ar: 'طابعة المالك', price_iqd: 899000, status: 'draft',
    category_id: 'ct_print', catalog_ids: ['ct_print'], serialized: false,
  });
  assert.equal(owner.status, 200, await owner.clone().text());
  const id = String(row<{ id: string }>(w.raw, "SELECT id FROM products WHERE name = 'Owner printer'")!.id);
  assert.equal(await effective(w, id), false, 'the owner\'s word is stored');
});

// ------------------------------------------------------------------ S1 #4

test('S1 #4: a non-owner\'s echo of an inherited answer is not written down — the product keeps following its section', async () => {
  const w = world();
  w.raw.exec(`UPDATE catalogs SET serial_policy = 'required' WHERE id = 'ct_ams'`);
  // The ops-policy door: the echo passes, nothing is stored.
  const echo = await post(w.as('adm'), '/api/devices/admin/products/pAMS/ops-policy', { serialized: true });
  assert.equal(echo.status, 200, await echo.clone().text());
  assert.equal((await json(echo)).ops_policy.serialized, true, 'the answer is the effective one');
  assert.equal('serialized' in opsOf(w, 'pAMS'), false, 'the echo is not the product\'s own word');
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'device.ops_policy'"), 0, 'nothing written, nothing audited');
  // The product form: the same.
  const save = await post(w.as('ast'), '/api/admin/products-v2', {
    id: 'pAMS', name_en: 'Bambu Lab AMS Lite', name_ar: 'AMS لايت', price_iqd: 399000, status: 'draft', serialized: true,
  });
  assert.equal(save.status, 200, await save.clone().text());
  assert.equal('serialized' in opsOf(w, 'pAMS'), false);
  // So when the owner turns the section off, the product follows.
  w.raw.exec(`UPDATE catalogs SET serial_policy = 'off' WHERE id = 'ct_ams'`);
  assert.equal(await effective(w, 'pAMS'), false, 'it inherits the owner\'s new policy');
  // A product with its own word keeps it through a non-owner's save, and a
  // non-owner cannot clear it by sending `ops_policy.serialized: null`.
  w.raw.exec(`UPDATE products SET ops_policy = '{"serialized":true}' WHERE id = 'pPLA'`);
  const keep = await post(w.as('adm'), '/api/admin/products-v2', {
    id: 'pPLA', name_en: 'PLA spool', name_ar: 'خيط PLA', price_iqd: 25000, status: 'draft', ops_policy: { serialized: null },
  });
  assert.equal(keep.status, 403, 'clearing a word that the placement would answer differently is a change');
  assert.equal(opsOf(w, 'pPLA').serialized, true);
  // The owner's echo IS his word.
  assert.equal((await post(w.as('boss'), '/api/devices/admin/products/pAMS/ops-policy', { serialized: false })).status, 200);
  assert.equal(opsOf(w, 'pAMS').serialized, false);
});

// ------------------------------------------------------------------ S1 #2 / Mig #2 — the import sheet

const HEAD = ['row_type', 'key', 'name', 'status', 'category', 'sub_category', 'price_iqd', 'serialized'];
const sheet = (...rows: Array<Record<string, string>>) =>
  toCsv([HEAD, ...rows.map((r) => HEAD.map((h) => ({ row_type: 'product', status: 'draft', price_iqd: '100000', ...r })[h] ?? ''))]);

function importApp(w: World, who: keyof typeof USERS): App {
  return stubApp(w.db, USERS[who], (a) => a.route('/api/admin/import', adminImportRoutes));
}

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

function importWorld() {
  const w = world();
  w.raw.exec(`UPDATE catalogs SET template_family = 'devices' WHERE id IN ('ct_acc','ct_print')`);
  return w;
}

test('S1 #2 / migration #2: a sheet cell that turns off a serial the SECTION requires is refused for a non-owner; the echo passes unpinned', async () => {
  const w = importWorld();
  w.raw.exec(`UPDATE catalogs SET serial_policy = 'required' WHERE id = 'ct_ams'`);
  const amsRow = (serialized: string) => ({ key: 'sp-ams-lite', name: 'Bambu Lab AMS Lite', category: 'sp-acc', sub_category: 'sp-ams', serialized });
  for (const who of ['adm', 'ast'] as const) {
    const off = await preview(importApp(w, who), sheet(amsRow('no')));
    assert.equal(off.rows[0].action, 'failed', `${who}: ${JSON.stringify(off.rows[0])}`);
    assert.ok(off.rows[0].errors.some((e) => e.includes(IMPORT_SERIALIZED_OWNER_ONLY)), JSON.stringify(off.rows[0].errors));
  }
  // The echo of the section's answer is not an attempt — and the confirm does
  // not write it down as the product's own.
  const app = importApp(w, 'adm');
  const echo = await preview(app, sheet(amsRow('yes')));
  assert.deepEqual(serialErrors(echo.rows[0]), [], JSON.stringify(echo.rows[0]));
  const done = await confirm(app, echo.import_id);
  assert.equal(done.success, true, JSON.stringify(done));
  assert.equal('serialized' in opsOf(w, 'pAMS'), false, 'the echo is not pinned');
  assert.equal(await effective(w, 'pAMS'), true);
  // The owner may.
  const owner = await preview(importApp(w, 'boss'), sheet(amsRow('no')));
  assert.deepEqual(serialErrors(owner.rows[0]), []);
});

test('S1 #2 / migration #2: a sheet that RE-FILES a silent product into or out of a printer section is refused for a non-owner', async () => {
  const w = importWorld();
  // The filament, its serialized cell empty, filed under the printers.
  const into = await preview(importApp(w, 'adm'), sheet({ key: 'sp-pla', name: 'PLA spool', category: 'sp-printers', serialized: '' }));
  assert.ok(into.rows[0].errors.some((e) => e.includes(IMPORT_SERIAL_REFILE_OWNER_ONLY)), JSON.stringify(into.rows[0]));
  // A printer re-filed as an accessory. Its printer catalog is its SECTION
  // here (as on live rows): round 3 (F2) keeps a placement the sheet does not
  // state, so only a section the sheet replaces can take the printer away.
  w.raw.exec(`UPDATE products SET category_id = 'ct_print' WHERE id = 'pA1'`);
  const out = await preview(importApp(w, 'ast'), sheet({ key: 'sp-a1', name: 'Bambu Lab A1 Combo', category: 'sp-acc', serialized: '' }));
  assert.ok(out.rows[0].errors.some((e) => e.includes(IMPORT_SERIAL_REFILE_OWNER_ONLY)), JSON.stringify(out.rows[0]));
  // Between two sections that agree, anyone may; and the owner may re-file.
  const sideways = await preview(importApp(w, 'adm'), sheet({ key: 'sp-pla', name: 'PLA spool', category: 'sp-acc', sub_category: 'sp-fil', serialized: '' }));
  assert.deepEqual(serialErrors(sideways.rows[0]), [], JSON.stringify(sideways.rows[0]));
  const owner = await preview(importApp(w, 'boss'), sheet({ key: 'sp-pla', name: 'PLA spool', category: 'sp-printers', serialized: '' }));
  assert.deepEqual(serialErrors(owner.rows[0]), []);
  // A NEW product whose cell disagrees with its section, the same.
  const fresh = await preview(importApp(w, 'adm'), sheet({ key: 'NEW-PRN', name: 'Brand new printer', category: 'sp-printers', serialized: 'no' }));
  assert.ok(fresh.rows[0].errors.some((e) => e.includes(IMPORT_SERIALIZED_OWNER_ONLY)), JSON.stringify(fresh.rows[0]));
  // The refusals carry Arabic, English and real Sorani.
  for (const m of [IMPORT_SERIALIZED_OWNER_ONLY, IMPORT_SERIAL_REFILE_OWNER_ONLY]) {
    const [ar, en, ckb] = m.split(' / ');
    assert.ok(/[؀-ۿ]/.test(ar) && /[a-z]/i.test(en) && /[ەێۆڕڵ]/.test(ckb) && ckb !== ar, m);
  }
});

test('S1 #2 variant: the TXT template door judges `serialized` and the filing like the form', async () => {
  const w = world();
  w.raw.exec(`UPDATE catalogs SET template_family = 'devices' WHERE id IN ('ct_acc','ct_print')`);
  const tpl = (who: keyof typeof USERS) => stubApp(w.db, USERS[who], (a) => a.route('/api/admin/template', templateRoutes));
  const draft = (lines: string[]) => [
    'template_version=2', 'name_ar=طابعة القالب', 'name_en=Template printer', 'price_iqd=899000',
    'selling_type=direct_sale', 'template_family=devices', ...lines,
  ].join('\n');
  const refused = await post(tpl('ast'), '/api/admin/template/apply', {
    text: draft(['slug=tpl-printer', 'category=sp-printers', 'serialized=false']), mode: 'draft', confirm: true,
  });
  const body = await json(refused);
  assert.equal(body.code, 'OWNER_ONLY', JSON.stringify(body));
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM products WHERE slug = 'tpl-printer'"), 0);
  // The owner may.
  const owner = await post(tpl('boss'), '/api/admin/template/apply', {
    text: draft(['slug=tpl-printer', 'category=sp-printers', 'serialized=false']), mode: 'draft', confirm: true,
  });
  assert.equal(owner.status, 200, await owner.clone().text());
  // An update that re-files the silent AMS into the printers is refused too.
  const text = await (await get(tpl('adm'), '/api/admin/template/export/pAMS')).text();
  assert.ok(text.includes('product_id='), text.slice(0, 300));
  const moved = await post(tpl('adm'), '/api/admin/template/apply', {
    text: text.replace(/^category=.*$/m, 'category=sp-printers').concat(/^category=/m.test(text) ? '' : '\ncategory=sp-printers'),
    mode: 'update', confirm: true,
  });
  assert.equal((await json(moved)).code, 'OWNER_ONLY');
  assert.equal(await effective(w, 'pAMS'), false, 'still no serial asked of it');
  // The echo of a section's answer passes — and is not pinned (S1 #4 through this door).
  w.raw.exec(`UPDATE catalogs SET serial_policy = 'required' WHERE id = 'ct_ams'`);
  const echo = await post(tpl('adm'), '/api/admin/template/apply', { text: `${text.trimEnd()}\nserialized=true\n`, mode: 'update', confirm: true });
  assert.equal(echo.status, 200, await echo.clone().text());
  assert.equal('serialized' in opsOf(w, 'pAMS'), false, 'the echo is not the product\'s own word');
  assert.equal(await effective(w, 'pAMS'), true);
});

// ------------------------------------------------------------------ S1 #3

test('S1 #3: the masking path (defence in depth since owner decision 1) masks every serial a history row names, at any depth', async () => {
  // No admin is shown a masked serial since owner decision 1 (2026-10-09);
  // the path stays, and a viewer without either right is masked by it.
  const assistant = { fullSerial: false, orderRefs: false };
  const replaced = maskedDetail({ replaced_receipt_no: 'W-1', replaced_serial: SN, new_serial: SN2, new_unit_id: 'u2' }, assistant);
  assert.equal(replaced.replaced_serial, maskSerial(SN));
  assert.equal(replaced.new_serial, maskSerial(SN2));
  assert.equal(replaced.replaced_receipt_no, 'W-1', 'a receipt number is not a serial');
  const reissued = maskedDetail({ reason: 'typo', corrected_serial: { from: SN, to: SN2 }, corrected_window: { from: '2026-01-01', to: '2027-01-01' } }, assistant);
  assert.deepEqual(reissued.corrected_serial, { from: maskSerial(SN), to: maskSerial(SN2) });
  assert.deepEqual(reissued.corrected_window, { from: '2026-01-01', to: '2027-01-01' }, 'dates are left alone');
  const updated = maskedDetail({ from: { box_sn: BOX, product_id: 'pA1', order_id: 'ORD-9' }, to: { box_sn: 'B07119G5811000AC' } }, assistant);
  assert.deepEqual(updated, { from: { box_sn: maskSerial(BOX), product_id: 'pA1', order_id: null }, to: { box_sn: maskSerial('B07119G5811000AC') } });
  assert.deepEqual(maskedDetail({ serials: [SN, SN2] }, assistant), { serials: [maskSerial(SN), maskSerial(SN2)] });
  assert.deepEqual(maskedDetail({ corrected_serial: { from: SN } }, { fullSerial: true, orderRefs: true }), { corrected_serial: { from: SN } }, 'the owner sees it whole');
  // The two halves are separate: an assistant today — whole serials, no order numbers.
  assert.deepEqual(
    maskedDetail({ from: { box_sn: BOX, order_id: 'ORD-9' }, new_serial: SN2 }, { fullSerial: true, orderRefs: false }),
    { from: { box_sn: BOX, order_id: null }, new_serial: SN2 }
  );
  assert.deepEqual(maskedDetail({ new_serial: SN2, order_id: 'ORD-9' }, { fullSerial: false, orderRefs: true }), { new_serial: maskSerial(SN2), order_id: 'ORD-9' });

  // Through the page itself: every admin reads the serials whole (decision 1).
  const w = world();
  w.raw.exec(`
    INSERT INTO serial_inventory (serial_norm, serial_raw, model_name, product_id, box_sn, created_by) VALUES ('${SN}','${SN}','A1 Combo','pA1','${BOX}','boss');
    INSERT INTO audit_log (actor_id, action, target, detail) VALUES
      ('boss','warranty.replaced','${SN}','{"replaced_serial":"${SN}","new_serial":"${SN2}"}'),
      ('boss','warranty.reissued','${SN}','{"corrected_serial":{"from":"${SN2}","to":"${SN}"}}'),
      ('boss','serial_inventory.update','${SN}','{"from":{"box_sn":"${BOX}"},"to":{"box_sn":"B07119G5811000AC"}}');
  `);
  const page = await json(await get(w.as('ast'), `/api/devices/admin/serial-inventory/${SN}`));
  assert.equal(page.success, true, JSON.stringify(page));
  assert.equal(page.history.length, 4, 'three rows and the rebuilt «added»');
  const text = JSON.stringify(page.history);
  for (const whole of [SN2, BOX, 'B07119G5811000AC']) assert.ok(text.includes(whole), `${whole}: the assistant reads it whole`);
  const ownerPage = JSON.stringify((await json(await get(w.as('boss'), `/api/devices/admin/serial-inventory/${SN}`))).history);
  assert.ok(ownerPage.includes(SN2) && ownerPage.includes(BOX), 'the owner reads them whole');
});

// ------------------------------------------------------------------ Mig #1

test('migration #1: OWNER_ONLY and IDEMPOTENCY_MISMATCH carry the programme contract\'s one server sentence on the serial doors', async () => {
  assert.equal(SERIAL_TEXT.OWNER_ONLY, serverMessage('OWNER_ONLY'));
  assert.equal(SERIAL_TEXT.IDEMPOTENCY_MISMATCH, serverMessage('IDEMPOTENCY_MISMATCH'));
  assert.equal(refuse(403, 'OWNER_ONLY').message, serverMessage('OWNER_ONLY'));
  // Every serial door that refuses a non-owner says the same sentence as S1's `ownerOnly()`.
  const w = world();
  const doors: Array<Response | Promise<Response>> = [
    // (round 3, F1: the flag is refused only where it flips a product — the
    // filament section holds a silent one.)
    post(w.as('adm'), '/api/admin/taxonomy/catalogs', { id: 'ct_fil', name_en: 'Filament', is_printer_catalog: true }),
    post(w.as('adm'), '/api/devices/admin/products/pAMS/ops-policy', { serialized: true }),
  ];
  for (const res of await Promise.all(doors)) {
    const body = await json(res);
    assert.equal(body.code, 'OWNER_ONLY');
    assert.equal(body.error, serverMessage('OWNER_ONLY'));
  }
});

// ------------------------------------------------------------------ Mig #3

test('migration #3: moving a section under a parent whose serial policy flips its products is the owner\'s', async () => {
  const w = world();
  w.raw.exec(`
    INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, serial_policy) VALUES ('ct_req', NULL, 'sp-req', 'أجهزة', 'Devices', 'required');
    INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en) VALUES ('ct_empty', 'ct_acc', 'sp-empty', 'فارغ', 'Empty');
  `);
  for (const who of ['adm', 'ast'] as const) {
    const move = await post(w.as(who), '/api/admin/taxonomy/catalogs', { id: 'ct_fil', parent_id: 'ct_req' });
    assert.equal(move.status, 403, `${who}: ${await move.clone().text()}`);
    const body = await json(move);
    assert.equal(body.code, 'OWNER_ONLY');
    assert.equal(body.details?.products, 1, 'one product (the filament) would start needing a serial');
  }
  assert.equal(row<{ parent_id: string }>(w.raw, "SELECT parent_id FROM catalogs WHERE id = 'ct_fil'")!.parent_id, 'ct_acc', 'not moved');
  assert.equal(await effective(w, 'pPLA'), false);
  // A move that flips nothing is anyone's: an empty section, or a branch whose policy agrees.
  assert.equal((await post(w.as('adm'), '/api/admin/taxonomy/catalogs', { id: 'ct_empty', parent_id: 'ct_req' })).status, 200);
  assert.equal((await post(w.as('adm'), '/api/admin/taxonomy/catalogs', { id: 'ct_fil', parent_id: 'ct_print' })).status, 200, 'the printer flag is not inherited');
  // A product with its own word is never flipped by a move.
  w.raw.exec(`UPDATE products SET ops_policy = '{"serialized":false}' WHERE id = 'pPLA'`);
  assert.equal((await post(w.as('adm'), '/api/admin/taxonomy/catalogs', { id: 'ct_fil', parent_id: 'ct_req' })).status, 200);
  // The owner may move a section that flips its products.
  w.raw.exec(`UPDATE products SET ops_policy = '{}' WHERE id = 'pPLA'; UPDATE catalogs SET parent_id = 'ct_acc' WHERE id = 'ct_fil'`);
  assert.equal((await post(w.as('boss'), '/api/admin/taxonomy/catalogs', { id: 'ct_fil', parent_id: 'ct_req' })).status, 200);
  assert.equal(await effective(w, 'pPLA'), true);
});

test('migration #3 variant: the products-v2 catalog editor guards the printer flag and re-parenting like the taxonomy editor', async () => {
  const w = world();
  w.raw.exec(`INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, serial_policy) VALUES ('ct_req', NULL, 'sp-req', 'أجهزة', 'Devices', 'required')`);
  for (const who of ['adm', 'ast'] as const) {
    // The printer flag: the filament filed there would start needing a serial.
    // (Round 3, F1: only a flag that FLIPS a product is refused — a new
    // catalog holds none, so creating one with the flag is anyone's.)
    const flag = await patch(w.as(who), '/api/admin/products-v2/catalogs/ct_fil', { is_printer_catalog: true });
    assert.equal(flag.status, 403, `${who}: ${await flag.clone().text()}`);
    assert.equal((await json(flag)).code, 'OWNER_ONLY');
    const born = await post(w.as(who), '/api/admin/products-v2/catalogs', { name_ar: 'طابعات جديدة', name_en: 'New printers', is_printer_catalog: true });
    assert.equal(born.status, 200, `${who}: ${await born.clone().text()}`);
    // The re-parent that flips the filament.
    const move = await patch(w.as(who), '/api/admin/products-v2/catalogs/ct_fil', { parent_id: 'ct_req' });
    assert.equal(move.status, 403, who);
    assert.equal((await json(move)).details?.via, 'reparent');
  }
  assert.equal(row<{ n: number }>(w.raw, "SELECT is_printer_catalog AS n FROM catalogs WHERE id = 'ct_fil'")!.n, 0);
  assert.equal(row<{ p: string }>(w.raw, "SELECT parent_id AS p FROM catalogs WHERE id = 'ct_fil'")!.p, 'ct_acc');
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM catalogs WHERE name_en = 'New printers' AND is_printer_catalog = 1"), 2);
  // An echo, a rename and an ordinary section are anyone's; the owner may do all of it.
  assert.equal((await patch(w.as('adm'), '/api/admin/products-v2/catalogs/ct_acc', { is_printer_catalog: false, name_en: 'Accessories+' })).status, 200);
  assert.equal((await post(w.as('ast'), '/api/admin/products-v2/catalogs', { name_ar: 'قسم', name_en: 'Plain section' })).status, 200);
  assert.equal((await patch(w.as('boss'), '/api/admin/products-v2/catalogs/ct_fil', { parent_id: 'ct_req' })).status, 200);
  assert.equal(await effective(w, 'pPLA'), true);
});
