/**
 * THE OFFER AND REQUEST SCREENS, SIXTH REVIEW (P1-05, docs/DECISIONS.md row
 * 267) — the pure halves of the screens, and the lines that wire them.
 *
 * Pinned:
 *   R10      the old wizard says the estimate covers the priced parts only,
 *            as the request page and the list do.
 *   bidi     the parts list draws a part materials line in the reader
 *            direction, never `auto`; so does the composer asked line.
 *   colours  the parts list and the composer asked line keep every colour
 *            entry, «as in the reference» and «any colour» as words.
 *   board    the Sorani R10 label of the workshop board says «priced», not
 *            «valuable».
 *   list     «طلباتي» shows the partial and substitutes chips beside the
 *            accepted price.
 *   composer a colour substitute is chosen from the palette, one entry per
 *            colour, each with its hex — never one typed label.
 *   lows     the admin lines say «Parts covered: 1» and «Parts: 1», never
 *            «1 parts»; the custom-order card has its doc comment back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

(globalThis as { localStorage?: unknown }).localStorage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
const parts = await import('../src/components/community/requests/offerParts');
const strings = await import('../src/components/community/requests/strings');
const field = await import('../src/components/community/requests/OfferPartsField');
const composer = await import('../src/components/community/requests/OfferComposer');
const workshop = await import('../src/components/merchant/workshop/api');
import type { OfferV2 } from '../src/components/community/requests/api';

const { requestStrings } = strings;
const code = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const offer = (o: Partial<OfferV2> = {}): OfferV2 =>
  ({
    id: 'o1', request_id: 'r1', merchant_id: 'm1', store_id: 's1', price_iqd: 20_000, delivery_fee_iqd: 0, total_iqd: 20_000,
    quantity: null, color: '', terms: '', completion_days: 3, delivery_method: 'merchant_delivery', message: '', materials: '',
    material_ids: [], included: '', warranty_terms: '', state: 'pending', draft: false, expires_at: null, valid_until: null,
    created_at: '', updated_at: '', revision: 1, request_revision: 1, revised: false, stale: false, expired: false, files: [],
    merchant: null, ...o,
  }) as OfferV2;

const BLACK = { mode: 'catalogue', hex: '#1a1a1a', label: 'Black', palette: '', ref: '' };
const RED = { mode: 'catalogue', hex: '#d32f2f', label: 'Red', palette: '', ref: '' };
const AS_REF = { mode: 'as_reference', hex: '', label: '', palette: '', ref: '' };
const ANY = { mode: 'any', hex: '', label: '', palette: '', ref: '' };
const row = (id: string, material_id: string, colors: unknown[], material_unsure = false) =>
  ({ id, position: 0, material_id, material_unsure, colors, finish: '' }) as never;

// ================================================================== R10

test('R10: the wizard says the estimate covers the priced parts only when a part is unpriced — as the request page — and nothing for a whole job', () => {
  const half = { coverage: { complete: false, parts_total: 2, priced_parts: [{ part_id: 'a' }] } };
  assert.equal(strings.estimateCoverageLine(half, requestStrings('ar')), 'التقدير يشمل القطع المسعّرة فقط (1/2)');
  assert.equal(strings.estimateCoverageLine(half, requestStrings('en')), 'The estimate covers the priced parts only (1/2)');
  assert.equal(strings.estimateCoverageLine(half, requestStrings('ckb')), 'خەمڵاندنەکە تەنها ئەو پارچانە دەگرێتەوە کە نرخیان بۆ دانراوە (1/2)');
  assert.equal(strings.estimateCoverageLine({ coverage: { complete: true, parts_total: 2, priced_parts: [{}, {}] } }, requestStrings('en')), '');
  assert.equal(strings.estimateCoverageLine({}, requestStrings('en')), '', 'a v1 estimate has no coverage');
  assert.equal(strings.estimateCoverageLine(null, requestStrings('en')), '');
  const wizard = code('src/components/community/requests/RequestWizard.tsx');
  assert.match(wizard, /estimateCoverageLine\(quote, requestStrings\(L\)\)/, 'the wizard estimate step renders it');
  assert.match(wizard, /data-wizard-estimate-coverage/);
});

// ============================================================ bidi, colours

test('colours: a part materials line keeps every colour entry — «as in the reference» and «any colour» as words — in three languages', () => {
  const p = { materials: [row('m1', 'pla', [BLACK, AS_REF])] };
  assert.equal(parts.partMaterialsLine(p, 'ar'), 'PLA · أسود، كما في المرجع');
  assert.equal(parts.partMaterialsLine(p, 'en'), 'PLA · Black, as in the reference');
  assert.equal(parts.partMaterialsLine(p, 'ckb'), 'PLA · ڕەش، وەک لە سەرچاوەکەدا');
  const two = { materials: [row('m1', 'tpu', [BLACK, RED]), row('m2', '', [ANY], true)] };
  assert.equal(parts.partMaterialsLine(two, 'ar'), 'TPU مرن · أسود، أحمر، أي لون');
  assert.equal(parts.partMaterialsLine(two, 'en'), 'TPU · Black, Red, any colour');
  assert.equal(parts.askedRowLine(row('m1', 'pla', [BLACK, AS_REF]), 'ckb'), 'PLA · ڕەش، وەک لە سەرچاوەکەدا');
  assert.equal(parts.askedRowLine(row('m1', 'pla', []), 'en'), 'PLA');
});

test('bidi: the parts list and the composer asked line are drawn in the reader direction, through the one helper — never dir="auto"', () => {
  const summary = code('src/components/print/PrintSummary.tsx');
  assert.match(summary, /const materials = partMaterialsLine\(p, lang\);/);
  assert.match(summary, /<p className="mt-0\.5 text-\[11\.5px\] text-text-secondary" dir=\{readerDir\(lang\)\}>\{materials\}<\/p>/);
  assert.doesNotMatch(summary, /dir="auto">\{materials\}/);
  const fieldSrc = code('src/components/community/requests/OfferPartsField.tsx');
  assert.match(fieldSrc, /const asked = askedRowLine\(row, lang, materials\);/);
  assert.match(fieldSrc, /<p className="text-\[11\.5px\] text-text-secondary" dir=\{readerDir\(lang\)\}>\s*\{s\.asAsked\}: <bdi dir=\{readerDir\(lang\)\}>\{asked\}<\/bdi>/);
});

// ================================================================= board

test('board: the R10 label in Sorani says «priced», as the list does, never «valuable» (نرخدار); the board renders it from the one helper', () => {
  assert.equal(workshop.boardEstimateLabel(false, 'ckb'), 'خەمڵاندن تەنها بۆ ئەو پارچانەی نرخیان بۆ دانراوە');
  assert.doesNotMatch(workshop.boardEstimateLabel(false, 'ckb'), /نرخدار/);
  assert.equal(workshop.boardEstimateLabel(false, 'ar'), 'تقدير القطع المسعّرة فقط');
  assert.equal(workshop.boardEstimateLabel(false, 'en'), 'Estimate of the priced parts only');
  assert.equal(workshop.boardEstimateLabel(true, 'ckb'), 'خەمڵاندنی Levonis');
  assert.equal(workshop.boardEstimateLabel(undefined, 'en'), 'Levonis estimate', 'an older Worker says nothing about coverage');
  const board = code('src/components/merchant/workshop/RequestBoard.tsx');
  assert.match(board, /\{boardEstimateLabel\(r\.estimate_complete, L\)\}/);
  assert.doesNotMatch(board, /نرخدار/);
});

// ================================================================== list

test('list: «طلباتي» shows the partial and substitutes chips of the accepted order beside its price', () => {
  const list = code('src/components/print/MyRequestsList.tsx');
  assert.match(list, /customOrderChips\(r\.accepted, loc\)/);
  assert.match(list, /data-my-request-accepted-chip/);
  assert.match(code('src/lib/printApi.ts'), /uncovered_count\?: number;[\s\S]*substitutes\?: true;/);
});

// ============================================================== composer

const SUB = { part_id: 'pa', material_row_id: 'ma', material_id: 'pla', note: '' };

test('composer: a colour substitute is the palette colours chosen, one entry per colour with its hex — never one typed label', () => {
  const white = { hex: '#f2f2f2', label: 'White' };
  const black = { hex: '#1a1a1a', label: 'Black' };
  let colors = field.toggleColour([], white);
  colors = field.toggleColour(colors, black);
  assert.deepEqual(colors, [white, black]);
  const body = field.partsBody({ coverage: null, subs: [{ ...SUB, colors }] }, { clear: false });
  assert.deepEqual(body.substitutions?.[0].to, { material_id: 'pla', colors: [white, black] }, 'two colours are two entries, so MULTICOLOR counts two');
  assert.ok(body.substitutions![0].to.colors!.every((c) => /^#[0-9a-f]{6}$/.test(c.hex)), 'every colour carries its hex, so stock is judged');
  // Unpicked again: the colours as asked.
  assert.deepEqual(field.toggleColour(colors, white), [black]);
  assert.deepEqual(field.partsBody({ coverage: null, subs: [{ ...SUB, material_id: 'petg', colors: [] }] }, { clear: false }).substitutions?.[0].to, { material_id: 'petg' });
  // The choices: the wizard palette, and a stored colour beyond it kept while chosen.
  const choices = field.paletteChoices([{ hex: '', label: 'Olive' }]);
  assert.deepEqual(choices.slice(0, 7).map((c) => c.hex), ['#1a1a1a', '#f2f2f2', '#808080', '#d32f2f', '#1976d2', '#388e3c', '#fbc02d']);
  assert.equal(choices[0].label, 'Black', 'the English word the wizard stores');
  assert.deepEqual(choices[7], { hex: '', label: 'Olive' });
  assert.equal(field.paletteChoices([white]).length, 7, 'a palette colour is not listed twice');
  const src = code('src/components/community/requests/OfferPartsField.tsx');
  assert.doesNotMatch(src, /data-offer-sub-colour(?![\w-])/, 'no free-text colour field');
  assert.doesNotMatch(src, /\{ hex: '', label: typed \}/, 'a typed colour is never sent as one label');
  assert.match(src, /data-offer-sub-colours/);
  assert.match(src, /aria-pressed=\{on\}/);
});

test('composer: an edit reads a proposed colour back as its entries, a material-only substitute as none', () => {
  const black = { hex: '#1a1a1a', label: 'Black' };
  const green = { hex: '#388e3c', label: 'Green' };
  const proposed = composer.partsFrom(offer({ substitutions: [{ ...SUB, from: { material_id: 'pla', colors: [black] }, to: { material_id: 'pla', colors: [green] } }] }));
  assert.deepEqual(proposed.subs[0].colors, [green]);
  assert.deepEqual(field.partsBody(proposed, { clear: true }).substitutions?.[0].to, { material_id: 'pla', colors: [green] });
  const material = composer.partsFrom(offer({ substitutions: [{ ...SUB, from: { material_id: 'pla', colors: [black] }, to: { material_id: 'petg', colors: [black] } }] }));
  assert.deepEqual(material.subs[0].colors, []);
});

test('composer: the colour words are in three languages, and Sorani is never the Arabic', () => {
  for (const l of ['ar', 'en', 'ckb'] as const) {
    const s = requestStrings(l);
    assert.ok(s.substituteColourHint.length > 0);
    assert.doesNotMatch(s.substituteColour, /\(|اسمه|its name|ناوەکەی/, 'no longer a name to type');
  }
  assert.notEqual(requestStrings('ckb').substituteColourHint, requestStrings('ar').substituteColourHint);
});

// ================================================================== lows

test('lows: the admin offer line and the review queue put the label first — «Parts covered: 1», «Parts: 1» — never «1 parts»', () => {
  const admin = code('src/components/adminCommunity/AdminCommunity.tsx');
  assert.doesNotMatch(admin, /parts covered`/);
  assert.match(admin, /`Partial — parts covered: \$\{o\.coverage\.parts\?\.length \?\? 0\}`/);
  const panel = code('src/components/adminCommunity/TechnicalReviewPanel.tsx');
  assert.doesNotMatch(panel, /`\$\{r\.parts_count \?\? 1\} parts`/);
  assert.match(panel, /`Parts: \$\{r\.parts_count \?\? 1\}`/);
});

test('lows: the custom-order card function has its doc comment back, and the coverage facts keep theirs', () => {
  const cards = code('worker/lib/chatCards.ts');
  assert.match(cards, /\/\*\* A funded \(or moved\) custom order's card[^\n]*\*\/\nexport function customOrderCard\(/);
  assert.doesNotMatch(cards, /\*\/\n\/\*\*\n \* WHAT THE ORDER MAKES, ON ITS CARD/, 'no two doc blocks stacked');
});

test('lows: the offer coverage header says what is fenced — every write on a board request; a direct re-confirm is not, as before', () => {
  const header = code('worker/lib/offerCoverage.ts').split('*/')[0].replace(/\s*\*\s*/g, ' ');
  assert.match(header, /Every offer write on a BOARD request/);
  assert.match(header, /A re-confirm on a DIRECT request \(0151\) reads no model and covers no part: it is not fenced/);
});
