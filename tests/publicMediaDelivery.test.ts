/**
 * WHAT MAY BE CACHED AT THE EDGE, AND WHAT MAY NOT.
 *
 * Two changes made storefront images cheap, and both sit on an authorisation
 * boundary, so both are pinned here rather than trusted to a reading:
 *
 *   1. `/files/*` now participates in `caches.default`. That cache is SHARED by
 *      every visitor to the colo, so writing a private object into it would
 *      hand one customer's receipt or chat attachment to anyone who guessed the
 *      URL. Only anonymous-public keys are ever matched or written.
 *   2. `worker/index.ts` skips `loadSessionUser` — a D1 JOIN — for public file
 *      requests. It ran on '*' before, so a signed-in shopper paid one database
 *      read per image tile. The skip uses the SAME predicate the handler
 *      authorises with, so a key the predicate does not recognise still loads
 *      the session and still meets the handler's own check.
 *
 * `isAnonymousPublicMediaKey` is therefore load-bearing twice over, and the
 * first test is the one that matters: if it ever said yes to a private prefix,
 * both changes would leak at once.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { isAnonymousPublicMediaKey } from '../worker/lib/mediaStorage';

test('the predicate that gates caching never admits a private prefix', () => {
  for (const key of [
    'receipts/u1/invoice-123.pdf',
    'chat/u1/photo.webp',
    'kyc/u1/id-front.webp',
    'evidence/o1/damage.webp',
    'warranty/u1/claim.pdf',
    'support/u1/attachment.webp',
    'requests/u1/model.stl',
    'private/anything.webp',
  ]) {
    assert.equal(isAnonymousPublicMediaKey(key), false, `${key} would be cached at a shared edge`);
  }
});

test('the storefront prefixes a card actually serves are recognised as public', () => {
  for (const key of [
    'products/p1/main.webp',
    'merchants/m1/public/banner.webp',
    'merchants/m1/logos/logo.webp',
    'users/u1/avatar/me.webp',
    'community/post-1.webp',
    'brands/bambu.webp',
    'ui/levonis/icons/cart.svg',
  ]) {
    assert.equal(isAnonymousPublicMediaKey(key), true, `${key} is a storefront asset and should be cacheable`);
  }
});

test('traversal and absolute keys are refused before either optimisation sees them', () => {
  for (const key of ['../receipts/u1/x.pdf', 'products/../receipts/u1/x.pdf', '/products/p1.webp', '']) {
    assert.equal(isAnonymousPublicMediaKey(key), false, `${JSON.stringify(key)} escaped the safety check`);
  }
});

test('only the public branch reads from or writes to the shared edge cache', () => {
  const src = readFileSync(join(ROOT, 'worker/routes/uploads.ts'), 'utf8');
  // The match is guarded on publicPrefix — and on the cache existing at all,
  // because `caches` is absent in the Node runtime these route tests use.
  // (A `Range` request additionally bypasses the cache in both directions: a
  // stored full body must not answer a byte range, nor a partial body be
  // stored as the file — tests/fileRangeDelivery.test.ts.)
  assert.ok(
    /if \(publicPrefix && cache(?: && !rangeHeader)?\) \{\s*const hit = await cache\.match\((?:c\.req\.raw|edgeCacheKey\(c\.req\.raw, key\))\);/.test(src),
    'cache.match is not gated on publicPrefix'
  );
  // So is the write.
  const putIdx = src.indexOf('cache.put(');
  assert.ok(putIdx > 0, 'the response is never written to the edge cache');
  const before = src.slice(Math.max(0, putIdx - 600), putIdx);
  assert.ok(before.includes('if (publicPrefix && cache'), 'cache.put is not gated on publicPrefix');
  // A private object keeps its private, short-lived header.
  assert.ok(
    src.includes("headers.set('Cache-Control', 'private, max-age=300');"),
    'the private branch lost its Cache-Control'
  );
  // A public object is immutable ONLY where the key really is content-addressed.
  //
  // THIS ASSERTION USED TO PIN THE DEFECT. It required the single unconditional
  // line `Cache-Control: public, max-age=31536000, immutable`, on the stated
  // premise that "media keys are content-addressed" — true of every key the
  // application mints, false of the brand folder, whose whole purpose is fixed
  // names the owner replaces in place. So a replaced logo stayed old on every
  // screen, and this test certified it: `cf-cache-status: HIT`, `age: 45821`,
  // a cached body of 70,084 bytes against the 51,518 actually in R2.
  //
  // What is guarded now is that the public branch still sets its header
  // EXPLICITLY here rather than inheriting R2's stored metadata (the original
  // and still-correct point of this line), and that it does so through the
  // rewritability branch. tests/mediaCachePolicy.test.ts owns which arm gets
  // which policy, and that the arms are not swapped.
  assert.ok(
    src.includes("'public, max-age=31536000, immutable'"),
    'the public branch no longer names an immutable policy for minted keys'
  );
  assert.ok(
    src.includes('isRewritableMediaKey(key)'),
    'the public branch promises immutable without asking whether the key can be rewritten'
  );
});

test('a revalidation costs a header, not a body', () => {
  const src = readFileSync(join(ROOT, 'worker/routes/uploads.ts'), 'utf8');
  assert.ok(
    src.includes("if (c.req.header('If-None-Match') === obj.httpEtag)"),
    'If-None-Match is still ignored, so every revalidation streams the whole object'
  );
  assert.ok(src.includes('status: 304'), 'no 304 is ever returned');
});

test('the session lookup is skipped for public files using the same predicate that authorises them', () => {
  const src = readFileSync(join(ROOT, 'worker/index.ts'), 'utf8');
  assert.ok(
    src.includes("import { isAnonymousPublicMediaKey } from './lib/mediaStorage';"),
    'index.ts invented its own idea of what is public'
  );
  assert.ok(
    /path\.startsWith\('\/files\/'\) && isAnonymousPublicMediaKey\(path\.slice\('\/files\/'\.length\)\)/.test(src),
    'the skip is not gated on the shared predicate'
  );
  // The session must still load for everything else, including private files.
  const i = src.indexOf('await loadSessionUser(c);');
  assert.ok(i > 0, 'loadSessionUser was removed entirely');
});

test('the edge cache is an optional capability, not an assumption', () => {
  // `caches` is a Workers global and is simply not defined in the Node runtime
  // the route tests run under. Referencing it unguarded threw a ReferenceError
  // before R2 was ever reached — the whole /files route 500'd. A runtime
  // without the Cache API must behave exactly as it did before this change.
  const src = readFileSync(join(ROOT, 'worker/routes/uploads.ts'), 'utf8');
  assert.ok(
    src.includes("typeof caches !== 'undefined'"),
    '`caches` is referenced without checking that the runtime has it'
  );
  assert.ok(
    /try \{\s*c\.executionCtx\.waitUntil\(cache\.put\(/.test(src),
    'executionCtx.waitUntil is not guarded; a missing execution context would fail a complete response'
  );
});
