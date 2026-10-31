/**
 * THE META PIXEL (src/lib/metaPixel.ts, src/components/MetaPixel.tsx).
 *
 * What these hold is what the privacy policy (version 4) tells customers:
 * public pages only, the main site only, PageView only, Meta's automatic
 * events off, no advanced matching, and nothing inline in the shared document.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isMetaPixelPath, META_EVENTS_PATH, META_PIXEL_ID, META_PIXEL_SCRIPT_URL, reportMetaViewContent, startMetaPixel, trackMetaPageView } from '../src/lib/metaPixel';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('public shopping and browsing pages are reported', () => {
  for (const path of [
    '/', '/products', '/product/bambu-a1-mini', '/categories', '/categories/printers', '/categories/printers/fdm',
    '/compare', '/used-printers', '/bundles', '/bundles/starter', '/cart', '/checkout',
    '/community', '/community/stores', '/community/makers', '/community/projects', '/community/projects/p_123',
    '/community/store/ali3d', '/community/store/ali3d/p/benchy', '/u/sara', '/tools', '/printer-finder',
    '/policies', '/policies/privacy', '/policy', '/products/', '/product/x/',
  ]) assert.ok(isMetaPixelPath(path), path);
});

test('private pages — and any page not listed — are never reported (Meta receives the address)', () => {
  for (const path of [
    '/admin', '/admin/orders', '/admin/creative-studio', '/merchant', '/merchant/orders/ORD-1', '/merchant/start',
    '/auth', '/welcome', '/settings', '/addresses', '/profile', '/edit-profile', '/wallet', '/subscription', '/points',
    '/orders', '/orders/ORD-2', '/chats', '/chat/c_1', '/warranty', '/warranty/WR-123', '/model-viewer/secret-token',
    '/invest', '/earnings', '/admin/invest', '/referrals', '/gifts', '/stock-alerts', '/saved-items', '/followed-stores',
    '/community/saved', '/community/following', '/community/projects/new', '/community/projects/p_1/edit',
    '/requests', '/requests/r_1', '/requests/new/x', '/games', '/support', '/store-checkout', '/a-route-added-later',
    '/trade-in', // the customer's own devices; ?request= / ?draft= carry their request ids
  ]) assert.ok(!isMetaPixelPath(path), path);
});

test('the pixel starts with automatic events and history tracking off, no advanced matching, and loads Meta after the page; the server gets the same event id', async () => {
  const appended: Array<{ src: string; async: boolean }> = [];
  const beacons: Array<{ url: string; body: Record<string, unknown> }> = [];
  let path = '/products';
  const win: Record<string, unknown> = {
    requestIdleCallback: (fn: () => void) => fn(),
    addEventListener: () => assert.fail('the page had already loaded'),
    location: { get pathname() { return path; } },
  };
  const doc = { readyState: 'complete', createElement: () => ({ src: '', async: false }), head: { appendChild: (s: { src: string; async: boolean }) => appended.push(s) } };
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, document: g.document, navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator') };
  g.window = win;
  g.document = doc;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { sendBeacon: (url: string, blob: { text?: () => Promise<string> } & Blob) => { void blob.text().then((t) => beacons.push({ url, body: JSON.parse(t) })); return true; } },
  });
  try {
    reportMetaViewContent('p_before'); // before the pixel started (off the main site): nothing
    startMetaPixel();
    startMetaPixel(); // idempotent
    trackMetaPageView();
    const fbq = win.fbq as { queue: unknown[][]; disablePushState?: boolean };
    assert.equal(fbq.disablePushState, true, 'fbevents must not send its own PageView on every history change');
    const [set, init, pageView] = fbq.queue;
    assert.deepEqual(set, ['set', 'autoConfig', false, META_PIXEL_ID], 'autoConfig off BEFORE init');
    assert.deepEqual(init, ['init', META_PIXEL_ID], 'init with the id alone: the browser sends no advanced matching');
    assert.equal(fbq.queue.length, 3, 'PageView is the browser pixel\'s only event');
    assert.deepEqual(pageView.slice(0, 4), ['trackSingle', META_PIXEL_ID, 'PageView', {}], 'by trackSingle (track is deduplicated per load)');
    const eventId = (pageView[4] as { eventID: string }).eventID;
    assert.match(eventId, /^[A-Za-z0-9_-]{8,64}$/);
    assert.equal(win._fbq, win.fbq);
    assert.deepEqual(appended, [{ src: META_PIXEL_SCRIPT_URL, async: true }], 'one async script, once');
    path = '/product/benchy';
    reportMetaViewContent('p_1');
    path = '/orders';
    reportMetaViewContent('p_2'); // a page that is not reported: nothing
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(beacons.map((b) => b.url), [META_EVENTS_PATH, META_EVENTS_PATH]);
    assert.deepEqual(beacons[0].body, { event: 'PageView', id: eventId, path: '/products' }, 'the server copy carries the pixel\'s own event id');
    assert.equal(beacons[1].body.event, 'ViewContent');
    assert.equal(beacons[1].body.product, 'p_1');
    assert.equal(beacons[1].body.path, '/product/benchy');
    assert.equal(META_PIXEL_ID, '906446185408755');
    assert.equal(META_PIXEL_SCRIPT_URL, 'https://connect.facebook.net/en_US/fbevents.js');
  } finally {
    g.window = saved.window;
    g.document = saved.document;
    if (saved.navigator) Object.defineProperty(globalThis, 'navigator', saved.navigator);
  }
});

test('main site only: nothing is decided before the server names the host, and a store host loads nothing', () => {
  const component = read('src/components/MetaPixel.tsx');
  assert.match(component, /const mainSite = resolved && !store && !unknownStore && !unavailableStore && !system;/);
  assert.match(component, /if \(!resolved \|\| decided\.current === pathname\) return;/);
  assert.match(component, /if \(!mainSite\) return;[\s\S]*?import\('\.\.\/lib\/metaPixel'\)\.then\(\(m\) => m\.reportMetaPage\(pathname\)\)/);
  assert.ok(!/^import .*lib\/metaPixel/m.test(component), 'the pixel module is a lazy chunk: the entry is every store page\'s download too');
  assert.ok(!/^import .*lib\/metaPixel/m.test(read('src/pages/Product.tsx')), 'the product page loads it lazily too');
  const lib = read('src/lib/metaPixel.ts');
  assert.match(lib, /export function reportMetaPage\(pathname: string\): void \{\s*if \(!isMetaPixelPath\(pathname\) \|\| currentPath\(\) !== pathname\) return;\s*startMetaPixel\(\);\s*trackMetaPageView\(\);/,
    'a page not listed starts nothing, and a redirect that already moved the browser (a guest at /cart -> /auth) is not reported under the private address');
  assert.ok(!component.includes('location.hostname'), 'the host is the server\'s answer (src/StoreContext.tsx)');
  const app = read('src/App.tsx');
  assert.ok(app.indexOf('<MetaPixel />') > app.indexOf('<StoreProvider>') && app.indexOf('<MetaPixel />') < app.indexOf('</StoreProvider>'), 'mounted inside StoreProvider (and so inside the router)');
});

test('the shared document carries no Meta snippet: nothing inline, nothing that fires on a store host', () => {
  const html = read('index.html');
  for (const s of ['fbq', 'fbevents', 'facebook.com/tr']) assert.ok(!html.includes(s), s);
});
