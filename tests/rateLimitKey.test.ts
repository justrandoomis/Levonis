/**
 * Which bucket a request counts against.
 *
 * Sign-in used to be limited per IP only, so a password guess spread across
 * many addresses was never limited at all for the one account it targeted.
 * The account-side bucket is keyed on a hash of the identifier — the
 * rate_limits table must not become a list of who tried to sign in — and is
 * applied to every identifier alike, so the limit says nothing about which
 * accounts exist.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identifierKey, rateLimitKey } from '../worker/lib/ratelimit';

test('an explicit key wins over user and IP', () => {
  assert.equal(rateLimitKey('login-id', 'u1', '1.2.3.4', 'abc'), 'login-id:k:abc');
});

test('a signed-in user is keyed by id, an anonymous one by IP', () => {
  assert.equal(rateLimitKey('upload', 'u1', '1.2.3.4'), 'upload:u:u1');
  assert.equal(rateLimitKey('login', null, '1.2.3.4'), 'login:1.2.3.4');
});

test('the identifier key ignores case and surrounding whitespace', async () => {
  const a = await identifierKey('Ali@Example.com');
  assert.equal(a, await identifierKey('  ali@example.com '));
  assert.equal(a, await identifierKey('ALI@EXAMPLE.COM'));
});

test('the identifier key is a hash — it names nobody, and differs per account', async () => {
  const a = await identifierKey('ali@example.com');
  const b = await identifierKey('ali2@example.com');
  assert.notEqual(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.ok(!a.includes('ali'), 'the raw identifier is not in the key');
});
