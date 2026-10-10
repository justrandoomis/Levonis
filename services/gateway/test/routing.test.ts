/**
 * ROUTING PARITY (`01-TARGET.md` §3.3, `02-MIGRATION-PLAN.md` 1.5).
 *
 * The gateway is only safe in front of the core if nothing the core mounts can
 * fall off the edge of the routing table. So the table is not compared with a
 * copy of itself: every `app.route(...)` in `worker/index.ts` is read out of
 * the source, resolved through the real matcher, and checked against the owner
 * this design records for it. A new mount in the core with no row here is a
 * failing test, not a 404 in production.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GONE_ROUTES, ROUTES, ROUTE_TARGETS, matchRoute, parseOverrides, phaseOf, resolve, targetFor } from '../src/routes';
import { coreAllRoutes, coreMounts, rootMountPaths } from './_harness';

/**
 * The owner each mounted prefix ends up with. Written out per mount — not
 * derived from the table — so that a table edit which silently re-homes a
 * prefix (a longer row shadowing a shorter one, say) fails here.
 */
const EXPECTED_OWNER: Record<string, string> = {
  '/api/auth': 'IDENTITY',
  '/api/products': 'CATALOG',
  '/api/compare': 'CATALOG',
  '/api/catalog': 'CATALOG',
  '/api/printer-finder': 'CATALOG',
  '/api/public/v1': 'CORE',
  '/api/stock-alerts': 'CATALOG',
  '/api/price-reports': 'CATALOG',
  '/api/admin/price-reports': 'CATALOG',
  '/api/bundles': 'CATALOG',
  '/api/admin/bundles': 'CATALOG',
  '/api/admin/mystery': 'CATALOG',
  '/api/admin/offers': 'COMMERCE',
  '/api/admin/analytics': 'ANALYTICS',
  '/api/admin/finance': 'ANALYTICS',
  '/api/admin/finance/report': 'ANALYTICS',
  '/api/home': 'CATALOG',
  '/api/cart': 'COMMERCE',
  '/api/orders': 'COMMERCE',
  '/api/admin/orders': 'COMMERCE',
  '/api/addresses': 'IDENTITY',
  '/api/wallet': 'LEDGER',
  '/api/rewards': 'LEDGER',
  '/api/subscription': 'SUBSCRIPTIONS',
  '/api/invest': 'INVEST',
  '/api/community': 'MARKETPLACE',
  '/api/chats': 'CHAT',
  '/api/profile': 'IDENTITY',
  '/api/uploads': 'FILES',
  '/api/farm': 'FARM',
  '/api': 'CORE',
  '/api/admin': 'CORE',
  '/api/admin/farm': 'FARM',
  '/api/admin/products-v2': 'CATALOG',
  '/api/admin/template': 'CATALOG',
  '/api/admin/media': 'CATALOG',
  '/api/admin/taxonomy': 'CATALOG',
  '/api/admin/inventory': 'CATALOG',
  '/api/admin/procurement': 'CATALOG',
  '/api/admin/pricing': 'CATALOG',
  '/api/admin/stock-operations': 'CATALOG',
  '/api/admin/finance-operations': 'ANALYTICS',
  '/api/admin/finance-workspace': 'ANALYTICS',
  '/api/admin/finance-people': 'LEDGER',
  '/api/admin/investment-finance': 'LEDGER',
  '/api/finance-earnings': 'LEDGER',
  '/api/admin/membership-benefits': 'SUBSCRIPTIONS',
  '/api/warranty': 'DEVICES',
  '/api/admin/warranties': 'DEVICES',
  '/api/admin/community': 'MARKETPLACE',
  '/api/admin/import': 'CATALOG',
  '/api/admin/chats': 'CORE',
  '/api/admin/wallet-adjust': 'LEDGER',
  '/api/admin/products': 'CATALOG',
  '/api/memberships': 'SUBSCRIPTIONS',
  '/api/telegram': 'IDENTITY',
  '/api/invoices': 'INVOICES',
  '/api/devices': 'DEVICES',
  '/api/reviews': 'REVIEWS',
  '/api/gifts': 'REVIEWS',
  '/api/returns': 'COMMERCE',
  '/api/price-protection': 'COMMERCE',
  '/api/trade-in': 'COMMERCE',
  '/api/admin/trade-in': 'COMMERCE',
  '/api/quick-buy': 'COMMERCE',
  '/api/policies': 'POLICIES',
  '/api/kyc': 'KYC',
  '/api/support': 'SUPPORT',
  '/api/referrals': 'REFERRALS',
  '/api/studio': 'IDENTITY',
  '/api/merchant': 'MARKETPLACE',
  '/api/merchant/store/layout': 'MARKETPLACE',
  '/api/merchant/notifications': 'MARKETPLACE',
  '/api/merchant/inbox': 'MARKETPLACE',
  '/api/merchant/analytics': 'MARKETPLACE',
  '/api/merchant/finance': 'MARKETPLACE',
  '/api/merchant/payouts': 'MARKETPLACE',
  '/api/merchant/attention': 'MARKETPLACE',
  '/api/merchant/search': 'MARKETPLACE',
  '/api/merchant/customers': 'MARKETPLACE',
  // W5-B: the workshop's «مناسب لي» board, live eligibility verdicts and private request costing.
  '/api/merchant/workshop': 'MARKETPLACE',
  '/api/merchant/orders': 'MARKETPLACE',
  // Phase 4 of the community programme (docs/COMMUNITY_ECOSYSTEM.md §4d): resumable uploads, files on products, link cards.
  '/api/uploads/sessions': 'FILES',
  '/api/product-files': 'MARKETPLACE',
  '/api/link-cards': 'CHAT',
  '/api/storefront/events': 'MARKETPLACE',
  '/api/storefront': 'MARKETPLACE',
  '/api/marketplace/print': 'MARKETPLACE',
  '/api/marketplace': 'MARKETPLACE',
  '/api/print-quote': 'MARKETPLACE',
  '/api/admin/print-quote': 'MARKETPLACE',
  '/api/notifications': 'NOTIFICATIONS',
  '/api/store-orders': 'MARKETPLACE',
  '/api/community-reviews': 'MARKETPLACE',
  '/api/community-favorites': 'IDENTITY',
  '/files': 'FILES',
  // 0180 (owner decision 2): serial format rules, the devices' own records.
  '/api/admin/serial-rules': 'DEVICES',
  // DECISIONS row 206: «الأمان», the owner's security console, on the owner-only row the table already held for it.
  '/api/admin/security': 'ADMIN',
};

