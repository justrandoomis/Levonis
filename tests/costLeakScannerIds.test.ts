/**
 * The cost-leak scanner and generated ids (costlyProduct.ts). A random id can
 * spell a four-digit sentinel (COST.optionAdjust = 6,333) by chance; that made
 * costRoleMatrix fail about once in a few full runs on a policy id. The scanner
 * now skips a string that is exactly a generated id, and only that.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { COST, isGeneratedId, leaks } from './fixtures/costlyProduct';

const D = String(COST.optionAdjust); // '6333'

test('a generated id that happens to spell a sentinel is not a leak', () => {
  assert.deepEqual(leaks({ id: `pol_3f${D}abcdef01234567` }), []);
  assert.deepEqual(leaks({ id: `ORD-${D}ABCDEF` }), []);
  assert.deepEqual(leaks({ id: `0f${D}ab-1234-4abc-8def-0123456789ab` }), []);
  assert.deepEqual(leaks({ id: `3f${D}abcdef01234567aa` }), []);
});

test('the same digits anywhere else are still a leak', () => {
  assert.notDeepEqual(leaks({ note: `cost ${D} IQD` }), []);
  assert.notDeepEqual(leaks({ csv: `x;${D};y` }), []);
  assert.notDeepEqual(leaks({ text: `pol_3f${D}abcdef01234567 ${D}` }), [], 'an id followed by text is not an id');
  assert.notDeepEqual(leaks({ id: `p_${D}` }), [], 'too short to be a generated id');
  assert.notDeepEqual(leaks({ n: COST.optionAdjust }), [], 'the number itself');
});

test('isGeneratedId needs a hex letter, so an all-digit string is always scanned', () => {
  assert.equal(isGeneratedId('12345678901234567890'), false);
  assert.equal(isGeneratedId(`pol_${'1'.repeat(19)}a`), true);
  assert.equal(isGeneratedId('Sara'), false);
});
