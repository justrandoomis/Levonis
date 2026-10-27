/**
 * The document gate, the bounded operations and the edit-patch gate.
 * Spec §15, §16, §28, §34 acceptance 3, 5, 7, 10.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultBrandKit } from '../src/brand';
import { validateEditPatch } from '../src/aiContracts';
import { normalizeDocument } from '../src/normalize';
import { applyOps } from '../src/ops';
import { drawnRatio, layerBox, type CreativeDocument, type ImageLayer, type TextLayer } from '../src/schema';
import { approximateMeasurer } from '../src/text';
import { allowedFor, built } from './fixtures';

const kit = defaultBrandKit();
const human = { actor: 'human' as const, brand: kit, allowed: allowedFor(), measure: approximateMeasurer };
const ai = { ...human, actor: 'ai' as const };
const docOf = () => built().doc;
const layer = <T = TextLayer>(doc: CreativeDocument, id: string) => doc.layers.find((l) => l.id === id) as unknown as T;
const withoutLayer = (doc: CreativeDocument, id: string) => doc.layers.filter((l) => l.id !== id);

test('a built document passes the gate unchanged and the gate is idempotent', () => {
  const doc = docOf();
  const once = normalizeDocument(doc);
  assert.equal(once.ok, true, JSON.stringify(once.issues));
  assert.deepEqual(once.issues, []);
  assert.deepEqual(once.doc, doc);
  const twice = normalizeDocument(JSON.parse(JSON.stringify(once.doc)));
  assert.deepEqual(twice.doc, once.doc);
  assert.deepEqual(twice.issues, []);
});

test('dangerous values are refused (fatal), not cleaned', () => {
  const doc = docOf();
  const cases: Array<[string, (d: Record<string, unknown>) => void, string]> = [
    ['future schema', (d) => { d.schema_version = 2; }, 'unsupported_schema_version'],
    ['external image url', (d) => { (d.layers as Record<string, unknown>[]).find((l) => l.id === 'product')!.asset = { kind: 'product', ref: 'https://evil.example/p.png', slot: 'main' }; }, 'unsafe_asset_ref'],
    ['path traversal', (d) => { (d.layers as Record<string, unknown>[]).find((l) => l.id === 'product')!.asset = { kind: 'product', ref: '/files/../secrets', slot: 'main' }; }, 'unsafe_asset_ref'],
    ['javascript url', (d) => { (d.layers as Record<string, unknown>[]).find((l) => l.id === 'product')!.asset = { kind: 'product', ref: 'javascript:alert(1)', slot: 'main' }; }, 'unsafe_asset_ref'],
    ['invented font', (d) => { ((d.layers as Record<string, unknown>[]).find((l) => l.id === 'headline')!.font as Record<string, unknown>).family = 'Comic Sans'; }, 'unknown_font'],
    ['duplicate id', (d) => { (d.layers as unknown[]).push({ ...(d.layers as Record<string, unknown>[])[1] }); }, 'duplicate_id'],
    ['html layer', (d) => { (d.layers as unknown[]).push({ id: 'x1', type: 'html', html: '<script>alert(1)</script>' }); }, 'unknown_layer_type'],
    ['oversize', (d) => { d.caption = 'x'.repeat(300 * 1024); }, 'payload_too_large'],
  ];
  for (const [name, mutate, code] of cases) {
    const copy = JSON.parse(JSON.stringify(doc));
    mutate(copy);
    const r = normalizeDocument(copy);
    assert.equal(r.ok, false, name);
    assert.ok(r.issues.some((i) => i.code === code && i.fatal), `${name}: ${JSON.stringify(r.issues)}`);
  }
});

test('unknown keys are stripped with an issue, never copied through', () => {
  const copy = JSON.parse(JSON.stringify(docOf()));
  copy.__proto__polluted = 1;
  copy.layers[1].onclick = 'alert(1)';
  copy.layers[1].letterSpacing = 4; // no such field: Arabic joining
  const r = normalizeDocument(copy);
  assert.equal(r.ok, true);
  assert.ok(r.issues.some((i) => i.code === 'unknown_key'));
  assert.equal('onclick' in r.doc.layers[1], false);
  assert.equal('letterSpacing' in r.doc.layers[1], false);
});

test('«غيّر العنوان فقط»: set_text on the headline changes only the headline', () => {
  const doc = docOf();
  const r = applyOps(doc, [{ op: 'set_text', layer_id: 'headline', value: 'اكتشف إمكانيات الطباعة ثلاثية الأبعاد' }], ai);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.changed, ['headline']);
  assert.deepEqual(r.moved, []);
  assert.equal(layer(r.doc, 'headline').text, 'اكتشف إمكانيات الطباعة ثلاثية الأبعاد');
  assert.deepEqual(withoutLayer(r.doc, 'headline'), withoutLayer(doc, 'headline'));
  assert.deepEqual(r.doc.template, doc.template);
  assert.deepEqual(r.doc.products, doc.products);
});

test('Claude cannot write a price, a link or into a bound layer, and cannot touch a locked layer', () => {
  const doc = docOf();
  const refused = (ops: unknown[], code: string) => {
    const r = applyOps(doc, ops, ai);
    assert.equal(r.ok, false, JSON.stringify(ops));
    if (!r.ok) assert.equal(r.refusals[0].code, code, JSON.stringify(r.refusals));
  };
  refused([{ op: 'set_text', layer_id: 'headline', value: 'فقط 999,000 د.ع' }], 'price_like_text');
  refused([{ op: 'set_text', layer_id: 'headline', value: 'السعر 250 ألف' }], 'price_like_text');
  refused([{ op: 'set_text', layer_id: 'headline', value: 'زوروا www.example.com' }], 'invented_link');
  refused([{ op: 'set_text', layer_id: 'price', value: 'مجاناً' }], 'bound_text');
  refused([{ op: 'set_text', layer_id: 'product_name', value: 'X1 Carbon' }], 'bound_text');
  refused([{ op: 'move_layer', layer_id: 'background', x: 10, y: 10 }], 'locked_layer');
  refused([{ op: 'set_lock', layer_id: 'headline', locked: true }], 'not_allowed_for_actor');
  refused([{ op: 'delete_layer', layer_id: 'price' }], 'not_allowed_for_actor');
  refused([{ op: 'run_js', code: 'fetch(1)' }], 'unknown_op');
  refused([{ op: 'set_color', layer_id: 'headline', color: '#ff00ff' }], 'color_not_in_palette');
  // all or nothing: one bad op refuses the batch
  const r = applyOps(doc, [{ op: 'set_text', layer_id: 'headline', value: 'عنوان جديد' }, { op: 'set_text', layer_id: 'price', value: 'x' }], ai);
  assert.equal(r.ok, false);
});

test('pictures only scale uniformly — the ratio survives every path that can change it', () => {
  const doc = docOf();
  const p0 = layer<ImageLayer>(doc, 'product');
  const ratio = drawnRatio(p0);
  for (const factor of [1.3, 0.6, 2.2]) {
    const r = applyOps(doc, [{ op: 'scale_asset_uniform', layer_id: 'product', factor, anchor: 'bottom' }], ai);
    assert.equal(r.ok, true);
    if (!r.ok) continue;
    const p = layer<ImageLayer>(r.doc, 'product');
    const b = layerBox(p)!;
    assert.ok(Math.abs(b.width / b.height - ratio) < 1e-9);
    // dependents moved, the headline and background did not change
    assert.deepEqual(layer(r.doc, 'background'), layer(doc, 'background'));
  }
  // resize_box is refused for pictures (no free stretch), even for a person
  const stretch = applyOps(doc, [{ op: 'resize_box', layer_id: 'product', width: 900, height: 200 }], human);
  assert.equal(stretch.ok, false);
  // replacing the picture keeps the new picture's own ratio
  const swap = applyOps(doc, [{ op: 'replace_asset', layer_id: 'product', ref: '/files/products/test/a1-combo-side.webp' }], ai);
  assert.equal(swap.ok, true);
  if (swap.ok) {
    const b = layerBox(layer<ImageLayer>(swap.doc, 'product'))!;
    assert.ok(Math.abs(b.width / b.height - 1) < 1e-9);
  }
  // a picture of ANOTHER variant (solo) is not one of this binding's pictures
  const wrong = applyOps(doc, [{ op: 'replace_asset', layer_id: 'product', ref: '/files/products/test/a1-solo.webp' }], ai);
  assert.equal(wrong.ok, false);
});

test('scaling the product moves only its dependents (name, price, CTA), never the headline or logo', () => {
  const doc = docOf();
  const r = applyOps(doc, [{ op: 'scale_asset_uniform', layer_id: 'product', factor: 0.8, anchor: 'top' }], human);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(layer(r.doc, 'headline'), layer(doc, 'headline'));
  assert.deepEqual(layer(r.doc, 'logo'), layer(doc, 'logo'));
  assert.ok(r.moved.includes('product_name'));
  assert.ok(layer(r.doc, 'product_name').y < layer(doc, 'product_name').y);
});

test('a design-wide operation must be alone in its patch and becomes a rebuild request', () => {
  const doc = docOf();
  const alone = applyOps(doc, [{ op: 'switch_template_variant', variant: 'price_first' }], ai);
  assert.equal(alone.ok, true);
  if (alone.ok) assert.deepEqual(alone.rebuild, { kind: 'variant', variant: 'price_first' });
  const mixed = applyOps(doc, [{ op: 'switch_template_variant', variant: 'price_first' }, { op: 'set_text', layer_id: 'headline', value: 'x y' }], ai);
  assert.equal(mixed.ok, false);
});

test('the edit-patch gate: identity, version, targets, scope, then the operations', () => {
  const doc = docOf();
  const ctx = { documentId: 'doc_test_1', version: 7, doc, scope: ['headline'], evidence: { offer: false, serviceClaim: false }, ops: { brand: kit, allowed: allowedFor(), measure: approximateMeasurer } };
  const patch = (over: Record<string, unknown> = {}) => ({
    schema_version: 1, document_id: 'doc_test_1', base_document_version: 7, intent: 'edit_selected_text', target_layer_ids: ['headline'],
    operations: [{ op: 'set_text', layer_id: 'headline', value: 'اكتشف إمكانيات الطباعة ثلاثية الأبعاد' }], reason: 'اختصار', warnings: [], clarification: '', ...over,
  });
  const ok = validateEditPatch(patch(), ctx);
  assert.equal(ok.ok, true);
  const code = (p: unknown, c = ctx) => { const v = validateEditPatch(p, c); return v.ok ? 'ok' : v.code; };
  assert.equal(code(patch({ base_document_version: 6 })), 'stale_version');
  assert.equal(code(patch({ document_id: 'other' })), 'wrong_document');
  assert.equal(code(patch({ target_layer_ids: ['ghost'] })), 'target_outside_document');
  assert.equal(code(patch({ target_layer_ids: ['price'], operations: [{ op: 'set_color', layer_id: 'price', color: '#f4f4f1' }] })), 'target_outside_scope');
  assert.equal(code(patch({ operations: [{ op: 'set_text', layer_id: 'subhead_x', value: 'a b' }] })), 'op_target_undeclared');
  assert.equal(code(patch({ operations: [{ op: 'apply_background_preset', preset_id: 'charcoal' }] })), 'design_wide_needs_scope');
  assert.equal(code(patch({ operations: [{ op: 'set_text', layer_id: 'headline', value: 'أرخص طابعة في العراق' }] })), 'text_refused');
  assert.equal(code(patch({ operations: [{ op: 'set_text', layer_id: 'headline', value: 'خصم خاص هذا الأسبوع' }] })), 'text_refused');
  // with offer evidence, offer wording is allowed
  assert.equal(code(patch({ operations: [{ op: 'set_text', layer_id: 'headline', value: 'عرض خاص هذا الأسبوع' }] }), { ...ctx, evidence: { offer: true, serviceClaim: false } }), 'ok');
  // a clarification with no operations is a valid answer
  assert.equal(code(patch({ operations: [], clarification: 'أي عنصر تقصد؟' })), 'ok');
});
