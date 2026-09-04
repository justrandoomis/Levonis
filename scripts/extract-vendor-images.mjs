/**
 * Run the REAL extractor over REAL vendor pages.
 *
 * The unit tests in tests/pageImages.test.ts use hand-written fixtures, because
 * this build environment cannot reach bambulab, qidi, biqu, esun or creality —
 * the egress proxy answers 403 for all of them. Hand-written fixtures prove the
 * parser handles the SHAPES those platforms emit; they cannot prove the shapes
 * are right. This script closes that gap from a runner with open egress.
 *
 * READ-ONLY: it makes GET requests to public product pages and HEAD requests to
 * the image addresses it finds. It stores nothing, needs no credentials, and
 * touches neither the database nor R2.
 *
 * A page that refuses a bot (403/429) is REPORTED, not counted as a failure —
 * that is the vendor's policy, not a defect in the extractor. The run fails
 * when a page we could actually read yields no product image.
 */
import { extractPageImages, imageCandidates, isVendorHost } from '../worker/lib/pageImages.ts';

const PAGES = process.argv.slice(2);
if (PAGES.length === 0) {
  console.error('usage: extract-vendor-images.mjs <product page url> [...]');
  process.exit(2);
}

const UA = 'Mozilla/5.0 (compatible; LevonisBot/1.0; +https://levonis-iq.com)';
let readable = 0;
let withImages = 0;
let unreachable = 0;
let failed = 0;

for (const url of PAGES) {
  console.log(`\n=== ${url}`);
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    console.log('  FAIL not a URL');
    failed += 1;
    continue;
  }
  if (!isVendorHost(host)) {
    console.log(`  FAIL ${host} is not on VENDOR_HOSTS — the worker would refuse to read this page`);
    failed += 1;
    continue;
  }

  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, redirect: 'follow' });
  } catch (e) {
    console.log(`  SKIP unreachable: ${e.message}`);
    unreachable += 1;
    continue;
  }
  if (!res.ok) {
    console.log(`  SKIP HTTP ${res.status} — the vendor refused the request, not an extractor defect`);
    unreachable += 1;
    continue;
  }
  const html = await res.text();
  readable += 1;
  console.log(`  read ${html.length} bytes`);

  const found = extractPageImages(html, res.url, 10);
  if (found.length === 0) {
    console.log('  FAIL the page was read and named no product image');
    failed += 1;
    continue;
  }
  withImages += 1;
  console.log(`  ${found.length} candidate(s):`);
  let verified = 0;
  for (const img of found.slice(0, 4)) {
    const candidates = imageCandidates(img.url);
    let ok = null;
    for (const c of candidates) {
      try {
        const head = await fetch(c, { method: 'HEAD', headers: { 'User-Agent': UA } });
        const type = head.headers.get('content-type') ?? '';
        if (head.ok && type.startsWith('image/')) {
          ok = { url: c, type, upgraded: c !== img.url };
          break;
        }
      } catch {
        /* try the next candidate */
      }
    }
    if (ok) {
      verified += 1;
      console.log(
        `    ok   [${img.source}${img.width ? ` ${img.width}w` : ''}] ${ok.type}${ok.upgraded ? ' (upgraded to the original)' : ''}`
      );
      console.log(`         ${ok.url.slice(0, 140)}`);
    } else {
      console.log(`    warn [${img.source}] no candidate answered as an image: ${img.url.slice(0, 140)}`);
    }
  }
  if (verified === 0) {
    console.log('  FAIL every candidate this page named failed a HEAD check');
    failed += 1;
  }
}

console.log(
  `\nsummary: ${PAGES.length} page(s) — ${readable} read, ${withImages} yielded images, ` +
    `${unreachable} unreachable/refused, ${failed} failed`
);
if (failed > 0) process.exit(1);
if (readable === 0) {
  console.log('NOTE: no page could be read, so this run proved nothing about the extractor.');
  process.exit(0);
}
