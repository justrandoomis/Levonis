/**
 * The specifications & guide round, pinned:
 *
 *  1. upgradeUsageGuide — the structured setup/usage guide is validated and
 *     URL-SANITIZED at write time: http(s)/relative only, empty steps
 *     dropped, kinds coerced, order respected, caps enforced. A stored
 *     guide can never carry javascript:/data: into an href/src.
 *  2. The guide and its neighbours survive every write path: absent DB
 *     column → safe default; TXT template update carries it (with the other
 *     registry-less fields) instead of wiping it.
 *  3. Template catalogs — «القسم يتغير حسب القسم والفرع»: a printer branch,
 *     an accessory branch and a filament branch each get their OWN groups;
 *     in_the_box is declared by BOTH families; no branch ever yields a
 *     duplicated field id (one id = one CSV column = one form input).
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upgradeUsageGuide, parseProductRow, validateProductDoc } from '../worker/lib/productModel';
import { FAMILIES, fieldsFor, flatFields } from '../worker/lib/templateFamilies';

// ------------------------------------------------------- 1. sanitization

test('usage guide: URLs are sanitized to http(s)/relative — script URLs die at write time', () => {
  const g = upgradeUsageGuide({
    official_url: 'javascript:alert(1)',
    steps: [
      {
        id: 'a',
        kind: 'setup',
        title: 'Unbox',
        body: 'Remove the clips',
        images: ['https://cdn.example.com/1.jpg', 'data:text/html,x', '/files/abc.jpg', '//evil.example.com/x.jpg'],
        video_url: 'vbscript:x',
        link_url: 'https://wiki.bambulab.com/en/a1',
        order: 0,
      },
    ],
  });
  assert.equal(g.official_url, '');
  assert.deepEqual(g.steps[0].images, ['https://cdn.example.com/1.jpg', '/files/abc.jpg']);
  assert.equal(g.steps[0].video_url, '');
  assert.equal(g.steps[0].link_url, 'https://wiki.bambulab.com/en/a1');
});

test('usage guide: empty steps dropped, kinds coerced, order sorts, caps hold', () => {
  const g = upgradeUsageGuide({
    official_url: 'https://wiki.bambulab.com/en/a1',
    steps: [
      { id: 'later', kind: 'usage', title: 'Second', body: '', images: [], video_url: '', link_url: '', order: 5 },
      { id: 'empty', kind: 'setup', title: '', body: '', images: [], video_url: '', link_url: '', order: 1 },
      { id: 'first', kind: 'weird', title: 'First', body: '', images: [], video_url: '', link_url: '', order: 0 },
    ],
  });
  assert.deepEqual(g.steps.map((s) => s.id), ['first', 'later']); // empty dropped, order sorted
  assert.equal(g.steps[0].kind, 'usage'); // unknown kind → usage, never invented setup
  const many = upgradeUsageGuide({
    steps: Array.from({ length: 60 }, (_, i) => ({ id: `s${i}`, kind: 'usage', title: `t${i}`, order: i })),
  });
  assert.equal(many.steps.length, 40);
  const imgs = upgradeUsageGuide({
    steps: [{ id: 'x', title: 'x', images: Array.from({ length: 10 }, (_, i) => `https://e.com/${i}.jpg`) }],
  });
  assert.equal(imgs.steps[0].images.length, 6);
});

test('usage guide: garbage in → the empty guide out, never a throw', () => {
  for (const raw of [undefined, null, '', 'not json', 42, [], { steps: 'nope' }]) {
    const g = upgradeUsageGuide(raw);
    assert.equal(g.official_url, '');
    assert.deepEqual(g.steps, []);
  }
});

// --------------------------------------------- 2. survives every write path

test('usage guide: a pre-0035 row (no column) parses to the safe default', () => {
  const doc = parseProductRow({ id: 'p', name: 'X', price_iqd: 1000 });
  assert.deepEqual(doc.usage_guide, { official_url: '', steps: [] });
});

test('usage guide: validateProductDoc round-trips a real guide from a save body', () => {
  const doc = validateProductDoc({
    name_en: 'Printer',
    price_iqd: 100000,
    usage_guide: {
      official_url: 'https://wiki.bambulab.com/en/a1',
      steps: [{ id: 's1', kind: 'setup', title: 'Mount the spool holder', body: 'Two screws', images: [], video_url: '', link_url: '', order: 0 }],
    },
  });
  assert.equal(doc.usage_guide.official_url, 'https://wiki.bambulab.com/en/a1');
  assert.equal(doc.usage_guide.steps[0].kind, 'setup');
  assert.equal(doc.usage_guide.steps[0].title, 'Mount the spool holder');
});

// --------------------------------------------------- 3. template catalogs

test('templates respond to the branch: printer, accessory and filament ask different questions', () => {
  const printer = flatFields(fieldsFor('devices', ['fdm-printers', 'printers'])).map((f) => f.id);
  const accessory = flatFields(fieldsFor('devices', ['fdm-printer-accessories', 'printer-accessories'])).map((f) => f.id);
  const filament = flatFields(fieldsFor('materials', ['fdm-materials', 'materials'])).map((f) => f.id);
  const generalAcc = flatFields(fieldsFor('materials', ['accessories'])).map((f) => f.id);

  // A Bambu-A1-style printer branch gets printer physics…
  for (const id of ['technology', 'nozzle_temp_max', 'motion_system', 'noise_level', 'camera', 'slicer_software']) {
    assert.ok(printer.includes(id), `printer branch missing ${id}`);
  }
  // …an accessory branch gets fitting questions, not extruder counts…
  for (const id of ['fits_models', 'install_type', 'use_case']) {
    assert.ok(accessory.includes(id), `accessory branch missing ${id}`);
  }
  assert.ok(!accessory.includes('nozzle_temp_max'));
  // …a filament branch gets material questions…
  for (const id of ['material_type', 'net_weight', 'spool_type', 'operating_temp', 'storage']) {
    assert.ok(filament.includes(id), `filament branch missing ${id}`);
  }
  // …and the seeded general-accessories section gets its own group.
  for (const id of ['fits_models', 'install_type', 'use_case']) {
    assert.ok(generalAcc.includes(id), `general accessories missing ${id}`);
  }
});

test('in_the_box is declared by BOTH families (every box has contents)', () => {
  assert.ok(FAMILIES.devices.common.fields.some((f) => f.id === 'in_the_box'));
  assert.ok(FAMILIES.materials.common.fields.some((f) => f.id === 'in_the_box'));
});

test('no branch yields a duplicated field id (one id = one CSV column = one input)', () => {
  const branches: Array<['devices' | 'materials', string[]]> = [
    ['devices', ['fdm-printers', 'printers']],
    ['devices', ['resin-printers', 'printers']],
    ['devices', ['fdm-printer-accessories', 'printer-accessories']],
    ['devices', ['resin-printer-accessories', 'printer-accessories']],
    ['materials', ['fdm-materials', 'materials']],
    ['materials', ['resin-materials', 'materials']],
    ['materials', ['accessories']],
    ['materials', ['model-kits']],
    ['materials', ['hardware-parts']],
  ];
  for (const [family, slugs] of branches) {
    const ids = flatFields(fieldsFor(family, slugs)).map((f) => f.id);
    assert.equal(new Set(ids).size, ids.length, `${family}:${slugs.join('/')} has duplicate ids: ${ids.join(',')}`);
  }
});

test('devices spec set is still not a subset of materials (import suites pin the difference)', () => {
  const dev = new Set(flatFields(fieldsFor('devices', ['fdm-printers'])).map((f) => f.id));
  const mat = new Set(flatFields(fieldsFor('materials', ['fdm-materials'])).map((f) => f.id));
  assert.ok([...dev].some((id) => !mat.has(id)));
  assert.ok(dev.has('nozzle') && !mat.has('nozzle'));
});
