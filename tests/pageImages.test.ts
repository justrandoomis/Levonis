/**
 * WHICH PICTURES A VENDOR PRODUCT PAGE IS ACTUALLY OFFERING.
 *
 * The owner asked for image ingestion from bambulab / qidi / biqu / esun /
 * creality pages. Those five run on three different platforms, so the
 * extractor is deliberately built on what ALL of them emit — Open Graph,
 * JSON-LD `Product.image`, `<link rel=preload as=image>` and `<img srcset>` —
 * rather than on five per-site scrapers that rot the moment a theme changes.
 *
 * The fixtures below are HAND-WRITTEN to the shape each platform emits. They
 * were NOT captured from the vendors' live sites: this build environment
 * cannot reach them (the egress proxy answers 403). A companion CI job runs
 * this same extractor over pages fetched for real, which is where the claim
 * "it works on their site" is allowed to come from — not from here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPageImages, imageCandidates, isVendorHost, VENDOR_HOSTS } from '../worker/lib/pageImages';

// --------------------------------------------------------------- host gate

test('the vendor gate matches a host and its subdomains, not a lookalike', () => {
  assert.equal(isVendorHost('bambulab.com'), true);
  assert.equal(isVendorHost('us.store.bambulab.com'), true);
  assert.equal(isVendorHost('BAMBULAB.COM'), true);
  assert.equal(isVendorHost('bambulab.com.'), true, 'a trailing root dot is the same host');
  // The suffix match must be on a LABEL boundary or "notbambulab.com" passes.
  assert.equal(isVendorHost('notbambulab.com'), false);
  assert.equal(isVendorHost('bambulab.com.evil.example'), false);
  assert.equal(isVendorHost('example.com'), false);
});

test('every vendor the owner named is on the list, and the gate agrees', () => {
  // Checking the array alone would pass while isVendorHost was broken, so
  // each entry is also put through the gate that actually decides.
  for (const needle of ['bambulab', 'qidi', 'biqu', 'esun', 'creality']) {
    const host = VENDOR_HOSTS.find((h) => h.includes(needle));
    assert.ok(host, `${needle} is missing from VENDOR_HOSTS`);
    assert.equal(isVendorHost(host!), true, `${host} is listed but the gate refuses it`);
    assert.equal(isVendorHost(`shop.${host}`), true, `a storefront subdomain of ${host} must pass`);
  }
  assert.equal(isVendorHost('example.com'), false, 'and the gate is not simply true for everything');
});

// ------------------------------------------------------------- open graph

test('Open Graph names the product shot and it comes first', () => {
  const html = `
    <html><head>
      <meta property="og:title" content="Bambu Lab A1">
      <meta property="og:image" content="https://cdn.example.com/a1-hero.jpg">
      <meta property="og:image:width" content="1200">
      <meta name="twitter:image" content="https://cdn.example.com/a1-card.jpg">
    </head><body>
      <img src="https://cdn.example.com/gallery-1.jpg" width="800">
    </body></html>`;
  const out = extractPageImages(html, 'https://us.store.bambulab.com/products/a1');
  assert.equal(out[0].url, 'https://cdn.example.com/a1-hero.jpg');
  assert.equal(out[0].source, 'og');
  assert.equal(out[0].width, 1200);
  assert.ok(out.some((i) => i.url.endsWith('a1-card.jpg')));
});

// ---------------------------------------------------------------- JSON-LD

test('JSON-LD Product.image is read as a string, an array and an ImageObject', () => {
  const html = `
    <script type="application/ld+json">
    {"@context":"https://schema.org","@type":"Product","name":"QIDI X-Max 3",
     "image":["https://cdn.example.com/x1.jpg","https://cdn.example.com/x2.jpg"]}
    </script>
    <script type="application/ld+json">
    {"@type":"Product","image":{"@type":"ImageObject","url":"https://cdn.example.com/x3.jpg"}}
    </script>`;
  const out = extractPageImages(html, 'https://qidi3d.com/products/x-max-3');
  const urls = out.map((i) => i.url);
  assert.deepEqual(urls, [
    'https://cdn.example.com/x1.jpg',
    'https://cdn.example.com/x2.jpg',
    'https://cdn.example.com/x3.jpg',
  ]);
  assert.ok(out.every((i) => i.source === 'jsonld'));
});

test('a Product nested inside an @graph is still found', () => {
  const html = `
    <script type="application/ld+json">
    {"@context":"https://schema.org","@graph":[
      {"@type":"WebPage","name":"page"},
      {"@type":["Product","Thing"],"image":"https://cdn.example.com/deep.jpg"}
    ]}
    </script>`;
  const out = extractPageImages(html, 'https://biqu.equipment/products/x');
  assert.equal(out[0].url, 'https://cdn.example.com/deep.jpg');
});

test('one malformed JSON-LD block does not lose the page', () => {
  const html = `
    <script type="application/ld+json">{ this is not json </script>
    <script type="application/ld+json">{"@type":"Product","image":"https://cdn.example.com/ok.jpg"}</script>`;
  const out = extractPageImages(html, 'https://esun3d.com/p/1');
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://cdn.example.com/ok.jpg');
});

test('a NON-product JSON-LD image is not mistaken for the product', () => {
  // The Product block is in the SAME fixture on purpose. Asserting only that
  // the organization image is absent would pass against an extractor that
  // returns nothing at all — a test that cannot fail is not a test.
  const html = `
    <script type="application/ld+json">
    {"@type":"Organization","logo":"https://cdn.example.com/logo.png","image":"https://cdn.example.com/org.png"}
    </script>
    <script type="application/ld+json">
    {"@type":"Product","image":"https://cdn.example.com/the-real-product.jpg"}
    </script>`;
  const urls = extractPageImages(html, 'https://creality.com/p').map((i) => i.url);
  assert.deepEqual(urls, ['https://cdn.example.com/the-real-product.jpg']);
});

// ----------------------------------------------------------------- srcset

test('srcset hands us the widest file, and its declared width', () => {
  const html = `<img alt="A1 back" srcset="
      https://cdn.example.com/a1_400x.jpg 400w,
      https://cdn.example.com/a1_1600x.jpg 1600w,
      https://cdn.example.com/a1_800x.jpg 800w">`;
  const out = extractPageImages(html, 'https://us.store.bambulab.com/products/a1');
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://cdn.example.com/a1_1600x.jpg');
  assert.equal(out[0].width, 1600);
  assert.equal(out[0].alt, 'A1 back', 'the page wrote alt text; it is carried, not invented');
});

test('a comma inside a srcset URL does not cut the address in half', () => {
  // Cloudinary-style transforms put commas in the PATH. Splitting a srcset on
  // "," turns this into two broken URLs; anchoring on the descriptor does not.
  const html = `<img srcset="https://res.example.com/w_800,h_800,c_fit/p.jpg 800w, https://res.example.com/w_1600,h_1600,c_fit/p.jpg 1600w">`;
  const out = extractPageImages(html, 'https://www.creality.com/products/k1');
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://res.example.com/w_1600,h_1600,c_fit/p.jpg');
});

test('a density srcset picks the densest without inventing a pixel width', () => {
  const html = `<img srcset="https://cdn.example.com/p.jpg 1x, https://cdn.example.com/p@3x.jpg 3x">`;
  const out = extractPageImages(html, 'https://qidi3d.com/p');
  assert.equal(out[0].url, 'https://cdn.example.com/p@3x.jpg');
  assert.equal(out[0].width, null, 'a density is not a width and must not be reported as one');
});

test('a bare srcset with a single URL and no descriptor still resolves', () => {
  const html = `<img srcset="https://cdn.example.com/only.jpg">`;
  assert.equal(extractPageImages(html, 'https://esun3d.com/p')[0].url, 'https://cdn.example.com/only.jpg');
});

// ------------------------------------------------------------ lazy images

test('lazy-loaded galleries are read from their data-* attributes', () => {
  const html = `
    <img data-src="https://cdn.example.com/lazy-1.jpg">
    <img data-original="https://cdn.example.com/lazy-2.jpg">
    <img data-srcset="https://cdn.example.com/lazy-3-2000.jpg 2000w">`;
  const urls = extractPageImages(html, 'https://biqu.equipment/p').map((i) => i.url);
  assert.ok(urls.includes('https://cdn.example.com/lazy-1.jpg'));
  assert.ok(urls.includes('https://cdn.example.com/lazy-2.jpg'));
  assert.ok(urls.includes('https://cdn.example.com/lazy-3-2000.jpg'));
});

// -------------------------------------------------------------- rejection

test('page furniture is dropped before it costs a fetch', () => {
  const html = `
    <img src="https://cdn.example.com/assets/logo.svg">
    <img src="https://cdn.example.com/assets/site-logo.png">
    <img src="https://cdn.example.com/icons/cart-icon.png">
    <img src="https://cdn.example.com/pay/visa.png">
    <img src="https://cdn.example.com/loading-placeholder.gif">
    <img src="data:image/gif;base64,R0lGOD">
    <img src="https://cdn.example.com/products/real-shot.jpg">`;
  const urls = extractPageImages(html, 'https://www.creality.com/p').map((i) => i.url);
  assert.deepEqual(urls, ['https://cdn.example.com/products/real-shot.jpg']);
});

test('a declared thumbnail width is refused, an undeclared one is not', () => {
  const html = `
    <img src="https://cdn.example.com/thumb.jpg" width="64">
    <img src="https://cdn.example.com/unknown.jpg">`;
  const urls = extractPageImages(html, 'https://qidi3d.com/p').map((i) => i.url);
  assert.deepEqual(urls, ['https://cdn.example.com/unknown.jpg']);
});

test('relative and protocol-relative addresses resolve against the page', () => {
  const html = `
    <img src="/cdn/shop/files/hero.jpg">
    <img src="//cdn.example.com/proto-relative.jpg">`;
  const urls = extractPageImages(html, 'https://us.store.bambulab.com/products/a1?variant=42').map((i) => i.url);
  assert.ok(urls.includes('https://us.store.bambulab.com/cdn/shop/files/hero.jpg'));
  assert.ok(urls.includes('https://cdn.example.com/proto-relative.jpg'));
});

test('the same address found twice is returned once', () => {
  const html = `
    <meta property="og:image" content="https://cdn.example.com/same.jpg">
    <script type="application/ld+json">{"@type":"Product","image":"https://cdn.example.com/same.jpg"}</script>
    <img src="https://cdn.example.com/same.jpg">`;
  assert.equal(extractPageImages(html, 'https://esun3d.com/p').length, 1);
});

test('the limit is honoured so one page cannot queue an unbounded batch', () => {
  const html = Array.from({ length: 60 }, (_, i) => `<img src="https://cdn.example.com/p${i}.jpg">`).join('');
  assert.equal(extractPageImages(html, 'https://qidi3d.com/p', 8).length, 8);
});

test('HTML entities inside an attribute are decoded', () => {
  const html = `<img src="https://cdn.example.com/p.jpg?a=1&amp;b=2">`;
  assert.equal(extractPageImages(html, 'https://esun3d.com/p')[0].url, 'https://cdn.example.com/p.jpg?a=1&b=2');
});

// ------------------------------------------------------- CDN original file

test('a Shopify resize infix is stripped, with the original kept as a fallback', () => {
  const got = imageCandidates('https://cdn.shopify.com/s/files/1/0/a1_600x600.jpg?v=17');
  assert.equal(got[0], 'https://cdn.shopify.com/s/files/1/0/a1.jpg?v=17');
  assert.equal(got[got.length - 1], 'https://cdn.shopify.com/s/files/1/0/a1_600x600.jpg?v=17');
});

test('Shopify width/height query parameters are dropped', () => {
  const got = imageCandidates('https://us.store.bambulab.com/cdn/shop/files/a1.jpg?v=1&width=493&height=493&crop=center');
  assert.equal(got[0], 'https://us.store.bambulab.com/cdn/shop/files/a1.jpg?v=1');
});

test('a WordPress -800x800 suffix is stripped', () => {
  const got = imageCandidates('https://qidi3d.com/wp-content/uploads/2025/01/x-max-3-800x800.jpg');
  assert.equal(got[0], 'https://qidi3d.com/wp-content/uploads/2025/01/x-max-3.jpg');
  assert.equal(got.length, 2);
});

test('an address with no known resize pattern is returned untouched, exactly once', () => {
  assert.deepEqual(imageCandidates('https://cdn.example.com/plain.jpg'), ['https://cdn.example.com/plain.jpg']);
});

test('a resize strip that changes nothing does not duplicate the address', () => {
  assert.deepEqual(imageCandidates('https://cdn.shopify.com/s/files/a1.jpg'), ['https://cdn.shopify.com/s/files/a1.jpg']);
});

test('an unparseable address is passed through rather than throwing', () => {
  assert.deepEqual(imageCandidates('not a url'), ['not a url']);
});

// ============================================================ review round 2
// Each test below is a defect an adversarial review found in the first cut of
// this file, reproduced before it was fixed.

test('an attribute is never read out of another attribute VALUE', () => {
  // Shopify writes `?width=` into essentially every src. Matching the tag's
  // raw text made attr(tag,'width') return 1946 for a 64px thumbnail, which
  // then sorted to the FRONT of the gallery ahead of the real shots.
  const html = `<img src="https://cdn.example.com/p.jpg?v=1&amp;width=1946" width="64" height="64">`;
  assert.deepEqual(extractPageImages(html, 'https://us.store.bambulab.com/p'), []);
});

test('srcset does not match data-srcset by accident', () => {
  // `\\bsrcset` also matches after a hyphen, which made the data-srcset
  // fallback unreachable and read the lazy attribute as the eager one.
  const html = `<img data-srcset="https://cdn.example.com/lazy-1600.jpg 1600w">`;
  const out = extractPageImages(html, 'https://qidi3d.com/p');
  assert.equal(out[0].url, 'https://cdn.example.com/lazy-1600.jpg');
  assert.equal(out[0].width, 1600);
});

test('alt text is not read out of a URL query parameter', () => {
  const html = `<img src="https://cdn.example.com/p.jpg?alt=media&amp;token=x" alt="Bambu Lab A1 rear view">`;
  assert.equal(extractPageImages(html, 'https://us.store.bambulab.com/p')[0].alt, 'Bambu Lab A1 rear view');
});

test('og:image:width belongs to the og:image above it, not to the whole page', () => {
  const html = `
    <meta property="og:image" content="https://cdn.example.com/hero-2000.jpg">
    <meta property="og:image:width" content="2000">
    <meta property="og:image" content="https://cdn.example.com/swatch.jpg">
    <meta property="og:image:width" content="200">
    <meta name="twitter:image" content="https://cdn.example.com/card-1200.jpg">`;
  const urls = extractPageImages(html, 'https://www.creality.com/p').map((i) => i.url);
  assert.ok(urls.includes('https://cdn.example.com/hero-2000.jpg'), 'the 2000px hero must survive');
  assert.ok(!urls.includes('https://cdn.example.com/swatch.jpg'), 'the 200px swatch is a thumbnail');
  assert.ok(urls.includes('https://cdn.example.com/card-1200.jpg'), 'twitter:image declared no width');
});

test('a real product photo is not mistaken for page furniture', () => {
  // Every one of these was dropped by the first, unanchored filter: `close`
  // inside closeup, `arrow` inside narrow, `icon-` inside silicon-,
  // `profile-` in a part BIQU actually sells.
  const names = [
    'k1-max-closeup.jpg',
    'close-up-nozzle.jpg',
    'narrow-nozzle-0.2.jpg',
    'silicon-carbide-nozzle.jpg',
    'aluminium-profile-2020.jpg',
    'fidget-spinner-blue.jpg',
    'skeleton-hand-model.png',
  ];
  const html = names.map((n) => `<img src="https://cdn.example.com/products/${n}">`).join('');
  const out = extractPageImages(html, 'https://biqu.equipment/p');
  assert.equal(out.length, names.length, `dropped: ${names.filter((n) => !out.some((i) => i.url.endsWith(n)))}`);
});

test('real page furniture is still dropped', () => {
  const html = [
    'assets/logo.png',
    'icons/cart.png',
    'ui/spinner.gif',
    'chrome/close.png',
    'pay/visa.png',
    'ui/menu-arrow.png',
  ]
    .map((n) => `<img src="https://cdn.example.com/${n}">`)
    .join('');
  assert.deepEqual(extractPageImages(html, 'https://biqu.equipment/p'), []);
});

test('AVIF is accepted — the sniffer stores it', () => {
  const html = `<img src="https://cdn.example.com/files/a1-hero.avif">`;
  assert.equal(extractPageImages(html, 'https://us.store.bambulab.com/p').length, 1);
});

test('a huge descriptorless srcset is parsed in linear time, not quadratic', () => {
  // The regex version took 19.5 s on 84 KB of this shape. A linear scan is
  // milliseconds; the assertion is a wall-clock ceiling, generous enough not
  // to flake on a loaded runner and far under the old cost.
  const one = 'https://res.example.com/w_400,h_400,c_fit/product-photo.jpg';
  const srcset = Array.from({ length: 1500 }, () => one).join(',');
  const html = `<img srcset="${srcset}">`;
  const started = process.hrtime.bigint();
  extractPageImages(html, 'https://www.creality.com/p');
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 1000, `took ${Math.round(ms)}ms — the parser is backtracking again`);
});

test('a trailing comma in srcset does not stick to the URL', () => {
  const html = `<img srcset="https://cdn.example.com/a-1600.jpg 1600w,">`;
  const out = extractPageImages(html, 'https://esun3d.com/p');
  assert.equal(out[0].url, 'https://cdn.example.com/a-1600.jpg');
});

test('a tag declaring a thumbnail width is refused even through the src fallback', () => {
  // The width check used to run only on the src path, so a small tag whose
  // srcset was rejected fell through to src and was kept with width unknown.
  const html = `<img width="48" srcset="https://cdn.example.com/tiny.svg 48w" src="https://cdn.example.com/tiny.jpg">`;
  assert.deepEqual(extractPageImages(html, 'https://qidi3d.com/p'), []);
});
