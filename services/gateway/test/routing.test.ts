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
import { coreAllRoutes, coreMounts } from './_harness';

/**
 * The owner each mounted prefix ends up with. Written out per mount — not
 * derived from the table — so that a table edit which silently re-homes a
 * prefix (a longer row shadowing a shorter one, say) fails here.
 */
const EXPECTED_OWNER: Record<string, string> = {
  '/api/auth': 'IDENTITY',
  '/api/products': 'CATALOG',
  '/api/compare': 'CATALOG',
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
  '/api/returns': 'COMMERCE',
  '/api/price-protection': 'COMMERCE',
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
};

test('every mount in worker/index.ts resolves to exactly one rule, with the owner this design records', () => {
  const mounts = coreMounts();
  assert.ok(mounts.length >= 45, `expected the core's full mount list, saw ${mounts.length}`);
  const unknown: string[] = [];
  for (const m of mounts) {
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
    const r = resolve(m.prefix, 'GET', 1);
    assert.ok(r, m.prefix);
    assert.equal(r!.target, 'CORE', `${m.prefix} must still be CORE at phase 1`);
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
