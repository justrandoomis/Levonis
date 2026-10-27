/**
 * Sizes the layout must survive (finding model-10, spec §14, §24): a product
 * crowded below its share is reported ON THE PRODUCT, never as an over-long
 * headline; no build ever stores a zero scale or a font under the stored
 * floor; and landscape custom sizes scale type, logo and gaps by their
 * height, so the product keeps a real share of them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultBrandKit, scaledType } from '../src/brand';
import { qualityReport } from '../src/quality';
import { normalizeDocument } from '../src/normalize';
import { formatOf, layerBox, safeBox, FORMATS, type ImageLayer, type TextLayer } from '../src/schema';
import { approximateMeasurer } from '../src/text';
import { built, product, snapshot } from './fixtures';

test('a product crowded below its share is product_too_small on the product, with options that give it room', () => {
  // A kit whose headline cannot shrink: the words fit, the product cannot reach its 50 % share.
  const kit = defaultBrandKit();
  const big = { ...kit, type: { ...kit.type, headline: { ...kit.type.headline, size: 150, min: 150 } } };
  const r = built({ brand: big, copy: { headline: 'طباعة دقيقة لكل مشروع', cta: 'اطلبها الآن' } });
  const c = r.conflicts.find((x) => x.code === 'product_too_small');
  assert.ok(c, JSON.stringify(r.conflicts));
  assert.deepEqual(c!.layer_ids, ['product']);
  assert.ok(c!.options.includes('switch_variant') && c!.options.includes('shorten_text'));
  assert.ok(!c!.options.includes('shrink_product'));
  assert.ok(!r.conflicts.some((x) => x.code === 'content_too_long'), `not blamed on the headline: ${JSON.stringify(r.conflicts)}`);
});

test('the reviewer`s sizes: no zero scale, no clamped font, the product a real share of a landscape post', () => {
  const wide = snapshot({ images: [{ url: '/files/products/test/wide.webp', width: 1500, height: 500, alt: 'w', primary: true, variant_key: 'combo', same_origin: true }] });
  const cases = [
    { name: 'square, 1500×500 picture', format: FORMATS.square, products: [{ slot: 'main', snapshot: wide, image: { url: '/files/products/test/wide.webp', width: 1500, height: 500 } }] },
    { name: '1200×628', format: formatOf('custom', 1200, 628)!, products: [product()] },
    { name: '1500×500', format: formatOf('custom', 1500, 500)!, products: [product()] },
    { name: '1584×396', format: formatOf('custom', 1584, 396)!, products: [product()] },
    { name: '4096×1024', format: formatOf('custom', 4096, 1024)!, products: [product()] },
    { name: '320×320', format: formatOf('custom', 320, 320)!, products: [product()] },
  ];
  for (const c of cases) {
    const r = built({ format: c.format, products: c.products, copy: { headline: 'طابعة سريعة', cta: 'اطلبها الآن' } });
    const p = r.doc.layers.find((l): l is ImageLayer => l.id === 'product')!;
    assert.ok(p.scale > 0.01, `${c.name}: scale ${p.scale}`);
    const n = normalizeDocument(JSON.parse(JSON.stringify(r.doc)));
    assert.deepEqual(n.issues, [], `${c.name}: the gate changes nothing (${JSON.stringify(n.issues)})`);
    assert.deepEqual(r.conflicts.filter((x) => x.code !== 'product_too_small'), [], `${c.name}: ${JSON.stringify(r.conflicts)}`);
    if (c.format.width > c.format.height) {
      const share = layerBox(p)!.height / safeBox(r.doc).height;
      assert.ok(share >= 0.35, `${c.name}: product ${Math.round(share * 100)} % of the safe height`);
      assert.ok(r.doc.layers.some((l) => l.id === 'cta'), `${c.name}: CTA kept`);
    }
  }
  // Type follows the shorter side: a 1584×396 banner's headline is sized for 396, never for 1584.
  assert.equal(scaledType(defaultBrandKit(), 'headline', 1584, 396).size, Math.round(76 * 396 / 1080));
  assert.equal(scaledType(defaultBrandKit(), 'headline', 1080, 1920).size, 76, 'the post formats do not change');
  assert.ok(scaledType(defaultBrandKit(), 'note', 320).size >= 8);
});

test('a 320×320 service card stores the sizes it measured: no clamp, no overflow the build did not report', () => {
  const kit = defaultBrandKit();
  const claim = {
    id: 'claim_warranty', version: 2,
    title: { ar: 'ضمان (تجريبي)', en: 'Warranty (test)', ckb: 'گەرەنتی (تاقیکاری)' },
    summary: { ar: 'ضمان على الطابعات', en: 'Printer warranty', ckb: 'گەرەنتی چاپکەر' },
    conditions: { ar: 'يشمل عيوب التصنيع فقط لمدة سنة من تاريخ الشراء مع الفاتورة', en: 'Test conditions', ckb: 'مەرجی تاقیکاری' },
    details_path: null,
  };
  const r = built({ format: formatOf('custom', 320, 320)!, template: 'service_card', variant: 'feature_first', products: [], service: claim, objective: 'service_trust', copy: { headline: 'اطبع بثقة', cta: 'اعرف التفاصيل' } });
  for (const t of r.doc.layers.filter((l): l is TextLayer => l.type === 'text')) assert.ok(t.font.size >= 8 && t.minSize >= 8, `${t.id}: ${t.font.size}/${t.minSize}`);
  const n = normalizeDocument(JSON.parse(JSON.stringify(r.doc)));
  assert.deepEqual(n.issues, []);
  const q = qualityReport(n.doc, { brand: kit, snapshots: {}, claims: { claim_warranty: { ...claim, approved: true, valid_until: null } }, measure: approximateMeasurer, final: true, now: '2026-10-27T12:00:00Z' });
  assert.ok(!q.issues.some((i) => i.code === 'text_overflow'), JSON.stringify(q.issues));
});
