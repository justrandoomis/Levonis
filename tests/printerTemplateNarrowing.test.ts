/**
 * AN FDM PRINTER IS NOT ASKED ABOUT ITS LCD.
 *
 * THE DEFECT the owner reported: the Bambu Lab A1 — an FDM machine — rendered
 * THE CENSUS MOVED WHEN THE TEMPLATE GREW, AND THE RULE DID NOT.
 *
 * The owner asked for the printer template to widen so the comparison has real
 * data to draw on, and the FDM and Resin sections were split into readable
 * sub-groups at the same time («كمميزات بنقاط مرتبة», not one wall). So the
 * numbers below are larger than they were and will grow again. What these
 * tests are actually about is unchanged and is not a number: an FDM section
 * must never be asked a Resin question, a Resin section never an FDM one, and
 * a product filed at the parent «الطابعات» keeps both because the branch has
 * not said which. The group-shape assertions are the ones that carry that; the
 * totals are a census that has to be re-counted whenever a field is added.
 *
 * The union is the device-common and environment groups plus both technologies;
 * the other eight (lcd_size, lcd_resolution, xy_resolution,
 * layer_height_range, light_source, exposure_time, uv_power, release_film) are
 * Resin fields for a screen the A1 does not have.
 *
 * THE CAUSE: A TYPE IS NOT A TECHNOLOGY. `PRODUCT_TYPES.printer` composes
 * device-common + FDM + Resin, because the TYPE covers both kinds of machine.
 * `fieldsFor(family, slugs)` used the branch ONLY to pick the type — through
 * `productTypeForSection`, where `fdm-printers`, `resin-printers` and
 * `printers` all answer `printer` — and then discarded it, handing back the
 * union every time.
 *
 * THE FIX: the branch narrows within the type. Naming one leaf of an axis
 * drops its siblings; naming none keeps them all, because a product filed
 * directly under «الطابعات» genuinely has not said which technology it is.
 *
 * AND THE MATCH IS ON THE ID FIRST. Migration 0018 seeds `cat_printers_fdm`
 * with a PREFERRED slug and two documented fallbacks — `fdm-printers-levo`,
 * then the bare id — for a store where the slug was already taken. The id
 * never moves, so an FDM section whose slug collided, or one an admin renamed
 * in the taxonomy screen, must still get 39 fields and not 47.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  groupsForSection,
  narrowGroups,
  groupsForType,
  productTypeForBranch,
  fieldsFor,
  flatFields,
  type SectionRef,
} from '../worker/lib/templateFamilies';
import { templateShape } from '../worker/lib/importCsv';
import { freshDb, asD1, stubApp, get, json } from './fixtures/app';
import { adminTaxonomyRoutes } from '../worker/routes/adminTaxonomy';
import { specIdsOutsideTemplate } from '../src/components/adminProducts/types';

/** The eight fields that made this a bug report. */
const RESIN_FIELDS = [
  'lcd_size',
  'lcd_resolution',
  'xy_resolution',
  'layer_height_range',
  'light_source',
  'exposure_time',
  'uv_power',
  'release_film',
];

/** A few FDM fields no resin printer should be asked for. */
const FDM_FIELDS = ['nozzle_temp_max', 'bed_temp_max', 'extruders', 'ams_compatibility', 'input_shaping'];

const ids = (branch: SectionRef[]) => flatFields(groupsForSection('devices', branch)).map((f) => f.id);

const FDM_BRANCH: SectionRef[] = [
  { id: 'cat_printers_fdm', slug: 'fdm-printers' },
  { id: 'cat_printers', slug: 'printers' },
];
const RESIN_BRANCH: SectionRef[] = [
  { id: 'cat_printers_resin', slug: 'resin-printers' },
  { id: 'cat_printers', slug: 'printers' },
];

// ------------------------------------------------------------------- test 5

test('5 — an FDM printer gets device-common + FDM only: 62 fields, no Resin', () => {
  const groups = groupsForSection('devices', FDM_BRANCH);
  assert.deepEqual(
    groups.map((g) => `${g.id}:${g.fields.length}`),
    ['device_core:24', 'device_env:8', 'fdm:21', 'fdm_extrusion:4', 'fdm_motion:3', 'fdm_control:2'],
    'exactly the two groups an FDM machine should be asked about'
  );
  assert.equal(flatFields(groups).length, 62);

  const shown = ids(FDM_BRANCH);
  for (const f of RESIN_FIELDS) {
    assert.ok(!shown.includes(f), `the A1 is still being asked for "${f}"`);
  }
  // And the FDM fields ARE there — narrowing must not be a synonym for hiding.
  for (const f of FDM_FIELDS) assert.ok(shown.includes(f), `"${f}" went missing`);
});

