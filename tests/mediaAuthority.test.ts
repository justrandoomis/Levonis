/**
 * ONE AUTHORITATIVE STORE FOR A PRODUCT'S MEDIA, AND ONE HONEST LOOKUP FOR A
 * REVIEW'S.
 *
 * Both of these came out of a media-architecture audit, and both are the same
 * shape of defect: a rule that reads as if it holds and does not.
 *
 * ---------------------------------------------------------------------------
 * 1. The product mirror
 * ---------------------------------------------------------------------------
 * `product_images` (migration 0018) is authoritative; `products.images` is a
 * derived mirror of it. `productOverlay` makes the rows win on read whenever
 * a product has any. `productPersistence` restates both in one batch, and its
 * own comment calls the JSON column "a derived artefact, never a
 * caller-supplied field".
 *
 * The legacy `POST /api/admin/products` writes the mirror column directly and
 * contains no statement touching `product_images`. On a product that has rows,
 * a save there rewrites the copy nobody reads and leaves the rows everybody
 * reads alone: the admin's change is accepted, the storefront keeps the old
 * pictures, and the two stores are apart for good — silently.
 *
 * ---------------------------------------------------------------------------
 * 2. The review media lookup
 * ---------------------------------------------------------------------------
 * `GET /api/reviews/media/*` decided whether a key belongs to a PUBLISHED
 * review with `media LIKE '%"key"%'`, guarded by a charset comment promising
 * "no %/_ wildcards can widen the match" — while `_`, a LIKE wildcard, sat
 * inside that very character class.
 *
 * Nothing was reachable through it: ids are hex, no stored key contains `_`,
 * so a widened match could only agree with a key R2 does not have. But the
 * guard was wrong for an incidental reason, which is a guard waiting for the
 * key format to change. It also matched the key anywhere in the row rather
 * than in the field that means "key".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

/**
 * Prose about a rule is not the rule — so comments come out before anything is
 * asserted on.
 *
 * THE STRIPPER IS NAIVE, AND ONE ROUTE IN THIS FILE IS WHY THAT MATTERS.
 * `reviewRoutes.get('/media/*', …)` contains a slash-star INSIDE A STRING, and
 * a regex that pairs `/*` with the next `*\/` reads it as a comment opener —
 * swallowing every line from the route's own registration to the next comment
 * terminator, which is exactly the code these tests exist to check. The same
 * landmine is documented in worker/index.ts around its '/api/admin/*' mount.
 *
 * `slice` therefore cuts the region out of the RAW source first and strips
 * comments from that, so a mount string can never delete the thing under it.
 */
/**
 * Comments removed, WITHOUT treating a slash-star inside a string literal as a
 * comment opener.
 *
 * The naive regex — pair `/*` with the next `*` `/` — is the idiom elsewhere in
 * this repository and it is wrong in exactly one situation, which this file
 * runs into twice: a route registered at `'/media/*'` or `'/api/admin/*'`
 * carries a slash-star INSIDE A STRING, so the stripper opens a comment there
 * and deletes everything up to the next terminator — which is the code the
 * test was about to assert on. worker/index.ts documents the same trap, and
 * its rule is "line comments only below this point"; a scanner that knows what
 * a string is removes the need for that rule here.
 *
 * Small on purpose: quotes, template literals, escapes, and the two comment
 * forms. It is not a JavaScript parser and does not need to be.
 */
