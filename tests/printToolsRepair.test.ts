/**
 * Two calculator screens that must not lose what the person just did.
 *
 *   * THE PRINTER EDITOR keeps figures typed on other cards when one card is
 *     saved: the reload after a save refills only the saved model.
 *   * THE GRAMS DOOR answers a printer change the way the file door does:
 *     it prices the same job again and keeps the previous printer's figure,
 *     and shows that comparison only between two answers to the same job.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { draftsAfterLoad } from '../src/components/adminCommunity/PrinterModelsEditor';
import { pricedJob } from '../src/components/tools/GramsQuotePanel';

const fields = [{ column: 'purchase_iqd' }, { column: 'useful_print_hours' }];

test('saving one printer keeps the unsaved figures typed on the others', () => {
  const prev = {
    'bbl-x1c': { purchase_iqd: '1500000', useful_print_hours: '5000' },
    'bbl-h2d': { purchase_iqd: '2400000', useful_print_hours: '' }, // typed, not saved
  };
  const models = [
    { id: 'bbl-x1c', purchase_iqd: 1500000, useful_print_hours: 5000 },
    { id: 'bbl-h2d', purchase_iqd: null, useful_print_hours: null },
    { id: 'bbl-a1', purchase_iqd: null, useful_print_hours: null },
  ];
  const after = draftsAfterLoad(prev, models, fields, 'bbl-x1c');
  assert.deepEqual(after['bbl-h2d'], { purchase_iqd: '2400000', useful_print_hours: '' }, 'the H2D figure survived the X1C save');
  assert.deepEqual(after['bbl-x1c'], { purchase_iqd: '1500000', useful_print_hours: '5000' });
  assert.deepEqual(after['bbl-a1'], { purchase_iqd: '', useful_print_hours: '' }, 'a model with no draft is filled from the server');

  // The first load (no saved id) fills every card from the server.
  assert.deepEqual(draftsAfterLoad(prev, models, fields)['bbl-h2d'], { purchase_iqd: '', useful_print_hours: '' });
});

test('the editor reloads with the saved id, not a bare reload', () => {
  const src = readFileSync(join(ROOT, 'src/components/adminCommunity/PrinterModelsEditor.tsx'), 'utf8');
  assert.match(src, /await load\(m\.id\);/);
  assert.match(src, /setDrafts\(\(prev\) => draftsAfterLoad\(prev, res\.models, res\.fields, savedId\)\)/);
});

test('the grams door re-prices on a printer change and keeps the previous figure', () => {
  const src = readFileSync(join(ROOT, 'src/components/tools/GramsQuotePanel.tsx'), 'utf8');
  const onChange = src.slice(src.indexOf('id="grams-printer"'), src.indexOf('{printers.map((p) => ('));
  assert.match(onChange, /setComparison\(\{ name: `\$\{printer\.manufacturer\} \$\{printer\.model\}`, price: priced\.quote\.price_iqd/);
  assert.match(onChange, /setAutoRecalc\(true\)/);
  assert.match(src, /setAutoRecalc\(false\);\s*void submit\(\);/);
  assert.match(src, /comparison && comparison\.job === pricedJob\(result\)/);
});

test('a comparison is only between answers to the same job', () => {
  const base = {
    rows: [{ material_id: 'pla', material_type: 'PLA', color_hex: '#000000', grams: 100 }],
    print_minutes: 180,
    accessories: [],
  };
  assert.equal(pricedJob(base), pricedJob({ ...base }));
  assert.notEqual(pricedJob(base), pricedJob({ ...base, print_minutes: 120 }));
  assert.notEqual(pricedJob(base), pricedJob({ ...base, rows: [{ ...base.rows[0], material_id: 'petg' }] }));
});
