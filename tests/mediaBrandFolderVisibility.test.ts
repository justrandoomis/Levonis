/**
 * THE SITE'S OWN LOGO MUST BE FETCHABLE BY SOMEONE WHO IS NOT SIGNED IN.
 *
 * `isAnonymousPublicMediaKey` matched the brand folder as `ui/` and `UIUx/`,
 * exactly. The real object in the live bucket is `UiUx/Logo/Logo.webp` —
 * lowercase `i` — so the match failed, the key was classified PRIVATE, and the
 * first media migration filed the shop's logo in the private bucket. It copied
 * and verified perfectly; it was simply put somewhere an anonymous visitor
 * cannot reach. A brand asset only signed-in users can load is not a private
 * asset, it is a broken one.
 *
 * The folder is matched case-insensitively HERE AND NOWHERE ELSE, because it
 * holds fixed brand files an admin controls and never user content. The
 * user-scoped prefixes stay exact, and this file pins that difference: loosening
 * `users/` the same way would be a route to someone's data via a capital letter.
 *
 * Run: npx tsx --test tests/mediaBrandFolderVisibility.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAnonymousPublicMediaKey, isSafeMediaKey } from '../worker/lib/mediaStorage';

test('the brand folder is public however it was capitalised', () => {
  for (const key of [
    'UiUx/Logo/Logo.webp', // the real object, and the one that regressed
    'UIUx/Logo/Logo.webp',
    'ui/Logo/Logo.webp',
    'UI/Logo/Logo.webp',
    'uiux/logo.png',
  ]) {
    assert.equal(isAnonymousPublicMediaKey(key), true, `${key} must be publicly fetchable`);
  }
});

test('a folder that merely STARTS like the brand folder is not swept in', () => {
  for (const key of ['uix/a.png', 'uiuxy/a.png', 'ui-private/a.png', 'users/u1/a.png']) {
    assert.equal(isAnonymousPublicMediaKey(key), false, `${key} must NOT be public`);
  }
});

test('the user-scoped prefixes stay CASE-SENSITIVE', () => {
  // The whole point of the narrow fix. `users/<id>/avatar/` is public by an
  // exact rule; `Users/` is not that rule and must not be treated as it, or a
  // capital letter becomes a way to ask for someone else's private object.
  assert.equal(isAnonymousPublicMediaKey('users/u1/avatar/a.png'), true);
  assert.equal(isAnonymousPublicMediaKey('Users/u1/avatar/a.png'), false);
  assert.equal(isAnonymousPublicMediaKey('merchants/m1/logos/a.png'), true);
  assert.equal(isAnonymousPublicMediaKey('Merchants/m1/logos/a.png'), false);
  assert.equal(isAnonymousPublicMediaKey('PRODUCTS/p1/a.png'), false, 'products/ is exact too');
});

test('customer media is private whatever its case', () => {
  for (const key of [
    'chat/usr_7eeadbc88ab04da7856d/a4af69669be943e0ada9.jpg',
    'receipts/usr_04834acf6e1e4bf1bd6f/3994c9ee34f64aa9a2c4.png',
    'reviews/usr_934b7beb1ff24ce2b6b6/076352db43a044859fff.mp4',
    'reviews-evidence/usr_d73ea9434cef45ef88a0/4fa9aed6bfa741c986ae.png',
    'kyc/usr_1/id.png',
  ]) {
    assert.equal(isAnonymousPublicMediaKey(key), false, `${key} is customer data and must stay private`);
  }
});

test('an unsafe key is never public, whatever it is named', () => {
  // isAnonymousPublicMediaKey gates on isSafeMediaKey first, so a traversal
  // dressed as a brand path cannot be talked into the public bucket.
  for (const key of ['UiUx/../users/u1/secret.png', '/UiUx/Logo.webp', 'UiUx/Logo%2E.webp', 'UiUx//Logo.webp']) {
    assert.equal(isSafeMediaKey(key), false, `${key} must be refused as unsafe`);
    assert.equal(isAnonymousPublicMediaKey(key), false, `${key} must never be public`);
  }
});
