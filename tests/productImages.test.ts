/**
 * A BROKEN PICTURE SAYS SO, AND NOBODY DELETES IT (mandate §3).
 *
 * Three things went wrong in the product form's image section, and all three
 * had the same shape: the form assumed success.
 *
 *   1. A REMOTE URL THAT FAILS rendered the browser's broken-file glyph. That
 *      glyph is indistinguishable from "no image set", so an admin reading the
 *      screen could not tell a hotlink block from an empty record.
 *   2. A STRING WAS TREATED AS A URL. `product_images.url` is TEXT and the
 *      only check was non-emptiness, so «صورة», a Windows path, or a
 *      `javascript:` scheme all became an <img src>.
 *   3. A BROKEN PRIMARY WAS INVISIBLE. The primary image is what the
 *      storefront leads with; when it stopped loading, every customer saw a
 *      broken box and nobody in the admin saw anything.
 *
 * WHAT IS TESTED HERE, AND WHY IT IS THE HELPER. There is no DOM test runner
 * in this repository, so the two decisions the section makes were extracted
 * into `src/lib/imageUrl.ts` — pure, and the single source of truth the UI
 * reads. The component wiring is pinned by source assertions the way
 * `tests/adminProductHydration.test.ts` pins its own, and the server half (the
 * safe R2 ingestion path) is tested against the real guard.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyImageUrl, isUsableImageUrl, primaryRepair } from '../src/lib/imageUrl';
import { productPrimaryImage } from '../src/lib/productImage';
import { validateOutboundUrl } from '../worker/lib/fetchGuard';

// ------------------------------------------------- 1. a string is not a URL

test('a URL is judged as an address, not as a non-empty string', () => {
  for (const good of [
    'https://cdn.example.com/a.jpg',
    'http://cdn.example.com/a.jpg',
    'https://example.com/a.jpg?v=2#x',
  ]) {
    assert.equal(classifyImageUrl(good).kind, 'absolute', good);
    assert.ok(isUsableImageUrl(good), good);
  }

  // The site's own R2 objects are served from a path.
  assert.equal(classifyImageUrl('/api/media/abc.jpg').kind, 'r2');
  assert.equal(classifyImageUrl('/uploads/x.png').kind, 'relative');
  assert.ok(isUsableImageUrl('/api/media/abc.jpg'));
});

test('everything that is not an address is refused BY NAME, not silently', () => {
  const refused: Array<[unknown, string]> = [
    ['', 'الرابط فارغ'],
    ['   ', 'الرابط فارغ'],
    [null, 'الرابط فارغ'],
    [undefined, 'الرابط فارغ'],
    [42, 'الرابط فارغ'],
    ['صورة', 'ليس رابطًا صالحًا'],
    // `new URL` parses this with protocol "c:", so the refusal must be about
    // what it actually is — a path on the admin's own machine — and not about
    // an unsupported protocol named "c".
    ['C:\\pictures\\a.jpg', 'يبدو مسارًا على جهازك'],
    ['cdn.example.com/a.jpg', 'ليس رابطًا صالحًا'],
    ['//cdn.example.com/a.jpg', 'رابط بلا بروتوكول'],
  ];
  for (const [value, fragment] of refused) {
    const v = classifyImageUrl(value);
    assert.equal(v.ok, false, `${String(value)} was accepted`);
    assert.equal(v.kind, 'invalid');
    assert.ok(v.reason?.includes(fragment), `${String(value)}: reason was "${v.reason}"`);
  }
});

test('javascript:, data: and blob: are refused — two of them would even render', () => {
  // `javascript:` never loads in an <img>, but storing it is still a hostile
  // string in a column other screens read.
  assert.equal(classifyImageUrl('javascript:alert(1)').ok, false);
  // These two DO render, which is exactly why they need a rule: a data: URI
  // puts a whole image inside a TEXT column that every product read then
  // carries, and neither can ever be re-fetched or copied to R2.
  assert.equal(classifyImageUrl('data:image/png;base64,iVBORw0KGgo=').ok, false);
  assert.equal(classifyImageUrl('blob:https://x/9f3a').ok, false);
});

// ------------------------------------------------- 2. the broken primary

const img = (id: string, is_primary = false, url = `https://cdn.example.com/${id}.jpg`) => ({ id, url, is_primary });

test('a broken primary beside a healthy image is reported, with the replacement named', () => {
  const images = [img('a', true), img('b'), img('c')];
  const r = primaryRepair(images, new Set(['a']), new Set(['b', 'c']));
  assert.equal(r.needed, true);
  assert.equal(r.brokenId, 'a');
  assert.equal(r.healthyId, 'b', 'the first image in DISPLAY order takes over, not an arbitrary one');
});

test('a working primary is never disturbed', () => {
  const images = [img('a', true), img('b')];
  // Even with another image broken beside it.
  const r = primaryRepair(images, new Set(['b']), new Set(['a']));
  assert.deepEqual(r, { needed: false, brokenId: null, healthyId: null });
});

test('"not loaded yet" is not "healthy" — the grid is lazy', () => {
  // `b` has reported nothing at all: it is below the fold and was never
  // requested. Offering it as the healthy replacement would be a guess, and
  // the admin would click a button that swapped one broken image for another.
  const images = [img('a', true), img('b')];
  const r = primaryRepair(images, new Set(['a']), new Set());
  assert.equal(r.needed, false, 'nothing has been SEEN to work');
  assert.equal(r.brokenId, 'a', 'but the break itself is still known');
  assert.equal(r.healthyId, null);
});

test('a product whose every image is broken has nothing to repair', () => {
  const images = [img('a', true), img('b')];
  const r = primaryRepair(images, new Set(['a', 'b']), new Set());
  assert.equal(r.needed, false, 'moving the star between two broken images fixes nothing');
});

test('a healthy candidate must also have a usable address', () => {
  // `b` loaded — from a cached data: URI, say — but its stored address is not
  // one the server could ever re-fetch, so it is not a safe primary.
  const images = [img('a', true), { id: 'b', url: 'not a url', is_primary: false }, img('c')];
  const r = primaryRepair(images, new Set(['a']), new Set(['b', 'c']));
  assert.equal(r.healthyId, 'c');
});

test('a product with no primary at all is not a repair case', () => {
  const r = primaryRepair([img('a'), img('b')], new Set(['a']), new Set(['b']));
  assert.equal(r.needed, false, 'there is no star to move');
});

test('storefront thumbnails honor the explicit primary even across a stale legacy image array', () => {
  const product = {
    images: ['https://cdn.example.com/stale-first.jpg'],
    media: [
      { url: 'https://cdn.example.com/gallery-first.jpg', primary: false, order: 0 },
      { url: 'https://cdn.example.com/admin-primary.jpg', primary: true, order: 8 },
    ],
  };
  assert.equal(productPrimaryImage(product), 'https://cdn.example.com/admin-primary.jpg');
});

test('thumbnail fallback uses the published server order, then media order', () => {
  assert.equal(
    productPrimaryImage({ images: ['', 'https://cdn.example.com/published.jpg'], media: [] }),
    'https://cdn.example.com/published.jpg'
  );
  assert.equal(
    productPrimaryImage({ images: [], media: [{ url: 'later.jpg', order: 4 }, { url: 'first.jpg', order: 0 }] }),
    'first.jpg'
  );
});

// --------------------------------- 3. the section behaves the way it claims

test('the image grid renders through SafeImage and never deletes on failure', () => {
  const src = readFileSync(new URL('../src/components/adminProducts/form/ImagesSection.tsx', import.meta.url), 'utf8');

  assert.match(src, /<SafeImage/, 'the grid must show an explicit failure state, not a broken-file glyph');
  assert.ok(!/<img\s/.test(src), 'a bare <img> is back in the image grid');
  assert.match(src, /onStatus=\{\(st\) => noteStatus\(img\.id, st\)\}/, 'the grid must learn what actually loaded');
  assert.match(src, /primaryRepair\(rel\.images, failed, loaded\)/, 'the broken-primary rule comes from the shared helper');
  assert.match(src, /data-image-primary-broken/, 'and it is surfaced to the admin');
  assert.match(src, /data-image-replace-url=/, 'a failed image offers a new address');
  assert.match(src, /classifyImageUrl\(editingUrl\.text\)/, 'and the replacement is validated before it is accepted');

  // The failure path must not remove anything. `remove` is only ever reached
  // from the confirmed delete button.
  const removeCalls = src.match(/remove\(img\.id\)/g) ?? [];
  assert.equal(removeCalls.length, 1, 'deleting an image must stay one explicit, confirmed action');
  assert.match(src, /window\.confirm\('حذف هذه الصورة؟'\)/);
  assert.ok(
    !/failed\.has\([^)]*\)[^;]*remove\(/.test(src),
    'a temporary hotlink failure must never delete the record'
  );
});

test('the small option/colour thumbnail is honest about failure too', () => {
  const src = readFileSync(new URL('../src/components/adminProducts/form/formUi.tsx', import.meta.url), 'utf8');
  assert.match(src, /<SafeImage/, 'ImgSlot must not use a bare <img>');
  assert.ok(!/<img\s/.test(src));
});

test('SafeImage reports status without repairing anything', () => {
  const src = readFileSync(new URL('../src/components/ui/SafeImage.tsx', import.meta.url), 'utf8');
  assert.match(src, /onStatus\?:\s*\(status:/, 'the reporter exists');
  assert.match(src, /onStatus\?\.\(status, cleanSrc\)/);
  // Reported from an effect, so a parent that re-renders on the news cannot
  // re-enter setState during React's own event dispatch.
  assert.match(src, /useEffect\(\(\) => \{\s*onStatus\?\./);
  assert.match(src, /onError=\{\(\) => setStatus\('error'\)\}/, 'and a failure is still a first-class state');
});

// ------------------------------------- the safe R2 ingestion path, server side

test('the R2 ingestion path refuses every address that could reach inside', () => {
  // The owner asked for "SSRF protection, no localhost, no private IP ranges,
  // no Cloudflare metadata/internal addresses". The guard already exists; this
  // pins that the image ingest is the thing standing behind it.
  const blocked = [
    'http://localhost/a.jpg',
    'http://localhost./a.jpg',
    'http://127.0.0.1/a.jpg',
    'http://10.0.0.5/a.jpg',
    'http://172.16.4.1/a.jpg',
    'http://192.168.1.1/a.jpg',
    'http://169.254.169.254/latest/meta-data/', // cloud metadata
    'http://[::1]/a.jpg',
    'http://[::ffff:127.0.0.1]/a.jpg', // IPv4-mapped loopback
    'http://[::ffff:7f00:1]/a.jpg', // the same, in hex
    'http://router.local/a.jpg',
    'http://svc.internal/a.jpg',
    'file:///etc/passwd',
    'gopher://x/a',
  ];
  for (const url of blocked) {
    assert.throws(() => validateOutboundUrl(url), `${url} was NOT refused`);
  }
  // And an ordinary vendor CDN still passes.
  assert.doesNotThrow(() => validateOutboundUrl('https://cdn.bambulab.com/a.jpg'));
});

test('the ingest route states, and keeps, its four limits', () => {
  const src = readFileSync(new URL('../worker/routes/media.ts', import.meta.url), 'utf8');
  assert.match(src, /validateOutboundUrl/, 'every hop is checked');
  assert.match(src, /redirect: 'manual'/, 'redirects are followed by hand so each hop can be re-checked');
  assert.match(src, /AbortSignal\.timeout\(/, 'a fetch cannot hang');
  // Magic bytes, not the Content-Type header: a server can claim image/png for
  // an HTML error page, and storing that would put a page in the R2 bucket.
  assert.match(src, /magic bytes/i);
});


// ================ the adversarial review's image findings (5, 6, 10)

test('the paste box splits a URL list the way the TXT template does', () => {
  const src = readFileSync(
    new URL('../src/components/adminProducts/form/ImagesSection.tsx', import.meta.url),
    'utf8'
  );
  // It used to be `urlText.split(/[\s,]+/)`, which turned one Cloudinary
  // transform into a truncated URL plus two bogus refusals shown to the admin.
  assert.match(src, /splitUrlList\(urlText\)/);
  assert.ok(!/\[\\s,\]\+/.test(src), 'the comma split is back');
});

test('confirming an UNCHANGED url does not mark a still-broken image healthy', () => {
  const src = readFileSync(
    new URL('../src/components/adminProducts/form/ImagesSection.tsx', import.meta.url),
    'utf8'
  );
  // The replace panel is seeded with the current URL. Clicking «استبدال»
  // without editing used to clear the failed flag while SafeImage's own status
  // stayed 'error' — the card kept saying «تعذر تحميل الصورة» while the warning
  // and the broken-primary banner quietly vanished.
  assert.match(src, /if \(next !== img\.url\) \{/, 'only a DIFFERENT address is a new load');
  assert.match(src, /noteStatus\(img\.id, 'loading'\);/);
});

test('a protocol-relative address is refused in both of its spellings', () => {
  // Browsers resolve `/\\host/x` exactly like `//host/x` for http(s), so
  // refusing one and accepting the other left the stated rule with a hole.
  assert.equal(classifyImageUrl('//evil.example/x.jpg').ok, false);
  assert.equal(classifyImageUrl('/\\evil.example/x.jpg').ok, false);
  assert.match(classifyImageUrl('/\\evil.example/x.jpg').reason ?? '', /بلا بروتوكول/);
  // An ordinary site-relative path is still fine.
  assert.equal(classifyImageUrl('/api/media/a.jpg').ok, true);
});

test('the helper states its own scope — this is the editor, not the column', () => {
  const src = readFileSync(new URL('../src/lib/imageUrl.ts', import.meta.url), 'utf8');
  assert.match(src, /SCOPE, STATED PLAINLY/, 'a client-only rule that reads as a server guarantee is worse than none');
  assert.match(src, /the server still accepts any string|The server still accepts any string/i);
});
