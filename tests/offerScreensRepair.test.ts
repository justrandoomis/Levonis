/**
 * THE OFFER AND REQUEST SCREENS, THIRD REVIEW (P1-05, docs/DECISIONS.md row
 * 267) — the pure halves of the screens, and the lines that wire them.
 *
 * Pinned:
 *   composer   a material-only substitution survives an edit untouched (no
 *              colour invented from the stored labels); a colour the merchant
 *              proposed keeps its hex; the default coverage applied when the
 *              verdict arrives is part of the baseline, so an untouched
 *              composer is not dirty.
 *   my list    «طلباتي» reads the summary: the technical review, an estimate of
 *              the priced parts only, the model files not priced — three
 *              languages.
 *   words      a substitution and an agreement read in the reader's language:
 *              catalogue names in Sorani, palette colours by name, the list
 *              separator of the language — on the offer, the accepted offer,
 *              the order screen and the composer's material list.
 *   partial    without the parts loaded, a partial offer is not counted 1/1
 *              and cannot be acknowledged as leaving out «—».
 *   compare    the «complete offers» note only when the picks really came
 *              from complete offers; a pick from the partial pool says so.
 *   review     «as in the reference» is a word, not a blank; the age is
 *              label first; the reviewer opens the files; a colour-only
 *              substitution reads as colours, not «PLA بدل PLA».
 *
 * Fourth review (round 2):
 *   bidi       a substitution line is drawn in the reader direction with
 *              each side isolated, never `dir="auto"`.
 *   accepted   a partial accepted offer is marked partial without the parts.
 *   merchant   the own offer card shows its coverage and substitutes.
 *   seen       a new offer and a sent draft carry the revision rendered.
 *   words      the composer chips, the admin review and the order screen
 *              read in the reader language; «Part n», not «#n»; the
 *              substitute refusal names its remedy.
 *   my list    the unpriced files only beside an estimate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

(globalThis as { localStorage?: unknown }).localStorage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
const parts = await import('../src/components/community/requests/offerParts');
const { requestStrings } = await import('../src/components/community/requests/strings');
const { partsBody } = await import('../src/components/community/requests/OfferPartsField');
const composer = await import('../src/components/community/requests/OfferComposer');
const { readAgreement, agreementSide } = await import('../src/components/merchant/orders/CustomOrderScreen');
const { myRequestNotes } = await import('../src/components/print/MyRequestsList');
const review = await import('../src/components/adminCommunity/reviewWords');
const { resolveCoverage, readCoverageBody } = await import('../worker/lib/offerCoverage');
import type { OfferV2 } from '../src/components/community/requests/api';
import type { MyRequestRow } from '../src/lib/printApi';

const code = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const offer = (o: Partial<OfferV2> = {}): OfferV2 =>
  ({
    id: 'o1', request_id: 'r1', merchant_id: 'm1', store_id: 's1', price_iqd: 20_000, delivery_fee_iqd: 0, total_iqd: 20_000,
    quantity: null, color: '', terms: '', completion_days: 3, delivery_method: 'merchant_delivery', message: '', materials: '',
    material_ids: [], included: '', warranty_terms: '', state: 'pending', draft: false, expires_at: null, valid_until: null,
    created_at: '', updated_at: '', revision: 1, request_revision: 1, revised: false, stale: false, expired: false, files: [],
    merchant: null, ...o,
  }) as OfferV2;

const BLACK_RED = [{ hex: '#111111', label: 'Black' }, { hex: '#ff0000', label: 'Red' }];
const MODEL = {
  revision: 1, hash: 'h', legacy: false,
  model: {
    sources: [],
    parts: [{
      id: 'p1', position: 0, name: '', quantity: 1, process: 'fdm', legacy_text: '',
      materials: [{ id: 'm1', material_id: 'tpu', material_unsure: false, colors: BLACK_RED.map((c) => ({ mode: 'catalogue', ...c })) }],
    }],
  },
} as never;
const MATS = [{ id: 'tpu', process: 'fdm' }, { id: 'petg', process: 'fdm' }];

// ---------------------------------------------------------------- composer

test('composer: a material-only substitution comes back from an edit as material only, the colours as asked', () => {
  const from = { material_id: 'tpu', colors: BLACK_RED };
  const stored = { part_id: 'p1', material_row_id: 'm1', from, to: { material_id: 'petg', colors: BLACK_RED }, note: '' };
  const v = composer.partsFrom(offer({ coverage: { covers_all: true, parts: null }, substitutions: [stored] }));
  assert.deepEqual(v.subs[0].colors, [], 'no colour pre-chosen that the merchant never proposed');
  const body = partsBody(v, { clear: true });
  assert.deepEqual(body.substitutions?.[0].to, { material_id: 'petg' });
  const out = resolveCoverage(readCoverageBody(body as never), MODEL, MATS);
  assert.deepEqual(out.substitutions[0].to, { material_id: 'petg', colors: BLACK_RED });
});

test('composer: a colour the merchant proposed keeps its hex through an edit; a palette colour chosen instead is sent with its hex (review 6)', () => {
  const green = [{ hex: '#16a34a', label: 'Green' }];
  const stored = { part_id: 'p1', material_row_id: 'm1', from: { material_id: 'tpu', colors: BLACK_RED }, to: { material_id: 'tpu', colors: green }, note: 'n' };
  const v = composer.partsFrom(offer({ substitutions: [stored] }));
  assert.deepEqual(v.subs[0].colors, green);
  assert.deepEqual(partsBody(v, { clear: true }).substitutions?.[0].to, { material_id: 'tpu', colors: green });
  const chosen = { ...v, subs: [{ ...v.subs[0], colors: [{ hex: '#388e3c', label: 'Green' }] }] };
  assert.deepEqual(partsBody(chosen, { clear: true }).substitutions?.[0].to, { material_id: 'tpu', colors: [{ hex: '#388e3c', label: 'Green' }] });
});

test('composer: the default ticks applied when the verdict arrives are the baseline — an untouched composer is not dirty', () => {
  const ps = [{ id: 'pa' }, { id: 'pb' }];
  const start = composer.partsFrom(null);
  const baseline = JSON.stringify(start);
  const next = composer.applyPartVerdicts(start, baseline, ps, [{ part_id: 'pa', eligible: true, reasons: [] }, { part_id: 'pb', eligible: false, reasons: ['MATERIAL'] }]);
  assert.deepEqual(next.value.coverage, ['pa']);
  assert.equal(next.baseline, JSON.stringify(next.value), 'the default is not a change');
  // A merchant who already changed the ticks keeps their change and their baseline.
  const touched = { coverage: ['pb'], subs: [] };
  const kept = composer.applyPartVerdicts(touched, baseline, ps, [{ part_id: 'pa', eligible: true, reasons: [] }]);
  assert.deepEqual(kept.value, touched);
  assert.equal(kept.baseline, baseline);
  assert.match(code('src/components/community/requests/OfferComposer.tsx'), /applyPartVerdicts\(/);
});

// ----------------------------------------------------------------- my list

const ESTIMATED = { estimate_low_iqd: 10_000, estimate_high_iqd: 14_000 } as unknown as MyRequestRow['print'];
const myRow = (summary: MyRequestRow['summary'], print: MyRequestRow['print'] = ESTIMATED): MyRequestRow =>
  ({ id: 'r', title: 't', state: 'open', quantity: 1, material: '', color: '', budget_iqd: null, deadline: null, governorate: '', offer_count: 0, file_count: 0, created_at: '', summary, print, accepted: null }) as MyRequestRow;

test('my requests: the review chip, a priced-parts-only estimate and the unpriced model files, in three languages', () => {
  const r = myRow({ parts_count: 2, pieces_per_set: 2, review_state: 'needs_technical_review', estimate_complete: false, models_unpriced: 2 });
  const ar = myRequestNotes(r, 'ar');
  assert.equal(ar.review, requestStrings('ar').reviewChip);
  assert.equal(ar.partial, requestStrings('ar').estimatePricedOnly);
  assert.equal(ar.unpriced, 'ملفات نماذج أخرى لم يشملها التقدير: 2');
  assert.equal(myRequestNotes(r, 'en').partial, 'Estimate for the priced parts only, not the whole request');
  const ckb = myRequestNotes(r, 'ckb');
  assert.equal(ckb.review, 'پێویستی بە پێداچوونەوەی تەکنیکی هەیە');
  assert.notEqual(ckb.partial, ar.partial, 'Sorani is never the Arabic');
  assert.equal(ckb.unpriced, 'فایلی مۆدێلی تر کە لەم خەمڵاندنەدا نین: 2');
  // A complete one-job request says nothing more; an older Worker has no summary.
  assert.deepEqual(myRequestNotes(myRow({ parts_count: 1, pieces_per_set: 1, review_state: '', estimate_complete: true, models_unpriced: 0 }), 'ar'), { review: '', partial: '', unpriced: '' });
  assert.deepEqual(myRequestNotes(myRow(undefined), 'en'), { review: '', partial: '', unpriced: '' });
  const list = code('src/components/print/MyRequestsList.tsx');
  assert.match(list, /myRequestNotes\(r, /);
  assert.match(list, /data-my-request-review/);
  assert.match(list, /data-my-request-partial/);
});

// ------------------------------------------------------------------- words

const SUB = { part_id: 'pb', material_row_id: 'mb', from: { material_id: 'tpu', colors: BLACK_RED }, to: { material_id: 'petg', colors: BLACK_RED }, note: '' };
const PARTS = [{ id: 'pa', name: 'Body', position: 0 }, { id: 'pb', name: 'Grip', position: 1 }];
const CATALOGUE = [{ id: 'tpu', name_en: 'TPU', name_ar: 'TPU مرن' }, { id: 'petg', name_en: 'PETG', name_ar: 'PETG' }];

test('words: a substitution line in the reader language — Sorani catalogue name, palette colours by name, the language separator', () => {
  const o = offer({ substitutions: [SUB] });
  assert.deepEqual(parts.substitutionLines(o, PARTS, requestStrings('en'), 'en', CATALOGUE), ['PETG Black, Red instead of TPU Black, Red (Grip)']);
  assert.deepEqual(parts.substitutionLines(o, PARTS, requestStrings('ar'), 'ar', CATALOGUE), ['PETG أسود، أحمر بدل TPU مرن أسود، أحمر (Grip)']);
  assert.deepEqual(parts.substitutionLines(o, PARTS, requestStrings('ckb'), 'ckb', CATALOGUE), ['PETG ڕەش، سوور لە جیاتی TPU نەرم ڕەش، سوور (Grip)']);
  // A free-text colour is shown as written.
  const custom = offer({ substitutions: [{ ...SUB, to: { material_id: 'tpu', colors: [{ hex: '', label: 'Olive' }] } }] });
  assert.deepEqual(parts.substitutionLines(custom, PARTS, requestStrings('en'), 'en', CATALOGUE), ['TPU Olive instead of TPU Black, Red (Grip)']);
  for (const f of ['src/components/community/requests/OfferCompare.tsx', 'src/pages/community/Request.tsx']) {
    const src = code(f);
    assert.match(src, /substitutionPieces\(/, f);
    assert.doesNotMatch(src, /name_ar \|\| m{1,2}\.name_en/, `${f}: a catalogue name goes through localMaterial`);
  }
  assert.doesNotMatch(code('src/components/community/requests/OfferPartsField.tsx'), /name_ar \|\| m\.name_en/, 'the substitute list goes through localMaterial');
});

test('words: the order screen agreement reads in the reader language — not the raw upper-case id, not a fixed Arabic comma', () => {
  const a = readAgreement({
    parts: [{ id: 'pa', name: 'Body', position: 0 }, { id: 'pb', name: '', position: 1 }],
    uncovered: [],
    substitutions: [{ part_id: 'pb', from: { material_id: 'resin-standard', colors: BLACK_RED }, to: { material_id: 'resin-tough', colors: BLACK_RED } }],
  })!;
  assert.deepEqual(a.substitutions[0].part, { name: '', n: 2 });
  assert.equal(agreementSide(a.substitutions[0].from, 'en'), 'Standard Resin Black, Red');
  assert.equal(agreementSide(a.substitutions[0].to, 'ckb'), 'ڕێزنی بەهێز ڕەش، سوور');
  assert.equal(agreementSide(a.substitutions[0].to, 'ar'), 'ريزن متين أسود، أحمر');
  const screen = code('src/components/merchant/orders/CustomOrderScreen.tsx');
  assert.doesNotMatch(screen, /toUpperCase\(\)/);
  assert.doesNotMatch(screen, /join\('، '\)/);
});

// ----------------------------------------------------------------- partial

test('partial: before the parts load, the chip has no count and the acknowledgement is not ready', () => {
  const o = offer({ coverage: { covers_all: false, parts: ['pa'] } });
  assert.equal(parts.partialLabel(o, 0, requestStrings('ar')), 'جزئي');
  assert.equal(parts.partialLabel(o, 0, requestStrings('en')), 'Partial');
  assert.equal(parts.partialLabel(o, 0, requestStrings('ckb')), 'بەشەکی');
  assert.equal(parts.partialLabel(o, 2, requestStrings('en')), 'Partial — parts covered 1/2');
  assert.equal(parts.partialAckReady(o, []), false, 'nothing named to acknowledge');
  assert.equal(parts.partialAckReady(o, [PARTS[0]]), false, 'every part covered: the list is not this request');
  assert.equal(parts.partialAckReady(o, PARTS), true);
  assert.equal(parts.partialAckReady(offer(), []), true, 'a whole offer needs no list');
  const compare = code('src/components/community/requests/OfferCompare.tsx');
  assert.match(compare, /partialAckReady\(o, parts\)/);
  assert.match(compare, /data-accept-parts-missing/);
  for (const l of ['ar', 'en', 'ckb'] as const) assert.ok(requestStrings(l).partsNotLoaded.length > 10, l);
  assert.notEqual(requestStrings('ckb').partsNotLoaded, requestStrings('ar').partsNotLoaded);
});

// ----------------------------------------------------------------- compare

test('compare: the complete-offers note only when complete and partial offers are both live; a partial pick is flagged', () => {
  const whole = offer({ id: 'whole', total_iqd: 30_000 });
  const pa = offer({ id: 'pa', total_iqd: 9_000, coverage: { covers_all: false, parts: ['pa'] } });
  const pb = offer({ id: 'pb', total_iqd: 8_000, coverage: { covers_all: false, parts: ['pb'] } });
  assert.equal(parts.bestOffers([whole, pa]).completeOnly, true);
  const onlyPartial = parts.bestOffers([pa, pb]);
  assert.equal(onlyPartial.completeOnly, false, 'the picks come from the partial pool');
  assert.equal(onlyPartial.cheapest?.id, 'pb');
  assert.equal(parts.bestOffers([whole, offer({ ...pa, expired: true })]).completeOnly, false, 'an expired partial offer is no reason');
  const compare = code('src/components/community/requests/OfferCompare.tsx');
  assert.match(compare, /best\.completeOnly &&/);
  assert.doesNotMatch(compare, /offers\.some\(isPartialOffer\) &&/);
  assert.match(compare, /data-compare-partial/);
});

// ------------------------------------------------------------------ review

test('review: as-in-the-reference is a word in three languages, the age is label first, and the reviewer gets the files', () => {
  const loc = (l: 'ar' | 'en' | 'ckb') => (ar: string, en: string, ckb?: string) => (l === 'en' ? en : l === 'ckb' ? ckb ?? ar : ar);
  const ref = { mode: 'as_reference', hex: '', label: '' };
  assert.equal(review.colourWord(ref, loc('ar')), 'كما في المرجع');
  assert.equal(review.colourWord(ref, loc('en')), 'as in the reference');
  assert.equal(review.colourWord(ref, loc('ckb')), 'وەک لە سەرچاوەکەدا');
  assert.equal(review.colourWord({ mode: 'any', hex: '', label: '' }, loc('en')), 'any colour');
  assert.equal(review.colourWord({ mode: 'catalogue', hex: '#111111', label: 'Black' }, loc('en'), 'en'), 'Black');
  const now = Date.parse('2026-10-21T12:00:00Z');
  assert.equal(review.reviewAge('2026-10-18T10:00:00Z', loc('ar'), now), 'أيام الانتظار: 3');
  assert.equal(review.reviewAge('2026-10-18T10:00:00Z', loc('en'), now), 'Days waiting: 3');
  assert.equal(review.reviewAge('2026-10-18T10:00:00Z', loc('ckb'), now), 'ڕۆژانی چاوەڕوانی: 3');
  assert.equal(review.reviewAge('2026-10-21T10:00:00Z', loc('ar'), now), 'اليوم');
  const panel = code('src/components/adminCommunity/TechnicalReviewPanel.tsx');
  assert.doesNotMatch(panel, /منذ \$\{days\} يوم/);
  assert.match(panel, /data-technical-review-file/);
  assert.match(panel, /colourWord\(c, loc, L\)/);
});

test('review: the admin offer line shows the colours of a colour-only substitution, and only the materials of a material-only one', () => {
  const colourOnly = { part_id: 'p', material_row_id: 'm', from: { material_id: 'pla', colors: [{ hex: '#111111', label: 'Black' }] }, to: { material_id: 'pla', colors: [{ hex: '', label: 'Olive' }] }, note: '' };
  assert.equal(review.adminSubstitutionText(colourOnly, 'en'), 'PLA Olive instead of PLA Black');
  const materialOnly = { ...colourOnly, to: { material_id: 'petg', colors: colourOnly.from.colors } };
  assert.equal(review.adminSubstitutionText(materialOnly, 'en'), 'PETG instead of PLA');
  assert.match(code('src/components/adminCommunity/AdminCommunity.tsx'), /adminSubstitutionSides\(x, reviewLang\(lang\), catalogue\)/);
});

// ================================================== fourth review (round 2)

const { createElement } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { AuthProvider } = await import('../src/AuthContext');
const { LanguageProvider } = await import('../src/LanguageContext');
const { WalletProvider } = await import('../src/WalletContext');
const { CurrencyProvider } = await import('../src/CurrencyContext');
const { MemoryRouter } = await import('react-router-dom');
const { AcceptedOffer } = await import('../src/pages/community/Request');
const { SubstitutionText } = await import('../src/components/community/requests/SubstitutionText');
const { apiRefusal } = await import('../src/lib/refusalStrings');
const { agreedPartName } = await import('../src/components/merchant/orders/CustomOrderScreen');
const { CUSTOM_ORDER_STRINGS } = await import('../src/components/merchant/orders/strings');
const customOrderStrings = (l: 'ar' | 'en' | 'ckb') => CUSTOM_ORDER_STRINGS[l];

const draw = (el: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(
    createElement(AuthProvider, {
      children: createElement(LanguageProvider, {
        children: createElement(WalletProvider, { children: createElement(CurrencyProvider, { children: createElement(MemoryRouter, null, el) }) }),
      }),
    })
  );
const PETG_FOR_PLA = { part_id: 'pa', material_row_id: 'ma', from: { material_id: 'pla', colors: [] }, to: { material_id: 'petg', colors: [] }, note: '' };

test('bidi: a substitution line is drawn in the reader direction with each side isolated — never dir="auto", which reads «PETG بدل PLA» backwards in RTL', () => {
  assert.equal(parts.readerDir('ar'), 'rtl');
  assert.equal(parts.readerDir('ckb'), 'rtl');
  assert.equal(parts.readerDir('en'), 'ltr');
  const [x] = parts.substitutionPieces(offer({ substitutions: [PETG_FOR_PLA] }), [{ id: 'pa', name: 'المقبض', position: 0 }], requestStrings('ar'), 'ar', CATALOGUE);
  assert.equal(x.line, 'PETG بدل PLA (المقبض)');
  // Review 5: each isolate takes the reader direction too (offerScreensReview5.test.ts).
  assert.equal(renderToStaticMarkup(createElement(SubstitutionText, { x, s: requestStrings('ar'), dir: 'rtl' })), '<bdi dir="rtl">PETG</bdi> بدل <bdi dir="rtl">PLA</bdi> (<bdi dir="rtl">المقبض</bdi>)');
  const compare = code('src/components/community/requests/OfferCompare.tsx');
  assert.match(compare, /<li key=\{x\.line\} dir=\{readerDir\(L\)\}>/, 'the acknowledged list');
  assert.match(compare, /<Row k=\{s\.substitutesLabel\} dir=\{readerDir\(lang\)\}>/, 'the offer column');
  assert.doesNotMatch(compare, /<li key=\{line\} dir="auto">/);
  for (const f of ['src/components/community/requests/OfferCompare.tsx', 'src/pages/community/Request.tsx', 'src/components/community/requests/OfferComposer.tsx']) {
    assert.match(code(f), /<SubstitutionText x=\{x\} s=\{s\} dir=\{readerDir\((lang|L)\)\} \/>/, f);
  }
});

test('accepted offer: a partial offer is marked partial from the offer itself when the parts never load', () => {
  for (const [l, word] of [['ar', 'جزئي'], ['en', 'Partial'], ['ckb', 'بەشەکی']] as const) {
    const html = draw(createElement(AcceptedOffer, {
      o: offer({ state: 'accepted', coverage: { covers_all: false, parts: ['pa'] } }), s: requestStrings(l), lang: l, materials: [], mine: false, orderState: 'funded', parts: [],
    }));
    assert.match(html, /data-accepted-partial/, l);
    assert.ok(html.includes(word), `${l}: ${word}`);
  }
  // With the parts: the count, and the parts left out named.
  const html = draw(createElement(AcceptedOffer, {
    o: offer({ state: 'accepted', coverage: { covers_all: false, parts: ['pa'] } }), s: requestStrings('en'), lang: 'en', materials: [], mine: false, orderState: 'funded', parts: PARTS,
  }));
  assert.ok(html.includes('Partial — parts covered 1/2'));
  assert.match(html, /data-accepted-uncovered/);
  // A whole offer carries no chip.
  assert.doesNotMatch(draw(createElement(AcceptedOffer, { o: offer({ state: 'accepted' }), s: requestStrings('en'), lang: 'en', materials: [], mine: false, orderState: 'funded', parts: [] })), /data-accepted-partial/);
});

test('merchant card: the workshop own offer or draft shows its partial chip, the parts it makes and its substitutes', () => {
  const o = offer({ coverage: { covers_all: false, parts: ['pa'] }, substitutions: [{ ...PETG_FOR_PLA }] });
  const html = draw(createElement(composer.OfferBrief, { o, s: requestStrings('en'), lang: 'en', parts: PARTS, materials: [] }));
  assert.match(html, /data-offer-brief-partial/);
  assert.ok(html.includes('Partial — parts covered 1/2'));
  assert.ok(html.includes('<bdi dir="ltr">Body</bdi>'), 'the parts it makes');
  assert.match(html, /data-offer-brief-substitutions/);
  assert.ok(html.includes('<bdi dir="ltr">PETG</bdi> instead of <bdi dir="ltr">PLA</bdi> (<bdi dir="ltr">Body</bdi>)'));
  const src = code('src/components/community/requests/OfferComposer.tsx');
  assert.match(src, /<OfferBrief o=\{draft\} s=\{s\} lang=\{L\} parts=\{partRefs\} materials=\{materials\} \/>/);
  assert.match(src, /<OfferBrief o=\{o\} s=\{s\} lang=\{L\} parts=\{partRefs\} materials=\{materials\} \/>/);
  // A whole offer that substitutes nothing reads as before.
  assert.doesNotMatch(draw(createElement(composer.OfferBrief, { o: offer(), s: requestStrings('en'), lang: 'en', parts: PARTS, materials: [] })), /data-offer-brief-(partial|substitutions)/);
});

test('seen revision: a new offer and (review 5) an edit carry the revision the composer rendered; a draft does not', () => {
  const t = composer.termsFrom(null, null, {});
  const fresh = composer.offerBody({ ...t, price: 20_000, days: 3 }, { draft: false, editingSent: false, validTouched: false, requestHash: 'h1' });
  assert.equal(fresh.expected_request_hash, 'h1');
  assert.equal(composer.offerBody(t, { draft: true, editingSent: false, validTouched: false, requestHash: 'h1' }).expected_request_hash, undefined);
  assert.equal(composer.offerBody(t, { draft: false, editingSent: true, validTouched: false, requestHash: 'h1' }).expected_request_hash, 'h1');
  assert.equal(composer.offerBody(t, { draft: false, editingSent: false, validTouched: false }).expected_request_hash, undefined, 'an unknown revision sends nothing');
  const src = code('src/components/community/requests/OfferComposer.tsx');
  assert.match(src, /parts: partsOpt\(false\), requestHash \}/);
  assert.match(src, /sendOffer\(offer!\.id, requestHash\)/);
  assert.match(src, /sendOffer\(draft\.id, requestHash\)/);
  assert.match(code('src/pages/community/Request.tsx'), /requestHash=\{modelExtra\.revisionHash\}/);
  assert.match(code('src/components/print/PrintSummary.tsx'), /revisionHash: d\.revision_hash \?\? ''/);
});

test('my requests: the unpriced model files are said only beside an estimate, as the request page says them', () => {
  const sum = { parts_count: 1, pieces_per_set: 1, review_state: '', estimate_complete: true, models_unpriced: 1 };
  assert.equal(myRequestNotes(myRow(sum, null), 'ar').unpriced, '', 'a draft with a file and no estimate');
  assert.equal(myRequestNotes(myRow(sum, { estimate_low_iqd: null, estimate_high_iqd: null } as unknown as MyRequestRow['print']), 'en').unpriced, '', 'an unpriced job');
  assert.equal(myRequestNotes(myRow(sum), 'ar').unpriced, 'ملفات نماذج أخرى لم يشملها التقدير: 1');
});

test('composer: the material chips name the catalogue in the reader language, Sorani included', () => {
  const src = code('src/components/community/requests/OfferComposer.tsx');
  assert.doesNotMatch(src, /name_ar \|\| m\.name_en/);
  assert.match(src, /<bdi>\{localMaterial\(m\.id, L, materials\)\}<\/bdi>/);
});

test('review: the reviewer reads materials and palette colours in the admin language, and the offer line says «instead of», never an arrow', () => {
  const loc = (l: 'ar' | 'en' | 'ckb') => (ar: string, en: string, ckb?: string) => (l === 'en' ? en : l === 'ckb' ? ckb ?? ar : ar);
  const black = { mode: 'catalogue', hex: '#111111', label: 'Black' };
  assert.equal(review.colourWord(black, loc('ar'), 'ar'), 'أسود');
  assert.equal(review.colourWord(black, loc('ckb'), 'ckb'), 'ڕەش');
  assert.equal(review.colourWord({ mode: 'custom', hex: '', label: 'زيتي' }, loc('ar'), 'ar'), 'زيتي', 'a free-text colour as written');
  assert.equal(review.materialWord('resin-standard', 'ar'), 'ريزن قياسي');
  assert.equal(review.materialWord('resin-standard', 'ckb'), 'ڕێزنی ستاندارد');
  const colourOnly = { from: { material_id: 'pla', colors: [{ hex: '', label: 'أسود' }] }, to: { material_id: 'pla', colors: [{ hex: '', label: 'زيتي' }] } };
  assert.equal(review.adminSubstitutionText(colourOnly, 'ar'), 'PLA زيتي بدل PLA أسود');
  assert.equal(review.adminSubstitutionText({ from: { material_id: 'pla', colors: [] }, to: { material_id: 'petg', colors: [] } }, 'ckb'), 'PETG لە جیاتی PLA');
  assert.doesNotMatch(code('src/components/adminCommunity/reviewWords.ts'), /←/);
  const panel = code('src/components/adminCommunity/TechnicalReviewPanel.tsx');
  assert.doesNotMatch(panel, /toUpperCase\(\)/);
  assert.match(panel, /materialWord\(m\.material_id, L, catalogue\)/);
});

test('order screen: an unnamed part is «Part n» in the reader language, and a material beyond the seed reads by its catalogue name', () => {
  assert.equal(agreedPartName({ name: '', n: 2 }, customOrderStrings('ar')), 'القطعة 2');
  assert.equal(agreedPartName({ name: '', n: 2 }, customOrderStrings('en')), 'Part 2');
  assert.equal(agreedPartName({ name: '', n: 2 }, customOrderStrings('ckb')), 'پارچەی 2');
  assert.equal(agreedPartName({ name: 'Lid', n: 3 }, customOrderStrings('en')), 'Lid');
  const silk = [{ id: 'pla-silk', name_en: 'PLA Silk', name_ar: 'PLA حريري' }];
  assert.equal(agreementSide({ material_id: 'pla-silk', colors: [] }, 'en', silk), 'PLA Silk');
  assert.equal(agreementSide({ material_id: 'pla-silk', colors: [] }, 'ar', silk), 'PLA حريري');
  const screen = code('src/components/merchant/orders/CustomOrderScreen.tsx');
  assert.doesNotMatch(screen, /`#\$\{/);
  assert.match(screen, /agreementSide\(x\.to, lang, catalogue\)/);
});

test('refusal: a part refused only for its substitute names the substitute as the remedy, in three languages', () => {
  const err = { code: 'OFFER_PART_NOT_ELIGIBLE', details: { part_id: 'p', position: 0, reasons: ['MATERIAL'], substitute: true } };
  assert.ok(apiRefusal(err, 'en').startsWith('Part 1: Your printers cannot make the substitute proposed for this part'));
  assert.doesNotMatch(apiRefusal(err, 'en'), /remove it from the offer/);
  assert.ok(apiRefusal(err, 'ar').startsWith('القطعة 1: '));
  assert.notEqual(apiRefusal(err, 'ckb').replace(/^\S+ \S+ /, ''), apiRefusal(err, 'ar').replace(/^\S+ \S+ /, ''), 'Sorani is never the Arabic');
  // The part itself cannot be made: the plain advice stands.
  assert.match(apiRefusal({ code: 'OFFER_PART_NOT_ELIGIBLE', details: { position: 0, reasons: ['MATERIAL'] } }, 'en'), /remove it from the offer/);
});
