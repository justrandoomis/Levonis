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
import { buildRelations, type CompatTargets } from '../packages/catalog/src/bambuImport/relations';
import { buildOptions, newProductId } from '../packages/catalog/src/bambuImport/options';
import { describe } from '../packages/catalog/src/bambuImport/describe';
import { sample } from './fixtures/bambu/load';

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
