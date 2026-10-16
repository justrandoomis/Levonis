/**
 * A GRID LOADS ITS FIRST SCREEN AT ONCE AND THE REST AS IT NEARS THE SCREEN
 * (speed audit 2026-10-16, «/products downloads 16 of 26 card images before
 * any scroll; 2 of the 6 visible cards are lazy and fade in»).
 *
 *  - src/lib/productCard.ts `gridImageLoading`: the first screen eager (no
 *    lazy start, no fade), `high` priority only for the lead row's two cards,
 *    every later card deferred;
 *  - SafeImage `defer` (src/lib/nearViewport.ts): a deferred picture is not
 *    requested until it is within NEAR_PX of the screen IN ITS SCROLLER
 *    (`#main-scroll-container`), and one released while already on the screen
 *    is not faded in;
 *  - /products' grid (six on a phone's first screen) and the listings' grid
 *    (four) use it.
 *
 * The browser half renders the real SafeImage in a 360×800 phone scroller with
 * /products' geometry (rows every 268 px from 86 px) in Chromium; it is a skip,
 * not a failure, where Playwright's Chromium is not installed.
 *
 * Run: node --import tsx --test tests/gridImageLoading.test.ts
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';
import { ROOT } from './fixtures/d1';
import { GRID_LEAD_CARDS, gridImageLoading } from '../src/lib/productCard';
import { NEAR_PX } from '../src/lib/nearViewport';
import SafeImage from '../src/components/ui/SafeImage';
import { LanguageProvider } from '../src/LanguageContext';

const src = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

test('the first screen is eager, only the lead row is high priority, everything after it waits', () => {
  const six = Array.from({ length: 10 }, (_, i) => gridImageLoading(i, 6));
  assert.deepEqual(six.map((x) => x.eager), [true, true, true, true, true, true, false, false, false, false]);
  assert.deepEqual(six.map((x) => x.deferImage), six.map((x) => !x.eager), 'a card is eager or deferred, never plain lazy');
  assert.deepEqual(six.map((x) => x.fetchPriority), ['high', 'high', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto']);
  assert.equal(GRID_LEAD_CARDS, 2);
  // The audit's phone shows three rows of /products (tops 86 / 354 / 622) and two of a listing's grid (it starts ~240 px down).
  assert.match(src('src/pages/Products.tsx'), /const FIRST_SCREEN_CARDS = 6;/);
  assert.match(src('src/pages/Products.tsx'), /<ProductCard p=\{p\} density="compact" compareToggle \{\.\.\.gridImageLoading\(i, FIRST_SCREEN_CARDS\)\} \/>/);
  assert.match(src('src/components/listing/ProductGrid.tsx'), /const FIRST_SCREEN_CARDS = 4;/);
  assert.match(src('src/components/listing/ProductGrid.tsx'), /\{\.\.\.gridImageLoading\(i, FIRST_SCREEN_CARDS\)\}/);
  assert.match(src('src/components/listing/ProductList.tsx'), /eager=\{i < 4\}\s+defer=\{i >= 4\}/);
  // The card hands both through to its picture.
  const card = src('src/components/home/ProductCard.tsx');
  assert.match(card, /fetchPriority=\{fetchPriority\}\s+defer=\{deferImage\}/);
});

const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(LanguageProvider, null, el));

test('SafeImage: a deferred picture renders its placeholder and no request; priority is the caller\'s, high by default when eager', () => {
  const held = html(createElement(SafeImage, { src: '/files/products/a.webp', defer: true, sizes: '100px' }));
  assert.doesNotMatch(held, /<img/, 'nothing is requested before it nears the screen');
  assert.match(held, /animate-pulse/, 'the same pending surface a lazy picture shows');
  const lead = html(createElement(SafeImage, { src: '/files/products/a.webp', eager: true, sizes: '100px' }));
  assert.match(lead, /fetchPriority="high"|fetchpriority="high"/i);
  assert.match(lead, /loading="eager"/);
  assert.doesNotMatch(lead, /duration-300/, 'an eager picture is never faded in');
  const row3 = html(createElement(SafeImage, { src: '/files/products/a.webp', eager: true, fetchPriority: 'auto', sizes: '100px' }));
  assert.match(row3, /fetchPriority="auto"|fetchpriority="auto"/i);
  assert.match(row3, /loading="eager"/);
  // `defer` never holds an eager picture back.
  assert.match(html(createElement(SafeImage, { src: '/files/products/a.webp', eager: true, defer: true, sizes: '100px' })), /<img/);
  assert.equal(NEAR_PX, 300, 'about one 268 px grid row');
});

// ------------------------------------------------------------ in Chromium

interface PwPage {
  goto(url: string): Promise<unknown>;
  waitForFunction(fn: string, arg?: unknown, o?: { timeout: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate<T>(fn: string): Promise<T>;
}
interface PwRoute {
  request(): { url(): string };
  fulfill(o: { status: number; contentType: string; body: Buffer }): Promise<void>;
  continue(): Promise<void>;
  abort(): Promise<void>;
}
interface PwContext {
  newPage(): Promise<PwPage>;
  route(glob: string, cb: (r: PwRoute) => void): Promise<void>;
  close(): Promise<void>;
}
interface PwBrowser {
  newContext(o: { viewport: { width: number; height: number } }): Promise<PwContext>;
  close(): Promise<void>;
}

function loadChromium(): { launch(o: { args: string[] }): Promise<PwBrowser> } | null {
  const req = createRequire(import.meta.url);
  for (const id of [process.env.PLAYWRIGHT_MODULE, 'playwright', '/opt/node22/lib/node_modules/playwright'].filter(Boolean) as string[]) {
    try {
      const chromium = (req(id) as { chromium: { launch(o: { args: string[] }): Promise<PwBrowser>; executablePath(): string } }).chromium;
      if (!existsSync(chromium.executablePath())) continue;
      return chromium;
    } catch {
      /* next */
    }
  }
  return null;
}

