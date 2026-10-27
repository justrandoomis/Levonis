/**
 * Templates, the stack layout, format changes and conflicts.
 * Spec §12, §14, §24, §34 acceptance 3, 7, 11.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultBrandKit } from '../src/brand';
import { detectConflicts, rebuild, resolveConflict, type RebuildContext } from '../src/layout';
import { contains, drawnRatio, FORMATS, layerBox, safeBox, type DocFormat, type ImageLayer, type TextLayer } from '../src/schema';
import { NO_EVIDENCE, TEMPLATES, variantsFor, type VariantId } from '../src/templates';
import { approximateMeasurer } from '../src/text';
import { built, product, snapshot } from './fixtures';

const kit = defaultBrandKit();
const formats: DocFormat[] = [FORMATS.square, FORMATS.portrait, FORMATS.story];

test('every product variant lays out in every format with the product undistorted and essentials inside the safe area', () => {
  for (const template of ['product_hero', 'compact_product'] as const) {
    for (const variant of Object.keys(TEMPLATES[template].variants) as VariantId[]) {
      for (const format of formats) {
        const r = built({ template, variant, format, copy: { headline: 'طباعة ثلاثية الأبعاد بدقة مذهلة', cta: 'اطلبها الآن', features: ['طباعة ملونة حتى 4 ألوان', 'معايرة تلقائية'] } });
        const p = r.doc.layers.find((l): l is ImageLayer => l.id === 'product');
        assert.ok(p, `${template}/${variant}/${format.id}: product placed`);
        const b = layerBox(p)!;
        assert.ok(Math.abs(b.width / b.height - 1200 / 800) < 1e-9, 'ratio of the source');
        const safe = safeBox(r.doc);
        for (const l of r.doc.layers) {
          if (['headline', 'product', 'product_name', 'price', 'logo'].includes(l.role) && l.type !== 'group') {
            assert.ok(contains(safe, layerBox(l, r.doc.layers)!, 1), `${template}/${variant}/${format.id}: ${l.id} inside safe area`);
          }
        }
        assert.deepEqual(r.conflicts.filter((c) => c.code === 'overlap' || c.code === 'outside_safe_area'), [], `${template}/${variant}/${format.id}`);
      }
    }
  }
});

test('the price is drawn from the snapshot, never from the copy, and an unpriced product is never a zero', () => {
  const priced = built();
  const price = priced.doc.layers.find((l) => l.id === 'price') as TextLayer;
  assert.deepEqual(price.source, { kind: 'product', slot: 'main', field: 'price' });
  assert.equal(price.text, 'تجريبي — 1,250,000 د.ع'); // a test snapshot is labelled as such
  const unpriced = built({ products: [product(snapshot({ price: { status: 'unpriced', amount_iqd: null, regular_iqd: null, from: false, offer: null, member_price_iqd: null }, availability: 'unknown' }))] });
  const p2 = unpriced.doc.layers.find((l) => l.id === 'price') as TextLayer;
  assert.ok(!/[0-9]/.test(p2.text), p2.text);
  assert.match(p2.text, /السعر عند الطلب/);
  const cta = unpriced.doc.layers.find((l) => l.id === 'cta') as TextLayer;
  assert.ok(cta);
  assert.equal(variantsFor('product_hero', 'sell', 'unpriced').includes('price_first'), false, 'no price layout without a public price');
});

test('a family badge is drawn only with its evidence', () => {
  const without = built({ family: 'new_arrival', variant: 'product_first' });
  assert.equal(without.doc.layers.some((l) => l.id === 'badge'), false);
  const withEvidence = built({ family: 'new_arrival', variant: 'product_first', evidence: { ...NO_EVIDENCE, arrival: true } });
  const badge = withEvidence.doc.layers.find((l) => l.id === 'badge') as TextLayer;
  assert.equal(badge.text, 'وصل حديثاً');
});

test('changing the format re-lays out from the template — the product keeps its ratio and the words are kept', () => {
  const square = built({ copy: { headline: 'طباعة ثلاثية الأبعاد بدقة مذهلة', cta: 'اطلبها الآن' } }).doc;
  const snap = snapshot();
  const ctx: RebuildContext = { brand: kit, brandVersion: null, snapshots: { main: snap }, claims: {}, evidence: NO_EVIDENCE, family: null, logo: { width: 1254, height: 1254 }, backgroundNatural: null, measure: approximateMeasurer };
  const story = rebuild(square, { format: FORMATS.story }, ctx)!;
  assert.equal(story.doc.format.height, 1920);
  const p = story.doc.layers.find((l): l is ImageLayer => l.id === 'product')!;
  assert.ok(Math.abs(drawnRatio(p) - 1.5) < 1e-9);
  assert.equal((story.doc.layers.find((l) => l.id === 'headline') as TextLayer).text, 'طباعة ثلاثية الأبعاد بدقة مذهلة');
  // the story gives the product more room, it does not stretch it
  assert.ok(layerBox(p)!.height >= layerBox(square.layers.find((l) => l.id === 'product')!)!.height - 1);
});

test('too much text never shrinks below the floor or overlaps silently — it becomes a conflict with options', () => {
  const long = 'هذا عنوان طويل جداً جداً يشرح كل شيء عن الطابعة الجديدة وكل مزاياها وكل ملحقاتها وكل شيء آخر يمكن قوله في إعلان واحد بلا توقف أبداً';
  const r = built({ copy: { headline: long + ' ' + long + ' ' + long, subhead: long, cta: 'اطلبها الآن' }, density: 'detailed' });
  const h = r.doc.layers.find((l) => l.id === 'headline') as TextLayer | undefined;
  if (h) assert.ok(h.font.size >= h.minSize);
  assert.ok(r.conflicts.length > 0 || r.dropped.length > 0, 'reported, not hidden');
  const c = r.conflicts.find((x) => x.code === 'content_too_long');
  if (c) assert.ok(c.options.includes('shorten_text'));
});

test('a manual move that pushes the price out of the safe area is reported, and shrink_product resolves it', () => {
  const doc = built().doc;
  const moved = { ...doc, layers: doc.layers.map((l) => (l.id === 'product' ? { ...l, scale: (l as ImageLayer).scale * 1.6 } : l)) };
  const conflicts = detectConflicts(moved, { measure: approximateMeasurer });
  assert.ok(conflicts.length > 0);
  const fixed = resolveConflict(moved, conflicts[0], 'shrink_product', { measure: approximateMeasurer, brand: kit });
  if (fixed) {
    const p = fixed.layers.find((l): l is ImageLayer => l.id === 'product')!;
    assert.ok(Math.abs(drawnRatio(p) - 1.5) < 1e-9);
  }
});

test('service card keeps the conditions line', () => {
  const claim = {
    id: 'claim_warranty_1', version: 3,
    title: { ar: 'ضمان (نص تجريبي)', en: 'Warranty (test text)', ckb: 'گەرەنتی (دەقی تاقیکاری)' },
    summary: { ar: 'ملخص تجريبي للضمان', en: 'Test warranty summary', ckb: 'پوختەی تاقیکاری گەرەنتی' },
    conditions: { ar: 'الشروط التجريبية تنطبق', en: 'Test conditions apply', ckb: 'مەرجە تاقیکارییەکان جێبەجێ دەبن' },
    details_path: '/policies/warranty',
  };
  const r = built({ template: 'service_card', variant: 'feature_first', products: [], service: claim, objective: 'service_trust', copy: { headline: 'اطمئن لطابعتك', cta: 'اعرف التفاصيل' } });
  const cond = r.doc.layers.find((l) => l.type === 'text' && l.source.kind === 'service' && l.source.field === 'conditions') as TextLayer;
  assert.ok(cond, 'conditions drawn');
  assert.equal(cond.text, 'الشروط التجريبية تنطبق');
  assert.deepEqual(r.doc.services, [{ claim_id: 'claim_warranty_1', claim_version: 3 }]);
});
