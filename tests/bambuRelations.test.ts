/**
 * RELATIONS FROM EVIDENCE ONLY (Bambu import spec §B.6).
 *
 * A relation exists only because the source names its target, and a label
 * resolves only through the reviewed compat-targets file: a manifest handle
 * (pending until that product is written), an existing Levonis product
 * (resolved at once), a family (one row per member), a compound (its atoms,
 * and `not_atoms` as not_compatible_with). A reviewed-unresolvable label
 * writes nothing; any other unknown label is kept as `unresolvable` with a
 * relation_unresolvable note. Name similarity never creates a relation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRelations, compatLabelReviewed, entryTargetsFor, type CompatTargets } from '../packages/catalog/src/bambuImport/relations';
import { buildOptions, newProductId } from '../packages/catalog/src/bambuImport/options';
import { describe } from '../packages/catalog/src/bambuImport/describe';
import { fixtureJson, sample } from './fixtures/bambu/load';

const TARGETS: CompatTargets = {
  version: 1,
  labels: {
    H2D: { kind: 'family', family: 'model_h2d', members: [{ source_handle: 'h2d' }, { source_handle: 'refurbished-bambu-lab-h2d-3d-printer' }] },
    H2C: { kind: 'printer', to: { source_handle: 'h2c' } },
    'A1 mini': { kind: 'printer', to: { source_handle: 'a1-mini' } },
    A1: { kind: 'printer', to: { source_handle: 'a1' } },
    'X1 Series': { kind: 'family', family: 'x1_series', members: [{ levonis_product_id: 'prod_x1c' }, { levonis_product_id: 'prod_x1e' }] },
    X1C: { kind: 'printer', to: { levonis_product_id: 'prod_x1c' } },
    X1E: { kind: 'printer', to: { levonis_product_id: 'prod_x1e' } },
    'P1 Series': { kind: 'family', family: 'p1_series', members: [{ source_handle: 'p1s' }, { levonis_model: 'P1P', levonis_product_id: null }] },
    'All AMS Series': { kind: 'family', family: 'ams_series', members: [{ source_handle: 'ams-2-pro' }, { source_handle: 'ams-lite' }] },
  },
  compounds: { 'X1 and X1C (not for X1E)': { atoms: ['X1C'], not_atoms: ['X1E'], relation: 'compatible_with' } },
  reviewed_unresolvable: { '0.2 mm Nozzle': { reason: 'component_concept_not_a_product' } },
  requirement_targets: { spool: { kind: 'spool', to: { source_handle: 'bambu-reusable-spool' } } },
};

function plate() {
  const x = sample('bambu-textured-pei-plate');
  const productId = newProductId(x.sourceProductId);
  return { x, productId, model: buildOptions(x, productId), described: describe(x.description) };
}

test('option values naming printers: pending on a handle, one row per family member, never a guess', () => {
  const { x, productId, model, described } = plate();
  const r = buildRelations({ productId, handle: x.handle, model, described, relationBullets: [], targets: TARGETS });
  const by = (label: string) => r.rows.filter((row) => row.targetLabel === label);
  assert.deepEqual(by('H2C').map((row) => [row.state, row.targetSourceHandle, row.scopeKind, row.evidenceKind]), [['pending', 'h2c', 'option_value', 'option_value']]);
  assert.deepEqual(by('H2D').map((row) => [row.targetSourceHandle, row.targetFamily]).sort(), [['h2d', 'model_h2d'], ['refurbished-bambu-lab-h2d-3d-printer', 'model_h2d']]);
  assert.deepEqual(by('X1 Series').map((row) => [row.state, row.targetProductId]).sort(), [['resolved', 'prod_x1c'], ['resolved', 'prod_x1e']]);
  // "A1" is the A1, never the A1 mini; the A1 mini value is its own label.
  assert.deepEqual(by('A1').map((row) => row.targetSourceHandle), ['a1']);
  assert.deepEqual(by('A1 mini').map((row) => row.targetSourceHandle), ['a1-mini']);
  // A member with no resolvable id yet is a note, never an invented row.
  assert.ok(by('P1 Series').every((row) => row.targetSourceHandle === 'p1s'));
  assert.ok(r.notes.some((n) => n.detail.includes('family member')));
  // Labels the file does not list are kept, unresolvable, with a note.
  for (const label of ['A2L', 'X2D', 'P2S', 'H2S']) {
    assert.deepEqual(by(label).map((row) => [row.state, row.targetProductId]), [['unresolvable', null]], label);
  }
  for (const row of r.rows) {
    assert.match(row.id, /^pr_[0-9a-f]{24}$/);
    assert.equal(row.state === 'resolved', row.targetProductId !== null, 'resolved ⇔ a target product (0194 CHECK)');
  }
  assert.equal(new Set(r.rows.map((row) => row.id)).size, r.rows.length);
});

test('feature bullets, compounds, requirements and reviewed-unresolvable labels', () => {
  const { productId, model } = plate();
  const r = buildRelations({
    productId,
    handle: 'pla-basic-filament',
    model: { ...model, groups: [] },
    described: {
      format: 'legacy_html',
      sections: [
        { kind: 'compat', title: 'Compatibility', path: 'html › 1', blocks: [{ t: 'text', text: 'Works with X1 and X1C (not for X1E).' }, { t: 'text', text: '0.2 mm Nozzle NOT Compatible' }] },
        { kind: 'overview', title: 'Notes', path: 'html › 2', blocks: [{ t: 'text', text: 'The refill needs to be used with a spool.' }] },
      ],
      documents: [], wikiLinks: [], trackerLinks: [], videos: [], otherLinks: [], storeLinks: [], specPairs: [],
    },
    relationBullets: ['All AMS Series Compatible'],
    targets: TARGETS,
  });
  const rows = r.rows.map((row) => [row.relation, row.targetLabel, row.targetSourceHandle || row.targetProductId, row.evidenceKind]);
  assert.deepEqual(rows.filter((x) => x[1] === 'All AMS Series').map((x) => x[2]).sort(), ['ams-2-pro', 'ams-lite']);
  assert.ok(rows.some((x) => x[0] === 'compatible_with' && x[2] === 'prod_x1c' && x[3] === 'compat_section'));
  assert.ok(rows.some((x) => x[0] === 'not_compatible_with' && x[2] === 'prod_x1e'), 'not_atoms are not compatible');
  assert.ok(rows.some((x) => x[0] === 'requires' && x[2] === 'bambu-reusable-spool' && x[3] === 'description_text'));
  assert.ok(!rows.some((x) => /nozzle/i.test(String(x[1]))), 'a reviewed-unresolvable label writes no row');
  assert.deepEqual(r.reviewedSkipped, ['0.2 mm Nozzle']);
});

test('a product is never related to itself, and without the reviewed file every label is unresolvable', () => {
  const { productId, model, described } = plate();
  const self = buildRelations({ productId, handle: 'h2c', model, described, relationBullets: [], targets: TARGETS });
  assert.ok(!self.rows.some((row) => row.targetSourceHandle === 'h2c'));
  const none = buildRelations({ productId, handle: 'x', model, described, relationBullets: [], targets: null });
  assert.ok(none.rows.length > 0 && none.rows.every((row) => row.state === 'unresolvable'));
});

// ---------------------------------------------------------------- the real reviewed file (P0 DRAFT, owner-questions §E.2, §E.9)

/**
 * "A1 SERIES" PER SUBJECT (owner-questions §E.2, owner question P0-1). The
 * reviewed entry has no `to` and no top-level `members` on purpose: whether
 * the A1 mini is in the A1 Series depends on the product that names it, so
 * relations.ts reads `by_subject[<subject handle>].members` first and
 * `default.members` otherwise. One subject of each basis, on the real file.
 */
