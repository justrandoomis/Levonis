/**
 * THE MERCHANT WORKSPACE SHELL (W3-A) — routes, the one nav table, the
 * palette's pure parts, the Command Center's figures, the own-host rule, the
 * shell's placement in App.tsx, and the rules its files must keep (no native
 * dialogs, no invented Sorani, one Toaster, one scroll owner, lazy screens).
 *
 * Run: node --import tsx --test tests/merchantWorkspaceShell.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import {
  MERCHANT_BASE,
  SECTION_PATHS,
  STORE_HOST_BASE,
  hostPath,
  merchantHref,
  parseMerchantPath,
  readWorkspaceQuery,
  type MerchantSection,
} from '../packages/contracts/src/merchantRoutes';
import { NAV, NAV_GROUPS, PHONE_TABS, badgeCount, moreEntries, navGroups, phoneTabFor, sectionPath, visibleNav } from '../src/components/merchant/shell/nav';
import { ROUTE_TABLE, resolveWorkspaceRoute } from '../src/components/merchant/shell/routeTable';
import { onOwnHost } from '../src/components/merchant/shell/ownHost';
import { isPaletteKey, paletteGroups, searchable, type SearchResults } from '../src/components/merchant/shell/paletteModel';
import { commandKpis } from '../src/components/merchant/shell/kpis';
import { storeStatus } from '../src/components/merchant/shell/status';
import { W } from '../src/components/merchant/shell/strings';
import { filterByQuery } from '../src/lib/listNav';
import type { MerchantMe } from '../src/lib/merchant';

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const ALL = Object.keys(SECTION_PATHS) as MerchantSection[];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (/\.(tsx?|ts)$/.test(name)) out.push(rel);
  }
  return out;
}

// ------------------------------------------------------ routes ↔ nav ↔ contract

test('the route table IS the contract, the nav table names every section once, and each nav path parses back to its section on both hosts', () => {
  assert.deepEqual(
    ROUTE_TABLE.map((r) => [r.section, r.path]),
    ALL.map((s) => [s, SECTION_PATHS[s]])
  );
  const ids = NAV.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'a section listed twice in the nav');
  assert.deepEqual([...ids].sort(), [...ALL].sort(), 'the nav and the contract list different sections');
  for (const e of NAV) {
    assert.deepEqual(parseMerchantPath(sectionPath(e.id)), { section: e.id }, e.id);
    assert.deepEqual(parseMerchantPath(sectionPath(e.id, STORE_HOST_BASE), STORE_HOST_BASE), { section: e.id }, `${e.id} on /admin`);
    assert.equal(e.capability, 'always', 'no gating was invented (brief §2)');
  }
});

test('every nav entry opens a LAZY screen', () => {
  // Read, not imported: importing the table would make the type-checker of
  // this suite walk every screen it lazily names.
  const table = code('src/components/merchant/shell/sections.tsx');
  const body = /export const SECTIONS[^=]*= \{([\s\S]*?)\n\};/.exec(table)?.[1] ?? '';
  for (const e of NAV) {
    const entry = new RegExp(`\\n  ${e.id}: (lazy\\(\\(\\) => import\\('[^']+'\\)\\)|section\\(\\s*\\(\\) => import\\('[^']+'\\))`).exec(body);
    assert.ok(entry, `${e.id} does not open a lazily imported screen`);
  }
  // `section()` is React.lazy around the import (one definition, checked here).
  assert.match(table, /function section<M>\([\s\S]*?return lazy\(async \(\) => \{\s*const m = await load\(\);/);
  // …and the shell's own modules import no screen statically.
  const shellFiles = ['MerchantShell.tsx', 'sections.tsx', 'nav.ts', 'routeTable.ts', 'context.ts', 'attention.ts', 'paletteModel.ts', 'SectionFallback.tsx', 'status.ts', 'strings.ts'];
  for (const f of shellFiles) {
    const src = code(`src/components/merchant/shell/${f}`);
    assert.doesNotMatch(src, /^import[^;]*from '\.\.\/(dashboard|catalog|finance|delivery|inbox|storeDesign|analytics)\//m, `${f} statically imports a screen`);
    assert.doesNotMatch(src, /^import[^;]*from '\.\/sections\/[^']+'/m, `${f} statically imports a section`);
  }
  const page = code('src/pages/MerchantDashboardPage.tsx');
  assert.doesNotMatch(page, /from '\.\.\/components\/merchant\/(dashboard|catalog|finance)\//, 'the page must not pull screens into the shell chunk');
});

test('every address the brief lists resolves; the old spellings and unknown paths never leave a blank page', () => {
  const brief: Array<[string, MerchantSection, string?]> = [
    ['/merchant', 'home'],
    ['/merchant/orders', 'orders'],
    ['/merchant/orders/ORD-1', 'orders', 'ORD-1'],
    ['/merchant/products', 'products'],
    ['/merchant/products/cp_1', 'products', 'cp_1'],
    ['/merchant/collections', 'collections'],
    ['/merchant/services', 'services'],
    ['/merchant/showcase', 'showcase'],
    ['/merchant/marketing/coupons', 'coupons'],
    ['/merchant/customers', 'customers'],
    ['/merchant/inbox', 'inbox'],
    ['/merchant/requests', 'requests'],
    ['/merchant/requests/orders', 'custom_orders'],
    ['/merchant/requests/orders/cord_1', 'custom_orders', 'cord_1'],
    ['/merchant/money', 'money'],
    ['/merchant/analytics', 'analytics'],
    ['/merchant/reviews', 'reviews'],
    ['/merchant/notifications', 'notifications'],
    ['/merchant/printers', 'printers'],
    ['/merchant/costing', 'costing'],
    ['/merchant/store/design', 'store_design'],
    ['/merchant/store/settings', 'store_settings'],
    ['/merchant/store/delivery', 'store_delivery'],
  ];
  for (const [path, section, id] of brief) {
    const expected = id ? { kind: 'section', section, id } : { kind: 'section', section };
    assert.deepEqual(resolveWorkspaceRoute(path, MERCHANT_BASE), expected, path);
    assert.deepEqual(resolveWorkspaceRoute(hostPath(path, true), STORE_HOST_BASE), expected, `${path} on a store host`);
    assert.deepEqual(resolveWorkspaceRoute(`${path}/`, MERCHANT_BASE), expected, `${path}/`);
  }
  // The thread and the request still open where they live (W2-E's adapter did the same).
  assert.deepEqual(resolveWorkspaceRoute('/merchant/inbox/chat_1', MERCHANT_BASE), { kind: 'away', to: '/chat/chat_1' });
  assert.deepEqual(resolveWorkspaceRoute('/admin/requests/req_9', STORE_HOST_BASE), { kind: 'away', to: '/requests?request=req_9' });
  // The brief's `/merchant/custom-orders` spelling redirects to the contract's.
  assert.deepEqual(resolveWorkspaceRoute('/merchant/custom-orders', MERCHANT_BASE), { kind: 'redirect', to: '/merchant/requests/orders' });
  assert.deepEqual(resolveWorkspaceRoute('/admin/custom-orders/cord_2', STORE_HOST_BASE), { kind: 'redirect', to: '/admin/requests/orders/cord_2' });
  // Unknown → the Command Center, never a blank page, never a traversal.
  for (const p of ['/merchant/nope', '/merchant/orders/a/b', '/merchant/money/1', '/merchant/custom-orders/../x', '/merchant/orders/%2e%2e']) {
    assert.deepEqual(resolveWorkspaceRoute(p, MERCHANT_BASE), { kind: 'redirect', to: MERCHANT_BASE }, p);
  }
});

test('the query words an address may carry are closed lists; the quick-create and filter doors are real routes', () => {
  assert.deepEqual(readWorkspaceQuery('?status=pending&x=1'), { create: false, status: 'pending' });
  assert.deepEqual(readWorkspaceQuery('status=evil'), { create: false });
  assert.deepEqual(readWorkspaceQuery('?new=1'), { create: true });
  assert.equal(merchantHref.ordersInStatus('confirmed'), '/merchant/orders?status=confirmed');
  assert.equal(merchantHref.ordersInStatus('x' as never), '/merchant/orders');
  assert.equal(merchantHref.productsInStock('low'), '/merchant/products?state=published&stock=low');
  for (const link of [merchantHref.newProduct(), merchantHref.newCoupon(), merchantHref.newCollection()]) {
    assert.ok(parseMerchantPath(link), link);
    assert.equal(readWorkspaceQuery(link.split('?')[1]).create, true);
    assert.equal(hostPath(link, true).startsWith('/admin/'), true);
  }
});

// ------------------------------------------------------------------ nav shapes

test('one nav table feeds the sidebar groups, the phone tabs and «More» — together they are every destination', () => {
  assert.deepEqual(
    navGroups().map((g) => g.id),
    NAV_GROUPS.map((g) => g.id),
    'sidebar group order: Overview · Sales · Catalogue · Workshop · Store · Money · Analytics · Reviews · Inbox · Notifications'
  );
  assert.deepEqual(navGroups().find((g) => g.id === 'sales')!.entries.map((e) => e.id), ['orders', 'custom_orders', 'customers', 'coupons']);
  assert.deepEqual(navGroups().find((g) => g.id === 'catalogue')!.entries.map((e) => e.id), ['products', 'collections', 'services', 'showcase']);
  assert.deepEqual(navGroups().find((g) => g.id === 'workshop')!.entries.map((e) => e.id), ['printers', 'costing', 'requests']);
  assert.deepEqual(navGroups().find((g) => g.id === 'store')!.entries.map((e) => e.id), ['store_design', 'store_settings', 'store_delivery']);
  assert.deepEqual(PHONE_TABS.map((t) => t.tab), ['home', 'orders', 'products', 'store']);
  const covered = new Set([...PHONE_TABS.map((t) => t.section), ...moreEntries().map((e) => e.id)]);
  assert.deepEqual([...covered].sort(), [...ALL].sort(), 'a destination is unreachable on a phone');
  assert.equal(phoneTabFor('store_delivery'), 'store');
  assert.equal(phoneTabFor('money'), 'more');
  assert.equal(visibleNav().length, NAV.length);
});

test('badges are real counts or nothing: an absent source draws no badge, never a 0', () => {
  assert.equal(badgeCount('orders', null), null);
  assert.equal(badgeCount('orders', {}), null);
  assert.equal(badgeCount('requests', { orders: { total: 3 } } as never), null);
  assert.equal(badgeCount('orders', { orders: { total: 3 } } as never), 3);
  assert.equal(badgeCount('stock', { stock: { low: 2, out: 1 } } as never), 3);
  assert.equal(badgeCount('reviews', { reviews: { link: '/merchant/reviews', new: 1 } } as never), null, 'unanswered absent');
  assert.equal(badgeCount(undefined, { orders: { total: 3 } } as never), null);
});

// ---------------------------------------------------------------- own host

test('the own-host rule (audit 01 B16): the workspace only on the viewer\'s own store host, or on the platform', () => {
  const own = { id: 's1', url: 'https://ali3d.levonis-iq.com' };
  assert.equal(onOwnHost(own, { storeId: null, storeHost: false }, 'levonis-iq.com'), true, 'the platform host');
  assert.equal(onOwnHost(own, { storeId: 's1', storeHost: true }, 'ali3d.levonis-iq.com'), true, 'my own store');
  assert.equal(onOwnHost(own, { storeId: 's2', storeHost: true }, 'zahra.levonis-iq.com'), false, 'someone else\'s store');
  // A suspended host resolves to no store: the server's own URL for mine decides.
  assert.equal(onOwnHost(own, { storeId: null, storeHost: true }, 'ali3d.levonis-iq.com'), true);
  assert.equal(onOwnHost(own, { storeId: null, storeHost: true }, 'zahra.levonis-iq.com'), false);
  assert.equal(onOwnHost({ id: 's1', url: '/community/store/m1' }, { storeId: null, storeHost: true }, 'x.levonis-iq.com'), false);
  const page = code('src/pages/MerchantDashboardPage.tsx');
  assert.match(page, /if \(!onOwnHost\(me\.store, \{ storeId: hostStore\?\.id \?\? null, storeHost \}, window\.location\.host\)\) \{[\s\S]*?data-not-your-store/);
  assert.match(page, /onStoreHost=\{storeHost\}/, 'the base is /admin whenever StorefrontApp serves the page, suspended hosts included');
});

// ------------------------------------------------------------------ palette

test('palette: ⌘K / Ctrl+K by key POSITION (works on Arabic and Kurdish layouts); the server is asked from 2 to 60 characters', () => {
  assert.equal(isPaletteKey({ code: 'KeyK', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }), true);
  assert.equal(isPaletteKey({ code: 'KeyK', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false }), true, 'an Arabic layout types «ن» here; the code is still KeyK');
  assert.equal(isPaletteKey({ code: 'KeyK', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }), false);
  assert.equal(isPaletteKey({ code: 'KeyK', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true }), false);
  assert.equal(isPaletteKey({ code: 'KeyJ', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }), false);
  assert.equal(searchable('a'), false);
  assert.equal(searchable(' ab '), true);
  assert.equal(searchable('ن'.repeat(60)), true);
  assert.equal(searchable('ن'.repeat(61)), false);
});

test('palette: every nav destination, in every language; server rows only for the query they answer, and kept by the local filter', () => {
  const loc = (ar: string, en: string) => en || ar;
  const results: SearchResults = {
    q: '0770',
    orders: [{ id: 'ORD-9', status: 'pending', total_iqd: 5000, link: '/merchant/orders/ORD-9' }],
    products: [],
    customers: [{ name: 'Sara', order_count: 2, link: '/merchant/orders/ORD-9' }],
  };
  const base = { loc, lang: 'en' as const, base: STORE_HOST_BASE, actions: [], money: (n: number) => `${n}`, href: (l: string) => hostPath(l, true), results };
  const groups = paletteGroups({ ...base, query: '0770' });
  const nav = groups.find((g) => g.id === 'nav')!;
  assert.equal(nav.items.length, NAV.length);
  assert.ok(nav.items.every((i) => i.href?.startsWith('/admin')), 'destinations on this host');
  // Arabic chrome, typed in English — or the other way round — still finds it.
  const orders = nav.items.find((i) => i.id === 'nav:orders')!;
  assert.ok(orders.keywords!.includes('الطلبات') && orders.keywords!.includes('Orders'));
  assert.deepEqual(filterByQuery(nav.items, 'الطلبات').map((i) => i.id)[0], 'nav:orders');
  // The server matched Sara by phone: her label does not contain «0770», the keyword keeps her.
  const res = groups.find((g) => g.id === 'results')!;
  assert.deepEqual(filterByQuery(res.items, '0770').map((i) => i.label), ['ORD-9', 'Sara']);
  assert.equal(res.items[0].href, '/admin/orders/ORD-9');
  // A stale answer (typed on) is not shown.
  assert.equal(paletteGroups({ ...base, query: '07701' }).some((g) => g.id === 'results'), false);
});

// ------------------------------------------------------------------ figures

const series = (orders: number[], start = '2026-09-01') =>
  orders.map((n, i) => ({ day: `2026-09-${String(Number(start.slice(8)) + i).padStart(2, '0')}`, orders: n, gross_iqd: n * 1000 }));

test('Command Center figures: today and the week from the report\'s own series, a delta only with a real previous week, no flat-zero trend', () => {
  const full = commandKpis({ range: { from: '2026-09-01', to: '2026-09-14' }, orders: { series: series([1, 0, 0, 2, 0, 0, 1, 3, 0, 1, 0, 2, 0, 4]) } })!;
  assert.deepEqual(full.today, { orders: 4, gross_iqd: 4000 });
  assert.equal(full.week.orders, 10);
  assert.deepEqual(full.week.previous, { orders: 4, gross_iqd: 4000 });
  assert.equal(full.week.trend!.length, 14);
  const short = commandKpis({ range: { from: '2026-09-01', to: '2026-09-05' }, orders: { series: series([0, 0, 1, 0, 0]) } })!;
  assert.equal(short.week.previous, undefined, 'five days of history make no week-on-week change');
  const quiet = commandKpis({ range: { from: '2026-09-01', to: '2026-09-14' }, orders: { series: series(Array(14).fill(0)) } })!;
  assert.equal(quiet.week.trend, undefined, 'a line of zeros is not drawn');
  assert.equal(commandKpis({ range: { from: '', to: '' }, orders: { series: [] } }), null);
  // Visitors only for a week that was counted from its first day.
  const traffic = (from: string) => ({ counted_from: from, series: series(Array(14).fill(0)).filter((d) => d.day >= from).map((d) => ({ day: d.day, visitors: 5 })) });
  const counted = commandKpis({ range: { from: '2026-09-01', to: '2026-09-14' }, orders: { series: series(Array(14).fill(0)) }, traffic: traffic('2026-09-01') })!;
  assert.equal(counted.visitors7, 35);
  const half = commandKpis({ range: { from: '2026-09-01', to: '2026-09-14' }, orders: { series: series(Array(14).fill(0)) }, traffic: traffic('2026-09-11') })!;
  assert.equal(half.visitors7, undefined, 'a half-counted week would read as a drop');
});

test('the status pill comes from /api/merchant/me, most severe first, and always says why', () => {
  const me = (store: Record<string, unknown>, canSell = true, reason = '') =>
    ({ store: { status: 'active', merchant: { status: 'active' }, ...store }, selling: { canSell, reason } }) as unknown as MerchantMe;
  const loc = (ar: string, en: string) => en || ar;
  assert.equal(storeStatus(me({})).key, 'open');
  assert.equal(storeStatus(me({ status: 'paused' }, false, 'store_paused')).key, 'paused');
  assert.equal(storeStatus(me({ status: 'paused', merchant: { status: 'suspended' } }, false, 'merchant_suspended')).key, 'suspended');
  const lapsed = storeStatus(me({}, false, 'subscription_inactive'));
  assert.equal(lapsed.key, 'lapsed');
  assert.match(lapsed.reason(loc), /PLUS/);
  assert.equal(storeStatus(me({ merchant: { status: 'restricted' } })).key, 'restricted');
  assert.equal(storeStatus(me({})).reason(loc), '');
});

// ------------------------------------------------------------------ App.tsx

test('the workspace is its own full-screen tree; onboarding stays in the customer shell; one splat route per host', () => {
  const app = read('src/App.tsx');
  const listed = /const isFullScreenRoute = \[([^\]]+)\]/.exec(app)![1];
  assert.match(listed, /'\/merchant'/);
  assert.match(app, /&& !isMerchantStart;/);
  const start = app.indexOf('if (isFullScreenRoute) {');
  const end = app.indexOf('const navHidden = isBottomNavHidden');
  const full = app.slice(start, end);
  const rest = app.slice(end);
  assert.match(full, /<Route path="\/merchant\/\*" element=\{<ProtectedRoute><MerchantDashboardPage \/><\/ProtectedRoute>\} \/>/);
  assert.doesNotMatch(rest, /path="\/merchant(\/\*)?" element/, 'the workspace is not declared in the customer shell any more');
  assert.match(rest, /<Route path="\/merchant\/start"/, 'onboarding is untouched');
  const storefront = app.slice(app.indexOf('function StorefrontApp('), app.indexOf('function AppBootstrapLayer('));
  assert.match(storefront, /<Route path="\/admin\/\*" element=\{<ProtectedRoute><MerchantDashboardPage \/><\/ProtectedRoute>\} \/>/);
  assert.doesNotMatch(storefront, /<Route path="\/admin" element/, 'one splat route, so screens never remount the frame');
  assert.match(read('src/components/bloub/MotionCharacterAnchor.tsx'), /path === '\/merchant' \|\| path\.startsWith\('\/merchant\/'\)\) && !path\.startsWith\('\/merchant\/start'\)/);
});

test('the shell mounts the Toaster once, owns one scroll area, and the page mounts none', () => {
  const shell = code('src/components/merchant/shell/MerchantShell.tsx');
  assert.equal((shell.match(/<Toaster \/>/g) ?? []).length, 1);
  assert.match(shell, /data-scroll-owner/);
  assert.doesNotMatch(code('src/pages/MerchantDashboardPage.tsx'), /Toaster/);
  // Every screen sits under a chunk boundary and a per-screen skeleton.
  assert.match(shell, /<ChunkBoundary>\s*<Suspense key=\{section\} fallback=\{<SectionFallback section=\{section\} \/>\}>/);
});

// ------------------------------------------------------------------ source rules

test('NO NATIVE DIALOGS in the merchant workspace or the community admin: no confirm(), alert(), prompt() or window.confirm/prompt', () => {
  const files = [...walk('src/components/merchant'), ...walk('src/components/adminCommunity'), 'src/pages/MerchantDashboardPage.tsx'];
  const offenders: string[] = [];
  for (const f of files) {
    const src = code(f);
    for (const m of src.matchAll(/(^|[^.\w])(window\.)?(confirm|alert|prompt)\s*\(/g)) {
      // `await confirm({…})` / `await prompt({…})` are useConfirm's and
      // usePrompt's functions (W3-B), not the browser's.
      const after = src.slice(m.index! + m[0].length).trimStart();
      if ((m[3] === 'confirm' || m[3] === 'prompt') && !m[2] && after.startsWith('{')) continue;
      offenders.push(`${f}: ${m[0].trim()}`);
    }
    if (/window\.(confirm|alert|prompt)\b/.test(src)) offenders.push(`${f}: window.${/window\.(confirm|alert|prompt)/.exec(src)![1]}`);
  }
  assert.deepEqual(offenders, []);
});

test('NO SORANI WAS INVENTED in the shell: every ckb word already existed elsewhere; a file that passes ar/en only says so', () => {
  const shellDir = 'src/components/merchant/shell';
  const corpus = walk('src')
    .filter((f) => !f.startsWith(shellDir))
    .map(read)
    .join('\n');
  for (const [key, words] of Object.entries(W)) {
    const ckb = (words as readonly string[])[2];
    if (ckb) assert.ok(corpus.includes(ckb), `W.${key}: «${ckb}» is Sorani nobody wrote before`);
  }
  for (const f of walk(shellDir)) {
    const src = read(f);
    if (/loc\(\s*(['`])(?:(?!\1).)*\1\s*,\s*(['`])(?:(?!\2).)*\2\s*\)/.test(src.replace(/\/\*[\s\S]*?\*\//g, ''))) {
      assert.match(src, /OWNER: Sorani to be written by hand\./, `${f} passes ar/en only without the OWNER marker`);
    }
  }
});

test('the workspace never reads a tier string, and refusals never show the server\'s sentence', () => {
  for (const f of walk('src/components/merchant/shell')) {
    const src = code(f);
    assert.doesNotMatch(src, /membership_tier\s*===|subscription_plan\s*===|\.tier\s*===/, `${f} decides from a tier string`);
    assert.doesNotMatch(src, /\balert\(|e\.message|err\.message/, `${f} shows raw text`);
  }
});
