/**
 * The text guards (price-like text, links, claims) and the checks that hold
 * bound text, product size and picture ratio to the data — review findings
 * security-1/2, model-3, 5–12, 15, spec-11, editor-8 (QA part).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultBrandKit } from '../src/brand';
import { textProblems, validateCarousel, validateCompose, validateEditPatch, validateIdeas } from '../src/aiContracts';
import { refreshBoundText, type BindingContext } from '../src/layout';
import { normalizeDocument } from '../src/normalize';
import { qualityReport, type QualityContext } from '../src/quality';
import { FORMATS, type CreativeDocument, type DocFormat, type ImageLayer, type Layer, type TextLayer } from '../src/schema';
import type { ServiceClaimText } from '../src/snapshot';
import { variantsFor } from '../src/templates';
import { approximateMeasurer, claimsIn, containsPriceLike, containsUrl, unsupportedClaims, type ClaimKind } from '../src/text';
import { allowedFor, built, product, snapshot } from './fixtures';

const kit = defaultBrandKit();
const NONE = { offer: false, serviceClaim: false };
const ZW = '\u200B';
const ctx = (over: Partial<QualityContext> = {}): QualityContext => ({
  brand: kit, snapshots: { main: snapshot() }, claims: {}, measure: approximateMeasurer, final: false, now: '2026-10-27T12:00:00Z', ...over,
});
const codes = (r: ReturnType<typeof qualityReport>, severity?: string) => r.issues.filter((i) => !severity || i.severity === severity).map((i) => i.code);
const withLayer = (doc: CreativeDocument, id: string, f: (l: Layer) => Layer): CreativeDocument => ({ ...doc, layers: doc.layers.map((l) => (l.id === id ? f(l) : l)) });
const setText = (doc: CreativeDocument, id: string, text: string) => withLayer(doc, id, (l) => ({ ...(l as TextLayer), text }));

test('security-1: invisible characters, Persian/fullwidth digits and harakat do not hide a price, a link or a claim', () => {
  const prices = [
    `A1 بسعر 1${ZW},${ZW}250${ZW},${ZW}000${ZW} د.ع`, 'نرخ: ۱٬۲۵۰٬۰۰۰ دینار', 'السعر ۱٬۲۵۰٬۰۰۰ د.ع', '１，２５０，０００ IQD', `1\u2060,250\u2060,000\u2060 د.ع`,
  ];
  for (const t of prices) assert.equal(containsPriceLike(t), true, t);
  for (const t of [`levonis-deals${ZW}.com`, 'levonis-deals．com', `www${ZW}.example${ZW}.com`]) assert.equal(containsUrl(t), true, t);
  assert.deepEqual(claimsIn(`مج${ZW}اني`), ['free']);
  assert.deepEqual(claimsIn('مَجّاني'), ['free']);
  assert.deepEqual(claimsIn('خـصم'), ['discount']);
  assert.deepEqual(claimsIn(`Fr${ZW}ee delivery`), ['free']);
  // Ordinary Sorani with a ZWNJ inside a word stays clean.
  for (const t of ['چاپکەری خێرا بۆ\u200Cماڵەوە', 'تازەترین تەکنەلۆژیا']) {
    assert.equal(containsPriceLike(t) || containsUrl(t) || claimsIn(t).length > 0, false, t);
  }
  // The AI gate refuses the hidden variants; the approval blocker fires on a Persian-digit price; the stored text is unchanged.
  assert.equal(textProblems([`Fr${ZW}ee delivery — only 1${ZW},${ZW}250${ZW},${ZW}000${ZW} IQD at levonis-deals${ZW}.com`], NONE)?.code, 'price_like_text');
  assert.equal(textProblems([`order at levonis-deals${ZW}.com`], NONE)?.code, 'invented_link');
  const typed = setText(built().doc, 'headline', 'نرخ: ۱٬۲۵۰٬۰۰۰ دینار');
  assert.ok(codes(qualityReport(typed, ctx()), 'blocker').includes('unbound_price_text'));
  const n = normalizeDocument(setText(built().doc, 'headline', `بسعر 1${ZW},250 د.ع`));
  assert.equal((n.doc.layers.find((l) => l.id === 'headline') as TextLayer).text, `بسعر 1${ZW},250 د.ع`);
});

test('model-5 / model-6: price-like text — the reviewer’s misses are caught, specs with units are not prices', () => {
  const price = [
    '۲۵۰٬۰۰۰ دینار', '۱۲۳ هەزار دینار', '۲۵۰ هەزار دینار', 'السعر ألف دينار فقط', 'بأقل من مليون دينار', 'خمسمائة ألف دينار', '899K IQD', '1.250.000',
    'تەنها ۲۵۰ هەزار دینار', 'السعر مليون دينار فقط', 'بتسعمئة ألف دينار', '899k دع', 'السعر 250 ألف', '1,250,000', '١٬٢٥٠٬٠٠٠', '250 ألف دينار',
  ];
  const notPrice = [
    'تسارع 20,000 مم/ث²', 'Acceleration 20,000 mm/s²', 'عمر يصل إلى 10,000 ساعة', '16 مليون لون', 'يدعم 4 دعامات', '1,000 ساعة طباعة', 'تبريد 3 دعامات',
    'سرعة 500 مم/ث', '256 لون', 'Rated power 350W', 'version 1.2.3', '250 ألف',
  ];
  for (const t of price) assert.equal(containsPriceLike(t), true, `price: ${t}`);
  for (const t of notPrice) assert.equal(containsPriceLike(t), false, `not a price: ${t}`);
  const r = validateCompose({ proposals: [{ variant: 'product_first', reason: 'r', headline: 'تەنها ۲۵۰ هەزار دینار', subhead: '', features: [], cta: '', caption: '', alt_text: '' }] }, { variants: ['product_first'], evidence: NONE, maxFeatures: 3 });
  assert.equal(r.proposals.length, 0);
  assert.equal(r.rejected[0].code, 'price_like_text');
  const spec = setText(built().doc, 'headline', 'تسارع 20,000 مم/ث²');
  assert.ok(!codes(qualityReport(spec, ctx())).includes('unbound_price_text'));
});

test('model-7: ordinary product and lesson copy makes no claim', () => {
  const ordinary = [
    'Integrated AI camera, auto-calibrated bed', 'مستشعر نفاد الخيط يوقف الطباعة تلقائياً', 'استخدم حشوة 15% فقط', 'Tangle-free filament', 'BPA-free PLA',
    'Auto power off', 'Preview your print', 'موديل رقم 1200', 'Rated power 350W', 'accelerated printing', 'نسبة الحشوة 20%', 'رطوبة أقل من 10%',
  ];
  for (const t of ordinary) assert.deepEqual(claimsIn(t), [], t);
  const c = validateCarousel({ slides: [{ purpose: 'explain', headline: 'استخدم حشوة 15% فقط', body: 'Auto power off بعد الطباعة', uses_product: false }], caption: '', alt_texts: [] }, { evidence: NONE, maxSlides: 5 });
  assert.equal(c.slides.length, 1);
  // The real claims still match.
  for (const [t, kind] of [['50% off', 'discount'], ['خصم 20%', 'discount'], ['Free delivery', 'free'], ['Top rated printer', 'rating'], ['حتى نفاد الكمية', 'last_piece'], ['رقم 1 في العراق', 'superlative']] as const) {
    assert.ok(claimsIn(t).includes(kind), `${t} → ${kind}`);
  }
});

test('model-8 / spec-11: arrival, back in stock, availability, warranty in words and the other common phrasings are claims', () => {
  const table: Array<[string, string]> = [
    ['وصل حديثاً', 'arrival'], ['Just arrived', 'arrival'], ['تازە گەیشت', 'arrival'],
    ['عاد للتوفر', 'back_in_stock'], ['Back in stock', 'back_in_stock'], ['دووبارە بەردەستە', 'back_in_stock'],
    ['متوفر الآن', 'availability'], ['Available now', 'availability'], ['In stock today', 'availability'],
    ['كفالة سنتين على الطابعة', 'warranty_term'], ['ضمان لمدة عام كامل', 'warranty_term'], ['ضمان سنتين', 'warranty_term'], ['سنتين ضمان', 'warranty_term'],
    ['two-year warranty', 'warranty_term'], ['ضمان لمدة سنة كاملة', 'warranty_term'], ['كفالة سنة', 'warranty_term'], ['ضمان عامين', 'warranty_term'], ['ضمان 2 سنة', 'warranty_term'],
    ['بأقل الأسعار في العراق', 'cheapest'], ['بأفضل سعر', 'cheapest'], ['آخر حبة بالمخزن', 'last_piece'], ['باقي قطعتين بس', 'last_piece'],
    ['نص السعر', 'discount'], ['وفّر ربع السعر', 'discount'],
  ];
  for (const [t, kind] of table) assert.ok(claimsIn(t).includes(kind as ClaimKind), `${t} → ${kind}`);
  assert.deepEqual(claimsIn('Back in stock'), ['back_in_stock'], '"back in stock" is not also an availability claim');
  // Evidence: arrival and back in stock need their record; availability is never free text.
  assert.deepEqual(unsupportedClaims('وصل حديثاً', NONE), ['arrival']);
  assert.deepEqual(unsupportedClaims('وصل حديثاً', { ...NONE, arrival: true }), []);
  assert.deepEqual(unsupportedClaims('عاد للتوفر', { ...NONE, backInStock: true }), []);
  assert.deepEqual(unsupportedClaims('متوفر الآن', { offer: true, serviceClaim: true, arrival: true, backInStock: true }), ['availability']);
  assert.equal(textProblems(['ضمان سنتين من الوكيل'], NONE)?.code, 'unsupported_claim');
  // Ideas: the arrival evidence for the idea's own target allows the arrival words.
  const idea = { objective: 'arrival', target_kind: 'product', target_ref: 'p1', audience: 'هواة', reason: 'وصل مخزون', evidence_ids: ['e1'], message: 'م', headline: 'وصل حديثاً إلى المتجر', subhead: '', cta: 'اطلبها', post_type: 'single', layout: 'product_first', caption: '', alt_text: '' };
  const ideasCtx = (kind: 'arrival' | 'offer', ref = 'p1') => ({ products: new Set(['p1', 'p2']), services: new Set<string>(), categories: new Set<string>(), evidence: [{ id: 'e1', kind, ref }], max: 5 });
  assert.equal(validateIdeas({ ideas: [idea], notes: [] }, ideasCtx('arrival')).ideas.length, 1);
  assert.equal(validateIdeas({ ideas: [{ ...idea, objective: 'sell' }], notes: [] }, ideasCtx('offer')).rejected[0].code, 'unsupported_claim');
});

test('spec-11: the checks re-check claims in free text, with evidence from the bindings', () => {
  const doc = setText(built().doc, 'headline', 'ضمان سنتين على الطابعة');
  const r = qualityReport(doc, ctx());
  assert.ok(codes(r, 'blocker').includes('unsupported_claim_text'));
  // An approved, current service claim bound to the design supports the warranty words.
  const svc = { ...doc, services: [{ claim_id: 'claim_warranty', claim_version: 2 }] };
  const claim = { id: 'claim_warranty', version: 2, title: { ar: 'ضمان', en: 'Warranty', ckb: 'گەرەنتی' }, summary: { ar: 'س', en: 's', ckb: 'س' }, conditions: { ar: '', en: '', ckb: '' }, details_path: null, approved: true, valid_until: null };
  assert.ok(!codes(qualityReport(svc, ctx({ claims: { claim_warranty: claim } }))).includes('unsupported_claim_text'));
  // A discount needs a live public offer on the bound snapshot.
  const sale = setText(built().doc, 'headline', 'خصم خاص هذا الأسبوع');
  assert.ok(codes(qualityReport(sale, ctx()), 'blocker').includes('unsupported_claim_text'));
  const offered = snapshot({ price: { status: 'priced', amount_iqd: 1000000, regular_iqd: 1250000, from: false, offer: { starts_at: null, ends_at: null }, member_price_iqd: null } });
  assert.ok(!codes(qualityReport(sale, ctx({ snapshots: { main: offered } }))).includes('unsupported_claim_text'));
  // Arrival words: judged with the catalogue watch's evidence, skipped (and said so) without it.
  const arrival = setText(built().doc, 'headline', 'وصل حديثاً');
  const unreported = qualityReport(arrival, ctx());
  assert.ok(!codes(unreported).includes('unsupported_claim_text'));
  assert.ok(unreported.skipped.some((s) => s.check === 'claims'));
  assert.ok(codes(qualityReport(arrival, ctx({ claimEvidence: { arrival: false } })), 'blocker').includes('unsupported_claim_text'));
  assert.ok(!codes(qualityReport(arrival, ctx({ claimEvidence: { arrival: true } }))).includes('unsupported_claim_text'));
  assert.ok(!qualityReport(built().doc, ctx()).skipped.some((s) => s.check === 'claims'), 'no claim words, nothing skipped');
});

test('security-2: a carousel caption with a price, a link or a claim is refused', () => {
  const caption = 'Free delivery & 50% discount today only! Was 1,800,000 IQD, now 900,000 IQD — order at levonis-deals.com';
  const r = validateCarousel({ slides: [{ purpose: 'opening', headline: 'كيف تختار خيط الطباعة', body: '', uses_product: false }], caption, alt_texts: [] }, { evidence: NONE, maxSlides: 5 });
  assert.equal(r.caption, '');
  assert.equal(r.slides.length, 1);
  assert.deepEqual(r.rejected, [{ index: -1, code: 'price_like_text', detail: 'caption' }]);
  const ok = validateCarousel({ slides: [], caption: 'خمس نصائح لطباعة أنظف', alt_texts: [] }, { evidence: NONE, maxSlides: 5 });
  assert.equal(ok.caption, 'خمس نصائح لطباعة أنظف');
});

test('model-3: bound text that cannot render is never drawn as data', () => {
  const doc = built().doc;
  // A price_note on the real slot, with no live offer, carrying invented words.
  const note: TextLayer = { ...(doc.layers.find((l) => l.id === 'price') as TextLayer), id: 'price_note', role: 'price_note', y: 900, source: { kind: 'product', slot: 'main', field: 'price_note' }, text: 'بدلاً من 1,500,000 د.ع — خصم 50%' };
  const withNote = { ...doc, layers: [...doc.layers, note] };
  const r = qualityReport(withNote, ctx());
  assert.ok(r.issues.some((i) => i.code === 'bound_text_missing' && i.severity === 'blocker' && i.layer_ids.includes('price_note')));
  // refreshBoundText empties it instead of keeping the stored words.
  const bctx: BindingContext = { snapshots: { main: snapshot() }, claims: {}, brand: kit, locale: 'ar', slide: null };
  const refreshed = refreshBoundText(withNote, bctx);
  assert.equal((refreshed.layers.find((l) => l.id === 'price_note') as TextLayer).text, '');
  // No snapshot loaded at all: the layer is left as it is (snapshot_missing reports it).
  assert.equal((refreshBoundText(withNote, { ...bctx, snapshots: {} }).layers.find((l) => l.id === 'price_note') as TextLayer).text, note.text);
  // A text bound to a slot with no binding: normalize makes it free text, and the typed price is caught.
  const ghost = { ...doc, products: [], layers: doc.layers.map((l) => (l.id === 'price' ? { ...(l as TextLayer), source: { kind: 'product' as const, slot: 'ghost', field: 'price' as const }, text: '99,000 د.ع' } : l)) };
  const n = normalizeDocument(ghost);
  assert.equal(n.ok, true);
  assert.deepEqual((n.doc.layers.find((l) => l.id === 'price') as TextLayer).source, { kind: 'free' });
  assert.ok(n.issues.some((i) => i.path === 'layers.price.source'));
  assert.ok(codes(qualityReport(n.doc, ctx()), 'blocker').includes('unbound_price_text'));
  assert.deepEqual(normalizeDocument(n.doc).issues, [], 'idempotent');
  // Unnormalised input (the checks never trust the caller): a missing binding is a blocker on its own.
  const orphan = qualityReport(ghost, ctx());
  assert.ok(orphan.issues.some((i) => i.code === 'bound_text_missing' && i.detail === 'no binding'));
});

test('model-12: service text renders only from the claim version the design is bound to', () => {
  const doc = built().doc;
  const conditions: TextLayer = { ...(doc.layers.find((l) => l.id === 'headline') as TextLayer), id: 'service_conditions', role: 'body', y: 960, source: { kind: 'service', claim_id: 'claim_warranty', field: 'conditions' }, text: 'يشمل عيوب التصنيع فقط لمدة سنة' };
  const svc: CreativeDocument = { ...doc, services: [{ claim_id: 'claim_warranty', claim_version: 2 }], layers: [...doc.layers, conditions] };
  const claim = (version: number, ar: string): ServiceClaimText => ({ id: 'claim_warranty', version, title: { ar: 'ضمان', en: 'Warranty', ckb: 'گەرەنتی' }, summary: { ar: 'س', en: 's', ckb: 'س' }, conditions: { ar, en: 'x', ckb: 'ی' }, details_path: null });
  const bctx = (c: ServiceClaimText): BindingContext => ({ snapshots: { main: snapshot() }, claims: { claim_warranty: c }, brand: kit, locale: 'ar', slide: null });
  const v3 = refreshBoundText(svc, bctx(claim(3, 'يشمل عيوب التصنيع فقط لمدة ستة أشهر')));
  assert.equal((v3.layers.find((l) => l.id === 'service_conditions') as TextLayer).text, 'يشمل عيوب التصنيع فقط لمدة سنة', 'a newer version never rewrites the design');
  const v2 = refreshBoundText(svc, bctx(claim(2, 'يشمل عيوب التصنيع فقط لمدة سنة كاملة')));
  assert.equal((v2.layers.find((l) => l.id === 'service_conditions') as TextLayer).text, 'يشمل عيوب التصنيع فقط لمدة سنة كاملة');
});

test('model-11: a product whose recorded natural size has another ratio than its picture is a blocker', () => {
  const doc = withLayer(built().doc, 'product', (l) => ({ ...(l as ImageLayer), natural: { width: 1200, height: 400 } }));
  const r = qualityReport(doc, ctx());
  assert.ok(r.issues.some((i) => i.code === 'product_transformed' && i.severity === 'blocker' && i.detail === 'stretched'));
  assert.ok(!codes(qualityReport(built().doc, ctx())).includes('product_transformed'));
});

test('model-15: text under the readable floor is reported', () => {
  const doc = withLayer(built().doc, 'headline', (l) => ({ ...(l as TextLayer), font: { ...(l as TextLayer).font, size: 8 }, minSize: 8 }));
  const n = normalizeDocument(doc);
  assert.ok(codes(qualityReport(n.doc, ctx())).includes('small_text'));
  assert.ok(!codes(qualityReport(built().doc, ctx())).includes('small_text'));
});

test('model-9: a chip selected as its group can have its words edited', () => {
  const doc = built().doc;
  const pctx = { documentId: 'doc_1', version: 3, doc, scope: ['cta_group'], evidence: NONE, ops: { brand: kit, allowed: allowedFor(), measure: approximateMeasurer } };
  const patch = (targets: string[], ops: unknown[]) => ({ schema_version: 1, document_id: 'doc_1', base_document_version: 3, intent: 'edit', target_layer_ids: targets, operations: ops, reason: 'r', warnings: [], clarification: '' });
  const v = validateEditPatch(patch(['cta'], [{ op: 'set_text', layer_id: 'cta', value: 'احجز الآن' }]), pctx);
  assert.equal(v.ok, true, JSON.stringify(v));
  // Still only the selection: the headline is outside it.
  const out = validateEditPatch(patch(['headline'], [{ op: 'set_text', layer_id: 'headline', value: 'عنوان آخر' }]), pctx);
  assert.equal(out.ok === false && out.code, 'target_outside_scope');
});

test('model-10: a product reduced to a speck is a blocker, one under its share needs a look; standard builds are clean', () => {
  const tiny = withLayer(built().doc, 'product', (l) => ({ ...(l as ImageLayer), scale: 0.01 }));
  assert.ok(qualityReport(tiny, ctx()).issues.some((i) => i.code === 'product_too_small' && i.severity === 'blocker'));
  const small = withLayer(built().doc, 'product', (l) => ({ ...(l as ImageLayer), scale: (l as ImageLayer).scale * 0.4 }));
  assert.ok(qualityReport(small, ctx()).issues.some((i) => i.code === 'product_too_small' && i.severity === 'review'));
  for (const format of ['square', 'portrait', 'story'] as const) {
    for (const [template, imageIndex] of [['product_hero', 0], ['compact_product', 1]] as const) {
      for (const variant of variantsFor(template, 'sell', 'priced')) {
        const b = built({ template, variant, format: FORMATS[format] as DocFormat, products: [product(snapshot(), imageIndex)] });
        const issues = qualityReport(b.doc, ctx()).issues.filter((i) => i.code === 'product_too_small');
        assert.deepEqual(issues, [], `${format} ${template} ${variant}`);
      }
    }
  }
});

test('editor-8: a picture that decodes at another ratio than recorded is a blocker', () => {
  const doc = built().doc;
  const productRef = (doc.layers.find((l) => l.id === 'product') as ImageLayer).asset.ref;
  const r = qualityReport(doc, ctx({ decodedSizes: { [productRef]: { width: 800, height: 1200 }, site: { width: 1254, height: 1254 } } }));
  assert.ok(r.issues.some((i) => i.code === 'asset_ratio_mismatch' && i.severity === 'blocker' && i.layer_ids.includes('product')));
  const same = qualityReport(doc, ctx({ decodedSizes: { [productRef]: { width: 2400, height: 1600 } } }));
  assert.ok(!codes(same).includes('asset_ratio_mismatch'));
  assert.ok(same.ran.includes('assets'));
});