const REAL = fixtureJson<CompatTargets>('compat-targets.json');

function relationsOf(h: Parameters<typeof sample>[0]) {
  const x = sample(h);
  const productId = newProductId(x.sourceProductId);
  const model = buildOptions(x, productId, { isReviewedTarget: (label) => compatLabelReviewed(REAL, label) });
  return { x, model, r: buildRelations({ productId, handle: x.handle, model, described: describe(x.description), relationBullets: [], targets: REAL }) };
}
const a1SeriesTargets = (rows: ReturnType<typeof buildRelations>['rows']) =>
  [...new Set(rows.filter((row) => row.targetLabel === 'A1 Series').map((row) => `${row.state}:${row.targetSourceHandle}:${row.targetFamily}`))].sort();

test('the real "A1 Series" entry has no `to` and no top-level members: it resolves only per subject', () => {
  const entry = REAL.labels['A1 Series'];
  assert.equal(entry.to, undefined);
  assert.equal(entry.members, undefined);
  assert.ok(entry.by_subject && entry.default);
  assert.equal(entry.by_subject!['bambu-hotend-a1-a2'].basis, 'includes_a1_mini');
  assert.equal(entry.by_subject!['ams-2-pro'].basis, 'excludes_a1_mini');
  assert.equal(entry.by_subject!['cyberbrick-timelapse-kit'], undefined, 'a subject on the default');
  assert.deepEqual(entryTargetsFor(entry, 'no-such-subject').members, entry.default!.members);
});