/**
 * The routers mounted at `/` (DECISIONS row 206: the deception layer's
 * decoys). They claim no prefix, so each is named here and its paths are
 * checked one by one (`rootMountPaths` reads them out of the core's registry):
 * an `/api` path must reach the core at every phase, and every other path is
 * §3.3's last row — never routed to the gateway, so no row may claim it.
 */
const ROOT_MOUNTS: readonly string[] = ['decoyRoutes'];
const isApiPath = (path: string): boolean => path === '/api' || path.startsWith('/api/');

test('every mount in worker/index.ts resolves to exactly one rule, with the owner this design records', () => {
  const mounts = coreMounts();
  assert.ok(mounts.length >= 45, `expected the core's full mount list, saw ${mounts.length}`);
  const unknown: string[] = [];
  for (const m of mounts) {
    // A router at `/` claims no prefix: the test below checks each of its paths.
    if (m.prefix === '/') continue;
    const rule = matchRoute(m.prefix, 'GET');
    assert.ok(rule, `${m.prefix} (${m.file}) resolves to no row in the routing table`);
    const expected = EXPECTED_OWNER[m.prefix];
    if (!expected) {
      unknown.push(`${m.prefix} → ${rule!.owner} (${m.file})`);
      continue;
    }
    assert.equal(rule!.owner, expected, `${m.prefix} resolves to ${rule!.owner}, the design says ${expected}`);
  }
  assert.deepEqual(unknown, [], `a new mount in worker/index.ts needs a row in 01-TARGET.md §3.3 and here:\n${unknown.join('\n')}`);
});

