/**
 * A CATEGORY BANNER'S PHOTOGRAPH ASKS FOR THE COPY ITS DRAWN BOX NEEDS — no
 * bigger, never smaller (speed audit 2026-10-16, finding «cropBanner»).
 *
 * The boxes below were measured in Chromium on the category pages
 * (`img.lv-promo-photo` width, CSS px) at each phone the audit names. The
 * browser takes the smallest server copy at least `slot × DPR` wide; this
 * file evaluates each preset's `sizes` the same way and holds two facts:
 *
 *  - COVERAGE: the copy is never narrower than the drawn box needs (no soft
 *    picture on any measured phone);
 *  - NO OVER-FETCH on the phones that paid for it: a 320–375 px DPR-3 phone
 *    took the 800 copy of every row banner and of the compact hero where the
 *    640 copy covers them (`230px` × 3 = 690 device px).
 *
 * Run: node --import tsx --test tests/categoryImageSizes.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { IMAGE_SIZES, cropDrawnWidth, cropHeroCompactSizes } from '../packages/contracts/src/imageSizes';
import { IMAGE_VARIANT_WIDTHS } from '../packages/contracts/src/imageSizing';

/** The slot a `sizes` value gives at this viewport (px / vw lengths, min-/max-width and min-resolution conditions). */
export function slotWidth(sizes: string, viewport: number, dpr: number): number {
  for (const part of sizes.split(',').map((s) => s.trim())) {
    const m = /^(?:\((min|max)-(width|resolution):\s*([\d.]+)(px|dppx)\)\s+)?([\d.]+)(px|vw)$/.exec(part);
    assert.ok(m, `unparsed sizes clause «${part}»`);
    const [, bound, feature, value, , length, unit] = m;
    const v = Number(value);
    const actual = feature === 'resolution' ? dpr : viewport;
    const holds = !bound || (bound === 'min' ? actual >= v : actual <= v);
    if (holds) return unit === 'vw' ? (Number(length) * viewport) / 100 : Number(length);
  }
  throw new Error(`no clause matched in «${sizes}»`);
}

/** The server copy the browser downloads for that slot. */
export function copyFor(sizes: string, viewport: number, dpr: number): number {
  const needed = slotWidth(sizes, viewport, dpr) * dpr;
  return IMAGE_VARIANT_WIDTHS.find((w) => w >= needed) ?? IMAGE_VARIANT_WIDTHS[IMAGE_VARIANT_WIDTHS.length - 1];
}

const src = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** [viewport, DPR, drawn CSS px] — measured, 2026-10-16. */
const ROW_BANNER: Array<[number, number, number]> = [
  [320, 3, 204.6], [360, 3, 204.6], [360, 2, 204.6], [375, 3, 212.7], [384, 2.8125, 218.3], [390, 3, 222],
  [393, 2.75, 223.3], [412, 2.625, 223.3], [430, 3, 223.3], [640, 2, 302.3], [768, 2, 302.3], [1024, 1, 418.6], [1280, 1, 495.3],
];
/**
 * The compact hero's photograph follows the hero's HEIGHT (its zone is
 * `inset-y-0`; the crop square is max(height / 0.53, width / 0.86)), and the
 * hero grows with its title: one line draws it 192–194 px on a phone, a
 * wrapped title (30 px more) 249 px. Measured in all three languages — the
 * review of the category lane found the en and ckb «Printer Accessories» /
 * «پێداویستی چاپکەر» wrapping at 320 px, and department names wrapping at
 * 360–412 px in ar, en and ckb («رؤوس الطباعة والفوهات», «FDM Printer
 * Accessories», «پارچە یەدەگەکانی زنجیرەی X1 و P1»).
 */