/** /products on a phone: a 70 px bar, then two cards a row, a row every 268 px from 86 px. */
const ENTRY = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import SafeImage from '../src/components/ui/SafeImage';
import { LanguageProvider } from '../src/LanguageContext';
import { gridImageLoading } from '../src/lib/productCard';

function Grid() {
  return (
    <main id="main-scroll-container" style={{ height: '100vh', overflowY: 'auto' }}>
      <div style={{ height: 86 }} />
      <ul style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', rowGap: 10, columnGap: 10, padding: '0 16px', margin: 0, listStyle: 'none' }}>
        {Array.from({ length: 26 }, (_, i) => {
          const l = gridImageLoading(i, 6);
          return (
            <li key={i} data-card={i} style={{ height: 258 }}>
              <SafeImage src={'/files/products/card-' + i + '.webp'} alt="" aspect="auto" eager={l.eager} fetchPriority={l.fetchPriority} defer={l.deferImage} sizes="164px" className="card-img" />
            </li>
          );
        })}
      </ul>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<LanguageProvider><Grid /></LanguageProvider>);
`;
// The few utility classes SafeImage's box and picture use, so the grid lays out as on the site.
const HTML = '<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}.card-img{height:197px;width:100%}.relative{position:relative}.overflow-hidden{overflow:hidden}.absolute{position:absolute}.inset-0{inset:0}.w-full{width:100%}.h-full{height:100%}</style></head><body><div id="root"></div><script type="module" src="/grid.js"></script></body></html>';
// A 1×1 PNG: the requests are what is measured, not the pixels.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

const chromium = loadChromium();
let server: Server;
let base = '';
let browser: PwBrowser;
let js = '';

before(async () => {
  if (!chromium) return;
  const out = await build({
    stdin: { contents: ENTRY, resolveDir: join(ROOT, 'tests'), sourcefile: 'grid-harness.tsx', loader: 'tsx' },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', jsx: 'automatic', logLevel: 'silent',
    loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty', '.webp': 'empty', '.woff2': 'empty' },
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': JSON.stringify({ DEV: false, PROD: true, MODE: 'production', BASE_URL: '/', SSR: false }) },
  });
  js = out.outputFiles[0].text;
  server = createServer((req, res) => {
    if (req.url === '/grid.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      return res.end(js);
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(HTML);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/`;
  browser = await chromium.launch({ args: ['--no-sandbox'] });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise<void>((r) => server.close(() => r()));
});

