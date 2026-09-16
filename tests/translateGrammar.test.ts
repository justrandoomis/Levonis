/**
 * R7 — THE SENTENCE LAYER.
 *
 * The owner's complaint was that the translator "does not translate English
 * into Arabic" and that he wanted sentences rendered «بدقة عالية وبمعنى كامل
 * وليس ترجمة حرفية» — accurately, with the full meaning, and not literally.
 *
 * These tests hold the new layer to BOTH halves of that, because either one
 * alone is a defect:
 *
 *   it must TRANSLATE a spec sentence into real Arabic, with the modifiers
 *   behind the head noun where Arabic puts them; and
 *
 *   it must still REFUSE marketing prose, because §3 forbids inventing a
 *   translation and a rule engine cannot write persuasive Arabic. A layer that
 *   started guessing at prose would be a worse bug than the one it fixed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translateText } from '../worker/lib/translate/index';
import { GRAMMAR_TABLES } from '../worker/lib/translate/grammar';

const ar = (s: string) => translateText(s, 'ar');

// ------------------------------------------------- the owner's own sentence

test('the Bambu A1 description from the report translates, in Arabic word order', () => {
  const src =
    'Bambu Lab A1 is an open-frame FDM 3D printer with a 256 x 256 x 256 mm build volume, ' +
    'full-auto calibration, active flow-rate compensation, a quick-swap nozzle system, ' +
    'up to 500 mm/s toolhead speed and up to 10,000 mm/s² acceleration.';
  const r = ar(src);

  assert.equal(r.status, 'machine', `still refused: ${r.text}`);
  assert.equal(r.coverage, 1);

  // The HEAD NOUN COMES FIRST and its modifiers follow it. This is the whole
  // difference between a translation and a gloss: a word-by-word engine would
  // emit «مفتوح الإطار FDM ثلاثي الأبعاد طابعة», which is not Arabic.
  assert.match(r.text, /طابعة ثلاثية الأبعاد FDM مفتوحة الهيكل/);

  // The subject is a product NAME and is never translated (§3).
  assert.match(r.text, /^Bambu Lab A1 /);

  // Gender agreement with طابعة (feminine), on both the copula and the
  // participle. Getting this wrong is the clearest tell of machine Arabic.
  assert.match(r.text, /Bambu Lab A1 هي /);
  assert.match(r.text, /مزوّدة ب/);

  // The dimension keeps its numbers, localizes only the unit, and uses ×.
  assert.match(r.text, /حيّز طباعة 256 × 256 × 256 مم/);

  // "up to N" moves BEHIND the head and agrees with it: سرعة is feminine,
  // تسارع is masculine.
  assert.match(r.text, /سرعة رأس الطباعة تصل إلى 500 مم\/ث/);
  assert.match(r.text, /تسارع يصل إلى 10,000 مم\/ث²/);

  // The list is joined with Arabic punctuation and an attached wa-.
  assert.match(r.text, /معايرة تلقائية بالكامل، تعويض نشط لمعدّل التدفق/);

  // Not a single English word of the original survives except the two names.
  assert.doesNotMatch(r.text, /\b(?:printer|build volume|calibration|compensation|acceleration)\b/i);
});

test('the other two sentences of that description translate too', () => {
  const a = ar('Multi-colour printing is supported with AMS lite.');
  assert.equal(a.status, 'machine');
  assert.equal(a.text, 'طباعة متعددة الألوان مدعومة عبر AMS lite.');

  // "AMS lite" is a product line, so it passes through verbatim — that IS its
  // translation, and translating "lite" would be an error.
  const b = ar('The A1 Combo includes AMS lite in the package.');
  assert.equal(b.status, 'machine');
  assert.match(b.text, /^تتضمّن عبوة A1 Combo AMS lite/);
});

// ------------------------------------------------------ the refusal stands

test('marketing prose is STILL refused — the layer did not start guessing', () => {
  for (const prose of [
    'This printer is perfect for hobbyists who want reliable results every day.',
    'We believe everyone should be able to create something beautiful.',
    'Order now and enjoy free delivery across Iraq.',
    'Random unmatched English words here',
  ]) {
    const r = ar(prose);
    assert.equal(r.text, prose, `invented a translation for: ${prose}`);
    assert.equal(r.status, 'review_needed');
  }
});

test('one unknown noun abandons the WHOLE sentence — never a half translation', () => {
  // Same frame as the one that works, with a noun the tables do not carry.
  const r = ar('Bambu Lab A1 is an open-frame FDM 3D printer with a flux capacitor.');
  assert.equal(r.status, 'review_needed');
  assert.match(r.text, /flux capacitor/, 'the English must come back intact');
  assert.doesNotMatch(r.text, /طابعة/, 'no part of it may be translated');
});

// ------------------------------------------------------- the field headings

test('a spec field name on its own resolves — that is most of the review sheet', () => {
  const cases: Array<[string, string]> = [
    ['Chassis', 'الهيكل'],
    ['Additional engineering & sensor details', 'تفاصيل هندسية وحساسات إضافية'],
    ['Heated build plate', 'منصة طباعة ساخنة'],
    ['Hardened steel nozzle', 'فوهة من الفولاذ المقوّى'],
    ['How to use', 'طريقة الاستخدام'],
    ['Filament runout sensor', 'حساس نفاد الفلامنت'],
  ];
  for (const [en, expected] of cases) {
    const r = ar(en);
    assert.equal(r.status, 'machine', `${en} was refused`);
    assert.equal(r.text, expected, en);
  }
});

test('an ampersand is read as "and", so one entry covers both spellings', () => {
  assert.equal(ar('Engineering & sensor details').text, ar('Engineering and sensor details').text);
});

// --------------------------------------------------------- the composition

test('a measurement in front of a head noun moves behind it', () => {
  // English: "[figure] [noun]". Arabic: "[noun] [figure]". Nothing else in
  // the engine reorders anything, so this is the rule doing its job.
  assert.equal(ar('0.4 mm nozzle').text, 'فوهة 0.4 مم');
  assert.equal(ar('220 V power supply').text, 'مزوّد طاقة 220 فولت');
});

test('an adjective follows its head and agrees with it in gender', () => {
  // طابعة is feminine, نظام is masculine — the SAME English adjective must
  // come out differently.
  assert.match(ar('Silent 3D printer').text, /طابعة ثلاثية الأبعاد صامتة/);
  assert.match(ar('Silent nozzle system').text, /نظام فوهات صامت/);
});

test('a thousands separator is not a list separator', () => {
  // The bug this pins: splitting "up to 10,000 mm/s² acceleration" on its
  // comma produced "up to 10" and "000 mm/s² acceleration", and one broken
  // member abandoned the entire sentence.
  const r = ar('Compatible with up to 10,000 mm/s² acceleration and PLA.');
  assert.equal(r.status, 'machine', r.text);
  assert.match(r.text, /10,000 مم\/ث²/);
});

test('a coordinated list keeps Arabic punctuation and attaches the wa-', () => {
  const r = ar('Compatible with PLA, PETG and TPU.');
  assert.equal(r.text, 'متوافق مع PLA، PETG وTPU.');
});

// ---------------------------------------------------------- the invariants

test('every recorded adjective carries BOTH Arabic genders', () => {
  // A one-gender adjective would silently agree wrongly with half the nouns.
  for (const [key, adj] of Object.entries(GRAMMAR_TABLES.ADJECTIVES)) {
    assert.ok(adj.m && adj.f, `${key} is missing a gender`);
  }
});

test('every recorded noun with Arabic carries a gender, or no frame may use it', () => {
  // A frame refuses rather than guessing, so a missing gender is a silent
  // loss of coverage. This names them instead.
  const missing = Object.entries(GRAMMAR_TABLES.NOUN_PHRASES)
    .filter(([, e]) => e.ar && !e.g)
    .map(([k]) => k);
  assert.deepEqual(missing, [], `these nouns can never head a sentence: ${missing.join(', ')}`);
});

test('the grammar layer is pure: same input, same output, no clock, no network', () => {
  const src = 'Bambu Lab A1 is an open-frame FDM 3D printer with full-auto calibration.';
  assert.equal(ar(src).text, ar(src).text);
  assert.equal(translateText(src, 'ckb').text, translateText(src, 'ckb').text);
});

test('Sorani degrades on its own without dragging Arabic down', () => {
  // 'full-auto calibration' has no confident Sorani rendering recorded, so the
  // ckb side refuses while ar succeeds. Never a fabricated Kurdish phrase.
  const src = 'Bambu Lab A1 is an open-frame FDM 3D printer with full-auto calibration.';
  assert.equal(ar(src).status, 'machine');
  assert.equal(translateText(src, 'ckb').status, 'review_needed');
  assert.equal(translateText(src, 'ckb').text, src);
});

// --------------------------------------------- the one that invented text

/**
 * THE WORST CLASS OF BUG THIS ENGINE CAN HAVE: output it made up, marked
 * complete, and shipped with no review flag.
 *
 * `translateText('Acceleration: 10,000 mm/s2', 'ar')` returned
 * «التسارع: 10، 000 مم، s2» with `status: 'machine'` and `coverage: 1`.
 * `mm/s2` was not a unit this catalogue knew — only the superscript `mm/s²`
 * was — so the measurement rule declined, and the ENUMERATION rule then
 * "succeeded" by splitting the number at its thousands separator and
 * translating the debris `10` / `000 mm` / `s2`.
 *
 * §3's one absolute rule is that the engine never invents. A refusal is
 * always acceptable; a fabrication presented as a finished translation is not.
 */
