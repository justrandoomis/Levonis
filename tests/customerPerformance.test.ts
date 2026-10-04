import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { LanguageProvider } from '../src/LanguageContext';
import { CurrencyProvider } from '../src/CurrencyContext';
import { WalletProvider } from '../src/WalletContext';
import { AuthContext } from '../src/AuthContext';
import PromoPhoto from '../src/components/home/v2/PromoPhoto';
import CategoryBento from '../src/components/home/v2/CategoryBento';
import ProductCard from '../src/components/home/ProductCard';
import ChunkBoundary from '../src/components/ChunkBoundary';
import { api, type ApiProduct } from '../src/lib/api';
import { type BentoTile } from '../src/lib/homeLayout';
import { bentoImageSizes } from '../src/lib/homeImageSizes';
import { variantSrcSet } from '../src/components/ui/SafeImage';
import { bootRequests, clearPrimedRequests, primeGet, takePrimedJson } from '../src/lib/bootFetch';
import { productImagePreload, injectDocumentPreloads } from '../worker/lib/socialPreview';
import { PRODUCT_GALLERY_SIZES } from '../packages/contracts/src/imageSizing';

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterEach(() => {
  clearPrimedRequests();
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});
const browser = () => Object.defineProperty(globalThis, 'window', { value: {}, configurable: true });
const render = (child: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(LanguageProvider, { children: createElement(MemoryRouter, null, child) }));