const skip = chromium ? false : 'Playwright/Chromium not resolvable (set PLAYWRIGHT_MODULE)';

async function open(height: number): Promise<{ page: PwPage; context: PwContext; requested: Set<number> }> {
  const context = await browser.newContext({ viewport: { width: 360, height } });
  const requested = new Set<number>();
  await context.route('**/*', (route) => {
    const u = new URL(route.request().url());
    const card = /\/files\/products\/card-(\d+)\.webp/.exec(u.pathname);
    if (card) {
      requested.add(Number(card[1]));
      void route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    } else if (u.hostname === '127.0.0.1') void route.continue();
    else void route.abort();
  });
  const page = await context.newPage();
  await page.goto(base);
  await page.waitForFunction('document.querySelectorAll("[data-card]").length === 26', undefined, { timeout: 20_000 });
  await page.waitForTimeout(600);
  return { page, context, requested };
}

const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);

test('a phone requests its six visible cards and the next row only; scrolling releases the rest', { skip }, async () => {
  const { page, context, requested } = await open(800);
  // Rows at 86 / 354 / 622 are on screen; 890 is within 300 px of the fold, 1158 is not.
  assert.deepEqual(sorted(requested), [0, 1, 2, 3, 4, 5, 6, 7], 'native lazy loading fetched 16 here');
  const imgs = await page.evaluate<Array<{ card: number; loading: string; prio: string | null; fade: boolean }>>(
    `[...document.querySelectorAll('[data-card]')].map((li) => { const im = li.querySelector('img'); return im ? { card: +li.getAttribute('data-card'), loading: im.loading, prio: im.getAttribute('fetchpriority'), fade: /duration-300/.test(im.className) } : null; }).filter(Boolean)`
  );
  assert.deepEqual(imgs.slice(0, 6).map((x) => [x.loading, x.prio, x.fade]), [
    ['eager', 'high', false], ['eager', 'high', false],
    ['eager', 'auto', false], ['eager', 'auto', false], ['eager', 'auto', false], ['eager', 'auto', false],
  ], 'the first screen: eager, never faded, high only for the lead row');
  assert.deepEqual(imgs.slice(6).map((x) => x.fade), [true, true], 'released below the fold: it may fade in where nobody sees it start');
  await page.evaluate(`document.getElementById('main-scroll-container').scrollBy(0, 600)`);
  await page.waitForTimeout(600);
  // 600 px down: rows 1158 / 1426 / 1694 are now at 558 / 826 / 1094, all within 300 px of the 800 px fold.
  assert.deepEqual(sorted(requested), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], 'the rows that came near the screen, no further');
  // A thumb's scroll, a screen at a time: every card is asked for before it is reached.
  for (let i = 0; i < 12; i++) {
    await page.evaluate(`document.getElementById('main-scroll-container').scrollBy(0, 400)`);
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(400);
  assert.equal(requested.size, 26, 'every card loads by the end of the list');
  await context.close();
});

test('a deferred card that is already on a tall screen loads at once and is not faded', { skip }, async () => {
  const { page, context, requested } = await open(1300);
  // 1300 px: rows up to 1158 are on screen, 1426 is within 300 px.
  assert.deepEqual(sorted(requested), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  const fades = await page.evaluate<boolean[]>(
    `[6, 7, 8, 9, 10, 11].map((i) => /duration-300/.test(document.querySelector('[data-card="' + i + '"] img').className))`
  );
  assert.deepEqual(fades, [false, false, false, false, true, true], 'on screen when released: no fade; below the fold: fade');
  await context.close();
});
