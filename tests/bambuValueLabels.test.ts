/**
 * REVIEWED VALUE LABELS (Bambu import owner-questions §E.1, owner question
 * P0-11; spec §C.2, §C.4, §C.10).
 *
 * The AMS 2 Pro (audit class, queue position 4) offers a units value whose
 * source wording the sentence classifier refuses as a promotion. Its manifest
 * row carries a reviewed neutral label (ar / en / ckb), and the builder
 * receives the row as `manifestRow`: the label replaces the value's DISPLAY
 * names after the ids, the variant_key and the SKU join are computed from the
 * source, and before media binding — so the names, the variant label, the
 * value's source label and the alt text of every image row whose selection
 * names the value all carry it, and no payload string keeps the source wording.
 *
 * The page is the real one, trimmed (tests/fixtures/bambu/ams-2-pro.page.html,
 * ≤ 200 KB; its payload equals the full page's); the manifest row is the real
 * P0 row.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertImportPayload, buildImportPayload, ImportPayloadRefused, type BuildInputs, type ManifestRowInput } from '../packages/catalog/src/bambuImport/payload';
import { buildOptions, newProductId, sourceTextOf, valueIdOf, variantKeyOf, type ReviewedValueLabel } from '../packages/catalog/src/bambuImport/options';
import { extractionFingerprint } from '../packages/catalog/src/bambuImport/fingerprint';
import type { Extraction } from '../packages/catalog/src/bambuImport/extract';
import { fixtureJson, pageOf, sample } from './fixtures/bambu/load';

const VALUE = '758126084595167233'; // the refused units value of ams-2-pro
const row = fixtureJson<ManifestRowInput & { value_labels: Record<string, ReviewedValueLabel> }>('ams-2-pro.manifest-row.json');
const label = row.value_labels[VALUE];

const build = (x: Extraction, extra: Partial<BuildInputs> = {}) =>
  buildImportPayload({ extraction: x, writeMode: 'create', extractionSha256: extractionFingerprint(x), targets: null, retrievedAt: '2026-10-15T00:00:00Z', ...extra });

const refusal = (p: unknown): ImportPayloadRefused | null => {
  try {
    assertImportPayload(JSON.parse(JSON.stringify(p)));
    return null;
  } catch (e) {
    if (e instanceof ImportPayloadRefused) return e;
    throw e;
  }
};

/** Every string of a value, at any depth. */
const strings = (v: unknown, out: string[] = []): string[] => {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, out);
  return out;
};

test('the fixture is the real page: its own source wording for the value is refused without the reviewed label', () => {
  const x = pageOf('ams-2-pro').extraction;
  assert.equal(x.handle, 'ams-2-pro');
  assert.equal(x.sourceProductId, row.source_product_id);
  const r = refusal(build(x).payload);
  assert.ok(r, 'without the label the payload must be refused');
  assert.deepEqual([r!.path.replace(/\[\d+\]/g, '[]'), r!.reason, r!.textClass], ['$.groups[].values[].name_en', 'refused_text', 'promotion']);
});

test('with the manifest row the whole payload passes, the 15 variants survive and no string keeps the source wording', () => {
  const x = pageOf('ams-2-pro').extraction;
  const sourceWords = x.groups.flatMap((g) => g.values).find((v) => v.id === VALUE)!.value;
  const res = build(x, { manifestRow: row });
  assert.deepEqual(res.report.errors, []);
  assert.equal(refusal(res.payload), null, 'assertImportPayload accepts the whole payload');
  const p = res.payload;
  assert.equal(p.variants.length, 15);
  assert.equal(p.groups.reduce((n, g) => n + g.values.length, 0), 13);
  for (const s of strings(p)) assert.ok(!s.toLowerCase().includes(sourceWords.toLowerCase()), 'a payload string keeps the refused source wording');
  assert.ok(!JSON.stringify(p).includes('PLANTED-'), 'a planted forbidden value reached the payload');

  // The value: names, variant label and source label carry the reviewed label.
  const v = p.groups.flatMap((g) => g.values).find((val) => val.source_id === VALUE)!;
  assert.deepEqual([v.name_en, v.name_ar, v.name_ckb, v.variant_label], [label.name_en, label.name_ar, label.name_ckb, label.name_en]);
  assert.equal(p.source_refs.find((s) => s.kind === 'value' && s.source_id === VALUE)?.source_label, label.name_en);

  // Every image row whose selection names the value carries the label in all three alt texts (3 rows on this page).
  const named = p.images.filter((im) => im.option_value_id === v.id || p.variants.find((vr) => vr.id === im.variant_id)?.value_ids.includes(v.id));
  assert.equal(named.length, 3);
  for (const im of named) {
    assert.ok(im.alt_en.endsWith(label.name_en), im.alt_en);
    assert.ok(im.alt_ar.startsWith('صورة ') && im.alt_ar.endsWith(label.name_ar), im.alt_ar);
    assert.ok(im.alt_ckb.startsWith('وێنەی ') && im.alt_ckb.endsWith(label.name_ckb), im.alt_ckb);
  }
});