test('includes: bambu-hotend-a1-a2 names "A1 Series" in its compatibility section — the A1, the refurbished A1 and the A1 mini', () => {
  const { r } = relationsOf('bambu-hotend-a1-a2');
  assert.deepEqual(a1SeriesTargets(r.rows), ['pending:a1-mini:a1_series', 'pending:a1:a1_series', 'pending:refurbished-a1:a1_series']);
  assert.ok(!r.rows.some((row) => row.targetLabel === 'A1 Series' && row.state === 'unresolvable'));
});

test('excludes: the AMS 2 Pro printer question offers "A1 Series" — the A1 and the refurbished A1, never the A1 mini', () => {
  const { r, model } = relationsOf('ams-2-pro.options');
  assert.deepEqual(a1SeriesTargets(r.rows), ['pending:a1:a1_series', 'pending:refurbished-a1:a1_series']);
  const a1Series = model.groups.flatMap((g) => g.values).find((v) => v.nameEn === 'A1 Series')!;
  assert.ok(r.rows.filter((row) => row.targetLabel === 'A1 Series').every((row) => row.scopeKind === 'option_value' && row.scopeId === a1Series.id));
  const plate = relationsOf('build-plate-combo');
  assert.deepEqual(a1SeriesTargets(plate.r.rows), ['pending:a1:a1_series', 'pending:refurbished-a1:a1_series'], 'build-plate-combo, also excludes');
});

test('default: the CyberBrick time-lapse kit has no evidence either way — the narrow default, the A1 and the refurbished A1', () => {
  const { r } = relationsOf('cyberbrick-timelapse-kit.options');
  assert.deepEqual(a1SeriesTargets(r.rows), ['pending:a1:a1_series', 'pending:refurbished-a1:a1_series']);
});

/**
 * PRINTER QUESTIONS THE REGISTRY CANNOT READ ALONE (owner-questions §E.9).
 * "Select your printer series" (cyberbrick-timelapse-kit) and "Device"
 * (ptfe-tubes) are printer groups only when every value is a label the
 * reviewed file maps or lists as reviewed-unresolvable; then their values are
 * relation evidence like any printer question's.
 */
test('"Select your printer series" and "Device" are printer groups when the reviewed file knows every value', () => {
  const kit = relationsOf('cyberbrick-timelapse-kit.options');
  const series = kit.model.groups.find((g) => g.sourceLabel === 'Select your printer series')!;
  assert.deepEqual([series.kind, series.canonical, series.nameAr, series.nameEn, series.nameCkb], ['printer', 'printer', 'الطابعة', 'Printer', 'چاپکەر']);
  // The two kit choices the store put in the printer question are reviewed-unresolvable: no row, never a guess.
  assert.deepEqual([...kit.r.reviewedSkipped].sort(), ['CyberBrick Time-lapse Kit - ZK005', 'Expansion Board Only - XA015']);
  assert.ok(!kit.r.rows.some((row) => row.state === 'unresolvable'), 'every printer value resolves');
  const p2 = kit.r.rows.filter((row) => row.targetLabel === 'P2 Series').map((row) => row.targetSourceHandle).sort();
  assert.deepEqual(p2, ['p2s', 'refurbished-bambu-lab-p2s-3d-printer']);
  assert.ok(kit.r.rows.some((row) => row.targetLabel === 'X2 Series') && kit.r.rows.some((row) => row.targetLabel === 'H2 Series'), 'compounds expand to their atoms');

  const tubes = relationsOf('ptfe-tubes.options');
  const device = tubes.model.groups.find((g) => g.sourceLabel === 'Device')!;
  assert.deepEqual([device.kind, device.canonical, device.nameAr, device.nameEn, device.nameCkb], ['printer', 'device', 'الجهاز', 'Device', 'ئامێر']);
  const byValue = new Map(device.values.map((v) => [v.id, v.nameEn]));
  const targeted = new Set(tubes.r.rows.filter((row) => row.scopeKind === 'option_value' && byValue.has(row.scopeId)).map((row) => byValue.get(row.scopeId)));
  assert.equal(targeted.size, device.values.length, 'every device value carries a relation row');
  assert.ok(tubes.r.rows.some((row) => row.targetSourceHandle === 'ams-ht' && row.targetKind === 'ams'), 'AMS values target AMS products (never mirrored as printer fits)');
});