test('promo photo selects one responsive light/phone file and prioritizes only the chosen LCP', () => {
  const html = render(createElement(PromoPhoto, {
    src: '/files/products/dark.webp', lightSrc: '/files/products/light.webp',
    mobileSrc: '/files/products/phone-dark.webp', lightMobileSrc: '/files/products/phone-light.webp',
    crop: false, className: 'inset-0', width: 560, height: 560, eager: true, sizes: '400px',
  }));
  const photo = html.match(/<img[^>]*>/)?.[0] ?? '';
  assert.match(photo, /src="\/files\/products\/light.webp"/);
  assert.match(photo, /srcSet="\/files\/products\/light.webp\?w=320 320w/);
  assert.match(photo, /loading="eager"/);
  assert.match(photo, /fetchPriority="high"/);
  assert.match(html, /<source media="\(max-width: 639px\)" srcSet="\/files\/products\/phone-light.webp\?w=320 320w/);
  assert.match(html, /sizes="400px"/);
  assert.doesNotMatch(html, /src(?:Set)?="[^"\n]*dark.webp/);
  const gif = render(createElement(PromoPhoto, { src: '/files/products/motion.gif', crop: false, className: 'inset-0', width: 100, height: 100, sizes: '100px' }));
  assert.doesNotMatch(gif, /srcSet=|\?w=/);
});

test('bento eagerly loads the large tile while preserving cropped image resolution and lazy neighbours', () => {
  const tile = (position: BentoTile['position'], id: BentoTile['id']): BentoTile => ({
    position, id, to: '/categories/printers', category: null, title: null,
    image: `/files/products/${position}.webp`, lightImage: '', mobileImage: '', lightMobileImage: '', imageProductId: position,
  });
  const html = render(createElement(CategoryBento, { tiles: [tile('top-1', 'filament'), tile('bottom-1', 'parts'), tile('large', 'printers')] }));
  const images = [...html.matchAll(/<img[^>]*>/g)].map((m) => m[0]);
  assert.equal(images.filter((image) => image.includes('loading="eager"')).length, 1);
  assert.match(images.find((image) => image.includes('/large.webp')) ?? '', /fetchPriority="high"/);
  assert.equal(images.filter((image) => image.includes('loading="lazy"')).length, 2);
  const sizes = bentoImageSizes({ position: 'large', crop: true, hasLarge: true, topCount: 1, bottomCount: 1 });
  assert.match(sizes, /max\(377\.358px,/); // 200px / .53: the studio middle band, not its 134px tile width.
  assert.match(sizes, /min\(/); // Preserve the 1920px shell cap on wide screens.
});

test('a 148px rail requests a rail-sized variant while grid slots retain responsive sizes', () => {
  const p = { id: 'p', slug: 'p', name: 'Printer', images: ['/files/products/p.webp'], price_iqd: 5000, membership_prices: {}, options: [], colors: [] } as unknown as ApiProduct;
  const card = (width: 'rail' | 'fill') => renderToStaticMarkup(createElement(AuthContext.Provider, {
    value: { isAuthenticated: false, user: null, isLoaded: true, login: async () => {}, loginWithGoogle: async () => {}, register: async () => {}, refreshUser: async () => {}, logout: async () => {} },
    children: createElement(WalletProvider, { children: createElement(CurrencyProvider, { children: createElement(LanguageProvider, { children: createElement(MemoryRouter, null, createElement(ProductCard, { p, density: 'compact', width })) }) }) }),
  }));
  assert.match(card('rail'), /sizes="148px"/);
  assert.doesNotMatch(card('rail'), /sizes="[^"]*50vw/);
  assert.match(card('fill'), /sizes="\(min-width: 1280px\)/);
});

test('product preload matches the gallery candidates and sizes; private, animated and queried files do not resize', () => {
  const image = '/files/products/a.webp';
  const preload = productImagePreload(image);
  assert.equal(preload.imageSrcSet, variantSrcSet(image));
  assert.equal(preload.imageSizes, PRODUCT_GALLERY_SIZES);
  const html = injectDocumentPreloads('<head></head>', { scripts: [], styles: [], image, resolve: null, ...preload });
  assert.match(html, /imagesrcset="\/files\/products\/a.webp\?w=320 320w/);
  assert.match(html, /imagesizes="\(min-width: 1540px\) 988px/);
  for (const source of ['/files/finance/secret.webp', '/files/products/a.gif', '/files/products/a.webp?token=secret', 'https://external.example/a.webp']) assert.deepEqual(productImagePreload(source), {});
});

test('opening catalogue requests start before React only on the canonical main host, with exact query identity', () => {
  const start = (path: string, host: string, inline: { kind?: unknown } | null = { kind: 'main' }, search = '') => bootRequests(path, inline, () => {}, search, host);
  assert.deepEqual(start('/products', 'levonis-iq.com', null, '?category=x&search=PLA&offset=50&sort=old'), ['/api/storefront/resolve', '/api/products?search=PLA&category=x&limit=50']);
  assert.deepEqual(start('/product/bambu-lab-a1', 'www.levonis-iq.com'), ['/api/products/bambu-lab-a1']);
  for (const host of ['shop.levonis-iq.com', 'printer.example', 'levonis-iq.com.evil.example']) {
    assert.deepEqual(start('/products', host), []);
    assert.deepEqual(start('/product/x', host), []);
  }
  assert.deepEqual(start('/product/x', 'levonis-iq.com', { kind: 'merchant' }), []);
  assert.deepEqual(start('/admin/finance', 'levonis-iq.com'), []);
});

test('an opening answer is consumed once and replaced if the session changes while it is in flight', async () => {
  browser();
  let finish: (response: Response) => void = () => {};
  let requests = 0;
  globalThis.fetch = ((_path: unknown, options: RequestInit) => {
    assert.equal(options.credentials, 'same-origin');
    requests += 1;
    return requests === 1 ? new Promise<Response>((resolve) => { finish = resolve; }) : Promise.resolve(Response.json({ success: true, price_iqd: 9000 }));
  }) as typeof fetch;
  const path = '/api/products/session-case';
  primeGet(path);
  const answer = takePrimedJson<{ price_iqd: number }>(path);
  assert.ok(answer);
  assert.equal(takePrimedJson(path), null, 'not a response cache');
  clearPrimedRequests();
  finish(Response.json({ success: true, price_iqd: 5000 }));
  assert.equal((await answer).price_iqd, 9000);
  assert.equal(requests, 2);
});

test('a primed response with headers but a stalled JSON body has a deadline', async () => {
  browser();
  globalThis.fetch = ((_path: unknown, options: RequestInit) => Promise.resolve({
    ok: true, status: 200,
    json: () => new Promise((_resolve, reject) => {
      const signal = options.signal!;
      if (signal.aborted) reject(new DOMException('Aborted', 'AbortError'));
      else signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }),
  } as Response)) as typeof fetch;
  primeGet('/api/products/stalled-body', 15);
  await assert.rejects(takePrimedJson('/api/products/stalled-body')!, /Invalid server response/);
});

test('a session fallback bypasses an ordinary GET still pending from the old session', async () => {
  browser();
  const pending: Array<(response: Response) => void> = [];
  let requests = 0;
  globalThis.fetch = (() => {
    requests += 1;
    return requests <= 2 ? new Promise<Response>((resolve) => { pending.push(resolve); }) : Promise.resolve(Response.json({ success: true, viewer: 'new-member' }));
  }) as typeof fetch;
  const path = '/api/products/old-coalesced-request';
  primeGet(path);
  const opening = takePrimedJson<{ viewer: string }>(path)!;
  const ordinary = api.get<{ viewer: string }>(path);
  clearPrimedRequests();
  pending[0](Response.json({ success: true, viewer: 'old-member' }));
  assert.equal((await opening).viewer, 'new-member');
  assert.equal(requests, 3, 'a fresh-session request left even while the old ordinary GET was in flight');
  pending[1](Response.json({ success: true, viewer: 'old-member' }));
  await ordinary;
});

test('an unconsumed opening response expires, so a late route fetches current price instead of an abandoned answer', async () => {
  browser();
  let requests = 0;
  globalThis.fetch = (() => { requests += 1; return Promise.resolve(Response.json({ success: true, price_iqd: requests === 1 ? 5000 : 9000 })); }) as typeof fetch;
  const path = '/api/products/abandoned-opening';
  primeGet(path, 10);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(takePrimedJson(path), null);
  assert.equal((await api.get<{ price_iqd: number }>(path)).price_iqd, 9000);
  assert.equal(requests, 2);
});

test('an optional chunk failure stays in its own section or dismissible dialog instead of replacing the product page', () => {
  const boundary = new ChunkBoundary({ children: null, compact: true, renderFallback: (content) => createElement('section', { 'data-failed-dialog': true }, content) });
  boundary.state = { failed: true };
  const html = renderToStaticMarkup(boundary.render());
  assert.match(html, /data-failed-dialog/);
  assert.match(html, /role="alert"/);
  assert.doesNotMatch(html, /min-h-dvh/);
  const route = new ChunkBoundary({ children: null });
  route.state = { failed: true };
  assert.match(renderToStaticMarkup(route.render()), /min-h-dvh/, 'the route-level failure remains full-screen');
});
