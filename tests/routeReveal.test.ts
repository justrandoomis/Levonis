/**
 * A ROUTE WHOSE CODE HAS ARRIVED IS SHOWN NOW (speed audit 2026-10-16, the
 * lazy-route finding): no Suspense frame for a module already in memory, no
 * 300 ms retry-lane hold for one that lands while the fallback is up, and the
 * product route's fallback is the product page's own loading screen.
 * src/lib/routeReveal.ts says why; this file holds it.
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Suspense, createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { prefetchable, routeReveal } from '../src/lib/routeReveal';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const page = () => createElement('p', null, 'the page');
type Lazy = ComponentType & { preload: () => void; _payload: { _status: number }; _init: (p: unknown) => unknown };
const tick = () => new Promise((r) => setTimeout(r, 0));
const releases: Array<() => void> = [];
afterEach(() => {
  while (releases.length) releases.pop()!();
});

test('a route module already in memory renders in the same pass — no fallback frame', async () => {
  const Page = prefetchable(() => Promise.resolve({ default: page })) as unknown as Lazy;
  Page.preload();
  await tick();
  const html = renderToStaticMarkup(createElement(Suspense, { fallback: 'FALLBACK' }, createElement(Page)));
  assert.equal(html, '<p>the page</p>', 'React.lazy suspended on a module it already had');
});

test('a module still loading shows the fallback, as before', () => {
  const Page = prefetchable(() => new Promise<{ default: () => ReturnType<typeof page> }>(() => {})) as unknown as Lazy;
  const html = renderToStaticMarkup(createElement(Suspense, { fallback: 'FALLBACK' }, createElement(Page)));
  assert.equal(html, 'FALLBACK');
});

test('a module that lands while a fallback is held re-renders the shell, after React has marked it resolved', async () => {
  let land!: (m: { default: typeof page }) => void;
  const Page = prefetchable(() => new Promise<{ default: typeof page }>((r) => { land = r; })) as unknown as Lazy;
  // React renders the route: its lazy initializer starts the load and suspends.
  assert.throws(() => Page._init(Page._payload));
  releases.push(routeReveal.hold());
  const before = routeReveal.snapshot();
  const seen: number[] = [];
  const unsubscribe = routeReveal.subscribe(() => {
    // The shell's update renders a microtask later; by then React's own
    // reaction must have resolved the lazy component, or it would suspend again.
    queueMicrotask(() => seen.push(Page._payload._status));
  });
  land({ default: page });
  await tick();
  unsubscribe();
  assert.equal(routeReveal.snapshot(), before + 1, 'the shell was told');
  assert.deepEqual(seen, [1], 'the update that reveals the route sees it resolved (1), never pending (0)');
});

test('nothing re-renders when no fallback is waiting (an idle or pointer-down prefetch)', async () => {
  const Page = prefetchable(() => Promise.resolve({ default: page })) as unknown as Lazy;
  const before = routeReveal.snapshot();
  let calls = 0;
  const unsubscribe = routeReveal.subscribe(() => { calls += 1; });
  Page.preload();
  await tick();
  unsubscribe();
  assert.equal(routeReveal.waiting(), 0);
  assert.equal(calls, 0);
  assert.equal(routeReveal.snapshot(), before);
  // A release is idempotent.
  const release = routeReveal.hold();
  release();
  release();
  assert.equal(routeReveal.waiting(), 0);
});

test('a failed load is retried by the next render, never an unhandled rejection', async () => {
  let attempts = 0;
  const Page = prefetchable((): Promise<{ default: typeof page }> => {
    attempts += 1;
    return attempts === 1 ? Promise.reject(new Error('offline')) : Promise.resolve({ default: page });
  }) as unknown as Lazy;
  Page.preload();
  await tick();
  Page.preload();
  await tick();
  assert.equal(attempts, 2);
  assert.equal(renderToStaticMarkup(createElement(Suspense, { fallback: 'FALLBACK' }, createElement(Page))), '<p>the page</p>');
});

test('the app shell: fallbacks hold, the shell subscribes, the opening route is asked for with the entry, and the product route draws its own loading screen', () => {
  const app = read('src/App.tsx');
  assert.match(app, /import \{ prefetchable, routeReveal \} from '\.\/lib\/routeReveal';/);
  assert.match(app, /const RouteFallback = [\s\S]{0,600}React\.useLayoutEffect\(\(\) => routeReveal\.hold\(\), \[\]\);/);
  assert.match(app, /React\.useSyncExternalStore\(routeReveal\.subscribe, routeReveal\.snapshot, routeReveal\.snapshot\);/);
  // The documents the Worker rewrites, and the pages their chunks are preloaded for.
  for (const page of ['Product', 'Products', 'BundleDetail', 'Storefront', 'StorefrontProduct', 'CategoriesExplorer', 'CategoryPage', 'CategoryListing', 'Community']) {
    assert.match(app, new RegExp(`const ${page} = prefetchable\\(\\(\\) => import\\('\\./pages/${page}'\\)\\);`), `${page} is not a revealable route`);
  }
  assert.match(app, /preload\(openingRouteModule\(window\.location\.pathname, host\)\);/);
  assert.ok(app.includes('if (/^\\/product\\/[^/]+\\/?$/.test(path)) return Product;'), 'a product document asks for the product page');
  assert.ok(app.includes('if (/^\\/p\\/[^/]+\\/?$/.test(path)) return StorefrontProduct;'), "a store's product document asks for the store's product page");
  // The product route's fallback is Product.tsx's own loading screen: the bar and the skeleton, on the page's ground.
  const fallback = app.slice(app.indexOf('const RouteFallback'), app.indexOf('const preload ='));
  assert.match(fallback, /if \(productHeader\) \{[\s\S]*<MotionCharacterRouteHeader busy \/>\s*<div className="pb-10">\s*<ProductDetailSkeleton \/>/);
  // On the ground of the shell, like the pages that replace it: no flat fill over the light of the canvas.
  assert.doesNotMatch(fallback, /className="[^"]*\bbg-black\b/);
  const product = read('src/pages/Product.tsx');
  assert.match(product, /<MotionCharacterHome busy=\{loading\} \/>[\s\S]{0,200}<div className="pb-10">\s*\{loading \? \(\s*<ProductDetailSkeleton \/>/, 'Product.tsx draws the same skeleton while its data loads');
});
