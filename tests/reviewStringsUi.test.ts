/**
 * THE REVIEW FEATURE SPEAKS ARABIC, ENGLISH AND WRITTEN SORANI
 * (docs/REVIEWS_GIFTS.md §8 C1; owner brief §8: «AR / EN / CKB … لا تستخدم
 * نصوص Hard-coded خارج نظام localization»).
 *
 * src/components/reviews/reviewStrings.ts is every word of the review form,
 * the media picker, the stars, the gallery and its viewer, the product page's
 * review section and the profile's reviews. This pins, for each language:
 *
 *  - the SAME keys (nested ones included), every value non-empty;
 *  - every sentence with a number carries the same numbers in all three
 *    languages (a count that is in the Arabic and missing from the Sorani is
 *    a different sentence);
 *  - the Sorani is Sorani: never the Arabic copied across, never Arabic-only
 *    letters (ة ي ك or harakat), and Kurdish letters in (nearly) every value —
 *    the OWNER-placeholder pattern this feature used to ship is gone;
 *  - the doc's key sentences are used verbatim, so /gifts, the admin and the
 *    review form say the same thing about a gift.
 *
 * Run: node --import tsx --test tests/reviewStringsUi.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { REVIEW_STRINGS, reviewStrings, asReviewLang } from '../src/components/reviews/reviewStrings';

const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** Letters only Kurdish (Sorani) writes — not Arabic, not Persian. */
const KURDISH_ONLY = /[ەۆێڕڵڤ]/;
/** Letters Sorani writes that Arabic does not (Persian shares some). */
const KURDISH_ANY = /[ەۆێڕڵڤگچپژیک]/;
/** Arabic orthography Sorani never uses: ة ي ك and the harakat. Escaped: they are combining marks. */
const ARABIC_ONLY = /[ةيك]|[ً-ْ]/;

type Leaf = { path: string; ar: string; en: string; ckb: string };

/** A template with no words of its own («${name}»: ${reason}) — it has no language to check. */
const formatOnly = (l: Leaf) => ![l.ar, l.en, l.ckb].some((v) => /\p{L}/u.test(v));

/** Every leaf of the three tables, functions called with marker numbers. */
function leaves(): Leaf[] {
  const out: Leaf[] = [];
  const walk = (path: string, ar: unknown, en: unknown, ckb: unknown) => {
    if (typeof ar === 'function') {
      assert.equal(typeof en, 'function', `${path}: en is not a function`);
      assert.equal(typeof ckb, 'function', `${path}: ckb is not a function`);
      const call = (f: unknown) => String((f as (...a: unknown[]) => unknown)(7, 3));
      out.push({ path, ar: call(ar), en: call(en), ckb: call(ckb) });
      return;
    }
    if (ar && typeof ar === 'object') {
      const keys = Object.keys(ar as object).sort();
      assert.deepEqual(Object.keys(en as object).sort(), keys, `${path}: en keys differ`);
      assert.deepEqual(Object.keys(ckb as object).sort(), keys, `${path}: ckb keys differ`);
      for (const k of keys) walk(path ? `${path}.${k}` : k, (ar as never)[k], (en as never)[k], (ckb as never)[k]);
      return;
    }
    out.push({ path, ar: String(ar), en: String(en), ckb: String(ckb) });
  };
  walk('', REVIEW_STRINGS.ar, REVIEW_STRINGS.en, REVIEW_STRINGS.ckb);
  return out;
}

test('the three tables have the same keys and no empty value', () => {
  const all = leaves();
  assert.ok(all.length > 100, `only ${all.length} strings — the table is the whole feature`);
  for (const l of all) {
    for (const lang of ['ar', 'en', 'ckb'] as const) {
      assert.ok(l[lang].trim().length > 0, `${l.path} is empty in ${lang}`);
    }
  }
});

test('a number in one language is the same number in the other two', () => {
  const nums = (s: string) => (s.match(/\d+/g) ?? []).sort().join(',');
  for (const l of leaves()) {
    assert.equal(nums(l.ckb), nums(l.ar), `${l.path}: ckb «${l.ckb}» vs ar «${l.ar}»`);
    assert.equal(nums(l.en), nums(l.ar), `${l.path}: en «${l.en}» vs ar «${l.ar}»`);
  }
});

test('the Sorani is written Sorani, never the Arabic standing in', () => {
  const all = leaves().filter((l) => !formatOnly(l));
  let kurdishOnly = 0;
  let kurdishAny = 0;
  for (const l of all) {
    assert.notEqual(l.ckb, l.ar, `${l.path}: the ckb value IS the Arabic`);
    assert.notEqual(l.ckb, l.en, `${l.path}: the ckb value is the English`);
    assert.doesNotMatch(l.ckb, ARABIC_ONLY, `${l.path}: «${l.ckb}» uses Arabic-only letters`);
    if (KURDISH_ONLY.test(l.ckb)) kurdishOnly += 1;
    if (KURDISH_ANY.test(l.ckb)) kurdishAny += 1;
  }
  // A few Sorani words use only letters Arabic shares («داخستن»); nearly
  // every sentence still carries a letter Arabic never writes.
  assert.ok(kurdishOnly / all.length >= 0.9, `only ${kurdishOnly}/${all.length} ckb values carry a Kurdish-only letter`);
  assert.ok(kurdishAny / all.length >= 0.95, `only ${kurdishAny}/${all.length} ckb values carry a Kurdish letter`);
});

