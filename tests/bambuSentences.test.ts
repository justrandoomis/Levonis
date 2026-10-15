/**
 * THE SENTENCE CLASSIFIER (Bambu import spec §C.10 golden sentences).
 *
 * Every sentence of every prose field is labelled: money, promotion and US
 * shipping-policy sentences are removed; warranty / return / refund sentences
 * are withheld from customers (kept owner-only, L-19); voltage purchase
 * advice is region evidence. Technical text that merely contains a number or
 * a temperature is kept. Hits are counts, never text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySentence, refusedClassOf, scrubProse, splitSentences } from '../packages/catalog/src/bambuImport/sentences';
import { buildImportPayload } from '../packages/catalog/src/bambuImport/payload';
import { extractionFingerprint } from '../packages/catalog/src/bambuImport/fingerprint';
import { sample, type SampleHandle } from './fixtures/bambu/load';

const KEPT = [
  'Prints come off easily when the temperature of the heatbed reaches room temperature, and we always recommend waiting until it reaches 35℃ or lower.',
  'A: No,they aren\'t. A1 3D printers sold after January 30, 2024 are not from the same batch as those recalled before.',
  'They already contain all the necessary fixes to mitigate the heatbed cable issue which caused the recall.',
  'Max Speed of Tool Head 500mm/s',
  'Diameter: 1.75mm +/- 0.03mm',
  'Supports up to 4 AMS units with 16 colours.',
];
const REMOVED: Array<[string, 'money' | 'promotion' | 'shipping_policy']> = [
  ['30-day price protection, 2-year warranty & 30-day returns at official store.', 'money'],
  ['Add only $50 to the A1 Combo for the AMS lite.', 'money'],
  ['Now US$399 at the official store.', 'money'],
  ['Check out our Multi-Size Hotends Kit for an exclusive bundle discount.', 'promotion'],
  ['Save on officially refurbished Bambu Lab H2D.', 'promotion'],
  ['Get 10% off with code SPRING.', 'promotion'],
  ['Free shipping on orders over a threshold.', 'promotion'],
  ['Packaging may vary, shipping costs are the same for all orders placed at the same time.', 'shipping_policy'],
];
const WITHHELD = [
  'The warranty will only cover manufacturing defects, not cosmetic damage like scratches, dents, or cracks.',
  'Defective sheets upon arrival are the only ones covered by the warranty.',
  '2-year warranty & 30-day returns.',
  'Refunds are processed within 14 days.',
];

test('golden sentences: kept, removed, withheld', () => {
  for (const s of KEPT) assert.equal(classifySentence(s), 'keep', s);
  for (const [s, c] of REMOVED) assert.equal(classifySentence(s), c, s);
  for (const s of WITHHELD) assert.equal(classifySentence(s), 'warranty', s);
  assert.equal(classifySentence("Please purchase the version corresponding to your region's voltage."), 'region');
});

test('sentences split at boundaries, not at decimals or inside a sentence', () => {
  assert.deepEqual(splitSentences('Diameter 1.75 mm. Tolerance 0.03 mm! Done'), ['Diameter 1.75 mm.', 'Tolerance 0.03 mm!', 'Done']);
  assert.deepEqual(splitSentences('Line one\nLine two.'), ['Line one', 'Line two.']);
});

test('scrubProse keeps the technical sentences, counts the rest and withholds warranty text', () => {
  const text =
    'Full-size multi-color 3D printer. Print-ready, no tuning. 2M+ free models. 30-day price protection, 2-year warranty & 30-day returns at official store.\n' +
    'The warranty will only cover manufacturing defects, not cosmetic damage like scratches, dents, or cracks. Prints come off easily when cooled.';
  const r = scrubProse(text);
  assert.equal(r.kept, 'Full-size multi-color 3D printer. Print-ready, no tuning. 2M+ free models.\nPrints come off easily when cooled.');
  assert.deepEqual(r.counts, { money: 1, promotion: 0, shipping_policy: 0, warranty: 1, region: 0 });
  assert.equal(r.withheld.length, 1);
  assert.equal(refusedClassOf(r.kept), null);
  assert.equal(refusedClassOf(text), 'money');
});

test('on the fixtures: removed sentences never reach the payload, withheld ones only an owner row', () => {
  const build = (h: SampleHandle) => {
    const x = sample(h);
    return buildImportPayload({ extraction: x, writeMode: 'create', extractionSha256: extractionFingerprint(x), targets: null, retrievedAt: '2026-10-15T00:00:00Z' }).payload;
  };
  const checks: Array<[SampleHandle, string[]]> = [
    ['a1', ['price protection']],
    ['h2d', ['price protection', 'Packaging may vary', 'shipping costs']],
    ['bambu-hotend-a1-a2', ['exclusive bundle discount']],
    ['refurbished-bambu-lab-h2d-3d-printer', ['Save on officially refurbished']],
  ];
  for (const [h, gone] of checks) {
    const json = JSON.stringify(build(h));
    for (const g of gone) assert.ok(!json.includes(g), `${h}: "${g}" reached the payload`);
  }
  const plate = build('bambu-textured-pei-plate');
  const publicText = JSON.stringify({ ...plate, specs: plate.specs.filter((s) => s.visibility === 'public') });
  assert.ok(publicText.includes('Prints come off easily'), 'the technical sentence is kept');
  assert.ok(!publicText.includes('The warranty will only cover'), 'the warranty sentence is not public');
  const note = plate.specs.find((s) => s.key === 'manufacturer_terms.warranty_note');
  assert.ok(note && note.visibility === 'owner' && note.value_text.includes('The warranty will only cover'), 'withheld, owner-only (L-19)');
  assert.ok(plate.notes.some((n) => n.kind === 'sentence_withheld'));
});