test('ids, variant keys and the SKU join come from the source, before the label', () => {
  const x = pageOf('ams-2-pro').extraction;
  const plain = build(x).payload;
  const labelled = build(x, { manifestRow: row }).payload;
  // Same value ids, variant keys, variants and combinations: only display strings differ.
  assert.deepEqual(labelled.groups.map((g) => g.values.map((v) => [v.id, v.variant_key])), plain.groups.map((g) => g.values.map((v) => [v.id, v.variant_key])));
  assert.deepEqual(labelled.variants, plain.variants);
  const src = x.groups.find((g) => g.values.some((v) => v.id === VALUE))!;
  const productId = newProductId(x.sourceProductId);
  const v = labelled.groups.flatMap((g) => g.values).find((val) => val.source_id === VALUE)!;
  assert.equal(v.id, valueIdOf(productId, src.propertyKeyId, src.values.find((s) => s.id === VALUE)!.value));
  assert.equal(v.variant_key, variantKeyOf(VALUE));
  // The model keeps the source text for matching, and marks the value as labelled.
  const model = buildOptions(x, productId, { valueLabels: row.value_labels });
  const mv = model.groups.flatMap((g) => g.values).find((val) => val.sourceId === VALUE)!;
  assert.equal(sourceTextOf(mv), src.values.find((s) => s.id === VALUE)!.value);
  assert.equal(mv.labelled, true);
  assert.equal(model.hold, '');
});

test('a label that cannot be applied as written is an error; one whose value the page lacks is a note', () => {
  const x = sample('ams-2-pro.options');
  const productId = newProductId(x.sourceProductId);
  const errorsOf = (labels: Record<string, Partial<ReviewedValueLabel>>) =>
    buildOptions(x, productId, { valueLabels: labels as Record<string, ReviewedValueLabel> }).errors.filter((e) => e.code === 'VALUE_LABEL_INVALID');
  assert.equal(errorsOf({ [VALUE]: { ...label, name_ckb: label.name_ar } }).length, 1, 'ckb copies ar (DECISIONS row 183)');
  assert.equal(errorsOf({ [VALUE]: { ...label, name_ckb: '' } }).length, 1, 'a language is missing');
  assert.equal(errorsOf({ [VALUE]: { ...label, group_source_id: '644350794219778049' } }).length, 1, 'labelled for another group');
  assert.equal(errorsOf({ [VALUE]: { ...label, name_en: 'Connect 1 AMS 2 Pro unit' } }).length, 1, 'shows the name of another value of its group');
  assert.equal(errorsOf({ [VALUE]: { ...label, name_en: 'x'.repeat(201) } }).length, 1, 'longer than the payload allows');
  assert.deepEqual(errorsOf({ [VALUE]: label }), []);
  const unused = buildOptions(x, productId, { valueLabels: { '1': label } });
  assert.deepEqual(unused.errors, []);
  assert.deepEqual(unused.notes.filter((n) => n.code === 'VALUE_LABEL_UNUSED').map((n) => n.detail), ['value 1']);
  // An invalid label is not applied: the value keeps its source names.
  const bad = buildOptions(x, productId, { valueLabels: { [VALUE]: { ...label, name_ckb: label.name_ar } } });
  const v = bad.groups.flatMap((g) => g.values).find((val) => val.sourceId === VALUE)!;
  assert.equal(v.nameEn, sourceTextOf(v));
  assert.ok(!v.labelled);
});

