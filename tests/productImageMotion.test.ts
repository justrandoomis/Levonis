import test from 'node:test';
import assert from 'node:assert/strict';
import { imagePlane } from '../src/components/motion/ProductTransition';
import { gallerySwipeStep } from '../src/components/motion/GallerySurface';

test('a cover-cropped card and a padded hero describe the same undistorted image plane', () => {
  const card = imagePlane({ x: 20, y: 100, width: 160, height: 130 }, 600, 600, 'cover', '50% 4%', 0);
  assert.deepEqual(card, { x: 20, y: 98.8, width: 160, height: 160 });
  const hero = imagePlane({ x: 16, y: 64, width: 358, height: 340 }, 600, 600, 'contain', '50% 50%', 12);
  for (const [key, expected] of Object.entries({ x: 37, y: 76, width: 316, height: 316 })) assert.ok(Math.abs(hero[key as keyof typeof hero] - expected) < 1e-6, key);
});

test('wide and tall images preserve their ratio; zero object-position stays at the edge', () => {
  const box = { x: 10, y: 20, width: 400, height: 300 };
  assert.deepEqual(imagePlane(box, 800, 400, 'contain', '0px 0px', 0), { x: 10, y: 20, width: 400, height: 200 });
  assert.deepEqual(imagePlane(box, 400, 800, 'contain', '50% 50%', 0), { x: 135, y: 20, width: 150, height: 300 });
});

test('horizontal gallery gestures work in both directions and mirror under RTL', () => {
  assert.equal(gallerySwipeStep(-100, 5, 390, 'ltr'), 1);
  assert.equal(gallerySwipeStep(100, 5, 390, 'ltr'), -1);
  assert.equal(gallerySwipeStep(-100, 5, 390, 'rtl'), -1);
  assert.equal(gallerySwipeStep(100, 5, 390, 'rtl'), 1);
});

test('a tap, small drift or a vertical/ambiguous gesture never changes the photo', () => {
  for (const [x, y] of [[0, 0], [12, 0], [8, 150], [90, 90]]) assert.equal(gallerySwipeStep(x, y, 390, 'ltr'), 0);
  assert.equal(gallerySwipeStep(70, 0, 1400, 'ltr'), -1, 'desktop swipe distance is capped');
});
