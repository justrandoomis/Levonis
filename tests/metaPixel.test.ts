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
import { isMetaPixelPath, META_PIXEL_ID, META_PIXEL_SCRIPT_URL, startMetaPixel, trackMetaPageView } from '../src/lib/metaPixel';

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

test('the pixel starts with automatic events and history tracking off, no advanced matching, and loads Meta after the page', () => {
  const appended: Array<{ src: string; async: boolean }> = [];
  const win: Record<string, unknown> = { requestIdleCallback: (fn: () => void) => fn(), addEventListener: () => assert.fail('the page had already loaded') };
  const doc = { readyState: 'complete', createElement: () => ({ src: '', async: false }), head: { appendChild: (s: { src: string; async: boolean }) => appended.push(s) } };
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, document: g.document };
  g.window = win;
  g.document = doc;
  try {
    startMetaPixel();
    startMetaPixel(); // idempotent
    trackMetaPageView();
    const fbq = win.fbq as { queue: unknown[][]; disablePushState?: boolean };
    assert.equal(fbq.disablePushState, true, 'fbevents must not send its own PageView on every history change');
    assert.deepEqual(fbq.queue, [
      ['set', 'autoConfig', false, META_PIXEL_ID],
      ['init', META_PIXEL_ID],
      ['trackSingle', META_PIXEL_ID, 'PageView'],
    ], 'autoConfig off BEFORE init; init with the id alone (no advanced matching); PageView only, by trackSingle (track is deduplicated per load)');
    assert.equal(win._fbq, win.fbq);
    assert.deepEqual(appended, [{ src: META_PIXEL_SCRIPT_URL, async: true }], 'one async script, once');
    assert.equal(META_PIXEL_ID, '906446185408755');
    assert.equal(META_PIXEL_SCRIPT_URL, 'https://connect.facebook.net/en_US/fbevents.js');
  } finally {
    g.window = saved.window;
    g.document = saved.document;
  }
});

test('main site only: nothing is decided before the server names the host, and a store host loads nothing', () => {
  const component = read('src/components/MetaPixel.tsx');
  assert.match(component, /const mainSite = resolved && !store && !unknownStore && !unavailableStore && !system;/);
  assert.match(component, /if \(!resolved \|\| decided\.current === pathname\) return;/);
  assert.match(component, /if \(!mainSite \|\| !isMetaPixelPath\(pathname\)\) return;[\s\S]*?if \(window\.location\.pathname !== pathname\) return;\s*startMetaPixel\(\);\s*trackMetaPageView\(\);/,
    'a redirect that already moved the browser (a guest at /cart -> /auth) is not reported under the private address');
  assert.ok(!component.includes('location.hostname'), 'the host is the server\'s answer (src/StoreContext.tsx)');
  const app = read('src/App.tsx');
  assert.ok(app.indexOf('<MetaPixel />') > app.indexOf('<StoreProvider>') && app.indexOf('<MetaPixel />') < app.indexOf('</StoreProvider>'), 'mounted inside StoreProvider (and so inside the router)');
});

test('the shared document carries no Meta snippet: nothing inline, nothing that fires on a store host', () => {
  const html = read('index.html');
  for (const s of ['fbq', 'fbevents', 'facebook.com/tr']) assert.ok(!html.includes(s), s);
});
