/**
 * THE ANALYSIS, WITHOUT A BROWSER (owner, 2026-11-05; DECISIONS row 301). The one
 * rule of what a score opens; the sheet's clock (about 7 to 9 seconds whatever the
 * review says); real figures only; and, read off the source, that it stays what the
 * owner asked for: a lazy chunk with no animation library, compositor-only motion,
 * skippable, and nothing moving under reduced motion.
 *
 * Run: node --import tsx --test tests/giftRevealScript.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import {
  GIFT_SCORE_MAX,
  GIFT_SCORE_MIN,
  GIFT_SCORE_PARTS,
  GIFT_SCORE_STEP,
  clampGiftScore,
  giftLevelThreshold,
  giftLevelsForScore,
  maxGiftLevel,
  scoreForOldLevel,
} from '../packages/contracts/src/giftScore';
import {
  MOTION,
  PART_FILL,
  REVEAL_MS,
  countAt,
  fillMotion,
  fillOf,
  fillTransform,
  initialPick,
  itemOfChoice,
  opensOnAnalysis,
  railFill,
  revealScript,
  scriptDuration,
  sheenMotion,
  signOf,
  stageOf,
  trackCaption,
} from '../src/components/rewards/revealScript';
import { COPY, SCORE_SCALE, copyText, type CopyKey } from '../src/components/rewards/copy';
import { formatGiftCode } from '../src/components/adminReviews/reviewGiftStrings';
import { groupByLevel, type GiftItemView } from '../src/components/reviews/gifts/GiftCard';

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

// ---------------------------------------------------------------- the one rule

test('levels = 1 + floor(score / 20), at most 5: the owner’s table, and clamped to 1..100', () => {
  const TABLE: ReadonlyArray<[number, number[]]> = [
    [1, [1]],
    [5, [1]],
    [19, [1]],
    [20, [1, 2]],
    [26, [1, 2]],
    [39, [1, 2]],
    [40, [1, 2, 3]],
    [59, [1, 2, 3]],
    [60, [1, 2, 3, 4]],
    [79, [1, 2, 3, 4]],
    [80, [1, 2, 3, 4, 5]],
    [100, [1, 2, 3, 4, 5]],
  ];
  for (const [score, levels] of TABLE) {
    assert.deepEqual(giftLevelsForScore(score), levels, `score ${score}`);
    assert.equal(maxGiftLevel(score), levels.length, `score ${score}`);
  }
  // A score outside the scale is held to it; nothing opens a sixth level.
  assert.deepEqual(giftLevelsForScore(0), [1]);
  assert.deepEqual(giftLevelsForScore(-7), [1]);
  assert.deepEqual(giftLevelsForScore(500), [1, 2, 3, 4, 5]);
  assert.equal(clampGiftScore(0), 1);
  assert.equal(clampGiftScore(101), 100);
  assert.equal(clampGiftScore(Number.NaN), 1);
  assert.equal(clampGiftScore(26.9), 26);
});

test('the track’s thresholds say the same rule: «يفتح عند 40» is the score that opens level 3', () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(giftLevelThreshold), [1, 20, 40, 60, 80]);
  for (const level of [2, 3, 4, 5]) {
    assert.equal(maxGiftLevel(giftLevelThreshold(level)), level);
    assert.equal(maxGiftLevel(giftLevelThreshold(level) - 1), level - 1);
  }
});

test('an old tab’s level becomes the score that opens exactly it, the system’s own when it already does', () => {
  assert.equal(scoreForOldLevel(3, 45), 45, 'the system’s score opens level 3: it stands');
  assert.equal(scoreForOldLevel(2, 100), 39, 'above the band: the nearest that opens level 2');
  assert.equal(scoreForOldLevel(4, 5), 60, 'below the band: the nearest that opens level 4');
  assert.equal(scoreForOldLevel(5, 100), 100);
  assert.equal(scoreForOldLevel(1, 0), 1);
  assert.equal(scoreForOldLevel(3, null), 40);
  for (const level of [1, 2, 3, 4, 5]) for (const system of [0, 5, 26, 61, 100, null]) assert.equal(maxGiftLevel(scoreForOldLevel(level, system)), level, `${level} from ${system}`);
});

test('the parts the screens name add up to the whole scale', () => {
  const { text, images, video, story, stars } = GIFT_SCORE_PARTS;
  assert.deepEqual([text, images, video, story, stars], [42, 27, 18, 8, 5]);
  assert.equal(text + images + video + story + stars, 100);
});

// ------------------------------------------------------------------- the clock

const part = (adjustment: number, levels: number[]) => ({
  levels,
  breakdown: {
    text: { score: 10, max: 42, chars: 40, words: 8 },
    images: { score: 0, max: 27, count: 0 },
    video: { score: 0, max: 18, present: false },
    story: { score: 0, max: 8, present: false },
    stars: { score: 5, max: 5, stars: 3 },
    adjustment,
  },
});

test('the analysis takes about 7 to 9 seconds whatever the review opened, in the spec’s order', () => {
  for (const levels of [[1], [1, 2], [1, 2, 3], [1, 2, 3, 4], [1, 2, 3, 4, 5]]) {
    for (const adjustment of [0, 3, -7]) {
      const ms = scriptDuration(revealScript(part(adjustment, levels)));
      assert.ok(ms >= 7000 && ms <= 9000, `${levels.length} levels, adjustment ${adjustment}: ${ms} ms`);
    }
  }
  const script = revealScript(part(3, [1, 2]));
  assert.deepEqual(script.map((s) => s.key), ['download', 'text', 'images', 'video', 'story', 'stars', 'adjust', 'total', 'level', 'level', 'settle']);
  assert.deepEqual(script.filter((s) => s.key === 'level').map((s) => s.level), [1, 2], 'one by one, only the opened');
  assert.ok(!revealScript(part(0, [1])).some((s) => s.key === 'adjust'), 'no gap, no line');
  assert.ok(REVEAL_MS.total >= 900, 'the figure has time to be read');
});

test('a bar fills to its real figure, a missing video to its real nothing; the count never passes the score', () => {
  assert.equal(fillOf(0, 18), 0);
  assert.equal(fillOf(21, 42), 0.5);
  assert.equal(fillOf(27, 27), 1);
  assert.equal(fillOf(99, 27), 1);
  assert.equal(fillOf(5, 0), 0);
  assert.equal(fillOf(Number.NaN, 5), 0);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(railFill), [0, 0, 0.25, 0.5, 0.75, 1, 1]);
  assert.equal(countAt(26, 0, 1000), 0);
  assert.equal(countAt(26, 1000, 1000), 26);
  assert.equal(countAt(26, 5000, 1000), 26);
  assert.equal(countAt(26, 500, 0), 26);
  let last = 0;
  for (let t = 0; t <= 1000; t += 16) {
    const n = countAt(26, t, 1000);
    assert.ok(n >= last && n <= 26, `${t}: ${n}`);
    last = n;
  }
});

test('coming back lands on the right step; reduced motion never plays', () => {
  assert.equal(stageOf({ status: 'GRANTED' }), 'choose');
  assert.equal(stageOf({ status: 'READY_TO_REDEEM' }), 'choose');
  assert.equal(stageOf({ status: 'REDEEMED' }), 'add');
  assert.equal(stageOf({ status: 'ADDED_TO_ORDER' }), 'done');
  assert.equal(stageOf({ status: 'ORDERED' }), 'ordered');
  assert.equal(stageOf({ status: 'FULFILLED' }), 'fulfilled');
  assert.equal(stageOf({ status: 'CANCELLED' }), 'cancelled');
  assert.equal(opensOnAnalysis(true, false), true);
  assert.equal(opensOnAnalysis(true, true), false, 'reduced motion: straight to the result');
  assert.equal(opensOnAnalysis(false, false), false, 'a returning customer: the result, with «شاهد التحليل»');
});

test('the gifts group by level, in the server’s order, and a code prints as it is read aloud', () => {
  const item = (id: string, level: number | null) => ({ item_id: id, product_id: `p_${id}`, level }) as unknown as GiftItemView;
  assert.deepEqual(groupByLevel([item('a', 1), item('b', 1), item('c', 2)]).map((g) => [g.level, g.items.map((i) => i.item_id)]), [[1, ['a', 'b']], [2, ['c']]]);
  assert.deepEqual(groupByLevel([]), []);
  assert.deepEqual(groupByLevel([item('a', null)]).map((g) => g.level), [null], 'an older answer: one group');
  assert.equal(itemOfChoice({ choices: [item('a', 1)] }, 'a')?.item_id, 'a');
  assert.equal(itemOfChoice({ choices: null }, 'a'), null);
  assert.equal(formatGiftCode('GFT7KQ4MZX'), 'GFT-7KQ-4MZX');
});

// --------------------------------------------------------------- what it stays

test('a lazy chunk, no animation library, and the figures come from the server’s answer alone', () => {
  const rate = read('src/components/rewards/RateScreen.tsx');
  assert.match(rate, /const loadReveal = \(\) => import\('\.\/GiftReveal'\);/);
  assert.match(rate, /const GiftReveal = prefetchable\(loadReveal\);/, 'a module already here renders in the same pass: no empty fallback, and no 300 ms hold after it');
  assert.match(rate, /onFocus=\{warmReveal\}/, 'the chunk starts loading the moment the field is touched');
  assert.doesNotMatch(rate, /= React\.lazy\(/);
  assert.doesNotMatch(rate, /from '\.\/GiftReveal'/, 'never in the page’s own chunk');
  const sheet = read('src/components/rewards/GiftReveal.tsx');
  assert.doesNotMatch(sheet, /from '(?:motion|gsap|motion\/react)[^']*'/, 'no animation library');
  assert.doesNotMatch(sheet, /Math\.random/, 'nothing invented');
  assert.match(sheet, /data-reveal-skip/, 'skippable');
  assert.match(sheet, /usePrefersReducedMotion/);
  assert.match(sheet, /opensOnAnalysis\(play, reduced\)/);
  // Only the order the spec gives: choose, redeem, cart.
  const posts = [...sheet.matchAll(/api\.post[^(]*\((`[^`]+`|'[^']+')/g)].map((m) => m[1]);
  assert.deepEqual(posts.slice(0, 3), ["'/api/cart/gift-items'", '`/api/gifts/${encodeURIComponent(gift.id)}/choose`', '`/api/gifts/${encodeURIComponent(gift.id)}/redeem`']);
});

test('the motion is transform and opacity only, reads right in both directions, and the sheet’s look is tokens', () => {
  const moves = [...Object.values(MOTION), fillMotion(0, 0.5, 1, 600), fillMotion(0, 0.5, -1, 600, 130), sheenMotion(1), sheenMotion(-1)];
  for (const m of moves) {
    for (const frame of m.frames) for (const k of Object.keys(frame)) assert.ok(k === 'transform' || k === 'opacity', `a frame animates ${k}`);
    assert.ok(m.options.duration > 0 && m.options.duration <= 2000, 'calm, and never long');
  }
  // A bar shows its share from the start of the line, whichever way the line reads.
  assert.equal(signOf('rtl'), -1);
  assert.equal(signOf('ltr'), 1);
  assert.equal(fillTransform(0.5, 1), 'translateX(-50%)');
  assert.equal(fillTransform(0.5, -1), 'translateX(50%)');
  assert.equal(fillTransform(1, -1), 'translateX(0%)');
  assert.equal(fillTransform(0, 1), 'translateX(-100%)');
  assert.equal(fillTransform(0, -1), 'translateX(100%)');
  // The figure appears once the bar has nearly filled, and the whole of a part fits inside its dwell.
  assert.ok(PART_FILL.delay + PART_FILL.duration <= REVEAL_MS.images);
  assert.ok(MOTION.fade.options.delay + MOTION.fade.options.duration <= REVEAL_MS.images);

  const sheet = read('src/components/rewards/GiftReveal.tsx');
  assert.doesNotMatch(sheet, /\.css'/, 'no stylesheet: the shop’s CSS gate has no room for one (tests/bundleBudget.test.ts)');
  assert.doesNotMatch(sheet, /\b(?:filter|backdropFilter|textShadow)\s*:/, 'no glow and no blur');
  assert.match(sheet, /sizes="64px" reveal="none"/, 'the photo above the analysis does not blur in: that would animate `filter`');
  assert.match(sheet, /typeof el\.animate !== 'function'/, 'a browser without Web Animations shows the same figures, still');
  // Reduced motion: the analysis never mounts, the result does not rise, and the unfolded figures do not move.
  assert.match(sheet, /const root = useMove<HTMLDivElement>\(!reduced, MOTION\.rise\);/);
  assert.match(sheet, /<PartRow key=\{line\.key\} line=\{line\} shown still \/>/);
  assert.match(sheet, /if \(reduced && view === 'analysis'\) finish\(\);/, 'the setting changing mid-way stops it too');
});

test('the rate screen’s code box says only the server’s words, and closed levels’ gifts have nowhere to come from', () => {
  const rate = read('src/components/rewards/RateScreen.tsx');
  assert.match(rate, /api\.post<RevealData>\('\/api\/rewards\/program\/gift-code', \{ code \}\)/);
  for (const key of ['code.err.invalid', 'code.err.used', 'code.err.generic']) assert.ok(rate.includes(`'${key}'`), key);
  assert.doesNotMatch(rate, /giftScore'/, 'the page computes no figure: the server sends each level’s threshold');
  // The old fixed contents of a level left with chapter 8's box.
  assert.doesNotMatch(rate, /rate\.level[1-5]/);
  const sheet = read('src/components/rewards/GiftReveal.tsx');
  assert.doesNotMatch(sheet, /\/api\/gifts\/admin|gift_pool_items|\/levels/, 'the page asks for no level’s list of its own');
});

// ---------------------------------------------------------------- nothing told early

/**
 * THE ANALYSIS IS THE FIRST TO SAY THE SCORE. The hub used to be read the moment the
 * code answered, so the page behind the rising sheet already read «درجتك 92 من 100»,
 * and the track's captions named the levels that would open while the figure was
 * still counting. tests/browser/gift-reveal.html shows both on a real page.
 */
