/**
 * Locks hold through the tree, for Claude and for people (spec §23, §34-7):
 * a layer inside a locked group is locked, an operation on a whole group is
 * refused while anything inside it is locked, relation propagation never
 * moves a locked layer, and Claude cannot re-lay a design that has one.
 * The probes are the reviewer's (finding model-1 / editor-3 / model-2).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultBrandKit } from '../src/brand';
import { validateEditPatch } from '../src/aiContracts';
import { applyOps } from '../src/ops';
import { layerBox, type CreativeDocument, type Layer } from '../src/schema';
import { approximateMeasurer } from '../src/text';
import { allowedFor, built } from './fixtures';

const kit = defaultBrandKit();
const opsCtx = { brand: kit, allowed: allowedFor(), measure: approximateMeasurer };
const human = (doc: CreativeDocument, ops: unknown[]) => applyOps(doc, ops, { ...opsCtx, actor: 'human' });
const patch = (doc: CreativeDocument, targets: string[], operations: unknown[], scope: string[] | null) => validateEditPatch(
  { schema_version: 1, document_id: 'doc_1', base_document_version: 3, intent: 'x', target_layer_ids: targets, operations, reason: '', warnings: [], clarification: '' },
  { documentId: 'doc_1', version: 3, doc, scope, evidence: { offer: false, serviceClaim: false }, ops: opsCtx },
);
const L = (doc: CreativeDocument, id: string): Layer => doc.layers.find((l) => l.id === id)!;
const yOf = (doc: CreativeDocument, id: string) => layerBox(L(doc, id), doc.layers)!.y;
/** Lock a layer the way the owner does it: a person's set_lock. */
const lock = (doc: CreativeDocument, id: string) => {
  const r = human(doc, [{ op: 'set_lock', layer_id: id, locked: true }]);
  assert.ok(r.ok, JSON.stringify(r));
  return r.doc;
};
const refusedLocked = (v: ReturnType<typeof patch>, name: string) => {
  assert.equal(v.ok, false, `${name}: accepted`);
  if (!v.ok) {
    assert.equal(v.code, 'ops_refused', name);
    assert.equal((v.detail as Array<{ code: string }>)[0].code, 'locked_layer', `${name}: ${JSON.stringify(v.detail)}`);
  }
};
const docOf = () => built({ copy: { headline: 'طباعة ثلاثية الأبعاد بدقة مذهلة', cta: 'اطلبها الآن', badge: 'جديد' } }).doc;

test('the owner locks the CTA words inside their chip: Claude cannot move, hide or push them through the group or a relation', () => {
  const doc = lock(docOf(), 'cta');
  assert.equal(L(doc, 'cta').parent, 'cta_group', 'the words are a child of the chip group');
  const ctaY = yOf(doc, 'cta');
  refusedLocked(patch(doc, ['cta_group'], [{ op: 'nudge_layer', layer_id: 'cta_group', dx: 0, dy: -40 }], ['cta_group']), 'nudge cta_group');
  refusedLocked(patch(doc, ['cta_group'], [{ op: 'set_visibility', layer_id: 'cta_group', visible: false }], null), 'hide cta_group');
  // A product scale that would push the CTA through r_below_cta_group: accepted, but the locked words stay.
  const shrink = patch(doc, ['product'], [{ op: 'scale_asset_uniform', layer_id: 'product', factor: 0.8, anchor: 'top' }], ['product']);
  assert.ok(shrink.ok && shrink.applied, JSON.stringify(shrink));
  if (shrink.ok && shrink.applied) {
    assert.equal(yOf(shrink.applied.doc, 'cta'), ctaY, 'the locked words did not move');
    assert.equal(yOf(shrink.applied.doc, 'cta_chip'), yOf(doc, 'cta_chip'), 'nor did their chip');
    assert.ok(!shrink.applied.moved.includes('cta') && !shrink.applied.moved.includes('cta_chip'), JSON.stringify(shrink.applied.moved));
    assert.ok(shrink.applied.moved.includes('price'), 'the unlocked dependents still follow');
    assert.equal(L(shrink.applied.doc, 'cta').locked, true);
  }
  // Growing the product instead: the chain runs into the locked CTA and the conflict says so — nothing overlaps silently.
  const grow = patch(doc, ['product'], [{ op: 'scale_asset_uniform', layer_id: 'product', factor: 1.3, anchor: 'top' }], ['product']);
  assert.ok(grow.ok && grow.applied, JSON.stringify(grow));
  if (grow.ok && grow.applied) {
    assert.equal(yOf(grow.applied.doc, 'cta'), ctaY);
    assert.ok(grow.applied.conflicts.some((c) => c.layer_ids.includes('cta') || c.layer_ids.includes('price')), JSON.stringify(grow.applied.conflicts));
  }
});

