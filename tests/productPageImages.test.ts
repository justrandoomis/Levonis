/**
 * The template importer's product-page fallback reads a store page's own
 * JSON-LD and og:image. Pinned against a trimmed copy of the real Bambu Lab
 * PLA Basic page (tests/fixtures/bambuPlaBasicPage.html) that the owner's
 * template pointed at: every colour code in that template resolves.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { extractPageImages, pickPageImage } from '../worker/lib/productPageImages';

const PAGE = extractPageImages(
  readFileSync(join(ROOT, 'tests/fixtures/bambuPlaBasicPage.html'), 'utf8'),
  'https://us.store.bambulab.com/products/pla-basic-filament'
);

test('the page primary is its og:image', () => {
  assert.match(PAGE.primary ?? '', /PLA_Basic_White\.jpg$/);
  assert.equal(pickPageImage(PAGE, { bindingId: '', labels: [] }), PAGE.primary);
});

test('every colour id of the owner template resolves by its code', () => {
  const ids = [
    'yellow-10400', 'orange-10300', 'gold-10401', 'bambu-green-10501', 'mistletoe-green-10502', 'pink-10203',
    'magenta-10202', 'red-10200', 'purple-10700', 'cyan-10603', 'blue-10601', 'brown-10800', 'bronze-10801',
    'gray-10103', 'silver-10102', 'blue-grey-10602', 'dark-gray-10105', 'black-10101', 'sunflower-yellow-10402',
    'pumpkin-orange-10301', 'bright-green-10503', 'turquoise-10605', 'cobalt-blue-10604', 'hot-pink-10204',
    'maroon-red-10205', 'indigo-purple-10701', 'cocoa-brown-10802', 'jade-white-10100', 'beige-10201', 'light-gray-10104',
  ];
  for (const id of ids) assert.ok(pickPageImage(PAGE, { bindingId: id, labels: [] }), id);
  assert.match(pickPageImage(PAGE, { bindingId: 'turquoise-10605', labels: [] }) ?? '', /Turquoise\.jpg$/);
  assert.match(pickPageImage(PAGE, { bindingId: 'blue-10601', labels: [] }) ?? '', /PLABasicBlue\.jpg$/);
});

test('by words, "Blue" never takes "Blue Grey", and an unknown colour gives null', () => {
  const page = {
    primary: null,
    variants: [
      { name: 'PLA - Blue Grey / 1kg', image: 'https://x/bg.jpg' },
      { name: 'PLA - Blue / 1kg', image: 'https://x/b.jpg' },
    ],
  };
  assert.equal(pickPageImage(page, { bindingId: 'col_blue', labels: ['Blue'] }), 'https://x/b.jpg');
  assert.equal(pickPageImage(page, { bindingId: 'blue-grey', labels: [] }), 'https://x/bg.jpg');
  assert.equal(pickPageImage(page, { bindingId: 'neon-pink', labels: ['Neon Pink'] }), null);
});

test('non-http image values and broken JSON-LD are ignored', () => {
  const html = `<meta property="og:image" content="javascript:alert(1)">
<script type="application/ld+json">{broken</script>
<script type="application/ld+json">{"@type":"Product","name":"X - Red","image":"data:image/png;base64,AA"}</script>`;
  const page = extractPageImages(html, 'https://shop.example/p');
  assert.equal(page.primary, null);
  assert.deepEqual(page.variants, []);
});