// ------------------------------------------------------------------- test 6

test('6 — a Resin printer gets device-common + Resin only: 46 fields, no FDM', () => {
  const groups = groupsForSection('devices', RESIN_BRANCH);
  assert.deepEqual(groups.map((g) => `${g.id}:${g.fields.length}`), ['device_core:24', 'device_env:8', 'resin:10', 'resin_motion:4']);
  assert.equal(flatFields(groups).length, 46);

  const shown = ids(RESIN_BRANCH);
  for (const f of RESIN_FIELDS) assert.ok(shown.includes(f), `"${f}" went missing from a Resin printer`);
  for (const f of FDM_FIELDS) assert.ok(!shown.includes(f), `a Resin printer is being asked for "${f}"`);
});

// ------------------------------------------- the id is what the match is on

test('a renamed slug does not widen the form back to the full union', () => {
  // The admin renamed «طابعات FDM» in the taxonomy screen. The id is unchanged,
  // so the narrowing must hold.
  const renamed: SectionRef[] = [
    { id: 'cat_printers_fdm', slug: 'bambu-machines' },
    { id: 'cat_printers', slug: 'printers' },
  ];
  assert.equal(flatFields(groupsForSection('devices', renamed)).length, 62);
  assert.equal(productTypeForBranch('devices', renamed), 'printer', 'and it is still a printer');
});

test("0018's slug fallbacks are recognised, because a colliding store gets them", () => {
  // 0018: `fdm-printers` taken → `fdm-printers-levo`; that taken too → the id.
  for (const slug of ['fdm-printers', 'fdm-printers-levo', 'cat_printers_fdm']) {
    const branch: SectionRef[] = [{ id: 'unknown', slug }];
    assert.equal(flatFields(groupsForSection('devices', branch)).length, 62, `slug "${slug}" was not recognised`);
  }
});

// ------------------------------------------------- honest when it cannot tell

test('a product filed directly under «الطابعات» keeps both, because the section has not said', () => {
  const groups = groupsForSection('devices', [{ id: 'cat_printers', slug: 'printers' }]);
  assert.equal(flatFields(groups).length, 76, 'the union is the honest answer when the branch names no technology');
  assert.deepEqual(groups.map((g) => g.id), ['device_core', 'device_env', 'fdm', 'fdm_extrusion', 'fdm_motion', 'fdm_control', 'resin', 'resin_motion']);
});

test('a section nobody seeded still gets its type, never an empty form', () => {
  const invented: SectionRef[] = [{ id: 'cat_9f3a', slug: 'my-new-printers' }];
  assert.equal(productTypeForBranch('devices', invented), 'printer');
  assert.equal(flatFields(groupsForSection('devices', invented)).length, 76);
});

// ------------------------------------------------------------ the other axes

test('the same narrowing applies to materials and to printer accessories', () => {
  const fdmMat = groupsForSection('materials', [
    { id: 'cat_materials_fdm', slug: 'fdm-materials' },
    { id: 'cat_materials', slug: 'printing-materials' },
  ]);
  assert.deepEqual(fdmMat.map((g) => g.id), ['material_core', 'fdm_mat']);
  assert.ok(!flatFields(fdmMat).some((f) => f.id === 'wavelength'), 'a filament spool asked for a UV wavelength');

  const resinMat = groupsForSection('materials', [{ id: 'cat_materials_resin', slug: 'resin-materials' }]);
  assert.deepEqual(resinMat.map((g) => g.id), ['material_core', 'resin_mat']);
  assert.ok(!flatFields(resinMat).some((f) => f.id === 'spool_type'), 'a bottle of resin asked for a spool type');

  // «ملحقات طابعات FDM» declares no group of its own, but naming it is still
  // the statement "not a Resin accessory" — so the wash-station capacity goes.
  const fdmAcc = groupsForSection('devices', [
    { id: 'cat_pacc_fdm', slug: 'fdm-printer-accessories' },
    { id: 'cat_pacc', slug: 'printer-accessories' },
  ]);
  assert.ok(!flatFields(fdmAcc).some((f) => f.id === 'capacity'), 'an FDM accessory asked for a resin-tank capacity');
  const resinAcc = groupsForSection('devices', [
    { id: 'cat_pacc_resin', slug: 'resin-printer-accessories' },
    { id: 'cat_pacc', slug: 'printer-accessories' },
  ]);
  assert.ok(flatFields(resinAcc).some((f) => f.id === 'capacity'));
});

/** The five fields «ملحقات الليزر» adds to the `parts` type. */
const LASER_ACC_FIELDS = ['laser_part_kind', 'focal_length', 'filter_life', 'rotary_max_diameter', 'work_surface_size'];