test('a thousands separator is never read as a list separator', () => {
  const r = ar('Acceleration: 10,000 mm/s2');
  assert.equal(r.text, 'التسارع: 10,000 مم/ث²');
  assert.equal(r.status, 'machine');
  // The specific corruption, named so a regression is unmistakable.
  assert.doesNotMatch(r.text, /10، 000/, 'the number was split at its comma');
  assert.doesNotMatch(r.text, /s2/, 'the unit was left in English debris');
});

test('the ASCII unit spellings a vendor page actually uses are recognised', () => {
  // Recording these is what keeps R3 from declining and handing the segment to
  // the enumeration rule in the first place.
  for (const [src, expected] of [
    ['10,000 mm/s2', '10,000 مم/ث²'],
    ['10000 mm/s^2', '10000 مم/ث²'],
    ['24 mm3/s', '24 مم³/ث'],
    ['24 mm^3/s', '24 مم³/ث'],
  ] as Array<[string, string]>) {
    const r = ar(src);
    assert.equal(r.status, 'machine', `${src} was refused`);
    assert.equal(r.text, expected, src);
  }
});

test('a genuine list still translates, and a broken one still refuses', () => {
  assert.equal(ar('PLA, PETG, TPU').text, 'PLA، PETG، TPU');
  // No member resolves → the whole segment comes back in English.
  const junk = ar('Widget, Doohickey, Thingamabob');
  assert.equal(junk.status, 'review_needed');
  assert.equal(junk.text, 'Widget, Doohickey, Thingamabob');
});
