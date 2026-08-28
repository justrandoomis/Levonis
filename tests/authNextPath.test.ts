import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeNextPath } from '../src/components/auth/nextPath';

test('same-origin relative paths pass through unchanged', () => {
  assert.equal(sanitizeNextPath('/cart'), '/cart');
  assert.equal(sanitizeNextPath('/product/abc-123?x=1#top'), '/product/abc-123?x=1#top');
  assert.equal(sanitizeNextPath('/orders?status=pending'), '/orders?status=pending');
  assert.equal(sanitizeNextPath('/'), '/');
});

test('non-strings, empty and oversized values fall back to /', () => {
  assert.equal(sanitizeNextPath(undefined), '/');
  assert.equal(sanitizeNextPath(null), '/');
  assert.equal(sanitizeNextPath(42), '/');
  assert.equal(sanitizeNextPath(''), '/');
  assert.equal(sanitizeNextPath('   '), '/');
  assert.equal(sanitizeNextPath('/' + 'a'.repeat(2000)), '/');
});

test('open-redirect shapes are rejected', () => {
  assert.equal(sanitizeNextPath('//evil.com'), '/');
  assert.equal(sanitizeNextPath('//evil.com/path'), '/');
  assert.equal(sanitizeNextPath('https://evil.com'), '/');
  assert.equal(sanitizeNextPath('http://evil.com'), '/');
  assert.equal(sanitizeNextPath('javascript:alert(1)'), '/');
  assert.equal(sanitizeNextPath('\\\\evil.com'), '/');
  assert.equal(sanitizeNextPath('/\\evil.com'), '/'); // browsers normalize \ to /
  assert.equal(sanitizeNextPath('/a\\b'), '/');
  assert.equal(sanitizeNextPath('evil.com'), '/');
});

test('control characters are rejected', () => {
  assert.equal(sanitizeNextPath('/a\nb'), '/');
  assert.equal(sanitizeNextPath('/a\tb'), '/');
  assert.equal(sanitizeNextPath('/a\u0000b'), '/');
});

test('never bounces back into /auth itself', () => {
  assert.equal(sanitizeNextPath('/auth'), '/');
  assert.equal(sanitizeNextPath('/auth/'), '/');
  assert.equal(sanitizeNextPath('/auth?reset=x'), '/');
  // …but legitimate paths that merely start with the letters still pass.
  assert.equal(sanitizeNextPath('/authors'), '/authors');
});

test('location-like objects from ProtectedRoute state work', () => {
  assert.equal(sanitizeNextPath({ pathname: '/orders', search: '?f=1', hash: '' }), '/orders?f=1');
  assert.equal(sanitizeNextPath({ pathname: '/cart', search: '', hash: '#items' }), '/cart#items');
  assert.equal(sanitizeNextPath({ pathname: '//evil.com' }), '/');
  assert.equal(sanitizeNextPath({ pathname: 42 }), '/');
  assert.equal(sanitizeNextPath({}), '/');
});