test('without the reviewed file, or with one value it does not know, the groups stay unread (kind other, no rows)', () => {
  const x = sample('ptfe-tubes.options');
  const productId = newProductId(x.sourceProductId);
  const none = buildOptions(x, productId).groups.find((g) => g.sourceLabel === 'Device')!;
  assert.deepEqual([none.kind, none.canonical], ['other', null]);
  const partial = buildOptions(x, productId, { isReviewedTarget: (label) => label !== 'P1P' && compatLabelReviewed(REAL, label) }).groups.find((g) => g.sourceLabel === 'Device')!;
  assert.equal(partial.kind, 'other');
  assert.equal(compatLabelReviewed(REAL, 'h2 / p1 / x1 series'), true, 'case and punctuation do not matter');
  assert.equal(compatLabelReviewed(REAL, 'Not a label'), false);
  assert.equal(compatLabelReviewed(null, 'A1'), false);
});

/**
 * A REVIEWED DISPLAY LABEL ON A PRINTER VALUE (review 5, findings 4 and 5): the
 * reviewed file is keyed by the source's words, so the lookup reads them; the
 * row SHOWS the reviewed label whatever its state (resolved, pending or
 * unresolvable), and its id stays the one the source label gives.
 */
test('a labelled printer value: the row shows the reviewed label in every state, its id is the source label\'s', () => {
  const x = sample('bambu-textured-pei-plate');
  const productId = newProductId(x.sourceProductId);
  const h2c = x.groups.flatMap((g) => g.values).find((v) => v.value === 'H2C')!.id;
  const a2l = x.groups.flatMap((g) => g.values).find((v) => v.value === 'A2L')!.id;
  const labels = {
    [h2c]: { name_en: 'H2C printer', name_ar: 'طابعة H2C', name_ckb: 'چاپکەری H2C' },
    [a2l]: { name_en: 'A2L printer', name_ar: 'طابعة A2L', name_ckb: 'چاپکەری A2L' },
  };
  const targets: CompatTargets = { version: 1, labels: { H2C: { kind: 'printer', to: { source_handle: 'h2c' } } } };
  const rowsOf = (valueLabels: typeof labels | null, sourceId: string) => {
    const model = buildOptions(x, productId, { valueLabels });
    const v = model.groups.flatMap((g) => g.values).find((val) => val.sourceId === sourceId)!;
    return buildRelations({ productId, handle: x.handle, model, described: describe(x.description), relationBullets: [], targets }).rows.filter((r) => r.scopeId === v.id);
  };
  // Pending (mapped by the file): the label shows, the source words do not; the id is unchanged.
  const pendingPlain = rowsOf(null, h2c);
  const pendingLabelled = rowsOf(labels, h2c);
  assert.equal(pendingLabelled.length, 1);
  assert.equal(pendingLabelled[0].state, 'pending');
  assert.equal(pendingLabelled[0].targetLabel, 'H2C printer');
  assert.deepEqual(pendingLabelled.map((r) => r.id), pendingPlain.map((r) => r.id));
  // Unresolvable (not in the file): the same.
  const loosePlain = rowsOf(null, a2l);
  const looseLabelled = rowsOf(labels, a2l);
  assert.equal(looseLabelled[0].state, 'unresolvable');
  assert.equal(looseLabelled[0].targetLabel, 'A2L printer');
  assert.deepEqual(looseLabelled.map((r) => r.id), loosePlain.map((r) => r.id));
});
