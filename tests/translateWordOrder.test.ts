/**
 * WORD ORDER — THE DEFECT WHERE THE ENGINE LIED ABOUT SUCCEEDING.
 *
 * The audit found «١٣ كغم الوزن الإجمالي» for "gross weight 13 kg": the VALUE
 * printed before its LABEL. What made it a live incident rather than an
 * annoyance is the second half — `status` came back `'machine'` and
 * `coverage` came back `1`. Nothing was flagged, nothing reached the review
 * page, and the only reason no customer read it is that the owner's
 * hand-written Arabic is what is stored today. Editing one character of the
 * English would have overwritten that hand-written Arabic with this.
 *
 * THE ROOT CAUSE, one line, in `grammar.ts` `resolveNoun` step 3. That rule is
 * "<measurement> <head noun>" — English writes "0.4 mm nozzle", Arabic writes
 * «فوهة 0.4 مم», so the rule moves the figure behind the head. It decided what
 * counted as "the measurement" by calling `ctx.atom`, and `ctx.atom` is
 * `translateAtom`, which tries the PHRASES dictionary FIRST. So any ordinary
 * label — "gross weight", "product dimensions", "automatic" — satisfied the
 * test for "this prefix is a measurement", and the rule dutifully moved the
 * LABEL to the end of the line.
 *
 * The same one line produced three more shapes, all marked `'machine'`:
 *
 *   "Product dimensions 389 x 389 x 458 mm"
 *       → «× 389 × 458 مم 389 أبعاد المنتج»   (the dimension itself shredded:
 *         the prefix "389" passed as a bare number, and the recursion re-split
 *         what was left)
 *   "Automatic 3D printer"
 *       → «طابعة ثلاثية الأبعاد تلقائي»       (masculine adjective on a
 *         feminine noun — step 3 fired before the gender-agreeing step 4)
 *   "Black printer"
 *       → «طابعة أسود»                        (same, for a colour, which has
 *         no agreeing pair recorded at all)
 *
 * WHAT THIS FILE PINS. Per the mandate «إذا لم يستطع النظام المحلي ترجمة مقطع
 * بأمان، احتفظ بالنص الإنجليزي لذلك المقطع وعلّمه داخليًا review_needed؛ لا
 * تخترع ترجمة», a wrong translation is strictly worse than an absent one: the
 * wrong one ships silently, the absent one is flagged and a human fixes it. So
 * every case below asserts BOTH halves — the text AND the status — and the
 * cases the engine cannot order with certainty assert that the English comes
 * back untouched rather than asserting some invented Arabic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { segment, translateText } from '../worker/lib/translate/index';

const ar = (s: string) => translateText(s, 'ar');
const ckb = (s: string) => translateText(s, 'ckb');

/** Arabic script runs from U+0600; a Latin comma, semicolon or "x" sitting
 *  between two of them is the punctuation bug this file also covers. */
const LATIN_IN_ARABIC =
  /[؀-ۿ][^؀-ۿ]{0,3}[,;x][^؀-ۿ]{0,3}[؀-ۿ]/;

// ------------------------------------------- 1. the reported line, verbatim

test('a label followed by its measurement keeps the label FIRST', () => {
  // Arabic is head-initial: the thing being measured is named, then measured.
  // «الوزن الإجمالي 13 كغم» is a nominal sentence and is what an Arabic spec
  // sheet says. «13 كغم الوزن الإجمالي» is not Arabic in any register.
  const r = ar('Gross weight 13 kg');
  assert.equal(r.status, 'machine', r.text);
  assert.equal(r.text, 'الوزن الإجمالي 13 كغم');

  // The exact corruption, named so a regression is unmistakable.
  assert.doesNotMatch(r.text, /^13 كغم/, 'the value was printed before its label');
});