test('the manifest row applies only to the product it names; it also carries the frozen SKU codes', () => {
  const x = sample('ams-2-pro.options');
  const other = build(x, { manifestRow: { ...row, source_product_id: '1', handle: 'another-product' } });
  assert.deepEqual(other.report.errors, ['IDENTITY_AMBIGUOUS']);
  assert.ok(!other.model.groups.some((g) => g.values.some((v) => v.labelled)), 'a row naming another product applies nothing');
  const sku = x.skus[0].id;
  const coded = build(x, { manifestRow: { ...row, sku_codes: { [sku]: 'SA001' } }, skuCodes: { [sku]: 'IGNORED' } }).payload;
  assert.deepEqual(coded.external_ids.filter((e) => e.id_type === 'bambu_sku_code').map((e) => e.value), ['SA001']);
  const legacy = build(x, { skuCodes: { [sku]: 'SA002' } }).payload;
  assert.deepEqual(legacy.external_ids.filter((e) => e.id_type === 'bambu_sku_code').map((e) => e.value), ['SA002']);
});

test('relations look a labelled value up by its source words; a label kept as unresolvable text is the reviewed one', async () => {
  const { buildRelations } = await import('../packages/catalog/src/bambuImport/relations');
  const { describe } = await import('../packages/catalog/src/bambuImport/describe');
  const x = sample('bambu-textured-pei-plate');
  const idOf = (text: string) => x.groups.flatMap((g) => g.values).find((v) => v.value === text)!.id;
  const labels: Record<string, ReviewedValueLabel> = {
    [idOf('H2C')]: { name_en: 'H2C printer', name_ar: 'طابعة H2C', name_ckb: 'چاپکەری H2C' },
    [idOf('A2L')]: { name_en: 'A2L printer', name_ar: 'طابعة A2L', name_ckb: 'چاپکەری A2L' },
  };
  const productId = newProductId(x.sourceProductId);
  const model = buildOptions(x, productId, { valueLabels: labels });
  const r = buildRelations({
    productId,
    handle: x.handle,
    model,
    described: describe(x.description),
    relationBullets: [],
    targets: { version: 1, labels: { H2C: { kind: 'printer', to: { source_handle: 'h2c' } } } },
  });
  const h2c = r.rows.filter((row) => row.targetSourceHandle === 'h2c');
  assert.equal(h2c.length, 1, 'the source words "H2C" still resolve through compat-targets.json');
  assert.equal(h2c[0].evidenceText.endsWith(': H2C printer'), true, h2c[0].evidenceText);
  const a2l = r.rows.filter((row) => row.scopeId === model.groups[0].values.find((v) => v.sourceId === idOf('A2L'))!.id);
  assert.deepEqual(a2l.map((row) => [row.state, row.targetLabel]), [['unresolvable', 'A2L printer']]);
});

/**
 * A BOX SECTION TITLED IN THE SOURCE'S WORDS (review 5, finding 6): the
 * "<value> Add-ons" rule scopes a section to the value its title names, and
 * that title is the very wording the reviewed label replaces. The row's label
 * and locator carry it only as the classifier keeps it, so the payload passes.
 */
test('a value-scoped box section titled in the refused source words: scoped, and no row keeps the wording', () => {
  const base = pageOf('ams-2-pro').extraction;
  const x: Extraction = {
    ...base,
    description: { kind: 'sections_html', sections: [{ id: '1', name: 'Bundle Deals Add-ons', html: '<ul><li>AMS 2 Pro Hub x1</li><li>PTFE Tube x2</li></ul>' }] },
  };
  const res = build(x, { manifestRow: row });
  assert.deepEqual(res.report.errors, []);
  const vId = res.payload.groups.flatMap((g) => g.values).find((v) => v.source_id === VALUE)!.id;
  const box = res.payload.specs.find((s) => s.key === 'package.contents' && s.scope_id === vId);
  assert.ok(box, 'the section is scoped to the labelled value');
  assert.equal(box!.original_label, 'In the box');
  assert.equal(refusal(res.payload), null);
  assert.ok(!strings(res.payload).some((s) => /Bundle Deals/i.test(s)), 'no payload string keeps the refused wording');
});
