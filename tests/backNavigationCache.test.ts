/**
 * «14- اضافة كاش من الموقع حيث عند الرجوع للوراء لا يضطر أن يحمل الصفحة مرة
 *  ثانية … يدخل على صفحة معينة ويرجع للوراء خلال ثواني معدودة يضطر إلى تحميل
 *  الصفحة من جديد.»
 *
 * TWO THINGS MAKE A RETURN LOOK LIKE A FIRST VISIT, and this suite pins both.
 *
 *   1. THE SKELETON. Every list page started at `loading = true` and fetched in
 *      a mount effect, so `back` ran the whole first-visit sequence again for
 *      data the customer had been reading seconds earlier. src/lib/pageCache.ts
 *      holds the last successful answer; the page paints from it and
 *      revalidates behind it.
 *
 *   2. THE TOP OF THE PAGE. App.tsx reset the scroll container on EVERY
 *      navigation, `back` included, so returning to a shelf put you at the
 *      start of it. The restore is keyed on the router's own history key and
 *      gated on a POP.
 *
 * The behavioural half of (1) is proved against the real module below. The
 * wiring is proved by reading the sources, because a cache nobody calls is the
 * failure mode that would otherwise pass every test in this file.
 *
 * Run: npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readPageCache,
  writePageCache,
  dropPageCache,
  clearPageCache,
  pageCacheSize,
  PAGE_CACHE_TTL_MS,
} from '../src/lib/pageCache';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** Every case starts from an empty cache; the module is shared state. */
function fresh(): void {
  clearPageCache();
}

// ----------------------------------------------------------- the module

test('a snapshot comes back, and only for its own key', () => {
  fresh();
  assert.equal(readPageCache('home'), null, 'nothing was written yet');
  writePageCache('home', { latest: [1, 2, 3] });
  assert.deepEqual(readPageCache('home'), { latest: [1, 2, 3] });
  // The keys carry the query — «products:|cat_printers» is not «products:|» —
  // so a return to one section can never paint another section's grid.
  assert.equal(readPageCache('products:|cat_printers'), null);
});

test('an expired snapshot is not returned, and does not stay in the map', () => {
  fresh();
  writePageCache('home', { latest: [] });
  assert.equal(pageCacheSize(), 1);
  // Read with a TTL of zero: whatever the clock source is, an entry written
  // before this line is older than nothing.
  assert.equal(readPageCache('home', 0), null, 'a stale snapshot must not paint');
  assert.equal(pageCacheSize(), 0, 'an expired entry is dropped, not left to rot');
});

test('the default window is the length of a back-navigation, not a session', () => {
  // Sixty seconds covers "open a product, read it, come back" — the journey the
  // owner described — and leaves a page parked in a background tab to fetch on
  // its own rather than flashing a stale shelf first.
  assert.equal(PAGE_CACHE_TTL_MS, 60_000);
});

test('signing in or out drops everything', () => {
  fresh();
  writePageCache('home', 1);
  writePageCache('bundles:all||', 2);
  writePageCache('used-printers', 3);
  assert.equal(pageCacheSize(), 3);
  clearPageCache();
  assert.equal(pageCacheSize(), 0);
  assert.equal(readPageCache('home'), null);
});

test('one page can be forgotten without taking the others with it', () => {
  fresh();
  writePageCache('home', 1);
  writePageCache('used-printers', 3);
  dropPageCache('home');
  assert.equal(readPageCache('home'), null);
  assert.deepEqual(readPageCache('used-printers'), 3);
});

test('a later write replaces the earlier snapshot rather than stacking', () => {
  fresh();
  writePageCache('home', { latest: [1] });
  writePageCache('home', { latest: [1, 2] });
  assert.equal(pageCacheSize(), 1);
  assert.deepEqual(readPageCache('home'), { latest: [1, 2] });
});

// --------------------------------------------------- nothing is persisted

test('the cache is memory only — no storage API is touched', () => {
  // A snapshot in localStorage would outlive the tab, survive a reload (which
  // is the customer asking for the page AGAIN) and sit on a shared phone for
  // the next person. The module must not reach for storage at all.
  // Comments stripped: the header NAMES those APIs to say it does not use
  // them, and a grep over prose would fail on the sentence that promises it.
  const code = read('src/lib/pageCache.ts')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(code, /localStorage|sessionStorage|indexedDB/i);
});

// ------------------------------------------------------------ the wiring

