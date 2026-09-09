import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ApiError } from '../src/lib/api';
import { classifyError } from '../src/components/ui/AsyncStates';

// The unified async-state system must NEVER conflate states:
// 401 is a sign-in prompt (not "no items"), 404 is not-found (not an error
// toast), 5xx/network are retryable errors (not "product not found").

test('401 classifies as unauthorized — never rendered as an empty list', () => {
  assert.equal(classifyError(new ApiError(401, 'Unauthorized')), 'unauthorized');
});

test('404 classifies as not-found', () => {
  assert.equal(classifyError(new ApiError(404, 'Not found')), 'not-found');
});

test('403 classifies as forbidden, distinct from unauthorized', () => {
  assert.equal(classifyError(new ApiError(403, 'Forbidden')), 'forbidden');
});

test('status 0 (fetch failure wrapped by the api client) is a network error', () => {
  assert.equal(classifyError(new ApiError(0, 'Network error')), 'network');
});

test('5xx classify as server errors (retryable), including 503 not-configured', () => {
  assert.equal(classifyError(new ApiError(500, 'Internal')), 'server');
  assert.equal(classifyError(new ApiError(502, 'Bad gateway')), 'server');
  assert.equal(classifyError(new ApiError(503, 'Not configured')), 'server');
});

test('other 4xx are generic errors that surface the server message', () => {
  assert.equal(classifyError(new ApiError(400, 'Invalid input')), 'error');
  assert.equal(classifyError(new ApiError(422, 'Unprocessable')), 'error');
  assert.equal(classifyError(new ApiError(429, 'Too many requests')), 'error');
});

test('raw fetch TypeErrors classify as network failures', () => {
  assert.equal(classifyError(new TypeError('Failed to fetch')), 'network');
});

test('unknown throwables fall back to a generic error, never a crash', () => {
  assert.equal(classifyError(new Error('boom')), 'error');
  assert.equal(classifyError('string throw'), 'error');
  assert.equal(classifyError(undefined), 'error');
  assert.equal(classifyError(null), 'error');
});

/**
 * THE PAGES THAT MUST USE THIS SYSTEM RATHER THAN THEIR OWN.
 *
 * `classifyError` above proves the mapping; these prove it is REACHED. The
 * bundles pages replaced a hand-rolled `animate-spin` div and a red error
 * paragraph — markup that renders a 401 as "no bundles" and a 404 as a red
 * error box, which is precisely the conflation the rest of this file forbids.
 * A source assertion is the honest test here: there is no DOM in this suite,
 * and the failure mode is a page reintroducing its own states, not a function
 * returning the wrong string.
 */
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('the bundles pages render AsyncStates and skeletons, never a hand-rolled spinner or error div', () => {
  for (const page of ['src/pages/Bundles.tsx', 'src/pages/BundleDetail.tsx']) {
    const src = source(page);
    assert.match(src, /from '\.\.\/components\/ui\/AsyncStates'/, `${page} does not use AsyncStates`);
    assert.match(src, /<ErrorState\b/, `${page} does not render ErrorState`);
    assert.match(src, /from '\.\.\/components\/ui\/Skeleton'/, `${page} does not use the shared skeletons`);
    assert.equal(
      /animate-spin/.test(src),
      false,
      `${page} still hand-rolls a spinner instead of using a skeleton or Spinner`
    );
    assert.equal(
      /text-red-400/.test(src),
      false,
      `${page} still hand-rolls an error paragraph instead of ErrorState`
    );
  }
});

test('the bundles grid renders an EmptyState for "no matches" — never for a failed fetch', () => {
  const src = source('src/pages/Bundles.tsx');
  assert.match(src, /<EmptyState\b/);
  // The error branch must be tested BEFORE the empty branch, or a network
  // failure renders as "no bundles match".
  assert.ok(
    src.indexOf('<ErrorState') < src.indexOf('<EmptyState'),
    'the empty state is checked before the error state, so a failed fetch reads as "no bundles"'
  );
});

test('the bundle detail carries a sign-in return path, so a 401 lands back on the offer', () => {
  assert.match(source('src/pages/BundleDetail.tsx'), /next=\{`\/bundles\/\$\{slug\}`\}/);
});