test('at phase 1 every legacy mount is still served by CORE — the gateway is a transparent hop', () => {
  for (const m of coreMounts()) {
    // A router at `/` reaches the gateway only through its /api paths.
    for (const path of m.prefix === '/' ? rootMountPaths(m.router).filter(isApiPath) : [m.prefix]) {
      const r = resolve(path, 'GET', 1);
      assert.ok(r, path);
      assert.equal(r!.target, 'CORE', `${path} must still be CORE at phase 1`);
    }
  }
});

test('a router mounted at / is checked path by path: its /api paths reach the core at every phase, open to all, and no row claims the rest', () => {
  const roots = coreMounts().filter((m) => m.prefix === '/');
  assert.deepEqual(
    roots.map((m) => m.router).sort(),
    [...ROOT_MOUNTS].sort(),
    'a router mounted at / in worker/index.ts needs its registry in _harness.ts (rootMountPaths) and its name in ROOT_MOUNTS'
  );
  for (const m of roots) {
    const paths = rootMountPaths(m.router);
    assert.ok(paths.length >= 10, `${m.router} (${m.file}): its paths could not be read out of its registry (saw ${paths.length})`);
    assert.ok(paths.some(isApiPath) && paths.some((p) => !isApiPath(p)), `${m.router}: expected both /api and site paths, saw ${paths.join(' ')}`);
    for (const path of paths) {
      for (const method of ['GET', 'HEAD', 'POST']) {
        const rule = matchRoute(path, method);
        if (!isApiPath(path)) {
          // §3.3, last row: the gateway has no `/*` route, so a site path never reaches it.
          assert.equal(rule, null, `${method} ${path} is a site path (01-TARGET.md §3.3, last row): no gateway row may claim it`);
          continue;
        }
        assert.ok(rule, `${method} ${path} (${m.file}) resolves to no row in the routing table`);
        // The decoy answers whoever asks: an edge refusal first would tell the asker it is not a real door.
        assert.equal(rule!.requires, 'none', `${method} ${path}: the edge must not refuse it before the core answers`);
        for (let phase = 1; phase <= 9; phase++) {
          assert.equal(resolve(path, method, phase)!.target, 'CORE', `${method} ${path} must reach the core at phase ${phase}`);
        }
      }
    }
  }
});

test('a phase raises exactly the prefixes whose flipPhase it reaches', () => {
  assert.equal(resolve('/api/chats/1', 'GET', 3)!.target, 'CORE');
  assert.equal(resolve('/api/chats/1', 'GET', 4)!.target, 'CHAT');
  assert.equal(resolve('/api/products', 'GET', 4)!.target, 'CORE');
  assert.equal(resolve('/api/products', 'GET', 5)!.target, 'CATALOG');
  assert.equal(resolve('/api/wallet', 'GET', 7)!.target, 'CORE');
  assert.equal(resolve('/api/wallet', 'GET', 8)!.target, 'LEDGER');
  // `/api/health` and the strangler defaults never flip.
  assert.equal(resolve('/api/health', 'GET', 9)!.target, 'CORE');
  assert.equal(resolve('/api/whatever-comes-next', 'GET', 9)!.target, 'CORE');
});

test('the kill switch beats the phase, and the longest override prefix wins', () => {
  const overrides = parseOverrides('/api/chats=CORE,/api/products/special=CORE,/api/products=CATALOG', ROUTE_TARGETS);
  assert.deepEqual(overrides.map((o) => o.prefix), ['/api/chats', '/api/products/special', '/api/products']);
  assert.equal(resolve('/api/chats/1', 'GET', 4, overrides)!.target, 'CORE', 'a flipped prefix goes back to CORE without a deploy');
  assert.equal(resolve('/api/products', 'GET', 1, overrides)!.target, 'CATALOG', 'and forward, for the flip itself');
  assert.equal(resolve('/api/products/special/x', 'GET', 1, overrides)!.target, 'CORE', 'the longest override wins');
});