test('the four catalogue listings paint from a snapshot and revalidate', () => {
  for (const [file, key] of [
    ['src/pages/Home.tsx', 'HOME_CACHE_KEY'],
    ['src/pages/Products.tsx', 'cacheKey'],
    ['src/pages/UsedPrinters.tsx', 'USED_CACHE_KEY'],
    ['src/pages/Bundles.tsx', 'cacheKey'],
  ] as const) {
    const src = read(file);
    assert.match(src, /from '\.\.\/lib\/pageCache'/, `${file} does not use the cache`);
    assert.ok(src.includes(`readPageCache<`), `${file} never reads a snapshot`);
    assert.ok(src.includes(`writePageCache(${key}`), `${file} never records one`);
    // THE REQUEST STILL GOES OUT. A snapshot that suppressed the fetch would
    // make «رجعت للوراء» show a price the shop no longer charges.
    assert.match(src, /await\s+(api\.get|fetchGradedStock|fetchPage)/, `${file} stopped fetching`);
    // And the skeleton is gated on there being nothing to paint.
    assert.match(src, /setLoading\(!snapshot\)|setInitialLoading\(!snapshot\)/, `${file} still forces its skeleton`);
  }
});

test('a snapshot is only ever written after a successful read', () => {
  // Recording inside a catch would make the next return paint a failure
  // instantly. Every write must sit in the try, after the await.
  for (const file of [
    'src/pages/Home.tsx',
    'src/pages/Products.tsx',
    'src/pages/UsedPrinters.tsx',
    'src/pages/Bundles.tsx',
  ]) {
    const src = read(file);
    for (const m of src.matchAll(/writePageCache\(/g)) {
      const before = src.slice(0, m.index);
      const lastTry = before.lastIndexOf('try {');
      const lastCatch = before.lastIndexOf('} catch');
      assert.ok(lastTry > lastCatch, `${file}: a snapshot is written outside the success path`);
    }
  }
});

test('the two pages that carry a query put it in the key', () => {
  // «products:» alone would let a return to «فلامنت» paint «طابعات».
  assert.match(read('src/pages/Products.tsx'), /`products:\$\{search\}\|\$\{category\}`/);
  assert.match(read('src/pages/Bundles.tsx'), /`bundles:\$\{kind\}\|\$\{search\}\|\$\{category\}`/);
});

test('the money pages are deliberately NOT cached', () => {
  // A remembered total on the screen with the pay button on it is the one
  // trade this shop does not make. The header of pageCache.ts says so; this
  // is the assertion that keeps it true.
  for (const file of [
    'src/pages/Cart.tsx',
    'src/pages/Checkout.tsx',
    'src/pages/Wallet.tsx',
    'src/pages/Orders.tsx',
    'src/pages/OrderDetail.tsx',
    'src/pages/Product.tsx',
  ]) {
    assert.ok(!read(file).includes('pageCache'), `${file} must not paint money from a snapshot`);
  }
});

test('the identity change empties it, and does so from one place', () => {
  const auth = read('src/AuthContext.tsx');
  assert.match(auth, /import \{ clearPageCache \} from '\.\/lib\/pageCache';/);
  assert.match(auth, /const lastIdentityRef = useRef<string \| null>\(null\);/);
  assert.match(auth, /if \(lastIdentityRef\.current === id\) return;[\s\S]{0,120}clearPageCache\(\);/);
  // Starting at `null` is what makes the BOOT case work: the app is a visitor
  // until /api/auth/me answers, so a user arriving is a change and drops
  // whatever was cached while the page was still anonymous.
  assert.ok(
    !/useRef<string \| null \| undefined>/.test(auth),
    'an undefined seed would skip the first transition — the boot case'
  );
});

// ---------------------------------------------------------- the scroll

test('back restores the offset; a new page still starts at its top', () => {
  const app = read('src/App.tsx');
  assert.match(app, /useNavigationType/, 'the restore cannot tell back from a new page');
  assert.match(app, /navigationType === 'POP' \? offsetsRef\.current\.get\(key\) \?\? 0 : 0/);
  // Keyed on the history entry, not the path: two visits to the same shelf at
  // different depths are two entries and must not share an offset.
  assert.match(app, /const key = location\.key;/);
  assert.match(app, /\}, \[location\.key, location\.hash, navigationType\]\);/);
  // Bounded: a long session is an unbounded number of history keys.
  assert.match(app, /if \(offsets\.size > 40\)/);
  // A hash link keeps its own offset.
  assert.match(app, /if \(location\.hash\) return;/);
  // The listener is removed with the effect, or every route change would add
  // another one to the same element.
  assert.match(app, /el\.removeEventListener\('scroll', onScroll\);/);
  assert.match(app, /cancelAnimationFrame\(frame\);/);
});
