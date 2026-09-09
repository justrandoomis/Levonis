/**
 * A COMMA IS A LEGAL CHARACTER IN A URL PATH.
 *
 * Two places split a list of image addresses: the TXT template's
 * `usage_steps.N.images` and the admin image box's paste field. Both split on
 * every comma, and both therefore turned one working address into several
 * broken ones — a Cloudinary transform reads `/upload/w_800,h_600,c_fill/a.jpg`
 * and the IIIF Image API's "scale to width" size is literally `400,`.
 *
 * `worker/lib/urlList.ts` is the one rule they now share. The interesting part
 * is what it REFUSES to guess: `,/` is genuinely ambiguous, and a comma inside
 * a query string is never a separator, because query values carry commas
 * routinely and nothing distinguishes one from a boundary.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { splitUrlList, looksLikeUrl } from '../worker/lib/urlList';

test('whitespace always separates — a bare space cannot occur inside a valid URL', () => {
  assert.deepEqual(splitUrlList('https://a.example/1.jpg https://b.example/2.jpg'), [
    'https://a.example/1.jpg',
    'https://b.example/2.jpg',
  ]);
  assert.deepEqual(splitUrlList('  https://a.example/1.jpg\n\thttps://b.example/2.jpg  '), [
    'https://a.example/1.jpg',
    'https://b.example/2.jpg',
  ]);
  assert.deepEqual(splitUrlList(''), []);
  assert.deepEqual(splitUrlList('   '), []);
});

test('a comma before a new ABSOLUTE address separates — every file written before the change still reads', () => {
  assert.deepEqual(splitUrlList('https://a.example/1.jpg,https://b.example/2.jpg'), [
    'https://a.example/1.jpg',
    'https://b.example/2.jpg',
  ]);
  assert.deepEqual(splitUrlList('https://a.example/1.jpg, https://b.example/2.jpg'), [
    'https://a.example/1.jpg',
    'https://b.example/2.jpg',
  ]);
});

test('a comma INSIDE a path never separates — the defect this exists to fix', () => {
  const cloudinary = 'https://res.cloudinary.com/levonis/image/upload/w_800,h_600,c_fill/a1.jpg';
  assert.deepEqual(splitUrlList(cloudinary), [cloudinary], 'three transforms, one image');
});

test('`,/` splits only when what precedes it looks like a finished file', () => {
  // The IIIF Image API's size parameter is `400,` — one address, not two.
  const iiif = 'https://iiif.example.org/img/abc/full/400,/0/default.jpg';
  assert.deepEqual(splitUrlList(iiif), [iiif], 'the segment before the comma is `400`, not a filename');

  // A real list of site-relative R2 objects does split: `a.jpg` is a filename.
  assert.deepEqual(splitUrlList('/api/media/a.jpg,/api/media/b.jpg'), ['/api/media/a.jpg', '/api/media/b.jpg']);
  assert.deepEqual(splitUrlList('https://a.example/1.jpg,/api/media/b.jpg'), [
    'https://a.example/1.jpg',
    '/api/media/b.jpg',
  ]);
});

test('a comma inside a QUERY STRING is data, in either form', () => {
  for (const one of [
    'https://x.example/a.jpg?w=1,/b',
    'https://x.example/a.jpg?sizes=1,2,3',
    'https://x.example/a.jpg?next=https://y.example/z.jpg',
  ]) {
    assert.deepEqual(splitUrlList(one), [one], one);
  }
});

test('a trailing comma is punctuation, and only when what is left still stands alone', () => {
  assert.deepEqual(splitUrlList('https://a.example/1.jpg,'), ['https://a.example/1.jpg']);
  // Not a URL either way — the comma is not what makes it one.
  assert.deepEqual(splitUrlList('notaurl,'), ['notaurl,']);
});

test('looksLikeUrl agrees with what the splitter treats as an address', () => {
  assert.equal(looksLikeUrl('https://a.example/1.jpg'), true);
  assert.equal(looksLikeUrl('http://a.example/1.jpg'), true);
  assert.equal(looksLikeUrl('/api/media/a.jpg'), true);
  assert.equal(looksLikeUrl('//a.example/1.jpg'), false, 'protocol-relative is not an address we accept');
  assert.equal(looksLikeUrl('a.example/1.jpg'), false);
  assert.equal(looksLikeUrl(''), false);
});

test('both callers use the shared rule — no second implementation', () => {
  const template = readFileSync(new URL('../worker/lib/template.ts', import.meta.url), 'utf8');
  const images = readFileSync(
    new URL('../src/components/adminProducts/form/ImagesSection.tsx', import.meta.url),
    'utf8'
  );
  assert.match(template, /splitUrlList\(raw\)/, 'the TXT parser');
  assert.match(images, /splitUrlList\(urlText\)/, 'the admin paste box');
  // The bare-comma split that caused both bugs must not come back.
  assert.ok(!/split\(\/\[\\s,\]\+\//.test(images), 'the admin box is splitting on commas again');
  assert.ok(!/raw\.split\(','\)/.test(template.slice(template.indexOf("case 'urls'"))), 'the urls case is splitting on commas again');
});
