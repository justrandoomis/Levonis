/**
 * «Three compositions» are three for product posts (spec §12, finding
 * spec-9): the headline-first composition is a genuinely different layout —
 * a large headline leads, the product keeps a real share, the price and the
 * CTA stay — and a variant or priority the template does not have is refused
 * with its own code instead of silently re-laying the first variant
 * (finding editor-9).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultBrandKit } from '../src/brand';
import { applyOps } from '../src/ops';
import { contains, FORMATS, layerBox, safeBox, type DocFormat, type ImageLayer, type TextLayer } from '../src/schema';
import { TEMPLATES, variantsFor } from '../src/templates';
import { approximateMeasurer } from '../src/text';
import { allowedFor, built, product, snapshot } from './fixtures';

const kit = defaultBrandKit();
const formats: DocFormat[] = [FORMATS.square, FORMATS.portrait, FORMATS.story];
const COPY = {
  ar: { headline: 'طباعة ثلاثية الأبعاد بدقة مذهلة', cta: 'اطلبها الآن' },
  en: { headline: 'Precise 3D printing for every project', cta: 'Order now' },
};

test('priced and unpriced product posts both get three different compositions, whatever the goal', () => {
  for (const template of ['product_hero', 'compact_product'] as const) {
    for (const objective of ['sell', 'arrival', 'back_in_stock', 'feature', 'education', 'service_trust'] as const) {
      for (const status of ['priced', 'unpriced'] as const) {
        const three = variantsFor(template, objective, status).slice(0, 3);
        assert.equal(new Set(three).size, 3, `${template}/${objective}/${status}: ${three}`);
        if (status === 'unpriced' || objective === 'education' || objective === 'feature') assert.ok(!three.includes('price_first'), `${template}/${objective}/${status}`);
      }
    }
  }
  // Service cards and lessons keep their real counts.
  assert.equal(variantsFor('service_card', 'service_trust', null).length, 2);
  assert.equal(variantsFor('education_slide', 'education', null).length, 1);
});

test('headline-first lays out in every format and language: a large leading headline, a well-sized product, the price and the CTA kept', () => {
  for (const template of ['product_hero', 'compact_product'] as const) {
    const pic = template === 'product_hero' ? product() : product(snapshot(), 1); // a wide printer, a square spool shot
    for (const locale of ['ar', 'en'] as const) {
      for (const format of formats) {
        const tag = `${template}/${locale}/${format.id}`;
        const r = built({ template, variant: 'headline_first', format, locale, products: [pic], copy: COPY[locale] });
        const ref = built({ template, variant: 'product_first', format, locale, products: [pic], copy: COPY[locale] });
        assert.deepEqual(r.conflicts, [], `${tag}: ${JSON.stringify(r.conflicts)}`);
        const safe = safeBox(r.doc);
        for (const l of r.doc.layers) {
          if (['headline', 'product', 'product_name', 'price', 'cta', 'logo'].includes(l.role) && l.type !== 'group') assert.ok(contains(safe, layerBox(l, r.doc.layers)!, 1), `${tag}: ${l.id} inside the safe area`);
        }
        const h = r.doc.layers.find((l) => l.id === 'headline') as TextLayer;
        const p = r.doc.layers.find((l): l is ImageLayer => l.id === 'product')!;
        const pb = layerBox(p)!;
        assert.ok(Math.abs(pb.width / pb.height - p.natural.width / p.natural.height) < 1e-9, `${tag}: product undistorted`);
        // It leads: the first text from the top, set from the start edge, larger than the product-first headline.
        const texts = r.doc.layers.filter((l): l is TextLayer => l.type === 'text');
        assert.equal(texts.slice().sort((a, b) => a.y - b.y)[0].id, 'headline', tag);
        assert.equal(h.align, 'start', tag);
        assert.ok(h.font.size > (ref.doc.layers.find((l) => l.id === 'headline') as TextLayer).font.size, `${tag}: ${h.font.size}px leads`);
        assert.ok(h.y + h.height <= pb.y, `${tag}: the headline is above the product`);
        assert.ok(pb.height / safe.height >= 0.3, `${tag}: product ${Math.round(pb.height)}px of ${Math.round(safe.height)}`);
        for (const id of ['product_name', 'price', 'cta']) assert.ok(r.doc.layers.some((l) => l.id === id), `${tag}: ${id} kept`);
        assert.equal(r.doc.priority, 'headline');
      }
    }
  }
});

test('a variant or a priority the template does not have is refused with its own code', () => {
  const ai = { actor: 'ai' as const, brand: kit, allowed: allowedFor(), measure: approximateMeasurer };
  const pair = built({
    template: 'comparison', variant: 'product_first', objective: 'comparison',
    products: [product(), { ...product(), slot: 'p2' }],
  }).doc;
  assert.deepEqual(Object.keys(TEMPLATES.comparison.variants), ['product_first']);
  const v = applyOps(pair, [{ op: 'switch_template_variant', variant: 'price_first' }], ai);
  assert.ok(!v.ok && v.refusals[0].code === 'unknown_variant', JSON.stringify(v));
  const p = applyOps(pair, [{ op: 'set_priority', priority: 'price' }], ai);
  assert.ok(!p.ok && p.refusals[0].code === 'priority_unavailable', JSON.stringify(p));
  // A hand-made document has no template to re-lay from.
  const free = { ...built().doc, template: null };
  assert.ok(!applyOps(free, [{ op: 'set_priority', priority: 'headline' }], ai).ok);
  // The product templates now have a headline-first composition.
  const hero = applyOps(built().doc, [{ op: 'set_priority', priority: 'headline' }], ai);
  assert.ok(hero.ok && hero.rebuild?.kind === 'priority');
  assert.ok(applyOps(built().doc, [{ op: 'switch_template_variant', variant: 'headline_first' }], ai).ok);
});