test('an ESP32 board is not asked a focal length: «إلكترونيات» and «قطع هاردوير» are on the accessory axis too', () => {
  // 0018 parents these two under «صناعة ومشاريع», not under «ملحقات
  // الطابعات» — but they are `parts` sections, so every group the type gains
  // reaches them. When «ملحقات الليزر» added `laser_acc` to the type, the
  // electronics sheet grew a focal length and a rotary-axis diameter, and it
  // had been carrying the resin wash-station capacity before that. Naming
  // them as zero-group leaves is the statement "neither a Resin nor a laser
  // accessory", which is what drops both.
  for (const [id, slug] of [['cat_makers_elec', 'electronics'], ['cat_makers_hw', 'hardware-parts']] as const) {
    const branch: SectionRef[] = [{ id, slug }];
    assert.equal(productTypeForBranch('devices', branch), 'parts', `${slug} is still «ملحقات وقطع»`);
    const shown = flatFields(groupsForSection('devices', branch)).map((f) => f.id);
    for (const f of LASER_ACC_FIELDS) assert.ok(!shown.includes(f), `${slug} is being asked for "${f}"`);
    assert.ok(!shown.includes('capacity'), `${slug} is being asked for a resin-tank capacity`);
    // Narrowing is not a synonym for hiding: their own groups are untouched.
    assert.deepEqual(groupsForSection('devices', branch).map((g) => g.id), [
      'acc_common', 'electronics', 'hardware', 'physical_core',
    ]);
  }

  // «ملحقات الليزر» keeps its own five, and the root «ملحقات الطابعات» keeps
  // the union, because a product filed straight under it has not said which.
  const laserAcc = flatFields(groupsForSection('devices', [{ id: 'cat_laser_acc', slug: 'laser-accessories' }])).map((f) => f.id);
  for (const f of LASER_ACC_FIELDS) assert.ok(laserAcc.includes(f), `"${f}" went missing from a laser accessory`);
  const root = flatFields(groupsForSection('devices', [{ id: 'cat_pacc', slug: 'printer-accessories' }])).map((f) => f.id);
  for (const f of LASER_ACC_FIELDS) assert.ok(root.includes(f), 'the root keeps the union — the branch has not said');
});

// ------------------------------------------- the dedupe runs after the filter

test('dropping a group hands its shared fields to the group that survives', () => {
  // `acc_common` and PHYSICAL_CORE both declare `material`; the first to claim
  // it keeps it. If the filter ran AFTER the dedupe, dropping a group would
  // take a field with it that a surviving group would happily have declared.
  const fdmAcc = groupsForSection('devices', [
    { id: 'cat_pacc_fdm', slug: 'fdm-printer-accessories' },
    { id: 'cat_pacc', slug: 'printer-accessories' },
  ]);
  const all = flatFields(fdmAcc).map((f) => f.id);
  assert.ok(all.includes('material'), 'the field survived the narrowing');
  assert.equal(all.filter((f) => f === 'material').length, 1, 'and it is not asked for twice');
});

// ------------------------------------ the sheet and the form show one thing

test('the import sheet narrows exactly as the form does', () => {
  const shape = templateShape('printer', ['fdm-printers', 'printers'], { branch: FDM_BRANCH });
  const columns = shape.specFields.map((f) => f.id);
  assert.deepEqual(columns, ids(FDM_BRANCH), 'a column the form will not show is a column an admin fills for nothing');
  for (const f of RESIN_FIELDS) assert.ok(!shape.columns.includes(`spec.${f}`));
});

test('a sheet asked for by TYPE alone keeps the union — no section was chosen', () => {
  const shape = templateShape('printer');
  assert.equal(shape.specFields.length, 76);
  assert.equal(flatFields(groupsForType('printer')).length, 76);
});

test('a section narrows within an explicitly requested type, and never overrules it', () => {
  // The admin asked for a `parts` sheet while standing in a section of that
  // type. The TYPE they typed wins — the branch may not re-pick it — but the
  // branch still drops what it can WITHIN it.
  //
  // The branch has to be one the type's own axis knows about, or the assertion
  // is vacuous: `FDM_BRANCH` excludes only the `resin` group, which `parts`
  // does not contain, so pairing those two would pass identically if
  // `narrowGroups` ignored its branch entirely.
  const fdmAccessory: SectionRef[] = [
    { id: 'cat_pacc_fdm', slug: 'fdm-printer-accessories' },
    { id: 'cat_pacc', slug: 'printer-accessories' },
  ];
  const full = groupsForType('parts');
  const narrowed = narrowGroups('parts', fdmAccessory);
  assert.ok(narrowed.length < full.length, 'the branch narrowed something');
  assert.ok(full.some((g) => g.id === 'acc_resin'), 'the type carries the resin-accessory group');
  assert.ok(!narrowed.some((g) => g.id === 'acc_resin'), 'and naming the FDM leaf drops it');
  assert.ok(!flatFields(narrowed).some((f) => f.id === 'capacity'));

  // The type is still `parts`, not the `printer` the branch's siblings imply.
  const resinPrinterBranch: SectionRef[] = [{ id: 'cat_printers_resin', slug: 'resin-printers' }];
  assert.deepEqual(
    narrowGroups('parts', resinPrinterBranch).map((g) => g.id),
    full.map((g) => g.id),
    'a printer-axis branch says nothing about the parts type, and never re-picks it'
  );
});