const HERO_COMPACT: Array<[number, number, number]> = [
  [320, 3, 192.4], [360, 3, 192.4], [360, 2, 192.4], [375, 3, 192.4], [384, 2.8125, 192.4], [390, 3, 192.4],
  [393, 2.75, 192.4], [412, 2.625, 192.4], [430, 3, 194.4], [640, 2, 261.6], [768, 2, 318.1], [1024, 1, 379.5], [1280, 1, 449.1],
  // A wrapped title (hero 132 px tall), measured 2026-10-17 in ar, en and ckb.
  [320, 3, 249], [360, 3, 249], [360, 2, 249], [384, 2.8125, 249], [390, 3, 249], [393, 2.75, 249], [412, 2.625, 249], [430, 3, 249],
];
/** The photograph's zone (CSS px, measured) behind those drawn widths: 320 px one line, 430 px one line, 320 px wrapped. */
const HERO_ZONES: Array<[{ width: number; height: number }, number]> = [
  [{ width: 120.95, height: 102 }, 192.4],
  [{ width: 167.16, height: 102 }, 194.4],
  [{ width: 120.95, height: 132 }, 249],
];

test('a category row banner takes a copy that covers its drawn box at every measured screen', () => {
  for (const [vw, dpr, drawn] of ROW_BANNER) {
    assert.ok(copyFor(IMAGE_SIZES.cropBanner, vw, dpr) >= Math.ceil(drawn * dpr - 1), `${vw}@${dpr}: ${drawn} px drawn`);
  }
});

test('a 320–384 px phone downloads the 640 copy of a row banner, not 800; 390 px and up at DPR 3 still take 800', () => {
  for (const [vw, dpr] of [[320, 3], [360, 3], [375, 3], [384, 2.8125], [393, 2.75], [412, 2.625]] as const) {
    assert.equal(copyFor(IMAGE_SIZES.cropBanner, vw, dpr), 640, `${vw}@${dpr}`);
  }
  assert.equal(copyFor(IMAGE_SIZES.cropBanner, 360, 2), 480);
  for (const vw of [390, 430]) assert.equal(copyFor(IMAGE_SIZES.cropBanner, vw, 3), 800, `${vw}@3 needs 666–670 device px`);
});

/** What the compact hero asked with before the category lane, whatever its title (`230px`, the old banner value). */
const BEFORE_LANE = '(min-width: 1024px) 500px, (min-width: 640px) 40vw, 230px';

test('the compact hero asks with its MEASURED box: a one-line title its own 195 px, a wrapped one what it asked before the lane', () => {
  for (const [vw, dpr, drawn] of HERO_COMPACT) {
    const took = copyFor(cropHeroCompactSizes(drawn), vw, dpr);
    const label = `${vw}@${dpr}: ${drawn} px drawn, took ${took}`;
    if (vw >= 640 || drawn < 200 || dpr >= 3) assert.ok(took >= Math.ceil(drawn * dpr - 1), `covers: ${label}`);
    if (vw >= 640) continue;
    // Never heavier than before the lane; a wrapped title exactly the copy it took then (800 on DPR 3,
    // 640 on DPR 2.625–2.75 at 0.93–0.98 image px per device px — the commonest Android screens).
    assert.ok(took <= copyFor(BEFORE_LANE, vw, dpr), `no heavier than before: ${label}`);
    if (drawn >= 200) assert.equal(took, copyFor(BEFORE_LANE, vw, dpr), `no softer than before: ${label}`);
  }
  // The one-line preset alone, the review's finding: a wrapped title took the 640 copy for 747 device px.
  assert.equal(copyFor(IMAGE_SIZES.cropHeroCompact, 320, 3), 640);
  assert.ok(copyFor(IMAGE_SIZES.cropHeroCompact, 320, 3) < Math.ceil(249 * 3 - 1));
  // The crop rule's arithmetic (src/index.css `.lv-promo-photo[data-crop]`) gives the drawn widths measured.
  for (const [zone, drawn] of HERO_ZONES) assert.ok(Math.abs(cropDrawnWidth(zone) - drawn) < 0.5, `${zone.width}×${zone.height}`);
  assert.match(src('src/index.css'), /--lv-s: max\(calc\(100cqh \/ 0\.53\), calc\(100cqw \/ 0\.86\)\);/);
});