test('the kill switch never invents a target: junk entries are dropped, not guessed', () => {
  assert.deepEqual(parseOverrides('nonsense,/api/x=NOWHERE,=CORE,/api/y=core', ROUTE_TARGETS), [{ prefix: '/api/y', target: 'CORE' }]);
  assert.deepEqual(parseOverrides(undefined, ROUTE_TARGETS), []);
  assert.equal(phaseOf(undefined), 1);
  assert.equal(phaseOf('nine'), 1);
  assert.equal(phaseOf('7'), 7);
});

test('the four permanent 410s of worker/index.ts are answered by the gateway itself', () => {
  const all = coreAllRoutes();
  assert.deepEqual(all.sort(), Object.keys(GONE_ROUTES).sort());
  assert.equal(GONE_ROUTES['/api/upload'], 'Use POST /api/uploads.');
  for (const p of all) assert.ok(GONE_ROUTES[p], `${p} has no 410 body`);
});

test('the narrow rows win over their prefix, and only for their method', () => {
  assert.equal(resolve('/api/orders/o1/tracking', 'GET', 7)!.target, 'FULFILMENT');
  assert.equal(resolve('/api/orders/o1/units', 'GET', 7)!.target, 'DEVICES');
  assert.equal(resolve('/api/orders/o1/settlement', 'POST', 8)!.target, 'LEDGER');
  assert.equal(resolve('/api/orders/o1/tracking', 'POST', 7)!.target, 'COMMERCE', 'a POST to the tracking path is not the Fulfilment read');
  assert.equal(resolve('/api/orders/o1', 'GET', 7)!.target, 'COMMERCE');
  assert.equal(resolve('/api/admin/orders/o1/stage', 'PATCH', 7)!.target, 'FULFILMENT');
  assert.equal(resolve('/api/admin/orders', 'GET', 7)!.target, 'COMMERCE');
});

test('assistant stock picker reads pass while every other procurement path is the owner\'s alone (decision 2)', () => {
  const selection = '/api/admin/procurement/selections/product-1';
  for (const method of ['GET', 'HEAD']) {
    const rule = matchRoute(selection, method)!;
    assert.equal(rule.requires, 'admin');
    assert.equal(rule.hosts, 'main');
    assert.equal(rule.owner, 'CATALOG');
    assert.equal(resolve(selection, method, 1)!.target, 'CORE');
    assert.equal(resolve(selection, method, 5)!.target, 'CATALOG');
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(matchRoute(selection, method)!.requires, 'admin:owner');
  }
  for (const path of [
    '/api/admin/procurement',
    '/api/admin/procurement/config',
    '/api/admin/procurement/documents',
    '/api/admin/procurement/documents/purchase-1',
    '/api/admin/procurement/documents/purchase-1/payments',
    '/api/admin/procurement/selections',
    '/api/admin/procurement/selections/product-1/extra',
    '/api/admin/procurement/selections-extra/product-1',
  ]) {
    for (const method of ['GET', 'HEAD', 'POST']) {
      assert.equal(matchRoute(path, method)!.requires, 'admin:owner', `${method} ${path}`);
    }
  }
});

test('receiving stays open to a receive holder at the edge — through the cost-free view and the receive POST only', () => {
  for (const method of ['GET', 'HEAD']) {
    for (const path of ['/api/admin/procurement/receiving', '/api/admin/procurement/receiving/purchase-1']) {
      assert.equal(matchRoute(path, method)!.requires, 'admin', `${method} ${path}`);
      assert.equal(matchRoute(path, method)!.owner, 'CATALOG');
    }
    for (const path of ['/api/admin/investment-finance/lots', '/api/admin/investment-finance/lots/lot-1']) {
      assert.equal(matchRoute(path, method)!.requires, 'admin', `${method} ${path}`);
      assert.equal(matchRoute(path, method)!.owner, 'LEDGER');
    }
  }
  assert.equal(matchRoute('/api/admin/procurement/documents/purchase-1/receive', 'POST')!.requires, 'admin');
  // …and nothing beside them opens.
  for (const [path, method] of [
    ['/api/admin/procurement/documents/purchase-1/receive', 'GET'],
    ['/api/admin/procurement/documents/purchase-1', 'GET'],
    ['/api/admin/procurement/receiving/purchase-1/extra', 'GET'],
    ['/api/admin/procurement/receiving', 'POST'],
    ['/api/admin/investment-finance/lots/lot-1/contracts', 'GET'],
    ['/api/admin/investment-finance/lots', 'POST'],
    ['/api/admin/investment-finance/lot-cost-adjustments', 'POST'],
  ] as const) {
    assert.equal(matchRoute(path, method)!.requires, 'admin:owner', `${method} ${path}`);
  }
});

