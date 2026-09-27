/**
 * THE IMPORT'S SECTIONS, THE «المستعمل» SHELF AND THE FIELDS PER SUB-SECTION
 * (owner, 2026-09-27).
 *
 *   «في إضافة منتجات (استيراد منتجات) في الأقسام يظهر أنها غير صحيحة وغير
 *   مرتبة … الأقسام الرئيسية والفرعية متداخلة وهنالك أقسام فرعية متداخلة مع
 *   أقسام أخرى، كما أنه لا يوجد قسم بعنوان المستعمل … أريد التأكد من القوالب
 *   خاصة TXT والأقسام الرئيسية والفرعية. كذلك أضف حقول عند الحاجة في الأقسام
 *   الفرعية خاصة الفلامنت والـAMS وملحقات الطابعات، وحقول مختلفة في قسم
 *   المستعمل للطابعات أو ملحقات الطابعات».
 *
 * Proven here: the tree order every list now uses; MakerWorld's sub-sections
 * no longer pretending to be filament; 0147's Used tree and the fields only it
 * is asked; the AMS / hotend / plate narrowing by a hand-made section's slug;
 * and the TXT template carrying the section it was downloaded for.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, SqliteD1 } from './fixtures/d1';
import { freshDb, asD1, stubApp, get } from './fixtures/app';
import { sectionPath, sectionTreeOrder } from '../packages/catalog/src/sectionTree';
import { loadLookups } from '../worker/lib/lookups';
import {
  flatFields,
  groupsForSection,
  groupsForType,
  isUsedBranch,
  narrowGroups,
  productTypeForBranch,
  type SectionRef,
} from '../worker/lib/templateFamilies';
import { prefillSection, buildBlankTemplate, templateRoutes } from '../worker/routes/template';

const ids = (groups: Array<{ id: string }>) => groups.map((g) => g.id);
const fields = (groups: Parameters<typeof flatFields>[0]) => flatFields(groups).map((f) => f.id);
const branch = (...pairs: Array<[string, string]>): SectionRef[] => pairs.map(([id, slug]) => ({ id, slug }));

// ------------------------------------------------------------ the tree order

test('every main section is followed by its own branch, whatever the sort numbers say', () => {
  // The shape that broke the import's select: sort compared ACROSS levels.
  const rows = [
    { id: 'kid_b1', parent_id: 'b', sort: 1, name: 'B1' },
    { id: 'a', parent_id: null, sort: 2, name: 'A' },
    { id: 'kid_a1', parent_id: 'a', sort: 3, name: 'A1' },
    { id: 'b', parent_id: null, sort: 4, name: 'B' },
    { id: 'grand', parent_id: 'kid_a1', sort: 5, name: 'A1x' },
    { id: 'orphan', parent_id: 'gone', sort: 6, name: 'O' },
  ];
  const placed = sectionTreeOrder(rows);
  assert.deepEqual(placed.map((p) => p.row.id), ['a', 'kid_a1', 'grand', 'b', 'kid_b1', 'orphan']);
  assert.deepEqual(placed.map((p) => p.depth), [0, 1, 2, 0, 1, 0]);
  assert.deepEqual(placed.map((p) => p.root.id), ['a', 'a', 'a', 'b', 'b', 'orphan']);
  assert.equal(sectionPath(placed[2], (r) => r.name), 'A › A1 › A1x');
});

test('a cycle a hand-edited database could hold loses no section', () => {
  const placed = sectionTreeOrder([
    { id: 'x', parent_id: 'y' },
    { id: 'y', parent_id: 'x' },
    { id: 'z', parent_id: null },
  ]);
  assert.deepEqual(new Set(placed.map((p) => p.row.id)), new Set(['x', 'y', 'z']));
  assert.equal(placed.length, 3);
});

test('the template lookups list each main section with its own sub-sections under it', async () => {
  const raw = freshDb();
  // A sub-section sorted before every main section, as a hand edit leaves it.
  raw.exec(`UPDATE catalogs SET sort = 0 WHERE id = 'cat_materials_resin'`);
  const { sections } = await loadLookups(asD1(raw));
  const at = (id: string) => sections.findIndex((s) => s.id === id);
  assert.ok(at('cat_materials') < at('cat_materials_resin'), 'a sub-section never prints above its main section');
  assert.ok(at('cat_materials_resin') < at('cat_accessories'), 'and never among another main section’s');
  const resin = sections[at('cat_materials_resin')];
  assert.equal(resin.depth, 1);
  assert.equal(resin.root_id, 'cat_materials');
  assert.equal(resin.path_ar, 'مواد الطباعة › مواد Resin');
});

// -------------------------------------------------- MakerWorld is not filament

test('MakerWorld’s sub-sections are accessories or parts — never the filament form', () => {
  for (const [id, slug] of [
    ['cat_makers_tools', 'maker-tools'],
    ['cat_makers_new', 'new-products'],
    ['cat_makers_premium', 'premium-model-kits'],
    ['cat_makers_other', 'others'],
    ['cat_makers_combo', 'maker-combo-kits'],
    ['cat_makers_lab', 'makerlab-accessories'],
  ] as const) {
    assert.equal(productTypeForBranch('materials', branch([id, slug], ['cat_makers', 'makers-supply'])), 'accessory', slug);
  }
  const parts = branch(['cat_makers_parts', 'parts-components'], ['cat_makers', 'makers-supply']);
  assert.equal(productTypeForBranch('materials', parts), 'parts');
  const partFields = fields(groupsForSection('materials', parts));
  for (const id of ['ams_slots', 'capacity', 'focal_length']) assert.ok(!partFields.includes(id), `a bearing was asked ${id}`);
  assert.equal(productTypeForBranch('materials', branch(['cat_makers', 'makers-supply'])), 'accessory');
});

// --------------------------------------------------------------- «المستعمل»

function migratedThrough(last: string) {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync(join(ROOT, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    if (f > last) break;
    raw.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  }
  return raw;
}

test('0147 seeds «المستعمل» with its two shelves, in the devices family', () => {
  const raw = freshDb();
  const rows = raw
    .prepare(`SELECT id, parent_id, slug, name_ar, is_printer_catalog, template_family FROM catalogs WHERE id LIKE 'cat_used%' ORDER BY sort`)
    .all() as Array<Record<string, unknown>>;
  assert.deepEqual(
    rows.map((r) => [r.id, r.parent_id, r.slug, r.name_ar, r.is_printer_catalog, r.template_family]),
    [
      ['cat_used', null, 'used', 'المستعمل', 0, 'devices'],
      ['cat_used_printers', 'cat_used', 'used-printers', 'طابعات مستعملة', 1, 'devices'],
      ['cat_used_pacc', 'cat_used', 'used-printer-accessories', 'ملحقات طابعات مستعملة', 0, 'devices'],
    ]
  );
});

test('a store that already owns the slug «used» keeps it; 0147 takes the fallback', () => {
  const raw = migratedThrough('0146_points_rate_v3.sql');
  raw.exec(`INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, sort) VALUES ('mine', NULL, 'used', 'قسمي', 'Mine', 1)`);
  raw.exec(readFileSync(join(ROOT, 'migrations', '0147_used_section.sql'), 'utf8'));
  assert.equal((raw.prepare(`SELECT slug FROM catalogs WHERE id = 'mine'`).get() as { slug: string }).slug, 'used');
  assert.equal((raw.prepare(`SELECT slug FROM catalogs WHERE id = 'cat_used'`).get() as { slug: string }).slug, 'used-levo');
  // And the fallback still resolves to the used branch.
  assert.equal(isUsedBranch(branch(['cat_used_printers', 'used-printers'], ['cat_used', 'used-levo'])), true);
  // A replay is a no-op.
  raw.exec(readFileSync(join(ROOT, 'migrations', '0147_used_section.sql'), 'utf8'));
  assert.equal((raw.prepare(`SELECT COUNT(*) AS n FROM catalogs WHERE id LIKE 'cat_used%'`).get() as { n: number }).n, 3);
});

test('a used printer is a printer asked its used condition; a new one is never asked it', () => {
  const used = branch(['cat_used_printers', 'used-printers'], ['cat_used', 'used']);
  assert.equal(productTypeForBranch('devices', used), 'printer');
  const usedGroups = ids(groupsForSection('devices', used));
  assert.ok(usedGroups.includes('used_state') && usedGroups.includes('used_printer'));
  assert.ok(usedGroups.includes('device_core'), 'and every printer question besides');

  const fresh = ids(groupsForSection('devices', branch(['cat_printers_fdm', 'fdm-printers'], ['cat_printers', 'printers'])));
  assert.ok(!fresh.includes('used_state') && !fresh.includes('used_printer'), 'a new printer asked how long it was used');
  assert.ok(!ids(groupsForType('printer')).includes('used_state'), 'nor the bare printer template');
});

test('a used accessory is asked the used condition and the FDM kinds, not the resin or laser ones', () => {
  const b = branch(['cat_used_pacc', 'used-printer-accessories'], ['cat_used', 'used']);
  assert.equal(productTypeForBranch('devices', b), 'parts');
  const g = ids(groupsForSection('devices', b));
  assert.ok(g.includes('used_state'));
  assert.ok(!g.includes('used_printer'), 'the printer usage record is a printer’s');
  for (const id of ['acc_ams', 'acc_hotend', 'acc_plate']) assert.ok(g.includes(id), id);
  for (const id of ['acc_resin', 'laser_acc']) assert.ok(!g.includes(id), id);
});

// ------------------------------------------------ fields per sub-section

test('a hand-made «AMS» shelf is asked the AMS questions alone; «Build plates» the plate ones', () => {
  const under = (id: string, slug: string) =>
    branch([id, slug], ['cat_pacc_fdm', 'fdm-printer-accessories'], ['cat_pacc', 'printer-accessories']);
  const ams = ids(groupsForSection('devices', under('x1', 'ams-lite')));
  assert.ok(ams.includes('acc_ams') && !ams.includes('acc_plate') && !ams.includes('acc_hotend'));
  const plates = ids(groupsForSection('devices', under('x2', 'build-plates')));
  assert.ok(plates.includes('acc_plate') && !plates.includes('acc_ams'));
  const hotends = ids(groupsForSection('devices', under('x3', 'hot-end-kits')));
  assert.ok(hotends.includes('acc_hotend') && !hotends.includes('acc_ams'));
  // A word inside a longer word is not the word: «parts» is not «pa».
  const shelf = ids(groupsForSection('devices', under('x4', 'spare-parts')));
  for (const id of ['acc_ams', 'acc_hotend', 'acc_plate']) assert.ok(shelf.includes(id), `an unnamed kind keeps ${id}`);
});

test('a filament is asked its AMS fit and how it performs; a resin bottle is asked neither', () => {
  const fdm = fields(groupsForSection('materials', branch(['cat_materials_fdm', 'fdm-materials'])));
  for (const id of ['ams_compatible', 'rfid_tag', 'tensile_strength', 'heat_deflection', 'max_print_speed']) assert.ok(fdm.includes(id), id);
  const resin = fields(narrowGroups('filament', branch(['cat_materials_resin', 'resin-materials'])));
  for (const id of ['ams_compatible', 'tensile_strength']) assert.ok(!resin.includes(id), id);
});

// ------------------------------------------------------------ the TXT template

test('the TXT template carries the section it was downloaded for', () => {
  const base = buildBlankTemplate().text;
  assert.match(base, /^category=__NULL__$/m, 'the bare blank still says no section');
  const out = prefillSection(base, { category: 'printers', subCategory: 'fdm-printers', family: 'devices' });
  assert.match(out, /^category=printers$/m);
  assert.match(out, /^sub_category=fdm-printers$/m);
  assert.match(out, /^template_family=devices$/m);
  // A main section chosen on its own leaves the sub-section empty.
  const main = prefillSection(base, { category: 'printers', subCategory: null, family: 'devices' });
  assert.match(main, /^sub_category=__NULL__$/m);
});

test('GET /api/admin/template/blank for «طابعات مستعملة» writes that section and asks the used fields', async () => {
  const raw = freshDb();
  const app = stubApp(new SqliteD1(raw) as unknown as D1Database, { id: 'boss', role: 'admin', email: 'a@x.co' }, (a) =>
    a.route('/api/admin/template', templateRoutes)
  );
  const res = await get(app, '/api/admin/template/blank?type=printer&category=cat_used_printers');
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /^category=used$/m);
  assert.match(text, /^sub_category=used-printers$/m);
  assert.match(text, /^spec\.usage_age=$/m);
  assert.match(text, /^spec\.functional_check=$/m);
});
