/**
 * THE LIGHT THEME'S LEAD PICTURE KEEPS A SIZE (speed audit 2026-10-16, the
 * light-theme finding — the first of the audit's «high» list).
 *
 * In the light theme the product page shows `light_image` in the primary's
 * slot. It was swapped in as `{ ...m, url: light, width: null, height: null }`,
 * so the lead <img> got the gallery FRAME's `sizes` (calc(100vw - 58px) on a
 * phone) and a srcset running to `?w=1600`. Measured live on 25 of 26
 * products: the 1080 copy on a 360 px phone at DPR 3 where the 800 covers the
 * drawn square; the 1254 px ORIGINAL (77–141 KB) on 430 px phones, iPads and
 * desktops, where a 34–52 KB copy covers it — about 0.6 s of phone LCP.
 *
 * The rule (src/lib/productGallery.ts `lightMainImageSize`): the light file's
 * own stored size when the answer carries one, else its twin's — unless the
 * page has measured the light file and its shape is not the twin's, when no
 * size is given (the old, over-asking but never blurred behaviour).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIGHT_ASPECT_TOLERANCE, dedupeByUrl, lightMainImageSize, mediaInStoredOrder, withLightMainImage } from '../src/lib/productGallery';
import { PRODUCT_GALLERY_SIZES, mediaAspect, productGallerySizes } from '../packages/contracts/src/imageSizes';
import { variantSrcSet } from '../packages/contracts/src/imageSizing';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const MAIN = '/files/products/catalog/gallery/main.webp';
const LIGHT = '/files/products/catalog/gallery/light.webp';
const SIDE = '/files/products/catalog/gallery/side.webp';
const media = [
  { url: SIDE, order: 1, width: 1000, height: 800 },
  { url: MAIN, primary: true, order: 0, width: 1254, height: 1254 },
];

/** What Product.tsx renders for the lead: the light-theme gallery, its first picture's sizes and srcset. */
function lightLead(own?: { width?: number | null; height?: number | null } | null, observed?: number | null) {
  const rows = mediaInStoredOrder(media);
  const primary = dedupeByUrl(rows)[0];
  const gallery = withLightMainImage(rows, primary.url, LIGHT, lightMainImageSize(primary, own, observed));
  const lead = gallery[0];
  return { lead, sizes: productGallerySizes(mediaAspect(lead)), srcset: variantSrcSet(lead.url, { width: lead.width }) };
}

test('the light main image is drawn at its twin\'s size: the drawn square\'s sizes and a srcset that stops at the stored width', () => {
  const { lead, sizes, srcset } = lightLead();
  assert.equal(lead.url, LIGHT, 'the light picture leads in the primary\'s slot');
  assert.deepEqual([lead.width, lead.height], [1254, 1254]);
  assert.equal(sizes, productGallerySizes(1), 'the square actually drawn, not the frame');
  assert.notEqual(sizes, PRODUCT_GALLERY_SIZES);
  assert.ok(srcset?.endsWith(`${LIGHT}?w=1280 1254w`), `the srcset stops at the stored width: ${srcset}`);
  assert.equal(srcset?.includes('?w=1600'), false, 'never the 1600 rung of a 1254 px picture');
  // The same pair the dark theme gives its primary.
  const dark = mediaInStoredOrder(media)[0];
  assert.equal(productGallerySizes(mediaAspect(dark)), sizes);
  assert.equal(variantSrcSet(dark.url, { width: dark.width })?.replaceAll(MAIN, LIGHT), srcset);
});

test('the light file\'s own stored size wins when the answer carries one', () => {
  const { lead, sizes, srcset } = lightLead({ width: 1600, height: 900 });
  assert.deepEqual([lead.width, lead.height], [1600, 900]);
  assert.equal(sizes, productGallerySizes(1600 / 900));
  assert.ok(srcset?.endsWith('?w=1600 1600w'), srcset);
  // A half-known size is not a size.
  assert.deepEqual(lightMainImageSize({ width: 1254, height: 1254 }, { width: 1600, height: null }), { width: 1254, height: 1254 });
});

test('a light file measured in another shape than its twin drops the assumption — never a blurred picture', () => {
  assert.deepEqual(lightMainImageSize({ width: 1254, height: 1254 }, null, 16 / 9), { width: null, height: null });
  const { sizes, srcset } = lightLead(null, 16 / 9);
  assert.equal(sizes, PRODUCT_GALLERY_SIZES, 'the frame width again, as before the fix');
  assert.ok(srcset?.includes('?w=1600 1600w'), 'and every rung, so a larger file still has a candidate');
  // A re-encode's rounding is the same shape.
  assert.deepEqual(lightMainImageSize({ width: 1254, height: 1254 }, null, 1 + LIGHT_ASPECT_TOLERANCE / 2), { width: 1254, height: 1254 });
  // A primary with no stored size gives nothing to borrow.
  assert.deepEqual(lightMainImageSize({ width: null, height: null }), { width: null, height: null });
  assert.deepEqual(lightMainImageSize(undefined), { width: null, height: null });
});

test('every other picture, and a product without a light image, are untouched', () => {
  const rows = mediaInStoredOrder(media);
  assert.deepEqual(withLightMainImage(rows, MAIN, '', { width: 1, height: 1 }), rows);
  const gallery = withLightMainImage(rows, MAIN, LIGHT, { width: 1254, height: 1254 });
  assert.deepEqual(gallery[1], rows[1]);
  assert.equal(gallery.length, rows.length);
});

test('Product.tsx swaps the light picture in through the rule, and checks the measured shape once it has loaded', () => {
  const page = read('src/pages/Product.tsx');
  assert.equal(page.includes('url: light, width: null, height: null'), false, 'the light picture lost its size again');
  assert.match(page, /const size = lightMainImageSize\(\s*primary,\s*\{ width: product\.light_image_width, height: product\.light_image_height \},\s*lightShape\?\.url === light \? lightShape\.aspect : null\s*\);\s*return withLightMainImage\(ordered, primary\.url, light, size\);/);
  // The lead keeps naming the pair from the gallery entry (tests/documentPreloads.test.ts pins the same line).
  assert.match(page, /sizes=\{productGallerySizes\(mediaAspect\(activeMedia\)\)\}\s*naturalWidth=\{activeMedia\?\.width\}\s*onStatus=/);
  assert.match(page, /if \(Math\.abs\(aspect \/ assumed - 1\) > LIGHT_ASPECT_TOLERANCE\) setLightShape\(\{ url: src, aspect \}\);/);
});