test('a one-line compact hero still takes 640 on every DPR-3 phone; the phone clause stays between 195 and 230 px', () => {
  for (const [vw, dpr, drawn] of HERO_COMPACT.filter(([vw, dpr, d]) => vw < 640 && d < 200 && dpr === 3)) {
    assert.equal(copyFor(cropHeroCompactSizes(drawn), vw, dpr), 640, `${vw}@3`);
  }
  for (const vw of [320, 360, 390]) assert.equal(copyFor(cropHeroCompactSizes(249), vw, 3), 800, `${vw}@3 wrapped`);
  assert.equal(cropHeroCompactSizes(0), IMAGE_SIZES.cropHeroCompact, 'an unmeasured zone asks the one-line preset');
  assert.equal(cropHeroCompactSizes(Number.NaN), IMAGE_SIZES.cropHeroCompact);
  assert.equal(cropHeroCompactSizes(192.4), IMAGE_SIZES.cropHeroCompact);
  assert.equal(cropHeroCompactSizes(194.4), IMAGE_SIZES.cropHeroCompact);
  assert.equal(cropHeroCompactSizes(222.6), '(min-width: 1024px) 500px, (min-width: 640px) 40vw, 223px', 'a wrapped breadcrumb (118 px hero)');
  assert.equal(cropHeroCompactSizes(249), BEFORE_LANE);
  assert.equal(cropHeroCompactSizes(306), BEFORE_LANE, 'a three-line title: never heavier than before the lane');
});

test('the compact hero measures its photograph\'s zone BEFORE the picture is inserted, and only ever asks wider', () => {
  const hero = src('src/components/catalog/CategoryHero.tsx');
  assert.match(hero, /fit=\{compact && !band \? cropHeroCompactSizes : undefined\}/);
  const crop = src('src/components/catalog/CropPhoto.tsx');
  // Measured in a layout effect (same task as the commit, before paint and before the image's fetch).
  assert.match(crop, /React\.useLayoutEffect\(/);
  assert.match(crop, /const box = el\.getBoundingClientRect\(\);\s+\/\/[^\n]*\n\s+const next = crop \? cropDrawnWidth\(box\)/);
  // The <picture> waits for the measurement: one request, the right copy (no 640 then 800).
  assert.match(crop, /const fitted = fit \? \(drawn === null \? null : fit\(drawn\)\) : sizes;/);
  assert.match(crop, /\{fitted === null \? null : \(\s*<picture>/);
  // A font that arrives late, a rotation: re-measured, never narrowed (a narrower `sizes` would fetch a smaller copy of a picture already shown).
  assert.match(crop, /new ResizeObserver\(measure\)/);
  assert.match(crop, /prev !== null && Math\.ceil\(prev\) >= Math\.ceil\(next\) \? prev : next/);
});

test('the full hero keeps the copy it had (800 on a DPR-3 phone), and each hero names its own preset', () => {
  assert.equal(copyFor(IMAGE_SIZES.cropHeroFull, 360, 3), 800);
  assert.equal(copyFor(IMAGE_SIZES.cropHeroFull, 412, 2.625), 640);
  const hero = readFileSync(join(ROOT, 'src/components/catalog/CategoryHero.tsx'), 'utf8');
  assert.match(hero, /sizes=\{band \? IMAGE_SIZES\.full : compact \? IMAGE_SIZES\.cropHeroCompact : IMAGE_SIZES\.cropHeroFull\}/);
  const rows = readFileSync(join(ROOT, 'src/components/catalog/CategoryRowBanners.tsx'), 'utf8');
  assert.match(rows, /sizes=\{cover \? IMAGE_SIZES\.full : IMAGE_SIZES\.cropBanner\}/);
});

test('the evaluator reads clauses in order, the way a browser does', () => {
  assert.equal(slotWidth('(min-width: 640px) 40vw, (max-width: 375px) 213px, 224px', 1000, 1), 400);
  assert.equal(slotWidth('(min-width: 640px) 40vw, (max-width: 375px) 213px, 224px', 375, 3), 213);
  assert.equal(slotWidth('(min-width: 640px) 40vw, (max-width: 375px) 213px, 224px', 376, 3), 224);
  assert.equal(slotWidth('(min-resolution: 2.5dppx) 41vw, 45vw', 400, 3), 164);
  assert.equal(copyFor('230px', 360, 3), 800, 'the old phone clause');
});
