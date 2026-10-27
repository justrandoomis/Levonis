/**
 * The owner's pointing marks (spec §17) are operations too: people may add and
 * remove them, Claude may not, and they pass the same gate as everything else.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultBrandKit } from '../src/brand';
import { validateEditPatch } from '../src/aiContracts';
import { applyOps } from '../src/ops';
import { MAX_ANNOTATIONS } from '../src/schema';
import { approximateMeasurer } from '../src/text';
import { allowedFor, built } from './fixtures';

const kit = defaultBrandKit();
const human = { actor: 'human' as const, brand: kit, allowed: allowedFor(), measure: approximateMeasurer };
const pin = (id: string, layer_ids: string[] = ['headline']) => ({ id, kind: 'pin', x: 540, y: 300, width: 0, height: 0, note: 'هذه المنطقة مزدحمة', layer_ids });

test('a person adds and deletes an annotation; the design itself does not move', () => {
  const doc = built().doc;
  const added = applyOps(doc, [{ op: 'add_annotation', annotation: pin('n_one', ['headline', 'nope']) }], human);
  assert.equal(added.ok, true, JSON.stringify(added));
  if (!added.ok) return;
  assert.equal(added.doc.annotations.length, 1);
  assert.deepEqual(added.doc.annotations[0].layer_ids, ['headline'], 'only ids of layers that exist are kept');
  assert.deepEqual(added.doc.layers, doc.layers, 'a mark is not a design change');
  assert.deepEqual(added.changed, []);
  const removed = applyOps(added.doc, [{ op: 'delete_annotation', annotation_id: 'n_one' }], human);
  assert.equal(removed.ok, true);
  if (removed.ok) assert.equal(removed.doc.annotations.length, 0);
});

test('a duplicate, a malformed mark, an unknown id and one past the cap are refused', () => {
  const doc = built().doc;
  const one = applyOps(doc, [{ op: 'add_annotation', annotation: pin('n_one') }], human);
  assert.ok(one.ok);
  if (!one.ok) return;
  const dup = applyOps(one.doc, [{ op: 'add_annotation', annotation: pin('n_one') }], human);
  assert.ok(!dup.ok && dup.refusals[0].code === 'duplicate_id', JSON.stringify(dup));
  const bad = applyOps(one.doc, [{ op: 'add_annotation', annotation: { id: 'Bad Id', kind: 'pin' } }], human);
  assert.ok(!bad.ok && bad.refusals[0].code === 'invalid_value', JSON.stringify(bad));
  const gone = applyOps(one.doc, [{ op: 'delete_annotation', annotation_id: 'n_missing' }], human);
  assert.ok(!gone.ok && gone.refusals[0].code === 'unknown_annotation');
  const full = { ...doc, annotations: Array.from({ length: MAX_ANNOTATIONS }, (_, i) => ({ ...pin(`n_${i}`), kind: 'pin' as const })) };
  const over = applyOps(full, [{ op: 'add_annotation', annotation: pin('n_extra') }], human);
  assert.ok(!over.ok, 'the cap holds');
});

test('Claude cannot add or remove a mark, directly or through a patch', () => {
  const doc = built().doc;
  const direct = applyOps(doc, [{ op: 'add_annotation', annotation: pin('n_ai') }], { ...human, actor: 'ai' });
  assert.ok(!direct.ok && direct.refusals[0].code === 'not_allowed_for_actor');
  const verdict = validateEditPatch(
    { schema_version: 1, document_id: 'doc_1', base_document_version: 3, intent: 'x', target_layer_ids: [], operations: [{ op: 'add_annotation', annotation: pin('n_ai') }], reason: '', warnings: [], clarification: '' },
    { documentId: 'doc_1', version: 3, doc, scope: null, evidence: { offer: false, serviceClaim: false }, ops: { brand: kit, allowed: allowedFor(), measure: approximateMeasurer } },
  );
  assert.equal(verdict.ok, false);
});
