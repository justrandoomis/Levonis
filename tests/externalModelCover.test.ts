/**
 * «البيانات فقط، والصورة بالرابط» — the owner's decision on a MakerWorld link,
 * and the two halves it has.
 *
 * A customer very often has no file, only a link: "print me this one". The
 * resolver already reads the page's own JSON API and comes back with a name, a
 * creator and a set of cover images — and the wizard rendered the first two and
 * threw the third away. A name and a creator are a poor way to check the shop
 * understood WHICH design is meant; the picture is the confirmation.
 *
 * THE IMAGE IS A LINK, NOT A COPY. It is loaded from the source's own CDN and
 * never downloaded, never re-hosted and never written to R2. Nothing of theirs
 * is copied, nothing goes stale when the designer replaces the render, and the
 * shop stores no bytes it has no licence to.
 *
 * What that costs is that the URL points at another host, so it must be an
 * absolute https one — `http` is blocked on an https page, and a relative or
 * `data:` string out of somebody else's API is not a picture of anything. The
 * rule is applied on the worker (which decides what is STORED) and again in the
 * component (which decides what is DRAWN), because those are two different
 * decisions and one of them must not rely on the other having been careful.
 *
 * Run: npx tsx --test tests/externalModelCover.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const WIZARD = 'src/components/print/PrintRequestWizard.tsx';
const ROUTE = 'worker/routes/printRequests.ts';
const RESOLVER = 'worker/lib/externalModels.ts';

test('the wizard shows the cover the source named', () => {
  const wizard = read(WIZARD);
  assert.match(wizard, /data-wizard="link-cover"/);
  assert.match(wizard, /src=\{linkCover\}/);
  assert.match(wizard, /const linkCover = \(\) =>|const linkCover = \(\(\) => \{/);
  assert.match(wizard, /link\?\.info\.images\?\.\[0\]/, 'from the resolved images, not from a second lookup');
});

test('it is a link and never a copy', () => {
  const wizard = read(WIZARD);
  const route = read(ROUTE);
  // A re-host would mean an upload call on this path. There is none, and the
  // absence is the feature.
  assert.doesNotMatch(wizard, /putMediaObject|uploadImage|ingestImage/);
  assert.doesNotMatch(route, /ingestRemoteImage|putMediaObject\([^)]*image_url/);
  assert.match(
    route,
    /never downloaded,\s*\n \* never re-hosted and never written to R2/,
    'and the reason is written where the rule lives'
  );
});

test('only an absolute https URL is drawn, and only one that size', () => {
  const wizard = read(WIZARD);
  assert.match(wizard, /\/\^https:\\\/\\\/\/i\.test\(first\)/, 'the component decides what it draws');
  assert.match(wizard, /referrerPolicy="no-referrer"/, 'the source learns nothing about who is looking');
  assert.match(wizard, /loading="lazy"/);
});

test('only an absolute https URL is stored, and the blob is typed rather than free-form', () => {
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
  assert.match(body, /\/\^https:\\\/\\\/\/i\.test\(image\)/, 'the worker decides what it stores');
  assert.match(body, /image\.length <= 600/, 'a URL longer than a permalink is a payload');
  assert.match(body, /raw\.resolved === true/, 'and a truthy string cannot claim the model was resolved');
});

test('a broken cover loses the thumbnail and nothing else', () => {
  const wizard = read(WIZARD);
  assert.match(wizard, /onError=\{\(\) => setCoverFailed\(true\)\}/);
  assert.match(wizard, /\{linkCover && !coverFailed &&/, 'a broken frame would look like a broken request');
  // The latch must clear, or one bad link poisons every later one in the
  // same session.
  assert.match(wizard, /setLink\(d\);\s*\n\s*setCoverFailed\(false\);/);
  assert.match(wizard, /setLink\(null\); setCoverFailed\(false\);/);
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

test('an unresolved link still publishes, with no picture and no invented numbers', () => {
  const wizard = read(WIZARD);
  // The honest-degradation path is the one most likely to be broken by adding
  // a picture to the happy one.
  assert.match(wizard, /!link\.info\.resolved &&/);
  assert.match(wizard, /ولم نستطع قراءة تفاصيل المجسم من الموقع/);
  assert.match(wizard, /طلبك يعمل بشكل طبيعي؛ التقدير فقط سيكون أقل دقة/);
});
