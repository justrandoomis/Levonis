/**
 * THE ADMIN'S SIDE OF THE CODE (DECISIONS row 301): the words in three languages,
 * the Sorani its own (row 183); the ready message the admin copies, in the
 * customer's language, which nothing sends; and the rule the screen uses to say a
 * score cannot be approved yet.
 *
 * Run: node --import tsx --test tests/reviewGiftAdmin.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { REVIEW_GIFT_STRINGS, readySentence, reviewGiftText, type ReviewGiftKey } from '../src/components/adminReviews/reviewGiftStrings';
import { ScoreField, canApproveScore, draftScore, initialDraft } from '../src/components/adminReviews/ReviewGiftDecision';
import { GIFT_CODE_NOTICE } from '../worker/lib/rewards/strings';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LanguageProvider } from '../src/LanguageContext';
import { parseLocaleNumber } from '../src/lib/localeNumber';

const ARABIC_ONLY = /[ةىيك]/;
const SORANI_LETTER = /[ڕڵۆێەپچژگڤکی]/;
const marks = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();

test('every admin string has three slots asking for the same values, and the Sorani is its own', () => {
  const keys = Object.keys(REVIEW_GIFT_STRINGS.ar) as ReviewGiftKey[];
  assert.ok(keys.length >= 30);
  const bad: string[] = [];
  for (const k of keys) {
    const [ar, en, ckb] = [REVIEW_GIFT_STRINGS.ar[k], REVIEW_GIFT_STRINGS.en[k], REVIEW_GIFT_STRINGS.ckb[k]];
    if (!ar?.trim() || !en?.trim() || !ckb?.trim()) bad.push(`${k}: empty`);
    if (ckb === ar) bad.push(`${k}: ckb = ar`);
    if (ckb === en) bad.push(`${k}: ckb = en`);
    if (ARABIC_ONLY.test(ckb)) bad.push(`${k}: an Arabic-only letter in «${ckb}»`);
    if (ckb.replace(/\{\w+\}/g, '').trim().length > 8 && !SORANI_LETTER.test(ckb)) bad.push(`${k}: no Sorani letter`);
    if (marks(ar) !== marks(en) || marks(ar) !== marks(ckb)) bad.push(`${k}: marks differ`);
  }
  assert.deepEqual(bad, []);
  assert.equal(reviewGiftText('ar', 'opensMany', { list: '1، 2' }), 'يفتح المستويات 1، 2', 'the spec’s live line');
  assert.equal(reviewGiftText('en', 'opensOne', { list: '1' }), 'Opens level 1');
});

test('the ready message: the customer’s language, the code as it is read aloud, the page to write it on, and no invented figure', () => {
  const v = { name: 'Sara', printer: 'Bambu Lab P1S', code: 'GFT7KQ4MZX', origin: 'https://levonis-iq.com' };
  const ar = readySentence('ar', v);
  const en = readySentence('en', v);
  const ckb = readySentence('ckb', v);
  for (const s of [ar, en, ckb]) {
    assert.ok(s.includes('GFT-7KQ-4MZX'));
    assert.ok(s.includes('https://levonis-iq.com/rewards/rate'));
    assert.ok(s.includes('«Bambu Lab P1S»'));
    assert.ok(s.includes('Sara'));
    assert.doesNotMatch(s, /\{\w+\}/, 'every mark filled');
  }
  assert.ok(ar.startsWith('مرحبًا Sara،'));
  assert.ok(ar.includes('«قيّم طابعتك»'));
  assert.ok(ar.includes('أجرة التوصيل فقط'));
  assert.ok(en.startsWith('Hello Sara,'));
  assert.ok(ckb.startsWith('سڵاو Sara،'));
  assert.ok(ckb.includes('«چاپکەرەکەت هەڵبسەنگێنە»'));
  assert.doesNotMatch(ckb, ARABIC_ONLY);
  // No name: the greeting stands alone. A character that means something to replace() is taken as it is.
  assert.ok(readySentence('en', { ...v, name: '  ' }).startsWith('Hello, thank you'));
  assert.ok(readySentence('en', { ...v, printer: 'A$&B' }).includes('«A$&B»'));
  // The screen only copies: no route sends this.
  const panel = readFileSync(join(ROOT, 'src/components/adminReviews/ReviewGiftDecision.tsx'), 'utf8');
  const posts = [...panel.matchAll(/api\.post[^(]*\(([^,]+),/g)].map((m) => m[1]);
  assert.deepEqual(posts, ['`/api/reviews/admin/${encodeURIComponent(row.review_id)}/code/regenerate`']);
  // A refusal reaches the admin in their language: the table's sentence, or this panel's own. Never a bare English word.
  assert.match(panel, /table\.apiRefusal\(err, lang, fallback\)/);
  assert.doesNotMatch(panel, /'Failed'|e\.message/);
});

test('the score field: what counts as a score, and when every opened level is empty', () => {
  for (const ok of ['1', '26', '100', ' 45 ']) assert.notEqual(draftScore(ok), null, ok);
  for (const no of ['', ' ', '0', '101', '12.5', 'abc', '-3']) assert.equal(draftScore(no), null, no);
  assert.equal(initialDraft(92), '92');
  assert.equal(initialDraft(0), '1', 'the system’s 0 still opens level 1');
  assert.equal(initialDraft(null), '');
  assert.equal(initialDraft(undefined), '');
  const offer = (over: Partial<Record<number, { active?: boolean; sellable?: number }>>) =>
    [1, 2, 3, 4, 5].map((level) => ({ level, active: over[level]?.active ?? true, items: 1, sellable: over[level]?.sellable ?? 0 }));
  assert.equal(canApproveScore(26, offer({})), false, 'nothing can be ordered');
  assert.equal(canApproveScore(26, offer({ 3: { sellable: 2 } })), false, 'level 3 does not help a 26');
  assert.equal(canApproveScore(45, offer({ 3: { sellable: 2 } })), true);
  assert.equal(canApproveScore(45, offer({ 3: { sellable: 2, active: false } })), false, 'switched off');
  assert.equal(canApproveScore(26, []), true, 'an older answer says nothing: the server decides');
});

test('the one in-app notice: three languages of its own, and no code in any of them', () => {
  const { title, body } = GIFT_CODE_NOTICE;
  assert.equal(title.ar, 'اعتُمدت مراجعتك');
  assert.equal(body.ar, 'سيصلك كود هديتك من فريق Levonis، أدخله في «قيّم طابعتك».');
  for (const s of [title.ckb, body.ckb]) assert.doesNotMatch(s, ARABIC_ONLY);
  assert.notEqual(title.ckb, title.ar);
  assert.notEqual(body.ckb, body.ar);
  for (const t of [title, body]) for (const s of [t.ar, t.en, t.ckb]) assert.doesNotMatch(s, /GFT|\{/);
});

/**
 * THE SHOP'S OWN NUMBER FIELD. `<input type=number>` reads an Arabic keyboard's ٢٦ as
 * nothing at all, with no line saying what was wrong. The field is text with a digit
 * pad, every keystroke read by `parseLocaleNumber`, and its one complaint is in the
 * admin's language (NumberInput's own has no Sorani). Typing ٢٦ on a real page:
 * tests/browser/gift-reveal.html?view=admin.
 */