test('the Arabic is Arabic and the English is English', () => {
  for (const l of leaves().filter((x) => !formatOnly(x))) {
    assert.match(l.ar, /[؀-ۿ]/, `${l.path}: ar «${l.ar}» has no Arabic`);
    assert.doesNotMatch(l.en, /[؀-ۿ]/, `${l.path}: en «${l.en}» carries Arabic script`);
  }
});

test('the doc’s key sentences are used verbatim (§9 «Key UI sentences»)', () => {
  const ar = reviewStrings('ar');
  const en = reviewStrings('en');
  const ckb = reviewStrings('ckb');
  assert.equal(ar.giftQueued, 'مراجعتك قيد اعتماد الهدية');
  assert.equal(en.giftQueued, 'Your review is being considered for a gift');
  assert.equal(ckb.giftQueued, 'هەڵسەنگاندنەکەت لە ژێر پێداچوونەوەدایە بۆ دیاری');
  assert.equal(ar.giftApproved, 'تم اعتماد مراجعتك للحصول على هدية');
  assert.equal(en.giftApproved, 'Your review was approved for a gift');
  assert.equal(ckb.giftApproved, 'هەڵسەنگاندنەکەت بۆ وەرگرتنی دیاری پەسەند کرا');
  // The counters the owner asked for, by the shape he wrote them.
  assert.match(ar.photosCount(3), /3\/10/);
  assert.match(ar.videosCount(1), /1\/2/);
  assert.match(ckb.photosCount(3), /3\/10/);
  assert.match(en.videosCount(2), /2\/2/);
});

test('an unknown language falls back to Arabic, the store’s source language', () => {
  assert.equal(asReviewLang('fr'), 'ar');
  assert.equal(reviewStrings('ku').sheetTitle, REVIEW_STRINGS.ar.sheetTitle);
});

test('no review surface ships an OWNER placeholder, and the brand is never spelled in Arabic', () => {
  for (const file of [
    'src/components/orders/ReviewSheet.tsx',
    'src/components/reviews/ReviewSection.tsx',
    'src/components/reviews/ReviewMediaGallery.tsx',
    'src/components/reviews/ReviewMediaPicker.tsx',
    'src/components/reviews/ReviewMediaViewer.tsx',
    'src/components/reviews/StarRating.tsx',
    'src/components/reviews/reviewStrings.ts',
    'src/components/orders/OrderCard.tsx',
  ]) {
    const src = read(file);
    assert.ok(!src.includes('OWNER: Sorani to be written by hand'), `${file} still stands Arabic in for Sorani`);
    assert.ok(!/ليفونيس|لیڤۆنیس|ليڤونيس/.test(src), `${file} spells the brand in Arabic script`);
  }
  // The form's words live in the feature's table, not in a second copy inside the sheet.
  const sheet = read('src/components/orders/ReviewSheet.tsx');
  assert.ok(!/const STRINGS\s*=/.test(sheet), 'ReviewSheet reads reviewStrings, it keeps no table of its own');
  assert.match(sheet, /reviewStrings\(lang\)/);
});

test('the order screens’ review and gift words are Sorani too', () => {
  const orders = read('src/pages/Orders.tsx');
  const detail = read('src/pages/OrderDetail.tsx');
  const card = read('src/components/orders/OrderCard.tsx');
  // «published», never «awaiting approval»: the review is live the moment it is sent.
  assert.match(orders, /reviewThanks: 'سوپاس — هەڵسەنگاندنەکەت بڵاوکرایەوە\./);
  assert.match(detail, /reviewThanks: 'سوپاس — هەڵسەنگاندنەکەت بڵاوکرایەوە\./);
  assert.match(detail, /reviewThanks: 'شكرًا — نُشرت مراجعتك\./);
  assert.match(detail, /reviewThanks: 'Thank you — your review is published\./);
  assert.ok(!/awaiting approval|بانتظار الاعتماد|چاوەڕێی پەسەندکردنە/.test(detail), 'no screen says a published review awaits approval');
  // «هدية / Gift / دیاری» on a gift line (§8 C1).
  for (const src of [detail, card]) {
    assert.match(src, /giftLine: 'هدية'/);
    assert.match(src, /giftLine: 'Gift'/);
    assert.match(src, /giftLine: 'دیاری'/);
  }
  assert.match(card, /reviewedAll: 'هەموو بەرهەمەکانی ئەم داواکارییەت هەڵسەنگاندووە'/);
});
