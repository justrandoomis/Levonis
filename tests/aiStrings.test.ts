/**
 * PUSH B'S SERVER SENTENCES, THREE TIMES BY HAND (push B plan §16 #18, §12.1,
 * §12.5; DECISIONS row 183).
 *
 * The assistant's new templates (worker/lib/assist/strings.ts), the
 * customer's read refusals (packages/contracts/src/assistAiRefusals.ts) and
 * the automatic-reading policy (worker/lib/policies/assistant_ai.ts) exist in
 * Arabic, English and Sorani with the same placeholders; Sorani is never the
 * Arabic and English is never the Arabic. `tr()` silently falls back to
 * Arabic, so a missing key would not fail anywhere else.
 *
 * (The client keys — the page, the + sheet, the desk and the admin tab — are
 * the client part's, in its own tests.)
 *
 * Run: node --import tsx --test tests/aiStrings.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ASSIST_T, tr } from '../worker/lib/assist/strings';
import { ASSIST_AI_READ_REFUSALS, ASSIST_AI_REFUSALS } from '../packages/contracts/src/assistAiRefusals';
import { getPolicyDocument } from '../worker/lib/policies';

/** The §12.1 keys, plus the clip's own «not available». */
const PUSH_B_KEYS = [
  'photo_code_one',
  'photo_code_many',
  'photo_label_match',
  'photo_symptom',
  'photo_part',
  'photo_printer',
  'photo_unclear',
  'photo_unavailable',
  'clip_unavailable',
  'video_frames_note',
  'chip_code_yes',
  'chip_yes',
  'chip_not_this',
  'ai_not_meant',
  'voice_unavailable',
  'voice_unclear',
  'voice_ckb',
  'voice_too_long',
] as const;

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const SORANI_LETTER = /[ڕڵۆێەڤڎ]/;

test('every push B template exists in all three languages, with the same placeholders', () => {
  for (const key of PUSH_B_KEYS) {
    const [ar, en, ckb] = (['ar', 'en', 'ckb'] as const).map((l) => ASSIST_T[l][key]);
    assert.ok(ar && en && ckb, `${key} is missing a language`);
    assert.deepEqual(placeholders(en!), placeholders(ar!), `${key}: en placeholders`);
    assert.deepEqual(placeholders(ckb!), placeholders(ar!), `${key}: ckb placeholders`);
    assert.notEqual(ckb, ar, `${key}: ckb is the Arabic`);
    assert.notEqual(en, ar, `${key}: en is the Arabic`);
    assert.notEqual(ckb, en, `${key}: ckb is the English`);
    assert.doesNotMatch(en!, /[\u0600-\u06FF]/, `${key}: Arabic script in the English`);
  }
  // The key sets of the three dictionaries are still one set.
  const keys = (l: 'ar' | 'en' | 'ckb') => Object.keys(ASSIST_T[l]).sort();
  assert.deepEqual(keys('en'), keys('ar'));
  assert.deepEqual(keys('ckb'), keys('ar'));
});

test('the Sorani templates are Sorani: most carry a letter only Sorani writes', () => {
  const sorani = PUSH_B_KEYS.filter((k) => SORANI_LETTER.test(ASSIST_T.ckb[k]!));
  // «بەڵێ» alone is short; every longer sentence carries one.
  assert.ok(sorani.length >= PUSH_B_KEYS.length - 1, `only ${sorani.length} of ${PUSH_B_KEYS.length}`);
});

test('placeholders are filled, never left showing', () => {
  for (const loc of ['ar', 'en', 'ckb'] as const) {
    const filled = tr(loc, 'photo_code_one', { code: '0300-0100-0001-0003' });
    assert.ok(filled.includes('0300-0100-0001-0003') && !filled.includes('{'), loc);
    assert.ok(!tr(loc, 'video_frames_note', { count: 3 }).includes('{'), loc);
  }
});

test('the read refusals: three languages, Sorani its own', () => {
  const codes = Object.keys(ASSIST_AI_READ_REFUSALS) as Array<keyof typeof ASSIST_AI_READ_REFUSALS>;
  assert.deepEqual(codes.sort(), ['AI_CONSENT_REQUIRED', 'AI_FRAMES_INVALID', 'AI_FRAMES_TOO_LARGE', 'AI_READ_INVALID', 'AI_READ_KIND']);
  for (const code of codes) {
    const e = ASSIST_AI_READ_REFUSALS[code];
    for (const l of ['ar', 'en', 'ckb'] as const) assert.ok(e[l].trim().length > 10, `${code}.${l}`);
    assert.notEqual(e.ckb, e.ar, code);
    assert.notEqual(e.en, e.ar, code);
    assert.ok(SORANI_LETTER.test(e.ckb), `${code}: no Sorani letter`);
    assert.ok(!(code in ASSIST_AI_REFUSALS), `${code} is also an admin code`);
  }
});

test('the automatic-reading policy is written three times, article for article', () => {
  const doc = getPolicyDocument('assistant_ai');
  assert.ok(doc);
  const articles = (body: string) => [...body.matchAll(/^###? (\d+(?:\.\d+)?)/gm)].map((m) => m[1]);
  assert.deepEqual(articles(doc.body.en), articles(doc.body.ar));
  assert.deepEqual(articles(doc.body.ckb), articles(doc.body.ar));
  assert.notEqual(doc.body.ckb, doc.body.ar);
  assert.notEqual(doc.title.ckb, doc.title.ar);
  // It names company names only, never a model, and says what never comes from AI in each language.
  assert.match(doc.body.ar, /الأسعار والتوفر والتوافق ومعاني رموز الأخطاء لا تأتي أبدًا من الذكاء الاصطناعي/);
  assert.match(doc.body.en, /Prices, availability, compatibility and error-code meanings never come from AI/);
  assert.match(doc.body.ckb, /هەرگیز لە زیرەکی دەستکردەوە نایەن/);
  for (const l of ['ar', 'en', 'ckb'] as const) assert.match(doc.body[l], /### 1\.2 /, `${l}: «only while reading is on» is article 1.2`);
});