test('the score field takes any keyboard’s digits, and says what is wrong when it cannot read a score', () => {
  const draw = (lang: 'ar' | 'en' | 'ckb', value: string) =>
    renderToStaticMarkup(createElement(LanguageProvider, { children: createElement(ScoreField, { lang, value, onChange: () => undefined, quality: null, offer: [] }) }));
  const ok = draw('ar', '92');
  assert.match(ok, /type="text"/);
  assert.match(ok, /inputMode="numeric"/);
  assert.match(ok, /data-review-final-score/);
  assert.match(ok, /value="92"/);
  assert.doesNotMatch(ok, /type="number"/, 'the field that drops ٢٦');
  assert.doesNotMatch(ok, /aria-invalid/);
  assert.ok(ok.includes('يفتح المستويات 1، 2، 3، 4، 5'));
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const wrong = draw(lang, '');
    assert.match(wrong, /aria-invalid="true"/);
    assert.ok(wrong.includes(reviewGiftText(lang, 'scoreInvalid', { from: '1', to: '100' })), `${lang}: the line says what is wrong`);
    assert.doesNotMatch(wrong, /data-review-opens/, 'no score, no opened levels');
  }
  // What NumberInput hands the field for an Arabic or a Kurdish keyboard is the score itself.
  for (const typed of ['٢٦', '۲۶', '26', ' ٢٦ ']) {
    const parsed = parseLocaleNumber(typed, 0);
    assert.equal(parsed.valid, true, typed);
    assert.equal(draftScore(String(parsed.value)), 26, typed);
  }
  const panel = readFileSync(join(ROOT, 'src/components/adminReviews/ReviewGiftDecision.tsx'), 'utf8');
  assert.doesNotMatch(panel, /type="number"/);
  assert.match(panel, /<NumberInput/);
  assert.match(panel, /onValueChange=\{\(n, ok\) => onChange\(ok && n !== null \? String\(n\) : ''\)\}/, 'out of range is no score, and the approve button stays shut');
});