// ------------------------------------------------- the legacy slug-only entry

test('the slug-only `fieldsFor` narrows too, so no caller is left on the old behaviour', () => {
  assert.equal(flatFields(fieldsFor('devices', ['fdm-printers', 'printers'])).length, 62);
  assert.equal(flatFields(fieldsFor('devices', ['resin-printers', 'printers'])).length, 46);
  assert.equal(flatFields(fieldsFor('devices', ['printers'])).length, 76);
});


// ================================================== through the real endpoint
//
// Everything above is the resolver. This is the round trip ProductForm
// actually makes — `GET /api/admin/taxonomy/templates?category=<leaf>` — over
// the seeded taxonomy migration 0018 writes, because the seeded ids are the
// whole basis of the narrowing and a test that hand-writes them proves less.

const OWNER = { id: 'usr_owner', role: 'admin' as const, email: 'boss@x.co', admin_scope: null };

const taxonomyApp = () => {
  const raw = freshDb();
  return stubApp(asD1(raw), OWNER, (a) => a.route('/api/admin/taxonomy', adminTaxonomyRoutes));
};

const templateFor = async (categoryId: string) => {
  const app = taxonomyApp();
  const body = await json(await get(app, `/api/admin/taxonomy/templates?category=${categoryId}`));
  assert.equal(body.success, true, JSON.stringify(body));
  return body as {
    template_family: string;
    product_type: string;
    groups: Array<{ id: string; fields: Array<{ id: string }> }>;
    section_ids: string[];
  };
};

test('the endpoint ProductForm calls returns the FDM field set for the seeded FDM section', async () => {
  const body = await templateFor('cat_printers_fdm');
  assert.equal(body.template_family, 'devices');
  assert.equal(body.product_type, 'printer');
  assert.deepEqual(body.groups.map((g) => g.id), ['device_core', 'device_env', 'fdm', 'fdm_extrusion', 'fdm_motion', 'fdm_control']);
  const fields = body.groups.flatMap((g) => g.fields.map((f) => f.id));
  assert.equal(fields.length, 62);
  for (const f of RESIN_FIELDS) assert.ok(!fields.includes(f), `the form would still render "${f}"`);
  // Leaf first — the narrowing depends on it.
  assert.deepEqual(body.section_ids, ['cat_printers_fdm', 'cat_printers']);
});

test('and the Resin field set for the seeded Resin section, with no FDM fields', async () => {
  const body = await templateFor('cat_printers_resin');
  assert.deepEqual(body.groups.map((g) => g.id), ['device_core', 'device_env', 'resin', 'resin_motion']);
  const fields = body.groups.flatMap((g) => g.fields.map((f) => f.id));
  assert.equal(fields.length, 46);
  for (const f of FDM_FIELDS) assert.ok(!fields.includes(f));
});

test('a resin value on an FDM machine is PRESERVED, not deleted and not promoted', async () => {
  // The owner's rule: "do not delete old resin fields from the DB if present;
  // just don't show them as primary fields when the product is FDM — they may
  // be shown in preserved fields if they are genuinely legacy data."
  const body = await templateFor('cat_printers_fdm');
  const templateIds = body.groups.flatMap((g) => g.fields.map((f) => f.id));
  const stored = { technology: 'FDM', nozzle_temp_max: '300', lcd_size: '6.6', release_film: 'nFEP' };

  // Not primary fields...
  for (const id of ['lcd_size', 'release_film']) assert.ok(!templateIds.includes(id));
  // ...but the form still finds them, and shows them under «مواصفات محفوظة
  // خارج قالب هذا القسم» rather than dropping the value.
  assert.deepEqual(specIdsOutsideTemplate(stored, templateIds).sort(), ['lcd_size', 'release_film']);
  // The FDM value stays a first-class field.
  assert.deepEqual(specIdsOutsideTemplate({ nozzle_temp_max: '300' }, templateIds), []);
});
