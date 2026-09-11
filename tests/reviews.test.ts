/**
 * Unit tests for review helpers (worker/routes/reviews.ts).
 * Run: npm run test:unit
 * Pins mandate §5 privacy semantics: the public reviewer name is always
 * masked and never leaks a full identity or email-like username.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskName } from '../worker/routes/reviews';

test('two-part names keep first name + initial only', () => {
  assert.equal(maskName('Ahmed Kareem', null), 'Ahmed K.');
  assert.equal(maskName('احمد كريم حسن', null), 'احمد ك.');
});

test('single-token names are truncated, never shown in full', () => {
  const masked = maskName('AbdulrahmanX', null);
  assert.equal(masked, 'Ab***');
  assert.ok(!masked.includes('AbdulrahmanX'));
});

test('falls back to username when name is empty, still masked', () => {
  assert.equal(maskName('', 'coolprinter99'), 'co***');
  assert.equal(maskName(null, 'coolprinter99'), 'co***');
});

test('empty identity gets a neutral placeholder', () => {
  assert.equal(maskName('', ''), 'Levonis');
  assert.equal(maskName(null, null), 'Levonis');
});

test('very short single names pass through (nothing to leak)', () => {
  assert.equal(maskName('Al', null), 'Al');
});
