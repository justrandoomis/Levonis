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
import { IMAGE_SIZES } from '../packages/contracts/src/imageSizes';
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

/** [viewport, DPR, drawn CSS px] — measured, 2026-10-16. */
const ROW_BANNER: Array<[number, number, number]> = [
  [320, 3, 204.6], [360, 3, 204.6], [360, 2, 204.6], [375, 3, 212.7], [384, 2.8125, 218.3], [390, 3, 222],
  [393, 2.75, 223.3], [412, 2.625, 223.3], [430, 3, 223.3], [640, 2, 302.3], [768, 2, 302.3], [1024, 1, 418.6], [1280, 1, 495.3],
];
const HERO_COMPACT: Array<[number, number, number]> = [
  [320, 3, 192.4], [360, 3, 192.4], [360, 2, 192.4], [375, 3, 192.4], [384, 2.8125, 192.4], [390, 3, 192.4],
  [393, 2.75, 192.4], [412, 2.625, 192.4], [430, 3, 194.4], [640, 2, 261.6], [768, 2, 318.1], [1024, 1, 379.5], [1280, 1, 449.1],
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

test('the compact hero\'s photograph takes 640 on every DPR-3 phone and still covers its box everywhere', () => {
  for (const [vw, dpr, drawn] of HERO_COMPACT) {
    assert.ok(copyFor(IMAGE_SIZES.cropHeroCompact, vw, dpr) >= Math.ceil(drawn * dpr - 1), `${vw}@${dpr}: ${drawn} px drawn`);
  }
  for (const vw of [320, 360, 390, 430]) assert.equal(copyFor(IMAGE_SIZES.cropHeroCompact, vw, 3), 640, `${vw}@3`);
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
