/**
 * The gift levels — pins that belong to the GIFT routes (worker/routes/gifts.ts,
 * lane S2). Moved verbatim out of tests/reviewQuality.test.ts when the gift
 * routes left worker/routes/reviews.ts, so the reviews lane and the gifts lane
 * never edit one test file. Lane S2 replaces this pin when the levels become
 * real store products (docs/REVIEWS_GIFTS.md §Levels).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEVEL_COMPOSITION } from '../worker/routes/gifts';

test('the five established gift levels and their contents remain unchanged', () => {
  assert.deepEqual(Object.keys(LEVEL_COMPOSITION), ['1', '2', '3', '4', '5']);
  assert.deepEqual(LEVEL_COMPOSITION, {
    1: ['accessory'],
    2: ['filament'],
    3: ['filament', 'accessory'],
    4: ['nozzle'],
    5: ['nozzle', 'plate'],
  });
});