test('the same reversal on every label the audit could have hit', () => {
  for (const [src, expected] of [
    ['Net weight 9.5 kg', 'الوزن الصافي 9.5 كغم'],
    ['Nozzle diameter 0.4 mm', 'قطر الفوهة 0.4 مم'],
    // «سرعة طباعة», indefinite, because the NOUN_PHRASES entry is written for
    // composition into a sentence («مزوّدة بسرعة طباعة عالية»). On a bare spec
    // line «سرعة الطباعة» would read better. That is a DICTIONARY question,
    // not a word-order one, and it is deliberately not touched here — this
    // track is correctness of order first, vocabulary second (owner's own
    // sequencing). Pinned as-is so the difference is visible rather than
    // rediscovered.
    ['Print speed 500 mm/s', 'سرعة طباعة 500 مم/ث'],
    ['Layer height 0.08 mm', 'ارتفاع الطبقة 0.08 مم'],
    ['Warranty period 12 months', 'مدة الضمان 12 شهر'],
    ['Rated power 350W', 'القدرة المقننة 350 واط'],
  ] as Array<[string, string]>) {
    const r = ar(src);
    assert.equal(r.status, 'machine', `${src} was refused: ${r.text}`);
    assert.equal(r.text, expected, src);
  }
});

test('Sorani gets the same order, because Sorani is head-initial too', () => {
  const r = ckb('Gross weight 13 kg');
  assert.equal(r.status, 'machine', r.text);
  assert.equal(r.text, 'کێشی گشتی 13 کگم');
});

// ------------------------------------ 2. the dimension that shredded itself

test('a dimension stays whole and is never re-split by the noun rule', () => {
  // «× 389 × 458 مم 389 أبعاد المنتج» is what this returned, with
  // status 'machine'. The first "389" had been peeled off as a bare number,
  // and the remainder re-parsed as a measurement of its own.
  const r = ar('Product dimensions 389 x 389 x 458 mm');
  assert.equal(r.status, 'machine', r.text);
  assert.equal(r.text, 'أبعاد المنتج 389 × 389 × 458 مم');
  assert.doesNotMatch(r.text, /^×/, 'the dimension was split at its first number');
});

test('the dimensions-and-weight line the audit reported', () => {
  const r = ar('Dimensions 480 x 480 x 530 mm, weight 13 kg');
  assert.equal(r.status, 'machine', r.text);
  assert.equal(r.text, 'الأبعاد 480 × 480 × 530 مم والوزن 13 كغم');
  assert.doesNotMatch(r.text, LATIN_IN_ARABIC, 'Latin punctuation inside Arabic text');
});

test('the measurement-first shape still moves the figure behind the head', () => {
  // The rule that was being abused is a REAL rule and must keep working:
  // English "0.4 mm nozzle", Arabic «فوهة 0.4 مم».
  assert.equal(ar('0.4 mm nozzle').text, 'فوهة 0.4 مم');
  assert.equal(ar('220 V power supply').text, 'مزوّد طاقة 220 فولت');
  assert.equal(ar('256 x 256 x 256 mm build volume').text, 'حيّز طباعة 256 × 256 × 256 مم');
});

// ---------------------------------------------- 3. gender, and the refusals

test('a recorded adjective agrees with its head instead of being glued on', () => {
  // «طابعة ثلاثية الأبعاد تلقائي» shipped as 'machine'. طابعة is feminine.
  const r = ar('Automatic 3D printer');
  assert.equal(r.status, 'machine', r.text);
  assert.equal(r.text, 'طابعة ثلاثية الأبعاد تلقائية');
});

test('a colour has no agreeing pair recorded, so the segment is REFUSED', () => {
  // «طابعة أسود» is the masculine form on a feminine noun. There is no
  // recorded «سوداء» for the engine to pick, and §3 forbids deriving one. The
  // right answer is therefore the English, flagged — not a guess.
  for (const src of ['Black printer', 'Black 3D printer', 'Transparent spool']) {
    const r = ar(src);
    assert.equal(r.status, 'review_needed', `invented an agreement for: ${r.text}`);
    assert.equal(r.text, src, 'the English must come back intact');
  }
});