function stripComments(source: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      out += ch;
      if (ch === '\\') { out += source[++i] ?? ''; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; continue; }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/** A whole file, as rules rather than prose. */
const code = (p: string) => stripComments(read(p));

/** One region of a file, cut from the raw source and then stripped. */
const slice = (p: string, from: string, to?: string) => {
  const source = read(p);
  const start = source.indexOf(from);
  assert.ok(start >= 0, `${from} not found in ${p}`);
  const rest = source.slice(start);
  const end = to ? rest.indexOf(to, from.length) : -1;
  return stripComments(end > 0 ? rest.slice(0, end) : rest);
};

// --------------------------------------------------- the product mirror

test('the legacy admin route refuses a structural save that would diverge', () => {
  const admin = code('worker/routes/admin.ts');
  const handler = admin.slice(admin.indexOf("adminRoutes.post('/products'"));
  assert.ok(handler.length > 500, 'the legacy product handler should be findable');

  // It asks whether the product has relation rows…
  assert.match(handler, /SELECT COUNT\(\*\) AS n FROM product_images WHERE product_id = \?/);
  // …only when the body actually carries structure — a price-only save on a
  // product with rows is fine and must keep working.
  assert.match(handler, /STRUCTURE_FIELDS = \['images', 'options', 'colors'\]/);
  assert.match(handler, /STRUCTURE_FIELDS\.some\(\(field\) => body\[field\] !== undefined\)/);
  // …and refuses with a code and a route that CAN do it, rather than a 500 or
  // a silent success.
  assert.match(handler, /409,/);
  assert.match(handler, /STRUCTURE_HAS_RELATIONS/);
  assert.match(handler, /products-v2/, 'the refusal must name the route that writes both');

  // The check comes BEFORE the write, which is the only place it means anything.
  assert.ok(
    handler.indexOf('STRUCTURE_HAS_RELATIONS') < handler.indexOf('INSERT INTO products'),
    'the guard must precede the upsert'
  );
});

test('this route still has no writer for the authoritative table', () => {
  // The refusal above is only correct while that stays true. If this route
  // ever learns to write product_images, the guard becomes wrong instead of
  // protective, and this test is where that gets noticed.
  const admin = code('worker/routes/admin.ts');
  assert.ok(
    !/INSERT INTO product_images|UPDATE product_images|DELETE FROM product_images/.test(admin),
    'admin.ts must not write the relation rows — that is productPersistence.ts'
  );
});

test('the read side still prefers the rows over the mirror', () => {
  // The whole reason the divergence matters. If this inverted, a stale mirror
  // would become the thing customers see.
  const overlay = code('worker/lib/productOverlay.ts');
  assert.match(
    overlay,
    /view\.images\.length > 0\s*\n?\s*\? view\.images/,
    'relation rows must win whenever a product has any'
  );
});

test('the lead image is chosen by one rule, in one place', () => {
  // Owner mandate §J: one authoritative primary image, resolved identically
  // everywhere. `primaryMediaFirst` is that rule; a second sort order
  // appearing beside it is how the cards and the page start disagreeing.
  const model = code('worker/lib/productModel.ts');
  assert.match(model, /export function primaryMediaFirst/);
  assert.match(model, /export function primaryMedia/);
  assert.match(model, /Number\(!!b\.item\.primary\) - Number\(!!a\.item\.primary\)/);
  // Every surface that needs a lead image goes through it rather than taking
  // images[0] — including the share card added for product links.
  for (const file of [
    'worker/lib/productSelectionImage.ts',
    'worker/lib/socialPreview.ts',
  ]) {
    assert.match(code(file), /primaryMedia(First)?\(/, `${file} must use the shared resolver`);
  }
});

// ------------------------------------------------ the review media lookup

test('a review media key is matched exactly, not as a LIKE pattern', () => {
  const handler = slice('worker/routes/reviews.ts', "reviewRoutes.get('/media", 'reviewRoutes.');
  assert.ok(handler.length > 500, 'the media handler should be findable');

  // No LIKE anywhere in this handler — that is the whole point.
  assert.ok(!/\bLIKE\b/.test(handler), 'the published-review check must not use LIKE');
  assert.ok(!handler.includes('%"'), 'nor build a pattern by string interpolation');

  // It asks the real question: is this the `key` field of an item of a
  // published review's media array?
  assert.match(handler, /json_each\(reviews\.media\)/);
  assert.match(handler, /json_extract\(m\.value, '\$\.key'\) = \?/);
  assert.match(handler, /status = 'published'/, 'and only a published review makes it public');
  assert.match(handler, /\.bind\(key\)/, 'the key is bound, never interpolated');
});

test('the charset guard no longer claims to do the LIKE\'s job', () => {
  /**
   * The comment promised "no %/_ wildcards can widen the match" while `_` — a
   * LIKE wildcard — sat in the character class it was describing. A comment
   * that is wrong about a security guard is worse than no comment, because
   * the next reader trusts it and stops looking.
   *
   * The phrase is still in the file ON PURPOSE, as the history of why the
   * query changed. What must never come back is the CLAIM: the guard standing
   * next to a LIKE and asserting it keeps that LIKE literal. So this checks
   * the pairing, not the words.
   */
  const source = read('worker/routes/reviews.ts');
  assert.match(source, /THE CHARSET IS NOT WHAT KEEPS THE LOOKUP HONEST/, 'the correction must stay with the rule');
  const handler = slice('worker/routes/reviews.ts', "reviewRoutes.get('/media", 'reviewRoutes.');
  assert.ok(!/\bLIKE\b/.test(handler), 'no LIKE for the charset comment to make a promise about');
  // And the guard is still a guard: it is a path sanity check and it still
  // refuses traversal, which is the part that was always doing real work.
  assert.match(handler, /\/\^\[A-Za-z0-9\/\._-\]\+\$\/\.test\(key\)/, 'the path sanity check itself stays');
  assert.match(handler, /key\.includes\('\.\.'\)/, 'including the traversal refusal');
});

test('private review evidence is never made public by this route', () => {
  // The published-review branch is for `reviews/` only. `reviews-evidence/` is
  // the seller-dispute material and has no public path at all.
  const evidence = slice('worker/routes/reviews.ts', "key.startsWith('reviews-evidence/')", "key.startsWith('reviews/')");
  assert.ok(evidence.length > 40, 'the evidence branch should be findable');
  assert.ok(!/json_each|published/.test(evidence), 'evidence must never be resolved by publication');
  assert.match(evidence, /if \(!user\) throw notFound\(\)/, 'and is refused outright when signed out');
});

// ------------------------------------------- the cache and a revoked permission

test('a revocable permission is never cached as if it were permanent', () => {
  /**
   * `isPublic` on the review-media route is not a property of the object. It
   * is the answer to a question asked of the database on that request — "is
   * this key an item of a PUBLISHED review's media?" — and the answer changes:
   * a review gets moderated, an author retracts it, an admin unpublishes a
   * product's reviews. The object does not move; the permission does.
   *
   * The response said `public, max-age=3600`, which tells every shared cache
   * and every browser to serve the photo for an hour WITHOUT asking again. For
   * that hour an unpublished review's media stayed readable by anyone holding
   * the URL, and nothing in the unpublish path could reach into those caches.
   *
   * `no-cache` is the right instruction and is NOT `no-store`: caches may keep
   * the bytes, they may not serve them without revalidating. The ETag makes
   * that revalidation a 304, so almost all of the bandwidth saving survives.
   */
  const handler = slice('worker/routes/reviews.ts', "reviewRoutes.get('/media", 'reviewRoutes.');
  assert.ok(handler.length > 500, 'the media handler should be findable');
  assert.ok(!/max-age=\d+/.test(handler), 'a fixed lifetime outlives the permission it was granted under');
  assert.match(handler, /isPublic \? 'public, no-cache' : 'private, no-cache'/);
  // Dispute evidence is not cached at all, revalidated or otherwise.
  assert.match(handler, /key\.startsWith\('reviews-evidence\/'\) \? 'no-store'/);

  // …and the revalidation it asks for is answered, or `no-cache` would turn
  // every hit into a full re-download.
  assert.match(handler, /headers\.set\('etag', obj\.httpEtag\)/);
  assert.match(handler, /c\.req\.header\('If-None-Match'\) === obj\.httpEtag/);
  assert.match(handler, /new Response\(null, \{ status: 304, headers \}\)/);

  // The 304 must come AFTER the authorisation, or it becomes a way to learn
  // that an object exists without being allowed to see it.
  assert.ok(
    handler.indexOf('if (!allowed) throw notFound();') < handler.indexOf('If-None-Match'),
    'the conditional check must not precede the permission check'
  );
});
