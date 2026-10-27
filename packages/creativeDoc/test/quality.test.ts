/**
 * Deterministic quality checks, text rules, Sorani strings and the AI output
 * schemas. Spec §8, §9, §23, §28, §34 acceptance 2, 4, 10; DECISIONS rows 183, 262.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BINDING_RULES, defaultBrandKit, normalizeBrandKit } from '../src/brand';
import { CAROUSEL_SCHEMA, COMPOSE_SCHEMA, EDIT_SCHEMA, IDEAS_SCHEMA, REVIEW_SCHEMA, validateIdeas } from '../src/aiContracts';
import { qualityReport, type QualityContext } from '../src/quality';
import { phrase, type BoundPhraseKey } from '../src/snapshot';
import { FAMILIES, TEMPLATES, VARIANT_LABELS, defaultCta } from '../src/templates';
import { approximateMeasurer, claimsIn, containsPriceLike, fitText, formatIqd, wrapText } from '../src/text';
import { built, snapshot } from './fixtures';

const kit = defaultBrandKit();
const ctx = (over: Partial<QualityContext> = {}): QualityContext => ({
  brand: kit, snapshots: { main: snapshot() }, claims: {}, measure: approximateMeasurer, final: false, now: '2026-10-27T12:00:00Z', ...over,
});
const codes = (r: ReturnType<typeof qualityReport>, severity?: string) => r.issues.filter((i) => !severity || i.severity === severity).map((i) => i.code);

test('a clean draft has no blockers, and the report says which checks ran and which were skipped', () => {
  const r = qualityReport(built().doc, ctx());
  assert.deepEqual(codes(r, 'blocker'), []);
  assert.ok(r.ran.includes('text_fit') && r.ran.includes('data'));
  assert.ok(r.skipped.some((s) => s.check === 'fonts'), 'font load state was not reported — said so, not passed');
});

test('final export: test data, an unverified price and a wrong-variant picture are blockers', () => {
  const doc = built().doc;
  const final = qualityReport(doc, ctx({ final: true }));
  assert.ok(codes(final, 'blocker').includes('test_data'));
  assert.ok(codes(final, 'blocker').includes('unverified_source'));
  const verified = qualityReport(doc, ctx({ final: true, snapshots: { main: { ...snapshot(), source: 'live' } }, verification: { main: [] } }));
  assert.deepEqual(codes(verified, 'blocker'), []);
  const changed = qualityReport(doc, ctx({ final: true, snapshots: { main: { ...snapshot(), source: 'live' } }, verification: { main: ['price_changed'] } }));
  assert.ok(codes(changed, 'blocker').includes('source_changed'));
  const wrongImage = { ...doc, layers: doc.layers.map((l) => (l.id === 'product' && l.type === 'image' ? { ...l, asset: { ...l.asset, ref: '/files/products/test/a1-solo.webp' } } : l)) };
  assert.ok(codes(qualityReport(wrongImage, ctx()), 'blocker').includes('wrong_variant_image'));
});

test('a price ad for an unpriced product is blocked; a typed price in free text is blocked', () => {
  const unpriced = snapshot({ price: { status: 'unpriced', amount_iqd: null, regular_iqd: null, from: false, offer: null, member_price_iqd: null } });
  const doc = built().doc;
  assert.ok(codes(qualityReport(doc, ctx({ snapshots: { main: unpriced } })), 'blocker').includes('price_unavailable'));
  const typed = { ...doc, layers: doc.layers.map((l) => (l.id === 'headline' && l.type === 'text' ? { ...l, text: 'الآن 999,000 د.ع فقط' } : l)) };
  assert.ok(codes(qualityReport(typed, ctx()), 'blocker').includes('unbound_price_text'));
});

test('fonts not loaded and pictures not decoded are blockers when the editor reports them', () => {
  const doc = built().doc;
  const r = qualityReport(doc, ctx({ fontsLoaded: new Set(), assetsLoaded: new Set() }));
  assert.ok(codes(r, 'blocker').includes('font_not_loaded'));
  assert.ok(codes(r, 'blocker').includes('asset_missing'));
});

test('text: wrapping keeps words whole, fitting never goes under the floor, money uses the brand digits', () => {
  const r = wrapText('طابعة Bambu Lab A1 Combo مع 4 بكرات', 300, { family: 'x', weight: 400, size: 30 }, approximateMeasurer);
  assert.equal(r.lines.join(' '), 'طابعة Bambu Lab A1 Combo مع 4 بكرات');
  const fit = fitText('كلمة '.repeat(80).trim(), { family: 'x', weight: 400, lineHeight: 1.3 }, { width: 300, maxHeight: 100, maxLines: 2 }, { max: 60, min: 30 }, approximateMeasurer);
  assert.equal(fit.size, 30);
  assert.equal(fit.fits, false);
  assert.equal(formatIqd(1250000, { digits: 'latn', label: 'د.ع' }), '1,250,000 د.ع');
  assert.equal(formatIqd(1250000, { digits: 'arab', label: 'د.ع' }), '١٬٢٥٠٬٠٠٠ د.ع');
  assert.equal(formatIqd(1250000, { digits: 'latn', label: 'IQD' }), 'IQD 1,250,000');
  // A number word (ألف, مليون) is a price only next to a currency word or a price word: "16 مليون لون" is a count.
  for (const t of ['1,250,000 د.ع', '250 ألف دينار', 'السعر 250 ألف', 'IQD 900', '٣٠٠ دينار', '$99']) assert.equal(containsPriceLike(t), true, t);
  for (const t of ['طابعة A1 مع 4 بكرات', 'دقة 0.1 مم', 'AMS lite', '16 مليون لون']) assert.equal(containsPriceLike(t), false, t);
  assert.deepEqual(claimsIn('الأرخص في العراق وآخر قطعة'), ['cheapest', 'last_piece']);
  assert.deepEqual(claimsIn('الأفضل في العراق'), ['superlative']);
});

test('every Sorani string in the package is Sorani: present, not Arabic, no Arabic-only letters', () => {
  const SORANI = /[ەۆێڕڵڤگچپژ]|ی/;
  const ARABIC_ONLY = /[ةىيك]/;
  const all: Array<{ ar: string; en: string; ckb: string; where: string }> = [];
  for (const k of ['price_on_request', 'members_price', 'from', 'available', 'preorder', 'unavailable', 'was', 'test_label'] as BoundPhraseKey[]) {
    all.push({ ar: phrase(k, 'ar'), en: phrase(k, 'en'), ckb: phrase(k, 'ckb'), where: `phrase.${k}` });
  }
  for (const r of BINDING_RULES) all.push({ ...r, where: `rule.${r.code}` });
  for (const [k, v] of Object.entries(VARIANT_LABELS)) all.push({ ...v, where: `variant.${k}` });
  for (const t of Object.values(TEMPLATES)) all.push({ ...t.label, where: `template.${t.id}` });
  for (const f of Object.values(FAMILIES)) { all.push({ ...f.label, where: `family.${f.id}` }); if (f.badge) all.push({ ...f.badge.text, where: `badge.${f.id}` }); }
  for (const a of ['available', 'preorder', 'unavailable', 'unknown', null] as const) {
    all.push({ ar: defaultCta(a, 'priced', 'ar'), en: defaultCta(a, 'priced', 'en'), ckb: defaultCta(a, 'priced', 'ckb'), where: `cta.${a}` });
  }
  all.push({ ar: defaultCta(null, 'unpriced', 'ar'), en: defaultCta(null, 'unpriced', 'en'), ckb: defaultCta(null, 'unpriced', 'ckb'), where: 'cta.unpriced' });
  for (const s of all) {
    assert.ok(s.ar && s.en && s.ckb, `${s.where}: three languages`);
    assert.notEqual(s.ckb, s.ar, `${s.where}: ckb is not the Arabic`);
    assert.ok(!ARABIC_ONLY.test(s.ckb), `${s.where}: no Arabic-only letters in "${s.ckb}"`);
    assert.ok(SORANI.test(s.ckb), `${s.where}: Sorani letters in "${s.ckb}"`);
  }
});

test('the AI schemas stay inside the structured-outputs limits', () => {
  const forbidden = ['minLength', 'maxLength', 'minimum', 'maximum', 'multipleOf', 'maxItems', 'format', 'pattern'];
  let unions = 0;
  let optional = 0;
  const walk = (s: unknown, path: string) => {
    if (!s || typeof s !== 'object') return;
    const o = s as Record<string, unknown>;
    for (const k of forbidden) assert.ok(!(k in o), `${path}: ${k}`);
    if ('anyOf' in o || Array.isArray(o.type)) unions++;
    if (o.type === 'object') {
      assert.equal(o.additionalProperties, false, `${path}: additionalProperties false`);
      const props = Object.keys(o.properties as object);
      const req = o.required as string[];
      optional += props.filter((p) => !req.includes(p)).length;
    }
    for (const [k, v] of Object.entries(o)) {
      // `properties` maps NAMES to schemas: its keys are property names (one is called "format"), not keywords.
      if (k === 'properties') for (const [name, sub] of Object.entries(v as object)) walk(sub, `${path}.properties.${name}`);
      else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}.${k}[${i}]`));
      else walk(v, `${path}.${k}`);
    }
  };
  for (const [name, schema] of Object.entries({ IDEAS_SCHEMA, COMPOSE_SCHEMA, EDIT_SCHEMA, REVIEW_SCHEMA, CAROUSEL_SCHEMA })) {
    unions = 0; optional = 0;
    walk(schema, name);
    assert.ok(unions <= 16, `${name}: ${unions} union parameters`);
    assert.equal(optional, 0, `${name}: every property is required`);
  }
});

test('ideas must point at supplied products and evidence; an arrival needs arrival evidence', () => {
  const base = { objective: 'sell', target_kind: 'product', target_ref: 'p1', audience: 'هواة', reason: 'وصل مخزون', evidence_ids: ['e1'], message: 'م', headline: 'طابعة جديدة للهواة', subhead: '', cta: 'اطلبها', post_type: 'single', layout: 'product_first', caption: '', alt_text: '' };
  const ctxI = { products: new Set(['p1']), services: new Set<string>(), categories: new Set<string>(), evidence: [{ id: 'e1', kind: 'offer' as const, ref: 'p1' }], max: 5 };
  const r = validateIdeas({ ideas: [base, { ...base, target_ref: 'ghost' }, { ...base, evidence_ids: ['nope'] }, { ...base, objective: 'arrival' }, { ...base, headline: 'الأرخص في العراق' }], notes: [] }, ctxI);
  assert.equal(r.ideas.length, 1);
  assert.deepEqual(r.rejected.map((x) => x.code), ['unknown_target', 'unknown_evidence', 'no_evidence', 'unsupported_claim']);
});

test('the brand kit gate clamps and refuses bad values', () => {
  const r = normalizeBrandKit({ colors: { background: 'red', text: '#FFFFFF' }, fonts: { primary: 'Comic Sans' }, type: { headline: { size: 999, min: 2 } }, evil: 1 });
  assert.equal(r.kit.colors.background, kit.colors.background);
  assert.equal(r.kit.colors.text, '#ffffff');
  assert.equal(r.kit.fonts.primary, 'plex-arabic');
  assert.equal(r.kit.type.headline.size, 200);
  assert.ok(r.kit.type.headline.min >= 20);
  assert.ok(r.issues.some((i) => i.code === 'unknown_key'));
});