// ------------------------------- 4. Latin punctuation inside Arabic output

test('a comma between two measurements becomes the Arabic comma', () => {
  const r = ar('Weight: 13 kg, 500 mm/s');
  assert.equal(r.status, 'machine', r.text);
  assert.equal(r.text, 'الوزن: 13 كغم، 500 مم/ث');
  assert.doesNotMatch(r.text, LATIN_IN_ARABIC);
});

test('a semicolon between two measurements becomes the Arabic semicolon', () => {
  const r = ar('Layer height: 0.1 mm; 0.2 mm');
  assert.equal(r.status, 'machine', r.text);
  assert.equal(r.text, 'ارتفاع الطبقة: 0.1 مم؛ 0.2 مم');
});

test('a glued dimension uses × like the spaced one, not a Latin x', () => {
  // "256x256x256mm" is how a vendor page writes it. The spaced form already
  // became «256 × 256 × 256 مم»; the glued form kept the Latin x, which in RTL
  // text renders as a stray Latin letter in the middle of Arabic.
  const r = ar('Build volume: 256x256x256mm');
  assert.equal(r.status, 'machine', r.text);
  assert.equal(r.text, 'حجم الطباعة: 256 × 256 × 256 مم');
});

test('a comma BETWEEN DIGITS stays Latin — it is a thousands separator', () => {
  // The digits themselves are Latin (see the NUMBERS note in index.ts), so the
  // separator that belongs to them is Latin too. Turning it into «،» would
  // make «10٬000» read as a two-item list in the middle of a number.
  const r = ar('Acceleration: 10,000 mm/s2');
  assert.equal(r.text, 'التسارع: 10,000 مم/ث²');
  assert.equal(r.status, 'machine');
});

// -------------------------------------------------- 5. ranges, and refusals

test('a numeric range is a measurement, as R3 always claimed it was', () => {
  // index.ts documents R3 as covering "220-240 V", and a range token used to
  // match no number pattern at all, so even that came back English and
  // flagged. It works now — for a unit that does not inflect.
  for (const [src, expected] of [
    ['220-240 V', '220-240 فولت'],
    ['Input voltage 220-240 V', 'جهد الدخل 220-240 فولت'],
    // Again the NOUN_PHRASES wording («حرارة التشغيل») rather than the
    // PHRASES one («درجة حرارة التشغيل»); same note as above.
    ['Operating temperature 15-30 °C', 'حرارة التشغيل 15-30 °م'],
    ['15-30 microns', '15-30 ميكرون'],
  ] as Array<[string, string]>) {
    const r = ar(src);
    assert.equal(r.status, 'machine', `${src} was refused: ${r.text}`);
    assert.equal(r.text, expected, src);
  }
});

/**
 * THIS TEST REPLACES AN ASSERTION THAT PINNED A FABRICATION.
 *
 * It used to read `['Lead time: 3-4 weeks', 'مدة التجهيز: 3-4 أسبوع']` and
 * demand `status: 'machine'`. «3-4 أسبوع» is not Arabic — a range makes the
 * counted noun plural, «3-4 أسابيع» — and `UNITS` stores one form per key, so
 * there is no plural for the engine to reach for. Before ranges parsed at all
 * these lines were kept in English and FLAGGED, which is what §3 asks for; the
 * range support turned a correctly-flagged line into a wrong one marked
 * finished. That is a regression this engine created, so the assertion that
 * froze it is the thing that was wrong, not the refusal.
 *
 * A single figure in front of the same noun is NOT touched here: «12 شهر» is a
 * pre-existing infelicity, it is what the catalogue already says, and changing
 * it is a plural-forms job for the dictionary, not a word-order one. When
 * `UNITS` records plurals, `COUNTING_UNITS` in index.ts is what should shrink.
 */