test('the prefixes that share a stem resolve to their own owner, not to the shorter row', () => {
  assert.equal(matchRoute('/api/community-favorites/x', 'GET')!.owner, 'IDENTITY');
  assert.equal(matchRoute('/api/community-reviews/x', 'GET')!.owner, 'MARKETPLACE');
  assert.equal(matchRoute('/api/community/x', 'GET')!.owner, 'MARKETPLACE');
  assert.equal(matchRoute('/api/admin/wallet-requests', 'GET')!.owner, 'LEDGER');
  assert.equal(matchRoute('/api/admin/wallet/credit', 'POST')!.owner, 'LEDGER');
  assert.equal(matchRoute('/api/admin/settings/exchangeRate', 'PUT')!.owner, 'CONFIG');
  assert.equal(matchRoute('/api/memberships/referral/x', 'GET')!.owner, 'REFERRALS');
  assert.equal(matchRoute('/api/memberships/admin/referrals', 'GET')!.owner, 'REFERRALS');
  assert.equal(matchRoute('/api/memberships/admin/plans', 'GET')!.owner, 'SUBSCRIPTIONS');
  assert.equal(matchRoute('/api/admin/media/ingest', 'POST')!.owner, 'FILES');
  assert.equal(matchRoute('/api/admin/media/x', 'POST')!.owner, 'CATALOG');
  assert.equal(matchRoute('/api/support/admin/restrictions/1', 'GET')!.owner, 'RISK');
  assert.equal(matchRoute('/api/support/admin/tickets', 'GET')!.owner, 'SUPPORT');
});

test('every row is well formed: a known target, a phase that exists, and no duplicate (prefix, methods, pattern)', () => {
  const seen = new Set<string>();
  for (const r of ROUTES) {
    assert.ok(ROUTE_TARGETS.includes(r.owner), `${r.prefix}: unknown owner ${r.owner}`);
    assert.ok(r.flipPhase === null || (r.flipPhase >= 2 && r.flipPhase <= 9), `${r.prefix}: flipPhase ${r.flipPhase}`);
    assert.ok(r.prefix.startsWith('/'), r.prefix);
    const key = `${r.prefix}|${(r.methods ?? []).join(',')}|${r.pattern?.source ?? ''}`;
    assert.ok(!seen.has(key), `duplicate row ${key}`);
    seen.add(key);
  }
});

test('targetFor applies the override to the PATH, not only to the matched prefix', () => {
  const rule = matchRoute('/api/products/abc', 'GET')!;
  const overrides = parseOverrides('/api/products/abc=CORE', ROUTE_TARGETS);
  assert.equal(targetFor(rule, 5, overrides, '/api/products/abc'), 'CORE');
  assert.equal(targetFor(rule, 5, overrides, '/api/products/other'), 'CATALOG');
});

test('every cost surface is the owner\'s alone at the edge (owner decision 2)', () => {
  for (const path of [
    '/api/admin/finance/report/summary',
    '/api/admin/finance-workspace/summary',
    '/api/admin/finance-people/staff',
    '/api/admin/investment-finance/contracts',
    '/api/admin/finance-operations/config',
    '/api/admin/finance/expenses',
    '/api/admin/investment-profiles',
    '/api/admin/invest/summary',
    '/api/admin/security/overview',
    '/api/admin/pricing/overview',
    '/api/admin/pricing/products/p1/what-if',
  ]) {
    assert.equal(matchRoute(path, 'GET')!.requires, 'admin:owner', path);
  }
});
