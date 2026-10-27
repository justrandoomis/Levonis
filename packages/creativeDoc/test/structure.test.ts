/**
 * The document's structure under edits: a group reorders as ONE block and a
 * reorder that changes nothing drawn is no edit (finding model-13); in the
 * comparison template the full-width headline and CTA are not chained to one
 * product's column (finding model-14, spec §14: only dependents move).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultBrandKit } from '../src/brand';
import { buildFromTemplate } from '../src/layout';
import { applyOps } from '../src/ops';
import { type CreativeDocument } from '../src/schema';
import { approximateMeasurer } from '../src/text';
import { allowedFor, buildInput, built, snapshot } from './fixtures';

const kit = defaultBrandKit();
const human = (doc: CreativeDocument, ops: unknown[]) => applyOps(doc, ops, { actor: 'human', brand: kit, allowed: allowedFor(), measure: approximateMeasurer });
const painted = (d: CreativeDocument) => d.layers.filter((l) => l.type !== 'group').map((l) => l.id);
const docOf = () => built({ copy: { headline: 'طباعة ثلاثية الأبعاد بدقة مذهلة', cta: 'اطلبها الآن', badge: 'جديد' } }).doc;

test('a group reorders with its children as one block, stepping past whole sibling blocks', () => {
  const doc = docOf();
  const before = painted(doc);
  const at = (d: CreativeDocument, id: string) => painted(d).indexOf(id);
  const front = human(doc, [{ op: 'reorder_layer', layer_id: 'cta_group', to: 'front' }]);
  assert.ok(front.ok);
  if (front.ok) {
    assert.deepEqual(painted(front.doc).slice(-2), ['cta_chip', 'cta'], 'chip then its words, on top');
    assert.deepEqual(front.changed, ['cta_group']);
  }
  const back = human(doc, [{ op: 'reorder_layer', layer_id: 'cta_group', to: 'back' }]);
  assert.ok(back.ok);
  if (back.ok) assert.deepEqual(painted(back.doc).slice(0, 3), ['background', 'cta_chip', 'cta'], 'never under the background');
  const down = human(doc, [{ op: 'reorder_layer', layer_id: 'cta_group', to: 'backward' }]);
  assert.ok(down.ok);
  if (down.ok) {
    assert.equal(at(down.doc, 'cta'), at(down.doc, 'cta_chip') + 1, 'the block stays together');
    assert.ok(at(down.doc, 'cta_chip') < at(down.doc, 'price') && at(doc, 'cta_chip') > at(doc, 'price'), 'one sibling block down');
  }
  // The badge group steps past the whole CTA block, not into it.
  const badge = human(doc, [{ op: 'reorder_layer', layer_id: 'badge_group', to: 'front' }]);
  assert.ok(badge.ok);
  if (badge.ok) assert.deepEqual(painted(badge.doc).slice(-2), ['badge_chip', 'badge']);
  assert.deepEqual(painted(doc), before, 'the input is untouched');
});

test('a group child stays inside its group, and a reorder that changes nothing drawn is no edit', () => {
  const doc = docOf();
  const chip = human(doc, [{ op: 'reorder_layer', layer_id: 'cta', to: 'back' }]);
  assert.ok(chip.ok);
  if (chip.ok) {
    const p = painted(chip.doc);
    assert.equal(p.indexOf('cta_chip'), p.indexOf('cta') + 1, 'the words moved under their chip, inside the group block — not under the background');
  }
  // Already on top among its siblings: nothing moves, no change is reported, the caller gets its own document back.
  const top = human(doc, [{ op: 'reorder_layer', layer_id: 'logo', to: 'front' }]);
  assert.ok(top.ok);
  if (top.ok) {
    assert.deepEqual(top.changed, []);
    assert.equal(top.doc, doc, 'same document: no undo step, nothing to save');
  }
});

test('comparison: the full-width headline and CTA are not chained to one product`s column', () => {
  for (const locale of ['en', 'ar'] as const) {
    const s1 = snapshot({ images: [{ url: '/files/products/test/a.webp', width: 1600, height: 500, alt: '', primary: true, variant_key: 'combo', same_origin: true }] });
    const s2 = { ...snapshot({ product_id: 'p_test_b2', images: [{ url: '/files/products/test/b.webp', width: 500, height: 1600, alt: '', primary: true, variant_key: 'combo', same_origin: true }] }), id: 'snap_test_0002' };
    const doc = buildFromTemplate(buildInput({
      template: 'comparison', variant: 'product_first', locale, objective: 'comparison',
      products: [{ slot: 'main', snapshot: s1, image: { url: '/files/products/test/a.webp', width: 1600, height: 500 } }, { slot: 'p2', snapshot: s2, image: { url: '/files/products/test/b.webp', width: 500, height: 1600 } }],
      copy: { headline: locale === 'en' ? 'Which printer suits you?' : 'أي طابعة تناسبك؟', cta: locale === 'en' ? 'Order now' : 'اطلبها الآن' },
    })).doc;
    for (const r of doc.relations) if (r.kind === 'below' || r.kind === 'clear_of') assert.ok(!['headline', 'cta_group'].includes(r.subject), `${locale}: ${r.id} ties ${r.subject} to ${r.target}`);
    for (const pid of ['product', 'product_p2']) {
      const r = human(doc, [{ op: 'nudge_layer', layer_id: pid, dx: 0, dy: 1 }]);
      assert.ok(r.ok);
      if (!r.ok) continue;
      assert.ok(!r.moved.includes('cta') && !r.moved.includes('headline'), `${locale}: nudging ${pid} moved ${r.moved}`);
      assert.ok(r.moved.includes(pid === 'product' ? 'price' : 'price_p2'), `${locale}: ${pid}'s own column follows`);
      assert.deepEqual(r.conflicts.filter((c) => c.code === 'overlap'), [], `${locale}: ${pid}`);
    }
  }
});