test('a range in front of a counting noun is refused, not inflected wrongly', () => {
  for (const src of ['3-4 weeks', 'Lead time: 3-4 weeks', 'Warranty period 1-2 years', '2-3 pcs']) {
    const r = ar(src);
    assert.equal(r.status, 'review_needed', `${src} must be flagged, not fabricated: ${r.text}`);
    assert.equal(r.text, src, 'a refusal keeps the English exactly as written');
  }
  // And the single-figure form still behaves as it always has.
  assert.equal(ar('Warranty period 12 months').text, 'مدة الضمان 12 شهر');
});

test('two units with no number between them are not glued in English order', () => {
  // "1 kg spool" means a spool weighing 1 kg. `spool` is a UNITS entry, so R3
  // read the segment as three units in a row, joined them in English order and
  // produced «1 كغم بكرة» — word salad, marked 'machine'. R3 now refuses the
  // shape, and the segment falls through to the grammar layer, which knows
  // `spool` as a HEAD NOUN and puts the figure behind it where Arabic wants it.
  const good = ar('1 kg spool');
  assert.equal(good.status, 'machine', good.text);
  assert.equal(good.text, 'بكرة 1 كغم');

  // And where the grammar layer has no head noun recorded either — no plural
  // «بكرات» keyed as a noun phrase, no `rolls` at all — the answer is the
  // English, flagged. Never the glued form.
  for (const src of ['1 kg spools', '3 x 1 kg rolls']) {
    const r = ar(src);
    assert.equal(r.status, 'review_needed', `invented an order for: ${r.text}`);
    assert.equal(r.text, src);
  }
});

// --------------------------------------------------------- 6. enumerations

test('an enumeration is split on ONE separator, never on two at once', () => {
  // "Black, White / Red" was split on both, producing «أسود، أبيض، أحمر» —
  // three equal items where the source had two, and the "or" meaning of the
  // slash silently deleted. The engine cannot know what the slash means
  // inside a member, so it refuses.
  const r = ar('Colors: Black, White / Red');
  assert.equal(r.status, 'review_needed', `flattened a mixed list: ${r.text}`);
  assert.equal(r.text, 'Colors: Black, White / Red');

  // Each separator ON ITS OWN still works, exactly as before.
  assert.equal(ar('Supported materials: PLA, PETG, TPU').text, 'المواد المدعومة: PLA، PETG، TPU');
  assert.equal(ar('Supported materials: PLA / PETG / TPU').text, 'المواد المدعومة: PLA / PETG / TPU');
});

test('a slash inside a unit no longer destroys the list around it', () => {
  // Splitting on "/" as well as "," tore "500 mm/s" into "500 mm" and "s".
  const r = ar('Print speed: 500 mm/s, 10000 mm/s2');
  assert.equal(r.status, 'machine', r.text);
  assert.equal(r.text, 'سرعة الطباعة: 500 مم/ث، 10000 مم/ث²');
});

// ------------------------------------------------------------- 7. numbers

test('digits are NEVER converted to Arabic-Indic, in any rule', () => {
  // The policy, stated once and pinned here: this engine localizes UNITS and
  // WORDS, never digits. See the NUMBERS note in index.ts for why — a stored
  // value must stay comparable with the English row it came from, and a mix of
  // ٠١٢ and 012 inside one spec sheet is its own defect.
  const arabicIndic = /[٠-٩۰-۹]/;
  for (const src of [
    'Gross weight 13 kg',
    'Product dimensions 389 x 389 x 458 mm',
    'Acceleration: 10,000 mm/s2',
    '0.4 mm nozzle',
    'Lead time: 3-4 weeks',
    'Bambu Lab A1 is a 3D printer with a 256 x 256 x 256 mm build volume.',
  ]) {
    assert.doesNotMatch(ar(src).text, arabicIndic, src);
    assert.doesNotMatch(ckb(src).text, arabicIndic, src);
  }
});

// ------------------------------- 8. the line that is actually on the site

