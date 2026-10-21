/**
 * THE OFFER AND REQUEST SCREENS, FIFTH REVIEW (P1-05, docs/DECISIONS.md row
 * 267) — the pure halves of the screens, and the lines that wire them.
 *
 * Pinned:
 *   bidi     each side of a substitution, the covered parts, the admin
 *            offer line and the reviewer's material and colour isolates take
 *            the READER direction, never `auto`: «PETG أحمر» and «TPU مرن»
 *            read in their written order in Arabic and Sorani.
 *   colours  «any colour» and «as in the reference» are words on both sides
 *            of a material-only substitute and in the agreement; the composer
 *            never sends them back as colours.
 *   card     the custom-order card and the customer's order row say partial
 *            and substituted, and the confirmation says what was left out.
 *   board    «any material» beside the named ones; the pieces a set beside
 *            the parts, on the workshop board and the public card, with a
 *            word for a part and another for a piece.
 *   review   the attachment kind in three languages; a material beyond the
 *            seed by its catalogue name.
 *   seen     an edit of a sent offer carries the revision the composer rendered.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

(globalThis as { localStorage?: unknown }).localStorage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
const parts = await import('../src/components/community/requests/offerParts');
const { requestStrings } = await import('../src/components/community/requests/strings');
const mirrors = await import('../src/components/community/requests/mirrors');
const composer = await import('../src/components/community/requests/OfferComposer');
const { readAgreement, agreementSide } = await import('../src/components/merchant/orders/CustomOrderScreen');
const review = await import('../src/components/adminCommunity/reviewWords');
const cardWords = await import('../src/components/chat/cards/cardWords');
const { boardJobFacts } = await import('../src/components/merchant/workshop/api');
const { createElement } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { SubstitutionText } = await import('../src/components/community/requests/SubstitutionText');
import type { OfferV2 } from '../src/components/community/requests/api';

const code = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const offer = (o: Partial<OfferV2> = {}): OfferV2 =>
  ({
    id: 'o1', request_id: 'r1', merchant_id: 'm1', store_id: 's1', price_iqd: 20_000, delivery_fee_iqd: 0, total_iqd: 20_000,
    quantity: null, color: '', terms: '', completion_days: 3, delivery_method: 'merchant_delivery', message: '', materials: '',
    material_ids: [], included: '', warranty_terms: '', state: 'pending', draft: false, expires_at: null, valid_until: null,
    created_at: '', updated_at: '', revision: 1, request_revision: 1, revised: false, stale: false, expired: false, files: [],
    merchant: null, ...o,
  }) as OfferV2;
const loc = (l: 'ar' | 'en' | 'ckb') => (ar: string, en: string, ckb?: string) => (l === 'en' ? en : l === 'ckb' ? ckb ?? ar : ar);
const RTL_SWAP = {
  part_id: 'pa', material_row_id: 'ma', note: '',
  from: { material_id: 'tpu', colors: [{ hex: '', label: 'Black' }, { hex: '', label: 'Red' }] },
  to: { material_id: 'petg', colors: [{ hex: '', label: 'Red' }] },
};

// ================================================================ bidi

test('bidi: each side of a substitution is isolated in the reader direction — «PETG أحمر» and «TPU مرن أسود، أحمر» read as written', () => {
  const [x] = parts.substitutionPieces(offer({ substitutions: [RTL_SWAP] }), [{ id: 'pa', name: '', position: 1 }], requestStrings('ar'), 'ar');
  assert.equal(x.to, 'PETG أحمر');
  assert.equal(x.from, 'TPU مرن أسود، أحمر');
  const html = renderToStaticMarkup(createElement(SubstitutionText, { x, s: requestStrings('ar'), dir: 'rtl' }));
  assert.equal(html, '<bdi dir="rtl">PETG أحمر</bdi> بدل <bdi dir="rtl">TPU مرن أسود، أحمر</bdi> (<bdi dir="rtl">القطعة 2</bdi>)');
  assert.doesNotMatch(html, /<bdi>/, 'no isolate is left to dir=auto');
  const [ck] = parts.substitutionPieces(offer({ substitutions: [RTL_SWAP] }), [{ id: 'pa', name: '', position: 1 }], requestStrings('ckb'), 'ckb');
  assert.equal(renderToStaticMarkup(createElement(SubstitutionText, { x: ck, s: requestStrings('ckb'), dir: parts.readerDir('ckb') })).startsWith('<bdi dir="rtl">PETG سوور</bdi> لە جیاتی <bdi dir="rtl">TPU نەرم ڕەش، سوور</bdi>'), true);
  const en = parts.substitutionPieces(offer({ substitutions: [RTL_SWAP] }), [{ id: 'pa', name: 'Grip', position: 1 }], requestStrings('en'), 'en')[0];
  assert.equal(renderToStaticMarkup(createElement(SubstitutionText, { x: en, s: requestStrings('en'), dir: parts.readerDir('en') })), '<bdi dir="ltr">PETG Red</bdi> instead of <bdi dir="ltr">TPU Black, Red</bdi> (<bdi dir="ltr">Grip</bdi>)');
});

test('bidi: every screen passes the reader direction to its isolates — compare, accept sheet, accepted offer, merchant card, admin line, technical review', () => {
  const compare = code('src/components/community/requests/OfferCompare.tsx');
  assert.match(compare, /<Row k=\{s\.partsLabel\} dir=\{readerDir\(lang\)\}>/, 'the parts row of the compare column');
  assert.match(compare, /<SubstitutionText x=\{x\} s=\{s\} dir=\{readerDir\(lang\)\} \/>/);
  assert.match(compare, /<SubstitutionText x=\{x\} s=\{s\} dir=\{readerDir\(L\)\} \/>/);
  assert.match(code('src/pages/community/Request.tsx'), /<SubstitutionText x=\{x\} s=\{s\} dir=\{readerDir\(lang\)\} \/>/);
  const brief = code('src/components/community/requests/OfferComposer.tsx');
  assert.match(brief, /\{covered && <bdi dir=\{readerDir\(lang\)\}>\{covered\}<\/bdi>\}/);
  assert.match(brief, /<SubstitutionText x=\{x\} s=\{s\} dir=\{readerDir\(lang\)\} \/>/);
  assert.match(code('src/components/adminCommunity/AdminCommunity.tsx'), /<bdi dir=\{lang === 'en' \? 'ltr' : 'rtl'\}>\{v\.to\}<\/bdi> \{v\.word\} <bdi dir=\{lang === 'en' \? 'ltr' : 'rtl'\}>\{v\.from\}<\/bdi>/);
  const panel = code('src/components/adminCommunity/TechnicalReviewPanel.tsx');
  assert.match(panel, /<bdi dir=\{L === 'en' \? 'ltr' : 'rtl'\}>\{m\.material_unsure/);
  assert.match(panel, /<bdi dir=\{L === 'en' \? 'ltr' : 'rtl'\}>\{m\.colors\.map/);
  assert.match(code('src/components/community/requests/SubstitutionText.tsx'), /<bdi dir=\{dir\}>\{x\.to\}<\/bdi>/);
});

// ================================================================ colours

const AS_REF = { hex: '', label: '', mode: 'as_reference' as const };
const ANY = { hex: '', label: '', mode: 'any' as const };
const BLACK = { hex: '#1a1a1a', label: 'Black' };

test('colours: a material-only substitute shows the colours that stay — «as in the reference» and «any colour» as words, in three languages', () => {
  const swap = { part_id: 'pa', material_row_id: 'ma', note: '', from: { material_id: 'pla', colors: [BLACK, AS_REF] }, to: { material_id: 'petg', colors: [BLACK, AS_REF] } };
  const line = (l: 'ar' | 'en' | 'ckb') => parts.substitutionLines(offer({ substitutions: [swap] }), [{ id: 'pa', name: 'Body', position: 0 }], requestStrings(l), l)[0];
  assert.equal(line('en'), 'PETG Black, as in the reference instead of PLA Black, as in the reference (Body)');
  assert.equal(line('ar'), 'PETG أسود، كما في المرجع بدل PLA أسود، كما في المرجع (Body)');
  assert.equal(line('ckb'), 'PETG ڕەش، وەک لە سەرچاوەکەدا لە جیاتی PLA ڕەش، وەک لە سەرچاوەکەدا (Body)');
  for (const l of ['ar', 'en', 'ckb'] as const) assert.equal(mirrors.entryColour(ANY, l), { ar: 'أي لون', en: 'any colour', ckb: 'هەر ڕەنگێک' }[l]);
});

test('colours: the order screen keeps «as in the reference» from the agreement, and reads it as a word', () => {
  const a = readAgreement({
    covers_all: true,
    parts: [{ id: 'pa', name: 'Body', position: 0 }, { id: 'pb', name: 'Lid', position: 1 }],
    uncovered: [],
    substitutions: [{ part_id: 'pa', from: { material_id: 'pla', colors: [BLACK, AS_REF] }, to: { material_id: 'petg', colors: [BLACK, AS_REF] } }],
  });
  assert.ok(a);
  assert.deepEqual(a!.substitutions[0].to.colors, [BLACK, AS_REF]);
  assert.equal(agreementSide(a!.substitutions[0].to, 'en'), 'PETG Black, as in the reference');
  assert.equal(agreementSide(a!.substitutions[0].to, 'ckb'), 'PETG ڕەش، وەک لە سەرچاوەکەدا');
});

test('colours: an edit never sends the entries the customer left open — a material-only substitute stays material only, a proposed colour keeps only what was named', () => {
  const material = composer.partsFrom(offer({ substitutions: [{ part_id: 'pa', material_row_id: 'ma', note: '', from: { material_id: 'pla', colors: [BLACK, AS_REF] }, to: { material_id: 'petg', colors: [BLACK, AS_REF] } }] }));
  assert.equal(material.subs[0].colour, '');
  assert.equal(material.subs[0].colors, undefined);
  const red = { hex: '#d32f2f', label: 'Red' };
  const proposed = composer.partsFrom(offer({ substitutions: [{ part_id: 'pa', material_row_id: 'ma', note: '', from: { material_id: 'pla', colors: [BLACK, AS_REF] }, to: { material_id: 'pla', colors: [red, AS_REF] } }] }));
  assert.deepEqual(proposed.subs[0].colors, [red]);
  assert.equal(proposed.subs[0].colour, 'Red');
});

// ================================================================ card

test('card: a partial or substituted custom order says so, with the parts left out, in three languages; a whole one says nothing', () => {
  const s = { covers_all: false, uncovered_count: 1, substitutes: true };
  assert.deepEqual(cardWords.customOrderChips(s, loc('en')), ['Partial — parts not included: 1', 'With substitutes']);
  assert.deepEqual(cardWords.customOrderChips(s, loc('ar')), ['جزئي — قطع غير مشمولة: 1', 'مع بدائل']);
  assert.deepEqual(cardWords.customOrderChips(s, loc('ckb')), ['بەشەکی — پارچە نەگیراوەکان: 1', 'لەگەڵ جێگرەوە']);
  assert.deepEqual(cardWords.customOrderChips({}, loc('en')), []);
  assert.equal(cardWords.customOrderReminder({ covers_all: false }, loc('en')), 'This order does not include every part of your request.');
  assert.notEqual(cardWords.customOrderReminder({ covers_all: false }, loc('ckb')), cardWords.customOrderReminder({ covers_all: false }, loc('ar')), 'Sorani is never the Arabic');
  assert.equal(cardWords.customOrderReminder({}, loc('en')), '');
  const cards = code('src/components/chat/cards/OrderCards.tsx');
  assert.match(cards, /const chips = customOrderChips\(s, loc\);/);
  assert.match(cards, /consequence: \[reminder, loc\(/);
  const page = code('src/pages/Requests.tsx');
  assert.match(page, /customOrderChips\(o, loc\)/);
  assert.match(page, /customOrderReminder\(action\.order, loc\)/);
});

// ================================================================ board

test('board: a job with a PLA part and a part whose material is open reads «PLA + any material», never PLA alone', () => {
  const f = boardJobFacts({ process: 'fdm', material_id: null, summary: { parts_count: 2, pieces_per_set: 2, review_state: '', materials: ['pla'], processes: ['fdm'], materials_open: true } });
  assert.deepEqual(f.materials, ['pla']);
  assert.equal(f.anyMaterial, true);
  assert.equal(boardJobFacts({ process: 'fdm', material_id: 'pla', summary: { parts_count: 1, pieces_per_set: 1, review_state: '', materials: ['pla'], processes: ['fdm'] } }).anyMaterial, false);
  assert.equal(boardJobFacts({ process: null, material_id: null, summary: { parts_count: 1, pieces_per_set: 1, review_state: '', materials: [], processes: [], materials_open: true } }).anyMaterial, false, 'nothing named: no «+»');
  assert.match(code('src/components/merchant/workshop/RequestBoard.tsx'), /loc\('المادة مفتوحة', 'Any material', 'هەر کەرەستەیەک'\)/);
});

test('board: the pieces a set beside the parts — a part and a piece are two words in Arabic and Sorani', () => {
  assert.deepEqual(mirrors.jobCountWords({ parts_count: 1, pieces_per_set: 4 }, 'en'), ['4 pieces a set'], 'one part of four pieces, one set');
  assert.deepEqual(mirrors.jobCountWords({ parts_count: 2, pieces_per_set: 3 }, 'en'), ['2 parts', '3 pieces a set']);
  assert.deepEqual(mirrors.jobCountWords({ parts_count: 2, pieces_per_set: 3 }, 'ar'), ['عدد الأجزاء 2', 'القطع في الطقم 3']);
  assert.deepEqual(mirrors.jobCountWords({ parts_count: 2, pieces_per_set: 3 }, 'ckb'), ['2 بەش', '3 پارچە لە هەر سێتێکدا']);
  assert.deepEqual(mirrors.jobCountWords({ parts_count: 2, pieces_per_set: 2 }, 'en'), ['2 parts']);
  assert.deepEqual(mirrors.jobCountWords({ parts_count: 1, pieces_per_set: 1 }, 'en'), []);
  assert.match(code('src/components/merchant/workshop/RequestBoard.tsx'), /jobCountWords\(r\.summary, L\)/);
  const card = code('src/components/community/hub/RequestCard.tsx');
  assert.match(card, /jobCountWords\(sum!, /);
  assert.doesNotMatch(card, /sum!\.parts_count > 1 \? sum!\.parts_count : sum!\.pieces_per_set/, 'never one count instead of the other');
});

// ================================================================ review

test('review: the attachment kind in the admin language; a material beyond the seed by its catalogue name', () => {
  assert.equal(review.fileKindWord('model', 'ar'), 'نموذج');
  assert.equal(review.fileKindWord('reference', 'ckb'), 'سەرچاوە');
  assert.equal(review.fileKindWord('document', 'en'), 'document');
  const silk = [{ id: 'pla-silk', name_en: 'PLA Silk', name_ar: 'PLA حريري' }];
  assert.equal(review.materialWord('pla-silk', 'ar', silk), 'PLA حريري');
  assert.equal(review.materialWord('pla-silk', 'en', silk), 'PLA Silk');
  assert.equal(review.adminSubstitutionText({ from: { material_id: 'pla', colors: [] }, to: { material_id: 'pla-silk', colors: [] } }, 'ar', silk), 'PLA حريري بدل PLA');
  const panel = code('src/components/adminCommunity/TechnicalReviewPanel.tsx');
  assert.match(panel, /\{fileKindWord\(f\.kind, L\)\}/);
  assert.doesNotMatch(panel, /dir="ltr">\{f\.kind\}/);
  assert.match(panel, /requestsApi\.catalog\(\)/);
});

// ================================================================ seen

test('seen revision: an edit of a sent offer carries the revision the composer rendered', () => {
  const t = composer.termsFrom(null, null, {});
  assert.equal(composer.offerBody(t, { draft: false, editingSent: true, validTouched: false, requestHash: 'h1' }).expected_request_hash, 'h1');
  assert.match(code('src/components/community/requests/OfferComposer.tsx'), /editingSent: true, validTouched, quoteId, parts: partsOpt\(true\), requestHash \}/);
});
