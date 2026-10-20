/**
 * A MODEL LINK'S PICTURE — the link card's own copy, never a hot-link.
 *
 * A customer very often has no file, only a link: "print me this one". The
 * resolver reads the page's own JSON API and comes back with a name, a
 * creator and cover images. The owner's first rule was «البيانات فقط، والصورة
 * بالرابط»: store the cover's address and draw it from the source's CDN. Row
 * 173 (link cards) superseded it — a reader's browser is never sent to the
 * pasted host, and a picture is ours or nothing — and R13 (Community V3)
 * aligns the request with it:
 *
 *   - `sanitizeSourceMeta` keeps an `image_url` ONLY when it is the link
 *     card's re-hosted copy (`/files/link-cards/<id>.webp`); any other
 *     address — the old https hot-link included — is dropped, on write and
 *     on read (a legacy row's stored address never reaches a screen);
 *   - this route still never downloads or re-hosts a cover itself: the link
 *     card resolver (worker/lib/linkCards.ts) is the one door that fetches;
 *   - the provider resolver still never scrapes, still refuses a non-https
 *     image, and now reads its JSON under a byte ceiling.
 *
 * Run: npx tsx --test tests/externalModelCover.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const ROUTE = 'worker/routes/printRequests.ts';
const RESOLVER = 'worker/lib/externalModels.ts';

test('it is a link and never a copy', () => {
  const route = read(ROUTE);
  // A re-host would mean an upload call on this path. There is none, and the
  // absence is the feature.
  assert.doesNotMatch(route, /ingestRemoteImage|putMediaObject\([^)]*image_url/);
  assert.match(route, /THE PICTURE IS NEVER HOT-LINKED \(docs\/DECISIONS\.md row 173/, 'and the reason is written where the rule lives');
});

test('only the link card copy is stored as the picture, and the blob is typed rather than free-form', () => {
  const route = read(ROUTE);
  assert.match(route, /function sanitizeSourceMeta/);
  assert.match(route, /const sourceMeta = sanitizeSourceMeta\(body\.source_meta\);/);
  // The old contract — store whatever object arrived — is the thing being
  // replaced, and it must not come back: every field here is read back and
  // shown on a merchant's screen.
  assert.doesNotMatch(route, /typeof body\.source_meta === 'object' \? body\.source_meta : \{\}/);
  const fn = route.slice(route.indexOf('function sanitizeSourceMeta'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  for (const key of ['provider', 'external_id', 'name', 'creator', 'image_url', 'resolved']) {
    assert.ok(body.includes(key), `${key} is part of the stored shape`);
  }
  assert.doesNotMatch(body, /\^https/, 'no absolute address from somebody else is stored any more (row 173)');
  assert.ok(body.includes('files\\/link-cards'), 'only the link card copy is kept');
  assert.match(body, /image\.length <= 600/, 'a URL longer than a permalink is a payload');
  assert.match(body, /raw\.resolved === true/, 'and a truthy string cannot claim the model was resolved');
});

test('the resolver still refuses to scrape, and still refuses a non-https image', () => {
  const resolver = read(RESOLVER);
  assert.match(resolver, /this module NEVER parses HTML/);
  const picker = resolver.slice(resolver.indexOf('function pickImages'));
  assert.ok(
    picker.slice(0, 600).includes('if (!/^https:\\/\\//i.test(v)) return false;'),
    'the resolver still drops a non-https image before it can be stored'
  );
});