test('the A1 dimensions line from levonis-iq.com, in the author\'s order', () => {
  // Fetched from the live product API while writing this. It is the audit's
  // "dimensions line with the weight before the dimensions and a Latin comma
  // inside Arabic text" — a semicolon, in fact, but the same defect:
  //
  //   OLD  «13 كغم الوزن الإجمالي 596 × 536 × 325 مم;»   status: machine
  //
  // As ONE segment nothing matched until the noun rule, which read the
  // dimension as a modifier of "gross weight 13 kg" and moved it behind. The
  // semicolon is a CLAUSE BOUNDARY, so `segment()` now splits there and each
  // half is an ordinary spec line in the order the author wrote it.
  const r = ar('596 × 536 × 325 mm; gross weight 13 kg');
  assert.equal(r.status, 'machine', r.text);
  assert.equal(r.text, '596 × 536 × 325 مم؛ الوزن الإجمالي 13 كغم');
  assert.doesNotMatch(r.text, LATIN_IN_ARABIC);

  // Splitting at the semicolon is a gain elsewhere too: two labelled clauses
  // on one line used to fail as a whole and now both translate.
  assert.equal(
    ar('Nozzle diameter: 0.4 mm; Layer height: 0.2 mm').text,
    'قطر الفوهة: 0.4 مم؛ ارتفاع الطبقة: 0.2 مم'
  );
});

test('segment() still reassembles its input byte for byte', () => {
  // The semicolon joined the terminator set, so the invariant is re-pinned:
  // dropping the inter-clause space would reflow the author's text on save.
  for (const src of [
    '596 × 536 × 325 mm; gross weight 13 kg',
    'a; b. c\nd؛ e',
    'no terminators at all',
    '',
  ]) {
    assert.equal(segment(src).join(''), src, JSON.stringify(src));
  }
});

test('a measurement in front of a NON-noun is refused, not reordered', () => {
  // Also live on the site: "0.4 mm included; 0.2 / 0.6 / 0.8 mm optional".
  // `included` and `optional` are short VALUES in the flat dictionary, not
  // head nouns. Reordering around them produced «مشمول 0.4 مم» — "included
  // 0.4 mm". Arabic wants «0.4 مم مشمولة», with an agreement nothing here has
  // recorded, so the engine keeps the English and flags it.
  const r = ar('0.4 mm included; 0.2 / 0.6 / 0.8 mm optional');
  assert.equal(r.status, 'review_needed', `invented an order for: ${r.text}`);
  assert.equal(r.text, '0.4 mm included; 0.2 / 0.6 / 0.8 mm optional');
});

test('composition is bounded, so a pasted spec run cannot hang the save', () => {
  // Requiring a real head noun removed an accidental early exit in rule 3, and
  // the split-and-recurse rules are exponential without one. A run of nothing
  // but measurements is the shape that found it. This must return, fast, and
  // it must return a refusal rather than something composed out of debris.
  //
  // The trailing unknown word is what forces the grammar layer to be reached
  // at all: without it R3 reads the whole run as one measurement and returns
  // immediately, which is correct and is not the path that hung.
  const run =
    '256 x 256 x 256 mm ' + Array.from({ length: 30 }, () => '0.4 mm').join(' ') + ' widget';
  const started = Date.now();
  const r = ar(run);
  assert.ok(Date.now() - started < 2000, 'composition did not terminate promptly');
  assert.equal(r.status, 'review_needed');
  assert.equal(r.text, run);
});

// ------------------------------------------- 9. the refusal has not widened

test('prose is still refused and still comes back intact', () => {
  for (const prose of [
    'This printer is perfect for hobbyists who want reliable results every day.',
    'Random unmatched English words here',
  ]) {
    const r = ar(prose);
    assert.equal(r.status, 'review_needed');
    assert.equal(r.text, prose);
  }
});

test('a refused segment is reported as review_needed with honest coverage', () => {
  // The whole point of the fix: what the engine cannot order correctly must
  // ARRIVE at the review page, not be silently marked complete.
  const r = ar('Black printer');
  assert.equal(r.coverage, 0);
  assert.equal(r.segments.every((s) => s.rule === 'untranslated' || s.rule === 'blank'), true);
});