test('the page behind hears of the code only when the sheet reaches the result, and however the customer leaves it hears in the end', () => {
  const rate = read('src/components/rewards/RateScreen.tsx');
  const written = /const onWritten = \(answer: RevealData\) => \{([\s\S]*?)\n {2}\};/.exec(rate)?.[1] ?? '';
  assert.ok(written, 'onWritten is findable');
  assert.doesNotMatch(written, /\brefresh\(\)|\breload\(\)/, 'no read while the sheet is still rising');
  assert.match(written, /owed\.current = true/);
  assert.match(written, /loadReveal\(\)\.catch\(refresh\)/, 'a chunk that never arrives: no sheet covers the page, and it reads at once');
  assert.match(rate, /if \(owed\.current\) void reload\(\);/, 'leaving by Back or a link pays what is owed');
  assert.match(rate, /onClose=\{\(\) => \{\s*setReveal\(null\);\s*refresh\(\);/, 'closing the sheet reads too');
  const sheet = read('src/components/rewards/GiftReveal.tsx');
  assert.match(sheet, /const pageTold = useRef\(!play\);/, 'a returning customer’s hub already knows');
  assert.match(sheet, /if \(view !== 'result' \|\| pageTold\.current\) return;\s*pageTold\.current = true;\s*onChanged\(\);/);
});

test('a step of the track says the score it opens at until it lights, whichever levels this review will reach', () => {
  const steps = [1, 2, 3, 4, 5].map((level) => ({ level, threshold: giftLevelThreshold(level) }));
  for (const step of steps) {
    assert.deepEqual(trackCaption(step, false), { key: 'reveal.opensAt', n: step.threshold }, 'not lit: no telling');
    assert.deepEqual(trackCaption(step, true), { key: 'rate.level', n: step.level }, 'lit: its name');
  }
  const sheet = read('src/components/rewards/GiftReveal.tsx');
  assert.match(sheet, /const caption = trackCaption\(step, on\);/);
  assert.doesNotMatch(sheet, /step\.opened \? t\(/, 'the caption no longer reads the answer ahead of the light');
  // A caption going from two lines to one must not move the track under the figure.
  assert.match(sheet, /style=\{settled \? LOOK\.caption : LOOK\.captionHeld\}/);
});

// ---------------------------------------------------------------- a withdrawn pick

test('an item withdrawn since it was chosen is no pick: the confirm stays shut until the customer chooses again', () => {
  const choice = (id: string) => ({ item_id: id, product_id: `p_${id}` }) as unknown as GiftItemView;
  const a = choice('a');
  const b = choice('b');
  assert.equal(initialPick({ chosen: a, choices: [a, b] }), 'a', 'chosen earlier and still offered: it comes back chosen');
  assert.equal(initialPick({ chosen: choice('gone'), choices: [a, b] }), '', 'withdrawn: no pick, and no dialog with no name in it');
  assert.equal(initialPick({ chosen: choice('gone'), choices: [a] }), 'a', 'withdrawn, one left: the lone gift is the choice');
  assert.equal(initialPick({ chosen: null, choices: [a] }), 'a');
  assert.equal(initialPick({ chosen: null, choices: [a, b] }), '');
  assert.equal(initialPick({ chosen: choice('gone'), choices: null }), '');
  assert.equal(initialPick({ chosen: null, choices: [{ item_id: null, product_id: 'p_only' } as unknown as GiftItemView] }), 'p_only', 'an older answer names the product');
  const sheet = read('src/components/rewards/GiftReveal.tsx');
  assert.match(sheet, /useState<string>\(\(\) => initialPick\(data\.gift\)\)/);
  assert.match(sheet, /disabled=\{!pickedItem \|\| busy\}/, 'the button asks the offer, not the state');
  assert.match(sheet, /if \(busy \|\| !pickedItem\) return;/);
});

// ------------------------------------------------------------------ one kind of digit

/**
 * ON A PHONE SET TO AN ARABIC LOCALE every figure the sheet draws is «٢٦», so a «100»
 * written into a string read «٢٦ من 100». The scale goes through `formatFigure` like
 * the figure beside it, and the strings hold marks.
 */
test('the score’s scale is a mark in every sentence that names it, and agrees with the rule', () => {
  assert.deepEqual([SCORE_SCALE.from, SCORE_SCALE.to, SCORE_SCALE.every], [GIFT_SCORE_MIN, GIFT_SCORE_MAX, GIFT_SCORE_STEP]);
  const named: CopyKey[] = ['rate.score', 'rate.step3', 'reveal.of100', 'reveal.sr.result', 'reveal.done.body'];
  for (const key of named) for (const s of COPY[key]) assert.doesNotMatch(s, /[0-9]/, `${key}: «${s}» holds a digit`);
  for (const key of Object.keys(COPY) as CopyKey[]) {
    if (key.startsWith('reveal.')) for (const s of COPY[key]) assert.doesNotMatch(s, /[0-9]/, `${key}: a digit no locale can change`);
  }
  assert.equal(copyText('reveal.of100', 'ar', { max: '١٠٠' }), 'من ١٠٠');
  assert.equal(copyText('rate.score', 'ar', { score: '٢٦', max: '١٠٠' }), 'درجتك ٢٦ من ١٠٠');
  assert.equal(copyText('rate.score', 'en', { score: '26', max: '100' }), 'You scored 26 of 100', 'English reads as it did');
  assert.equal(copyText('rate.score', 'ckb', { score: '26', max: '100' }), '26 لە 100 نمرەت هێنا');
  assert.equal(
    copyText('rate.step3', 'en', { from: '1', to: '100', every: '20' }),
    'The system scores your review from 1 to 100 by how helpful it is — never by the stars. The Levonis team approves it and gives you a code. Every 20 points opens a level: write the code, choose one gift from your levels, and pay for delivery only.'
  );
  // Each screen fills every mark, in the reader's digits.
  const sheet = read('src/components/rewards/GiftReveal.tsx');
  assert.equal([...sheet.matchAll(/t\('reveal\.of100', \{ max: formatFigure\(SCORE_SCALE\.to, lang\) \}\)/g)].length, 2, 'the analysis and the result');
  assert.match(sheet, /t\('reveal\.sr\.result', \{ score: formatFigure\(data\.score, lang\), max: formatFigure\(SCORE_SCALE\.to, lang\), opened \}\)/);
  assert.match(sheet, /t\('reveal\.done\.body', \{ zero: formatFigure\(0, lang\) \}\)/);
  const rate = read('src/components/rewards/RateScreen.tsx');
  assert.match(rate, /t\('rate\.score', \{ score: formatFigure\(score, lang\), max: formatFigure\(SCORE_SCALE\.to, lang\) \}\)/);
  assert.match(rate, /from: formatFigure\(SCORE_SCALE\.from, lang\), to: formatFigure\(SCORE_SCALE\.to, lang\), every: formatFigure\(SCORE_SCALE\.every, lang\)/);
});

// ------------------------------------------------------------- what the customer reads

test('a used code promises no waiting gift: it was delivered, or the team cancelled it', () => {
  assert.deepEqual([...COPY['code.err.used']], [
    'استُخدم هذا الكود من قبل. تجد حالة هديتك في «هداياي».',
    "This code has already been used. You can see your gift's status in «My gifts».",
    'ئەم کۆدە پێشتر بەکارهاتووە. دۆخی دیارییەکەت لە «دیارییەکانم» دەبینیت.',
  ]);
});

test('the screens say what policy 8.13 says: the story raises the score, and asks nothing of the gift', () => {
  const [ar, en, ckb] = COPY['rate.step2'];
  assert.ok(ar.includes('الفيديو وستوري إنستغرام يرفعان درجتك'));
  assert.ok(en.includes('A video and an Instagram story raise your score'));
  assert.ok(ckb.includes('ڤیدیۆ و ستۆری ئینستاگرام نمرەکەت بەرز دەکەنەوە'));
  const form = read('src/components/reviews/ReviewSection.tsx');
  for (const stale of ['لتأكيد الأهلية', 'to confirm eligibility', 'پشتڕاستکردنەوەی شایستەیی']) assert.ok(!form.includes(stale), stale);
  for (const said of ['ويرفع درجة مراجعتك', 'it raises your review score', 'نمرەی پێداچوونەوەکەت بەرز دەکاتەوە']) assert.ok(form.includes(said), said);
});

test('the order’s review sheet says what the queue takes, and that photos and a video raise the score from the product page', () => {
  const sheet = read('src/components/orders/ReviewSheet.tsx');
  // Every sound printer review enters, and this sheet has no way to add a photo.
  for (const stale of ['المراجعة الغنية', 'a rich review may enter', 'لەوانەیە بچێتە ڕیزی دیاری']) assert.ok(!sheet.includes(stale), stale);
  for (const said of [
    'ومراجعة طابعة اشتريتها تدخل قائمة اعتماد هدايا التقييم، والصور والفيديو من صفحة المنتج ترفع درجتها.',
    'A review of a printer you bought enters the gift approval queue, and photos and a video from the product page raise its score.',
    'پێداچوونەوەی پرینتەرێک کە کڕیوتە دەچێتە ڕیزی دیاری، و وێنە و ڤیدیۆ لە پەڕەی بەرهەمەکەوە نمرەکەی بەرز دەکەنەوە.',
  ]) assert.ok(sheet.includes(said), said);
});
