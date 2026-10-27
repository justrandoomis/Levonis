/**
 * A PICTURE CROPPED TO FILL ITS BOX, AND THE GRID ON A DENSE PHONE — the
 * `sizes` the verification of DECISIONS row 226 found wrong.
 *
 *  - `object-cover` scales a picture to its box's HEIGHT, so a picture wider
 *    than the box is drawn wider than the box: a `sizes` naming the box asked
 *    for a copy that was then stretched (community covers 0.53–0.71, store
 *    gallery tiles 0.51–0.77, a phone store hero 0.74 image pixels per screen
 *    pixel). `coverSizes` multiplies the box by that factor when the picture's
 *    aspect is known (feed and cover-story covers); a store block's picture
 *    carries none, so `coverFit` sets `sizes` to the drawn width once a copy
 *    has loaded, and the phone hero asks for 150vw.
 *  - The product grid's bytes had not moved: on a phone of DPR 2.5+ its slot
 *    is declared at 1 / 2.2 of the row, which takes the 480 copy instead of 640.
 *
 * Run: node --import tsx --test tests/imageCoverSizes.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { IMAGE_SIZES, coverSizes, coverStorySizes, feedCoverSizes } from '../packages/contracts/src/imageSizes';
import { IMAGE_VARIANT_WIDTHS, STORE_HERO_SIZES } from '../packages/contracts/src/imageSizing';
import { coverFit } from '../src/components/storefront/parts';

const src = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

test('coverSizes: the box when the picture is no wider than it, the drawn width when it is — px, vw and any other length', () => {
  const boxes = [
    { media: '(min-width: 1024px)', width: '672px', aspect: 4 / 3 },
    { media: '(min-width: 640px)', width: 'calc(100vw - 32px)', aspect: 4 / 3 },
    { width: '100vw', aspect: 4 / 3 },
  ];
  assert.equal(coverSizes(boxes, 1), '(min-width: 1024px) 672px, (min-width: 640px) calc(100vw - 32px), 100vw', 'a square photograph fills a 4:3 card by its width');
  assert.equal(coverSizes(boxes, 16 / 9), '(min-width: 1024px) 896px, (min-width: 640px) calc(calc(100vw - 32px) * 1.33), 133.33vw');
  assert.equal(coverSizes(boxes, null), coverSizes(boxes, 16 / 9), 'no aspect: a 16:9 photograph is assumed');
  assert.equal(coverSizes([{ width: '100px', aspect: 1 }], 12), '400px', 'never more than 4 ×');
});

test('a feed cover and the cover story ask for what they draw', () => {
  // Card v2 (community UI plan C2.1): a 16:9 frame inset in the card, 646 px in the 672 px column.
  assert.equal(feedCoverSizes({ width: 1600, height: 900 }), IMAGE_SIZES.feedCover, '16:9: the frame itself');
  assert.equal(feedCoverSizes({ width: 1000, height: 1000 }), IMAGE_SIZES.feedCover, 'square: cropped to the width, the frame itself');
  assert.match(feedCoverSizes({ width: 2400, height: 1000 }), /^\(min-width: 1024px\) 872\.1px, calc\(calc\(100vw - 58px\) \* 1\.35\)$/, 'a 2.4:1 picture is drawn 1.35 × wider than the frame');
  // The cover story is 1120 px wide at 1280 (it used to say 720).
  assert.equal(coverStorySizes(null), '(min-width: 1024px) min(1120px, calc(100vw - 32px)), 100vw');
  assert.equal(coverStorySizes(2.4), '(min-width: 1024px) min(1120px, calc(100vw - 32px)), 135vw', 'a 12:5 picture fits the desktop frame; on a phone it is 1.35 × wider than 16:9');
  assert.match(src('src/components/community/feed/PostCard.tsx'), /sizes=\{feedCoverSizes\(p\.cover\)\}/);
  assert.equal((src('src/components/community/hub/CoverStory.tsx').match(/sizes=\{coverStorySizes\(/g) ?? []).length, 2);
});

test('a store picture cropped to fill takes the copy its drawn width needs once it has loaded; the phone hero asks for 150vw', () => {
  const sets: string[] = [];
  const img = (w: number, h: number, nw: number, nh: number) => {
    let sizes = '(min-width: 768px) 280px, 50vw';
    return {
      clientWidth: w, clientHeight: h, naturalWidth: nw, naturalHeight: nh,
      get sizes() { return sizes; },
      set sizes(v: string) { sets.push(v); sizes = v; },
    };
  };
  const wide = img(174, 174, 480, 200);
  coverFit({ currentTarget: wide } as never);
  assert.deepEqual(sets, ['418px'], 'a 2.4:1 picture in a 174 px square tile is drawn 418 px wide');
  coverFit({ currentTarget: wide } as never);
  assert.deepEqual(sets, ['418px'], 'the bigger copy\'s own load changes nothing');
  coverFit({ currentTarget: img(174, 174, 480, 480) } as never);
  coverFit({ currentTarget: img(174, 174, 300, 480) } as never);
  assert.deepEqual(sets, ['418px'], 'square and portrait pictures fill the tile by its width');
  assert.match(src('src/components/storefront/blocks/Gallery.tsx'), /onLoad=\{coverFit\}/);
  assert.match(src('src/components/catalog/ProductGallery.tsx'), /onLoad=\{coverFit\}/);
  assert.equal(STORE_HERO_SIZES, '(max-width: 639px) 150vw, 100vw');
  // 390 px at DPR 3: 1755 device pixels — the 1600 copy, for a 2.4:1 cover drawn 576 px wide (1728).
  assert.ok(390 * 1.5 * 3 > IMAGE_VARIANT_WIDTHS[IMAGE_VARIANT_WIDTHS.length - 2]);
});

test('the product grid on a DPR-3 phone takes the 480 copy; a desktop keeps 320', () => {
  const card = src('src/components/home/ProductCard.tsx');
  const grid = /const GRID_CARD_SIZES =\s*'([^']+)'/.exec(card)?.[1] ?? '';
  assert.match(grid, /\(min-resolution: 2\.5dppx\) calc\(\(100vw - 42px\) \/ 2\.2\), calc\(\(100vw - 42px\) \/ 2\)$/);
  // The browser takes the smallest copy at least slot × DPR wide.
  const pick = (needed: number) => IMAGE_VARIANT_WIDTHS.find((w) => w >= needed);
  assert.equal(pick(((390 - 42) / 2.2) * 3), 480, '390 px, DPR 3 (0.92 image px per screen px)');
  assert.equal(pick(((412 - 42) / 2.2) * 2.625), 480, '412 px, DPR 2.625 (0.99)');
  assert.equal(pick(((390 - 42) / 2) * 2), 480, 'DPR 2 is unchanged');
  assert.equal(pick((1280 - 72) / 5), 320, 'desktop is unchanged');
  assert.match(IMAGE_SIZES.card, /\(min-resolution: 2\.5dppx\) 41vw, 45vw$/);
});
