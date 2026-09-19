/**
 * `immutable` IS A PROMISE. THIS FILE IS WHERE IT IS CHECKED.
 *
 * The defect these tests exist to prevent shipped once and was invisible for a
 * year's worth of cache, because the code carried a comment asserting the very
 * thing that was untrue: "Media keys are content-addressed, so a given URL's
 * bytes never change."
 *
 * True of every key the application mints — a SHA for imported gallery images,
 * `mintSiteMediaObject`'s per-upload token for admin uploads. False of the
 * brand folder, whose entire purpose is FIXED names the owner replaces in
 * place, so that every page and every stored reference keeps working without
 * an edit.
 *
 * What that cost, measured on the live site before the fix: the owner uploaded
 * a new logo to `UiUx/Logo/Logo.webp`, and every visitor kept receiving the old
 * one — `cf-cache-status: HIT`, `age: 45821`, a cached body of 70,084 bytes
 * against the 51,518 bytes actually in R2. `immutable` does not merely cache;
 * it instructs the browser and the edge never to ask again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { isRewritableMediaKey, isAnonymousPublicMediaKey } from '../worker/lib/mediaStorage';

const ROUTE = readFileSync(new URL('../worker/routes/uploads.ts', import.meta.url), 'utf8');

// ------------------------------------------------- which keys are rewritable

test('the brand folder is rewritable, in every spelling it has ever had', () => {
  // The folder has been written `ui/`, `UIUx/` and `UiUx/` across code, imports
  // and hand uploads — mediaStorage.ts documents that history at length. A
  // cache rule that matched only one of the three would pin the other two.
  for (const key of [
    'UiUx/Logo/Logo.webp',
    'UIUx/Logo/Logo.webp',
    'uiux/MainPage/Bundle.webp',
    'ui/MainPage/Compare.webp',
    'UiUx/MainPage/Warranty.webp',
  ]) {
    assert.equal(isRewritableMediaKey(key), true, key);
  }
  assert.equal(isRewritableMediaKey('brands/creality.webp'), true);
  assert.equal(isRewritableMediaKey('services/studio.webp'), true);
});

test('a key the application minted is NOT rewritable — its name carries its bytes', () => {
  // A content digest, and a per-upload token. Replacing either means a new
  // name, so the old URL's bytes really can never change and `immutable` is
  // honest for them. These are the majority of the catalogue's traffic, which
  // is why the fix is a branch and not a blanket shortening.
  for (const key of [
    'products/import/gallery/9f2a1c4e5b6d7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a.webp',
    'products/prd_abc123/gallery/logo-7f3a91.webp',
    'avatars/usr_123/avatar-9c2b.webp',
    'community/usr_9/post-11aa.webp',
    'merchants/usr_4/public/cover-3de1.webp',
  ]) {
    assert.equal(isRewritableMediaKey(key), false, key);
  }
});

test('every rewritable key is also a publicly servable one', () => {
  // The rewritable rule only matters on the branch that serves public media.
  // A key that is rewritable but not public would never reach it, which would
  // make this whole policy dead code without anything saying so.
  for (const key of ['UiUx/Logo/Logo.webp', 'brands/qidi.webp', 'services/tools.webp']) {
    assert.equal(isAnonymousPublicMediaKey(key), true, key);
  }
});

// ------------------------------------------------------ what the route emits

test('the route branches its Cache-Control on rewritability, and never promises immutable to a rewritable key', () => {
  // Source-text assertions rather than a rendered response, because what is
  // being guarded is the DECISION — a future edit that collapses the branch
  // back to one header is exactly the regression, and it would still return a
  // perfectly valid response.
  assert.match(ROUTE, /isRewritableMediaKey\(key\)/);
  assert.match(ROUTE, /public, max-age=300, must-revalidate/);
  assert.match(ROUTE, /public, max-age=31536000, immutable/);

  // The ternary must put the SHORT policy on the rewritable side. Asserting
  // both strings exist would pass with the arms swapped — which is the same
  // bug wearing the fix's clothes.
  const branch = /isRewritableMediaKey\(key\)\s*\?\s*'public, max-age=300, must-revalidate'\s*:\s*'public, max-age=31536000, immutable'/;
  assert.match(ROUTE.replace(/\s+/g, ' '), new RegExp(branch.source.replace(/\\s\*/g, ' *'), 's'));
});

test('the false premise is gone from the comment that made the defect invisible', () => {
  // The line "Media keys are content-addressed, so a given URL's bytes never
  // change" is what stopped anyone checking. A reader who trusts a comment is
  // reading the code as its author intended; the comment was wrong, so the
  // reader was too. It must not come back.
  assert.doesNotMatch(
    ROUTE,
    /Media keys are content-addressed, so a given URL's bytes never change/,
    'the premise that was false for the brand folder has returned'
  );
});

test('the private branch is untouched — this change is about public media only', () => {
  assert.match(ROUTE, /private, max-age=300/);
});
