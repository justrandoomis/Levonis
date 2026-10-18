/**
 * THE MERCHANT WORKSPACE'S ADDRESSES (packages/contracts/src/merchantRoutes.ts):
 * one spelling for the Worker that writes notification links and the SPA that
 * routes them.
 *
 * Run: node --import tsx --test tests/merchantRoutes.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import {
  MERCHANT_BASE,
  SECTION_PATHS,
  STORE_HOST_BASE,
  hostPath,
  isMerchantLink,
  merchantHref,
  parseMerchantPath,
  readWorkspaceQuery,
  type MerchantSection,
} from '../packages/contracts/src/merchantRoutes';
import { LIST_PAGES_MAX, LIST_SEARCH_MAX, ordersViewHref, readOrdersView } from '../src/components/merchant/orders/ordersView';

test('every destination the plan lists (§4.6) has a builder, and the builders say what the brief says', () => {
  assert.equal(merchantHref.home(), '/merchant');
  assert.equal(merchantHref.order('ORD-1A2B'), '/merchant/orders/ORD-1A2B');
  assert.equal(merchantHref.product('cp_9'), '/merchant/products/cp_9');
  assert.equal(merchantHref.thread('chat_abc'), '/merchant/inbox/chat_abc');
  assert.equal(merchantHref.request('req_1'), '/merchant/requests/req_1');
  assert.equal(merchantHref.customOrder('cord_1'), '/merchant/requests/orders/cord_1');
  assert.equal(merchantHref.money(), '/merchant/money');
  assert.equal(merchantHref.reviews(), '/merchant/reviews');
  assert.equal(merchantHref.notifications(), '/merchant/notifications');
  assert.equal(merchantHref.coupon('cpn_1'), '/merchant/marketing/coupons/cpn_1');
  assert.equal(merchantHref.storeDesign(), '/merchant/store/design');
  assert.equal(merchantHref.storeSettings(), '/merchant/store/settings');
  assert.equal(merchantHref.storeDelivery(), '/merchant/store/delivery');
  for (const s of ['customers', 'inbox', 'collections', 'services', 'showcase', 'printers', 'costing', 'requests', 'analytics'] as const) {
    assert.equal((merchantHref as unknown as Record<string, () => string>)[s](), `/merchant/${s}`);
  }
});

test('every section round-trips through the parser, with and without an object id', () => {
  for (const section of Object.keys(SECTION_PATHS) as MerchantSection[]) {
    const path = SECTION_PATHS[section];
    const base = path ? `${MERCHANT_BASE}/${path}` : MERCHANT_BASE;
    assert.deepEqual(parseMerchantPath(base), { section }, base);
    assert.deepEqual(parseMerchantPath(`${base}/`), { section }, `${base}/`);
  }
  assert.deepEqual(parseMerchantPath(merchantHref.order('ORD-1')), { section: 'orders', id: 'ORD-1' });
  assert.deepEqual(parseMerchantPath(merchantHref.customOrder('cord_7')), { section: 'custom_orders', id: 'cord_7' });
  assert.deepEqual(parseMerchantPath(merchantHref.request('req_7')), { section: 'requests', id: 'req_7' });
  assert.deepEqual(parseMerchantPath('/merchant/orders/ORD-1?from=bell#x'), { section: 'orders', id: 'ORD-1' }, 'a query or hash is ignored');
  // The same tree on a store's own host.
  assert.deepEqual(parseMerchantPath('/admin/inbox/chat_1', STORE_HOST_BASE), { section: 'inbox', id: 'chat_1' });
});

test('an id is a plain token: a builder never produces, and the parser never accepts, a path that smuggles anything', () => {
  assert.equal(merchantHref.order('../../admin'), '/merchant/orders', 'a bad id falls back to the list, never to a traversal');
  assert.equal(merchantHref.order('x?y=1'), '/merchant/orders');
  assert.equal(merchantHref.order(''), '/merchant/orders');
  assert.equal(parseMerchantPath('/merchant/orders/a/b'), null);
  assert.equal(parseMerchantPath('/merchant/orders/%2e%2e%2fadmin'), null);
  assert.equal(parseMerchantPath('/merchant/orders/%2e%2e'), null, 'dots alone are a path segment, not an id');
  assert.equal(parseMerchantPath('/merchant/orders/..'), null);
  assert.equal(merchantHref.order('..'), '/merchant/orders');
  assert.deepEqual(parseMerchantPath('/merchant/orders/ORD.1'), { section: 'orders', id: 'ORD.1' }, 'a dot inside an id is fine');
  assert.equal(parseMerchantPath('/merchant/money/123'), null, 'a section without objects takes no id');
  assert.equal(parseMerchantPath('/merchant/unknown'), null);
  assert.equal(parseMerchantPath('/merchantx'), null);
  assert.equal(parseMerchantPath('/requests?request=1'), null);
  assert.equal(isMerchantLink('/merchant/orders/ORD-1'), true);
  assert.equal(isMerchantLink('https://evil.example/merchant'), false);
});

test('hostPath re-bases a stored link on a store host and leaves everything else alone', () => {
  assert.equal(hostPath('/merchant/orders/ORD-1', true), '/admin/orders/ORD-1');
  assert.equal(hostPath('/merchant', true), '/admin');
  assert.equal(hostPath('/merchant/orders/ORD-1', false), '/merchant/orders/ORD-1');
  assert.equal(hostPath('/requests?request=r1', true), '/requests?request=r1');
  assert.equal(hostPath('/merchantx', true), '/merchantx');
});

test('the SPA uses the same module, and every section lands on a screen of the workspace (no dead link)', () => {
  const reexport = readFileSync(join(ROOT, 'src/lib/merchantRoutes.ts'), 'utf8');
  assert.match(reexport, /export \* from '\.\.\/\.\.\/packages\/contracts\/src\/merchantRoutes'/);
  // W3-A: the URL→tab adapter became the workspace's router; every section is a lazy screen.
  const screens = readFileSync(join(ROOT, 'src/components/merchant/shell/sections.tsx'), 'utf8');
  for (const section of Object.keys(SECTION_PATHS)) {
    assert.match(screens, new RegExp(`\\n  ${section}: (lazy|section)\\(`), `section ${section} has no screen`);
  }
  const app = readFileSync(join(ROOT, 'src/App.tsx'), 'utf8');
  assert.match(app, /path="\/merchant\/\*"/, 'the apex serves the tree');
  assert.match(app, /path="\/admin\/\*"/, 'a store host serves the tree under /admin');
});

test('THE ORDERS LIST\'S STATE IS ITS ADDRESS: tab, search and open pages write and read back the same, and nothing else gets in', () => {
  // The writer (src/components/merchant/orders/ordersView.ts) writes only what the reader takes back.
  assert.equal(ordersViewHref({}), '/merchant/orders');
  assert.equal(ordersViewHref({ status: 'pending' }), merchantHref.ordersInStatus('pending'), 'the Command Center\'s door and the list\'s own address are one spelling');
  assert.equal(ordersViewHref({ status: 'shipped', q: 'نور', pages: 3 }), '/merchant/orders?status=shipped&q=%D9%86%D9%88%D8%B1&pages=3');
  assert.equal(ordersViewHref({ status: 'evil', q: '   ', pages: 1 }), '/merchant/orders', 'an unknown tab, an empty search and one page are no words at all');
  assert.equal(ordersViewHref({ pages: 99 }), `/merchant/orders?pages=${LIST_PAGES_MAX}`, 'a depth is clamped, never unbounded');
  assert.equal(ordersViewHref({ q: 'x'.repeat(LIST_SEARCH_MAX + 1) }), '/merchant/orders', 'a search the server would refuse is not written');
  assert.equal(ordersViewHref({ q: '#A1&status=x' }), '/merchant/orders?q=%23A1%26status%3Dx', 'a search is one encoded word — it cannot add a second');

  // Round trip: what the list writes, the address gives back — and the shell's reader agrees on the tab.
  for (const view of [{ status: 'confirmed' as const }, { q: 'ORD-1A' }, { status: 'delivered' as const, q: '0770 12', pages: 4 }]) {
    const link = ordersViewHref(view);
    assert.ok(parseMerchantPath(link), link);
    assert.deepEqual(readOrdersView(link.split('?')[1]), view, link);
    assert.equal(readWorkspaceQuery(link.split('?')[1]).status, 'status' in view ? view.status : undefined, 'the shell reads the same tab');
    assert.equal(hostPath(link, true).startsWith('/admin/orders'), true, 'a store host serves the same list under /admin');
  }

  // The reader's bounds: the closed status list; trimmed, at most LIST_SEARCH_MAX characters, no control characters; pages 2..max.
  assert.deepEqual(readOrdersView('?status=evil&x=1'), {});
  assert.equal(LIST_SEARCH_MAX, 60, 'the server\'s own bound (worker/routes/merchantWorkspace.ts SEARCH_MAX)');
  assert.equal(readOrdersView('?q=%20%20n%C5%ABr%20').q, 'nūr');
  assert.equal(readOrdersView(`?q=${'x'.repeat(LIST_SEARCH_MAX)}`).q, 'x'.repeat(LIST_SEARCH_MAX));
  assert.equal(readOrdersView(`?q=${'x'.repeat(LIST_SEARCH_MAX + 1)}`).q, undefined);
  assert.equal(readOrdersView('?q=a%0Ab').q, undefined, 'a control character is no search');
  assert.equal(readOrdersView('?q=').q, undefined);
  assert.equal(readOrdersView('?pages=1').pages, undefined, 'one page is the default and is never carried');
  assert.equal(readOrdersView('?pages=3').pages, 3);
  assert.equal(readOrdersView('?pages=500').pages, LIST_PAGES_MAX);
  for (const bad of ['0', '-2', '2.5', 'x', '1e3', '9999']) assert.equal(readOrdersView(`?pages=${bad}`).pages, undefined, bad);
  // The contract's own words are untouched: the shell's reader still knows only its closed lists.
  assert.deepEqual(readWorkspaceQuery('?status=pending&q=x&pages=3'), { create: false, status: 'pending' });
});

test('the orders section writes the list\'s state with replace (a typed search is not a history step), and the order screen goes back to it', () => {
  const section = readFileSync(join(ROOT, 'src/components/merchant/shell/sections/OrdersSection.tsx'), 'utf8');
  assert.match(section, /onViewChange=\{\(view: OrdersView\) => ws\.go\(ordersViewHref\(view\), \{ replace: true \}\)\}/);
  assert.match(section, /const query = useMemo\(\(\) => readOrdersView\(search\), \[search\]\);/, 'the section reads the list\'s words from the address on every change');
  assert.match(section, /initialQuery=\{query\.q \?\? ''\}/);
  assert.match(section, /initialPages=\{query\.pages \?\? 1\}/);
  assert.match(section, /backHref=\{ws\.href\(back\)\}/, 'the order screen\'s «all orders» is the list as it was left');
  assert.match(section, /lastList\?\.store === ws\.store\.id/, 'and only ever this store\'s list');
  const detail = readFileSync(join(ROOT, 'src/components/merchant/orders/OrderDetailScreen.tsx'), 'utf8');
  assert.match(detail, /<Link to=\{backHref \?\? ws\.href\(merchantHref\.orders\(\)\)\}/);
});