test('the same group rule holds for a person: dragging or deleting the chip group is refused while its words are locked', () => {
  const doc = lock(docOf(), 'cta');
  for (const op of [{ op: 'nudge_layer', layer_id: 'cta_group', dx: 0, dy: 50 }, { op: 'move_layer', layer_id: 'cta_group', x: 100, y: 100 }, { op: 'delete_layer', layer_id: 'cta_group' }, { op: 'reorder_layer', layer_id: 'cta_group', to: 'front' }, { op: 'set_visibility', layer_id: 'cta_group', visible: false }]) {
    const r = human(doc, [op]);
    assert.ok(!r.ok && r.refusals[0].code === 'locked_layer' && r.refusals[0].layer_id === 'cta', `${op.op}: ${JSON.stringify(r)}`);
  }
  // Renaming is a label, never a design change; unlocking is the way out.
  assert.ok(human(doc, [{ op: 'rename_layer', layer_id: 'cta', name: 'Call to action' }]).ok);
  const unlocked = human(doc, [{ op: 'set_lock', layer_id: 'cta', locked: false }]);
  assert.ok(unlocked.ok && human(unlocked.doc, [{ op: 'nudge_layer', layer_id: 'cta_group', dx: 0, dy: 50 }]).ok);
});

test('the owner locks the chip group: everything inside it is locked, for Claude and for people', () => {
  const doc = lock(docOf(), 'cta_group');
  refusedLocked(patch(doc, ['cta'], [{ op: 'set_text', layer_id: 'cta', value: 'تواصل معنا' }], null), 'set_text cta');
  refusedLocked(patch(doc, ['cta_chip'], [{ op: 'nudge_layer', layer_id: 'cta_chip', dx: 100, dy: 0 }], null), 'nudge cta_chip');
  refusedLocked(patch(doc, ['cta_chip'], [{ op: 'set_color', layer_id: 'cta_chip', color: '#2a2d31' }], null), 'recolour cta_chip');
  const r = human(doc, [{ op: 'set_text', layer_id: 'cta', value: 'تواصل معنا' }]);
  assert.ok(!r.ok && r.refusals[0].code === 'locked_layer' && r.refusals[0].layer_id === 'cta_group');
  // Adding a layer INTO the locked group changes it too.
  const add = human(doc, [{ op: 'add_layer', layer: { ...L(doc, 'cta_chip'), id: 'extra_chip' } }]);
  assert.ok(!add.ok && add.refusals[0].code === 'locked_layer', JSON.stringify(add));
});

test('a locked contact shadow is not reshaped when its product changes', () => {
  const doc = lock(docOf(), 'product_shadow');
  const r = patch(doc, ['product'], [{ op: 'scale_asset_uniform', layer_id: 'product', factor: 0.8, anchor: 'top' }], ['product']);
  assert.ok(r.ok && r.applied);
  if (r.ok && r.applied) assert.deepEqual(L(r.applied.doc, 'product_shadow'), L(doc, 'product_shadow'));
});

test('Claude cannot re-lay a design that has a locked layer; the always-locked background does not count', () => {
  const free = docOf();
  assert.equal(L(free, 'background').locked, true, 'the background is stored locked');
  const ok = patch(free, [], [{ op: 'switch_template_variant', variant: 'price_first' }], null);
  assert.ok(ok.ok && ok.applied, JSON.stringify(ok));
  if (ok.ok && ok.applied) assert.deepEqual(ok.applied.rebuild, { kind: 'variant', variant: 'price_first' }, 'the rebuild is exposed for the preview');
  const doc = lock(free, 'headline');
  for (const op of [{ op: 'switch_template_variant', variant: 'price_first' }, { op: 'set_priority', priority: 'price' }, { op: 'create_format_variant', format: 'story' }]) {
    refusedLocked(patch(doc, [], [op], null), op.op);
  }
});
