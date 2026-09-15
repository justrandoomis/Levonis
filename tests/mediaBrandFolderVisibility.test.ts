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
import { planLegacyMediaKey } from '../worker/lib/mediaMigration';

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

/**
 * THE SECOND HALF OF THE SAME BUG.
 *
 * Fixing `isAnonymousPublicMediaKey` made `UiUx/Logo/Logo.webp` public, and the
 * migration filed it in the public bucket — but `planLegacyMediaKey` still
 * asked `key.startsWith('UIUx/')`, exact case, in three separate places. So the
 * repository held two opinions about one file: the serving path called it the
 * site's logo, and the migration path reported `domain: 'support'` and
 * `action: 'manual_review'` — "I do not know what this is, a human should look
 * at it." `POST /api/admin/media/migration/apply` returns early on
 * `manual_review`, so the one rename this system exists to perform could never
 * run on the one file it exists for.
 *
 * These tests pin the agreement, not the implementation: whatever the serving
 * path decides about a key, the plan for that key must decide the same.
 */

test('every spelling of the brand folder plans the same as it serves', () => {
  for (const key of ['UiUx/Logo/Logo.webp', 'UIUx/Logo/Logo.webp', 'uiux/Logo/Logo.webp']) {
    const plan = planLegacyMediaKey(key, true);
    assert.equal(plan.visibility, 'public', `${key} must plan public`);
    assert.equal(
      plan.visibility,
      isAnonymousPublicMediaKey(key) ? 'public' : 'private',
      `${key}: the plan and the serving path must not disagree`
    );
    // 'support' is the map's fallback and means "unknown prefix". The brand
    // folder is not unknown, and a report that says so is a report nobody can
    // read.
    assert.equal(plan.domain, 'ui', `${key} must be reported as the ui domain`);
    // manual_review is what blocked the rename. Nothing about a .webp logo
    // needs a human.
    assert.equal(plan.action, 'copy', `${key} must be actionable, not parked`);
    assert.match(
      plan.destinationKey,
      /^ui\/levonis\/logo\/Logo_[0-9a-f]{8}\.webp$/,
      `${key} must rename into the canonical namespace`
    );
  }
});

test('the canonical namespace is never renamed into itself again', () => {
  // The rename may touch the LEGACY spelling only. `ui/levonis/*` is already
  // the output of this migration: renaming it again would file an
  // already-migrated object under `ui/levonis/legacy/`, and the apply endpoint
  // would rewrite the settings row to follow it — every re-run moving the logo
  // one directory deeper.
  for (const key of ['ui/levonis/logo/Logo_124973c2.webp', 'ui/levonis/icons/cart_fafe9ba3.png']) {
    const plan = planLegacyMediaKey(key, true);
    assert.equal(plan.destinationKey, key, `${key} is already canonical and must not move`);
    assert.equal(plan.visibility, 'public');
    assert.equal(plan.domain, 'ui');
  }
});

test('the case-insensitive folder is the brand folder and nothing next to it', () => {
  // The whole risk of a loose match is that it is loose about the wrong thing.
  // A near-miss prefix must NOT inherit the brand folder's public treatment.
  for (const key of ['uiuxx/Logo/Logo.webp', 'uix/Logo/Logo.webp', 'Users/usr_x/avatar/a.png']) {
    const plan = planLegacyMediaKey(key, true);
    assert.equal(plan.visibility, 'private', `${key} must stay private`);
    assert.equal(isAnonymousPublicMediaKey(key), false, `${key} must not serve anonymously`);
    assert.notEqual(plan.domain, 'ui', `${key} is not the brand folder`);
  }
  // And the exact user-scoped prefix still works, so the guard above is
  // pinning case-sensitivity rather than a broken path.
  assert.equal(planLegacyMediaKey('users/usr_x/avatar/a.png', true).visibility, 'public');
});
